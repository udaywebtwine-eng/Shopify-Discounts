import { useState } from "react";
import { useLoaderData, useNavigate, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { syncAppStatusMetafield } from "../utils/appStatus.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shopName = session.shop.replace(".myshopify.com", "");

  // eslint-disable-next-line no-undef
  const clientId = process.env.SHOPIFY_API_KEY || "";

  // 1. Check accurate theme app embed status and active theme ID
  let isAppEmbedEnabled = false;
  let activeThemeId = null;

  try {
    const statusResult = await syncAppStatusMetafield(admin);
    isAppEmbedEnabled = Boolean(statusResult?.isAppEmbedEnabled);
    activeThemeId = statusResult?.numericThemeId || null;
  } catch (err) {
    console.error("[Customization] Error checking app embed status:", err);
  }

  // 2. Count active offers per type
  let counts = { paired: 0, selected: 0, volume: 0, bogo: 0, total: 0 };
  try {
    const [pairedCount, selectedCount, volumeCount, bogoCount] = await Promise.all([
      db.offer.count({ where: { shop: session.shop, type: "PAIRED", status: "ACTIVE" } }),
      db.offer.count({ where: { shop: session.shop, type: "SELECTED", status: "ACTIVE" } }),
      db.offer.count({ where: { shop: session.shop, type: "VOLUME", status: "ACTIVE" } }),
      db.offer.count({ where: { shop: session.shop, type: "BOGO", status: "ACTIVE" } }),
    ]);

    counts = {
      paired: pairedCount,
      selected: selectedCount,
      volume: volumeCount,
      bogo: bogoCount,
      total: pairedCount + selectedCount + volumeCount + bogoCount,
    };
  } catch (dbErr) {
    console.error("[Customization] DB count error:", dbErr);
  }

  return {
    shopName,
    activeThemeId,
    clientId,
    isAppEmbedEnabled,
    counts,
  };
};

