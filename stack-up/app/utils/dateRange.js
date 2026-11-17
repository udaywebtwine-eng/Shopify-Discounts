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
 * Builds chronological daily buckets between startDate and endDate.
 * Ensures custom ranges and historical presets render accurate time series.
 *
 * @param {Date} startDate
 * @param {Date} endDate
 * @returns {Array<{ dateStr: string, label: string, orders: number, sales: number, aov: number }>}
 */
export function generateDailyBuckets(startDate, endDate) {
    const buckets = [];
    const current = new Date(startDate);
    current.setHours(0, 0, 0, 0);

    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    while (current <= end) {
        const dateStr = formatDate(current);
        const label = current.toLocaleDateString("en-US", { month: "short", day: "numeric" });

        buckets.push({
            dateStr,
            label,
            orders: 0,
            sales: 0,
            aov: 0,
        });

        current.setDate(current.getDate() + 1);
    }

    return buckets;
}
