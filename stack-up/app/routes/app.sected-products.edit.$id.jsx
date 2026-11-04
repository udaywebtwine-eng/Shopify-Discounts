import { useState, useEffect, useMemo } from "react";
import {
    useLoaderData,
    useActionData,
    useNavigation,
    useSubmit,
    redirect,
} from "react-router";
import { useAppBridge, SaveBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
    getShopTimezone,
    getShopTodayDate,
    formatDateInShopTimezone,
    formatTimeInShopTimezone,
    formatTime12h,
    getTimezoneAbbr,
    generateTimeOptions,
    dateToShopISO,
    computeOfferStatus,
    setShopTimezoneCache,
} from "../utils/timezone";
import { syncAllActiveSelectedOffersToShopMetafield } from "../utils/selectedOffersMetafields.server";
import { getActiveMainProductsMap, checkMainProductConflicts } from "../utils/productConflicts.server";
import { syncRecentOrdersFromShopify } from "../utils/orders.server";

export const loader = async ({ request, params }) => {
    const t0 = performance.now();
    const { admin, session } = await authenticate.admin(request);
    const numericId = params.id;
    const shop = session?.shop || "";

    console.log("-------------------> [SelectedProducts: EditLoader] Loading offer for numericId:", numericId);

    let discountNode = null;
    let shopTimezone = "UTC";
    let widgetSettings = null;

    const possibleIds = [
        `gid://shopify/DiscountAutomaticNode/${numericId}`,
        `gid://shopify/DiscountAutomaticApp/${numericId}`,
    ];

    // Single batched query for discountNode + shop timezone
    for (const gid of possibleIds) {
        try {
            const response = await admin.graphql(
                `#graphql
                query GetDiscountAndShopDetails($id: ID!) {
                    discountNode(id: $id) {
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
                            id
                            value
                        }
                    }
                    shop {
                        ianaTimezone
                        metafield(namespace: "stack_up", key: "selected_widget_settings") {
                            value
                        }
                    }
                }`,
                { variables: { id: gid } }
            );
            const json = await response.json();
            const data = json.data;

            if (data?.shop?.ianaTimezone) {
                shopTimezone = data.shop.ianaTimezone;
                if (shop) setShopTimezoneCache(shop, shopTimezone);
            }

            const rawWidgetMetafield = data?.shop?.metafield?.value;
            if (rawWidgetMetafield) {
                try {
                    widgetSettings = JSON.parse(rawWidgetMetafield);
                } catch {
                    widgetSettings = null;
                }
            }

            if (data?.discountNode?.discount) {
                discountNode = data.discountNode;
                break;
            }
        } catch (e) {
            console.warn("-------------------> [SelectedProducts: EditLoader] Query failed for", gid, e);
        }
    }

    // Parallel DB fallback and order sync
    const [dbFallback] = await Promise.all([
        prisma.selectedProductOffer.findFirst({
            where: {
                OR: [
                    { numericId },
                    { discountId: `gid://shopify/DiscountAutomaticNode/${numericId}` },
                    { id: numericId },
                ],
            },
            include: {
                orders: {
                    take: 5,
                    orderBy: { createdAt: "desc" },
                },
            },
        }).catch((e) => {
            console.warn("Could not query DB for offer:", e);
            return null;
        }),
        shop
            ? syncRecentOrdersFromShopify(admin, shop).catch((e) => {
                console.warn("Could not sync recent orders in edit loader:", e);
                return 0;
            })
            : Promise.resolve(0),
    ]);

    if (!discountNode) {
        if (!dbFallback) {
            throw new Response("Selected Product Offer Not Found", { status: 404 });
        }

        let parsedTargets = [];
        let parsedOffered = [];
        try {
            parsedTargets = JSON.parse(dbFallback.targetProducts || "[]");
            parsedOffered = JSON.parse(dbFallback.offeredProducts || dbFallback.products || "[]");
        } catch {}

        discountNode = {
            id: dbFallback.discountId || `gid://shopify/DiscountAutomaticNode/${numericId}`,
            discount: {
                title: dbFallback.title,
                status: dbFallback.status || "ACTIVE",
                startsAt: dbFallback.startsAt ? dbFallback.startsAt.toISOString() : null,
                endsAt: dbFallback.endsAt ? dbFallback.endsAt.toISOString() : null,
                combinesWith: {
                    orderDiscounts: dbFallback.combinesWithOrder,
                    productDiscounts: dbFallback.combinesWithProduct,
                    shippingDiscounts: dbFallback.combinesWithShipping,
                },
            },
            metafield: {
                id: null,
                value: JSON.stringify({
                    discountType: "SELECTED_PRODUCTS",
                    percentage: dbFallback.percentage,
                    title: dbFallback.title,
                    targetProducts: parsedTargets,
                    offeredProducts: parsedOffered,
                }),
            },
        };
    }

    const disc = discountNode.discount;
    let config = {};
    try {
        config = JSON.parse(discountNode.metafield?.value || "{}");
    } catch {
        config = {};
    }

    let rawTargets = Array.isArray(config.targetProducts) ? config.targetProducts : [];
    let rawOffered = Array.isArray(config.offeredProducts) ? config.offeredProducts : [];

    // Fallback to legacy single products list if target/offered not yet split
    if (rawTargets.length === 0 && rawOffered.length === 0 && Array.isArray(config.products)) {
        rawOffered = config.products;
    }

    // Fallback to DB fields if Shopify metafield was missing them
    if (rawTargets.length === 0 && dbFallback?.targetProducts && dbFallback.targetProducts !== "[]") {
        try { rawTargets = JSON.parse(dbFallback.targetProducts); } catch {}
    }
    if (rawOffered.length === 0 && dbFallback?.offeredProducts && dbFallback.offeredProducts !== "[]") {
        try { rawOffered = JSON.parse(dbFallback.offeredProducts); } catch {}
    }

    const allProductIds = [
        ...new Set([
            ...rawTargets.map((p) => p.id),
            ...rawOffered.map((p) => p.id),
        ]),
    ].filter(Boolean);

    // Fetch live product details including variants from Shopify GraphQL
    const productsMap = {};
    if (allProductIds.length > 0) {
        try {
            const prodResponse = await admin.graphql(
                `#graphql
                query GetProductDetails($ids: [ID!]!) {
                    nodes(ids: $ids) {
                        ... on Product {
                            id
                            title
                            handle
                            featuredImage {
                                url
                            }
                            variants(first: 50) {
                                nodes {
                                    id
                                    price
                                }
                            }
                        }
                    }
                }`,
                { variables: { ids: allProductIds } }
            );
            const prodJson = await prodResponse.json();
            const nodes = prodJson.data?.nodes || [];
            nodes.forEach((n) => {
                if (n && n.id) {
                    const rawPrice = n.variants?.nodes?.[0]?.price;
                    const price = rawPrice
                        ? (String(rawPrice).startsWith("$") ? String(rawPrice) : `$${rawPrice}`)
                        : "";
                    productsMap[n.id] = {
                        title: n.title,
                        handle: n.handle || "",
                        image: n.featuredImage?.url || "",
                        price,
                        variants: n.variants?.nodes?.map((v) => ({ id: v.id })) || [],
                    };
                }
            });
        } catch (err) {
            console.warn("Could not query live product details:", err);
        }
    }

    const initialTargetProducts = rawTargets.map((p) => {
        const live = productsMap[p.id];
        const savedVariantIds = Array.isArray(p.variants) && p.variants.length > 0
            ? new Set(p.variants.map((v) => String(typeof v === "object" ? v.id : v)))
            : null;
        const filteredVariants = savedVariantIds && live?.variants
            ? live.variants.filter((v) => savedVariantIds.has(String(v.id)))
            : (live?.variants || p.variants || []);
        return {
            id: p.id,
            title: live?.title || p.title || `Product (${String(p.id).split("/").pop()})`,
            handle: live?.handle || p.handle || "",
            image: live?.image || p.image || "",
            price: live?.price || p.price || "",
            variants: filteredVariants,
        };
    });

    const initialOfferedProducts = rawOffered.map((p) => {
        const live = productsMap[p.id];
        const savedVariantIds = Array.isArray(p.variants) && p.variants.length > 0
            ? new Set(p.variants.map((v) => String(typeof v === "object" ? v.id : v)))
            : null;
        const filteredVariants = savedVariantIds && live?.variants
            ? live.variants.filter((v) => savedVariantIds.has(String(v.id)))
            : (live?.variants || p.variants || []);
        return {
            id: p.id,
            title: live?.title || p.title || `Product (${String(p.id).split("/").pop()})`,
            handle: live?.handle || p.handle || "",
            image: live?.image || p.image || "",
            price: live?.price || p.price || "",
            quantity: Math.max(1, parseInt(p.quantity, 10) || 1),
            variants: filteredVariants,
        };
    });

    const tEnd = performance.now();
    console.log(`⏱️ [SelectedProducts: EditLoader] Loaded offer ${numericId} in ${(tEnd - t0).toFixed(0)}ms`);

    // Load products already used as Main/Target in OTHER active offers
    const usedMainMap = await getActiveMainProductsMap({
        shop,
        offerType: "SELECTED",
        excludeDiscountId: discountNode.id,
        excludeNumericId: numericId,
    });
    const usedMainProducts = Array.from(usedMainMap.entries()).map(([numId, info]) => ({
        numericId: numId,
        offerTitle: info.offerTitle,
        offerType: info.offerType,
        offerNumericId: info.numericId,
        editUrl:
            info.offerType === "PAIRED"
                ? `/app/paired-products/edit/${info.numericId}`
                : `/app/sected-products/edit/${info.numericId}`,
    }));

    return {
        numericId,
        discountNodeId: discountNode.id,
        shopifyStatus: disc.status || "ACTIVE",
        title: disc.title || "",
        widgetTitle: config.widgetTitle || dbFallback?.widgetTitle || "",
        percentage: String(config.percentage || "10"),
        combinesWith: disc.combinesWith || {
            orderDiscounts: false,
            productDiscounts: false,
            shippingDiscounts: false,
        },
        startsAtDate: disc.startsAt ? formatDateInShopTimezone(disc.startsAt, shopTimezone) : "",
        startsAtTime: disc.startsAt ? formatTimeInShopTimezone(disc.startsAt, shopTimezone, "00:00:00") : "00:00:00",
        endsAtDate: disc.endsAt ? formatDateInShopTimezone(disc.endsAt, shopTimezone) : "",
        endsAtTime: disc.endsAt ? formatTimeInShopTimezone(disc.endsAt, shopTimezone, "23:59:59") : "23:59:59",
        startsAt: disc.startsAt ? formatDateInShopTimezone(disc.startsAt, shopTimezone) : "",
        endsAt: disc.endsAt ? formatDateInShopTimezone(disc.endsAt, shopTimezone) : "",
        hasEndDate: Boolean(disc.endsAt),
        shopTimezone,
        timezoneAbbr: getTimezoneAbbr(shopTimezone),
        initialTargetProducts,
        initialOfferedProducts,
        usedMainProducts,
        widgetSettings,
        analytics: {
            usageCount: dbFallback?.usageCount || 0,
            totalRevenue: dbFallback?.totalRevenue || 0,
            totalDiscountAmount: dbFallback?.totalDiscountAmount || 0,
            recentOrders: dbFallback?.orders || [],
        },
        shop,
    };
};

