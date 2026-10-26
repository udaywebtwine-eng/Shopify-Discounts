import {
  DiscountClass,
  OrderDiscountSelectionStrategy,
} from '../generated/api';

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

/**
 * Parses the function configuration stored in the discount's metafield.
 */
function parseConfiguration(metafieldValue) {
  if (!metafieldValue) return null;
  try {
    return JSON.parse(metafieldValue);
  } catch {
    return null;
  }
}

/**
 * Parses a product's suggested_products metafield value into an array of product GIDs.
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
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  if (!input.cart.lines.length) {
    return { operations: [] };
  }

  // 1. Read configuration from discount metafield
  const config = parseConfiguration(input.discount?.metafield?.value);
  if (!config) {
    return { operations: [] };
  }

  const percentage = Number(config.percentage);
  if (isNaN(percentage) || percentage <= 0) {
    return { operations: [] };
  }

  const mainProductIds = new Set(config.mainProductIds || []);
  const subProductIds = new Set(config.subProductIds || []);

  // Map configured quantities per product
  const mainProductQuantities = {};
  if (Array.isArray(config.mainProducts)) {
    for (const item of config.mainProducts) {
      if (item?.id) {
        mainProductQuantities[item.id] = Number(item.quantity) || 1;
      }
    }
  }

  const subProductQuantities = {};
  if (Array.isArray(config.subProducts)) {
    for (const item of config.subProducts) {
      if (item?.id) {
        subProductQuantities[item.id] = Number(item.quantity) || 1;
      }
    }
  }

  // 2. Scan products currently in the customer's cart and accumulate quantities
  const cartProductIds = new Set();
  const cartProductQuantities = new Map();
  const cartLinesByProduct = [];

  for (const line of input.cart.lines) {
    if (line.merchandise?.__typename === 'ProductVariant') {
      const product = line.merchandise.product;
      if (product?.id) {
        cartProductIds.add(product.id);
        const currentQty = cartProductQuantities.get(product.id) || 0;
        cartProductQuantities.set(product.id, currentQty + (line.quantity || 1));
        cartLinesByProduct.push({
          lineId: line.id,
          productId: product.id,
          suggestedMetafieldIds: parseSuggestedProductIds(product.suggestedProducts?.value),
        });
      }
    }
  }

  // 3. Check if Main Product is in cart with required quantity
  const hasMainProduct = Array.from(mainProductIds).some((id) => {
    const requiredQty = mainProductQuantities[id] || 1;
    const inCartQty = cartProductQuantities.get(id) || 0;
    return inCartQty >= requiredQty;
  });

  // 4. Check if Sub Product is in cart with required quantity
  let hasSubProduct = Array.from(subProductIds).some((id) => {
    const requiredQty = subProductQuantities[id] || 1;
    const inCartQty = cartProductQuantities.get(id) || 0;
    return inCartQty >= requiredQty;
  });

  // Fallback: If no explicit sub products chosen, check product's suggested_products metafield
  if (!hasSubProduct && subProductIds.size === 0) {
    for (const item of cartLinesByProduct) {
      if (mainProductIds.has(item.productId)) {
        if (item.suggestedMetafieldIds.some((id) => cartProductIds.has(id))) {
          hasSubProduct = true;
          break;
        }
      }
    }
  }

  // 5. Evaluate pair condition: both Main and Sub products must be in cart
  if (!hasMainProduct || !hasSubProduct) {
    return { operations: [] };
  }

  // 6. Identify Paired lines and Non-Paired lines
  // Non-paired lines are excluded from the order subtotal discount calculation
  const excludedCartLineIds = [];
  const pairedCartLineIds = [];

  for (const line of input.cart.lines) {
    const productId = line.merchandise?.__typename === 'ProductVariant' ? line.merchandise.product?.id : null;
    const isMain = productId && mainProductIds.has(productId);
    let isSub = productId && subProductIds.has(productId);

    if (!isSub && subProductIds.size === 0 && productId) {
      for (const item of cartLinesByProduct) {
        if (mainProductIds.has(item.productId) && item.suggestedMetafieldIds.includes(productId)) {
          isSub = true;
          break;
        }
      }
    }

    if (isMain || isSub) {
      pairedCartLineIds.push(line.id);
    } else {
      excludedCartLineIds.push(line.id);
    }
  }

  // 7. Return Order Subtotal Percentage Discount excluding non-paired items
  return {
    operations: [
      {
        orderDiscountsAdd: {
          candidates: [
            {
              message: config.title || `${percentage}% OFF PAIRED OFFER`,
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
            },
          ],
          selectionStrategy: OrderDiscountSelectionStrategy.First,
        },
      },
    ],
  };
}