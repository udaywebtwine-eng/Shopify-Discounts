/* eslint-disable react/prop-types */
import { useState, useMemo } from "react";

const PAGE_SIZE = 10;

export default function ProductsTable({ productsList = [] }) {
    const [currentPage, setCurrentPage] = useState(1);

    const totalProducts = productsList.length;
    const totalPages = Math.max(1, Math.ceil(totalProducts / PAGE_SIZE));
    const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);

    const paginatedProducts = useMemo(() => {
        const start = (safeCurrentPage - 1) * PAGE_SIZE;
        return productsList.slice(start, start + PAGE_SIZE);
    }, [productsList, safeCurrentPage]);

    return (
        <s-section heading="Top Selling Products" padding="none">
            <s-table>
                <s-table-header-row>
                    <s-table-header>Product Name</s-table-header>
                    <s-table-header>Total Orders</s-table-header>
                    <s-table-header>Bundle Count</s-table-header>
                    <s-table-header>Available Quantity</s-table-header>
                </s-table-header-row>

                <s-table-body>
                    {productsList.length === 0 ? (
                        <s-empty-state heading="No products found">
                            <s-box slot="graphic" maxInlineSize="200px">
                                <s-image
                                    aspectRatio="1/0.5"
                                    src="https://cdn.shopify.com/static/images/polaris/patterns/callout.png"
                                    alt="Illustration showing empty state"
                                />
                            </s-box>
                            <s-text slot="subheading">
                                No top selling products found for the selected date range.
                            </s-text>
                        </s-empty-state>
                    ) : (
                        paginatedProducts.map((prod) => {
                            const numericId = String(prod.id || "").split("/").pop();
                            const productUrl = numericId ? `shopify:admin/products/${numericId}` : "#";

                            return (
                                <s-table-row key={prod.id}>
                                    <s-table-cell>
                                        <s-stack direction="inline" gap="small-200" alignItems="center">
                                            {prod.image ? (
                                                <s-thumbnail
                                                    src={prod.image}
                                                    alt={prod.name}
                                                    size="small"
                                                />
                                            ) : (
                                                <s-thumbnail
                                                    alt={prod.name}
                                                    size="small"
                                                />
                                            )}
                                            <s-link href={productUrl} target="_blank">
                                                <s-text weight="bold">{prod.name}</s-text>
                                            </s-link>
                                        </s-stack>
                                    </s-table-cell>
                                    <s-table-cell>
                                        <s-text weight={prod.totalOrders > 0 ? "bold" : "regular"}>
                                            {prod.totalOrders}
                                        </s-text>
                                    </s-table-cell>
                                    <s-table-cell>{prod.bundleCount}</s-table-cell>
                                    <s-table-cell>
                                        {prod.availableQuantity <= 0 ? (
                                            <s-badge tone="critical" icon="alert-octagon">Out of stock</s-badge>
                                        ) : prod.availableQuantity <= 5 ? (
                                            <s-badge tone="warning" icon="alert-circle">{prod.availableQuantity} in stock</s-badge>
                                        ) : prod.availableQuantity <= 10 ? (
                                            <s-badge tone="caution" icon="alert-triangle">{prod.availableQuantity} in stock</s-badge>
                                        ) : (
                                            <s-badge tone="success" icon="check-circle">{prod.availableQuantity} in stock</s-badge>
                                        )}
                                    </s-table-cell>
                                </s-table-row>
                            );
                        })
                    )}
                </s-table-body>
            </s-table>

            {/* Pagination Controls */}
            {totalProducts > PAGE_SIZE && (
                <>
                    <s-divider />
                    <s-box paddingInline="base" paddingBlock="small">
                        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                            <s-text tone="subdued" size="small">
                                Showing {(safeCurrentPage - 1) * PAGE_SIZE + 1} – {Math.min(safeCurrentPage * PAGE_SIZE, totalProducts)} of {totalProducts} products
                            </s-text>
                            {totalPages > 1 && (
                                <s-stack direction="inline" gap="small" alignItems="center">
                                    <s-button
                                        variant="secondary"
                                        icon="chevron-left"
                                        disabled={safeCurrentPage <= 1 ? true : undefined}
                                        onClick={safeCurrentPage > 1 ? () => setCurrentPage((p) => Math.max(1, p - 1)) : undefined}
                                        accessibilityLabel="Previous page"
                                    />
                                    <s-text weight="medium" size="small">
                                        Page {safeCurrentPage} of {totalPages}
                                    </s-text>
                                    <s-button
                                        variant="secondary"
                                        icon="chevron-right"
                                        disabled={safeCurrentPage >= totalPages ? true : undefined}
                                        onClick={safeCurrentPage < totalPages ? () => setCurrentPage((p) => Math.min(totalPages, p + 1)) : undefined}
                                        accessibilityLabel="Next page"
                                    />
                                </s-stack>
                            )}
                        </s-stack>
                    </s-box>
                </>
            )}
        </s-section>
    );
}
