import { useState } from "react";
import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
    const { session } = await authenticate.admin(request);
    const shopName = session.shop.replace(".myshopify.com", "");

    // Initial mock / persisted offers list for Main + Suggested discounts
    const offers = [
        {
            id: "gid://shopify/DiscountAutomaticApp/1",
            numericId: "1",
            title: "Summer Paired Products 20% OFF",
            discountPercentage: "20%",
            mainProductCount: 412,
            metafieldNamespaceKey: "custom.suggested_products",
            healthStatus: "healthy", // "healthy" | "missing_metafield" | "warning"
            healthLabel: "Healthy (412 mapped)",
            status: "ACTIVE", // "ACTIVE" | "EXPIRED" | "SCHEDULED"
            combinesWith: "None",
            startDate: "Oct 1, 2026",
            endDate: "No end date",
        },
        {
            id: "gid://shopify/DiscountAutomaticApp/2",
            numericId: "2",
            title: "Bedroom Furniture Cross-Sell 15% OFF",
            discountPercentage: "15%",
            mainProductCount: 38,
            metafieldNamespaceKey: "custom.suggested_products",
            healthStatus: "warning",
            healthLabel: "3 missing metafields",
            status: "ACTIVE",
            combinesWith: "None",
            startDate: "Oct 15, 2026",
            endDate: "Dec 31, 2026",
        },
        {
            id: "gid://shopify/DiscountAutomaticApp/3",
            numericId: "3",
            title: "Flash Bundle Weekend 25% OFF",
            discountPercentage: "25%",
            mainProductCount: 15,
            metafieldNamespaceKey: "custom.suggested_products",
            healthStatus: "healthy",
            healthLabel: "Healthy (15 mapped)",
            status: "EXPIRED",
            combinesWith: "None",
            startDate: "Oct 5, 2026",
            endDate: "Oct 8, 2026",
        },
    ];

    return { shopName, offers };
};

