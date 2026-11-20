import db from "../db.server";

/**
 * Extracts all products from an offer regardless of its type.
 */
export function getOfferProducts(offer) {
  try {
    if (offer.type === "PAIRED") {
      const p1 = JSON.parse(offer.mainProducts || "[]");
      const p2 = JSON.parse(offer.subProducts || "[]");
      return [...p1, ...p2];
    }
    if (offer.type === "BOGO") {
      const p1 = JSON.parse(offer.mainProducts || "[]");
      const p2 = JSON.parse(offer.subProducts || "[]");
      return [...p1, ...p2];
    }
    if (offer.type === "VOLUME") {
      if (offer.volumeProducts) {
        return JSON.parse(offer.volumeProducts);
      }
      if (offer.configuration) {
        return JSON.parse(offer.configuration)?.volumeProducts || [];
      }
      return [];
    }
    if (offer.type === "CART_GOAL") {
      let giftProds = [];
      try {
        const cfg = typeof offer.configuration === "string" ? JSON.parse(offer.configuration) : offer.configuration;
        const tiers = cfg?.tiers || [];
        tiers.forEach((t) => {
          if (t.freeGift && (t.freeGift.id || t.freeGift.productId)) {
            giftProds.push({
              id: t.freeGift.productId || t.freeGift.id,
              title: t.freeGift.title || "Free Gift",
              image: t.freeGift.image,
            });
          }
        });
      } catch {}
      return giftProds;
    }
    // SELECTED
    const p1 = JSON.parse(offer.targetProducts || "[]");
    const p2 = JSON.parse(offer.offeredProducts || offer.products || "[]");
    return [...p1, ...p2];
  } catch {
    return [];
  }
}

/**
 * Returns a Set of product IDs (both full GID and numeric string ID) configured for an offer.
 */
export function getOfferProductIds(offer) {
  const prods = getOfferProducts(offer);
  const idSet = new Set();
  prods.forEach((p) => {
    if (p?.id) {
      const fullId = String(p.id).trim();
      const numId = fullId.split("/").pop();
      idSet.add(fullId);
      idSet.add(numId);
      idSet.add(`gid://shopify/Product/${numId}`);
    }
  });
  return idSet;
}

/**
 * Robustly upserts an OrderUsage record.
 * If the Prisma client in server RAM has not yet reloaded the new `purchasedProducts` column,
 * it catches the validation error, saves standard fields, and updates `purchasedProducts` via raw SQL.
 */
export async function safeSaveOrderUsage({
  shop,
  orderId,
  orderName,
  customerEmail,
  totalPrice,
  discountAmount,
  currency,
  purchasedProducts,
  offerId,
  createdAt,
}) {
  const purchasedProductsStr = typeof purchasedProducts === "string"
    ? purchasedProducts
    : JSON.stringify(purchasedProducts || []);

  const existingUsage = await db.orderUsage.findFirst({
    where: {
      orderId,
      offerId,
    },
  });

  if (existingUsage) {
    try {
      await db.orderUsage.update({
        where: { id: existingUsage.id },
        data: {
          totalPrice,
          discountAmount,
          currency,
          purchasedProducts: purchasedProductsStr,
        },
      });
    } catch (err) {
      if (err?.message?.includes("purchasedProducts")) {
        await db.orderUsage.update({
          where: { id: existingUsage.id },
          data: {
            totalPrice,
            discountAmount,
            currency,
          },
        });
        try {
          await db.$executeRawUnsafe(
            `UPDATE "OrderUsage" SET "purchasedProducts" = $1 WHERE id = $2`,
            purchasedProductsStr,
            existingUsage.id
          );
        } catch (rawErr) {
          console.warn("[safeSaveOrderUsage] Raw SQL update warning:", rawErr.message);
        }
      } else {
        throw err;
      }
    }
  } else {
    try {
      await db.orderUsage.create({
        data: {
          shop,
          orderId,
          orderName,
          customerEmail,
          totalPrice,
          discountAmount,
          currency,
          purchasedProducts: purchasedProductsStr,
          offerId,
          createdAt: createdAt ? new Date(createdAt) : new Date(),
        },
      });
    } catch (err) {
      if (err?.message?.includes("purchasedProducts")) {
        const created = await db.orderUsage.create({
          data: {
            shop,
            orderId,
            orderName,
            customerEmail,
            totalPrice,
            discountAmount,
            currency,
            offerId,
            createdAt: createdAt ? new Date(createdAt) : new Date(),
          },
        });
        try {
          await db.$executeRawUnsafe(
            `UPDATE "OrderUsage" SET "purchasedProducts" = $1 WHERE id = $2`,
            purchasedProductsStr,
            created.id
          );
        } catch (rawErr) {
          console.warn("[safeSaveOrderUsage] Raw SQL insert warning:", rawErr.message);
        }
      } else {
        throw err;
      }
    }
  }
}

