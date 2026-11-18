# StackUp Metafields Schema Dictionary & GraphiQL Testing Guide

This document defines the standardized, ultra-compact JSON schema for all **StackUp** discount and widget metafields. It includes copy-paste ready **Shopify GraphQL Queries** so developers, merchants, and QA can test, inspect, and verify every metafield using the **Shopify GraphiQL App**, Admin API Explorer, or Postman.

---

## 💡 Architecture & Key Principles

### The Problem
Previously, discount configurations were stored in monolithic shop-level metafields (`shop.metafields.stack_up.*`). Storing 3–4 multi-product promotions in a single field produced payloads exceeding **3,500+ bytes**, quickly breaching Shopify Functions' strict **10,000-byte (~10 KB)** input query limit and crashing checkout.

### The Solution: Product-Level Sharding
All product-specific promotional rules are saved directly on the participating Product's metafield (`product.metafields.stack_up.*`).
* **Ultra-Compact**: Each product carries only ~**200–280 bytes**.
* **Zero Bloat**: At checkout, Shopify Functions query *only* the metafields of items physically present in the customer's cart.
* **Unlimited Scale**: A store can maintain 10,000+ active promotions without approaching the 10 KB Function limit.
* **Storefront Speed**: Product page Liquid templates read `product.metafields.stack_up.*` in **0ms** without additional API calls.
* **Shop-Level Safety**: Shop-level fallback containers (`shop.metafields.stack_up.*_offers`) are intentionally kept at `{}` (2 bytes) to safeguard against legacy limit overflows.

---

## 🛠️ How to Test in the Shopify GraphiQL App

1. Open your store's **Shopify GraphiQL App** (or Admin API Explorer in the Partner Dashboard / Shopify Admin).
2. Ensure your app or token has `read_products` and `read_discounts` scopes.
3. Paste the provided **GraphQL Query** into the main editor window.
4. Paste the **Query Variables** (JSON) into the bottom *Variables* panel.
5. Click **Run** (Play button) to view the live JSON response.

> [!TIP]
> To quickly find a product's GID (`gid://shopify/Product/1234567890`), navigate to the product in Shopify Admin; the numeric ID is at the end of the URL (e.g. `admin.shopify.com/store/YOUR-STORE/products/8923482348` -> `gid://shopify/Product/8923482348`). Alternatively, query directly by the product's handle using the handle queries below.

---

## Quick Reference: Metafield Registry

| Promotion Type | Owner | Namespace | Key | Type | Size | Target Reader |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Volume Discounts** | Product | `stack_up` | `volume_tiers` | `json` | ~270 B | `volume-discount` function & `volume-discount.liquid` |
| **Selected Products / Add-ons** | Product | `stack_up` | `selected_offers` | `json` | ~280 B | `selected-products-discount` function & `selected-products.liquid` |
| **Paired Bundles** | Product | `stack_up` | `paired_bundle` | `json` | ~260 B | `paired-products-discount` function & `paired-products.liquid` |
| **BOGO & Buy X Get Y** | Product | `stack_up` | `bogo_offer` | `json` | ~220 B | `bogo-discount` function & `bogo-widget.liquid` |
| **Volume Widget Settings** | Shop | `stack_up` | `volume_widget_settings` | `json` | ~450 B | `volume-discount.liquid` & Admin Customize |
| **Selected Widget Settings** | Shop | `stack_up` | `selected_widget_settings` | `json` | ~450 B | `selected-products.liquid` & Admin Customize |
| **Paired Widget Settings** | Shop | `stack_up` | `paired_widget_settings` | `json` | ~450 B | `paired-products.liquid` & Admin Customize |
| **BOGO Widget Settings** | Shop | `stack_up` | `bogo_widget_settings` | `json` | ~450 B | `bogo-widget.liquid` & Admin Customize |
| **Global App Status** | Shop | `stack_up` | `stack_up_app_enabled` | `boolean` / `single_line_text_field` | ~5 B | All 4 functions & Theme App Embed |
| **Master Discount Node** | Discount | `$app:discount` | `function_configuration` | `json` | ~30 B | Shopify Functions (Node Filter) |

