import { useState, useEffect, useMemo } from "react";
import { useLoaderData, useSubmit, useActionData, useSearchParams, useNavigation, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopTimezone, formatDateInShopTimezone } from "../utils/timezone";
import { syncAllActiveSelectedOffersToShopMetafield } from "../utils/selectedOffersMetafields.server";

export const loader = async ({ request }) => {
    const t0 = performance.now();
    const { admin, session } = await authenticate.admin(request);
    const tAuth = performance.now();
    const shopName = session.shop.replace(".myshopify.com", "");

    // Parallelize DB fetch with cached shop timezone
    const [shopTimezone, dbOffers] = await Promise.all([
        getShopTimezone(admin, session.shop).catch(() => "UTC"),
        prisma.selectedProductOffer.findMany({
            where: {
                OR: [
                    { shop: session.shop },
                    { shop: shopName },
                    { shop: { contains: shopName } },
                ],
            },
            orderBy: { createdAt: "desc" },
        }).catch((e) => {
            console.warn("Could not fetch DB selected offers:", e);
            return [];
        }),
    ]);
    const tAsync = performance.now();

    const formattedOffers = dbOffers.map((dbo) => {
        let targetCount = 0;
        let offeredCount = 0;
        try {
            targetCount = JSON.parse(dbo.targetProducts || "[]").length;
            offeredCount = JSON.parse(dbo.offeredProducts || dbo.products || "[]").length;
        } catch {
            targetCount = 0;
            offeredCount = 0;
        }

        return {
            id: dbo.discountId,
            numericId: dbo.numericId,
            title: dbo.title,
            discountPercentage: `${dbo.percentage}%`,
            targetCount,
            offeredCount,
            productCount: offeredCount,
            status: dbo.status || "ACTIVE",
            combinesWith: {
                orderDiscounts: dbo.combinesWithOrder,
                productDiscounts: dbo.combinesWithProduct,
                shippingDiscounts: dbo.combinesWithShipping,
            },
            usageCount: dbo.usageCount || 0,
            startDate: dbo.startsAt ? formatDateInShopTimezone(dbo.startsAt, shopTimezone) : "Immediate",
            endDate: dbo.endsAt ? formatDateInShopTimezone(dbo.endsAt, shopTimezone) : null,
        };
    });
    const tEnd = performance.now();

    console.log(`⏱️ [SelectedProducts: Table] Total: ${(tEnd - t0).toFixed(0)}ms (Auth: ${(tAuth - t0).toFixed(0)}ms | DB+TZ: ${(tAsync - tAuth).toFixed(0)}ms | Format: ${(tEnd - tAsync).toFixed(0)}ms) - ${formattedOffers.length} offers`);
    return { shopName, offers: formattedOffers };
};

export const action = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");
    const id = formData.get("id");
    const numericId = formData.get("numericId");

    if (intent === "delete" && (id || numericId)) {
        console.log("-------------------> [SelectedProducts: Delete] Deleting offer ID:", numericId || id);

        const possibleGids = [
            id,
            numericId ? `gid://shopify/DiscountAutomaticNode/${numericId}` : null,
            numericId ? `gid://shopify/DiscountAutomaticApp/${numericId}` : null,
        ].filter(Boolean);

        let deleted = false;
        let lastError = null;

        for (const targetGid of possibleGids) {
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
                    { variables: { id: targetGid } }
                );
                const json = await response.json();
                const userErrors = json.data?.discountAutomaticDelete?.userErrors || [];
                if (userErrors.length === 0 && (json.data?.discountAutomaticDelete?.deletedAutomaticDiscountId || json.data?.discountAutomaticDelete)) {
                    deleted = true;

                    try {
                        await prisma.selectedProductOffer.deleteMany({
                            where: {
                                OR: [
                                    id ? { discountId: id } : undefined,
                                    numericId ? { numericId } : undefined,
                                ].filter(Boolean),
                            },
                        });
                        console.log("-------------------> 💾 [SelectedProducts: Delete] Removed offer from DB for ID:", numericId || id);
                        await syncAllActiveSelectedOffersToShopMetafield(admin);
                    } catch (dbErr) {
                        console.warn("Could not delete from DB:", dbErr);
                    }

                    break;
                } else if (userErrors.length > 0) {
                    lastError = userErrors.map((e) => e.message).join(", ");
                }
            } catch (err) {
                lastError = err instanceof Error ? err.message : String(err);
            }
        }

        if (!deleted) {
            console.error("-------------------> [SelectedProducts: Delete Failed] Error:", lastError);
            return { error: lastError || "Failed to delete offer" };
        }

        return { success: true };
    }

    return null;
};

