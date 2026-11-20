import prisma from "../db.server.js";
import { computeOfferStatus } from "./timezone.js";

/**
 * ============================================================================
 * STACKUP CART GOAL - SHOP-LEVEL METAFELD ENGINE
 * ============================================================================
 * 
 * Synchronizes active Cart Goal campaigns into the shop metafield:
 *   `shop.metafields.stack_up.cart_goal_offers`
 * 
 * At checkout, Shopify Functions query this single shop metafield to
 * evaluate cart subtotals and apply Order Discounts, Free Delivery, and Free Gifts.
 * On the storefront, Liquid & theme JavaScript read this metafield to render the
 * animated progress bar inside the Cart Drawer and on the /cart page.
 */

/**
 * Safely parses the configuration JSON of a Cart Goal offer.
 * @param {object} offer
 * @returns {object}
 */
export function getCartGoalConfiguration(offer) {
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
 * Default widget settings for Cart Goal progress bar.
 * Stored in `shop.metafields.stack_up.cart_goal_widget_settings`.
 */
export const DEFAULT_CART_GOAL_WIDGET_SETTINGS = {
  content: {
    heading: "{widgettitle}",
    initialMessage: "Add {{remaining}} more to unlock {{next_tier}}!",
    progressMessage: "🎉 {{current_tier}} unlocked! Add {{remaining}} for {{next_tier}}!",
    completedMessage: "🎉 Congratulations! You unlocked maximum savings + Free Shipping!",
  },
  styles: {
    barColor: "#000000",
    trackColor: "#e5e7eb",
    achievedColor: "#10b981",
    cardSurface: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 12,
    borderWidth: 1,
    barHeight: 8,
    textColor: "#111827",
    milestoneTextColor: "#6b7280",
  },
  display: {
    showInCartDrawer: true,
    showOnCartPage: true,
    showMilestoneIcons: true,
    showCelebrationEmojis: true,
    customDrawerSelector: "",
  },
};

/**
 * Normalizes tiers into a consistent, validated schema.
 * @param {Array} rawTiers
 * @param {string} currencyCode
 * @returns {Array}
 */
export function normalizeCartGoalTiers(rawTiers = [], currencyCode = "") {
  if (!Array.isArray(rawTiers)) return [];
  return rawTiers
    .map((t, idx) => {
      const minAmount = Math.max(0, parseFloat(t.minAmount ?? t.minCartValue ?? 0) || 0);
      const discountType = String(t.discountType || "PERCENTAGE").toUpperCase() === "FIXED_AMOUNT" ? "FIXED_AMOUNT" : "PERCENTAGE";
      const hasDiscount = t.hasDiscount !== undefined ? Boolean(t.hasDiscount) : (parseFloat(t.discountValue ?? t.value ?? 0) > 0);
      const discountValue = hasDiscount ? Math.max(0, parseFloat(t.discountValue ?? t.value ?? 0) || 0) : 0;
      const hasFreeShipping = Boolean(t.hasFreeShipping ?? t.freeShipping ?? false);
      const maxCap = t.maxCap || t.maxDiscountAmount ? Math.max(0, parseFloat(t.maxCap || t.maxDiscountAmount) || 0) : null;
      
      let freeGift = null;
      if (t.freeGift && (t.freeGift.variantId || t.freeGift.id || t.freeGift.productId)) {
        freeGift = {
          productId: String(t.freeGift.productId || t.freeGift.id || ""),
          variantId: String(t.freeGift.variantId || ""),
          title: String(t.freeGift.title || "Free Gift"),
          image: String(t.freeGift.image || ""),
          price: parseFloat(t.freeGift.price || 0) || 0,
        };
      }

      const parts = [];
      if (hasDiscount && discountValue > 0) {
        if (discountType === "FIXED_AMOUNT") {
          parts.push(currencyCode ? `${discountValue} ${currencyCode} off` : `${discountValue} off`);
        } else {
          parts.push(`${discountValue}% off`);
        }
      }
      if (hasFreeShipping) {
        parts.push("Free Shipping");
      }
      if (freeGift) {
        parts.push(`Free ${freeGift.title || "Gift"}`);
      }
      const label = parts.length > 0 ? parts.join(" + ") : (t.label || `Tier ${idx + 1}`);

      return {
        minAmount,
        discountType,
        discountValue,
        hasDiscount,
        hasFreeShipping,
        freeGift,
        maxCap,
        label,
      };
    })
    .sort((a, b) => a.minAmount - b.minAmount);
}

/**
 * Synchronizes all active CART_GOAL offers to the shop metafield.
 * @param {object} admin - Authenticated Shopify GraphQL admin client
 * @returns {Promise<{success: boolean, activeOffersCount: number, error?: string}>}
 */
export async function syncAllActiveCartGoalOffersToShopMetafield(admin, shopDomain = null) {
  if (!admin) {
    console.warn("[CartGoalMetafields] Admin client required for synchronization");
    return { success: false, activeOffersCount: 0, error: "Admin client required" };
  }

  try {
    // 1. Fetch shop ID, timezone, base currency, and custom widget settings if any
    const shopRes = await admin.graphql(
      `#graphql
      query GetShopDetails {
        shop {
          id
          currencyCode
          ianaTimezone
          myshopifyDomain
          widgetSettings: metafield(namespace: "stack_up", key: "cart_goal_widget_settings") {
            value
          }
        }
      }`
    );
    const shopJson = await shopRes.json();
    const shopData = shopJson.data?.shop;
    const shopId = shopData?.id;
    const shopCurrency = shopData?.currencyCode || "";
    const shopDomainFromAdmin = shopData?.myshopifyDomain || "";
    const shopTimezone = shopData?.ianaTimezone || "UTC";

    if (!shopId) {
      throw new Error("Unable to retrieve shop ID from Shopify Admin API");
    }

    const rawWidgetSettings = shopData?.widgetSettings?.value;
    const canonicalShop = (shopDomain || shopDomainFromAdmin || "").trim();
    if (!canonicalShop) {
      console.warn("[CartGoalSync] No shop domain available, aborting metafield sync.");
      return { success: false, activeOffersCount: 0, error: "No shop domain" };
    }
    const cleanShop = canonicalShop.replace(".myshopify.com", "");
    const shopFilter = {
      OR: [
        { shop: canonicalShop },
        { shop: cleanShop },
        { shop: `${cleanShop}.myshopify.com` },
      ],
    };

    // 2. Query all CART_GOAL offers from PostgreSQL DB strictly for this authenticated shop
    const allOffers = await prisma.offer.findMany({
      where: {
        AND: [
          shopFilter,
          { type: "CART_GOAL" },
        ],
      },
      orderBy: { createdAt: "desc" },
    });

    // 3. Filter active offers based on timezone & schedule
    const activeOffersPayload = [];

    for (const offer of allOffers) {
      if (offer.status === "DEACTIVATED" || offer.status === "EXPIRED") continue;

      const realStatus = computeOfferStatus(offer, shopTimezone);
      // Ensure offers created for today sync to storefront even with minor clock drift
      const isLiveOrToday = realStatus === "ACTIVE" || (offer.status === "ACTIVE" && (!offer.startsAt || new Date(offer.startsAt).getTime() <= (Date.now() + 24 * 60 * 60 * 1000)));
      if (!isLiveOrToday) continue;

      const cfg = getCartGoalConfiguration(offer);
      const normalizedTiers = normalizeCartGoalTiers(cfg.tiers || [], shopCurrency);

      let collectionProductIds = [];
      if (cfg.applyTo === "COLLECTIONS" && Array.isArray(cfg.collections) && cfg.collections.length > 0) {
        try {
          for (const col of cfg.collections) {
            const colId = typeof col === "object" ? (col.id || "") : String(col);
            if (!colId) continue;
            const fullColGid = colId.startsWith("gid://") ? colId : `gid://shopify/Collection/${colId}`;
            const colRes = await admin.graphql(
              `#graphql
              query GetCollectionProductIds($id: ID!) {
                collection(id: $id) {
                  id
                  products(first: 250) {
                    nodes {
                      id
                    }
                  }
                }
              }`,
              { variables: { id: fullColGid } }
            );
            const colJson = await colRes.json();
            const nodes = colJson.data?.collection?.products?.nodes || [];
            for (const node of nodes) {
              const numId = String(node.id).split("/").pop();
              if (numId && !collectionProductIds.includes(numId)) {
                collectionProductIds.push(numId);
              }
            }
          }
        } catch (colErr) {
          console.warn("[CartGoalMetafields] Could not fetch collection product IDs:", colErr);
        }
      }

      let enrichedProducts = Array.isArray(cfg.products) ? cfg.products : [];
      if (cfg.applyTo === "PRODUCTS" && enrichedProducts.length > 0) {
        try {
          const productIds = enrichedProducts.map((p) => (typeof p === "object" ? p.id : String(p))).filter(Boolean);
          const fullGids = productIds.map((id) => (id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`));

          if (fullGids.length > 0) {
            const prodRes = await admin.graphql(
              `#graphql
              query GetCartGoalProductsInfo($ids: [ID!]!) {
                nodes(ids: $ids) {
                  ... on Product {
                    id
                    title
                    handle
                    featuredImage {
                      url
                    }
                    variants(first: 50) {
                      nodes {
                        id
                        title
                        price
                      }
                    }
                  }
                }
              }`,
              { variables: { ids: fullGids } }
            );
            const prodJson = await prodRes.json();
            const nodes = prodJson.data?.nodes || [];
            const prodMap = {};
            nodes.forEach((n) => {
              if (n && n.id) {
                prodMap[n.id] = n;
                const num = n.id.split("/").pop();
                if (num) prodMap[num] = n;
              }
            });

            enrichedProducts = enrichedProducts.map((p) => {
              const pId = typeof p === "object" ? p.id : String(p);
              const num = pId.split("/").pop();
              const details = prodMap[pId] || prodMap[num];
              if (!details) return typeof p === "object" ? p : { id: pId };

              const variants = (details.variants?.nodes || []).map((v) => ({
                id: v.id,
                title: v.title,
                price: parseFloat(v.price) || 0,
              }));

              return {
                id: details.id,
                title: details.title || (typeof p === "object" ? p.title : "") || "Product",
                handle: details.handle || (typeof p === "object" ? p.handle : "") || "",
                image: details.featuredImage?.url || (typeof p === "object" ? p.image : "") || "",
                variants: variants.length > 0 ? variants : (p.variants || []),
              };
            });
          }
        } catch (prodErr) {
          console.warn("[CartGoalMetafields] Could not enrich product info:", prodErr);
        }
      }

      activeOffersPayload.push({
        id: String(offer.numericId || offer.id),
        title: String(offer.title || "Cart Goal"),
        widgetTitle: String(cfg.widgetTitle || "").replace(/\{widgettitle\}/gi, offer.title || "Spend More, Save More"),
        status: "ACTIVE",
        applyTo: String(cfg.applyTo || "ALL"),
        collections: Array.isArray(cfg.collections) ? cfg.collections : [],
        collectionProductIds,
        products: enrichedProducts,
        excludedProductIds: Array.isArray(cfg.excludedProductIds) ? cfg.excludedProductIds : [],
        tiers: normalizedTiers,
      });
    }

    // 4. Save to Shop Metafields:
    // - cart_goal_offers: Pure offer logic and discount thresholds
    // - cart_goal_widget_settings: Visual styling, messages, and layout
    const metafieldsMutation = `#graphql
      mutation SetCartGoalMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const metafieldsToSet = [
      {
        ownerId: shopId,
        namespace: "stack_up",
        key: "cart_goal_offers",
        type: "json",
        value: JSON.stringify(activeOffersPayload),
      },
    ];

    if (!rawWidgetSettings) {
      metafieldsToSet.push({
        ownerId: shopId,
        namespace: "stack_up",
        key: "cart_goal_widget_settings",
        type: "json",
        value: JSON.stringify(DEFAULT_CART_GOAL_WIDGET_SETTINGS),
      });
    }

    const variables = {
      metafields: metafieldsToSet,
    };

    const setRes = await admin.graphql(metafieldsMutation, { variables });
    const setJson = await setRes.json();
    const userErrors = setJson.data?.metafieldsSet?.userErrors || [];

    if (userErrors.length > 0) {
      console.error("[CartGoalMetafields] Error saving shop metafield:", userErrors);
      throw new Error(userErrors.map((e) => e.message).join(", "));
    }

    console.log(`[CartGoalMetafields] Successfully synced ${activeOffersPayload.length} active Cart Goal offers to shop metafield.`);
    return { success: true, activeOffersCount: activeOffersPayload.length };
  } catch (err) {
    console.error("[CartGoalMetafields] Synchronization error:", err);
    return { success: false, activeOffersCount: 0, error: err.message };
  }
}
