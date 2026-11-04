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
 * Live Selected / Special Add-Ons Widget Preview Component
 */
export default function SelectedWidgetPreview({
  title = "",
  widgetTitle = "",
  percentage = 10,
  targetProducts = [],
  offeredProducts = [],
  shopDomain = "",
  widgetSettings = null,
}) {
  const [selectedTargetIndex, setSelectedTargetIndex] = useState(0);

  // Settings with defaults matching selected_widget_settings
  const styles = {
    cardSurface: widgetSettings?.styles?.cardSurface || "#ffffff",
    borderColor: widgetSettings?.styles?.borderColor || "#e2e8f0",
    borderRadius: widgetSettings?.styles?.borderRadius ?? 12,
    badgeBg: widgetSettings?.styles?.badgeBg || "#ecfdf5",
    badgeTextColor: widgetSettings?.styles?.badgeTextColor || "#065f46",
    buttonBg: widgetSettings?.styles?.buttonBg || "#0f172a",
    buttonTextColor: widgetSettings?.styles?.buttonTextColor || "#ffffff",
    totalBoxBg: widgetSettings?.styles?.totalBoxBg || "#f8fafc",
  };

  const globalHeading = widgetSettings?.content?.heading || "{widgettitle}";
  const offerHeading = widgetTitle?.trim() || "Special Add-Ons Just for You";
  const baseHeading = globalHeading.includes("{widgettitle}")
    ? globalHeading.replace(/{widgettitle}/gi, offerHeading)
    : (widgetTitle?.trim() || globalHeading);

  const resolvedHeading = baseHeading
    .replace(/{widgetname}/gi, title || "Special Offer")
    .replace(/{offername}/gi, title || "Special Offer")
    .replace(/{percentage}/gi, String(percentage || "0"));

  const content = {
    heading: resolvedHeading,
    subheading: widgetSettings?.content?.subheading || "Recommended companion items for this product",
    buttonText: widgetSettings?.content?.buttonText || "Add to Cart with Add-Ons",
    badgeText: widgetSettings?.content?.badgeText || "Save {percentage}% OFF Add-Ons",
  };

  const display = {
    showWidgetTitle: widgetSettings?.display?.showWidgetTitle !== false,
    showSubheading: widgetSettings?.display?.showSubheading !== false,
    showSaleBadge: widgetSettings?.display?.showSaleBadge !== false,
    showTotalBox: widgetSettings?.display?.showTotalBox !== false,
    checkByDefault: widgetSettings?.display?.checkByDefault !== false,
  };

  const currentTarget = targetProducts[selectedTargetIndex] || targetProducts[0] || {
    title: "Everyday Cotton Tee",
    price: "$30.00",
    image: "",
  };

  const mainPrice = parsePrice(currentTarget.price) || 30.0;
  const discPct = parseFloat(percentage) || 10;

  // Track checked states for preview
  const [checkedAddons, setCheckedAddons] = useState({});

  const sampleAddons = [
    { id: "sample-1", title: "Organic Canvas Tote", price: "$20.00", image: "" },
    { id: "sample-2", title: "Sport Wristband 2-Pack", price: "$15.00", image: "" },
  ];

  const effectiveAddons = offeredProducts.length > 0 ? offeredProducts : sampleAddons;

  const isChecked = (id, idx) => {
    if (checkedAddons[id] !== undefined) return checkedAddons[id];
    return display.checkByDefault;
  };

  const toggleCheck = (id, idx) => {
    setCheckedAddons((prev) => ({
      ...prev,
      [id]: !isChecked(id, idx),
    }));
  };

  // Calculate totals
  let addonsOriginal = 0;
  let addonsDiscounted = 0;
  let checkedCount = 0;

  effectiveAddons.forEach((item, idx) => {
    if (isChecked(item.id || idx, idx)) {
      checkedCount++;
      const p = parsePrice(item.price) || 20.0;
      const qty = item.quantity || 1;
      const orig = p * qty;
      const disc = orig * (1 - discPct / 100);
      addonsOriginal += orig;
      addonsDiscounted += disc;
    }
  });

  const finalTotal = mainPrice + addonsDiscounted;
  const totalSavings = addonsOriginal - addonsDiscounted;

  const badgeLabel = (content.badgeText || "Save {percentage}% OFF Add-Ons").replace(
    "{percentage}",
    String(discPct)
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {/* Target Product Switcher (if multiple target products) */}
      {targetProducts.length > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", fontSize: "12px" }}>
          <span style={{ fontWeight: 600, color: "#64748b" }}>Preview on Product:</span>
          {targetProducts.slice(0, 4).map((tp, idx) => (
            <button
              key={tp.id || idx}
              type="button"
              onClick={() => setSelectedTargetIndex(idx)}
              style={{
                border: selectedTargetIndex === idx ? "1px solid #0f172a" : "1px solid #cbd5e1",
                background: selectedTargetIndex === idx ? "#0f172a" : "#ffffff",
                color: selectedTargetIndex === idx ? "#ffffff" : "#334155",
                borderRadius: "6px",
                padding: "3px 8px",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
                maxWidth: "140px",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {tp.title || `Product ${idx + 1}`}
            </button>
          ))}
          {targetProducts.length > 4 && (
            <span style={{ color: "#94a3b8", fontSize: "11px" }}>+{targetProducts.length - 4} more</span>
          )}
        </div>
      )}

      {/* Widget Card Container */}
      <div
        style={{
          background: styles.cardSurface,
          borderRadius: `${styles.borderRadius}px`,
          border: `1px solid ${styles.borderColor}`,
          padding: "18px",
          boxShadow: "0 4px 20px -2px rgba(0,0,0,0.05), 0 2px 6px -1px rgba(0,0,0,0.02)",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            marginBottom: "6px",
            flexWrap: "wrap",
          }}
        >
          {display.showWidgetTitle && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "16px" }}>✨</span>
              <h3
                style={{
                  fontSize: "15px",
                  fontWeight: 700,
                  color: "#0f172a",
                  margin: 0,
                  letterSpacing: "-0.01em",
                }}
              >
                {title || content.heading}
              </h3>
            </div>
          )}

          {display.showSaleBadge && discPct > 0 && (
            <div
              style={{
                background: styles.badgeBg,
                color: styles.badgeTextColor,
                fontSize: "11px",
                fontWeight: 700,
                padding: "4px 10px",
                borderRadius: "20px",
                border: "1px solid rgba(16, 185, 129, 0.25)",
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              <span>⚡</span>
              <span>{badgeLabel}</span>
            </div>
          )}
        </div>

        {/* Subheading */}
        {display.showSubheading && content.subheading && (
          <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "12px" }}>
            {content.subheading}
          </div>
        )}

        {/* Add-ons list */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {effectiveAddons.map((item, idx) => {
            const checked = isChecked(item.id || idx, idx);
            const origPrice = parsePrice(item.price) || 20.0;
            const discPrice = origPrice * (1 - discPct / 100);

            return (
              <div
                key={item.id || idx}
                onClick={() => toggleCheck(item.id || idx, idx)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  padding: "10px 12px",
                  background: "#ffffff",
                  border: `1px solid ${checked ? "#cbd5e1" : styles.borderColor}`,
                  borderRadius: `${Math.max(6, styles.borderRadius - 4)}px`,
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                  boxShadow: checked ? "0 2px 6px rgba(0,0,0,0.03)" : "none",
                }}
              >
                {/* Custom Checkbox */}
                <div
                  style={{
                    width: "18px",
                    height: "18px",
                    borderRadius: "4px",
                    background: checked ? styles.buttonBg : "#ffffff",
                    border: checked ? `1px solid ${styles.buttonBg}` : "1px solid #cbd5e1",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: styles.buttonTextColor,
                    flexShrink: 0,
                    transition: "all 0.15s ease",
                  }}
                >
                  {checked && (
                    <svg width="10" height="8" viewBox="0 0 11 9" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="1.5 4.5 4 7 9.5 1.5" />
                    </svg>
                  )}
                </div>

                {/* Thumbnail */}
                <div
                  style={{
                    width: "44px",
                    height: "44px",
                    background: "#f8fafc",
                    border: "1px solid #f1f5f9",
                    borderRadius: "6px",
                    overflow: "hidden",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {item.image ? (
                    <img src={item.image} alt={item.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <span style={{ fontSize: "20px" }}>🎁</span>
                  )}
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "13px", fontWeight: 600, color: "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {item.title}
                  </div>
                  {item.quantity && item.quantity > 1 && (
                    <span style={{ fontSize: "10px", fontWeight: 600, background: "#f1f5f9", color: "#334155", padding: "1px 6px", borderRadius: "8px" }}>
                      Qty: {item.quantity}
                    </span>
                  )}
                </div>

                {/* Price */}
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: "14px", fontWeight: 700, color: "#059669" }}>
                    {formatMoney(discPrice)}
                  </div>
                  <div style={{ fontSize: "11px", color: "#94a3b8", textDecoration: "line-through", marginTop: "1px" }}>
                    {formatMoney(origPrice)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Total & Summary Box */}
        {display.showTotalBox && (
          <div
            style={{
              marginTop: "14px",
              padding: "12px 14px",
              background: styles.totalBoxBg,
              border: `1px solid ${styles.borderColor}`,
              borderRadius: `${Math.max(6, styles.borderRadius - 4)}px`,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "12px",
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ fontSize: "11px", color: "#64748b", fontWeight: 500, marginBottom: "2px" }}>
                Total with {checkedCount} add-on{checkedCount !== 1 ? "s" : ""}:
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
                <span style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a" }}>
                  {formatMoney(finalTotal)}
                </span>
                {totalSavings > 0 && (
                  <span style={{ fontSize: "13px", color: "#94a3b8", textDecoration: "line-through" }}>
                    {formatMoney(mainPrice + addonsOriginal)}
                  </span>
                )}
              </div>
            </div>

            {totalSavings > 0 && (
              <div
                style={{
                  background: styles.badgeBg,
                  color: styles.badgeTextColor,
                  border: "1px solid rgba(16, 185, 129, 0.25)",
                  fontSize: "11px",
                  fontWeight: 700,
                  padding: "4px 10px",
                  borderRadius: "20px",
                }}
              >
                Save {formatMoney(totalSavings)}
              </div>
            )}
          </div>
        )}

        {/* 1-Click Action Button */}
        <button
          type="button"
          style={{
            width: "100%",
            marginTop: "12px",
            padding: "12px 18px",
            background: styles.buttonBg,
            color: styles.buttonTextColor,
            border: "none",
            borderRadius: `${styles.borderRadius}px`,
            fontSize: "14px",
            fontWeight: 700,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
            boxShadow: "0 4px 12px rgba(15, 23, 42, 0.12)",
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path>
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <path d="M16 10a4 4 0 0 1-8 0"></path>
          </svg>
          <span>{content.buttonText}</span>
        </button>
      </div>
    </div>
  );
}

