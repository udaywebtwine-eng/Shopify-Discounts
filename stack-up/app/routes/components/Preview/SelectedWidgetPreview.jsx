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
  asSection = false,
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

  const currentTargetHandle = currentTarget?.handle;
  const cleanShop = shopDomain ? shopDomain.replace(/^https?:\/\//, "") : "";
  const viewOnStoreUrl = cleanShop && currentTargetHandle
    ? `https://${cleanShop}/products/${currentTargetHandle}`
    : cleanShop
      ? `https://${cleanShop}`
      : null;

  const cardContent = (
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
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
      }}
    >
      {/* Widget Heading & Badge */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "6px",
          paddingBottom: "1px",
        }}
      >
        {display.showWidgetTitle && (
          <div
            style={{
              fontSize: "12px",
              fontWeight: 700,
              color: "#0f172a",
              display: "flex",
              alignItems: "center",
              gap: "5px",
            }}
          >
            <span style={{ fontSize: "11px" }}>✨</span>
            <span>{resolvedHeading}</span>
          </div>
        )}

        {display.showSaleBadge && discPct > 0 && (
          <span
            style={{
              background: styles.badgeBg,
              color: styles.badgeTextColor,
              fontSize: "9px",
              fontWeight: 700,
              padding: "2px 6px",
              borderRadius: "12px",
              border: "1px solid rgba(16, 185, 129, 0.25)",
              display: "inline-flex",
              alignItems: "center",
              gap: "3px",
              whiteSpace: "nowrap",
            }}
          >
            <span>⚡</span>
            <span>{badgeLabel}</span>
          </span>
        )}
      </div>

      {/* Subheading */}
      {display.showSubheading && content.subheading && (
        <div
          style={{
            fontSize: "10px",
            color: "#64748b",
            lineHeight: 1.3,
            marginBottom: "2px",
          }}
        >
          {content.subheading}
        </div>
      )}

      {/* Add-ons list */}
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
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
                gap: "7px",
                padding: "6px 8px",
                background: "#ffffff",
                border: `1px solid ${checked ? "#cbd5e1" : styles.borderColor}`,
                borderRadius: `${Math.max(5, styles.borderRadius - 6)}px`,
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              {/* Checkbox */}
              <div
                style={{
                  width: "15px",
                  height: "15px",
                  borderRadius: "3px",
                  background: checked ? styles.buttonBg : "#ffffff",
                  border: checked ? `1px solid ${styles.buttonBg}` : "1px solid #cbd5e1",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: styles.buttonTextColor,
                  flexShrink: 0,
                }}
              >
                {checked && (
                  <svg width="8" height="6" viewBox="0 0 11 9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="1.5 4.5 4 7 9.5 1.5" />
                  </svg>
                )}
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
                {item.image ? (
                  <img
                    src={item.image}
                    alt={item.title}
                    style={{ width: "100%", height: "100%", objectFit: "contain" }}
                  />
                ) : (
                  <span style={{ fontSize: "14px" }}>🎁</span>
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
                  title={item.title}
                >
                  {item.title}
                </div>
                {item.quantity && item.quantity > 1 && (
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
                      Qty: {item.quantity}
                    </span>
                  </div>
                )}
              </div>

              {/* Price */}
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: "11px", fontWeight: 700, color: discPct > 0 ? "#059669" : "#0f172a" }}>
                  {formatMoney(discPrice)}
                </div>
                {discPct > 0 && (
                  <div style={{ fontSize: "9px", color: "#94a3b8", textDecoration: "line-through", marginTop: "1px" }}>
                    {formatMoney(origPrice)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Total Box */}
      {display.showTotalBox && (
        <div
          style={{
            padding: "8px 10px",
            background: styles.totalBoxBg,
            border: `1px solid ${styles.borderColor}`,
            borderRadius: `${Math.max(6, styles.borderRadius - 4)}px`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
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
              TOTAL WITH {checkedCount} ADD-ON{checkedCount !== 1 ? "S" : ""}
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: "5px", marginTop: "1px" }}>
              <span style={{ fontSize: "14px", fontWeight: 800, color: "#0f172a" }}>
                {formatMoney(finalTotal)}
              </span>
              {totalSavings > 0 && (
                <span
                  style={{
                    fontSize: "10px",
                    color: "#94a3b8",
                    textDecoration: "line-through",
                  }}
                >
                  {formatMoney(mainPrice + addonsOriginal)}
                </span>
              )}
            </div>
          </div>

          {totalSavings > 0 && (
            <span
              style={{
                background: styles.badgeBg,
                color: styles.badgeTextColor,
                fontSize: "9px",
                fontWeight: 700,
                padding: "3px 6px",
                borderRadius: "12px",
                border: "1px solid rgba(16, 185, 129, 0.25)",
                display: "inline-flex",
                alignItems: "center",
                gap: "3px",
                whiteSpace: "nowrap",
              }}
            >
              <span>⚡</span>
              <span>Save {formatMoney(totalSavings)}</span>
            </span>
          )}
        </div>
      )}

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
        <span>{content.buttonText || "Add to Cart with Add-Ons"}</span>
      </button>
    </div>
  );

  if (!asSection) {
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
          alignItems={targetProducts.length > 1 ? "end" : "center"}
          justifyContent="space-between"
        >
          {targetProducts.length > 1 ? (
            <s-box inlineSize="48%">
              <s-select
                label="Page:"
                value={String(selectedTargetIndex)}
                onChange={(e) => setSelectedTargetIndex(Number(e.target.value))}
                accessibilityLabel="Select product page preview"
              >
                {targetProducts.map((p, idx) => (
                  <s-option key={p.id || idx} value={String(idx)}>
                    {p.title}
                  </s-option>
                ))}
              </s-select>
            </s-box>
          ) : (
            <span style={{ fontSize: "11px", color: "#64748b", fontWeight: 500 }}>
              {targetProducts.length === 0 ? "✨ Showing sample preview" : "✨ Live widget preview"}
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
          <s-link href="/app/offers/selected/customize">
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

