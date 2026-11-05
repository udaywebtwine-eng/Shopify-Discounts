import {
  ProductDiscountSelectionStrategy,
} from '../generated/api';

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

/**
 * Extracts numeric ID from a Shopify GID or string ID.
 * @param {string} id
 * @returns {string}
 */
function getNumericId(id) {
  if (!id) return '';
  return String(id).split('/').pop().trim();
}

/**
 * Parses JSON configuration stored in a metafield.
 * @param {string|null} metafieldValue
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
 * Extracts active selected product offers from shop metafield (Master Engine)
 * or fallback discount node metafield (legacy).
 * @param {RunInput} input
 * @returns {Array<object>}
 */
function getOffersList(input) {
  // If this discount node is an old legacy node (not isMaster), ignore it completely
  const nodeConfig = parseJson(input.discount?.metafield?.value);
  if (nodeConfig && !nodeConfig.isMaster) {
    return [];
  }

  // Retrieve active offers from the master shop metafield
  const shopMetaValue = input.shop?.offersMetafield?.value;
  if (shopMetaValue) {
    const map = parseJson(shopMetaValue);
    if (map && typeof map === 'object') {
      const seen = new Set();
      const list = [];
      for (const key of Object.keys(map)) {
        const offer = map[key];
        if (!offer || typeof offer !== 'object') continue;
        const idKey = offer.numericId || offer.offerId || key;
        if (!seen.has(idKey)) {
          seen.add(idKey);
          list.push(offer);
        }
      }
      if (list.length > 0) return list;
    }
  }

  return [];
}

/**
 * Main discount evaluation function for Special Add-Ons / Selected Products.
 * 
 * Rules:
 * 1. Checks if the Target / Main Product is in the cart.
 * 2. Checks if any Recommended Add-On Product is in the cart with required minimum quantity.
 * 3. Applies the percentage discount specifically to the qualifying Add-On product lines (Target product remains at regular price).
 * 4. Displays the offer's custom title at checkout dynamically via candidate `message`.
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
  if (!input.cart.lines.length) {
    return { operations: [] };
  }

  // 3. Retrieve active offers
  const offers = getOffersList(input);
  if (offers.length === 0) {
    return { operations: [] };
  }

  // Pre-calculate cart product & variant quantities
  const cartProductQuantities = new Map();
  for (const line of input.cart.lines) {
    if (line.merchandise?.__typename === 'ProductVariant') {
      const prod = line.merchandise.product;
      if (prod?.id) {
        const fullId = String(prod.id).trim();
        const numId = getNumericId(fullId);
        const qty = line.quantity || 1;

        cartProductQuantities.set(fullId, (cartProductQuantities.get(fullId) || 0) + qty);
        cartProductQuantities.set(numId, (cartProductQuantities.get(numId) || 0) + qty);
      }
    }
  }

  const candidates = [];

  for (const offer of offers) {
    const percentage = Number(offer.percentage);
    if (isNaN(percentage) || percentage <= 0) continue;

    // 4. Map Target / Main products
    const targetProductIds = new Set();
    const rawTargets = Array.isArray(offer.targetProducts)
      ? offer.targetProducts
      : Array.isArray(offer.targetProductIds)
      ? offer.targetProductIds.map((id) => ({ id }))
      : offer.targetProductId
      ? [{ id: offer.targetProductId }]
      : [];

    rawTargets.forEach((p) => {
      if (p?.id) {
        const fullId = String(p.id).trim();
        targetProductIds.add(fullId);
        targetProductIds.add(getNumericId(fullId));
      }
    });

    // Target product must be present in cart (if target products were configured)
    let foundTargetInCart = targetProductIds.size === 0;
    for (const targetId of targetProductIds) {
      if ((cartProductQuantities.get(targetId) || 0) > 0) {
        foundTargetInCart = true;
        break;
      }
    }
    if (!foundTargetInCart) continue;

    // 5. Map Recommended / Offered Add-On products & their required minimum quantities
    const offeredQuantities = new Map();
    const offeredProductIds = new Set();
    const offeredVariantIds = new Set();
    let hasSpecificOfferedVariants = false;

    const rawOffered = Array.isArray(offer.offeredProducts)
      ? offer.offeredProducts
      : Array.isArray(offer.products)
      ? offer.products
      : [];

    rawOffered.forEach((item) => {
      if (item?.id) {
        const fullId = String(item.id).trim();
        const numId = getNumericId(fullId);
        const reqQty = Math.max(1, parseInt(item.quantity, 10) || 1);
        offeredQuantities.set(fullId, reqQty);
        offeredQuantities.set(numId, reqQty);
        offeredProductIds.add(fullId);
        offeredProductIds.add(numId);

        if (Array.isArray(item.variants) && item.variants.length > 0) {
          hasSpecificOfferedVariants = true;
          item.variants.forEach((v) => {
            const vId = String(typeof v === 'object' ? v.id : v).trim();
            offeredVariantIds.add(vId);
            offeredVariantIds.add(getNumericId(vId));
          });
        }
      }
    });

    if (offeredProductIds.size === 0) continue;

    // 6. Partition cart lines: Qualifying Add-Ons get discount
    const qualifyingLineIds = [];

    for (const line of input.cart.lines) {
      if (line.merchandise?.__typename === 'ProductVariant') {
        const prod = line.merchandise.product;
        const variantId = line.merchandise.id ? String(line.merchandise.id).trim() : null;
        const variantNumId = variantId ? getNumericId(variantId) : null;

        if (prod?.id) {
          const fullId = String(prod.id).trim();
          const numId = getNumericId(fullId);

          if (offeredProductIds.has(fullId) || offeredProductIds.has(numId)) {
            const variantMatches = !hasSpecificOfferedVariants ||
              (variantId && (offeredVariantIds.has(variantId) || offeredVariantIds.has(variantNumId)));

            if (variantMatches) {
              const reqQty = offeredQuantities.get(fullId) || offeredQuantities.get(numId) || 1;
              const totalInCart = cartProductQuantities.get(fullId) || cartProductQuantities.get(numId) || 0;

              if (totalInCart >= reqQty) {
                qualifyingLineIds.push(line.id);
              }
            }
          }
        }
      }
    }

    if (qualifyingLineIds.length > 0) {
      candidates.push({
        message: offer.title || `${percentage}% OFF`,
        targets: qualifyingLineIds.map((lineId) => ({
          cartLine: {
            id: lineId,
          },
        })),
        value: {
          percentage: {
            value: percentage,
          },
        },
      });
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
