import prisma from "../db.server.js";
import { computeOfferStatus } from "./timezone.js";

/**
 * ============================================================================
 * STACKUP VOLUME OFFERS METAFIELD SYNC
 * ============================================================================
 * 
 * Synchronizes active Quantity Breaks / Volume Discount offers from PostgreSQL
 * to the single Shop Metafield:
 *   `shop.metafields.stack_up.volume_offers`
 * 
 * Storing under shop.metafields.stack_up.volume_offers does NOT require write_products scope,
 * and allows Liquid to look up any product's volume offer in 0ms!
 * Exactly matches how paired_offers and selected_offers are managed.
 * 
 * ULTRA-COMPACT TIER SCHEMA DICTIONARY:
 * ----------------------------------------------------------------------------
 * mq -> minQty:    Minimum quantity required for tier (e.g. 2, 3, 5)
 * d  -> discount:  Discount value (e.g. 10 for 10% OFF, or fixed dollar amount)
 * t  -> type:      Discount type ("P" = Percentage %, "F" = Fixed Amount $) [Default: "P"]
 * b  -> badge:     Highlight badge text (e.g. "MOST POPULAR", "BEST VALUE", or "")
 * s  -> subtitle:  Optional savings subtitle (e.g. "Save $15", or "")
 * ----------------------------------------------------------------------------
 */

/**
 * Normalizes any tier object to our ultra-compact schema.
 * @param {object} tier
 * @param {number} idx
 * @returns {object}
 */
export function normalizeTierToCompact(tier, idx = 0) {
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
  const isDefault = Boolean(tier.isDefault ?? (idx === 0));

  return {
    mq: minQty,
    quantity: minQty,
    d: discount,
    value: discount,
    t: t,
    discountType: t === "N" ? "none" : (t === "F" ? "fixed" : "percent"),
    b: badge,
    badge: badge,
    s: label,
    label: label,
    title: title,
    isDefault: isDefault,
  };
}

/**
 * Syncs all active volume discount offers to Shopify Shop Metafield.
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

    // 1. Fetch all Volume offers from DB that are not manually deactivated (EXPIRED)
    const allOffers = await prisma.offer.findMany({
      where: { type: "VOLUME", status: { not: "EXPIRED" } },
    });
    const activeOffers = allOffers.filter((o) => computeOfferStatus(o) === "ACTIVE");

    // 2. Background sync of DB status if schedule changed
    for (const o of allOffers) {
      const realStatus = computeOfferStatus(o);
      if (realStatus !== o.status && o.status !== "EXPIRED") {
        prisma.offer.update({ where: { id: o.id }, data: { status: realStatus } }).catch(() => {});
      }
    }

    const offersMap = {};

    // 3. Process active volume offers
    for (const offer of activeOffers) {
      let products = [];
      try {
        if (offer.volumeProducts) {
          products = JSON.parse(offer.volumeProducts);
        } else if (offer.configuration) {
          const cfg = JSON.parse(offer.configuration);
          products = cfg.volumeProducts || [];
        }
      } catch {
        products = [];
      }

      let rawTiers = [];
      try {
        if (offer.volumeTiers) {
          rawTiers = JSON.parse(offer.volumeTiers);
        } else if (offer.configuration) {
          const cfg = JSON.parse(offer.configuration);
          rawTiers = cfg.volumeTiers || [];
        }
      } catch {
        rawTiers = [];
      }

      // Convert tiers to ultra-compact dictionary format
      const compactTiers = rawTiers
        .map((t, i) => normalizeTierToCompact(t, i))
        .filter((t) => t.mq > 0)
        .sort((a, b) => a.mq - b.mq); // Lowest quantity first for storefront display

      if (compactTiers.length === 0) continue;

      const offerPayload = {
        offerId: offer.discountId,
        numericId: offer.numericId,
        title: offer.title,
        widgetTitle: offer.widgetTitle || "Buy More, Save More",
        percentage: offer.percentage,
        products,
        tiers: compactTiers,
      };

      for (const prod of products) {
        const fullGid = String(prod.id).trim();
        const numericId = fullGid.split("/").pop();

        // Add to shop-level map (same indexing as paired_offers & selected_offers)
        offersMap[numericId] = offerPayload;
        offersMap["id_" + numericId] = offerPayload;
        offersMap[fullGid] = offerPayload;
      }
    }

    // 4. Update Shop Metafield (`shop.metafields.stack_up.volume_offers`)
    const mutation = `#graphql
      mutation SetVolumeOffersShopMetafield($metafields: [MetafieldsSetInput!]!) {
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
            key: "volume_offers",
            type: "json",
            value: JSON.stringify(offersMap),
          },
        ],
      },
    });

    console.log(`[VolumeMetafields] Synced ${activeOffers.length} active volume offers to shop.metafields.stack_up.volume_offers.`);
  } catch (err) {
    console.error("[VolumeMetafields] Error syncing volume offers to shop metafield:", err);
  }
}

/**
 * Kept for interface compatibility; unbinding is automatic upon syncing shop metafield.
 */
export async function removeVolumeMetafieldFromProducts() {}
