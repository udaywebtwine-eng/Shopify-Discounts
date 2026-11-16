# Shopify app development

This app is scaffolded from a Shopify app template. See the README for framework-specific details.

## Metafields Architecture & Schema
Always consult `METAFIELDS_SCHEMA.md` before reading, writing, or updating discount metafields. All discounts use product-level sharded metafields with standardized compact keys to stay well below Shopify Functions' 10 KB input query limit.

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for all Shopify API and platform work. If missing, install it in the agent host per that page (or `npx skills add Shopify/shopify-ai-toolkit --list` for skill-compatible hosts) — do not add tooling to this repo.
