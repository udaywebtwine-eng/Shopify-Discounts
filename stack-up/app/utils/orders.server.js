import db from "../db.server";

/**
 * Syncs and backfills recent orders from Shopify Admin GraphQL into the PostgreSQL database.
 * Supports both PairedProduct offers and SelectedProduct (Add-on) offers.
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
      select: { orderId: true },
    });
    const existingSet = new Set(existingOrders.map((e) => e.orderId));

    let newlySyncedCount = 0;

    for (const order of orders) {
      const orderNumericId = order.id.split("/").pop();
      const orderIdStr = String(orderNumericId);

      // Check if already in DB
      if (existingSet.has(orderIdStr)) continue;

      // Extract applied discount titles and codes
      const appliedTitles = (order.discountApplications?.nodes || [])
        .map((app) => (app.title || app.code)?.toLowerCase().trim())
        .filter(Boolean);

      if (appliedTitles.length === 0) continue;

      // Match with SelectedProductOffer first, then PairedOffer
      let matchedOffer = allSelectedOffers.find((off) => {
        const title = off.title?.toLowerCase().trim();
        return appliedTitles.includes(title);
      });
      let offerType = "SELECTED";

      if (!matchedOffer) {
        matchedOffer = allPairedOffers.find((off) => {
          const title = off.title?.toLowerCase().trim();
          return appliedTitles.includes(title);
        });
        offerType = "PAIRED";
      }

      // Fallback: If only 1 total offer exists across both types
      const totalOffers = allSelectedOffers.length + allPairedOffers.length;
      if (!matchedOffer && totalOffers === 1 && appliedTitles.length > 0) {
        if (allSelectedOffers.length === 1) {
          matchedOffer = allSelectedOffers[0];
          offerType = "SELECTED";
        } else {
          matchedOffer = allPairedOffers[0];
          offerType = "PAIRED";
        }
      }

      if (!matchedOffer) continue;

      const totalPrice = parseFloat(order.totalPriceSet?.shopMoney?.amount) || 0;
      const discountAmount = parseFloat(order.totalDiscountsSet?.shopMoney?.amount) || 0;
      const currency = order.totalPriceSet?.shopMoney?.currencyCode || "USD";
      const customerEmail = "Customer";

      try {
        if (offerType === "SELECTED") {
          await db.orderUsage.create({
            data: {
              shop,
              orderId: orderIdStr,
              orderName: order.name,
              customerEmail,
              totalPrice,
              discountAmount,
              currency,
              selectedOfferId: matchedOffer.id,
              createdAt: order.createdAt ? new Date(order.createdAt) : new Date(),
            },
          });

          await db.selectedProductOffer.update({
            where: { id: matchedOffer.id },
            data: {
              usageCount: { increment: 1 },
              totalRevenue: { increment: totalPrice },
              totalDiscountAmount: { increment: discountAmount },
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
        }

        newlySyncedCount++;
        console.log(`-------------------> 🔄 [OrderSync] Backfilled order ${order.name} ($${totalPrice}) for ${offerType} offer "${matchedOffer.title}"`);
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