---

## 1. Volume Discount / Quantity Breaks (Function 1)

* **Metafield Target**: `product.metafields.stack_up.volume_tiers`
* **Type**: `json`
* **Average Size**: ~**270 bytes**
* **Read by**: `volume-discount` Shopify Function (`cart_lines_discounts_generate_run.js`) and `volume-discount.liquid`.

### Top-Level Object Keys

| Short Key | Full Property Name | Type | Purpose / Description |
| :--- | :--- | :--- | :--- |
| **`id`** | `numericId` / `offerId` | `String` | Maps back to the database offer record (`/app/offers/volume/edit/:id`). |
| **`t`** | `title` | `String` | Offer title shown on the checkout savings pill (e.g. `"BUNDLE"` or `"Buy More Save More"`). |
| **`wt`** | `widgetTitle` | `String` | Product page widget heading (e.g. `"Diwali Bumper Offer"`). Defaults to `"Buy more, Save more"` if omitted. |
| **`p`** | `percentage` | `Number` | Campaign maximum headline discount percentage for fast display (e.g. `20` for "Up to 20% OFF"). |
| **`tiers`** | `tiers` | `Array` | Array of quantity break level definitions. |

### Tier Object Keys (`tiers[]`)

| Short Key | Full Property Name | Type | Allowed Values | Purpose / Description |
| :--- | :--- | :--- | :--- | :--- |
| **`mq`** | `minQuantity` | `Number` | `1, 2, 3, ...` | Threshold quantity required in cart to qualify for this tier (`quantity >= mq`). |
| **`d`** | `discount` | `Number` | `0, 10, 20, ...` | Discount value (percentage or fixed dollar amount off). |
| **`t`** | `type` | `String` | `"P"`, `"F"`, `"N"` | `"P"` = Percentage off, `"F"` = Fixed amount off per item, `"N"` = No discount (base tier). |
| **`title`** | `title` | `String` | `"Buy 1"`, `"Buy 2"` | Title text displayed on the storefront tier card. |
| **`s`** | `subtitle` / `label` | `String` | `"Standard"`, `"Save 10%"` | Savings badge/pill displayed alongside the tier title. |
| **`b`** | `badge` | `String` | `"Most popular"` | Optional ribbon badge text. *(Omitted if empty to conserve bytes)*. |
| **`df`** | `isDefault` | `Boolean` | `true` | Indicates pre-selected tier on initial page load. *(Omitted if false)*. |

### Sample JSON Payload

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

### GraphiQL Testing Queries

#### 🔍 Query A: Read Volume Metafield by Product ID
```graphql
query GetProductVolumeTiers($productId: ID!) {
  product(id: $productId) {
    id
    title
    handle
    volumeTiers: metafield(namespace: "stack_up", key: "volume_tiers") {
      id
      namespace
      key
      type
      value
    }
  }
}
```
**Variables:**
```json
{
  "productId": "gid://shopify/Product/YOUR_PRODUCT_ID"
}
```

#### 🔍 Query B: Read Volume Metafield by Product Handle
```graphql
query GetVolumeTiersByHandle($handle: String!) {
  productByHandle(handle: $handle) {
    id
    title
    volumeTiers: metafield(namespace: "stack_up", key: "volume_tiers") {
      id
      value
    }
  }
}
```
**Variables:**
```json
{
  "handle": "selling-plans-ski-wax"
}
```

---

## 2. Selected Products / Add-ons / Frequently Bought Together (Function 2)

* **Metafield Target**: `product.metafields.stack_up.selected_offers` (Saved on each Target Product)
* **Type**: `json`
* **Average Size**: ~**280 bytes**
* **Read by**: `selected-products-discount` Shopify Function and `selected-products.liquid`.

### Top-Level Object Keys

