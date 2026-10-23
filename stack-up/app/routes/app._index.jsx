import { useNavigate, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shopName = session.shop.replace(".myshopify.com", "");
  return { shopName, shop: session.shop };
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
  const navigate = useNavigate();
  const { shopName } = useLoaderData();

  return (
    <s-page heading="Automatic Discounts">
      <s-box paddingBlockEnd="small">
        <s-heading tone="subdued">
          {shopName} • Create automatic offers for product combinations or selected products.
        </s-heading>
      </s-box>
      <s-section>

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
