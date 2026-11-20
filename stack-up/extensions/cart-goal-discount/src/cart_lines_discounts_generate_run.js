import {
  ProductDiscountSelectionStrategy,
} from '../generated/api';

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

/**
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  if (!input.cart.lines || input.cart.lines.length === 0) {
    return { operations: [] };
  }

  // 1. Verify this discount node is eligible for Line/Product discounts
  const classes = input.discount?.discountClasses || [];
  const isLineEligible = classes.length === 0 || classes.some(
    (c) => String(c).toUpperCase() === "PRODUCT" || String(c).toUpperCase() === "ORDER"
  );
  if (!isLineEligible) {
    return { operations: [] };
  }

  // 1. Verify App Status (Master Kill Switch)
  const appStatusRaw = input.shop?.appStatus?.value;
  if (appStatusRaw === 'false' || appStatusRaw === false) {
    return { operations: [] };
  }
  if (appStatusRaw) {
    try {
      const status = JSON.parse(appStatusRaw);
      if (status && status.enabled === false) {
        return { operations: [] };
      }
    } catch {}
  }

  // 2. Parse Active Cart Goal Offers from Shop Metafield
  const offersRaw = input.shop?.cartGoalOffers?.value;
  if (!offersRaw) {
    return { operations: [] };
  }

  let offers = [];
  try {
    offers = JSON.parse(offersRaw);
  } catch {
    return { operations: [] };
  }

  if (!Array.isArray(offers) || offers.length === 0) {
    return { operations: [] };
  }

  const productDiscountCandidates = [];

  // Compute overall paid subtotal (excluding free gifts) across cart
  let totalPaidSubtotal = 0;
  for (const line of input.cart.lines) {
    const isFreeGift = line.attribute?.value === "true";
    if (!isFreeGift) {
      totalPaidSubtotal += parseFloat(line.cost?.subtotalAmount?.amount) || 0;
    }
  }

  // Evaluate EVERY active Cart Goal offer (Supports Unlimited Simultaneous Cart Goals)
  for (const offer of offers) {
    if (!offer || !Array.isArray(offer.tiers) || offer.tiers.length === 0) {
      continue;
    }

    // Determine qualifying lines & subtotal for this specific offer
    let offerPaidSubtotal = 0;
    const qualifyingLines = [];

    for (const line of input.cart.lines) {
      const isFreeGift = line.attribute?.value === "true";
      if (isFreeGift) continue;

      let isEligible = true;
      const lineProdId = line.merchandise?.product?.id || "";
      const lineProdNum = lineProdId.split("/").pop();

      if (offer.applyTo === "PRODUCTS" && Array.isArray(offer.products) && offer.products.length > 0) {
        isEligible = offer.products.some((p) => {
          const pid = String(p.id || p).split("/").pop();
          return pid === lineProdNum;
        });
      } else if (offer.applyTo === "COLLECTIONS" && Array.isArray(offer.collectionProductIds) && offer.collectionProductIds.length > 0) {
        isEligible = offer.collectionProductIds.includes(lineProdNum);
      }

      if (isEligible) {
        const lineAmount = parseFloat(line.cost?.subtotalAmount?.amount) || 0;
        offerPaidSubtotal += lineAmount;
        qualifyingLines.push(line);
      }
    }

    const isFiltered = (offer.applyTo === "PRODUCTS" || offer.applyTo === "COLLECTIONS");
    const effectiveSubtotal = isFiltered ? offerPaidSubtotal : totalPaidSubtotal;

    // Currency exchange rate (Shopify presentmentCurrencyRate relative to store base currency)
    const currencyRate = parseFloat(input.presentmentCurrencyRate) || 1.0;

    // Determine achieved tiers for this offer (scaling threshold by exchange rate)
    const sortedTiers = [...offer.tiers].sort((a, b) => (Number(a.minAmount) || 0) - (Number(b.minAmount) || 0));
    const achievedTiers = sortedTiers.filter((t) => {
      const convertedThreshold = (Number(t.minAmount) || 0) * currencyRate;
      return effectiveSubtotal >= convertedThreshold;
    });

    if (achievedTiers.length === 0) continue;

    // 1. Find active discount tier (highest achieved discount)
    let activeDiscountTier = null;
    for (let i = achievedTiers.length - 1; i >= 0; i--) {
      if (parseFloat(achievedTiers[i].discountValue) > 0) {
        activeDiscountTier = achievedTiers[i];
        break;
      }
    }

    // 2. Find active free gift tier
    let activeGiftTier = null;
    for (let i = achievedTiers.length - 1; i >= 0; i--) {
      if (achievedTiers[i].freeGift && (achievedTiers[i].freeGift.variantId || achievedTiers[i].freeGift.productId || achievedTiers[i].freeGift.id)) {
        activeGiftTier = achievedTiers[i];
        break;
      }
    }

    // 3. Find matching gift line in cart
    let targetGiftLine = null;
    if (activeGiftTier?.freeGift) {
      const giftVarId = activeGiftTier.freeGift.variantId;
      const giftVarNumeric = giftVarId ? String(giftVarId).split("/").pop() : null;
      const giftProdId = activeGiftTier.freeGift.productId || activeGiftTier.freeGift.id;
      const giftProdNumeric = giftProdId ? String(giftProdId).split("/").pop() : null;

      targetGiftLine = input.cart.lines.find((line) => {
        if (line.attribute?.value === "true") return true;
        if (line.merchandise?.__typename !== "ProductVariant") return false;
        const lineVarId = line.merchandise.id || "";
        const lineProdId = line.merchandise.product?.id || "";

        if (giftVarId && (lineVarId === giftVarId || (giftVarNumeric && lineVarId.endsWith(`/${giftVarNumeric}`)))) {
          return true;
        }
        if (giftProdId && (lineProdId === giftProdId || (giftProdNumeric && lineProdId.endsWith(`/${giftProdNumeric}`)))) {
          return true;
        }
        return false;
      });
    }

    // 4. Apply Tier Line Discount (% or $)
    if (activeDiscountTier) {
      const baseDiscountVal = parseFloat(activeDiscountTier.discountValue) || 0;
      if (baseDiscountVal > 0) {
        const isFixed = String(activeDiscountTier.discountType).toUpperCase() === "FIXED_AMOUNT";
        // Convert fixed-amount discounts to customer's presentment currency; percentage is currency-neutral
        const convertedDiscountVal = isFixed ? (baseDiscountVal * currencyRate) : baseDiscountVal;
        const discountMessage = isFixed
          ? (activeDiscountTier.label || `${convertedDiscountVal.toFixed(2)} OFF`)
          : (activeDiscountTier.label || `${baseDiscountVal}% OFF`);
        const eligibleLines = (isFiltered ? qualifyingLines : input.cart.lines)
          .filter((line) => line.id !== targetGiftLine?.id && line.attribute?.value !== "true");

        if (eligibleLines.length > 0) {
          productDiscountCandidates.push({
            message: `${offer.title ? `${offer.title}: ` : ""}${discountMessage}`,
            targets: eligibleLines.map((line) => ({ cartLine: { id: line.id } })),
            value: isFixed
              ? { fixedAmount: { amount: String((convertedDiscountVal / eligibleLines.length).toFixed(2)) } }
              : { percentage: { value: baseDiscountVal } },
          });
        }
      }
    }

    // 5. Apply Free Gift 100% Discount
    if (targetGiftLine && activeGiftTier?.freeGift) {
      const giftTitle = activeGiftTier.freeGift?.title || "Free Gift";
      productDiscountCandidates.push({
        message: `FREE GIFT: ${giftTitle}`,
        targets: [
          {
            cartLine: {
              id: targetGiftLine.id,
              quantity: 1,
            },
          },
        ],
        value: {
          percentage: {
            value: 100,
          },
        },
      });
    }
  }

  const operations = [];
  if (productDiscountCandidates.length > 0) {
    operations.push({
      productDiscountsAdd: {
        candidates: productDiscountCandidates,
        selectionStrategy: ProductDiscountSelectionStrategy.All,
      },
    });
  }

  return { operations };
}
