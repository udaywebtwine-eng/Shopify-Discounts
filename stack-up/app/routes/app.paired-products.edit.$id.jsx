import { useState, useEffect } from "react";
import {
    useLoaderData,
    useActionData,
    useNavigation,
    useSubmit,
    redirect,
} from "react-router";
import { useAppBridge, SaveBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
    getShopTimezone,
    getShopTodayDate,
    formatDateInShopTimezone,
    dateToShopISO,
} from "../utils/timezone";

export const loader = async ({ request, params }) => {
    const { admin } = await authenticate.admin(request);
    const numericId = params.id;

    console.log("-------------------> [EditLoader] Loading offer for numericId:", numericId);

    // Try querying discountNode with standard GID formats
    let discountNode = null;
    const possibleIds = [
        `gid://shopify/DiscountAutomaticNode/${numericId}`,
        `gid://shopify/DiscountAutomaticApp/${numericId}`,
    ];

    for (const gid of possibleIds) {
        try {
            const response = await admin.graphql(
                `#graphql
        query GetDiscountDetails($id: ID!) {
          discountNode(id: $id) {
            id
            discount {
              __typename
              ... on DiscountAutomaticApp {
                title
                status
                startsAt
                endsAt
                combinesWith {
                  orderDiscounts
                  productDiscounts
                  shippingDiscounts
                }
              }
            }
            metafield(namespace: "$app:discount", key: "function_configuration") {
              id
              value
            }
          }
        }`,
                { variables: { id: gid } }
            );
            const json = await response.json();
            if (json.data?.discountNode?.discount) {
                discountNode = json.data.discountNode;
                break;
            }
        } catch (e) {
            console.warn("-------------------> [EditLoader] Query attempt failed for", gid, e);
        }
    }

    if (!discountNode) {
        console.error("-------------------> [EditLoader] Offer not found for numericId:", numericId);
        throw new Response("Offer Not Found", { status: 404 });
    }

    const disc = discountNode.discount;
    let config = {};
    try {
        config = JSON.parse(discountNode.metafield?.value || "{}");
    } catch {
        config = {};
    }

    const mainProductIds = config.mainProductIds || [];
    const subProductIds = config.subProductIds || [];
    const allProductIds = [...new Set([...mainProductIds, ...subProductIds])];

    // Fetch product titles, images, and prices for selected products
    let productsMap = {};
    if (allProductIds.length > 0) {
        try {
            const prodResponse = await admin.graphql(
                `#graphql
        query GetProductDetails($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              title
              featuredImage {
                url
              }
              variants(first: 1) {
                nodes {
                  price
                }
              }
            }
          }
        }`,
                { variables: { ids: allProductIds } }
            );
            const prodJson = await prodResponse.json();
            const nodes = prodJson.data?.nodes || [];
            nodes.forEach((n) => {
                if (n && n.id) {
                    const rawPrice = n.variants?.nodes?.[0]?.price;
                    const price = rawPrice
                        ? (String(rawPrice).startsWith("$") ? String(rawPrice) : `$${rawPrice}`)
                        : "";
                    productsMap[n.id] = {
                        title: n.title,
                        image: n.featuredImage?.url || "",
                        price,
                    };
                }
            });
        } catch (err) {
            console.warn("-------------------> [EditLoader] Could not fetch product details:", err);
        }
    }

    const mainProductQtyMap = {};
    if (Array.isArray(config.mainProducts)) {
        config.mainProducts.forEach((item) => {
            if (item?.id) mainProductQtyMap[item.id] = Number(item.quantity) || 1;
        });
    }

    const subProductQtyMap = {};
    if (Array.isArray(config.subProducts)) {
        config.subProducts.forEach((item) => {
            if (item?.id) subProductQtyMap[item.id] = Number(item.quantity) || 1;
        });
    }

    const initialMainProducts = mainProductIds.map((id) => {
        const prod = productsMap[id];
        return {
            id,
            title: prod?.title || `Product (${id.split("/").pop()})`,
            image: prod?.image || "",
            price: prod?.price || "",
            quantity: mainProductQtyMap[id] || 1,
        };
    });

    const initialSubProducts = subProductIds.map((id) => {
        const prod = productsMap[id];
        return {
            id,
            title: prod?.title || `Product (${id.split("/").pop()})`,
            image: prod?.image || "",
            price: prod?.price || "",
            quantity: subProductQtyMap[id] || 1,
        };
    });

    const shopTimezone = await getShopTimezone(admin);

    console.log("-------------------> [Open Edit Page] Offer ID:", numericId);
    console.log("------------------->   Title:", disc.title);
    console.log("------------------->   Discount:", (config.percentage || "20") + "%");
    console.log("------------------->   Main Products (" + initialMainProducts.length + "):", initialMainProducts.map((p) => `${p.quantity}x ${p.title}`));
    console.log("------------------->   Sub Products (" + initialSubProducts.length + "):", initialSubProducts.map((p) => `${p.quantity}x ${p.title}`));

    return {
        numericId,
        discountNodeId: discountNode.id,
        shopifyStatus: disc.status || "ACTIVE",
        title: disc.title || "",
        percentage: String(config.percentage || "20"),
        combinesWith: disc.combinesWith || {
            orderDiscounts: false,
            productDiscounts: false,
            shippingDiscounts: false,
        },
        startsAt: disc.startsAt ? formatDateInShopTimezone(disc.startsAt, shopTimezone) : "",
        endsAt: disc.endsAt ? formatDateInShopTimezone(disc.endsAt, shopTimezone) : "",
        hasEndDate: Boolean(disc.endsAt),
        shopTimezone,
        initialMainProducts,
        initialSubProducts,
    };
};

