import { useState, useMemo } from "react";
import { useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }) => {
    const { admin, session } = await authenticate.admin(request);
    const url = new URL(request.url);
    const range = url.searchParams.get("range") || "30d";

    // 1. Fetch currency from Shopify
    let currencyCode = "INR";
    let currencySymbol = "₹";
    try {
        const shopRes = await admin.graphql(`#graphql
      query GetShopCurrency {
        shop {
          currencyCode
        }
      }
    `);
        const shopJson = await shopRes.json();
        currencyCode = shopJson.data?.shop?.currencyCode || "INR";
        const symbols = {
            INR: "₹",
            USD: "$",
            EUR: "€",
            GBP: "£",
            CAD: "CA$",
            AUD: "AU$",
            AED: "AED ",
            SGD: "S$",
        };
        currencySymbol = symbols[currencyCode] || `${currencyCode} `;
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

    // 8. Build Top Selling Products for Table 2
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

        [...mProds, ...sProds].forEach((p) => {
            if (!p || !p.id) return;
            if (!productMap[p.id]) {
                productMap[p.id] = {
                    id: p.id,
                    name: p.title || "Product",
                    image: p.image || "",
                    price: p.price || "",
                    bundleCount: 0,
                    totalOrders: 0,
                    availableQuantity: 100, // standard available qty indicator
                };
            }
            productMap[p.id].bundleCount += 1;
            productMap[p.id].totalOrders += off.usageCount || 0;
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
    console.log(productsList, "productsList")
    const [searchParams, setSearchParams] = useSearchParams();

    // Chart 1 toggle state: 'orders' | 'sales' | 'aov'
    const [chart1Metric, setChart1Metric] = useState("orders");

    // Chart 2 toggle state: 'orders' | 'sales'
    const [chart2Metric, setChart2Metric] = useState("orders");

    // Table search & sort state
    const [searchQuery, setSearchQuery] = useState("");
    const [sortField, setSortField] = useState("totalOrders");
    const [sortAsc, setSortAsc] = useState(false);

    // Handle Range change
    const handleRangeChange = (newRange) => {
        const params = new URLSearchParams(searchParams);
        params.set("range", newRange);
        setSearchParams(params);
    };

    // Filtered & sorted offers for Table 1
    const filteredOffers = useMemo(() => {
        return offersData
            .filter((o) => o.title.toLowerCase().includes(searchQuery.toLowerCase().trim()))
            .sort((a, b) => {
                const valA = a[sortField];
                const valB = b[sortField];
                if (typeof valA === "string") {
                    return sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
                }
                return sortAsc ? valA - valB : valB - valA;
            });
    }, [offersData, searchQuery, sortField, sortAsc]);

    // Chart 1 Calculations
    const chart1Values = dailyBuckets.map((b) => b[chart1Metric]);
    const maxChart1Value = Math.max(10, Math.ceil(Math.max(...chart1Values, 0) * 1.25));

    // Chart 1 dynamic title
    const chart1Title =
        chart1Metric === "orders"
            ? `Offers Total Orders : ${kpi.totalOrders}`
            : chart1Metric === "sales"
                ? `Offers Total Sales : ${currencySymbol}${kpi.revenueGenerated.toFixed(2)}`
                : `Offers Average Order Value : ${currencySymbol}${kpi.aov.toFixed(2)}`;

    // Chart 2 Max Calculation
    const chart2Values = offersData.map((o) => (chart2Metric === "orders" ? o.totalOrders : o.totalSale));
    const maxChart2Value = Math.max(10, Math.ceil(Math.max(...chart2Values, 0) * 1.25));

    // SVG dimensions for Line Chart
    const svgWidth = 800;
    const svgHeight = 220;
    const paddingLeft = 40;
    const paddingRight = 20;
    const paddingTop = 20;
    const paddingBottom = 30;
    const chartPlotWidth = svgWidth - paddingLeft - paddingRight;
    const chartPlotHeight = svgHeight - paddingTop - paddingBottom;

    // Build SVG Points for Line Chart
    const linePoints = dailyBuckets.map((bucket, i) => {
        const x = paddingLeft + (i / Math.max(dailyBuckets.length - 1, 1)) * chartPlotWidth;
        const val = bucket[chart1Metric];
        const y = paddingTop + chartPlotHeight - (val / maxChart1Value) * chartPlotHeight;
        return { x, y, val, label: bucket.label };
    });

    const linePathD =
        linePoints.length > 0
            ? linePoints.reduce((acc, pt, i) => `${acc} ${i === 0 ? "M" : "L"} ${pt.x} ${pt.y}`, "")
            : "";

    const areaPathD =
        linePoints.length > 0
            ? `${linePathD} L ${linePoints[linePoints.length - 1].x} ${paddingTop + chartPlotHeight} L ${linePoints[0].x} ${paddingTop + chartPlotHeight} Z`
            : "";

    return (
        <s-page heading="Analytics">
            <s-box paddingBlockEnd="base">
                <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                    <s-heading tone="subdued">
                        Track revenue, orders, and bundle performance. Use the date range to compare metrics.
                    </s-heading>

                    {/* Date Range Selector */}
                    <s-stack direction="inline" gap="small-200" alignItems="center">
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
                    </s-stack>
                </s-stack>
            </s-box>

            <s-stack gap="base">
                {/* TOP 4 METRIC CARDS */}
                <div
                    style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(4, 1fr)",
                        gap: "12px",
                    }}
                >
                    {/* 1. Revenue generated */}
                    <div
                        style={{
                            background: "#ffffff",
                            border: "1px solid #e1e3e5",
                            borderRadius: "8px",
                            padding: "16px",
                            boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
                        }}
                    >
                        <div style={{ fontSize: "22px", fontWeight: "700", color: "#202223", marginBottom: "4px" }}>
                            {currencySymbol}
                            {kpi.revenueGenerated.toFixed(2)}
                        </div>
                        <div style={{ fontSize: "13px", color: "#6d7175" }}>Revenue generated</div>
                    </div>

                    {/* 2. Total Orders */}
                    <div
                        style={{
                            background: "#ffffff",
                            border: "1px solid #e1e3e5",
                            borderRadius: "8px",
                            padding: "16px",
                            boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
                        }}
                    >
                        <div style={{ fontSize: "22px", fontWeight: "700", color: "#202223", marginBottom: "4px" }}>
                            {kpi.totalOrders}
                        </div>
                        <div style={{ fontSize: "13px", color: "#6d7175" }}>Total Orders</div>
                    </div>

                    {/* 3. Average order value */}
                    <div
                        style={{
                            background: "#ffffff",
                            border: "1px solid #e1e3e5",
                            borderRadius: "8px",
                            padding: "16px",
                            boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
                        }}
                    >
                        <div style={{ fontSize: "22px", fontWeight: "700", color: "#202223", marginBottom: "4px" }}>
                            {currencySymbol}
                            {kpi.aov.toFixed(2)}
                        </div>
                        <div style={{ fontSize: "13px", color: "#6d7175" }}>Average order value</div>
                    </div>

                    {/* 4. ROI */}
                    <div
                        style={{
                            background: "#ffffff",
                            border: "1px solid #e1e3e5",
                            borderRadius: "8px",
                            padding: "16px",
                            boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
                        }}
                    >
                        <div style={{ fontSize: "22px", fontWeight: "700", color: "#202223", marginBottom: "4px" }}>
                            {kpi.roi}%
                        </div>
                        <div style={{ fontSize: "13px", color: "#6d7175" }}>Bundle ROI</div>
                    </div>
                </div>

                {/* CHART 1: Offers Total Orders / Sales / AOV */}
                <s-section>
                    <s-stack gap="base">
                        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                            <s-text weight="bold" size="medium">
                                {chart1Title}
                            </s-text>

                            {/* Segmented Buttons for Metric Toggle */}
                            <div
                                style={{
                                    display: "inline-flex",
                                    border: "1px solid #dcdfe3",
                                    borderRadius: "6px",
                                    overflow: "hidden",
                                    background: "#f4f5f7",
                                }}
                            >
                                <button
                                    type="button"
                                    onClick={() => setChart1Metric("orders")}
                                    style={{
                                        padding: "6px 14px",
                                        border: "none",
                                        background: chart1Metric === "orders" ? "#ffffff" : "transparent",
                                        color: chart1Metric === "orders" ? "#202223" : "#6d7175",
                                        fontWeight: chart1Metric === "orders" ? "600" : "400",
                                        fontSize: "13px",
                                        cursor: "pointer",
                                        boxShadow: chart1Metric === "orders" ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                                    }}
                                >
                                    Orders
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setChart1Metric("sales")}
                                    style={{
                                        padding: "6px 14px",
                                        border: "none",
                                        borderLeft: "1px solid #dcdfe3",
                                        borderRight: "1px solid #dcdfe3",
                                        background: chart1Metric === "sales" ? "#ffffff" : "transparent",
                                        color: chart1Metric === "sales" ? "#202223" : "#6d7175",
                                        fontWeight: chart1Metric === "sales" ? "600" : "400",
                                        fontSize: "13px",
                                        cursor: "pointer",
                                        boxShadow: chart1Metric === "sales" ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                                    }}
                                >
                                    Sales
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setChart1Metric("aov")}
                                    style={{
                                        padding: "6px 14px",
                                        border: "none",
                                        background: chart1Metric === "aov" ? "#ffffff" : "transparent",
                                        color: chart1Metric === "aov" ? "#202223" : "#6d7175",
                                        fontWeight: chart1Metric === "aov" ? "600" : "400",
                                        fontSize: "13px",
                                        cursor: "pointer",
                                        boxShadow: chart1Metric === "aov" ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                                    }}
                                >
                                    AOV
                                </button>
                            </div>
                        </s-stack>

                        {/* SVG Line Chart */}
                        <div style={{ width: "100%", height: "240px", position: "relative" }}>
                            <svg
                                viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                                style={{ width: "100%", height: "100%", overflow: "visible" }}
                            >
                                <defs>
                                    <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="0%" stopColor="#2c6ecb" stopOpacity="0.25" />
                                        <stop offset="100%" stopColor="#2c6ecb" stopOpacity="0.0" />
                                    </linearGradient>
                                </defs>

                                {/* Y-Axis Horizontal Grid Lines */}
                                {[0, 0.25, 0.5, 0.75, 1].map((pct, idx) => {
                                    const y = paddingTop + chartPlotHeight * (1 - pct);
                                    const labelVal = Math.round(maxChart1Value * pct);
                                    return (
                                        <g key={idx}>
                                            <line
                                                x1={paddingLeft}
                                                y1={y}
                                                x2={svgWidth - paddingRight}
                                                y2={y}
                                                stroke="#eef0f2"
                                                strokeWidth="1"
                                            />
                                            <text
                                                x={paddingLeft - 8}
                                                y={y + 4}
                                                textAnchor="end"
                                                fontSize="11"
                                                fill="#8c9196"
                                            >
                                                {chart1Metric !== "orders" && labelVal > 0 ? `${currencySymbol}${labelVal}` : labelVal}
                                            </text>
                                        </g>
                                    );
                                })}

                                {/* Area Gradient Fill under Line */}
                                {kpi.totalOrders > 0 && <path d={areaPathD} fill="url(#areaGrad)" />}

                                {/* Line Path */}
                                {kpi.totalOrders > 0 ? (
                                    <path d={linePathD} fill="none" stroke="#2c6ecb" strokeWidth="2.5" strokeLinecap="round" />
                                ) : (
                                    // Flat baseline when 0
                                    <line
                                        x1={paddingLeft}
                                        y1={paddingTop + chartPlotHeight}
                                        x2={svgWidth - paddingRight}
                                        y2={paddingTop + chartPlotHeight}
                                        stroke="#2c6ecb"
                                        strokeWidth="1.5"
                                        strokeDasharray="4 4"
                                        opacity="0.4"
                                    />
                                )}

                                {/* Data Points */}
                                {kpi.totalOrders > 0 &&
                                    linePoints.map((pt, i) =>
                                        pt.val > 0 ? (
                                            <circle
                                                key={i}
                                                cx={pt.x}
                                                cy={pt.y}
                                                r="4"
                                                fill="#2c6ecb"
                                                stroke="#ffffff"
                                                strokeWidth="2"
                                            />
                                        ) : null
                                    )}

                                {/* X-Axis Dates Sampled */}
                                {linePoints
                                    .filter((_, i) => i % Math.ceil(linePoints.length / 7) === 0 || i === linePoints.length - 1)
                                    .map((pt, i) => (
                                        <text
                                            key={i}
                                            x={pt.x}
                                            y={svgHeight - 6}
                                            textAnchor="middle"
                                            fontSize="11"
                                            fill="#8c9196"
                                        >
                                            {pt.label}
                                        </text>
                                    ))}
                            </svg>
                        </div>
                    </s-stack>
                </s-section>

                {/* CHART 2: Orders by Offer */}
                <s-section>
                    <s-stack gap="base">
                        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                            <s-text weight="bold" size="medium">
                                {chart2Metric === "orders" ? "Orders by Offer" : "Sales by Offer"}
                            </s-text>

                            {/* Segmented Buttons for Chart 2 Toggle */}
                            <div
                                style={{
                                    display: "inline-flex",
                                    border: "1px solid #dcdfe3",
                                    borderRadius: "6px",
                                    overflow: "hidden",
                                    background: "#f4f5f7",
                                }}
                            >
                                <button
                                    type="button"
                                    onClick={() => setChart2Metric("orders")}
                                    style={{
                                        padding: "6px 14px",
                                        border: "none",
                                        background: chart2Metric === "orders" ? "#ffffff" : "transparent",
                                        color: chart2Metric === "orders" ? "#202223" : "#6d7175",
                                        fontWeight: chart2Metric === "orders" ? "600" : "400",
                                        fontSize: "13px",
                                        cursor: "pointer",
                                        boxShadow: chart2Metric === "orders" ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                                    }}
                                >
                                    Orders
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setChart2Metric("sales")}
                                    style={{
                                        padding: "6px 14px",
                                        border: "none",
                                        borderLeft: "1px solid #dcdfe3",
                                        background: chart2Metric === "sales" ? "#ffffff" : "transparent",
                                        color: chart2Metric === "sales" ? "#202223" : "#6d7175",
                                        fontWeight: chart2Metric === "sales" ? "600" : "400",
                                        fontSize: "13px",
                                        cursor: "pointer",
                                        boxShadow: chart2Metric === "sales" ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                                    }}
                                >
                                    Sales
                                </button>
                            </div>
                        </s-stack>

                        {/* Bar Chart Area */}
                        <div style={{ width: "100%", height: "220px", position: "relative" }}>
                            <svg
                                viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                                style={{ width: "100%", height: "100%", overflow: "visible" }}
                            >
                                {/* Horizontal Grid lines */}
                                {[0, 0.25, 0.5, 0.75, 1].map((pct, idx) => {
                                    const y = paddingTop + chartPlotHeight * (1 - pct);
                                    const labelVal = Math.round(maxChart2Value * pct);
                                    return (
                                        <g key={idx}>
                                            <line
                                                x1={paddingLeft}
                                                y1={y}
                                                x2={svgWidth - paddingRight}
                                                y2={y}
                                                stroke="#eef0f2"
                                                strokeWidth="1"
                                            />
                                            <text
                                                x={paddingLeft - 8}
                                                y={y + 4}
                                                textAnchor="end"
                                                fontSize="11"
                                                fill="#8c9196"
                                            >
                                                {chart2Metric === "sales" && labelVal > 0 ? `${currencySymbol}${labelVal}` : labelVal}
                                            </text>
                                        </g>
                                    );
                                })}

                                {/* Bars for each offer */}
                                {offersData.length > 0 &&
                                    offersData.map((off, idx) => {
                                        const barWidth = Math.min(60, chartPlotWidth / (offersData.length * 2));
                                        const slotWidth = chartPlotWidth / offersData.length;
                                        const x = paddingLeft + idx * slotWidth + (slotWidth - barWidth) / 2;
                                        const val = chart2Metric === "orders" ? off.totalOrders : off.totalSale;
                                        const barHeight = (val / maxChart2Value) * chartPlotHeight;
                                        const y = paddingTop + chartPlotHeight - barHeight;

                                        return (
                                            <g key={off.id}>
                                                {val > 0 ? (
                                                    <rect
                                                        x={x}
                                                        y={y}
                                                        width={barWidth}
                                                        height={Math.max(barHeight, 4)}
                                                        rx="4"
                                                        fill="#008060"
                                                    />
                                                ) : null}
                                                <text
                                                    x={x + barWidth / 2}
                                                    y={svgHeight - 8}
                                                    textAnchor="middle"
                                                    fontSize="11"
                                                    fill="#6d7175"
                                                >
                                                    {off.title.length > 15 ? `${off.title.substring(0, 15)}...` : off.title}
                                                </text>
                                            </g>
                                        );
                                    })}
                            </svg>
                        </div>
                    </s-stack>
                </s-section>

                {/* TABLE 1: Top Selling Offers */}
                <s-section heading="Top Selling Offers" padding="none">
                    <s-table>
                        {/* Search Input Bar in slot="filters" */}
                        <s-grid
                            slot="filters"
                            gridTemplateColumns="1fr auto"
                            gap="small-200"
                            alignItems="center"
                            padding="small-400"
                        >
                            <s-search-field
                                placeholder="Filter Offers"
                                value={searchQuery}
                                onInput={(e) => setSearchQuery(e.target.value)}
                            />
                            <s-button
                                icon="sort"
                                onClick={() => {
                                    setSortAsc(!sortAsc);
                                }}
                            >
                                Sort {sortAsc ? "▲" : "▼"}
                            </s-button>
                        </s-grid>

                        {/* Offers Table */}
                        <s-table-header-row>
                            <s-table-header>No</s-table-header>
                            <s-table-header>Offer Id</s-table-header>
                            <s-table-header>Offer Title</s-table-header>
                            <s-table-header>Offer Type</s-table-header>
                            <s-table-header>Total Orders</s-table-header>
                            <s-table-header>Total Sale</s-table-header>
                            <s-table-header>Cart Click</s-table-header>
                            <s-table-header>Bundle Views</s-table-header>
                        </s-table-header-row>

                        <s-table-body>
                            {filteredOffers.length === 0 ? (
                                <s-box padding="large" textAlign="center">
                                    <s-text tone="subdued" size="large" weight="bold">
                                        No data found
                                    </s-text>
                                </s-box>
                            ) : (
                                filteredOffers.map((offer, index) => (
                                    <s-table-row key={offer.id}>
                                        <s-table-cell>{index + 1}</s-table-cell>
                                        <s-table-cell>
                                            <s-text tone="subdued">#{offer.numericId}</s-text>
                                        </s-table-cell>
                                        <s-table-cell>
                                            <s-link href={`/app/paired-products/edit/${offer.numericId}`}>
                                                <s-text weight="bold">{offer.title}</s-text>
                                            </s-link>
                                        </s-table-cell>
                                        <s-table-cell>
                                            <s-badge tone="info">{offer.discountType}</s-badge>
                                        </s-table-cell>
                                        <s-table-cell>
                                            <s-text weight={offer.totalOrders > 0 ? "bold" : "regular"}>
                                                {offer.totalOrders}
                                            </s-text>
                                        </s-table-cell>
                                        <s-table-cell>
                                            <s-text weight={offer.totalSale > 0 ? "bold" : "regular"}>
                                                {currencySymbol}
                                                {offer.totalSale.toFixed(2)}
                                            </s-text>
                                        </s-table-cell>
                                        <s-table-cell>{offer.cartClicks}</s-table-cell>
                                        <s-table-cell>{offer.bundleViews}</s-table-cell>
                                    </s-table-row>
                                ))
                            )}
                        </s-table-body>
                    </s-table>
                </s-section>

                {/* TABLE 2: Top Selling Products */}
                <s-section heading="Top Selling Products" padding="none">
                    <s-table>
                        <s-table-header-row>
                            <s-table-header>Product Name</s-table-header>
                            <s-table-header>Total Orders</s-table-header>
                            <s-table-header>Bundle Count</s-table-header>
                            <s-table-header>Available Quantity</s-table-header>
                        </s-table-header-row>

                        <s-table-body>
                            {productsList.length === 0 ? (
                                <s-box padding="large" textAlign="center">
                                    <s-text tone="subdued" size="large" weight="bold">
                                        No data found
                                    </s-text>
                                </s-box>
                            ) : (
                                productsList.map((prod) => (
                                    <s-table-row key={prod.id}>
                                        <s-table-cell>
                                            <s-stack direction="inline" gap="small-200" alignItems="center">
                                                {prod.image ? (
                                                    <img
                                                        src={prod.image}
                                                        alt={prod.name}
                                                        style={{
                                                            width: "32px",
                                                            height: "32px",
                                                            borderRadius: "4px",
                                                            objectFit: "cover",
                                                        }}
                                                    />
                                                ) : (
                                                    <div
                                                        style={{
                                                            width: "32px",
                                                            height: "32px",
                                                            borderRadius: "4px",
                                                            background: "#f1f2f3",
                                                        }}
                                                    />
                                                )}
                                                <s-text weight="bold">{prod.name}</s-text>
                                            </s-stack>
                                        </s-table-cell>
                                        <s-table-cell>
                                            <s-text weight={prod.totalOrders > 0 ? "bold" : "regular"}>
                                                {prod.totalOrders}
                                            </s-text>
                                        </s-table-cell>
                                        <s-table-cell>{prod.bundleCount}</s-table-cell>
                                        <s-table-cell>
                                            <s-badge tone="success">{prod.availableQuantity} in stock</s-badge>
                                        </s-table-cell>
                                    </s-table-row>
                                ))
                            )}
                        </s-table-body>
                    </s-table>
                </s-section>
            </s-stack>
        </s-page>
    );
}