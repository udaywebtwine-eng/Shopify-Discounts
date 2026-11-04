/**
 * Master Discount Engine Helper for StackUp
 * 
 * Manages the single permanent automatic discounts in Shopify Admin:
 * 1. "StackUp Selected Products (Do Not Delete)" -> backed by selected-products-discount function
 * 2. "StackUp Paired Products (Do Not Delete)"   -> backed by paired-products-discount function
 * 
 * Individual offers are stored in PostgreSQL DB and synced to Shop Metafields.
 * Offers never create separate discount nodes in Shopify Admin, eliminating
 * "Discount does not exist" and "Invalid id" errors permanently.
 */

export const MASTER_SELECTED_TITLE = "StackUp Selected Products (Do Not Delete)";
export const MASTER_PAIRED_TITLE = "StackUp Paired Products (Do Not Delete)";

/**
 * Queries all Shopify Functions installed in the store to find function IDs.
 */
export async function getInstalledFunctionIds(admin) {
  try {
    const res = await admin.graphql(
      `#graphql
      query GetInstalledFunctions {
        shopifyFunctions(first: 25) {
          nodes {
            id
            title
            apiType
          }
        }
      }`
    );
    const json = await res.json();
    const functions = json.data?.shopifyFunctions?.nodes || [];

    const selectedFn = functions.find(
      (fn) =>
        fn.title?.toLowerCase().includes("selected") ||
        fn.id?.toLowerCase().includes("selected")
    );
    const pairedFn = functions.find(
      (fn) =>
        fn.title?.toLowerCase().includes("paired") ||
        fn.id?.toLowerCase().includes("paired")
    );

    return {
      selectedFunctionId: selectedFn?.id || functions[0]?.id || null,
      pairedFunctionId: pairedFn?.id || functions[1]?.id || functions[0]?.id || null,
    };
  } catch (err) {
    console.error("[MasterDiscount] Error querying shopifyFunctions:", err);
    return { selectedFunctionId: null, pairedFunctionId: null };
  }
}

/**
 * Retrieves the status of both master discounts from Shopify Admin.
 */
export async function getMasterDiscountsStatus(admin) {
  try {
    const res = await admin.graphql(
      `#graphql
      query GetMasterDiscounts {
        discountNodes(first: 50) {
          nodes {
            id
            discount {
              __typename
              ... on DiscountAutomaticApp {
                title
                status
                combinesWith {
                  orderDiscounts
                  productDiscounts
                  shippingDiscounts
                }
                appDiscountType {
                  functionId
                }
              }
            }
          }
        }
      }`
    );
    const json = await res.json();
    const nodes = json.data?.discountNodes?.nodes || [];

    let selectedMaster = null;
    let pairedMaster = null;

    for (const node of nodes) {
      const disc = node.discount;
      if (!disc || disc.__typename !== "DiscountAutomaticApp") continue;

      const titleLower = (disc.title || "").toLowerCase();
      if (titleLower.includes("stackup selected products") || disc.title === MASTER_SELECTED_TITLE) {
        selectedMaster = {
          nodeId: node.id,
          numericId: node.id.split("/").pop(),
          title: disc.title,
          status: disc.status,
          combinesWith: disc.combinesWith || {
            orderDiscounts: true,
            productDiscounts: false,
            shippingDiscounts: true,
          },
        };
      } else if (titleLower.includes("stackup paired products") || disc.title === MASTER_PAIRED_TITLE) {
        pairedMaster = {
          nodeId: node.id,
          numericId: node.id.split("/").pop(),
          title: disc.title,
          status: disc.status,
          combinesWith: disc.combinesWith || {
            orderDiscounts: true,
            productDiscounts: false,
            shippingDiscounts: true,
          },
        };
      }
    }

    return { selectedMaster, pairedMaster };
  } catch (err) {
    console.error("[MasterDiscount] Error querying master discount nodes:", err);
    return { selectedMaster: null, pairedMaster: null };
  }
}

/**
 * Creates the Master Automatic Discount in Shopify for Selected Products.
 */
