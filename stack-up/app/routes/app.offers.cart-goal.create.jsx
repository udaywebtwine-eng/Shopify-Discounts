import { useState, useMemo, useEffect } from "react";
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
import { syncAllActiveCartGoalOffersToShopMetafield } from "../utils/cartGoalMetafields.server";
import CartGoalWidgetPreview from "./components/Preview/CartGoalWidgetPreview";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session?.shop || "";

  // Ensure Cart Goal Master Discount node exists in Shopify Admin
  let masterStatus = null;
  try {
    masterStatus = await ensureMasterDiscounts(admin);
  } catch (err) {
    console.warn("[CartGoalCreate:Loader] Could not verify master discounts:", err);
  }

  const shopTimezone = await getShopTimezone(admin, shop);
  if (shop && shopTimezone) {
    setShopTimezoneCache(shop, shopTimezone);
  }
  const timezoneAbbr = getTimezoneAbbr(shopTimezone);
  const currentTime = getShopCurrentTime(shopTimezone);

  const cleanShop = shop.replace(".myshopify.com", "");

  // Fetch count of existing Cart Goal offers for clean auto-titling
  const cartGoalCount = await prisma.offer.count({
    where: {
      type: "CART_GOAL",
      OR: [
        { shop },
        { shop: cleanShop },
        { shop: `${cleanShop}.myshopify.com` },
      ],
    },
  });

  // Check if there is already an existing or active Cart Goal offer
  const existingActiveOffer = await prisma.offer.findFirst({
    where: {
      type: "CART_GOAL",
      status: { not: "DEACTIVATED" },
      OR: [
        { shop },
        { shop: cleanShop },
        { shop: `${cleanShop}.myshopify.com` },
      ],
    },
    select: { id: true, numericId: true, title: true, status: true },
    orderBy: { createdAt: "desc" },
  });

  // Fetch saved widget settings for live preview sync
  let widgetSettings = null;
  let shopCurrency = "";
  try {
    const metaRes = await admin.graphql(
      `#graphql
      query GetCartGoalWidgetSettings {
        shop {
          currencyCode
          metafield(namespace: "stack_up", key: "cart_goal_widget_settings") {
            value
          }
        }
      }`
    );
    const metaJson = await metaRes.json();
    shopCurrency = metaJson.data?.shop?.currencyCode || "";
    const rawVal = metaJson.data?.shop?.metafield?.value;
    if (rawVal) {
      widgetSettings = JSON.parse(rawVal);
    }
  } catch (e) {
    console.warn("[CartGoalCreate:Loader] Failed to fetch cart_goal_widget_settings:", e);
  }

  return {
    shopTimezone,
    timezoneAbbr,
    currentTime,
    shop,
    shopCurrency,
    nextOfferNumber: cartGoalCount + 1,
    hasExistingActiveOffer: Boolean(existingActiveOffer),
    existingActiveOffer,
    isFunctionDeployed: Boolean(masterStatus?.cartGoalMaster),
    widgetSettings,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session?.shop || "";
  const cleanShop = shop.replace(".myshopify.com", "");

  // Server-side validation: Prevent creating another Cart Goal if one already exists
  const existingActiveOffer = await prisma.offer.findFirst({
    where: {
      type: "CART_GOAL",
      status: { not: "DEACTIVATED" },
      OR: [
        { shop },
        { shop: cleanShop },
        { shop: `${cleanShop}.myshopify.com` },
      ],
    },
    select: { id: true, title: true },
  });
  if (existingActiveOffer) {
    return {
      error: `A Cart Goal campaign ("${existingActiveOffer.title}") already exists for this store. Only 1 Cart Goal campaign is allowed. Please edit or delete the existing campaign.`
    };
  }

  const formData = await request.formData();

  const title = (formData.get("title") || "").trim();
  const widgetTitle = (formData.get("widgetTitle") || "").trim();
  const status = formData.get("status") || "ACTIVE";
  const applyTo = formData.get("applyTo") || "ALL";

  const collectionsRaw = formData.get("collections") || "[]";
  const productsRaw = formData.get("products") || "[]";

  let collections = [];
  let products = [];
  try { collections = JSON.parse(collectionsRaw); } catch { }
  try { products = JSON.parse(productsRaw); } catch { }

  const tiersJsonRaw = formData.get("tiers") || "[]";
  let tiers = [];
  try {
    tiers = JSON.parse(tiersJsonRaw);
  } catch {
    return { error: "Invalid tiers configuration data." };
  }

  if (!title) {
    return { error: "Please enter an offer title." };
  }

  if (!Array.isArray(tiers) || tiers.length === 0) {
    return { error: "Please configure at least one tier for the cart goal." };
  }

  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    const minVal = parseFloat(t.minAmount);
    if (isNaN(minVal) || minVal <= 0) {
      return { error: `Tier ${i + 1} must have a minimum cart value greater than 0.` };
    }
    const hasDiscount = Boolean(t.hasDiscount && parseFloat(t.discountValue) > 0);
    const hasShipping = Boolean(t.hasFreeShipping);
    const hasGift = Boolean(t.freeGift && (t.freeGift.variantId || t.freeGift.id || t.freeGift.productId));
    if (!hasDiscount && !hasShipping && !hasGift) {
      return { error: `Tier ${i + 1} must have at least one reward selected (Discount, Free Shipping, or Free Gift).` };
    }
    if (!t.hasDiscount) {
      t.discountValue = 0;
    }
  }

  const startsAtDate = (formData.get("startsAtDate") || formData.get("startsAt") || "").trim();
  const startsAtTime = (formData.get("startsAtTime") || "00:00:00").trim();
  const hasEndDate = formData.get("hasEndDate") === "true";
  const endsAtDate = hasEndDate ? (formData.get("endsAtDate") || formData.get("endsAt") || "").trim() : null;
  const endsAtTime = hasEndDate ? (formData.get("endsAtTime") || "23:59:59").trim() : null;

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

  const shopTimezone = await getShopTimezone(admin, shop);
  const effectiveStartsAt = dateToShopISO(startsAtDate, startsAtTime, shopTimezone) || new Date().toISOString();
  const effectiveEndsAt = hasEndDate && endsAtDate ? dateToShopISO(endsAtDate, endsAtTime, shopTimezone) : undefined;

  const configuration = {
    applyTo,
    collections,
    products,
    tiers,
    widgetTitle,
  };

  try {
    const numericId = Date.now().toString();
    const discountNodeId = `gid://shopify/DiscountAutomaticNode/${numericId}`;

    await prisma.offer.create({
      data: {
        shop,
        discountId: discountNodeId,
        numericId,
        title,
        type: "CART_GOAL",
        status,
        combinesWithOrder: true,
        combinesWithProduct: true,
        combinesWithShipping: true,
        startsAt: effectiveStartsAt,
        endsAt: effectiveEndsAt,
        configuration: JSON.stringify(configuration),
      },
    });

    // Synchronize active Cart Goal offers to shop metafield
    await syncAllActiveCartGoalOffersToShopMetafield(admin);

    // Ensure Master Automatic Discount exists in Shopify Admin
    await ensureMasterDiscounts(admin).catch((e) => {
      console.warn("[CartGoalCreate:Action] ensureMasterDiscounts non-blocking error:", e.message);
    });

    return redirect("/app/offers");
  } catch (err) {
    console.error("[CartGoalCreate:Action] Error creating offer:", err);
    return { error: `Failed to save Cart Goal campaign: ${err.message}` };
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

export default function CartGoalCreateRoute() {
  const {
    shopTimezone,
    timezoneAbbr,
    currentTime,
    nextOfferNumber,
    hasExistingActiveOffer,
    existingActiveOffer,
    isFunctionDeployed,
    shop,
    shopCurrency = "",
    widgetSettings,
  } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const currencySymbol = useMemo(() => getCurrencySymbol(shopCurrency), [shopCurrency]);

  const [isSaving, setIsSaving] = useState(false);
  const isRedirecting = navigation.state === "loading" && navigation.location?.pathname !== "/app/offers/cart-goal/create";
  const isSubmitting = (isSaving || navigation.state === "submitting" || (navigation.state === "loading" && navigation.formMethod?.toLowerCase() === "post")) && !isRedirecting;

  // Form State
  const defaultTitle = `Spend More, Save More #${nextOfferNumber}`;
  const [title, setTitle] = useState(defaultTitle);
  const [widgetTitle, setWidgetTitle] = useState("");
  const [status, setStatus] = useState("ACTIVE");
  const [applyTo, setApplyTo] = useState("ALL"); // "ALL" | "COLLECTIONS" | "PRODUCTS"
  const [selectedCollections, setSelectedCollections] = useState([]);
  const [selectedProducts, setSelectedProducts] = useState([]);

  // Progressive Tiers Builder State
  const [activeTierTab, setActiveTierTab] = useState(0);
  const [tiers, setTiers] = useState([
    {
      minAmount: 100,
      discountType: "PERCENTAGE",
      discountValue: 10,
      hasDiscount: true,
      hasFreeShipping: false,
      freeGift: null,
      maxCap: "",
      label: "10% off",
      showFreeGift: false,
      showMaxCap: false,
    },
  ]);

  // Dates in shop's timezone
  const todayStr = getShopTodayDate(shopTimezone);
  const defaultStartTime = "00:00:00";
  const [startsAtDate, setStartsAtDate] = useState(todayStr);
  const [startsAtTime, setStartsAtTime] = useState(defaultStartTime);
  const [hasEndDate, setHasEndDate] = useState(false);
  const [endsAtDate, setEndsAtDate] = useState("");
  const [endsAtTime, setEndsAtTime] = useState("23:59:59");
  const tzAbbr = timezoneAbbr || getTimezoneAbbr(shopTimezone);

  const startTimeOptions = useMemo(() => generateTimeOptions(false, defaultStartTime), [defaultStartTime]);
  const endTimeOptions = useMemo(() => generateTimeOptions(true), []);

  // Active Tier helper
  const currentTier = tiers[activeTierTab] || tiers[0];

  const computeTierLabel = (tier, idx) => {
    const parts = [];
    const val = parseFloat(tier.discountValue) || 0;
    if (tier.hasDiscount && val > 0) {
      parts.push(tier.discountType === "FIXED_AMOUNT" ? `${currencySymbol}${val} off` : `${val}% off`);
    }
    if (tier.hasFreeShipping) {
      parts.push("Free Shipping");
    }
    if (tier.freeGift && (tier.freeGift.title || tier.freeGift.variantId)) {
      parts.push(`Free ${tier.freeGift.title || "Gift"}`);
    }
    return parts.length > 0 ? parts.join(" + ") : `Tier ${idx + 1}`;
  };

  const updateCurrentTier = (field, value) => {
    setTiers((prev) => {
      const next = [...prev];
      if (next[activeTierTab]) {
        const updated = { ...next[activeTierTab], [field]: value };
        updated.label = computeTierLabel(updated, activeTierTab);
        next[activeTierTab] = updated;
      }
      return next;
    });
  };

  const handleAddTier = () => {
    const lastTier = tiers[tiers.length - 1];
    const nextMin = lastTier ? (Number(lastTier.minAmount) || 0) + 100 : 100;

    const newTier = {
      minAmount: nextMin,
      discountType: "PERCENTAGE",
      discountValue: 0,
      hasDiscount: false,
      hasFreeShipping: false,
      freeGift: null,
      maxCap: "",
      label: `Tier ${tiers.length + 1}`,
      showFreeGift: false,
      showMaxCap: false,
    };

    setTiers((prev) => [...prev, newTier]);
    setActiveTierTab(tiers.length);
  };

  const handleRemoveTier = (indexToRemove) => {
    if (tiers.length <= 1) return;
    setTiers((prev) => prev.filter((_, idx) => idx !== indexToRemove));
    setActiveTierTab((prev) => (prev >= indexToRemove && prev > 0 ? prev - 1 : prev));
  };

  // Open Shopify Resource Picker for Free Gift Product Variant
  const handleOpenGiftPicker = async () => {
    try {
      const selected = await shopify.resourcePicker({
        type: "product",
        multiple: false,
        action: "select",
        filter: { archived: false, draft: false, query: "status:active" },
      });

      if (selected && Array.isArray(selected) && selected.length > 0) {
        const product = selected[0];
        const variant = product.variants?.[0] || {};
        const image = product.images?.[0]?.originalSrc || product.featuredImage?.url || "";

        updateCurrentTier("freeGift", {
          productId: product.id,
          variantId: variant.id,
          title: product.title,
          variantTitle: variant.title || "Default Variant",
          price: parseFloat(variant.price || 0) || 0,
          image,
        });
      }
    } catch (err) {
      console.warn("[CartGoalCreate] Error in gift picker:", err);
    }
  };

  // Open Resource Picker for Collections
  const handleOpenCollectionPicker = async () => {
    try {
      const selected = await shopify.resourcePicker({
        type: "collection",
        multiple: true,
        action: "select",
      });
      if (selected && Array.isArray(selected)) {
        setSelectedCollections(selected.map((c) => ({ id: c.id, title: c.title, handle: c.handle })));
      }
    } catch (err) {
      console.warn("[CartGoalCreate] Error in collection picker:", err);
    }
  };

  // Open Resource Picker for Products
  const handleOpenProductPicker = async () => {
    try {
      const selected = await shopify.resourcePicker({
        type: "product",
        multiple: true,
        action: "select",
        filter: { archived: false, draft: false, query: "status:active" },
      });
      if (selected && Array.isArray(selected)) {
        setSelectedProducts(selected.map((p) => ({
          id: p.id,
          title: p.title,
          handle: p.handle || "",
          image: p.images?.[0]?.originalSrc || p.featuredImage?.url || "",
          variants: Array.isArray(p.variants) ? p.variants.map((v) => ({
            id: v.id,
            title: v.title,
            price: parseFloat(v.price) || 0,
          })) : [],
        })));
      }
    } catch (err) {
      console.warn("[CartGoalCreate] Error in product picker:", err);
    }
  };

  // Dirty State Calculation
  const isDirty = Boolean(
    title.trim() !== defaultTitle ||
    widgetTitle.trim() !== "" ||
    status !== "ACTIVE" ||
    applyTo !== "ALL" ||
    selectedCollections.length > 0 ||
    selectedProducts.length > 0 ||
    tiers.length > 1 ||
    tiers[0]?.minAmount !== 100 ||
    tiers[0]?.discountValue !== 10 ||
    tiers[0]?.hasFreeShipping ||
    tiers[0]?.freeGift !== null ||
    tiers[0]?.showMaxCap ||
    startsAtDate !== todayStr ||
    startsAtTime !== defaultStartTime ||
    hasEndDate ||
    endsAtDate !== ""
  );

  const showSaveBar = (isDirty || isSubmitting) && !isRedirecting;

  useEffect(() => {
    if (isRedirecting) {
      setIsSaving(false);
      shopify.saveBar?.hide("create-cart-goal-save-bar");
    }
  }, [isRedirecting, shopify]);

  useEffect(() => {
    if (navigation.state === "idle") {
      setIsSaving(false);
    }
  }, [navigation.state]);

  useEffect(() => {
    return () => {
      shopify.saveBar?.hide("create-cart-goal-save-bar");
    };
  }, [shopify]);

  const handleDiscard = (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setTitle(defaultTitle);
    setWidgetTitle("");
    setStatus("ACTIVE");
    setApplyTo("ALL");
    setExclusionsEnabled(false);
    setSelectedCollections([]);
    setSelectedProducts([]);
    setTiers([
      {
        minAmount: 100,
        discountType: "PERCENTAGE",
        discountValue: 10,
        hasFreeShipping: false,
        freeGift: null,
        maxCap: "",
        label: "10% off",
        showFreeGift: false,
        showFreeShipping: false,
        showMaxCap: false,
      },
    ]);
    setActiveTierTab(0);
    setStartsAtDate(todayStr);
    setStartsAtTime(defaultStartTime);
    setHasEndDate(false);
    setEndsAtDate("");
    setEndsAtTime("23:59:59");
    setIsSaving(false);
    shopify.saveBar?.hide("create-cart-goal-save-bar");
  };

  useEffect(() => {
    if (actionData?.error) {
      setIsSaving(false);
      shopify.toast.show(actionData.error, { isError: true });
    }
  }, [actionData, shopify]);

  const handleSubmit = () => {
    if (hasExistingActiveOffer) {
      shopify.toast.show(
        `A Cart Goal already exists ("${existingActiveOffer?.title || "Active Campaign"}"). Only 1 Cart Goal campaign can run at a time.`,
        { isError: true }
      );
      return;
    }
    if (!title.trim()) {
      shopify.toast.show("Please enter an offer title", { isError: true });
      return;
    }
    for (let i = 0; i < tiers.length; i++) {
      const min = parseFloat(tiers[i].minAmount);
      if (isNaN(min) || min <= 0) {
        shopify.toast.show(`Tier ${i + 1} must have a valid minimum cart value greater than 0`, { isError: true });
        return;
      }
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

    const formData = new FormData();
    formData.append("title", title);
    formData.append("widgetTitle", widgetTitle);
    formData.append("status", status);
    formData.append("applyTo", applyTo);
    formData.append("collections", JSON.stringify(selectedCollections));
    formData.append("products", JSON.stringify(selectedProducts));
    formData.append("tiers", JSON.stringify(tiers));

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
    <s-page heading="Create Cart Goal Offer">
      <s-link slot="breadcrumb-actions" href="/app/offers">
        All Discounts
      </s-link>

      <SaveBar id="create-cart-goal-save-bar" open={showSaveBar}>
        <button
          type="button"
          variant="primary"
          onClick={handleSubmit}
          loading={isSubmitting ? "true" : undefined}
          disabled={(isSubmitting || hasExistingActiveOffer) ? "true" : undefined}
        >
          {hasExistingActiveOffer ? "Campaign Already Exists" : "Save"}
        </button>
        <button
          type="button"
          onClick={handleDiscard}
          disabled={isSubmitting ? "true" : undefined}
        >
          Discard
        </button>
      </SaveBar>

      <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
        <s-stack gap="base">
          {actionData?.error && (
            <s-banner tone="critical" heading="Cannot save campaign" dismissible>
              <s-paragraph>{actionData.error}</s-paragraph>
            </s-banner>
          )}

          {hasExistingActiveOffer && (
            <s-banner tone="critical" heading="Cannot Create: Cart Goal Already Exists">
              <s-paragraph>
                You already have an active Cart Goal campaign (<strong>{existingActiveOffer?.title || "Active Campaign"}</strong>).
                To maintain a clean cart experience, only one Cart Goal campaign can be active at a time.
              </s-paragraph>
              <s-stack direction="inline" gap="small" paddingBlockStart="small">
                {existingActiveOffer?.id && (
                  <s-button variant="primary" href={`/app/offers/cart-goal/edit/${existingActiveOffer.id}`}>
                    Edit Existing Campaign
                  </s-button>
                )}
                <s-button variant="secondary" href="/app/offers">
                  View All Discounts
                </s-button>
              </s-stack>
            </s-banner>
          )}

          {!isFunctionDeployed && (
            <s-banner tone="warning" heading="Deploy Function to Enable Checkout Discounts" dismissible>
              <s-paragraph>
                The storefront progress bar is active. To enable automatic checkout discounts (10% off, free shipping, etc.) in Shopify Checkout, deploy the extension to your store by running:
              </s-paragraph>
              <s-paragraph>
                <code>shopify app deploy</code>
              </s-paragraph>
            </s-banner>
          )}

          {/* Section: Offer Details */}
          <s-section heading="Offer details">
            <s-grid gridTemplateColumns="1fr" gap="base">
              <s-text-field
                label="Discount title (Internal & Checkout)"
                name="title"
                placeholder="e.g. Spend More, Save More (Tiered Savings)"
                value={title}
                onInput={(e) => setTitle(e.target.value)}
                details="Shown at checkout and in Shopify Admin when this discount applies."
                required
              ></s-text-field>

              <s-text-field
                label="Widget title (Displayed on Cart Drawer & Cart Page)"
                name="widgetTitle"
                placeholder="e.g. Spend More, Save More (leave blank for default)"
                value={widgetTitle}
                onInput={(e) => setWidgetTitle(e.target.value)}
                details="Custom heading shown above the progress bar on the storefront for this offer."
              ></s-text-field>
            </s-grid>
          </s-section>

          {/* Section: 1. Select Eligible Products */}
          <s-section heading="1. Select Eligible Products & Exclusions">
            <s-stack gap="base">
              <s-paragraph tone="subdued">
                Choose whether all items in the cart contribute toward unlocking the goal, or only items from specific collections or products.
              </s-paragraph>

              <s-select
                label="Applies to"
                value={applyTo}
                onChange={(e) => setApplyTo(e.target.value)}
              >
                <s-option value="ALL">All products</s-option>
                <s-option value="COLLECTIONS">Specific collections</s-option>
                <s-option value="PRODUCTS">Specific products</s-option>
              </s-select>

              {applyTo === "COLLECTIONS" && (
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
                      {selectedCollections.length} Collection(s) selected
                    </s-text>
                    <s-button type="button" variant="primary" onClick={handleOpenCollectionPicker}>
                      Browse Collections
                    </s-button>
                  </s-stack>

                  {selectedCollections.length > 0 ? (
                    <s-box>
                      {selectedCollections.map((c, idx) => (
                        <div key={c.id}>
                          {idx > 0 && <s-divider />}
                          <s-box padding="small-300">
                            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                              <s-text weight="semibold">{c.title}</s-text>
                              <s-button
                                type="button"
                                variant="primary"
                                tone="critical"
                                icon="delete"
                                accessibilityLabel={`Remove ${c.title}`}
                                onClick={() => setSelectedCollections((prev) => prev.filter((item) => item.id !== c.id))}
                              />
                            </s-stack>
                          </s-box>
                        </div>
                      ))}
                    </s-box>
                  ) : (
                    <s-paragraph tone="subdued">
                      No collections selected yet. Click &quot;Browse Collections&quot; to pick.
                    </s-paragraph>
                  )}
                </s-stack>
              )}

              {applyTo === "PRODUCTS" && (
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
                      {selectedProducts.length} Product(s) selected
                    </s-text>
                    <s-button type="button" variant="primary" onClick={handleOpenProductPicker}>
                      Browse Products
                    </s-button>
                  </s-stack>

                  {selectedProducts.length > 0 ? (
                    <s-box>
                      {selectedProducts.map((p, idx) => (
                        <div key={p.id}>
                          {idx > 0 && <s-divider />}
                          <s-box padding="small-300">
                            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                              <s-stack direction="inline" gap="base" alignItems="center">
                                {p.image ? (
                                  <s-thumbnail src={p.image} alt={p.title} size="small" />
                                ) : (
                                  <s-thumbnail alt={p.title} size="small" />
                                )}
                                <s-text weight="semibold">{p.title}</s-text>
                              </s-stack>
                              <s-button
                                type="button"
                                variant="primary"
                                tone="critical"
                                icon="delete"
                                accessibilityLabel={`Remove ${p.title}`}
                                onClick={() => setSelectedProducts((prev) => prev.filter((item) => item.id !== p.id))}
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
              )}
            </s-stack>
          </s-section>

          {/* Section: 2. Tiers & Rewards */}
          <s-section heading="2. Cart Goal Tiers & Rewards">
            <s-stack gap="base">
              <s-paragraph tone="subdued">
                Configure progressive cart value milestones. Customers unlock higher discounts, free shipping, or free gifts as their cart value grows.
              </s-paragraph>

              {/* Horizontal Tier Tabs + Add Tier Button */}
              <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  {tiers.map((t, idx) => (
                    <s-button
                      key={idx}
                      type="button"
                      variant={activeTierTab === idx ? "primary" : "secondary"}
                      onClick={() => setActiveTierTab(idx)}
                    >
                      Tier {idx + 1}
                    </s-button>
                  ))}
                </s-stack>

                <s-button
                  type="button"
                  variant="tertiary"
                  onClick={handleAddTier}
                >
                  + Add tier
                </s-button>
              </s-stack>

              <s-divider />

              {/* Active Tier Details */}
              {currentTier && (
                <s-stack gap="base">
                  <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                    <s-text weight="bold">Tier {activeTierTab + 1} Details</s-text>
                    {tiers.length > 1 && (
                      <s-button
                        type="button"
                        variant="primary"
                        tone="critical"
                        icon="delete"
                        accessibilityLabel={`Delete Tier ${activeTierTab + 1}`}
                        onClick={() => handleRemoveTier(activeTierTab)}
                      />
                    )}
                  </s-stack>

                  <div style={{ maxWidth: "260px" }}>
                    <s-number-field
                      label={`Minimum cart value (${shopCurrency || "Base currency"})`}
                      prefix={currencySymbol}
                      min="1"
                      step="any"
                      value={String(currentTier.minAmount)}
                      onInput={(e) => updateCurrentTier("minAmount", e.target.value)}
                      required
                    ></s-number-field>
                  </div>

                  {/* Rewards Selection for this Milestone */}
                  <s-stack gap="small">
                    <s-text tone="subdued" size="small" weight="bold">Select rewards unlocked at this milestone:</s-text>
                    <s-stack direction="inline" gap="small">
                      <s-button
                        type="button"
                        variant={currentTier.hasDiscount ? "primary" : "secondary"}
                        onClick={() => {
                          const nextState = !currentTier.hasDiscount;
                          updateCurrentTier("hasDiscount", nextState);
                          if (!nextState) {
                            updateCurrentTier("discountValue", 0);
                          } else if (!currentTier.discountValue || Number(currentTier.discountValue) === 0) {
                            updateCurrentTier("discountValue", 10);
                          }
                        }}
                      >
                        {currentTier.hasDiscount ? `✓ Discount (% or ${currencySymbol})` : `+ Discount (% or ${currencySymbol})`}
                      </s-button>

                      <s-button
                        type="button"
                        variant={currentTier.hasFreeShipping ? "primary" : "secondary"}
                        onClick={() => {
                          const nextVal = !currentTier.hasFreeShipping;
                          updateCurrentTier("hasFreeShipping", nextVal);
                        }}
                      >
                        {currentTier.hasFreeShipping ? "✓ Free shipping" : "+ Free shipping"}
                      </s-button>

                      <s-button
                        type="button"
                        variant={currentTier.showFreeGift || currentTier.freeGift ? "primary" : "secondary"}
                        onClick={() => {
                          const nextState = !(currentTier.showFreeGift || currentTier.freeGift);
                          updateCurrentTier("showFreeGift", nextState);
                          if (!nextState) updateCurrentTier("freeGift", null);
                        }}
                      >
                        {currentTier.freeGift ? "✓ Free gift" : "+ Free gift"}
                      </s-button>

                      {currentTier.hasDiscount && currentTier.discountType === "PERCENTAGE" && (
                        <s-button
                          type="button"
                          variant={currentTier.showMaxCap || currentTier.maxCap ? "primary" : "secondary"}
                          onClick={() => {
                            const nextState = !(currentTier.showMaxCap || currentTier.maxCap);
                            updateCurrentTier("showMaxCap", nextState);
                            if (!nextState) updateCurrentTier("maxCap", "");
                          }}
                        >
                          {currentTier.maxCap ? "✓ Max discount cap" : "+ Max discount cap"}
                        </s-button>
                      )}
                    </s-stack>
                  </s-stack>

                  {/* Discount Inputs (Only shown if Discount is selected for this tier) */}
                  {currentTier.hasDiscount && (
                    <s-grid gridTemplateColumns="repeat(2, 1fr)" gap="small" style={{ maxWidth: "520px" }}>
                      <s-grid-item gridColumn="span 1">
                        <s-select
                          label="Discount type"
                          value={currentTier.discountType || "PERCENTAGE"}
                          onChange={(e) => updateCurrentTier("discountType", e.target.value)}
                        >
                          <s-option value="PERCENTAGE">Percentage (%)</s-option>
                          <s-option value="FIXED_AMOUNT">{`Fixed amount (${currencySymbol})`}</s-option>
                        </s-select>
                      </s-grid-item>

                      <s-grid-item gridColumn="span 1">
                        <s-number-field
                          label="Discount value"
                          min="1"
                          step="any"
                          suffix={currentTier.discountType === "FIXED_AMOUNT" ? currencySymbol : "%"}
                          value={String(currentTier.discountValue || "")}
                          onInput={(e) => updateCurrentTier("discountValue", e.target.value)}
                          required
                        ></s-number-field>
                      </s-grid-item>
                    </s-grid>
                  )}

                  {/* Free Gift Selector Box */}
                  {(currentTier.showFreeGift || currentTier.freeGift) && (
                    <s-box background="subdued" padding="base" borderRadius="base">
                      <s-stack gap="small">
                        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                          <s-text weight="bold">Free gift product</s-text>
                          <s-button type="button" variant="primary" onClick={handleOpenGiftPicker}>
                            {currentTier.freeGift ? "Change product" : "Browse products"}
                          </s-button>
                        </s-stack>

                        {currentTier.freeGift ? (
                          <s-box padding="small" background="base" borderRadius="base">
                            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                              <s-stack direction="inline" gap="base" alignItems="center">
                                {currentTier.freeGift.image ? (
                                  <s-thumbnail src={currentTier.freeGift.image} alt={currentTier.freeGift.title} size="small" />
                                ) : (
                                  <s-thumbnail alt={currentTier.freeGift.title} size="small" />
                                )}
                                <s-stack gap="extra-tight">
                                  <s-text weight="semibold">{currentTier.freeGift.title}</s-text>
                                  <s-text tone="subdued" size="small">
                                    {currentTier.freeGift.variantTitle || "Default"} • Free (100% off) at checkout
                                  </s-text>
                                </s-stack>
                              </s-stack>

                              <s-button
                                type="button"
                                variant="primary"
                                tone="critical"
                                icon="delete"
                                accessibilityLabel="Remove free gift"
                                onClick={() => updateCurrentTier("freeGift", null)}
                              />
                            </s-stack>
                          </s-box>
                        ) : (
                          <s-paragraph tone="subdued">
                            No gift selected yet. Click &quot;Browse products&quot; to pick the item shoppers receive for free upon reaching this threshold.
                          </s-paragraph>
                        )}
                      </s-stack>
                    </s-box>
                  )}

                  {/* Max Discount Cap Input */}
                  {(currentTier.showMaxCap || currentTier.maxCap) && (
                    <div style={{ maxWidth: "240px" }}>
                      <s-number-field
                        label="Maximum discount amount cap"
                        prefix={currencySymbol}
                        min="1"
                        step="any"
                        placeholder="e.g. 50"
                        value={String(currentTier.maxCap || "")}
                        onInput={(e) => updateCurrentTier("maxCap", e.target.value)}
                      ></s-number-field>
                    </div>
                  )}
                </s-stack>
              )}
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
                    label={`Start time (${tzAbbr})`}
                    value={startsAtTime}
                    onChange={(e) => setStartsAtTime(e.target.value)}
                  >
                    {startTimeOptions.map((opt) => (
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
                        label={`End time (${tzAbbr})`}
                        value={endsAtTime}
                        onChange={(e) => setEndsAtTime(e.target.value)}
                      >
                        {endTimeOptions.map((opt) => (
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
                  Discount combinations (Product, Order, and Shipping) apply globally across all offers. You can configure them anytime in{" "}
                  <s-link href="/app/settings">Settings → Combinations</s-link>.
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
            <s-text weight="bold">Tiers & Milestones</s-text>
            {tiers.map((t, idx) => {
              const parts = [];
              const val = parseFloat(t.discountValue) || 0;
              if (t.hasDiscount && val > 0) parts.push(t.discountType === "FIXED_AMOUNT" ? `${currencySymbol}${val} off` : `${val}% off`);
              if (t.hasFreeShipping) parts.push("Free Shipping");
              if (t.freeGift) parts.push(`Free ${t.freeGift.title || "Gift"}`);
              if (t.maxCap) parts.push(`(Capped at ${currencySymbol}${t.maxCap})`);
              const rewardSummary = parts.length > 0 ? parts.join(" + ") : "No reward selected";
              return (
                <s-paragraph key={idx} tone="subdued">
                  • Tier {idx + 1}: Spend {currencySymbol}{t.minAmount}+ → {rewardSummary}
                </s-paragraph>
              );
            })}
          </s-stack>

          <s-stack gap="tight">
            <s-text weight="bold">Active dates</s-text>
            <s-paragraph tone="subdued">
              • Starts {startsAtDate || todayStr} at {formatTime12h(startsAtTime)} ({tzAbbr})
              {hasEndDate && endsAtDate ? ` • Ends ${endsAtDate} at ${formatTime12h(endsAtTime)} (${tzAbbr})` : ""}
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
              When a customer adds items to cart reaching any threshold, the discount is applied automatically at checkout and in the cart drawer.
            </s-paragraph>
          </s-stack>
        </s-stack>
      </s-section>

      {/* Right side Sidebar: Live Widget Preview in slot="aside" */}
      <CartGoalWidgetPreview
        title={title}
        widgetTitle={widgetTitle}
        tiers={tiers}
        applyTo={applyTo}
        collections={selectedCollections}
        products={selectedProducts}
        shopDomain={shop}
        currency={shopCurrency}
        widgetSettings={widgetSettings}
        asSection={true}
      />
    </s-page>
  );
}
