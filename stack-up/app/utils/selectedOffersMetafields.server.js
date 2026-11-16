import prisma from "../db.server.js";
import { computeOfferStatus } from "./timezone.js";

/**
 * ============================================================================
 * STACKUP SELECTED PRODUCTS / ADD-ONS - PRODUCT-LEVEL METAFELD ENGINE (SHARDED)
 * ============================================================================
 * 
 * Instead of storing every add-on offer into a single 4,000+ byte shop-level metafield
 * (which crashes into Shopify Functions' 10,000-byte limit after 2-3 offers),
 * each Selected Add-On offer is saved directly on the participating Target Product's metafield:
 *   `product.metafields.stack_up.selected_offers`
 * 
 * BENEFIT:
 * - Each target product stores only its own compact ~280-byte rule.
 * - At checkout, Shopify Functions ONLY query the metafields of items in the cart!
 * - A store can have 10,000+ active add-on offers without ever hitting the 10 KB limit.
 * - Liquid on product pages directly reads `product.metafields.stack_up.selected_offers` in 0ms!
 */

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
 * Safely extracts target/main products list from a selected offer record.
 * Supports modern `targetProducts` column and legacy `configuration.targetProducts`.
 * @param {object} offer
 * @returns {Array}
 */
export function getSelectedTargetProductsFromOffer(offer) {
  if (!offer) return [];
  try {
    if (offer.targetProducts) {
      const parsed = typeof offer.targetProducts === "string" ? JSON.parse(offer.targetProducts) : offer.targetProducts;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
    if (offer.configuration) {
      const cfg = typeof offer.configuration === "string" ? JSON.parse(offer.configuration) : offer.configuration;
      if (Array.isArray(cfg?.targetProducts) && cfg.targetProducts.length > 0) return cfg.targetProducts;
    }
    // Fallback: If no explicit target products, fallback to offered products
    return getSelectedOfferedProductsFromOffer(offer);
  } catch {}
  return [];
}

/**
 * Safely extracts offered/recommended add-on products list from a selected offer record.
 * Supports modern `offeredProducts` column, legacy `products` column, and `configuration`.
 * @param {object} offer
 * @returns {Array}
 */
export function getSelectedOfferedProductsFromOffer(offer) {
  if (!offer) return [];
  try {
    if (offer.offeredProducts) {
      const parsed = typeof offer.offeredProducts === "string" ? JSON.parse(offer.offeredProducts) : offer.offeredProducts;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
    if (offer.products) {
      const parsed = typeof offer.products === "string" ? JSON.parse(offer.products) : offer.products;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
    if (offer.configuration) {
      const cfg = typeof offer.configuration === "string" ? JSON.parse(offer.configuration) : offer.configuration;
      if (Array.isArray(cfg?.offeredProducts) && cfg.offeredProducts.length > 0) return cfg.offeredProducts;
      if (Array.isArray(cfg?.products) && cfg.products.length > 0) return cfg.products;
    }
  } catch {}
  return [];
}

/**
 * Deletes the `selected_offers` metafield from specified products.
 * Uses Shopify GraphQL `metafieldsDelete` mutation in batches of 25.
 * 
 * @param {object} admin - Authenticated Shopify GraphQL admin client
 * @param {Array<string|number>} productIds - Array of product GIDs or numeric IDs
 */
export async function removeSelectedMetafieldFromProducts(admin, productIds = []) {
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
      key: "selected_offers",
    }));

    try {
      const res = await admin.graphql(
        `#graphql
        mutation DeleteProductSelectedOffers($metafields: [MetafieldIdentifierInput!]!) {
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
        console.warn("[SelectedOffersMetafield] Warning deleting product selected offers:", userErrors);
      } else {
        console.log(`[SelectedOffersMetafield] Cleaned selected_offers from ${chunk.length} product(s).`);
      }
    } catch (err) {
      console.warn("[SelectedOffersMetafield] Error deleting product selected offers:", err);
    }
  }
}

/**
 * Syncs all active Selected Product (Add-On) offers to individual Target Product Metafields:
 *   `product.metafields.stack_up.selected_offers`
 * 
 * Also keeps `shop.metafields.stack_up.selected_offers` completely empty `{}` (2 bytes)
 * so it never consumes shop-level space or crashes checkout.
 * 
 * @param {object} admin - Authenticated Shopify GraphQL admin client
 */
export async function syncAllActiveSelectedOffersToShopMetafield(admin) {
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

    // 1. Fetch all Selected product offers from DB
    const allOffers = await prisma.offer.findMany({
      where: { type: "SELECTED" },
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
        const inactiveTargets = getSelectedTargetProductsFromOffer(o);
        inactiveTargets.forEach((p) => {
          if (p.id) inactiveProductsToClean.add(p.id);
        });
      }
    }

    // 3. Collect all offered product IDs to fetch live variant details in bulk
    const offeredProductIdsToFetch = new Set();
    for (const o of activeOffers) {
      const offered = getSelectedOfferedProductsFromOffer(o);
      offered.forEach((p) => {
        if (p.id) offeredProductIdsToFetch.add(toProductGid(p.id));
      });
    }

    const productInfoMap = {};
    if (offeredProductIdsToFetch.size > 0) {
      try {
        const prodRes = await admin.graphql(
          `#graphql
          query GetOfferedProductVariants($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Product {
                id
                title
                handle
                featuredImage {
                  url
                }
                variants(first: 20) {
                  nodes {
                    id
                    title
                    price
                    availableForSale
                  }
                }
              }
            }
          }`,
          { variables: { ids: Array.from(offeredProductIdsToFetch) } }
        );
        const prodJson = await prodRes.json();
        const nodes = prodJson.data?.nodes || [];
        nodes.forEach((node) => {
          if (node?.id) {
            productInfoMap[node.id] = node;
            const numId = String(node.id).split("/").pop();
            productInfoMap[numId] = node;
          }
        });
      } catch (err) {
        console.warn("[SelectedOffersMetafield] Could not fetch offered product details:", err);
      }
    }

    const productMetafieldMap = new Map();
    const activeTargetProductGids = new Set();

    // 4. Prepare compact product-level metafields for active offers
    for (const offer of activeOffers) {
      const targetProducts = getSelectedTargetProductsFromOffer(offer);
      const offeredProducts = getSelectedOfferedProductsFromOffer(offer);
      const discountPercentage = Number(offer.percentage) || 0;

      if (targetProducts.length === 0 || offeredProducts.length === 0) continue;

      // Convert offered products to ultra-compact items
      const compactItems = offeredProducts.map((p) => {
        const gid = toProductGid(p.id);
        const numId = String(p.id).split("/").pop();
        const realProd = productInfoMap[gid] || productInfoMap[numId];

        const selectedVariantIds = Array.isArray(p.variants) && p.variants.length > 0
          ? new Set(p.variants.map((v) => String(typeof v === "object" ? v.id : v).split("/").pop()))
          : null;

        const allVariants = (realProd?.variants?.nodes || []).map((v) => ({
          id: String(v.id).split("/").pop(),
          title: v.title,
          price: Math.round(parseFloat(v.price) * 100),
          availableForSale: v.availableForSale !== undefined ? Boolean(v.availableForSale) : true,
        }));

        const variants = selectedVariantIds && selectedVariantIds.size > 0
          ? allVariants.filter((v) => selectedVariantIds.has(v.id))
          : allVariants;

        const rawPriceStr = String(p.price || "");
        const fallbackPrice = rawPriceStr
          ? Math.round((parseFloat(rawPriceStr.replace(/[^0-9.]/g, "")) || 20) * 100)
          : 2000;

        const originalPrice = variants[0]?.price || fallbackPrice;
        const discountedPrice = Math.round(originalPrice * (1 - discountPercentage / 100));
        const firstVariantId = variants[0]?.id || "";
        const specificVids = selectedVariantIds && selectedVariantIds.size > 0
          ? Array.from(selectedVariantIds)
          : undefined;

        const itemObj = {
          id: numId,
          vid: firstVariantId,
          t: realProd?.title || p.title || "Add-on Product",
          p: originalPrice,
          dp: discountedPrice,
          h: realProd?.handle || p.handle || "",
          img: realProd?.featuredImage?.url || p.image || "",
          q: Number(p.quantity) || 1,
          df: true,
        };

        if (specificVids && specificVids.length > 0) {
          itemObj.vids = specificVids;
        }

        return itemObj;
      });

      // Target Product payload (ultra-compact ~280 bytes per product!)
      const productPayload = {
        id: String(offer.numericId || offer.id || ""),
        t: String(offer.title || ""),
        wt: String(offer.widgetTitle || "Special Add-Ons Just for You"),
        d: discountPercentage,
        items: compactItems,
      };

      const payloadJson = JSON.stringify(productPayload);

      for (const targetProd of targetProducts) {
        const targetGid = toProductGid(targetProd.id);
        if (!targetGid) continue;

        activeTargetProductGids.add(targetGid);
        productMetafieldMap.set(targetGid, payloadJson);
      }
    }

    const productMetafieldsToSet = Array.from(productMetafieldMap.entries()).map(([ownerId, value]) => ({
      ownerId,
      namespace: "stack_up",
      key: "selected_offers",
      type: "json",
      value,
    }));

    // 5. Automatically clean up any products from expired/inactive offers
    // that are NOT part of any other active offer
    const productsToDelete = Array.from(inactiveProductsToClean).filter(
      (pid) => !activeTargetProductGids.has(toProductGid(pid))
    );
    if (productsToDelete.length > 0) {
      await removeSelectedMetafieldFromProducts(admin, productsToDelete);
    }

    // 6. Batch save product metafields in chunks of 25
    const BATCH_SIZE = 25;
    for (let i = 0; i < productMetafieldsToSet.length; i += BATCH_SIZE) {
      const chunk = productMetafieldsToSet.slice(i, i + BATCH_SIZE);
      const mutation = `#graphql
        mutation SetProductSelectedOffers($metafields: [MetafieldsSetInput!]!) {
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
        console.warn("[SelectedOffersMetafield] UserErrors saving product selected offers:", userErrors);
      }
    }

    // 7. Ensure the old Shop Metafield stays completely empty `{}` (only 2 bytes)
    await admin.graphql(
      `#graphql
      mutation EmptyShopSelectedMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
          }
          userErrors {
            field
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
              key: "selected_offers",
              type: "json",
              value: "{}",
            },
          ],
        },
      }
    );

    console.log(`[SelectedOffersMetafield] Successfully synced ${productMetafieldsToSet.length} target product(s) to product.metafields.stack_up.selected_offers across ${activeOffers.length} offer(s).`);
  } catch (err) {
    console.error("[SelectedOffersMetafield] Error syncing selected offers to product metafields:", err);
  }
}
