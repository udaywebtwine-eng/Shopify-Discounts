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
import { syncAllActiveSelectedOffersToShopMetafield } from "../utils/selectedOffersMetafields.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session?.shop || "";

  let functionId = null;
  try {
    const response = await admin.graphql(
      `#graphql
      query GetFunctionId {
        shopifyFunctions(first: 25) {
          nodes {
            id
            title
            apiType
          }
        }
      }`
    );
    const json = await response.json();
    const functions = json.data?.shopifyFunctions?.nodes || [];
    const matched = functions.find(
      (fn) =>
        fn.title?.toLowerCase().includes("selected") ||
        fn.handle?.toLowerCase().includes("selected")
    );
    functionId = matched?.id || functions[0]?.id || null;
  } catch (err) {
    console.warn("Could not query shopifyFunctions:", err);
  }

  const shopTimezone = await getShopTimezone(admin, shop);
  if (shop && shopTimezone) {
    setShopTimezoneCache(shop, shopTimezone);
  }
  const timezoneAbbr = getTimezoneAbbr(shopTimezone);
  const currentTime = getShopCurrentTime(shopTimezone);

  return { functionId, shopTimezone, timezoneAbbr, currentTime, shop };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  const title = (formData.get("title") || "").trim();
  const percentageStr = formData.get("percentage") || "";
  const percentage = parseFloat(percentageStr);

  const targetProductsRaw = formData.get("targetProducts") || "[]";
  const offeredProductsRaw = formData.get("offeredProducts") || "[]";

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

  let targetProducts = [];
  let offeredProducts = [];
  try {
    targetProducts = JSON.parse(targetProductsRaw);
    offeredProducts = JSON.parse(offeredProductsRaw);
  } catch {
    targetProducts = [];
    offeredProducts = [];
  }

  if (!Array.isArray(targetProducts) || targetProducts.length === 0) {
    return { error: "Please select at least one Main / Target Product where this widget will appear." };
  }

  if (!Array.isArray(offeredProducts) || offeredProducts.length === 0) {
    return { error: "Please select at least one Recommended Add-On Product to offer." };
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

  const sanitizedTargetProducts = targetProducts.map((p) => ({
    id: p.id,
    title: p.title || "",
    handle: p.handle || "",
    image: p.image || "",
    price: p.price || "",
  }));

  const sanitizedOfferedProducts = offeredProducts.map((p) => ({
    id: p.id,
    title: p.title || "",
    handle: p.handle || "",
    image: p.image || "",
    price: p.price || "",
    quantity: Math.max(1, parseInt(p.quantity, 10) || 1),
  }));

  const configPayload = {
    discountType: "SELECTED_PRODUCTS",
    percentage,
    title,
    targetProductIds: sanitizedTargetProducts.map((p) => p.id),
    offeredProductIds: sanitizedOfferedProducts.map((p) => p.id),
    targetProducts: sanitizedTargetProducts,
    offeredProducts: sanitizedOfferedProducts,
    // Backwards compatibility for existing function
    productIds: sanitizedOfferedProducts.map((p) => p.id),
    products: sanitizedOfferedProducts,
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
    functionId || "gid://shopify/ShopifyFunction/selected-products-discount";

  const shopTimezone = await getShopTimezone(admin, session?.shop);
  const effectiveStartsAt = dateToShopISO(startsAtDate, startsAtTime, shopTimezone) || new Date().toISOString();
  const effectiveEndsAt = hasEndDate && endsAtDate ? dateToShopISO(endsAtDate, endsAtTime, shopTimezone) : undefined;

  const variables = {
    automaticAppDiscount: {
      title,
      functionId: effectiveFunctionId,
      startsAt: effectiveStartsAt,
      ...(effectiveEndsAt ? { endsAt: effectiveEndsAt } : {}),
      discountClasses: ["PRODUCT"],
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

  try {
    const response = await admin.graphql(mutation, { variables });
    const json = await response.json();

    const userErrors = json.data?.discountAutomaticAppCreate?.userErrors || [];
    if (userErrors.length > 0) {
      return { error: userErrors.map((e) => e.message).join(", ") };
    }

    const createdDiscount = json.data?.discountAutomaticAppCreate?.automaticAppDiscount;
    const discountId = createdDiscount?.discountId || "";
    const numericId = discountId.split("/").pop() || "";

    // Save to PostgreSQL DB
    try {
      await prisma.selectedProductOffer.create({
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
          targetProducts: JSON.stringify(sanitizedTargetProducts),
          offeredProducts: JSON.stringify(sanitizedOfferedProducts),
          products: JSON.stringify(sanitizedOfferedProducts),
        },
      });
      console.log("-------------------> 💾 [SelectedProducts: CreateAction] Saved to DB with ID:", numericId);
    } catch (dbErr) {
      console.error("-------------------> [SelectedProducts: CreateAction] Error saving to DB:", dbErr);
    }

    // Sync to Shop Metafield for instant storefront rendering
    await syncAllActiveSelectedOffersToShopMetafield(admin);

    return redirect("/app/sected-products?created=true");
  } catch (err) {
    console.error("-------------------> [SelectedProducts: CreateAction] Error creating discount:", err);
    return {
      error:
        err instanceof Error
          ? err.message
          : "An unexpected error occurred while saving the offer.",
    };
  }
};

export default function CreateSelectedProductsOffer() {
  const { functionId, shopTimezone, timezoneAbbr, currentTime } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const DEFAULT_PERCENTAGE = "10";

  const [title, setTitle] = useState("Special Add-Ons Just for You");
  const [percentage, setPercentage] = useState(DEFAULT_PERCENTAGE);

  // 1. Target / Main Products (where the widget appears)
  const [targetProducts, setTargetProducts] = useState([]);

  // 2. Offered / Add-on Products (the recommended items with checkboxes)
  const [offeredProducts, setOfferedProducts] = useState([]);

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

  const [isSaving, setIsSaving] = useState(false);
  const isRedirecting = navigation.state === "loading" && !navigation.location?.pathname?.includes("/create");
  const isSubmitting = (isSaving || navigation.state === "submitting" || (navigation.state === "loading" && navigation.formMethod?.toLowerCase() === "post")) && !isRedirecting;

  // Helper to format selection IDs and variants for Shopify App Bridge ResourcePicker
  const buildResourceSelection = (products) =>
    products.map((p) => {
      const item = { id: p.id };
      if (Array.isArray(p.variants) && p.variants.length > 0) {
        item.variants = p.variants.map((v) => ({ id: typeof v === "string" ? v : v.id }));
      }
      return item;
    });

  // Resource Picker for 1. Main / Target Products
  const handleOpenTargetPicker = async () => {
    try {
      const selection = buildResourceSelection(targetProducts);
      const selected = await shopify.resourcePicker({
        type: "product",
        multiple: true,
        action: "select",
        filter: { archived: false, draft: false, query: "status:active" },
        selectionIds: selection,
        initialSelectionIds: selection,
      });

      if (selected && Array.isArray(selected)) {
        setTargetProducts(
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
            const existing = targetProducts.find((item) => item.id === p.id);
            return {
              id: p.id,
              title: p.title,
              handle: p.handle || existing?.handle || "",
              image,
              price,
              variants: p.variants
                ? p.variants.map((v) => ({ id: v.id }))
                : existing?.variants || [],
            };
          })
        );
      }
    } catch (err) {
      console.error("Error opening target product picker:", err);
    }
  };

  const removeTargetProduct = (productId) => {
    setTargetProducts((prev) => prev.filter((p) => p.id !== productId));
  };

  // Resource Picker for 2. Recommended / Add-On Products
  const handleOpenOfferedPicker = async () => {
    try {
      const selection = buildResourceSelection(offeredProducts);
      const selected = await shopify.resourcePicker({
        type: "product",
        multiple: true,
        action: "select",
        filter: { archived: false, draft: false, query: "status:active" },
        selectionIds: selection,
        initialSelectionIds: selection,
      });

      if (selected && Array.isArray(selected)) {
        setOfferedProducts(
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
            const existing = offeredProducts.find((item) => item.id === p.id);
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
    } catch (err) {
      console.error("Error opening offered product picker:", err);
    }
  };

  const removeOfferedProduct = (productId) => {
    setOfferedProducts((prev) => prev.filter((p) => p.id !== productId));
  };

  const updateOfferedQuantity = (productId, newQty) => {
    setOfferedProducts((prev) =>
      prev.map((p) =>
        p.id === productId
          ? { ...p, quantity: newQty === "" ? "" : Math.max(1, parseInt(newQty, 10) || 1) }
          : p
      )
    );
  };

  const handleBlurOfferedQuantity = (productId) => {
    setOfferedProducts((prev) =>
      prev.map((p) =>
        p.id === productId && (!p.quantity || p.quantity < 1)
          ? { ...p, quantity: 1 }
          : p
      )
    );
  };

  const isDirty = Boolean(
    title.trim() !== "Special Add-Ons Just for You" ||
    percentage !== DEFAULT_PERCENTAGE ||
    targetProducts.length > 0 ||
    offeredProducts.length > 0 ||
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
      shopify.saveBar?.hide("create-selected-offer-save-bar");
    }
  }, [isRedirecting, shopify]);

  useEffect(() => {
    if (navigation.state === "idle") {
      setIsSaving(false);
    }
  }, [navigation.state]);

  useEffect(() => {
    return () => {
      shopify.saveBar?.hide("create-selected-offer-save-bar");
    };
  }, [shopify]);

  const handleDiscard = (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setTitle("Special Add-Ons Just for You");
    setPercentage(DEFAULT_PERCENTAGE);
    setTargetProducts([]);
    setOfferedProducts([]);
    setCombinesWithOrder(false);
    setCombinesWithProduct(false);
    setCombinesWithShipping(false);
    setStartsAtDate(todayStr);
    setStartsAtTime(defaultStartTime);
    setHasEndDate(false);
    setEndsAtDate("");
    setEndsAtTime("23:59:59");
    setIsSaving(false);
    shopify.saveBar?.hide("create-selected-offer-save-bar");
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
    if (targetProducts.length === 0) {
      shopify.toast.show("Please select at least one Main / Target Product", { isError: true });
      return;
    }
    if (offeredProducts.length === 0) {
      shopify.toast.show("Please select at least one Recommended Add-On Product", { isError: true });
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
      "targetProducts",
      JSON.stringify(
        targetProducts.map((p) => ({
          id: p.id,
          title: p.title,
          handle: p.handle || "",
          image: p.image || "",
          price: p.price || "",
        }))
      )
    );
    formData.append(
      "offeredProducts",
      JSON.stringify(
        offeredProducts.map((p) => ({
          id: p.id,
          title: p.title,
          handle: p.handle || "",
          image: p.image || "",
          price: p.price || "",
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
    <s-page heading="Create Selected Products Offer">
      <s-link slot="breadcrumb-actions" href="/app/sected-products">
        Selected Products Offers
      </s-link>

      <SaveBar id="create-selected-offer-save-bar" open={showSaveBar}>
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
                  label="Offer title / Heading"
                  name="title"
                  placeholder="e.g. Special Add-Ons Just for You"
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

          {/* 1. Target / Main Products */}
          <s-section heading="1. Select Main / Target Product(s)">
            <s-stack gap="base">
              <s-paragraph tone="subdued">
                Choose the product page(s) where this add-on widget will appear. When a customer views any of these product pages, the add-ons widget will be displayed.
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
                    {targetProducts.length} Main Product(s) selected
                  </s-text>
                  <s-button type="button" variant="primary" onClick={handleOpenTargetPicker}>
                    Browse Main Products
                  </s-button>
                </s-stack>

                {targetProducts.length > 0 ? (
                  <s-box>
                    {targetProducts.map((p, idx) => (
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
                                removeTargetProduct(p.id);
                              }}
                            />
                          </s-stack>
                        </s-box>
                      </div>
                    ))}
                  </s-box>
                ) : (
                  <s-paragraph tone="subdued">
                    No main products selected yet. Click &quot;Browse Main Products&quot; to pick which product pages display this widget.
                  </s-paragraph>
                )}
              </s-stack>
            </s-stack>
          </s-section>

          {/* 2. Recommended / Add-On Products */}
          <s-section heading="2. Select Recommended Add-On Product(s)">
            <s-stack gap="base">
              <s-paragraph tone="subdued">
                Choose the companion/add-on products displayed in the widget with checkboxes and discounted prices.
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
                    {offeredProducts.length} Add-On Product(s) selected
                  </s-text>
                  <s-button type="button" variant="primary" onClick={handleOpenOfferedPicker}>
                    Browse Add-On Products
                  </s-button>
                </s-stack>

                {offeredProducts.length > 0 ? (
                  <s-box>
                    {offeredProducts.map((p, idx) => (
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
                                Min Qty:
                              </s-text>
                              <div style={{ width: "90px" }}>
                                <s-number-field
                                  label-hidden
                                  min="1"
                                  step="1"
                                  value={String(p.quantity ?? 1)}
                                  onInput={(e) => updateOfferedQuantity(p.id, e.target.value)}
                                  onBlur={() => handleBlurOfferedQuantity(p.id)}
                                ></s-number-field>
                              </div>
                              <s-button
                                type="button"
                                variant="primary"
                                tone="critical"
                                icon="delete"
                                accessibilityLabel={`Remove ${p.title}`}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  removeOfferedProduct(p.id);
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
                    No add-on products selected yet. Click &quot;Browse Add-On Products&quot; to pick items.
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

          {/* Combinations */}
          <s-section heading="Combinations">
            <s-stack gap="base">
              <s-paragraph tone="subdued">
                Control whether this discount can be combined with other discounts.
              </s-paragraph>

              <s-box background="base" border="small" borderRadius="base">
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
              • {percentage ? `${percentage}% off add-on products` : "No discount value set"}
            </s-paragraph>
          </s-stack>

          <s-stack gap="tight">
            <s-text weight="bold">Main / Target product(s)</s-text>
            {targetProducts.length > 0 ? (
              targetProducts.map((p) => (
                <s-paragraph key={p.id} tone="subdued">
                  • {p.title}
                </s-paragraph>
              ))
            ) : (
              <s-paragraph tone="subdued">
                • No main products selected
              </s-paragraph>
            )}
          </s-stack>

          <s-stack gap="tight">
            <s-text weight="bold">Recommended add-ons</s-text>
            {offeredProducts.length > 0 ? (
              offeredProducts.map((p) => (
                <s-paragraph key={p.id} tone="subdued">
                  • {p.quantity || 1}x {p.title}
                </s-paragraph>
              ))
            ) : (
              <s-paragraph tone="subdued">
                • No add-on products selected
              </s-paragraph>
            )}
          </s-stack>

          <s-stack gap="tight">
            <s-text weight="bold">Active dates</s-text>
            <s-paragraph tone="subdued">
              • Starts {startsAtDate || todayStr} at {formatTime12h(startsAtTime)} ({tzAbbr})
            </s-paragraph>
            {hasEndDate && endsAtDate && (
              <s-paragraph tone="subdued">
                • Ends {endsAtDate} at {formatTime12h(endsAtTime)} ({tzAbbr})
              </s-paragraph>
            )}
          </s-stack>

          <s-stack gap="tight">
            <s-text weight="bold">Combinations</s-text>
            <s-paragraph tone="subdued">
              {combinesWithProduct || combinesWithOrder || combinesWithShipping ? (
                <>
                  {combinesWithProduct && "• Combines with Product discounts\n"}
                  {combinesWithOrder && "• Combines with Order discounts\n"}
                  {combinesWithShipping && "• Combines with Shipping discounts\n"}
                </>
              ) : (
                "• Cannot be combined with other discounts"
              )}
            </s-paragraph>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}
