import React, { useState } from "react";

/**
 * Helper to clean and parse price from various Shopify string/number formats
 */
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

/**
 * Live Widget Preview Component
 * Uses the exact saved widget styling and structure (from customize settings / shop metafield).
 */
export default function WidgetPreview({
  title = "",
  percentage = 10,
  mainProducts = [],
  subProducts = [],
  shopDomain = "",
  widgetSettings = null,
}) {
  const [selectedMainIndex, setSelectedMainIndex] = useState(0);

  // Fallback defaults matching saved widget settings
  const styles = {
    cardSurface: widgetSettings?.styles?.cardSurface || "#ffffff",
    borderColor: widgetSettings?.styles?.borderColor || "#e2e8f0",
    borderRadius: widgetSettings?.styles?.borderRadius ?? 12,
    plusIconBg: widgetSettings?.styles?.plusIconBg || "#f8fafc",
    plusIconColor: widgetSettings?.styles?.plusIconColor || "#475569",
    totalBoxBg: widgetSettings?.styles?.totalBoxBg || "#f8fafc",
    totalBoxBorderColor: widgetSettings?.styles?.totalBoxBorderColor || "#f1f5f9",
    badgeBg: widgetSettings?.styles?.badgeBg || "#ede9fe",
    badgeTextColor: widgetSettings?.styles?.badgeTextColor || "#6d28d9",
    buttonBg: widgetSettings?.styles?.buttonBg || "#0f172a",
    buttonTextColor: widgetSettings?.styles?.buttonTextColor || "#ffffff",
  };

  const content = {
    heading: widgetSettings?.content?.heading || "Frequently Bought Together",
    buttonText: widgetSettings?.content?.buttonText || "Add in cart",
  };

  const discountVal = Math.min(100, Math.max(0, parseFloat(percentage) || 0));

  // Active Main Product
  const activeMain = mainProducts.length > 0
    ? mainProducts[Math.min(selectedMainIndex, mainProducts.length - 1)]
    : {
      id: "sample-main",
      title: "Black Blazer Jacket",
      price: "$69.00",
      quantity: 2,
      image: "",
      isSample: true,
    };

  // Active Sub Products
  const activeSubs = subProducts.length > 0
    ? subProducts
    : [
      {
        id: "sample-sub-1",
        title: "Split-Front Denim Skirt",
        price: "$113.24",
        quantity: 1,
        image: "",
        isSample: true,
      },
      {
        id: "sample-sub-2",
        title: "Wool Shirt Jacket",
        price: "$169.00",
        quantity: 2,
        image: "",
        isSample: true,
      },
    ];

  const mainQty = Math.max(1, parseInt(activeMain?.quantity, 10) || 1);
  const mainUnitPrice = parsePrice(activeMain?.price || 69);
  const mainLinePrice = mainUnitPrice * mainQty;

  // Calculate Sub Products Prices
  let totalSubOriginal = 0;
  activeSubs.forEach((sub) => {
    const subQty = Math.max(1, parseInt(sub?.quantity, 10) || 1);
    const subUnitPrice = parsePrice(sub?.price || 50);
    totalSubOriginal += subUnitPrice * subQty;
  });

  const originalTotal = mainLinePrice + totalSubOriginal;
  const discountMultiplier = discountVal > 0 ? (100 - discountVal) / 100 : 1;
  const finalTotal = originalTotal * discountMultiplier;
  const savings = originalTotal - finalTotal;

  const totalItemsCount = mainQty + activeSubs.reduce((acc, sub) => acc + (parseInt(sub.quantity, 10) || 1), 0);

  // Storefront preview link
  const productHandle = activeMain?.handle;
  const cleanShop = shopDomain ? shopDomain.replace(/^https?:\/\//, "") : "";
  const viewOnStoreUrl = cleanShop && productHandle
    ? `https://${cleanShop}/products/${productHandle}`
    : cleanShop
      ? `https://${cleanShop}`
      : null;

  return (
    <s-section slot="aside" heading="How widget looks">
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {/* Top Reference Bar: Page selector & View on Store link */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
          }}
        >
          {mainProducts.length > 1 ? (
            <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <span style={{ fontSize: "11px", color: "#64748b", fontWeight: 600 }}>Page:</span>
              <select
                value={selectedMainIndex}
                onChange={(e) => setSelectedMainIndex(Number(e.target.value))}
                style={{
                  fontSize: "11px",
                  padding: "2px 6px",
                  borderRadius: "4px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#0f172a",
                  maxWidth: "140px",
                }}
              >
                {mainProducts.map((p, idx) => (
                  <option key={p.id || idx} value={idx}>
                    {p.title}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <span style={{ fontSize: "11px", color: "#64748b", fontWeight: 500 }}>
              {activeMain.isSample ? "✨ Showing sample preview" : "✨ Live widget preview"}
            </span>
          )}

          {viewOnStoreUrl ? (
            <a
              href={viewOnStoreUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                fontSize: "11px",
                fontWeight: 600,
                color: "#4338ca",
                background: "#eef2ff",
                border: "1px solid #c7d2fe",
                padding: "3px 8px",
                borderRadius: "5px",
                textDecoration: "none",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              View on Store
            </a>
          ) : (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                fontSize: "11px",
                fontWeight: 500,
                color: "#94a3b8",
                background: "#f1f5f9",
                border: "1px solid #e2e8f0",
                padding: "3px 8px",
                borderRadius: "5px",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              View on Store
            </span>
          )}
        </div>

        {/* Storefront Widget Card (Matches saved styling, compact reference) */}
        <div
          style={{
            background: styles.cardSurface,
            border: `1px solid ${styles.borderColor}`,
            borderRadius: `${Math.max(8, styles.borderRadius - 2)}px`,
            padding: "10px",
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            boxSizing: "border-box",
          }}
        >
          {/* Widget Heading */}
          <div
            style={{
              fontSize: "12px",
              fontWeight: 700,
              color: "#0f172a",
              display: "flex",
              alignItems: "center",
              gap: "5px",
              paddingBottom: "1px",
            }}
          >
            <span style={{ fontSize: "11px" }}>✨</span>
            <span>{content.heading}</span>
          </div>

          {/* Product Stack */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {/* 1. Main Product Card */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "7px",
                padding: "6px 8px",
                background: "#ffffff",
                border: `1px solid ${styles.borderColor}`,
                borderRadius: `${Math.max(5, styles.borderRadius - 6)}px`,
              }}
            >
              {/* Checkbox */}
              <div
                style={{
                  width: "15px",
                  height: "15px",
                  borderRadius: "3px",
                  background: styles.buttonBg,
                  color: styles.buttonTextColor,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <svg width="8" height="6" viewBox="0 0 11 9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="1.5 4.5 4 7 9.5 1.5" />
                </svg>
              </div>

              {/* Thumb */}
              <div
                style={{
                  width: "34px",
                  height: "34px",
                  borderRadius: "5px",
                  border: "1px solid #f1f5f9",
                  background: "#f8fafc",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  overflow: "hidden",
                  flexShrink: 0,
                }}
              >
                {activeMain.image ? (
                  <img
                    src={activeMain.image}
                    alt={activeMain.title}
                    style={{ width: "100%", height: "100%", objectFit: "contain" }}
                  />
                ) : (
                  <span style={{ fontSize: "14px" }}>👕</span>
                )}
              </div>

              {/* Title & Qty Pill */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    color: "#0f172a",
                    lineHeight: 1.25,
                    wordBreak: "break-word",
                  }}
                  title={activeMain.title}
                >
                  {activeMain.title}
                </div>
                {mainQty > 1 && (
                  <div style={{ marginTop: "2px" }}>
                    <span
                      style={{
                        fontSize: "9px",
                        fontWeight: 600,
                        background: "#f1f5f9",
                        color: "#475569",
                        padding: "1px 5px",
                        borderRadius: "8px",
                        border: "1px solid #e2e8f0",
                      }}
                    >
                      Qty: {mainQty}
                    </span>
                  </div>
                )}
              </div>

              {/* Price */}
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: "11px", fontWeight: 700, color: "#0f172a" }}>
                  {formatMoney(mainLinePrice)}
                </div>
                {mainQty > 1 && (
                  <div style={{ fontSize: "9px", color: "#64748b" }}>
                    ({formatMoney(mainUnitPrice)} each)
                  </div>
                )}
              </div>
            </div>

            {/* Single Plus Separator between Main and Sub Products */}
            {activeSubs.length > 0 && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "6px",
                  margin: "-2px 0",
                }}
              >
                <div style={{ flex: 1, height: "1px", background: "#f1f5f9" }} />
                <div
                  style={{
                    width: "16px",
                    height: "16px",
                    borderRadius: "50%",
                    background: styles.plusIconBg,
                    color: styles.plusIconColor,
                    border: `1px solid ${styles.borderColor}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "10px",
                    fontWeight: "bold",
                    flexShrink: 0,
                  }}
                >
                  +
                </div>
                <div style={{ flex: 1, height: "1px", background: "#f1f5f9" }} />
              </div>
            )}

            {/* 2. Sub Products List (NO plus icons between subproducts!) */}
            {activeSubs.map((sub, idx) => {
              const subQty = Math.max(1, parseInt(sub?.quantity, 10) || 1);
              const subUnitPrice = parsePrice(sub?.price || 50);
              const subLinePrice = subUnitPrice * subQty;

              return (
                <div
                  key={sub.id || idx}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "7px",
                    padding: "6px 8px",
                    background: "#ffffff",
                    border: `1px solid ${styles.borderColor}`,
                    borderRadius: `${Math.max(5, styles.borderRadius - 6)}px`,
                  }}
                >
                  {/* Checkbox */}
                  <div
                    style={{
                      width: "15px",
                      height: "15px",
                      borderRadius: "3px",
                      background: styles.buttonBg,
                      color: styles.buttonTextColor,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <svg width="8" height="6" viewBox="0 0 11 9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="1.5 4.5 4 7 9.5 1.5" />
                    </svg>
                  </div>

                  {/* Thumb */}
                  <div
                    style={{
                      width: "34px",
                      height: "34px",
                      borderRadius: "5px",
                      border: "1px solid #f1f5f9",
                      background: "#f8fafc",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      overflow: "hidden",
                      flexShrink: 0,
                    }}
                  >
                    {sub.image ? (
                      <img
                        src={sub.image}
                        alt={sub.title}
                        style={{ width: "100%", height: "100%", objectFit: "contain" }}
                      />
                    ) : (
                      <span style={{ fontSize: "14px" }}>🎁</span>
                    )}
                  </div>

                  {/* Title & Qty Pill (identical to storefront widget) */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "11px",
                        fontWeight: 600,
                        color: "#0f172a",
                        lineHeight: 1.25,
                        wordBreak: "break-word",
                      }}
                      title={sub.title}
                    >
                      {sub.title}
                    </div>
                    {subQty > 1 && (
                      <div style={{ marginTop: "2px" }}>
                        <span
                          style={{
                            fontSize: "9px",
                            fontWeight: 600,
                            background: "#f1f5f9",
                            color: "#475569",
                            padding: "1px 5px",
                            borderRadius: "8px",
                            border: "1px solid #e2e8f0",
                          }}
                        >
                          Qty: {subQty}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Price */}
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: "11px", fontWeight: 700, color: "#0f172a" }}>
                      {formatMoney(subLinePrice)}
                    </div>
                    {subQty > 1 && (
                      <div style={{ fontSize: "9px", color: "#64748b" }}>
                        ({formatMoney(subUnitPrice)} each)
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* BUNDLE SUBTOTAL Box */}
          <div
            style={{
              padding: "7px 9px",
              background: styles.totalBoxBg,
              border: `1px solid ${styles.totalBoxBorderColor}`,
              borderRadius: `${Math.max(5, styles.borderRadius - 6)}px`,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "4px",
              marginTop: "2px",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: "9px",
                  fontWeight: 600,
                  color: "#64748b",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                BUNDLE SUBTOTAL
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: "5px", marginTop: "1px" }}>
                <span style={{ fontSize: "14px", fontWeight: 800, color: "#0f172a" }}>
                  {formatMoney(finalTotal)}
                </span>
                {discountVal > 0 && (
                  <span
                    style={{
                      fontSize: "10px",
                      color: "#94a3b8",
                      textDecoration: "line-through",
                    }}
                  >
                    {formatMoney(originalTotal)}
                  </span>
                )}
              </div>
            </div>

            {discountVal > 0 && (
              <span
                style={{
                  background: styles.badgeBg,
                  color: styles.badgeTextColor,
                  fontSize: "9px",
                  fontWeight: 700,
                  padding: "3px 6px",
                  borderRadius: "12px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "3px",
                  whiteSpace: "nowrap",
                }}
              >
                <span>⚡</span>
                <span>
                  Save {formatMoney(savings)} ({discountVal}% OFF)
                </span>
              </span>
            )}
          </div>

          {/* Add to Cart Button */}
          <button
            type="button"
            style={{
              width: "100%",
              height: "32px",
              padding: "0 12px",
              background: styles.buttonBg,
              color: styles.buttonTextColor,
              borderRadius: `${Math.max(6, styles.borderRadius - 4)}px`,
              border: "none",
              fontWeight: 700,
              fontSize: "11px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "5px",
              boxShadow: "0 1px 4px rgba(0, 0, 0, 0.08)",
              marginTop: "2px",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <path d="M16 10a4 4 0 0 1-8 0" />
            </svg>
            <span>
              {content.buttonText && content.buttonText !== "Add Both to Cart"
                ? content.buttonText
                : `Add ${totalItemsCount} items in cart`}
            </span>
          </button>
        </div>

        {/* Widget Settings link */}
        <div style={{ textAlign: "center" }}>
          <a
            href="/app/paired-products/customize"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              fontSize: "11px",
              fontWeight: 600,
              color: "#4f46e5",
              textDecoration: "none",
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
            Widget Settings
          </a>
        </div>
      </div>
    </s-section>
  );
}
