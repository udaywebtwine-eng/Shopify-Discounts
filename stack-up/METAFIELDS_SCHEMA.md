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

## 2. Selected Products / Frequently Bought Together (Function 2)

* **Metafield Target**: `product.metafields.stack_up.selected_offers` (Saved on each Target Product)
* **Type**: `json`
* **Average Size**: ~**280 bytes**

### Top-Level Object Keys

| Short Key | Full Property Name | Type | Purpose / Use Case | Why We Use It |
| :--- | :--- | :--- | :--- | :--- |
| **`id`** | `numericId` / `offerId` | `String` | **Offer Tracking & DB Reference** | Maps back to database offer (`/app/offers/selected/edit/:id`). |
| **`t`** | `title` | `String` | **Checkout Discount Pill** | Read by `cart_lines_discounts_generate_run.js` to display the discount message at checkout (e.g., `"Frequently Bought Together"`). |
| **`wt`** | `widgetTitle` | `String` | **Storefront Widget Heading** | Read by `selected-products.liquid` on the product page (e.g., `"Special Add-Ons Just for You"`). |
| **`d`** | `percentage` | `Number` | **Discount Percentage** | The percentage discount applied to companion add-on items at checkout (e.g., `15` for 15% OFF). |
| **`items`** | `offeredProducts` | `Array` | **Add-On Products List** | List of companion add-on items that qualify for the discount when this target product is in cart. |

---

### Add-On Item Object Keys (`items[]`)

| Short Key | Full Property Name | Type | Purpose / Use Case | Why We Use It |
| :--- | :--- | :--- | :--- | :--- |
| **`id`** | `numericId` / `id` | `String` | **Product Numeric ID** | Matches the add-on product in cart lines. |
| **`vid`** | `variantId` | `String` | **Default Variant ID** | Pre-selected variant ID used when adding to cart. |
| **`vids`** | `variantIds` | `Array<String>` | **Specific Variant IDs** | *(Optional)* If merchant restricted the offer to specific variants, checkout function checks this list. |
| **`t`** | `title` | `String` | **Add-On Title** | Displayed in storefront add-on list. |
| **`p`** | `price` | `Number` | **Original Price (cents)** | Base price in cents (e.g. `2500` for \$25.00). |
| **`dp`** | `discountedPrice` | `Number` | **Discounted Price (cents)** | Price after discount (e.g. `2125` for \$21.25). |
| **`h`** | `handle` | `String` | **Product Handle** | Used by `all_products[item.h]` in Liquid to query live stock, prices, and images in 0ms. |
| **`img`** | `image` | `String` | **Image URL** | Thumbnail image URL for the add-on item. |
| **`q`** | `quantity` | `Number` | **Required Quantity** | Minimum quantity of the add-on required (default `1`). |
| **`df`** | `isDefault` | `Boolean` | **Pre-checked State** | `true` if the checkbox is checked by default on page load. |

---

### Example Selected Offer Payload (~280 bytes)

```json
{
  "id": "1794807750096",
  "t": "Frequently Bought Together",
  "wt": "Special Add-Ons Just for You",
  "d": 15,
  "items": [
    {
      "id": "8923482348",
      "vid": "48923482348",
      "t": "Leather Belt",
      "p": 2500,
      "dp": 2125,
      "h": "leather-belt",
      "img": "https://cdn.shopify.com/.../belt.jpg",
      "df": true
    }
  ]
}
```

---

## 3. Paired Products / Frequently Bought Together Bundles (Function 3)

* **Metafield Target**: `product.metafields.stack_up.paired_bundle` (Saved on each participating Main Product)
* **Type**: `json`
* **Average Size**: ~**260 bytes**

### Top-Level Object Keys

| Short Key | Full Property Name | Type | Purpose / Use Case | Why We Use It |
| :--- | :--- | :--- | :--- | :--- |
| **`id`** | `numericId` / `offerId` | `String` | **Offer Tracking & DB Reference** | Maps back to database offer (`/app/offers/paired/edit/:id`). |
| **`t`** | `title` | `String` | **Checkout Discount Pill** | Read by `cart_lines_discounts_generate_run.js` to display the discount label at checkout (e.g., `"Frequently Bought Together"`). |
| **`wt`** | `widgetTitle` | `String` | **Storefront Widget Heading** | Read by `paired-products.liquid` on the product page (e.g., `"Pair & Save 20%"`). |
| **`d`** | `percentage` | `Number` | **Discount Percentage** | The bundle discount percentage applied to participating bundle lines (e.g., `20` for 20% OFF). |
| **`mq`** | `mainQuantity` | `Number` | **Main Product Minimum Quantity** | Minimum quantity of the main product required in the cart (default `1`). |
| **`mvids`** | `mainVariantIds` | `Array<String>` | **Specific Main Variant IDs** | *(Optional)* If merchant restricted the main product to specific variants, checkout function checks this list. |
| **`subs`** | `subProducts` | `Array` | **Sub / Companion Products List** | List of companion items that must be paired with this main product to form the bundle. |

