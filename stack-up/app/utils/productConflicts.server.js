import prisma from "../db.server.js";
import { computeOfferStatus } from "./timezone.js";

/**
 * Normalizes a product GID or numeric ID to a bare numeric ID string.
 * e.g. "gid://shopify/Product/12345" -> "12345", 12345 -> "12345"
 * @param {string|number} id
 * @returns {string}
 */
export function normalizeProductId(id) {
  if (!id) return "";
  const str = String(id).trim();
  return str.includes("/") ? str.split("/").pop() : str;
}

/**
 * Returns a map of all products that are currently used as Main/Target products
 * in ACTIVE or SCHEDULED offers for the given shop.
 *
 * Excludes any offer specified by `excludeDiscountId` or `excludeNumericId` (for Edit mode).
 *
 * @param {object} params
 * @param {string} params.shop - Shop domain (e.g. store.myshopify.com)
 * @param {string} [params.offerType] - "PAIRED", "SELECTED", or "ALL" (default: "ALL")
 * @param {string} [params.excludeDiscountId] - discountId to exclude (current offer in edit mode)
 * @param {string} [params.excludeNumericId] - numericId to exclude (current offer in edit mode)
 * @returns {Promise<Map<string, { offerId: string, numericId: string, offerTitle: string, offerType: "PAIRED" | "SELECTED" }>>}
 */
export async function getActiveMainProductsMap({
  shop,
  offerType = "ALL",
  excludeDiscountId = null,
  excludeNumericId = null,
}) {
  const shopName = (shop || "").replace(".myshopify.com", "");
  const shopCondition = {
    OR: [
      { shop: shop || "" },
      { shop: shopName },
      { shop: { contains: shopName } },
    ],
  };

  const usedMap = new Map();

  // 1. Check PairedOffers if requested
  if (offerType === "PAIRED" || offerType === "ALL") {
    const pairedOffers = await prisma.offer.findMany({
      where: {
        ...shopCondition,
        type: "PAIRED",
        status: { not: "EXPIRED" },
      },
      select: {
        id: true,
        discountId: true,
        numericId: true,
        title: true,
        status: true,
        startsAt: true,
        endsAt: true,
        mainProducts: true,
      },
    }).catch(() => []);

    for (const offer of pairedOffers) {
      if (excludeDiscountId && offer.discountId === excludeDiscountId) continue;
      if (excludeNumericId && offer.numericId === excludeNumericId) continue;

      const realStatus = computeOfferStatus({
        startsAt: offer.startsAt,
        endsAt: offer.endsAt,
        status: offer.status,
      });

      if (realStatus === "ACTIVE" || realStatus === "SCHEDULED") {
        try {
          const mainProds = JSON.parse(offer.mainProducts || "[]");
          for (const p of mainProds) {
            const rawId = p?.id || p;
            const normId = normalizeProductId(rawId);
            if (normId) {
              usedMap.set(normId, {
                offerId: offer.discountId,
                numericId: offer.numericId,
                offerTitle: offer.title,
                offerType: "PAIRED",
              });
            }
          }
        } catch {
          // ignore json errors
        }
      }
    }
  }

  // 2. Check SelectedProductOffers if requested
  if (offerType === "SELECTED" || offerType === "ALL") {
    const selectedOffers = await prisma.offer.findMany({
      where: {
        ...shopCondition,
        type: "SELECTED",
        status: { not: "EXPIRED" },
      },
      select: {
        id: true,
        discountId: true,
        numericId: true,
        title: true,
        status: true,
        startsAt: true,
        endsAt: true,
        targetProducts: true,
      },
    }).catch(() => []);

    for (const offer of selectedOffers) {
      if (excludeDiscountId && offer.discountId === excludeDiscountId) continue;
      if (excludeNumericId && offer.numericId === excludeNumericId) continue;

      const realStatus = computeOfferStatus({
        startsAt: offer.startsAt,
        endsAt: offer.endsAt,
        status: offer.status,
      });

      if (realStatus === "ACTIVE" || realStatus === "SCHEDULED") {
        try {
          const targets = JSON.parse(offer.targetProducts || "[]");
          for (const p of targets) {
            const rawId = p?.id || p;
            const normId = normalizeProductId(rawId);
            if (normId) {
              usedMap.set(normId, {
                offerId: offer.discountId,
                numericId: offer.numericId,
                offerTitle: offer.title,
                offerType: "SELECTED",
              });
            }
          }
        } catch {
          // ignore json errors
        }
      }
    }
  }

  return usedMap;
}

/**
 * Checks if any of the provided product IDs are already used as Main/Target products
 * in an active or scheduled offer.
 *
 * @param {object} params
 * @param {Array<string|object>} params.products - Products list [{ id, title }] or array of IDs
 * @param {string} params.shop
 * @param {string} [params.offerType="ALL"]
 * @param {string} [params.excludeDiscountId]
 * @param {string} [params.excludeNumericId]
 * @returns {Promise<{ hasConflict: boolean, conflictingProducts: Array<{ id: string, title?: string, offerTitle: string, offerType: string }> }>}
 */
export async function checkMainProductConflicts({
  products = [],
  shop,
  offerType = "ALL",
  excludeDiscountId = null,
  excludeNumericId = null,
}) {
  const usedMap = await getActiveMainProductsMap({
    shop,
    offerType,
    excludeDiscountId,
    excludeNumericId,
  });

  const conflictingProducts = [];

  for (const item of products) {
    const rawId = typeof item === "object" && item !== null ? item.id : item;
    const itemTitle = typeof item === "object" && item !== null ? item.title : "";
    const normId = normalizeProductId(rawId);

    if (normId && usedMap.has(normId)) {
      const match = usedMap.get(normId);
      conflictingProducts.push({
        id: rawId,
        numericId: normId,
        title: itemTitle,
        offerTitle: match.offerTitle,
        offerType: match.offerType,
        offerNumericId: match.numericId,
        editUrl:
          match.offerType === "PAIRED"
            ? `/app/paired-products/edit/${match.numericId}`
            : `/app/sected-products/edit/${match.numericId}`,
      });
    }
  }

  return {
    hasConflict: conflictingProducts.length > 0,
    conflictingProducts,
  };
}

