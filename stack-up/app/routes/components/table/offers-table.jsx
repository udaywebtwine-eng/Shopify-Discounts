/* eslint-disable react/prop-types */
import { useState, useMemo } from "react";

const PAGE_SIZE = 10;

export default function OffersTable({ offersData = [], currencySymbol = "$" }) {
    const [searchQuery, setSearchQuery] = useState("");
    const [typeFilter, setTypeFilter] = useState("ALL");
    const [sortBy, setSortBy] = useState("orders_desc");
    const [currentPage, setCurrentPage] = useState(1);

    // Filtered & sorted offers
    const filteredOffers = useMemo(() => {
        const query = searchQuery.toLowerCase().trim();
        return offersData
            .filter((o) => {
                const matchesQuery =
                    !query ||
                    (o.title && o.title.toLowerCase().includes(query)) ||
                    (o.numericId && String(o.numericId).includes(query));
                const matchesType =
                    typeFilter === "ALL" || o.discountType === typeFilter;
                return matchesQuery && matchesType;
            })
            .sort((a, b) => {
                switch (sortBy) {
                    case "orders_desc":
                        return (Number(b.totalOrders) || 0) - (Number(a.totalOrders) || 0);
                    case "orders_asc":
                        return (Number(a.totalOrders) || 0) - (Number(b.totalOrders) || 0);
                    case "sales_desc":
                        return (Number(b.totalSale) || 0) - (Number(a.totalSale) || 0);
                    case "sales_asc":
                        return (Number(a.totalSale) || 0) - (Number(b.totalSale) || 0);
                    case "title_asc":
                        return (a.title || "").localeCompare(b.title || "");
                    case "title_desc":
                        return (b.title || "").localeCompare(a.title || "");
                    case "newest":
                        return (Number(b.numericId) || 0) - (Number(a.numericId) || 0);
                    case "oldest":
                        return (Number(a.numericId) || 0) - (Number(b.numericId) || 0);
                    default:
                        return (Number(b.totalOrders) || 0) - (Number(a.totalOrders) || 0);
                }
            });
    }, [offersData, searchQuery, typeFilter, sortBy]);

    const totalFilteredOffers = filteredOffers.length;
    const totalPages = Math.max(1, Math.ceil(totalFilteredOffers / PAGE_SIZE));
    const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);

    const paginatedOffers = useMemo(() => {
        const start = (safeCurrentPage - 1) * PAGE_SIZE;
        return filteredOffers.slice(start, start + PAGE_SIZE);
    }, [filteredOffers, safeCurrentPage]);

    const isFilteredOrSorted =
        searchQuery.trim() !== "" || typeFilter !== "ALL" || sortBy !== "orders_desc";

    const handleSearchChange = (val) => {
        setSearchQuery(val);
        setCurrentPage(1);
    };

    const handleTypeChange = (val) => {
        setTypeFilter(val);
        setCurrentPage(1);
    };

    const handleSortChange = (val) => {
        setSortBy(val);
        setCurrentPage(1);
    };

    const handleClearFilters = () => {
        setSearchQuery("");
        setTypeFilter("ALL");
        setSortBy("orders_desc");
        setCurrentPage(1);
    };

    const toggleColumnSort = (column) => {
        setCurrentPage(1);
        if (column === "orders") {
            setSortBy((prev) => (prev === "orders_desc" ? "orders_asc" : "orders_desc"));
        } else if (column === "sales") {
            setSortBy((prev) => (prev === "sales_desc" ? "sales_asc" : "sales_desc"));
        } else if (column === "title") {
            setSortBy((prev) => (prev === "title_asc" ? "title_desc" : "title_asc"));
        } else if (column === "id") {
            setSortBy((prev) => (prev === "newest" ? "oldest" : "newest"));
        }
    };

    return (
        <s-section heading="Top Selling Offers" padding="none">
            <s-table>
                {/* Search & Filter Toolbar in slot="filters" */}
                <s-grid
                    slot="filters"
                    gridTemplateColumns="@container (inline-size <= 760px) 1fr, 1fr 160px auto auto"
                    gap="small-200"
                    alignItems="center"
                    padding="small-400"
                >
                    <s-search-field
                        placeholder="Filter offers by title or ID..."
                        value={searchQuery}
                        onInput={(e) => handleSearchChange(e.target.value)}
                    />

                    <s-select
                        value={typeFilter}
                        onChange={(e) => handleTypeChange(e.target.value)}
                    >
                        <s-option value="ALL">All Types</s-option>
                        <s-option value="Paired Products">Paired Products</s-option>
                        <s-option value="Selected Products">Selected Products</s-option>
                        <s-option value="Volume Discount">Volume Discount</s-option>
                    </s-select>

                    <s-box>
                        <s-button
                            icon="sort"
                            variant="secondary"
                            accessibilityLabel="Sort offers"
                            interestFor="sort-offers-tooltip"
                            commandFor="sort-offers-popover"
                        />
                        <s-tooltip id="sort-offers-tooltip">Sort</s-tooltip>
                        <s-popover id="sort-offers-popover">
                            <s-box padding="small">
                                <s-choice-list
                                    label="Sort by"
                                    name="sort-by"
                                    onChange={(e) => {
                                        const val = (e.target.values && e.target.values[0]) || e.target.value;
                                        if (val) handleSortChange(val);
                                    }}
                                >
                                    <s-choice
                                        value="orders_desc"
                                        selected={sortBy === "orders_desc" ? true : undefined}
                                        onClick={() => handleSortChange("orders_desc")}
                                    >
                                        Total Orders (high to low)
                                    </s-choice>
                                    <s-choice
                                        value="orders_asc"
                                        selected={sortBy === "orders_asc" ? true : undefined}
                                        onClick={() => handleSortChange("orders_asc")}
                                    >
                                        Total Orders (low to high)
                                    </s-choice>
                                    <s-choice
                                        value="sales_desc"
                                        selected={sortBy === "sales_desc" ? true : undefined}
                                        onClick={() => handleSortChange("sales_desc")}
                                    >
                                        Total Sales (high to low)
                                    </s-choice>
                                    <s-choice
                                        value="sales_asc"
                                        selected={sortBy === "sales_asc" ? true : undefined}
                                        onClick={() => handleSortChange("sales_asc")}
                                    >
                                        Total Sales (low to high)
                                    </s-choice>
                                    <s-choice
                                        value="title_asc"
                                        selected={sortBy === "title_asc" ? true : undefined}
                                        onClick={() => handleSortChange("title_asc")}
                                    >
                                        Offer Title (A–Z)
                                    </s-choice>
                                    <s-choice
                                        value="title_desc"
                                        selected={sortBy === "title_desc" ? true : undefined}
                                        onClick={() => handleSortChange("title_desc")}
                                    >
                                        Offer Title (Z–A)
                                    </s-choice>
                                    <s-choice
                                        value="newest"
                                        selected={sortBy === "newest" ? true : undefined}
                                        onClick={() => handleSortChange("newest")}
                                    >
                                        Offer ID (newest first)
                                    </s-choice>
                                    <s-choice
                                        value="oldest"
                                        selected={sortBy === "oldest" ? true : undefined}
                                        onClick={() => handleSortChange("oldest")}
                                    >
                                        Offer ID (oldest first)
                                    </s-choice>
                                </s-choice-list>
                            </s-box>
                        </s-popover>
                    </s-box>

                    <s-box>
                        <s-button
                            variant="secondary"
                            disabled={!isFilteredOrSorted}
                            onClick={isFilteredOrSorted ? handleClearFilters : undefined}
                            accessibilityLabel="Clear filters"
                            icon="eraser"
                        />
                    </s-box>
                </s-grid>

                {/* Offers Table */}
                <s-table-header-row>
                    <s-table-header>No</s-table-header>
                    <s-table-header>
                        <s-clickable onClick={() => toggleColumnSort("id")}>
                            <s-text weight={sortBy === "newest" || sortBy === "oldest" ? "bold" : "regular"}>
                                Offer Id {sortBy === "newest" ? "▼" : sortBy === "oldest" ? "▲" : ""}
                            </s-text>
                        </s-clickable>
                    </s-table-header>
                    <s-table-header>
                        <s-clickable onClick={() => toggleColumnSort("title")}>
                            <s-text weight={sortBy === "title_asc" || sortBy === "title_desc" ? "bold" : "regular"}>
                                Offer Title {sortBy === "title_asc" ? "▲" : sortBy === "title_desc" ? "▼" : ""}
                            </s-text>
                        </s-clickable>
                    </s-table-header>
                    <s-table-header>Offer Type</s-table-header>
                    <s-table-header>
                        <s-clickable onClick={() => toggleColumnSort("orders")}>
                            <s-text weight={sortBy === "orders_desc" || sortBy === "orders_asc" ? "bold" : "regular"}>
                                Total Orders {sortBy === "orders_desc" ? "▼" : sortBy === "orders_asc" ? "▲" : ""}
                            </s-text>
                        </s-clickable>
                    </s-table-header>
                    <s-table-header>
                        <s-clickable onClick={() => toggleColumnSort("sales")}>
                            <s-text weight={sortBy === "sales_desc" || sortBy === "sales_asc" ? "bold" : "regular"}>
                                Total Sale {sortBy === "sales_desc" ? "▼" : sortBy === "sales_asc" ? "▲" : ""}
                            </s-text>
                        </s-clickable>
                    </s-table-header>
                    <s-table-header>Cart Click</s-table-header>
                    <s-table-header>Bundle Views</s-table-header>
                </s-table-header-row>

                <s-table-body>
                    {filteredOffers.length === 0 ? (
                        <s-empty-state
                            heading={
                                isFilteredOrSorted
                                    ? "No offers found"
                                    : "No offers yet"
                            }
                        >
                            <s-box slot="graphic" maxInlineSize="200px">
                                <s-image
                                    aspectRatio="1/0.5"
                                    src="https://cdn.shopify.com/static/images/polaris/patterns/callout.png"
                                    alt="Illustration showing empty state"
                                />
                            </s-box>
                            <s-text slot="subheading">
                                {isFilteredOrSorted
                                    ? "Try clearing your filters or search query to see more offers."
                                    : "No top selling offers found for the selected date range."}
                            </s-text>
                            {isFilteredOrSorted && (
                                <s-button
                                    slot="primary-action"
                                    variant="primary"
                                    onClick={handleClearFilters}
                                >
                                    Clear filters
                                </s-button>
                            )}
                        </s-empty-state>
                    ) : (
                        paginatedOffers.map((offer, index) => {
                            const editUrl =
                                offer.discountType === "Selected Products" || offer.type === "SELECTED"
                                    ? `/app/offers/selected/edit/${offer.numericId}`
                                    : offer.discountType === "Volume Discount" || offer.type === "VOLUME"
                                    ? `/app/offers/volume/edit/${offer.numericId}`
                                    : `/app/offers/paired/edit/${offer.numericId}`;
                            return (
                                <s-table-row key={offer.id}>
                                    <s-table-cell>{(safeCurrentPage - 1) * PAGE_SIZE + index + 1}</s-table-cell>
                                    <s-table-cell>
                                        <s-link href={editUrl}>
                                            <s-text tone="subdued">#{offer.numericId}</s-text>
                                        </s-link>
                                    </s-table-cell>
                                    <s-table-cell>
                                        <s-link href={editUrl}>
                                            <s-text weight="bold">{offer.title}</s-text>
                                        </s-link>
                                    </s-table-cell>
                                    <s-table-cell>
                                        <s-badge
                                            tone={
                                                offer.discountType === "Paired Products"
                                                    ? "info"
                                                    : offer.discountType === "Volume Discount"
                                                    ? "success"
                                                    : "warning"
                                            }
                                        >{offer.discountType}</s-badge>
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
                            );
                        })
                    )}
                </s-table-body>
            </s-table>

            {/* Pagination Controls */}
            {totalFilteredOffers > PAGE_SIZE && (
                <>
                    <s-divider />
                    <s-box paddingInline="base" paddingBlock="small">
                        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                            <s-text tone="subdued" size="small">
                                Showing {(safeCurrentPage - 1) * PAGE_SIZE + 1} – {Math.min(safeCurrentPage * PAGE_SIZE, totalFilteredOffers)} of {totalFilteredOffers} offers
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
