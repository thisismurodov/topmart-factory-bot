---
name: Two product catalogs (ERP vs savdo bot)
description: How public.products and distribution.mahsulotlar relate, and the SKU bridge that links them
---

- `public.products` (ERP/zavod) and `distribution.mahsulotlar` (savdo bot) are intentionally separate catalogs.
- **SKU bridge (unified catalog):** `mahsulotlar.sku` links a bot product to exactly one ERP product via `products.sku`.
  - `products.sku` non-blank values are UNIQUE via partial index `idx_products_sku_unique ... WHERE sku <> ''` — defined in BOTH api-server init-db.ts and Drizzle schema (drift-checked).
  - Existing ERP SKUs are **mixed case** (`shrk35`, `SHKR28`) — never uppercase an SKU before matching; compare exact strings. Only newly auto-generated SKUs are uppercased.
  - Product creation is dashboard-only; both Telegram bots' add-product flows are disabled with redirect messages.
  - ERP PATCH propagates name + price (UZS only, per-unit) to linked mahsulotlar by sku; `mahsulotlar.narx` is bigint UZS.
  - Name-conflict upsert on products must PRESERVE the existing non-blank sku (`CASE WHEN products.sku <> '' THEN products.sku ELSE EXCLUDED.sku END`) or bot links silently break.
- When matching by name (auto-link, sync-to-erp), normalize apostrophe variants (`' ’ ʼ \` ´`) and whitespace; link only when the match is unique on both sides.
- **Why:** one physical product must have one identity across factory + distribution; SKU is that identity, names drift.
