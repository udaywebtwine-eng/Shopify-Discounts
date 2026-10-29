import { authenticate } from "../shopify.server";
import { syncAppStatusMetafield } from "../utils/appStatus.server";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const { isAppEmbedEnabled, numericThemeId } = await syncAppStatusMetafield(admin);

  const shopName = session.shop.replace(".myshopify.com", "");
  // eslint-disable-next-line no-undef
  const clientId = process.env.SHOPIFY_API_KEY;
  const activateQuery = clientId
    ? `&activateAppId=${encodeURIComponent(`${clientId}/app-embed`)}`
    : "";

  let themeEditorUrl = `https://admin.shopify.com/store/${shopName}/themes/current/editor?context=apps${activateQuery}`;
  if (numericThemeId) {
    themeEditorUrl = `https://admin.shopify.com/store/${shopName}/themes/${numericThemeId}/editor?context=apps${activateQuery}`;
  }

  return {
    themeExtensionStatus: {
      appEmbedEnabled: isAppEmbedEnabled,
    },
    isAppEmbedEnabled,
    themeEditorUrl,
  };
};