export const action = async ({ request, params }) => {
    const { admin } = await authenticate.admin(request);
    const numericId = params.id;
    const formData = await request.formData();
    const intent = formData.get("intent") || "update";

    // Handle Deactivate
    if (intent === "deactivate") {
        console.log("-------------------> [Deactivate Clicked] Offer ID:", numericId);
        const targetId = formData.get("discountNodeId") || `gid://shopify/DiscountAutomaticNode/${numericId}`;

        try {
            const response = await admin.graphql(
                `#graphql
                mutation DeactivateAutomaticDiscount($id: ID!) {
                  discountAutomaticDeactivate(id: $id) {
                    automaticDiscountNode {
                      id
                    }
                    userErrors {
                      field
                      message
                    }
                  }
                }`,
                { variables: { id: targetId } }
            );
            const json = await response.json();
            const userErrors = json.data?.discountAutomaticDeactivate?.userErrors || [];
            if (userErrors.length > 0) {
                return { error: userErrors.map((e) => e.message).join(", ") };
            }
            return redirect(`/app/paired-products/edit/${numericId}`);
        } catch (err) {
            console.error("-------------------> [EditAction] Error deactivating discount:", err);
            return { error: err instanceof Error ? err.message : "Failed to deactivate offer." };
        }
    }

    // Handle Activate
    if (intent === "activate") {
        console.log("-------------------> [Activate Clicked] Offer ID:", numericId);
        const targetId = formData.get("discountNodeId") || `gid://shopify/DiscountAutomaticNode/${numericId}`;

        try {
            const response = await admin.graphql(
                `#graphql
                mutation ActivateAutomaticDiscount($id: ID!) {
                  discountAutomaticActivate(id: $id) {
                    automaticDiscountNode {
                      id
                    }
                    userErrors {
                      field
                      message
                    }
                  }
                }`,
                { variables: { id: targetId } }
            );
            const json = await response.json();
            const userErrors = json.data?.discountAutomaticActivate?.userErrors || [];
            if (userErrors.length > 0) {
                return { error: userErrors.map((e) => e.message).join(", ") };
            }
            return redirect(`/app/paired-products/edit/${numericId}`);
        } catch (err) {
            console.error("-------------------> [EditAction] Error activating discount:", err);
            return { error: err instanceof Error ? err.message : "Failed to activate offer." };
        }
    }

    // Handle Delete
    if (intent === "delete") {
        console.log("-------------------> [Delete Clicked] Deleting offer ID:", numericId);
        const deleteId = formData.get("discountNodeId") || `gid://shopify/DiscountAutomaticNode/${numericId}`;

        try {
            const response = await admin.graphql(
                `#graphql
        mutation DeleteAutomaticDiscount($id: ID!) {
          discountAutomaticDelete(id: $id) {
            deletedAutomaticDiscountId
            userErrors {
              field
              message
            }
          }
        }`,
                { variables: { id: deleteId } }
            );
            const json = await response.json();
            console.log("-------------------> [EditAction] Delete response:", JSON.stringify(json, null, 2));

            const userErrors = json.data?.discountAutomaticDelete?.userErrors || [];
            if (userErrors.length > 0) {
                return { error: userErrors.map((e) => e.message).join(", ") };
            }

            console.log("-------------------> 🎉 [EditAction] Offer deleted successfully!");
            return redirect("/app/paired-products");
        } catch (err) {
            console.error("-------------------> [EditAction] Error deleting discount:", err);
            return { error: err instanceof Error ? err.message : "Failed to delete offer." };
        }
    }

    // Handle Update
    const title = (formData.get("title") || "").trim();
    const percentageStr = formData.get("percentage") || "";
    const percentage = parseFloat(percentageStr);
    const mainProductIdsRaw = formData.get("mainProductIds") || "[]";
    const subProductIdsRaw = formData.get("subProductIds") || "[]";
    const mainProductsRaw = formData.get("mainProducts") || "[]";
    const subProductsRaw = formData.get("subProducts") || "[]";

    const combinesWithOrder = formData.get("combinesWithOrder") === "true";
    const combinesWithProduct = formData.get("combinesWithProduct") === "true";
    const combinesWithShipping = formData.get("combinesWithShipping") === "true";
    const startsAt = formData.get("startsAt") || new Date().toISOString();
    const hasEndDate = formData.get("hasEndDate") === "true";
    const endsAt = hasEndDate && formData.get("endsAt") ? formData.get("endsAt") : null;

    if (!title) {
        return { error: "Please enter an offer title." };
    }

    if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
        return { error: "Please enter a valid discount percentage between 1 and 100." };
    }

    let mainProductIds = [];
    let subProductIds = [];
    let mainProducts = [];
    let subProducts = [];
    try {
        mainProductIds = JSON.parse(mainProductIdsRaw);
        subProductIds = JSON.parse(subProductIdsRaw);
        mainProducts = JSON.parse(mainProductsRaw);
        subProducts = JSON.parse(subProductsRaw);
    } catch {
        mainProductIds = [];
        subProductIds = [];
        mainProducts = [];
        subProducts = [];
    }

    if (mainProductIds.length === 0) {
        return { error: "Please select at least one Main Product." };
    }

    if (subProductIds.length === 0) {
        return { error: "Please select at least one Sub / Add-on Product." };
    }

    if (hasEndDate && (!endsAt || !endsAt.trim())) {
        return { error: "Please enter an end date." };
    }

    if (hasEndDate && endsAt && startsAt && endsAt < startsAt) {
        return { error: "End date must be on or after start date." };
    }

    const configPayload = {
        discountType: "PAIRED_PRODUCTS",
        percentage,
        title,
        mainProductIds,
        subProductIds,
        mainProducts,
        subProducts,
    };

    const updateGid = `gid://shopify/DiscountAutomaticApp/${numericId}`;

    const shopTimezone = await getShopTimezone(admin);
    const effectiveStartsAt = dateToShopISO(startsAt, "00:00:00", shopTimezone) || new Date().toISOString();
    const effectiveEndsAt = hasEndDate && endsAt ? dateToShopISO(endsAt, "23:59:59", shopTimezone) : null;

    const metafieldItem = {
        namespace: "$app:discount",
        key: "function_configuration",
        type: "json",
        value: JSON.stringify(configPayload),
    };

    const variables = {
        id: updateGid,
        automaticAppDiscount: {
            title,
            discountClasses: ["ORDER"],
            startsAt: effectiveStartsAt,
            endsAt: effectiveEndsAt,
            combinesWith: {
                orderDiscounts: combinesWithOrder,
                productDiscounts: combinesWithProduct,
                shippingDiscounts: combinesWithShipping,
            },
            metafields: [metafieldItem],
        },
    };

    console.log("-------------------> [Save Edit Clicked]");
    console.log("------------------->   Offer ID:", numericId);
    console.log("------------------->   Updated Title:", title);
    console.log("------------------->   Updated Percentage:", percentage + "%");
    console.log("------------------->   Updated Main Products:", mainProducts);
    console.log("------------------->   Updated Sub Products:", subProducts);

    try {
        const response = await admin.graphql(
            `#graphql
      mutation UpdateAutomaticDiscount($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
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
      }`,
            { variables }
        );
        const json = await response.json();
        const userErrors = json.data?.discountAutomaticAppUpdate?.userErrors || [];
        if (userErrors.length > 0) {
            const errMsg = userErrors.map((e) => e.message).join(", ");
            console.error("-------------------> [Save Edit Failed] Shopify Error:", errMsg);
            return { error: errMsg };
        }

        console.log("-------------------> [Save Edit Success] Offer updated successfully in Shopify for ID:", numericId);
        return redirect("/app/paired-products");
    } catch (err) {
        console.error("-------------------> [Save Edit Failed] Exception:", err);
        return {
            error:
                err instanceof Error
                    ? err.message
                    : "An unexpected error occurred while updating the offer.",
        };
    }
};

