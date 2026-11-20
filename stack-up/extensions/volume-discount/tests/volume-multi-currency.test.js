import { describe, it, expect } from "vitest";
import { cartLinesDiscountsGenerateRun } from "../src/cart_lines_discounts_generate_run.js";

describe("Volume Discount Function - Multi-Currency Precision Tests", () => {
  const buildInput = ({
    rate = "1.0",
    lines = [],
    volumeTiers = null,
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
          subtotalAmount: { amount: l.costAmount || "100.00" },
        },
        merchandise: {
          __typename: "ProductVariant",
          id: l.variantId || `gid://shopify/ProductVariant/${l.productId || 500 + idx}`,
          product: {
            id: `gid://shopify/Product/${l.productId || 500 + idx}`,
            volumeTiers: volumeTiers ? { value: JSON.stringify(volumeTiers) } : null,
          },
        },
      })),
    },
  });

  describe("Fixed Amount Volume Tier Conversions", () => {
    it("converts $10.00 fixed discount per item to INR (rate: 83.50) -> ₹835.00", () => {
      const tiers = [
        {
          minQty: 2,
          discount: 5,
          type: "F",
        },
        {
          minQty: 3,
          discount: 10,
          type: "F",
        },
      ];

      const input = buildInput({
        rate: "83.50",
        volumeTiers: { tiers },
        lines: [
          {
            productId: "601",
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
      expect(candidates[0].value.fixedAmount.appliesToEachItem).toBe(true);
    });

    it("converts $10.00 fixed discount per item to EUR (rate: 0.92) -> €9.20", () => {
      const tiers = [
        {
          mq: 3,
          d: 10,
          t: "F",
        },
      ];

      const input = buildInput({
        rate: "0.92",
        volumeTiers: tiers, // Compact array schema
        lines: [
          {
            productId: "602",
            quantity: 4,
            costAmount: "200.00",
          },
        ],
      });

      const result = cartLinesDiscountsGenerateRun(input);
      expect(result.operations.length).toBe(1);
      const candidates = result.operations[0].productDiscountsAdd.candidates;
      expect(candidates.length).toBe(1);
      expect(candidates[0].value.fixedAmount).toBeDefined();
      expect(candidates[0].value.fixedAmount.amount).toBe("9.20");
      expect(candidates[0].value.fixedAmount.appliesToEachItem).toBe(true);
    });

    it("applies exact USD $10.00 when rate is 1.0", () => {
      const tiers = [
        {
          mq: 2,
          d: 10,
          t: "F",
        },
      ];

      const input = buildInput({
        rate: "1.00",
        volumeTiers: tiers,
        lines: [
          {
            productId: "603",
            quantity: 2,
            costAmount: "100.00",
          },
        ],
      });

      const result = cartLinesDiscountsGenerateRun(input);
      expect(result.operations.length).toBe(1);
      const candidates = result.operations[0].productDiscountsAdd.candidates;
      expect(candidates[0].value.fixedAmount.amount).toBe("10.00");
    });
  });

  describe("Percentage Volume Tier Discounts (Currency-Neutral)", () => {
    it("maintains percentage volume discounts (e.g. 20% OFF) accurately across currencies", () => {
      const tiers = [
        {
          minQty: 2,
          discount: 10,
          type: "P",
        },
        {
          minQty: 4,
          discount: 20,
          type: "P",
        },
      ];

      const input = buildInput({
        rate: "83.50",
        volumeTiers: { tiers },
        lines: [
          {
            productId: "604",
            quantity: 4,
            costAmount: "5000.00",
          },
        ],
      });

      const result = cartLinesDiscountsGenerateRun(input);
      expect(result.operations.length).toBe(1);
      const candidates = result.operations[0].productDiscountsAdd.candidates;
      expect(candidates[0].value.percentage).toBeDefined();
      expect(candidates[0].value.percentage.value).toBe(20);
    });
  });

  describe("Edge Cases & App Status", () => {
    it("returns no operations when app status is false", () => {
      const tiers = [{ minQty: 1, discount: 10, type: "P" }];
      const input = {
        ...buildInput({ volumeTiers: { tiers }, lines: [{ quantity: 2 }] }),
        shop: { appStatus: { value: "false" } },
      };
      const result = cartLinesDiscountsGenerateRun(input);
      expect(result.operations).toEqual([]);
    });
  });
});

