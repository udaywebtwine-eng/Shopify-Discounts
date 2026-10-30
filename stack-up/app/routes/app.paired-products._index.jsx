import { useState, useEffect } from "react";
import { useLoaderData, useSubmit, useActionData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopTimezone, formatDateInShopTimezone } from "../utils/timezone";
import { syncRecentOrdersFromShopify } from "../utils/orders.server";
import { syncAllActiveOffersToShopMetafield } from "../utils/bundleMetafields.server";

export const loader = async ({ request }) => {
    const { admin, session } = await authenticate.admin(request);
    const shopName = session.shop.replace(".myshopify.com", "");
    const shopTimezone = await getShopTimezone(admin);

    console.log("-------------------> [PairedProductsIndex] Fetching paired product discounts for:", session.shop);

    let liveOffers = [];
    try {
        const response = await admin.graphql(
            `#graphql
            query GetAutomaticDiscounts {
                discountNodes(first: 50, query: "type:app") {
                    nodes {
                        id
                        discount {
                            __typename
                            ... on DiscountAutomaticApp {
                                title
                                status
                                startsAt
                                endsAt
                                combinesWith {
                                    orderDiscounts
                                    productDiscounts
                                    shippingDiscounts
                                }
                            }
                        }
                        metafield(namespace: "$app:discount", key: "function_configuration") {
                            value
                        }
                    }
                }
            }`
        );
        const json = await response.json();
        const nodes = json.data?.discountNodes?.nodes || [];

        // Auto-sync offers from Shopify to PostgreSQL DB so existing offers are recovered
        try {
            for (const node of nodes) {
                const disc = node.discount;
                if (!disc || disc.__typename !== "DiscountAutomaticApp" || !node.metafield?.value) continue;
                let config = null;
                try { config = JSON.parse(node.metafield.value); } catch { continue; }
                if (!config || config.discountType !== "PAIRED_PRODUCTS") continue;

                const numericId = node.id.split("/").pop();
                await prisma.pairedOffer.upsert({
                    where: { discountId: node.id },
                    update: {
                        title: disc.title || config.title || "Paired Products Discount",
                        percentage: parseFloat(config.percentage) || 0,
                        status: disc.status || "ACTIVE",
                        startsAt: disc.startsAt ? new Date(disc.startsAt) : undefined,
                        endsAt: disc.endsAt ? new Date(disc.endsAt) : null,
                        mainProducts: JSON.stringify(config.mainProducts || []),
                        subProducts: JSON.stringify(config.subProducts || []),
                    },
                    create: {
                        shop: session.shop,
                        discountId: node.id,
                        numericId,
                        title: disc.title || config.title || "Paired Products Discount",
                        percentage: parseFloat(config.percentage) || 0,
                        status: disc.status || "ACTIVE",
                        combinesWithOrder: Boolean(disc.combinesWith?.orderDiscounts),
                        combinesWithProduct: Boolean(disc.combinesWith?.productDiscounts),
                        combinesWithShipping: Boolean(disc.combinesWith?.shippingDiscounts),
                        startsAt: disc.startsAt ? new Date(disc.startsAt) : new Date(),
                        endsAt: disc.endsAt ? new Date(disc.endsAt) : null,
                        mainProducts: JSON.stringify(config.mainProducts || []),
                        subProducts: JSON.stringify(config.subProducts || []),
                    },
                });
            }
            await syncAllActiveOffersToShopMetafield(admin);
        } catch (syncErr) {
            console.warn("Could not auto-sync offers to DB:", syncErr);
        }

        // Auto-sync recent orders to calculate Total Sales and Total Discounts
        if (session?.shop) {
            await syncRecentOrdersFromShopify(admin, session.shop);
        }

        // Fetch all DB offers for this shop (with shopName fallback)
        let allDbOffers = [];
        let dbOfferMap = {};
        try {
            allDbOffers = await prisma.pairedOffer.findMany({
                where: {
                    OR: [
                        { shop: session.shop },
                        { shop: shopName },
                        { shop: { contains: shopName } },
                    ],
                },
            });
            for (const d of allDbOffers) {
                dbOfferMap[d.discountId] = d;
                dbOfferMap[d.numericId] = d;
            }
        } catch (e) {
            console.warn("Could not fetch DB offers:", e);
        }

        liveOffers = nodes
            .map((node) => {
                const disc = node.discount;
                if (!disc || disc.__typename !== "DiscountAutomaticApp") return null;

                // Only include discounts created by our app with function_configuration
                if (!node.metafield?.value) return null;

                let config = null;
                try {
                    config = JSON.parse(node.metafield.value);
                } catch {
                    return null;
                }

                // Strictly filter for Paired Products offers
                if (!config || config.discountType !== "PAIRED_PRODUCTS") {
                    return null;
                }

                const numericId = node.id.split("/").pop();
                const mainProductCount = Array.isArray(config.mainProductIds) ? config.mainProductIds.length : 0;
                const subProductCount = Array.isArray(config.subProductIds) ? config.subProductIds.length : 0;

                const combinesWith = {
                    orderDiscounts: Boolean(disc.combinesWith?.orderDiscounts),
                    productDiscounts: Boolean(disc.combinesWith?.productDiscounts),
                    shippingDiscounts: Boolean(disc.combinesWith?.shippingDiscounts),
                };

                const dbItem = dbOfferMap[node.id] || dbOfferMap[numericId];
                const usageCount = dbItem?.usageCount || 0;

                return {
                    id: node.id,
                    numericId,
                    title: disc.title || config.title || "Paired Products Discount",
                    discountPercentage: config.percentage ? `${config.percentage}%` : "0%",
                    mainProductCount,
                    subProductCount,
                    status: disc.status || "ACTIVE",
                    combinesWith,
                    usageCount,
                    startDate: disc.startsAt ? formatDateInShopTimezone(disc.startsAt, shopTimezone) : "Immediate",
                    endDate: disc.endsAt ? formatDateInShopTimezone(disc.endsAt, shopTimezone) : null,
                };
            })
            .filter(Boolean);

        // Auto-heal: If DB has active offers that were dropped by local dev restart, re-register them with the active function
        const liveShopifyIds = new Set();
        nodes.forEach((node) => {
            liveShopifyIds.add(node.id);
            liveShopifyIds.add(node.id.split("/").pop());
        });

        let activeFunctionId = null;
        try {
            const fnRes = await admin.graphql(
                `#graphql
                query GetFunctionId {
                    shopifyFunctions(first: 25) {
                        nodes {
                            id
                            title
                            apiType
                        }
                    }
                }`
            );
            const fnJson = await fnRes.json();
            const functions = fnJson.data?.shopifyFunctions?.nodes || [];
            const matched = functions.find(
                (fn) =>
                    fn.title?.toLowerCase().includes("paired") ||
                    fn.apiType === "cart_lines_discounts_generate" ||
                    fn.apiType === "order_discounts"
            );
            activeFunctionId = matched?.id || functions[0]?.id || "gid://shopify/ShopifyFunction/paired-products-discount";
        } catch (fnErr) {
            console.warn("Could not query shopifyFunctions:", fnErr);
            activeFunctionId = "gid://shopify/ShopifyFunction/paired-products-discount";
        }

        for (const dbOffer of allDbOffers) {
            const isPresentInShopify = liveShopifyIds.has(dbOffer.discountId) || liveShopifyIds.has(dbOffer.numericId);
            if (!isPresentInShopify && activeFunctionId && dbOffer.status === "ACTIVE") {
                console.log(`-------------------> [AutoRestore] Re-registering missing offer in Shopify: "${dbOffer.title}" with function ${activeFunctionId}`);
                try {
                    let mainProducts = [];
                    let subProducts = [];
                    try {
                        mainProducts = JSON.parse(dbOffer.mainProducts);
                        subProducts = JSON.parse(dbOffer.subProducts);
                    } catch {
                        mainProducts = [];
                        subProducts = [];
                    }

                    const configPayload = {
                        discountType: "PAIRED_PRODUCTS",
                        percentage: dbOffer.percentage,
                        title: dbOffer.title,
                        mainProductIds: mainProducts.map((p) => p.id),
                        subProductIds: subProducts.map((p) => p.id),
                        mainProducts,
                        subProducts,
                    };

                    const createRes = await admin.graphql(
                        `#graphql
                        mutation RecreateAutomaticDiscount($automaticAppDiscount: DiscountAutomaticAppInput!) {
                            discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
                                automaticAppDiscount {
                                    discountId
                                    title
                                    status
                                }
                                userErrors {
                                    field
                                    message
                                }
                            }
                        }`,
                        {
                            variables: {
                                automaticAppDiscount: {
                                    title: dbOffer.title,
                                    functionId: activeFunctionId,
                                    startsAt: dbOffer.startsAt ? dbOffer.startsAt.toISOString() : new Date().toISOString(),
                                    ...(dbOffer.endsAt ? { endsAt: dbOffer.endsAt.toISOString() } : {}),
                                    discountClasses: ["ORDER"],
                                    combinesWith: {
                                        orderDiscounts: dbOffer.combinesWithOrder,
                                        productDiscounts: dbOffer.combinesWithProduct,
                                        shippingDiscounts: dbOffer.combinesWithShipping,
                                    },
                                    metafields: [
                                        {
                                            namespace: "$app:discount",
                                            key: "function_configuration",
                                            type: "json",
                                            value: JSON.stringify(configPayload),
                                        },
                                    ],
                                },
                            },
                        }
                    );
                    const createJson = await createRes.json();
                    const newDiscount = createJson.data?.discountAutomaticAppCreate?.automaticAppDiscount;
                    if (newDiscount?.discountId) {
                        const newNumericId = newDiscount.discountId.split("/").pop();
                        await prisma.pairedOffer.update({
                            where: { id: dbOffer.id },
                            data: {
                                discountId: newDiscount.discountId,
                                numericId: newNumericId,
                                status: newDiscount.status || "ACTIVE",
                            },
                        });
                        console.log(`-------------------> [AutoRestore] Successfully re-registered "${dbOffer.title}" as ${newDiscount.discountId}`);
                        dbOffer.discountId = newDiscount.discountId;
                        dbOffer.numericId = newNumericId;
                        dbOffer.status = newDiscount.status || "ACTIVE";
                    }
                } catch (recreateErr) {
                    console.warn(`-------------------> [AutoRestore] Error re-registering "${dbOffer.title}":`, recreateErr);
                }
            }
        }

        // Build comprehensive offers list: live Shopify offers + all DB offers
        const combinedOffers = [];
        const seenNumericIds = new Set();

        for (const o of liveOffers) {
            combinedOffers.push(o);
            seenNumericIds.add(String(o.numericId));
        }

        for (const dbo of allDbOffers) {
            if (!seenNumericIds.has(String(dbo.numericId))) {
                let mainCount = 0;
                let subCount = 0;
                try {
                    mainCount = JSON.parse(dbo.mainProducts || "[]").length;
                    subCount = JSON.parse(dbo.subProducts || "[]").length;
                } catch {
                    mainCount = 0;
                    subCount = 0;
                }

                combinedOffers.push({
                    id: dbo.discountId,
                    numericId: dbo.numericId,
                    title: dbo.title,
                    discountPercentage: `${dbo.percentage}%`,
                    mainProductCount: mainCount,
                    subProductCount: subCount,
                    status: dbo.status || "ACTIVE",
                    combinesWith: {
                        orderDiscounts: dbo.combinesWithOrder,
                        productDiscounts: dbo.combinesWithProduct,
                        shippingDiscounts: dbo.combinesWithShipping,
                    },
                    usageCount: dbo.usageCount || 0,
                    startDate: dbo.startsAt ? formatDateInShopTimezone(dbo.startsAt, shopTimezone) : "Immediate",
                    endDate: dbo.endsAt ? formatDateInShopTimezone(dbo.endsAt, shopTimezone) : null,
                });
                seenNumericIds.add(String(dbo.numericId));
            }
        }

        console.log("-------------------> [Index: Table] Loaded " + combinedOffers.length + " Paired Products offers (Live + DB):");
        console.log("-------------------> [Index: Table] Offers:", combinedOffers.map((o) => ({ id: o.numericId, title: o.title, discount: o.discountPercentage, status: o.status, usageCount: o.usageCount })));
        await syncAllActiveOffersToShopMetafield(admin);
        return { shopName, offers: combinedOffers };
    } catch (err) {
        console.error("-------------------> [Index: Table] Error in loader:", err);
        // Fallback: If GraphQL queries fail completely, still load directly from DB
        try {
            const fallbackDbOffers = await prisma.pairedOffer.findMany({
                where: {
                    OR: [
                        { shop: session?.shop || "" },
                        { shop: shopName },
                        { shop: { contains: shopName } },
                    ],
                },
            });
            const fallbackOffers = fallbackDbOffers.map((dbo) => {
                let mainCount = 0;
                let subCount = 0;
                try {
                    mainCount = JSON.parse(dbo.mainProducts || "[]").length;
                    subCount = JSON.parse(dbo.subProducts || "[]").length;
                } catch {
                    mainCount = 0;
                    subCount = 0;
                }
                return {
                    id: dbo.discountId,
                    numericId: dbo.numericId,
                    title: dbo.title,
                    discountPercentage: `${dbo.percentage}%`,
                    mainProductCount: mainCount,
                    subProductCount: subCount,
                    status: dbo.status || "ACTIVE",
                    combinesWith: {
                        orderDiscounts: dbo.combinesWithOrder,
                        productDiscounts: dbo.combinesWithProduct,
                        shippingDiscounts: dbo.combinesWithShipping,
                    },
                    usageCount: dbo.usageCount || 0,
                    startDate: dbo.startsAt ? formatDateInShopTimezone(dbo.startsAt, shopTimezone) : "Immediate",
                    endDate: dbo.endsAt ? formatDateInShopTimezone(dbo.endsAt, shopTimezone) : null,
                };
            });
            return { shopName, offers: fallbackOffers };
        } catch {
            return { shopName, offers: [] };
        }
    }
};