| Short Key | Full Property Name | Type | Purpose / Description |
| :--- | :--- | :--- | :--- |
| **`id`** | `numericId` / `offerId` | `String` | Maps back to the database offer record (`/app/offers/selected/edit/:id`). |
| **`t`** | `title` | `String` | Offer title shown on the checkout savings pill (e.g. `"Frequently Bought Together"`). |
| **`wt`** | `widgetTitle` | `String` | Product page widget heading (e.g. `"Special Add-Ons Just for You"`). |
| **`d`** | `percentage` | `Number` | Discount percentage applied to companion add-on items at checkout (e.g. `15` for 15% OFF). |
| **`items`** | `offeredProducts` | `Array` | List of companion add-on products that qualify for the discount when this target item is in the cart. |

### Add-On Item Object Keys (`items[]`)

| Short Key | Full Property Name | Type | Purpose / Description |
| :--- | :--- | :--- | :--- |
| **`id`** | `numericId` | `String` | Numeric ID of the add-on product (used to match cart lines). |
| **`vid`** | `variantId` | `String` | Pre-selected default variant ID for add-to-cart operations. |
| **`vids`** | `variantIds` | `Array<String>` | *(Optional)* Whitelist of specific eligible variant IDs if restricted by merchant. |
| **`t`** | `title` | `String` | Add-on product title. |
| **`p`** | `price` | `Number` | Base price in cents (e.g. `2500` for \$25.00). |
| **`dp`** | `discountedPrice` | `Number` | Price in cents after discount is deducted (e.g. `2125` for \$21.25). |
| **`h`** | `handle` | `String` | Product handle for instant live stock and image lookups in Liquid (`all_products[item.h]`). |
| **`img`** | `image` | `String` | Fallback thumbnail image URL. |
| **`q`** | `quantity` | `Number` | Minimum add-on quantity required (default `1`). |
| **`df`** | `isDefault` | `Boolean` | `true` if pre-checked by default on storefront load. |

### Sample JSON Payload

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
      "img": "https://cdn.shopify.com/s/files/1/0000/0001/products/belt.jpg",
      "df": true
    }
  ]
}
```

### GraphiQL Testing Queries

#### 🔍 Query A: Read Selected Offers Metafield by Product ID
```graphql
query GetProductSelectedOffers($productId: ID!) {
  product(id: $productId) {
    id
    title
    handle
    selectedOffers: metafield(namespace: "stack_up", key: "selected_offers") {
      id
      namespace
      key
      type
      value
    }
  }
}
```
**Variables:**
```json
{
  "productId": "gid://shopify/Product/YOUR_PRODUCT_ID"
}
```

#### 🔍 Query B: Read Selected Offers Metafield by Product Handle
```graphql
query GetSelectedOffersByHandle($handle: String!) {
  productByHandle(handle: $handle) {
    id
    title
    selectedOffers: metafield(namespace: "stack_up", key: "selected_offers") {
      id
      value
    }
  }
}
```
**Variables:**
```json
{
  "handle": "leather-shoes"
}
```

---

## 3. Paired Products / Frequently Bought Together Bundles (Function 3)

* **Metafield Target**: `product.metafields.stack_up.paired_bundle` (Saved on each participating Main Product)
* **Type**: `json`
* **Average Size**: ~**260 bytes**
* **Read by**: `paired-products-discount` Shopify Function and `paired-products.liquid`.

### Top-Level Object Keys

| Short Key | Full Property Name | Type | Purpose / Description |
| :--- | :--- | :--- | :--- |
| **`id`** | `numericId` / `offerId` | `String` | Maps back to the database offer record (`/app/offers/paired/edit/:id`). |
| **`t`** | `title` | `String` | Offer title shown on the checkout savings pill (e.g. `"Frequently Bought Together"`). |
| **`wt`** | `widgetTitle` | `String` | Product page widget heading (e.g. `"Pair & Save 20%"`). |
| **`d`** | `percentage` | `Number` | Bundle discount percentage applied to all participating bundle lines (e.g. `20` for 20% OFF). |
| **`mq`** | `mainQuantity` | `Number` | Required minimum quantity of this main product in the cart (default `1`). |
| **`mvids`** | `mainVariantIds` | `Array<String>` | *(Optional)* Whitelist of specific eligible main product variant IDs. |
| **`subs`** | `subProducts` | `Array` | List of companion products that must be bundled with this item. |

### Sub-Product Object Keys (`subs[]`)

| Short Key | Full Property Name | Type | Purpose / Description |
| :--- | :--- | :--- | :--- |
| **`id`** | `numericId` | `String` | Numeric ID of the companion product (used to match cart lines). |
| **`q`** | `quantity` | `Number` | Required quantity of the companion product (default `1`). |
| **`vid`** | `variantId` | `String` | Default variant ID used when adding the bundle to the cart. |
| **`vids`** | `variantIds` | `Array<String>` | *(Optional)* Whitelist of specific eligible companion variant IDs. |
| **`t`** | `title` | `String` | Companion product title. |
| **`p`** | `price` | `Number` | Base price in cents (e.g. `6900` for \$69.00). |
| **`h`** | `handle` | `String` | Product handle for instant live stock, price, and variant lookups in Liquid. |
| **`img`** | `image` | `String` | Fallback thumbnail image URL. |

### Sample JSON Payload

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
      "img": "https://cdn.shopify.com/s/files/1/0000/0001/products/pants.jpg"
    }
  ]
}
```