// eslint-disable-next-line react/prop-types
function MetricCard({ label, value, iconType, onClick, disabled }) {
    return (
        <s-clickable
            padding="small-300"
            borderRadius="base"
            disabled={disabled}
            onClick={onClick}
        >
            <s-stack direction="inline" gap="base" alignItems="center">
                <s-box background="subdued" borderRadius="base" padding="small" border="small">
                    <s-icon size="large" type={iconType}></s-icon>
                </s-box>
                <s-grid>
                    <s-heading tone="subdued" size="small">
                        {label}
                    </s-heading>
                    <s-text size="large" weight="bold">
                        {value}
                    </s-text>
                </s-grid>
            </s-stack>
        </s-clickable>
    );
}

export default function SelectedProducts() {
    const { offers } = useLoaderData();
    const actionData = useActionData();
    const submit = useSubmit();
    const navigation = useNavigation();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const shopify = useAppBridge();

    const isSubmitting = navigation.state === "submitting";
    const deletingId = isSubmitting && navigation.formData?.get("intent") === "delete"
        ? String(navigation.formData?.get("numericId") || navigation.formData?.get("id"))
        : null;

    // Create offer navigation loading state
    const [isNavigatingCreate, setIsNavigatingCreate] = useState(false);
    const isCreateLoading = isNavigatingCreate || (navigation.state === "loading" && navigation.location?.pathname?.includes("/create"));

    const handleCreateOffer = (e) => {
        if (e?.preventDefault) e.preventDefault();
        try {
            shopify.loading(true);
        } catch {
            // ignore if not in embedded bridge
        }
        setIsNavigatingCreate(true);
        navigate("/app/sected-products/create");
    };

    // Edit offer navigation loading state
    const [editingId, setEditingId] = useState(null);
    const isNavigatingEdit = Boolean(editingId) || (navigation.state === "loading" && navigation.location?.pathname?.includes("/edit/"));

    const handleEditOffer = (numericId) => {
        setEditingId(String(numericId));
        try {
            shopify.loading(true);
        } catch {
            // ignore if not in embedded bridge
        }
        navigate(`/app/sected-products/edit/${numericId}`);
    };

    useEffect(() => {
        if (navigation.state === "idle") {
            setIsNavigatingCreate(false);
            setEditingId(null);
        }
    }, [navigation.state]);

    // Read initial filters from URL params so reloads preserve all selections
    const initialQuery = searchParams.get("q") || "";
    const initialStatus = searchParams.get("status") || "ALL";
    const initialSort = searchParams.get("sort") || "newest";
    const initialPage = Math.max(1, parseInt(searchParams.get("page") || "1", 10));

    const [searchQuery, setSearchQuery] = useState(initialQuery);
    const [statusFilter, setStatusFilter] = useState(initialStatus);
    const [sortBy, setSortBy] = useState(initialSort);
    const [currentPage, setCurrentPage] = useState(initialPage);

    // Sync from URL when browser back/forward or searchParams change
    useEffect(() => {
        const q = searchParams.get("q") || "";
        const s = searchParams.get("status") || "ALL";
        const sort = searchParams.get("sort") || "newest";
        const p = Math.max(1, parseInt(searchParams.get("page") || "1", 10));

        if (q !== searchQuery) setSearchQuery(q);
        if (s !== statusFilter) setStatusFilter(s);
        if (sort !== sortBy) setSortBy(sort);
        if (p !== currentPage) setCurrentPage(p);
    }, [searchParams]);

    // Helper to persist filters, sort, and pagination into URL
    const updateUrlParams = (newQuery, newStatus, newSort, newPage) => {
        const params = new URLSearchParams(searchParams);
        if (newQuery) params.set("q", newQuery);
        else params.delete("q");

        if (newStatus && newStatus !== "ALL") params.set("status", newStatus);
        else params.delete("status");

        if (newSort && newSort !== "newest") params.set("sort", newSort);
        else params.delete("sort");

        if (newPage && newPage > 1) params.set("page", String(newPage));
        else params.delete("page");

        setSearchParams(params, { replace: true });
    };

    const handleSearchChange = (val) => {
        setSearchQuery(val);
        setCurrentPage(1);
        updateUrlParams(val, statusFilter, sortBy, 1);
    };

    const handleStatusChange = (val) => {
        setStatusFilter(val);
        setCurrentPage(1);
        updateUrlParams(searchQuery, val, sortBy, 1);
    };

    const handleSortChange = (val) => {
        setSortBy(val);
        setCurrentPage(1);
        updateUrlParams(searchQuery, statusFilter, val, 1);
    };

    const isFilteredOrSorted = Boolean(
        searchQuery.trim() || statusFilter !== "ALL" || sortBy !== "newest"
    );

    const handleClearAllFilters = () => {
        setSearchQuery("");
        setStatusFilter("ALL");
        setSortBy("newest");
        setCurrentPage(1);
        updateUrlParams("", "ALL", "newest", 1);
    };

    const handlePageChange = (val) => {
        const targetPage = Math.min(Math.max(1, val), totalPages);
        if (targetPage === safeCurrentPage) return;
        setCurrentPage(targetPage);
        updateUrlParams(searchQuery, statusFilter, sortBy, targetPage);
    };

    useEffect(() => {
        if (searchParams.get("created") === "true") {
            shopify.saveBar?.hide("create-selected-offer-save-bar");
            shopify.saveBar?.hide("edit-selected-offer-save-bar");
            shopify.toast.show("Discount created");
            const newParams = new URLSearchParams(searchParams);
            newParams.delete("created");
            setSearchParams(newParams, { replace: true });
        } else if (searchParams.get("updated") === "true") {
            shopify.saveBar?.hide("create-selected-offer-save-bar");
            shopify.saveBar?.hide("edit-selected-offer-save-bar");
            shopify.toast.show("Offer updated successfully");
            const newParams = new URLSearchParams(searchParams);
            newParams.delete("updated");
            setSearchParams(newParams, { replace: true });
        } else if (searchParams.get("deleted") === "true") {
            shopify.saveBar?.hide("create-selected-offer-save-bar");
            shopify.saveBar?.hide("edit-selected-offer-save-bar");
            shopify.toast.show("Offer deleted");
            const newParams = new URLSearchParams(searchParams);
            newParams.delete("deleted");
            setSearchParams(newParams, { replace: true });
        }
    }, [searchParams, setSearchParams, shopify]);

    useEffect(() => {
        try {
            shopify.loading(false);
        } catch {
            // ignore if not in embedded bridge
        }
        setIsNavigatingCreate(false);
        setEditingId(null);
        shopify.saveBar?.hide("create-selected-offer-save-bar");
        shopify.saveBar?.hide("edit-selected-offer-save-bar");
    }, [shopify]);

    useEffect(() => {
        if (actionData?.success) {
            shopify.toast.show("Offer deleted");
        } else if (actionData?.error) {
            shopify.toast.show(actionData.error, { isError: true });
        }
    }, [actionData, shopify]);

    // Filter and Sort offers
    const sortedAndFilteredOffers = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        const result = (offers || []).filter((offer) => {
            const matchesSearch =
                !query ||
                offer.title.toLowerCase().includes(query) ||
                String(offer.numericId).includes(query);

            const matchesStatus =
                statusFilter === "ALL" ||
                offer.status === statusFilter ||
                (statusFilter === "EXPIRED" &&
                    (offer.status === "EXPIRED" || offer.status === "DEACTIVATED"));

            return matchesSearch && matchesStatus;
        });

        result.sort((a, b) => {
            switch (sortBy) {
                case "oldest":
                    return (Number(a.numericId) || 0) - (Number(b.numericId) || 0);
                case "title_asc":
                    return a.title.localeCompare(b.title);
                case "title_desc":
                    return b.title.localeCompare(a.title);
                case "used_desc":
                    return (b.usageCount || 0) - (a.usageCount || 0);
                case "discount_desc": {
                    const percA = parseFloat(a.discountPercentage) || 0;
                    const percB = parseFloat(b.discountPercentage) || 0;
                    return percB - percA;
                }
                case "newest":
                default:
                    return (Number(b.numericId) || 0) - (Number(a.numericId) || 0);
            }
        });

        return result;
    }, [offers, searchQuery, statusFilter, sortBy]);

    // Pagination calculations (10 offers per page)
    const ITEMS_PER_PAGE = 10;
    const totalFilteredOffers = sortedAndFilteredOffers.length;
    const totalPages = Math.max(1, Math.ceil(totalFilteredOffers / ITEMS_PER_PAGE));
    const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);

    const paginatedOffers = useMemo(() => {
        const start = (safeCurrentPage - 1) * ITEMS_PER_PAGE;
        return sortedAndFilteredOffers.slice(start, start + ITEMS_PER_PAGE);
    }, [sortedAndFilteredOffers, safeCurrentPage]);

    const activeCount = useMemo(() => (offers || []).filter((o) => o.status === "ACTIVE").length, [offers]);
    const scheduledCount = useMemo(() => (offers || []).filter((o) => o.status === "SCHEDULED").length, [offers]);
    const deactivatedCount = useMemo(
        () => (offers || []).filter((o) => o.status === "EXPIRED" || o.status === "DEACTIVATED").length,
        [offers]
    );

    const metricCards = useMemo(() => [
        {
            id: "total",
            label: "Total Offers",
            value: (offers || []).length,
            iconType: "discount",
            filterValue: "ALL",
        },
        {
            id: "active",
            label: "Active in Checkout",
            value: activeCount,
            iconType: "check-circle",
            filterValue: "ACTIVE",
        },
        {
            id: "scheduled",
            label: "Scheduled",
            value: scheduledCount,
            iconType: "clock",
            filterValue: "SCHEDULED",
        },
        {
            id: "deactivated",
            label: "Deactivated",
            value: deactivatedCount,
            iconType: "disabled",
            filterValue: "EXPIRED",
        },
    ], [offers, activeCount, scheduledCount, deactivatedCount]);

    const handleDelete = (id, numericId) => {
        if (isSubmitting) return; // Prevent double submit
        const formData = new FormData();
        formData.append("intent", "delete");
        formData.append("id", id);
        formData.append("numericId", numericId);
        submit(formData, { method: "post" });
    };

    return (
        <s-page heading="Selected Products Offers">
            <s-link slot="breadcrumb-actions" href="/app">
                Home
            </s-link>
            <s-button
                slot="primary-action"
                variant="primary"
                onClick={handleCreateOffer}
                loading={isCreateLoading ? true : undefined}
                disabled={(isCreateLoading || isSubmitting || isNavigatingEdit) ? true : undefined}
            >
                Create offer
            </s-button>

            {/* KPI Metric Cards */}
            <s-box border="small" borderRadius="base" padding="small">
                <s-grid
                    gridTemplateColumns="@container (inline-size <= 600px) 1fr, 1fr auto 1fr auto 1fr auto 1fr"
                    gap="small"
                >
                    {metricCards.map((card, index) => [
                        index > 0 ? (
                            <s-divider key={`divider-${card.id}`} direction="block" />
                        ) : null,
                        <MetricCard
                            key={card.id}
                            label={card.label}
                            value={card.value}
                            iconType={card.iconType}
                            onClick={() => handleStatusChange(card.filterValue)}
                        />,
                    ])}
                </s-grid>
            </s-box>

            {/* Filter and Table Section */}
            <s-box paddingBlockStart="large">
                <s-section padding="none">
                    <s-table>
                        {/* Filters Toolbar Slot */}
                        <s-grid
                            slot="filters"
                            gap="small-200"
                            gridTemplateColumns="@container (inline-size <= 760px) 1fr, 1fr 140px auto auto"
                            alignItems="center"
                            padding="small-400"
                        >
                            <s-search-field
                                label="Search offers"
                                labelAccessibilityVisibility="exclusive"
                                placeholder="Search offers by name or ID..."
                                value={searchQuery}
                                onInput={(e) => handleSearchChange(e.target.value)}
                            ></s-search-field>

                            <s-select
                                label="Status"
                                labelAccessibilityVisibility="exclusive"
                                value={statusFilter}
                                onChange={(e) => handleStatusChange(e.target.value)}
                            >
                                <s-option value="ALL">All Statuses</s-option>
                                <s-option value="ACTIVE">Active</s-option>
                                <s-option value="SCHEDULED">Scheduled</s-option>
                                <s-option value="EXPIRED">Deactivated</s-option>
                            </s-select>

                            <s-box>
                                <s-button
                                    icon="sort"
                                    variant="secondary"
                                    accessibilityLabel="Sort"
                                    interestFor="sort-tooltip"
                                    commandFor="sort-actions"
                                />
                                <s-tooltip id="sort-tooltip">Sort</s-tooltip>
                                <s-popover id="sort-actions">
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
                                                value="newest"
                                                selected={sortBy === "newest" ? true : undefined}
                                                onClick={() => handleSortChange("newest")}
                                            >
                                                Newest first
                                            </s-choice>
                                            <s-choice
                                                value="oldest"
                                                selected={sortBy === "oldest" ? true : undefined}
                                                onClick={() => handleSortChange("oldest")}
                                            >
                                                Oldest first
                                            </s-choice>
                                            <s-choice
                                                value="title_asc"
                                                selected={sortBy === "title_asc" ? true : undefined}
                                                onClick={() => handleSortChange("title_asc")}
                                            >
                                                Title (A–Z)
                                            </s-choice>
                                            <s-choice
                                                value="title_desc"
                                                selected={sortBy === "title_desc" ? true : undefined}
                                                onClick={() => handleSortChange("title_desc")}
                                            >
                                                Title (Z–A)
                                            </s-choice>
                                            <s-choice
                                                value="used_desc"
                                                selected={sortBy === "used_desc" ? true : undefined}
                                                onClick={() => handleSortChange("used_desc")}
                                            >
                                                Most used
                                            </s-choice>
                                            <s-choice
                                                value="discount_desc"
                                                selected={sortBy === "discount_desc" ? true : undefined}
                                                onClick={() => handleSortChange("discount_desc")}
                                            >
                                                Highest discount
                                            </s-choice>
                                        </s-choice-list>
                                    </s-box>
                                </s-popover>
                            </s-box>

                            <s-box>
                                <s-button
                                    variant="secondary"
                                    disabled={!isFilteredOrSorted}
                                    onClick={isFilteredOrSorted ? handleClearAllFilters : undefined}
                                    icon="eraser"
                                    accessibilityLabel="Clear filters"
                                    interestFor="clear-tooltip"
                                />
                                <s-tooltip id="clear-tooltip">Clear filters</s-tooltip>
                            </s-box>
                        </s-grid>

                        {/* Table Headers */}
                        <s-table-header-row>
                            <s-table-header>
                                <s-box padding="small-300">Offer name</s-box>
                            </s-table-header>
                            <s-table-header>Discount</s-table-header>
                            <s-table-header>Products</s-table-header>
                            <s-table-header>Status</s-table-header>
                            <s-table-header>Combinations</s-table-header>
                            <s-table-header>Used</s-table-header>
                            <s-table-header>Schedule</s-table-header>
                            <s-table-header>Actions</s-table-header>
                        </s-table-header-row>

                        {/* Table Body */}
                        <s-table-body>
                            {paginatedOffers.length === 0 ? (
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
                                            alt="Illustration showing offer creation"
                                        />
                                    </s-box>
                                    <s-text slot="subheading">
                                        {isFilteredOrSorted
                                            ? "Try clearing your filters or search query to see more offers."
                                            : "Create selected product discounts to incentivize customers to buy specific quantities of products."}
                                    </s-text>
                                    {isFilteredOrSorted && (
                                        <s-button
                                            slot="secondary-actions"
                                            onClick={handleCreateOffer}
                                        >
                                            Create offer
                                        </s-button>
                                    )}
                                    {isFilteredOrSorted ? (
                                        <s-button
                                            slot="primary-action"
                                            variant="primary"
                                            onClick={handleClearAllFilters}
                                        >
                                            Clear filters
                                        </s-button>
                                    ) : (
                                        <s-button
                                            slot="primary-action"
                                            variant="primary"
                                            onClick={handleCreateOffer}
                                        >
                                            Create offer
                                        </s-button>
                                    )}
                                </s-empty-state>
                            ) : (
                                paginatedOffers.map((offer) => (
                                    <s-table-row key={offer.id}>
                                        <s-table-cell>
                                            <s-link href={`/app/sected-products/edit/${offer.numericId}`}>
                                                <s-text weight="bold">{offer.title}</s-text>
                                            </s-link>
                                        </s-table-cell>

                                        <s-table-cell>
                                            <s-badge tone="info">{offer.discountPercentage} OFF</s-badge>
                                        </s-table-cell>

                                        <s-table-cell>
                                            <s-text>
                                                {offer.targetCount > 0
                                                    ? `${offer.targetCount} main · ${offer.offeredCount} add-on${offer.offeredCount === 1 ? "" : "s"}`
                                                    : `${offer.productCount} selected`}
                                            </s-text>
                                        </s-table-cell>

                                        <s-table-cell>
                                            <s-badge
                                                tone={
                                                    offer.status === "ACTIVE"
                                                        ? "success"
                                                        : offer.status === "SCHEDULED"
                                                            ? "warning"
                                                            : "neutral"
                                                }
                                            >
                                                {offer.status}
                                            </s-badge>
                                        </s-table-cell>

                                        <s-table-cell>
                                            <s-tooltip id={`combo-prod-${offer.numericId}`}>
                                                {offer.combinesWith?.productDiscounts ? "Combines with product discounts" : "Can't combine with product discounts"}
                                            </s-tooltip>
                                            <s-tooltip id={`combo-order-${offer.numericId}`}>
                                                {offer.combinesWith?.orderDiscounts ? "Combines with order discounts" : "Can't combine with order discounts"}
                                            </s-tooltip>
                                            <s-tooltip id={`combo-ship-${offer.numericId}`}>
                                                {offer.combinesWith?.shippingDiscounts ? "Combines with shipping discounts" : "Can't combine with shipping discounts"}
                                            </s-tooltip>

                                            <s-stack direction="inline" gap="small-300">
                                                <s-icon
                                                    type="product-add"
                                                    color={offer.combinesWith?.productDiscounts ? "base" : "subdued"}
                                                    interestFor={`combo-prod-${offer.numericId}`}
                                                    style={{ opacity: offer.combinesWith?.productDiscounts ? 1 : 0.28 }}
                                                />

                                                <s-icon
                                                    type="order"
                                                    color={offer.combinesWith?.orderDiscounts ? "base" : "subdued"}
                                                    interestFor={`combo-order-${offer.numericId}`}
                                                    style={{ opacity: offer.combinesWith?.orderDiscounts ? 1 : 0.28 }}
                                                />

                                                <s-icon
                                                    type="delivery"
                                                    color={offer.combinesWith?.shippingDiscounts ? "base" : "subdued"}
                                                    interestFor={`combo-ship-${offer.numericId}`}
                                                    style={{ opacity: offer.combinesWith?.shippingDiscounts ? 1 : 0.28 }}
                                                />
                                            </s-stack>
                                        </s-table-cell>

                                        {/* Used count */}
                                        <s-table-cell>
                                            <s-text weight={offer.usageCount > 0 ? "bold" : "regular"}>
                                                {offer.usageCount || 0} times
                                            </s-text>
                                        </s-table-cell>

                                        <s-table-cell>
                                            <div style={{ height: "40px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
                                                <s-stack gap="small-400">
                                                    <s-chip>{offer.startDate}</s-chip>
                                                    {
                                                        offer.endDate && offer.endDate !== "No end date" && (
                                                            <s-chip>
                                                                {offer.endDate}
                                                            </s-chip>
                                                        )
                                                    }
                                                </s-stack>
                                            </div>
                                        </s-table-cell>

                                        <s-table-cell>
                                            <s-tooltip id={`edit-tip-${offer.numericId}`}>Edit offer</s-tooltip>
                                            <s-tooltip id={`delete-tip-${offer.numericId}`}>Delete offer</s-tooltip>

                                            <s-stack direction="inline" gap="small" alignItems="center">
                                                <s-button
                                                    variant="primary"
                                                    icon={editingId === String(offer.numericId) ? undefined : "edit"}
                                                    interestFor={`edit-tip-${offer.numericId}`}
                                                    accessibilityLabel="Edit offer"
                                                    onClick={() => handleEditOffer(offer.numericId)}
                                                    loading={editingId === String(offer.numericId) ? true : undefined}
                                                    disabled={(isSubmitting || isCreateLoading || isNavigatingEdit) ? true : undefined}
                                                />

                                                <s-button
                                                    variant="primary"
                                                    tone="critical"
                                                    commandFor={`delete-modal-${offer.numericId}`}
                                                    command="--show"
                                                    icon="delete"
                                                    interestFor={`delete-tip-${offer.numericId}`}
                                                    accessibilityLabel="Delete offer"
                                                    loading={deletingId === String(offer.numericId) ? true : undefined}
                                                    disabled={(isSubmitting || isCreateLoading || isNavigatingEdit) ? true : undefined}
                                                />

                                                <s-modal id={`delete-modal-${offer.numericId}`} heading="Delete offer?">
                                                    <s-stack gap="base">
                                                        <s-text>Are you sure you want to delete <b>&ldquo;{offer.title}&rdquo;</b>?</s-text>
                                                        <s-text tone="caution">This action cannot be undone.</s-text>
                                                    </s-stack>

                                                    <s-button
                                                        slot="primary-action"
                                                        variant="primary"
                                                        tone="critical"
                                                        commandFor={`delete-modal-${offer.numericId}`}
                                                        command="--hide"
                                                        onClick={() => handleDelete(offer.id, offer.numericId)}
                                                        loading={deletingId === String(offer.numericId) ? true : undefined}
                                                        disabled={(isSubmitting || isCreateLoading || isNavigatingEdit) ? true : undefined}
                                                    >
                                                        Delete offer
                                                    </s-button>
                                                    <s-button
                                                        slot="secondary-actions"
                                                        variant="secondary"
                                                        commandFor={`delete-modal-${offer.numericId}`}
                                                        command="--hide"
                                                        disabled={(isSubmitting || isCreateLoading || isNavigatingEdit) ? true : undefined}
                                                    >
                                                        Cancel
                                                    </s-button>
                                                </s-modal>
                                            </s-stack>
                                        </s-table-cell>
                                    </s-table-row>
                                ))
                            )}
                        </s-table-body>
                    </s-table>

                    {/* Pagination Controls */}
                    {totalFilteredOffers > 0 && (
                        <>
                            <s-divider />
                            <s-box paddingInline="base" paddingBlockEnd="small">
                                <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                                    <s-text tone="subdued" size="small">
                                        Showing {(safeCurrentPage - 1) * ITEMS_PER_PAGE + 1} – {Math.min(safeCurrentPage * ITEMS_PER_PAGE, totalFilteredOffers)} of {totalFilteredOffers} offers
                                    </s-text>
                                    <s-stack direction="inline" gap="small" alignItems="center">
                                        <s-button
                                            variant="secondary"
                                            icon="chevron-left"
                                            disabled={safeCurrentPage <= 1 ? true : undefined}
                                            onClick={safeCurrentPage > 1 ? () => handlePageChange(safeCurrentPage - 1) : undefined}
                                            accessibilityLabel="Previous page"
                                        />
                                        <s-text weight="medium" size="small">
                                            Page {safeCurrentPage} of {totalPages}
                                        </s-text>
                                        <s-button
                                            variant="secondary"
                                            icon="chevron-right"
                                            disabled={safeCurrentPage >= totalPages ? true : undefined}
                                            onClick={safeCurrentPage < totalPages ? () => handlePageChange(safeCurrentPage + 1) : undefined}
                                            accessibilityLabel="Next page"
                                        />
                                    </s-stack>
                                </s-stack>
                            </s-box>
                        </>
                    )}
                </s-section>
            </s-box>
        </s-page>
    );
}