export default function Customization() {
  const { shopName, activeThemeId, clientId, isAppEmbedEnabled, counts } = useLoaderData();
  const navigate = useNavigate();
  const navigation = useNavigation();

  const [activeFilter, setActiveFilter] = useState("all");
  const [navigatingId, setNavigatingId] = useState(null);

  const isNavigating = navigation.state === "loading";

  const themeEditorUrl = activeThemeId && clientId
    ? `https://${shopName}.myshopify.com/admin/themes/${activeThemeId}/editor?context=apps&activateAppId=${clientId}/app-embed`
    : `https://${shopName}.myshopify.com/admin/themes/current/editor`;

  const widgetItems = [
    {
      id: "paired",
      filterCategory: "paired",
      title: "Frequently Bought Together",
      badgeLabel: "Frequently Bought",
      badgeTone: "info",
      description: "Customize bundle widget layout, heading text, bundle discount badges, and 'Add Both to Cart' button styling.",
      image: "/img1.png",
      alt: "Frequently Bought Together Widget Preview",
      activeOffers: counts.paired,
      customizeUrl: "/app/customize/paired",
    },
    {
      id: "selected",
      filterCategory: "selected",
      title: "Product Add-ons",
      badgeLabel: "Product Add-ons",
      badgeTone: "caution",
      description: "Customize add-on product recommendation checkboxes, upgrade discount pills, and dynamic subtotal calculations.",
      image: "/img2.png",
      alt: "Product Add-ons Widget Preview",
      activeOffers: counts.selected,
      customizeUrl: "/app/customize/selected",
    },
    {
      id: "volume",
      filterCategory: "volume",
      title: "Quantity Breaks Table",
      badgeLabel: "Volume Discount",
      badgeTone: "success",
      description: "Customize tiered pricing tables, 'Most Popular' / 'Best Value' badges, quantity selectors, and instant cart discounts.",
      image: "/img3.png",
      alt: "Quantity Breaks Volume Discount Preview",
      activeOffers: counts.volume,
      customizeUrl: "/app/customize/volume",
    },
    {
      id: "bogo",
      filterCategory: "bogo",
      title: "BOGO & Buy X Get Y",
      badgeLabel: "BOGO & Deals",
      badgeTone: "magic",
      description: "Customize Buy X Get Y promotional cards, free gift reward badges, equal or lesser value notice, and single CTA button.",
      image: "/img4.png",
      alt: "Automatic BOGO & Buy X Get Y Preview",
      activeOffers: counts.bogo,
      customizeUrl: "/app/customize/bogo",
    },
  ];

  const filteredWidgets = activeFilter === "all"
    ? widgetItems
    : widgetItems.filter((item) => item.filterCategory === activeFilter);

  const handleCustomizeClick = (item) => {
    setNavigatingId(item.id);
    navigate(item.customizeUrl);
  };

  return (
    <s-page heading="Customization">
      {/* App Embed Alert (only shown if embed is NOT enabled) */}
      {!isAppEmbedEnabled && (
        <s-box paddingBlockEnd="base">
          <s-banner heading="Theme App Embed Required" tone="caution">
            <s-paragraph>
              To ensure your customized widgets and live discount calculations render seamlessly on your product pages, activate the StackUp App Embed in your theme.
            </s-paragraph>
            <s-button
              slot="action"
              variant="primary"
              href={themeEditorUrl}
              target="_blank"
            >
              Activate in Theme Editor
            </s-button>
          </s-banner>
        </s-box>
      )}

      {/* Category Filter Pills using Polaris Buttons in an Inline Stack */}
      <s-box paddingBlockEnd="base">
        <s-stack direction="inline" gap="small" wrap>
          <s-button
            variant={activeFilter === "all" ? "primary" : "secondary"}
            onClick={() => setActiveFilter("all")}
          >
            All Widgets
          </s-button>
          <s-button
            variant={activeFilter === "paired" ? "primary" : "secondary"}
            onClick={() => setActiveFilter("paired")}
          >
            Frequently Bought
          </s-button>
          <s-button
            variant={activeFilter === "selected" ? "primary" : "secondary"}
            onClick={() => setActiveFilter("selected")}
          >
            Product Add-ons
          </s-button>
          <s-button
            variant={activeFilter === "volume" ? "primary" : "secondary"}
            onClick={() => setActiveFilter("volume")}
          >
            Quantity Breaks
          </s-button>
          <s-button
            variant={activeFilter === "bogo" ? "primary" : "secondary"}
            onClick={() => setActiveFilter("bogo")}
          >
            Buy X Get Y
          </s-button>
        </s-stack>
      </s-box>

      {/* Polaris Web Component Grid for Widget Customization Cards */}
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(340px, 1fr))" gap="base">
        {filteredWidgets.map((item) => {
          const isThisLoading = navigatingId === item.id || (isNavigating && navigatingId === item.id);
          const isAnyDisabled = Boolean(navigatingId) || isNavigating;

          return (
            <s-box
              key={item.id}
              background="surface"
              border="base"
              borderRadius="base"
              padding="base"
            >
              <s-stack gap="base" justifyContent="space-between">
                <s-stack gap="base">
                  {/* Visual Preview Banner */}
                  <s-box
                    borderRadius="base"
                    overflow="hidden"
                    border="base"
                    background="subdued"
                  >
                    <s-image
                      src={item.image}
                      alt={item.alt}
                      aspectRatio="16/9"
                      objectFit="contain"
                      inlineSize="fill"
                    />
                  </s-box>

                  {/* Badge, Title & Description */}
                  <s-stack gap="small">
                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                      <s-heading size="medium">{item.title}</s-heading>
                      <s-badge tone={item.badgeTone}>{item.badgeLabel}</s-badge>
                    </s-stack>
                    <s-text tone="subdued">{item.description}</s-text>
                  </s-stack>
                </s-stack>

                {/* Status and Action Buttons */}
                <s-stack gap="small">
                  <s-divider />
                  <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                    <s-badge tone={item.activeOffers > 0 ? "success" : "neutral"}>
                      {item.activeOffers > 0
                        ? `${item.activeOffers} Active Offer${item.activeOffers === 1 ? "" : "s"}`
                        : "0 Active Offers"}
                    </s-badge>
                    <s-button
                      variant="primary"
                      loading={isThisLoading}
                      disabled={isAnyDisabled}
                      onClick={() => handleCustomizeClick(item)}
                    >
                      Customize Widget
                    </s-button>
                  </s-stack>
                </s-stack>
              </s-stack>
            </s-box>
          );
        })}
      </s-grid>
    </s-page>
  );
}
