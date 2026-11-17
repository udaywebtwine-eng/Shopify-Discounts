import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOfferProductIds, safeSaveOrderUsage, cleanupMismatchedOrders } from "../utils/orders.server";

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

  // Extract all applied discount titles, descriptions, codes & percentages
  const appliedTitles = (payload.discount_applications || [])
    .map((app) => (app.title || app.description || app.code)?.toLowerCase().trim())
    .filter(Boolean);

  const appliedCodes = (payload.discount_codes || [])
    .map((c) => c.code?.toLowerCase().trim())
    .filter(Boolean);

  const appliedPercentages = (payload.discount_applications || [])
    .map((app) => parseFloat(app.value))
    .filter((v) => !isNaN(v) && v > 0);

  const orderLines = payload.line_items || [];

  // Extract product IDs present in the order
  const orderProductIds = new Set();
  orderLines.forEach((item) => {
    if (item.product_id) {
      const pid = String(item.product_id).trim();
      orderProductIds.add(pid);
      orderProductIds.add(`gid://shopify/Product/${pid}`);
    }
  });

  // Find all offers for this shop
  let allOffers = [];
  try {
    const shopConditions = [
      { shop },
      { shop: shop.replace(".myshopify.com", "") },
      { shop: `${shop.replace(".myshopify.com", "")}.myshopify.com` },
    ];
    allOffers = await db.offer.findMany({
      where: { OR: shopConditions },
    });
  } catch (err) {
    console.error("-------------------> [Webhook: orders/create] DB query error:", err);
    return new Response();
  }

  if (allOffers.length === 0) {
    console.log("-------------------> [Webhook: orders/create] No Offers found in DB for shop:", shop);
    return new Response();
  }

  const orderTime = payload.created_at ? new Date(payload.created_at).getTime() : Date.now();
  const hasMasterSelected = appliedTitles.some((t) => (t.includes("stackup") || t.includes("stack-up")) && t.includes("selected"));
  const hasMasterPaired = appliedTitles.some((t) => (t.includes("stackup") || t.includes("stack-up")) && t.includes("paired"));
  const hasMasterVolume = appliedTitles.some((t) => ((t.includes("stackup") || t.includes("stack-up")) && (t.includes("volume") || t.includes("quantity"))) || t.includes("volume discount") || t.includes("buy more") || t.includes("quantity break"));

  const matchedOffers = [];

  for (const off of allOffers) {
    // GATE 1: Time Boundary (Strict) - Order MUST be created after the offer was created
    const offerTime = new Date(off.createdAt).getTime() - 2 * 60 * 1000;
    if (orderTime < offerTime) {
      continue;
    }

    // GATE 2: Product Membership (Strict) - Order MUST contain at least one product configured for this offer
    const offerProductIds = getOfferProductIds(off);
    if (offerProductIds.size === 0) continue;

    let hasMatchingProduct = false;
    for (const pid of offerProductIds) {
      if (orderProductIds.has(pid)) {
        hasMatchingProduct = true;
        break;
      }
    }
    if (!hasMatchingProduct) {
      continue;
    }

    // GATE 3: Title or Master Discount Function Match
    const title = (off.title || "").toLowerCase().trim();
    const titleMatches = Boolean(
      title && (appliedTitles.some((t) => t === title || t.includes(title)) || appliedCodes.includes(title))
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
    }

    if (!isMatched) {
      continue;
    }

    // GATE 4: Line Item Extraction & Product Attribution
    const purchasedItems = [];
    let offerAllocatedDiscount = 0;

    // Check line item discount allocations
    const appIndex = Array.isArray(payload.discount_applications)
      ? payload.discount_applications.findIndex((app) => {
          const t = (app.title || app.description || app.code || "")?.toLowerCase().trim();
          return t === title || t.includes(title);
        })
      : -1;

    orderLines.forEach((item) => {
      const pid = item.product_id ? String(item.product_id).trim() : "";
      const gid = `gid://shopify/Product/${pid}`;

      if (offerProductIds.has(pid) || offerProductIds.has(gid)) {
        const itemQty = Number(item.quantity) || 1;
        const unitPrice = parseFloat(item.price) || 0;

        let lineDiscount = 0;
        if (appIndex !== -1 && Array.isArray(item.discount_allocations)) {
          for (const alloc of item.discount_allocations) {
            if (alloc.discount_application_index === appIndex) {
              lineDiscount += parseFloat(alloc.amount) || 0;
            }
          }
        }

        offerAllocatedDiscount += lineDiscount;

        purchasedItems.push({
          productId: gid,
          title: item.title || "Product",
          quantity: itemQty,
          price: unitPrice,
          discountAmount: lineDiscount,
        });
      }
    });

    matchedOffers.push({
      offer: off,
      purchasedItems,
      offerDiscount: offerAllocatedDiscount,
    });
  }

  if (matchedOffers.length === 0) {
    console.log("-------------------> [Webhook: orders/create] No matching Offer found for this order's discounts.");
    return new Response();
  }

  console.log(`-------------------> 🎯 [Webhook: orders/create] Matched ${matchedOffers.length} offers for ${payload.name}:`, matchedOffers.map((m) => m.offer.title).join(", "));

  const totalPrice = parseFloat(payload.total_price) || 0;
  const totalDiscounts = parseFloat(payload.total_discounts) || 0;
  const customerEmail = payload.email || payload.customer?.email || "Customer";
  const currency = payload.currency || "USD";

  try {
    for (const matched of matchedOffers) {
      let finalDiscount = matched.offerDiscount;
      if (finalDiscount === 0) {
        finalDiscount = matchedOffers.length === 1 ? totalDiscounts : (totalDiscounts / matchedOffers.length);
      }

      await safeSaveOrderUsage({
        shop,
        orderId: orderIdStr,
        orderName: payload.name || `#${payload.order_number || payload.id}`,
        customerEmail,
        totalPrice,
        discountAmount: finalDiscount,
        currency,
        purchasedProducts: matched.purchasedItems,
        offerId: matched.offer.id,
        createdAt: payload.created_at ? new Date(payload.created_at) : new Date(),
      });
    }

    // Audit to guarantee numbers match perfectly
    await cleanupMismatchedOrders(shop);

    console.log(`-------------------> 💾 [Webhook: orders/create] Successfully recorded order for ${matchedOffers.length} offers!`);
    console.log("-------------------> ====================================================");
  } catch (dbErr) {
    console.error("-------------------> [Webhook: orders/create] Failed to record order in DB:", dbErr);
  }

  return new Response();
};
