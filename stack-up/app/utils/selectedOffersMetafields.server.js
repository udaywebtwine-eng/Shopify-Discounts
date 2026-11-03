import prisma from "../db.server.js";
import { computeOfferStatus } from "./timezone.js";

/**
 * Helper to sync active selected product offers to a single Shop Metafield.
 * Storing under shop.metafields.stack_up.selected_offers allows Liquid to
 * look up any product's active offer in 0ms!
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

    // Fetch all selected product offers from DB that are not manually deactivated
    const allOffers = await prisma.selectedProductOffer.findMany({
      where: { status: { not: "EXPIRED" } },
    });
    const activeOffers = allOffers.filter((o) => computeOfferStatus(o) === "ACTIVE");

    // Background sync of DB status if real-time status changed
    for (const o of allOffers) {
      const realStatus = computeOfferStatus(o);
      if (realStatus !== o.status && o.status !== "EXPIRED") {
        prisma.selectedProductOffer.update({ where: { id: o.id }, data: { status: realStatus } }).catch(() => {});
      }
    }

    // Collect all offered product IDs to fetch live variant details (variant IDs, prices, inventory)
    const offeredProductIdsToFetch = new Set();
    for (const o of activeOffers) {
      try {
        let offered = [];
        if (o.offeredProducts && o.offeredProducts !== "[]") {
          offered = JSON.parse(o.offeredProducts);
        } else if (o.products && o.products !== "[]") {
          offered = JSON.parse(o.products);
        }
        offered.forEach((p) => {
          if (p.id) offeredProductIdsToFetch.add(p.id);
        });
      } catch (e) {
        // ignore parse errors
      }
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
          if (node?.id) productInfoMap[node.id] = node;
        });
      } catch (err) {
        console.warn("[SelectedOffersMetafield] Could not fetch offered product details:", err);
      }
    }

    const offersMap = {};

    for (const offer of activeOffers) {
      let targetProducts = [];
      let offeredProducts = [];

      try {
        if (offer.targetProducts && offer.targetProducts !== "[]") {
          targetProducts = JSON.parse(offer.targetProducts);
        }
      } catch {}

      try {
        if (offer.offeredProducts && offer.offeredProducts !== "[]") {
          offeredProducts = JSON.parse(offer.offeredProducts);
        } else if (offer.products && offer.products !== "[]") {
          offeredProducts = JSON.parse(offer.products);
        }
      } catch {}

      // If no explicit target products, fallback to showing on the offered products themselves
      if (targetProducts.length === 0 && offeredProducts.length > 0) {
        targetProducts = offeredProducts;
      }

      const discountPercentage = Number(offer.percentage) || 0;

      // Enrich offered products with live variant IDs and prices
      const enrichedOfferedProducts = offeredProducts.map((p) => {
        const realProd = productInfoMap[p.id];
        const selectedVariantIds = Array.isArray(p.variants) && p.variants.length > 0
          ? new Set(p.variants.map((v) => String(typeof v === "object" ? v.id : v).split("/").pop()))
          : null;

        const allVariants = (realProd?.variants?.nodes || []).map((v) => ({
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

        const originalPrice = variants[0]?.price || fallbackPrice;
        const discountedPrice = Math.round(originalPrice * (1 - discountPercentage / 100));

        return {
          id: p.id,
          numericId: String(p.id).split("/").pop(),
          title: realProd?.title || p.title || "Add-on Product",
          handle: realProd?.handle || p.handle || "",
          image: realProd?.featuredImage?.url || p.image || "",
          price: originalPrice,
          discountedPrice,
          quantity: Number(p.quantity) || 1,
          variantId: variants[0]?.id || "",
          availableForSale: variants.length > 0 ? variants.some((v) => v.availableForSale) : true,
          variants,
        };
      });

      for (const targetProd of targetProducts) {
        const fullGid = String(targetProd.id);
        const numericId = fullGid.split("/").pop();

        const offerData = {
          offerId: offer.discountId,
          numericId: offer.numericId,
          title: offer.title,
          percentage: offer.percentage,
          targetProductId: fullGid,
          offeredProducts: enrichedOfferedProducts,
          startsAt: offer.startsAt,
          endsAt: offer.endsAt,
        };

        offersMap[numericId] = offerData;
        offersMap["id_" + numericId] = offerData;
        offersMap[fullGid] = offerData;
      }
    }

    const mutation = `#graphql
      mutation SetSelectedOffersShopMetafield($metafields: [MetafieldsSetInput!]!) {
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
            key: "selected_offers",
            type: "json",
            value: JSON.stringify(offersMap),
          },
        ],
      },
    });

    console.log(`[SelectedOffersMetafield] Synced active selected offers to shop.metafields.stack_up.selected_offers.`);
  } catch (err) {
    console.error("[SelectedOffersMetafield] Error syncing selected offers to shop metafield:", err);
  }
}
