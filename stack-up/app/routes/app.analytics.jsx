/* eslint-disable react/prop-types */
import { useState, useEffect } from "react";
import { useLoaderData, useSearchParams, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { syncRecentOrdersFromShopify } from "../utils/orders.server";
import { resolveAnalyticsRange, generateDailyBuckets } from "../utils/dateRange";
import DailyTrendChart from "./components/chart/daily-trend-chart";
import OffersComparisonChart from "./components/chart/offers-comparison-chart";
import OffersTable from "./components/table/offers-table";
import ProductsTable from "./components/table/products-table";
import DatePicker from "./components/DatePicker"

// In-memory currency and shop details cache per shop domain to avoid redundant GraphQL roundtrips
const shopDetailsCache = new Map();

async function getShopDetails(admin, shopDomain) {
    if (shopDomain && shopDetailsCache.has(shopDomain)) {
        return shopDetailsCache.get(shopDomain);
    }
    try {
        const shopRes = await admin.graphql(`#graphql
            query GetShopDetails {
                shop {
                    currencyCode
                    ianaTimezone
                }
            }
        `);
        const shopJson = await shopRes.json();
        const currencyCode = shopJson.data?.shop?.currencyCode || "USD";
        const ianaTimezone = shopJson.data?.shop?.ianaTimezone || "UTC";

        const currencySymbol =
            new Intl.NumberFormat("en-US", {
                style: "currency",
                currency: currencyCode,
                currencyDisplay: "narrowSymbol",
            })
                .formatToParts(0)
                .find((part) => part.type === "currency")?.value || currencyCode;

        const result = { currencyCode, currencySymbol, ianaTimezone };
        if (shopDomain) shopDetailsCache.set(shopDomain, result);
        return result;
    } catch (err) {
        console.warn("Could not query shop details:", err);
        return { currencyCode: "USD", currencySymbol: "$", ianaTimezone: "UTC" };
    }
}

// In-memory product details cache (5 minute TTL) to make range switching instant
const productDetailsCache = new Map();
const PRODUCT_CACHE_TTL_MS = 5 * 60 * 1000;

export const loader = async ({ request }) => {
    const t0 = performance.now();
    const { admin, session } = await authenticate.admin(request);
    const shop = session?.shop || "";
    const url = new URL(request.url);

    // 1. Parallelize shop details (timezone, currency) and background order sync
    const [shopDetails] = await Promise.all([
        getShopDetails(admin, shop),
        shop ? syncRecentOrdersFromShopify(admin, shop).catch((e) => {
            console.warn("Could not sync recent orders in analytics loader:", e);
            return 0;
        }) : Promise.resolve(0),
    ]);
    const { currencyCode, currencySymbol, ianaTimezone } = shopDetails;

    // 2. Resolve date boundaries using local date matching frontend
    const { startDate, endDate, rangeKey, activePresetLabel } = resolveAnalyticsRange(
        url.searchParams
    );

    // 3. Parallelize database queries for Paired Offers, Selected Offers, and Order Usages
    const shopName = shop.replace(".myshopify.com", "");
    const shopConditions = [
        { shop },
        { shop: shopName },
        { shop: `${shopName}.myshopify.com` },
    ];

    let allOffers = [];
    let ordersInRange = [];

    const dateFilter = {
        gte: startDate,
        lte: endDate,
    };

    try {
        [allOffers, ordersInRange] = await Promise.all([
            db.offer.findMany({
                where: { OR: shopConditions },
                include: {
                    orders: {
                        where: { createdAt: dateFilter },
                        orderBy: { createdAt: "desc" },
                    },
                },
                orderBy: { createdAt: "desc" },
            }),
            db.orderUsage.findMany({
                where: {
                    OR: shopConditions,
                    createdAt: dateFilter,
                },
                orderBy: { createdAt: "asc" },
            }),
        ]);
    } catch (err) {
        console.warn("Could not query DB for analytics:", err);
    }

    // 4. Aggregate KPI Summary (deduplicating multi-offer orders)
    const uniqueOrderMap = new Map();
    ordersInRange.forEach((o) => {
        if (!uniqueOrderMap.has(o.orderId)) {
            uniqueOrderMap.set(o.orderId, o);
        }
    });

    const totalOrders = uniqueOrderMap.size;
    const revenueGenerated = Array.from(uniqueOrderMap.values()).reduce((acc, o) => acc + (o.totalPrice || 0), 0);
    const totalDiscountAmount = ordersInRange.reduce((acc, o) => acc + (o.discountAmount || 0), 0);
    const aov = totalOrders > 0 ? revenueGenerated / totalOrders : 0;
    const roi =
        revenueGenerated > 0 && totalDiscountAmount > 0
            ? Math.round(((revenueGenerated - totalDiscountAmount) / totalDiscountAmount) * 100)
            : 0;

    // 5. Build Daily Time Series for Chart 1 using chronological bucket generator
    const dailyBuckets = generateDailyBuckets(startDate, endDate);
    const bucketMap = {};
    dailyBuckets.forEach((b, idx) => {
        bucketMap[b.dateStr] = idx;
    });

    Array.from(uniqueOrderMap.values()).forEach((order) => {
        const orderDateStr = new Date(order.createdAt).toISOString().split("T")[0];
        const idx = bucketMap[orderDateStr];
        if (idx !== undefined) {
            dailyBuckets[idx].orders += 1;
            dailyBuckets[idx].sales += order.totalPrice || 0;
        }
    });

    dailyBuckets.forEach((b) => {
        b.aov = b.orders > 0 ? b.sales / b.orders : 0;
    });

    // Helper to safely extract products from any offer type
    const getOfferProductsList = (off) => {
        try {
            if (off.type === "PAIRED") {
                const p1 = JSON.parse(off.mainProducts || "[]");
                const p2 = JSON.parse(off.subProducts || "[]");
                return { p1, p2, all: [...p1, ...p2] };
            }
            if (off.type === "VOLUME") {
                let vProds = [];
                if (off.volumeProducts) {
                    vProds = JSON.parse(off.volumeProducts);
                } else if (off.configuration) {
                    vProds = JSON.parse(off.configuration)?.volumeProducts || [];
                }
                return { p1: vProds, p2: [], all: vProds };
            }
            // SELECTED
            const p1 = JSON.parse(off.targetProducts || "[]");
            const p2 = JSON.parse(off.offeredProducts || off.products || "[]");
            return { p1, p2, all: [...p1, ...p2] };
        } catch {
            return { p1: [], p2: [], all: [] };
        }
    };

    // 6. Build Offers Comparison for Chart 2 & Table 1
    const offersData = allOffers.map((off) => {
        const offOrders = off.orders || [];
        const ordersCount = offOrders.length || off.usageCount || 0;
        const salesAmount = offOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0) || off.totalRevenue || 0;

        let discountType = "Paired Products";
        if (off.type === "SELECTED") discountType = "Selected Products";
        else if (off.type === "VOLUME") discountType = "Volume Discount";

        const prods = getOfferProductsList(off);

        return {
            id: off.id,
            numericId: off.numericId,
            title: off.title,
            discountType,
            percentage: off.percentage,
            status: off.status,
            totalOrders: ordersCount,
            totalSale: salesAmount,
            cartClicks: 0,
            bundleViews: 0,
            mainProducts: JSON.stringify(prods.p1),
            subProducts: JSON.stringify(prods.p2),
        };
    });

    // 7. Collect unique product GIDs across all active offers
    const allProdIdsSet = new Set();
    allOffers.forEach((off) => {
        const prods = getOfferProductsList(off);
        prods.all.forEach((p) => {
            if (p && p.id) {
                const gid = String(p.id).startsWith("gid://shopify/Product/")
                    ? String(p.id)
                    : `gid://shopify/Product/${p.id}`;
                allProdIdsSet.add(gid);
            }
        });
    });

    const allProductIds = Array.from(allProdIdsSet);
    const shopifyProductDetails = {};

    // 8. Fetch product details with in-memory caching to prevent repeating GraphQL queries
    const nowMs = Date.now();
    const uncachedIds = allProductIds.filter((id) => {
        const entry = productDetailsCache.get(id);
        return !entry || nowMs - entry.timestamp > PRODUCT_CACHE_TTL_MS;
    });

    if (uncachedIds.length > 0) {
        try {
            const prodRes = await admin.graphql(
                `#graphql
                query GetProductsForAnalytics($ids: [ID!]!) {
                    nodes(ids: $ids) {
                        ... on Product {
                            id
                            title
                            totalInventory
                            featuredImage {
                                url
                            }
                            variants(first: 20) {
                                nodes {
                                    price
                                    inventoryQuantity
                                }
                            }
                        }
                    }
                }`,
                { variables: { ids: uncachedIds } }
            );
            const prodJson = await prodRes.json();
            const nodes = prodJson.data?.nodes || [];
            nodes.forEach((n) => {
                if (n && n.id) {
                    let qty = n.totalInventory;
                    if (qty === null || qty === undefined) {
                        qty = n.variants?.nodes?.reduce((sum, v) => sum + (v.inventoryQuantity || 0), 0) ?? 0;
                    }
                    const rawPrice = n.variants?.nodes?.[0]?.price;
                    const price = rawPrice ? (String(rawPrice).startsWith("$") ? String(rawPrice) : `$${rawPrice}`) : "";

                    const itemData = {
                        title: n.title,
                        image: n.featuredImage?.url || "",
                        price,
                        availableQuantity: Number(qty),
                    };

                    productDetailsCache.set(n.id, { data: itemData, timestamp: nowMs });
                    const numericId = n.id.split("/").pop();
                    if (numericId) {
                        productDetailsCache.set(numericId, { data: itemData, timestamp: nowMs });
                    }
                }
            });
        } catch (err) {
            console.warn("Could not query Shopify product details for analytics:", err);
        }
    }

    // Populate lookup from cache
    allProductIds.forEach((id) => {
        const cached = productDetailsCache.get(id);
        if (cached?.data) {
            shopifyProductDetails[id] = cached.data;
            const numericId = id.split("/").pop();
            if (numericId) shopifyProductDetails[numericId] = cached.data;
        }
    });

    const productMap = {};

    const addProductToMap = (p, ordersCount) => {
        if (!p || !p.id) return;
        const pid = String(p.id);
        const numericId = pid.split("/").pop();
        const details = shopifyProductDetails[pid] || shopifyProductDetails[numericId] || {};

        if (!productMap[pid]) {
            productMap[pid] = {
                id: pid,
                name: details.title || p.title || "Product",
                image: details.image || p.image || "",
                price: details.price || p.price || "",
                bundleCount: 0,
                totalOrders: 0,
                availableQuantity: details.availableQuantity !== undefined ? details.availableQuantity : 0,
            };
        }
        productMap[pid].bundleCount += 1;
        productMap[pid].totalOrders += ordersCount;
    };

    allOffers.forEach((off) => {
        const prods = getOfferProductsList(off);
        const offOrders = off.orders || [];
        const ordersCount = offOrders.length || off.usageCount || 0;

        prods.all.forEach((p) => addProductToMap(p, ordersCount));
    });

    const productsList = Object.values(productMap).sort((a, b) => b.totalOrders - a.totalOrders);
    const tEnd = performance.now();
    console.log(`⏱️ [AnalyticsLoader] Loaded in ${(tEnd - t0).toFixed(0)}ms (${offersData.length} offers, ${productsList.length} products, ${totalOrders} orders)`);

    return {
        range: rangeKey,
        activePresetLabel,
        startDate: startDate.toISOString().split("T")[0],
        endDate: endDate.toISOString().split("T")[0],
        currencySymbol,
        currencyCode,
        ianaTimezone,
        kpi: {
            revenueGenerated,
            totalOrders,
            aov,
            roi,
        },
        dailyBuckets,
        offersData,
        productsList,
    };
};

