import {
  ProductDiscountSelectionStrategy,
} from '../generated/api';

/**
 * ============================================================================
 * STACKUP SELECTED PRODUCTS / SPECIAL ADD-ONS ENGINE (SHARDED ARCHITECTURE)
 * ============================================================================
 * 
 * Evaluates companion add-on discounts at checkout:
 * - When the Target / Main Product is in the cart,
 * - Any qualifying Recommended Add-On items in the cart receive the discount.
 * 
 * SCHEMA DICTIONARY (Reused across StackUp):
 * ----------------------------------------------------------------------------
 * id    -> Unique offer numeric ID
 * t     -> Offer Title (shown on checkout discount pill)
 * wt    -> Storefront Widget Title
 * d     -> Discount percentage value (e.g. 15 for 15% OFF)
 * items -> List of companion add-on items:
 *          - id: Product ID
 *          - vid: Default Variant ID
 *          - vids: Array of specific allowed variant IDs (optional)
 *          - t: Product title
 *          - p: Price in cents
 *          - dp: Discounted price in cents
 *          - q: Required quantity (default 1)
 *          - df: true if default checked
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
 * Parses JSON configuration stored in a metafield.
 * @param {string|null|undefined} metafieldValue
 * @returns {object|null}
 */
function parseJson(metafieldValue) {
  if (!metafieldValue) return null;
  try {
    return JSON.parse(metafieldValue);
  } catch {
    return null;
  }
}

/**
 * Extracts active selected product offers from shop metafield (Legacy fallback).
 * @param {RunInput} input
 * @returns {Array<object>}
 */
function getLegacyShopOffersList(input) {
  const shopMetaValue = input.shop?.offersMetafield?.value;
  if (!shopMetaValue) return [];

  const map = parseJson(shopMetaValue);
  if (!map || typeof map !== 'object') return [];

  const seen = new Set();
  const list = [];
  for (const key of Object.keys(map)) {
    const offer = map[key];
    if (!offer || typeof offer !== 'object') continue;
    const idKey = offer.id || offer.numericId || offer.offerId || key;
    if (!seen.has(idKey)) {
      seen.add(idKey);
      list.push(offer);
    }
  }
  return list;
}