export const action = async ({ request, params }) => {
    const { admin, session } = await authenticate.admin(request);
    const numericId = params.id;
    const formData = await request.formData();
    const intent = formData.get("intent") || "update";

    // Deactivate
    if (intent === "deactivate") {
        const targetId = formData.get("discountNodeId") || `gid://shopify/DiscountAutomaticNode/${numericId}`;
        try {
            const response = await admin.graphql(
                `#graphql
                mutation DeactivateAutomaticDiscount($id: ID!) {
                    discountAutomaticDeactivate(id: $id) {
                        automaticDiscountNode {
                            id
                        }
                        userErrors {
                            field
                            message
                        }
                    }
                }`,
                { variables: { id: targetId } }
            );
            const json = await response.json();
            const userErrors = json.data?.discountAutomaticDeactivate?.userErrors || [];
            if (userErrors.length > 0) {
                return { error: userErrors.map((e) => e.message).join(", ") };
            }

            try {
                await prisma.selectedProductOffer.updateMany({
                    where: { numericId },
                    data: { status: "EXPIRED" },
                });
                await syncAllActiveSelectedOffersToShopMetafield(admin);
            } catch (dbErr) {
                console.warn("Could not sync deactivation to DB:", dbErr);
            }

            return redirect(`/app/sected-products/edit/${numericId}`);
        } catch (err) {
            return { error: err instanceof Error ? err.message : "Failed to deactivate offer." };
        }
    }

    // Activate
    if (intent === "activate") {
        const targetId = formData.get("discountNodeId") || `gid://shopify/DiscountAutomaticNode/${numericId}`;
        try {
            const response = await admin.graphql(
                `#graphql
                mutation ActivateAutomaticDiscount($id: ID!) {
                    discountAutomaticActivate(id: $id) {
                        automaticDiscountNode {
                            id
                        }
                        userErrors {
                            field
                            message
                        }
                    }
                }`,
                { variables: { id: targetId } }
            );
            const json = await response.json();
            const userErrors = json.data?.discountAutomaticActivate?.userErrors || [];
            if (userErrors.length > 0) {
                return { error: userErrors.map((e) => e.message).join(", ") };
            }

            try {
                await prisma.selectedProductOffer.updateMany({
                    where: { numericId },
                    data: { status: "ACTIVE" },
                });
                await syncAllActiveSelectedOffersToShopMetafield(admin);
            } catch (dbErr) {
                console.warn("Could not sync activation to DB:", dbErr);
            }

            return redirect(`/app/sected-products/edit/${numericId}`);
        } catch (err) {
            return { error: err instanceof Error ? err.message : "Failed to activate offer." };
        }
    }

    // Delete
    if (intent === "delete") {
        const targetId = formData.get("discountNodeId") || `gid://shopify/DiscountAutomaticNode/${numericId}`;
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
                { variables: { id: targetId } }
            );
            const json = await response.json();
            const userErrors = json.data?.discountAutomaticDelete?.userErrors || [];
            if (userErrors.length > 0) {
                return { error: userErrors.map((e) => e.message).join(", ") };
            }

            try {
                await prisma.selectedProductOffer.deleteMany({
                    where: { numericId },
                });
                await syncAllActiveSelectedOffersToShopMetafield(admin);
            } catch (dbErr) {
                console.warn("Could not delete from DB:", dbErr);
            }

            return redirect("/app/sected-products?deleted=true");
        } catch (err) {
            return { error: err instanceof Error ? err.message : "Failed to delete offer." };
        }
    }

    // Update
    if (intent === "update") {
        const title = (formData.get("title") || "").trim();
        const widgetTitle = (formData.get("widgetTitle") || "").trim();
        const percentageStr = formData.get("percentage") || "";
        const percentage = parseFloat(percentageStr);

        const targetProductsRaw = formData.get("targetProducts") || "[]";
        const offeredProductsRaw = formData.get("offeredProducts") || "[]";

        const combinesWithOrder = formData.get("combinesWithOrder") === "true";
        const combinesWithProduct = formData.get("combinesWithProduct") === "true";
        const combinesWithShipping = formData.get("combinesWithShipping") === "true";
        const startsAtDate = (formData.get("startsAtDate") || formData.get("startsAt") || "").trim();
        const startsAtTime = (formData.get("startsAtTime") || "00:00:00").trim();
        const hasEndDate = formData.get("hasEndDate") === "true";
        const endsAtDate = hasEndDate ? (formData.get("endsAtDate") || formData.get("endsAt") || "").trim() : null;
        const endsAtTime = hasEndDate ? (formData.get("endsAtTime") || "23:59:59").trim() : null;
        const discountNodeId = formData.get("discountNodeId") || `gid://shopify/DiscountAutomaticNode/${numericId}`;

        if (!title) {
            return { error: "Please enter an offer title." };
        }
        if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
            return { error: "Please enter a valid discount percentage between 1 and 100." };
        }

        let targetProducts = [];
        let offeredProducts = [];
        try {
            targetProducts = JSON.parse(targetProductsRaw);
            offeredProducts = JSON.parse(offeredProductsRaw);
        } catch {
            targetProducts = [];
            offeredProducts = [];
        }

        if (!Array.isArray(targetProducts) || targetProducts.length === 0) {
            return { error: "Please select at least one Main / Target Product where this widget will appear." };
        }
        if (!Array.isArray(offeredProducts) || offeredProducts.length === 0) {
            return { error: "Please select at least one Recommended Add-On Product." };
        }

        // Conflict Guard: Ensure target products are not already used in other active offers
        const conflictCheck = await checkMainProductConflicts({
            products: targetProducts,
            shop: session?.shop,
            offerType: "SELECTED",
            excludeDiscountId: `gid://shopify/DiscountAutomaticNode/${numericId}`,
            excludeNumericId: numericId,
        });
        if (conflictCheck.hasConflict) {
            const names = conflictCheck.conflictingProducts
                .map((cp) => `"${cp.title || cp.numericId}" (in offer: "${cp.offerTitle}")`)
                .join(", ");
            return {
                error: `${names} already has an active offer. To use it in this offer, please deactivate or remove it from the existing offer first.`,
            };
        }

        if (!startsAtDate) {
            return { error: "Please enter a start date." };
        }
        if (hasEndDate && !endsAtDate) {
            return { error: "Please enter an end date." };
        }
        if (hasEndDate && endsAtDate && startsAtDate) {
            if (endsAtDate < startsAtDate) {
                return { error: "End date must be on or after start date." };
            }
            if (endsAtDate === startsAtDate && endsAtTime <= startsAtTime) {
                return { error: "End time must be after start time on the same day." };
            }
        }

        const sanitizedTargetProducts = targetProducts.map((p) => ({
            id: p.id,
            title: p.title || "",
            handle: p.handle || "",
            image: p.image || "",
            price: p.price || "",
            variants: Array.isArray(p.variants)
                ? p.variants.map((v) => ({ id: typeof v === "object" ? v.id : v }))
                : [],
        }));

        const sanitizedOfferedProducts = offeredProducts.map((p) => ({
            id: p.id,
            title: p.title || "",
            handle: p.handle || "",
            image: p.image || "",
            price: p.price || "",
            quantity: Math.max(1, parseInt(p.quantity, 10) || 1),
            variants: Array.isArray(p.variants)
                ? p.variants.map((v) => ({ id: typeof v === "object" ? v.id : v }))
                : [],
        }));

        const configPayload = {
            discountType: "SELECTED_PRODUCTS",
            percentage,
            title,
            widgetTitle,
            targetProductIds: sanitizedTargetProducts.map((p) => p.id),
            offeredProductIds: sanitizedOfferedProducts.map((p) => p.id),
            targetProducts: sanitizedTargetProducts,
            offeredProducts: sanitizedOfferedProducts,
            // Backwards compatibility for function
            productIds: sanitizedOfferedProducts.map((p) => p.id),
            products: sanitizedOfferedProducts,
        };

        const shopTimezone = await getShopTimezone(admin, session?.shop);
        const effectiveStartsAt = dateToShopISO(startsAtDate, startsAtTime, shopTimezone) || new Date().toISOString();
        const effectiveEndsAt = hasEndDate && endsAtDate ? dateToShopISO(endsAtDate, endsAtTime, shopTimezone) : null;

        const updateVariables = {
            id: discountNodeId,
            automaticAppDiscount: {
                title,
                startsAt: effectiveStartsAt,
                endsAt: effectiveEndsAt,
                discountClasses: ["PRODUCT"],
                combinesWith: {
                    orderDiscounts: combinesWithOrder,
                    productDiscounts: combinesWithProduct,
                    shippingDiscounts: combinesWithShipping,
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
        };

        try {
            const response = await admin.graphql(
                `#graphql
                mutation UpdateAutomaticDiscount($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
                    discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
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
                { variables: updateVariables }
            );

            const json = await response.json();
            const userErrors = json.data?.discountAutomaticAppUpdate?.userErrors || [];
            if (userErrors.length > 0) {
                return { error: userErrors.map((e) => e.message).join(", ") };
            }

            const updatedDiscount = json.data?.discountAutomaticAppUpdate?.automaticAppDiscount;

            // Update PostgreSQL DB
            try {
                await prisma.selectedProductOffer.updateMany({
                    where: { numericId },
                    data: {
                        title,
                        widgetTitle: widgetTitle || null,
                        percentage,
                        status: updatedDiscount?.status || "ACTIVE",
                        combinesWithOrder,
                        combinesWithProduct,
                        combinesWithShipping,
                        startsAt: effectiveStartsAt ? new Date(effectiveStartsAt) : undefined,
                        endsAt: effectiveEndsAt ? new Date(effectiveEndsAt) : null,
                        targetProducts: JSON.stringify(sanitizedTargetProducts),
                        offeredProducts: JSON.stringify(sanitizedOfferedProducts),
                        products: JSON.stringify(sanitizedOfferedProducts),
                    },
                });
            } catch (dbErr) {
                console.warn("Could not update DB:", dbErr);
            }

            // Sync Shop Metafield
            await syncAllActiveSelectedOffersToShopMetafield(admin);

            return redirect("/app/sected-products?updated=true");
        } catch (err) {
            return {
                error: err instanceof Error ? err.message : "Failed to update offer.",
            };
        }
    }

    return null;
};

export default function EditSelectedProductOffer() {
    const data = useLoaderData();
    const actionData = useActionData();
    const navigation = useNavigation();
    const submit = useSubmit();
    const shopify = useAppBridge();

    const [title, setTitle] = useState(data.title);
    const [widgetTitle, setWidgetTitle] = useState(data.widgetTitle || "");
    const [percentage, setPercentage] = useState(data.percentage);

    const [targetProducts, setTargetProducts] = useState(data.initialTargetProducts || []);
    const [offeredProducts, setOfferedProducts] = useState(data.initialOfferedProducts || []);

    const [combinesWithOrder, setCombinesWithOrder] = useState(data.combinesWith?.orderDiscounts || false);
    const [combinesWithProduct, setCombinesWithProduct] = useState(data.combinesWith?.productDiscounts || false);
    const [combinesWithShipping, setCombinesWithShipping] = useState(data.combinesWith?.shippingDiscounts || false);

    const todayStr = getShopTodayDate(data.shopTimezone);
    const initialStartDate = data.startsAtDate || data.startsAt || todayStr;
    const minStartDate = initialStartDate && initialStartDate < todayStr ? initialStartDate : todayStr;
    const [startsAtDate, setStartsAtDate] = useState(initialStartDate);
    const [startsAtTime, setStartsAtTime] = useState(data.startsAtTime || "00:00:00");
    const [hasEndDate, setHasEndDate] = useState(data.hasEndDate);
    const [endsAtDate, setEndsAtDate] = useState(data.endsAtDate || data.endsAt || "");
    const [endsAtTime, setEndsAtTime] = useState(data.endsAtTime || "23:59:59");
    const tzAbbr = data.timezoneAbbr || getTimezoneAbbr(data.shopTimezone);

    // Conflict banner state
    const [conflictBanner, setConflictBanner] = useState(null);

    const startTimeOptions = useMemo(
        () => generateTimeOptions(false, data.startsAtTime),
        [data.startsAtTime]
    );
    const endTimeOptions = useMemo(
        () => generateTimeOptions(true, data.endsAtTime),
        [data.endsAtTime]
    );

    const [isSaving, setIsSaving] = useState(false);
    const isRedirecting = navigation.state === "loading" && !navigation.location?.pathname?.includes("/edit/");
    const isSubmitting = (isSaving || navigation.state === "submitting" || (navigation.state === "loading" && navigation.formMethod?.toLowerCase() === "post")) && !isRedirecting;

    const buildResourceSelection = (products) =>
        products.map((p) => {
            const item = { id: p.id };
            if (Array.isArray(p.variants) && p.variants.length > 0) {
                item.variants = p.variants.map((v) => ({ id: typeof v === "string" ? v : v.id }));
            }
            return item;
        });

    const isDirty = Boolean(
        title.trim() !== data.title ||
        widgetTitle.trim() !== (data.widgetTitle || "") ||
        percentage !== data.percentage ||
        combinesWithOrder !== (data.combinesWith?.orderDiscounts || false) ||
        combinesWithProduct !== (data.combinesWith?.productDiscounts || false) ||
        combinesWithShipping !== (data.combinesWith?.shippingDiscounts || false) ||
        startsAtDate !== (data.startsAtDate || data.startsAt || todayStr) ||
        startsAtTime !== (data.startsAtTime || "00:00:00") ||
        hasEndDate !== data.hasEndDate ||
        endsAtDate !== (data.endsAtDate || data.endsAt || "") ||
        (hasEndDate && endsAtTime !== (data.endsAtTime || "23:59:59")) ||
        JSON.stringify(targetProducts.map((p) => ({
            id: p.id,
            variants: (p.variants || []).map((v) => String(typeof v === "object" ? v.id : v)).sort(),
        }))) !==
        JSON.stringify((data.initialTargetProducts || []).map((p) => ({
            id: p.id,
            variants: (p.variants || []).map((v) => String(typeof v === "object" ? v.id : v)).sort(),
        }))) ||
        JSON.stringify(offeredProducts.map((p) => ({
            id: p.id,
            qty: Number(p.quantity) || 1,
            variants: (p.variants || []).map((v) => String(typeof v === "object" ? v.id : v)).sort(),
        }))) !==
        JSON.stringify((data.initialOfferedProducts || []).map((p) => ({
            id: p.id,
            qty: Number(p.quantity) || 1,
            variants: (p.variants || []).map((v) => String(typeof v === "object" ? v.id : v)).sort(),
        })))
    );

    const showSaveBar = (isDirty || isSubmitting) && !isRedirecting;

    useEffect(() => {
        if (isRedirecting) {
            setIsSaving(false);
            shopify.saveBar?.hide("edit-selected-offer-save-bar");
        }
    }, [isRedirecting, shopify]);

    useEffect(() => {
        if (navigation.state === "idle") {
            setIsSaving(false);
        }
    }, [navigation.state]);

    useEffect(() => {
        return () => {
            shopify.saveBar?.hide("edit-selected-offer-save-bar");
        };
    }, [shopify]);

    useEffect(() => {
        if (actionData?.error) {
            setIsSaving(false);
            shopify.toast.show(actionData.error, { isError: true });
        }
    }, [actionData, shopify]);

    const handleDiscard = (e) => {
        e?.preventDefault?.();
        setTitle(data.title);
        setPercentage(data.percentage);
        setTargetProducts(data.initialTargetProducts || []);
        setOfferedProducts(data.initialOfferedProducts || []);
        setCombinesWithOrder(data.combinesWith?.orderDiscounts || false);
        setCombinesWithProduct(data.combinesWith?.productDiscounts || false);
        setCombinesWithShipping(data.combinesWith?.shippingDiscounts || false);
        setStartsAtDate(data.startsAtDate || data.startsAt || todayStr);
        setStartsAtTime(data.startsAtTime || "00:00:00");
        setHasEndDate(data.hasEndDate);
        setEndsAtDate(data.endsAtDate || data.endsAt || "");
        setEndsAtTime(data.endsAtTime || "23:59:59");
        setIsSaving(false);
        shopify.saveBar?.hide("edit-selected-offer-save-bar");
    };

    // 1. Target Products Picker
    const handleOpenTargetPicker = async () => {
        try {
            const selection = buildResourceSelection(targetProducts);
            const selected = await shopify.resourcePicker({
                type: "product",
                multiple: true,
                action: "select",
                filter: { archived: false, draft: false, query: "status:active" },
                selectionIds: selection,
                initialSelectionIds: selection,
            });

            if (selected && Array.isArray(selected)) {
                // Filter out any products already used in other active offers
                const usedIdMap = new Map((data.usedMainProducts || []).map((u) => [u.numericId, u]));
                const conflictingItems = [];
                const validSelected = [];
                let firstConflictLink = null;

                selected.forEach((p) => {
                    const numId = String(p.id).split("/").pop();
                    if (usedIdMap.has(numId)) {
                        const conflict = usedIdMap.get(numId);
                        conflictingItems.push(`"${p.title}" (in offer: "${conflict.offerTitle}")`);
                        if (!firstConflictLink && conflict.editUrl) {
                            firstConflictLink = conflict.editUrl;
                        }
                    } else {
                        validSelected.push(p);
                    }
                });

                if (conflictingItems.length > 0) {
                    setConflictBanner({
                        message: `${conflictingItems.join(", ")} already has an active offer. A product can only have one active offer at a time. To use it here, please remove or deactivate it from the other offer first.`,
                        url: firstConflictLink,
                    });
                } else {
                    setConflictBanner(null);
                }

                setTargetProducts(
                    validSelected.map((p) => {
                        const image =
                            p.images?.[0]?.originalSrc ||
                            p.images?.[0]?.src ||
                            p.featuredImage?.url ||
                            p.image?.src ||
                            "";
                        const rawPrice = p.variants?.[0]?.price ?? p.price ?? "";
                        const price = rawPrice
                            ? (String(rawPrice).startsWith("$") ? String(rawPrice) : `$${rawPrice}`)
                            : "";
                        const existing = targetProducts.find((item) => item.id === p.id);
                        return {
                            id: p.id,
                            title: p.title,
                            handle: p.handle || existing?.handle || "",
                            image,
                            price,
                            variants: p.variants
                                ? p.variants.map((v) => ({ id: v.id }))
                                : existing?.variants || [],
                        };
                    })
                );
            }
        } catch (err) {
            console.error("Error opening target product picker:", err);
        }
    };

    const removeTargetProduct = (productId) => {
        setTargetProducts((prev) => prev.filter((p) => p.id !== productId));
    };

    // 2. Offered Products Picker
    const handleOpenOfferedPicker = async () => {
        try {
            const selection = buildResourceSelection(offeredProducts);
            const selected = await shopify.resourcePicker({
                type: "product",
                multiple: true,
                action: "select",
                filter: { archived: false, draft: false, query: "status:active" },
                selectionIds: selection,
                initialSelectionIds: selection,
            });

            if (selected && Array.isArray(selected)) {
                setOfferedProducts(
                    selected.map((p) => {
                        const image =
                            p.images?.[0]?.originalSrc ||
                            p.images?.[0]?.src ||
                            p.featuredImage?.url ||
                            p.image?.src ||
                            "";
                        const rawPrice = p.variants?.[0]?.price ?? p.price ?? "";
                        const price = rawPrice
                            ? (String(rawPrice).startsWith("$") ? String(rawPrice) : `$${rawPrice}`)
                            : "";
                        const existing = offeredProducts.find((item) => item.id === p.id);
                        return {
                            id: p.id,
                            title: p.title,
                            handle: p.handle || existing?.handle || "",
                            image,
                            price,
                            quantity: existing?.quantity || 1,
                            variants: p.variants
                                ? p.variants.map((v) => ({ id: v.id }))
                                : existing?.variants || [],
                        };
                    })
                );
            }
        } catch (err) {
            console.error("Error opening offered product picker:", err);
        }
    };

    const removeOfferedProduct = (productId) => {
        setOfferedProducts((prev) => prev.filter((p) => p.id !== productId));
    };

    const updateOfferedQuantity = (productId, newQty) => {
        setOfferedProducts((prev) =>
            prev.map((p) =>
                p.id === productId
                    ? { ...p, quantity: newQty === "" ? "" : Math.max(1, parseInt(newQty, 10) || 1) }
                    : p
            )
        );
    };

    const handleBlurOfferedQuantity = (productId) => {
        setOfferedProducts((prev) =>
            prev.map((p) =>
                p.id === productId && (!p.quantity || p.quantity < 1)
                    ? { ...p, quantity: 1 }
                    : p
            )
        );
    };

    const handleSubmit = () => {
        if (!title.trim()) {
            shopify.toast.show("Please enter an offer title", { isError: true });
            return;
        }
        const pct = parseFloat(percentage);
        if (isNaN(pct) || pct <= 0 || pct > 100) {
            shopify.toast.show("Please enter a valid discount percentage between 1 and 100", { isError: true });
            return;
        }
        if (targetProducts.length === 0) {
            shopify.toast.show("Please select at least one Main / Target Product", { isError: true });
            return;
        }
        if (offeredProducts.length === 0) {
            shopify.toast.show("Please select at least one Recommended Add-On Product", { isError: true });
            return;
        }
        if (!startsAtDate || !startsAtDate.trim()) {
            shopify.toast.show("Please enter a start date", { isError: true });
            return;
        }
        if (hasEndDate && (!endsAtDate || !endsAtDate.trim())) {
            shopify.toast.show("Please enter an end date", { isError: true });
            return;
        }
        if (hasEndDate && endsAtDate && startsAtDate) {
            if (endsAtDate < startsAtDate) {
                shopify.toast.show("End date must be on or after start date", { isError: true });
                return;
            }
            if (endsAtDate === startsAtDate && endsAtTime <= startsAtTime) {
                shopify.toast.show("End time must be after start time on the same day", { isError: true });
                return;
            }
        }

        setIsSaving(true);

        const formData = new FormData();
        formData.append("intent", "update");
        formData.append("discountNodeId", data.discountNodeId);
        formData.append("title", title);
        formData.append("widgetTitle", widgetTitle);
        formData.append("percentage", percentage);
        formData.append(
            "targetProducts",
            JSON.stringify(
                targetProducts.map((p) => ({
                    id: p.id,
                    title: p.title,
                    handle: p.handle || "",
                    image: p.image || "",
                    price: p.price || "",
                    variants: (p.variants || []).map((v) => ({ id: typeof v === "object" ? v.id : v })),
                }))
            )
        );
        formData.append(
            "offeredProducts",
            JSON.stringify(
                offeredProducts.map((p) => ({
                    id: p.id,
                    title: p.title,
                    handle: p.handle || "",
                    image: p.image || "",
                    price: p.price || "",
                    quantity: Math.max(1, parseInt(p.quantity, 10) || 1),
                    variants: (p.variants || []).map((v) => ({ id: typeof v === "object" ? v.id : v })),
                }))
            )
        );
        formData.append("combinesWithOrder", String(combinesWithOrder));
        formData.append("combinesWithProduct", String(combinesWithProduct));
        formData.append("combinesWithShipping", String(combinesWithShipping));
        formData.append("startsAtDate", startsAtDate);
        formData.append("startsAtTime", startsAtTime);
        formData.append("startsAt", startsAtDate);
        formData.append("hasEndDate", String(hasEndDate));
        if (hasEndDate && endsAtDate) {
            formData.append("endsAtDate", endsAtDate);
            formData.append("endsAtTime", endsAtTime);
            formData.append("endsAt", endsAtDate);
        }

        submit(formData, { method: "post" });
    };

    const handleDeactivateOffer = () => {
        setIsSaving(false);
        shopify.saveBar?.hide("edit-selected-offer-save-bar");
        const formData = new FormData();
        formData.append("intent", "deactivate");
        formData.append("discountNodeId", data.discountNodeId);
        submit(formData, { method: "post" });
    };

    const handleActivateOffer = () => {
        setIsSaving(false);
        shopify.saveBar?.hide("edit-selected-offer-save-bar");
        const formData = new FormData();
        formData.append("intent", "activate");
        formData.append("discountNodeId", data.discountNodeId);
        submit(formData, { method: "post" });
    };

    const handleDeleteOffer = () => {
        setIsSaving(false);
        shopify.saveBar?.hide("edit-selected-offer-save-bar");
        const formData = new FormData();
        formData.append("intent", "delete");
        formData.append("discountNodeId", data.discountNodeId);
        submit(formData, { method: "post" });
    };

    const effectiveStartsAtISO = startsAtDate ? dateToShopISO(startsAtDate, startsAtTime, data.shopTimezone) : null;
    const effectiveEndsAtISO = hasEndDate && endsAtDate ? dateToShopISO(endsAtDate, endsAtTime, data.shopTimezone) : null;

    const currentStatus = computeOfferStatus({
        startsAt: effectiveStartsAtISO,
        endsAt: effectiveEndsAtISO,
        status: data.shopifyStatus === "EXPIRED" ? "EXPIRED" : "ACTIVE",
    });
    const statusTone =
        currentStatus === "ACTIVE"
            ? "success"
            : currentStatus === "SCHEDULED"
                ? "warning"
                : "neutral";
    const statusLabel =
        currentStatus === "ACTIVE"
            ? "Active"
            : currentStatus === "SCHEDULED"
                ? "Scheduled"
                : "Expired";

    const isDeactivatedOrExpired =
        data.shopifyStatus === "EXPIRED" ||
        (hasEndDate && endsAtDate && endsAtDate < todayStr);

    return (
        <s-page heading={data.title || "Edit Selected Products Offer"}>
            <s-link slot="breadcrumb-actions" href="/app/sected-products">
                Selected Products Offers
            </s-link>

            {/* Official Polaris Web Component More Actions Menu */}
            <s-button
                slot="secondary-actions"
                commandFor="offer-actions"
            >
                More actions
            </s-button>

            <s-menu
                id="offer-actions"
                accessibilityLabel="Offer actions"
            >
                {isDeactivatedOrExpired ? (
                    <s-button onClick={handleActivateOffer}>
                        Activate
                    </s-button>
                ) : (
                    <s-button
                        commandFor="deactivate-offer-modal"
                        command="--show"
                    >
                        Deactivate
                    </s-button>
                )}

                <s-button
                    tone="critical"
                    commandFor="delete-offer-modal"
                    command="--show"
                >
                    Delete
                </s-button>
            </s-menu>

            {/* Deactivate Confirmation Modal */}
            <s-modal id="deactivate-offer-modal" heading="Deactivate offer?">
                <s-stack gap="base">
                    <s-paragraph>
                        Are you sure you want to deactivate <b>&ldquo;{title || data.title}&rdquo;</b>? Customers will no longer receive this discount at checkout.
                    </s-paragraph>
                    {isDirty && (
                        <s-paragraph tone="caution">
                            Note: Any unsaved changes you made will be discarded.
                        </s-paragraph>
                    )}
                </s-stack>

                <s-button
                    slot="primary-action"
                    variant="primary"
                    tone="critical"
                    commandFor="deactivate-offer-modal"
                    command="--hide"
                    onClick={handleDeactivateOffer}
                >
                    Deactivate
                </s-button>
                <s-button
                    slot="secondary-actions"
                    variant="secondary"
                    commandFor="deactivate-offer-modal"
                    command="--hide"
                >
                    Cancel
                </s-button>
            </s-modal>

            {/* Delete Confirmation Modal */}
            <s-modal id="delete-offer-modal" heading="Delete offer?">
                <s-stack gap="base">
                    <s-paragraph>
                        Are you sure you want to delete <b>&ldquo;{title || data.title}&rdquo;</b>?
                    </s-paragraph>
                    <s-paragraph tone="critical">
                        This action cannot be undone.
                    </s-paragraph>
                </s-stack>

                <s-button
                    slot="primary-action"
                    variant="primary"
                    tone="critical"
                    commandFor="delete-offer-modal"
                    command="--hide"
                    onClick={handleDeleteOffer}
                >
                    Delete offer
                </s-button>
                <s-button
                    slot="secondary-actions"
                    variant="secondary"
                    commandFor="delete-offer-modal"
                    command="--hide"
                >
                    Cancel
                </s-button>
            </s-modal>

            {/* SaveBar */}
            <SaveBar id="edit-selected-offer-save-bar" open={showSaveBar}>
                <button
                    type="button"
                    variant="primary"
                    onClick={handleSubmit}
                    loading={isSubmitting ? "true" : undefined}
                    disabled={isSubmitting ? "true" : undefined}
                >
                    Save
                </button>
                <button
                    type="button"
                    onClick={handleDiscard}
                    disabled={isSubmitting ? "true" : undefined}
                >
                    Discard
                </button>
            </SaveBar>

            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    handleSubmit();
                }}
            >
                <s-stack gap="base">
                    {conflictBanner && (
                        <s-banner
                            tone="critical"
                            heading="Product already has an active offer"
                            dismissible
                            onDismiss={() => setConflictBanner(null)}
                        >
                            <s-paragraph>
                                {typeof conflictBanner === "object" ? conflictBanner.message : conflictBanner}
                            </s-paragraph>
                            {typeof conflictBanner === "object" && conflictBanner.url && (
                                <s-button slot="secondary-actions" href={conflictBanner.url}>
                                    View conflicting offer
                                </s-button>
                            )}
                        </s-banner>
                    )}

                    {/* Offer Details */}
                    <s-section heading="Offer details">
                        <s-grid
                            gridTemplateColumns="repeat(10, 1fr)"
                            gap="small"
                            justifyContent="center"
                        >
                            <s-grid-item gridColumn="span 7">
                                <s-text-field
                                    label="Discount title (Internal & Checkout)"
                                    name="title"
                                    placeholder="e.g. Special Add-Ons 10% OFF"
                                    value={title}
                                    onInput={(e) => setTitle(e.target.value)}
                                    details="Shown at checkout and in Shopify Admin when this discount applies."
                                    required
                                ></s-text-field>
                            </s-grid-item>
                            <s-grid-item gridColumn="span 3">
                                <s-number-field
                                    label="Discount percentage"
                                    name="percentage"
                                    min="1"
                                    max="100"
                                    step="1"
                                    suffix="%"
                                    value={percentage}
                                    onInput={(e) => setPercentage(e.target.value)}
                                ></s-number-field>
                            </s-grid-item>

                            <s-grid-item gridColumn="span 10">
                                <s-text-field
                                    label="Widget title (Displayed on Product Page)"
                                    name="widgetTitle"
                                    placeholder="e.g. Special Add-Ons Just for You (leave blank for default)"
                                    value={widgetTitle}
                                    onInput={(e) => setWidgetTitle(e.target.value)}
                                    details="Custom heading shown above the add-ons widget on the storefront for this offer."
                                ></s-text-field>
                            </s-grid-item>
                        </s-grid>
                    </s-section>

                    {/* 1. Main / Target Products */}
                    <s-section heading="1. Select Main / Target Product(s)">
                        <s-stack gap="base">
                            <s-paragraph tone="subdued">
                                Choose the product page(s) where this add-on widget will appear. When a customer views any of these product pages, the add-ons widget will be displayed.
                            </s-paragraph>

                            <s-stack gap="base">
                                <s-stack
                                    background="subdued"
                                    padding="small"
                                    borderRadius="base"
                                    direction="inline"
                                    justifyContent="space-between"
                                    alignItems="center"
                                >
                                    <s-text weight="bold">
                                        {targetProducts.length} Main Product(s) selected
                                    </s-text>
                                    <s-button type="button" variant="primary" onClick={handleOpenTargetPicker}>
                                        Browse Main Products
                                    </s-button>
                                </s-stack>

                                {targetProducts.length > 0 ? (
                                    <s-box>
                                        {targetProducts.map((p, idx) => (
                                            <div key={p.id}>
                                                {idx > 0 && <s-divider />}
                                                <s-box padding="small-300">
                                                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                                                        <s-stack direction="inline" gap="base" alignItems="center">
                                                            {p.image ? (
                                                                <s-thumbnail
                                                                    id={idx}
                                                                    src={p.image}
                                                                    alt={p.title}
                                                                    size="small"
                                                                />
                                                            ) : (
                                                                <s-thumbnail
                                                                    id={idx}
                                                                    alt={p.title}
                                                                    size="small"
                                                                />
                                                            )}
                                                            <s-stack gap="extra-tight">
                                                                <s-text weight="semibold">{p.title}</s-text>
                                                                {p.price && (
                                                                    <s-text tone="subdued" size="small">
                                                                        {p.price}
                                                                    </s-text>
                                                                )}
                                                            </s-stack>
                                                        </s-stack>

                                                        <s-button
                                                            type="button"
                                                            variant="primary"
                                                            tone="critical"
                                                            icon="delete"
                                                            accessibilityLabel={`Remove ${p.title}`}
                                                            onClick={(e) => {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                                removeTargetProduct(p.id);
                                                            }}
                                                        />
                                                    </s-stack>
                                                </s-box>
                                            </div>
                                        ))}
                                    </s-box>
                                ) : (
                                    <s-paragraph tone="subdued">
                                        No main products selected. Click &quot;Browse Main Products&quot; to pick items.
                                    </s-paragraph>
                                )}
                            </s-stack>
                        </s-stack>
                    </s-section>

                    {/* 2. Recommended Add-On Products */}
                    <s-section heading="2. Select Recommended Add-On Product(s)">
                        <s-stack gap="base">
                            <s-paragraph tone="subdued">
                                Choose the companion/add-on products displayed in the widget with checkboxes and discounted prices.
                            </s-paragraph>

                            <s-stack gap="base">
                                <s-stack
                                    background="subdued"
                                    padding="small"
                                    borderRadius="base"
                                    direction="inline"
                                    justifyContent="space-between"
                                    alignItems="center"
                                >
                                    <s-text weight="bold">
                                        {offeredProducts.length} Add-On Product(s) selected
                                    </s-text>
                                    <s-button type="button" variant="primary" onClick={handleOpenOfferedPicker}>
                                        Browse Add-On Products
                                    </s-button>
                                </s-stack>

                                {offeredProducts.length > 0 ? (
                                    <s-box>
                                        {offeredProducts.map((p, idx) => (
                                            <div key={p.id}>
                                                {idx > 0 && <s-divider />}
                                                <s-box padding="small-300">
                                                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                                                        <s-stack direction="inline" gap="base" alignItems="center">
                                                            {p.image ? (
                                                                <s-thumbnail
                                                                    id={idx}
                                                                    src={p.image}
                                                                    alt={p.title}
                                                                    size="small"
                                                                />
                                                            ) : (
                                                                <s-thumbnail
                                                                    id={idx}
                                                                    alt={p.title}
                                                                    size="small"
                                                                />
                                                            )}
                                                            <s-stack gap="extra-tight">
                                                                <s-text weight="semibold">{p.title}</s-text>
                                                                {p.price && (
                                                                    <s-text tone="subdued" size="small">
                                                                        {p.price}
                                                                    </s-text>
                                                                )}
                                                            </s-stack>
                                                        </s-stack>

                                                        <s-stack direction="inline" gap="small" alignItems="center">
                                                            <s-text tone="subdued" size="small" weight="medium">
                                                                Min Qty:
                                                            </s-text>
                                                            <div style={{ width: "90px" }}>
                                                                <s-number-field
                                                                    label-hidden
                                                                    min="1"
                                                                    step="1"
                                                                    value={String(p.quantity ?? 1)}
                                                                    onInput={(e) => updateOfferedQuantity(p.id, e.target.value)}
                                                                    onBlur={() => handleBlurOfferedQuantity(p.id)}
                                                                ></s-number-field>
                                                            </div>
                                                            <s-button
                                                                type="button"
                                                                variant="primary"
                                                                tone="critical"
                                                                icon="delete"
                                                                accessibilityLabel={`Remove ${p.title}`}
                                                                onClick={(e) => {
                                                                    e.preventDefault();
                                                                    e.stopPropagation();
                                                                    removeOfferedProduct(p.id);
                                                                }}
                                                            />
                                                        </s-stack>
                                                    </s-stack>
                                                </s-box>
                                            </div>
                                        ))}
                                    </s-box>
                                ) : (
                                    <s-paragraph tone="subdued">
                                        No add-on products selected. Click &quot;Browse Add-On Products&quot; to pick items.
                                    </s-paragraph>
                                )}
                            </s-stack>
                        </s-stack>
                    </s-section>

                    {/* Active Dates */}
                    <s-section heading="Active dates">
                        <s-stack gap="base">
                            {data.shopTimezone && (
                                <s-paragraph tone="subdued">
                                    Times are based on your store timezone ({data.shopTimezone}).
                                </s-paragraph>
                            )}
                            <s-grid gridTemplateColumns="repeat(2, 1fr)" gap="base">
                                <s-grid-item gridColumn="span 1">
                                    <s-date-field
                                        label="Start date"
                                        value={startsAtDate || ""}
                                        allow={`${minStartDate}--`}
                                        onChange={(e) => setStartsAtDate(e.target.value)}
                                    ></s-date-field>
                                </s-grid-item>

                                <s-grid-item gridColumn="span 1">
                                    <s-select
                                        label={`Start time (${tzAbbr})`}
                                        value={startsAtTime}
                                        onChange={(e) => setStartsAtTime(e.target.value)}
                                    >
                                        {startTimeOptions.map((opt) => (
                                            <s-option key={opt.value} value={opt.value}>
                                                {opt.label}
                                            </s-option>
                                        ))}
                                    </s-select>
                                </s-grid-item>

                                <s-grid-item gridColumn="span 2">
                                    <s-checkbox
                                        label="Set end date"
                                        checked={hasEndDate}
                                        onChange={(e) => {
                                            const checked = e.currentTarget.checked;
                                            setHasEndDate(checked);
                                            if (!checked) {
                                                setEndsAtDate("");
                                                setEndsAtTime("23:59:59");
                                            }
                                        }}
                                    ></s-checkbox>
                                </s-grid-item>

                                {hasEndDate && (
                                    <>
                                        <s-grid-item gridColumn="span 1">
                                            <s-date-field
                                                label="End date"
                                                value={endsAtDate || ""}
                                                allow={`${startsAtDate || minStartDate}--`}
                                                onChange={(e) => setEndsAtDate(e.target.value)}
                                            ></s-date-field>
                                        </s-grid-item>

                                        <s-grid-item gridColumn="span 1">
                                            <s-select
                                                label={`End time (${tzAbbr})`}
                                                value={endsAtTime}
                                                onChange={(e) => setEndsAtTime(e.target.value)}
                                            >
                                                {endTimeOptions.map((opt) => (
                                                    <s-option key={opt.value} value={opt.value}>
                                                        {opt.label}
                                                    </s-option>
                                                ))}
                                            </s-select>
                                        </s-grid-item>
                                    </>
                                )}
                            </s-grid>
                        </s-stack>
                    </s-section>

                    {/* Combinations */}
                    <s-section heading="Combinations">
                        <s-stack gap="base">
                            <s-paragraph tone="subdued">
                                Control whether this discount can be combined with other discounts.
                            </s-paragraph>

                            <s-box background="base" border="small" borderRadius="base">
                                <s-box padding="small-300">
                                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                                        <s-stack direction="inline" gap="base" alignItems="center">
                                            <s-icon type="product-add" />
                                            <s-stack gap="extra-tight">
                                                <s-text weight="semibold">Product discounts</s-text>
                                                <s-text tone="subdued" size="small">
                                                    Multiple can apply per order · One per product (best value wins)
                                                </s-text>
                                            </s-stack>
                                        </s-stack>
                                        <s-switch
                                            checked={combinesWithProduct}
                                            onChange={(e) => setCombinesWithProduct(Boolean(e.target.checked ?? e.currentTarget.checked))}
                                            accessibilityLabel="Combine with Product discounts"
                                        ></s-switch>
                                    </s-stack>
                                </s-box>

                                <s-divider />

                                <s-box padding="small-300">
                                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                                        <s-stack direction="inline" gap="base" alignItems="center">
                                            <s-icon type="order" />
                                            <s-stack gap="extra-tight">
                                                <s-text weight="semibold">Order discounts</s-text>
                                                <s-text tone="subdued" size="small">
                                                    Multiple can apply per order
                                                </s-text>
                                            </s-stack>
                                        </s-stack>
                                        <s-switch
                                            checked={combinesWithOrder}
                                            onChange={(e) => setCombinesWithOrder(Boolean(e.target.checked ?? e.currentTarget.checked))}
                                            accessibilityLabel="Combine with Order discounts"
                                        ></s-switch>
                                    </s-stack>
                                </s-box>

                                <s-divider />

                                <s-box padding="small-300">
                                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                                        <s-stack direction="inline" gap="base" alignItems="center">
                                            <s-icon type="delivery" />
                                            <s-stack gap="extra-tight">
                                                <s-text weight="semibold">Shipping discounts</s-text>
                                                <s-text tone="subdued" size="small">
                                                    Only one can apply per order (best value wins)
                                                </s-text>
                                            </s-stack>
                                        </s-stack>
                                        <s-switch
                                            checked={combinesWithShipping}
                                            onChange={(e) => setCombinesWithShipping(Boolean(e.target.checked ?? e.currentTarget.checked))}
                                            accessibilityLabel="Combine with Shipping discounts"
                                        ></s-switch>
                                    </s-stack>
                                </s-box>
                            </s-box>
                        </s-stack>
                    </s-section>
                </s-stack>
            </form>

            {/* Sidebar: Summary & Analytics in slot="aside" */}
            <s-section slot="aside" heading="Summary">
                <s-stack gap="base">
                    <s-stack gap="tight">
                        <s-text weight="bold">Status</s-text>
                        <div>
                            <s-badge tone={statusTone}>
                                {statusLabel}
                            </s-badge>
                        </div>
                    </s-stack>

                    <s-stack gap="tight">
                        <s-text weight="bold">Offer title</s-text>
                        <s-paragraph tone={title.trim() ? "default" : "subdued"}>
                            {title.trim() || "No title set"}
                        </s-paragraph>
                    </s-stack>

                    <s-stack gap="tight">
                        <s-text weight="bold">Discount value</s-text>
                        <s-paragraph tone="subdued">
                            • {percentage ? `${percentage}% off add-on products` : "No discount value set"}
                        </s-paragraph>
                    </s-stack>

                    <s-stack gap="tight">
                        <s-text weight="bold">Main / Target product(s)</s-text>
                        {targetProducts.length > 0 ? (
                            targetProducts.map((p) => (
                                <s-paragraph key={p.id} tone="subdued">
                                    • {p.title}
                                </s-paragraph>
                            ))
                        ) : (
                            <s-paragraph tone="subdued">
                                • No main products selected
                            </s-paragraph>
                        )}
                    </s-stack>

                    <s-stack gap="tight">
                        <s-text weight="bold">Recommended add-ons</s-text>
                        {offeredProducts.length > 0 ? (
                            offeredProducts.map((p) => (
                                <s-paragraph key={p.id} tone="subdued">
                                    • {p.quantity || 1}x {p.title}
                                </s-paragraph>
                            ))
                        ) : (
                            <s-paragraph tone="subdued">
                                • No add-on products selected
                            </s-paragraph>
                        )}
                    </s-stack>

                    <s-stack gap="tight">
                        <s-text weight="bold">Active dates</s-text>
                        <s-paragraph tone="subdued">
                            • Starts {startsAtDate || todayStr} at {formatTime12h(startsAtTime)} ({tzAbbr})
                        </s-paragraph>
                        {hasEndDate && endsAtDate && (
                            <s-paragraph tone="subdued">
                                • Ends {endsAtDate} at {formatTime12h(endsAtTime)} ({tzAbbr})
                            </s-paragraph>
                        )}
                    </s-stack>

                    <s-stack gap="tight">
                        <s-text weight="bold">Combinations</s-text>
                        <s-paragraph tone="subdued">
                            {combinesWithProduct || combinesWithOrder || combinesWithShipping ? (
                                <>
                                    {combinesWithProduct && "• Combines with Product discounts\n"}
                                    {combinesWithOrder && "• Combines with Order discounts\n"}
                                    {combinesWithShipping && "• Combines with Shipping discounts\n"}
                                </>
                            ) : (
                                "• Cannot be combined with other discounts"
                            )}
                        </s-paragraph>
                    </s-stack>
                </s-stack>
            </s-section>

            {/* Performance Card */}
            <s-section slot="aside" heading="Performance">
                <s-stack gap="base">
                    <s-box background="subdued" borderRadius="base" padding="small">
                        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                            <s-text tone="subdued">Times Used</s-text>
                            <s-text weight="bold">{data.analytics.usageCount} times</s-text>
                        </s-stack>
                    </s-box>

                    <s-box background="subdued" borderRadius="base" padding="small">
                        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                            <s-text tone="subdued">Total Sales</s-text>
                            <s-text weight="bold">${data.analytics.totalRevenue.toFixed(2)}</s-text>
                        </s-stack>
                    </s-box>

                    <s-box background="subdued" borderRadius="base" padding="small">
                        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                            <s-text tone="subdued">Total Discount</s-text>
                            <s-text weight="bold">${data.analytics.totalDiscountAmount.toFixed(2)}</s-text>
                        </s-stack>
                    </s-box>
                </s-stack>
            </s-section>
        </s-page>
    );
}