### GraphiQL Testing Queries

#### 🔍 Query A: Read Paired Bundle Metafield by Product ID
```graphql
query GetProductPairedBundle($productId: ID!) {
  product(id: $productId) {
    id
    title
    handle
    pairedBundle: metafield(namespace: "stack_up", key: "paired_bundle") {
      id
      namespace
      key
      type
      value
    }
  }
}
```
**Variables:**
```json
{
  "productId": "gid://shopify/Product/YOUR_PRODUCT_ID"
}
```

#### 🔍 Query B: Read Paired Bundle Metafield by Product Handle
```graphql
query GetPairedBundleByHandle($handle: String!) {
  productByHandle(handle: $handle) {
    id
    title
    pairedBundle: metafield(namespace: "stack_up", key: "paired_bundle") {
      id
      value
    }
  }
}
```
**Variables:**
```json
{
  "handle": "linen-shirt"
}
```

---

## 4. Automatic BOGO & Buy X Get Y (Function 4)

* **Metafield Target**: `product.metafields.stack_up.bogo_offer` (Saved on each participating Customer Buy (X) Product)
* **Type**: `json`
* **Average Size**: ~**220 bytes**
* **Read by**: `bogo-discount` Shopify Function (`cart_lines_discounts_generate_run.js`) and `bogo-widget.liquid`.

### Top-Level Object Keys

| Short Key | Full Property Name | Type | Allowed Values | Purpose / Description |
| :--- | :--- | :--- | :--- | :--- |
| **`id`** | `numericId` / `offerId` | `String` | e.g. `"1794981123456"` | Maps back to database offer record (`/app/offers/bogo/edit/:id`). |
| **`t`** | `title` | `String` | e.g. `"BOGO 100% OFF"` | Internal campaign title shown in the checkout savings pill. |
| **`wt`** | `widgetTitle` | `String` | e.g. `"Buy 1 Get 1 Special"` | Storefront widget title displayed on the product page. |
| **`dealType`**| `dealType` | `String` | `"BOGO"`, `"BUY_X_GET_X"`, `"BUY_X_GET_Y"` | Promotional architecture type. |
| **`buyQty`** | `buyQuantity` | `Number` | `1, 2, 3, ...` | Number of Customer Buy (X) items required to qualify. |
| **`getQty`** | `getQuantity` | `Number` | `1, 2, 3, ...` | Number of Customer Get (Y) items awarded per qualifying set. |
| **`dType`** | `discountType` | `String` | `"P"`, `"F"` | `"P"` = Percentage discount, `"F"` = Fixed amount discount. |
| **`dVal`** | `discountValue` | `Number` | `0` to `100` (P) or currency (F) | Discount magnitude (`100` for 100% free, `15` for \$15 off). |
| **`maxD`** | `maxDiscount` | `Number` or `null` | Optional numeric cap (e.g. `25`) | Maximum total discount dollar cap applied across reward items. |
| **`getY`** | `rewardProduct` | `Object` or `null` | Detailed below | Reward product object for `BUY_X_GET_Y`; `null` for same-product offers. |

