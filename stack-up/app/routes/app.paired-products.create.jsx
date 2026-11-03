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
import { syncAllActiveOffersToShopMetafield } from "../utils/bundleMetafields.server";
import WidgetPreview from "./components/Preview/WidgetPreview";

// In-memory cache for functionId (Shopify Function IDs are static per app installation)
let cachedFunctionId = null;

export const loader = async ({ request }) => {
  const t0 = performance.now();
  const { admin, session } = await authenticate.admin(request);
  const shop = session?.shop || "";

  let functionId = cachedFunctionId;
  let shopTimezone = "UTC";
  let widgetSettings = null;

  try {
    // Single batched GraphQL request for functions, timezone, and widget settings
    const response = await admin.graphql(
      `#graphql
      query GetCreateOfferData {
        shopifyFunctions(first: 25) {
          nodes {
            id
            title
            apiType
          }
        }
        shop {
          ianaTimezone
          metafield(namespace: "stack_up", key: "paired_widget_settings") {
            value
          }
        }
      }`
    );
    const json = await response.json();
    const data = json.data;

    // 1. Resolve functionId
    if (data?.shopifyFunctions?.nodes) {
      const functions = data.shopifyFunctions.nodes || [];
      const matched = functions.find(
        (fn) =>
          fn.title?.toLowerCase().includes("paired") ||
          fn.apiType === "cart_lines_discounts_generate" ||
          fn.apiType === "order_discounts"
      );
      functionId = matched?.id || functions[0]?.id || null;
      if (functionId) {
        cachedFunctionId = functionId;
      }
    }

    // 2. Resolve shop timezone and prime the cache
    if (data?.shop?.ianaTimezone) {
      shopTimezone = data.shop.ianaTimezone;
      setShopTimezoneCache(shop, shopTimezone);
    } else {
      shopTimezone = await getShopTimezone(admin, shop).catch(() => "UTC");
    }

    // 3. Resolve widget settings
    const rawMetafield = data?.shop?.metafield?.value;
    if (rawMetafield) {
      try {
        widgetSettings = JSON.parse(rawMetafield);
      } catch {
        widgetSettings = null;
      }
    }
  } catch (err) {
    console.warn("Could not query create offer data in single GraphQL call:", err);
    shopTimezone = await getShopTimezone(admin, shop).catch(() => "UTC");
  }

  const tEnd = performance.now();
  console.log(`⏱️ [PairedProducts: Create Loader] Loaded in ${(tEnd - t0).toFixed(0)}ms (Single batched GraphQL call)`);

  const timezoneAbbr = getTimezoneAbbr(shopTimezone);
  const currentTime = getShopCurrentTime(shopTimezone);
  return { functionId: functionId || cachedFunctionId, shopTimezone, timezoneAbbr, currentTime, shop, widgetSettings };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  const title = (formData.get("title") || "").trim();
  const percentageStr = formData.get("percentage") || "";
  const percentage = parseFloat(percentageStr);
  const mainProductIdsRaw = formData.get("mainProductIds") || "[]";
  const subProductIdsRaw = formData.get("subProductIds") || "[]";

  const mainProductsRaw = formData.get("mainProducts") || "[]";
  const subProductsRaw = formData.get("subProducts") || "[]";

  const combinesWithOrder = formData.get("combinesWithOrder") === "true";
  const combinesWithProduct = formData.get("combinesWithProduct") === "true";
  const combinesWithShipping = formData.get("combinesWithShipping") === "true";
  const startsAtDate = (formData.get("startsAtDate") || formData.get("startsAt") || "").trim();
  const startsAtTime = (formData.get("startsAtTime") || "00:00:00").trim();
  const hasEndDate = formData.get("hasEndDate") === "true";
  const endsAtDate = hasEndDate ? (formData.get("endsAtDate") || formData.get("endsAt") || "").trim() : null;
  const endsAtTime = hasEndDate ? (formData.get("endsAtTime") || "23:59:59").trim() : null;
  const functionId = formData.get("functionId");

  if (!title) {
    return { error: "Please enter an offer title." };
  }

  if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
    return { error: "Please enter a valid discount percentage between 1 and 100." };
  }

  let mainProductIds = [];
  let subProductIds = [];
  let mainProducts = [];
  let subProducts = [];
  try {
    mainProductIds = JSON.parse(mainProductIdsRaw);
    subProductIds = JSON.parse(subProductIdsRaw);
    mainProducts = JSON.parse(mainProductsRaw);
    subProducts = JSON.parse(subProductsRaw);
  } catch {
    mainProductIds = [];
    subProductIds = [];
    mainProducts = [];
    subProducts = [];
  }

  if (mainProductIds.length === 0) {
    return { error: "Please select at least one Main Product." };
  }

  if (subProductIds.length === 0) {
    return { error: "Please select at least one Sub / Add-on Product." };
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

  const configPayload = {
    discountType: "PAIRED_PRODUCTS",
    percentage,
    title,
    mainProductIds,
    subProductIds,
    mainProducts,
    subProducts,
  };

  const mutation = `#graphql
    mutation CreateAutomaticDiscount($automaticAppDiscount: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
        automaticAppDiscount {
          discountId
          title
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const effectiveFunctionId =
    functionId || "gid://shopify/ShopifyFunction/paired-products-discount";

  const shopTimezone = await getShopTimezone(admin, session?.shop);
  const effectiveStartsAt = dateToShopISO(startsAtDate, startsAtTime, shopTimezone) || new Date().toISOString();
  const effectiveEndsAt = hasEndDate && endsAtDate ? dateToShopISO(endsAtDate, endsAtTime, shopTimezone) : undefined;

  const variables = {
    automaticAppDiscount: {
      title,
      functionId: effectiveFunctionId,
      startsAt: effectiveStartsAt,
      ...(effectiveEndsAt ? { endsAt: effectiveEndsAt } : {}),
      discountClasses: ["ORDER"],
      combinesWith: {
        orderDiscounts: combinesWithOrder,
        productDiscounts: combinesWithProduct,
        shippingDiscounts: combinesWithShipping,
      },
      metafields: [
        {
          namespace: "$app:discount",
          key: "function_configuration",
          type: "json",
          value: JSON.stringify(configPayload),
        },
      ],
    },
  };

  console.log("-------------------> ====================================================");
  console.log("-------------------> [CreateAction] Received offer submission:");
  console.log("------------------->   Title:", title);
  console.log("------------------->   Percentage:", percentage);
  console.log("------------------->   Main Product IDs:", mainProductIds);
  console.log("------------------->   Sub Product IDs:", subProductIds);
  console.log("------------------->   Starts At:", effectiveStartsAt);
  console.log("------------------->   Ends At:", effectiveEndsAt);
  console.log("------------------->   Function ID:", effectiveFunctionId);

  try {
    console.log("-------------------> [CreateAction] Sending discountAutomaticAppCreate mutation to Shopify Admin GraphQL...");
    const response = await admin.graphql(mutation, { variables });
    const json = await response.json();
    console.log("-------------------> [CreateAction] Shopify GraphQL Response:", JSON.stringify(json, null, 2));

    const userErrors = json.data?.discountAutomaticAppCreate?.userErrors || [];

    if (userErrors.length > 0) {
      console.log("-------------------> [CreateAction] User errors returned by Shopify:", userErrors);
      return { error: userErrors.map((e) => e.message).join(", ") };
    }

    const createdDiscount = json.data?.discountAutomaticAppCreate?.automaticAppDiscount;
    console.log("-------------------> 🎉 [CreateAction] Discount created successfully in Shopify!", createdDiscount);

    // Save offer to PostgreSQL DB via Prisma
    const discountId = createdDiscount?.discountId || "";
    const numericId = discountId.split("/").pop() || "";

    try {
      await prisma.pairedOffer.create({
        data: {
          shop: session.shop,
          discountId,
          numericId,
          title,
          percentage,
          status: createdDiscount?.status || "ACTIVE",
          combinesWithOrder,
          combinesWithProduct,
          combinesWithShipping,
          startsAt: effectiveStartsAt ? new Date(effectiveStartsAt) : new Date(),
          endsAt: effectiveEndsAt ? new Date(effectiveEndsAt) : null,
          mainProducts: JSON.stringify(mainProducts),
          subProducts: JSON.stringify(subProducts),
        },
      });
      console.log("-------------------> 💾 [CreateAction] Successfully saved offer to PostgreSQL DB! ID:", numericId);
    } catch (dbErr) {
      console.error("-------------------> [CreateAction] Error saving to DB:", dbErr);
    }

    // Sync all active bundle offers to Shop Metafield for instant storefront rendering
    await syncAllActiveOffersToShopMetafield(admin);

    console.log("-------------------> ====================================================");

    return redirect("/app/paired-products?created=true");
  } catch (err) {
    console.error("-------------------> [CreateAction] Error creating discount in Shopify:", err);
    return {
      error:
        err instanceof Error
          ? err.message
          : "An unexpected error occurred while saving the offer.",
    };
  }
};

export default function CreatePairedProductsOffer() {
  const { functionId, shopTimezone, timezoneAbbr, currentTime, shop, widgetSettings } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const DEFAULT_PERCENTAGE = "10";

  const [title, setTitle] = useState("");
  const [percentage, setPercentage] = useState(DEFAULT_PERCENTAGE);

  // Main Products list
  const [mainProducts, setMainProducts] = useState([]);

  // Sub Products list
  const [subProducts, setSubProducts] = useState([]);

  // Combinations
  const [combinesWithOrder, setCombinesWithOrder] = useState(false);
  const [combinesWithProduct, setCombinesWithProduct] = useState(false);
  const [combinesWithShipping, setCombinesWithShipping] = useState(false);

  // Dates in shop's timezone
  const todayStr = getShopTodayDate(shopTimezone);
  const defaultStartTime = currentTime || "00:00:00";
  const [startsAtDate, setStartsAtDate] = useState(todayStr);
  const [startsAtTime, setStartsAtTime] = useState(defaultStartTime);
  const [hasEndDate, setHasEndDate] = useState(false);
  const [endsAtDate, setEndsAtDate] = useState("");
  const [endsAtTime, setEndsAtTime] = useState("23:59:59");
  const tzAbbr = timezoneAbbr || getTimezoneAbbr(shopTimezone);

  const startTimeOptions = useMemo(() => generateTimeOptions(false, defaultStartTime), [defaultStartTime]);
  const endTimeOptions = useMemo(() => generateTimeOptions(true), []);

  // Helper to format selection IDs and variants for Shopify App Bridge ResourcePicker
  const buildResourceSelection = (products) =>
    products.map((p) => {
      const item = { id: p.id };
      if (Array.isArray(p.variants) && p.variants.length > 0) {
        item.variants = p.variants.map((v) => ({ id: typeof v === "string" ? v : v.id }));
      }
      return item;
    });

  // Resource Picker for Main Products
  const handleOpenMainProductPicker = async () => {
    try {
      const selection = buildResourceSelection(mainProducts);
      const selected = await shopify.resourcePicker({
        type: "product",
        multiple: true,
        action: "select",
        filter: {
          archived: false,
          draft: false,
          query: "status:active",
        },
        selectionIds: selection,
        initialSelectionIds: selection,
      });

      if (selected && Array.isArray(selected)) {
        setMainProducts(
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
            const existing = mainProducts.find((item) => item.id === p.id);
            return {
              id: p.id,
              title: p.title,
              handle: p.handle || existing?.handle || "",
              image,
              price,
              quantity: existing?.quantity || 1,
              variants: p.variants
                ? p.variants.map((v) => ({ id: v.id }))
                : existing?.variants || [],
            };
          })
        );
      }
    } catch (e) {
      console.warn("Main product picker dismissed:", e);
    }
  };

  // Resource Picker for Sub Products
  const handleOpenSubProductPicker = async () => {
    try {
      const selection = buildResourceSelection(subProducts);
      const selected = await shopify.resourcePicker({
        type: "product",
        multiple: true,
        action: "select",
        filter: {
          archived: false,
          draft: false,
          query: "status:active",
        },
        selectionIds: selection,
        initialSelectionIds: selection,
      });

      if (selected && Array.isArray(selected)) {
        setSubProducts(
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
            const existing = subProducts.find((item) => item.id === p.id);
            return {
              id: p.id,
              title: p.title,
              handle: p.handle || existing?.handle || "",
              image,
              price,
              quantity: existing?.quantity || 1,
              variants: p.variants
                ? p.variants.map((v) => ({ id: v.id }))
                : existing?.variants || [],
            };
          })
        );
      }
    } catch (e) {
      console.warn("Sub product picker dismissed:", e);
    }
  };

  const removeMainProduct = (productId) => {
    setMainProducts((prev) => prev.filter((p) => p.id !== productId));
  };

  const removeSubProduct = (productId) => {
    setSubProducts((prev) => prev.filter((p) => p.id !== productId));
  };

  const updateMainProductQuantity = (productId, newQty) => {
    setMainProducts((prev) =>
      prev.map((p) =>
        p.id === productId
          ? { ...p, quantity: newQty === "" ? "" : Math.max(1, parseInt(newQty, 10) || 1) }
          : p
      )
    );
  };

  const handleBlurMainProductQuantity = (productId) => {
    setMainProducts((prev) =>
      prev.map((p) =>
        p.id === productId && (!p.quantity || p.quantity < 1)
          ? { ...p, quantity: 1 }
          : p
      )
    );
  };

  const updateSubProductQuantity = (productId, newQty) => {
    setSubProducts((prev) =>
      prev.map((p) =>
        p.id === productId
          ? { ...p, quantity: newQty === "" ? "" : Math.max(1, parseInt(newQty, 10) || 1) }
          : p
      )
    );
  };

  const handleBlurSubProductQuantity = (productId) => {
    setSubProducts((prev) =>
      prev.map((p) =>
        p.id === productId && (!p.quantity || p.quantity < 1)
          ? { ...p, quantity: 1 }
          : p
      )
    );
  };

  const [isSaving, setIsSaving] = useState(false);
  const isRedirecting = navigation.state === "loading" && navigation.location?.pathname !== "/app/paired-products/create";
  const isSubmitting = (isSaving || navigation.state === "submitting" || (navigation.state === "loading" && navigation.formMethod?.toLowerCase() === "post")) && !isRedirecting;

  const isDirty = Boolean(
    title.trim() !== "" ||
    percentage !== DEFAULT_PERCENTAGE ||
    mainProducts.length > 0 ||
    subProducts.length > 0 ||
    combinesWithOrder ||
    combinesWithProduct ||
    combinesWithShipping ||
    startsAtDate !== todayStr ||
    startsAtTime !== defaultStartTime ||
    hasEndDate ||
    endsAtDate !== "" ||
    endsAtTime !== "23:59:59"
  );

  const showSaveBar = (isDirty || isSubmitting) && !isRedirecting;

  useEffect(() => {
    if (isRedirecting) {
      setIsSaving(false);
      shopify.saveBar?.hide("create-paired-offer-save-bar");
    }
  }, [isRedirecting, shopify]);

  useEffect(() => {
    if (navigation.state === "idle") {
      setIsSaving(false);
    }
  }, [navigation.state]);

  useEffect(() => {
    return () => {
      shopify.saveBar?.hide("create-paired-offer-save-bar");
    };
  }, [shopify]);

  const handleDiscard = (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setTitle("");
    setPercentage(DEFAULT_PERCENTAGE);
    setMainProducts([]);
    setSubProducts([]);
    setCombinesWithOrder(false);
    setCombinesWithProduct(false);
    setCombinesWithShipping(false);
    setStartsAtDate(todayStr);
    setStartsAtTime(defaultStartTime);
    setHasEndDate(false);
    setEndsAtDate("");
    setEndsAtTime("23:59:59");
    setIsSaving(false);
    shopify.saveBar?.hide("create-paired-offer-save-bar");
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
    const pct = parseFloat(percentage);
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      shopify.toast.show("Please enter a valid discount percentage between 1 and 100", { isError: true });
      return;
    }
    if (mainProducts.length === 0) {
      shopify.toast.show("Please select at least one Main Product", { isError: true });
      return;
    }
    if (subProducts.length === 0) {
      shopify.toast.show("Please select at least one Sub / Add-on Product", { isError: true });
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

    const formData = new FormData();
    formData.append("title", title);
    formData.append("percentage", percentage);
    formData.append(
      "mainProductIds",
      JSON.stringify(mainProducts.map((p) => p.id))
    );
    formData.append(
      "subProductIds",
      JSON.stringify(subProducts.map((p) => p.id))
    );
    formData.append(
      "mainProducts",
      JSON.stringify(
        mainProducts.map((p) => ({
          id: p.id,
          quantity: Math.max(1, parseInt(p.quantity, 10) || 1),
        }))
      )
    );
    formData.append(
      "subProducts",
      JSON.stringify(
        subProducts.map((p) => ({
          id: p.id,
          quantity: Math.max(1, parseInt(p.quantity, 10) || 1),
        }))
      )
    );
    formData.append("combinesWithOrder", String(combinesWithOrder));
    formData.append("combinesWithProduct", String(combinesWithProduct));
    formData.append("combinesWithShipping", String(combinesWithShipping));
    formData.append("startsAtDate", startsAtDate);
    formData.append("startsAtTime", startsAtTime);
    formData.append("startsAt", startsAtDate);
    formData.append("hasEndDate", String(hasEndDate));
    if (hasEndDate && endsAtDate) {
      formData.append("endsAtDate", endsAtDate);
      formData.append("endsAtTime", endsAtTime);
      formData.append("endsAt", endsAtDate);
    }
    if (functionId) {
      formData.append("functionId", functionId);
    }

    submit(formData, { method: "post" });
  };

  return (
    <s-page heading="Create Main + Sub Product Offer">
      <s-link slot="breadcrumb-actions" href="/app/paired-products">
        Paired Products Offers
      </s-link>

      <SaveBar id="create-paired-offer-save-bar" open={showSaveBar}>
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
          {/* Offer Details */}
          <s-section heading="Offer details">
            <s-grid
              gridTemplateColumns="repeat(10, 1fr)"
              gap="small"
              justifyContent="center"
            >
              <s-grid-item gridColumn="span 7">
                <s-text-field
                  label="Offer title"
                  name="title"
                  placeholder="e.g. Phone + Charger Bundle 20% OFF"
                  value={title}
                  onInput={(e) => setTitle(e.target.value)}
                  required
                ></s-text-field>
              </s-grid-item>
              <s-grid-item gridColumn="span 3">
                <s-number-field
                  label="Discount percentage"
                  name="percentage"
                  min="1"
                  max="100"
                  step="1"
                  suffix="%"
                  placeholder="10"
                  value={percentage}
                  onInput={(e) => setPercentage(e.target.value)}
                ></s-number-field>
              </s-grid-item>
            </s-grid>
          </s-section>

          {/* 1. Main Products */}
          <s-section heading="1. Select Main Product(s)">
            <s-stack gap="base">
              <s-paragraph tone="subdued">
                Choose the primary product page(s) where this bundle will be displayed. When a customer views any of these product pages, the bundle widget will appear.
              </s-paragraph>

              <s-stack gap="base">
                <s-stack background="subdued" padding="small" borderRadius="base" direction="inline" justifyContent="space-between" alignItems="center">
                  <s-text weight="bold">
                    {mainProducts.length} Main Product(s) selected
                  </s-text>
                  <s-button type="button" variant="primary" onClick={handleOpenMainProductPicker}>
                    Browse Main Products
                  </s-button>
                </s-stack>

                {mainProducts.length > 0 ? (
                  <s-box>
                    {mainProducts.map((p, idx) => (
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

                            <s-stack direction="inline" gap="small" alignItems="center">
                              <s-text tone="subdued" size="small" weight="medium">
                                Qty:
                              </s-text>
                              <div style={{ width: "80px" }}>
                                <s-number-field
                                  // label="Quantity"
                                  label-hidden
                                  min="1"
                                  step="1"
                                  value={String(p.quantity ?? 1)}
                                  onInput={(e) => updateMainProductQuantity(p.id, e.target.value)}
                                  onBlur={() => handleBlurMainProductQuantity(p.id)}
                                ></s-number-field>
                              </div>
                              <s-button
                                type="button"
                                variant="primary" tone="critical"
                                icon="delete"
                                accessibilityLabel={`Remove ${p.title}`}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  removeMainProduct(p.id);
                                }}
                              />
                            </s-stack>
                          </s-stack>
                        </s-box>
                      </div>
                    ))}
                  </s-box>
                ) : (
                  <s-paragraph tone="subdued">
                    No main products selected yet. Click &quot;Browse Main Products&quot; to pick.
                  </s-paragraph>
                )}
              </s-stack>
            </s-stack>
          </s-section>

          {/* 2. Sub Products */}
          <s-section heading="2. Select Sub / Add-on Product(s)">
            <s-stack gap="base">
              <s-paragraph tone="subdued">
                Choose the companion/accessory product(s) bundled with the main product. All selected companion products will be displayed together in the storefront bundle widget.
              </s-paragraph>

              <s-stack gap="base">
                <s-stack background="subdued" padding="small" borderRadius="base" direction="inline" justifyContent="space-between" alignItems="center">
                  <s-text weight="bold">
                    {subProducts.length} Sub Product(s) selected
                  </s-text>
                  <s-button type="button" variant="primary" onClick={handleOpenSubProductPicker}>
                    Browse Sub Products
                  </s-button>
                </s-stack>

                {subProducts.length > 0 ? (
                  <s-box>
                    {subProducts.map((p, idx) => (
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

                            <s-stack direction="inline" gap="small" alignItems="center">
                              <s-text tone="subdued" size="small" weight="medium">
                                Qty:
                              </s-text>
                              <div style={{ width: "80px" }}>
                                <s-number-field
                                  // label="Quantity"
                                  label-hidden
                                  min="1"
                                  step="1"
                                  value={String(p.quantity ?? 1)}
                                  onInput={(e) => updateSubProductQuantity(p.id, e.target.value)}
                                  onBlur={() => handleBlurSubProductQuantity(p.id)}
                                ></s-number-field>
                              </div>
                              <s-button
                                type="button"
                                variant="primary" tone="critical"
                                icon="delete"
                                accessibilityLabel={`Remove ${p.title}`}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  removeSubProduct(p.id);
                                }}
                              />
                            </s-stack>
                          </s-stack>
                        </s-box>
                      </div>
                    ))}
                  </s-box>
                ) : (
                  <s-paragraph tone="subdued">
                    No sub products selected yet. Click &quot;Browse Sub Products&quot; to pick.
                  </s-paragraph>
                )}
              </s-stack>
            </s-stack>
          </s-section>


          {/* Active Dates */}
          <s-section heading="Active dates">
            <s-stack gap="base">
              {shopTimezone && (
                <s-paragraph tone="subdued">
                  Times are based on your store timezone ({shopTimezone}).
                </s-paragraph>
              )}
              <s-grid
                gridTemplateColumns="repeat(2, 1fr)"
                gap="base"
              >
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

          {/* Combinations */}
          <s-section heading="Combinations">
            <s-stack gap="base">
              <s-paragraph tone="subdued">
                Control whether this discount can be combined with other discounts. Defaults to OFF for merchant margin safety.
              </s-paragraph>

              <s-box
                background="base"
                border="small"
                borderRadius="base"
              >
                {/* Product discounts */}
                <s-box padding="small-300">
                  <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                    <s-stack direction="inline" gap="base" alignItems="center">
                      <s-icon type="product-add" />
                      <s-stack gap="extra-tight">
                        <s-text weight="semibold">Product discounts</s-text>
                        <s-text tone="subdued" size="small">
                          Multiple can apply per order · One per product (best value wins)
                        </s-text>
                      </s-stack>
                    </s-stack>
                    <s-switch
                      checked={combinesWithProduct}
                      onChange={(e) => setCombinesWithProduct(Boolean(e.target.checked ?? e.currentTarget.checked))}
                      accessibilityLabel="Combine with Product discounts"
                    ></s-switch>
                  </s-stack>
                </s-box>

                <s-divider />

                {/* Order discounts */}
                <s-box padding="small-300">
                  <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                    <s-stack direction="inline" gap="base" alignItems="center">
                      <s-icon type="order" />
                      <s-stack gap="extra-tight">
                        <s-text weight="semibold">Order discounts</s-text>
                        <s-text tone="subdued" size="small">
                          Multiple can apply per order
                        </s-text>
                      </s-stack>
                    </s-stack>
                    <s-switch
                      checked={combinesWithOrder}
                      onChange={(e) => setCombinesWithOrder(Boolean(e.target.checked ?? e.currentTarget.checked))}
                      accessibilityLabel="Combine with Order discounts"
                    ></s-switch>
                  </s-stack>
                </s-box>

                <s-divider />

                {/* Shipping discounts */}
                <s-box padding="small-300">
                  <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                    <s-stack direction="inline" gap="base" alignItems="center">
                      <s-icon type="delivery" />
                      <s-stack gap="extra-tight">
                        <s-text weight="semibold">Shipping discounts</s-text>
                        <s-text tone="subdued" size="small">
                          Only one can apply per order (best value wins)
                        </s-text>
                      </s-stack>
                    </s-stack>
                    <s-switch
                      checked={combinesWithShipping}
                      onChange={(e) => setCombinesWithShipping(Boolean(e.target.checked ?? e.currentTarget.checked))}
                      accessibilityLabel="Combine with Shipping discounts"
                    ></s-switch>
                  </s-stack>
                </s-box>
              </s-box>
            </s-stack>
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
            <s-text weight="bold">Discount value</s-text>
            <s-paragraph tone="subdued">
              • {percentage ? `${percentage}% off order subtotal` : "No discount value set"}
            </s-paragraph>
          </s-stack>

          <s-stack gap="tight">
            <s-text weight="bold">Target products (Main)</s-text>
            {mainProducts.length > 0 ? (
              mainProducts.map((p) => (
                <s-paragraph key={p.id} tone="subdued">
                  • {p.quantity || 1}x {p.title}
                </s-paragraph>
              ))
            ) : (
              <s-paragraph tone="subdued">• No main products selected</s-paragraph>
            )}
          </s-stack>

          <s-stack gap="tight">
            <s-text weight="bold">Offer products (Sub / Add-on)</s-text>
            {subProducts.length > 0 ? (
              subProducts.map((p) => (
                <s-paragraph key={p.id} tone="subdued">
                  • {p.quantity || 1}x {p.title}
                </s-paragraph>
              ))
            ) : (
              <s-paragraph tone="subdued">• No sub products selected</s-paragraph>
            )}
          </s-stack>

          <s-stack gap="tight">
            <s-text weight="bold">Combinations</s-text>
            <s-paragraph tone="subdued">
              • {[
                combinesWithOrder && "Order",
                combinesWithProduct && "Product",
                combinesWithShipping && "Shipping",
              ].filter(Boolean).join(", ") || "None"}
            </s-paragraph>
          </s-stack>

          <s-stack gap="tight">
            <s-text weight="bold">Active dates</s-text>
            <s-paragraph tone="subdued">
              • Starts {startsAtDate || todayStr} at {formatTime12h(startsAtTime)} ({tzAbbr})
              {hasEndDate && endsAtDate ? ` • Ends ${endsAtDate} at ${formatTime12h(endsAtTime)} (${tzAbbr})` : ""}
            </s-paragraph>
          </s-stack>

          <s-stack background="subdued" padding="small" borderRadius="base" gap="small">
            <s-text size="small" weight="bold">How it applies:</s-text>
            <s-paragraph size="small" tone="subdued">
              When a customer adds the required quantity of Main and Sub products to cart, {percentage || "0"}% discount will be applied automatically at checkout.
            </s-paragraph>
          </s-stack>
        </s-stack>
      </s-section>

      {/* Right side Sidebar: Live Widget Preview */}
      <WidgetPreview
        title={title}
        percentage={percentage}
        mainProducts={mainProducts}
        subProducts={subProducts}
        shopDomain={shop}
        widgetSettings={widgetSettings}
      />
    </s-page>
  );
}