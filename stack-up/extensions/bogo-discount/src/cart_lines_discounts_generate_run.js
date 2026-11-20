import {
  ProductDiscountSelectionStrategy,
} from '../generated/api';

/**
 * ============================================================================
 * STACKUP AUTOMATIC BOGO & BUY X GET Y ENGINE
 * ============================================================================
 * 
 * Evaluates promotional line-item discounts at checkout for 3 deal types:
 * 1. BOGO (Buy 1 Get 1 Free - Same Product)
 * 2. BUY_X_GET_X (Buy X, Get X at discount/free - Same Product)
 * 3. BUY_X_GET_Y (Buy X, Get Y at discount/free - Different Product)
 * 
 * ULTRA-COMPACT METAFELD SCHEMA:
 * ----------------------------------------------------------------------------
 * id       -> offer ID
 * t        -> offer title (displayed in savings pill)
 * dealType -> "BOGO" | "BUY_X_GET_X" | "BUY_X_GET_Y"
 * buyQty   -> quantity of Buy product required to qualify (e.g. 1, 2)
 * getQty   -> quantity of Get product awarded (e.g. 1)
 * dType    -> "P" (percentage %) or "F" (fixed amount $)
 * dVal     -> discount value (e.g. 100 for free, 50 for half price)
 * maxD     -> optional maximum discount cap in currency ($)
 * getY     -> reward product info (null for same item)
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
 * Main discount evaluation function for BOGO & Buy X Get Y.
 * 
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  // 1. If cart has no lines, exit immediately
  if (!input.cart?.lines?.length) {
    return { operations: [] };
  }

  // 1b. Validate discountClasses eligibility
  const classes = input.discount?.discountClasses || [];
  const isLineEligible = classes.length === 0 || classes.some(
    (c) => String(c).toUpperCase() === "PRODUCT" || String(c).toUpperCase() === "ORDER"
  );
  if (!isLineEligible) {
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

  // 4. Parse shop-level offers fallback map (if present)
  const shopOffersMap = parseJson(input.shop?.offersMetafield?.value) || {};

  // 5. Aggregate cart lines by product ID
  const productGroups = new Map();

  for (const line of input.cart.lines) {
    if (line.merchandise?.__typename === 'ProductVariant') {
      const prod = line.merchandise.product;
      if (!prod?.id) continue;

      const prodGid = String(prod.id).trim();
      const prodNumId = getNumericId(prodGid);
      const lineQty = Number(line.quantity) || 1;

      if (!productGroups.has(prodNumId)) {
        productGroups.set(prodNumId, {
          productGid: prodGid,
          numericId: prodNumId,
          lines: [],
          totalQuantity: 0,
          bogoOfferMeta: prod.bogoOffer?.value || null,
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

  // 6. Evaluate BOGO offers for each product in the cart
  for (const [prodNumId, group] of productGroups.entries()) {
    let offer = null;

    // Priority A: Product-level metafield
    if (group.bogoOfferMeta) {
      offer = parseJson(group.bogoOfferMeta);
    }

    // Priority B: Shop-level fallback map
    if (!offer && shopOffersMap) {
      offer = shopOffersMap[prodNumId] || shopOffersMap[group.productGid];
    }

    if (!offer) continue;

    const dealType = String(offer.dealType || 'BOGO').toUpperCase();
    const buyQty = Math.max(1, Number(offer.buyQty || 1));
    const getQty = Math.max(1, Number(offer.getQty || 1));
    const dType = String(offer.dType || 'P').toUpperCase();
    const dVal = Number(offer.dVal ?? (dealType === 'BOGO' ? 100 : 0));
    const maxD = offer.maxD ? Number(offer.maxD) : null;
    const offerTitle = offer.t || '';

    if (dVal <= 0) continue;

    const rawRate = parseFloat(input.presentmentCurrencyRate);
    const currencyRate = (Number.isFinite(rawRate) && rawRate > 0) ? rawRate : 1.0;
    const isFixed = (dType === 'F' || dType === 'FIXED' || dType === 'FIXED_AMOUNT');
    const convertedDVal = isFixed ? (dVal * currencyRate) : dVal;
    const convertedMaxD = (maxD && Number(maxD) > 0) ? (Number(maxD) * currencyRate) : 0;

    const targets = [];
    let totalDiscountEstimate = 0;

    if (dealType === 'BOGO' || dealType === 'BUY_X_GET_X') {
      // Reward is the SAME product
      // Total required units for 1 complete set = buyQty + getQty
      const setRequiredUnits = buyQty + getQty;
      const sets = Math.floor(group.totalQuantity / setRequiredUnits);
      if (sets < 1) continue;

      const totalRewardUnits = sets * getQty;
      let remainingRewardToTarget = totalRewardUnits;

      // Allocate target quantity across lines sorted by unit price ascending:
      // Lowest-priced items get targeted for discount first!
      // This strictly enforces the "Equal or Lesser Value" rule and prevents cart manipulation.
      const sortedLines = [...group.lines].sort((a, b) => {
        const costA = Number(a.cost?.subtotalAmount?.amount) || 0;
        const qtyA = Number(a.quantity) || 1;
        const unitA = costA / qtyA;

        const costB = Number(b.cost?.subtotalAmount?.amount) || 0;
        const qtyB = Number(b.quantity) || 1;
        const unitB = costB / qtyB;

        return unitA - unitB;
      });

      for (const line of sortedLines) {
        if (remainingRewardToTarget <= 0) break;
        const lineQty = Number(line.quantity) || 1;
        const targetedFromLine = Math.min(lineQty, remainingRewardToTarget);

        targets.push({
          cartLine: {
            id: line.id,
            quantity: targetedFromLine,
          },
        });

        // Compute estimated raw discount for this line (converted to presentment currency)
        const lineCost = Number(line.cost?.subtotalAmount?.amount) || 0;
        const unitPrice = lineCost / lineQty;
        const lineDiscount = isFixed
          ? convertedDVal * targetedFromLine
          : (unitPrice * targetedFromLine * (Math.min(100, Math.max(0, dVal)) / 100));

        totalDiscountEstimate += lineDiscount;
        remainingRewardToTarget -= targetedFromLine;
      }
    } else if (dealType === 'BUY_X_GET_Y') {
      // Reward is a DIFFERENT product
      const sets = Math.floor(group.totalQuantity / buyQty);
      if (sets < 1) continue;

      const rewardProductGid = offer.getY?.id;
      if (!rewardProductGid) continue;

      const rewardProdNumId = getNumericId(rewardProductGid);
      const targetGroup = productGroups.get(rewardProdNumId);
      if (!targetGroup || targetGroup.totalQuantity < 1) continue;

      const maxRewardUnitsAllowed = sets * getQty;
      let remainingRewardToTarget = Math.min(targetGroup.totalQuantity, maxRewardUnitsAllowed);

      // Sort reward lines by unit price ascending
      const sortedRewardLines = [...targetGroup.lines].sort((a, b) => {
        const costA = Number(a.cost?.subtotalAmount?.amount) || 0;
        const qtyA = Number(a.quantity) || 1;
        const unitA = costA / qtyA;

        const costB = Number(b.cost?.subtotalAmount?.amount) || 0;
        const qtyB = Number(b.quantity) || 1;
        const unitB = costB / qtyB;

        return unitA - unitB;
      });

      for (const line of sortedRewardLines) {
        if (remainingRewardToTarget <= 0) break;
        const lineQty = Number(line.quantity) || 1;
        const targetedFromLine = Math.min(lineQty, remainingRewardToTarget);

        targets.push({
          cartLine: {
            id: line.id,
            quantity: targetedFromLine,
          },
        });

        const lineCost = Number(line.cost?.subtotalAmount?.amount) || 0;
        const unitPrice = lineCost / lineQty;
        const lineDiscount = isFixed
          ? convertedDVal * targetedFromLine
          : (unitPrice * targetedFromLine * (Math.min(100, Math.max(0, dVal)) / 100));

        totalDiscountEstimate += lineDiscount;
        remainingRewardToTarget -= targetedFromLine;
      }
    }

    if (targets.length === 0) continue;

    const discountDisplayStr = isFixed ? `${convertedDVal.toFixed(2)} OFF` : `${dVal}% OFF`;

    // Display title on savings pill
    const message = offerTitle || (
      dealType === 'BOGO' ? 'Buy 1 Get 1 Free' :
      dealType === 'BUY_X_GET_X' ? `Buy ${buyQty} Get ${getQty} (${discountDisplayStr})` :
      `Buy ${buyQty} Get ${getQty} Special Deal`
    );

    // Check if Max Discount Cap is exceeded (evaluated in presentment currency)
    if (convertedMaxD > 0 && totalDiscountEstimate > convertedMaxD) {
      // Cap the total discount savings to convertedMaxD via fixedAmount
      candidates.push({
        message,
        targets,
        value: {
          fixedAmount: {
            amount: String(convertedMaxD.toFixed(2)),
            appliesToEachItem: false,
          },
        },
      });
    } else {
      if (isFixed) {
        candidates.push({
          message,
          targets,
          value: {
            fixedAmount: {
              amount: String(convertedDVal.toFixed(2)),
              appliesToEachItem: true,
            },
          },
        });
      } else {
        const clampedPercentage = Math.min(100, Math.max(0, dVal));
        candidates.push({
          message,
          targets,
          value: {
            percentage: {
              value: clampedPercentage,
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
