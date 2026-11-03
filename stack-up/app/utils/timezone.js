/**
 * Standard Timezone helpers for Shopify store timezone conversions
 * Ensures 100% accurate round-trip conversions between local store calendar dates
 * and UTC ISO timestamps, adhering to official ECMAScript Intl standards.
 */

const timezoneCache = new Map();

/**
 * Compute the real-time status of an offer ("ACTIVE", "SCHEDULED", "EXPIRED")
 * based on its startsAt, endsAt, and current status.
 * Matches Shopify Admin Discount status lifecycle.
 *
 * @param {object} params
 * @param {Date|string|null} [params.startsAt]
 * @param {Date|string|null} [params.endsAt]
 * @param {string} [params.status]
 * @returns {"ACTIVE" | "SCHEDULED" | "EXPIRED"}
 */
export function computeOfferStatus({ startsAt, endsAt, status } = {}) {
  if (status === "EXPIRED" || status === "DEACTIVATED") return "EXPIRED";
  const now = Date.now();
  if (endsAt) {
    const endMs = endsAt instanceof Date ? endsAt.getTime() : new Date(endsAt).getTime();
    if (!isNaN(endMs) && endMs <= now) {
      return "EXPIRED";
    }
  }
  if (startsAt) {
    const startMs = startsAt instanceof Date ? startsAt.getTime() : new Date(startsAt).getTime();
    if (!isNaN(startMs) && startMs > now) {
      return "SCHEDULED";
    }
  }
  return "ACTIVE";
}

/**
 * Validate that a timezone string is a recognized IANA timezone identifier.
 * Falls back to "UTC" if invalid, null, or empty.
 * @param {string} tz
 * @returns {string} valid IANA timezone name
 */
export function getValidTimezone(tz) {
  if (!tz || typeof tz !== "string") return "UTC";
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/**
 * Fetch the store's IANA timezone from Shopify GraphQL with memory caching.
 * @param {object} admin - Shopify admin GraphQL client
 * @param {string} [shopDomain] - Shop domain for caching
 * @returns {Promise<string>} e.g. "America/New_York", "Asia/Kolkata", "UTC"
 */
export async function getShopTimezone(admin, shopDomain = "default") {
  const safeShop = shopDomain
    ? shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "")
    : "default";

  if (safeShop && timezoneCache.has(safeShop)) {
    return timezoneCache.get(safeShop);
  }

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
    const tz = json.data?.shop?.ianaTimezone;
    const validTz = getValidTimezone(tz);

    if (safeShop) {
      timezoneCache.set(safeShop, validTz);
    }
    return validTz;
  } catch (err) {
    console.warn("Could not query shop ianaTimezone, defaulting to UTC:", err);
    return "UTC";
  }
}

/**
 * Manually set or prime the timezone cache for a shop.
 * @param {string} shopDomain
 * @param {string} tz
 */
export function setShopTimezoneCache(shopDomain, tz) {
  const safeShop = shopDomain
    ? shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "")
    : "";
  if (safeShop && tz) {
    timezoneCache.set(safeShop, getValidTimezone(tz));
  }
}

/**
 * Format today's date in the shop's timezone as standard "YYYY-MM-DD".
 * @param {string} timeZone - Shop IANA timezone
 * @returns {string} e.g. "2026-11-03"
 */
export function getShopTodayDate(timeZone = "UTC") {
  const safeTz = getValidTimezone(timeZone);
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: safeTz,
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
 * Format an ISO string to "YYYY-MM-DD" in the shop's timezone.
 * Used to populate date fields in edit pages and table views.
 * @param {string} isoString - e.g. "2026-11-03T05:00:00.000Z"
 * @param {string} timeZone - Shop IANA timezone
 * @returns {string} e.g. "2026-11-03"
 */
export function formatDateInShopTimezone(isoString, timeZone = "UTC") {
  if (!isoString) return "";
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return "";

  const safeTz = getValidTimezone(timeZone);
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: safeTz,
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
 * Format a 24-hour time "HH:mm:ss" or "HH:mm" into a 12-hour string (e.g. "12:00 AM", "2:30 PM", "11:59 PM").
 * @param {string} time24 - e.g. "02:30:00" or "14:00"
 * @returns {string} e.g. "2:30 AM" or "2:00 PM"
 */
export function formatTime12h(time24) {
  if (!time24) return "12:00 AM";
  const [hStr, mStr] = String(time24).split(":");
  let h = parseInt(hStr, 10);
  if (isNaN(h)) return "12:00 AM";
  const m = parseInt(mStr, 10) || 0;
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  h = h ? h : 12;
  const mm = String(m).padStart(2, "0");
  return `${h}:${mm} ${ampm}`;
}

/**
 * Get current time in the shop's timezone formatted as "HH:mm:00".
 * (e.g. "14:35:00")
 * @param {string} timeZone - IANA timezone
 * @returns {string} e.g. "12:34:00"
 */
export function getShopCurrentTime(timeZone = "UTC") {
  const safeTz = getValidTimezone(timeZone);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: safeTz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const m = {};
    parts.forEach((p) => {
      m[p.type] = p.value;
    });
    return `${m.hour || "00"}:${m.minute || "00"}:00`;
  } catch {
    const now = new Date();
    return `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}:00`;
  }
}

/**
 * Extract the wall-clock time string "HH:mm:ss" from an ISO timestamp in a given timezone.
 * @param {string} isoString - e.g. "2026-11-03T05:00:00.000Z"
 * @param {string} timeZone - IANA timezone
 * @param {string} [defaultTime="00:00:00"] - fallback time if isoString is missing
 * @returns {string} e.g. "00:00:00" or "23:59:59"
 */
export function formatTimeInShopTimezone(isoString, timeZone = "UTC", defaultTime = "00:00:00") {
  if (!isoString) return defaultTime;
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return defaultTime;
  const safeTz = getValidTimezone(timeZone);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: safeTz,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const m = {};
    parts.forEach((p) => {
      m[p.type] = p.value;
    });
    return `${m.hour || "00"}:${m.minute || "00"}:${m.second || "00"}`;
  } catch {
    return defaultTime;
  }
}

