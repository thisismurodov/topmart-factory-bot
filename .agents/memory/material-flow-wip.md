---
name: Material Flow (Ish jarayoni) two-step WIP
description: Manual-only warehouse WIP model; bot batches intentionally bypass it until production warehouses are ready.
---

# Two-step WIP model (Ish jarayoni)

raw container → department (production_line) WIP → finished container.

- **Department WIP = SUM(RECEIVE) − SUM(PRODUCE)** over the `wip_movements` ledger ONLY. Do not derive WIP from inventory or raw_materials.current_stock.
- **Raw-stock single entry point (avoid double-count):** `POST /ombor/flow/receive` and manual PRODUCE must NOT touch `raw_materials.current_stock` (raw still in factory as WIP; global stock only drops via BOM at batch creation). Raw INTAKE has ONE entry point — `POST /ombor/flow/raw-in` — which increments BOTH container `inventory` (product_type='raw') AND `raw_materials.current_stock` (matched by LOWER(name)) so the per-container view and global stock stay consistent.

**Why:** two independent raw ledgers guarantee drift. Keeping intake in one place (raw-in) and consumption in one place (BOM) prevents both double-counting and divergence. raw-in REJECTS (400) any material name that has no matching raw_materials row, so container stock can never exist without a global counterpart.
- RECEIVE (+kg) inserted by the API when raw is handed from a container to a department (`POST /ombor/flow/receive`).
- PRODUCE (−kg) currently has **ONE entry point**: dashboard `POST /ombor/flow/produce` (manual "Tayyor chiqarish" in Ish jarayoni). It guards available WIP, inserts a PRODUCE row, upserts finished inventory, and logs a finished stock movement.

**Bot rule (authoritative for now):** `create_batch_session` must not read/lock WIP, reject on WIP balance, insert PRODUCE, or trigger negative-WIP alerts. It still creates the batch/label, finished inventory and stock movement, and performs BOM consumption atomically.

**Why:** production warehouses/Flow are not operationally ready yet. WIP history and endpoints stay available, but they must not block factory bot output. If bot-driven WIP is re-enabled later, define one output source of truth and idempotent source references first.

**How to apply:** keep dashboard manual Flow guards intact. A regression test should succeed even when the WIP table is unavailable and should prove a late BOM failure rolls back batch, labels, inventory, movements, and raw stock.

## Invariants the endpoints must hold
- Raw inventory lives in containers with `warehouses.purpose='raw'` and `inventory.product_type='raw'`, where `quantity = weight_kg = kg`. raw-in and receive both REQUIRE the source container be `purpose='raw'` (else 404) — otherwise totals hide from the flow views (rawContainers filters purpose='raw'; finished view filters product_type='finished').
- **receive decrement must be atomic/race-safe**: `UPDATE ... SET weight_kg=weight_kg-$amt WHERE ... AND weight_kg >= $amt RETURNING ...`, and only insert the RECEIVE row if 1 row was affected. A read-then-clamp(GREATEST(0,...)) pattern double-counts under concurrency.
- "today" KPIs use `AT TIME ZONE 'Asia/Tashkent'`.

## Schema ownership / cold-start
The columns this module reads (`inventory.weight_kg`, `inventory.product_type`, `warehouses.location_type/capacity_kg/purpose`, `stock_movements.product_type`) are normally created by the **bot** `init_db`. The API `initDb` ALSO guarantees them via idempotent `ALTER ... IF EXISTS ADD COLUMN IF NOT EXISTS` so `/ombor/*` does not 500 when the API boots against a DB the bot hasn't initialized yet. Keep the two in sync.

**Why:** in a fresh Replit dev environment the bot never runs, so the API (which connects to RAILWAY_DATABASE_URL) hit "column i.weight_kg does not exist" and every /ombor/* endpoint 500'd. Defensive ALTERs in API initDb fixed it without depending on bot run-order.

## Testing gotcha
The API connects to **RAILWAY_DATABASE_URL** even in the Replit dev workflow (lib/db: `RAILWAY_DATABASE_URL || DATABASE_URL`). curl-based write tests therefore mutate the shared Railway DB — clean up test rows afterward (wip_movements is the new ledger; delete test RECEIVE/PRODUCE rows, reset container purpose).
