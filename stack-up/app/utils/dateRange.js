/**
 * Shared Date Range Utilities for Analytics & DatePicker
 * Standardizes calculation of presets, local date boundaries, and chart buckets.
 */

// Format Date object to YYYY-MM-DD
export function formatDate(d) {
    if (!d || isNaN(new Date(d).getTime())) return "";
    const date = new Date(d);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

// Preset definitions with mapping to URL range keys and readable labels
export const PRESET_CONFIGS = [
    { key: "today", label: "Today", days: 1 },
    { key: "yesterday", label: "Yesterday", days: 1 },
    { key: "7d", label: "Last 7 days", days: 7 },
    { key: "30d", label: "Last 30 Days", days: 30 },
    { key: "90d", label: "Last 90 Days", days: 90 },
    { key: "this_month", label: "This Month" },
    { key: "last_month", label: "Last Month" },
    { key: "custom", label: "Custom" },
];

export const PRESET_LABELS = PRESET_CONFIGS.map((c) => c.label);

/**
 * Standard calculation of start and end dates for a preset using the user's local date.
 * Exactly matches how official Shopify apps and browsers display dates.
 *
 * @param {string} presetKey - Label (e.g. "Last 30 Days") or short key (e.g. "30d")
 * @param {Date} [baseDate=new Date()]
 * @returns {{ start: string, end: string, startDate: Date, endDate: Date, daysCount: number }}
 */
export function getPresetDateRange(presetKey, baseDate = new Date()) {
    const key = String(presetKey || "30d").toLowerCase().replace(/\s+/g, "_");
    const now = new Date(baseDate);

    let startDate = new Date(now);
    let endDate = new Date(now);
    let daysCount = 30;

    switch (key) {
        case "today":
            startDate.setHours(0, 0, 0, 0);
            endDate.setHours(23, 59, 59, 999);
            daysCount = 1;
            break;

        case "yesterday":
            startDate.setDate(now.getDate() - 1);
            startDate.setHours(0, 0, 0, 0);
            endDate.setDate(now.getDate() - 1);
            endDate.setHours(23, 59, 59, 999);
            daysCount = 1;
            break;

        case "7d":
        case "last_7_days":
            startDate.setDate(now.getDate() - 6);
            startDate.setHours(0, 0, 0, 0);
            endDate.setHours(23, 59, 59, 999);
            daysCount = 7;
            break;

        case "90d":
        case "last_90_days":
            startDate.setDate(now.getDate() - 89);
            startDate.setHours(0, 0, 0, 0);
            endDate.setHours(23, 59, 59, 999);
            daysCount = 90;
            break;

        case "this_month":
            startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
            endDate.setHours(23, 59, 59, 999);
            daysCount = Math.max(1, now.getDate());
            break;

        case "last_month":
            startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
            endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
            daysCount = endDate.getDate();
            break;

        case "30d":
        case "last_30_days":
        default:
            startDate.setDate(now.getDate() - 29);
            startDate.setHours(0, 0, 0, 0);
            endDate.setHours(23, 59, 59, 999);
            daysCount = 30;
            break;
    }

    return {
        start: formatDate(startDate),
        end: formatDate(endDate),
        startDate,
        endDate,
        daysCount,
    };
}

/**
 * Resolves analytics date bounds from URL query parameters.
 *
 * @param {URLSearchParams} searchParams
 * @returns {{ startDate: Date, endDate: Date, daysCount: number, rangeKey: string, activePresetLabel: string }}
 */
export function resolveAnalyticsRange(searchParams) {
    const rangeParam = searchParams.get("range");
    const startDateParam = searchParams.get("startDate");
    const endDateParam = searchParams.get("endDate");

    // Custom date range passed from frontend
    if (startDateParam && endDateParam) {
        const startDate = new Date(`${startDateParam}T00:00:00`);
        const endDate = new Date(`${endDateParam}T23:59:59.999`);
        const diffMs = Math.max(0, endDate.getTime() - startDate.getTime());
        const daysCount = Math.max(1, Math.round(diffMs / (1000 * 60 * 60 * 24)) + 1);

        return {
            startDate,
            endDate,
            daysCount,
            rangeKey: "custom",
            activePresetLabel: "Custom",
        };
    }

    // Preset lookup
    const resolvedRangeKey = rangeParam || "30d";
    const presetConfig = PRESET_CONFIGS.find(
        (c) => c.key === resolvedRangeKey || c.label.toLowerCase() === resolvedRangeKey.toLowerCase()
    ) || PRESET_CONFIGS.find((c) => c.key === "30d");

    const range = getPresetDateRange(presetConfig.key);

    return {
        startDate: range.startDate,
        endDate: range.endDate,
        daysCount: range.daysCount,
        rangeKey: presetConfig.key,
        activePresetLabel: presetConfig.label,
    };
}

/**
 * Formats hour in 12-hour AM/PM format (e.g. 0 -> "12 AM", 15 -> "3 PM")
 */
function formatHourLabel(h) {
    const ampm = h >= 12 ? "PM" : "AM";
    const hour = h % 12 === 0 ? 12 : h % 12;
    return `${hour} ${ampm}`;
}

/**
 * Generates smart chart buckets based on the span of days:
 * - 1 day (e.g. Today, Yesterday): 24 Hourly buckets (00:00 - 23:00)
 * - 2 to 90 days: Daily buckets
 * - 91 to 180 days: Weekly buckets (7-day intervals)
 * - > 180 days: Monthly buckets (grouped by year-month)
 *
 * @param {Date} startDate
 * @param {Date} endDate
 * @param {number} daysCount
 * @returns {{ intervalType: "hour" | "day" | "week" | "month", intervalTitle: string, buckets: Array<any> }}
 */
export function generateChartBuckets(startDate, endDate, daysCount) {
    const start = new Date(startDate);
    const end = new Date(endDate);

    // 1. Single day range -> Hourly breakdown (24 buckets)
    if (daysCount <= 1) {
        const buckets = [];
        for (let h = 0; h < 24; h++) {
            const hourPadded = String(h).padStart(2, "0");
            buckets.push({
                key: hourPadded,
                label: formatHourLabel(h),
                fullLabel: `${formatHourLabel(h)} (${hourPadded}:00)`,
                orders: 0,
                sales: 0,
                aov: 0,
            });
        }
        return {
            intervalType: "hour",
            intervalTitle: "Hourly breakdown over the selected day",
            buckets,
        };
    }

    // 2. Daily breakdown for up to 90 days
    if (daysCount <= 90) {
        const buckets = [];
        const current = new Date(start);
        current.setHours(0, 0, 0, 0);
        const endDay = new Date(end);
        endDay.setHours(23, 59, 59, 999);

        while (current <= endDay) {
            const dateStr = formatDate(current);
            const label = current.toLocaleDateString("en-US", { month: "short", day: "numeric" });
            buckets.push({
                key: dateStr,
                label,
                fullLabel: label,
                orders: 0,
                sales: 0,
                aov: 0,
            });
            current.setDate(current.getDate() + 1);
        }

        return {
            intervalType: "day",
            intervalTitle: "Daily breakdown over the selected date range",
            buckets,
        };
    }

    // 3. Weekly breakdown for 91 to 180 days
    if (daysCount <= 180) {
        const buckets = [];
        const current = new Date(start);
        current.setHours(0, 0, 0, 0);
        const endDay = new Date(end);
        endDay.setHours(23, 59, 59, 999);

        while (current <= endDay) {
            const weekStartStr = formatDate(current);
            const label = current.toLocaleDateString("en-US", { month: "short", day: "numeric" });

            const nextWeek = new Date(current);
            nextWeek.setDate(nextWeek.getDate() + 6);
            const effectiveEnd = nextWeek > endDay ? endDay : nextWeek;

            buckets.push({
                key: weekStartStr,
                label,
                fullLabel: `Week of ${label} - ${effectiveEnd.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
                startTime: current.getTime(),
                endTime: effectiveEnd.getTime() + (24 * 60 * 60 * 1000 - 1),
                orders: 0,
                sales: 0,
                aov: 0,
            });

            current.setDate(current.getDate() + 7);
        }

        return {
            intervalType: "week",
            intervalTitle: "Weekly breakdown over the selected date range",
            buckets,
        };
    }

    // 4. Monthly breakdown for > 180 days (prevents axis squishing on very long date ranges)
    const buckets = [];
    const current = new Date(start.getFullYear(), start.getMonth(), 1, 0, 0, 0, 0);
    const endMonth = new Date(end.getFullYear(), end.getMonth(), 1, 0, 0, 0, 0);

    while (current <= endMonth) {
        const year = current.getFullYear();
        const month = String(current.getMonth() + 1).padStart(2, "0");
        const monthKey = `${year}-${month}`;
        const label = current.toLocaleDateString("en-US", { month: "short", year: "2-digit" });

        buckets.push({
            key: monthKey,
            label,
            fullLabel: current.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
            orders: 0,
            sales: 0,
            aov: 0,
        });

        current.setMonth(current.getMonth() + 1);
    }

    return {
        intervalType: "month",
        intervalTitle: "Monthly breakdown over the selected date range",
        buckets,
    };
}

/**
 * Backward compatibility alias for generateDailyBuckets
 */
export function generateDailyBuckets(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const diffMs = Math.max(0, end.getTime() - start.getTime());
    const days = Math.max(1, Math.round(diffMs / (1000 * 60 * 60 * 24)) + 1);
    return generateChartBuckets(start, end, days).buckets;
}
