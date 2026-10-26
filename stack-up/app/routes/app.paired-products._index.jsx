import { useState, useEffect } from "react";
import { useLoaderData, useNavigate, useSubmit, useActionData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopTimezone, formatDateInShopTimezone } from "../utils/timezone";

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

                return {
                    id: node.id,
                    numericId,
                    title: disc.title || config.title || "Paired Products Discount",
                    discountPercentage: config.percentage ? `${config.percentage}%` : "0%",
                    mainProductCount,
                    subProductCount,
                    status: disc.status || "ACTIVE",
                    combinesWith,
                    startDate: disc.startsAt ? formatDateInShopTimezone(disc.startsAt, shopTimezone) : "Immediate",
                    endDate: disc.endsAt ? formatDateInShopTimezone(disc.endsAt, shopTimezone) : null,
                };
            })
            .filter(Boolean);

        console.log("-------------------> [Index: Table] Loaded " + liveOffers.length + " Paired Products offers:");
        console.log("-------------------> [Index: Table] Offers:", liveOffers.map((o) => ({ id: o.numericId, title: o.title, discount: o.discountPercentage, status: o.status })));
    } catch (err) {
        console.error("-------------------> [Index: Table] Error querying discountNodes:", err);
    }

    return { shopName, offers: liveOffers };
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
    const { shopName, offers } = useLoaderData();
    const actionData = useActionData();
    const navigate = useNavigate();
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
                            <s-table-header>Schedule</s-table-header>
                            <s-table-header >Actions</s-table-header>
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
                                            <s-stack direction="inline" gap="small" alignItems="center">
                                                <s-tooltip id={`edit-tooltip-${offer.numericId}`}>
                                                    Edit offer
                                                </s-tooltip>
                                                <s-button
                                                    variant="primary"
                                                    href={`/app/paired-products/edit/${offer.numericId}`}
                                                    icon="edit"
                                                    interestFor={`edit-tooltip-${offer.numericId}`}
                                                    accessibilityLabel="Edit offer"
                                                />

                                                <s-tooltip id={`delete-tooltip-${offer.numericId}`}>
                                                    Delete offer
                                                </s-tooltip>
                                                <s-button
                                                    variant="primary"
                                                    tone="critical"
                                                    commandFor={`delete-modal-${offer.numericId}`}
                                                    command="--show"
                                                    icon="delete"
                                                    interestFor={`delete-tooltip-${offer.numericId}`}
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
