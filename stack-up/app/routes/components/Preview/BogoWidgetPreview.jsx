import { useState, useMemo } from "react";

function parsePrice(raw) {
  if (typeof raw === "number") return isNaN(raw) ? 0 : raw;
  if (!raw) return 0;
  const cleaned = String(raw).replace(/[^0-9.]/g, "");
  const val = parseFloat(cleaned);
  return isNaN(val) ? 0 : val;
}

function formatMoney(amount) {
  const num = typeof amount === "number" ? amount : parseFloat(amount) || 0;
  return `$${num.toFixed(2)}`;
}

export default function BogoWidgetPreview({
  dealType = "BOGO", // "BOGO" | "BUY_X_GET_X" | "BUY_X_GET_Y"
  buyQty = 1,
  getQty = 1,
  buyProducts = [],
  getProducts = [],
  discountType = "PERCENTAGE", // "PERCENTAGE" | "FIXED_AMOUNT"
  discountValue = 100,
  maxDiscount = null,
  widgetTitle = "",
  widgetSettings = null,
  shopDomain = "",
  asSection = true,
}) {
  const [selectedProductIndex, setSelectedProductIndex] = useState(0);
  const [selectedBuyVariantId, setSelectedBuyVariantId] = useState("");
  const [selectedGetVariantId, setSelectedGetVariantId] = useState("");

  // Settings with fallbacks
  const styles = {
    cardSurface: widgetSettings?.styles?.cardSurface || "#ffffff",
    borderColor: widgetSettings?.styles?.borderColor || "#e5e7eb",
    borderWidth: widgetSettings?.styles?.borderWidth ?? 1,
    borderRadius: widgetSettings?.styles?.borderRadius ?? 12,
    badgeBg: widgetSettings?.styles?.badgeBg || "#ede9fe",
    badgeTextColor: widgetSettings?.styles?.badgeTextColor || "#6366f1",
    plusBg: widgetSettings?.styles?.plusBg || widgetSettings?.styles?.badgeBg || "#ede9fe",
    plusColor: widgetSettings?.styles?.plusColor || widgetSettings?.styles?.badgeTextColor || "#6366f1",
    buttonBg: widgetSettings?.styles?.buttonBg || "#1f2937",
    buttonTextColor: widgetSettings?.styles?.buttonTextColor || "#ffffff",
    buttonBorderRadius: widgetSettings?.styles?.buttonBorderRadius ?? 8,
  };

  const display = {
    showWidgetTitle: widgetSettings?.display?.showWidgetTitle !== false,
    showDivider: widgetSettings?.display?.showDivider !== false,
    showPlusIcon: widgetSettings?.display?.showPlusIcon !== false,
    showBadge: widgetSettings?.display?.showBadge !== false,
    showSavings: widgetSettings?.display?.showSavings !== false,
    showAddToCart: widgetSettings?.display?.showAddToCart !== false,
  };

  const parsedBuyQty = Math.max(1, Number(buyQty) || 1);
  const parsedGetQty = Math.max(1, Number(getQty) || 1);
  const parsedDiscountValue = dealType === "BOGO" ? 100 : Math.max(0, Number(discountValue) || 0);
  const parsedMaxDiscount = maxDiscount && Number(maxDiscount) > 0 ? Number(maxDiscount) : null;

  // Active Buy product
  const activeProductIndex = Math.min(
    Math.max(0, selectedProductIndex),
    Math.max(0, buyProducts.length - 1)
  );

  const activeBuyProduct = buyProducts[activeProductIndex] || {
    id: "preview-buy",
    title: "Afterglow Block-Heel Sandals - Black",
    price: "85.00",
    image: "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-lifestyle-1_large.png",
    handle: "",
    variants: [{ id: "v1", title: "1 v" }],
  };

  // Active Get product
  const activeGetProduct = useMemo(() => {
    if (dealType === "BOGO" || dealType === "BUY_X_GET_X") {
      return activeBuyProduct;
    }
    return getProducts[0] || {
      id: "preview-get",
      title: "Beige Slip Dress",
      price: "69.00",
      image: "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-lifestyle-2_large.png",
      handle: "",
      variants: [{ id: "v2", title: "1 v" }],
    };
  }, [dealType, activeBuyProduct, getProducts]);

  const isSameProductReward = dealType === "BOGO" || dealType === "BUY_X_GET_X";

  const buyVariants = activeBuyProduct?.variants || [];
  const currentBuyVariant = buyVariants.find((v) => String(v.id) === String(selectedBuyVariantId)) || buyVariants[0];

  const getVariants = activeGetProduct?.variants || [];
  const currentGetVariant = isSameProductReward
    ? currentBuyVariant
    : (getVariants.find((v) => String(v.id) === String(selectedGetVariantId)) || getVariants[0]);

  const buyUnitPrice = parsePrice(currentBuyVariant?.price ?? activeBuyProduct.price) || 85.0;
  const getUnitPrice = isSameProductReward
    ? buyUnitPrice
    : (parsePrice(currentGetVariant?.price ?? activeGetProduct.price) || 69.0);

  const buyTotal = buyUnitPrice * parsedBuyQty;
  const getOriginalTotal = getUnitPrice * parsedGetQty;

  // Calculate discount amount on reward item(s)
  let rawDiscountAmount = 0;
  if (dealType === "BOGO") {
    rawDiscountAmount = getOriginalTotal;
  } else if (discountType === "FIXED_AMOUNT") {
    rawDiscountAmount = parsedDiscountValue * parsedGetQty;
  } else {
    rawDiscountAmount = getOriginalTotal * (parsedDiscountValue / 100);
  }

  // Apply optional Max Discount Cap
  let finalDiscountAmount = Math.min(getOriginalTotal, rawDiscountAmount);
  if (parsedMaxDiscount !== null && parsedMaxDiscount > 0) {
    finalDiscountAmount = Math.min(finalDiscountAmount, parsedMaxDiscount);
  }

  const discountedGetTotal = Math.max(0, getOriginalTotal - finalDiscountAmount);
  const discountedGetUnitPrice = parsedGetQty > 0 ? discountedGetTotal / parsedGetQty : 0;

  const originalGrandTotal = buyTotal + getOriginalTotal;
  const finalGrandTotal = buyTotal + discountedGetTotal;

  const isFixed = discountType === "FIXED_AMOUNT";
  const discountOffText = isFixed ? `$${parsedDiscountValue} off` : `${parsedDiscountValue}% off`;

  // Title header text
  const defaultHeaderTitle =
    widgetTitle ||
    (dealType === "BOGO"
      ? "Buy 1 Get 1 with 100% off"
      : dealType === "BUY_X_GET_X"
      ? `Buy ${parsedBuyQty} Get ${parsedGetQty} with ${discountOffText}`
      : isFixed
      ? `Buy ${parsedBuyQty} Get ${parsedGetQty} with ${discountOffText}`
      : `Buy ${parsedBuyQty} Get ${parsedGetQty} Special Deal`);

  const rawHeadingTemplate = widgetSettings?.content?.heading || "{widgettitle}";
  const resolvedHeading = (rawHeadingTemplate.includes("{widgettitle}")
    ? rawHeadingTemplate.replace(/{widgettitle}/gi, defaultHeaderTitle)
    : (widgetTitle?.trim() || rawHeadingTemplate))
    .replace(/{buy_qty}/gi, String(parsedBuyQty))
    .replace(/{get_qty}/gi, String(parsedGetQty))
    .replace(/{discount}/gi, discountOffText);

  const defaultRewardBadge =
    dealType === "BOGO" || parsedDiscountValue === 100
      ? `Add ${parsedGetQty} item${parsedGetQty > 1 ? "s" : ""} for 100% off`
      : discountType === "PERCENTAGE"
      ? `Add ${parsedGetQty} item${parsedGetQty > 1 ? "s" : ""} for ${parsedDiscountValue}% off`
      : `Add ${parsedGetQty} item${parsedGetQty > 1 ? "s" : ""} for $${parsedDiscountValue} off`;

  const rawBadgeTemplate = widgetSettings?.content?.badgeText || defaultRewardBadge;
  const resolvedBadgeText = rawBadgeTemplate
    .replace(/{get_qty}/gi, String(parsedGetQty))
    .replace(
      /{discount}/gi,
      dealType === "BOGO" || parsedDiscountValue === 100
        ? "100% off"
        : discountType === "PERCENTAGE"
        ? `${parsedDiscountValue}% off`
        : `$${parsedDiscountValue} off`
    );

  const totalItemsCount = parsedBuyQty + parsedGetQty;
  const rawBtnTemplate = widgetSettings?.content?.buttonText || "Add {total} items to Cart";
  const resolvedButtonText = rawBtnTemplate
    .replace(/{total}/gi, String(totalItemsCount))
    .replace(/{quantity}/gi, String(totalItemsCount));

  const rawBuyTag = widgetSettings?.content?.buyTagText || "Buy {buy_qty}/{buy_qty}";
  const resolvedBuyTag = rawBuyTag.replace(/{buy_qty}/gi, String(parsedBuyQty));

  const rawGetTag = widgetSettings?.content?.getTagText || "Get {get_qty}/{get_qty}";
  const resolvedGetTag = rawGetTag.replace(/{get_qty}/gi, String(parsedGetQty));

  const currentBuyHandle = activeBuyProduct?.handle;
  const cleanShop = shopDomain ? shopDomain.replace(/^https?:\/\//, "") : "";
  const viewOnStoreUrl = cleanShop && currentBuyHandle
    ? `https://${cleanShop}/products/${currentBuyHandle}`
    : cleanShop
      ? `https://${cleanShop}`
      : null;

  const cardContent = (
    <div
      style={{
        background: styles.cardSurface,
        border: `${styles.borderWidth}px solid ${styles.borderColor}`,
        borderRadius: `${styles.borderRadius}px`,
        padding: "16px",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
      }}
    >
      {/* Header with Title and Horizontal Divider */}
      {display.showWidgetTitle && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            marginBottom: "14px",
          }}
        >
          <span style={{ fontSize: "15px", fontWeight: 700, color: "#111827", whiteSpace: "nowrap" }}>
            {resolvedHeading}
          </span>
          {display.showDivider && <div style={{ flex: 1, height: "1.5px", background: "#e5e7eb" }} />}
        </div>
      )}

      {/* Card 1: Buy Item Card */}
      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: "8px",
          padding: "12px",
          background: "#ffffff",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        {/* Top Meta Line: Buy X/X label */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: "11px", fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.5px" }}>
            {resolvedBuyTag}
          </span>
        </div>

        {/* Content Row: Thumbnail + Product Info + Price */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <img
            src={activeBuyProduct.image || "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-lifestyle-1_large.png"}
            alt={activeBuyProduct.title}
            style={{ width: "44px", height: "44px", objectFit: "cover", borderRadius: "6px", background: "#f3f4f6", flexShrink: 0 }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: "13px",
                fontWeight: 600,
                color: "#111827",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {activeBuyProduct.title}
            </div>
            <div style={{ fontSize: "11px", color: "#6b7280", marginTop: "2px", whiteSpace: "nowrap" }}>
              {formatMoney(buyUnitPrice)} per item
            </div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0, paddingLeft: "8px" }}>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827" }}>
              {formatMoney(buyTotal)}
            </div>
          </div>
        </div>

        {/* Full-width Variant Selector Row if multiple variants exist */}
        {buyVariants.length > 1 && (
          <select
            value={currentBuyVariant?.id}
            onChange={(e) => setSelectedBuyVariantId(e.target.value)}
            style={{
              width: "100%",
              padding: "5px 8px",
              fontSize: "12px",
              color: "#374151",
              border: "1px solid #d1d5db",
              borderRadius: "6px",
              backgroundColor: "#ffffff",
              cursor: "pointer",
              outline: "none",
              boxSizing: "border-box",
            }}
          >
            {buyVariants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.title}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Centered Plus Icon */}
      {display.showPlusIcon && (
        <div style={{ display: "flex", justifyContent: "center", margin: "-6px 0", position: "relative", zIndex: 2 }}>
          <div
            style={{
              width: "24px",
              height: "24px",
              borderRadius: "50%",
              background: styles.plusBg,
              color: styles.plusColor,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "15px",
              fontWeight: 700,
              boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
            }}
          >
            +
          </div>
        </div>
      )}

      {/* Card 2: Get Item Card */}
      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: "8px",
          padding: "12px",
          background: "#ffffff",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        {/* Top Meta Line: Get Y/Y on Left, Badge on Right */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: "11px", fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.5px" }}>
            {resolvedGetTag}
          </span>
          {display.showBadge && (
            <span
              style={{
                fontSize: "10px",
                fontWeight: 600,
                background: styles.badgeBg,
                color: styles.badgeTextColor,
                padding: "2px 8px",
                borderRadius: "10px",
                whiteSpace: "nowrap",
              }}
            >
              {resolvedBadgeText}
            </span>
          )}
        </div>

        {/* Content Row: Thumbnail + Product Info + Price */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <img
            src={activeGetProduct.image || "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-lifestyle-2_large.png"}
            alt={activeGetProduct.title}
            style={{ width: "44px", height: "44px", objectFit: "cover", borderRadius: "6px", background: "#f3f4f6", flexShrink: 0 }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: "13px",
                fontWeight: 600,
                color: "#111827",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {activeGetProduct.title}
            </div>
            <div style={{ fontSize: "11px", color: "#6b7280", marginTop: "2px", whiteSpace: "nowrap" }}>
              {formatMoney(discountedGetUnitPrice)} per item
            </div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0, paddingLeft: "8px" }}>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827" }}>
              {formatMoney(discountedGetTotal)}
            </div>
            {finalDiscountAmount > 0 && (
              <div style={{ fontSize: "11px", color: "#9ca3af", textDecoration: "line-through" }}>
                {formatMoney(getOriginalTotal)}
              </div>
            )}
          </div>
        </div>

        {/* If same-product BOGO/BUY_X_GET_X: show mirrored variant name if multiple variants */}
        {isSameProductReward ? (
          buyVariants.length > 1 && (
            <div style={{ fontSize: "11px", color: "#6b7280", padding: "2px 0" }}>
              Variant: <span style={{ fontWeight: 600, color: "#374151" }}>{currentBuyVariant?.title}</span>
            </div>
          )
        ) : (
          /* For BUY_X_GET_Y (Different Products): show reward product variant selector */
          getVariants.length > 1 && (
            <select
              value={currentGetVariant?.id}
              onChange={(e) => setSelectedGetVariantId(e.target.value)}
              style={{
                width: "100%",
                padding: "5px 8px",
                fontSize: "12px",
                color: "#374151",
                border: "1px solid #d1d5db",
                borderRadius: "6px",
                backgroundColor: "#ffffff",
                cursor: "pointer",
                outline: "none",
                boxSizing: "border-box",
              }}
            >
              {getVariants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.title}
                </option>
              ))}
            </select>
          )
        )}
      </div>

      {/* Pricing Summary */}
      {display.showSavings && (
        <div style={{ marginTop: "14px", paddingTop: "10px", borderTop: "1px dashed #e5e7eb" }}>
          {finalDiscountAmount > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "4px" }}>
              <span style={{ color: "#6b7280" }}>Discount</span>
              <span style={{ fontWeight: 600, color: "#ef4444" }}>
                -{formatMoney(finalDiscountAmount)}
              </span>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontSize: "13px", fontWeight: 600, color: "#111827" }}>Total</span>
            <div style={{ textAlign: "right" }}>
              {finalDiscountAmount > 0 && (
                <span style={{ fontSize: "12px", color: "#9ca3af", textDecoration: "line-through", marginRight: "6px" }}>
                  {formatMoney(originalGrandTotal)}
                </span>
              )}
              <span style={{ fontSize: "15px", fontWeight: 800, color: "#111827" }}>
                {formatMoney(finalGrandTotal)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Single Add to Cart Action Button */}
      {display.showAddToCart && (
        <button
          type="button"
          style={{
            width: "100%",
            marginTop: "14px",
            padding: "10px 16px",
            background: styles.buttonBg,
            color: styles.buttonTextColor,
            border: "none",
            borderRadius: `${styles.buttonBorderRadius}px`,
            fontSize: "13px",
            fontWeight: 600,
            cursor: "pointer",
            transition: "background 0.15s ease",
          }}
        >
          {resolvedButtonText}
        </button>
      )}
    </div>
  );

  if (!asSection) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {cardContent}
      </div>
    );
  }

  return (
    <s-section slot="aside" heading="How widget looks">
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {/* Top Reference Bar: Page selector & View on Store link */}
        <s-stack
          direction="inline"
          alignItems={buyProducts.length > 1 ? "end" : "center"}
          justifyContent="space-between"
        >
          {buyProducts.length > 1 ? (
            <s-box inlineSize="48%">
              <s-select
                label="Page:"
                value={String(activeProductIndex)}
                onChange={(e) => setSelectedProductIndex(Number(e.target.value))}
                accessibilityLabel="Select product page preview"
              >
                {buyProducts.map((p, idx) => (
                  <s-option key={p.id || idx} value={String(idx)}>
                    {p.title}
                  </s-option>
                ))}
              </s-select>
            </s-box>
          ) : (
            <span style={{ fontSize: "11px", color: "#64748b", fontWeight: 500 }}>
              {buyProducts.length === 0 ? "✨ Showing sample preview" : "✨ Live widget preview"}
            </span>
          )}

          {viewOnStoreUrl ? (
            <s-button
              href={viewOnStoreUrl}
              target="_blank"
              icon="view"
            >
              View on Store
            </s-button>
          ) : (
            <s-button
              disabled
              icon="view"
            >
              View on Store
            </s-button>
          )}
        </s-stack>

        {/* Preview Card */}
        {cardContent}

        {/* Widget Settings link */}
        <div style={{ textAlign: "center", display: "flex", justifyContent: "center" }}>
          <s-link href="/app/offers/bogo/customize">
            <s-stack direction="inline" alignItems="center" gap="small-400">
              <s-icon type="edit" size="small" />
              Widget Settings
            </s-stack>
          </s-link>
        </div>
      </div>
    </s-section>
  );
}
