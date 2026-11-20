import { useState, useEffect } from "react";
import { useNavigate, useNavigation, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session?.shop || "";
  const cleanShop = shop.replace(".myshopify.com", "");

  const existingCartGoal = await prisma.offer.findFirst({
    where: {
      type: "CART_GOAL",
      status: { not: "DEACTIVATED" },
      OR: [
        { shop: session.shop },
        { shop: cleanShop },
        { shop: `${cleanShop}.myshopify.com` },
      ],
    },
    select: { id: true, numericId: true, title: true, status: true },
    orderBy: { createdAt: "desc" },
  });

  return { existingCartGoal };
};

export default function NewOfferSelect() {
  const { existingCartGoal } = useLoaderData() || {};
  const hasCartGoal = Boolean(existingCartGoal);
  const navigate = useNavigate();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [selectedType, setSelectedType] = useState(null);

  useEffect(() => {
    try {
      shopify.loading(false);
    } catch { }
  }, [shopify]);

  useEffect(() => {
    if (navigation.state === "idle") {
      setSelectedType(null);
    }
  }, [navigation.state]);

  const handleSelect = (type, path) => {
    if (selectedType) return;
    try {
      shopify.loading(true);
    } catch { }
    setSelectedType(type);
    navigate(path);
  };

  const isBusy = Boolean(selectedType) || navigation.state === "loading";

  return (
    <s-page heading="Select discount type">
      <s-link slot="breadcrumb-actions" href="/app/offers">
        All Discounts
      </s-link>

      <s-box paddingBlockEnd="large">
        <s-heading tone="subdued">
          Choose the type of discount campaign you want to create for your store.
        </s-heading>
      </s-box>

      <s-section padding="none">
        <s-box padding="base">
          <s-grid
            gridTemplateColumns="@container (inline-size <= 900px) 1fr, 1fr 1fr"
            gap="base"
          >
            {/* Option 1: Frequently Bought Together */}
            <s-box
              background="subdued"
              border="small"
              borderRadius="base"
              padding="base"
            >
              <s-stack gap="base" justifyContent="space-between">
                <s-stack gap="base">
                  {/* Preview Image */}
                  <s-box
                    borderRadius="base"
                    overflow="hidden"
                    border="small"
                    background="surface"
                  >
                    <s-image
                      src="/img1.png"
                      alt="Frequently Bought Together Preview"
                      aspectRatio="16/9"
                      objectFit="contain"
                      inlineSize="fill"
                    />
                  </s-box>

                  {/* Badge, Title & Description */}
                  <s-stack gap="small">
                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                      <s-badge tone="info">Frequently Bought</s-badge>
                    </s-stack>
                    <s-heading size="medium">Frequently Bought Together</s-heading>
                    <s-text tone="subdued">
                      Pair complementary products together on your product page. When customers add both to cart, they get an exclusive bundle discount at checkout.
                    </s-text>
                  </s-stack>
                </s-stack>

                {/* Action Button */}
                <s-box paddingBlockStart="base">
                  <s-button
                    variant="primary"
                    inlineSize="fill"
                    onClick={() => handleSelect("PAIRED", "/app/offers/paired/create")}
                    loading={selectedType === "PAIRED" ? true : undefined}
                    disabled={isBusy ? true : undefined}
                  >
                    Create Frequently Bought Offer
                  </s-button>
                </s-box>
              </s-stack>
            </s-box>

            {/* Option 2: Product Add-ons */}
            <s-box
              background="subdued"
              border="small"
              borderRadius="base"
              padding="base"
            >
              <s-stack gap="base" justifyContent="space-between">
                <s-stack gap="base">
                  {/* Preview Image */}
                  <s-box
                    borderRadius="base"
                    overflow="hidden"
                    border="small"
                    background="surface"
                  >
                    <s-image
                      src="/img2.png"
                      alt="Product Add-ons Preview"
                      aspectRatio="16/9"
                      objectFit="contain"
                      inlineSize="fill"
                    />
                  </s-box>

                  {/* Badge, Title & Description */}
                  <s-stack gap="small">
                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                      <s-badge tone="caution">Product Add-ons</s-badge>
                    </s-stack>
                    <s-heading size="medium">Product Add-ons</s-heading>
                    <s-text tone="subdued">
                      Recommend high-converting add-on products with checkboxes directly on the product page. Customers get a special discounted price only on the add-on items.
                    </s-text>
                  </s-stack>
                </s-stack>

                {/* Action Button */}
                <s-box paddingBlockStart="base">
                  <s-button
                    variant="primary"
                    inlineSize="fill"
                    onClick={() => handleSelect("SELECTED", "/app/offers/selected/create")}
                    loading={selectedType === "SELECTED" ? true : undefined}
                    disabled={isBusy ? true : undefined}
                  >
                    Create Product Add-on Offer
                  </s-button>
                </s-box>
              </s-stack>
            </s-box>

            {/* Option 3: Quantity Breaks / Volume Discount */}
            <s-box
              background="subdued"
              border="small"
              borderRadius="base"
              padding="base"
            >
              <s-stack gap="base" justifyContent="space-between">
                <s-stack gap="base">
                  {/* Preview Image */}
                  <s-box
                    borderRadius="base"
                    overflow="hidden"
                    border="small"
                    background="surface"
                  >
                    <s-image
                      src="/img3.png"
                      alt="Quantity Breaks Volume Discount Preview"
                      aspectRatio="16/9"
                      objectFit="contain"
                      inlineSize="fill"
                    />
                  </s-box>

                  {/* Badge, Title & Description */}
                  <s-stack gap="small">
                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                      <s-badge tone="success">Volume Discount</s-badge>
                    </s-stack>
                    <s-heading size="medium">Quantity Breaks</s-heading>
                    <s-text tone="subdued">
                      Motivate customers to buy higher quantities with tiered discounts (e.g. Buy 2 get 10% OFF, Buy 3 get 20% OFF). Automatically applied at checkout.
                    </s-text>
                  </s-stack>
                </s-stack>

                {/* Action Button */}
                <s-box paddingBlockStart="base">
                  <s-button
                    variant="primary"
                    inlineSize="fill"
                    onClick={() => handleSelect("VOLUME", "/app/offers/volume/create")}
                    loading={selectedType === "VOLUME" ? true : undefined}
                    disabled={isBusy ? true : undefined}
                  >
                    Create Volume Offer
                  </s-button>
                </s-box>
              </s-stack>
            </s-box>

            {/* Option 4: Automatic BOGO & Buy X Get Y */}
            <s-box
              background="subdued"
              border="small"
              borderRadius="base"
              padding="base"
            >
              <s-stack gap="base" justifyContent="space-between">
                <s-stack gap="base">
                  {/* Preview Image */}
                  <s-box
                    borderRadius="base"
                    overflow="hidden"
                    border="small"
                    background="surface"
                  >
                    <s-image
                      src="/img4.png"
                      alt="Automatic BOGO & Buy X Get Y Preview"
                      aspectRatio="16/9"
                      objectFit="contain"
                      inlineSize="fill"
                    />
                  </s-box>

                  {/* Badge, Title & Description */}
                  <s-stack gap="small">
                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                      <s-badge tone="magic">BOGO & Buy X Get Y</s-badge>
                    </s-stack>
                    <s-heading size="medium">Automatic BOGO & Buy X Get Y</s-heading>
                    <s-text tone="subdued">
                      Reward customers with free items or special deals when purchasing qualifying items. Supports Buy 1 Get 1 Free, Buy X Get X, and Buy X Get Y.
                    </s-text>
                  </s-stack>
                </s-stack>

                {/* Action Button */}
                <s-box paddingBlockStart="base">
                  <s-button
                    variant="primary"
                    inlineSize="fill"
                    onClick={() => handleSelect("BOGO", "/app/offers/bogo/create")}
                    loading={selectedType === "BOGO" ? true : undefined}
                    disabled={isBusy ? true : undefined}
                  >
                    Create BOGO Offer
                  </s-button>
                </s-box>
              </s-stack>
            </s-box>

            {/* Option 5: Cart Goal / Tiered Cart-Value Discount */}
            <s-box
              background="subdued"
              border="small"
              borderRadius="base"
              padding="base"
            >
              <s-stack gap="base" justifyContent="space-between">
                <s-stack gap="base">
                  {/* Preview Image */}
                  <s-box
                    borderRadius="base"
                    overflow="hidden"
                    border="small"
                    background="surface"
                  >
                    <s-image
                      src="/img5.png"
                      alt="Cart Goal & Tiered Cart Discount Preview"
                      aspectRatio="16/9"
                      objectFit="contain"
                      inlineSize="fill"
                    />
                  </s-box>

                  {/* Badge, Title & Description */}
                  <s-stack gap="small">
                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                      <s-badge tone="success">Cart & Order Discount</s-badge>
                      {hasCartGoal && (
                        <s-badge tone="attention">1 Active (Limit reached)</s-badge>
                      )}
                    </s-stack>
                    <s-heading size="medium">Cart Goal / Spend More, Save More</s-heading>
                    <s-text tone="subdued">
                      Boost order value directly inside the cart drawer and on the cart page. Motivate customers to unlock tiered discounts, free shipping, and free gifts with an animated progress bar.
                    </s-text>
                    {hasCartGoal && (
                      <s-box background="subdued" padding="small" borderRadius="base">
                        <s-stack gap="extra-tight">
                          <s-text size="small" tone="subdued">
                            Only 1 Cart Goal campaign can run at a time to prevent duplicate progress bars.
                          </s-text>
                          <s-link href={`/app/offers/cart-goal/edit/${existingCartGoal.id || existingCartGoal.numericId}`}>
                            Edit existing campaign ({existingCartGoal.title}) →
                          </s-link>
                        </s-stack>
                      </s-box>
                    )}
                  </s-stack>
                </s-stack>

                {/* Action Button */}
                <s-box paddingBlockStart="base">
                  <s-button
                    variant={hasCartGoal ? "secondary" : "primary"}
                    inlineSize="fill"
                    onClick={() => {
                      if (hasCartGoal) return;
                      handleSelect("CART_GOAL", "/app/offers/cart-goal/create");
                    }}
                    loading={selectedType === "CART_GOAL" ? true : undefined}
                    disabled={(isBusy || hasCartGoal) ? true : undefined}
                  >
                    {hasCartGoal ? "Cart Goal Already Created" : "Create Cart Goal Offer"}
                  </s-button>
                </s-box>
              </s-stack>
            </s-box>
          </s-grid>
        </s-box>
      </s-section>
    </s-page>
  );
}
