import db from "../db.server";

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
      const validOrders = await db.orderUsage.findMany({
        where: { offerId: offer.id },
      });

      const newUsageCount = validOrders.length;
      const newRevenue = validOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
      const newDiscount = validOrders.reduce((sum, o) => sum + (o.discountAmount || 0), 0);

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
 * Accurately supports combined orders where multiple offers apply!
 */
export async function syncRecentOrdersFromShopify(admin, shop) {
  try {
    const response = await admin.graphql(
      `#graphql
      query GetRecentOrders {
        orders(first: 25, sortKey: CREATED_AT, reverse: true) {
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
                  }
                }
                product {
                  id
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

      // Extract applied discount titles, codes, and percentages
      const appliedTitles = (order.discountApplications?.nodes || [])
        .map((app) => (app.title || app.code)?.toLowerCase().trim())
        .filter(Boolean);

      const appliedPercentages = (order.discountApplications?.nodes || [])
        .map((app) => (typeof app.value?.percentage === "number" ? app.value.percentage : null))
        .filter((p) => p !== null);

      if (appliedTitles.length === 0 && appliedPercentages.length === 0) continue;

      // Extract product IDs present in the order's line items
      const orderProductIds = new Set();
      (order.lineItems?.nodes || []).forEach((line) => {
        if (line.product?.id) {
          const fullId = String(line.product.id).trim();
          orderProductIds.add(fullId);
          orderProductIds.add(fullId.split("/").pop());
        }
      });

      const orderCreatedAt = new Date(order.createdAt).getTime();
      const hasMasterSelected = appliedTitles.some((t) => (t.includes("stackup") || t.includes("stack-up")) && t.includes("selected"));
      const hasMasterPaired = appliedTitles.some((t) => (t.includes("stackup") || t.includes("stack-up")) && t.includes("paired"));
      const hasMasterVolume = appliedTitles.some((t) => ((t.includes("stackup") || t.includes("stack-up")) && (t.includes("volume") || t.includes("quantity"))) || t.includes("volume discount") || t.includes("buy more") || t.includes("quantity break"));

      const matchedOffers = [];

      for (const off of allOffers) {
        const title = (off.title || "").toLowerCase().trim();
        const titleMatches = Boolean(title && appliedTitles.some((t) => t === title || t.includes(title)));

        if (titleMatches) {
          matchedOffers.push(off);
          continue;
        }

        const offerTime = new Date(off.createdAt).getTime() - 5 * 60 * 1000;
        if (orderCreatedAt < offerTime) continue;

        if (off.type === "PAIRED") {
          const pctMatches = hasMasterPaired && appliedPercentages.includes(off.percentage);
          let prodMatches = false;
          if (hasMasterPaired) {
            try {
              const mProds = JSON.parse(off.mainProducts || "[]");
              const sProds = JSON.parse(off.subProducts || "[]");
              prodMatches = [...mProds, ...sProds].some((p) => p?.id && (orderProductIds.has(String(p.id)) || orderProductIds.has(String(p.id).split("/").pop())));
            } catch {}
          }
          if (pctMatches || prodMatches) matchedOffers.push(off);
        } else if (off.type === "SELECTED") {
          const pctMatches = hasMasterSelected && appliedPercentages.includes(off.percentage);
          let prodMatches = false;
          if (hasMasterSelected) {
            try {
              const tProds = JSON.parse(off.targetProducts || "[]");
              const oProds = JSON.parse(off.offeredProducts || off.products || "[]");
              prodMatches = [...tProds, ...oProds].some((p) => p?.id && (orderProductIds.has(String(p.id)) || orderProductIds.has(String(p.id).split("/").pop())));
            } catch {}
          }
          if (pctMatches || prodMatches) matchedOffers.push(off);
        } else if (off.type === "VOLUME") {
          let prodMatches = false;
          if (hasMasterVolume) {
            try {
              let vProds = [];
              if (off.volumeProducts) {
                vProds = JSON.parse(off.volumeProducts);
              } else if (off.configuration) {
                vProds = JSON.parse(off.configuration)?.volumeProducts || [];
              }
              prodMatches = vProds.some((p) => p?.id && (orderProductIds.has(String(p.id)) || orderProductIds.has(String(p.id).split("/").pop())));
            } catch {}
          }
          if (prodMatches) matchedOffers.push(off);
        }
      }

      if (matchedOffers.length === 0) continue;

      const totalPrice = parseFloat(order.totalPriceSet?.shopMoney?.amount) || 0;
      const totalDiscounts = parseFloat(order.totalDiscountsSet?.shopMoney?.amount) || 0;
      const currency = order.totalPriceSet?.shopMoney?.currencyCode || "USD";
      const customerEmail = "Customer";

      for (const matchedOffer of matchedOffers) {
        // Calculate allocated discount for this specific offer if line-item allocations exist
        let offerDiscount = 0;
        const targetTitle = (matchedOffer.title || "").toLowerCase().trim();
        (order.lineItems?.nodes || []).forEach((line) => {
          (line.discountAllocations || []).forEach((alloc) => {
            const appTitle = (alloc.discountApplication?.title || alloc.discountApplication?.code || "")?.toLowerCase().trim();
            if (appTitle && (appTitle === targetTitle || appTitle.includes(targetTitle))) {
              offerDiscount += parseFloat(alloc.allocatedAmountSet?.shopMoney?.amount) || 0;
            }
          });
        });

        // Fallback: if not allocated specifically or order discount, divide proportionally or use totalDiscounts
        if (offerDiscount === 0) {
          offerDiscount = matchedOffers.length === 1 ? totalDiscounts : (totalDiscounts / matchedOffers.length);
        }

        const existingUsage = await db.orderUsage.findFirst({
          where: {
            orderId: orderIdStr,
            offerId: matchedOffer.id,
          },
        });

        if (existingUsage) {
          await db.orderUsage.update({
            where: { id: existingUsage.id },
            data: {
              totalPrice,
              discountAmount: offerDiscount,
            },
          });
        } else {
          await db.orderUsage.create({
            data: {
              shop,
              orderId: orderIdStr,
              orderName: order.name,
              customerEmail,
              totalPrice,
              discountAmount: offerDiscount,
              currency,
              offerId: matchedOffer.id,
              createdAt: order.createdAt ? new Date(order.createdAt) : new Date(),
            },
          });
        }
        newlySyncedCount++;
      }
    }

    // Recalculate stats for all offers
    await cleanupMismatchedOrders(shop);

    return newlySyncedCount;
  } catch (err) {
    console.warn("Error running syncRecentOrdersFromShopify:", err);
    return 0;
  }
}