export default function Analytics() {
    const { range, activePresetLabel, startDate, endDate, currencySymbol, ianaTimezone, kpi, dailyBuckets, offersData, productsList } = useLoaderData();
    const [searchParams, setSearchParams] = useSearchParams();
    const navigation = useNavigation();
    const shopify = useAppBridge();

    // Client-side mount flag for Recharts
    const [isMounted, setIsMounted] = useState(false);
    useEffect(() => {
        setIsMounted(true);
    }, []);

    // Show App Bridge loading spinner during date range transitions
    const isNavigating = navigation.state === "loading";
    useEffect(() => {
        try {
            shopify.loading(isNavigating);
        } catch {
            // ignore if outside embedded bridge
        }
    }, [isNavigating, shopify]);

    // Map preset labels to short range tokens for clean URLs
    const PRESET_TO_RANGE = {
        "Today": "today",
        "Yesterday": "yesterday",
        "Last 7 days": "7d",
        "Last 30 Days": "30d",
        "Last 90 Days": "90d",
        "This Month": "this_month",
        "Last Month": "last_month",
    };

    // Handle Range change from DatePicker (Apply callback)
    const handleDatePickerApply = ({ preset, startDate: sDate, endDate: eDate }) => {
        const params = new URLSearchParams();
        if (preset && preset !== "Custom") {
            const shortRange = PRESET_TO_RANGE[preset] || "30d";
            params.set("range", shortRange);
        } else if (sDate && eDate) {
            params.set("startDate", sDate);
            params.set("endDate", eDate);
        }
        setSearchParams(params);
    };

    // 4 KPI Summary Cards Configuration
    const kpiCards = [
        {
            title: "Revenue generated",
            value: `${currencySymbol}${kpi.revenueGenerated.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
            })}`,
            subtext: "Gross bundle sales",
            icon: <s-icon type="money" />,
        },
        {
            title: "Total Orders",
            value: kpi.totalOrders.toLocaleString(),
            subtext: "Paired product orders",
            icon: <s-icon type="order" />,
        },
        {
            title: "Average order value",
            value: `${currencySymbol}${kpi.aov.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
            })}`,
            subtext: "Per bundle checkout",
            icon: <s-icon type="chart-vertical" />,
        },
        {
            title: "Bundle ROI",
            value: `${kpi.roi}%`,
            subtext: "Return on discount",
            icon: <s-icon type="chart-line" />,
        },
    ];

    return (
        <s-page heading="Analytics">
            <s-box paddingBlockEnd="base">
                <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                    <s-heading tone="subdued">
                        Track revenue, orders, and bundle performance. Use the date range to compare metrics.
                    </s-heading>

                    {/* Date Range Selector */}
                    <DatePicker
                        initialPreset={activePresetLabel || "Last 30 Days"}
                        initialStartDate={startDate}
                        initialEndDate={endDate}
                        onApply={handleDatePickerApply}
                    />
                </s-stack>
            </s-box>

            <s-stack gap="base">
                <s-section padding="base">
                    {/* KPI Tooltips outside the grid layout */}
                    {kpiCards.map((card, i) => (
                        <s-tooltip key={`tooltip-${i}`} id={`kpi-tooltip-${i}`}>
                            {card.subtext}
                        </s-tooltip>
                    ))}

                    <s-grid
                        gridTemplateColumns="@container (inline-size <= 600px) 1fr, 1fr auto 1fr auto 1fr auto 1fr"
                        gap="small"
                        alignItems="center"
                    >
                        {kpiCards.flatMap((card, i) => [
                            i > 0 ? (
                                <s-divider
                                    key={`divider-${i}`}
                                    direction="block"
                                />
                            ) : null,

                            <s-clickable
                                key={`card-${i}`}
                                interestFor={`kpi-tooltip-${i}`}
                                paddingBlock="small-400"
                                paddingInline="small-100"
                                borderRadius="base"
                            >
                                <s-stack
                                    direction="inline"
                                    alignItems="center"
                                    gap="base"
                                >
                                    <s-box
                                        padding="small"
                                        background="subdued"
                                        borderRadius="base"
                                    >
                                        {card.icon}
                                    </s-box>

                                    <s-stack gap="small-500">
                                        <s-heading>{card.title}</s-heading>

                                        {i === 0 ? (
                                            <s-badge tone="success">
                                                {card.value}
                                            </s-badge>
                                        ) : i === 1 ? (
                                            <s-badge tone="info">
                                                {card.value}
                                            </s-badge>
                                        ) : i === 2 ? (
                                            <s-badge tone="caution">
                                                {card.value}
                                            </s-badge>
                                        ) : (
                                            <s-badge tone="warning">
                                                {card.value}
                                            </s-badge>
                                        )}
                                    </s-stack>
                                </s-stack>
                            </s-clickable>,
                        ])}
                    </s-grid>
                </s-section>

                {/* CHART 1: Daily Breakdown / Trend Area Chart */}
                <DailyTrendChart
                    dailyBuckets={dailyBuckets}
                    kpi={kpi}
                    currencySymbol={currencySymbol}
                    isMounted={isMounted}
                />

                {/* CHART 2: Orders by Offer Bar Chart */}
                <OffersComparisonChart
                    offersData={offersData}
                    currencySymbol={currencySymbol}
                    isMounted={isMounted}
                />

                {/* TABLE 1: Top Selling Offers */}
                <OffersTable offersData={offersData} currencySymbol={currencySymbol} />

                {/* TABLE 2: Top Selling Products */}
                <ProductsTable productsList={productsList} />
            </s-stack>
        </s-page>
    );
}