export const action = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");
    const id = formData.get("id");
    const numericId = formData.get("numericId");

    if (intent === "delete" && (id || numericId)) {
        console.log("-------------------> [Delete Clicked] Deleting offer ID:", numericId || id);

        // Shopify discountAutomaticDelete requires DiscountAutomaticNode ID
        const possibleGids = [
            id,
            numericId ? `gid://shopify/DiscountAutomaticNode/${numericId}` : null,
            numericId ? `gid://shopify/DiscountAutomaticApp/${numericId}` : null,
        ].filter(Boolean);

        let deleted = false;
        let lastError = null;

        for (const targetGid of possibleGids) {
            try {
                const response = await admin.graphql(
                    `#graphql
                    mutation DeleteAutomaticDiscount($id: ID!) {
                        discountAutomaticDelete(id: $id) {
                            deletedAutomaticDiscountId
                            userErrors {
                                field
                                message
                            }
                        }
                    }`,
                    { variables: { id: targetGid } }
                );
                const json = await response.json();
                const userErrors = json.data?.discountAutomaticDelete?.userErrors || [];
                if (userErrors.length === 0 && (json.data?.discountAutomaticDelete?.deletedAutomaticDiscountId || json.data?.discountAutomaticDelete)) {
                    console.log("-------------------> [Delete Success] Deleted offer ID:", json.data.discountAutomaticDelete.deletedAutomaticDiscountId);
                    deleted = true;

                    // Delete from PostgreSQL DB and sync Shop Metafield
                    try {
                        await prisma.pairedOffer.deleteMany({
                            where: {
                                OR: [
                                    id ? { discountId: id } : undefined,
                                    numericId ? { numericId } : undefined,
                                ].filter(Boolean),
                            },
                        });
                        console.log("-------------------> 💾 [Index: Delete] Removed offer from DB for ID:", numericId || id);
                        const { syncAllActiveOffersToShopMetafield } = await import("../utils/bundleMetafields.server");
                        await syncAllActiveOffersToShopMetafield(admin);
                    } catch (dbErr) {
                        console.warn("Could not delete from DB:", dbErr);
                    }

                    break;
                } else if (userErrors.length > 0) {
                    lastError = userErrors.map((e) => e.message).join(", ");
                }
            } catch (err) {
                lastError = err instanceof Error ? err.message : String(err);
            }
        }

        if (!deleted) {
            console.error("-------------------> [Delete Failed] Error:", lastError);
            return { error: lastError || "Failed to delete offer" };
        }

        return { success: true };
    }

    return null;
};

