import {
  OrderDiscountSelectionStrategy,
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
 * Parses a product's suggested_products metafield value into an array of product GIDs.
 * @param {string|null} metafieldValue
 * @returns {Array<string>}
 */
function parseSuggestedProductIds(metafieldValue) {
  if (!metafieldValue) return [];
  try {
    const parsed = JSON.parse(metafieldValue);
    if (Array.isArray(parsed)) {
      return parsed.map((id) => String(id).trim());
    }
  } catch {
    return String(metafieldValue)
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Extracts active paired product offers from shop metafield (Master Engine)
 * or fallback discount node metafield (legacy).
 * @param {RunInput} input
 * @returns {Array<object>}
 */
function getOffersList(input) {
  // 1. Try shop-level metafield (Master Engine Architecture)
  const shopMetaValue = input.shop?.offersMetafield?.value;
  if (shopMetaValue) {
    const map = parseJson(shopMetaValue);
    if (map && typeof map === 'object') {
      const seen = new Set();
      const list = [];
      for (const key of Object.keys(map)) {
        const offer = map[key];
        if (!offer || typeof offer !== 'object') continue;
        const idKey = offer.numericId || offer.offerId || offer.title || key;
        if (!seen.has(idKey)) {
          seen.add(idKey);
          list.push(offer);
        }
      }
      if (list.length > 0) return list;
    }
  }

  // 2. Fallback to discount node metafield (legacy)
  const legacyConfig = parseJson(input.discount?.metafield?.value);
  if (legacyConfig && !legacyConfig.isMaster) {
    return [legacyConfig];
  }

  return [];
}

/**
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  // 1. Check if StackUp is enabled in the shop metafield
  if (input.shop?.appStatus?.value === 'false') {
    return { operations: [] };
  }

  if (!input.cart.lines.length) {
    return { operations: [] };
  }

  // 2. Retrieve active paired offers
  const offers = getOffersList(input);
  if (offers.length === 0) {
    return { operations: [] };
  }

  // Scan products currently in the customer's cart and accumulate quantities
  const cartProductIds = new Set();
  const cartProductQuantities = new Map();
  const cartLinesByProduct = [];

  for (const line of input.cart.lines) {
    if (line.merchandise?.__typename === 'ProductVariant') {
      const product = line.merchandise.product;
      if (product?.id) {
        const fullId = String(product.id).trim();
        const numId = getNumericId(fullId);
        cartProductIds.add(fullId);
        cartProductIds.add(numId);
        const currentQty = cartProductQuantities.get(fullId) || cartProductQuantities.get(numId) || 0;
        const newQty = currentQty + (line.quantity || 1);
        cartProductQuantities.set(fullId, newQty);
        cartProductQuantities.set(numId, newQty);
        cartLinesByProduct.push({
          lineId: line.id,
          productId: fullId,
          numericId: numId,
          suggestedMetafieldIds: parseSuggestedProductIds(product.suggestedProducts?.value),
        });
      }
    }
  }

  const candidates = [];

  for (const offer of offers) {
    const percentage = Number(offer.percentage);
    if (isNaN(percentage) || percentage <= 0) continue;

    // Build main products set & requirements
    const mainProductIds = new Set();
    const mainProductQuantities = {};
    const mainVariantIds = new Set();
    let hasSpecificMainVariants = false;

    const rawMains = Array.isArray(offer.mainProducts)
      ? offer.mainProducts
      : Array.isArray(offer.mainProductIds)
      ? offer.mainProductIds.map((id) => ({ id }))
      : [];

    rawMains.forEach((item) => {
      if (item?.id) {
        const fullId = String(item.id).trim();
        const numId = getNumericId(fullId);
        const qty = Number(item.quantity) || 1;
        mainProductIds.add(fullId);
        mainProductIds.add(numId);
        mainProductQuantities[fullId] = qty;
        mainProductQuantities[numId] = qty;

        if (Array.isArray(item.variants) && item.variants.length > 0) {
          hasSpecificMainVariants = true;
          item.variants.forEach((v) => {
            const vId = String(typeof v === 'object' ? v.id : v).trim();
            mainVariantIds.add(vId);
            mainVariantIds.add(getNumericId(vId));
          });
        }
      }
    });

    // Build sub products set & requirements
    const subProductIds = new Set();
    const subProductQuantities = {};
    const subVariantIds = new Set();
    let hasSpecificSubVariants = false;

    const rawSubs = Array.isArray(offer.subProducts)
      ? offer.subProducts
      : Array.isArray(offer.subProductIds)
      ? offer.subProductIds.map((id) => ({ id }))
      : [];

    rawSubs.forEach((item) => {
      if (item?.id) {
        const fullId = String(item.id).trim();
        const numId = getNumericId(fullId);
        const qty = Number(item.quantity) || 1;
        subProductIds.add(fullId);
        subProductIds.add(numId);
        subProductQuantities[fullId] = qty;
        subProductQuantities[numId] = qty;

        if (Array.isArray(item.variants) && item.variants.length > 0) {
          hasSpecificSubVariants = true;
          item.variants.forEach((v) => {
            const vId = String(typeof v === 'object' ? v.id : v).trim();
            subVariantIds.add(vId);
            subVariantIds.add(getNumericId(vId));
          });
        }
      }
    });

    // Check if Main Product is in cart with required quantity
    const hasMainProduct = Array.from(mainProductIds).some((id) => {
      const requiredQty = mainProductQuantities[id] || 1;
      const inCartQty = cartProductQuantities.get(id) || 0;
      return inCartQty >= requiredQty;
    });

    // Check if Sub Product is in cart with required quantity
    let hasSubProduct = Array.from(subProductIds).some((id) => {
      const requiredQty = subProductQuantities[id] || 1;
      const inCartQty = cartProductQuantities.get(id) || 0;
      return inCartQty >= requiredQty;
    });

    // Fallback: If no explicit sub products chosen, check product's suggested_products metafield
    if (!hasSubProduct && subProductIds.size === 0) {
      for (const item of cartLinesByProduct) {
        if (mainProductIds.has(item.productId) || mainProductIds.has(item.numericId)) {
          if (item.suggestedMetafieldIds.some((id) => cartProductIds.has(id) || cartProductIds.has(getNumericId(id)))) {
            hasSubProduct = true;
            break;
          }
        }
      }
    }

    // Both Main and Sub products must be in cart to qualify
    if (!hasMainProduct || !hasSubProduct) continue;

    // Identify Paired lines and Non-Paired lines (excluded from order discount)
    const excludedCartLineIds = [];
    for (const line of input.cart.lines) {
      const isVariant = line.merchandise?.__typename === 'ProductVariant';
      const productId = isVariant ? line.merchandise.product?.id : null;
      const variantId = isVariant && line.merchandise.id ? String(line.merchandise.id).trim() : null;
      const variantNumId = variantId ? getNumericId(variantId) : null;
      const numId = getNumericId(productId);

      const matchesMainVariant = !hasSpecificMainVariants ||
        (variantId && (mainVariantIds.has(variantId) || mainVariantIds.has(variantNumId)));
      const isMain = productId && (mainProductIds.has(productId) || mainProductIds.has(numId)) && matchesMainVariant;

      const matchesSubVariant = !hasSpecificSubVariants ||
        (variantId && (subVariantIds.has(variantId) || subVariantIds.has(variantNumId)));
      let isSub = productId && (subProductIds.has(productId) || subProductIds.has(numId)) && matchesSubVariant;

      if (!isSub && subProductIds.size === 0 && productId) {
        for (const item of cartLinesByProduct) {
          if ((mainProductIds.has(item.productId) || mainProductIds.has(item.numericId)) &&
              (item.suggestedMetafieldIds.includes(productId) || item.suggestedMetafieldIds.includes(numId))) {
            isSub = true;
            break;
          }
        }
      }

      if (!isMain && !isSub) {
        excludedCartLineIds.push(line.id);
      }
    }

    candidates.push({
      message: offer.title || `${percentage}% OFF PAIRED OFFER`,
      targets: [
        {
          orderSubtotal: {
            excludedCartLineIds,
          },
        },
      ],
      value: {
        percentage: {
          value: percentage,
        },
      },
    });
  }

  if (candidates.length === 0) {
    return { operations: [] };
  }

  return {
    operations: [
      {
        orderDiscountsAdd: {
          candidates,
          selectionStrategy: OrderDiscountSelectionStrategy.First,
        },
      },
    ],
  };
}