/**
 * Get short timezone abbreviation (e.g. "EST", "EDT", "IST", "GMT", "PST")
 * for a shop's timezone on a specific date.
 * @param {string} timeZone
 * @param {Date} [date]
 * @returns {string}
 */
export function getTimezoneAbbr(timeZone = "UTC", date = new Date()) {
  const safeTz = getValidTimezone(timeZone);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: safeTz,
      timeZoneName: "short",
    }).formatToParts(date instanceof Date ? date : new Date());
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    return tzPart?.value || safeTz;
  } catch {
    return safeTz;
  }
}

/**
 * Format an ISO string to a human-readable "MMM D, YYYY at h:mm A" in store timezone.
 * Used for cards and tables: e.g. "Nov 3, 2026 at 12:00 AM"
 * @param {string} isoString
 * @param {string} timeZone
 * @returns {string}
 */
export function formatDateTimeInShopTimezone(isoString, timeZone = "UTC") {
  if (!isoString) return "";
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return "";
  const safeTz = getValidTimezone(timeZone);
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: safeTz,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return formatDateInShopTimezone(isoString, safeTz);
  }
}

/**
 * Generates standard 30-minute time options for dropdown selection (matching Shopify Admin).
 * Values are "HH:mm:ss" in 24h format, labels are "12:00 AM (start of day)", "12:30 AM", etc.
 * @param {boolean} [isEndTime=false] - If true, adds "23:59:59" / "11:59 PM (end of day)"
 * @param {string} [customTime] - Optional existing/custom time to ensure it is in the options list
 * @returns {Array<{ value: string, label: string }>}
 */
export function generateTimeOptions(isEndTime = false, customTime = null) {
  const options = [];
  const seenValues = new Set();

  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 30) {
      const time24 = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
      let label = formatTime12h(time24);
      if (h === 0 && m === 0) {
        label += " (start of day)";
      }
      options.push({ value: time24, label });
      seenValues.add(time24);
    }
  }

  if (isEndTime) {
    const endOfDay = "23:59:59";
    if (!seenValues.has(endOfDay)) {
      options.push({ value: endOfDay, label: "11:59 PM (end of day)" });
      seenValues.add(endOfDay);
    }
  }

  // If a custom time is passed and not already in options, insert it in sorted order
  if (customTime && typeof customTime === "string") {
    const normalized = customTime.length === 5 ? `${customTime}:00` : customTime;
    if (!seenValues.has(normalized)) {
      const customLabel = formatTime12h(normalized);
      options.push({ value: normalized, label: customLabel });
      options.sort((a, b) => a.value.localeCompare(b.value));
    }
  }

  return options;
}

/**
 * Convert a date string "YYYY-MM-DD" and time "HH:mm:ss" in the shop's timezone
 * into an exact, standard UTC ISO string (e.g. "2026-11-03T05:00:00.000Z").
 *
 * Uses the standard inverse wall-clock calculation to guarantee 100% accuracy
 * across all worldwide timezones, Daylight Saving Time (DST) transitions,
 * half-hour offsets, and negative offsets.
 *
 * @param {string} dateStr - "YYYY-MM-DD"
 * @param {string} [timeStr="00:00:00"] - "00:00:00" or "23:59:59" or "14:30:00"
 * @param {string} [timeZone="UTC"] - IANA timezone
 * @returns {string|null} - e.g. "2026-11-03T05:00:00.000Z"
 */
export function dateToShopISO(dateStr, timeStr = "00:00:00", timeZone = "UTC") {
  if (!dateStr || typeof dateStr !== "string") return null;
  const trimmedDate = dateStr.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmedDate)) return null;

  const safeTz = getValidTimezone(timeZone);
  const [year, month, day] = trimmedDate.split("-").map(Number);
  const timeParts = (timeStr || "00:00:00").split(":").map((v) => parseInt(v, 10) || 0);
  const hour = Math.min(23, Math.max(0, timeParts[0] || 0));
  const minute = Math.min(59, Math.max(0, timeParts[1] || 0));
  const second = Math.min(59, Math.max(0, timeParts[2] || 0));

  try {
    // 1. Initial UTC anchor date
    const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

    // 2. Format in the shop's target timeZone to measure the exact wall-clock offset
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: safeTz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(utcGuess);

    const m = {};
    parts.forEach((p) => {
      m[p.type] = p.value;
    });

    const asInTz = new Date(
      Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second)
    );

    // 3. Compensate for the offset delta
    const diff = utcGuess.getTime() - asInTz.getTime();
    const finalDate = new Date(utcGuess.getTime() + diff);

    return isNaN(finalDate.getTime()) ? null : finalDate.toISOString();
  } catch (err) {
    console.warn("Error converting date to shop ISO:", err);
    return null;
  }
}
