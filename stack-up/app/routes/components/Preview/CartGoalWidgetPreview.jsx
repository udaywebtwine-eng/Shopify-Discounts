import { useState, useMemo } from "react";

/**
 * CartGoalWidgetPreview
 * Live interactive widget preview matching StackUp's other 4 preview components.
 * Supports both asSection={true} for Offer Create/Edit aside slot,
 * and asSection={false} for the Widget Customization Studio.
 */
export default function CartGoalWidgetPreview({
  title = "",
  widgetTitle = "",
  tiers = [],
  applyTo = "ALL",
  collections = [],
  products = [],
  asSection = false,
  widgetSettings = null,
  shopDomain = "",
  initialSubtotal = 65,
  showSimulator = true,
  previewMode = "drawer", // "drawer" | "page"
  currency = "",
}) {
  const [simulatedSubtotal, setSimulatedSubtotal] = useState(initialSubtotal);
  const [selectedVariants, setSelectedVariants] = useState({});

  const formatMoney = (amount) => {
    const cur = currency ? currency.toUpperCase() : "";
    try {
      if (cur) {
        return new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: cur,
          currencyDisplay: "narrowSymbol",
        }).format(amount);
      }
    } catch { }
    return `$${Number(amount || 0).toFixed(2)}`;
  };

  // Default fallback settings
  const contentConfig = {
    heading: widgetSettings?.content?.heading || "{widgettitle}",
    initialMessage: widgetSettings?.content?.initialMessage || "Add {{remaining}} more to unlock {{next_tier}}!",
    progressMessage: widgetSettings?.content?.progressMessage || "🎉 {{current_tier}} unlocked! Add {{remaining}} for {{next_tier}}!",
    completedMessage: widgetSettings?.content?.completedMessage || "🎉 Congratulations! You unlocked maximum savings + Free Shipping!",
  };

  const stylesConfig = {
    cardSurface: widgetSettings?.styles?.cardSurface || "#ffffff",
    borderColor: widgetSettings?.styles?.borderColor || "#e5e7eb",
    borderWidth: widgetSettings?.styles?.borderWidth ?? 1,
    borderRadius: widgetSettings?.styles?.borderRadius ?? 12,
    barColor: widgetSettings?.styles?.barColor || "#000000",
    trackColor: widgetSettings?.styles?.trackColor || "#e5e7eb",
    achievedColor: widgetSettings?.styles?.achievedColor || "#10b981",
    barHeight: widgetSettings?.styles?.barHeight ?? 8,
    textColor: widgetSettings?.styles?.textColor || "#111827",
    milestoneTextColor: widgetSettings?.styles?.milestoneTextColor || "#6b7280",
  };

  const displayConfig = {
    showWidgetTitle: widgetSettings?.display?.showWidgetTitle !== false,
    showMilestoneIcons: widgetSettings?.display?.showMilestoneIcons !== false,
    showCelebrationEmojis: widgetSettings?.display?.showCelebrationEmojis !== false,
    showInCartDrawer: widgetSettings?.display?.showInCartDrawer !== false,
    showOnCartPage: widgetSettings?.display?.showOnCartPage !== false,
  };

  // Sort tiers by minAmount
  const sortedTiers = useMemo(() => {
    if (!Array.isArray(tiers) || tiers.length === 0) {
      return [
        { minAmount: 50, discountType: "PERCENTAGE", discountValue: 10, label: "10% off" },
        { minAmount: 100, discountType: "PERCENTAGE", discountValue: 15, hasFreeShipping: true, label: "Free Shipping" },
        { minAmount: 150, discountType: "PERCENTAGE", discountValue: 20, freeGift: { title: "Amber Glow Candle Mini" }, label: "Free Gift" },
      ];
    }
    return [...tiers].sort((a, b) => (Number(a.minAmount) || 0) - (Number(b.minAmount) || 0));
  }, [tiers]);

  const maxThreshold = useMemo(() => {
    const highest = sortedTiers[sortedTiers.length - 1];
    return Math.max(100, Number(highest?.minAmount) || 100);
  }, [sortedTiers]);

  // Determine current achieved tier and next tier
  const { currentTier, nextTier, progressPercent, remainingForNext } = useMemo(() => {
    let current = null;
    let next = null;

    for (const t of sortedTiers) {
      const min = Number(t.minAmount) || 0;
      if (simulatedSubtotal >= min) {
        current = t;
      } else if (!next) {
        next = t;
      }
    }

    let pct = 0;
    if (simulatedSubtotal >= maxThreshold) {
      pct = 100;
    } else {
      pct = Math.min(100, Math.max(0, (simulatedSubtotal / maxThreshold) * 100));
    }

    const rem = next ? Math.max(0, (Number(next.minAmount) || 0) - simulatedSubtotal) : 0;
    return {
      currentTier: current,
      nextTier: next,
      progressPercent: pct,
      remainingForNext: rem,
    };
  }, [sortedTiers, simulatedSubtotal, maxThreshold]);

  // Format cumulative reward labels dynamically based on achieved tier settings
  const formatCumulativeRewards = (achieved) => {
    if (!achieved || achieved.length === 0) return "maximum savings";
    const parts = [];
    const discTier = achieved.slice().reverse().find((t) => parseFloat(t.discountValue) > 0);
    if (discTier) {
      const val = parseFloat(discTier.discountValue);
      parts.push(discTier.discountType === "FIXED_AMOUNT" ? `${formatMoney(val)} off` : `${val}% off`);
    }
    if (achieved.some((t) => Boolean(t.hasFreeShipping))) {
      parts.push("Free Shipping");
    }
    const giftTier = achieved.slice().reverse().find((t) => t.freeGift && (t.freeGift.title || t.freeGift.variantId));
    if (giftTier) {
      parts.push(`Free ${giftTier.freeGift.title || "Gift"}`);
    }
    return parts.length > 0 ? parts.join(" + ") : "maximum savings";
  };

  const formatTierNewReward = (tier) => {
    if (!tier) return "next reward";
    const parts = [];
    const val = parseFloat(tier.discountValue) || 0;
    if (val > 0) {
      parts.push(tier.discountType === "FIXED_AMOUNT" ? `${formatMoney(val)} off` : `${val}% off`);
    }
    if (tier.hasFreeShipping) parts.push("Free Shipping");
    if (tier.freeGift && (tier.freeGift.title || tier.freeGift.variantId)) {
      parts.push(`Free ${tier.freeGift.title || "Gift"}`);
    }
    return parts.length > 0 ? parts.join(" + ") : (tier.label || "next tier");
  };

  // Interpolate dynamic motivational copy
  const motivationalMessage = useMemo(() => {
    const achievedTiers = sortedTiers.filter((t) => simulatedSubtotal >= Number(t.minAmount));
    if (progressPercent >= 100) {
      const rewardText = formatCumulativeRewards(achievedTiers.length > 0 ? achievedTiers : sortedTiers);
      return `🎉 Congratulations! You unlocked ${rewardText}!`;
    }
    if (achievedTiers.length > 0 && nextTier) {
      const currentRewardText = formatCumulativeRewards(achievedTiers);
      const nextRewardText = formatTierNewReward(nextTier);
      return (
        <span>
          <span
            style={{
              color: "#16a34a",
              fontWeight: "800",
              marginRight: "6px",
              fontSize: "15px",
            }}
          >
            🎉 {currentRewardText} unlocked!
          </span>
          <span style={{ color: stylesConfig.textColor || "#0f172a", fontSize: "14.5px", fontWeight: "600" }}>
            Add <strong>{formatMoney(remainingForNext)}</strong> for <strong>{nextRewardText}</strong>!
          </span>
        </span>
      );
    }
    if (nextTier) {
      const nextRewardText = formatTierNewReward(nextTier);
      return `Add ${formatMoney(remainingForNext)} more to unlock ${nextRewardText}!`;
    }
    return "Add items to your cart to unlock exclusive discounts!";
  }, [progressPercent, currentTier, nextTier, remainingForNext, contentConfig, sortedTiers, simulatedSubtotal]);

  // Resolve widget heading
  const offerHeading = widgetTitle?.trim() || title?.trim() || "Spend More, Save More";
  const globalHeading = contentConfig.heading || "{widgettitle}";
  const resolvedHeading = globalHeading.includes("{widgettitle}")
    ? globalHeading.replace(/{widgettitle}/gi, offerHeading)
    : (widgetTitle?.trim() || globalHeading);

  // Active discount savings calculation
  const currentDiscountAmount = useMemo(() => {
    if (!currentTier) return 0;
    if (currentTier.discountType === "PERCENTAGE") {
      return (simulatedSubtotal * (Number(currentTier.discountValue) || 0)) / 100;
    }
    return Math.min(simulatedSubtotal, Number(currentTier.discountValue) || 0);
  }, [currentTier, simulatedSubtotal]);

  // Is Free Gift unlocked
  const isFreeGiftUnlocked = useMemo(() => {
    return sortedTiers.some((t) => t.freeGift && simulatedSubtotal >= (Number(t.minAmount) || 0));
  }, [sortedTiers, simulatedSubtotal]);

  // Is Free Shipping unlocked
  const isFreeShippingUnlocked = useMemo(() => {
    return sortedTiers.some((t) => t.hasFreeShipping && simulatedSubtotal >= (Number(t.minAmount) || 0));
  }, [sortedTiers, simulatedSubtotal]);

  // Scope Badge Text for Specific Collections / Products
  const scopeBadgeText = useMemo(() => {
    if (applyTo === "COLLECTIONS" && Array.isArray(collections) && collections.length > 0) {
      const names = collections.map((c) => c.title || "Collection").join(", ");
      return (
        <>
          🏷️ Valid on: <strong style={{ color: "#111827", fontWeight: "600" }}>{names}</strong> collection only
        </>
      );
    }
    if (applyTo === "PRODUCTS" && Array.isArray(products) && products.length > 0) {
      if (products.length === 1) {
        return (
          <>
            🏷️ Valid on: <strong style={{ color: "#111827", fontWeight: "600" }}>{products[0].title || "Product"}</strong> only
          </>
        );
      }
      return (
        <>
          🏷️ Valid on selected <strong style={{ color: "#111827", fontWeight: "600" }}>{products.length} products</strong> only
        </>
      );
    }
    return null;
  }, [applyTo, collections, products]);

  // Card element containing the progress bar
  const progressBarCard = (
    <div
      style={{
        backgroundColor: stylesConfig.cardSurface,
        border: `${stylesConfig.borderWidth}px solid ${stylesConfig.borderColor}`,
        borderRadius: `${stylesConfig.borderRadius || 14}px`,
        padding: "16px 20px 14px 20px",
        boxShadow: "0 4px 15px -3px rgba(0, 0, 0, 0.05), 0 2px 6px -2px rgba(0, 0, 0, 0.03)",
        marginBottom: "16px",
      }}
    >
      {/* Optional Widget Title */}
      {displayConfig.showWidgetTitle && resolvedHeading && (
        <div
          style={{
            fontSize: "11px",
            fontWeight: "700",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: stylesConfig.textColor,
            opacity: 0.75,
            marginBottom: "8px",
            textAlign: "center",
          }}
        >
          {resolvedHeading}
        </div>
      )}

      {/* Scope Badge (Specific collections or specific products) */}
      {scopeBadgeText && (
        <div style={{ textAlign: "center", marginBottom: "10px" }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "11.5px",
              fontWeight: "500",
              lineHeight: "1.2",
              padding: "4px 12px",
              borderRadius: "9999px",
              backgroundColor: "#f8fafc",
              color: "#475569",
              border: "1px solid #e2e8f0",
              boxShadow: "0 1px 2px rgba(0, 0, 0, 0.03)",
              maxWidth: "90%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {scopeBadgeText}
          </span>
        </div>
      )}

      {/* Motivational Copy */}
      <div style={{ textAlign: "center", marginBottom: "14px" }}>
        <div
          style={{
            fontSize: "14.5px",
            fontWeight: "600",
            color: stylesConfig.textColor || "#0f172a",
            lineHeight: "1.45",
            letterSpacing: "-0.01em",
          }}
        >
          {motivationalMessage}
        </div>
      </div>

      {/* Progress Track & Markers */}
      <div style={{ position: "relative", marginBottom: "6px", padding: "12px 4px 16px 4px" }}>
        <div
          style={{
            width: "100%",
            height: `${Math.max(12, stylesConfig.barHeight || 12)}px`,
            backgroundColor: stylesConfig.trackColor || "#eef2f6",
            borderRadius: "9999px",
            overflow: "hidden",
            boxShadow: "inset 0 1px 2px rgba(0, 0, 0, 0.05)",
          }}
        >
          <div
            style={{
              width: `${progressPercent}%`,
              height: "100%",
              background: progressPercent >= 100
                ? "linear-gradient(90deg, #10b981 0%, #059669 100%)"
                : "linear-gradient(90deg, #22c55e 0%, #10b981 30%, #06b6d4 70%, #3b82f6 100%)",
              boxShadow: "0 1px 4px rgba(6, 182, 212, 0.35)",
              borderRadius: "9999px",
              transition: "width 0.4s cubic-bezier(0.25, 1, 0.5, 1)",
            }}
          />
        </div>

        {/* Milestone Dots along track */}
        {displayConfig.showMilestoneIcons &&
          sortedTiers.map((t, idx) => {
            const min = Number(t.minAmount) || 0;
            const pos = Math.min(100, (min / maxThreshold) * 100);
            const isAchieved = simulatedSubtotal >= min;

            let icon = "%";
            if (t.hasFreeShipping) icon = "🚚";
            if (t.freeGift) icon = "🎁";

            const isFirst = idx === 0;
            const isLast = idx === sortedTiers.length - 1;
            const markerTransform = isLast
              ? "translate(-100%, -50%)"
              : isFirst
                ? "translate(0%, -50%)"
                : "translate(-50%, -50%)";
            const markerAlign = isLast ? "flex-end" : isFirst ? "flex-start" : "center";

            return (
              <div
                key={idx}
                title={t.label || `${formatMoney(t.minAmount)}`}
                style={{
                  position: "absolute",
                  left: `${pos}%`,
                  top: "38%",
                  transform: markerTransform,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: markerAlign,
                }}
              >
                <div
                  style={{
                    width: "28px",
                    height: "28px",
                    borderRadius: "50%",
                    background: isAchieved
                      ? "linear-gradient(135deg, #22c55e 0%, #06b6d4 100%)"
                      : "#ffffff",
                    border: isAchieved ? "2.5px solid #ffffff" : "2.5px solid #e2e8f0",
                    color: isAchieved ? "#ffffff" : "#64748b",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "13.5px",
                    fontWeight: "700",
                    boxShadow: isAchieved
                      ? "0 0 0 2px rgba(6, 182, 212, 0.4), 0 3px 10px rgba(6, 182, 212, 0.45)"
                      : "0 2px 8px rgba(0, 0, 0, 0.08)",
                    transform: isAchieved ? "scale(1.1)" : "none",
                    transition: "all 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
                  }}
                >
                  {icon}
                </div>
              </div>
            );
          })}
      </div>

      {/* Eligible Products Section (When applyTo === "PRODUCTS" and products exist) */}
      {applyTo === "PRODUCTS" && Array.isArray(products) && products.length > 0 && (
        <div
          style={{
            marginTop: "16px",
            paddingTop: "14px",
            borderTop: "1px solid #f1f5f9",
            textAlign: "left",
          }}
        >
          <div
            style={{
              fontSize: "11.5px",
              fontWeight: "700",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: stylesConfig.textColor || "#334155",
              opacity: 0.85,
              marginBottom: "10px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span>Eligible Products to Unlock This Goal ({products.length}):</span>
            <span style={{ fontSize: "11px", fontWeight: "500", color: "#64748b" }}>
              Add to unlock discount
            </span>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              maxHeight: products.length > 3 ? "210px" : "none",
              overflowY: products.length > 3 ? "auto" : "visible",
              paddingRight: products.length > 3 ? "4px" : "0",
            }}
          >
            {products.map((p, pIdx) => {
              const pId = p.id || `prod-${pIdx}`;
              const variants = Array.isArray(p.variants) && p.variants.length > 0
                ? p.variants
                : (p.variantId ? [{ id: p.variantId, title: "Default", price: p.price || 0 }] : []);
              const hasMultipleVariants = variants.length > 1 && variants.some(v => v.title && v.title !== "Default Title");
              const currentVariantId = selectedVariants[pId] || variants[0]?.id || "";
              const activeVariant = variants.find(v => String(v.id) === String(currentVariantId)) || variants[0] || {};
              const variantPrice = activeVariant.price || p.price || 0;

              return (
                <div
                  key={pId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "8px 10px",
                    background: "#f8fafc",
                    border: "1px solid #e2e8f0",
                    borderRadius: "8px",
                    boxSizing: "border-box",
                  }}
                >
                  {/* Thumbnail */}
                  <div
                    style={{
                      width: "38px",
                      height: "38px",
                      borderRadius: "6px",
                      overflow: "hidden",
                      background: "#ffffff",
                      border: "1px solid #e2e8f0",
                      flexShrink: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {p.image ? (
                      <img
                        src={p.image}
                        alt={p.title}
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    ) : (
                      <span style={{ fontSize: "16px" }}>🛍️</span>
                    )}
                  </div>

                  {/* Product Info & Variant Dropdown */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <a
                      href={p.handle ? `/products/${p.handle}` : "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        fontSize: "12px",
                        fontWeight: "600",
                        color: "#0f172a",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        lineHeight: "1.3",
                        textDecoration: "none",
                        display: "block",
                      }}
                      title={p.title}
                    >
                      {p.title || "Product"}
                    </a>

                    <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "3px" }}>
                      {variantPrice > 0 && (
                        <span style={{ fontSize: "11px", fontWeight: "600", color: "#475569" }}>
                          {formatMoney(variantPrice)}
                        </span>
                      )}

                      {hasMultipleVariants && (
                        <select
                          value={currentVariantId}
                          onChange={(e) => setSelectedVariants((prev) => ({ ...prev, [pId]: e.target.value }))}
                          style={{
                            fontSize: "11px",
                            padding: "2px 6px",
                            borderRadius: "4px",
                            border: "1px solid #cbd5e1",
                            background: "#ffffff",
                            color: "#334155",
                            maxWidth: "130px",
                            cursor: "pointer",
                          }}
                        >
                          {variants.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.title}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => {
                        const addVal = variantPrice > 0 ? Number(variantPrice) : 50;
                        setSimulatedSubtotal((prev) => prev + addVal);
                      }}
                      style={{
                        fontSize: "11.5px",
                        fontWeight: "600",
                        padding: "5px 10px",
                        background: stylesConfig.barColor || "#0f172a",
                        color: "#ffffff",
                        border: "none",
                        borderRadius: "6px",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: "2px",
                        boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
                      }}
                      title="Add to cart"
                    >
                      + Add
                    </button>

                    <a
                      href={p.handle ? `/products/${p.handle}` : "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        fontSize: "11px",
                        fontWeight: "500",
                        padding: "4px 8px",
                        background: "#ffffff",
                        color: "#475569",
                        border: "1px solid #cbd5e1",
                        borderRadius: "6px",
                        textDecoration: "none",
                        cursor: "pointer",
                      }}
                      title="View product details"
                    >
                      View
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );

  // Content body
  const previewContent = (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Simulation Slider Control */}
      {showSimulator && (
        <div
          style={{
            background: "#f9fafb",
            border: "1px solid #e5e7eb",
            borderRadius: "8px",
            padding: "10px 14px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: "12px",
              color: "#4b5563",
            }}
          >
            <span>
              <strong>Simulated Subtotal:</strong> {formatMoney(simulatedSubtotal)}
            </span>
            <span style={{ fontSize: "11px", color: "#6b7280" }}>Drag to test milestone fill</span>
          </div>

          <input
            type="range"
            min="0"
            max={maxThreshold + 40}
            value={simulatedSubtotal}
            onChange={(e) => setSimulatedSubtotal(Number(e.target.value))}
            style={{ width: "100%", accentColor: stylesConfig.barColor, cursor: "pointer" }}
          />

          {/* Quick jump milestone preset buttons */}
          {/* <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", paddingTop: "2px" }}>
            <button
              type="button"
              onClick={() => setSimulatedSubtotal(30)}
              style={{
                fontSize: "11px",
                padding: "2px 8px",
                borderRadius: "4px",
                border: "1px solid #d1d5db",
                background: simulatedSubtotal === 30 ? "#111827" : "#ffffff",
                color: simulatedSubtotal === 30 ? "#ffffff" : "#374151",
                cursor: "pointer",
              }}
            >
              {formatMoney(30)} (0%)
            </button>
            {sortedTiers.map((t, idx) => {
              const amount = Number(t.minAmount) || 0;
              const isSelected = simulatedSubtotal === amount;
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setSimulatedSubtotal(amount)}
                  style={{
                    fontSize: "11px",
                    padding: "2px 8px",
                    borderRadius: "4px",
                    border: "1px solid #d1d5db",
                    background: isSelected ? "#111827" : "#ffffff",
                    color: isSelected ? "#ffffff" : "#374151",
                    cursor: "pointer",
                  }}
                >
                  {formatMoney(amount)} ({t.label || `Tier ${idx + 1}`})
                </button>
              );
            })}
          </div> */}
        </div>
      )}

      {/* Cart Container Mockup */}
      {previewMode === "drawer" ? (
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e5e7eb",
            borderRadius: "10px",
            padding: "16px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.05)",
          }}
        >
          {/* Cart Drawer Header */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              paddingBottom: "12px",
              borderBottom: "1px solid #f1f5f9",
              marginBottom: "14px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "14px", fontWeight: "700", color: "#111827" }}>Your Cart</span>
              <span
                style={{
                  background: "#f3f4f6",
                  color: "#4b5563",
                  fontSize: "11px",
                  fontWeight: "600",
                  padding: "1px 6px",
                  borderRadius: "999px",
                }}
              >
                {isFreeGiftUnlocked ? 3 : 2}
              </span>
            </div>
            <span style={{ fontSize: "14px", color: "#9ca3af", cursor: "pointer" }}>✕</span>
          </div>

          {/* THE LIVE PROGRESS BAR */}
          {progressBarCard}

          {/* Cart Drawer Items List */}
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "16px" }}>
            {/* Item 1 */}
            <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 0" }}>
              <div
                style={{
                  width: "42px",
                  height: "42px",
                  background: "#f1f5f9",
                  borderRadius: "6px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "18px",
                }}
              >
                🧺
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "12px", fontWeight: "600", color: "#111827", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  Coastal Woven Storage Basket
                </div>
                <div style={{ fontSize: "11px", color: "#6b7280" }}>Natural / Large • Qty: 1</div>
              </div>
              <div style={{ fontSize: "12px", fontWeight: "600" }}>{formatMoney(42)}</div>
            </div>

            {/* Item 2 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                padding: "8px 0",
                borderTop: "1px solid #f8fafc",
              }}
            >
              <div
                style={{
                  width: "42px",
                  height: "42px",
                  background: "#f1f5f9",
                  borderRadius: "6px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "18px",
                }}
              >
                🕯️
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "12px", fontWeight: "600", color: "#111827", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  Amber Glow Jar Candle
                </div>
                <div style={{ fontSize: "11px", color: "#6b7280" }}>Vanilla & Sandalwood • Qty: 1</div>
              </div>
              <div style={{ fontSize: "12px", fontWeight: "600" }}>{formatMoney(23)}</div>
            </div>

            {/* Dynamic Free Gift Item when unlocked */}
            {isFreeGiftUnlocked && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  padding: "8px 10px",
                  background: "#ecfdf5",
                  border: "1px dashed #10b981",
                  borderRadius: "6px",
                }}
              >
                <div
                  style={{
                    width: "36px",
                    height: "36px",
                    background: "#ffffff",
                    borderRadius: "6px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "16px",
                  }}
                >
                  🎁
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "12px", fontWeight: "700", color: "#065f46" }}>
                    Free Gift Unlocked!
                  </div>
                  <div style={{ fontSize: "11px", color: "#047857" }}>
                    Amber Glow Candle Mini • Free at checkout
                  </div>
                </div>
                <div style={{ fontSize: "12px", fontWeight: "700", color: "#059669" }}>{formatMoney(0)}</div>
              </div>
            )}
          </div>

          {/* Drawer Footer */}
          <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "12px" }}>
            {/* Free Shipping status pill */}
            {isFreeShippingUnlocked && (
              <div
                style={{
                  background: "#eff6ff",
                  border: "1px solid #bfdbfe",
                  borderRadius: "6px",
                  padding: "6px 10px",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  fontSize: "11px",
                  color: "#1e40af",
                  fontWeight: "600",
                  marginBottom: "10px",
                }}
              >
                <span>🚚</span>
                <span>Congratulations! You qualify for Free Standard Delivery!</span>
              </div>
            )}

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "12px",
                color: "#6b7280",
                marginBottom: "4px",
              }}
            >
              <span>Subtotal:</span>
              <span>{formatMoney(simulatedSubtotal)}</span>
            </div>

            {currentDiscountAmount > 0 && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "12px",
                  color: "#059669",
                  fontWeight: "600",
                  marginBottom: "4px",
                }}
              >
                <span>Tier Discount Savings:</span>
                <span>-{formatMoney(currentDiscountAmount)}</span>
              </div>
            )}

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "14px",
                fontWeight: "700",
                color: "#111827",
                marginTop: "6px",
                marginBottom: "12px",
              }}
            >
              <span>Estimated Total:</span>
              <span>{formatMoney(Math.max(0, simulatedSubtotal - currentDiscountAmount))}</span>
            </div>

            <div
              style={{
                background: "#000000",
                color: "#ffffff",
                textAlign: "center",
                padding: "10px",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: "700",
                cursor: "pointer",
                boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
              }}
            >
              Check out
            </div>
          </div>
        </div>
      ) : (
        /* Cart Page Preview Mode (/cart) */
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e5e7eb",
            borderRadius: "10px",
            padding: "20px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.05)",
          }}
        >
          <div style={{ fontSize: "18px", fontWeight: "700", color: "#111827", marginBottom: "16px" }}>
            Shopping Cart
          </div>

          {/* Full-width Cart Goal Banner */}
          {progressBarCard}

          {/* Cart Table Header */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "2fr 1fr 1fr",
              fontSize: "11px",
              fontWeight: "600",
              color: "#6b7280",
              borderBottom: "1px solid #e5e7eb",
              paddingBottom: "8px",
              marginBottom: "12px",
            }}
          >
            <span>PRODUCT</span>
            <span style={{ textAlign: "center" }}>QUANTITY</span>
            <span style={{ textAlign: "right" }}>TOTAL</span>
          </div>

          {/* Row 1 */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "2fr 1fr 1fr",
              alignItems: "center",
              fontSize: "12px",
              padding: "8px 0",
              borderBottom: "1px solid #f8fafc",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "16px" }}>🧺</span>
              <span style={{ fontWeight: "600" }}>Coastal Storage Basket</span>
            </div>
            <div style={{ textAlign: "center" }}>
              <span style={{ border: "1px solid #e5e7eb", padding: "2px 8px", borderRadius: "4px" }}>1</span>
            </div>
            <div style={{ textAlign: "right", fontWeight: "600" }}>{formatMoney(42)}</div>
          </div>

          {/* Row 2 */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "2fr 1fr 1fr",
              alignItems: "center",
              fontSize: "12px",
              padding: "8px 0",
              borderBottom: "1px solid #f8fafc",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "16px" }}>🕯️</span>
              <span style={{ fontWeight: "600" }}>Amber Glow Candle</span>
            </div>
            <div style={{ textAlign: "center" }}>
              <span style={{ border: "1px solid #e5e7eb", padding: "2px 8px", borderRadius: "4px" }}>1</span>
            </div>
            <div style={{ textAlign: "right", fontWeight: "600" }}>{formatMoney(23)}</div>
          </div>

          {/* Page Subtotal & Checkout */}
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "16px" }}>
            <div style={{ width: "220px", display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", fontWeight: "700" }}>
                <span>Subtotal:</span>
                <span>{formatMoney(simulatedSubtotal)}</span>
              </div>
              {currentDiscountAmount > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "#059669", fontWeight: "600" }}>
                  <span>Savings:</span>
                  <span>-{formatMoney(currentDiscountAmount)}</span>
                </div>
              )}
              <div
                style={{
                  background: "#000000",
                  color: "#ffffff",
                  textAlign: "center",
                  padding: "8px",
                  borderRadius: "6px",
                  fontSize: "12px",
                  fontWeight: "700",
                  marginTop: "6px",
                  cursor: "pointer",
                }}
              >
                Proceed to Checkout
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Widget Settings Shortcut */}
      {asSection && (
        <div style={{ textAlign: "center", display: "flex", justifyContent: "center", marginTop: "4px" }}>
          <s-link href="/app/customize/cart-goal">
            <s-stack direction="inline" alignItems="center" gap="small-400">
              <s-icon type="edit" size="small" />
              Customize Widget Copy & Colors
            </s-stack>
          </s-link>
        </div>
      )}
    </div>
  );

  if (asSection) {
    return (
      <s-section slot="aside" heading="Widget Preview">
        {previewContent}
      </s-section>
    );
  }

  return previewContent;
}
