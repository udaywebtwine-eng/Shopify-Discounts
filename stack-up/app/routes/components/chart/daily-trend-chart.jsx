/* eslint-disable react/prop-types */
import { useState } from "react";
import {
    ResponsiveContainer,
    AreaChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
} from "recharts";

export default function DailyTrendChart({
    dailyBuckets = [],
    kpi = { totalOrders: 0, revenueGenerated: 0, aov: 0 },
    currencySymbol = "$",
    isMounted = true,
}) {
    // Chart 1 toggle state: 'orders' | 'sales' | 'aov'
    const [chart1Metric, setChart1Metric] = useState("orders");

    // Chart 1 active color & gradient
    const chart1Color =
        chart1Metric === "orders"
            ? "#2563eb"
            : chart1Metric === "sales"
                ? "#059669"
                : "#7c3aed";
    const chart1GradId =
        chart1Metric === "orders"
            ? "areaGradOrders"
            : chart1Metric === "sales"
                ? "areaGradSales"
                : "areaGradAov";

    // Custom Tooltip for Trend Area Chart
    const CustomChart1Tooltip = ({ active, payload, label }) => {
        if (active && payload && payload.length) {
            const val = payload[0].value ?? 0;
            const formattedVal =
                chart1Metric === "orders"
                    ? `${val} orders`
                    : `${currencySymbol}${Number(val).toFixed(2)}`;
            const metricLabel =
                chart1Metric === "orders"
                    ? "Total Orders"
                    : chart1Metric === "sales"
                        ? "Total Sales"
                        : "Average Order Value (AOV)";

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
                        minWidth: "150px",
                    }}
                >
                    <div
                        style={{
                            fontSize: "11px",
                            fontWeight: "600",
                            color: "#64748b",
                            marginBottom: "4px",
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                        }}
                    >
                        <span
                            style={{
                                display: "inline-block",
                                width: "7px",
                                height: "7px",
                                borderRadius: "50%",
                                background: chart1Color,
                            }}
                        />
                        {label}
                    </div>
                    <div
                        style={{
                            fontSize: "16px",
                            fontWeight: "800",
                            color: "#0f172a",
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
                                {chart1Metric === "orders"
                                    ? "Offers Total Orders"
                                    : chart1Metric === "sales"
                                        ? "Offers Total Sales"
                                        : "Offers Average Order Value"}
                            </s-heading>

                            <s-badge
                                tone={
                                    chart1Metric === "orders"
                                        ? "info"
                                        : chart1Metric === "sales"
                                            ? "success"
                                            : "caution"
                                }
                            >
                                {chart1Metric === "orders"
                                    ? kpi.totalOrders
                                    : `${currencySymbol}${chart1Metric === "sales"
                                        ? kpi.revenueGenerated.toFixed(2)
                                        : kpi.aov.toFixed(2)
                                    }`}
                            </s-badge>
                        </s-stack>
                        <s-box paddingBlockStart="small-400">
                            <s-paragraph color="subdued">
                                Daily breakdown over the selected date range
                            </s-paragraph>
                        </s-box>
                    </s-box>

                    <s-button-group gap="none">
                        <s-button
                            slot="secondary-actions"
                            disabled={chart1Metric === "orders"}
                            pressed={chart1Metric === "orders"}
                            onClick={() => setChart1Metric("orders")}
                        >
                            Orders
                        </s-button>
                        <s-button
                            slot="secondary-actions"
                            disabled={chart1Metric === "sales"}
                            pressed={chart1Metric === "sales"}
                            onClick={() => setChart1Metric("sales")}
                        >
                            Sales
                        </s-button>
                        <s-button
                            slot="secondary-actions"
                            disabled={chart1Metric === "aov"}
                            pressed={chart1Metric === "aov"}
                            onClick={() => setChart1Metric("aov")}
                        >
                            AOV
                        </s-button>
                    </s-button-group>
                </s-stack>

                {/* Recharts Area Chart */}
                <div style={{ width: "100%", height: "270px", position: "relative" }}>
                    {isMounted ? (
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart
                                data={dailyBuckets}
                                margin={{ top: 12, right: 15, left: -10, bottom: 0 }}
                            >
                                <defs>
                                    <linearGradient id="areaGradOrders" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="0%" stopColor="#2563eb" stopOpacity={0.32} />
                                        <stop offset="60%" stopColor="#3b82f6" stopOpacity={0.08} />
                                        <stop offset="100%" stopColor="#ffffff" stopOpacity={0.0} />
                                    </linearGradient>
                                    <linearGradient id="areaGradSales" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="0%" stopColor="#059669" stopOpacity={0.32} />
                                        <stop offset="60%" stopColor="#10b981" stopOpacity={0.08} />
                                        <stop offset="100%" stopColor="#ffffff" stopOpacity={0.0} />
                                    </linearGradient>
                                    <linearGradient id="areaGradAov" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="0%" stopColor="#7c3aed" stopOpacity={0.32} />
                                        <stop offset="60%" stopColor="#8b5cf6" stopOpacity={0.08} />
                                        <stop offset="100%" stopColor="#ffffff" stopOpacity={0.0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f2f5" />
                                <XAxis
                                    dataKey="label"
                                    tickLine={false}
                                    axisLine={{ stroke: "#e2e8f0" }}
                                    tick={{ fill: "#64748b", fontSize: 11, fontWeight: 500 }}
                                    dy={6}
                                />
                                <YAxis
                                    tickLine={false}
                                    axisLine={false}
                                    tick={{ fill: "#64748b", fontSize: 11, fontWeight: 500 }}
                                    tickFormatter={(val) =>
                                        chart1Metric === "orders" ? val : `${currencySymbol}${val}`
                                    }
                                    domain={[0, (dataMax) => (dataMax <= 0 ? 5 : Math.ceil(dataMax * 1.25))]}
                                    tickCount={5}
                                />
                                <Tooltip content={<CustomChart1Tooltip />} />
                                <Area
                                    key={chart1Metric}
                                    type="monotone"
                                    dataKey={chart1Metric}
                                    stroke={chart1Color}
                                    strokeWidth={2.5}
                                    fillOpacity={1}
                                    fill={`url(#${chart1GradId})`}
                                    isAnimationActive={true}
                                    animationDuration={500}
                                    animationEasing="ease-in"
                                    dot={
                                        kpi.totalOrders > 0
                                            ? { r: 3, fill: chart1Color, stroke: "#ffffff", strokeWidth: 2 }
                                            : false
                                    }
                                    activeDot={{
                                        r: 6,
                                        fill: chart1Color,
                                        stroke: "#ffffff",
                                        strokeWidth: 2.5,
                                        style: { filter: "drop-shadow(0 2px 5px rgba(0,0,0,0.2))" },
                                    }}
                                />
                            </AreaChart>
                        </ResponsiveContainer>
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
