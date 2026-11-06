import { authenticate } from "../shopify.server";
import db from "../db.server";
import { cleanupMismatchedOrders } from "../utils/orders.server";

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

  // Extract product IDs present in the order
  const orderProductIds = new Set();
  (payload.line_items || []).forEach((item) => {
    if (item.product_id) {
      const pid = String(item.product_id).trim();
      orderProductIds.add(pid);
      orderProductIds.add(`gid://shopify/Product/${pid}`);
    }
  });

  // Find all active offers for this shop
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
    const title = (off.title || "").toLowerCase().trim();
    const titleMatches = Boolean(title && (appliedTitles.some((t) => t === title || t.includes(title)) || appliedCodes.includes(title)));

    if (titleMatches) {
      matchedOffers.push(off);
      continue;
    }

    const offerTime = new Date(off.createdAt).getTime() - 5 * 60 * 1000;
    if (orderTime < offerTime) continue;

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

  if (matchedOffers.length === 0) {
    console.log("-------------------> [Webhook: orders/create] No matching Offer found for this order's discounts.");
    return new Response();
  }

  console.log(`-------------------> 🎯 [Webhook: orders/create] Matched ${matchedOffers.length} offers for ${payload.name}:`, matchedOffers.map((o) => o.title).join(", "));

  const totalPrice = parseFloat(payload.total_price) || 0;
  const totalDiscounts = parseFloat(payload.total_discounts) || 0;
  const customerEmail = payload.email || payload.customer?.email || "Customer";
  const currency = payload.currency || "USD";

  try {
    for (const matchedOffer of matchedOffers) {
      let offerDiscount = 0;
      const targetTitle = (matchedOffer.title || "").toLowerCase().trim();

      // Check line item discount allocations
      if (Array.isArray(payload.line_items) && Array.isArray(payload.discount_applications)) {
        const appIndex = payload.discount_applications.findIndex((app) => {
          const t = (app.title || app.description || app.code || "")?.toLowerCase().trim();
          return t === targetTitle || t.includes(targetTitle);
        });

        if (appIndex !== -1) {
          for (const item of payload.line_items) {
            for (const alloc of (item.discount_allocations || [])) {
              if (alloc.discount_application_index === appIndex) {
                offerDiscount += parseFloat(alloc.amount) || 0;
              }
            }
          }
        }
      }

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
            orderName: payload.name || `#${payload.order_number || payload.id}`,
            customerEmail,
            totalPrice,
            discountAmount: offerDiscount,
            currency,
            offerId: matchedOffer.id,
            createdAt: payload.created_at ? new Date(payload.created_at) : new Date(),
          },
        });
      }
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
