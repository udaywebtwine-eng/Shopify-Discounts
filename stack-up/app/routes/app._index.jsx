import { useLoaderData, useFetcher } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import { syncAppStatusMetafield } from "../utils/appStatus.server";
import { syncAllActiveOffersToShopMetafield } from "../utils/bundleMetafields.server";
import { syncAllActiveSelectedOffersToShopMetafield } from "../utils/selectedOffersMetafields.server";
import {
  ensureMasterDiscounts,
  getMasterDiscountsStatus,
  updateMasterDiscountCombinations,
  cleanupLegacyDiscounts,
} from "../utils/masterDiscount.server";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shopName = session.shop.replace(".myshopify.com", "");

  // eslint-disable-next-line no-undef
  const clientId = process.env.SHOPIFY_API_KEY;
  const activateQuery = clientId
    ? `&activateAppId=${encodeURIComponent(`${clientId}/app-embed`)}`
    : "";

  let themeEditorUrl = `https://admin.shopify.com/store/${shopName}/themes/current/editor?context=apps${activateQuery}`;

  const [{ isAppEmbedEnabled, numericThemeId }, masterDiscounts] = await Promise.all([
    syncAppStatusMetafield(admin),
    ensureMasterDiscounts(admin).catch((e) => {
      console.warn("Could not ensure master discounts:", e);
      return { selectedMaster: null, pairedMaster: null };
    }),
    syncAllActiveOffersToShopMetafield(admin).catch((e) => console.warn("Failed to sync paired offers:", e)),
    syncAllActiveSelectedOffersToShopMetafield(admin).catch((e) => console.warn("Failed to sync selected offers:", e)),
    cleanupLegacyDiscounts(admin).catch((e) => console.warn("Failed to cleanup legacy discounts:", e)),
  ]);

  if (numericThemeId) {
    themeEditorUrl = `https://admin.shopify.com/store/${shopName}/themes/${numericThemeId}/editor?context=apps${activateQuery}`;
  }

  const discountsAdminUrl = `https://admin.shopify.com/store/${shopName}/discounts`;

  return {
    shopName,
    shop: session.shop,
    themeEditorUrl,
    isAppEmbedEnabled,
    masterDiscounts,
    discountsAdminUrl,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "update_combinations") {
    const orderDiscounts = formData.get("orderDiscounts") === "true";
    const productDiscounts = formData.get("productDiscounts") === "true";
    const shippingDiscounts = formData.get("shippingDiscounts") === "true";

    const combinations = { orderDiscounts, productDiscounts, shippingDiscounts };
    const { selectedMaster, pairedMaster } = await getMasterDiscountsStatus(admin);

    if (selectedMaster?.nodeId) {
      await updateMasterDiscountCombinations(admin, selectedMaster.nodeId, combinations).catch((e) =>
        console.warn("Update selected master combinations failed:", e)
      );
    }
    if (pairedMaster?.nodeId) {
      await updateMasterDiscountCombinations(admin, pairedMaster.nodeId, combinations).catch((e) =>
        console.warn("Update paired master combinations failed:", e)
      );
    }

    return Response.json({ success: true, message: "Combinations updated successfully!" });
  }

  if (actionType === "resync_discounts") {
    await cleanupLegacyDiscounts(admin).catch((e) => console.warn("Cleanup error:", e));
    const res = await ensureMasterDiscounts(admin);
    await Promise.all([
      syncAllActiveOffersToShopMetafield(admin).catch(() => {}),
      syncAllActiveSelectedOffersToShopMetafield(admin).catch(() => {}),
    ]);
    return Response.json({ success: true, message: "Cleaned old discounts & resynced master discounts!", masterDiscounts: res });
  }

  return Response.json({ success: false });
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
    link: "/app/paired-products/create",
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
  const {
    shopName,
    themeEditorUrl: initialUrl,
    isAppEmbedEnabled: initialEnabled,
    masterDiscounts,
    discountsAdminUrl,
  } = useLoaderData();

  const fetcher = useFetcher();
  const combinationsFetcher = useFetcher();
  const resyncFetcher = useFetcher();

  const isAppEmbedEnabled = fetcher.data?.isAppEmbedEnabled ?? initialEnabled;
  const themeEditorUrl = fetcher.data?.themeEditorUrl ?? initialUrl;

  // Combination settings state initialized from active master discounts
  const activeCombinations =
    masterDiscounts?.selectedMaster?.combinesWith ||
    masterDiscounts?.pairedMaster?.combinesWith || {
      orderDiscounts: true,
      productDiscounts: false,
      shippingDiscounts: true,
    };

  const [orderDiscounts, setOrderDiscounts] = useState(activeCombinations.orderDiscounts !== false);
  const [productDiscounts, setProductDiscounts] = useState(Boolean(activeCombinations.productDiscounts));
  const [shippingDiscounts, setShippingDiscounts] = useState(activeCombinations.shippingDiscounts !== false);
  const [saveSuccessMessage, setSaveSuccessMessage] = useState("");

  useEffect(() => {
    if (combinationsFetcher.data?.message) {
      setSaveSuccessMessage(combinationsFetcher.data.message);
      const timer = setTimeout(() => setSaveSuccessMessage(""), 4000);
      return () => clearTimeout(timer);
    }
  }, [combinationsFetcher.data]);

  useEffect(() => {
    if (resyncFetcher.data?.message) {
      setSaveSuccessMessage(resyncFetcher.data.message);
      const timer = setTimeout(() => setSaveSuccessMessage(""), 4000);
      return () => clearTimeout(timer);
    }
  }, [resyncFetcher.data]);

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

  const handleSaveCombinations = () => {
    combinationsFetcher.submit(
      {
        actionType: "update_combinations",
        orderDiscounts: String(orderDiscounts),
        productDiscounts: String(productDiscounts),
        shippingDiscounts: String(shippingDiscounts),
      },
      { method: "POST" }
    );
  };

  const handleResyncDiscounts = () => {
    resyncFetcher.submit({ actionType: "resync_discounts" }, { method: "POST" });
  };

  const isSavingCombinations = combinationsFetcher.state !== "idle";
  const isResyncing = resyncFetcher.state !== "idle";

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

        {/* Offer Type Cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "16px",
            marginBottom: "20px",
          }}
        >
          <s-stack background="subdued" padding="base" borderRadius="base" justifyContent="space-between">
            <s-box>
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
                    Apply a discount specifically to recommended add-on products when purchased
                    together with the main/target product.
                  </s-paragraph>
                </s-stack>
              </s-stack>
            </s-box>
            <s-box paddingBlockStart="base">
              <s-button
                variant="primary"
                inlineSize="fill"
                href="/app/sected-products"
              >
                Manage offers
              </s-button>
            </s-box>
          </s-stack>
        </div>

        {/* 3. Checkout Discount Engine Card (Bundlify Architecture) */}
        <div style={{ marginBottom: "20px" }}>
          <div
            style={{
              backgroundColor: "#ffffff",
              border: "1px solid #e1e3e5",
              borderRadius: "12px",
              padding: "20px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
              <div>
                <h3 style={{ margin: "0 0 6px 0", fontSize: "16px", fontWeight: "600", color: "#202223" }}>
                  3. Checkout discount
                </h3>
                <p style={{ margin: 0, fontSize: "13px", color: "#6d7175", lineHeight: "1.5" }}>
                  Bundle prices are applied by automatic discounts powered by Shopify Functions.
                  Don&apos;t delete them in Shopify Admin: StackUp recreates them on the next sync.
                </p>
              </div>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "4px 10px",
                  backgroundColor: "#e3f1df",
                  color: "#1a7f37",
                  borderRadius: "20px",
                  fontSize: "12px",
                  fontWeight: "600",
                  whiteSpace: "nowrap",
                }}
              >
                ● Active in Checkout
              </span>
            </div>

            <div style={{ borderTop: "1px solid #f1f2f3", paddingTop: "16px", marginTop: "16px" }}>
              <div style={{ fontSize: "14px", fontWeight: "600", color: "#202223", marginBottom: "12px" }}>
                Combine bundle discounts with:
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "20px" }}>
                <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer", fontSize: "13px" }}>
                  <input
                    type="checkbox"
                    checked={orderDiscounts}
                    onChange={(e) => setOrderDiscounts(e.target.checked)}
                    style={{ marginTop: "2px", width: "16px", height: "16px", cursor: "pointer", accentColor: "#008060" }}
                  />
                  <span>
                    <b>Order discounts</b> (e.g. 10% off the whole order codes)
                  </span>
                </label>

                <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer", fontSize: "13px" }}>
                  <input
                    type="checkbox"
                    checked={productDiscounts}
                    onChange={(e) => setProductDiscounts(e.target.checked)}
                    style={{ marginTop: "2px", width: "16px", height: "16px", cursor: "pointer", accentColor: "#008060" }}
                  />
                  <div>
                    <span><b>Other product discounts</b></span>
                    <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>
                      Off by default so a bundled item isn&apos;t discounted twice.
                    </div>
                  </div>
                </label>

                <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer", fontSize: "13px" }}>
                  <input
                    type="checkbox"
                    checked={shippingDiscounts}
                    onChange={(e) => setShippingDiscounts(e.target.checked)}
                    style={{ marginTop: "2px", width: "16px", height: "16px", cursor: "pointer", accentColor: "#008060" }}
                  />
                  <span>
                    <b>Shipping discounts</b> (e.g. free shipping)
                  </span>
                </label>
              </div>

              {saveSuccessMessage && (
                <div
                  style={{
                    backgroundColor: "#e3f1df",
                    color: "#1a7f37",
                    padding: "8px 12px",
                    borderRadius: "6px",
                    fontSize: "13px",
                    fontWeight: "500",
                    marginBottom: "14px",
                  }}
                >
                  ✓ {saveSuccessMessage}
                </div>
              )}

              <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                <button
                  type="button"
                  onClick={handleSaveCombinations}
                  disabled={isSavingCombinations}
                  style={{
                    backgroundColor: "#008060",
                    color: "#ffffff",
                    border: "none",
                    borderRadius: "6px",
                    padding: "8px 16px",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: isSavingCombinations ? "not-allowed" : "pointer",
                    opacity: isSavingCombinations ? 0.7 : 1,
                  }}
                >
                  {isSavingCombinations ? "Saving..." : "Save"}
                </button>

                <a
                  href={discountsAdminUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    backgroundColor: "#ffffff",
                    color: "#202223",
                    border: "1px solid #babfc3",
                    borderRadius: "6px",
                    padding: "7px 14px",
                    fontSize: "13px",
                    fontWeight: "500",
                    textDecoration: "none",
                    cursor: "pointer",
                  }}
                >
                  View discounts
                </a>

                <button
                  type="button"
                  onClick={handleResyncDiscounts}
                  disabled={isResyncing}
                  style={{
                    backgroundColor: "transparent",
                    color: "#2c6ecb",
                    border: "none",
                    padding: "8px 12px",
                    fontSize: "13px",
                    fontWeight: "500",
                    cursor: isResyncing ? "not-allowed" : "pointer",
                    textDecoration: "underline",
                  }}
                >
                  {isResyncing ? "Resyncing..." : "Resync now"}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Cards */}
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
                <s-button href={card.link || card.externalUrl}>
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
