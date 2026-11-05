import { useState, useEffect, useMemo } from "react";
import { useLoaderData, useActionData, useSubmit, useNavigation } from "react-router";
import { useAppBridge, SaveBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import SelectedWidgetPreview from "./components/Preview/SelectedWidgetPreview";

// Default settings used as fallback if merchant hasn't saved customizations yet
const DEFAULT_SETTINGS = {
  content: {
    heading: "{widgettitle}",
    subheading: "Recommended companion items for this product",
    buttonText: "Add to Cart with Add-Ons",
    badgeText: "Save {percentage}% OFF Add-Ons",
  },
  styles: {
    cardSurface: "#ffffff",
    borderColor: "#e2e8f0",
    borderWidth: 1,
    borderRadius: 12,
    totalBoxBg: "#f8fafc",
    badgeBg: "#ecfdf5",
    badgeTextColor: "#065f46",
    buttonBg: "#0f172a",
    buttonTextColor: "#ffffff",
  },
  display: {
    showWidgetTitle: true,
    showSubheading: true,
    showSaleBadge: true,
    showTotalBox: true,
    checkByDefault: true,
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
      query GetSelectedWidgetSettingsAndTheme {
        shop {
          id
          metafield(namespace: "stack_up", key: "selected_widget_settings") {
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
        if (savedSettings?.content?.heading === "Special Add-Ons Just for You") {
          savedSettings.content.heading = "{widgettitle}";
        }
      } catch (e) {
        console.warn("Failed to parse selected_widget_settings:", e);
      }
    }
    const themeNode = json.data?.themes?.nodes?.[0];
    activeThemeId = themeNode?.id?.split("/").pop() || null;
  } catch (err) {
    console.warn("Error fetching selected widget settings:", err);
  }

  const themeEditorUrl = activeThemeId
    ? `https://admin.shopify.com/store/${shopName}/themes/${activeThemeId}/editor?context=apps${
        clientId ? `&activateAppId=${encodeURIComponent(`${clientId}/selected-products`)}` : ""
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
      mutation SaveSelectedWidgetSettings($metafields: [MetafieldsSetInput!]!) {
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
              key: "selected_widget_settings",
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
    console.error("Error saving selected widget settings:", err);
    return { error: "Failed to save widget settings. Please try again." };
  }
};

export default function SelectedProductsCustomize() {
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

  // Accordion Expansion State
  const [expanded, setExpanded] = useState({
    content: true,
    styles: true,
    display: true,
  });

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
    shopify.saveBar?.hide("customize-selected-widget-savebar");
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
      shopify.saveBar?.hide("customize-selected-widget-savebar");
    } else if (actionData?.error) {
      shopify.toast.show(actionData.error, { isError: true });
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Special Add-Ons Customization">
      <s-link slot="breadcrumb-actions" href="/app/offers">
        All Discounts
      </s-link>

      {/* SaveBar from App Bridge */}
      <SaveBar id="customize-selected-widget-savebar" open={isDirty}>
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
          gridTemplateColumns: "minmax(340px, 1fr) minmax(380px, 1.25fr)",
          gap: "24px",
          alignItems: "start",
          width: "100%",
        }}
      >
        {/* ===================== LEFT COLUMN: CONTROLS ACCORDION ===================== */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px", minWidth: 0 }}>
          {/* Top Banner / Theme Integration Alert */}
          <s-banner tone="info" heading="Storefront Theme Block">
            <s-paragraph>
              Customize how your Special Add-Ons widget appears on product pages. These settings automatically apply to all active Selected Product offers.
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
          <s-section>
            <s-grid
              gridTemplateColumns="1fr auto"
              gap="base"
              alignItems="center"
              onClick={() => setExpanded((prev) => ({ ...prev, content: !prev.content }))}
              style={{ cursor: "pointer", userSelect: "none" }}
            >
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-icon type="note" size="small" />
                <s-heading size="small">Content</s-heading>
              </s-stack>
              <s-button
                accessibilityLabel="Toggle Content section"
                variant="tertiary"
                tone="neutral"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded((prev) => ({ ...prev, content: !prev.content }));
                }}
                icon={expanded.content ? "chevron-up" : "chevron-down"}
              />
            </s-grid>

            {expanded.content && (
              <>
                <s-divider />
                <s-grid gap="base">
                  <s-text-field
                    label="Widget Title / Heading (Use {widgettitle} variable)"
                    value={content.heading}
                    onInput={(e) => setContent({ ...content, heading: e.target.value })}
                    placeholder="e.g. {widgettitle}"
                    details="Use {widgettitle} to dynamically display each offer's individual title set in the offer editor."
                  ></s-text-field>
                  <s-text-field
                    label="Subheading Text"
                    value={content.subheading}
                    onInput={(e) => setContent({ ...content, subheading: e.target.value })}
                    placeholder="Recommended companion items for this product"
                  ></s-text-field>
                  <s-text-field
                    label="Button Text"
                    value={content.buttonText}
                    onInput={(e) => setContent({ ...content, buttonText: e.target.value })}
                    placeholder="Add to Cart with Add-Ons"
                  ></s-text-field>
                  <s-text-field
                    label="Badge Label (Use {percentage} variable)"
                    value={content.badgeText}
                    onInput={(e) => setContent({ ...content, badgeText: e.target.value })}
                    placeholder="Save {percentage}% OFF Add-Ons"
                  ></s-text-field>
                </s-grid>
              </>
            )}
          </s-section>

          {/* 2. STYLES ACCORDION */}
          <s-section>
            <s-grid
              gridTemplateColumns="1fr auto"
              gap="base"
              alignItems="center"
              onClick={() => setExpanded((prev) => ({ ...prev, styles: !prev.styles }))}
              style={{ cursor: "pointer", userSelect: "none" }}
            >
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-icon type="color" size="small" />
                <s-heading size="small">Styles & Colors</s-heading>
              </s-stack>
              <s-button
                accessibilityLabel="Toggle Styles section"
                variant="tertiary"
                tone="neutral"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded((prev) => ({ ...prev, styles: !prev.styles }));
                }}
                icon={expanded.styles ? "chevron-up" : "chevron-down"}
              />
            </s-grid>

            {expanded.styles && (
              <>
                <s-divider />
                <s-grid gap="base">
                  {/* Surface & Border Colors */}
                  <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                    <s-color-field
                      label="Card Background"
                      value={styles.cardSurface}
                      onInput={(e) => setStyles({ ...styles, cardSurface: e.target.value })}
                      onChange={(e) => setStyles({ ...styles, cardSurface: e.target.value })}
                    ></s-color-field>

                    <s-color-field
                      label="Border Color"
                      value={styles.borderColor}
                      onInput={(e) => setStyles({ ...styles, borderColor: e.target.value })}
                      onChange={(e) => setStyles({ ...styles, borderColor: e.target.value })}
                    ></s-color-field>
                  </s-grid>

                  {/* Border Radius & Width */}
                  <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                    <s-number-field
                      label="Corner Radius (px)"
                      value={String(styles.borderRadius)}
                      min={0}
                      max={50}
                      onInput={(e) => setStyles({ ...styles, borderRadius: Number(e.target.value) })}
                    ></s-number-field>

                    <s-number-field
                      label="Border Width (px)"
                      value={String(styles.borderWidth)}
                      min={0}
                      max={10}
                      onInput={(e) => setStyles({ ...styles, borderWidth: Number(e.target.value) })}
                    ></s-number-field>
                  </s-grid>

                  {/* Total Box Background */}
                  <s-color-field
                    label="Total Box Background"
                    value={styles.totalBoxBg}
                    onInput={(e) => setStyles({ ...styles, totalBoxBg: e.target.value })}
                    onChange={(e) => setStyles({ ...styles, totalBoxBg: e.target.value })}
                  ></s-color-field>

                  <s-divider />

                  {/* Badge Colors */}
                  <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                    <s-color-field
                      label="Badge Background"
                      value={styles.badgeBg}
                      onInput={(e) => setStyles({ ...styles, badgeBg: e.target.value })}
                      onChange={(e) => setStyles({ ...styles, badgeBg: e.target.value })}
                    ></s-color-field>

                    <s-color-field
                      label="Badge Text Color"
                      value={styles.badgeTextColor}
                      onInput={(e) => setStyles({ ...styles, badgeTextColor: e.target.value })}
                      onChange={(e) => setStyles({ ...styles, badgeTextColor: e.target.value })}
                    ></s-color-field>
                  </s-grid>

                  <s-divider />

                  {/* Action Button Styling */}
                  <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                    <s-color-field
                      label="Button Background"
                      value={styles.buttonBg}
                      onInput={(e) => setStyles({ ...styles, buttonBg: e.target.value })}
                      onChange={(e) => setStyles({ ...styles, buttonBg: e.target.value })}
                    ></s-color-field>

                    <s-color-field
                      label="Button Text Color"
                      value={styles.buttonTextColor}
                      onInput={(e) => setStyles({ ...styles, buttonTextColor: e.target.value })}
                      onChange={(e) => setStyles({ ...styles, buttonTextColor: e.target.value })}
                    ></s-color-field>
                  </s-grid>
                </s-grid>
              </>
            )}
          </s-section>

          {/* 3. DISPLAY SETTINGS (VISIBILITY TOGGLES) */}
          <s-section>
            <s-grid
              gridTemplateColumns="1fr auto"
              gap="base"
              alignItems="center"
              onClick={() => setExpanded((prev) => ({ ...prev, display: !prev.display }))}
              style={{ cursor: "pointer", userSelect: "none" }}
            >
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-icon type="dns-settings" size="small" />
                <s-heading size="small">Display Settings</s-heading>
              </s-stack>
              <s-button
                accessibilityLabel="Toggle Display section"
                variant="tertiary"
                tone="neutral"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded((prev) => ({ ...prev, display: !prev.display }));
                }}
                icon={expanded.display ? "chevron-up" : "chevron-down"}
              />
            </s-grid>

            {expanded.display && (
              <>
                <s-divider />
                <s-grid gap="base">
                  <s-checkbox
                    label="Show widget title"
                    checked={Boolean(display.showWidgetTitle)}
                    onChange={(e) => setDisplay({ ...display, showWidgetTitle: e.target.checked })}
                  ></s-checkbox>

                  <s-checkbox
                    label="Show subheading"
                    checked={Boolean(display.showSubheading)}
                    onChange={(e) => setDisplay({ ...display, showSubheading: e.target.checked })}
                  ></s-checkbox>

                  <s-checkbox
                    label="Show discount savings badge"
                    checked={Boolean(display.showSaleBadge)}
                    onChange={(e) => setDisplay({ ...display, showSaleBadge: e.target.checked })}
                  ></s-checkbox>

                  <s-checkbox
                    label="Show total & savings summary box"
                    checked={Boolean(display.showTotalBox)}
                    onChange={(e) => setDisplay({ ...display, showTotalBox: e.target.checked })}
                  ></s-checkbox>

                  <s-checkbox
                    label="Check add-on items by default"
                    checked={Boolean(display.checkByDefault)}
                    onChange={(e) => setDisplay({ ...display, checkByDefault: e.target.checked })}
                  ></s-checkbox>
                </s-grid>
              </>
            )}
          </s-section>
        </div>

        {/* ===================== RIGHT COLUMN: LIVE STOREFRONT PREVIEW ===================== */}
        <div style={{ position: "sticky", top: "20px", minWidth: 0 }}>
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
                  maxWidth: "260px",
                  margin: "0 auto",
                }}
              >
                store.myshopify.com/products/summer-collection
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
                  👗
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

              {/* LIVE WIDGET PREVIEW */}
              <SelectedWidgetPreview
                title="Special Add-Ons Just for You"
                widgetTitle="Special Add-Ons Just for You"
                percentage={15}
                targetProducts={[{ title: "Floral Summer Dress", price: "$48.00" }]}
                offeredProducts={[
                  { id: "p1", title: "Matching Silk Scarf", price: "$18.00" },
                  { id: "p2", title: "Handmade Beaded Bracelet", price: "$14.00" },
                ]}
                widgetSettings={{
                  content,
                  styles,
                  display,
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}

