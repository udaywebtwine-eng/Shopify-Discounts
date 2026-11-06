import { useState, useEffect, useMemo } from "react";
import {
  useLoaderData,
  useActionData,
  useNavigation,
  useSubmit,
  redirect,
} from "react-router";
import { useAppBridge, SaveBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  getShopTimezone,
  getShopTodayDate,
  getShopCurrentTime,
  formatTime12h,
  getTimezoneAbbr,
  generateTimeOptions,
  dateToShopISO,
  setShopTimezoneCache,
} from "../utils/timezone";
import { ensureMasterDiscounts } from "../utils/masterDiscount.server";
import { syncAllActiveVolumeOffersToShopMetafield, normalizeTierToCompact } from "../utils/volumeMetafields.server";
import { getActiveMainProductsMap, checkMainProductConflicts } from "../utils/productConflicts.server";
import VolumeWidgetPreview from "./components/Preview/VolumeWidgetPreview";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session?.shop || "";

  // Ensure Volume Master Discount exists in Shopify Admin
  try {
    await ensureMasterDiscounts(admin);
  } catch (err) {
    console.warn("[VolumeCreate:Loader] Could not verify master discounts:", err);
  }

  const shopTimezone = await getShopTimezone(admin, shop);
  if (shop && shopTimezone) {
    setShopTimezoneCache(shop, shopTimezone);
  }
  const timezoneAbbr = getTimezoneAbbr(shopTimezone);
  const currentTime = getShopCurrentTime(shopTimezone);

  // Products already used in other active volume offers
  const usedMainMap = await getActiveMainProductsMap({ shop, offerType: "VOLUME" });
  const usedMainProducts = Array.from(usedMainMap.entries()).map(([numericId, info]) => ({
    numericId,
    offerTitle: info.offerTitle,
    offerType: info.offerType,
    offerNumericId: info.numericId,
    editUrl: `/app/offers/volume/edit/${info.numericId}`,
  }));

  return { shopTimezone, timezoneAbbr, currentTime, shop, usedMainProducts };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  const title = (formData.get("title") || "").trim();
  const widgetTitle = (formData.get("widgetTitle") || "").trim();
  const productsRaw = formData.get("products") || "[]";
  const tiersRaw = formData.get("tiers") || "[]";

  const combinesWithOrder = formData.get("combinesWithOrder") === "true";
  const combinesWithProduct = formData.get("combinesWithProduct") === "true";
  const combinesWithShipping = formData.get("combinesWithShipping") === "true";
  const startsAtDate = (formData.get("startsAtDate") || formData.get("startsAt") || "").trim();
  const startsAtTime = (formData.get("startsAtTime") || "00:00:00").trim();
  const hasEndDate = formData.get("hasEndDate") === "true";
  const endsAtDate = hasEndDate ? (formData.get("endsAtDate") || formData.get("endsAt") || "").trim() : null;
  const endsAtTime = hasEndDate ? (formData.get("endsAtTime") || "23:59:59").trim() : null;

  if (!title) {
    return { error: "Please enter an offer title." };
  }

  let products = [];
  try {
    products = JSON.parse(productsRaw);
  } catch {
    products = [];
  }

  if (!Array.isArray(products) || products.length === 0) {
    return { error: "Please select at least one Product for this volume discount." };
  }

  let rawTiers = [];
  try {
    rawTiers = JSON.parse(tiersRaw);
  } catch {
    rawTiers = [];
  }

  const compactTiers = rawTiers
    .map(normalizeTierToCompact)
    .filter((t) => t.mq > 0);

  if (compactTiers.length === 0) {
    return { error: "Please add at least one discount tier." };
  }

  // Check for duplicate quantities
  const qtySet = new Set();
  for (const t of compactTiers) {
    if (qtySet.has(t.mq)) {
      return { error: `Duplicate tier quantity: Buy ${t.mq} is defined more than once.` };
    }
    qtySet.add(t.mq);
    if (t.d < 0 || (t.t === "P" && t.d > 100)) {
      return { error: `Discount for Buy ${t.mq} must be between 1 and 100%.` };
    }
  }

  // Check product conflicts
  const conflictCheck = await checkMainProductConflicts({
    products,
    shop: session?.shop,
    offerType: "VOLUME",
  });
  if (conflictCheck.hasConflict) {
    const names = conflictCheck.conflictingProducts
      .map((cp) => `"${cp.title || cp.numericId}" (in offer: "${cp.offerTitle}")`)
      .join(", ");
    return {
      error: `${names} already has an active volume offer. Please deactivate or remove it from the existing offer first.`,
    };
  }

  if (!startsAtDate) {
    return { error: "Please enter a start date." };
  }

  if (hasEndDate && !endsAtDate) {
    return { error: "Please enter an end date." };
  }

  if (hasEndDate && endsAtDate && startsAtDate) {
    if (endsAtDate < startsAtDate) {
      return { error: "End date must be on or after start date." };
    }
    if (endsAtDate === startsAtDate && endsAtTime <= startsAtTime) {
      return { error: "End time must be after start time on the same day." };
    }
  }

  const sanitizedProducts = products.map((p) => ({
    id: p.id,
    title: p.title || "",
    handle: p.handle || "",
    image: p.image || "",
    price: p.price || "",
    variants: Array.isArray(p.variants)
      ? p.variants.map((v) => ({ id: typeof v === "object" ? v.id : v }))
      : [],
  }));

  const shopTimezone = await getShopTimezone(admin, session?.shop);
  const effectiveStartsAt = dateToShopISO(startsAtDate, startsAtTime, shopTimezone) || new Date().toISOString();
  const effectiveEndsAt = hasEndDate && endsAtDate ? dateToShopISO(endsAtDate, endsAtTime, shopTimezone) : undefined;

  const numericId = Date.now().toString();
  const discountId = `gid://shopify/VolumeOffer/${numericId}`;
  const maxDiscountPct = compactTiers.reduce((max, t) => Math.max(max, t.d), 0);

  try {
    try {
      await prisma.offer.create({
        data: {
          shop: session.shop,
          discountId,
          numericId,
          title,
          type: "VOLUME",
          widgetTitle: widgetTitle || null,
          percentage: maxDiscountPct,
          status: "ACTIVE",
          combinesWithOrder,
          combinesWithProduct,
          combinesWithShipping,
          startsAt: effectiveStartsAt ? new Date(effectiveStartsAt) : new Date(),
          endsAt: effectiveEndsAt ? new Date(effectiveEndsAt) : null,
          volumeProducts: JSON.stringify(sanitizedProducts),
          volumeTiers: JSON.stringify(compactTiers),
          configuration: JSON.stringify({
            volumeProducts: sanitizedProducts,
            volumeTiers: compactTiers,
          }),
        },
      });
    } catch (createErr) {
      // If the running dev server holds an older in-memory Prisma client that hasn't reloaded the new columns yet
      if (createErr?.message?.includes("volumeProducts") || createErr?.message?.includes("volumeTiers")) {
        console.warn("[Volume:CreateAction] Prisma client in memory does not yet recognize volumeProducts column, saving in configuration fallback...");
        await prisma.offer.create({
          data: {
            shop: session.shop,
            discountId,
            numericId,
            title,
            type: "VOLUME",
            widgetTitle: widgetTitle || null,
            percentage: maxDiscountPct,
            status: "ACTIVE",
            combinesWithOrder,
            combinesWithProduct,
            combinesWithShipping,
            startsAt: effectiveStartsAt ? new Date(effectiveStartsAt) : new Date(),
            endsAt: effectiveEndsAt ? new Date(effectiveEndsAt) : null,
            configuration: JSON.stringify({
              volumeProducts: sanitizedProducts,
              volumeTiers: compactTiers,
            }),
          },
        });
      } else {
        throw createErr;
      }
    }

    console.log("[Volume:CreateAction] Successfully saved offer to DB with ID:", numericId);

    // Sync to Shopify Metafields
    await syncAllActiveVolumeOffersToShopMetafield(admin);

    return redirect("/app/offers?created=true");
  } catch (err) {
    console.error("[Volume:CreateAction] Error saving offer:", err);
    return { error: err instanceof Error ? err.message : "Failed to create volume offer." };
  }
};

