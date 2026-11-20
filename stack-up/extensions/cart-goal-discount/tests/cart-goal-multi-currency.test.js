import { describe, it, expect } from "vitest";
import { cartLinesDiscountsGenerateRun } from "../src/cart_lines_discounts_generate_run.js";
import { cartDeliveryOptionsDiscountsGenerateRun } from "../src/cart_delivery_options_discounts_generate_run.js";

describe("Cart Goal Functions - Multi-Currency Precision Tests", () => {
  const baseOfferMetafield = (tiers, applyTo = "ALL") =>
    JSON.stringify([
      {
        id: "offer-1",
        title: "Spend More, Save More",
        status: "ACTIVE",
        applyTo,
        tiers,
      },
    ]);

  describe("Line & Product Discounts - Multi-Currency Conversion", () => {
    it("converts USD goal ($100) to INR (₹8,350): rejects subtotal ₹5,000 and unlocks at ₹8,500", () => {
      const tiers = [
        {
          minAmount: 100,
          discountType: "PERCENTAGE",
          discountValue: 10,
          hasDiscount: true,
          label: "10% off",
        },
      ];

      // 1. Below converted threshold (₹5,000 < ₹8,350)
      const belowInput = {
        presentmentCurrencyRate: "83.5",
        discount: { discountClasses: ["PRODUCT"] },
        shop: {
          appStatus: { value: "true" },
          cartGoalOffers: { value: baseOfferMetafield(tiers) },
        },
        cart: {
          lines: [
            {
              id: "gid://shopify/CartLine/1",
              cost: { subtotalAmount: { amount: "5000.00" } },
              merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/101" },
            },
          ],
        },
      };

      const belowResult = cartLinesDiscountsGenerateRun(belowInput);
      expect(belowResult.operations).toEqual([]);

      // 2. Above converted threshold (₹8,500 >= ₹8,350)
      const aboveInput = {
        ...belowInput,
        cart: {
          lines: [
            {
              id: "gid://shopify/CartLine/1",
              cost: { subtotalAmount: { amount: "8500.00" } },
              merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/101" },
            },
          ],
        },
      };

      const aboveResult = cartLinesDiscountsGenerateRun(aboveInput);
      expect(aboveResult.operations.length).toBe(1);
      const candidates = aboveResult.operations[0].productDiscountsAdd.candidates;
      expect(candidates.length).toBe(1);
      expect(candidates[0].value.percentage.value).toBe(10);
    });

    it("converts USD goal ($100) to EUR (€92): rejects €90 and unlocks at €95", () => {
      const tiers = [
        {
          minAmount: 100,
          discountType: "PERCENTAGE",
          discountValue: 10,
          hasDiscount: true,
          label: "10% off",
        },
      ];

      // Below EUR threshold (€90 < €92)
      const belowInput = {
        presentmentCurrencyRate: "0.92",
        discount: { discountClasses: ["ORDER"] },
        shop: {
          appStatus: { value: "true" },
          cartGoalOffers: { value: baseOfferMetafield(tiers) },
        },
        cart: {
          lines: [
            {
              id: "gid://shopify/CartLine/1",
              cost: { subtotalAmount: { amount: "90.00" } },
              merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/101" },
            },
          ],
        },
      };
      expect(cartLinesDiscountsGenerateRun(belowInput).operations).toEqual([]);

      // Above EUR threshold (€95 >= €92)
      const aboveInput = {
        ...belowInput,
        cart: {
          lines: [
            {
              id: "gid://shopify/CartLine/1",
              cost: { subtotalAmount: { amount: "95.00" } },
              merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/101" },
            },
          ],
        },
      };
      const aboveResult = cartLinesDiscountsGenerateRun(aboveInput);
      expect(aboveResult.operations.length).toBe(1);
      expect(aboveResult.operations[0].productDiscountsAdd.candidates[0].value.percentage.value).toBe(10);
    });

    it("converts USD goal ($100) to zero-decimal JPY (¥15,500): rejects ¥14,000 and unlocks at ¥16,000", () => {
      const tiers = [
        {
          minAmount: 100,
          discountType: "PERCENTAGE",
          discountValue: 10,
          hasDiscount: true,
          label: "10% off",
        },
      ];

      const belowInput = {
        presentmentCurrencyRate: "155.0",
        discount: { discountClasses: ["PRODUCT"] },
        shop: {
          appStatus: { value: "true" },
          cartGoalOffers: { value: baseOfferMetafield(tiers) },
        },
        cart: {
          lines: [
            {
              id: "gid://shopify/CartLine/1",
              cost: { subtotalAmount: { amount: "14000" } },
              merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/101" },
            },
          ],
        },
      };
      expect(cartLinesDiscountsGenerateRun(belowInput).operations).toEqual([]);

      const aboveInput = {
        ...belowInput,
        cart: {
          lines: [
            {
              id: "gid://shopify/CartLine/1",
              cost: { subtotalAmount: { amount: "16000" } },
              merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/101" },
            },
          ],
        },
      };
      const aboveResult = cartLinesDiscountsGenerateRun(aboveInput);
      expect(aboveResult.operations.length).toBe(1);
      expect(aboveResult.operations[0].productDiscountsAdd.candidates[0].value.percentage.value).toBe(10);
    });

    it("converts Fixed-Amount discounts accurately into presentment currency (USD $10 off -> INR ₹835 off)", () => {
      const tiers = [
        {
          minAmount: 50,
          discountType: "FIXED_AMOUNT",
          discountValue: 10, // $10 base discount
          hasDiscount: true,
          label: "$10 off",
        },
      ];

      // Rate = 83.5. Base $10 discount should convert to ₹835.00
      const input = {
        presentmentCurrencyRate: "83.5",
        discount: { discountClasses: ["PRODUCT"] },
        shop: {
          appStatus: { value: "true" },
          cartGoalOffers: { value: baseOfferMetafield(tiers) },
        },
        cart: {
          lines: [
            {
              id: "gid://shopify/CartLine/1",
              cost: { subtotalAmount: { amount: "5000.00" } }, // Exceeds 50 * 83.5 = 4175
              merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/101" },
            },
          ],
        },
      };

      const result = cartLinesDiscountsGenerateRun(input);
      expect(result.operations.length).toBe(1);
      const candidate = result.operations[0].productDiscountsAdd.candidates[0];
      expect(candidate.value.fixedAmount.amount).toBe("835.00");
    });

    it("correctly evaluates progressive multi-tiers in INR currency", () => {
      const tiers = [
        { minAmount: 50, discountType: "PERCENTAGE", discountValue: 5, hasDiscount: true },
        { minAmount: 100, discountType: "PERCENTAGE", discountValue: 10, hasDiscount: true },
        { minAmount: 200, discountType: "PERCENTAGE", discountValue: 20, hasDiscount: true },
      ];

      // Rate = 80. Converted thresholds: Tier 1 = ₹4,000, Tier 2 = ₹8,000, Tier 3 = ₹16,000
      const makeInput = (subtotal) => ({
        presentmentCurrencyRate: "80.0",
        discount: { discountClasses: ["PRODUCT"] },
        shop: {
          appStatus: { value: "true" },
          cartGoalOffers: { value: baseOfferMetafield(tiers) },
        },
        cart: {
          lines: [
            {
              id: "gid://shopify/CartLine/1",
              cost: { subtotalAmount: { amount: String(subtotal) } },
              merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/101" },
            },
          ],
        },
      });

      // Cart ₹3,000 -> 0 discounts
      expect(cartLinesDiscountsGenerateRun(makeInput(3000)).operations).toEqual([]);

      // Cart ₹5,000 -> Tier 1 (5% off)
      const res1 = cartLinesDiscountsGenerateRun(makeInput(5000));
      expect(res1.operations[0].productDiscountsAdd.candidates[0].value.percentage.value).toBe(5);

      // Cart ₹10,000 -> Tier 2 (10% off)
      const res2 = cartLinesDiscountsGenerateRun(makeInput(10000));
      expect(res2.operations[0].productDiscountsAdd.candidates[0].value.percentage.value).toBe(10);

      // Cart ₹18,000 -> Tier 3 (20% off)
      const res3 = cartLinesDiscountsGenerateRun(makeInput(18000));
      expect(res3.operations[0].productDiscountsAdd.candidates[0].value.percentage.value).toBe(20);
    });

    it("unlocks Free Gift tier in EUR currency (€138 converted threshold)", () => {
      const tiers = [
        {
          minAmount: 150,
          discountType: "PERCENTAGE",
          discountValue: 0,
          hasDiscount: false,
          freeGift: {
            productId: "999",
            variantId: "gid://shopify/ProductVariant/888",
            title: "Summer Sunglasses",
          },
        },
      ];

      // Rate = 0.92 -> threshold = 150 * 0.92 = 138 EUR
      const input = {
        presentmentCurrencyRate: "0.92",
        discount: { discountClasses: ["PRODUCT"] },
        shop: {
          appStatus: { value: "true" },
          cartGoalOffers: { value: baseOfferMetafield(tiers) },
        },
        cart: {
          lines: [
            {
              id: "gid://shopify/CartLine/main",
              cost: { subtotalAmount: { amount: "140.00" } },
              merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/101" },
            },
            {
              id: "gid://shopify/CartLine/gift",
              cost: { subtotalAmount: { amount: "25.00" } },
              merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/888" },
              attribute: { value: "true" }, // free gift line marker
            },
          ],
        },
      };

      const result = cartLinesDiscountsGenerateRun(input);
      expect(result.operations.length).toBe(1);
      const candidates = result.operations[0].productDiscountsAdd.candidates;
      expect(candidates.length).toBe(1);
      expect(candidates[0].targets[0].cartLine.id).toBe("gid://shopify/CartLine/gift");
      expect(candidates[0].value.percentage.value).toBe(100);
    });

    it("safely falls back to 1.0 rate when presentmentCurrencyRate is null or invalid", () => {
      const tiers = [{ minAmount: 100, discountType: "PERCENTAGE", discountValue: 10, hasDiscount: true }];

      const input = {
        presentmentCurrencyRate: null,
        discount: { discountClasses: ["PRODUCT"] },
        shop: {
          appStatus: { value: "true" },
          cartGoalOffers: { value: baseOfferMetafield(tiers) },
        },
        cart: {
          lines: [
            {
              id: "gid://shopify/CartLine/1",
              cost: { subtotalAmount: { amount: "105.00" } },
              merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/101" },
            },
          ],
        },
      };

      const result = cartLinesDiscountsGenerateRun(input);
      expect(result.operations.length).toBe(1);
      expect(result.operations[0].productDiscountsAdd.candidates[0].value.percentage.value).toBe(10);
    });
  });

  describe("Delivery Discounts - Multi-Currency Conversion", () => {
    it("converts Free Shipping threshold ($100 USD) into INR (₹8,350): rejects ₹7,000 and unlocks at ₹9,000", () => {
      const tiers = [
        {
          minAmount: 100,
          hasFreeShipping: true,
          label: "Free Shipping Milestone",
        },
      ];

      // Below threshold (₹7,000 < ₹8,350)
      const belowInput = {
        presentmentCurrencyRate: "83.5",
        discount: { discountClasses: ["SHIPPING"] },
        shop: {
          appStatus: { value: "true" },
          cartGoalOffers: { value: baseOfferMetafield(tiers) },
        },
        cart: {
          lines: [
            {
              id: "gid://shopify/CartLine/1",
              cost: { subtotalAmount: { amount: "7000.00" } },
            },
          ],
          deliveryGroups: [
            {
              id: "gid://shopify/DeliveryGroup/1",
              deliveryOptions: [{ deliveryMethodType: "SHIPPING" }],
            },
          ],
        },
      };

      expect(cartDeliveryOptionsDiscountsGenerateRun(belowInput).operations).toEqual([]);

      // Above threshold (₹9,000 >= ₹8,350)
      const aboveInput = {
        ...belowInput,
        cart: {
          ...belowInput.cart,
          lines: [
            {
              id: "gid://shopify/CartLine/1",
              cost: { subtotalAmount: { amount: "9000.00" } },
            },
          ],
        },
      };

      const aboveResult = cartDeliveryOptionsDiscountsGenerateRun(aboveInput);
      expect(aboveResult.operations.length).toBe(1);
      const deliveryCandidates = aboveResult.operations[0].deliveryDiscountsAdd.candidates;
      expect(deliveryCandidates.length).toBe(1);
      expect(deliveryCandidates[0].message).toBe("Free Shipping Milestone");
      expect(deliveryCandidates[0].value.percentage.value).toBe(100);
      expect(deliveryCandidates[0].targets[0].deliveryGroup.id).toBe("gid://shopify/DeliveryGroup/1");
    });
  });
});

