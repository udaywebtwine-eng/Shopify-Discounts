import { useState, useEffect } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
    ensureMasterDiscounts,
    getMasterDiscountsStatus,
    updateMasterDiscountCombinations,
    cleanupLegacyDiscounts,
} from "../utils/masterDiscount.server";
import { syncAllActiveOffersToShopMetafield } from "../utils/bundleMetafields.server";
import { syncAllActiveSelectedOffersToShopMetafield } from "../utils/selectedOffersMetafields.server";

export const loader = async ({ request }) => {
    const { admin, session } = await authenticate.admin(request);
    const shopName = session.shop.replace(".myshopify.com", "");

    const [masterDiscounts] = await Promise.all([
        ensureMasterDiscounts(admin).catch((e) => {
            console.warn("Could not ensure master discounts:", e);
            return { selectedMaster: null, pairedMaster: null };
        }),
    ]);

    const activeCombinations =
        masterDiscounts?.selectedMaster?.combinesWith ||
        masterDiscounts?.pairedMaster?.combinesWith || {
            orderDiscounts: true,
            productDiscounts: false,
            shippingDiscounts: true,
        };

    const discountsAdminUrl = `https://admin.shopify.com/store/${shopName}/discounts`;

    return {
        shopName,
        shop: session.shop,
        masterDiscounts,
        activeCombinations,
        discountsAdminUrl,
    };
};

export const action = async ({ request }) => {
    const { admin, session } = await authenticate.admin(request);
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

        // Also update in DB for consistency
        const shop = session.shop;
        const shopConditions = [
            { shop },
            { shop: shop.replace(".myshopify.com", "") },
            { shop: `${shop.replace(".myshopify.com", "")}.myshopify.com` },
        ];
        await db.offer.updateMany({
            where: { OR: shopConditions },
            data: {
                combinesWithOrder: orderDiscounts,
                combinesWithProduct: productDiscounts,
                combinesWithShipping: shippingDiscounts,
            },
        }).catch(() => { });

        return Response.json({ success: true, message: "Combinations saved successfully!" });
    }

    if (actionType === "resync_discounts") {
        await cleanupLegacyDiscounts(admin).catch((e) => console.warn("Cleanup error:", e));
        const res = await ensureMasterDiscounts(admin);
        await Promise.all([
            syncAllActiveOffersToShopMetafield(admin).catch(() => { }),
            syncAllActiveSelectedOffersToShopMetafield(admin).catch(() => { }),
        ]);
        return Response.json({ success: true, message: "Master discounts resynced successfully!", masterDiscounts: res });
    }

    return Response.json({ success: false });
};

export default function Settings() {
    const { masterDiscounts, activeCombinations, discountsAdminUrl } = useLoaderData();
    const shopify = useAppBridge();
    const fetcher = useFetcher();

    const [orderDiscounts, setOrderDiscounts] = useState(activeCombinations.orderDiscounts !== false);
    const [productDiscounts, setProductDiscounts] = useState(Boolean(activeCombinations.productDiscounts));
    const [shippingDiscounts, setShippingDiscounts] = useState(activeCombinations.shippingDiscounts !== false);

    useEffect(() => {
        if (fetcher.data?.message) {
            try {
                shopify.toast.show(fetcher.data.message);
            } catch {
                // ignore if outside bridge
            }
        }
    }, [fetcher.data, shopify]);

    const handleSaveCombinations = () => {
        fetcher.submit(
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
        fetcher.submit({ actionType: "resync_discounts" }, { method: "POST" });
    };

    const isSaving = fetcher.state !== "idle" && fetcher.formData?.get("actionType") === "update_combinations";
    const isResyncing = fetcher.state !== "idle" && fetcher.formData?.get("actionType") === "resync_discounts";

    return (
        <s-page heading="Settings">

            <s-stack gap="base">
                {/* Combinations Section (Polaris Web Components matching Image 2) */}
                <s-section heading="Combinations">
                    <s-stack gap="base">
                        <s-heading >
                            Control whether this discount can be combined with other discounts. Defaults to OFF for merchant margin safety.
                        </s-heading>

                        <s-box background="base" border="small" borderRadius="base">
                            {/* Product discounts */}
                            <s-box padding="small">
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
                                        checked={productDiscounts}
                                        onChange={(e) => setProductDiscounts(Boolean(e.target.checked ?? e.currentTarget.checked))}
                                        accessibilityLabel="Combine with Product discounts"
                                    ></s-switch>
                                </s-stack>
                            </s-box>

                            <s-divider />

                            {/* Order discounts */}
                            <s-box padding="small">
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
                                        checked={orderDiscounts}
                                        onChange={(e) => setOrderDiscounts(Boolean(e.target.checked ?? e.currentTarget.checked))}
                                        accessibilityLabel="Combine with Order discounts"
                                    ></s-switch>
                                </s-stack>
                            </s-box>

                            <s-divider />

                            {/* Shipping discounts */}
                            <s-box padding="small">
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
                                        checked={shippingDiscounts}
                                        onChange={(e) => setShippingDiscounts(Boolean(e.target.checked ?? e.currentTarget.checked))}
                                        accessibilityLabel="Combine with Shipping discounts"
                                    ></s-switch>
                                </s-stack>
                            </s-box>
                        </s-box>

                        <s-stack direction="inline" justifyContent="flex-end">
                            <s-button
                                variant="primary"
                                inlineSize="fill"
                                onClick={handleSaveCombinations}
                                loading={isSaving ? true : undefined}
                            >
                                Save
                            </s-button>
                        </s-stack>
                    </s-stack>
                </s-section>

                {/* Master Automatic Discounts Banner */}
                <s-banner tone="info" heading="Master Automatic Discounts (Active in Checkout)">
                    <s-paragraph>
                        Bundle prices are applied automatically at checkout via Shopify Functions (Selected Products &amp; Paired Products). Don&apos;t delete them in Shopify Admin: StackUp recreates them on the next sync.
                    </s-paragraph>
                    <s-button
                        slot="secondary-actions"
                        href={discountsAdminUrl}
                        target="_blank"
                    >
                        View in Shopify Admin
                    </s-button>
                    <s-button
                        slot="secondary-actions"
                        onClick={handleResyncDiscounts}
                        loading={isResyncing ? true : undefined}
                    >
                        Resync master discounts
                    </s-button>
                </s-banner>
            </s-stack>
        </s-page>
    );
}