---

### Sub-Product Object Keys (`subs[]`)

| Short Key | Full Property Name | Type | Purpose / Use Case | Why We Use It |
| :--- | :--- | :--- | :--- | :--- |
| **`id`** | `numericId` / `id` | `String` | **Sub Product Numeric ID** | Matches the companion product in the cart lines. |
| **`q`** | `quantity` | `Number` | **Required Sub Quantity** | Minimum quantity of the companion product required (default `1`). |
| **`vid`** | `variantId` | `String` | **Default Variant ID** | First or pre-selected variant ID used when adding the bundle to cart. |
| **`vids`** | `variantIds` | `Array<String>` | **Specific Variant IDs** | *(Optional)* If merchant restricted the companion product to specific variants, checkout function checks this list. |
| **`t`** | `title` | `String` | **Sub Product Title** | Displayed in storefront bundle items list. |
| **`p`** | `price` | `Number` | **Original Price (cents)** | Base price of the companion item in cents (e.g. `6900` for $69.00). |
| **`h`** | `handle` | `String` | **Product Handle** | Used by `all_products[sub.h]` in Liquid to query live stock, prices, and images in 0ms. |
| **`img`** | `image` | `String` | **Image URL** | Thumbnail image URL for the companion item. |

---

### Example Paired Bundle Payload (~260 bytes)

```json
{
  "id": "1794807750096",
  "t": "Frequently Bought Together",
  "wt": "Pair & Save 20%",
  "d": 20,
  "mq": 1,
  "subs": [
    {
      "id": "8923482348",
      "q": 1,
      "vid": "48923482348",
      "t": "Matching Linen Pants",
      "p": 6900,
      "h": "matching-linen-pants",
      "img": "https://cdn.shopify.com/.../pants.jpg"
    }
  ]
}
```

---

## 4. Shared Key Reusability Guide (Functions 1, 2 & 3)

To ensure consistency across the entire app and prevent confusion for future AI models and developers, **the same short keys MUST be reused** across all discount functions:
* **Function 1**: Volume Discounts / Quantity Breaks
* **Function 2**: Selected Add-ons / Frequently Bought Together
* **Function 3**: Paired Bundles (Buy X, Get Y)

### Standard Global Dictionary

| Key | Standard Meaning | Volume (F1) | Selected (F2) | Paired (F3) |
| :--- | :--- | :--- | :--- | :--- |
| **`id`** | Offer Database Numeric ID | Primary offer ID | Primary offer ID | Primary offer ID |
| **`t`** | Checkout Title | Campaign name | Campaign name | Campaign name |
| **`wt`** | Storefront Widget Title | Tier widget heading | Add-on widget heading | Bundle widget heading |
| **`d`** | Discount Value | Per-tier discount | Companion discount | Bundle discount |
| **`t`** | Discount Type (`"P"`, `"F"`, `"N"`) | Per-tier type | Add-on discount type | Bundle discount type |
| **`df`** | Default Selection Flag | Selected tier card | Pre-checked add-on checkbox | Pre-selected variant |
| **`p`** | Price / Max Percentage Rate | Headline percentage | Base price (cents) | Base price (cents) |
| **`q`** | Quantity Required | - | Add-on quantity | Companion quantity |
| **`mq`** | Main / Min Quantity Required | Min quantity tier | - | Main product quantity |
| **`vid`** | Variant ID | - | Default variant ID | Default variant ID |
| **`vids`** | Variant IDs List | - | Specific variant IDs | Specific variant IDs |
| **`h`** | Handle | - | Product handle | Product handle |
| **`img`** | Image URL | - | Image URL | Image URL |

---

## 5. Shop-Level Widget Customization Settings

Each widget has a dedicated customization route in the admin app (`/app/offers/*/customize`) where merchants can configure colors, fonts, borders, badge ribbons, and button text without editing theme code.

| Function | Metafield Key | Route | Description |
| :--- | :--- | :--- | :--- |
| **Volume Discounts / Quantity Breaks** | `shop.metafields.stack_up.volume_widget_settings` | `/app/offers/volume/customize` | Configures card background, borders, badge ribbon colors, active tier highlight, button text, and total savings banner. |
| **Selected Add-ons** | `shop.metafields.stack_up.selected_widget_settings` | `/app/offers/selected/customize` | Configures add-on list appearance, checkboxes, companion badges, total box, and Add to Cart button. |
| **Paired Bundles** | `shop.metafields.stack_up.paired_widget_settings` | `/app/offers/paired/customize` | Configures bundle box, plus separator icon, discount badge, sub-product label, and Add Both button. |



