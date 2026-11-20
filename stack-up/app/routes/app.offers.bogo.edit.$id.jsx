import { useState, useMemo, useEffect } from "react";
import {
  useLoaderData,
  useActionData,
  useNavigation,
  useSubmit,
  useSearchParams,
  redirect,
} from "react-router";
import { useAppBridge, SaveBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  getShopTimezone,
  getShopTodayDate,
  formatDateInShopTimezone,
  formatTimeInShopTimezone,
  formatTime12h,
  getTimezoneAbbr,
  generateTimeOptions,
  dateToShopISO,
  setShopTimezoneCache,
  computeOfferStatus,
} from "../utils/timezone";
import { ensureMasterDiscounts } from "../utils/masterDiscount.server";
import {
  syncAllActiveBogoOffersToShopMetafield,
  removeBogoMetafieldFromProducts,
  getBogoBuyProducts,
} from "../utils/bogoMetafields.server";
import { getActiveMainProductsMap, checkMainProductConflicts } from "../utils/productConflicts.server";
import BogoWidgetPreview from "./components/Preview/BogoWidgetPreview";

export const loader = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session?.shop || "";
  const { id: numericId } = params;

  if (!numericId) {
    return redirect("/app/offers");
  }

  // Ensure BOGO Master Discount exists in Shopify Admin
  try {
    await ensureMasterDiscounts(admin);
  } catch (err) {
    console.warn("[BogoEdit:Loader] Could not verify master discounts:", err);
  }

  const shopTimezone = await getShopTimezone(admin, shop);
  if (shop && shopTimezone) {
    setShopTimezoneCache(shop, shopTimezone);
  }
  const timezoneAbbr = getTimezoneAbbr(shopTimezone);

  // Load widget settings & shop currency
  let widgetSettings = null;
  let shopCurrency = "";
  try {
    const res = await admin.graphql(
      `#graphql
      query GetBogoWidgetSettings {
        shop {
          currencyCode
          metafield(namespace: "stack_up", key: "bogo_widget_settings") {
            value
          }
        }
      }`
    );
    const json = await res.json();
    shopCurrency = json.data?.shop?.currencyCode || "";
    const rawVal = json.data?.shop?.metafield?.value;
    if (rawVal) {
      widgetSettings = JSON.parse(rawVal);
    }
  } catch (err) {
    console.warn("Could not load bogo_widget_settings:", err);
  }

  const offer = await prisma.offer.findFirst({
    where: {
      type: "BOGO",
      OR: [
        { numericId },
        { discountId: `gid://shopify/BogoOffer/${numericId}` },
        { discountId: { contains: numericId } },
      ],
    },
  });

  if (!offer) {
    return redirect("/app/offers");
  }

  let buyProducts = [];
  try {
    if (offer.mainProducts) {
      buyProducts = JSON.parse(offer.mainProducts);
    }
  } catch {
    buyProducts = [];
  }

  let getProducts = [];
  try {
    if (offer.subProducts) {
      getProducts = JSON.parse(offer.subProducts);
    }
  } catch {
    getProducts = [];
  }

  let config = {};
  try {
    if (offer.configuration) {
      config = JSON.parse(offer.configuration);
    }
  } catch {
    config = {};
  }

  // Hydrate product details (title, handle, image, price) from Shopify GraphQL
  const allProductIds = [
    ...new Set([
      ...buyProducts.map((p) => p.id),
      ...getProducts.map((p) => p.id),
    ]),
  ].filter(Boolean);

  let productsMap = {};
  if (allProductIds.length > 0) {
    try {
      const prodRes = await admin.graphql(
        `#graphql
        query GetBogoProductDetails($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              title
              handle
              featuredImage {
                url
              }
              variants(first: 50) {
                nodes {
                  id
                  title
                  price
                }
              }
            }
          }
        }`,
        { variables: { ids: allProductIds } }
      );
      const prodJson = await prodRes.json();
      const nodes = prodJson.data?.nodes || [];
      nodes.forEach((n) => {
        if (n && n.id) {
          const rawPrice = n.variants?.nodes?.[0]?.price;
          const price = rawPrice
            ? (String(rawPrice).startsWith("$") ? String(rawPrice) : `$${rawPrice}`)
            : "";
          productsMap[n.id] = {
            title: n.title,
            handle: n.handle || "",
            image: n.featuredImage?.url || "",
            price,
            variants: n.variants?.nodes?.map((v) => ({ id: v.id, title: v.title, price: v.price })) || [],
          };
        }
      });
    } catch (err) {
      console.warn("[BogoEdit:Loader] Error fetching product details from Shopify:", err);
    }
  }

  const enrichedBuyProducts = buyProducts.map((p) => {
    const details = productsMap[p.id] || {};
    return {
      id: p.id,
      title: details.title || p.title || "",
      handle: details.handle || p.handle || "",
      image: details.image || p.image || "",
      price: details.price || p.price || "",
      variants: p.variants && p.variants.length > 0
        ? p.variants.map((v) => {
            const vObj = details.variants?.find((dv) => dv.id === (typeof v === "object" ? v.id : v));
            return {
              id: typeof v === "object" ? v.id : v,
              title: vObj?.title || (typeof v === "object" ? v.title : "") || "Default Title",
              price: vObj?.price || (typeof v === "object" ? v.price : "") || "",
            };
          })
        : details.variants || [],
    };
  });

  const enrichedGetProducts = getProducts.map((p) => {
    const details = productsMap[p.id] || {};
    return {
      id: p.id,
      title: details.title || p.title || "",
      handle: details.handle || p.handle || "",
      image: details.image || p.image || "",
      price: details.price || p.price || "",
      variants: p.variants && p.variants.length > 0
        ? p.variants.map((v) => {
            const vObj = details.variants?.find((dv) => dv.id === (typeof v === "object" ? v.id : v));
            return {
              id: typeof v === "object" ? v.id : v,
              title: vObj?.title || (typeof v === "object" ? v.title : "") || "Default Title",
              price: vObj?.price || (typeof v === "object" ? v.price : "") || "",
            };
          })
        : details.variants || [],
    };
  });

  const inferredDealType = config.dealType || (
    (getProducts && getProducts.length > 0) || (offer.percentage && offer.percentage !== 100)
      ? "BUY_X_GET_Y"
      : "BOGO"
  );

  const inferredDiscountValue = config.discountValue ?? (
    offer.percentage !== null && offer.percentage !== undefined
      ? offer.percentage
      : (inferredDealType === "BOGO" ? 100 : 50)
  );

  const computedStatus = computeOfferStatus({
    startsAt: offer.startsAt,
    endsAt: offer.endsAt,
    status: offer.status,
  });

  const startsAtDate = offer.startsAt ? formatDateInShopTimezone(offer.startsAt, shopTimezone) : "";
  const startsAtTime = offer.startsAt ? formatTimeInShopTimezone(offer.startsAt, shopTimezone, "00:00:00") : "00:00:00";
  const endsAtDate = offer.endsAt ? formatDateInShopTimezone(offer.endsAt, shopTimezone) : "";
  const endsAtTime = offer.endsAt ? formatTimeInShopTimezone(offer.endsAt, shopTimezone, "23:59:59") : "23:59:59";

  // Check used products excluding current offer
  const usedMainMap = await getActiveMainProductsMap({
    shop,
    offerType: "BOGO",
    excludeNumericId: numericId,
    excludeDiscountId: offer.discountId,
  });
  const usedMainProducts = Array.from(usedMainMap.entries()).map(([numId, info]) => ({
    numericId: numId,
    offerTitle: info.offerTitle,
    offerType: info.offerType,
    offerNumericId: info.numericId,
    editUrl: `/app/offers/bogo/edit/${info.numericId}`,
  }));

  return {
    offer: {
      id: offer.id,
      numericId: offer.numericId,
      discountId: offer.discountId,
      title: offer.title,
      widgetTitle: offer.widgetTitle || "",
      status: offer.status,
      computedStatus,
      dealType: inferredDealType,
      buyQty: config.buyQty || 1,
      getQty: config.getQty || 1,
      discountType: config.discountType || "PERCENTAGE",
      discountValue: inferredDiscountValue,
      maxDiscount: config.maxDiscount || "",
      startsAtDate,
      startsAtTime,
      hasEndDate: Boolean(offer.endsAt),
      endsAtDate,
      endsAtTime,
      buyProducts: enrichedBuyProducts,
      getProducts: enrichedGetProducts,
    },
    shopTimezone,
    timezoneAbbr,
    shop,
    shopCurrency,
    usedMainProducts,
    widgetSettings,
  };
};