/**
 * Cleans up any mismatched or false-backfilled orders from the database
 * and recalculates accurate usage count, total revenue, and discount amounts.
 */
export async function cleanupMismatchedOrders(shop) {
  try {
    const shopConditions = [
      { shop },
      { shop: shop.replace(".myshopify.com", "") },
      { shop: `${shop.replace(".myshopify.com", "")}.myshopify.com` },
    ];

    const allOffers = await db.offer.findMany({ where: { OR: shopConditions } });

    for (const offer of allOffers) {
      // Gate 1: Time Boundary check (allow 2 min margin for server clock skew)
      const offerCreatedAt = new Date(offer.createdAt).getTime() - 2 * 60 * 1000;
      const offerProductIds = getOfferProductIds(offer);

      const existingUsages = await db.orderUsage.findMany({
        where: { offerId: offer.id },
      });

      // If in-memory Prisma client did not select purchasedProducts, load via raw SQL
      let rawProductMap = new Map();
      if (existingUsages.some((u) => u.purchasedProducts === undefined) && existingUsages.length > 0) {
        try {
          const rawRows = await db.$queryRawUnsafe(
            `SELECT id, "purchasedProducts" FROM "OrderUsage" WHERE id = ANY($1::text[])`,
            existingUsages.map((u) => u.id)
          );
          rawRows.forEach((r) => rawProductMap.set(r.id, r.purchasedProducts));
        } catch {}
      }

      const invalidUsageIds = [];
      const validUsages = [];

      for (const usage of existingUsages) {
        const usageCreatedAt = new Date(usage.createdAt).getTime();

        // 1. If order was placed BEFORE offer was created, it's a false match!
        if (usageCreatedAt < offerCreatedAt) {
          invalidUsageIds.push(usage.id);
          continue;
        }

        // 2. If purchasedProducts is populated, verify at least one product belongs to this offer (for product-specific offers)
        const prodData = usage.purchasedProducts ?? rawProductMap.get(usage.id);
        if (prodData && offer.type !== "CART_GOAL" && offerProductIds.size > 0) {
          try {
            const items = JSON.parse(prodData || "[]");
            if (Array.isArray(items) && items.length > 0) {
              const hasOfferProd = items.some((it) => {
                const pid = String(it.productId || "").trim();
                const numId = pid.split("/").pop();
                return offerProductIds.has(pid) || offerProductIds.has(numId);
              });
              if (!hasOfferProd) {
                invalidUsageIds.push(usage.id);
                continue;
              }
            }
          } catch {}
        }

        validUsages.push(usage);
      }

      // Delete invalid records permanently from PostgreSQL
      if (invalidUsageIds.length > 0) {
        console.log(`[OrderAudit] Deleting ${invalidUsageIds.length} false-match orderUsages for offer ${offer.id} (${offer.title})`);
        await db.orderUsage.deleteMany({
          where: { id: { in: invalidUsageIds } },
        });
      }

      // Recalculate accurate stats
      const newUsageCount = validUsages.length;
      const newRevenue = validUsages.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
      const newDiscount = validUsages.reduce((sum, o) => sum + (o.discountAmount || 0), 0);

      await db.offer.update({
        where: { id: offer.id },
        data: {
          usageCount: newUsageCount,
          totalRevenue: newRevenue,
          totalDiscountAmount: newDiscount,
        },
      });
    }
  } catch (err) {
    console.warn("[OrderAudit] Error during cleanupMismatchedOrders:", err);
  }
}

/**
 * Syncs and backfills recent orders from Shopify Admin GraphQL into the PostgreSQL database.
 * Uses 4-gate verification to guarantee exact attribution and persists purchased items.
 */