export default function VolumeCreate() {
  const { shopTimezone, timezoneAbbr, currentTime, shop, usedMainProducts } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const todayStr = useMemo(() => getShopTodayDate(shopTimezone), [shopTimezone]);
  const defaultStartTime = currentTime || "00:00:00";
  const timeOptions = useMemo(() => generateTimeOptions(), []);

  // Form State
  const [title, setTitle] = useState("Quantity Breaks (Buy More, Save More)");
  const [widgetTitle, setWidgetTitle] = useState("");
  const [products, setProducts] = useState([]);
  const [tiers, setTiers] = useState([
    { quantity: 1, discountType: "none", value: 0, title: "Buy {quantity}", label: "Standard", badge: "", isDefault: true, mq: 1, d: 0, t: "N", b: "", s: "Standard" },
    { quantity: 2, discountType: "percent", value: 10, title: "Buy {quantity}", label: "Save 10%", badge: "Most popular", isDefault: false, mq: 2, d: 10, t: "P", b: "Most popular", s: "Save 10%" },
    { quantity: 3, discountType: "percent", value: 20, title: "Buy 3+", label: "Save 20%", badge: "", isDefault: false, mq: 3, d: 20, t: "P", b: "", s: "Save 20%" },
  ]);
  const [expandedIndices, setExpandedIndices] = useState({ 0: true });

  const toggleAccordion = (index) => {
    setExpandedIndices((prev) => ({
      ...prev,
      [index]: !prev[index],
    }));
  };

  const [combinesWithProduct, setCombinesWithProduct] = useState(false);
  const [combinesWithOrder, setCombinesWithOrder] = useState(false);
  const [combinesWithShipping, setCombinesWithShipping] = useState(false);

  const [startsAtDate, setStartsAtDate] = useState(todayStr);
  const [startsAtTime, setStartsAtTime] = useState(defaultStartTime);
  const [hasEndDate, setHasEndDate] = useState(false);
  const [endsAtDate, setEndsAtDate] = useState("");
  const [endsAtTime, setEndsAtTime] = useState("23:59:59");

  const [isSaving, setIsSaving] = useState(false);
  const isRedirecting = navigation.state === "loading" && navigation.location?.pathname !== "/app/offers/volume/create";
  const isSubmitting = (isSaving || navigation.state === "submitting" || (navigation.state === "loading" && navigation.formMethod?.toLowerCase() === "post")) && !isRedirecting;

  // Conflict Checking
  const usedProductIds = useMemo(() => {
    return new Set((usedMainProducts || []).map((p) => String(p.numericId)));
  }, [usedMainProducts]);

  const conflictingProducts = useMemo(() => {
    return products.filter((p) => {
      const numId = String(p.id).split("/").pop();
      return usedProductIds.has(numId);
    });
  }, [products, usedProductIds]);

  const conflictBanner = useMemo(() => {
    if (conflictingProducts.length === 0) return null;
    const names = conflictingProducts.map((p) => `"${p.title}"`).join(", ");
    const firstConflict = usedMainProducts.find((p) =>
      conflictingProducts.some((cp) => String(cp.id).split("/").pop() === String(p.numericId))
    );
    return {
      message: `${names} already has an active volume offer. Please deactivate or remove it from the existing offer first.`,
      url: firstConflict?.editUrl || null,
    };
  }, [conflictingProducts, usedMainProducts]);

  // Product Selection using App Bridge ResourcePicker
  const handleOpenProductPicker = async () => {
    try {
      const selection = products.map((p) => ({
        id: p.id,
        variants: (p.variants || []).map((v) => ({ id: typeof v === "object" ? v.id : v })),
      }));

      const selected = await shopify.resourcePicker({
        type: "product",
        multiple: true,
        action: "select",
        filter: { archived: false, draft: false, query: "status:active" },
        selectionIds: selection,
        initialSelectionIds: selection,
      });

      if (selected && Array.isArray(selected)) {
        setProducts(
          selected.map((p) => {
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
              variants: (p.variants || []).map((v) => ({ id: v.id, title: v.title, price: v.price })),
            };
          })
        );
      }
    } catch (err) {
      console.warn("Product picker error or cancelled:", err);
    }
  };

  const handleRemoveProduct = (productId) => {
    setProducts((prev) => prev.filter((p) => p.id !== productId));
  };

  // Tier builder
  const handleAddTier = () => {
    setTiers((prev) => {
      const last = prev[prev.length - 1];
      const nextQty = last ? Number(last.quantity || last.mq) + 1 : 2;
      const nextDisc = last ? Math.min(100, Number(last.value || last.d) + 10) : 10;
      const nextIdx = prev.length;
      setExpandedIndices((exp) => ({ ...exp, [nextIdx]: true }));
      return [
        ...prev,
        {
          quantity: nextQty,
          discountType: "percent",
          value: nextDisc,
          title: "Buy {quantity}",
          label: `Save ${nextDisc}%`,
          badge: "",
          isDefault: false,
          mq: nextQty,
          d: nextDisc,
          t: "P",
          b: "",
          s: `Save ${nextDisc}%`,
        },
      ];
    });
  };

  const handleUpdateTier = (index, field, value) => {
    setTiers((prev) => {
      const copy = [...prev];
      const current = { ...copy[index], [field]: value };
      if (field === "quantity") current.mq = value;
      if (field === "value") current.d = value;
      if (field === "discountType") {
        current.t = value === "fixed" ? "F" : (value === "none" ? "N" : "P");
      }
      if (field === "badge") current.b = value;
      if (field === "label") current.s = value;
      copy[index] = current;
      return copy;
    });
  };

  const handleRemoveTier = (index) => {
    if (tiers.length <= 1) return;
    setTiers((prev) => prev.filter((_, i) => i !== index));
    setExpandedIndices((prev) => {
      const next = {};
      Object.keys(prev).forEach((k) => {
        const kNum = Number(k);
        if (kNum < index) next[kNum] = prev[kNum];
        else if (kNum > index) next[kNum - 1] = prev[kNum];
      });
      return next;
    });
  };

  const handleSetDefaultTier = (index, checked) => {
    setTiers((prev) =>
      prev.map((t, i) => ({
        ...t,
        isDefault: checked ? i === index : false,
      }))
    );
  };

  // Max discount for display
  const maxDiscountPct = useMemo(() => {
    return tiers.reduce((max, t) => {
      const val = Number(t.value ?? t.d ?? 0);
      return Math.max(max, val);
    }, 0);
  }, [tiers]);

  // Dirty State & SaveBar
  const isDirty = Boolean(
    title.trim() !== "Quantity Breaks (Buy More, Save More)" ||
    widgetTitle.trim() !== "" ||
    products.length > 0 ||
    tiers.length !== 3 ||
    combinesWithOrder ||
    combinesWithProduct ||
    combinesWithShipping ||
    startsAtDate !== todayStr ||
    startsAtTime !== defaultStartTime ||
    hasEndDate ||
    endsAtDate !== ""
  );

  const showSaveBar = (isDirty || isSubmitting) && !isRedirecting;

  useEffect(() => {
    if (isRedirecting) {
      setIsSaving(false);
      shopify.saveBar?.hide("create-volume-offer-save-bar");
    }
  }, [isRedirecting, shopify]);

  useEffect(() => {
    if (navigation.state === "idle") {
      setIsSaving(false);
    }
  }, [navigation.state]);

  useEffect(() => {
    return () => {
      shopify.saveBar?.hide("create-volume-offer-save-bar");
    };
  }, [shopify]);

  const handleDiscard = (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setTitle("Quantity Breaks (Buy More, Save More)");
    setWidgetTitle("");
    setProducts([]);
    setTiers([
      { quantity: 1, discountType: "none", value: 0, title: "Buy {quantity}", label: "Standard", badge: "", isDefault: true, mq: 1, d: 0, t: "N", b: "", s: "Standard" },
      { quantity: 2, discountType: "percent", value: 10, title: "Buy {quantity}", label: "Save 10%", badge: "Most popular", isDefault: false, mq: 2, d: 10, t: "P", b: "Most popular", s: "Save 10%" },
      { quantity: 3, discountType: "percent", value: 20, title: "Buy 3+", label: "Save 20%", badge: "", isDefault: false, mq: 3, d: 20, t: "P", b: "", s: "Save 20%" },
    ]);
    setExpandedIndices({ 0: true });
    setCombinesWithOrder(false);
    setCombinesWithProduct(false);
    setCombinesWithShipping(false);
    setStartsAtDate(todayStr);
    setStartsAtTime(defaultStartTime);
    setHasEndDate(false);
    setEndsAtDate("");
    setEndsAtTime("23:59:59");
    setIsSaving(false);
    shopify.saveBar?.hide("create-volume-offer-save-bar");
  };

  useEffect(() => {
    if (actionData?.error) {
      setIsSaving(false);
      shopify.toast.show(actionData.error, { isError: true });
    }
  }, [actionData, shopify]);

  const handleSubmit = () => {
    if (!title.trim()) {
      shopify.toast.show("Please enter an offer title", { isError: true });
      return;
    }
    if (products.length === 0) {
      shopify.toast.show("Please select at least one Product", { isError: true });
      return;
    }
    if (tiers.length === 0) {
      shopify.toast.show("Please add at least one discount tier", { isError: true });
      return;
    }
    if (!startsAtDate || !startsAtDate.trim()) {
      shopify.toast.show("Please enter a start date", { isError: true });
      return;
    }
    if (hasEndDate && (!endsAtDate || !endsAtDate.trim())) {
      shopify.toast.show("Please enter an end date", { isError: true });
      return;
    }
    if (hasEndDate && endsAtDate && startsAtDate) {
      if (endsAtDate < startsAtDate) {
        shopify.toast.show("End date must be on or after start date", { isError: true });
        return;
      }
      if (endsAtDate === startsAtDate && endsAtTime <= startsAtTime) {
        shopify.toast.show("End time must be after start time on the same day", { isError: true });
        return;
      }
    }

    setIsSaving(true);
    try {
      shopify.loading(true);
    } catch { }

    const formData = new FormData();
    formData.append("title", title.trim());
    formData.append("widgetTitle", widgetTitle.trim());
    formData.append("products", JSON.stringify(products));
    formData.append("tiers", JSON.stringify(tiers));
    formData.append("combinesWithOrder", String(combinesWithOrder));
    formData.append("combinesWithProduct", String(combinesWithProduct));
    formData.append("combinesWithShipping", String(combinesWithShipping));
    formData.append("startsAtDate", startsAtDate);
    formData.append("startsAtTime", startsAtTime);
    formData.append("hasEndDate", String(hasEndDate));
    if (hasEndDate && endsAtDate) {
      formData.append("endsAtDate", endsAtDate);
      formData.append("endsAtTime", endsAtTime);
    }

    submit(formData, { method: "post" });
  };

  return (
    <s-page heading="Create Quantity Breaks Offer">
      <s-link slot="breadcrumb-actions" href="/app/offers">
        All Discounts
      </s-link>

      <SaveBar id="create-volume-offer-save-bar" open={showSaveBar}>
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
          {conflictBanner && (
            <s-banner
              tone="critical"
              heading="Product already has an active volume offer"
              dismissible
            >
              <s-paragraph>
                {typeof conflictBanner === "object" ? conflictBanner.message : conflictBanner}
              </s-paragraph>
              {typeof conflictBanner === "object" && conflictBanner.url && (
                <s-button slot="secondary-actions" href={conflictBanner.url}>
                  View conflicting offer
                </s-button>
              )}
            </s-banner>
          )}

          {/* Section: Offer Details */}
          <s-section heading="Offer details">
            <s-grid
              gridTemplateColumns="repeat(10, 1fr)"
              gap="small"
              justifyContent="center"
            >
              <s-grid-item gridColumn="span 7">
                <s-text-field
                  label="Discount title (Internal & Checkout)"
                  name="title"
                  placeholder="e.g. Volume Discount (Buy More, Save More)"
                  value={title}
                  onInput={(e) => setTitle(e.target.value)}
                  details="Shown at checkout and in Shopify Admin when this discount applies."
                  required
                ></s-text-field>
              </s-grid-item>
              <s-grid-item gridColumn="span 3">
                <s-number-field
                  label="Max discount"
                  name="percentage"
                  min="1"
                  max="100"
                  step="1"
                  suffix="%"
                  placeholder="20"
                  value={maxDiscountPct}
                  readOnly
                  details="Auto-calculated from highest tier"
                ></s-number-field>
              </s-grid-item>

              <s-grid-item gridColumn="span 10">
                <s-text-field
                  label="Widget title (Displayed on Product Page)"
                  name="widgetTitle"
                  placeholder="e.g. Buy More, Save More (leave blank for default)"
                  value={widgetTitle}
                  onInput={(e) => setWidgetTitle(e.target.value)}
                  details="Custom heading shown above the quantity breaks widget on the storefront for this offer."
                ></s-text-field>
              </s-grid-item>
            </s-grid>
          </s-section>

          {/* Section: 1. Select Eligible Products */}
          <s-section heading="1. Select Eligible Product(s)">
            <s-stack gap="base">
              <s-paragraph tone="subdued">
                Choose the product page(s) where this volume discount widget will appear and apply.
              </s-paragraph>

              <s-stack gap="base">
                <s-stack
                  background="subdued"
                  padding="small"
                  borderRadius="base"
                  direction="inline"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <s-text weight="bold">
                    {products.length} Product(s) selected
                  </s-text>
                  <s-button type="button" variant="primary" onClick={handleOpenProductPicker}>
                    Browse Products
                  </s-button>
                </s-stack>

                {products.length > 0 ? (
                  <s-box>
                    {products.map((p, idx) => (
                      <div key={p.id}>
                        {idx > 0 && <s-divider />}
                        <s-box padding="small-300">
                          <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                            <s-stack direction="inline" gap="base" alignItems="center">
                              {p.image ? (
                                <s-thumbnail
                                  id={idx}
                                  src={p.image}
                                  alt={p.title}
                                  size="small"
                                />
                              ) : (
                                <s-thumbnail
                                  id={idx}
                                  alt={p.title}
                                  size="small"
                                />
                              )}
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
                                handleRemoveProduct(p.id);
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
            </s-stack>
          </s-section>

          {/* Section: Discount options */}
          <s-section heading="Discount options">
            <s-stack gap="base">
              <div>
                {tiers.map((tier, idx) => {
                  const isExpanded = Boolean(expandedIndices[idx]);
                  return (
                    <div
                      key={idx}
                      style={{
                        background: "#f6f6f7",
                        border: "1px solid #e1e3e5",
                        borderRadius: "12px",
                        marginBottom: "12px",
                        overflow: "hidden",
                        transition: "all 0.15s ease",
                      }}
                    >
                      {/* Header: Clickable to expand/collapse */}
                      <div
                        onClick={() => toggleAccordion(idx)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "14px 18px",
                          cursor: "pointer",
                          userSelect: "none",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                          <span style={{ fontSize: "12px", color: "#475569", display: "flex", alignItems: "center" }}>
                            {isExpanded ? (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="18 15 12 9 6 15" />
                              </svg>
                            ) : (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="6 9 12 15 18 9" />
                              </svg>
                            )}
                          </span>
                          <span
                            style={{
                              fontSize: "13px",
                              fontWeight: 700,
                              letterSpacing: "0.05em",
                              color: "#111827",
                              textTransform: "uppercase",
                            }}
                          >
                            OPTION {idx + 1}
                          </span>
                        </div>

                        <s-button
                          type="button"
                          variant="primary"
                          tone="critical"
                          icon="delete"
                          accessibilityLabel={`Remove Option ${idx + 1}`}
                          disabled={tiers.length <= 1 ? "true" : undefined}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemoveTier(idx);
                          }}
                        />
                      </div>

                      {/* Expanded Content */}
                      {isExpanded && (
                        <div
                          style={{
                            padding: "0 18px 18px 18px",
                            display: "flex",
                            flexDirection: "column",
                            gap: "14px",
                            borderTop: "1px solid #e5e7eb",
                            paddingTop: "16px",
                          }}
                        >
                          {/* Row 1: Quantity, Discount type, Value */}
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "14px" }}>
                            <s-number-field
                              label="Quantity"
                              min="1"
                              step="1"
                              value={String(tier.quantity || tier.mq || 1)}
                              onInput={(e) => handleUpdateTier(idx, "quantity", parseInt(e.target.value, 10) || 1)}
                            ></s-number-field>

                            <s-select
                              label="Discount type"
                              value={tier.discountType || (tier.t === "F" ? "fixed" : (tier.d === 0 || tier.t === "N" ? "none" : "percent"))}
                              onChange={(e) => {
                                const newType = e.target.value;
                                handleUpdateTier(idx, "discountType", newType);
                                if (newType === "none") {
                                  handleUpdateTier(idx, "value", 0);
                                  handleUpdateTier(idx, "d", 0);
                                  handleUpdateTier(idx, "t", "N");
                                } else if (newType === "fixed") {
                                  handleUpdateTier(idx, "t", "F");
                                } else {
                                  handleUpdateTier(idx, "t", "P");
                                }
                              }}
                            >
                              <s-option value="none">No discount</s-option>
                              <s-option value="percent">% discount</s-option>
                              <s-option value="fixed">Fixed amount discount</s-option>
                            </s-select>

                            <s-number-field
                              label="Value"
                              min="0"
                              max={tier.discountType === "percent" ? "100" : undefined}
                              step="1"
                              value={String(tier.value ?? tier.d ?? 0)}
                              disabled={tier.discountType === "none" ? "true" : undefined}
                              onInput={(e) => {
                                const val = parseFloat(e.target.value) || 0;
                                handleUpdateTier(idx, "value", val);
                                handleUpdateTier(idx, "d", val);
                              }}
                            ></s-number-field>
                          </div>

                          {/* Row 2: Title, Label, Badge */}
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "14px" }}>
                            <s-text-field
                              label="Title"
                              placeholder="Buy {quantity}"
                              value={tier.title || `Buy {quantity}`}
                              onInput={(e) => handleUpdateTier(idx, "title", e.target.value)}
                            ></s-text-field>

                            <s-text-field
                              label="Label"
                              placeholder="Standard"
                              value={tier.label ?? tier.s ?? ""}
                              onInput={(e) => {
                                handleUpdateTier(idx, "label", e.target.value);
                                handleUpdateTier(idx, "s", e.target.value);
                              }}
                            ></s-text-field>

                            <s-text-field
                              label="Badge"
                              placeholder="e.g. Most popular"
                              value={tier.badge ?? tier.b ?? ""}
                              onInput={(e) => {
                                handleUpdateTier(idx, "badge", e.target.value);
                                handleUpdateTier(idx, "b", e.target.value);
                              }}
                            ></s-text-field>
                          </div>

                          {/* Row 3: Selected by default checkbox */}
                          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "4px" }}>
                            <input
                              type="checkbox"
                              id={`tier-default-${idx}`}
                              checked={Boolean(tier.isDefault)}
                              onChange={(e) => handleSetDefaultTier(idx, e.target.checked)}
                              style={{ width: "16px", height: "16px", accentColor: "#0f172a", cursor: "pointer" }}
                            />
                            <label
                              htmlFor={`tier-default-${idx}`}
                              style={{
                                fontSize: "13px",
                                fontWeight: 500,
                                color: "#1e293b",
                                cursor: "pointer",
                                display: "flex",
                                alignItems: "center",
                                gap: "5px",
                              }}
                            >
                              Selected by default
                              <span
                                title="When customers view the product page, this tier option will be pre-selected."
                                style={{ color: "#64748b", cursor: "help", fontSize: "14px" }}
                              >
                                ⓘ
                              </span>
                            </label>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div>
                <s-button type="button" onClick={handleAddTier} variant="secondary">
                  + Add option
                </s-button>
              </div>
            </s-stack>
          </s-section>

          {/* Section: Active Dates */}
          <s-section heading="Active dates">
            <s-stack gap="base">
              {shopTimezone && (
                <s-paragraph tone="subdued">
                  Times are based on your store timezone ({shopTimezone}).
                </s-paragraph>
              )}
              <s-grid gridTemplateColumns="repeat(2, 1fr)" gap="base">
                <s-grid-item gridColumn="span 1">
                  <s-date-field
                    label="Start date"
                    value={startsAtDate || ""}
                    allow={`${todayStr}--`}
                    onChange={(e) => setStartsAtDate(e.target.value)}
                  ></s-date-field>
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
                  ></s-checkbox>
                </s-grid-item>

                {hasEndDate && (
                  <>
                    <s-grid-item gridColumn="span 1">
                      <s-date-field
                        label="End date"
                        value={endsAtDate || ""}
                        allow={`${startsAtDate || todayStr}--`}
                        onChange={(e) => setEndsAtDate(e.target.value)}
                      ></s-date-field>
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
        <s-stack gap="base">
          <s-stack gap="tight">
            <s-text weight="bold">Offer title</s-text>
            <s-paragraph tone={title.trim() ? "default" : "subdued"}>
              {title.trim() || "No title set"}
            </s-paragraph>
          </s-stack>

          <s-stack gap="tight">
            <s-text weight="bold">Max discount</s-text>
            <s-paragraph tone="subdued">
              • {maxDiscountPct > 0 ? `${maxDiscountPct}% off (highest tier)` : "No discount configured"}
            </s-paragraph>
          </s-stack>

          <s-stack gap="tight">
            <s-text weight="bold">Eligible product(s)</s-text>
            {products.length > 0 ? (
              products.map((p) => (
                <s-paragraph key={p.id} tone="subdued">
                  • {p.title}
                </s-paragraph>
              ))
            ) : (
              <s-paragraph tone="subdued">• No products selected</s-paragraph>
            )}
          </s-stack>

          <s-stack gap="tight">
            <s-text weight="bold">Configured options</s-text>
            {tiers.length > 0 ? (
              tiers.map((t, i) => {
                const qty = t.quantity || t.mq || 1;
                const val = t.value ?? t.d ?? 0;
                const discLabel = t.discountType === "none" || val === 0
                  ? "Standard price"
                  : (t.discountType === "fixed" || t.t === "F" ? `$${val} off` : `${val}% off`);
                const badgeText = t.badge || t.b;
                return (
                  <s-paragraph key={i} tone="subdued">
                    • Buy {qty}: {discLabel} {badgeText ? `[${badgeText}]` : ""} {t.isDefault ? "• (Default)" : ""}
                  </s-paragraph>
                );
              })
            ) : (
              <s-paragraph tone="subdued">• No options configured</s-paragraph>
            )}
          </s-stack>

          <s-stack gap="tight">
            <s-text weight="bold">Active dates</s-text>
            <s-paragraph tone="subdued">
              • Starts {startsAtDate || todayStr} at {formatTime12h(startsAtTime)} ({timezoneAbbr})
              {hasEndDate && endsAtDate ? ` • Ends ${endsAtDate} at ${formatTime12h(endsAtTime)} (${timezoneAbbr})` : ""}
            </s-paragraph>
          </s-stack>

          <s-stack gap="tight">
            <s-text weight="bold">Combinations</s-text>
            <s-paragraph tone="subdued">
              • Managed store-wide in <s-link href="/app/settings">Settings</s-link>
            </s-paragraph>
          </s-stack>

          <s-stack background="subdued" padding="small" borderRadius="base" gap="small">
            <s-text size="small" weight="bold">How it applies:</s-text>
            <s-paragraph size="small" tone="subdued">
              When a customer purchases qualifying quantities of the selected product, the corresponding tiered discount will be applied automatically at checkout.
            </s-paragraph>
          </s-stack>
        </s-stack>
      </s-section>

      {/* Right side Sidebar: Live Widget Preview */}
      <VolumeWidgetPreview
        title={title}
        widgetTitle={widgetTitle}
        products={products}
        tiers={tiers}
        shopDomain={shop}
      />
    </s-page>
  );
}