### Reward Product Object Keys (`getY`)

| Key | Type | Description |
| :--- | :--- | :--- |
| **`id`** | `String` | Canonical Shopify Product GID (e.g. `"gid://shopify/Product/8923482348"`). |
| **`title`** | `String` | Title of the reward product. |
| **`handle`** | `String` | Product handle for storefront linking. |
| **`image`** | `String` | Product image URL. |
| **`price`** | `Number` | Base price in dollars (e.g. `24.95`). |
| **`variants`**| `Array` | List of available reward variants: `[{ id: "...", title: "...", price: 24.95 }]`. |

### Sample Payloads for the 3 BOGO Deal Types

#### A. Standard BOGO (Buy 1 Get 1 Free - Same Product) (~165 bytes)
```json
{
  "id": "1794981123456",
  "t": "Buy 1 Get 1 Free",
  "wt": "Buy 1 Get 1 with 100% off",
  "dealType": "BOGO",
  "buyQty": 1,
  "getQty": 1,
  "dType": "P",
  "dVal": 100,
  "maxD": null,
  "getY": null
}
```

#### B. BUY_X_GET_X (Buy 2 Get 1 at $10 Fixed Amount Off - Same Product) (~185 bytes)
```json
{
  "id": "1794981123457",
  "t": "Buy 2 Get 1 ($10 OFF)",
  "wt": "Buy 2 Get 1 with $10 off",
  "dealType": "BUY_X_GET_X",
  "buyQty": 2,
  "getQty": 1,
  "dType": "F",
  "dVal": 10,
  "maxD": 20,
  "getY": null
}
```

#### C. BUY_X_GET_Y (Buy 1 Wax, Get 1 Brush 50% Off - Different Product) (~340 bytes)
```json
{
  "id": "1794981123458",
  "t": "Ski Wax + Free Brush Deal",
  "wt": "Buy 1 Get 1 Special Deal",
  "dealType": "BUY_X_GET_Y",
  "buyQty": 1,
  "getQty": 1,
  "dType": "P",
  "dVal": 50,
  "maxD": null,
  "getY": {
    "id": "gid://shopify/Product/9876543210",
    "title": "Waxing Finishing Brush",
    "handle": "waxing-finishing-brush",
    "image": "https://cdn.shopify.com/s/files/1/0000/0001/products/brush.jpg",
    "price": 19.95,
    "variants": [
      { "id": "45678901234", "title": "Nylon Bristles", "price": 19.95 },
      { "id": "45678901235", "title": "Horsehair Bristles", "price": 24.95 }
    ]
  }
}
```

### GraphiQL Testing Queries

#### 🔍 Query A: Read BOGO Metafield by Product ID
```graphql
query GetProductBogoOffer($productId: ID!) {
  product(id: $productId) {
    id
    title
    handle
    bogoOffer: metafield(namespace: "stack_up", key: "bogo_offer") {
      id
      namespace
      key
      type
      value
    }
  }
}
```
**Variables:**
```json
{
  "productId": "gid://shopify/Product/YOUR_PRODUCT_ID"
}
```

#### 🔍 Query B: Read BOGO Metafield by Product Handle
```graphql
query GetBogoOfferByHandle($handle: String!) {
  productByHandle(handle: $handle) {
    id
    title
    bogoOffer: metafield(namespace: "stack_up", key: "bogo_offer") {
      id
      value
    }
  }
}
```
**Variables:**
```json
{
  "handle": "sample-ski-wax"
}
```

