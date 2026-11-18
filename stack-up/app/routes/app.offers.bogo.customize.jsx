import { useState, useEffect, useMemo } from "react";
import { useLoaderData, useActionData, useSubmit, useNavigation } from "react-router";
import { useAppBridge, SaveBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import BogoWidgetPreview from "./components/Preview/BogoWidgetPreview";

// Default settings used as fallback if merchant hasn't saved customizations yet
const DEFAULT_SETTINGS = {
  content: {
    heading: "{widgettitle}",
    buttonText: "Add {total} items to Cart",
    badgeText: "Add {get_qty} items for {discount}",
    buyTagText: "Buy {buy_qty}/{buy_qty}",
    getTagText: "Get {get_qty}/{get_qty}",
  },
  styles: {
    cardSurface: "#ffffff",
    borderColor: "#e5e7eb",
    borderWidth: 1,
    borderRadius: 12,
    badgeBg: "#ede9fe",
    badgeTextColor: "#6366f1",
    plusBg: "#ede9fe",
    plusColor: "#6366f1",
    buttonBg: "#1f2937",
    buttonTextColor: "#ffffff",
    buttonBorderRadius: 8,
  },
  display: {
    showWidgetTitle: true,
    showDivider: true,
    showPlusIcon: true,
    showBadge: true,
    showSavings: true,
    showAddToCart: true,
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
      query GetBogoWidgetSettingsAndTheme {
        shop {
          id
          metafield(namespace: "stack_up", key: "bogo_widget_settings") {
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
        if (
          !savedSettings?.content?.heading ||
          savedSettings?.content?.heading === "Buy 1 Get 1 with 100% off"
        ) {
          if (!savedSettings.content) savedSettings.content = {};
          savedSettings.content.heading = "{widgettitle}";
        }
      } catch (e) {
        console.warn("Failed to parse bogo_widget_settings:", e);
      }
    }
    const themeNode = json.data?.themes?.nodes?.[0];
    activeThemeId = themeNode?.id?.split("/").pop() || null;
  } catch (err) {
    console.warn("Error fetching bogo widget settings:", err);
  }

  const themeEditorUrl = activeThemeId
    ? `https://admin.shopify.com/store/${shopName}/themes/${activeThemeId}/editor?context=apps${
        clientId ? `&activateAppId=${encodeURIComponent(`${clientId}/bogo-widget`)}` : ""
      }`
    : `https://admin.shopify.com/store/${shopName}/themes/current/editor?context=apps`;

  return {
    settings: savedSettings || DEFAULT_SETTINGS,
    themeEditorUrl,
    shopName,
    shop: session.shop,
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
      mutation SaveBogoWidgetSettings($metafields: [MetafieldsSetInput!]!) {
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
              key: "bogo_widget_settings",
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
    console.error("Error saving bogo widget settings:", err);
    return { error: "Failed to save widget settings. Please try again." };
  }
};

export default function BogoCustomize() {
  const { settings: initialSettings, themeEditorUrl, shopName, shop } = useLoaderData();
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
    shopify.saveBar?.hide("customize-bogo-widget-savebar");
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
      shopify.saveBar?.hide("customize-bogo-widget-savebar");
    } else if (actionData?.error) {
      shopify.toast.show(actionData.error, { isError: true });
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="BOGO & Buy X Get Y Customization">
      <s-link slot="breadcrumb-actions" href="/app/offers">
        All Discounts
      </s-link>

      {/* SaveBar from App Bridge */}
      <SaveBar id="customize-bogo-widget-savebar" open={isDirty}>
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
              Customize how your BOGO and Buy X Get Y deals look on product pages. These settings automatically apply to all active BOGO offers.
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
                    label="Button Text (Use {total} variable)"
                    value={content.buttonText}
                    onInput={(e) => setContent({ ...content, buttonText: e.target.value })}
                    placeholder="Add {total} items to Cart"
                  ></s-text-field>
                  <s-text-field
                    label="Reward Badge Label (Use {get_qty} and {discount} variables)"
                    value={content.badgeText}
                    onInput={(e) => setContent({ ...content, badgeText: e.target.value })}
                    placeholder="Add {get_qty} items for {discount}"
                  ></s-text-field>
                  <s-text-field
                    label="Buy Step Tag"
                    value={content.buyTagText}
                    onInput={(e) => setContent({ ...content, buyTagText: e.target.value })}
                    placeholder="Buy {buy_qty}/{buy_qty}"
                  ></s-text-field>
                  <s-text-field
                    label="Get Step Tag"
                    value={content.getTagText}
                    onInput={(e) => setContent({ ...content, getTagText: e.target.value })}
                    placeholder="Get {get_qty}/{get_qty}"
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

                  <s-divider />

                  {/* Reward Badge Colors */}
                  <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                    <s-color-field
                      label="Reward Badge Background"
                      value={styles.badgeBg}
                      onInput={(e) => setStyles({ ...styles, badgeBg: e.target.value })}
                      onChange={(e) => setStyles({ ...styles, badgeBg: e.target.value })}
                    ></s-color-field>

                    <s-color-field
                      label="Reward Badge Text Color"
                      value={styles.badgeTextColor}
                      onInput={(e) => setStyles({ ...styles, badgeTextColor: e.target.value })}
                      onChange={(e) => setStyles({ ...styles, badgeTextColor: e.target.value })}
                    ></s-color-field>
                  </s-grid>

                  {/* Plus Icon Colors */}
                  <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                    <s-color-field
                      label="Plus (+) Icon Background"
                      value={styles.plusBg || "#ede9fe"}
                      onInput={(e) => setStyles({ ...styles, plusBg: e.target.value })}
                      onChange={(e) => setStyles({ ...styles, plusBg: e.target.value })}
                    ></s-color-field>

                    <s-color-field
                      label="Plus (+) Icon Color"
                      value={styles.plusColor || "#6366f1"}
                      onInput={(e) => setStyles({ ...styles, plusColor: e.target.value })}
                      onChange={(e) => setStyles({ ...styles, plusColor: e.target.value })}
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

                  <s-number-field
                    label="Button Corner Radius (px)"
                    value={String(styles.buttonBorderRadius)}
                    min={0}
                    max={50}
                    onInput={(e) => setStyles({ ...styles, buttonBorderRadius: Number(e.target.value) })}
                  ></s-number-field>
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
                    label="Show divider line next to title"
                    checked={Boolean(display.showDivider)}
                    onChange={(e) => setDisplay({ ...display, showDivider: e.target.checked })}
                  ></s-checkbox>

                  <s-checkbox
                    label="Show plus (+) separator icon"
                    checked={Boolean(display.showPlusIcon)}
                    onChange={(e) => setDisplay({ ...display, showPlusIcon: e.target.checked })}
                  ></s-checkbox>

                  <s-checkbox
                    label="Show reward discount badge"
                    checked={Boolean(display.showBadge)}
                    onChange={(e) => setDisplay({ ...display, showBadge: e.target.checked })}
                  ></s-checkbox>

                  <s-checkbox
                    label="Show total & savings summary"
                    checked={Boolean(display.showSavings)}
                    onChange={(e) => setDisplay({ ...display, showSavings: e.target.checked })}
                  ></s-checkbox>

                  <s-checkbox
                    label="Show Add to Cart button inside widget"
                    checked={Boolean(display.showAddToCart !== false)}
                    onChange={(e) => setDisplay({ ...display, showAddToCart: e.target.checked })}
                  ></s-checkbox>
                </s-grid>
              </>
            )}
          </s-section>
        </div>

        {/* ===================== RIGHT COLUMN: STICKY LIVE PREVIEW ===================== */}
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
                {shopName || "store"}.myshopify.com/products/summer-sandals
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
                  👠
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
              <BogoWidgetPreview
                dealType="BUY_X_GET_Y"
                buyQty={1}
                getQty={1}
                discountType="PERCENTAGE"
                discountValue={50}
                widgetTitle="Buy 1 Get 1 Special Deal"
                widgetSettings={{
                  content,
                  styles,
                  display,
                }}
                shopDomain={shop}
                asSection={false}
              />
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}
