import prisma from "../db.server.js";
import { computeOfferStatus } from "./timezone.js";

/**
 * Helper to sync active paired product bundle offers to a single Shop Metafield.
 * Storing under shop.metafields.stack_up.paired_offers does NOT require write_products scope,
 * and allows Liquid to look up any product's paired offer in 0ms!
 */
export async function syncAllActiveOffersToShopMetafield(admin) {
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

    // Fetch all paired offers from DB that are not manually deactivated
    const allOffers = await prisma.pairedOffer.findMany({
      where: { status: { not: "EXPIRED" } },
    });
    const activeOffers = allOffers.filter((o) => computeOfferStatus(o) === "ACTIVE");

    // Background sync of DB status if real-time status changed
    for (const o of allOffers) {
      const realStatus = computeOfferStatus(o);
      if (realStatus !== o.status && o.status !== "EXPIRED") {
        prisma.pairedOffer.update({ where: { id: o.id }, data: { status: realStatus } }).catch(() => {});
      }
    }

    // Collect all sub-product IDs that need real variant IDs
    const subProductIdsToFetch = new Set();
    for (const o of activeOffers) {
      try {
        const subs = JSON.parse(o.subProducts);
        subs.forEach((s) => {
          if (s.id) subProductIdsToFetch.add(s.id);
        });
      } catch (e) {
        // ignore JSON parse error
      }
    }

    // Query Shopify for real variant IDs, images, and handles
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

    const offersMap = {};

    for (const offer of activeOffers) {
      let mainProducts = [];
      let subProducts = [];
      try {
        mainProducts = JSON.parse(offer.mainProducts);
        subProducts = JSON.parse(offer.subProducts);
      } catch (e) {
        continue;
      }

      const enrichedSubProducts = subProducts.map((p) => {
        const realProd = productInfoMap[p.id];
        const selectedVariantIds = Array.isArray(p.variants) && p.variants.length > 0
          ? new Set(p.variants.map((v) => String(typeof v === "object" ? v.id : v).split("/").pop()))
          : null;

        const allVariants = (realProd?.variants?.nodes || p.variants || []).map((v) => ({
          id: String(v.id).split("/").pop(),
          title: v.title,
          price: Math.round(parseFloat(v.price) * 100),
          availableForSale: v.availableForSale !== undefined ? Boolean(v.availableForSale) : true,
        }));

        // Filter variants down to only merchant-selected variants if specific variants were chosen
        const variants = selectedVariantIds && selectedVariantIds.size > 0
          ? allVariants.filter((v) => selectedVariantIds.has(v.id))
          : allVariants;

        const rawPriceStr = String(p.price || "");
        const fallbackPrice = rawPriceStr
          ? Math.round((parseFloat(rawPriceStr.replace(/[^0-9.]/g, "")) || 20) * 100)
          : 2000;

        return {
          id: p.id,
          numericId: String(p.id).split("/").pop(),
          title: realProd?.title || p.title || "Sub Product",
          handle: realProd?.handle || p.handle || "",
          image: realProd?.featuredImage?.url || p.image || "",
          price: variants[0]?.price || fallbackPrice,
          quantity: Number(p.quantity) || 1,
          availableForSale: variants.length > 0 ? variants.some((v) => v.availableForSale) : true,
          variants,
        };
      });

      for (const mainProd of mainProducts) {
        const fullGid = String(mainProd.id);
        const numericId = fullGid.split("/").pop();
        const mainQty = Number(mainProd.quantity) || 1;

        const offerData = {
          offerId: offer.discountId,
          title: offer.title,
          percentage: offer.percentage,
          mainQuantity: mainQty,
          subProducts: enrichedSubProducts,
        };

        offersMap[numericId] = offerData;
        offersMap["id_" + numericId] = offerData;
        offersMap[fullGid] = offerData;
      }
    }

    const mutation = `#graphql
      mutation SetPairedOffersShopMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            key
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    await admin.graphql(mutation, {
      variables: {
        metafields: [
          {
            ownerId: shopId,
            namespace: "stack_up",
            key: "paired_offers",
            type: "json",
            value: JSON.stringify(offersMap),
          },
        ],
      },
    });

    console.log(`[BundleMetafields] Synced ${Object.keys(offersMap).length / 2} active offer(s) to shop.metafields.stack_up.paired_offers.`);
  } catch (err) {
    console.error("[BundleMetafields] Error syncing paired offers to shop metafield:", err);
  }
}
