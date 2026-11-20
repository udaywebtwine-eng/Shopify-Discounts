import prisma from "../db.server.js";
import { computeOfferStatus } from "./timezone.js";

/**
 * ============================================================================
 * STACKUP PAIRED BUNDLES - PRODUCT-LEVEL METAFELD ENGINE (SHARDED)
 * ============================================================================
 * 
 * Instead of storing every bundle offer into a single 4,000+ byte shop-level metafield
 * (which crashes into Shopify Functions' 10,000-byte limit after 2-3 offers),
 * each Paired Bundle offer is saved directly on the participating Main Product's metafield:
 *   `product.metafields.stack_up.paired_bundle`
 * 
 * BENEFIT:
 * - Each main product stores only its own compact ~260-280 byte rule.
 * - At checkout, Shopify Functions ONLY query the metafields of items in the cart!
 * - A store can have 10,000+ active bundle offers without ever hitting the 10 KB limit.
 * - Liquid on product pages directly reads `product.metafields.stack_up.paired_bundle` in 0ms!
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
 * Safely extracts main products list from a paired offer record.
 * Supports modern `mainProducts` column and `configuration.mainProducts`.
 * @param {object} offer
 * @returns {Array}
 */
export function getMainProductsFromOffer(offer) {
  if (!offer) return [];
  try {
    if (offer.mainProducts) {
      const parsed = typeof offer.mainProducts === "string" ? JSON.parse(offer.mainProducts) : offer.mainProducts;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
    if (offer.configuration) {
      const cfg = typeof offer.configuration === "string" ? JSON.parse(offer.configuration) : offer.configuration;
      if (Array.isArray(cfg?.mainProducts) && cfg.mainProducts.length > 0) return cfg.mainProducts;
    }
  } catch {}
  return [];
}

/**
 * Safely extracts sub/companion products list from a paired offer record.
 * Supports modern `subProducts` column and `configuration.subProducts`.
 * @param {object} offer
 * @returns {Array}
 */
export function getSubProductsFromOffer(offer) {
  if (!offer) return [];
  try {
    if (offer.subProducts) {
      const parsed = typeof offer.subProducts === "string" ? JSON.parse(offer.subProducts) : offer.subProducts;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
    if (offer.configuration) {
      const cfg = typeof offer.configuration === "string" ? JSON.parse(offer.configuration) : offer.configuration;
      if (Array.isArray(cfg?.subProducts) && cfg.subProducts.length > 0) return cfg.subProducts;
    }
  } catch {}
  return [];
}

/**
 * Removes `product.metafields.stack_up.paired_bundle` from specific products in chunks of 25.
 * Used during offer deactivation, deletion, or product removal.
 * @param {object} admin Shopify Admin GraphQL client
 * @param {Array<string>} productIds Array of product GIDs or numeric IDs
 */
export async function removePairedMetafieldFromProducts(admin, productIds = []) {
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
      key: "paired_bundle",
    }));

    try {
      const res = await admin.graphql(
        `#graphql
        mutation DeleteProductPairedBundle($metafields: [MetafieldIdentifierInput!]!) {
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
        console.warn("[BundleMetafields] UserErrors deleting product paired bundle metafields:", userErrors);
      }
    } catch (err) {
      console.error("[BundleMetafields] Failed to delete paired bundle metafields from products chunk:", err);
    }
  }
}

/**
 * Sync active paired product bundle offers to Product-Level Sharded Metafields.
 * Automatically saves `product.metafields.stack_up.paired_bundle` on each Main Product,
 * cleans up inactive/expired products, and empties out the legacy shop metafield.
 * @param {object} admin Shopify Admin GraphQL client
 * @param {string} [shopDomain] Optional explicit shop domain from session
 */
export async function syncAllActiveOffersToShopMetafield(admin, shopDomain = null) {
  try {
    const shopRes = await admin.graphql(
      `#graphql
      query GetShopId {
        shop {
          id
          myshopifyDomain
        }
      }`
    );
    const shopJson = await shopRes.json();
    const shopId = shopJson.data?.shop?.id;
    if (!shopId) return;

    const canonicalShop = (shopDomain || shopJson.data?.shop?.myshopifyDomain || "").trim();
    if (!canonicalShop) {
      console.warn("[PairedSync] No shop domain available, aborting metafield sync.");
      return;
    }
    const cleanShop = canonicalShop.replace(".myshopify.com", "");
    const shopFilter = {
      OR: [
        { shop: canonicalShop },
        { shop: cleanShop },
        { shop: `${cleanShop}.myshopify.com` },
      ],
    };

    // 1. Fetch all PAIRED offers from DB strictly for this authenticated shop
    const allOffers = await prisma.offer.findMany({
      where: {
        AND: [
          shopFilter,
          { type: "PAIRED" },
        ],
      },
    });

    const activeOffers = [];
    const inactiveProductsToClean = new Set();

    // 2. Classify active vs inactive offers and sync DB status if changed
    for (const o of allOffers) {
      const realStatus = computeOfferStatus(o);
      if (realStatus !== o.status && o.status !== "EXPIRED") {
        prisma.offer.update({ where: { id: o.id }, data: { status: realStatus } }).catch(() => {});
      }

      const mainProducts = getMainProductsFromOffer(o);
      if (realStatus === "ACTIVE" && o.status !== "EXPIRED") {
        activeOffers.push(o);
      } else {
        mainProducts.forEach((p) => {
          if (p?.id) inactiveProductsToClean.add(p.id);
        });
      }
    }

    // 3. Collect all sub-product IDs that need real variant IDs, prices, and handles
    const subProductIdsToFetch = new Set();
    for (const o of activeOffers) {
      const subs = getSubProductsFromOffer(o);
      subs.forEach((s) => {
        if (s?.id) subProductIdsToFetch.add(toProductGid(s.id));
      });
    }

    const productInfoMap = {};
    if (subProductIdsToFetch.size > 0) {
      try {
        const prodRes = await admin.graphql(
          `#graphql
          query GetSubVariants($ids: [ID!]!) {
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
          { variables: { ids: Array.from(subProductIdsToFetch) } }
        );
        const prodJson = await prodRes.json();
        const nodes = prodJson.data?.nodes || [];
        nodes.forEach((node) => {
          if (node?.id) productInfoMap[node.id] = node;
        });
      } catch (err) {
        console.warn("[BundleMetafields] Could not fetch sub product details:", err);
      }
    }

    // 4. Build Product-Level Sharded Metafields Map
    const productMetafieldMap = new Map();
    const activeMainProductGids = new Set();

    for (const offer of activeOffers) {
      const mainProducts = getMainProductsFromOffer(offer);
      const subProducts = getSubProductsFromOffer(offer);
      if (mainProducts.length === 0 || subProducts.length === 0) continue;

      const discountPercentage = Number(offer.percentage) || 10;

      // Build compact sub-products array
      const compactSubs = subProducts.map((p) => {
        const pGid = toProductGid(p.id);
        const realProd = productInfoMap[pGid] || productInfoMap[p.id];
        const selectedVariantIds = Array.isArray(p.variants) && p.variants.length > 0
          ? new Set(p.variants.map((v) => String(typeof v === "object" ? v.id : v).split("/").pop()))
          : null;

        const allVariants = (realProd?.variants?.nodes || p.variants || []).map((v) => ({
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

        const firstVariantId = variants[0]?.id || String(p.id).split("/").pop();

        const subObj = {
          id: String(p.id).split("/").pop(),
          q: Number(p.quantity) || 1,
          vid: String(firstVariantId).split("/").pop(),
          t: realProd?.title || p.title || "Companion Item",
          p: variants[0]?.price || fallbackPrice,
          h: realProd?.handle || p.handle || "",
          img: realProd?.featuredImage?.url || p.image || "",
        };

        if (selectedVariantIds && selectedVariantIds.size > 0) {
          subObj.vids = Array.from(selectedVariantIds);
        }

        // Include variants array if multiple variants exist (needed for storefront variant selector)
        if (variants.length > 1) {
          subObj.variants = variants;
        }

        return subObj;
      });

      // Assign payload to each Main Product
      for (const mainProd of mainProducts) {
        const mainGid = toProductGid(mainProd.id);
        if (!mainGid) continue;

        activeMainProductGids.add(mainGid);

        const selectedMainVariantIds = Array.isArray(mainProd.variants) && mainProd.variants.length > 0
          ? mainProd.variants.map((v) => String(typeof v === "object" ? v.id : v).split("/").pop()).filter(Boolean)
          : null;

        const productPayload = {
          id: String(offer.numericId || offer.id || ""),
          t: String(offer.title || ""),
          wt: String(offer.widgetTitle || "Frequently Bought Together"),
          d: discountPercentage,
          mq: Number(mainProd.quantity) || 1,
          subs: compactSubs,
        };

        if (selectedMainVariantIds && selectedMainVariantIds.length > 0) {
          productPayload.mvids = selectedMainVariantIds;
        }

        productMetafieldMap.set(mainGid, JSON.stringify(productPayload));
      }
    }

    const productMetafieldsToSet = Array.from(productMetafieldMap.entries()).map(([ownerId, value]) => ({
      ownerId,
      namespace: "stack_up",
      key: "paired_bundle",
      type: "json",
      value,
    }));

    // 5. Clean up any products from expired/inactive offers that are not in active offers
    const productsToDelete = Array.from(inactiveProductsToClean).filter(
      (pid) => !activeMainProductGids.has(toProductGid(pid))
    );
    if (productsToDelete.length > 0) {
      await removePairedMetafieldFromProducts(admin, productsToDelete);
    }

    // 6. Batch save product metafields in chunks of 25
    const BATCH_SIZE = 25;
    for (let i = 0; i < productMetafieldsToSet.length; i += BATCH_SIZE) {
      const chunk = productMetafieldsToSet.slice(i, i + BATCH_SIZE);
      const mutation = `#graphql
        mutation SetProductPairedBundle($metafields: [MetafieldsSetInput!]!) {
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
        console.warn("[BundleMetafields] UserErrors saving product paired bundle:", userErrors);
      }
    }

    // 7. Ensure the old Shop Metafield stays completely empty `{}` (only 2 bytes)
    await admin.graphql(
      `#graphql
      mutation EmptyShopPairedMetafield($metafields: [MetafieldsSetInput!]!) {
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
              key: "paired_offers",
              type: "json",
              value: "{}",
            },
          ],
        },
      }
    );

    console.log(`[BundleMetafields] Successfully synced ${productMetafieldsToSet.length} main product(s) to product.metafields.stack_up.paired_bundle across ${activeOffers.length} offer(s).`);
  } catch (err) {
    console.error("[BundleMetafields] Error syncing paired offers to product metafields:", err);
  }
}
