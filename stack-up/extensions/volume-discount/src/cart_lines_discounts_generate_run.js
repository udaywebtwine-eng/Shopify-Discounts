import {
  ProductDiscountSelectionStrategy,
} from '../generated/api';

/**
 * ============================================================================
 * STACKUP VOLUME DISCOUNT / QUANTITY BREAKS ENGINE
 * ============================================================================
 * 
 * Evaluates tiered volume discounts at checkout based on the quantity of
 * products in the cart.
 * 
 * ULTRA-COMPACT TIER SCHEMA DICTIONARY:
 * ----------------------------------------------------------------------------
 * mq -> minQty:    Minimum quantity required to qualify for this tier (e.g. 2, 3, 5)
 * d  -> discount:  Discount value (e.g. 10 for 10% OFF, or fixed dollar amount)
 * t  -> type:      Discount type ("P" = Percentage %, "F" = Fixed Amount $) [Defaults to "P"]
 * b  -> badge:     Highlight badge text (e.g. "MOST POPULAR", "BEST VALUE", or "")
 * s  -> subtitle:  Optional subtitle/savings note (e.g. "Save $15", or "")
 * ----------------------------------------------------------------------------
 * 
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

/**
 * Extracts numeric ID from a Shopify GID or string ID.
 * @param {string|null|undefined} id
 * @returns {string}
 */
function getNumericId(id) {
  if (!id) return '';
  return String(id).split('/').pop().trim();
}

/**
 * Safe JSON parse helper.
 * @param {string|null|undefined} val
 * @returns {object|null}
 */
function parseJson(val) {
  if (!val) return null;
  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
}

/**
 * Main discount evaluation function for Quantity Breaks / Volume Discounts.
 * 
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  // 1. If cart has no lines, exit immediately
  if (!input.cart?.lines?.length) {
    return { operations: [] };
  }

  // 2. Check if app is enabled globally in merchant settings
  const appStatusMeta = input.shop?.appStatus?.value;
  if (appStatusMeta !== undefined && appStatusMeta !== null && String(appStatusMeta).toLowerCase() === 'false') {
    return { operations: [] };
  }

  // 3. Ignore legacy standalone discount nodes (only master discount evaluates)
  const nodeConfig = parseJson(input.discount?.metafield?.value);
  if (nodeConfig && !nodeConfig.isMaster) {
    return { operations: [] };
  }

  // 4. Parse shop-level volume offers fallback map (if present)
  const shopOffersMap = parseJson(input.shop?.offersMetafield?.value) || {};

  // 5. Aggregate cart lines by product ID
  // Map<productId, { lines: Array<line>, totalQuantity: number, productGid: string, volumeTiersMeta: string|null }>
  const productGroups = new Map();

  for (const line of input.cart.lines) {
    if (line.merchandise?.__typename === 'ProductVariant') {
      const prod = line.merchandise.product;
      if (!prod?.id) continue;

      const prodGid = String(prod.id).trim();
      const prodNumId = getNumericId(prodGid);
      const lineQty = Number(line.quantity) || 1;

      // Group by numeric ID for consistent matching
      if (!productGroups.has(prodNumId)) {
        productGroups.set(prodNumId, {
          productGid: prodGid,
          numericId: prodNumId,
          lines: [],
          totalQuantity: 0,
          volumeTiersMeta: prod.volumeTiers?.value || null,
        });
      }

      const group = productGroups.get(prodNumId);
      group.lines.push(line);
      group.totalQuantity += lineQty;
    }
  }

  if (productGroups.size === 0) {
    return { operations: [] };
  }

  const candidates = [];

  // 6. Evaluate volume tiers for each product in the cart
  for (const [prodNumId, group] of productGroups.entries()) {
    let tiers = [];
    let offerTitle = '';

    // Priority A: Product-level metafield (fast, compact, zero-redundancy)
    if (group.volumeTiersMeta) {
      const parsedProductTiers = parseJson(group.volumeTiersMeta);
      if (Array.isArray(parsedProductTiers)) {
        tiers = parsedProductTiers;
      } else if (parsedProductTiers && typeof parsedProductTiers === 'object') {
        tiers = parsedProductTiers.tiers || [];
        offerTitle = parsedProductTiers.title || '';
      }
    }

    // Priority B: Shop-level fallback map
    if ((!tiers || tiers.length === 0) && shopOffersMap) {
      const offer = shopOffersMap[prodNumId] || shopOffersMap[group.productGid];
      if (offer) {
        tiers = offer.tiers || [];
        offerTitle = offer.title || '';
      }
    }

    if (!Array.isArray(tiers) || tiers.length === 0) {
      continue;
    }

    // 7. Find the highest qualifying tier for this product
    // Supports both compact keys ({ mq, d, t, b, s }) and full keys ({ minQty, discount })
    const qualifyingTier = tiers
      .filter((tier) => {
        const requiredQty = Number(tier.mq ?? tier.minQty ?? tier.quantity ?? 0);
        return requiredQty > 0 && group.totalQuantity >= requiredQty;
      })
      .sort((a, b) => {
        const qtyA = Number(a.mq ?? a.minQty ?? a.quantity ?? 0);
        const qtyB = Number(b.mq ?? b.minQty ?? b.quantity ?? 0);
        return qtyB - qtyA; // Highest quantity tier first
      })[0];

    if (!qualifyingTier) {
      continue;
    }

    const discountVal = Number(qualifyingTier.d ?? qualifyingTier.discount ?? qualifyingTier.discountValue ?? 0);
    if (discountVal <= 0) {
      continue;
    }

    const discountType = String(qualifyingTier.t ?? qualifyingTier.type ?? 'P').toUpperCase();
    const tierMinQty = Number(qualifyingTier.mq ?? qualifyingTier.minQty ?? qualifyingTier.quantity ?? 0);
    const badgeText = qualifyingTier.b ?? qualifyingTier.badge ?? '';
    const subtitleText = qualifyingTier.s ?? qualifyingTier.subtitle ?? '';

    // Dynamic message for the checkout savings pill
    const message = offerTitle ||
      (subtitleText ? `${subtitleText}` : `Buy ${tierMinQty}+ (${discountVal}% OFF)`);

    const targets = group.lines.map((l) => ({
      cartLine: {
        id: l.id,
      },
    }));

    // Fixed amount off per item ($) vs Percentage off (%)
    if (discountType === 'F' || discountType === 'FIXED') {
      candidates.push({
        message,
        targets,
        value: {
          fixedAmount: {
            amount: discountVal,
            appliesToEachItem: true,
          },
        },
      });
    } else {
      // Default: Percentage discount
      candidates.push({
        message,
        targets,
        value: {
          percentage: {
            value: discountVal,
          },
        },
      });
    }
  }

  if (candidates.length === 0) {
    return { operations: [] };
  }

  // 8. Return discount candidate operations
  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
