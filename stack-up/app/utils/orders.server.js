import db from "../db.server";

/**
 * Cleans up any mismatched or false-backfilled orders from the database
 * (e.g. historical store orders from before the offer was created)
 * and recalculates accurate usage count, total revenue, and discount amounts.
 */
export async function cleanupMismatchedOrders(shop) {
  try {
    const shopConditions = [
      { shop },
      { shop: shop.replace(".myshopify.com", "") },
      { shop: `${shop.replace(".myshopify.com", "")}.myshopify.com` },
    ];

    const [pairedOffers, selectedOffers] = await Promise.all([
      db.pairedOffer.findMany({ where: { OR: shopConditions } }),
      db.selectedProductOffer.findMany({ where: { OR: shopConditions } }),
    ]);

    // 1. Audit Paired Offers
    for (const offer of pairedOffers) {
      const offerCreatedAt = new Date(offer.createdAt).getTime() - 5 * 60 * 1000; // 5 min buffer

      // Find all orders linked to this paired offer that were created after offer existed
      const validOrders = await db.orderUsage.findMany({
        where: {
          offerId: offer.id,
          createdAt: { gte: new Date(offerCreatedAt) },
        },
      });

      // Find any invalid orders (placed before offer existed) and remove link or delete
      const invalidOrders = await db.orderUsage.findMany({
        where: {
          offerId: offer.id,
          createdAt: { lt: new Date(offerCreatedAt) },
        },
      });

      if (invalidOrders.length > 0) {
        for (const inv of invalidOrders) {
          if (inv.selectedOfferId) {
            // If it also had a selected offer, just unlink paired
            await db.orderUsage.update({ where: { id: inv.id }, data: { offerId: null } });
          } else {
            // Delete completely
            await db.orderUsage.delete({ where: { id: inv.id } });
          }
        }
      }

      const newUsageCount = validOrders.length;
      const newRevenue = validOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
      const newDiscount = validOrders.reduce((sum, o) => sum + (o.discountAmount || 0), 0);

      await db.pairedOffer.update({
        where: { id: offer.id },
        data: {
          usageCount: newUsageCount,
          totalRevenue: newRevenue,
          totalDiscountAmount: newDiscount,
        },
      });
    }

    // 2. Audit Selected Product Offers
    for (const offer of selectedOffers) {
      const offerCreatedAt = new Date(offer.createdAt).getTime() - 5 * 60 * 1000;

      const validOrders = await db.orderUsage.findMany({
        where: {
          selectedOfferId: offer.id,
          createdAt: { gte: new Date(offerCreatedAt) },
        },
      });

      const invalidOrders = await db.orderUsage.findMany({
        where: {
          selectedOfferId: offer.id,
          createdAt: { lt: new Date(offerCreatedAt) },
        },
      });

      if (invalidOrders.length > 0) {
        for (const inv of invalidOrders) {
          if (inv.offerId) {
            await db.orderUsage.update({ where: { id: inv.id }, data: { selectedOfferId: null } });
          } else {
            await db.orderUsage.delete({ where: { id: inv.id } });
          }
        }
      }

      const newUsageCount = validOrders.length;
      const newRevenue = validOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
      const newDiscount = validOrders.reduce((sum, o) => sum + (o.discountAmount || 0), 0);

      await db.selectedProductOffer.update({
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
 * Accurately supports combined orders where BOTH Paired and Selected offers apply!
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
              }
            }
            lineItems(first: 50) {
              nodes {
                id
                title
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

    const [allPairedOffers, allSelectedOffers] = await Promise.all([
      db.pairedOffer.findMany({ where: { OR: shopConditions } }),
      db.selectedProductOffer.findMany({ where: { OR: shopConditions } }),
    ]);

    if (allPairedOffers.length === 0 && allSelectedOffers.length === 0) return 0;

    const orderIdStrs = orders.map((o) => String(o.id.split("/").pop()));
    const existingOrders = await db.orderUsage.findMany({
      where: { orderId: { in: orderIdStrs } },
    });
    const existingMap = new Map(existingOrders.map((e) => [e.orderId, e]));

    let newlySyncedCount = 0;

    for (const order of orders) {
      const orderNumericId = order.id.split("/").pop();
      const orderIdStr = String(orderNumericId);
      const existingRecord = existingMap.get(orderIdStr);

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
      const hasMasterSelected = appliedTitles.some((t) => t.includes("stackup selected products"));
      const hasMasterPaired = appliedTitles.some((t) => t.includes("stackup paired products"));

      // 1. Identify matching Selected Product Offer
      let validSelectedOffer = null;
      for (const off of allSelectedOffers) {
        const title = (off.title || "").toLowerCase().trim();
        const offerTime = new Date(off.createdAt).getTime() - 5 * 60 * 1000;
        if (orderCreatedAt < offerTime) continue;

        const titleMatches = appliedTitles.some((t) => t === title || t.includes(title));
        const pctMatches = hasMasterSelected && appliedPercentages.includes(off.percentage);

        // Check if offered or target products match line items
        let prodMatches = false;
        if (hasMasterSelected) {
          try {
            const tProds = JSON.parse(off.targetProducts || "[]");
            const oProds = JSON.parse(off.offeredProducts || off.products || "[]");
            prodMatches = [...tProds, ...oProds].some((p) => p?.id && (orderProductIds.has(String(p.id)) || orderProductIds.has(String(p.id).split("/").pop())));
          } catch {
            prodMatches = false;
          }
        }

        if (titleMatches || pctMatches || prodMatches) {
          validSelectedOffer = off;
          break;
        }
      }

      // 2. Identify matching Paired Offer
      let validPairedOffer = null;
      for (const off of allPairedOffers) {
        const title = (off.title || "").toLowerCase().trim();
        const offerTime = new Date(off.createdAt).getTime() - 5 * 60 * 1000;
        if (orderCreatedAt < offerTime) continue;

        const titleMatches = appliedTitles.some((t) => t === title || t.includes(title));
        const pctMatches = hasMasterPaired && appliedPercentages.includes(off.percentage);

        // Check if main or sub products match line items
        let prodMatches = false;
        if (hasMasterPaired) {
          try {
            const mProds = JSON.parse(off.mainProducts || "[]");
            const sProds = JSON.parse(off.subProducts || "[]");
            prodMatches = [...mProds, ...sProds].some((p) => p?.id && (orderProductIds.has(String(p.id)) || orderProductIds.has(String(p.id).split("/").pop())));
          } catch {
            prodMatches = false;
          }
        }

        if (titleMatches || pctMatches || prodMatches) {
          validPairedOffer = off;
          break;
        }
      }

      // If neither offer matches this order, skip
      if (!validSelectedOffer && !validPairedOffer) continue;

      const totalPrice = parseFloat(order.totalPriceSet?.shopMoney?.amount) || 0;
      const discountAmount = parseFloat(order.totalDiscountsSet?.shopMoney?.amount) || 0;
      const currency = order.totalPriceSet?.shopMoney?.currencyCode || "USD";
      const customerEmail = "Customer";

      if (existingRecord) {
        // If order already in DB, check if missing the paired or selected link
        const needsPairedLink = validPairedOffer && existingRecord.offerId !== validPairedOffer.id;
        const needsSelectedLink = validSelectedOffer && existingRecord.selectedOfferId !== validSelectedOffer.id;

        if (needsPairedLink || needsSelectedLink) {
          await db.orderUsage.update({
            where: { id: existingRecord.id },
            data: {
              ...(needsPairedLink ? { offerId: validPairedOffer.id } : {}),
              ...(needsSelectedLink ? { selectedOfferId: validSelectedOffer.id } : {}),
            },
          });
          console.log(`[OrderSync] 🔗 Updated combined order ${order.name}: Paired=${validPairedOffer?.title || "none"}, Selected=${validSelectedOffer?.title || "none"}`);
        }
      } else {
        // Create new record with BOTH links if combined!
        await db.orderUsage.create({
          data: {
            shop,
            orderId: orderIdStr,
            orderName: order.name,
            customerEmail,
            totalPrice,
            discountAmount,
            currency,
            offerId: validPairedOffer?.id || null,
            selectedOfferId: validSelectedOffer?.id || null,
            createdAt: order.createdAt ? new Date(order.createdAt) : new Date(),
          },
        });
        newlySyncedCount++;
        console.log(`[OrderSync] 💾 Recorded new order ${order.name} ($${totalPrice}): Paired=${validPairedOffer?.title || "none"}, Selected=${validSelectedOffer?.title || "none"}`);
      }
    }

    // Now recalculate accurate offer stats
    await cleanupMismatchedOrders(shop);

    return newlySyncedCount;
  } catch (err) {
    console.warn("Error running syncRecentOrdersFromShopify:", err);
    return 0;
  }
}
