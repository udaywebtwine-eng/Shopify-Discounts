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
 * Parses JSON configuration stored in the discount metafield.
 * @param {string|null} metafieldValue
 * @returns {object|null}
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
 * Main discount evaluation function for Special Add-Ons / Selected Products.
 * 
 * Rules:
 * 1. Checks if the Target / Main Product is in the cart.
 * 2. Checks if any Recommended Add-On Product is in the cart with required minimum quantity.
 * 3. Applies the percentage discount specifically to the qualifying Add-On product lines (Target product remains at regular price).
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

  // 3. Read configuration from discount node metafield
  const config = parseConfiguration(input.discount?.metafield?.value);
  if (!config) {
    return { operations: [] };
  }

  const percentage = Number(config.percentage);
  if (isNaN(percentage) || percentage <= 0) {
    return { operations: [] };
  }

  // 4. Map Target / Main products (product pages where add-on offer is triggered)
  const targetProductIds = new Set();
  const rawTargets = Array.isArray(config.targetProducts)
    ? config.targetProducts
    : Array.isArray(config.targetProductIds)
    ? config.targetProductIds.map((id) => ({ id }))
    : [];

  rawTargets.forEach((p) => {
    if (p?.id) {
      const fullId = String(p.id).trim();
      targetProductIds.add(fullId);
      targetProductIds.add(getNumericId(fullId));
    }
  });

  // 5. Map Recommended / Offered Add-On products & their required minimum quantities
  const offeredQuantities = new Map();
  const offeredProductIds = new Set();
  const rawOffered = Array.isArray(config.offeredProducts)
    ? config.offeredProducts
    : Array.isArray(config.products)
    ? config.products
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
    }
  });

  if (offeredProductIds.size === 0) {
    return { operations: [] };
  }

  // 6. Scan cart lines and accumulate quantities per product
  const cartProductQuantities = new Map();
  const cartHasTargetProduct = targetProductIds.size === 0; // If no targets configured, treat as open offer
  let foundTargetInCart = cartHasTargetProduct;

  for (const line of input.cart.lines) {
    if (line.merchandise?.__typename === 'ProductVariant') {
      const prod = line.merchandise.product;
      if (prod?.id) {
        const fullId = String(prod.id).trim();
        const numId = getNumericId(fullId);
        const qty = line.quantity || 1;

        cartProductQuantities.set(fullId, (cartProductQuantities.get(fullId) || 0) + qty);
        cartProductQuantities.set(numId, (cartProductQuantities.get(numId) || 0) + qty);

        if (targetProductIds.has(fullId) || targetProductIds.has(numId)) {
          foundTargetInCart = true;
        }
      }
    }
  }

  // Target product must be present in cart to unlock the special add-on discount
  if (!foundTargetInCart) {
    return { operations: [] };
  }

  // 7. Partition cart lines: Qualifying Add-Ons get discount; all other lines are excluded
  const qualifyingLineIds = [];

  for (const line of input.cart.lines) {
    let qualifies = false;

    if (line.merchandise?.__typename === 'ProductVariant') {
      const prod = line.merchandise.product;
      if (prod?.id) {
        const fullId = String(prod.id).trim();
        const numId = getNumericId(fullId);

        // Check if this line is one of the recommended add-on products
        if (offeredProductIds.has(fullId) || offeredProductIds.has(numId)) {
          const reqQty = offeredQuantities.get(fullId) || offeredQuantities.get(numId) || 1;
          const totalInCart = cartProductQuantities.get(fullId) || cartProductQuantities.get(numId) || 0;

          if (totalInCart >= reqQty) {
            qualifies = true;
          }
        }
      }
    }

    if (qualifies) {
      qualifyingLineIds.push(line.id);
    }
  }

  // If no add-on products qualified, apply no discount
  if (qualifyingLineIds.length === 0) {
    return { operations: [] };
  }

  // 8. Return product discount operation applying percentage directly to qualifying add-on lines
  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates: [
            {
              message: config.title || `${percentage}% OFF`,
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
            },
          ],
          selectionStrategy: ProductDiscountSelectionStrategy.First,
        },
      },
    ],
  };
}