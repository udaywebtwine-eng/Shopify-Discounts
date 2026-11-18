import prisma from "../db.server.js";
import { computeOfferStatus } from "./timezone.js";

/**
 * ============================================================================
 * STACKUP BOGO & BUY X GET Y - PRODUCT-LEVEL METAFELD ENGINE (SHARDED ARCHITECTURE)
 * ============================================================================
 * 
 * Instead of storing all BOGO promotions in one oversized shop-level metafield
 * (which risks exceeding Shopify Functions' strict 10 KB limit),
 * each promotion is saved directly onto the participating Buy product's metafield:
 *   `product.metafields.stack_up.bogo_offer`
 * 
 * BENEFIT:
 * - Each product stores only its own compact ~180-byte rule.
 * - At checkout, Shopify Functions only query the metafields of items in the cart!
 * - Liquid on product pages can read `product.metafields.stack_up.bogo_offer` instantly.
 */

/**
 * Safely extracts Customer Buy (X) products list from a BOGO offer record.
 * @param {object} offer
 * @returns {Array}
 */
export function getBogoBuyProducts(offer) {
  if (!offer) return [];
  try {
    if (offer.mainProducts) {
      return JSON.parse(offer.mainProducts);
    }
    if (offer.configuration) {
      const cfg = typeof offer.configuration === "string" ? JSON.parse(offer.configuration) : offer.configuration;
      return cfg?.mainProducts || [];
    }
  } catch {}
  return [];
}

/**
 * Safely extracts Customer Get (Y) reward products list from a BOGO offer record.
 * @param {object} offer
 * @returns {Array}
 */
export function getBogoGetProducts(offer) {
  if (!offer) return [];
  try {
    if (offer.subProducts) {
      return JSON.parse(offer.subProducts);
    }
    if (offer.configuration) {
      const cfg = typeof offer.configuration === "string" ? JSON.parse(offer.configuration) : offer.configuration;
      return cfg?.subProducts || [];
    }
  } catch {}
  return [];
}

/**
 * Safely parses the configuration JSON of a BOGO offer.
 * @param {object} offer
 * @returns {object}
 */
export function getBogoConfiguration(offer) {
  if (!offer) return {};
  try {
    if (typeof offer.configuration === "string") {
      return JSON.parse(offer.configuration);
    }
    if (typeof offer.configuration === "object" && offer.configuration !== null) {
      return offer.configuration;
    }
  } catch {}
  return {};
}

/**
 * Formats a product ID into a canonical Shopify GID.
 * @param {string|number} id
 * @returns {string}
 */
export function toProductGid(id) {
  if (!id) return "";
  const str = String(id).trim();
  if (str.startsWith("gid://shopify/Product/")) return str;
  const num = str.split("/").pop();
  return `gid://shopify/Product/${num}`;
}

/**
 * Deletes the `bogo_offer` metafield from specified products.
 * Uses Shopify GraphQL `metafieldsDelete` mutation in batches of 25.
 * 
 * @param {object} admin - Authenticated Shopify GraphQL admin client
 * @param {Array<string|number>} productIds - Array of product GIDs or numeric IDs
 */