export async function createMasterSelectedDiscount(admin, functionId, combinations = {}) {
  const mutation = `#graphql
    mutation CreateMasterSelectedDiscount($automaticAppDiscount: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
        automaticAppDiscount {
          discountId
          title
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    automaticAppDiscount: {
      title: MASTER_SELECTED_TITLE,
      functionId,
      startsAt: new Date().toISOString(),
      discountClasses: ["PRODUCT"],
      combinesWith: {
        orderDiscounts: combinations.orderDiscounts !== false,
        productDiscounts: Boolean(combinations.productDiscounts),
        shippingDiscounts: combinations.shippingDiscounts !== false,
      },
      metafields: [
        {
          namespace: "$app:discount",
          key: "function_configuration",
          type: "json",
          value: JSON.stringify({ isMaster: true }),
        },
      ],
    },
  };

  const res = await admin.graphql(mutation, { variables });
  const json = await res.json();
  const userErrors = json.data?.discountAutomaticAppCreate?.userErrors || [];
  if (userErrors.length > 0) {
    console.error("[MasterDiscount] Error creating Selected master discount:", userErrors);
    throw new Error(userErrors.map((e) => e.message).join(", "));
  }

  const created = json.data?.discountAutomaticAppCreate?.automaticAppDiscount;
  console.log("[MasterDiscount] Successfully created Selected Master Discount:", created?.discountId);
  return created;
}

/**
 * Creates the Master Automatic Discount in Shopify for Paired Products.
 */
export async function createMasterPairedDiscount(admin, functionId, combinations = {}) {
  const mutation = `#graphql
    mutation CreateMasterPairedDiscount($automaticAppDiscount: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
        automaticAppDiscount {
          discountId
          title
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    automaticAppDiscount: {
      title: MASTER_PAIRED_TITLE,
      functionId,
      startsAt: new Date().toISOString(),
      discountClasses: ["ORDER"],
      combinesWith: {
        orderDiscounts: combinations.orderDiscounts !== false,
        productDiscounts: Boolean(combinations.productDiscounts),
        shippingDiscounts: combinations.shippingDiscounts !== false,
      },
      metafields: [
        {
          namespace: "$app:discount",
          key: "function_configuration",
          type: "json",
          value: JSON.stringify({ isMaster: true }),
        },
      ],
    },
  };

  const res = await admin.graphql(mutation, { variables });
  const json = await res.json();
  const userErrors = json.data?.discountAutomaticAppCreate?.userErrors || [];
  if (userErrors.length > 0) {
    console.error("[MasterDiscount] Error creating Paired master discount:", userErrors);
    throw new Error(userErrors.map((e) => e.message).join(", "));
  }

  const created = json.data?.discountAutomaticAppCreate?.automaticAppDiscount;
  console.log("[MasterDiscount] Successfully created Paired Master Discount:", created?.discountId);
  return created;
}

/**
 * Ensures both Master Discounts exist in Shopify Admin.
 * Recreates them automatically if missing.
 */
export async function ensureMasterDiscounts(admin, options = {}) {
  const { selectedMaster, pairedMaster } = await getMasterDiscountsStatus(admin);
  const { selectedFunctionId, pairedFunctionId } = await getInstalledFunctionIds(admin);

  let updatedSelected = selectedMaster;
  let updatedPaired = pairedMaster;

  if (!selectedMaster && selectedFunctionId) {
    console.log("[MasterDiscount] Selected master discount missing in Shopify. Creating now...");
    try {
      const created = await createMasterSelectedDiscount(admin, selectedFunctionId, options.selectedCombinations);
      if (created) {
        updatedSelected = {
          nodeId: created.discountId,
          numericId: created.discountId.split("/").pop(),
          title: created.title,
          status: created.status,
          combinesWith: {
            orderDiscounts: true,
            productDiscounts: false,
            shippingDiscounts: true,
          },
        };
      }
    } catch (e) {
      console.warn("[MasterDiscount] Could not auto-create Selected master discount:", e.message);
    }
  }

  if (!pairedMaster && pairedFunctionId) {
    console.log("[MasterDiscount] Paired master discount missing in Shopify. Creating now...");
    try {
      const created = await createMasterPairedDiscount(admin, pairedFunctionId, options.pairedCombinations);
      if (created) {
        updatedPaired = {
          nodeId: created.discountId,
          numericId: created.discountId.split("/").pop(),
          title: created.title,
          status: created.status,
          combinesWith: {
            orderDiscounts: true,
            productDiscounts: false,
            shippingDiscounts: true,
          },
        };
      }
    } catch (e) {
      console.warn("[MasterDiscount] Could not auto-create Paired master discount:", e.message);
    }
  }

  return { selectedMaster: updatedSelected, pairedMaster: updatedPaired };
}

/**
 * Updates combination rules on a master discount node.
 */
export async function updateMasterDiscountCombinations(admin, nodeId, combinations) {
  const mutation = `#graphql
    mutation UpdateMasterDiscountCombinations($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
      discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
        automaticAppDiscount {
          discountId
          title
          status
          combinesWith {
            orderDiscounts
            productDiscounts
            shippingDiscounts
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const numericId = String(nodeId).split("/").pop();
  const canonicalNodeId = `gid://shopify/DiscountAutomaticNode/${numericId}`;

  const res = await admin.graphql(mutation, {
    variables: {
      id: canonicalNodeId,
      automaticAppDiscount: {
        combinesWith: {
          orderDiscounts: Boolean(combinations.orderDiscounts),
          productDiscounts: Boolean(combinations.productDiscounts),
          shippingDiscounts: Boolean(combinations.shippingDiscounts),
        },
      },
    },
  });

  const json = await res.json();
  const userErrors = json.data?.discountAutomaticAppUpdate?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e) => e.message).join(", "));
  }

  return json.data?.discountAutomaticAppUpdate?.automaticAppDiscount;
}

