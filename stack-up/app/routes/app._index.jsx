import { useLoaderData, useFetcher } from "react-router";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import { syncAppStatusMetafield } from "../utils/appStatus.server";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shopName = session.shop.replace(".myshopify.com", "");

  // eslint-disable-next-line no-undef
  const clientId = process.env.SHOPIFY_API_KEY;
  const activateQuery = clientId
    ? `&activateAppId=${encodeURIComponent(`${clientId}/app-embed`)}`
    : "";

  let themeEditorUrl = `https://admin.shopify.com/store/${shopName}/themes/current/editor?context=apps${activateQuery}`;

  const { isAppEmbedEnabled, numericThemeId } = await syncAppStatusMetafield(admin);

  if (numericThemeId) {
    themeEditorUrl = `https://admin.shopify.com/store/${shopName}/themes/${numericThemeId}/editor?context=apps${activateQuery}`;
  }

  return { shopName, shop: session.shop, themeEditorUrl, isAppEmbedEnabled };
};

const BOTTOM_CARDS = [
  {
    title: "Product suggestions",
    description:
      "Uses your store's existing product suggestion metafields without replacing storefront widgets.",
    buttonText: "View mapping",
    link: "/app/paired-products",
  },
  {
    title: "Automatic by design",
    description:
      "Offers apply at checkout when conditions are met. Customers never need to enter discount codes.",
    buttonText: "Create campaign",
    link: "/app/paired-products/new",
  },
  {
    title: "Stacking & combinations",
    description:
      "All discount stacking defaults to OFF for merchant margin safety. Configure combinations per offer.",
    buttonText: "Learn combinations",
    externalUrl:
      "https://help.shopify.com/en/manual/discounts/combining-discounts",
  },
];

export default function Index() {
  const { shopName, themeEditorUrl: initialUrl, isAppEmbedEnabled: initialEnabled } = useLoaderData();
  const fetcher = useFetcher();

  const isAppEmbedEnabled = fetcher.data?.isAppEmbedEnabled ?? initialEnabled;
  const themeEditorUrl = fetcher.data?.themeEditorUrl ?? initialUrl;

  useEffect(() => {
    const checkStatus = () => {
      if (document.visibilityState === "visible") {
        fetcher.load("/app/status");
      }
    };

    window.addEventListener("focus", checkStatus);
    document.addEventListener("visibilitychange", checkStatus);

    let intervalId;
    if (!isAppEmbedEnabled) {
      intervalId = setInterval(checkStatus, 5000);
    }

    return () => {
      window.removeEventListener("focus", checkStatus);
      document.removeEventListener("visibilitychange", checkStatus);
      if (intervalId) clearInterval(intervalId);
    };
  }, [fetcher, isAppEmbedEnabled]);

  const handleOpenTheme = (e) => {
    e?.preventDefault?.();
    if (themeEditorUrl) {
      window.open(themeEditorUrl, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <s-page heading="Automatic Discounts">
      {!isAppEmbedEnabled && (
        <s-button
          slot="primary-action"
          onClick={handleOpenTheme}
          href={themeEditorUrl}
          target="_blank"
        >
          Theme Editor
        </s-button>
      )}

      <s-box paddingBlockEnd="small">
        <s-heading tone="subdued">
          {shopName} • Create automatic offers for product combinations or selected products.
        </s-heading>
      </s-box>
      <s-section>
        <s-box paddingBlockEnd="base">
          {isAppEmbedEnabled ? (
            <s-banner tone="success" heading="StackUp Theme Extension is Active">
              <s-paragraph>
                The app embed is active in your current theme. Your bundle widgets will display on matching product pages.
              </s-paragraph>
            </s-banner>
          ) : (
            <s-banner tone="warning" heading="Action Required: Enable StackUp in your Theme">
              <s-paragraph>
                To display your bundle offers and widgets on the product page, enable the <b>StackUp Bundles</b> app embed in your Shopify Theme Editor.
              </s-paragraph>
              <s-button
                slot="secondary-actions"
                variant="primary"
                onClick={handleOpenTheme}
                href={themeEditorUrl}
                target="_blank"
              >
                🚀 Enable in Theme Editor
              </s-button>
            </s-banner>
          )}
        </s-box>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "16px",
            marginBottom: "16px",
          }}
        >
          <s-stack background="subdued" padding="base" borderRadius="base" justifyContent="space-between">
            <s-box  >
              <s-stack gap="base">
                <s-image
                  src="/img1.png"
                  alt="Paired Products Offer Preview"
                  aspectRatio="16/9"
                  objectFit="contain"
                  borderRadius="base"
                  inlineSize="fill"
                ></s-image>
                <s-stack gap="small">
                  <s-heading>Paired Products Discount</s-heading>
                  <s-paragraph>
                    Apply a discount to the entire merchandise subtotal when a main product
                    and one of its paired suggested products are in the cart.
                  </s-paragraph>
                </s-stack>
              </s-stack>
            </s-box>
            <s-box paddingBlockStart="base">
              <s-button
                variant="primary"
                inlineSize="fill"
                href="/app/paired-products"
              >
                Manage offers
              </s-button>
            </s-box>
          </s-stack>
          <s-stack background="subdued" padding="base" borderRadius="base" justifyContent="space-between">
            <s-box>
              <s-stack gap="base">
                <s-image
                  src="/img2.png"
                  alt="Selected Products Offer Preview"
                  aspectRatio="16/9"
                  objectFit="contain"
                  borderRadius="base"
                  inlineSize="fill"
                ></s-image>
                <s-stack gap="small">
                  <s-heading>Selected Products Discount</s-heading>
                  <s-paragraph>
                    Apply a percentage discount to selected products whenever they are
                    present in the cart. Customers do not need to purchase all selected items.
                  </s-paragraph>
                </s-stack>
              </s-stack>
            </s-box>
            <s-box paddingBlockStart="base">
              <s-button
                variant="primary"
                inlineSize="fill"
                href="/app/selected-products"
              >
                Manage offers
              </s-button>
            </s-box>
          </s-stack>

        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: "16px",
          }}
        >
          {BOTTOM_CARDS.map((card, index) => (
            <s-stack background="subdued" padding="base" borderRadius="base" justifyContent="space-between" key={index}>
              <s-stack gap="small">
                <s-heading>{card.title}</s-heading>
                <s-paragraph>{card.description}</s-paragraph>
              </s-stack>

              <s-box paddingBlockStart="small">
                <s-button
                  href={card.link || card.externalUrl}
                >
                  {card.buttonText}
                </s-button>
              </s-box>
            </s-stack>
          ))}
        </div>
      </s-section>
    </s-page>
  );
}
