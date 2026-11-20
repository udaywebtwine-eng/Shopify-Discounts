import { useState, useEffect, useMemo } from "react";
import { useLoaderData, useActionData, useSubmit, useNavigation } from "react-router";
import { useAppBridge, SaveBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { syncAllActiveCartGoalOffersToShopMetafield } from "../utils/cartGoalMetafields.server";
import CartGoalWidgetPreview from "./components/Preview/CartGoalWidgetPreview";

// Default settings used as fallback if merchant hasn't saved customizations yet
const DEFAULT_SETTINGS = {
  content: {
    heading: "{widgettitle}",
    initialMessage: "Add {{remaining}} more to unlock {{next_tier}}!",
    progressMessage: "🎉 {{current_tier}} unlocked! Add {{remaining}} for {{next_tier}}!",
    completedMessage: "🎉 Congratulations! You unlocked maximum savings + Free Shipping!",
  },
  styles: {
    cardSurface: "#ffffff",
    borderColor: "#e5e7eb",
    borderWidth: 1,
    borderRadius: 12,
    barColor: "#000000",
    trackColor: "#e5e7eb",
    achievedColor: "#10b981",
    barHeight: 8,
    textColor: "#111827",
    milestoneTextColor: "#6b7280",
  },
  display: {
    showWidgetTitle: true,
    showInCartDrawer: true,
    showOnCartPage: true,
    showMilestoneIcons: true,
    showCelebrationEmojis: true,
    customDrawerSelector: "",
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
      query GetCartGoalWidgetSettingsAndTheme {
        shop {
          id
          currencyCode
          metafield(namespace: "stack_up", key: "cart_goal_widget_settings") {
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
        if (!savedSettings.content) savedSettings.content = {};
        if (!savedSettings.content.heading) savedSettings.content.heading = "{widgettitle}";
      } catch (e) {
        console.warn("Failed to parse cart_goal_widget_settings:", e);
      }
    }
    const themeNode = json.data?.themes?.nodes?.[0];
    activeThemeId = themeNode?.id?.split("/").pop() || null;
  } catch (err) {
    console.warn("Error fetching cart goal widget settings:", err);
  }

  const themeEditorUrl = activeThemeId
    ? `https://admin.shopify.com/store/${shopName}/themes/${activeThemeId}/editor?context=apps${
        clientId ? `&activateAppId=${encodeURIComponent(`${clientId}/cart-goal-bar`)}` : ""
      }`
    : `https://admin.shopify.com/store/${shopName}/themes/current/editor?context=apps`;

  const shopCurrency = json.data?.shop?.currencyCode || "";

  return {
    settings: savedSettings || DEFAULT_SETTINGS,
    themeEditorUrl,
    shopName,
    shopCurrency,
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
      mutation SaveCartGoalWidgetSettings($metafields: [MetafieldsSetInput!]!) {
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
              key: "cart_goal_widget_settings",
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

    // Immediately re-sync active Cart Goal offers with newly saved custom styling
    try {
      await syncAllActiveCartGoalOffersToShopMetafield(admin);
    } catch (syncErr) {
      console.warn("[CartGoalCustomize] Non-fatal sync warning:", syncErr);
    }

    return { success: true };
  } catch (err) {
    console.error("Error saving cart goal widget settings:", err);
    return { error: "Failed to save widget settings. Please try again." };
  }
};

export default function CartGoalCustomize() {
  const { settings: initialSettings, themeEditorUrl, shopCurrency = "" } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const isSaving = navigation.state === "submitting";

  // Form State
  const [content, setContent] = useState({
    heading: initialSettings.content?.heading || DEFAULT_SETTINGS.content.heading,
    initialMessage: initialSettings.content?.initialMessage || DEFAULT_SETTINGS.content.initialMessage,
    progressMessage: initialSettings.content?.progressMessage || DEFAULT_SETTINGS.content.progressMessage,
    completedMessage: initialSettings.content?.completedMessage || DEFAULT_SETTINGS.content.completedMessage,
  });

  const [styles, setStyles] = useState({
    cardSurface: initialSettings.styles?.cardSurface || DEFAULT_SETTINGS.styles.cardSurface,
    borderColor: initialSettings.styles?.borderColor || DEFAULT_SETTINGS.styles.borderColor,
    borderWidth: Number(initialSettings.styles?.borderWidth ?? DEFAULT_SETTINGS.styles.borderWidth),
    borderRadius: Number(initialSettings.styles?.borderRadius ?? DEFAULT_SETTINGS.styles.borderRadius),
    barColor: initialSettings.styles?.barColor || DEFAULT_SETTINGS.styles.barColor,
    trackColor: initialSettings.styles?.trackColor || DEFAULT_SETTINGS.styles.trackColor,
    achievedColor: initialSettings.styles?.achievedColor || DEFAULT_SETTINGS.styles.achievedColor,
    barHeight: Number(initialSettings.styles?.barHeight ?? DEFAULT_SETTINGS.styles.barHeight),
    textColor: initialSettings.styles?.textColor || DEFAULT_SETTINGS.styles.textColor,
    milestoneTextColor: initialSettings.styles?.milestoneTextColor || DEFAULT_SETTINGS.styles.milestoneTextColor,
  });

  const [display, setDisplay] = useState({
    showWidgetTitle: initialSettings.display?.showWidgetTitle ?? DEFAULT_SETTINGS.display.showWidgetTitle,
    showInCartDrawer: initialSettings.display?.showInCartDrawer ?? DEFAULT_SETTINGS.display.showInCartDrawer,
    showOnCartPage: initialSettings.display?.showOnCartPage ?? DEFAULT_SETTINGS.display.showOnCartPage,
    showMilestoneIcons: initialSettings.display?.showMilestoneIcons ?? DEFAULT_SETTINGS.display.showMilestoneIcons,
    showCelebrationEmojis: initialSettings.display?.showCelebrationEmojis ?? DEFAULT_SETTINGS.display.showCelebrationEmojis,
    customDrawerSelector: initialSettings.display?.customDrawerSelector || "",
  });

  // Preview Mode State
  const [previewMode, setPreviewMode] = useState("drawer"); // "drawer" | "page"

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
    shopify.saveBar?.hide("customize-cart-goal-widget-savebar");
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
      shopify.toast.show("Cart Goal widget customizations saved!");
      shopify.saveBar?.hide("customize-cart-goal-widget-savebar");
    } else if (actionData?.error) {
      shopify.toast.show(actionData.error, { isError: true });
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Cart Goal Customization">
      <s-link slot="breadcrumb-actions" href="/app/customize">
        Customization
      </s-link>

      {/* SaveBar from App Bridge */}
      <SaveBar id="customize-cart-goal-widget-savebar" open={isDirty}>
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
              Customize how your Cart Goal Progress Bar looks in the Cart Drawer and on the Cart page. These settings automatically apply to all active cart goal offers.
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
                    label="Initial Message (0% progress)"
                    value={content.initialMessage}
                    onInput={(e) => setContent({ ...content, initialMessage: e.target.value })}
                    placeholder="Add {{remaining}} more to unlock {{next_tier}}!"
                    details="Placeholders: {{remaining}} (amount left) and {{next_tier}} (reward name)."
                  ></s-text-field>

                  <s-text-field
                    label="Progress Message (Tier unlocked)"
                    value={content.progressMessage}
                    onInput={(e) => setContent({ ...content, progressMessage: e.target.value })}
                    placeholder="🎉 {{current_tier}} unlocked! Add {{remaining}} for {{next_tier}}!"
                    details="Placeholders: {{current_tier}}, {{remaining}}, and {{next_tier}}."
                  ></s-text-field>

                  <s-text-field
                    label="Goal Completed Message"
                    value={content.completedMessage}
                    onInput={(e) => setContent({ ...content, completedMessage: e.target.value })}
                    placeholder="🎉 Congratulations! You unlocked maximum savings + Free Shipping!"
                    details="Displayed when shoppers reach the highest milestone threshold."
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
                      max={40}
                      onInput={(e) => setStyles({ ...styles, borderRadius: Number(e.target.value) || 0 })}
                    ></s-number-field>

                    <s-number-field
                      label="Border Width (px)"
                      value={String(styles.borderWidth || 1)}
                      min={0}
                      max={10}
                      onInput={(e) => setStyles({ ...styles, borderWidth: Number(e.target.value) || 0 })}
                    ></s-number-field>
                  </s-grid>

                  <s-divider />

                  {/* Progress Bar Fill & Track Background */}
                  <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                    <s-color-field
                      label="Bar Fill Color"
                      value={styles.barColor}
                      onInput={(e) => setStyles({ ...styles, barColor: e.target.value })}
                      onChange={(e) => setStyles({ ...styles, barColor: e.target.value })}
                    ></s-color-field>

                    <s-color-field
                      label="Track Background"
                      value={styles.trackColor}
                      onInput={(e) => setStyles({ ...styles, trackColor: e.target.value })}
                      onChange={(e) => setStyles({ ...styles, trackColor: e.target.value })}
                    ></s-color-field>
                  </s-grid>

                  {/* Milestone Achieved Dot & Bar Height */}
                  <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                    <s-color-field
                      label="Achieved Milestone Color"
                      value={styles.achievedColor}
                      onInput={(e) => setStyles({ ...styles, achievedColor: e.target.value })}
                      onChange={(e) => setStyles({ ...styles, achievedColor: e.target.value })}
                    ></s-color-field>

                    <s-number-field
                      label="Progress Bar Height (px)"
                      value={String(styles.barHeight || 8)}
                      min={4}
                      max={24}
                      onInput={(e) => setStyles({ ...styles, barHeight: Number(e.target.value) || 8 })}
                    ></s-number-field>
                  </s-grid>

                  <s-divider />

                  {/* Text Colors */}
                  <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                    <s-color-field
                      label="Primary Text Color"
                      value={styles.textColor || "#111827"}
                      onInput={(e) => setStyles({ ...styles, textColor: e.target.value })}
                      onChange={(e) => setStyles({ ...styles, textColor: e.target.value })}
                    ></s-color-field>

                    <s-color-field
                      label="Milestone Label Color"
                      value={styles.milestoneTextColor || "#6b7280"}
                      onInput={(e) => setStyles({ ...styles, milestoneTextColor: e.target.value })}
                      onChange={(e) => setStyles({ ...styles, milestoneTextColor: e.target.value })}
                    ></s-color-field>
                  </s-grid>
                </s-grid>
              </>
            )}
          </s-section>

          {/* 3. DISPLAY SETTINGS */}
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
                    label="Auto-inject in Slide-out Cart Drawer"
                    checked={Boolean(display.showInCartDrawer)}
                    onChange={(e) => setDisplay({ ...display, showInCartDrawer: e.target.checked })}
                  ></s-checkbox>

                  <s-checkbox
                    label="Auto-inject on Cart Page (/cart)"
                    checked={Boolean(display.showOnCartPage)}
                    onChange={(e) => setDisplay({ ...display, showOnCartPage: e.target.checked })}
                  ></s-checkbox>

                  <s-checkbox
                    label="Show Milestone Reward Icons (%, 🚚, 🎁) along track"
                    checked={Boolean(display.showMilestoneIcons)}
                    onChange={(e) => setDisplay({ ...display, showMilestoneIcons: e.target.checked })}
                  ></s-checkbox>

                  <s-checkbox
                    label="Show celebratory emojis in motivational text"
                    checked={Boolean(display.showCelebrationEmojis)}
                    onChange={(e) => setDisplay({ ...display, showCelebrationEmojis: e.target.checked })}
                  ></s-checkbox>

                  <s-divider />

                  <s-text-field
                    label="Custom Cart Drawer CSS Selector (Optional Override)"
                    value={display.customDrawerSelector}
                    onInput={(e) => setDisplay({ ...display, customDrawerSelector: e.target.value })}
                    placeholder="e.g. #CartDrawer, .drawer__inner"
                    details="Leave blank to use our built-in selector matrix supporting 99% of Shopify themes (Dawn, Prestige, Impulse, etc.)."
                  ></s-text-field>
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
                  maxWidth: "240px",
                  margin: "0 auto",
                }}
              >
                {previewMode === "drawer" ? "store.myshopify.com (Cart Drawer)" : "store.myshopify.com/cart"}
              </div>

              {/* Segmented Mode Switcher */}
              <div style={{ display: "flex", background: "#e5e7eb", borderRadius: "6px", padding: "2px", gap: "2px" }}>
                <button
                  type="button"
                  onClick={() => setPreviewMode("drawer")}
                  style={{
                    padding: "3px 10px",
                    borderRadius: "4px",
                    border: "none",
                    background: previewMode === "drawer" ? "#ffffff" : "transparent",
                    color: previewMode === "drawer" ? "#111827" : "#6b7280",
                    fontSize: "11px",
                    fontWeight: previewMode === "drawer" ? "600" : "500",
                    boxShadow: previewMode === "drawer" ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                  }}
                >
                  Drawer
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewMode("page")}
                  style={{
                    padding: "3px 10px",
                    borderRadius: "4px",
                    border: "none",
                    background: previewMode === "page" ? "#ffffff" : "transparent",
                    color: previewMode === "page" ? "#111827" : "#6b7280",
                    fontSize: "11px",
                    fontWeight: previewMode === "page" ? "600" : "500",
                    boxShadow: previewMode === "page" ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                  }}
                >
                  Cart Page
                </button>
              </div>
            </div>

            {/* Mock Cart Container */}
            <div style={{ padding: "20px", background: previewMode === "drawer" ? "#f9fafb" : "#ffffff" }}>
              <CartGoalWidgetPreview
                title="Spend More, Save More"
                widgetTitle="Spend More, Save More"
                tiers={[
                  { minAmount: 50, discountType: "PERCENTAGE", discountValue: 10, label: "10% off" },
                  { minAmount: 100, discountType: "PERCENTAGE", discountValue: 15, hasFreeShipping: true, label: "Free Shipping" },
                  { minAmount: 150, discountType: "PERCENTAGE", discountValue: 20, freeGift: { title: "Amber Glow Candle Mini" }, label: "Free Gift" },
                ]}
                asSection={false}
                showSimulator={true}
                initialSubtotal={65}
                previewMode={previewMode}
                currency={shopCurrency}
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
