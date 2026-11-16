# StackUp Metafields Schema Dictionary

This document defines the standardized, ultra-compact JSON schema for all **StackUp** discount metafields.

---

## 💡 Architecture & Purpose

### The Problem
Previously, all discount configurations were stored in a single shop-level metafield (`shop.metafields.stack_up.*`). With 3–4 offers, the payload grew beyond **3,300+ bytes**, quickly breaching Shopify Functions' hard **10,000-byte (~10 KB)** input query limit and crashing checkout.

### The Solution: Product-Level Sharding
Discounts are saved directly on the participating Product's metafield (`product.metafields.stack_up.*`).
* **Ultra-Compact**: Each product carries only ~**270 bytes**.
* **Zero Bloat**: At checkout, Shopify Functions only query the products currently present in the cart.
* **Unlimited Scale**: Merchants can create 100+ offers without ever approaching the 10 KB limit.
* **Standardized Keys**: Short keys are reused consistently across all 3 discount functions.

---

## 1. Volume Discount / Quantity Breaks (Function 1)

* **Metafield Target**: `product.metafields.stack_up.volume_tiers`
* **Type**: `json`
* **Average Size**: ~**270 bytes**

### Top-Level Object Keys

| Short Key | Full Property Name | Type | Purpose / Use Case | Why We Use It |
| :--- | :--- | :--- | :--- | :--- |
| **`id`** | `numericId` / `offerId` | `String` | **Offer Tracking & DB Reference** | Maps the product metafield directly back to the database offer (`/app/offers/volume/edit/:id`). Replaces the long `gid://shopify/VolumeOffer/...` URL to save ~60 bytes while preserving 100% traceability. |
| **`t`** | `title` | `String` | **Checkout Discount Pill** | Read by `cart_lines_discounts_generate_run.js` to display the discount label at checkout (e.g., `"BUNDLE"` or `"Buy More Save More"`). |
| **`wt`** | `widgetTitle` | `String` | **Storefront Widget Heading** | Read by `volume-discount.liquid` on the product page (e.g., `"Diwali Bumper Offer"`). Defaults to `"Buy more, Save more"` if omitted. |
| **`p`** | `percentage` | `Number` | **Headline Maximum Rate** | Stores the campaign's maximum headline discount (e.g., `20` for "Up to 20% OFF") for quick reference. |
| **`tiers`** | `tiers` | `Array` | **Tier Definitions** | Contains the list of quantity break levels. |

---

### Tier Object Keys (`tiers[]`)

| Short Key | Full Property Name | Type | Allowed Values | Purpose / Use Case | Why We Use It |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`mq`** | `minQuantity` | `Number` | `1, 2, 3, ...` | **Threshold Condition** | Read by Checkout Function to qualify line items when `cart_quantity >= mq`. |
| **`d`** | `discount` | `Number` | `0, 10, 20, ...` | **Discount Value** | The exact discount amount (percentage or fixed amount off). |
| **`t`** | `type` | `String` | `"P"`, `"F"`, `"N"` | **Discount Mode** | `"P"` = Percentage off (default)<br>`"F"` = Fixed dollar off per item<br>`"N"` = No discount (base tier) |
| **`title`** | `title` | `String` | `"Buy 1"`, `"Buy 2"`, ... | **Option Title** | Displayed in bold on the storefront tier card. |
| **`s`** | `subtitle` / `label` | `String` | `"Standard"`, `"Save 10%"` | **Savings Pill** | Pill tag displayed next to the option title on the storefront. |
| **`b`** | `badge` | `String` | `"Most popular"`, ... | **Highlight Ribbon** | Optional red corner ribbon on storefront. *(Omitted entirely if blank to save bytes)*. |
| **`df`** | `isDefault` | `Boolean` | `true` | **Pre-selected Card** | Indicates which tier is pre-selected on page load. *(Only included when `true`; omitted on other tiers)*. |

---

### Example Volume Metafield Payload (~270 bytes)

```json
{
  "id": "1794807750096",
  "t": "BUNDLE",
  "wt": "Diwali Bumper Offer",
  "p": 20,
  "tiers": [
    { "mq": 1, "d": 0, "t": "N", "title": "Buy 1", "s": "Standard", "df": true },
    { "mq": 2, "d": 10, "t": "P", "title": "Buy 2", "s": "Save 10%", "b": "Most popular" },
    { "mq": 3, "d": 20, "t": "P", "title": "Buy 3+", "s": "Save 20%" }
  ]
}
```

---

## 2. Shared Key Reusability Guide (Functions 2 & 3)

To ensure consistency across the entire app and prevent confusion for future AI models and developers, **the same short keys MUST be reused** for:
* **Function 2**: Selected Add-ons / Frequently Bought Together
* **Function 3**: Paired Bundles (Buy X, Get Y)

### Standard Global Dictionary

| Key | Standard Meaning | Volume (F1) | Selected (F2) | Paired (F3) |
| :--- | :--- | :--- | :--- | :--- |
| **`id`** | Offer Database Numeric ID | Primary offer ID | Primary offer ID | Primary offer ID |
| **`t`** | Checkout Title | Campaign name | Campaign name | Campaign name |
| **`wt`** | Storefront Widget Title | Tier widget heading | Add-on widget heading | Bundle widget heading |
| **`d`** | Discount Value | Per-tier discount | Bundle discount | Bundle discount |
| **`t`** | Discount Type (`"P"`, `"F"`, `"N"`) | Per-tier type | Add-on discount type | Bundle discount type |
| **`df`** | Default Selection Flag | Selected tier card | Pre-checked add-on checkbox | Pre-selected variant |
| **`p`** | Max Percentage Rate | Headline metadata | Headline metadata | Headline metadata |

