---
name: Container inventory weight derivation
description: Why/how kg is shown for kg-sold products in the Ombor container view despite inventory tracking only quantity.
---

The `inventory` table (warehouse/container finished-goods stock, owned by the bot,
not Drizzle) stores **quantity only** — there is no weight column.

**Key constraint:** sales do NOT decrement `inventory`. Container stock only moves via
batch IN (bot `create_batch`), transfers, and manual OUT/finished-in. So for the normal
batch→container flow, `inventory.quantity` == total produced quantity.

**Rule:** To show kg for kg-sold products (e.g. "Ikki Qavat Arqon") in the Ombor
container detail, derive it instead of adding a weight column:
`kg_per_unit = SUM(weight_kg)/SUM(quantity)` over `batches` per product, then
`weightKg = inventory.quantity * kg_per_unit`. Only do this for `products.unit_type='kg'`
AND `kg_per_unit > 0` (some kg SKUs are entered with `quantity` already in kg and
`weight_kg=0` — for those show "—", never a misleading "0 kg").

**Why derive, not add a column:** a real `inventory.weight_kg` would require propagating
weight through every mutation path (bot create_batch, API transfer/finished-in, manual OUT)
plus a schema migration on the shared Railway DB. Derivation is exact for the common
no-transfer case and a reasonable proportional split otherwise.

**How to apply:** if exact per-container mass ever becomes business-critical (manual
adjustments, changing pack weights over time), THEN add `inventory.weight_kg` and update
all mutation paths. Until then, the batch-ratio derivation is the agreed approach.
