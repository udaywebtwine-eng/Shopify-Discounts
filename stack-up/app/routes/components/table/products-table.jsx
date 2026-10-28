/* eslint-disable react/prop-types */

export default function ProductsTable({ productsList = [] }) {
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
                        <s-box padding="large" textAlign="center">
                            <s-text tone="subdued" size="large" weight="bold">
                                No data found
                            </s-text>
                        </s-box>
                    ) : (
                        productsList.map((prod) => {
                            console.log(prod, "prodddddd")
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
                                            <s-badge tone="critical" icon="alert-octagon" >Out of stock</s-badge>
                                        ) : prod.availableQuantity <= 5 ? (
                                            <s-badge tone="warning" icon="alert-circle" >{prod.availableQuantity} in stock</s-badge>
                                        ) : prod.availableQuantity <= 10 ? (
                                            <s-badge tone="caution" icon="alert-triangle" >{prod.availableQuantity} in stock</s-badge>
                                        ) : (
                                            <s-badge tone="success" icon="check-circle" >{prod.availableQuantity} in stock</s-badge>
                                        )}
                                    </s-table-cell>
                                </s-table-row>
                            );
                        })
                    )}
                </s-table-body>
            </s-table>
        </s-section>
    );
}