> [!IMPORTANT]
> **Server-Side Security (Equal or Lesser Value Rule)**:
> In `bogo-discount/src/cart_lines_discounts_generate_run.js`, cart lines are sorted ascending by unit price (`cost / quantity`). Even if a customer tampers with browser DOM inputs or submits a $10 variant for Buy and a $50 variant for Get, the Shopify Function targets the cheapest ($10) line for discount calculation.

---

## 5. Shop-Level Customization & Appearance Settings

Each discount feature provides a merchant customization route (`/app/offers/*/customize`) saving visual theme settings directly to shop metafields.

* **Owner**: `Shop`
* **Namespace**: `stack_up`
* **Type**: `json`

| Key | Route | Description |
| :--- | :--- | :--- |
| **`volume_widget_settings`** | `/app/offers/volume/customize` | Colors, borders, badge ribbons, active tier highlight, button text, total savings banner. |
| **`selected_widget_settings`** | `/app/offers/selected/customize` | Colors, checkboxes, companion badges, total box, and Add to Cart button text. |
| **`paired_widget_settings`** | `/app/offers/paired/customize` | Card surface, plus separator, discount badge, sub-product label, and Add Both button text. |
| **`bogo_widget_settings`** | `/app/offers/bogo/customize` | Card surface, plus separator, reward badge, quantity tags, and Add Items to Cart button text. |

### Settings Object Structure (Standardized across all 4 widgets)

```json
{
  "content": {
    "heading": "{widgettitle}",
    "buttonText": "Add {total} items to Cart",
    "badgeText": "Add {get_qty} items for {discount}",
    "buyTagText": "Buy {buy_qty}/{buy_qty}",
    "getTagText": "Get {get_qty}/{get_qty}"
  },
  "styles": {
    "cardSurface": "#ffffff",
    "borderColor": "#e5e7eb",
    "borderWidth": 1,
    "borderRadius": 12,
    "badgeBg": "#ede9fe",
    "badgeTextColor": "#6366f1",
    "plusBg": "#ede9fe",
    "plusColor": "#6366f1",
    "buttonBg": "#1f2937",
    "buttonTextColor": "#ffffff",
    "buttonBorderRadius": 8
  },
  "display": {
    "showWidgetTitle": true,
    "showDivider": true,
    "showPlusIcon": true,
    "showBadge": true,
    "showSavings": true,
    "showAddToCart": true
  }
}
```

### GraphiQL Testing Query: Read All Shop Widget Settings

#### 🔍 Query: Read All 4 Widget Settings in a Single Request
```graphql
query GetAllWidgetSettings {
  shop {
    id
    name
    volumeSettings: metafield(namespace: "stack_up", key: "volume_widget_settings") {
      id
      value
    }
    selectedSettings: metafield(namespace: "stack_up", key: "selected_widget_settings") {
      id
      value
    }
    pairedSettings: metafield(namespace: "stack_up", key: "paired_widget_settings") {
      id
      value
    }
    bogoSettings: metafield(namespace: "stack_up", key: "bogo_widget_settings") {
      id
      value
    }
  }
}
```

---

## 6. Global App Controls & Master Discounts

### Global App Status Metafield
* **Metafield**: `shop.metafields.stack_up.stack_up_app_enabled`
* **Type**: `single_line_text_field` (or `boolean`)
* **Value**: `"true"` or `"false"`
* **Purpose**: Synchronized with the Theme App Embed toggle in `settings_data.json`. When disabled, all 4 Shopify Functions and all 4 storefront Liquid blocks immediately bypass execution.

#### 🔍 Query: Read App Embed Status
```graphql
query GetAppEmbedStatus {
  shop {
    id
    name
    appStatus: metafield(namespace: "stack_up", key: "stack_up_app_enabled") {
      id
      value
    }
  }
}
```

---

