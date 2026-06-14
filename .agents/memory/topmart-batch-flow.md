---
name: TopMart batch creation & raw-material flow
description: Where batch creation and BOM raw-material deduction live, and why.
---

# Batch creation is bot-only

Batches are created **only via the Telegram bot**. The API server's
`artifacts/api-server/src/routes/batches.ts` has GET + DELETE but **no POST**.

**Why:** packers create production batches through the Telegram bot conversation
flow; the dashboard only views/deletes them.

**How to apply:** Any logic that must run when a batch is created (e.g. BOM
raw-material deduction, finished-goods inventory IN, low-stock checks) belongs in
the bot's DB layer (`artifacts/telegram-bot/bot/database.py`), NOT in the API. The
batch-session creator does all inserts + inventory + `raw_materials.current_stock`
deduction in a single `get_conn()` transaction. If a future feature adds API-side
batch creation, the deduction logic must be duplicated/shared there too.

BOM is stored in `product_materials` (product_name, raw_material_id,
quantity_required). Deduction only happens for products that have BOM rows.

# A batch SESSION = many `batches` rows sharing one `batch_code`

The bot's "Tovar kiritish" flow is multi-product: one session inserts N rows (one
per product) that all share a single `batch_code` (e.g. `AZ-260614-01`). There is
**no UNIQUE constraint on `batches.batch_code`** — init_db drops it idempotently
(only `public.batches` unique constraints whose columns include `batch_code`).

**Why:** approach chosen for lowest blast radius — per-row SUM aggregates
(quantity, weight, earnings) stay correct automatically; only *counts* change.

**How to apply:** Anything that counts batches as production *events* must use
`COUNT(DISTINCT batch_code)`, never `COUNT(*)` (which now counts line-items). This
applies to the bot KPIs and the API session-facing totals in `dashboard.ts` /
`reports.ts`. Product-level and item-level feeds intentionally keep per-row counts.
Code generation is serialized inside the txn via `pg_advisory_xact_lock`.
