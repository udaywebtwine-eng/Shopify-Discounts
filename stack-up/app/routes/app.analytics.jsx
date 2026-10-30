/* eslint-disable react/prop-types */
import { useState, useEffect } from "react";
import { useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import DailyTrendChart from "./components/chart/daily-trend-chart";
import OffersComparisonChart from "./components/chart/offers-comparison-chart";
import OffersTable from "./components/table/offers-table";
import ProductsTable from "./components/table/products-table";

export const loader = async ({ request }) => {
    const { admin, session } = await authenticate.admin(request);
    const url = new URL(request.url);
    const range = url.searchParams.get("range") || "30d";

    // 1. Fetch currency from Shopify
    let currencyCode = "USD";
    let currencySymbol = "$";
    try {
        const shopRes = await admin.graphql(`#graphql
            query GetShopCurrency {
                shop {
                    currencyCode
                }
            }
        `);
        const shopJson = await shopRes.json();
        currencyCode = shopJson.data?.shop?.currencyCode || "USD";

        // Dynamically resolve currency symbol for any worldwide currency
        currencySymbol =
            new Intl.NumberFormat("en-US", {
                style: "currency",
                currency: currencyCode,
                currencyDisplay: "narrowSymbol",
            })
                .formatToParts(0)
                .find((part) => part.type === "currency")?.value || currencyCode;
    } catch (err) {
        console.warn("Could not query shop currency:", err);
    }

    // 2. Calculate date range boundaries
    const now = new Date();
    const startDate = new Date();
    let daysCount = 30;

    if (range === "today") {
        startDate.setHours(0, 0, 0, 0);
        daysCount = 1;
    } else if (range === "7d") {
        startDate.setDate(now.getDate() - 7);
        daysCount = 7;
    } else if (range === "90d") {
        startDate.setDate(now.getDate() - 90);
        daysCount = 90;
    } else {
        // 30d default
        startDate.setDate(now.getDate() - 30);
        daysCount = 30;
    }

    // 3. Query DB offers
    let offers = [];
    try {
        offers = await db.pairedOffer.findMany({
            where: { shop: session.shop },
            include: {
                orders: {
                    orderBy: { createdAt: "desc" },
                },
            },
            orderBy: { createdAt: "desc" },
        });
    } catch (err) {
        console.warn("Could not query paired offers:", err);
    }

    // 4. Query DB order usages within date range
    let ordersInRange = [];
    try {
        ordersInRange = await db.orderUsage.findMany({
            where: {
                shop: session.shop,
                createdAt: { gte: startDate },
            },
            orderBy: { createdAt: "asc" },
        });
    } catch (err) {
        console.warn("Could not query orders in range:", err);
    }

    // 5. Aggregate KPI Summary
    const totalOrders = ordersInRange.length;
    const revenueGenerated = ordersInRange.reduce((acc, o) => acc + (o.totalPrice || 0), 0);
    const totalDiscountAmount = ordersInRange.reduce((acc, o) => acc + (o.discountAmount || 0), 0);
    const aov = totalOrders > 0 ? revenueGenerated / totalOrders : 0;
    const roi =
        revenueGenerated > 0 && totalDiscountAmount > 0
            ? Math.round(((revenueGenerated - totalDiscountAmount) / totalDiscountAmount) * 100)
            : 0;

    // 6. Build Daily Time Series for Chart 1
    const dailyBuckets = [];
    const bucketCount = Math.min(daysCount, 30);
    for (let i = bucketCount - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split("T")[0];
        const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        dailyBuckets.push({
            dateStr,
            label,
            orders: 0,
            sales: 0,
            aov: 0,
        });
    }

    const bucketMap = {};
    dailyBuckets.forEach((b, idx) => {
        bucketMap[b.dateStr] = idx;
    });

    ordersInRange.forEach((order) => {
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

    // 7. Build Offers Comparison for Chart 2 & Table 1
    const offersData = offers.map((off) => {
        // Count orders in selected date range
        const offOrders = off.orders.filter((o) => new Date(o.createdAt) >= startDate);
        const ordersCount = offOrders.length || off.usageCount || 0;
        const salesAmount = offOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0) || off.totalRevenue || 0;

        return {
            id: off.id,
            numericId: off.numericId,
            title: off.title,
            discountType: "Paired Products",
            percentage: off.percentage,
            status: off.status,
            totalOrders: ordersCount,
            totalSale: salesAmount,
            cartClicks: 0,
            bundleViews: 0,
            mainProducts: off.mainProducts,
            subProducts: off.subProducts,
        };
    });

    // 8. Build Top Selling Products for Table 2 with real Shopify product details & inventory
    const allProdIdsSet = new Set();
    offers.forEach((off) => {
        let mProds = [];
        let sProds = [];
        try {
            mProds = JSON.parse(off.mainProducts || "[]");
            sProds = JSON.parse(off.subProducts || "[]");
        } catch {
            mProds = [];
            sProds = [];
        }

        [...mProds, ...sProds].forEach((p) => {
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

    if (allProductIds.length > 0) {
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
                { variables: { ids: allProductIds } }
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
                    shopifyProductDetails[n.id] = itemData;
                    const numericId = n.id.split("/").pop();
                    if (numericId) {
                        shopifyProductDetails[numericId] = itemData;
                    }
                }
            });
        } catch (err) {
            console.warn("Could not query Shopify product details for analytics:", err);
        }
    }

    const productMap = {};
    offers.forEach((off) => {
        let mProds = [];
        let sProds = [];
        try {
            mProds = JSON.parse(off.mainProducts || "[]");
            sProds = JSON.parse(off.subProducts || "[]");
        } catch {
            mProds = [];
            sProds = [];
        }

        const offOrders = off.orders.filter((o) => new Date(o.createdAt) >= startDate);
        const ordersCount = offOrders.length || off.usageCount || 0;

        [...mProds, ...sProds].forEach((p) => {
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
        });
    });

    const productsList = Object.values(productMap).sort((a, b) => b.totalOrders - a.totalOrders);

    return {
        range,
        currencySymbol,
        currencyCode,
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
    const { range, currencySymbol, kpi, dailyBuckets, offersData, productsList } = useLoaderData();
    const [searchParams, setSearchParams] = useSearchParams();

    // Client-side mount flag for Recharts
    const [isMounted, setIsMounted] = useState(false);
    useEffect(() => {
        setIsMounted(true);
    }, []);

    // Handle Range change
    const handleRangeChange = (newRange) => {
        const params = new URLSearchParams(searchParams);
        params.set("range", newRange);
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
                    <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                        <s-select
                            value={range}
                            onChange={(e) => handleRangeChange(e.target.value)}
                            accessibilityLabel="Select date range"
                        >
                            <s-option value="today">Today</s-option>
                            <s-option value="7d">Last 7 Days</s-option>
                            <s-option value="30d">Last 30 Days</s-option>
                            <s-option value="90d">Last 90 Days</s-option>
                        </s-select>
                    </div>
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