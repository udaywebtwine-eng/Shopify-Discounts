/**
 * Silently synchronizes the shop metafield "stack_up.stack_up_app_enabled"
 * based on the StackUp app embed toggle in the active theme.
 *
 * Runs efficiently across any page navigation:
 * 1. Queries shop id, current metafield value, and main theme settings_data.json.
 * 2. Compares whether the embed is enabled or disabled.
 * 3. Only writes to metafieldsSet if the value actually changed (0 overhead).
 */
export async function syncAppStatusMetafield(admin) {
  // eslint-disable-next-line no-undef
  const clientId = process.env.SHOPIFY_API_KEY;
  let isAppEmbedEnabled = false;
  let numericThemeId = null;

  try {
    const res = await admin.graphql(
      `#graphql
      query CheckThemeEmbedAndMetafield {
        shop {
          id
          metafield(namespace: "stack_up", key: "stack_up_app_enabled") {
            value
          }
        }
        themes(first: 1, roles: [MAIN]) {
          nodes {
            id
            files(filenames: ["config/settings_data.json"]) {
              nodes {
                body {
                  ... on OnlineStoreThemeFileBodyText {
                    content
                  }
                }
              }
            }
          }
        }
      }`
    );
    const json = await res.json();
    const shop = json.data?.shop;
    const shopId = shop?.id;
    const currentMetafieldValue = shop?.metafield?.value;

    const mainTheme = json.data?.themes?.nodes?.[0];
    numericThemeId = mainTheme?.id?.split("/").pop() || null;

    const content = mainTheme?.files?.nodes?.[0]?.body?.content;
    if (content) {
      const cleanContent = content.replace(/\/\*[\s\S]*?\*\//g, "").trim();
      const start = cleanContent.indexOf("{");
      const end = cleanContent.lastIndexOf("}");
      const validJson = start !== -1 && end !== -1 ? cleanContent.slice(start, end + 1) : cleanContent;

      const settings = JSON.parse(validJson);
      const blocks = settings?.current?.blocks || {};

      for (const block of Object.values(blocks)) {
        const type = block?.type || "";
        const isStackUp =
          (clientId && type.includes(clientId)) ||
          type.toLowerCase().includes("stack-up") ||
          type.toLowerCase().includes("stackup");
        const isEmbed = type.includes("app-embed");

        if (isStackUp && isEmbed) {
          isAppEmbedEnabled = block.disabled !== true;
          break;
        }
      }
    }

    const desiredValue = isAppEmbedEnabled ? "true" : "false";

    // Only update if the value has changed to avoid unnecessary API mutations
    if (shopId && currentMetafieldValue !== desiredValue) {
      console.log(`[StackUp] Syncing app status metafield: "${currentMetafieldValue}" -> "${desiredValue}"`);
      await admin.graphql(
        `#graphql
        mutation SyncAppStatus($metafields: [MetafieldsSetInput!]!) {
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
                key: "stack_up_app_enabled",
                type: "single_line_text_field",
                value: desiredValue,
              },
            ],
          },
        }
      );
    }
  } catch (err) {
    console.warn("[StackUp] Could not sync app status metafield:", err);
  }

  return { isAppEmbedEnabled, numericThemeId };
}