// eslint-disable-next-line react/prop-types
function MetricCard({ label, value, iconType, onClick, disabled }) {
    return (
        <s-clickable
            padding="small-300"
            borderRadius="base"
            disabled={disabled}
            onClick={onClick}
        >
            <s-stack direction="inline" gap="base" alignItems="center">
                <s-box background="subdued" borderRadius="base" padding="small" border="small">
                    <s-icon size="large" type={iconType}></s-icon>
                </s-box>
                <s-grid>
                    <s-heading tone="subdued" size="small">
                        {label}
                    </s-heading>
                    <s-text size="large" weight="bold">
                        {value}
                    </s-text>
                </s-grid>
            </s-stack>
        </s-clickable>
    );
}

export default function PairedProducts() {
    const { offers } = useLoaderData();
    const actionData = useActionData();
    const submit = useSubmit();
    const [searchParams, setSearchParams] = useSearchParams();
    const shopify = useAppBridge();

    useEffect(() => {
        if (searchParams.get("created") === "true") {
            shopify.toast.show("Discount created");
            const newParams = new URLSearchParams(searchParams);
            newParams.delete("created");
            setSearchParams(newParams, { replace: true });
        }
    }, [searchParams, setSearchParams, shopify]);

    useEffect(() => {
        shopify.saveBar?.hide("create-paired-offer-save-bar");
    }, [shopify]);

    useEffect(() => {
        if (actionData?.success) {
            shopify.toast.show("Offer deleted");
        } else if (actionData?.error) {
            shopify.toast.show(actionData.error, { isError: true });
        }
    }, [actionData, shopify]);

    const [searchQuery, setSearchQuery] = useState("");
    const [statusFilter, setStatusFilter] = useState("ALL");

    const filteredOffers = offers.filter((offer) => {
        const matchesSearch =
            offer.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
            offer.numericId.includes(searchQuery);

        const matchesStatus =
            statusFilter === "ALL" ||
            offer.status === statusFilter ||
            (statusFilter === "EXPIRED" &&
                (offer.status === "EXPIRED" || offer.status === "DEACTIVATED"));

        return matchesSearch && matchesStatus;
    });

    const activeCount = offers.filter((o) => o.status === "ACTIVE").length;
    const scheduledCount = offers.filter((o) => o.status === "SCHEDULED").length;
    const deactivatedCount = offers.filter(
        (o) => o.status === "EXPIRED" || o.status === "DEACTIVATED"
    ).length;

    const metricCards = [
        {
            id: "total",
            label: "Total Offers",
            value: offers.length,
            iconType: "discount",
            filterValue: "ALL",
        },
        {
            id: "active",
            label: "Active in Checkout",
            value: activeCount,
            iconType: "check-circle",
            filterValue: "ACTIVE",
        },
        {
            id: "scheduled",
            label: "Scheduled",
            value: scheduledCount,
            iconType: "clock",
            filterValue: "SCHEDULED",
        },
        {
            id: "deactivated",
            label: "Deactivated",
            value: deactivatedCount,
            iconType: "disabled",
            filterValue: "EXPIRED",
        },
    ];

    const handleDelete = (id, numericId) => {
        const formData = new FormData();
        formData.append("intent", "delete");
        formData.append("id", id);
        formData.append("numericId", numericId);
        submit(formData, { method: "post" });
    };

    return (
        <s-page heading="Paired Products Offers">
            <s-link slot="breadcrumb-actions" href="/app">
                Home
            </s-link>
            <s-button slot="secondary-actions" href="/app/paired-products/customize">
                🎨 Customize Widget
            </s-button>
            <s-button slot="primary-action" variant="primary" href="/app/paired-products/create">
                Create offer
            </s-button>



            {/* KPI Metric Cards */}
            <s-box border="small" borderRadius="base" padding="small">
                <s-grid
                    gridTemplateColumns="@container (inline-size <= 600px) 1fr, 1fr auto 1fr auto 1fr auto 1fr"
                    gap="small"
                >
                    {metricCards.map((card, index) => [
                        index > 0 ? (
                            <s-divider key={`divider-${card.id}`} direction="block" />
                        ) : null,
                        <MetricCard
                            key={card.id}
                            label={card.label}
                            value={card.value}
                            iconType={card.iconType}
                            onClick={() => setStatusFilter(card.filterValue)}
                        />,
                    ])}
                </s-grid>
            </s-box >

            {/* Filter and Table Section */}
            <s-box paddingBlockStart="large">
                <s-section padding="none">
                    <s-table>
                        {/* Filters Toolbar Slot */}
                        <s-grid
                            slot="filters"
                            gap="base"
                            gridTemplateColumns="1fr 180px auto"
                            alignItems="center"
                            padding="small-400"
                        >
                            <s-search-field
                                label="Search offers"
                                labelAccessibilityVisibility="exclusive"
                                placeholder="Search offers by name or ID..."
                                value={searchQuery}
                                onInput={(e) => setSearchQuery(e.target.value)}
                            ></s-search-field>

                            <s-select
                                label="Status"
                                labelAccessibilityVisibility="exclusive"
                                value={statusFilter}
                                onChange={(e) => setStatusFilter(e.target.value)}
                            >
                                <s-option value="ALL">All Statuses</s-option>
                                <s-option value="ACTIVE">Active</s-option>
                                <s-option value="SCHEDULED">Scheduled</s-option>
                                <s-option value="EXPIRED">Deactivated</s-option>
                            </s-select>

                            <s-button icon="plus" variant="primary" href="/app/paired-products/create">
                                Create offer
                            </s-button>
                        </s-grid>

                        {/* Table Headers */}
                        <s-table-header-row>
                            <s-table-header>
                                <s-box padding="small-300">Offer name</s-box>
                            </s-table-header>
                            <s-table-header>Discount</s-table-header>
                            <s-table-header>Main products</s-table-header>
                            <s-table-header>Sub products</s-table-header>
                            <s-table-header>Status</s-table-header>
                            <s-table-header>Combinations</s-table-header>
                            <s-table-header>Used</s-table-header>
                            <s-table-header>Schedule</s-table-header>
                            <s-table-header>Actions</s-table-header>
                        </s-table-header-row>

                        {/* Table Body */}
                        <s-table-body>
                            {filteredOffers.length === 0 ? (

                                <s-empty-state

                                    heading={
                                        searchQuery || statusFilter !== "ALL"
                                            ? "No offers found"
                                            : "No offers yet"
                                    }
                                >
                                    <s-box slot="graphic" maxInlineSize="200px">
                                        <s-image
                                            aspectRatio="1/0.5"
                                            src="https://cdn.shopify.com/static/images/polaris/patterns/callout.png"
                                            alt="Illustration showing offer creation"
                                        />
                                    </s-box>
                                    <s-text slot="subheading">
                                        {searchQuery || statusFilter !== "ALL"
                                            ? "Try clearing your filters or search query to see more offers."
                                            : "Create paired product discounts to incentivize customers to purchase bundles together."}
                                    </s-text>
                                    {(searchQuery || statusFilter !== "ALL") && (
                                        <s-button
                                            slot="secondary-actions"
                                            href="/app/paired-products/create"
                                        >
                                            Create offer
                                        </s-button>
                                    )}
                                    {searchQuery || statusFilter !== "ALL" ? (
                                        <s-button
                                            slot="primary-action"
                                            variant="primary"
                                            onClick={() => {
                                                setSearchQuery("");
                                                setStatusFilter("ALL");
                                            }}
                                        >
                                            Clear filters
                                        </s-button>
                                    ) : (
                                        <s-button
                                            slot="primary-action"
                                            variant="primary"
                                            href="/app/paired-products/create"
                                        >
                                            Create offer
                                        </s-button>
                                    )}
                                </s-empty-state>
                            ) : (
                                filteredOffers.map((offer) => (
                                    <s-table-row key={offer.id}>
                                        <s-table-cell>
                                            <s-link href={`/app/paired-products/edit/${offer.numericId}`}>
                                                <s-text weight="bold">{offer.title}</s-text>
                                            </s-link>
                                        </s-table-cell>

                                        <s-table-cell>
                                            <s-badge tone="info">{offer.discountPercentage} OFF</s-badge>
                                        </s-table-cell>

                                        <s-table-cell>
                                            <s-text>{offer.mainProductCount} selected</s-text>
                                        </s-table-cell>

                                        <s-table-cell>
                                            <s-text>{offer.subProductCount} selected</s-text>
                                        </s-table-cell>

                                        <s-table-cell>
                                            <s-badge
                                                tone={
                                                    offer.status === "ACTIVE"
                                                        ? "success"
                                                        : offer.status === "SCHEDULED"
                                                            ? "warning"
                                                            : "neutral"
                                                }
                                            >
                                                {offer.status}
                                            </s-badge>
                                        </s-table-cell>

                                        <s-table-cell>
                                            <s-stack direction="inline" gap="small-200" alignItems="center">
                                                <s-tooltip id={`combo-prod-${offer.numericId}`}>
                                                    {offer.combinesWith?.productDiscounts ? "Combines with product discounts" : "Can't combine with product discounts"}
                                                </s-tooltip>
                                                <span style={{ opacity: offer.combinesWith?.productDiscounts ? 1 : 0.28, display: "inline-flex" }}>
                                                    <s-icon
                                                        type="product-add"
                                                        color={offer.combinesWith?.productDiscounts ? "base" : "subdued"}
                                                        interestFor={`combo-prod-${offer.numericId}`}
                                                    />
                                                </span>

                                                <s-tooltip id={`combo-order-${offer.numericId}`}>
                                                    {offer.combinesWith?.orderDiscounts ? "Combines with order discounts" : "Can't combine with order discounts"}
                                                </s-tooltip>
                                                <span style={{ opacity: offer.combinesWith?.orderDiscounts ? 1 : 0.28, display: "inline-flex" }}>
                                                    <s-icon
                                                        type="order"
                                                        color={offer.combinesWith?.orderDiscounts ? "base" : "subdued"}
                                                        interestFor={`combo-order-${offer.numericId}`}
                                                    />
                                                </span>

                                                <s-tooltip id={`combo-ship-${offer.numericId}`}>
                                                    {offer.combinesWith?.shippingDiscounts ? "Combines with shipping discounts" : "Can't combine with shipping discounts"}
                                                </s-tooltip>
                                                <span style={{ opacity: offer.combinesWith?.shippingDiscounts ? 1 : 0.28, display: "inline-flex" }}>
                                                    <s-icon
                                                        type="delivery"
                                                        color={offer.combinesWith?.shippingDiscounts ? "base" : "subdued"}
                                                        interestFor={`combo-ship-${offer.numericId}`}
                                                    />
                                                </span>
                                            </s-stack>
                                        </s-table-cell>

                                        {/* Used count */}
                                        <s-table-cell>
                                            <s-text weight={offer.usageCount > 0 ? "bold" : "regular"}>
                                                {offer.usageCount || 0} times
                                            </s-text>
                                        </s-table-cell>

                                        <s-table-cell>
                                            <s-stack gap="small-400">
                                                <s-chip>{offer.startDate}</s-chip>
                                                {
                                                    offer.endDate && offer.endDate !== "No end date" && (
                                                        <s-chip>
                                                            {offer.endDate}
                                                        </s-chip>
                                                    )
                                                }
                                            </s-stack>
                                        </s-table-cell>

                                        <s-table-cell>
                                            <s-tooltip id={`edit-tip-${offer.numericId}`}>Edit offer</s-tooltip>
                                            <s-tooltip id={`delete-tip-${offer.numericId}`}>Delete offer</s-tooltip>

                                            <s-stack direction="inline" gap="small" alignItems="center">
                                                <s-button
                                                    variant="primary"
                                                    href={`/app/paired-products/edit/${offer.numericId}`}
                                                    icon="edit"
                                                    interestFor={`edit-tip-${offer.numericId}`}
                                                    accessibilityLabel="Edit offer"
                                                />

                                                <s-button
                                                    variant="primary"
                                                    tone="critical"
                                                    commandFor={`delete-modal-${offer.numericId}`}
                                                    command="--show"
                                                    icon="delete"
                                                    interestFor={`delete-tip-${offer.numericId}`}
                                                    accessibilityLabel="Delete offer"
                                                />


                                                <s-modal id={`delete-modal-${offer.numericId}`} heading="Delete offer?">
                                                    <s-stack gap="base">
                                                        <s-text>Are you sure you want to delete <b>&ldquo;{offer.title}&rdquo;</b>?</s-text>
                                                        <s-text tone="caution">This action cannot be undone.</s-text>
                                                    </s-stack>

                                                    <s-button
                                                        slot="primary-action"
                                                        variant="primary"
                                                        tone="critical"
                                                        commandFor={`delete-modal-${offer.numericId}`}
                                                        command="--hide"
                                                        onClick={() => handleDelete(offer.id, offer.numericId)}
                                                    >
                                                        Delete offer
                                                    </s-button>
                                                    <s-button
                                                        slot="secondary-actions"
                                                        variant="secondary"
                                                        commandFor={`delete-modal-${offer.numericId}`}
                                                        command="--hide"
                                                    >
                                                        Cancel
                                                    </s-button>
                                                </s-modal>
                                            </s-stack>
                                        </s-table-cell>
                                    </s-table-row>
                                ))
                            )}
                        </s-table-body>
                    </s-table>
                </s-section>
            </s-box>
        </s-page>
    );
}