export default function PairedProductsEdit() {
    const data = useLoaderData();
    const actionData = useActionData();
    const navigation = useNavigation();
    const submit = useSubmit();
    const shopify = useAppBridge();

    const [title, setTitle] = useState(data.title);
    const [percentage, setPercentage] = useState(data.percentage);

    // Main Products list
    const [mainProducts, setMainProducts] = useState(data.initialMainProducts);

    // Sub Products list
    const [subProducts, setSubProducts] = useState(data.initialSubProducts);

    // Combinations
    const [combinesWithOrder, setCombinesWithOrder] = useState(
        data.combinesWith.orderDiscounts || false
    );
    const [combinesWithProduct, setCombinesWithProduct] = useState(
        data.combinesWith.productDiscounts || false
    );
    const [combinesWithShipping, setCombinesWithShipping] = useState(
        data.combinesWith.shippingDiscounts || false
    );

    // Dates in shop's timezone
    const todayStr = getShopTodayDate(data.shopTimezone);
    const minStartDate = data.startsAt && data.startsAt < todayStr ? data.startsAt : todayStr;
    const [startsAt, setStartsAt] = useState(data.startsAt || todayStr);
    const [hasEndDate, setHasEndDate] = useState(data.hasEndDate);
    const [endsAt, setEndsAt] = useState(data.endsAt || "");

    const [isSaved, setIsSaved] = useState(false);
    const isSubmitting = navigation.state === "submitting";

    // Resource Picker for Main Products
    const handleOpenMainProductPicker = async () => {
        try {
            const selected = await shopify.resourcePicker({
                type: "product",
                multiple: true,
                action: "select",
                filter: {
                    archived: false,
                    draft: false,
                    query: "status:active",
                },
                initialSelectionIds: mainProducts.map((p) => ({ id: p.id })),
            });

            if (selected && Array.isArray(selected)) {
                setMainProducts(
                    selected.map((p) => {
                        const image =
                            p.images?.[0]?.originalSrc ||
                            p.images?.[0]?.src ||
                            p.featuredImage?.url ||
                            p.image?.src ||
                            "";
                        const rawPrice = p.variants?.[0]?.price ?? p.price ?? "";
                        const price = rawPrice
                            ? (String(rawPrice).startsWith("$") ? String(rawPrice) : `$${rawPrice}`)
                            : "";
                        const existing = mainProducts.find((item) => item.id === p.id);
                        return {
                            id: p.id,
                            title: p.title,
                            image,
                            price,
                            quantity: existing?.quantity || 1,
                        };
                    })
                );
            }
        } catch (e) {
            console.warn("Main product picker dismissed:", e);
        }
    };

    // Resource Picker for Sub Products
    const handleOpenSubProductPicker = async () => {
        try {
            const selected = await shopify.resourcePicker({
                type: "product",
                multiple: true,
                action: "select",
                filter: {
                    archived: false,
                    draft: false,
                    query: "status:active",
                },
                initialSelectionIds: subProducts.map((p) => ({ id: p.id })),
            });

            if (selected && Array.isArray(selected)) {
                setSubProducts(
                    selected.map((p) => {
                        const image =
                            p.images?.[0]?.originalSrc ||
                            p.images?.[0]?.src ||
                            p.featuredImage?.url ||
                            p.image?.src ||
                            "";
                        const rawPrice = p.variants?.[0]?.price ?? p.price ?? "";
                        const price = rawPrice
                            ? (String(rawPrice).startsWith("$") ? String(rawPrice) : `$${rawPrice}`)
                            : "";
                        const existing = subProducts.find((item) => item.id === p.id);
                        return {
                            id: p.id,
                            title: p.title,
                            image,
                            price,
                            quantity: existing?.quantity || 1,
                        };
                    })
                );
            }
        } catch (e) {
            console.warn("Sub product picker dismissed:", e);
        }
    };

    const removeMainProduct = (productId) => {
        setMainProducts((prev) => prev.filter((p) => p.id !== productId));
    };

    const removeSubProduct = (productId) => {
        setSubProducts((prev) => prev.filter((p) => p.id !== productId));
    };

    const updateMainProductQuantity = (productId, newQty) => {
        setMainProducts((prev) =>
            prev.map((p) =>
                p.id === productId
                    ? { ...p, quantity: newQty === "" ? "" : Math.max(1, parseInt(newQty, 10) || 1) }
                    : p
            )
        );
    };

    const handleBlurMainProductQuantity = (productId) => {
        setMainProducts((prev) =>
            prev.map((p) =>
                p.id === productId && (!p.quantity || p.quantity < 1)
                    ? { ...p, quantity: 1 }
                    : p
            )
        );
    };

    const updateSubProductQuantity = (productId, newQty) => {
        setSubProducts((prev) =>
            prev.map((p) =>
                p.id === productId
                    ? { ...p, quantity: newQty === "" ? "" : Math.max(1, parseInt(newQty, 10) || 1) }
                    : p
            )
        );
    };

    const handleBlurSubProductQuantity = (productId) => {
        setSubProducts((prev) =>
            prev.map((p) =>
                p.id === productId && (!p.quantity || p.quantity < 1)
                    ? { ...p, quantity: 1 }
                    : p
            )
        );
    };

    // Dirty detection comparing to initial loader state
    const isDirty = Boolean(
        title.trim() !== data.title ||
        percentage !== data.percentage ||
        combinesWithOrder !== Boolean(data.combinesWith.orderDiscounts) ||
        combinesWithProduct !== Boolean(data.combinesWith.productDiscounts) ||
        combinesWithShipping !== Boolean(data.combinesWith.shippingDiscounts) ||
        startsAt !== (data.startsAt || todayStr) ||
        hasEndDate !== data.hasEndDate ||
        endsAt !== (data.endsAt || "") ||
        JSON.stringify(mainProducts.map((p) => ({ id: p.id, quantity: Number(p.quantity) || 1 }))) !==
        JSON.stringify(data.initialMainProducts.map((p) => ({ id: p.id, quantity: Number(p.quantity) || 1 }))) ||
        JSON.stringify(subProducts.map((p) => ({ id: p.id, quantity: Number(p.quantity) || 1 }))) !==
        JSON.stringify(data.initialSubProducts.map((p) => ({ id: p.id, quantity: Number(p.quantity) || 1 })))
    );

    const showSaveBar = isDirty && !isSaved;

    useEffect(() => {
        return () => {
            shopify.saveBar?.hide("edit-paired-offer-save-bar");
        };
    }, [shopify]);

    const handleDiscard = (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        setTitle(data.title);
        setPercentage(data.percentage);
        setMainProducts(data.initialMainProducts);
        setSubProducts(data.initialSubProducts);
        setCombinesWithOrder(data.combinesWith.orderDiscounts || false);
        setCombinesWithProduct(data.combinesWith.productDiscounts || false);
        setCombinesWithShipping(data.combinesWith.shippingDiscounts || false);
        setStartsAt(data.startsAt || todayStr);
        setHasEndDate(data.hasEndDate);
        setEndsAt(data.endsAt || "");
        setIsSaved(false);
        shopify.saveBar?.hide("edit-paired-offer-save-bar");
    };

    useEffect(() => {
        if (actionData?.error) {
            setIsSaved(false);
            shopify.toast.show(actionData.error, { isError: true });
        }
    }, [actionData, shopify]);

    const handleSubmit = () => {
        if (!title.trim()) {
            shopify.toast.show("Please enter an offer title", { isError: true });
            return;
        }
        const pct = parseFloat(percentage);
        if (isNaN(pct) || pct <= 0 || pct > 100) {
            shopify.toast.show("Please enter a valid discount percentage between 1 and 100", { isError: true });
            return;
        }
        if (mainProducts.length === 0) {
            shopify.toast.show("Please select at least one Main Product", { isError: true });
            return;
        }
        if (subProducts.length === 0) {
            shopify.toast.show("Please select at least one Sub / Add-on Product", { isError: true });
            return;
        }
        if (hasEndDate && (!endsAt || !endsAt.trim())) {
            shopify.toast.show("Please enter an end date", { isError: true });
            return;
        }
        if (hasEndDate && endsAt && startsAt && endsAt < startsAt) {
            shopify.toast.show("End date must be on or after start date", { isError: true });
            return;
        }

        setIsSaved(true);
        shopify.saveBar?.hide("edit-paired-offer-save-bar");

        const formData = new FormData();
        formData.append("intent", "update");
        formData.append("title", title);
        formData.append("percentage", percentage);
        formData.append(
            "mainProductIds",
            JSON.stringify(mainProducts.map((p) => p.id))
        );
        formData.append(
            "subProductIds",
            JSON.stringify(subProducts.map((p) => p.id))
        );
        formData.append(
            "mainProducts",
            JSON.stringify(
                mainProducts.map((p) => ({
                    id: p.id,
                    quantity: Math.max(1, parseInt(p.quantity, 10) || 1),
                }))
            )
        );
        formData.append(
            "subProducts",
            JSON.stringify(
                subProducts.map((p) => ({
                    id: p.id,
                    quantity: Math.max(1, parseInt(p.quantity, 10) || 1),
                }))
            )
        );
        formData.append("combinesWithOrder", String(combinesWithOrder));
        formData.append("combinesWithProduct", String(combinesWithProduct));
        formData.append("combinesWithShipping", String(combinesWithShipping));
        formData.append("startsAt", startsAt);
        formData.append("hasEndDate", String(hasEndDate));
        if (hasEndDate && endsAt) {
            formData.append("endsAt", endsAt);
        }

        submit(formData, { method: "post" });
    };

    useEffect(() => {
        setTitle(data.title);
        setPercentage(data.percentage);
        setMainProducts(data.initialMainProducts);
        setSubProducts(data.initialSubProducts);
        setCombinesWithOrder(data.combinesWith.orderDiscounts || false);
        setCombinesWithProduct(data.combinesWith.productDiscounts || false);
        setCombinesWithShipping(data.combinesWith.shippingDiscounts || false);
        setStartsAt(data.startsAt || todayStr);
        setHasEndDate(data.hasEndDate);
        setEndsAt(data.endsAt || "");
        setIsSaved(false);
        shopify.saveBar?.hide("edit-paired-offer-save-bar");
    }, [data, todayStr, shopify]);

    const isDeactivatedOrExpired =
        data.shopifyStatus === "EXPIRED" ||
        (hasEndDate && endsAt && endsAt < todayStr);

    const handleDeactivateOffer = () => {
        setIsSaved(true);
        shopify.saveBar?.hide("edit-paired-offer-save-bar");
        const formData = new FormData();
        formData.append("intent", "deactivate");
        formData.append("discountNodeId", data.discountNodeId);
        submit(formData, { method: "post" });
    };

    const handleActivateOffer = () => {
        setIsSaved(true);
        shopify.saveBar?.hide("edit-paired-offer-save-bar");
        const formData = new FormData();
        formData.append("intent", "activate");
        formData.append("discountNodeId", data.discountNodeId);
        submit(formData, { method: "post" });
    };

    const handleDeleteOffer = () => {
        setIsSaved(true);
        shopify.saveBar?.hide("edit-paired-offer-save-bar");
        const formData = new FormData();
        formData.append("intent", "delete");
        formData.append("discountNodeId", data.discountNodeId);
        submit(formData, { method: "post" });
    };

    const status = isDeactivatedOrExpired
        ? "EXPIRED"
        : startsAt > todayStr
            ? "SCHEDULED"
            : "ACTIVE";
    const statusTone =
        status === "ACTIVE"
            ? "success"
            : status === "SCHEDULED"
                ? "warning"
                : "neutral";
    const statusLabel =
        status === "ACTIVE"
            ? "Active"
            : status === "SCHEDULED"
                ? "Scheduled"
                : "Expired";

    return (
        <s-page heading={`Edit Offer: ${title || data.title}`}>
            <s-link slot="breadcrumb-actions" href="/app/paired-products">
                Paired Products Offers
            </s-link>

            {/* Official Polaris Web Component More Actions Menu */}
            <s-button
                slot="secondary-actions"
                commandFor="offer-actions"
            >
                More actions
            </s-button>

            <s-menu
                id="offer-actions"
                accessibilityLabel="Offer actions"
            >
                {isDeactivatedOrExpired ? (
                    <s-button onClick={handleActivateOffer}>
                        Activate
                    </s-button>
                ) : (
                    <s-button
                        commandFor="deactivate-offer-modal"
                        command="--show"
                    >
                        Deactivate
                    </s-button>
                )}

                <s-button
                    tone="critical"
                    commandFor="delete-offer-modal"
                    command="--show"
                >
                    Delete
                </s-button>
            </s-menu>

            {/* Deactivate Confirmation Modal */}
            <s-modal id="deactivate-offer-modal" heading="Deactivate offer?">
                <s-stack gap="base">
                    <s-paragraph>
                        Are you sure you want to deactivate <b>&ldquo;{title || data.title}&rdquo;</b>? Customers will no longer receive this discount at checkout.
                    </s-paragraph>
                    {isDirty && (
                        <s-paragraph tone="caution">
                            Note: Any unsaved changes you made will be discarded.
                        </s-paragraph>
                    )}
                </s-stack>

                <s-button
                    slot="primary-action"
                    variant="primary"
                    tone="critical"
                    commandFor="deactivate-offer-modal"
                    command="--hide"
                    onClick={handleDeactivateOffer}
                >
                    Deactivate
                </s-button>
                <s-button
                    slot="secondary-actions"
                    variant="secondary"
                    commandFor="deactivate-offer-modal"
                    command="--hide"
                >
                    Cancel
                </s-button>
            </s-modal>

            {/* Delete Confirmation Modal */}
            <s-modal id="delete-offer-modal" heading="Delete offer?">
                <s-stack gap="base">
                    <s-paragraph>
                        Are you sure you want to delete <b>&ldquo;{title || data.title}&rdquo;</b>?
                    </s-paragraph>
                    <s-paragraph tone="critical">
                        This action cannot be undone.
                    </s-paragraph>
                </s-stack>

                <s-button
                    slot="primary-action"
                    variant="primary"
                    tone="critical"
                    commandFor="delete-offer-modal"
                    command="--hide"
                    onClick={handleDeleteOffer}
                >
                    Delete offer
                </s-button>
                <s-button
                    slot="secondary-actions"
                    variant="secondary"
                    commandFor="delete-offer-modal"
                    command="--hide"
                >
                    Cancel
                </s-button>
            </s-modal>

            <SaveBar id="edit-paired-offer-save-bar" open={showSaveBar}>
                <button
                    type="button"
                    variant="primary"
                    onClick={handleSubmit}
                    loading={isSubmitting ? "" : undefined}
                    disabled={isSubmitting ? "" : undefined}
                >
                    Save
                </button>
                <button
                    type="button"
                    onClick={handleDiscard}
                    disabled={isSubmitting ? "" : undefined}
                >
                    Discard
                </button>
            </SaveBar>

            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    handleSubmit();
                }}
            >
                <s-stack gap="base">
                    {/* Offer Details */}
                    <s-section heading="Offer details">
                        <s-grid
                            gridTemplateColumns="repeat(10, 1fr)"
                            gap="small"
                            justifyContent="center"
                        >
                            <s-grid-item gridColumn="span 7">
                                <s-text-field
                                    label="Offer title"
                                    name="title"
                                    placeholder="e.g. Phone + Charger Bundle 20% OFF"
                                    value={title}
                                    onInput={(e) => setTitle(e.target.value)}
                                    required
                                ></s-text-field>
                            </s-grid-item>
                            <s-grid-item gridColumn="span 3">
                                <s-number-field
                                    label="Discount percentage"
                                    name="percentage"
                                    min="1"
                                    max="100"
                                    step="1"
                                    suffix="%"
                                    placeholder="10"
                                    value={percentage}
                                    onInput={(e) => setPercentage(e.target.value)}
                                ></s-number-field>
                            </s-grid-item>
                        </s-grid>
                    </s-section>

                    {/* 1. Main Products */}
                    <s-section heading="1. Select Main Product(s)">
                        <s-stack gap="base">
                            <s-paragraph tone="subdued">
                                Choose the primary product(s) that the customer must add to their cart.
                            </s-paragraph>

                            <s-stack gap="base">
                                <s-stack background="subdued" padding="small" borderRadius="base" direction="inline" justifyContent="space-between" alignItems="center">
                                    <s-text weight="bold">
                                        {mainProducts.length} Main Product(s) selected
                                    </s-text>
                                    <s-button type="button" variant="primary" onClick={handleOpenMainProductPicker}>
                                        Browse Main Products
                                    </s-button>
                                </s-stack>

                                {mainProducts.length > 0 ? (
                                    <s-box>
                                        {mainProducts.map((p, idx) => (
                                            <div key={p.id}>
                                                {idx > 0 && <s-divider />}
                                                <s-box padding="small-300">
                                                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                                                        <s-stack direction="inline" gap="base" alignItems="center">
                                                            {p.image ? (
                                                                <s-thumbnail
                                                                    id={idx}
                                                                    src={p.image}
                                                                    alt={p.title}
                                                                    size="small"
                                                                />
                                                            ) : (
                                                                <s-thumbnail
                                                                    id={idx}
                                                                    alt={p.title}
                                                                    size="small"
                                                                />
                                                            )}
                                                            <s-stack gap="extra-tight">
                                                                <s-text weight="semibold">{p.title}</s-text>
                                                                {p.price && (
                                                                    <s-text tone="subdued" size="small">
                                                                        {p.price}
                                                                    </s-text>
                                                                )}
                                                            </s-stack>
                                                        </s-stack>

                                                        <s-stack direction="inline" gap="small" alignItems="center">
                                                            <s-text tone="subdued" size="small" weight="medium">
                                                                Qty:
                                                            </s-text>
                                                            <div style={{ width: "80px" }}>
                                                                <s-number-field
                                                                    // label="Quantity"
                                                                    label-hidden
                                                                    min="1"
                                                                    step="1"
                                                                    value={String(p.quantity ?? 1)}
                                                                    onInput={(e) => updateMainProductQuantity(p.id, e.target.value)}
                                                                    onBlur={() => handleBlurMainProductQuantity(p.id)}
                                                                ></s-number-field>
                                                            </div>
                                                            <s-button
                                                                type="button"
                                                                variant="primary" tone="critical"
                                                                icon="delete"
                                                                accessibilityLabel={`Remove ${p.title}`}
                                                                onClick={(e) => {
                                                                    e.preventDefault();
                                                                    e.stopPropagation();
                                                                    removeMainProduct(p.id);
                                                                }}
                                                            />
                                                        </s-stack>
                                                    </s-stack>
                                                </s-box>
                                            </div>
                                        ))}
                                    </s-box>
                                ) : (
                                    <s-paragraph tone="subdued">
                                        No main products selected yet. Click &quot;Browse Main Products&quot; to pick.
                                    </s-paragraph>
                                )}
                            </s-stack>
                        </s-stack>
                    </s-section>

                    {/* 2. Sub Products */}
                    <s-section heading="2. Select Sub / Add-on Product(s)">
                        <s-stack gap="base">
                            <s-paragraph tone="subdued">
                                Choose the companion/accessory product(s) that pair with the main product(s).
                            </s-paragraph>

                            <s-stack gap="base">
                                <s-stack background="subdued" padding="small" borderRadius="base" direction="inline" justifyContent="space-between" alignItems="center">
                                    <s-text weight="bold">
                                        {subProducts.length} Sub Product(s) selected
                                    </s-text>
                                    <s-button type="button" variant="primary" onClick={handleOpenSubProductPicker}>
                                        Browse Sub Products
                                    </s-button>
                                </s-stack>

                                {subProducts.length > 0 ? (
                                    <s-box>
                                        {subProducts.map((p, idx) => (
                                            <div key={p.id}>
                                                {idx > 0 && <s-divider />}
                                                <s-box padding="small-300">
                                                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                                                        <s-stack direction="inline" gap="base" alignItems="center">
                                                            {p.image ? (
                                                                <s-thumbnail
                                                                    id={idx}
                                                                    src={p.image}
                                                                    alt={p.title}
                                                                    size="small"
                                                                />
                                                            ) : (
                                                                <s-thumbnail
                                                                    id={idx}
                                                                    alt={p.title}
                                                                    size="small"
                                                                />
                                                            )}
                                                            <s-stack gap="extra-tight">
                                                                <s-text weight="semibold">{p.title}</s-text>
                                                                {p.price && (
                                                                    <s-text tone="subdued" size="small">
                                                                        {p.price}
                                                                    </s-text>
                                                                )}
                                                            </s-stack>
                                                        </s-stack>

                                                        <s-stack direction="inline" gap="small" alignItems="center">
                                                            <s-text tone="subdued" size="small" weight="medium">
                                                                Qty:
                                                            </s-text>
                                                            <div style={{ width: "80px" }}>
                                                                <s-number-field
                                                                    //   label="Quantity"
                                                                    label-hidden
                                                                    min="1"
                                                                    step="1"
                                                                    value={String(p.quantity ?? 1)}
                                                                    onInput={(e) => updateSubProductQuantity(p.id, e.target.value)}
                                                                    onBlur={() => handleBlurSubProductQuantity(p.id)}
                                                                ></s-number-field>
                                                            </div>
                                                            <s-button
                                                                type="button"
                                                                variant="primary" tone="critical"
                                                                icon="delete"
                                                                accessibilityLabel={`Remove ${p.title}`}
                                                                onClick={(e) => {
                                                                    e.preventDefault();
                                                                    e.stopPropagation();
                                                                    removeSubProduct(p.id);
                                                                }}
                                                            />
                                                        </s-stack>
                                                    </s-stack>
                                                </s-box>
                                            </div>
                                        ))}
                                    </s-box>
                                ) : (
                                    <s-paragraph tone="subdued">
                                        No sub products selected yet. Click &quot;Browse Sub Products&quot; to pick.
                                    </s-paragraph>
                                )}
                            </s-stack>
                        </s-stack>
                    </s-section>

                    {/* Active Dates */}
                    <s-section heading="Active dates">
                        <s-stack gap="base">
                            {data.shopTimezone && (
                                <s-paragraph tone="subdued">
                                    Times are based on your store timezone ({data.shopTimezone}).
                                </s-paragraph>
                            )}
                            <s-grid
                                gridTemplateColumns="repeat(2, 1fr)"
                                gap="base"
                            >
                                <s-grid-item gridColumn="span 1">
                                    <s-date-field
                                        label="Start date"
                                        value={startsAt || ""}
                                        allow={`${minStartDate}--`}
                                        onChange={(e) => setStartsAt(e.target.value)}
                                    ></s-date-field>
                                </s-grid-item>

                                {hasEndDate && (
                                    <s-grid-item gridColumn="span 1">
                                        <s-date-field
                                            label="End date"
                                            value={endsAt || ""}
                                            allow={`${startsAt || minStartDate}--`}
                                            onChange={(e) => setEndsAt(e.target.value)}
                                        ></s-date-field>
                                    </s-grid-item>
                                )}

                                <s-grid-item gridColumn="span 2">
                                    <s-checkbox
                                        label="Set end date"
                                        checked={hasEndDate}
                                        onChange={(e) => {
                                            const checked = e.currentTarget.checked;
                                            setHasEndDate(checked);
                                            if (!checked) {
                                                setEndsAt("");
                                            }
                                        }}
                                    ></s-checkbox>
                                </s-grid-item>
                            </s-grid>
                        </s-stack>
                    </s-section>

                    {/* Combinations */}
                    <s-section heading="Combinations">
                        <s-stack gap="base">
                            <s-paragraph tone="subdued">
                                Control whether this discount can be combined with other discounts. Defaults to OFF for merchant margin safety.
                            </s-paragraph>

                            <s-box
                                background="base"
                                border="small"
                                borderRadius="base"
                            >
                                {/* Product discounts */}
                                <s-box padding="small-300">
                                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                                        <s-stack direction="inline" gap="base" alignItems="center">
                                            <s-icon type="product-add" />
                                            <s-stack gap="extra-tight">
                                                <s-text weight="semibold">Product discounts</s-text>
                                                <s-text tone="subdued" size="small">
                                                    Multiple can apply per order · One per product (best value wins)
                                                </s-text>
                                            </s-stack>
                                        </s-stack>
                                        <s-switch
                                            checked={combinesWithProduct}
                                            onChange={(e) => setCombinesWithProduct(Boolean(e.target.checked ?? e.currentTarget.checked))}
                                            accessibilityLabel="Combine with Product discounts"
                                        ></s-switch>
                                    </s-stack>
                                </s-box>

                                <s-divider />

                                {/* Order discounts */}
                                <s-box padding="small-300">
                                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                                        <s-stack direction="inline" gap="base" alignItems="center">
                                            <s-icon type="order" />
                                            <s-stack gap="extra-tight">
                                                <s-text weight="semibold">Order discounts</s-text>
                                                <s-text tone="subdued" size="small">
                                                    Multiple can apply per order
                                                </s-text>
                                            </s-stack>
                                        </s-stack>
                                        <s-switch
                                            checked={combinesWithOrder}
                                            onChange={(e) => setCombinesWithOrder(Boolean(e.target.checked ?? e.currentTarget.checked))}
                                            accessibilityLabel="Combine with Order discounts"
                                        ></s-switch>
                                    </s-stack>
                                </s-box>

                                <s-divider />

                                {/* Shipping discounts */}
                                <s-box padding="small-300">
                                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                                        <s-stack direction="inline" gap="base" alignItems="center">
                                            <s-icon type="delivery" />
                                            <s-stack gap="extra-tight">
                                                <s-text weight="semibold">Shipping discounts</s-text>
                                                <s-text tone="subdued" size="small">
                                                    Only one can apply per order (best value wins)
                                                </s-text>
                                            </s-stack>
                                        </s-stack>
                                        <s-switch
                                            checked={combinesWithShipping}
                                            onChange={(e) => setCombinesWithShipping(Boolean(e.target.checked ?? e.currentTarget.checked))}
                                            accessibilityLabel="Combine with Shipping discounts"
                                        ></s-switch>
                                    </s-stack>
                                </s-box>
                            </s-box>
                        </s-stack>
                    </s-section>

                </s-stack>
            </form>

            {/* Right side Sidebar: Summary in slot="aside" */}
            <s-section slot="aside" heading="Summary">
                <s-badge slot="supplemental" tone={statusTone}>
                    {statusLabel}
                </s-badge>
                <s-stack gap="base">
                    <s-stack gap="tight">
                        <s-text weight="bold">Offer title</s-text>
                        <s-paragraph tone={title.trim() ? "default" : "subdued"}>
                            {title.trim() || "No title set"}
                        </s-paragraph>
                    </s-stack>

                    <s-stack gap="tight">
                        <s-text weight="bold">Discount value</s-text>
                        <s-paragraph tone="subdued">
                            • {percentage ? `${percentage}% off order subtotal` : "No discount value set"}
                        </s-paragraph>
                    </s-stack>

                    <s-stack gap="tight">
                        <s-text weight="bold">Target products (Main)</s-text>
                        {mainProducts.length > 0 ? (
                            mainProducts.map((p) => (
                                <s-paragraph key={p.id} tone="subdued">
                                    • {p.quantity || 1}x {p.title}
                                </s-paragraph>
                            ))
                        ) : (
                            <s-paragraph tone="subdued">• No main products selected</s-paragraph>
                        )}
                    </s-stack>

                    <s-stack gap="tight">
                        <s-text weight="bold">Offer products (Sub / Add-on)</s-text>
                        {subProducts.length > 0 ? (
                            subProducts.map((p) => (
                                <s-paragraph key={p.id} tone="subdued">
                                    • {p.quantity || 1}x {p.title}
                                </s-paragraph>
                            ))
                        ) : (
                            <s-paragraph tone="subdued">• No sub products selected</s-paragraph>
                        )}
                    </s-stack>

                    <s-stack gap="tight">
                        <s-text weight="bold">Combinations</s-text>
                        <s-paragraph tone="subdued">
                            • {[
                                combinesWithOrder && "Order",
                                combinesWithProduct && "Product",
                                combinesWithShipping && "Shipping",
                            ].filter(Boolean).join(", ") || "None"}
                        </s-paragraph>
                    </s-stack>

                    <s-stack gap="tight">
                        <s-text weight="bold">Active dates</s-text>
                        <s-paragraph tone="subdued">
                            • Starts {startsAt || todayStr}
                            {hasEndDate && endsAt ? ` • Ends ${endsAt}` : ""}
                        </s-paragraph>
                    </s-stack>

                    <s-stack background="subdued" padding="small" borderRadius="base" gap="small">
                        <s-text size="small" weight="bold">How it applies:</s-text>
                        <s-paragraph size="small" tone="subdued">
                            When a customer adds the required quantity of Main and Sub products to cart, {percentage || "0"}% discount will be applied automatically at checkout.
                        </s-paragraph>
                    </s-stack>
                </s-stack>
            </s-section>
        </s-page>
    );
}