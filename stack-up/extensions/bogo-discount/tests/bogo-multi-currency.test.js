import { describe, it, expect } from "vitest";
import { cartLinesDiscountsGenerateRun } from "../src/cart_lines_discounts_generate_run.js";

describe("BOGO Discount Function - Multi-Currency Precision Tests", () => {
  const buildInput = ({
    rate = "1.0",
    lines = [],
    bogoOffer = null,
    shopOffers = null,
  }) => ({
    presentmentCurrencyRate: rate,
    discount: { discountClasses: ["PRODUCT"] },
    shop: {
      appStatus: { value: "true" },
      offersMetafield: shopOffers ? { value: JSON.stringify(shopOffers) } : null,
    },
    cart: {
      lines: lines.map((l, idx) => ({
        id: l.id || `gid://shopify/CartLine/${idx + 1}`,
        quantity: l.quantity || 1,
        cost: {
          subtotalAmount: { amount: l.costAmount || "50.00" },
        },
        merchandise: {
          __typename: "ProductVariant",
          id: l.variantId || `gid://shopify/ProductVariant/${l.productId || 100 + idx}`,
          product: {
            id: `gid://shopify/Product/${l.productId || 100 + idx}`,
            bogoOffer: bogoOffer ? { value: JSON.stringify(bogoOffer) } : null,
          },
        },
      })),
    },
  });

  describe("Fixed Amount BOGO Discount Conversions", () => {
    it("converts $5.00 fixed discount to INR (rate: 83.50) -> ₹417.50", () => {
      const offer = {
        id: "bogo-fixed-1",
        t: "Buy 1 Get 1 ($5 OFF)",
        dealType: "BOGO",
        buyQty: 1,
        getQty: 1,
        dType: "F",
        dVal: 5.0,
      };

      const input = buildInput({
        rate: "83.50",
        bogoOffer: offer,
        lines: [
          {
            productId: "201",
            quantity: 2,
            costAmount: "1000.00",
          },
        ],
      });

      const result = cartLinesDiscountsGenerateRun(input);
      expect(result.operations.length).toBe(1);
      const candidates = result.operations[0].productDiscountsAdd.candidates;
      expect(candidates.length).toBe(1);
      expect(candidates[0].value.fixedAmount).toBeDefined();
      expect(candidates[0].value.fixedAmount.amount).toBe("417.50");
      expect(candidates[0].value.fixedAmount.appliesToEachItem).toBe(true);
    });

    it("converts $5.00 fixed discount to EUR (rate: 0.92) -> €4.60", () => {
      const offer = {
        id: "bogo-fixed-eur",
        t: "Buy 1 Get 1 ($5 OFF)",
        dealType: "BOGO",
        buyQty: 1,
        getQty: 1,
        dType: "F",
        dVal: 5.0,
      };

      const input = buildInput({
        rate: "0.92",
        bogoOffer: offer,
        lines: [
          {
            productId: "202",
            quantity: 2,
            costAmount: "50.00",
          },
        ],
      });

      const result = cartLinesDiscountsGenerateRun(input);
      expect(result.operations.length).toBe(1);
      const candidates = result.operations[0].productDiscountsAdd.candidates;
      expect(candidates.length).toBe(1);
      expect(candidates[0].value.fixedAmount.amount).toBe("4.60");
      expect(candidates[0].value.fixedAmount.appliesToEachItem).toBe(true);
    });

    it("applies exact USD $5.00 when rate is 1.0", () => {
      const offer = {
        id: "bogo-fixed-usd",
        dealType: "BOGO",
        buyQty: 1,
        getQty: 1,
        dType: "F",
        dVal: 5.0,
      };

      const input = buildInput({
        rate: "1.00",
        bogoOffer: offer,
        lines: [
          {
            productId: "203",
            quantity: 2,
            costAmount: "40.00",
          },
        ],
      });

      const result = cartLinesDiscountsGenerateRun(input);
      expect(result.operations.length).toBe(1);
      const candidates = result.operations[0].productDiscountsAdd.candidates;
      expect(candidates[0].value.fixedAmount.amount).toBe("5.00");
    });
  });

  describe("Maximum Discount Cap (maxD) Multi-Currency Conversions", () => {
    it("scales maximum discount cap ($10) by rate 83.5 -> ₹835.00 when raw discount exceeds cap", () => {
      const offer = {
        id: "bogo-cap-inr",
        dealType: "BUY_X_GET_X",
        buyQty: 1,
        getQty: 2,
        dType: "P",
        dVal: 100, // 100% off 2 items
        maxD: 10.0, // $10 store currency cap
      };

      // 3 items at ₹1000 each = ₹3000 total. Uncapped reward for 2 items = ₹2000.
      // ₹2000 exceeds ₹835 cap, so cap must apply at ₹835.00.
      const input = buildInput({
        rate: "83.50",
        bogoOffer: offer,
        lines: [
          {
            productId: "301",
            quantity: 3,
            costAmount: "3000.00",
          },
        ],
      });

      const result = cartLinesDiscountsGenerateRun(input);
      expect(result.operations.length).toBe(1);
      const candidates = result.operations[0].productDiscountsAdd.candidates;
      expect(candidates.length).toBe(1);
      expect(candidates[0].value.fixedAmount).toBeDefined();
      expect(candidates[0].value.fixedAmount.amount).toBe("835.00");
      expect(candidates[0].value.fixedAmount.appliesToEachItem).toBe(false);
    });
  });

  describe("Percentage BOGO Discounts (Currency-Neutral)", () => {
    it("maintains percentage discount (e.g. 50% OFF) accurately regardless of currency rate", () => {
      const offer = {
        id: "bogo-pct-1",
        dealType: "BOGO",
        buyQty: 1,
        getQty: 1,
        dType: "P",
        dVal: 50,
      };

      const input = buildInput({
        rate: "83.50",
        bogoOffer: offer,
        lines: [
          {
            productId: "401",
            quantity: 2,
            costAmount: "2000.00",
          },
        ],
      });

      const result = cartLinesDiscountsGenerateRun(input);
      expect(result.operations.length).toBe(1);
      const candidates = result.operations[0].productDiscountsAdd.candidates;
      expect(candidates[0].value.percentage).toBeDefined();
      expect(candidates[0].value.percentage.value).toBe(50);
    });

    it("applies full BOGO 100% Free item accurately across currencies", () => {
      const offer = {
        id: "bogo-free-1",
        dealType: "BOGO",
        buyQty: 1,
        getQty: 1,
        dType: "P",
        dVal: 100,
      };

      const input = buildInput({
        rate: "155.0", // JPY-like rate
        bogoOffer: offer,
        lines: [
          {
            productId: "402",
            quantity: 2,
            costAmount: "10000.00",
          },
        ],
      });

      const result = cartLinesDiscountsGenerateRun(input);
      expect(result.operations.length).toBe(1);
      const candidates = result.operations[0].productDiscountsAdd.candidates;
      expect(candidates[0].value.percentage.value).toBe(100);
    });
  });
});

