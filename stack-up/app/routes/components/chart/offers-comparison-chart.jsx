/* eslint-disable react/prop-types */
import { useState } from "react";
import {
    ResponsiveContainer,
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
} from "recharts";

export default function OffersComparisonChart({
    offersData = [],
    currencySymbol = "$",
    isMounted = true,
}) {
    // Chart 2 toggle state: 'orders' | 'sales'
    const [chart2Metric, setChart2Metric] = useState("orders");

    // Custom Tooltip for Offer Bar Chart
    const CustomChart2Tooltip = ({ active, payload }) => {
        if (active && payload && payload.length) {
            const item = payload[0].payload;
            const val = payload[0].value ?? 0;
            const formattedVal =
                chart2Metric === "orders"
                    ? `${val} orders`
                    : `${currencySymbol}${Number(val).toFixed(2)}`;
            const metricLabel = chart2Metric === "orders" ? "Total Orders" : "Total Sales";

            return (
                <div
                    style={{
                        background: "rgba(255, 255, 255, 0.98)",
                        backdropFilter: "blur(10px)",
                        border: "1px solid #e1e3e5",
                        borderRadius: "10px",
                        padding: "10px 14px",
                        boxShadow:
                            "0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.05)",
                        minWidth: "160px",
                    }}
                >
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "8px",
                            marginBottom: "4px",
                        }}
                    >
                        <span style={{ fontSize: "11px", fontWeight: "600", color: "#64748b" }}>
                            #{item.numericId || "Offer"}
                        </span>
                        <span
                            style={{
                                fontSize: "10px",
                                fontWeight: "700",
                                padding: "1px 6px",
                                borderRadius: "8px",
                                background: "#eff6ff",
                                color: "#2563eb",
                            }}
                        >
                            {item.percentage}% OFF
                        </span>
                    </div>
                    <div
                        style={{
                            fontSize: "13px",
                            fontWeight: "700",
                            color: "#0f172a",
                            marginBottom: "4px",
                            lineHeight: "1.3",
                        }}
                    >
                        {item.title}
                    </div>
                    <div
                        style={{
                            fontSize: "16px",
                            fontWeight: "800",
                            color: chart2Metric === "orders" ? "#2563eb" : "#059669",
                            letterSpacing: "-0.01em",
                        }}
                    >
                        {formattedVal}
                    </div>
                    <div
                        style={{
                            fontSize: "11px",
                            color: "#94a3b8",
                            marginTop: "2px",
                            fontWeight: "500",
                        }}
                    >
                        {metricLabel}
                    </div>
                </div>
            );
        }
        return null;
    };

    return (
        <s-section>
            <s-stack gap="base">
                <s-stack
                    direction="inline"
                    justifyContent="space-between"
                    alignItems="start"
                    gap="base"
                >
                    <s-box>
                        <s-stack direction="inline" alignItems="center" gap="small">
                            <s-heading>
                                {chart2Metric === "orders" ? "Orders by Offer" : "Sales by Offer"}
                            </s-heading>

                            <s-badge tone={chart2Metric === "orders" ? "info" : "success"}>
                                {offersData.length} {offersData.length === 1 ? "Offer" : "Offers"}
                            </s-badge>
                        </s-stack>
                        <s-box paddingBlockStart="small-400">
                            <s-paragraph color="subdued">
                                Compare conversion and volume across your active bundle discount campaigns
                            </s-paragraph>
                        </s-box>
                    </s-box>

                    <s-button-group gap="none">
                        <s-button
                            slot="secondary-actions"
                            disabled={chart2Metric === "orders"}
                            pressed={chart2Metric === "orders"}
                            onClick={() => setChart2Metric("orders")}
                        >
                            Orders
                        </s-button>
                        <s-button
                            slot="secondary-actions"
                            disabled={chart2Metric === "sales"}
                            pressed={chart2Metric === "sales"}
                            onClick={() => setChart2Metric("sales")}
                        >
                            Sales
                        </s-button>
                    </s-button-group>
                </s-stack>

                {/* Recharts Bar Chart Area */}
                <div style={{ width: "100%", height: "260px", position: "relative" }}>
                    {isMounted ? (
                        offersData.length === 0 ? (
                            <s-box
                                background="subdued"
                                borderRadius="base"
                                padding="large"
                                border="small"
                            >
                                <s-stack alignItems="center" justifyContent="center" gap="small-200">
                                    <s-box
                                        padding="small"
                                        background="base"
                                        borderRadius="base"
                                    >
                                        <s-icon type="chart-vertical" />
                                    </s-box>
                                    <s-text weight="bold">No offer data available</s-text>
                                    <s-paragraph color="subdued">
                                        Create a paired products bundle offer to track its performance here.
                                    </s-paragraph>
                                </s-stack>
                            </s-box>
                        ) : (
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart
                                    data={offersData}
                                    margin={{ top: 12, right: 15, left: -10, bottom: 10 }}
                                >
                                    <defs>
                                        <linearGradient id="barGradOrders" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="0%" stopColor="#3b82f6" />
                                            <stop offset="100%" stopColor="#1d4ed8" />
                                        </linearGradient>
                                        <linearGradient id="barGradSales" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="0%" stopColor="#10b981" />
                                            <stop offset="100%" stopColor="#047857" />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f2f5" />
                                    <XAxis
                                        dataKey="title"
                                        tickLine={false}
                                        axisLine={{ stroke: "#e2e8f0" }}
                                        tick={{ fill: "#64748b", fontSize: 11, fontWeight: 500 }}
                                        tickFormatter={(val) =>
                                            val && val.length > 15 ? `${val.substring(0, 15)}...` : val || ""
                                        }
                                        dy={6}
                                    />
                                    <YAxis
                                        tickLine={false}
                                        axisLine={false}
                                        tick={{ fill: "#64748b", fontSize: 11, fontWeight: 500 }}
                                        tickFormatter={(val) =>
                                            chart2Metric === "orders" ? val : `${currencySymbol}${val}`
                                        }
                                        domain={[0, (dataMax) => (dataMax <= 0 ? 5 : Math.ceil(dataMax * 1.25))]}
                                        tickCount={5}
                                    />
                                    <Tooltip
                                        content={<CustomChart2Tooltip />}
                                        cursor={{ fill: "rgba(241, 245, 249, 0.6)" }}
                                    />
                                    <Bar
                                        key={chart2Metric}
                                        dataKey={chart2Metric === "orders" ? "totalOrders" : "totalSale"}
                                        fill={chart2Metric === "orders" ? "url(#barGradOrders)" : "url(#barGradSales)"}
                                        radius={[6, 6, 0, 0]}
                                        maxBarSize={44}
                                        isAnimationActive={true}
                                        animationDuration={400}
                                        animationEasing="ease-in"
                                    />
                                </BarChart>
                            </ResponsiveContainer>
                        )
                    ) : (
                        <div
                            style={{
                                width: "100%",
                                height: "100%",
                                background: "#f9fafb",
                                borderRadius: "8px",
                            }}
                        />
                    )}
                </div>
            </s-stack>
        </s-section>
    );
}
