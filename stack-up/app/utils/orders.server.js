import db from "../db.server";

/**
 * Syncs and backfills recent orders from Shopify Admin GraphQL into the PostgreSQL database.
 * This ensures that even existing orders placed before webhook setup have their Total Sales
 * and Total Discounts calculated and displayed accurately.
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
            customer {
              email
              displayName
            }
            discountApplications(first: 10) {
              nodes {
                ... on AutomaticDiscountApplication {
                  title
                }
                ... on DiscountCodeApplication {
                  code
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

    const allOffers = await db.pairedOffer.findMany({ where: { shop } });
    if (allOffers.length === 0) return 0;

    let newlySyncedCount = 0;

    for (const order of orders) {
      const orderNumericId = order.id.split("/").pop();
      const orderIdStr = String(orderNumericId);

      // Check if already in DB
      const existing = await db.orderUsage.findUnique({
        where: { orderId: orderIdStr },
      });
      if (existing) continue;

      // Extract applied discount titles and codes
      const appliedTitles = (order.discountApplications?.nodes || [])
        .map((app) => (app.title || app.code)?.toLowerCase().trim())
        .filter(Boolean);

      if (appliedTitles.length === 0) continue;

      // Match with PairedOffer
      let matchedOffer = allOffers.find((off) => {
        const title = off.title?.toLowerCase().trim();
        return appliedTitles.includes(title);
      });

      // Fallback: If only 1 offer exists and order had a discount
      if (!matchedOffer && allOffers.length === 1 && appliedTitles.length > 0) {
        matchedOffer = allOffers[0];
      }

      if (!matchedOffer) continue;

      const totalPrice = parseFloat(order.totalPriceSet?.shopMoney?.amount) || 0;
      const discountAmount = parseFloat(order.totalDiscountsSet?.shopMoney?.amount) || 0;
      const currency = order.totalPriceSet?.shopMoney?.currencyCode || "USD";
      const customerEmail = order.customer?.email || order.customer?.displayName || "Customer";

      try {
        await db.orderUsage.create({
          data: {
            shop,
            orderId: orderIdStr,
            orderName: order.name,
            customerEmail,
            totalPrice,
            discountAmount,
            currency,
            offerId: matchedOffer.id,
            createdAt: order.createdAt ? new Date(order.createdAt) : new Date(),
          },
        });

        await db.pairedOffer.update({
          where: { id: matchedOffer.id },
          data: {
            usageCount: { increment: 1 },
            totalRevenue: { increment: totalPrice },
            totalDiscountAmount: { increment: discountAmount },
          },
        });

        newlySyncedCount++;
        console.log(`-------------------> 🔄 [OrderSync] Backfilled order ${order.name} ($${totalPrice}) for offer "${matchedOffer.title}"`);
      } catch (err) {
        console.warn("Could not backfill order:", order.name, err);
      }
    }

    return newlySyncedCount;
  } catch (err) {
    console.warn("Error running syncRecentOrdersFromShopify:", err);
    return 0;
  }
}
