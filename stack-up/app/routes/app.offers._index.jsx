import { useState, useEffect, useMemo } from "react";
import { useLoaderData, useSubmit, useActionData, useSearchParams, useNavigation, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopTimezone, formatDateInShopTimezone, computeOfferStatus } from "../utils/timezone";
import { syncAllActiveOffersToShopMetafield } from "../utils/bundleMetafields.server";
import { syncAllActiveSelectedOffersToShopMetafield } from "../utils/selectedOffersMetafields.server";
import { ensureMasterDiscounts, cleanupLegacyDiscounts } from "../utils/masterDiscount.server";

export const loader = async ({ request }) => {
    const t0 = performance.now();
    const { admin, session } = await authenticate.admin(request);
    const shopName = session.shop.replace(".myshopify.com", "");

    const [shopTimezone, dbOffers] = await Promise.all([
        getShopTimezone(admin, session.shop).catch(() => "UTC"),
        prisma.offer.findMany({
            where: {
                OR: [
                    { shop: session.shop },
                    { shop: shopName },
                    { shop: `${shopName}.myshopify.com` },
                ],
            },
            orderBy: { createdAt: "desc" },
        }).catch((e) => {
            console.warn("Could not fetch DB offers:", e);
            return [];
        }),
        ensureMasterDiscounts(admin).catch(() => { }),
        cleanupLegacyDiscounts(admin).catch(() => { }),
        syncAllActiveOffersToShopMetafield(admin).catch(() => { }),
        syncAllActiveSelectedOffersToShopMetafield(admin).catch(() => { }),
    ]);

    const formattedOffers = dbOffers.map((dbo) => {
        let mainCount = 0;
        let subCount = 0;
        try {
            if (dbo.type === "PAIRED") {
                mainCount = JSON.parse(dbo.mainProducts || "[]").length;
                subCount = JSON.parse(dbo.subProducts || "[]").length;
            } else {
                mainCount = JSON.parse(dbo.targetProducts || "[]").length;
                subCount = JSON.parse(dbo.offeredProducts || "[]").length;
            }
        } catch {
            mainCount = 0;
            subCount = 0;
        }

        const computedStatus = computeOfferStatus({
            startsAt: dbo.startsAt,
            endsAt: dbo.endsAt,
            status: dbo.status,
        });

        // Background sync if status changed
        if (computedStatus !== dbo.status && dbo.status !== "EXPIRED") {
            prisma.offer.update({
                where: { id: dbo.id },
                data: { status: computedStatus },
            }).catch(() => { });
        }

        const isPaired = dbo.type === "PAIRED";
        const typeLabel = isPaired ? "Frequently Bought" : "Product Add-ons";
        const typeBadgeTone = isPaired ? "info" : "caution";
        const productSummary = isPaired
            ? `${mainCount} Main + ${subCount} Sub`
            : `${mainCount} Target + ${subCount} Add-on`;

        return {
            id: dbo.discountId,
            numericId: dbo.numericId,
            title: dbo.title,
            widgetTitle: dbo.widgetTitle || "",
            type: dbo.type,
            typeLabel,
            typeBadgeTone,
            discountPercentage: `${dbo.percentage || 0}%`,
            productSummary,
            mainProductCount: mainCount,
            subProductCount: subCount,
            status: computedStatus,
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
    console.log(`⏱️ [AllOffers: Table] Loaded ${formattedOffers.length} offers in ${(tEnd - t0).toFixed(0)}ms`);
    return { shopName, offers: formattedOffers };
};

export const action = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");
    const id = formData.get("id");
    const numericId = formData.get("numericId");

    if (intent === "delete" && (id || numericId)) {
        console.log("-------------------> [Unified Offers: Delete] Deleting offer ID:", numericId || id);

        try {
            await prisma.offer.deleteMany({
                where: {
                    OR: [
                        id ? { discountId: id } : undefined,
                        numericId ? { numericId } : undefined,
                        id ? { id } : undefined,
                    ].filter(Boolean),
                },
            });

            // Resync both metafields immediately to Shopify to prevent any phantom discounts
            await Promise.all([
                syncAllActiveOffersToShopMetafield(admin),
                syncAllActiveSelectedOffersToShopMetafield(admin),
            ]);

            return { success: true };
        } catch (err) {
            console.error("-------------------> [Unified Offers: Delete] Error deleting offer:", err);
            return { error: "Failed to delete offer from database" };
        }
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

export default function AllOffersIndex() {
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

    const [editingId, setEditingId] = useState(null);
    const isNavigatingEdit = Boolean(editingId) || (navigation.state === "loading" && navigation.location?.pathname?.includes("/edit/"));

    const [isNavigatingCreate, setIsNavigatingCreate] = useState(false);
    const isCreateLoading = isNavigatingCreate || (navigation.state === "loading" && navigation.location?.pathname?.includes("/offers/new"));

    const handleCreateOffer = () => {
        try {
            shopify.loading(true);
        } catch { }
        setIsNavigatingCreate(true);
        navigate("/app/offers/new");
    };

    const handleEditOffer = (offer) => {
        setEditingId(String(offer.numericId));
        try {
            shopify.loading(true);
        } catch { }
        if (offer.type === "SELECTED") {
            navigate(`/app/offers/selected/edit/${offer.numericId}`);
        } else {
            navigate(`/app/offers/paired/edit/${offer.numericId}`);
        }
    };

    const handleDelete = (id, numericId) => {
        if (isSubmitting) return;
        try {
            shopify.loading(true);
        } catch { }
        const formData = new FormData();
        formData.append("intent", "delete");
        formData.append("id", id);
        formData.append("numericId", numericId);
        submit(formData, { method: "post" });
    };

    useEffect(() => {
        if (navigation.state === "idle") {
            setEditingId(null);
            setIsNavigatingCreate(false);
        }
    }, [navigation.state]);

    // Hide any hanging savebars from create/edit forms
    useEffect(() => {
        try {
            shopify.loading(false);
            shopify.saveBar?.hide("create-paired-offer-save-bar");
            shopify.saveBar?.hide("edit-paired-offer-save-bar");
            shopify.saveBar?.hide("create-selected-offer-save-bar");
            shopify.saveBar?.hide("edit-selected-offer-save-bar");
        } catch { }
    }, [shopify]);

    // Handle toast messages
    useEffect(() => {
        if (searchParams.get("created") === "true") {
            shopify.toast.show("Discount offer created successfully!");
            shopify.saveBar?.hide("create-paired-offer-save-bar");
            shopify.saveBar?.hide("edit-paired-offer-save-bar");
            shopify.saveBar?.hide("create-selected-offer-save-bar");
            shopify.saveBar?.hide("edit-selected-offer-save-bar");
            setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.delete("created");
                return next;
            }, { replace: true });
        }
        if (searchParams.get("updated") === "true") {
            shopify.toast.show("Discount offer updated successfully!");
            shopify.saveBar?.hide("create-paired-offer-save-bar");
            shopify.saveBar?.hide("edit-paired-offer-save-bar");
            shopify.saveBar?.hide("create-selected-offer-save-bar");
            shopify.saveBar?.hide("edit-selected-offer-save-bar");
            setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.delete("updated");
                return next;
            }, { replace: true });
        }
        if (searchParams.get("deleted") === "true" || actionData?.success) {
            shopify.toast.show("Discount offer deleted successfully!");
            shopify.saveBar?.hide("create-paired-offer-save-bar");
            shopify.saveBar?.hide("edit-paired-offer-save-bar");
            shopify.saveBar?.hide("create-selected-offer-save-bar");
            shopify.saveBar?.hide("edit-selected-offer-save-bar");
            setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.delete("deleted");
                return next;
            }, { replace: true });
        }
    }, [searchParams, actionData, shopify, setSearchParams]);

    // Read initial filters from URL params
    const initialQuery = searchParams.get("q") || "";
    const initialType = searchParams.get("type") || "ALL";
    const initialStatus = searchParams.get("status") || "ALL";
    const initialSort = searchParams.get("sort") || "newest";
    const initialPage = Math.max(1, parseInt(searchParams.get("page") || "1", 10));

    const [searchQuery, setSearchQuery] = useState(initialQuery);
    const [typeFilter, setTypeFilter] = useState(initialType);
    const [statusFilter, setStatusFilter] = useState(initialStatus);
    const [sortBy, setSortBy] = useState(initialSort);
    const [currentPage, setCurrentPage] = useState(initialPage);

    useEffect(() => {
        const q = searchParams.get("q") || "";
        const t = searchParams.get("type") || "ALL";
        const s = searchParams.get("status") || "ALL";
        const sort = searchParams.get("sort") || "newest";
        const p = Math.max(1, parseInt(searchParams.get("page") || "1", 10));

        if (q !== searchQuery) setSearchQuery(q);
        if (t !== typeFilter) setTypeFilter(t);
        if (s !== statusFilter) setStatusFilter(s);
        if (sort !== sortBy) setSortBy(sort);
        if (p !== currentPage) setCurrentPage(p);
    }, [searchParams]);

    const updateUrlParams = (newQuery, newType, newStatus, newSort, newPage) => {
        const params = new URLSearchParams(searchParams);
        if (newQuery) params.set("q", newQuery);
        else params.delete("q");

        if (newType && newType !== "ALL") params.set("type", newType);
        else params.delete("type");

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
        updateUrlParams(val, typeFilter, statusFilter, sortBy, 1);
    };

    const handleTypeChange = (val) => {
        setTypeFilter(val);
        setCurrentPage(1);
        updateUrlParams(searchQuery, val, statusFilter, sortBy, 1);
    };

    const handleStatusChange = (val) => {
        setStatusFilter(val);
        setCurrentPage(1);
        updateUrlParams(searchQuery, typeFilter, val, sortBy, 1);
    };

    const handleSortChange = (val) => {
        setSortBy(val);
        setCurrentPage(1);
        updateUrlParams(searchQuery, typeFilter, statusFilter, val, 1);
    };

    const handleClearAllFilters = () => {
        setSearchQuery("");
        setTypeFilter("ALL");
        setStatusFilter("ALL");
        setSortBy("newest");
        setCurrentPage(1);
        setSearchParams(new URLSearchParams(), { replace: true });
    };

    const isFilteredOrSorted = searchQuery !== "" || typeFilter !== "ALL" || statusFilter !== "ALL" || sortBy !== "newest";

    // Filtering & Sorting
    const sortedAndFilteredOffers = useMemo(() => {
        let result = offers.filter((offer) => {
            // Type filter
            if (typeFilter !== "ALL" && offer.type !== typeFilter) return false;

            // Status filter
            if (statusFilter !== "ALL" && offer.status !== statusFilter) return false;

            // Search query
            if (searchQuery.trim()) {
                const q = searchQuery.toLowerCase().trim();
                const matchTitle = offer.title?.toLowerCase().includes(q);
                const matchId = String(offer.numericId).includes(q);
                const matchType = offer.typeLabel?.toLowerCase().includes(q);
                if (!matchTitle && !matchId && !matchType) return false;
            }

            return true;
        });

        result.sort((a, b) => {
            switch (sortBy) {
                case "oldest":
                    return (Number(a.numericId) || 0) - (Number(b.numericId) || 0);
                case "title_asc":
                    return (a.title || "").localeCompare(b.title || "");
                case "title_desc":
                    return (b.title || "").localeCompare(a.title || "");
                case "used_desc":
                    return (b.usageCount || 0) - (a.usageCount || 0);
                case "newest":
                default:
                    return (Number(b.numericId) || 0) - (Number(a.numericId) || 0);
            }
        });

        return result;
    }, [offers, searchQuery, typeFilter, statusFilter, sortBy]);

    // Pagination calculations (10 offers per page)
    const ITEMS_PER_PAGE = 10;
    const totalFilteredOffers = sortedAndFilteredOffers.length;
    const totalPages = Math.max(1, Math.ceil(totalFilteredOffers / ITEMS_PER_PAGE));
    const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);

    const paginatedOffers = useMemo(() => {
        const start = (safeCurrentPage - 1) * ITEMS_PER_PAGE;
        return sortedAndFilteredOffers.slice(start, start + ITEMS_PER_PAGE);
    }, [sortedAndFilteredOffers, safeCurrentPage]);

    const activeCount = useMemo(() => offers.filter((o) => o.status === "ACTIVE").length, [offers]);
    const scheduledCount = useMemo(() => offers.filter((o) => o.status === "SCHEDULED").length, [offers]);
    const deactivatedCount = useMemo(() => offers.filter((o) => o.status === "EXPIRED").length, [offers]);

    const metricCards = useMemo(() => [
        {
            id: "total",
            label: "Total Offers",
            value: offers.length,
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
    ], [offers.length, activeCount, scheduledCount, deactivatedCount]);

    return (
        <s-page heading="All Discounts">
            <s-link slot="breadcrumb-actions" href="/app">
                Home
            </s-link>

            {/* Create Offer Button -> Navigates to dedicated /app/offers/new page */}
            <s-button
                slot="primary-action"
                variant="primary"
                onClick={handleCreateOffer}
                loading={isCreateLoading ? true : undefined}
                disabled={(isCreateLoading || isSubmitting || isNavigatingEdit) ? true : undefined}
            >
                Create offer
            </s-button>
            <s-button
                slot="secondary-actions"
                commandFor="customize-menu"
                icon="paint-brush-flat"
            >
                Customize Widgets
            </s-button>

            <s-menu
                id="customize-menu"
                accessibilityLabel="Customize widgets"
            >
                <s-button href="/app/offers/paired/customize">
                    Frequently Bought Widget
                </s-button>

                <s-button href="/app/offers/selected/customize">
                    Product Add-ons Widget
                </s-button>
            </s-menu>
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

            {/* Filter and Table Section (Matches original Polaris design) */}
            <s-box paddingBlockStart="large">
                <s-section padding="none">
                    <s-table>
                        {/* Filters Toolbar Slot */}
                        <s-grid
                            slot="filters"
                            gap="small-200"
                            gridTemplateColumns="@container (inline-size <= 760px) 1fr, 1fr 180px auto auto"
                            alignItems="center"
                            padding="small-400"
                        >
                            <s-search-field
                                label="Search offers"
                                labelAccessibilityVisibility="exclusive"
                                placeholder="Filter discounts by name or ID..."
                                value={searchQuery}
                                onInput={(e) => handleSearchChange(e.target.value)}
                            ></s-search-field>

                            <s-select
                                label="Discount Type"
                                labelAccessibilityVisibility="exclusive"
                                value={typeFilter}
                                onChange={(e) => handleTypeChange(e.target.value)}
                            >
                                <s-option value="ALL">All Discount Types</s-option>
                                <s-option value="PAIRED">Frequently Bought</s-option>
                                <s-option value="SELECTED">Product Add-ons</s-option>
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
                            <s-table-header>Type</s-table-header>
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
                                            : "Create your discount offers to incentivize customers to purchase in your store."}
                                    </s-text>
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
                                            loading={isCreateLoading ? true : undefined}
                                            disabled={(isSubmitting || isNavigatingEdit || isCreateLoading) ? true : undefined}
                                        >
                                            Create offer
                                        </s-button>
                                    )}
                                </s-empty-state>
                            ) : (
                                paginatedOffers.map((offer) => {
                                    const editUrl = offer.type === "SELECTED"
                                        ? `/app/offers/selected/edit/${offer.numericId}`
                                        : `/app/offers/paired/edit/${offer.numericId}`;

                                    return (
                                        <s-table-row key={offer.id}>
                                            {/* Offer Name */}
                                            <s-table-cell>
                                                <s-link href={editUrl}>
                                                    <s-text weight="bold">{offer.title}</s-text>
                                                </s-link>
                                            </s-table-cell>

                                            {/* Type */}
                                            <s-table-cell>
                                                <s-badge tone={offer.typeBadgeTone}>
                                                    {offer.typeLabel}
                                                </s-badge>
                                            </s-table-cell>

                                            {/* Discount */}
                                            <s-table-cell>
                                                <s-badge tone="info">{offer.discountPercentage} OFF</s-badge>
                                            </s-table-cell>

                                            {/* Products Summary */}
                                            <s-table-cell>
                                                <s-text>{offer.productSummary}</s-text>
                                            </s-table-cell>

                                            {/* Status */}
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

                                            {/* Combinations */}
                                            <s-table-cell>
                                                <s-tooltip id={`combo-tip-${offer.numericId}`}>
                                                    Combinations are managed store-wide in App Settings
                                                </s-tooltip>
                                                <s-link href="/app/settings">
                                                    <s-badge tone="info" interestFor={`combo-tip-${offer.numericId}`}>
                                                        Store-wide
                                                    </s-badge>
                                                </s-link>
                                            </s-table-cell>

                                            {/* Used count */}
                                            <s-table-cell>
                                                <s-text weight={offer.usageCount > 0 ? "bold" : "regular"}>
                                                    {offer.usageCount || 0}
                                                </s-text>
                                            </s-table-cell>

                                            {/* Schedule */}
                                            <s-table-cell>
                                                <div style={{ height: "40px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
                                                    <s-stack gap="small-400">
                                                        <s-chip>{offer.startDate}</s-chip>
                                                        {offer.endDate && offer.endDate !== "No end date" && (
                                                            <s-chip>{offer.endDate}</s-chip>
                                                        )}
                                                    </s-stack>
                                                </div>
                                            </s-table-cell>

                                            {/* Actions: Edit & Delete */}
                                            <s-table-cell>
                                                <s-tooltip id={`edit-tip-${offer.numericId}`}>Edit offer</s-tooltip>
                                                <s-tooltip id={`delete-tip-${offer.numericId}`}>Delete offer</s-tooltip>

                                                <s-stack direction="inline" gap="small" alignItems="center">
                                                    {/* Edit Button (Pencil Icon) */}
                                                    <s-button
                                                        variant="primary"
                                                        icon={editingId === String(offer.numericId) ? undefined : "edit"}
                                                        interestFor={`edit-tip-${offer.numericId}`}
                                                        accessibilityLabel="Edit offer"
                                                        onClick={() => handleEditOffer(offer)}
                                                        loading={editingId === String(offer.numericId) ? true : undefined}
                                                        disabled={(isSubmitting || isNavigatingEdit || isCreateLoading) ? true : undefined}
                                                    />

                                                    {/* Delete Button (Trash Icon) */}
                                                    <s-button
                                                        variant="primary"
                                                        tone="critical"
                                                        icon={deletingId === String(offer.numericId) ? undefined : "delete"}
                                                        interestFor={`delete-tip-${offer.numericId}`}
                                                        accessibilityLabel="Delete offer"
                                                        commandFor={`delete-modal-${offer.numericId}`}
                                                        command="--show"
                                                        loading={deletingId === String(offer.numericId) ? true : undefined}
                                                        disabled={(isSubmitting || isNavigatingEdit || isCreateLoading) ? true : undefined}
                                                    />

                                                    {/* Delete Confirmation Modal */}
                                                    <s-modal id={`delete-modal-${offer.numericId}`} heading="Delete offer?">
                                                        <s-stack gap="base">
                                                            <s-text>
                                                                Are you sure you want to delete <b>&ldquo;{offer.title}&rdquo;</b>?
                                                            </s-text>
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
                                                            disabled={(isSubmitting || isCreateLoading) ? true : undefined}
                                                        >
                                                            Delete offer
                                                        </s-button>
                                                        <s-button
                                                            slot="secondary-actions"
                                                            variant="secondary"
                                                            commandFor={`delete-modal-${offer.numericId}`}
                                                            command="--hide"
                                                            disabled={(isSubmitting || isCreateLoading) ? true : undefined}
                                                        >
                                                            Cancel
                                                        </s-button>
                                                    </s-modal>
                                                </s-stack>
                                            </s-table-cell>
                                        </s-table-row>
                                    );
                                })
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
                                            onClick={safeCurrentPage > 1 ? () => setCurrentPage(safeCurrentPage - 1) : undefined}
                                            accessibilityLabel="Previous page"
                                        />
                                        <s-text weight="medium" size="small">
                                            Page {safeCurrentPage} of {totalPages}
                                        </s-text>
                                        <s-button
                                            variant="secondary"
                                            icon="chevron-right"
                                            disabled={safeCurrentPage >= totalPages ? true : undefined}
                                            onClick={safeCurrentPage < totalPages ? () => setCurrentPage(safeCurrentPage + 1) : undefined}
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