/**
 * Cleans up old individual discounts created by previous versions of the app,
 * keeping ONLY the Master Discounts.
 */
export async function cleanupLegacyDiscounts(admin) {
  try {
    const { selectedFunctionId, pairedFunctionId } = await getInstalledFunctionIds(admin);
    const targetFunctionIds = new Set([selectedFunctionId, pairedFunctionId].filter(Boolean));

    const res = await admin.graphql(
      `#graphql
      query GetAllDiscountsForCleanup {
        discountNodes(first: 100) {
          nodes {
            id
            discount {
              __typename
              ... on DiscountAutomaticApp {
                title
                appDiscountType {
                  functionId
                }
              }
            }
          }
        }
      }`
    );
    const json = await res.json();
    const nodes = json.data?.discountNodes?.nodes || [];

    const deletedIds = [];
    for (const node of nodes) {
      const disc = node.discount;
      if (!disc || disc.__typename !== "DiscountAutomaticApp") continue;

      const title = disc.title || "";
      const isMaster =
        title === MASTER_SELECTED_TITLE ||
        title === MASTER_PAIRED_TITLE;

      if (isMaster) continue; // Keep Master discounts safe!

      const fnId = disc.appDiscountType?.functionId;
      const isOurAppFunction = targetFunctionIds.has(fnId);
      const isStackUpTitle =
        title.toLowerCase().includes("stackup") ||
        title.toLowerCase().includes("stack-up");

      if (isOurAppFunction || isStackUpTitle) {
        console.log(`[MasterDiscount] Deleting legacy discount: "${title}" (${node.id})`);
        try {
          await admin.graphql(
            `#graphql
            mutation DeleteLegacyDiscount($id: ID!) {
              discountAutomaticDelete(id: $id) {
                deletedAutomaticDiscountId
              }
            }`,
            { variables: { id: node.id } }
          );
          deletedIds.push(node.id);
        } catch (delErr) {
          console.warn(`[MasterDiscount] Could not delete legacy discount ${node.id}:`, delErr);
        }
      }
    }

    return { deletedCount: deletedIds.length, deletedIds };
  } catch (err) {
    console.error("[MasterDiscount] Error cleaning up legacy discounts:", err);
    return { deletedCount: 0, deletedIds: [] };
  }
}
