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
`artifacts/telegram-bot/bot/database.py::create_batch()`, NOT in the API. That
function does the batch insert + inventory + `raw_materials.current_stock`
deduction in a single `get_conn()` transaction. If a future feature adds API-side
batch creation, the deduction logic must be duplicated/shared there too.

BOM is stored in `product_materials` (product_name, raw_material_id,
quantity_required). Deduction only happens for products that have BOM rows.
