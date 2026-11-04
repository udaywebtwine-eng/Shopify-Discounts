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

  console.log("------------------->   Applied Discount Titles in Order:", appliedTitles);
  console.log("------------------->   Applied Discount Percentages in Order:", appliedPercentages);

  // Find all active offers (both Paired and Selected) for this shop
  let allPairedOffers = [];
  let allSelectedOffers = [];
  try {
    const shopConditions = [
      { shop },
      { shop: shop.replace(".myshopify.com", "") },
      { shop: `${shop.replace(".myshopify.com", "")}.myshopify.com` },
    ];
    allPairedOffers = await db.pairedOffer.findMany({
      where: { OR: shopConditions },
    });
    allSelectedOffers = await db.selectedProductOffer.findMany({
      where: { OR: shopConditions },
    });
  } catch (err) {
    console.error("-------------------> [Webhook: orders/create] DB query error:", err);
    return new Response();
  }

  if (allPairedOffers.length === 0 && allSelectedOffers.length === 0) {
    console.log("-------------------> [Webhook: orders/create] No Offers found in DB for shop:", shop);
    return new Response();
  }

  const orderTime = payload.created_at ? new Date(payload.created_at).getTime() : Date.now();
  const hasMasterSelected = appliedTitles.some((t) => t.includes("stackup selected products"));
  const hasMasterPaired = appliedTitles.some((t) => t.includes("stackup paired products"));

  // 1. Identify matching Selected Product Offer
  let validSelectedOffer = null;
  for (const off of allSelectedOffers) {
    const title = (off.title || "").toLowerCase().trim();
    const offerTime = new Date(off.createdAt).getTime() - 5 * 60 * 1000;
    if (orderTime < offerTime) continue;

    const titleMatches = appliedTitles.some((t) => t === title || t.includes(title)) || appliedCodes.includes(title);
    const pctMatches = hasMasterSelected && appliedPercentages.includes(off.percentage);

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
    if (orderTime < offerTime) continue;

    const titleMatches = appliedTitles.some((t) => t === title || t.includes(title)) || appliedCodes.includes(title);
    const pctMatches = hasMasterPaired && appliedPercentages.includes(off.percentage);

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

  if (!validSelectedOffer && !validPairedOffer) {
    console.log("-------------------> [Webhook: orders/create] No matching Offer found for this order's discounts.");
    return new Response();
  }

  console.log(`-------------------> 🎯 [Webhook: orders/create] Matched offers for ${payload.name}: Selected="${validSelectedOffer?.title || 'none'}", Paired="${validPairedOffer?.title || 'none'}"`);

  // Calculate discount amounts per offer
  function getOfferDiscountAmount(targetOffer) {
    if (!targetOffer) return 0;
    let amount = 0;
    if (Array.isArray(payload.discount_applications)) {
      const targetTitle = (targetOffer.title || "").toLowerCase().trim();
      const targetPct = parseFloat(targetOffer.percentage) || 0;

      const appIndex = payload.discount_applications.findIndex((app) => {
        const title = (app.title || "").toLowerCase().trim();
        const desc = (app.description || "").toLowerCase().trim();
        const code = (app.code || "").toLowerCase().trim();
        const val = parseFloat(app.value) || 0;
        return (
          title === targetTitle ||
          desc === targetTitle ||
          code === targetTitle ||
          title.includes(targetTitle) ||
          desc.includes(targetTitle) ||
          (Math.abs(val - targetPct) < 0.1 && (title.includes("stackup") || desc.includes("stackup")))
        );
      });

      if (appIndex !== -1 && Array.isArray(payload.line_items)) {
        for (const item of payload.line_items) {
          if (Array.isArray(item.discount_allocations)) {
            for (const alloc of item.discount_allocations) {
              if (alloc.discount_application_index === appIndex) {
                amount += parseFloat(alloc.amount) || 0;
              }
            }
          }
        }
      }
    }
    return amount;
  }

  let selectedDiscount = getOfferDiscountAmount(validSelectedOffer);
  let pairedDiscount = getOfferDiscountAmount(validPairedOffer);
  const totalDiscounts = parseFloat(payload.total_discounts) || 0;

  if (validSelectedOffer && !validPairedOffer) {
    selectedDiscount = selectedDiscount || totalDiscounts;
  } else if (validPairedOffer && !validSelectedOffer) {
    pairedDiscount = pairedDiscount || totalDiscounts;
  } else if (validSelectedOffer && validPairedOffer) {
    if (selectedDiscount > 0 && pairedDiscount === 0) {
      pairedDiscount = Math.max(0, totalDiscounts - selectedDiscount);
    } else if (pairedDiscount > 0 && selectedDiscount === 0) {
      selectedDiscount = Math.max(0, totalDiscounts - pairedDiscount);
    } else if (selectedDiscount === 0 && pairedDiscount === 0) {
      const totalPct = (validSelectedOffer.percentage || 10) + (validPairedOffer.percentage || 50);
      selectedDiscount = totalDiscounts * ((validSelectedOffer.percentage || 10) / totalPct);
      pairedDiscount = totalDiscounts - selectedDiscount;
    }
  }

  const totalPrice = parseFloat(payload.total_price) || 0;
  const customerEmail = payload.email || payload.customer?.email || "Customer";

  try {
    // 1. Save single order conversion record with BOTH offer links if combined!
    await db.orderUsage.create({
      data: {
        shop,
        orderId: orderIdStr,
        orderName: payload.name || `#${payload.order_number || payload.id}`,
        customerEmail,
        totalPrice,
        discountAmount: (selectedDiscount + pairedDiscount) || totalDiscounts,
        currency: payload.currency || "USD",
        selectedOfferId: validSelectedOffer?.id || null,
        offerId: validPairedOffer?.id || null,
        createdAt: payload.created_at ? new Date(payload.created_at) : new Date(),
      },
    });

    // 2. Increment Selected Offer stats
    if (validSelectedOffer) {
      await db.selectedProductOffer.update({
        where: { id: validSelectedOffer.id },
        data: {
          usageCount: { increment: 1 },
          totalRevenue: { increment: totalPrice },
          totalDiscountAmount: { increment: selectedDiscount },
        },
      });
    }

    // 3. Increment Paired Offer stats
    if (validPairedOffer) {
      await db.pairedOffer.update({
        where: { id: validPairedOffer.id },
        data: {
          usageCount: { increment: 1 },
          totalRevenue: { increment: totalPrice },
          totalDiscountAmount: { increment: pairedDiscount },
        },
      });
    }

    // 4. Audit to guarantee numbers match perfectly
    await cleanupMismatchedOrders(shop);

    console.log(`-------------------> 💾 [Webhook: orders/create] Successfully recorded order for Selected: ${validSelectedOffer?.title || 'none'} and Paired: ${validPairedOffer?.title || 'none'}!`);
    console.log("-------------------> ====================================================");
  } catch (dbErr) {
    console.error("-------------------> [Webhook: orders/create] Failed to record order in DB:", dbErr);
  }

  return new Response();
};
