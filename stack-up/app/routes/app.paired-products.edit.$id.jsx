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
import { syncAllActiveOffersToShopMetafield } from "../utils/bundleMetafields.server";
import { getActiveMainProductsMap, checkMainProductConflicts } from "../utils/productConflicts.server";
import { syncRecentOrdersFromShopify } from "../utils/orders.server";
import WidgetPreview from "./components/Preview/WidgetPreview";

export const loader = async ({ request, params }) => {
    const t0 = performance.now();
    const { admin, session } = await authenticate.admin(request);
    const numericId = params.id;
    const shop = session?.shop || "";

    console.log("-------------------> [EditLoader] Loading offer for numericId:", numericId);

    const [dbFallback, shopTimezoneRes] = await Promise.all([
        prisma.pairedOffer.findFirst({
            where: {
                OR: [
                    { numericId },
                    { discountId: `gid://shopify/PairedOffer/${numericId}` },
                    { discountId: `gid://shopify/DiscountAutomaticNode/${numericId}` },
                    { id: numericId },
                ],
            },
        }),
        getShopTimezone(admin, shop).catch(() => "UTC"),
    ]);

    if (!dbFallback) {
        console.error("-------------------> [EditLoader] Offer not found in DB for numericId:", numericId);
        throw new Response("Offer Not Found", { status: 404 });
    }

    const shopTimezone = shopTimezoneRes || "UTC";
    if (shop && shopTimezone) setShopTimezoneCache(shop, shopTimezone);

    let widgetSettings = null;
    try {
        const metaRes = await admin.graphql(
            `#graphql
            query GetPairedWidgetSettings {
                shop {
                    metafield(namespace: "stack_up", key: "paired_widget_settings") {
                        value
                    }
                }
            }`
        );
        const metaJson = await metaRes.json();
        const rawWidgetMetafield = metaJson.data?.shop?.metafield?.value;
        if (rawWidgetMetafield) {
            try {
                widgetSettings = JSON.parse(rawWidgetMetafield);
                if (
                    !widgetSettings?.content?.heading ||
                    widgetSettings?.content?.heading === "Frequently Bought Together"
                ) {
                    if (!widgetSettings.content) widgetSettings.content = {};
                    widgetSettings.content.heading = "{widgettitle}";
                }
            } catch { }
        }
    } catch (e) {
        console.warn("Could not query widget settings:", e);
    }

    let parsedMain = [];
    let parsedSub = [];
    try { parsedMain = JSON.parse(dbFallback.mainProducts || "[]"); } catch { }
    try { parsedSub = JSON.parse(dbFallback.subProducts || "[]"); } catch { }

    const discountNode = {
        id: dbFallback.discountId || `gid://shopify/PairedOffer/${numericId}`,
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
                discountType: "PAIRED_PRODUCTS",
                percentage: dbFallback.percentage,
                title: dbFallback.title,
                widgetTitle: dbFallback.widgetTitle || "",
                mainProductIds: parsedMain.map((p) => p.id),
                subProductIds: parsedSub.map((p) => p.id),
                mainProducts: parsedMain,
                subProducts: parsedSub,
            }),
        },
    };

    const disc = discountNode.discount;
    let config = {};
    try {
        config = JSON.parse(discountNode.metafield?.value || "{}");
    } catch {
        config = {};
    }

    const mainProductIds = config.mainProductIds || [];
    const subProductIds = config.subProductIds || [];
    const allProductIds = [...new Set([...mainProductIds, ...subProductIds])];

    // Parallelize: Product details fetch + order syncing
    const [prodResponse] = await Promise.all([
        allProductIds.length > 0
            ? admin.graphql(
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
            ).then((res) => res.json()).catch(() => ({ data: { nodes: [] } }))
            : Promise.resolve({ data: { nodes: [] } }),
        session?.shop
            ? syncRecentOrdersFromShopify(admin, session.shop).catch(() => 0)
            : Promise.resolve(0),
    ]);

    let productsMap = {};
    const nodes = prodResponse?.data?.nodes || [];
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

    const mainProductQtyMap = {};
    if (Array.isArray(config.mainProducts)) {
        config.mainProducts.forEach((item) => {
            if (item?.id) mainProductQtyMap[item.id] = Number(item.quantity) || 1;
        });
    }

    const subProductQtyMap = {};
    if (Array.isArray(config.subProducts)) {
        config.subProducts.forEach((item) => {
            if (item?.id) subProductQtyMap[item.id] = Number(item.quantity) || 1;
        });
    }

    const mainProductVariantMap = {};
    if (Array.isArray(config.mainProducts)) {
        config.mainProducts.forEach((item) => {
            if (item?.id && Array.isArray(item.variants) && item.variants.length > 0) {
                mainProductVariantMap[item.id] = new Set(item.variants.map((v) => String(typeof v === "object" ? v.id : v)));
            }
        });
    }

    const subProductVariantMap = {};
    if (Array.isArray(config.subProducts)) {
        config.subProducts.forEach((item) => {
            if (item?.id && Array.isArray(item.variants) && item.variants.length > 0) {
                subProductVariantMap[item.id] = new Set(item.variants.map((v) => String(typeof v === "object" ? v.id : v)));
            }
        });
    }

    const initialMainProducts = mainProductIds.map((id) => {
        const prod = productsMap[id];
        const savedVariantIds = mainProductVariantMap[id];
        const filteredVariants = savedVariantIds && prod?.variants
            ? prod.variants.filter((v) => savedVariantIds.has(String(v.id)))
            : (prod?.variants || []);
        return {
            id,
            title: prod?.title || `Product (${id.split("/").pop()})`,
            handle: prod?.handle || "",
            image: prod?.image || "",
            price: prod?.price || "",
            quantity: mainProductQtyMap[id] || 1,
            variants: filteredVariants,
        };
    });

    const initialSubProducts = subProductIds.map((id) => {
        const prod = productsMap[id];
        const savedVariantIds = subProductVariantMap[id];
        const filteredVariants = savedVariantIds && prod?.variants
            ? prod.variants.filter((v) => savedVariantIds.has(String(v.id)))
            : (prod?.variants || []);
        return {
            id,
            title: prod?.title || `Product (${id.split("/").pop()})`,
            handle: prod?.handle || "",
            image: prod?.image || "",
            price: prod?.price || "",
            quantity: subProductQtyMap[id] || 1,
            variants: filteredVariants,
        };
    });

    // Query DB analytics for this offer
    let dbOffer = null;
    try {
        dbOffer = await prisma.pairedOffer.findFirst({
            where: { numericId },
            include: {
                orders: {
                    take: 5,
                    orderBy: { createdAt: "desc" },
                },
            },
        });
    } catch (e) {
        console.warn("Could not query DB for offer analytics:", e);
    }

    const tEnd = performance.now();
    console.log(`⏱️ [PairedProducts: Edit Loader] Loaded in ${(tEnd - t0).toFixed(0)}ms for numericId: ${numericId}`);

    // Load products already used as Main in OTHER active offers (exclude current offer)
    const usedMainMap = await getActiveMainProductsMap({
        shop,
        offerType: "PAIRED",
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
        widgetTitle: config.widgetTitle || dbOffer?.widgetTitle || "",
        percentage: String(config.percentage || "20"),
        combinesWith: disc.combinesWith || {
            orderDiscounts: false,
            productDiscounts: false,
            shippingDiscounts: false,
        },
        startsAt: disc.startsAt ? formatDateInShopTimezone(disc.startsAt, shopTimezone) : "",
        startsAtDate: disc.startsAt ? formatDateInShopTimezone(disc.startsAt, shopTimezone) : "",
        startsAtTime: disc.startsAt ? formatTimeInShopTimezone(disc.startsAt, shopTimezone) : "00:00:00",
        endsAt: disc.endsAt ? formatDateInShopTimezone(disc.endsAt, shopTimezone) : "",
        endsAtDate: disc.endsAt ? formatDateInShopTimezone(disc.endsAt, shopTimezone) : "",
        endsAtTime: disc.endsAt ? formatTimeInShopTimezone(disc.endsAt, shopTimezone) : "23:59:59",
        timezoneAbbr: getTimezoneAbbr(shopTimezone),
        hasEndDate: Boolean(disc.endsAt),
        shopTimezone,
        initialMainProducts,
        initialSubProducts,
        usedMainProducts,
        analytics: {
            usageCount: dbOffer?.usageCount || 0,
            totalRevenue: dbOffer?.totalRevenue || 0,
            totalDiscountAmount: dbOffer?.totalDiscountAmount || 0,
            recentOrders: dbOffer?.orders || [],
        },
        shop,
        widgetSettings,
    };
};

