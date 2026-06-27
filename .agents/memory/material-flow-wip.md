---
name: Material Flow (Ish jarayoni) two-step WIP
description: How the warehouse material-flow / WIP module models and computes work-in-progress, and the invariants its endpoints must keep.
---

# Two-step WIP model (Ish jarayoni)

raw container → department (production_line) WIP → finished container.

- **Department WIP = SUM(RECEIVE) − SUM(PRODUCE)** over the `wip_movements` ledger ONLY. Do not derive WIP from inventory or raw_materials.current_stock.
- **Raw-stock single entry point (avoid double-count):** `POST /ombor/flow/receive` and the bot PRODUCE hook must NOT touch `raw_materials.current_stock` (raw still in factory as WIP; global stock only drops via BOM at batch creation). But raw INTAKE has ONE entry point — `POST /ombor/flow/raw-in` — which increments BOTH container `inventory` (product_type='raw') AND `raw_materials.current_stock` (matched by LOWER(name)) so the per-container view and global stock stay consistent.

**Why:** two independent raw ledgers guarantee drift. Keeping intake in one place (raw-in) and consumption in one place (BOM) prevents both double-counting and divergence. raw-in REJECTS (400) any material name that has no matching raw_materials row, so container stock can never exist without a global counterpart.
- RECEIVE (+kg) inserted by the API when raw is handed from a container to a department (`POST /ombor/flow/receive`).
- PRODUCE (−kg) has **TWO entry points**: (1) the **Python bot** `create_batch_session` when a batch is created, and (2) the dashboard `POST /ombor/flow/produce` (manual "Tayyor chiqarish" in Ish jarayoni). Both insert a PRODUCE `wip_movements` row, upsert finished `inventory` (product_type='finished'), and log a finished `stock_movement` IN. produce_kg = supplied kg if >0 else quantity × product.weight (same formula in both).

**Why / caution:** there is NO idempotency link between the two produce paths — recording the same physical output via both the bot batch flow AND the dashboard produce modal double-books finished stock + WIP PRODUCE. This is operational (not a transactional bug); pick one source of truth per output. If a guard is ever needed, add a source_ref/source_type to wip_movements.

## Invariants the endpoints must hold
- Raw inventory lives in containers with `warehouses.purpose='raw'` and `inventory.product_type='raw'`, where `quantity = weight_kg = kg`. raw-in and receive both REQUIRE the source container be `purpose='raw'` (else 404) — otherwise totals hide from the flow views (rawContainers filters purpose='raw'; finished view filters product_type='finished').
- **receive decrement must be atomic/race-safe**: `UPDATE ... SET weight_kg=weight_kg-$amt WHERE ... AND weight_kg >= $amt RETURNING ...`, and only insert the RECEIVE row if 1 row was affected. A read-then-clamp(GREATEST(0,...)) pattern double-counts under concurrency.
- "today" KPIs use `AT TIME ZONE 'Asia/Tashkent'`.

## Schema ownership / cold-start
The columns this module reads (`inventory.weight_kg`, `inventory.product_type`, `warehouses.location_type/capacity_kg/purpose`, `stock_movements.product_type`) are normally created by the **bot** `init_db`. The API `initDb` ALSO guarantees them via idempotent `ALTER ... IF EXISTS ADD COLUMN IF NOT EXISTS` so `/ombor/*` does not 500 when the API boots against a DB the bot hasn't initialized yet. Keep the two in sync.

**Why:** in a fresh Replit dev environment the bot never runs, so the API (which connects to RAILWAY_DATABASE_URL) hit "column i.weight_kg does not exist" and every /ombor/* endpoint 500'd. Defensive ALTERs in API initDb fixed it without depending on bot run-order.

## Testing gotcha
The API connects to **RAILWAY_DATABASE_URL** even in the Replit dev workflow (lib/db: `RAILWAY_DATABASE_URL || DATABASE_URL`). curl-based write tests therefore mutate the shared Railway DB — clean up test rows afterward (wip_movements is the new ledger; delete test RECEIVE/PRODUCE rows, reset container purpose).
