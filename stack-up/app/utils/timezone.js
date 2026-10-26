/**
 * Timezone helpers for Shopify store timezone conversions
 */

/**
 * Fetch the store's IANA timezone from Shopify GraphQL
 * @param {object} admin - Shopify admin GraphQL client
 * @returns {Promise<string>} e.g. "America/New_York", "Asia/Kolkata", "UTC"
 */
export async function getShopTimezone(admin) {
  try {
    const response = await admin.graphql(
      `#graphql
      query GetShopTimezone {
        shop {
          ianaTimezone
        }
      }`
    );
    const json = await response.json();
    return json.data?.shop?.ianaTimezone || "UTC";
  } catch (err) {
    console.warn("Could not query shop ianaTimezone, defaulting to UTC:", err);
    return "UTC";
  }
}

/**
 * Format today's date in the shop's timezone as "YYYY-MM-DD"
 * @param {string} timeZone
 * @returns {string} e.g. "2026-10-23"
 */
export function getShopTodayDate(timeZone = "UTC") {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(new Date());
  } catch {
    return new Date().toISOString().split("T")[0];
  }
}

/**
 * Format an ISO string to "YYYY-MM-DD" in the shop's timezone
 * @param {string} isoString
 * @param {string} timeZone
 * @returns {string} e.g. "2026-10-23"
 */
export function formatDateInShopTimezone(isoString, timeZone = "UTC") {
  if (!isoString) return "";
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return "";
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(date);
  } catch {
    return isoString.split("T")[0] || "";
  }
}

/**
 * Get the UTC offset string (e.g. "+05:30", "-04:00", "+00:00") for a date in a timezone
 * @param {Date} date
 * @param {string} timeZone
 * @returns {string}
 */
function getTimezoneOffsetString(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "UTC",
      timeZoneName: "longOffset",
    }).formatToParts(date);
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    if (!tzPart || tzPart.value === "GMT" || tzPart.value === "UTC") return "+00:00";
    return tzPart.value.replace(/^(GMT|UTC)/, "");
  } catch {
    return "+00:00";
  }
}

/**
 * Convert a date string "YYYY-MM-DD" and time "HH:mm:ss" in shop's timezone to a UTC ISO string
 * @param {string} dateStr - "YYYY-MM-DD"
 * @param {string} timeStr - "00:00:00" or "23:59:59"
 * @param {string} timeZone - IANA timezone
 * @returns {string|null} - e.g. "2026-10-23T04:00:00.000Z"
 */
export function dateToShopISO(dateStr, timeStr = "00:00:00", timeZone = "UTC") {
  if (!dateStr) return null;
  const safeTime = timeStr || "00:00:00";
  const approx = new Date(`${dateStr}T12:00:00Z`);
  const offset = getTimezoneOffsetString(approx, timeZone);
  const isoWithOffset = `${dateStr}T${safeTime}${offset}`;
  const d = new Date(isoWithOffset);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
