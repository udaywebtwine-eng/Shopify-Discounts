import { useState, useEffect } from "react";
import {
  useLoaderData,
  useActionData,
  useNavigation,
  useSubmit,
  redirect,
} from "react-router";
import { useAppBridge, SaveBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopTimezone, getShopTodayDate, dateToShopISO } from "../utils/timezone";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

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
        fn.title?.toLowerCase().includes("paired") ||
        fn.apiType === "cart_lines_discounts_generate" ||
        fn.apiType === "order_discounts"
    );
    functionId = matched?.id || functions[0]?.id || null;
  } catch (err) {
    console.warn("Could not query shopifyFunctions:", err);
  }

  const shopTimezone = await getShopTimezone(admin);

  return { functionId, shopTimezone };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
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
  const startsAt = formData.get("startsAt") || new Date().toISOString();
  const hasEndDate = formData.get("hasEndDate") === "true";
  const endsAt = hasEndDate && formData.get("endsAt") ? formData.get("endsAt") : null;
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

  if (hasEndDate && (!endsAt || !endsAt.trim())) {
    return { error: "Please enter an end date." };
  }

  if (hasEndDate && endsAt && startsAt && endsAt < startsAt) {
    return { error: "End date must be on or after start date." };
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

  const shopTimezone = await getShopTimezone(admin);
  const effectiveStartsAt = dateToShopISO(startsAt, "00:00:00", shopTimezone) || new Date().toISOString();
  const effectiveEndsAt = hasEndDate && endsAt ? dateToShopISO(endsAt, "23:59:59", shopTimezone) : undefined;

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
  console.log("------------------->   Starts At:", startsAt);
  console.log("------------------->   Ends At:", endsAt);
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
  const { functionId, shopTimezone } = useLoaderData();
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
  const [startsAt, setStartsAt] = useState(todayStr);
  const [hasEndDate, setHasEndDate] = useState(false);
  const [endsAt, setEndsAt] = useState("");

  // Resource Picker for Main Products
  const handleOpenMainProductPicker = async () => {
    try {
      const selected = await shopify.resourcePicker({
        type: "product",
        multiple: true,
        action: "select",
        filter: {
          archived: false,
          draft: false,
          query: "status:active",
        },
        initialSelectionIds: mainProducts.map((p) => ({ id: p.id })),
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
              image,
              price,
              quantity: existing?.quantity || 1,
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
      const selected = await shopify.resourcePicker({
        type: "product",
        multiple: true,
        action: "select",
        filter: {
          archived: false,
          draft: false,
          query: "status:active",
        },
        initialSelectionIds: subProducts.map((p) => ({ id: p.id })),
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
              image,
              price,
              quantity: existing?.quantity || 1,
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

  const isSubmitting = navigation.state === "submitting";
  const [isSaved, setIsSaved] = useState(false);

  const isDirty = Boolean(
    title.trim() !== "" ||
    percentage !== DEFAULT_PERCENTAGE ||
    mainProducts.length > 0 ||
    subProducts.length > 0 ||
    combinesWithOrder ||
    combinesWithProduct ||
    combinesWithShipping ||
    startsAt !== todayStr ||
    hasEndDate ||
    endsAt !== ""
  );

  const showSaveBar = isDirty && !isSaved;

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
    setStartsAt(todayStr);
    setHasEndDate(false);
    setEndsAt("");
    setIsSaved(false);
    shopify.saveBar?.hide("create-paired-offer-save-bar");
  };

  useEffect(() => {
    if (actionData?.error) {
      setIsSaved(false);
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
    if (hasEndDate && (!endsAt || !endsAt.trim())) {
      shopify.toast.show("Please enter an end date", { isError: true });
      return;
    }
    if (hasEndDate && endsAt && startsAt && endsAt < startsAt) {
      shopify.toast.show("End date must be on or after start date", { isError: true });
      return;
    }

    setIsSaved(true);
    shopify.saveBar?.hide("create-paired-offer-save-bar");

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
    formData.append("startsAt", startsAt);
    formData.append("hasEndDate", String(hasEndDate));
    if (hasEndDate && endsAt) {
      formData.append("endsAt", endsAt);
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
          loading={isSubmitting ? "" : undefined}
          disabled={isSubmitting ? "" : undefined}
        >
          Save
        </button>
        <button
          type="button"
          onClick={handleDiscard}
          disabled={isSubmitting ? "" : undefined}
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
                Choose the primary product(s) that the customer must add to their cart.
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
                Choose the companion/accessory product(s) that pair with the main product(s).
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
                {/* <s-grid-item gridColumn={hasEndDate ? "span 1" : "span 2"}> */}
                <s-grid-item gridColumn="span 1">
                  <s-date-field
                    label="Start date"
                    value={startsAt || ""}
                    allow={`${todayStr}--`}
                    onChange={(e) => setStartsAt(e.target.value)}
                  ></s-date-field>
                </s-grid-item>

                {hasEndDate && (
                  <s-grid-item gridColumn="span 1">
                    <s-date-field
                      label="End date"
                      value={endsAt || ""}
                      allow={`${startsAt || todayStr}--`}
                      onChange={(e) => setEndsAt(e.target.value)}
                    ></s-date-field>
                  </s-grid-item>
                )}

                <s-grid-item gridColumn="span 2">
                  <s-checkbox
                    label="Set end date"
                    checked={hasEndDate}
                    onChange={(e) => {
                      const checked = e.currentTarget.checked;
                      setHasEndDate(checked);
                      if (!checked) {
                        setEndsAt("");
                      }
                    }}
                  ></s-checkbox>
                </s-grid-item>
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
              • Starts {startsAt || todayStr}
              {hasEndDate && endsAt ? ` • Ends ${endsAt}` : ""}
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
    </s-page>
  );
}