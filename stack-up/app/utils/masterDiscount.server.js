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
export const MASTER_VOLUME_TITLE = "StackUp Volume Discounts (Do Not Delete)";
export const MASTER_BOGO_TITLE = "StackUp BOGO & Buy X Get Y (Do Not Delete)";

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
    const volumeFn = functions.find(
      (fn) =>
        fn.title?.toLowerCase().includes("volume") ||
        fn.id?.toLowerCase().includes("volume")
    );
    const bogoFn = functions.find(
      (fn) =>
        fn.title?.toLowerCase().includes("bogo") ||
        fn.id?.toLowerCase().includes("bogo") ||
        fn.title?.toLowerCase().includes("bxgy") ||
        fn.id?.toLowerCase().includes("bxgy")
    );

    return {
      selectedFunctionId: selectedFn?.id || null,
      pairedFunctionId: pairedFn?.id || null,
      volumeFunctionId: volumeFn?.id || null,
      bogoFunctionId: bogoFn?.id || null,
    };
  } catch (err) {
    console.error("[MasterDiscount] Error querying shopifyFunctions:", err);
    return { selectedFunctionId: null, pairedFunctionId: null, volumeFunctionId: null, bogoFunctionId: null };
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
    let volumeMaster = null;
    let bogoMaster = null;

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
      } else if (titleLower.includes("stackup volume") || disc.title === MASTER_VOLUME_TITLE) {
        volumeMaster = {
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
      } else if (titleLower.includes("stackup bogo") || disc.title === MASTER_BOGO_TITLE) {
        bogoMaster = {
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

    return { selectedMaster, pairedMaster, volumeMaster, bogoMaster };
  } catch (err) {
    console.error("[MasterDiscount] Error querying master discount nodes:", err);
    return { selectedMaster: null, pairedMaster: null, volumeMaster: null, bogoMaster: null };
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
 * Creates the Master Automatic Discount in Shopify for Volume Discounts / Quantity Breaks.
 */
export async function createMasterVolumeDiscount(admin, functionId, combinations = {}) {
  const mutation = `#graphql
    mutation CreateMasterVolumeDiscount($automaticAppDiscount: DiscountAutomaticAppInput!) {
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
      title: MASTER_VOLUME_TITLE,
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
    console.error("[MasterDiscount] Error creating Volume master discount:", userErrors);
    throw new Error(userErrors.map((e) => e.message).join(", "));
  }

  const created = json.data?.discountAutomaticAppCreate?.automaticAppDiscount;
  console.log("[MasterDiscount] Successfully created Volume Master Discount:", created?.discountId);
  return created;
}

/**
 * Creates the Master Automatic Discount in Shopify for BOGO & Buy X Get Y.
 */
export async function createMasterBogoDiscount(admin, functionId, combinations = {}) {
  const mutation = `#graphql
    mutation CreateMasterBogoDiscount($automaticAppDiscount: DiscountAutomaticAppInput!) {
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
      title: MASTER_BOGO_TITLE,
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
    console.error("[MasterDiscount] Error creating BOGO master discount:", userErrors);
    throw new Error(userErrors.map((e) => e.message).join(", "));
  }

  const created = json.data?.discountAutomaticAppCreate?.automaticAppDiscount;
  console.log("[MasterDiscount] Successfully created BOGO Master Discount:", created?.discountId);
  return created;
}

/**
 * Ensures all Master Discounts exist in Shopify Admin.
 * Recreates them automatically if missing.
 */
export async function ensureMasterDiscounts(admin, options = {}) {
  const { selectedMaster, pairedMaster, volumeMaster, bogoMaster } = await getMasterDiscountsStatus(admin);
  const { selectedFunctionId, pairedFunctionId, volumeFunctionId, bogoFunctionId } = await getInstalledFunctionIds(admin);

  let updatedSelected = selectedMaster;
  let updatedPaired = pairedMaster;
  let updatedVolume = volumeMaster;
  let updatedBogo = bogoMaster;

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
  } else if (selectedMaster && selectedMaster.status !== "ACTIVE" && selectedMaster.nodeId) {
    // If merchant deactivated it in Shopify Admin, reactivate it automatically
    try {
      await admin.graphql(
        `#graphql
        mutation ReactivateSelectedMaster($id: ID!) {
          discountAutomaticActivate(id: $id) {
            automaticDiscountNode {
              id
            }
            userErrors {
              message
            }
          }
        }`,
        { variables: { id: selectedMaster.nodeId } }
      );
      if (updatedSelected) updatedSelected.status = "ACTIVE";
      console.log("[MasterDiscount] Automatically reactivated Selected Master Discount:", selectedMaster.nodeId);
    } catch (actErr) {
      console.warn("[MasterDiscount] Could not auto-reactivate Selected master discount:", actErr);
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
  } else if (pairedMaster && pairedMaster.status !== "ACTIVE" && pairedMaster.nodeId) {
    // If merchant deactivated it in Shopify Admin, reactivate it automatically
    try {
      await admin.graphql(
        `#graphql
        mutation ReactivatePairedMaster($id: ID!) {
          discountAutomaticActivate(id: $id) {
            automaticDiscountNode {
              id
            }
            userErrors {
              message
            }
          }
        }`,
        { variables: { id: pairedMaster.nodeId } }
      );
      if (updatedPaired) updatedPaired.status = "ACTIVE";
      console.log("[MasterDiscount] Automatically reactivated Paired Master Discount:", pairedMaster.nodeId);
    } catch (actErr) {
      console.warn("[MasterDiscount] Could not auto-reactivate Paired master discount:", actErr);
    }
  }

  if (!volumeMaster && volumeFunctionId) {
    console.log("[MasterDiscount] Volume master discount missing in Shopify. Creating now...");
    try {
      const created = await createMasterVolumeDiscount(admin, volumeFunctionId, options.volumeCombinations);
      if (created) {
        updatedVolume = {
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
      console.warn("[MasterDiscount] Could not auto-create Volume master discount:", e.message);
    }
  } else if (volumeMaster && volumeMaster.status !== "ACTIVE" && volumeMaster.nodeId) {
    // If merchant deactivated it in Shopify Admin, reactivate it automatically
    try {
      await admin.graphql(
        `#graphql
        mutation ReactivateVolumeMaster($id: ID!) {
          discountAutomaticActivate(id: $id) {
            automaticDiscountNode {
              id
            }
            userErrors {
              message
            }
          }
        }`,
        { variables: { id: volumeMaster.nodeId } }
      );
      if (updatedVolume) updatedVolume.status = "ACTIVE";
      console.log("[MasterDiscount] Automatically reactivated Volume Master Discount:", volumeMaster.nodeId);
    } catch (actErr) {
      console.warn("[MasterDiscount] Could not auto-reactivate Volume master discount:", actErr);
    }
  }

  if (!bogoMaster && bogoFunctionId) {
    console.log("[MasterDiscount] BOGO master discount missing in Shopify. Creating now...");
    try {
      const created = await createMasterBogoDiscount(admin, bogoFunctionId, options.bogoCombinations);
      if (created) {
        updatedBogo = {
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
      console.warn("[MasterDiscount] Could not auto-create BOGO master discount:", e.message);
    }
  } else if (bogoMaster && bogoMaster.status !== "ACTIVE" && bogoMaster.nodeId) {
    // If merchant deactivated it in Shopify Admin, reactivate it automatically
    try {
      await admin.graphql(
        `#graphql
        mutation ReactivateBogoMaster($id: ID!) {
          discountAutomaticActivate(id: $id) {
            automaticDiscountNode {
              id
            }
            userErrors {
              message
            }
          }
        }`,
        { variables: { id: bogoMaster.nodeId } }
      );
      if (updatedBogo) updatedBogo.status = "ACTIVE";
      console.log("[MasterDiscount] Automatically reactivated BOGO Master Discount:", bogoMaster.nodeId);
    } catch (actErr) {
      console.warn("[MasterDiscount] Could not auto-reactivate BOGO master discount:", actErr);
    }
  }

  return {
    selectedMaster: updatedSelected,
    pairedMaster: updatedPaired,
    volumeMaster: updatedVolume,
    bogoMaster: updatedBogo,
  };
}

/**
 * Updates combination rules on a master discount node.
 * Tries the exact nodeId first, falling back to DiscountAutomaticNode and DiscountNode GIDs.
 */
export async function updateMasterDiscountCombinations(admin, nodeId, combinations, title = null) {
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
  const idCandidates = [
    nodeId,
    `gid://shopify/DiscountAutomaticNode/${numericId}`,
    `gid://shopify/DiscountNode/${numericId}`,
  ].filter(Boolean);

  const input = {
    combinesWith: {
      orderDiscounts: Boolean(combinations.orderDiscounts),
      productDiscounts: Boolean(combinations.productDiscounts),
      shippingDiscounts: Boolean(combinations.shippingDiscounts),
    },
  };
  if (title) {
    input.title = title;
  }

  let lastError = null;
  for (const candidateId of [...new Set(idCandidates)]) {
    try {
      const res = await admin.graphql(mutation, {
        variables: {
          id: candidateId,
          automaticAppDiscount: input,
        },
      });

      const json = await res.json();
      const userErrors = json.data?.discountAutomaticAppUpdate?.userErrors || [];
      if (userErrors.length === 0 && json.data?.discountAutomaticAppUpdate?.automaticAppDiscount) {
        return json.data.discountAutomaticAppUpdate.automaticAppDiscount;
      }
      if (userErrors.length > 0) {
        lastError = new Error(userErrors.map((e) => e.message).join(", "));
      }
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error(`Failed to update combinations for master discount ID ${nodeId}`);
}

/**
 * Updates combinations across ALL 4 Master Discounts in Shopify Admin:
 * 1. StackUp Selected Products
 * 2. StackUp Paired Products
 * 3. StackUp Volume Discounts
 * 4. StackUp BOGO & Buy X Get Y
 */
export async function updateAllMasterDiscountCombinations(admin, combinations) {
  const { selectedMaster, pairedMaster, volumeMaster, bogoMaster } = await getMasterDiscountsStatus(admin);

  const targets = [
    { master: selectedMaster, title: MASTER_SELECTED_TITLE },
    { master: pairedMaster, title: MASTER_PAIRED_TITLE },
    { master: volumeMaster, title: MASTER_VOLUME_TITLE },
    { master: bogoMaster, title: MASTER_BOGO_TITLE },
  ];

  const results = [];
  const errors = [];

  for (const { master, title } of targets) {
    if (master?.nodeId) {
      try {
        const updated = await updateMasterDiscountCombinations(
          admin,
          master.nodeId,
          combinations,
          master.title || title
        );
        results.push(updated);
      } catch (err) {
        console.warn(`[MasterDiscount] Failed updating combinations for ${master.title || title}:`, err.message);
        errors.push(`${master.title || title}: ${err.message}`);
      }
    }
  }

  return { results, errors };
}

/**
 * Cleans up old individual discounts created by previous versions of the app,
 * keeping ONLY the Master Discounts.
 */
export async function cleanupLegacyDiscounts(admin) {
  try {
    const { selectedFunctionId, pairedFunctionId, volumeFunctionId, bogoFunctionId } = await getInstalledFunctionIds(admin);
    const targetFunctionIds = new Set();
    [selectedFunctionId, pairedFunctionId, volumeFunctionId, bogoFunctionId].filter(Boolean).forEach((id) => {
      targetFunctionIds.add(id);
      targetFunctionIds.add(String(id).replace("gid://shopify/ShopifyFunction/", "").trim());
    });

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
        title === MASTER_PAIRED_TITLE ||
        title === MASTER_VOLUME_TITLE ||
        title === MASTER_BOGO_TITLE;

      if (isMaster) continue; // Keep Master discounts safe!

      const rawFnId = disc.appDiscountType?.functionId;
      const cleanFnId = rawFnId ? String(rawFnId).replace("gid://shopify/ShopifyFunction/", "").trim() : "";
      const isOurAppFunction = Boolean(
        (rawFnId && targetFunctionIds.has(rawFnId)) ||
        (cleanFnId && targetFunctionIds.has(cleanFnId))
      );
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
