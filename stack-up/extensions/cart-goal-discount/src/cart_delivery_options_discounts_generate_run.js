import {
  DeliveryDiscountSelectionStrategy,
  DeliveryMethod,
} from "../generated/api";

/**
 * @typedef {import("../generated/api").DeliveryInput} RunInput
 * @typedef {import("../generated/api").CartDeliveryOptionsDiscountsGenerateRunResult} CartDeliveryOptionsDiscountsGenerateRunResult
 */

/**
 * @param {RunInput} input
 * @returns {CartDeliveryOptionsDiscountsGenerateRunResult}
 */
export function cartDeliveryOptionsDiscountsGenerateRun(input) {
  // 1. Verify Shipping discount class is enabled
  const classes = input.discount?.discountClasses || [];
  const hasShippingDiscountClass = classes.length === 0 || classes.some(
    (c) => String(c).toUpperCase() === "SHIPPING"
  );
  if (!hasShippingDiscountClass) {
    return { operations: [] };
  }

  // 2. Verify App Status (Master Kill Switch)
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
    } catch { }
  }

  // 3. Parse Active Cart Goal Offers
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

  // 4. Check if ANY achieved tier has Free Shipping enabled
  let hasFreeShippingUnlocked = false;
  let shippingLabel = "FREE SHIPPING";

  // Presentment currency exchange rate relative to store base currency
  const currencyRate = parseFloat(input.presentmentCurrencyRate) || 1.0;

  const offersList = Array.isArray(offers) ? offers : [offers];
  for (const offer of offersList) {
    if (!offer || !Array.isArray(offer.tiers) || offer.tiers.length === 0) continue;

    // Calculate eligible subtotal for this offer
    let offerPaidSubtotal = 0;
    if (Array.isArray(input.cart.lines)) {
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
          offerPaidSubtotal += parseFloat(line.cost?.subtotalAmount?.amount) || 0;
        }
      }
    }

    const sortedTiers = [...offer.tiers].sort((a, b) => (Number(a.minAmount) || 0) - (Number(b.minAmount) || 0));
    const achievedTiers = sortedTiers.filter(t => {
      const convertedThreshold = (Number(t.minAmount) || 0) * currencyRate;
      return offerPaidSubtotal >= convertedThreshold;
    });
    const shippingTier = achievedTiers.slice().reverse().find(t => Boolean(t.hasFreeShipping));
    if (shippingTier) {
      hasFreeShippingUnlocked = true;
      shippingLabel = shippingTier.label || "FREE SHIPPING";
      break;
    }
  }

  if (!hasFreeShippingUnlocked) {
    return { operations: [] };
  }

  // Target delivery groups that have shipping methods
  let targets = (input.cart.deliveryGroups || [])
    .filter(({ deliveryOptions }) =>
      !deliveryOptions || deliveryOptions.length === 0 ||
      deliveryOptions.some(
        ({ deliveryMethodType }) =>
          !deliveryMethodType ||
          deliveryMethodType === DeliveryMethod.Shipping ||
          String(deliveryMethodType).toUpperCase() === "SHIPPING"
      ),
    )
    .map(({ id }) => ({ deliveryGroup: { id } }));

  if (targets.length === 0 && input.cart.deliveryGroups?.length > 0) {
    targets = input.cart.deliveryGroups.map(({ id }) => ({ deliveryGroup: { id } }));
  }

  if (targets.length === 0) {
    return { operations: [] };
  }

  return {
    operations: [
      {
        deliveryDiscountsAdd: {
          candidates: [
            {
              message: shippingLabel,
              targets,
              value: {
                percentage: {
                  value: 100,
                },
              },
            },
          ],
          selectionStrategy: DeliveryDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