export const action = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const { id: numericId } = params;
  const formData = await request.formData();
  const intent = formData.get("intent") || "update";

  const offer = await prisma.offer.findFirst({
    where: {
      type: "BOGO",
      OR: [
        { numericId },
        { discountId: `gid://shopify/BogoOffer/${numericId}` },
        { discountId: { contains: numericId } },
      ],
    },
  });

  if (!offer) {
    return redirect("/app/offers");
  }

  // Handle Deactivate
  if (intent === "deactivate") {
    try {
      await prisma.offer.update({
        where: { id: offer.id },
        data: { status: "EXPIRED" },
      });
      const buyProducts = getBogoBuyProducts(offer);
      if (buyProducts.length > 0) {
        await removeBogoMetafieldFromProducts(admin, buyProducts);
      }
      await syncAllActiveBogoOffersToShopMetafield(admin);
      return redirect(`/app/offers/bogo/edit/${numericId}?deactivated=true`);
    } catch (err) {
      console.error("[BogoEdit:DeactivateAction] Error:", err);
      return { error: err instanceof Error ? err.message : "Failed to deactivate offer." };
    }
  }

  // Handle Activate
  if (intent === "activate") {
    try {
      await prisma.offer.update({
        where: { id: offer.id },
        data: { status: "ACTIVE" },
      });
      await syncAllActiveBogoOffersToShopMetafield(admin);
      return redirect(`/app/offers/bogo/edit/${numericId}?activated=true`);
    } catch (err) {
      console.error("[BogoEdit:ActivateAction] Error:", err);
      return { error: err instanceof Error ? err.message : "Failed to activate offer." };
    }
  }

  // Handle Deletion
  if (intent === "delete") {
    try {
      const buyProducts = getBogoBuyProducts(offer);
      await prisma.offer.delete({ where: { id: offer.id } });
      if (buyProducts.length > 0) {
        await removeBogoMetafieldFromProducts(admin, buyProducts);
      }
      await syncAllActiveBogoOffersToShopMetafield(admin);
      return redirect("/app/offers?deleted=true");
    } catch (err) {
      console.error("[BogoEdit:DeleteAction] Error:", err);
      return { error: "Failed to delete promotion. " + (err.message || "") };
    }
  }

  // Handle Update
  const title = (formData.get("title") || "").trim();
  const widgetTitle = (formData.get("widgetTitle") || "").trim();
  const dealType = formData.get("dealType") || "BOGO";
  const buyQty = Math.max(1, parseInt(formData.get("buyQty") || "1", 10));
  const getQty = Math.max(1, parseInt(formData.get("getQty") || "1", 10));
  const discountType = formData.get("discountType") || "PERCENTAGE";
  const discountValue = dealType === "BOGO" ? 100 : Math.max(0, parseFloat(formData.get("discountValue") || "100"));
  const maxDiscountRaw = formData.get("maxDiscount");
  const maxDiscount = maxDiscountRaw && parseFloat(maxDiscountRaw) > 0 ? parseFloat(maxDiscountRaw) : null;

  const buyProductsRaw = formData.get("buyProducts") || "[]";
  const getProductsRaw = formData.get("getProducts") || "[]";

  const startsAtDate = (formData.get("startsAtDate") || "").trim();
  const startsAtTime = (formData.get("startsAtTime") || "00:00:00").trim();
  const hasEndDate = formData.get("hasEndDate") === "true";
  const endsAtDate = hasEndDate ? (formData.get("endsAtDate") || "").trim() : null;
  const endsAtTime = hasEndDate ? (formData.get("endsAtTime") || "23:59:59").trim() : null;

  if (!title) {
    return { error: "Please enter an offer title." };
  }

  let buyProducts = [];
  try {
    buyProducts = JSON.parse(buyProductsRaw);
  } catch {
    buyProducts = [];
  }

  if (!Array.isArray(buyProducts) || buyProducts.length === 0) {
    return { error: "Please select at least one Product for Customer Buy (X)." };
  }

  let getProducts = [];
  if (dealType === "BUY_X_GET_Y") {
    try {
      getProducts = JSON.parse(getProductsRaw);
    } catch {
      getProducts = [];
    }
    if (!Array.isArray(getProducts) || getProducts.length === 0) {
      return { error: "Please select a Reward Product for Customer Get (Y)." };
    }
  }

  // Conflict Check
  const conflictCheck = await checkMainProductConflicts({
    products: buyProducts,
    shop: session?.shop,
    offerType: "BOGO",
    excludeNumericId: numericId,
    excludeDiscountId: offer.discountId,
  });
  if (conflictCheck.hasConflict) {
    const names = conflictCheck.conflictingProducts
      .map((cp) => `"${cp.title || cp.numericId}" (in offer: "${cp.offerTitle}")`)
      .join(", ");
    return {
      error: `${names} already has an active promotion. A product can only have one active promotion at a time.`,
    };
  }

  if (!startsAtDate) {
    return { error: "Please select a start date." };
  }

  if (hasEndDate && !endsAtDate) {
    return { error: "Please select an end date." };
  }

  if (hasEndDate && endsAtDate && startsAtDate) {
    if (endsAtDate < startsAtDate) {
      return { error: "End date must be on or after start date." };
    }
    if (endsAtDate === startsAtDate && endsAtTime <= startsAtTime) {
      return { error: "End time must be after start time on the same day." };
    }
  }

  const shopTimezone = await getShopTimezone(admin, session?.shop);
  const effectiveStartsAt = dateToShopISO(startsAtDate, startsAtTime, shopTimezone) || new Date().toISOString();
  const effectiveEndsAt = hasEndDate && endsAtDate ? dateToShopISO(endsAtDate, endsAtTime, shopTimezone) : undefined;

  const configuration = {
    dealType,
    buyQty: dealType === "BOGO" ? 1 : buyQty,
    getQty: dealType === "BOGO" ? 1 : getQty,
    discountType: dealType === "BOGO" ? "PERCENTAGE" : discountType,
    discountValue,
    maxDiscount,
    sameItem: dealType !== "BUY_X_GET_Y",
  };

  try {
    const oldBuyProducts = getBogoBuyProducts(offer);

    await prisma.offer.update({
      where: { id: offer.id },
      data: {
        title,
        widgetTitle: widgetTitle || null,
        status: offer.status,
        percentage: discountType === "PERCENTAGE" ? discountValue : 0,
        startsAt: effectiveStartsAt ? new Date(effectiveStartsAt) : new Date(),
        endsAt: effectiveEndsAt ? new Date(effectiveEndsAt) : null,
        mainProducts: JSON.stringify(buyProducts),
        subProducts: dealType === "BUY_X_GET_Y" ? JSON.stringify(getProducts) : null,
        configuration: JSON.stringify(configuration),
      },
    });

    // Cleanup old products no longer in this offer
    const newProductIds = new Set(buyProducts.map((p) => String(p.id).split("/").pop()));
    const removedProducts = oldBuyProducts.filter((p) => {
      const pid = String(p.id).split("/").pop();
      return !newProductIds.has(pid);
    });
    if (removedProducts.length > 0) {
      await removeBogoMetafieldFromProducts(admin, removedProducts);
    }

    // Sync active offers
    await syncAllActiveBogoOffersToShopMetafield(admin);

    return redirect("/app/offers?updated=true");
  } catch (err) {
    console.error("[BogoEdit:UpdateAction] Error:", err);
    return { error: "Failed to update promotion. " + (err.message || "") };
  }
};