export default function PairedProducts() {
    const { offers } = useLoaderData();
    const navigate = useNavigate();

    const [searchQuery, setSearchQuery] = useState("");
    const [statusFilter, setStatusFilter] = useState("ALL");
    const [healthFilter, setHealthFilter] = useState("ALL");

    const filteredOffers = offers.filter((offer) => {
        const matchesSearch =
            offer.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
            offer.metafieldNamespaceKey.toLowerCase().includes(searchQuery.toLowerCase());

        const matchesStatus =
            statusFilter === "ALL" || offer.status === statusFilter;

        const matchesHealth =
            healthFilter === "ALL" ||
            (healthFilter === "HEALTHY" && offer.healthStatus === "healthy") ||
            (healthFilter === "WARNING" && offer.healthStatus !== "healthy");

        return matchesSearch && matchesStatus && matchesHealth;
    });

    const activeCount = offers.filter((o) => o.status === "ACTIVE").length;

    return (
        <s-page heading="Paired Products Offers">
            <s-link slot="breadcrumb-actions" href="/app">
                Home
            </s-link>
            <s-button slot="primary-action" variant="primary" href="/app/paired-products/create">
                Create offer
            </s-button>

            {/* Overview Metric Banner */}
            <s-section>
                <s-grid gridTemplateColumns="repeat(3, 1fr)" gap="base">
                    <s-grid-item gridColumn="span 1">
                        <s-stack background="subdued" padding="base" borderRadius="base">
                            <s-text tone="subdued">Total Offers</s-text>
                            <s-heading size="large">{offers.length}</s-heading>
                            <s-paragraph tone="subdued">Paired product discount rules</s-paragraph>
                        </s-stack>
                    </s-grid-item>

                    <s-grid-item gridColumn="span 1">
                        <s-stack background="subdued" padding="base" borderRadius="base">
                            <s-text tone="subdued">Active in Checkout</s-text>
                            <s-heading size="large">{activeCount}</s-heading>
                            <s-paragraph tone="subdued">Currently evaluating cart combinations</s-paragraph>
                        </s-stack>
                    </s-grid-item>

                    <s-grid-item gridColumn="span 1">
                        <s-stack background="subdued" padding="base" borderRadius="base">
                            <s-text tone="subdued">Metafield Source</s-text>
                            <s-heading size="large">~400</s-heading>
                            <s-paragraph tone="subdued">Products with suggested items</s-paragraph>
                        </s-stack>
                    </s-grid-item>
                </s-grid>
            </s-section>

            {/* Filter and Table Section */}
            <s-section>
                <s-box paddingBlockEnd="base">
                    <s-stack direction="inline" gap="base" alignItems="center">
                        <s-box inlineSize="fill">
                            <s-search-field
                                label="Search offers"
                                labelAccessibilityVisibility="exclusive"
                                placeholder="Search offers by name or metafield..."
                                value={searchQuery}
                                onInput={(e) => setSearchQuery(e.target.value)}
                            ></s-search-field>
                        </s-box>

                        <s-select
                            label="Status"
                            value={statusFilter}
                            onChange={(e) => setStatusFilter(e.target.value)}
                        >
                            <s-option value="ALL">All Statuses</s-option>
                            <s-option value="ACTIVE">Active</s-option>
                            <s-option value="EXPIRED">Expired</s-option>
                            <s-option value="SCHEDULED">Scheduled</s-option>
                        </s-select>

                        <s-select
                            label="Configuration Health"
                            value={healthFilter}
                            onChange={(e) => setHealthFilter(e.target.value)}
                        >
                            <s-option value="ALL">All Health</s-option>
                            <s-option value="HEALTHY">Healthy</s-option>
                            <s-option value="WARNING">Issues / Missing Metafields</s-option>
                        </s-select>
                    </s-stack>
                </s-box>

                {filteredOffers.length === 0 ? (
                    <s-box padding="large" background="subdued" borderRadius="base">
                        <s-stack gap="base" alignItems="center">
                            <s-heading>No offers found</s-heading>
                            <s-paragraph tone="subdued">
                                {searchQuery || statusFilter !== "ALL" || healthFilter !== "ALL"
                                    ? "Try clearing your filters or search query."
                                    : "You haven't created any Paired product offers yet."}
                            </s-paragraph>
                            {searchQuery || statusFilter !== "ALL" || healthFilter !== "ALL" ? (
                                <s-button
                                    onClick={() => {
                                        setSearchQuery("");
                                        setStatusFilter("ALL");
                                        setHealthFilter("ALL");
                                    }}
                                >
                                    Clear filters
                                </s-button>
                            ) : (
                                <s-button variant="primary" href="/app/paired-products/create">
                                    Create your first offer
                                </s-button>
                            )}
                        </s-stack>
                    </s-box>
                ) : (
                    <s-table>
                        <s-table-header-row>
                            <s-table-header>Offer name</s-table-header>
                            <s-table-header>Discount</s-table-header>
                            <s-table-header>Main products</s-table-header>
                            <s-table-header>Metafield mapping</s-table-header>
                            <s-table-header>Status</s-table-header>
                            <s-table-header>Schedule</s-table-header>
                            <s-table-header>Actions</s-table-header>
                        </s-table-header-row>

                        <s-table-body>
                            {filteredOffers.map((offer) => (
                                <s-table-row key={offer.id}>
                                    <s-table-cell>
                                        <s-stack gap="extra-tight">
                                            <s-link href={`/app/paired-products/${offer.numericId}`}>
                                                <s-text weight="bold">{offer.title}</s-text>
                                            </s-link>
                                            <s-text tone="subdued" size="small">
                                                Combines: {offer.combinesWith}
                                            </s-text>
                                        </s-stack>
                                    </s-table-cell>

                                    <s-table-cell>
                                        <s-badge tone="info">{offer.discountPercentage} OFF</s-badge>
                                    </s-table-cell>

                                    <s-table-cell>
                                        <s-text>{offer.mainProductCount} products</s-text>
                                    </s-table-cell>

                                    <s-table-cell>
                                        <s-stack gap="extra-tight">
                                            <s-text size="small">{offer.metafieldNamespaceKey}</s-text>
                                            <s-badge
                                                tone={offer.healthStatus === "healthy" ? "success" : "warning"}
                                            >
                                                {offer.healthLabel}
                                            </s-badge>
                                        </s-stack>
                                    </s-table-cell>

                                    <s-table-cell>
                                        <s-badge
                                            tone={offer.status === "ACTIVE" ? "success" : "neutral"}
                                        >
                                            {offer.status}
                                        </s-badge>
                                    </s-table-cell>

                                    <s-table-cell>
                                        <s-stack gap="extra-tight">
                                            <s-text size="small">{offer.startDate}</s-text>
                                            <s-text tone="subdued" size="small">
                                                {offer.endDate}
                                            </s-text>
                                        </s-stack>
                                    </s-table-cell>

                                    <s-table-cell>
                                        <s-stack direction="inline" gap="small">
                                            <s-button
                                                variant="tertiary"
                                                href={`/app/paired-products/${offer.numericId}`}
                                            >
                                                Edit
                                            </s-button>
                                        </s-stack>
                                    </s-table-cell>
                                </s-table-row>
                            ))}
                        </s-table-body>
                    </s-table>
                )}
            </s-section>
        </s-page>
    );
}