export async function syncRecentOrdersFromShopify(admin, shop) {
  try {
    const response = await admin.graphql(
      `#graphql
      query GetRecentOrders {
        orders(first: 100, sortKey: CREATED_AT, reverse: true) {
          nodes {
            id
            name
            createdAt
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            totalDiscountsSet {
              shopMoney {
                amount
              }
            }
            discountApplications(first: 10) {
              nodes {
                targetSelection
                targetType
                value {
                  ... on PricingPercentageValue {
                    percentage
                  }
                }
                ... on AutomaticDiscountApplication {
                  title
                }
                ... on DiscountCodeApplication {
                  code
                }
                ... on ScriptDiscountApplication {
                  title
                }
                ... on ManualDiscountApplication {
                  title
                }
              }
            }
            lineItems(first: 50) {
              nodes {
                id
                title
                quantity
                originalUnitPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                discountedUnitPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                discountAllocations {
                  allocatedAmountSet {
                    shopMoney {
                      amount
                    }
                  }
                  discountApplication {
                    ... on AutomaticDiscountApplication {
                      title
                    }
                    ... on DiscountCodeApplication {
                      code
                    }
                    ... on ScriptDiscountApplication {
                      title
                    }
                    ... on ManualDiscountApplication {
                      title
                    }
                  }
                }
                product {
                  id
                  title
                }
              }
            }
          }
        }
      }`
    );

    const json = await response.json();
    const orders = json.data?.orders?.nodes || [];

    if (orders.length === 0) return 0;

    const shopConditions = [
      { shop },
      { shop: shop.replace(".myshopify.com", "") },
      { shop: `${shop.replace(".myshopify.com", "")}.myshopify.com` },
    ];

    const allOffers = await db.offer.findMany({ where: { OR: shopConditions } });
    if (allOffers.length === 0) return 0;

    let newlySyncedCount = 0;

    for (const order of orders) {
      const orderNumericId = order.id.split("/").pop();
      const orderIdStr = String(orderNumericId);
      const orderCreatedAt = new Date(order.createdAt).getTime();

      // Extract applied discount titles, codes, and percentages
      const appliedTitles = (order.discountApplications?.nodes || [])
        .map((app) => (app.title || app.code)?.toLowerCase().trim())
        .filter(Boolean);

      const appliedPercentages = (order.discountApplications?.nodes || [])
        .map((app) => (typeof app.value?.percentage === "number" ? app.value.percentage : null))
        .filter((p) => p !== null);

      if (appliedTitles.length === 0 && appliedPercentages.length === 0) continue;

      const orderLines = order.lineItems?.nodes || [];

      // Extract product IDs present in the order's line items
      const orderProductIds = new Set();
      orderLines.forEach((line) => {
        if (line.product?.id) {
          const fullId = String(line.product.id).trim();
          const numId = fullId.split("/").pop();
          orderProductIds.add(fullId);
          orderProductIds.add(numId);
          orderProductIds.add(`gid://shopify/Product/${numId}`);
        }
      });

      const hasMasterSelected = appliedTitles.some((t) => (t.includes("stackup") || t.includes("stack-up")) && t.includes("selected"));
      const hasMasterPaired = appliedTitles.some((t) => (t.includes("stackup") || t.includes("stack-up")) && t.includes("paired"));
      const hasMasterVolume = appliedTitles.some((t) => ((t.includes("stackup") || t.includes("stack-up")) && (t.includes("volume") || t.includes("quantity"))) || t.includes("volume discount") || t.includes("buy more") || t.includes("quantity break"));
      const hasMasterBogo = appliedTitles.some((t) => (t.includes("stackup") || t.includes("stack-up")) && (t.includes("bogo") || t.includes("buy x") || t.includes("buy 1")));
      const hasMasterCartGoal = appliedTitles.some((t) =>
        (t.includes("stackup") || t.includes("stack-up")) && (t.includes("cart goal") || t.includes("cart_goal")) ||
        t.includes("cart goal") ||
        t.includes("free gift") ||
        t.includes("free shipping")
      );

      const matchedOffers = [];

      for (const off of allOffers) {
        // GATE 1: Time Boundary (Strict) - Order MUST be created after the offer was created
        const offerCreatedAt = new Date(off.createdAt).getTime() - 2 * 60 * 1000;
        if (orderCreatedAt < offerCreatedAt) {
          continue; // Order existed before offer existed!
        }

        // GATE 2: Product Membership (Strict) - Order MUST contain at least one product configured for this offer
        const offerProductIds = getOfferProductIds(off);
        let hasMatchingProduct = false;

        if (off.type === "CART_GOAL") {
          // Cart Goal is a cart-level storewide spend threshold offer. All products are eligible.
          hasMatchingProduct = true;
        } else {
          if (offerProductIds.size === 0) continue;

          for (const pid of offerProductIds) {
            if (orderProductIds.has(pid)) {
              hasMatchingProduct = true;
              break;
            }
          }
        }

        if (!hasMatchingProduct) {
          continue; // Order does not contain any of this offer's products!
        }

        // GATE 3: Title or Master Discount Function Match
        const title = (off.title || "").toLowerCase().trim();
        const titleMatches = Boolean(
          title && appliedTitles.some((t) => t === title || t.includes(title))
        );

        let isMatched = false;
        if (titleMatches) {
          isMatched = true;
        } else if (off.type === "PAIRED" && hasMasterPaired && appliedPercentages.includes(off.percentage)) {
          isMatched = true;
        } else if (off.type === "SELECTED" && hasMasterSelected && appliedPercentages.includes(off.percentage)) {
          isMatched = true;
        } else if (off.type === "VOLUME" && hasMasterVolume) {
          isMatched = true;
        } else if (off.type === "BOGO" && hasMasterBogo) {
          isMatched = true;
        } else if (off.type === "CART_GOAL" && (hasMasterCartGoal || titleMatches)) {
          isMatched = true;
        }

        if (!isMatched) {
          continue;
        }

        // GATE 4: Line Item Extraction & Product Attribution
        const purchasedItems = [];
        let lineAllocTotal = 0;

        if (off.type === "CART_GOAL") {
          orderLines.forEach((line) => {
            const linePid = line.product?.id ? String(line.product.id).trim() : "";
            const lineNumId = linePid.split("/").pop();
            const lineQty = Number(line.quantity) || 1;
            const unitPrice = parseFloat(
              line.discountedUnitPriceSet?.shopMoney?.amount ||
              line.originalUnitPriceSet?.shopMoney?.amount ||
              0
            );

            let lineDiscount = 0;
            (line.discountAllocations || []).forEach((alloc) => {
              lineDiscount += parseFloat(alloc.allocatedAmountSet?.shopMoney?.amount) || 0;
            });

            lineAllocTotal += lineDiscount;

            purchasedItems.push({
              productId: linePid.startsWith("gid://shopify/Product/") ? linePid : `gid://shopify/Product/${lineNumId}`,
              title: line.title || line.product?.title || "Product",
              quantity: lineQty,
              price: unitPrice,
              discountAmount: lineDiscount,
            });
          });
        } else {
          orderLines.forEach((line) => {
            const linePid = line.product?.id ? String(line.product.id).trim() : "";
            const lineNumId = linePid.split("/").pop();

            if (offerProductIds.has(linePid) || offerProductIds.has(lineNumId)) {
              const lineQty = Number(line.quantity) || 1;
              const unitPrice = parseFloat(
                line.discountedUnitPriceSet?.shopMoney?.amount ||
                line.originalUnitPriceSet?.shopMoney?.amount ||
                0
              );

              let lineDiscount = 0;
              (line.discountAllocations || []).forEach((alloc) => {
                const appTitle = (alloc.discountApplication?.title || alloc.discountApplication?.code || "")?.toLowerCase().trim();
                if (
                  (appTitle && (appTitle === title || appTitle.includes(title))) ||
                  (hasMasterVolume && off.type === "VOLUME") ||
                  (hasMasterSelected && off.type === "SELECTED") ||
                  (hasMasterPaired && off.type === "PAIRED") ||
                  (hasMasterBogo && off.type === "BOGO")
                ) {
                  lineDiscount += parseFloat(alloc.allocatedAmountSet?.shopMoney?.amount) || 0;
                }
              });

              lineAllocTotal += lineDiscount;

              purchasedItems.push({
                productId: linePid.startsWith("gid://shopify/Product/") ? linePid : `gid://shopify/Product/${lineNumId}`,
                title: line.title || line.product?.title || "Product",
                quantity: lineQty,
                price: unitPrice,
                discountAmount: lineDiscount,
              });
            }
          });
        }

        matchedOffers.push({
          offer: off,
          purchasedItems,
          lineAllocTotal,
        });
      }

      if (matchedOffers.length === 0) continue;

      const totalPrice = parseFloat(order.totalPriceSet?.shopMoney?.amount) || 0;
      const totalDiscounts = parseFloat(order.totalDiscountsSet?.shopMoney?.amount) || 0;
      const currency = order.totalPriceSet?.shopMoney?.currencyCode || "USD";
      const customerEmail = "Customer";

      for (const matched of matchedOffers) {
        let offerDiscount = matched.lineAllocTotal;
        if (matched.offer.type === "CART_GOAL") {
          offerDiscount = totalDiscounts || matched.lineAllocTotal;
        } else if (offerDiscount === 0) {
          offerDiscount = matchedOffers.length === 1 ? totalDiscounts : (totalDiscounts / matchedOffers.length);
        }

        await safeSaveOrderUsage({
          shop,
          orderId: orderIdStr,
          orderName: order.name,
          customerEmail,
          totalPrice,
          discountAmount: offerDiscount,
          currency,
          purchasedProducts: matched.purchasedItems,
          offerId: matched.offer.id,
          createdAt: order.createdAt ? new Date(order.createdAt) : new Date(),
        });

        newlySyncedCount++;
      }
    }

    // Clean up any historical false matches and recalculate stats
    await cleanupMismatchedOrders(shop);

    return newlySyncedCount;
  } catch (err) {
    console.warn("Error running syncRecentOrdersFromShopify:", err);
    return 0;
  }
}
