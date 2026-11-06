import React, { useState } from "react";

/**
 * Helper to clean and parse price
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
 * Normalizes any tier object to full options format
 */
function normalizeTier(t, idx = 0) {
  const quantity = Number(t.quantity ?? t.mq ?? (idx + 1));
  let discountType = t.discountType;
  if (!discountType) {
    if (t.t === "F") discountType = "fixed";
    else if (t.d === 0 || t.t === "N") discountType = "none";
    else discountType = "percent";
  }
  const value = discountType === "none" ? 0 : Number(t.value ?? t.d ?? 0);
  const title = t.title ?? (quantity === 1 ? "Buy 1" : (quantity === 3 ? "Buy 3+" : `Buy ${quantity}`));
  const label = t.label ?? t.s ?? (quantity === 1 ? "Standard" : (value > 0 ? `Save ${value}%` : ""));
  const badge = t.badge ?? t.b ?? (quantity === 2 ? "Most popular" : "");
  const isDefault = Boolean(t.isDefault ?? (idx === 0));

  return {
    quantity,
    discountType,
    value,
    title,
    label,
    badge,
    isDefault,
  };
}

/**
 * Live Volume Discount / Quantity Breaks Widget Preview
 * Matches the native storefront design (Buy more, Save more)
 */
export default function VolumeWidgetPreview({
  title = "",
  widgetTitle = "",
  products = [],
  tiers = [],
  shopDomain = "",
  asSection = false,
}) {
  const [selectedProductIndex, setSelectedProductIndex] = useState(0);

  // Fallback tiers matching standard presets
  const rawTiers = tiers && tiers.length > 0 ? tiers : [
    { quantity: 1, discountType: "none", value: 0, title: "Buy 1", label: "Standard", badge: "", isDefault: true },
    { quantity: 2, discountType: "percent", value: 10, title: "Buy 2", label: "Save 10%", badge: "Most popular", isDefault: false },
    { quantity: 3, discountType: "percent", value: 20, title: "Buy 3+", label: "Save 20%", badge: "", isDefault: false },
  ];

  const normalizedTiers = rawTiers.map(normalizeTier);

  const defaultIndex = Math.max(0, normalizedTiers.findIndex((t) => t.isDefault));
  const [selectedTierIndex, setSelectedTierIndex] = useState(defaultIndex >= 0 ? defaultIndex : 0);

  // Active product to preview
  const activeProductIndex = Math.min(Math.max(0, selectedProductIndex), Math.max(0, products.length - 1));
  const primaryProduct = products[activeProductIndex] || {
    title: "Premium Essential Hoodie",
    price: "125.40",
    image: "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-lifestyle-1_large.png",
    handle: "",
  };

  const basePrice = parsePrice(primaryProduct.price) || 125.40;

  const viewOnStoreUrl = shopDomain && primaryProduct?.handle
    ? `https://${shopDomain}/products/${primaryProduct.handle}`
    : null;

  const activeIndex = Math.min(Math.max(0, selectedTierIndex), normalizedTiers.length - 1);
  const activeTier = normalizedTiers[activeIndex] || normalizedTiers[0];

  const activeQty = activeTier.quantity;
  const isFixed = activeTier.discountType === "fixed";
  const hasDiscount = activeTier.discountType !== "none" && activeTier.value > 0;

  const originalTotal = basePrice * activeQty;
  let discountedTotal = originalTotal;
  let discountedUnitPrice = basePrice;

  if (hasDiscount) {
    if (isFixed) {
      discountedUnitPrice = Math.max(0, basePrice - activeTier.value);
      discountedTotal = discountedUnitPrice * activeQty;
    } else {
      discountedUnitPrice = basePrice * (1 - activeTier.value / 100);
      discountedTotal = originalTotal * (1 - activeTier.value / 100);
    }
  }

  const savedAmount = Math.max(0, originalTotal - discountedTotal);

  const cardContent = (
    <div
      style={{
        background: "#ffffff",
        border: "1px solid #e5e7eb",
        borderRadius: "14px",
        padding: "18px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
      }}
    >
      {/* Widget Heading with Horizontal Divider Line */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          marginBottom: "16px",
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: "16px",
            fontWeight: 700,
            color: "#111827",
            whiteSpace: "nowrap",
            letterSpacing: "-0.01em",
          }}
        >
          {widgetTitle?.trim() || "Buy more, Save more"}
        </h3>
        <div style={{ flex: 1, height: "1px", background: "#e5e7eb" }}></div>
      </div>

      {/* Target Product Bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "8px 10px",
          background: "#f9fafb",
          borderRadius: "8px",
          marginBottom: "14px",
          border: "1px solid #f3f4f6",
        }}
      >
        {primaryProduct.image ? (
          <img
            src={primaryProduct.image}
            alt={primaryProduct.title}
            style={{ width: "34px", height: "34px", objectFit: "cover", borderRadius: "6px" }}
          />
        ) : (
          <div
            style={{
              width: "34px",
              height: "34px",
              background: "#e5e7eb",
              borderRadius: "6px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "13px",
            }}
          >
            📦
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: "12px",
              fontWeight: 600,
              color: "#1f2937",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {primaryProduct.title}
          </div>
          <div style={{ fontSize: "11px", color: "#6b7280" }}>
            Base Price: <strong style={{ color: "#111827" }}>{formatMoney(basePrice)}</strong>
          </div>
        </div>
      </div>

      {/* Tiers List */}
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {normalizedTiers.map((tier, idx) => {
          const isSelected = idx === activeIndex;
          const qty = tier.quantity;
          const tierHasDiscount = tier.discountType !== "none" && tier.value > 0;
          const tierIsFixed = tier.discountType === "fixed";

          let tierTotal = basePrice * qty;
          if (tierHasDiscount) {
            if (tierIsFixed) {
              tierTotal = Math.max(0, basePrice - tier.value) * qty;
            } else {
              tierTotal = basePrice * qty * (1 - tier.value / 100);
            }
          }

          const rawTitle = tier.title || `Buy ${qty}`;
          const resolvedTitle = rawTitle.includes("{quantity}")
            ? rawTitle.replace(/\{quantity\}/gi, String(qty))
            : rawTitle;

          return (
            <div
              key={idx}
              onClick={() => setSelectedTierIndex(idx)}
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 18px",
                borderRadius: "12px",
                border: isSelected ? "2px solid #111827" : "1px solid #d1d5db",
                background: "#ffffff",
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              {/* Optional Red Ribbon for Badge (e.g. Most popular) */}
              {tier.badge && (
                <div
                  style={{
                    position: "absolute",
                    top: "-10px",
                    right: "18px",
                    background: "#c50707",
                    color: "#ffffff",
                    fontSize: "11px",
                    fontWeight: 700,
                    padding: "2px 10px",
                    borderRadius: "4px 4px 0 0",
                    letterSpacing: "0.02em",
                    boxShadow: "0 2px 4px rgba(197, 7, 7, 0.25)",
                    zIndex: 2,
                  }}
                >
                  {tier.badge}
                </div>
              )}

              {/* Left Side: Radio + Title + Pill Label */}
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div
                  style={{
                    width: "20px",
                    height: "20px",
                    borderRadius: "50%",
                    border: isSelected ? "6px solid #111827" : "2px solid #9ca3af",
                    background: "#ffffff",
                    boxSizing: "border-box",
                    flexShrink: 0,
                    transition: "border 0.15s ease",
                  }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "15px", fontWeight: 700, color: "#111827" }}>
                    {resolvedTitle}
                  </span>
                  {tier.label && (
                    <span
                      style={{
                        background: "#f3f4f6",
                        color: "#374151",
                        padding: "2px 10px",
                        borderRadius: "9999px",
                        fontSize: "12px",
                        fontWeight: 500,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {tier.label}
                    </span>
                  )}
                </div>
              </div>

              {/* Right Side: Total Price + Original Struck Price */}
              <div style={{ textAlign: "right" }}>
                <div
                  style={{
                    fontSize: "16px",
                    fontWeight: 700,
                    color: "#111827",
                    letterSpacing: "-0.01em",
                  }}
                >
                  {formatMoney(tierTotal)}
                </div>
                {tierHasDiscount && (
                  <div
                    style={{
                      fontSize: "13px",
                      color: "#9ca3af",
                      textDecoration: "line-through",
                      marginTop: "1px",
                    }}
                  >
                    {formatMoney(basePrice * qty)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer / CTA Button */}
      <div style={{ marginTop: "16px" }}>
        <button
          type="button"
          style={{
            width: "100%",
            background: "#111827",
            color: "#ffffff",
            border: "none",
            borderRadius: "10px",
            padding: "13px 16px",
            fontSize: "13px",
            fontWeight: 700,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
            boxShadow: "0 2px 4px rgba(0,0,0,0.08)",
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
            <line x1="3" y1="6" x2="21" y2="6" />
            <path d="M16 10a4 4 0 0 1-8 0" />
          </svg>
          <span>Add {activeQty} to Cart • {formatMoney(discountedTotal)}</span>
        </button>

        {savedAmount > 0 && (
          <div
            style={{
              marginTop: "8px",
              padding: "6px 8px",
              background: "#ecfdf5",
              borderRadius: "6px",
              textAlign: "center",
              fontSize: "11px",
              fontWeight: 700,
              color: "#059669",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "4px",
            }}
          >
            <span>🎉 Total Savings:</span>
            <span>{formatMoney(savedAmount)}</span>
            <span>({activeTier.value}% OFF)</span>
          </div>
        )}
      </div>
    </div>
  );

  if (asSection) {
    return cardContent;
  }

  return (
    <s-section slot="aside" heading="How widget looks">
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {/* Top Reference Bar: Page selector & View on Store link */}
        <s-stack
          direction="inline"
          alignItems={products.length > 1 ? "end" : "center"}
          justifyContent="space-between"
        >
          {products.length > 1 ? (
            <s-box inlineSize="48%">
              <s-select
                label="Page:"
                value={String(activeProductIndex)}
                onChange={(e) => setSelectedProductIndex(Number(e.target.value))}
                accessibilityLabel="Select product page preview"
              >
                {products.map((p, idx) => (
                  <s-option key={p.id || idx} value={String(idx)}>
                    {p.title}
                  </s-option>
                ))}
              </s-select>
            </s-box>
          ) : (
            <span style={{ fontSize: "11px", color: "#64748b", fontWeight: 500 }}>
              {products.length === 0 ? "✨ Sample Preview" : "✨ Live widget preview"}
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

        {cardContent}
      </div>
    </s-section>
  );
}