export async function removeBogoMetafieldFromProducts(admin, productIds = []) {
  if (!admin || !Array.isArray(productIds) || productIds.length === 0) return;

  const validGids = productIds
    .map(toProductGid)
    .filter(Boolean);

  if (validGids.length === 0) return;

  const BATCH_SIZE = 25;
  for (let i = 0; i < validGids.length; i += BATCH_SIZE) {
    const chunk = validGids.slice(i, i + BATCH_SIZE);
    const deleteInputs = chunk.map((ownerId) => ({
      ownerId,
      namespace: "stack_up",
      key: "bogo_offer",
    }));

    try {
      const res = await admin.graphql(
        `#graphql
        mutation DeleteProductBogoMetafields($metafields: [MetafieldIdentifierInput!]!) {
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
        console.warn("[BogoMetafields] Warning deleting product bogo metafields:", userErrors);
      }
    } catch (err) {
      console.warn("[BogoMetafields] Error deleting product bogo metafields:", err);
    }
  }
}

/**
 * Syncs all active BOGO & Buy X Get Y offers to product-level metafields:
 *   `product.metafields.stack_up.bogo_offer`
 * 
 * @param {object} admin - Authenticated Shopify GraphQL admin client
 */
export async function syncAllActiveBogoOffersToShopMetafield(admin) {
  if (!admin) return;

  try {
    const shopRes = await admin.graphql(
      `#graphql
      query GetShopIdForBogoMetafield {
        shop {
          id
        }
      }`
    );
    const shopJson = await shopRes.json();
    const shopId = shopJson.data?.shop?.id;
    if (!shopId) return;

    // 1. Fetch all BOGO offers from database
    const allOffers = await prisma.offer.findMany({
      where: { type: "BOGO" },
    });

    const activeOffers = [];
    const inactiveProductsToClean = new Set();

    // 2. Compute status using store timezone and identify active offers
    for (const o of allOffers) {
      const realStatus = computeOfferStatus(o);
      if (realStatus !== o.status && o.status !== "EXPIRED") {
        prisma.offer.update({ where: { id: o.id }, data: { status: realStatus } }).catch(() => {});
      }

      if (realStatus === "ACTIVE") {
        activeOffers.push(o);
      } else {
        const inactiveProds = getBogoBuyProducts(o);
        inactiveProds.forEach((p) => {
          if (p.id) inactiveProductsToClean.add(p.id);
        });
      }
    }

    const productMetafieldMap = new Map();
    const activeProductGids = new Set();

    // 3. Prepare product-level payload for each Buy product in active offers
    for (const offer of activeOffers) {
      const buyProducts = getBogoBuyProducts(offer);
      const getProducts = getBogoGetProducts(offer);
      const cfg = getBogoConfiguration(offer);

      const dealType = cfg.dealType || "BOGO"; // "BUY_X_GET_Y" | "BUY_X_GET_X" | "BOGO"
      const buyQty = Math.max(1, Number(cfg.buyQty || 1));
      const getQty = Math.max(1, Number(cfg.getQty || 1));
      const discountType = cfg.discountType === "FIXED_AMOUNT" ? "F" : "P";
      const discountValue = dealType === "BOGO" ? 100 : Number(cfg.discountValue ?? 100);
      const maxDiscount = cfg.maxDiscount ? Number(cfg.maxDiscount) : null;

      // Extract single reward product if BUY_X_GET_Y
      let rewardProductPayload = null;
      if (dealType === "BUY_X_GET_Y" && getProducts.length > 0) {
        const rp = getProducts[0];
        rewardProductPayload = {
          id: toProductGid(rp.id),
          title: rp.title || "",
          handle: rp.handle || "",
          image: rp.image || rp.images?.[0]?.url || "",
          price: Number(rp.price || (rp.variants?.[0]?.price) || 0),
          variants: (rp.variants || []).map((v) => ({
            id: String(v.id || ""),
            title: v.title || "Default Title",
            price: Number(v.price || 0),
          })),
        };
      }

      // Compact payload (~220 bytes)
      const payload = {
        id: String(offer.numericId || offer.id || ""),
        t: String(offer.title || ""),
        wt: String(offer.widgetTitle || ""),
        dealType,
        buyQty,
        getQty,
        dType: discountType,
        dVal: discountValue,
        maxD: maxDiscount,
        getY: rewardProductPayload,
      };

      const payloadJson = JSON.stringify(payload);

      for (const prod of buyProducts) {
        const prodGid = toProductGid(prod.id);
        if (!prodGid) continue;

        activeProductGids.add(prodGid);
        productMetafieldMap.set(prodGid, payloadJson);
      }
    }

    const productMetafieldsToSet = Array.from(productMetafieldMap.entries()).map(([ownerId, value]) => ({
      ownerId,
      namespace: "stack_up",
      key: "bogo_offer",
      type: "json",
      value,
    }));

    // 4. Clean up any products from expired/inactive offers
    const productsToDelete = Array.from(inactiveProductsToClean).filter(
      (pid) => !activeProductGids.has(toProductGid(pid))
    );

    if (productsToDelete.length > 0) {
      await removeBogoMetafieldFromProducts(admin, productsToDelete);
    }

    // 5. Batch save product metafields in chunks of 25
    const BATCH_SIZE = 25;
    for (let i = 0; i < productMetafieldsToSet.length; i += BATCH_SIZE) {
      const chunk = productMetafieldsToSet.slice(i, i + BATCH_SIZE);
      const mutation = `#graphql
        mutation SetProductBogoMetafields($metafields: [MetafieldsSetInput!]!) {
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
        console.warn("[BogoMetafields] UserErrors saving product BOGO metafields:", userErrors);
      }
    }

    // 6. Ensure shop-level metafield is kept empty `{}` (2 bytes)
    await admin.graphql(
      `#graphql
      mutation EmptyShopBogoMetafield($metafields: [MetafieldsSetInput!]!) {
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
              key: "bogo_offers",
              type: "json",
              value: "{}",
            },
          ],
        },
      }
    );

    console.log(`[BogoMetafields] Successfully synced ${productMetafieldsToSet.length} product(s) to product.metafields.stack_up.bogo_offer across ${activeOffers.length} offer(s).`);
  } catch (err) {
    console.error("[BogoMetafields] Error syncing BOGO offers to product metafields:", err);
  }
}