export const action = async ({ request, params }) => {
    const { admin, session } = await authenticate.admin(request);
    const numericId = params.id;
    const formData = await request.formData();
    const intent = formData.get("intent") || "update";

    const offerWhere = {
        OR: [
            { numericId },
            { discountId: `gid://shopify/PairedOffer/${numericId}` },
            { discountId: `gid://shopify/DiscountAutomaticNode/${numericId}` },
            { id: numericId },
        ],
    };

    // Handle Deactivate
    if (intent === "deactivate") {
        console.log("-------------------> [Deactivate Clicked] Offer ID:", numericId);
        try {
            await prisma.pairedOffer.updateMany({
                where: offerWhere,
                data: { status: "EXPIRED" },
            });
            console.log("-------------------> 💾 [Deactivate] Synced EXPIRED status to DB for ID:", numericId);
            await syncAllActiveOffersToShopMetafield(admin);

            // Best-effort cleanup for any legacy discount node in Shopify
            const targetId = formData.get("discountNodeId") || `gid://shopify/DiscountAutomaticNode/${numericId}`;
            if (targetId) {
                admin.graphql(
                    `#graphql
                    mutation DeactivateAutomaticDiscount($id: ID!) {
                      discountAutomaticDeactivate(id: $id) {
                        automaticDiscountNode { id }
                      }
                    }`,
                    { variables: { id: targetId } }
                ).catch(() => { });
            }

            return redirect(`/app/paired-products/edit/${numericId}`);
        } catch (err) {
            console.error("-------------------> [EditAction] Error deactivating offer:", err);
            return { error: err instanceof Error ? err.message : "Failed to deactivate offer." };
        }
    }

    // Handle Activate
    if (intent === "activate") {
        console.log("-------------------> [Activate Clicked] Offer ID:", numericId);
        try {
            await prisma.pairedOffer.updateMany({
                where: offerWhere,
                data: { status: "ACTIVE" },
            });
            console.log("-------------------> 💾 [Activate] Synced ACTIVE status to DB for ID:", numericId);
            await syncAllActiveOffersToShopMetafield(admin);

            // Best-effort cleanup for any legacy discount node in Shopify
            const targetId = formData.get("discountNodeId") || `gid://shopify/DiscountAutomaticNode/${numericId}`;
            if (targetId) {
                admin.graphql(
                    `#graphql
                    mutation ActivateAutomaticDiscount($id: ID!) {
                      discountAutomaticActivate(id: $id) {
                        automaticDiscountNode { id }
                      }
                    }`,
                    { variables: { id: targetId } }
                ).catch(() => { });
            }

            return redirect(`/app/paired-products/edit/${numericId}`);
        } catch (err) {
            console.error("-------------------> [EditAction] Error activating offer:", err);
            return { error: err instanceof Error ? err.message : "Failed to activate offer." };
        }
    }

    // Handle Delete
    if (intent === "delete") {
        console.log("-------------------> [Delete Clicked] Deleting offer ID:", numericId);
        try {
            await prisma.pairedOffer.deleteMany({
                where: offerWhere,
            });
            console.log("-------------------> 💾 [Delete] Removed offer from DB for ID:", numericId);
            await syncAllActiveOffersToShopMetafield(admin);

            // Best-effort cleanup for any legacy discount node in Shopify
            const deleteId = formData.get("discountNodeId") || `gid://shopify/DiscountAutomaticNode/${numericId}`;
            if (deleteId) {
                admin.graphql(
                    `#graphql
                    mutation DeleteAutomaticDiscount($id: ID!) {
                      discountAutomaticDelete(id: $id) {
                        deletedAutomaticDiscountId
                      }
                    }`,
                    { variables: { id: deleteId } }
                ).catch(() => { });
            }

            console.log("-------------------> 🎉 [EditAction] Offer deleted successfully!");
            return redirect("/app/paired-products?deleted=true");
        } catch (err) {
            console.error("-------------------> [EditAction] Error deleting offer:", err);
            return { error: err instanceof Error ? err.message : "Failed to delete offer." };
        }
    }

    // Handle Update
    const title = (formData.get("title") || "").trim();
    const widgetTitle = (formData.get("widgetTitle") || "").trim();
    const percentageStr = formData.get("percentage") || "";
    const percentage = parseFloat(percentageStr);
    const mainProductIdsRaw = formData.get("mainProductIds") || "[]";
    const subProductIdsRaw = formData.get("subProductIds") || "[]";
    const mainProductsRaw = formData.get("mainProducts") || "[]";
    const subProductsRaw = formData.get("subProducts") || "[]";

    const combinesWithOrder = formData.get("combinesWithOrder") === "true";
    const combinesWithProduct = formData.get("combinesWithProduct") === "true";
    const combinesWithShipping = formData.get("combinesWithShipping") === "true";
    const startsAtDate = (formData.get("startsAtDate") || formData.get("startsAt") || "").trim();
    const startsAtTime = (formData.get("startsAtTime") || "00:00:00").trim();
    const hasEndDate = formData.get("hasEndDate") === "true";
    const endsAtDate = hasEndDate ? (formData.get("endsAtDate") || formData.get("endsAt") || "").trim() : null;
    const endsAtTime = hasEndDate ? (formData.get("endsAtTime") || "23:59:59").trim() : null;

    if (!title) {
        return { error: "Please enter an offer title." };
    }

    if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
        return { error: "Please enter a valid discount percentage between 1 and 100." };
    }

    let mainProductIds = [];
    let subProductIds = [];
    let mainProducts = [];
    let subProducts = [];
    try {
        mainProductIds = JSON.parse(mainProductIdsRaw);
        subProductIds = JSON.parse(subProductIdsRaw);
        mainProducts = JSON.parse(mainProductsRaw);
        subProducts = JSON.parse(subProductsRaw);
    } catch {
        mainProductIds = [];
        subProductIds = [];
        mainProducts = [];
        subProducts = [];
    }

    if (mainProductIds.length === 0) {
        return { error: "Please select at least one Main Product." };
    }

    if (subProductIds.length === 0) {
        return { error: "Please select at least one Sub / Add-on Product." };
    }

    // Conflict Guard: Ensure main products are not already used in other active offers
    const conflictCheck = await checkMainProductConflicts({
        products: mainProducts,
        shop: session?.shop,
        offerType: "PAIRED",
        excludeDiscountId: `gid://shopify/DiscountAutomaticNode/${numericId}`,
        excludeNumericId: numericId,
    });
    if (conflictCheck.hasConflict) {
        const names = conflictCheck.conflictingProducts
            .map((cp) => `"${cp.title || cp.numericId}" (in offer: "${cp.offerTitle}")`)
            .join(", ");
        return {
            error: `${names} already has an active bundle offer. To use it in this offer, please deactivate or remove it from the existing offer first.`,
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

    const sanitizedMainProducts = mainProducts.map((p) => ({
        id: p.id,
        quantity: Math.max(1, parseInt(p.quantity, 10) || 1),
        variants: Array.isArray(p.variants)
            ? p.variants.map((v) => ({ id: typeof v === "object" ? v.id : v }))
            : [],
    }));

    const sanitizedSubProducts = subProducts.map((p) => ({
        id: p.id,
        quantity: Math.max(1, parseInt(p.quantity, 10) || 1),
        variants: Array.isArray(p.variants)
            ? p.variants.map((v) => ({ id: typeof v === "object" ? v.id : v }))
            : [],
    }));

    const shopTimezone = await getShopTimezone(admin, session?.shop);
    const effectiveStartsAt = dateToShopISO(startsAtDate, startsAtTime, shopTimezone) || new Date().toISOString();
    const effectiveEndsAt = hasEndDate && endsAtDate ? dateToShopISO(endsAtDate, endsAtTime, shopTimezone) : null;

    console.log("-------------------> [Save Edit Clicked]");
    console.log("------------------->   Offer ID:", numericId);
    console.log("------------------->   Updated Title:", title);
    console.log("------------------->   Updated Percentage:", percentage + "%");

    try {
        await prisma.pairedOffer.updateMany({
            where: offerWhere,
            data: {
                title,
                widgetTitle: widgetTitle || null,
                percentage,
                combinesWithOrder,
                combinesWithProduct,
                combinesWithShipping,
                startsAt: effectiveStartsAt ? new Date(effectiveStartsAt) : undefined,
                endsAt: effectiveEndsAt ? new Date(effectiveEndsAt) : null,
                mainProducts: JSON.stringify(sanitizedMainProducts),
                subProducts: JSON.stringify(sanitizedSubProducts),
            },
        });

        // Sync updated bundle data to Shop Metafield for instant storefront rendering
        await syncAllActiveOffersToShopMetafield(admin);

        console.log("-------------------> 🎉 [Save Edit Success] Offer updated directly in DB and shop metafield!");
        return redirect("/app/paired-products?updated=true");
    } catch (err) {
        console.error("-------------------> [Save Edit Failed] Exception:", err);
        return {
            error:
                err instanceof Error
                    ? err.message
                    : "An unexpected error occurred while updating the offer.",
        };
    }
};

export default function PairedProductsEdit() {
    const data = useLoaderData();
    const actionData = useActionData();
    const navigation = useNavigation();
    const submit = useSubmit();
    const shopify = useAppBridge();

    const [title, setTitle] = useState(data.title);
    const [widgetTitle, setWidgetTitle] = useState(data.widgetTitle || "");
    const [percentage, setPercentage] = useState(data.percentage);

    // Main Products list
    const [mainProducts, setMainProducts] = useState(data.initialMainProducts);

    // Sub Products list
    const [subProducts, setSubProducts] = useState(data.initialSubProducts);

    // Combinations
    const [combinesWithOrder, setCombinesWithOrder] = useState(
        data.combinesWith.orderDiscounts || false
    );
    const [combinesWithProduct, setCombinesWithProduct] = useState(
        data.combinesWith.productDiscounts || false
    );
    const [combinesWithShipping, setCombinesWithShipping] = useState(
        data.combinesWith.shippingDiscounts || false
    );

    // Dates in shop's timezone
    const todayStr = getShopTodayDate(data.shopTimezone);
    const minStartDate = data.startsAtDate && data.startsAtDate < todayStr ? data.startsAtDate : todayStr;
    const [startsAtDate, setStartsAtDate] = useState(data.startsAtDate || data.startsAt || todayStr);
    const [startsAtTime, setStartsAtTime] = useState(data.startsAtTime || "00:00:00");
    const [hasEndDate, setHasEndDate] = useState(data.hasEndDate);
    const [endsAtDate, setEndsAtDate] = useState(data.endsAtDate || data.endsAt || "");
    const [endsAtTime, setEndsAtTime] = useState(data.endsAtTime || "23:59:59");
    const tzAbbr = data.timezoneAbbr || getTimezoneAbbr(data.shopTimezone);

    // Conflict banner state
    const [conflictBanner, setConflictBanner] = useState(null);

    const startTimeOptions = useMemo(() => generateTimeOptions(false, data.startsAtTime), [data.startsAtTime]);
    const endTimeOptions = useMemo(() => generateTimeOptions(true, data.endsAtTime), [data.endsAtTime]);

    const [isSaving, setIsSaving] = useState(false);
    const isRedirecting = navigation.state === "loading" && !navigation.location?.pathname?.includes("/edit/");
    const isSubmitting = (isSaving || navigation.state === "submitting" || (navigation.state === "loading" && navigation.formMethod?.toLowerCase() === "post")) && !isRedirecting;

    // Helper to format selection IDs and variants for Shopify App Bridge ResourcePicker
    const buildResourceSelection = (products) =>
        products.map((p) => {
            const item = { id: p.id };
            if (Array.isArray(p.variants) && p.variants.length > 0) {
                item.variants = p.variants.map((v) => ({ id: typeof v === "string" ? v : v.id }));
            }
            return item;
        });

    // Resource Picker for Main Products
    const handleOpenMainProductPicker = async () => {
        try {
            const selection = buildResourceSelection(mainProducts);
            const selected = await shopify.resourcePicker({
                type: "product",
                multiple: true,
                action: "select",
                filter: {
                    archived: false,
                    draft: false,
                    query: "status:active",
                },
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
                        message: `${conflictingItems.join(", ")} already has an active bundle offer. A product can only have one active bundle at a time. To use it here, please remove or deactivate it from the other offer first.`,
                        url: firstConflictLink,
                    });
                } else {
                    setConflictBanner(null);
                }

                setMainProducts(
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
                        const existing = mainProducts.find((item) => item.id === p.id);
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
        } catch (e) {
            console.warn("Main product picker dismissed:", e);
        }
    };

    // Resource Picker for Sub Products
    const handleOpenSubProductPicker = async () => {
        try {
            const selection = buildResourceSelection(subProducts);
            const selected = await shopify.resourcePicker({
                type: "product",
                multiple: true,
                action: "select",
                filter: {
                    archived: false,
                    draft: false,
                    query: "status:active",
                },
                selectionIds: selection,
                initialSelectionIds: selection,
            });

            if (selected && Array.isArray(selected)) {
                setSubProducts(
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
                        const existing = subProducts.find((item) => item.id === p.id);
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
        } catch (e) {
            console.warn("Sub product picker dismissed:", e);
        }
    };

    const removeMainProduct = (productId) => {
        setMainProducts((prev) => prev.filter((p) => p.id !== productId));
    };

    const removeSubProduct = (productId) => {
        setSubProducts((prev) => prev.filter((p) => p.id !== productId));
    };

    const updateMainProductQuantity = (productId, newQty) => {
        setMainProducts((prev) =>
            prev.map((p) =>
                p.id === productId
                    ? { ...p, quantity: newQty === "" ? "" : Math.max(1, parseInt(newQty, 10) || 1) }
                    : p
            )
        );
    };

    const handleBlurMainProductQuantity = (productId) => {
        setMainProducts((prev) =>
            prev.map((p) =>
                p.id === productId && (!p.quantity || p.quantity < 1)
                    ? { ...p, quantity: 1 }
                    : p
            )
        );
    };

    const updateSubProductQuantity = (productId, newQty) => {
        setSubProducts((prev) =>
            prev.map((p) =>
                p.id === productId
                    ? { ...p, quantity: newQty === "" ? "" : Math.max(1, parseInt(newQty, 10) || 1) }
                    : p
            )
        );
    };

    const handleBlurSubProductQuantity = (productId) => {
        setSubProducts((prev) =>
            prev.map((p) =>
                p.id === productId && (!p.quantity || p.quantity < 1)
                    ? { ...p, quantity: 1 }
                    : p
            )
        );
    };

    // Dirty detection comparing to initial loader state
    const isDirty = Boolean(
        title.trim() !== data.title ||
        widgetTitle.trim() !== (data.widgetTitle || "") ||
        percentage !== data.percentage ||
        combinesWithOrder !== Boolean(data.combinesWith.orderDiscounts) ||
        combinesWithProduct !== Boolean(data.combinesWith.productDiscounts) ||
        combinesWithShipping !== Boolean(data.combinesWith.shippingDiscounts) ||
        startsAtDate !== (data.startsAtDate || data.startsAt || todayStr) ||
        startsAtTime !== (data.startsAtTime || "00:00:00") ||
        hasEndDate !== data.hasEndDate ||
        (hasEndDate && endsAtDate !== (data.endsAtDate || data.endsAt || "")) ||
        (hasEndDate && endsAtTime !== (data.endsAtTime || "23:59:59")) ||
        JSON.stringify(mainProducts.map((p) => ({
            id: p.id,
            quantity: Number(p.quantity) || 1,
            variants: (p.variants || []).map((v) => String(typeof v === "object" ? v.id : v)).sort(),
        }))) !==
        JSON.stringify(data.initialMainProducts.map((p) => ({
            id: p.id,
            quantity: Number(p.quantity) || 1,
            variants: (p.variants || []).map((v) => String(typeof v === "object" ? v.id : v)).sort(),
        }))) ||
        JSON.stringify(subProducts.map((p) => ({
            id: p.id,
            quantity: Number(p.quantity) || 1,
            variants: (p.variants || []).map((v) => String(typeof v === "object" ? v.id : v)).sort(),
        }))) !==
        JSON.stringify(data.initialSubProducts.map((p) => ({
            id: p.id,
            quantity: Number(p.quantity) || 1,
            variants: (p.variants || []).map((v) => String(typeof v === "object" ? v.id : v)).sort(),
        })))
    );

    const showSaveBar = (isDirty || isSubmitting) && !isRedirecting;

    useEffect(() => {
        if (isRedirecting) {
            setIsSaving(false);
            shopify.saveBar?.hide("edit-paired-offer-save-bar");
        }
    }, [isRedirecting, shopify]);

    useEffect(() => {
        if (navigation.state === "idle") {
            setIsSaving(false);
        }
    }, [navigation.state]);

    useEffect(() => {
        return () => {
            shopify.saveBar?.hide("edit-paired-offer-save-bar");
        };
    }, [shopify]);

    const handleDiscard = (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        setTitle(data.title);
        setPercentage(data.percentage);
        setMainProducts(data.initialMainProducts);
        setSubProducts(data.initialSubProducts);
        setCombinesWithOrder(data.combinesWith.orderDiscounts || false);
        setCombinesWithProduct(data.combinesWith.productDiscounts || false);
        setCombinesWithShipping(data.combinesWith.shippingDiscounts || false);
        setStartsAtDate(data.startsAtDate || data.startsAt || todayStr);
        setStartsAtTime(data.startsAtTime || "00:00:00");
        setHasEndDate(data.hasEndDate);
        setEndsAtDate(data.endsAtDate || data.endsAt || "");
        setEndsAtTime(data.endsAtTime || "23:59:59");
        setIsSaving(false);
        shopify.saveBar?.hide("edit-paired-offer-save-bar");
    };

    useEffect(() => {
        if (actionData?.error) {
            setIsSaving(false);
            shopify.toast.show(actionData.error, { isError: true });
        }
    }, [actionData, shopify]);

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
        if (mainProducts.length === 0) {
            shopify.toast.show("Please select at least one Main Product", { isError: true });
            return;
        }
        if (subProducts.length === 0) {
            shopify.toast.show("Please select at least one Sub / Add-on Product", { isError: true });
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
        formData.append("title", title);
        formData.append("widgetTitle", widgetTitle);
        formData.append("percentage", percentage);
        formData.append(
            "mainProductIds",
            JSON.stringify(mainProducts.map((p) => p.id))
        );
        formData.append(
            "subProductIds",
            JSON.stringify(subProducts.map((p) => p.id))
        );
        formData.append(
            "mainProducts",
            JSON.stringify(
                mainProducts.map((p) => ({
                    id: p.id,
                    quantity: Math.max(1, parseInt(p.quantity, 10) || 1),
                    variants: (p.variants || []).map((v) => ({ id: typeof v === "object" ? v.id : v })),
                }))
            )
        );
        formData.append(
            "subProducts",
            JSON.stringify(
                subProducts.map((p) => ({
                    id: p.id,
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

    useEffect(() => {
        setTitle(data.title);
        setPercentage(data.percentage);
        setMainProducts(data.initialMainProducts);
        setSubProducts(data.initialSubProducts);
        setCombinesWithOrder(data.combinesWith.orderDiscounts || false);
        setCombinesWithProduct(data.combinesWith.productDiscounts || false);
        setCombinesWithShipping(data.combinesWith.shippingDiscounts || false);
        setStartsAtDate(data.startsAtDate || data.startsAt || todayStr);
        setStartsAtTime(data.startsAtTime || "00:00:00");
        setHasEndDate(data.hasEndDate);
        setEndsAtDate(data.endsAtDate || data.endsAt || "");
        setEndsAtTime(data.endsAtTime || "23:59:59");
        setIsSaving(false);
        shopify.saveBar?.hide("edit-paired-offer-save-bar");
    }, [data, todayStr, shopify]);

    const isDeactivatedOrExpired =
        data.shopifyStatus === "EXPIRED" ||
        (hasEndDate && endsAtDate && endsAtDate < todayStr);

    const handleDeactivateOffer = () => {
        setIsSaving(false);
        shopify.saveBar?.hide("edit-paired-offer-save-bar");
        const formData = new FormData();
        formData.append("intent", "deactivate");
        formData.append("discountNodeId", data.discountNodeId);
        submit(formData, { method: "post" });
    };

    const handleActivateOffer = () => {
        setIsSaving(false);
        shopify.saveBar?.hide("edit-paired-offer-save-bar");
        const formData = new FormData();
        formData.append("intent", "activate");
        formData.append("discountNodeId", data.discountNodeId);
        submit(formData, { method: "post" });
    };

    const handleDeleteOffer = () => {
        setIsSaving(false);
        shopify.saveBar?.hide("edit-paired-offer-save-bar");
        const formData = new FormData();
        formData.append("intent", "delete");
        formData.append("discountNodeId", data.discountNodeId);
        submit(formData, { method: "post" });
    };

    const effectiveStartsAtISO = startsAtDate ? dateToShopISO(startsAtDate, startsAtTime, data.shopTimezone) : null;
    const effectiveEndsAtISO = hasEndDate && endsAtDate ? dateToShopISO(endsAtDate, endsAtTime, data.shopTimezone) : null;

    const status = computeOfferStatus({
        startsAt: effectiveStartsAtISO,
        endsAt: effectiveEndsAtISO,
        status: data.shopifyStatus === "EXPIRED" ? "EXPIRED" : "ACTIVE",
    });
    const statusTone =
        status === "ACTIVE"
            ? "success"
            : status === "SCHEDULED"
                ? "warning"
                : "neutral";
    const statusLabel =
        status === "ACTIVE"
            ? "Active"
            : status === "SCHEDULED"
                ? "Scheduled"
                : "Expired";

    return (
        <s-page heading={`Edit Offer: ${title || data.title}`}>
            <s-link slot="breadcrumb-actions" href="/app/paired-products">
                Paired Products Offers
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

            <SaveBar id="edit-paired-offer-save-bar" open={showSaveBar}>
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
                                    placeholder="e.g. Phone + Charger Bundle 20% OFF"
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
                                    placeholder="10"
                                    value={percentage}
                                    onInput={(e) => setPercentage(e.target.value)}
                                ></s-number-field>
                            </s-grid-item>

                            <s-grid-item gridColumn="span 10">
                                <s-text-field
                                    label="Widget title (Displayed on Product Page)"
                                    name="widgetTitle"
                                    placeholder="e.g. Frequently Bought Together (leave blank for default)"
                                    value={widgetTitle}
                                    onInput={(e) => setWidgetTitle(e.target.value)}
                                    details="Custom heading shown above the bundle widget on the storefront for this offer."
                                ></s-text-field>
                            </s-grid-item>
                        </s-grid>
                    </s-section>

                    {/* 1. Main Products */}
                    <s-section heading="1. Select Main Product(s)">
                        <s-stack gap="base">
                            <s-paragraph tone="subdued">
                                Choose the primary product page(s) where this bundle will be displayed. When a customer views any of these product pages, the bundle widget will appear.
                            </s-paragraph>

                            <s-stack gap="base">
                                <s-stack background="subdued" padding="small" borderRadius="base" direction="inline" justifyContent="space-between" alignItems="center">
                                    <s-text weight="bold">
                                        {mainProducts.length} Main Product(s) selected
                                    </s-text>
                                    <s-button type="button" variant="primary" onClick={handleOpenMainProductPicker}>
                                        Browse Main Products
                                    </s-button>
                                </s-stack>

                                {mainProducts.length > 0 ? (
                                    <s-box>
                                        {mainProducts.map((p, idx) => (
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
                                                                Qty:
                                                            </s-text>
                                                            <div style={{ width: "80px" }}>
                                                                <s-number-field
                                                                    // label="Quantity"
                                                                    label-hidden
                                                                    min="1"
                                                                    step="1"
                                                                    value={String(p.quantity ?? 1)}
                                                                    onInput={(e) => updateMainProductQuantity(p.id, e.target.value)}
                                                                    onBlur={() => handleBlurMainProductQuantity(p.id)}
                                                                ></s-number-field>
                                                            </div>
                                                            <s-button
                                                                type="button"
                                                                variant="primary" tone="critical"
                                                                icon="delete"
                                                                accessibilityLabel={`Remove ${p.title}`}
                                                                onClick={(e) => {
                                                                    e.preventDefault();
                                                                    e.stopPropagation();
                                                                    removeMainProduct(p.id);
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
                                        No main products selected yet. Click &quot;Browse Main Products&quot; to pick.
                                    </s-paragraph>
                                )}
                            </s-stack>
                        </s-stack>
                    </s-section>

                    {/* 2. Sub Products */}
                    <s-section heading="2. Select Sub / Add-on Product(s)">
                        <s-stack gap="base">
                            <s-paragraph tone="subdued">
                                Choose the companion/accessory product(s) bundled with the main product. All selected companion products will be displayed together in the storefront bundle widget.
                            </s-paragraph>

                            <s-stack gap="base">
                                <s-stack background="subdued" padding="small" borderRadius="base" direction="inline" justifyContent="space-between" alignItems="center">
                                    <s-text weight="bold">
                                        {subProducts.length} Sub Product(s) selected
                                    </s-text>
                                    <s-button type="button" variant="primary" onClick={handleOpenSubProductPicker}>
                                        Browse Sub Products
                                    </s-button>
                                </s-stack>

                                {subProducts.length > 0 ? (
                                    <s-box>
                                        {subProducts.map((p, idx) => (
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
                                                                Qty:
                                                            </s-text>
                                                            <div style={{ width: "80px" }}>
                                                                <s-number-field
                                                                    //   label="Quantity"
                                                                    label-hidden
                                                                    min="1"
                                                                    step="1"
                                                                    value={String(p.quantity ?? 1)}
                                                                    onInput={(e) => updateSubProductQuantity(p.id, e.target.value)}
                                                                    onBlur={() => handleBlurSubProductQuantity(p.id)}
                                                                ></s-number-field>
                                                            </div>
                                                            <s-button
                                                                type="button"
                                                                variant="primary" tone="critical"
                                                                icon="delete"
                                                                accessibilityLabel={`Remove ${p.title}`}
                                                                onClick={(e) => {
                                                                    e.preventDefault();
                                                                    e.stopPropagation();
                                                                    removeSubProduct(p.id);
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
                                        No sub products selected yet. Click &quot;Browse Sub Products&quot; to pick.
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
                            <s-grid
                                gridTemplateColumns="repeat(2, 1fr)"
                                gap="base"
                            >
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
                        <s-grid
                            gridTemplateColumns="auto minmax(0, 1fr)"
                            gap="base"
                            alignItems="start"
                        >
                            <s-box
                                padding="small"
                                background="subdued"
                                borderRadius="base"
                            >
                                <s-icon type="settings" />
                            </s-box>

                            <s-stack gap="small-100">
                                <s-heading type="strong">
                                    Managed store-wide in App Settings
                                </s-heading>

                                <s-paragraph color="subdued">
                                    Discount combinations (Product, Order, and Shipping)
                                    apply globally across all offers. You can configure
                                    them anytime in{" "}
                                    <s-link href="/app/settings">
                                        Settings → Combinations
                                    </s-link>.
                                </s-paragraph>
                            </s-stack>
                        </s-grid>
                    </s-section>

                </s-stack>
            </form>



            {/* Right side Sidebar: Summary in slot="aside" */}
            <s-section slot="aside" heading="Summary">
                <s-badge slot="supplemental" tone={statusTone}>
                    {statusLabel}
                </s-badge>
                <s-stack gap="base">
                    <s-stack gap="tight">
                        <s-text weight="bold">Offer title</s-text>
                        <s-paragraph tone={title.trim() ? "default" : "subdued"}>
                            {title.trim() || "No title set"}
                        </s-paragraph>
                    </s-stack>

                    <s-stack gap="tight">
                        <s-text weight="bold">Discount value</s-text>
                        <s-paragraph tone="subdued">
                            • {percentage ? `${percentage}% off order subtotal` : "No discount value set"}
                        </s-paragraph>
                    </s-stack>

                    <s-stack gap="tight">
                        <s-text weight="bold">Target products (Main)</s-text>
                        {mainProducts.length > 0 ? (
                            mainProducts.map((p) => (
                                <s-paragraph key={p.id} tone="subdued">
                                    • {p.quantity || 1}x {p.title}
                                </s-paragraph>
                            ))
                        ) : (
                            <s-paragraph tone="subdued">• No main products selected</s-paragraph>
                        )}
                    </s-stack>

                    <s-stack gap="tight">
                        <s-text weight="bold">Offer products (Sub / Add-on)</s-text>
                        {subProducts.length > 0 ? (
                            subProducts.map((p) => (
                                <s-paragraph key={p.id} tone="subdued">
                                    • {p.quantity || 1}x {p.title}
                                </s-paragraph>
                            ))
                        ) : (
                            <s-paragraph tone="subdued">• No sub products selected</s-paragraph>
                        )}
                    </s-stack>

                    <s-stack gap="tight">
                        <s-text weight="bold">Combinations</s-text>
                        <s-paragraph tone="subdued">
                            • Managed store-wide in <s-link href="/app/settings">Settings</s-link>
                        </s-paragraph>
                    </s-stack>

                    <s-stack gap="tight">
                        <s-text weight="bold">Active dates</s-text>
                        <s-paragraph tone="subdued">
                            • Starts {startsAtDate || todayStr} at {formatTime12h(startsAtTime)} ({tzAbbr})
                            {hasEndDate && endsAtDate ? ` • Ends ${endsAtDate} at ${formatTime12h(endsAtTime)} (${tzAbbr})` : ""}
                        </s-paragraph>
                    </s-stack>

                    <s-stack background="subdued" padding="small" borderRadius="base" gap="small">
                        <s-text size="small" weight="bold">How it applies:</s-text>
                        <s-paragraph size="small" tone="subdued">
                            When a customer adds the required quantity of Main and Sub products to cart, {percentage || "0"}% discount will be applied automatically at checkout.
                        </s-paragraph>
                    </s-stack>
                </s-stack>
            </s-section>

            {/* Live Widget Preview */}
            <WidgetPreview
                title={title}
                widgetTitle={widgetTitle}
                percentage={percentage}
                mainProducts={mainProducts}
                subProducts={subProducts}
                shopDomain={data.shop}
                widgetSettings={data.widgetSettings}
            />

            {/* Performance & Usage Analytics */}
            <s-section slot="aside" heading="Performance">
                <s-stack gap="base">
                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                        <s-text tone="subdued">Times used</s-text>
                        <s-text weight="bold">{data.analytics?.usageCount || 0} times</s-text>
                    </s-stack>
                    <s-divider />
                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                        <s-text tone="subdued">Total sales</s-text>
                        <s-text weight="bold">${(data.analytics?.totalRevenue || 0).toFixed(2)}</s-text>
                    </s-stack>
                    <s-divider />
                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                        <s-text tone="subdued">Total discount</s-text>
                        <s-text weight="bold">${(data.analytics?.totalDiscountAmount || 0).toFixed(2)}</s-text>
                    </s-stack>
                </s-stack>
            </s-section>
        </s-page>
    );
}