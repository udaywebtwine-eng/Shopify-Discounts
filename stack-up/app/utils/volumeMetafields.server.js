import prisma from "../db.server.js";
import { computeOfferStatus } from "./timezone.js";

/**
 * ============================================================================
 * STACKUP VOLUME OFFERS - PRODUCT-LEVEL METAFELD ENGINE (SHARDED ARCHITECTURE)
 * ============================================================================
 * 
 * Instead of storing every store offer into a single 3,300-byte shop-level metafield
 * (which crashes into Shopify Functions' 10,000-byte limit after 3-4 offers),
 * each Volume Discount is saved directly on the participating Product's metafield:
 *   `product.metafields.stack_up.volume_tiers`
 * 
 * BENEFIT:
 * - Each product only stores its own compact ~120-byte rule.
 * - At checkout, Shopify Functions ONLY query the metafields of items in the cart!
 * - A store can have 10,000+ active volume discounts without ever exceeding the 10 KB limit.
 * - Liquid on product pages directly reads `product.metafields.stack_up.volume_tiers` in 0ms!
 */

/**
 * Normalizes any tier object to our compact schema.
 * @param {object} tier
 * @param {number} idx
 * @returns {object}
 */
export function normalizeTierToCompact(tier, idx = 0, hasExplicitDefault = false) {
  const minQty = Number(tier.mq ?? tier.quantity ?? (idx + 1));
  const discountType = String(tier.discountType ?? tier.t ?? "percent").toLowerCase();

  let t = "P";
  if (discountType === "none" || discountType === "no discount" || discountType === "n") {
    t = "N"; // No discount
  } else if (discountType === "fixed" || discountType === "f" || discountType === "fixed amount discount") {
    t = "F";
  } else {
    t = "P"; // Percentage discount
  }

  const discount = t === "N" ? 0 : Number(tier.d ?? tier.value ?? tier.discount ?? 0);
  const badge = String(tier.b ?? tier.badge ?? "").trim();
  const label = String(tier.s ?? tier.label ?? tier.subtitle ?? "").trim();
  const title = String(tier.title ?? (minQty === 1 ? "Buy 1" : (minQty === 3 ? "Buy 3+" : `Buy ${minQty}`))).trim();
  const hasDf = tier.df === true || tier.df === "true" || tier.isDefault === true || tier.isDefault === "true";
  const isDefault = hasDf || (!hasExplicitDefault && idx === 0);

  const tierObj = {
    mq: minQty,
    d: discount,
    t: t,
    title: title,
    s: label,
  };
  if (badge) tierObj.b = badge;
  if (isDefault) tierObj.df = true;

  return tierObj;
}

/**
 * Safely extracts products list from a volume offer record.
 * Supports both modern `volumeProducts` column and legacy `configuration.volumeProducts`.
 * @param {object} offer
 * @returns {Array}
 */
export function getVolumeProductsFromOffer(offer) {
  if (!offer) return [];
  try {
    if (offer.volumeProducts) {
      return JSON.parse(offer.volumeProducts);
    }
    if (offer.configuration) {
      const cfg = typeof offer.configuration === "string" ? JSON.parse(offer.configuration) : offer.configuration;
      return cfg?.volumeProducts || [];
    }
  } catch {}
  return [];
}

/**
 * Safely extracts tiers list from a volume offer record.
 * Supports both modern `volumeTiers` column and legacy `configuration.volumeTiers`.
 * @param {object} offer
 * @returns {Array}
 */
export function getVolumeTiersFromOffer(offer) {
  if (!offer) return [];
  try {
    if (offer.volumeTiers) {
      return JSON.parse(offer.volumeTiers);
    }
    if (offer.configuration) {
      const cfg = typeof offer.configuration === "string" ? JSON.parse(offer.configuration) : offer.configuration;
      return cfg?.volumeTiers || [];
    }
  } catch {}
  return [];
}

/**
 * Formats a product ID into a canonical Shopify GID.
 * @param {string|number} id
 * @returns {string}
 */
function toProductGid(id) {
  if (!id) return "";
  const str = String(id).trim();
  if (str.startsWith("gid://shopify/Product/")) return str;
  const num = str.split("/").pop();
  return `gid://shopify/Product/${num}`;
}

/**
 * Deletes the `volume_tiers` metafield from specified products.
 * Uses Shopify GraphQL `metafieldsDelete` mutation.
 * 
 * @param {object} admin - Authenticated Shopify GraphQL admin client
 * @param {Array<string|number>} productIds - Array of product GIDs or numeric IDs
 */
export async function removeVolumeMetafieldFromProducts(admin, productIds = []) {
  if (!admin || !Array.isArray(productIds) || productIds.length === 0) return;

  const validGids = productIds
    .map(toProductGid)
    .filter(Boolean);

  if (validGids.length === 0) return;

  // Process in batches of 25 (Shopify's maximum allowed in a single mutation)
  const BATCH_SIZE = 25;
  for (let i = 0; i < validGids.length; i += BATCH_SIZE) {
    const chunk = validGids.slice(i, i + BATCH_SIZE);
    const deleteInputs = chunk.map((ownerId) => ({
      ownerId,
      namespace: "stack_up",
      key: "volume_tiers",
    }));

    try {
      const res = await admin.graphql(
        `#graphql
        mutation DeleteProductVolumeTiers($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) {
            deletedMetafields {
              ownerId
              namespace
              key
            }
            userErrors {
              field
              message
            }
          }
        }`,
        { variables: { metafields: deleteInputs } }
      );

      const json = await res.json();
      const userErrors = json.data?.metafieldsDelete?.userErrors || [];
      if (userErrors.length > 0) {
        console.warn("[VolumeMetafields] Warning deleting product volume tiers:", userErrors);
      } else {
        console.log(`[VolumeMetafields] Cleaned volume_tiers from ${chunk.length} product(s).`);
      }
    } catch (err) {
      console.warn("[VolumeMetafields] Error deleting product volume tiers:", err);
    }
  }
}

