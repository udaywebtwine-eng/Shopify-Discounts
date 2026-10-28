/* eslint-disable react/prop-types */
import { useState, useMemo } from "react";

export default function OffersTable({ offersData = [], currencySymbol = "$" }) {
    const [searchQuery, setSearchQuery] = useState("");
    const [sortField] = useState("totalOrders");
    const [sortAsc, setSortAsc] = useState(false);

    // Filtered & sorted offers
    const filteredOffers = useMemo(() => {
        return offersData
            .filter((o) => o.title.toLowerCase().includes(searchQuery.toLowerCase().trim()))
            .sort((a, b) => {
                const valA = a[sortField];
                const valB = b[sortField];
                if (typeof valA === "string") {
                    return sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
                }
                return sortAsc ? valA - valB : valB - valA;
            });
    }, [offersData, searchQuery, sortField, sortAsc]);

    return (
        <s-section heading="Top Selling Offers" padding="none">
            <s-table>
                {/* Search Input Bar in slot="filters" */}
                <s-grid
                    slot="filters"
                    gridTemplateColumns="1fr auto"
                    gap="small-200"
                    alignItems="center"
                    padding="small-400"
                >
                    <s-search-field
                        placeholder="Filter Offers"
                        value={searchQuery}
                        onInput={(e) => setSearchQuery(e.target.value)}
                    />
                    <s-button
                        icon="sort"
                        onClick={() => {
                            setSortAsc(!sortAsc);
                        }}
                    >
                        Sort {sortAsc ? "▲" : "▼"}
                    </s-button>
                </s-grid>

                {/* Offers Table */}
                <s-table-header-row>
                    <s-table-header>No</s-table-header>
                    <s-table-header>Offer Id</s-table-header>
                    <s-table-header>Offer Title</s-table-header>
                    <s-table-header>Offer Type</s-table-header>
                    <s-table-header>Total Orders</s-table-header>
                    <s-table-header>Total Sale</s-table-header>
                    <s-table-header>Cart Click</s-table-header>
                    <s-table-header>Bundle Views</s-table-header>
                </s-table-header-row>

                <s-table-body>
                    {filteredOffers.length === 0 ? (
                        <s-box padding="large" textAlign="center">
                            <s-text tone="subdued" size="large" weight="bold">
                                No data found
                            </s-text>
                        </s-box>
                    ) : (
                        filteredOffers.map((offer, index) => (
                            <s-table-row key={offer.id}>
                                <s-table-cell>{index + 1}</s-table-cell>
                                <s-table-cell>
                                    <s-link href={`/app/paired-products/edit/${offer.numericId}`}>
                                        <s-text tone="subdued">#{offer.numericId}</s-text>
                                    </s-link>
                                </s-table-cell>
                                <s-table-cell>
                                    <s-link href={`/app/paired-products/edit/${offer.numericId}`}>
                                        <s-text weight="bold">{offer.title}</s-text>
                                    </s-link>
                                </s-table-cell>
                                <s-table-cell>
                                    <s-badge tone="info">{offer.discountType}</s-badge>
                                </s-table-cell>
                                <s-table-cell>
                                    <s-text weight={offer.totalOrders > 0 ? "bold" : "regular"}>
                                        {offer.totalOrders}
                                    </s-text>
                                </s-table-cell>
                                <s-table-cell>
                                    <s-text weight={offer.totalSale > 0 ? "bold" : "regular"}>
                                        {currencySymbol}
                                        {offer.totalSale.toFixed(2)}
                                    </s-text>
                                </s-table-cell>
                                <s-table-cell>{offer.cartClicks}</s-table-cell>
                                <s-table-cell>{offer.bundleViews}</s-table-cell>
                            </s-table-row>
                        ))
                    )}
                </s-table-body>
            </s-table>
        </s-section>
    );
}