### Master Discounts Configuration
StackUp uses **Master Discounts** in Shopify Admin rather than generating a separate discount entry for every promotion:
1. `StackUp Volume Discounts (Do Not Delete)`
2. `StackUp Selected Products (Do Not Delete)`
3. `StackUp Paired Products (Do Not Delete)`
4. `StackUp BOGO & Buy X Get Y (Do Not Delete)`

Each Master Discount stores:
* **Namespace**: `$app:discount`
* **Key**: `function_configuration`
* **Value**: `{"isMaster": true}`

#### 🔍 Query: Inspect All Master Discounts in Shopify Admin
```graphql
query GetMasterDiscounts {
  discountNodes(first: 25, query: "title:StackUp") {
    nodes {
      id
      discount {
        __typename
        ... on DiscountAutomaticApp {
          title
          status
          combinesWith {
            orderDiscounts
            productDiscounts
            shippingDiscounts
          }
          appDiscountType {
            functionId
          }
          config: metafield(namespace: "$app:discount", key: "function_configuration") {
            value
          }
        }
      }
    }
  }
}
```

---

## 7. Standardized Key Reusability Guide

To ensure consistency across the entire codebase and prevent confusion for future developers and AI models, **the same short keys MUST be reused** across all discount functions:

| Key | Standard Meaning | Volume (F1) | Selected (F2) | Paired (F3) | BOGO (F4) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`id`** | Offer Database Numeric ID | Primary offer ID | Primary offer ID | Primary offer ID | Primary offer ID |
| **`t`** | Checkout Title | Campaign name | Campaign name | Campaign name | Campaign name |
| **`wt`** | Storefront Widget Title | Tier widget heading | Add-on widget heading | Bundle widget heading | BOGO widget heading |
| **`d`** | Discount Value | Per-tier discount | Companion discount | Bundle discount | - |
| **`dVal`** | Discount Value (BOGO) | - | - | - | Reward discount amount |
| **`dType`** | Discount Type (`"P"`, `"F"`) | Tier type (`t`) | Add-on type | Bundle type | Reward discount mode |
| **`df`** | Default Selection Flag | Selected tier card | Pre-checked add-on | Pre-selected variant | - |
| **`p`** | Price / Max Percentage | Headline rate (%) | Base price (cents) | Base price (cents) | Product price ($) |
| **`q`** | Quantity Required | - | Add-on quantity | Companion quantity | - |
| **`mq`** | Main / Min Quantity Required | Min quantity tier | - | Main product quantity | - |
| **`buyQty`**| Customer Buy Quantity | - | - | - | Required Buy items (X) |
| **`getQty`**| Customer Get Quantity | - | - | - | Awarded Get items (Y) |
| **`maxD`** | Max Discount Dollar Cap | - | - | - | Maximum total savings cap |
| **`dealType`**| BOGO Architecture | - | - | - | `BOGO`, `BUY_X_GET_X`, `BUY_X_GET_Y` |
| **`vid`** | Variant ID | - | Default variant ID | Default variant ID | - |
| **`vids`** | Variant IDs List | - | Specific variant IDs | Specific variant IDs | - |
| **`h`** | Handle | - | Product handle | Product handle | Product handle |
| **`img`** | Image URL | - | Image URL | Image URL | Image URL |

---

## 8. Summary Checklist for Developers & QA

1. **When testing in Shopify GraphiQL**:
   - Replace `YOUR_PRODUCT_ID` with a real product numeric GID (e.g. `gid://shopify/Product/8923482348`).
   - Or use the `productByHandle` queries with the product's URL handle (e.g. `selling-plans-ski-wax`).
2. **When modifying offer sync logic**:
   - Always update the product-level metafield in batches using `metafieldsSet` in server actions.
   - Never push large arrays into `shop.metafields.stack_up.*`.
   - Always clean up orphaned product metafields via `metafieldsDelete` when an offer is deactivated or deleted.
3. **When testing storefront Liquid**:
   - Liquid reads `product.metafields.stack_up.<key>.value`.
   - Ensure the theme app embed is enabled in the live theme (`config/settings_data.json`).