function getCurrencySymbol(code) {
  if (!code) return "";
  try {
    const parts = new Intl.NumberFormat("en-US", { style: "currency", currency: code }).formatToParts(0);
    const part = parts.find((p) => p.type === "currency");
    return part ? part.value : code;
  } catch {
    return code;
  }
}

export default function BogoEdit() {
  const { offer, shopTimezone, timezoneAbbr, shop, shopCurrency, usedMainProducts, widgetSettings } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const [searchParams, setSearchParams] = useSearchParams();
  const shopify = useAppBridge();

  const isSubmitting = navigation.state === "submitting";
  const currencySymbol = useMemo(() => getCurrencySymbol(shopCurrency), [shopCurrency]);
  const submittingIntent = navigation.formData?.get("intent");
  const isDeactivating = isSubmitting && submittingIntent === "deactivate";
  const isDeleting = isSubmitting && submittingIntent === "delete";
  const isActivating = isSubmitting && submittingIntent === "activate";

  // Handle toast notifications & modal hides based on query params
  useEffect(() => {
    if (searchParams.get("deactivated") === "true") {
      shopify.toast.show("Offer deactivated successfully!");
      shopify.modal.hide("deactivate-offer-modal");
      const modal = document.getElementById("deactivate-offer-modal");
      if (modal?.hideOverlay) {
        modal.hideOverlay();
      }
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete("deactivated");
        return next;
      }, { replace: true });
    }
    if (searchParams.get("activated") === "true") {
      shopify.toast.show("Offer activated successfully!");
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete("activated");
        return next;
      }, { replace: true });
    }
    if (searchParams.get("updated") === "true") {
      shopify.toast.show("Offer updated successfully!");
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete("updated");
        return next;
      }, { replace: true });
    }
  }, [searchParams, shopify, setSearchParams]);

  const [title, setTitle] = useState(offer.title || "");
  const [widgetTitle, setWidgetTitle] = useState(offer.widgetTitle || "");
  const [dealType, setDealType] = useState(offer.dealType || "BOGO");
  const [buyQty, setBuyQty] = useState(offer.buyQty || 1);
  const [getQty, setGetQty] = useState(offer.getQty || 1);
  const [discountType, setDiscountType] = useState(offer.discountType || "PERCENTAGE");
  const [discountValue, setDiscountValue] = useState(offer.discountValue ?? 100);
  const [maxDiscount, setMaxDiscount] = useState(offer.maxDiscount || "");

  const [buyProducts, setBuyProducts] = useState(offer.buyProducts || []);
  const [getProducts, setGetProducts] = useState(offer.getProducts || []);

  const [startsAtDate, setStartsAtDate] = useState(offer.startsAtDate || "");
  const [startsAtTime, setStartsAtTime] = useState(offer.startsAtTime || "00:00:00");
  const [hasEndDate, setHasEndDate] = useState(offer.hasEndDate || false);
  const [endsAtDate, setEndsAtDate] = useState(offer.endsAtDate || "");
  const [endsAtTime, setEndsAtTime] = useState(offer.endsAtTime || "23:59:59");

  const [conflictBanner, setConflictBanner] = useState(null);

  const timeOptions = useMemo(() => generateTimeOptions(), []);

  const handleDealTypeChange = (newType) => {
    setDealType(newType);
    if (newType === "BOGO") {
      setBuyQty(1);
      setGetQty(1);
      setDiscountType("PERCENTAGE");
      setDiscountValue(100);
      setMaxDiscount("");
    } else if (newType === "BUY_X_GET_X") {
      if (discountValue === 0) setDiscountValue(100);
    }
  };

  const handleOpenBuyProductPicker = async () => {
    try {
      const selection = buyProducts.map((p) => ({ id: p.id }));
      const selected = await shopify.resourcePicker({
        type: "product",
        multiple: true,
        action: "select",
        filter: { archived: false, draft: false, query: "status:active" },
        selectionIds: selection,
      });

      if (selected && Array.isArray(selected)) {
        const usedIdMap = new Map((usedMainProducts || []).map((u) => [u.numericId, u]));
        const conflictingItems = [];
        const validSelected = [];

        selected.forEach((p) => {
          const numId = String(p.id).split("/").pop();
          if (usedIdMap.has(numId)) {
            const conflict = usedIdMap.get(numId);
            conflictingItems.push(`"${p.title}" (in offer: "${conflict.offerTitle}")`);
          } else {
            validSelected.push(p);
          }
        });

        if (conflictingItems.length > 0) {
          setConflictBanner({
            message: `${conflictingItems.join(", ")} already has an active offer. A product can only have one active offer at a time.`,
          });
        } else {
          setConflictBanner(null);
        }

        setBuyProducts(
          validSelected.map((p) => {
            const image =
              p.images?.[0]?.originalSrc ||
              p.images?.[0]?.src ||
              p.featuredImage?.url ||
              p.image?.src ||
              "";
            const rawPrice = p.variants?.[0]?.price ?? p.price ?? "";
            const price = rawPrice
              ? (String(rawPrice).startsWith("$") ? String(rawPrice) : `$${rawPrice}`)
              : "";
            return {
              id: p.id,
              title: p.title,
              handle: p.handle || "",
              image,
              price,
              variants: p.variants ? p.variants.map((v) => ({ id: v.id, title: v.title, price: v.price })) : [],
            };
          })
        );
      }
    } catch (err) {
      console.warn("[BogoEdit] Resource picker error:", err);
    }
  };

  const handleOpenGetProductPicker = async () => {
    try {
      const selection = getProducts.map((p) => ({ id: p.id }));
      const selected = await shopify.resourcePicker({
        type: "product",
        multiple: false,
        action: "select",
        filter: { archived: false, draft: false, query: "status:active" },
        selectionIds: selection,
      });

      if (selected && Array.isArray(selected) && selected.length > 0) {
        const p = selected[0];
        const image =
          p.images?.[0]?.originalSrc ||
          p.images?.[0]?.src ||
          p.featuredImage?.url ||
          p.image?.src ||
          "";
        const rawPrice = p.variants?.[0]?.price ?? p.price ?? "";
        const price = rawPrice
          ? (String(rawPrice).startsWith("$") ? String(rawPrice) : `$${rawPrice}`)
          : "";

        setGetProducts([
          {
            id: p.id,
            title: p.title,
            handle: p.handle || "",
            image,
            price,
            variants: p.variants ? p.variants.map((v) => ({ id: v.id, title: v.title, price: v.price })) : [],
          },
        ]);
      }
    } catch (err) {
      console.warn("[BogoEdit] Reward picker error:", err);
    }
  };

  const handleRemoveBuyProduct = (productId) => {
    setBuyProducts(buyProducts.filter((p) => p.id !== productId));
  };

  const handleRemoveAllBuyProducts = () => {
    setBuyProducts([]);
  };

  const handleRemoveGetProduct = () => {
    setGetProducts([]);
  };

  const isDirty = useMemo(() => {
    return (
      title !== offer.title ||
      widgetTitle !== offer.widgetTitle ||
      dealType !== offer.dealType ||
      buyQty !== offer.buyQty ||
      getQty !== offer.getQty ||
      discountType !== offer.discountType ||
      discountValue !== offer.discountValue ||
      maxDiscount !== (offer.maxDiscount || "") ||
      startsAtDate !== offer.startsAtDate ||
      hasEndDate !== offer.hasEndDate ||
      endsAtDate !== offer.endsAtDate ||
      JSON.stringify(buyProducts) !== JSON.stringify(offer.buyProducts) ||
      JSON.stringify(getProducts) !== JSON.stringify(offer.getProducts)
    );
  }, [
    title,
    widgetTitle,
    dealType,
    buyQty,
    getQty,
    discountType,
    discountValue,
    maxDiscount,
    startsAtDate,
    hasEndDate,
    endsAtDate,
    buyProducts,
    getProducts,
    offer,
  ]);

  const handleSubmit = () => {
    const formData = new FormData();
    formData.append("intent", "update");
    formData.append("title", title);
    formData.append("widgetTitle", widgetTitle);
    formData.append("dealType", dealType);
    formData.append("buyQty", String(buyQty));
    formData.append("getQty", String(getQty));
    formData.append("discountType", discountType);
    formData.append("discountValue", String(discountValue));
    formData.append("maxDiscount", maxDiscount);
    formData.append("buyProducts", JSON.stringify(buyProducts));
    formData.append("getProducts", JSON.stringify(getProducts));
    formData.append("startsAtDate", startsAtDate);
    formData.append("startsAtTime", startsAtTime);
    formData.append("hasEndDate", String(hasEndDate));
    if (hasEndDate && endsAtDate) {
      formData.append("endsAtDate", endsAtDate);
      formData.append("endsAtTime", endsAtTime);
    }

    submit(formData, { method: "post" });
  };

  const handleDiscard = () => {
    setTitle(offer.title);
    setWidgetTitle(offer.widgetTitle || "");
    setDealType(offer.dealType);
    setBuyQty(offer.buyQty);
    setGetQty(offer.getQty);
    setDiscountType(offer.discountType);
    setDiscountValue(offer.discountValue);
    setMaxDiscount(offer.maxDiscount || "");
    setBuyProducts(offer.buyProducts || []);
    setGetProducts(offer.getProducts || []);
    setStartsAtDate(offer.startsAtDate || "");
    setStartsAtTime(offer.startsAtTime || "00:00:00");
    setHasEndDate(offer.hasEndDate || false);
    setEndsAtDate(offer.endsAtDate || "");
    setEndsAtTime(offer.endsAtTime || "23:59:59");
    setConflictBanner(null);
  };

  const isDeactivatedOrExpired = offer.status !== "ACTIVE";

  const handleDeactivateOffer = () => {
    const fd = new FormData();
    fd.append("intent", "deactivate");
    submit(fd, { method: "post" });
  };

  const handleActivateOffer = () => {
    const fd = new FormData();
    fd.append("intent", "activate");
    submit(fd, { method: "post" });
  };

  const handleDeleteOffer = () => {
    const fd = new FormData();
    fd.append("intent", "delete");
    submit(fd, { method: "post" });
  };

  return (
    <s-page heading={`Edit BOGO & Buy X Get Y Offer: ${title}`}>
      <s-link slot="breadcrumb-actions" href="/app/offers">
        All Discounts
      </s-link>

      {/* Polaris Web Component More Actions Menu */}
      <s-button
        slot="secondary-actions"
        commandFor="offer-actions"
        loading={isActivating ? "true" : undefined}
        disabled={isSubmitting ? "true" : undefined}
      >
        More actions
      </s-button>

      <s-menu
        id="offer-actions"
        accessibilityLabel="Offer actions"
      >
        {isDeactivatedOrExpired ? (
          <s-button onClick={handleActivateOffer} loading={isActivating ? "true" : undefined} disabled={isSubmitting ? "true" : undefined}>
            Activate
          </s-button>
        ) : (
          <s-button
            commandFor="deactivate-offer-modal"
            command="--show"
            disabled={isSubmitting ? "true" : undefined}
          >
            Deactivate
          </s-button>
        )}

        <s-button
          tone="critical"
          commandFor="delete-offer-modal"
          command="--show"
          disabled={isSubmitting ? "true" : undefined}
        >
          Delete
        </s-button>
      </s-menu>

      {/* Deactivate Confirmation Modal */}
      <s-modal id="deactivate-offer-modal" heading="Deactivate offer?">
        <s-stack gap="base">
          <s-paragraph>
            Are you sure you want to deactivate <b>&ldquo;{title || offer.title}&rdquo;</b>? Customers will no longer receive this discount at checkout.
          </s-paragraph>
          {isDirty && (
            <s-paragraph tone="caution">
              Note: Any unsaved changes you made will be discarded.
            </s-paragraph>
          )}
        </s-stack>

        <s-button
          slot="primary-action"
          variant="primary"
          onClick={handleDeactivateOffer}
          loading={isDeactivating ? "true" : undefined}
          disabled={isSubmitting ? "true" : undefined}
        >
          Deactivate
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="deactivate-offer-modal"
          command="--hide"
          disabled={isSubmitting ? "true" : undefined}
        >
          Cancel
        </s-button>
      </s-modal>

      {/* Delete Confirmation Modal */}
      <s-modal id="delete-offer-modal" heading="Delete offer?">
        <s-stack gap="base">
          <s-paragraph>
            Are you sure you want to delete <b>&ldquo;{title || offer.title}&rdquo;</b>?
          </s-paragraph>
          <s-paragraph tone="critical">
            This action cannot be undone.
          </s-paragraph>
        </s-stack>

        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          commandFor="delete-offer-modal"
          command="--hide"
          onClick={handleDeleteOffer}
          loading={isDeleting ? "true" : undefined}
          disabled={isSubmitting ? "true" : undefined}
        >
          Delete offer
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="delete-offer-modal"
          command="--hide"
          disabled={isSubmitting ? "true" : undefined}
        >
          Cancel
        </s-button>
      </s-modal>

      <SaveBar id="bogo-edit-save-bar" open={isDirty}>
        <button
          type="button"
          variant="primary"
          onClick={handleSubmit}
          loading={isSubmitting ? "true" : undefined}
          disabled={isSubmitting ? "true" : undefined}
        >
          Save
        </button>
        <button
          type="button"
          onClick={handleDiscard}
          disabled={isSubmitting ? "true" : undefined}
        >
          Discard
        </button>
      </SaveBar>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <s-stack gap="base">
          {actionData?.error && (
            <s-banner tone="critical" heading="Could not update promotion">
              <s-paragraph>{actionData.error}</s-paragraph>
            </s-banner>
          )}

          {conflictBanner && (
            <s-banner
              tone="critical"
              heading="Product conflict detected"
              dismissible
              onDismiss={() => setConflictBanner(null)}
            >
              <s-paragraph>{conflictBanner.message}</s-paragraph>
            </s-banner>
          )}

          {/* Section: Offer Details */}
          <s-section heading="Offer details">
            <s-grid gridTemplateColumns="repeat(10, 1fr)" gap="small" justifyContent="center">
              <s-grid-item gridColumn="span 10">
                <s-text-field
                  label="Discount title (Internal & Checkout)"
                  name="title"
                  placeholder="e.g. Buy 1 Get 1 Free (Special BOGO Deal)"
                  value={title}
                  onInput={(e) => setTitle(e.target.value)}
                  details="Shown at checkout and in Shopify Admin when this discount applies."
                  required
                />
              </s-grid-item>

              <s-grid-item gridColumn="span 10">
                <s-text-field
                  label="Widget title (Displayed on Product Page)"
                  name="widgetTitle"
                  placeholder={
                    dealType === "BOGO"
                      ? "e.g. Buy 1 Get 1 with 100% off (leave blank for default)"
                      : discountType === "FIXED_AMOUNT"
                      ? `e.g. Buy ${buyQty} Get ${getQty} with $${discountValue || 10} off (leave blank for default)`
                      : `e.g. Buy ${buyQty} Get ${getQty} with ${discountValue || 50}% off (leave blank for default)`
                  }
                  value={widgetTitle}
                  onInput={(e) => setWidgetTitle(e.target.value)}
                  details="Custom heading shown above the BOGO widget on the storefront for this offer."
                />
              </s-grid-item>
            </s-grid>
          </s-section>

          {/* Section: 1. Promotion Type */}
          <s-section heading="1. Promotion Type">
            <s-paragraph tone="subdued">
              Choose the promotional mechanics for this campaign.
            </s-paragraph>

            <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "10px" }}>
              <label
                onClick={() => handleDealTypeChange("BUY_X_GET_Y")}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "10px",
                  padding: "12px",
                  borderRadius: "8px",
                  border: `1.5px solid ${dealType === "BUY_X_GET_Y" ? "#111827" : "#e5e7eb"}`,
                  background: dealType === "BUY_X_GET_Y" ? "#f9fafb" : "#ffffff",
                  cursor: "pointer",
                }}
              >
                <input
                  type="radio"
                  name="dealTypeRadio"
                  checked={dealType === "BUY_X_GET_Y"}
                  onChange={() => handleDealTypeChange("BUY_X_GET_Y")}
                  style={{ marginTop: "3px", accentColor: "#111827" }}
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: "14px", color: "#111827" }}>
                    Buy X, Get Y (Different products)
                  </div>
                  <div style={{ fontSize: "12px", color: "#6b7280", marginTop: "2px" }}>
                    Customer buys a set quantity and gets a different product at a discount or free.
                  </div>
                </div>
              </label>

              <label
                onClick={() => handleDealTypeChange("BUY_X_GET_X")}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "10px",
                  padding: "12px",
                  borderRadius: "8px",
                  border: `1.5px solid ${dealType === "BUY_X_GET_X" ? "#111827" : "#e5e7eb"}`,
                  background: dealType === "BUY_X_GET_X" ? "#f9fafb" : "#ffffff",
                  cursor: "pointer",
                }}
              >
                <input
                  type="radio"
                  name="dealTypeRadio"
                  checked={dealType === "BUY_X_GET_X"}
                  onChange={() => handleDealTypeChange("BUY_X_GET_X")}
                  style={{ marginTop: "3px", accentColor: "#111827" }}
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: "14px", color: "#111827" }}>
                    Buy X, Get X (Same product reward)
                  </div>
                  <div style={{ fontSize: "12px", color: "#6b7280", marginTop: "2px" }}>
                    Customers buy a set quantity and get more from the same product with a reward.
                  </div>
                </div>
              </label>

              <label
                onClick={() => handleDealTypeChange("BOGO")}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "10px",
                  padding: "12px",
                  borderRadius: "8px",
                  border: `1.5px solid ${dealType === "BOGO" ? "#111827" : "#e5e7eb"}`,
                  background: dealType === "BOGO" ? "#f9fafb" : "#ffffff",
                  cursor: "pointer",
                }}
              >
                <input
                  type="radio"
                  name="dealTypeRadio"
                  checked={dealType === "BOGO"}
                  onChange={() => handleDealTypeChange("BOGO")}
                  style={{ marginTop: "3px", accentColor: "#111827" }}
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: "14px", color: "#111827" }}>
                    Buy One Get One (BOGO)
                  </div>
                  <div style={{ fontSize: "12px", color: "#6b7280", marginTop: "2px" }}>
                    Customer buys 1 item and gets another of the same item 100% free.
                  </div>
                </div>
              </label>
            </div>
          </s-section>

          {/* Section: 2. Customer Buy (X) */}
          <s-section heading="2. Customer Buy (X)">
            <s-stack gap="base">
              <s-paragraph tone="subdued">
                Choose the product page(s) where customers purchase the qualifying trigger item(s).
              </s-paragraph>

              <div style={{ display: "flex", gap: "12px", alignItems: "flex-end" }}>
                <div style={{ width: "130px" }}>
                  <s-number-field
                    label="Buy quantity"
                    value={String(buyQty)}
                    min="1"
                    disabled={dealType === "BOGO" ? "true" : undefined}
                    onInput={(e) => setBuyQty(Math.max(1, parseInt(e.target.value || "1", 10)))}
                  />
                </div>
              </div>

              {/* Browse Bar */}
              <s-stack
                background="subdued"
                padding="small"
                borderRadius="base"
                direction="inline"
                justifyContent="space-between"
                alignItems="center"
              >
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-text weight="bold">
                    {buyProducts.length} Product(s) selected
                  </s-text>
                  {buyProducts.length > 1 && (
                    <s-button
                      type="button"
                      variant="plain"
                      tone="critical"
                      onClick={handleRemoveAllBuyProducts}
                    >
                      Remove all
                    </s-button>
                  )}
                </s-stack>
                <s-button type="button" variant="primary" onClick={handleOpenBuyProductPicker}>
                  Browse Products
                </s-button>
              </s-stack>

              {/* Selected Buy Products List */}
              {buyProducts.length > 0 ? (
                <s-box>
                  {buyProducts.map((p, idx) => (
                    <div key={p.id}>
                      {idx > 0 && <s-divider />}
                      <s-box padding="small-300">
                        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                          <s-stack direction="inline" gap="base" alignItems="center">
                            <img
                              src={p.image || "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-lifestyle-1_large.png"}
                              alt={p.title}
                              style={{ width: "42px", height: "42px", objectFit: "cover", borderRadius: "4px" }}
                            />
                            <s-stack gap="extra-tight">
                              <s-text weight="semibold">{p.title}</s-text>
                              {p.price && (
                                <s-text tone="subdued" size="small">
                                  {p.price}
                                </s-text>
                              )}
                            </s-stack>
                          </s-stack>

                          <s-button
                            type="button"
                            variant="primary"
                            tone="critical"
                            icon="delete"
                            accessibilityLabel={`Remove ${p.title}`}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleRemoveBuyProduct(p.id);
                            }}
                          />
                        </s-stack>
                      </s-box>
                    </div>
                  ))}
                </s-box>
              ) : (
                <s-paragraph tone="subdued">
                  No products selected yet. Click &quot;Browse Products&quot; to pick items.
                </s-paragraph>
              )}
            </s-stack>
          </s-section>

          {/* Section: 3. Customer Get (Y) */}
          <s-section heading="3. Customer Get (Y)">
            <s-stack gap="base">
              {dealType === "BUY_X_GET_Y" ? (
                <>
                  <s-paragraph tone="subdued">
                    Choose the companion/reward product customer receives at a discount or free.
                  </s-paragraph>

                  <div style={{ width: "130px" }}>
                    <s-number-field
                      label="Get quantity"
                      value={String(getQty)}
                      min="1"
                      onInput={(e) => setGetQty(Math.max(1, parseInt(e.target.value || "1", 10)))}
                    />
                  </div>

                  <s-stack
                    background="subdued"
                    padding="small"
                    borderRadius="base"
                    direction="inline"
                    justifyContent="space-between"
                    alignItems="center"
                  >
                    <s-text weight="bold">
                      {getProducts.length} Reward Product selected
                    </s-text>
                    <s-button type="button" variant="primary" onClick={handleOpenGetProductPicker}>
                      {getProducts.length > 0 ? "Change Reward Product" : "Browse Reward Product"}
                    </s-button>
                  </s-stack>

                  {getProducts.length > 0 && (
                    <s-box padding="small-300">
                      <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                        <s-stack direction="inline" gap="base" alignItems="center">
                          <img
                            src={getProducts[0].image || "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-lifestyle-2_large.png"}
                            alt={getProducts[0].title}
                            style={{ width: "42px", height: "42px", objectFit: "cover", borderRadius: "4px" }}
                          />
                          <s-stack gap="extra-tight">
                            <s-text weight="semibold">{getProducts[0].title}</s-text>
                            {getProducts[0].price && (
                              <s-text tone="subdued" size="small">
                                {getProducts[0].price}
                              </s-text>
                            )}
                          </s-stack>
                        </s-stack>

                        <s-button
                          type="button"
                          variant="primary"
                          tone="critical"
                          icon="delete"
                          accessibilityLabel="Remove reward product"
                          onClick={handleRemoveGetProduct}
                        />
                      </s-stack>
                    </s-box>
                  )}
                </>
              ) : dealType === "BUY_X_GET_X" ? (
                <div>
                  <s-paragraph tone="subdued">
                    Get items automatically match the same product as the Buy items.
                  </s-paragraph>
                  <div style={{ width: "130px", marginTop: "12px" }}>
                    <s-number-field
                      label="Get quantity"
                      value={String(getQty)}
                      min="1"
                      onInput={(e) => setGetQty(Math.max(1, parseInt(e.target.value || "1", 10)))}
                    />
                  </div>
                </div>
              ) : (
                <div>
                  <s-paragraph tone="subdued">
                    The free item is 100% identical to the purchased item (Buy 1, Get 1 Free).
                  </s-paragraph>
                  <div style={{ width: "130px", marginTop: "12px" }}>
                    <s-number-field
                      label="Get quantity"
                      value="1"
                      disabled="true"
                    />
                  </div>
                </div>
              )}
            </s-stack>
          </s-section>

          {/* Section: 4. Discount Settings */}
          <s-section heading="4. Discount Settings">
            <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
              <div>
                <s-select
                  label="Discount type"
                  value={discountType}
                  disabled={dealType === "BOGO" ? "true" : undefined}
                  onChange={(e) => setDiscountType(e.target.value)}
                >
                  <s-option value="PERCENTAGE">Percentage</s-option>
                  <s-option value="FIXED_AMOUNT">Fixed amount</s-option>
                </s-select>
              </div>
              <div>
                <s-number-field
                  label="Value *"
                  value={String(discountValue)}
                  disabled={dealType === "BOGO" ? "true" : undefined}
                  suffix={discountType === "PERCENTAGE" ? "%" : (currencySymbol || "Fixed")}
                  onInput={(e) => setDiscountValue(Math.max(0, parseFloat(e.target.value || "0")))}
                />
              </div>
              <div>
                <s-number-field
                  label="Max discount"
                  value={maxDiscount}
                  disabled={dealType === "BOGO" ? "true" : undefined}
                  prefix={currencySymbol}
                  placeholder="Optional cap"
                  onInput={(e) => setMaxDiscount(e.target.value)}
                />
              </div>
            </s-grid>
          </s-section>

          {/* Section: 5. Active Dates */}
          <s-section heading="5. Active Dates">
            <s-stack gap="base">
              <s-paragraph tone="subdued">
                Times are based on your store timezone ({shopTimezone || "UTC"}).
              </s-paragraph>
              <s-grid gridTemplateColumns="repeat(2, 1fr)" gap="base">
                <s-grid-item gridColumn="span 1">
                  <s-text-field
                    label="Start date"
                    type="date"
                    value={startsAtDate}
                    onInput={(e) => setStartsAtDate(e.target.value)}
                  />
                </s-grid-item>

                <s-grid-item gridColumn="span 1">
                  <s-select
                    label={`Start time (${timezoneAbbr})`}
                    value={startsAtTime}
                    onChange={(e) => setStartsAtTime(e.target.value)}
                  >
                    {timeOptions.map((opt) => (
                      <s-option key={opt.value} value={opt.value}>
                        {opt.label}
                      </s-option>
                    ))}
                  </s-select>
                </s-grid-item>

                <s-grid-item gridColumn="span 2">
                  <s-checkbox
                    label="Set end date"
                    checked={hasEndDate}
                    onChange={(e) => {
                      const checked = e.currentTarget.checked;
                      setHasEndDate(checked);
                      if (!checked) {
                        setEndsAtDate("");
                        setEndsAtTime("23:59:59");
                      }
                    }}
                  />
                </s-grid-item>

                {hasEndDate && (
                  <>
                    <s-grid-item gridColumn="span 1">
                      <s-text-field
                        label="End date"
                        type="date"
                        value={endsAtDate}
                        onInput={(e) => setEndsAtDate(e.target.value)}
                      />
                    </s-grid-item>

                    <s-grid-item gridColumn="span 1">
                      <s-select
                        label={`End time (${timezoneAbbr})`}
                        value={endsAtTime}
                        onChange={(e) => setEndsAtTime(e.target.value)}
                      >
                        {timeOptions.map((opt) => (
                          <s-option key={opt.value} value={opt.value}>
                            {opt.label}
                          </s-option>
                        ))}
                      </s-select>
                    </s-grid-item>
                  </>
                )}
              </s-grid>
            </s-stack>
          </s-section>

          {/* Section: Combinations */}
          <s-section heading="Combinations">
            <s-grid
              gridTemplateColumns="auto minmax(0, 1fr)"
              gap="base"
              alignItems="start"
            >
              <s-box
                padding="small"
                background="subdued"
                borderRadius="base"
              >
                <s-icon type="settings" />
              </s-box>

              <s-stack gap="small-100">
                <s-heading type="strong">
                  Managed store-wide in App Settings
                </s-heading>

                <s-paragraph color="subdued">
                  Discount combinations (Product, Order, and Shipping)
                  apply globally across all offers. You can configure
                  them anytime in{" "}
                  <s-link href="/app/settings">
                    Settings → Combinations
                  </s-link>.
                </s-paragraph>
              </s-stack>
            </s-grid>
          </s-section>
        </s-stack>
      </form>

      {/* Right side Sidebar: Summary in slot="aside" */}
      <s-section slot="aside" heading="Summary">
        <s-badge
          slot="supplemental"
          tone={
            offer.computedStatus === "ACTIVE"
              ? "success"
              : offer.computedStatus === "SCHEDULED"
                ? "info"
                : "attention"
          }
        >
          {offer.computedStatus === "ACTIVE"
            ? "Active"
            : offer.computedStatus === "SCHEDULED"
              ? "Scheduled"
              : "Deactivated"}
        </s-badge>
        <s-stack gap="base">
          <s-stack gap="tight">
            <s-text weight="bold">Offer title</s-text>
            <s-paragraph tone={title.trim() ? "default" : "subdued"}>
              {title.trim() || "No title set"}
            </s-paragraph>
          </s-stack>

          <s-stack gap="tight">
            <s-text weight="bold">Promotion type</s-text>
            <s-paragraph tone="subdued">
              • {dealType === "BOGO" ? "Buy 1 Get 1 Free" : dealType === "BUY_X_GET_X" ? `Buy ${buyQty} Get ${getQty} (Same Product)` : `Buy ${buyQty} Get ${getQty} (Different Product)`}
            </s-paragraph>
          </s-stack>

          <s-stack gap="tight">
            <s-text weight="bold">Reward discount</s-text>
            <s-paragraph tone="subdued">
              • {dealType === "BOGO" ? "100% Free" : discountType === "PERCENTAGE" ? `${discountValue}% off` : `${currencySymbol}${discountValue} off per item`}
              {maxDiscount ? ` (Capped at ${currencySymbol}${maxDiscount})` : ""}
            </s-paragraph>
          </s-stack>

          <s-stack gap="tight">
            <s-text weight="bold">Customer Buy Product(s)</s-text>
            {buyProducts.length > 0 ? (
              buyProducts.map((p) => (
                <s-paragraph key={p.id} tone="subdued">
                  • {p.title}
                </s-paragraph>
              ))
            ) : (
              <s-paragraph tone="subdued">• No products selected</s-paragraph>
            )}
          </s-stack>

          <s-stack gap="tight">
            <s-text weight="bold">Customer Get Product</s-text>
            <s-paragraph tone="subdued">
              {dealType === "BUY_X_GET_Y" ? (getProducts[0]?.title ? `• ${getProducts[0].title}` : "• No reward product selected") : "• Matches purchased product"}
            </s-paragraph>
          </s-stack>

          <s-stack gap="tight">
            <s-text weight="bold">Active dates</s-text>
            <s-paragraph tone="subdued">
              • Starts {startsAtDate} at {formatTime12h(startsAtTime)} ({timezoneAbbr})
              {hasEndDate && endsAtDate ? ` • Ends ${endsAtDate} at ${formatTime12h(endsAtTime)} (${timezoneAbbr})` : ""}
            </s-paragraph>
          </s-stack>

          <s-stack gap="tight">
            <s-text weight="bold">Combinations</s-text>
            <s-paragraph tone="subdued">
              • Managed store-wide in <s-link href="/app/settings">Settings</s-link>
            </s-paragraph>
          </s-stack>
        </s-stack>
      </s-section>

      {/* Right side Sidebar: Live Widget Preview in slot="aside" */}
      <BogoWidgetPreview
        dealType={dealType}
        buyQty={buyQty}
        getQty={getQty}
        buyProducts={buyProducts}
        getProducts={getProducts}
        discountType={discountType}
        discountValue={discountValue}
        maxDiscount={maxDiscount}
        widgetTitle={widgetTitle}
        shopDomain={shop}
        widgetSettings={widgetSettings}
        asSection={true}
      />
    </s-page>
  );
}
