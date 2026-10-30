import { useState, useEffect, useMemo } from "react";
import { useLoaderData, useActionData, useSubmit, useNavigation } from "react-router";
import { useAppBridge, SaveBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

// Default settings used as fallback if merchant hasn't saved customizations yet
const DEFAULT_SETTINGS = {
  content: {
    heading: "Frequently Bought Together",
    buttonText: "Add Both to Cart",
    badgeText: "Save {percentage}% OFF",
    subProductLabel: "Pair with:",
  },
  styles: {
    cardSurface: "#ffffff",
    borderColor: "#e5e7eb",
    borderWidth: 1,
    borderRadius: 12,
    plusIconBg: "#f3f4f6",
    plusIconColor: "#374151",
    totalBoxBg: "#f9fafb",
    totalBoxBorderColor: "#e5e7eb",
    badgeBg: "#ede9fe",
    badgeTextColor: "#6d28d9",
    buttonBg: "#111827",
    buttonTextColor: "#ffffff",
    buttonHoverBg: "#1f2937",
    accentColor: "#4f46e5",
  },
  display: {
    showWidgetTitle: true,
    linkProductTitles: true,
    showTotalBox: true,
    showPlusIcon: true,
    showSaleBadge: true,
    showCheckboxes: true,
  },
};

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shopName = session.shop.replace(".myshopify.com", "");

  // eslint-disable-next-line no-undef
  const clientId = process.env.SHOPIFY_API_KEY;

  let savedSettings = null;
  let activeThemeId = null;

  try {
    const response = await admin.graphql(
      `#graphql
      query GetWidgetSettingsAndTheme {
        shop {
          id
          metafield(namespace: "stack_up", key: "paired_widget_settings") {
            value
          }
        }
        themes(first: 1, roles: [MAIN]) {
          nodes {
            id
          }
        }
      }`
    );
    const json = await response.json();
    const rawMetafield = json.data?.shop?.metafield?.value;
    if (rawMetafield) {
      try {
        savedSettings = JSON.parse(rawMetafield);
      } catch (e) {
        console.warn("Failed to parse paired_widget_settings:", e);
      }
    }
    const themeNode = json.data?.themes?.nodes?.[0];
    activeThemeId = themeNode?.id?.split("/").pop() || null;
  } catch (err) {
    console.warn("Error fetching widget settings:", err);
  }

  const themeEditorUrl = activeThemeId
    ? `https://admin.shopify.com/store/${shopName}/themes/${activeThemeId}/editor?context=apps${
        clientId ? `&activateAppId=${encodeURIComponent(`${clientId}/app-embed`)}` : ""
      }`
    : `https://admin.shopify.com/store/${shopName}/themes/current/editor?context=apps`;

  return {
    settings: savedSettings || DEFAULT_SETTINGS,
    themeEditorUrl,
    shopName,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const rawPayload = formData.get("settings");

  if (!rawPayload) {
    return { error: "No settings payload provided." };
  }

  try {
    const shopRes = await admin.graphql(
      `#graphql
      query GetShopId {
        shop {
          id
        }
      }`
    );
    const shopJson = await shopRes.json();
    const shopId = shopJson.data?.shop?.id;

    if (!shopId) {
      return { error: "Could not retrieve Shop ID." };
    }

    const mutationRes = await admin.graphql(
      `#graphql
      mutation SaveWidgetSettings($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            value
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              ownerId: shopId,
              namespace: "stack_up",
              key: "paired_widget_settings",
              type: "json",
              value: String(rawPayload),
            },
          ],
        },
      }
    );

    const mutationJson = await mutationRes.json();
    const userErrors = mutationJson.data?.metafieldsSet?.userErrors || [];
    if (userErrors.length > 0) {
      return { error: userErrors.map((e) => e.message).join(", ") };
    }

    return { success: true };
  } catch (err) {
    console.error("Error saving widget settings:", err);
    return { error: "Failed to save widget settings. Please try again." };
  }
};

export default function PairedProductsCustomize() {
  const { settings: initialSettings, themeEditorUrl } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const isSaving = navigation.state === "submitting";

  // Form State
  const [content, setContent] = useState(initialSettings.content || DEFAULT_SETTINGS.content);
  const [styles, setStyles] = useState(initialSettings.styles || DEFAULT_SETTINGS.styles);
  const [display, setDisplay] = useState(initialSettings.display || DEFAULT_SETTINGS.display);

  // Accordion Section Expansion State
  const [openSections, setOpenSections] = useState({
    content: true,
    styles: true,
    display: true,
  });

  const toggleSection = (section) => {
    setOpenSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  // Track if changes have been made (Dirty check)
  const isDirty = useMemo(() => {
    return (
      JSON.stringify(content) !== JSON.stringify(initialSettings.content || DEFAULT_SETTINGS.content) ||
      JSON.stringify(styles) !== JSON.stringify(initialSettings.styles || DEFAULT_SETTINGS.styles) ||
      JSON.stringify(display) !== JSON.stringify(initialSettings.display || DEFAULT_SETTINGS.display)
    );
  }, [content, styles, display, initialSettings]);

  // Handle SaveBar discard
  const handleDiscard = () => {
    setContent(initialSettings.content || DEFAULT_SETTINGS.content);
    setStyles(initialSettings.styles || DEFAULT_SETTINGS.styles);
    setDisplay(initialSettings.display || DEFAULT_SETTINGS.display);
    shopify.saveBar?.hide("customize-paired-widget-savebar");
  };

  // Handle SaveBar save
  const handleSave = () => {
    const fullPayload = {
      content,
      styles,
      display,
    };
    const formData = new FormData();
    formData.append("settings", JSON.stringify(fullPayload));
    submit(formData, { method: "post" });
  };

  // Toast feedback on save success/error
  useEffect(() => {
    if (actionData?.success) {
      shopify.toast.show("Widget customizations saved!");
      shopify.saveBar?.hide("customize-paired-widget-savebar");
    } else if (actionData?.error) {
      shopify.toast.show(actionData.error, { isError: true });
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Paired Products Customization">
      <s-link slot="breadcrumb-actions" href="/app/paired-products">
        Paired Products Offers
      </s-link>

      {/* SaveBar from App Bridge */}
      <SaveBar id="customize-paired-widget-savebar" open={isDirty}>
        <button variant="primary" onClick={handleSave} disabled={isSaving}>
          {isSaving ? "Saving..." : "Save"}
        </button>
        <button onClick={handleDiscard} disabled={isSaving}>
          Discard
        </button>
      </SaveBar>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1.25fr",
          gap: "24px",
          alignItems: "start",
        }}
      >
        {/* ===================== LEFT COLUMN: CONTROLS ACCORDION ===================== */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* Top Banner / Theme Integration Alert */}
          <s-banner tone="info" heading="Storefront Theme Block">
            <s-paragraph>
              Customize how your Paired Product bundle looks on product pages. Changes apply to all active paired offers.
            </s-paragraph>
            <s-button
              slot="secondary-actions"
              href={themeEditorUrl}
              target="_blank"
            >
              🚀 Open Theme Editor
            </s-button>
          </s-banner>

          {/* 1. CONTENT ACCORDION */}
          <s-box background="subdued" border="small" borderRadius="base" padding="base">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                cursor: "pointer",
                userSelect: "none",
              }}
              onClick={() => toggleSection("content")}
            >
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-icon type="note" size="small" />
                <s-heading size="small">Content</s-heading>
              </s-stack>
              <span style={{ fontSize: "14px", fontWeight: "bold", color: "#6b7280" }}>
                {openSections.content ? "▲" : "▼"}
              </span>
            </div>

            {openSections.content && (
              <div style={{ marginTop: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
                <s-text-field
                  label="Widget Title"
                  value={content.heading}
                  onChange={(e) => setContent({ ...content, heading: e.target.value })}
                  placeholder="Frequently Bought Together"
                />
                <s-text-field
                  label="Button Text"
                  value={content.buttonText}
                  onChange={(e) => setContent({ ...content, buttonText: e.target.value })}
                  placeholder="Add Both to Cart"
                />
                <s-text-field
                  label="Badge Label (Use {percentage} variable)"
                  value={content.badgeText}
                  onChange={(e) => setContent({ ...content, badgeText: e.target.value })}
                  placeholder="Save {percentage}% OFF"
                />
                <s-text-field
                  label="Sub-Product Prefix"
                  value={content.subProductLabel}
                  onChange={(e) => setContent({ ...content, subProductLabel: e.target.value })}
                  placeholder="Pair with:"
                />
              </div>
            )}
          </s-box>

          {/* 2. STYLES ACCORDION */}
          <s-box background="subdued" border="small" borderRadius="base" padding="base">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                cursor: "pointer",
                userSelect: "none",
              }}
              onClick={() => toggleSection("styles")}
            >
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-icon type="paint-brush" size="small" />
                <s-heading size="small">Styles & Colors</s-heading>
              </s-stack>
              <span style={{ fontSize: "14px", fontWeight: "bold", color: "#6b7280" }}>
                {openSections.styles ? "▲" : "▼"}
              </span>
            </div>

            {openSections.styles && (
              <div style={{ marginTop: "16px", display: "flex", flexDirection: "column", gap: "14px" }}>
                {/* Surface & Border */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                  <div>
                    <label style={{ fontSize: "12px", fontWeight: 600, display: "block", marginBottom: "4px" }}>
                      Card Background
                    </label>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <input
                        type="color"
                        value={styles.cardSurface}
                        onChange={(e) => setStyles({ ...styles, cardSurface: e.target.value })}
                        style={{ width: "36px", height: "36px", border: "none", borderRadius: "4px", cursor: "pointer" }}
                      />
                      <span style={{ fontSize: "13px", fontFamily: "monospace" }}>{styles.cardSurface}</span>
                    </div>
                  </div>

                  <div>
                    <label style={{ fontSize: "12px", fontWeight: 600, display: "block", marginBottom: "4px" }}>
                      Border Color
                    </label>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <input
                        type="color"
                        value={styles.borderColor}
                        onChange={(e) => setStyles({ ...styles, borderColor: e.target.value })}
                        style={{ width: "36px", height: "36px", border: "none", borderRadius: "4px", cursor: "pointer" }}
                      />
                      <span style={{ fontSize: "13px", fontFamily: "monospace" }}>{styles.borderColor}</span>
                    </div>
                  </div>
                </div>

                {/* Border Radius & Width */}
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                    <label style={{ fontSize: "12px", fontWeight: 600 }}>Corner Radius</label>
                    <span style={{ fontSize: "12px", color: "#6b7280" }}>{styles.borderRadius}px</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="50"
                    value={styles.borderRadius}
                    onChange={(e) => setStyles({ ...styles, borderRadius: Number(e.target.value) })}
                    style={{ width: "100%", accentColor: styles.buttonBg }}
                  />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                  <s-text-field
                    label="Border Width (px)"
                    type="number"
                    value={String(styles.borderWidth)}
                    onChange={(e) => setStyles({ ...styles, borderWidth: Number(e.target.value) })}
                  />
                  <div>
                    <label style={{ fontSize: "12px", fontWeight: 600, display: "block", marginBottom: "4px" }}>
                      Total Box Background
                    </label>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <input
                        type="color"
                        value={styles.totalBoxBg}
                        onChange={(e) => setStyles({ ...styles, totalBoxBg: e.target.value })}
                        style={{ width: "36px", height: "36px", border: "none", borderRadius: "4px", cursor: "pointer" }}
                      />
                      <span style={{ fontSize: "13px", fontFamily: "monospace" }}>{styles.totalBoxBg}</span>
                    </div>
                  </div>
                </div>

                {/* Badge Colors */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                  <div>
                    <label style={{ fontSize: "12px", fontWeight: 600, display: "block", marginBottom: "4px" }}>
                      Badge Background
                    </label>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <input
                        type="color"
                        value={styles.badgeBg}
                        onChange={(e) => setStyles({ ...styles, badgeBg: e.target.value })}
                        style={{ width: "36px", height: "36px", border: "none", borderRadius: "4px", cursor: "pointer" }}
                      />
                      <span style={{ fontSize: "13px", fontFamily: "monospace" }}>{styles.badgeBg}</span>
                    </div>
                  </div>

                  <div>
                    <label style={{ fontSize: "12px", fontWeight: 600, display: "block", marginBottom: "4px" }}>
                      Badge Text Color
                    </label>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <input
                        type="color"
                        value={styles.badgeTextColor}
                        onChange={(e) => setStyles({ ...styles, badgeTextColor: e.target.value })}
                        style={{ width: "36px", height: "36px", border: "none", borderRadius: "4px", cursor: "pointer" }}
                      />
                      <span style={{ fontSize: "13px", fontFamily: "monospace" }}>{styles.badgeTextColor}</span>
                    </div>
                  </div>
                </div>

                {/* Action Button Styling */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                  <div>
                    <label style={{ fontSize: "12px", fontWeight: 600, display: "block", marginBottom: "4px" }}>
                      Button Background
                    </label>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <input
                        type="color"
                        value={styles.buttonBg}
                        onChange={(e) => setStyles({ ...styles, buttonBg: e.target.value })}
                        style={{ width: "36px", height: "36px", border: "none", borderRadius: "4px", cursor: "pointer" }}
                      />
                      <span style={{ fontSize: "13px", fontFamily: "monospace" }}>{styles.buttonBg}</span>
                    </div>
                  </div>

                  <div>
                    <label style={{ fontSize: "12px", fontWeight: 600, display: "block", marginBottom: "4px" }}>
                      Button Text Color
                    </label>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <input
                        type="color"
                        value={styles.buttonTextColor}
                        onChange={(e) => setStyles({ ...styles, buttonTextColor: e.target.value })}
                        style={{ width: "36px", height: "36px", border: "none", borderRadius: "4px", cursor: "pointer" }}
                      />
                      <span style={{ fontSize: "13px", fontFamily: "monospace" }}>{styles.buttonTextColor}</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </s-box>

          {/* 3. DISPLAY SETTINGS (VISIBILITY TOGGLES) */}
          <s-box background="subdued" border="small" borderRadius="base" padding="base">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                cursor: "pointer",
                userSelect: "none",
              }}
              onClick={() => toggleSection("display")}
            >
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-icon type="visibility" size="small" />
                <s-heading size="small">Display Settings</s-heading>
              </s-stack>
              <span style={{ fontSize: "14px", fontWeight: "bold", color: "#6b7280" }}>
                {openSections.display ? "▲" : "▼"}
              </span>
            </div>

            {openSections.display && (
              <div style={{ marginTop: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={display.showWidgetTitle}
                    onChange={(e) => setDisplay({ ...display, showWidgetTitle: e.target.checked })}
                  />
                  <span>Show widget title</span>
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={display.linkProductTitles}
                    onChange={(e) => setDisplay({ ...display, linkProductTitles: e.target.checked })}
                  />
                  <span>Link product titles to product page</span>
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={display.showTotalBox}
                    onChange={(e) => setDisplay({ ...display, showTotalBox: e.target.checked })}
                  />
                  <span>Show total & savings summary box</span>
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={display.showPlusIcon}
                    onChange={(e) => setDisplay({ ...display, showPlusIcon: e.target.checked })}
                  />
                  <span>Show plus (+) separator icon</span>
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={display.showSaleBadge}
                    onChange={(e) => setDisplay({ ...display, showSaleBadge: e.target.checked })}
                  />
                  <span>Show discount sale badge</span>
                </label>
              </div>
            )}
          </s-box>
        </div>

        {/* ===================== RIGHT COLUMN: LIVE STOREFRONT PREVIEW ===================== */}
        <div style={{ position: "sticky", top: "20px" }}>
          <div
            style={{
              background: "#ffffff",
              borderRadius: "12px",
              boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.08), 0 8px 10px -6px rgba(0, 0, 0, 0.04)",
              border: "1px solid #e5e7eb",
              overflow: "hidden",
            }}
          >
            {/* Browser Header Bar */}
            <div
              style={{
                background: "#f3f4f6",
                padding: "10px 16px",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                borderBottom: "1px solid #e5e7eb",
              }}
            >
              <div style={{ display: "flex", gap: "6px" }}>
                <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#ef4444", display: "inline-block" }} />
                <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#f59e0b", display: "inline-block" }} />
                <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#10b981", display: "inline-block" }} />
              </div>
              <div
                style={{
                  background: "#ffffff",
                  borderRadius: "6px",
                  padding: "2px 12px",
                  fontSize: "11px",
                  color: "#6b7280",
                  flex: 1,
                  textAlign: "center",
                  maxWidth: "240px",
                  margin: "0 auto",
                }}
              >
                store.myshopify.com/products/everyday-tee
              </div>
            </div>

            {/* Mock Product Page Container */}
            <div style={{ padding: "20px", background: "#fafafa" }}>
              {/* Dummy Product Header Placeholder */}
              <div style={{ display: "flex", gap: "16px", marginBottom: "20px" }}>
                <div
                  style={{
                    width: "90px",
                    height: "90px",
                    background: "#e5e7eb",
                    borderRadius: "8px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#9ca3af",
                    fontSize: "28px",
                  }}
                >
                  👕
                </div>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "6px" }}>
                  <div style={{ height: "14px", width: "70%", background: "#e5e7eb", borderRadius: "4px" }} />
                  <div style={{ height: "10px", width: "40%", background: "#f3f4f6", borderRadius: "4px" }} />
                  <div style={{ height: "12px", width: "25%", background: "#e5e7eb", borderRadius: "4px", marginTop: "4px" }} />
                  <div
                    style={{
                      height: "28px",
                      width: "120px",
                      background: "#e5e7eb",
                      borderRadius: "6px",
                      marginTop: "4px",
                    }}
                  />
                </div>
              </div>

              {/* ================= LIVE WIDGET PREVIEW CARD ================= */}
              <div
                style={{
                  background: styles.cardSurface,
                  borderRadius: `${styles.borderRadius}px`,
                  border: `${styles.borderWidth}px solid ${styles.borderColor}`,
                  padding: "18px",
                  boxShadow: "0 4px 20px -2px rgba(0,0,0,0.05), 0 2px 6px -1px rgba(0,0,0,0.02)",
                  transition: "all 0.15s ease",
                }}
              >
                {/* Widget Heading */}
                {display.showWidgetTitle && (
                  <div
                    style={{
                      fontSize: "15px",
                      fontWeight: 700,
                      color: "#0f172a",
                      marginBottom: "14px",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <span>✨</span>
                    <span>{content.heading || "Frequently Bought Together"}</span>
                  </div>
                )}

                {/* Products Stack */}
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {/* Item 1: Main Product */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "12px",
                      padding: "10px 12px",
                      background: "#ffffff",
                      border: `1px solid ${styles.borderColor}`,
                      borderRadius: `${Math.max(6, styles.borderRadius - 4)}px`,
                      boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
                    }}
                  >
                    <div
                      style={{
                        width: "20px",
                        height: "20px",
                        borderRadius: "5px",
                        background: styles.buttonBg,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: styles.buttonTextColor,
                        flexShrink: 0,
                      }}
                    >
                      <svg width="11" height="9" viewBox="0 0 11 9" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="1.5 4.5 4 7 9.5 1.5" />
                      </svg>
                    </div>
                    <div
                      style={{
                        width: "48px",
                        height: "48px",
                        background: "#f8fafc",
                        border: "1px solid #f1f5f9",
                        borderRadius: "8px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "22px",
                        flexShrink: 0,
                      }}
                    >
                      👕
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "14px", fontWeight: 600, color: "#0f172a" }}>Everyday Cotton Tee</div>
                      <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>Size: M • White</div>
                      <div style={{ marginTop: "4px" }}>
                        <span style={{ fontSize: "11px", fontWeight: 600, background: "#f1f5f9", color: "#334155", padding: "2px 8px", borderRadius: "12px", border: "1px solid #e2e8f0" }}>
                          Qty: 2
                        </span>
                      </div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontSize: "15px", fontWeight: 700, color: "#0f172a" }}>$48.00</div>
                      <div style={{ fontSize: "11px", color: "#64748b", fontWeight: 500, marginTop: "2px" }}>($24.00 each)</div>
                    </div>
                  </div>

                  {/* Plus Icon Separator */}
                  {display.showPlusIcon && (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", margin: "-2px 0" }}>
                      <div style={{ flex: 1, height: "1px", background: "#f1f5f9" }} />
                      <div
                        style={{
                          width: "24px",
                          height: "24px",
                          borderRadius: "50%",
                          background: styles.plusIconBg,
                          color: styles.plusIconColor,
                          border: `1px solid ${styles.borderColor}`,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: "14px",
                          fontWeight: "bold",
                          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                          flexShrink: 0,
                        }}
                      >
                        +
                      </div>
                      <div style={{ flex: 1, height: "1px", background: "#f1f5f9" }} />
                    </div>
                  )}

                  {/* Item 2: Sub / Add-on Product */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "12px",
                      padding: "10px 12px",
                      background: "#ffffff",
                      border: `1px solid ${styles.borderColor}`,
                      borderRadius: `${Math.max(6, styles.borderRadius - 4)}px`,
                      boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
                    }}
                  >
                    <div
                      style={{
                        width: "20px",
                        height: "20px",
                        borderRadius: "5px",
                        background: styles.buttonBg,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: styles.buttonTextColor,
                        flexShrink: 0,
                      }}
                    >
                      <svg width="11" height="9" viewBox="0 0 11 9" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="1.5 4.5 4 7 9.5 1.5" />
                      </svg>
                    </div>
                    <div
                      style={{
                        width: "48px",
                        height: "48px",
                        background: "#f8fafc",
                        border: "1px solid #f1f5f9",
                        borderRadius: "8px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "22px",
                        flexShrink: 0,
                      }}
                    >
                      🧢
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "14px", fontWeight: 600, color: "#0f172a" }}>Summer Classic Cap</div>
                      <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>Color: Navy Blue</div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontSize: "15px", fontWeight: 700, color: "#0f172a" }}>$24.00</div>
                    </div>
                  </div>
                </div>

                {/* Total & Savings Box */}
                {display.showTotalBox && (
                  <div
                    style={{
                      marginTop: "14px",
                      padding: "12px 14px",
                      background: styles.totalBoxBg,
                      borderRadius: `${Math.max(6, styles.borderRadius - 4)}px`,
                      border: `1px solid ${styles.totalBoxBorderColor}`,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "10px",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: "11px", fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em" }}>Bundle Subtotal</div>
                      <div style={{ display: "flex", alignItems: "baseline", gap: "8px", marginTop: "3px" }}>
                        <span style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a" }}>$57.60</span>
                        <span style={{ fontSize: "13px", color: "#94a3b8", textDecoration: "line-through" }}>$72.00</span>
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <span
                        style={{
                          background: "linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%)",
                          color: "#065f46",
                          border: "1px solid rgba(16, 185, 129, 0.25)",
                          fontSize: "11px",
                          fontWeight: 700,
                          padding: "5px 10px",
                          borderRadius: "20px",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "4px",
                          boxShadow: "0 1px 2px rgba(16, 185, 129, 0.08)",
                        }}
                      >
                        <span>⚡</span>
                        <span>Save $14.40 (20% OFF)</span>
                      </span>
                    </div>
                  </div>
                )}

                {/* Primary Add to Cart Action */}
                <button
                  type="button"
                  style={{
                    width: "100%",
                    marginTop: "14px",
                    padding: "14px 20px",
                    background: styles.buttonBg,
                    color: styles.buttonTextColor,
                    borderRadius: `${styles.borderRadius}px`,
                    border: "none",
                    fontWeight: 700,
                    fontSize: "15px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "8px",
                    boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
                    transition: "all 0.15s ease",
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
                    <line x1="3" y1="6" x2="21" y2="6" />
                    <path d="M16 10a4 4 0 0 1-8 0" />
                  </svg>
                  <span>{content.buttonText || "Add Both to Cart"}</span>
                </button>
              </div>

              {/* Helper Footer Note */}
              <div
                style={{
                  fontSize: "10px",
                  color: "#9ca3af",
                  textAlign: "center",
                  marginTop: "14px",
                  fontStyle: "italic",
                }}
              >
                Above preview demonstrates styling in real time. Product images and prices match each offer automatically.
              </div>
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}
