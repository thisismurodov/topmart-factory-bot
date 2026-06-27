---
name: Container inventory weight (stored, not derived)
description: How exact kg per container is tracked now that inventory has a real weight_kg column.
---

The `inventory` table (warehouse/container finished-goods stock — bot-owned, NOT in
Drizzle schema, no CREATE TABLE anywhere in repo; it predates the SQLite→PG migration)
now has a real **`weight_kg NUMERIC NOT NULL DEFAULT 0`** column.

**Why stored, not derived:** exact per-container mass became business-critical (transfers,
manual receives, changing pack weights make the old `SUM(weight_kg)/SUM(quantity)` batch
ratio an approximation). Every stock mutation now carries weight directly.

**Mutation paths that maintain weight_kg:**
- Bot `create_batch`: adds the batch's actual `weight_kg` to inventory.
- Bot `record_movement` (manual IN/OUT/TRANSFER): IN derives from batch ratio for kg
  products (0 for dona); OUT/TRANSFER subtract **proportional** stored weight
  (`weight_kg * qty / quantity`, capped at current).
- API `/ombor/transfer`: moves proportional stored weight src→dest.
- API `/ombor/finished-in`: accepts optional `weightKg`; if omitted, derives from batch
  ratio for kg products. Dashboard ReceiveModal shows a kg input only for kg products.
- API `/ombor/adjust`: manual stock CORRECTION. Sets qty + weight to absolute values (not
  deltas). **kg products MUST send a weight (enforce server-side, not just UI) — else qty
  is "corrected" while weight goes stale, defeating the whole point.** dona forces weight 0.
  Adjust ≠ receive: 404 if the line isn't already in that container (no upsert).

**One-time backfill:** init_db backfills existing rows from the batch ratio
(`quantity * kg_per_unit`, kg products only), guarded by db_meta flag
`inventory_weight_backfilled` AND `to_regclass('public.inventory')` existence (local DBs
may not have the table — Drizzle doesn't own it). Backfill must stay idempotent/once-only,
or it would overwrite real post-transfer weights with derived values.

**Views (`/ombor/summary`, `/ombor/containers`, `/ombor/containers/:id/items`):** read
`i.weight_kg` directly. For a kg product show weight only when `weight_kg > 0`, else `null`
("—") and fall back to quantity for value — never a misleading "0 kg". The old
`weight_ratio` CTEs were removed from these queries.

**Not touched:** `/ombor/finished-goods (cross-warehouse aggregate)` never derived weight;
left as-is to avoid overlapping the separate "stock value correct everywhere" task.

**How to apply:** if exact per-container mass ever becomes business-critical (manual
adjustments, changing pack weights over time), THEN add `inventory.weight_kg` and update
all mutation paths. Until then, the batch-ratio derivation is the agreed approach.

## Current finished-goods stock = inventory table, NOT batches − sales

**Rule:** anywhere you need a product's *current warehouse stock* (the AI daily analysis,
dashboards, "omborda X" / "ishlab chiqarish kerak" alerts), read the `inventory` table —
`SUM(quantity) WHERE quantity > 0` across all warehouses. Do NOT derive it as
all-time produced (`batches`) minus all-time sold (`sales`).

**Why:** sales never decrement `inventory`, and stock also moves via transfers / manual OUT.
`batches − sales` therefore diverges badly: it reported many products with real container
stock (e.g. Qop ip ~9240, Reja ip ~3680) as `omborda 0`, generating false "produce now"
alerts. The bot (`get_stock_by_warehouse`) and Ombor dashboard both already use
`inventory` with a `quantity > 0` filter — the AI report must match the same source.

**The `quantity > 0` filter matters:** general warehouses can carry phantom *negative*
balances (e.g. Arqon −235 in "Namangan Markaziy Ombor" while container C-05 has +50).
Filtering to positive rows matches what the bot/dashboard show the user. For kg products
convert with the same batch ratio (`invQty × kg_per_unit`, fallback `invQty` when ratio 0).
