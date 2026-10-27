import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { payload, topic, shop } = await authenticate.webhook(request);

  console.log("-------------------> ====================================================");
  console.log(`-------------------> 🔔 [Webhook: ${topic}] Received order for shop: ${shop}`);
  console.log(`------------------->   Order ID: ${payload?.id}, Name: ${payload?.name}`);
  console.log(`------------------->   Total Price: ${payload?.total_price}, Total Discounts: ${payload?.total_discounts}`);

  if (!payload || !payload.id) {
    console.log("-------------------> [Webhook: orders/create] No valid payload received.");
    return new Response();
  }

  const orderIdStr = String(payload.id);

  // Check for duplicate webhook delivery (Idempotency)
  try {
    const existingUsage = await db.orderUsage.findUnique({
      where: { orderId: orderIdStr },
    });
    if (existingUsage) {
      console.log(`-------------------> [Webhook: orders/create] Order ${orderIdStr} (${payload.name}) is already tracked in DB. Skipping.`);
      return new Response();
    }
  } catch (err) {
    console.warn("-------------------> [Webhook: orders/create] Error checking existing order:", err);
  }

  // Extract all applied discount titles & codes from order
  const appliedTitles = (payload.discount_applications || [])
    .map((app) => app.title?.toLowerCase().trim())
    .filter(Boolean);

  const appliedCodes = (payload.discount_codes || [])
    .map((c) => c.code?.toLowerCase().trim())
    .filter(Boolean);

  console.log("------------------->   Applied Discount Titles in Order:", appliedTitles);
  console.log("------------------->   Applied Discount Codes in Order:", appliedCodes);

  // Find all active paired offers for this shop
  let allOffers = [];
  try {
    allOffers = await db.pairedOffer.findMany({
      where: { shop },
    });
  } catch (err) {
    console.error("-------------------> [Webhook: orders/create] DB query error:", err);
    return new Response();
  }

  if (allOffers.length === 0) {
    console.log("-------------------> [Webhook: orders/create] No PairedOffers found in DB for shop:", shop);
    return new Response();
  }

  // Match the order discount to our PairedOffer
  let matchedOffer = allOffers.find((offer) => {
    const title = offer.title?.toLowerCase().trim();
    return appliedTitles.includes(title) || appliedCodes.includes(title);
  });

  // Fallback: If only 1 offer exists and order has automatic discount application
  if (!matchedOffer && allOffers.length === 1 && appliedTitles.length > 0) {
    matchedOffer = allOffers[0];
    console.log("-------------------> [Webhook: orders/create] Single offer fallback match:", matchedOffer.title);
  }

  if (!matchedOffer) {
    console.log("-------------------> [Webhook: orders/create] No matching PairedOffer found for this order's discounts.");
    return new Response();
  }

  console.log(`-------------------> 🎯 [Webhook: orders/create] Matched offer: "${matchedOffer.title}" (ID: ${matchedOffer.numericId})`);

  // Calculate discount amount given by this specific offer
  let discountAmount = 0;
  if (Array.isArray(payload.discount_applications)) {
    const appIndex = payload.discount_applications.findIndex((app) =>
      app.title?.toLowerCase().trim() === matchedOffer.title?.toLowerCase().trim()
    );
    if (appIndex !== -1 && Array.isArray(payload.line_items)) {
      for (const item of payload.line_items) {
        if (Array.isArray(item.discount_allocations)) {
          for (const alloc of item.discount_allocations) {
            if (alloc.discount_application_index === appIndex) {
              discountAmount += parseFloat(alloc.amount) || 0;
            }
          }
        }
      }
    }
  }

  if (discountAmount === 0) {
    discountAmount = parseFloat(payload.total_discounts) || 0;
  }

  const totalPrice = parseFloat(payload.total_price) || 0;
  const customerEmail = payload.email || payload.customer?.email || "Customer";

  try {
    // 1. Save individual order conversion record
    await db.orderUsage.create({
      data: {
        shop,
        orderId: orderIdStr,
        orderName: payload.name || `#${payload.order_number || payload.id}`,
        customerEmail,
        totalPrice,
        discountAmount,
        currency: payload.currency || "USD",
        offerId: matchedOffer.id,
      },
    });

    // 2. Increment offer's usage count and total revenue
    await db.pairedOffer.update({
      where: { id: matchedOffer.id },
      data: {
        usageCount: { increment: 1 },
        totalRevenue: { increment: totalPrice },
        totalDiscountAmount: { increment: discountAmount },
      },
    });

    console.log(`-------------------> 💾 [Webhook: orders/create] Successfully recorded order usage!`);
    console.log(`------------------->    Offer: ${matchedOffer.title}`);
    console.log(`------------------->    Order: ${payload.name}`);
    console.log(`------------------->    Order Total: $${totalPrice.toFixed(2)}, Discount: $${discountAmount.toFixed(2)}`);
    console.log("-------------------> ====================================================");
  } catch (dbErr) {
    console.error("-------------------> [Webhook: orders/create] Failed to record order in DB:", dbErr);
  }

  return new Response();
};