/**
 * Main discount evaluation function for Special Add-Ons / Selected Products.
 * 
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  // 1. Guard: Check if StackUp app is explicitly disabled in the theme embed
  if (input.shop?.appStatus?.value === 'false') {
    return { operations: [] };
  }

  // 2. Guard: Cart must have items
  if (!input.cart?.lines?.length) {
    return { operations: [] };
  }

  // 3. Pre-index cart lines by product ID and variant ID
  const cartLinesByProduct = new Map(); // Map<prodNumId, Array<entry>>
  const cartProductQuantities = new Map(); // Map<prodNumId, totalQty>

  for (const line of input.cart.lines) {
    if (line.merchandise?.__typename === 'ProductVariant') {
      const prod = line.merchandise.product;
      const variantId = line.merchandise.id ? String(line.merchandise.id).trim() : '';
      if (!prod?.id) continue;

      const fullProdId = String(prod.id).trim();
      const numProdId = getNumericId(fullProdId);
      const numVarId = variantId ? getNumericId(variantId) : '';
      const qty = Number(line.quantity) || 1;

      // Track total quantities
      cartProductQuantities.set(numProdId, (cartProductQuantities.get(numProdId) || 0) + qty);
      cartProductQuantities.set(fullProdId, (cartProductQuantities.get(fullProdId) || 0) + qty);

      if (!cartLinesByProduct.has(numProdId)) {
        cartLinesByProduct.set(numProdId, []);
      }
      cartLinesByProduct.get(numProdId).push({
        line,
        qty,
        variantId,
        numVarId,
        product: prod,
      });
    }
  }

  const candidates = [];
  const processedOfferIds = new Set();

  // 4. Priority A: Evaluate Product-level sharded metafields on Target Products in cart
  for (const line of input.cart.lines) {
    if (line.merchandise?.__typename === 'ProductVariant') {
      const prod = line.merchandise.product;
      const metaVal = prod?.selectedOffers?.value;
      if (!metaVal) continue;

      const offer = parseJson(metaVal);
      if (!offer || typeof offer !== 'object') continue;

      const offerId = String(offer.id || offer.numericId || offer.offerId || '');
      if (offerId && processedOfferIds.has(offerId)) {
        continue;
      }

      const discountPercentage = Number(offer.d ?? offer.percentage ?? 0);
      if (discountPercentage <= 0) continue;

      const items = offer.items || offer.offeredProducts || [];
      if (!Array.isArray(items) || items.length === 0) continue;

      const qualifyingLineIds = [];

      for (const item of items) {
        if (!item?.id) continue;

        const itemNumId = getNumericId(item.id || item.numericId);
        const reqQty = Math.max(1, parseInt(item.q ?? item.quantity ?? 1, 10) || 1);
        const totalAddonInCart = cartProductQuantities.get(itemNumId) || 0;

        if (totalAddonInCart >= reqQty) {
          const addonLines = cartLinesByProduct.get(itemNumId) || [];
          const specificVarIds = Array.isArray(item.vids) && item.vids.length > 0
            ? new Set(item.vids.map((v) => getNumericId(v)))
            : null;

          for (const entry of addonLines) {
            // Target product is sold at regular price; only companion add-on lines qualify
            if (entry.line.id === line.id) continue;

            const matchesVariant = !specificVarIds || specificVarIds.size === 0 || specificVarIds.has(entry.numVarId);
            if (matchesVariant) {
              qualifyingLineIds.push(entry.line.id);
            }
          }
        }
      }

      if (qualifyingLineIds.length > 0) {
        if (offerId) processedOfferIds.add(offerId);
        candidates.push({
          message: offer.t || offer.title || `${discountPercentage}% OFF Add-on`,
          targets: qualifyingLineIds.map((id) => ({
            cartLine: { id },
          })),
          value: {
            percentage: {
              value: discountPercentage,
            },
          },
        });
      }
    }
  }

  // 5. Priority B: Fallback to Shop-level legacy map (if no product candidates found)
  if (candidates.length === 0) {
    const legacyOffers = getLegacyShopOffersList(input);
    for (const offer of legacyOffers) {
      const percentage = Number(offer.percentage || offer.d || 0);
      if (percentage <= 0) continue;

      const targetProductIds = new Set();
      const rawTargets = Array.isArray(offer.targetProducts)
        ? offer.targetProducts
        : offer.targetProductId
        ? [{ id: offer.targetProductId }]
        : [];

      rawTargets.forEach((p) => {
        if (p?.id) {
          targetProductIds.add(getNumericId(p.id));
        }
      });

      let foundTargetInCart = targetProductIds.size === 0;
      for (const targetId of targetProductIds) {
        if ((cartProductQuantities.get(targetId) || 0) > 0) {
          foundTargetInCart = true;
          break;
        }
      }
      if (!foundTargetInCart) continue;

      const rawOffered = Array.isArray(offer.offeredProducts)
        ? offer.offeredProducts
        : Array.isArray(offer.products)
        ? offer.products
        : Array.isArray(offer.items)
        ? offer.items
        : [];

      const qualifyingLineIds = [];

      for (const item of rawOffered) {
        if (!item?.id) continue;
        const itemNumId = getNumericId(item.id);
        const reqQty = Math.max(1, parseInt(item.quantity ?? item.q ?? 1, 10) || 1);
        const totalInCart = cartProductQuantities.get(itemNumId) || 0;

        if (totalInCart >= reqQty) {
          const addonLines = cartLinesByProduct.get(itemNumId) || [];
          for (const entry of addonLines) {
            qualifyingLineIds.push(entry.line.id);
          }
        }
      }

      if (qualifyingLineIds.length > 0) {
        candidates.push({
          message: offer.title || offer.t || `${percentage}% OFF`,
          targets: qualifyingLineIds.map((id) => ({
            cartLine: { id },
          })),
          value: {
            percentage: {
              value: percentage,
            },
          },
        });
      }
    }
  }

  if (candidates.length === 0) {
    return { operations: [] };
  }

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