/**
 * Syncs all active Volume Discount offers to individual Product Metafields:
 *   `product.metafields.stack_up.volume_tiers`
 * 
 * Also keeps `shop.metafields.stack_up.volume_offers` completely empty `{}` (2 bytes)
 * so it never consumes shop-level space.
 * 
 * @param {object} admin - Authenticated Shopify GraphQL admin client
 */
export async function syncAllActiveVolumeOffersToShopMetafield(admin) {
  try {
    const shopRes = await admin.graphql(
      `#graphql
      query GetShopId {
        shop {
          id
        }
      }`
    );
    const shopJson = await shopRes.json();
    const shopId = shopJson.data?.shop?.id;
    if (!shopId) return;

    // 1. Fetch all Volume offers from DB
    const allOffers = await prisma.offer.findMany({
      where: { type: "VOLUME" },
    });

    const activeOffers = [];
    const inactiveProductsToClean = new Set();

    // 2. Identify active offers and background sync DB status
    for (const o of allOffers) {
      const realStatus = computeOfferStatus(o);
      if (realStatus !== o.status && o.status !== "EXPIRED") {
        prisma.offer.update({ where: { id: o.id }, data: { status: realStatus } }).catch(() => {});
      }

      if (realStatus === "ACTIVE") {
        activeOffers.push(o);
      } else {
        const inactiveProds = getVolumeProductsFromOffer(o);
        inactiveProds.forEach((p) => {
          if (p.id) inactiveProductsToClean.add(p.id);
        });
      }
    }

    const productMetafieldMap = new Map();
    const activeProductGids = new Set();

    // 3. Prepare product-level metafields for active offers
    for (const offer of activeOffers) {
      const products = getVolumeProductsFromOffer(offer);
      const rawTiers = getVolumeTiersFromOffer(offer);

      const hasExplicitDefault = rawTiers.some(
        (t) => t.isDefault === true || t.isDefault === "true" || t.df === true || t.df === "true"
      );

      // Convert tiers to ultra-compact dictionary format
      const compactTiers = rawTiers
        .map((t, i) => normalizeTierToCompact(t, i, hasExplicitDefault))
        .filter((t) => t.mq > 0)
        .sort((a, b) => a.mq - b.mq);

      if (compactTiers.length === 0) continue;

      // Product payload (ultra-compact ~270 bytes per product!)
      const productPayload = {
        id: String(offer.numericId || offer.id || ""),
        t: String(offer.title || ""),
        wt: String(offer.widgetTitle || "Buy More, Save More"),
        p: Number(offer.percentage) || 0,
        tiers: compactTiers,
      };

      const payloadJson = JSON.stringify(productPayload);

      for (const prod of products) {
        const productGid = toProductGid(prod.id);
        if (!productGid) continue;

        activeProductGids.add(productGid);
        productMetafieldMap.set(productGid, payloadJson);
      }
    }

    const productMetafieldsToSet = Array.from(productMetafieldMap.entries()).map(([ownerId, value]) => ({
      ownerId,
      namespace: "stack_up",
      key: "volume_tiers",
      type: "json",
      value,
    }));

    // 4. Automatically clean up any products from expired/inactive offers
    // that are NOT part of any other active offer
    const productsToDelete = Array.from(inactiveProductsToClean).filter(
      (pid) => !activeProductGids.has(toProductGid(pid))
    );
    if (productsToDelete.length > 0) {
      await removeVolumeMetafieldFromProducts(admin, productsToDelete);
    }

    // 5. Batch save product metafields in chunks of 25
    const BATCH_SIZE = 25;
    for (let i = 0; i < productMetafieldsToSet.length; i += BATCH_SIZE) {
      const chunk = productMetafieldsToSet.slice(i, i + BATCH_SIZE);
      const mutation = `#graphql
        mutation SetProductVolumeTiers($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields {
              id
              key
              namespace
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const res = await admin.graphql(mutation, {
        variables: { metafields: chunk },
      });
      const json = await res.json();
      const userErrors = json.data?.metafieldsSet?.userErrors || [];
      if (userErrors.length > 0) {
        console.warn("[VolumeMetafields] UserErrors saving product volume tiers:", userErrors);
      }
    }

    // 6. Ensure the old Shop Metafield stays completely empty `{}` (only 2 bytes)
    await admin.graphql(
      `#graphql
      mutation EmptyShopVolumeMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
          }
          userErrors {
            message
          }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              ownerId: shopId,
              namespace: "stack_up",
              key: "volume_offers",
              type: "json",
              value: "{}",
            },
          ],
        },
      }
    );

    console.log(`[VolumeMetafields] Successfully synced ${productMetafieldsToSet.length} product(s) to product.metafields.stack_up.volume_tiers across ${activeOffers.length} offer(s).`);
  } catch (err) {
    console.error("[VolumeMetafields] Error syncing volume offers to product metafields:", err);
  }
}
