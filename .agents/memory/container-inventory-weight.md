---
name: Container inventory weight (stored, not derived)
description: How kg stock lives in inventory.weight_kg — existence/display/valuation rules, kg sales & transfers, positive-only aggregation.
---

The `inventory` table (warehouse/container finished-goods stock — bot-owned, NOT in
Drizzle schema, no CREATE TABLE anywhere in repo) has a real
**`weight_kg NUMERIC NOT NULL DEFAULT 0`** column, plus UNIQUE (warehouse_id, product).

## Core invariants (post 2026-08-17 baseline reset)

- **A stock row "exists" iff `quantity > 0 OR COALESCE(weight_kg,0) > 0`.** The reset
  baseline stores kg products as `quantity=0, weight_kg>0` — any `quantity > 0`-only
  filter silently hides them ("Konteyner bo'sh" bug). Every ombor endpoint
  (summary/containers/items/search/finished-goods) uses the OR predicate.
- **Display weight is NOT gated on `products.unit_type`.** Dona products can hold
  weight-only baseline rows too (lenta counted in kg). Item rows return stored weight
  whenever > 0; **valuation** stays keyed on unit_type: kg → weight×price,
  dona → qty×price (same CASE rule as the containers-list SQL — keep card↔detail equal).
- **Aggregates sum positive weight only:** `SUM(weight_kg) FILTER (WHERE weight_kg > 0)`
  for card totals / occupancy / finished-goods / flow overview. Detail lists only
  positive rows, so unfiltered sums (negative phantom rows) would diverge from detail.
- **Occupancy basis:** weight when present, else qty, over capacity_kg.

**Why:** exact per-container mass is business-critical; batch-ratio derivation is an
approximation kept only as fallback.

## Mutation paths that maintain weight_kg

- Bot `record_movement` is **dual-mode**: dona-mode (weight_kg=0 → old proportional
  heuristics, unchanged) vs kg-mode (weight_kg>0, quantity=0 → ONLY weight moves).
  Movement-row convention: raw kg → `quantity=kg` (raw ledger counts quantity);
  finished/pre-finished kg → `quantity=0` + weight_kg (API transfer convention).
  Bot raw movements sync `raw_materials.current_stock` in the SAME txn per reconcile
  semantics (IN → +, OUT-from-NULL → −, OUT-from-warehouse/TRANSFER → 0) — tests pin a
  "reconcile gap unchanged" invariant.
- **OUT/TRANSFER availability must be enforced INSIDE the write txn** (conditional
  UPDATE `WHERE qty/weight >= X` + rowcount check → rollback, movement row written only
  after source deduction succeeds). GREATEST(0,…) clamps alone are a corruption vector:
  under a selection↔confirmation race the movement claims the full amount while
  inventory loses less. Handler pre-checks are UX only, never the guard.
- Bot unit resolution: `get_unit_for_item` (products.unit_type → raw_materials.unit_type
  → raw default kg, finished default dona); chiqim/transfer additionally treat
  qty<=0 & weight>0 rows as kg (non-catalog container SKUs).
- Bot `create_batch` adds batch weight (unchanged).
- API `/ombor/transfer`: two modes, **mutually exclusive** (qty>0 XOR explicit weightKg;
  kg mode = qty:0 + weightKg). Source row read `FOR UPDATE` (parallel transfers otherwise
  double-move via GREATEST(0,...) clamp). Movement rows carry weight_kg; kg-mode note
  `Transfer: N kg`.
- API POST /sales deduction: **saleType ('kg'|'dona' = products.unit_type via
  resolveProductPrice) picks the path.** kg → decrement weight_kg (never `Math.round` kg!),
  pick rows by weight DESC FOR UPDATE, movement quantity=0 + weight_kg, negative fallback
  upserts weight on first active warehouse. dona → qty decrement + proportional weight
  decrement, unchanged otherwise.
- API `/ombor/finished-in` (optional weightKg, ratio fallback) and `/ombor/adjust`
  (absolute values; kg products MUST send weight) as before.
- Raw rows can be weight-only too (bot kg kirim → qty=0, weight>0) — the OR-existence
  predicate applies to ALL product types, raw included.

## Current finished-goods stock = inventory table, NOT batches − sales

Read current stock from `inventory` (positive rows), never all-time `batches − sales`
(transfers/manual OUT/pre-feature sales diverge it). AI daily analysis prefers measured
`SUM(weight_kg)` (positive-only) over `invQty × kg_per_unit` ratio estimate — ratio is
fallback only, since baseline kg rows have invQty=0.

## Low-stock basis (finished goods)
- kg products: `low` compares measured weight (when >0) against `minimum_stock`; dona products compare qty.
- **Why:** post-reset kg rows have qty=0 — qty-basis would flag every kg product permanently low; valuation is already weight-based, so the basis must match.
- **How to apply:** keep tests pinning weight-basis for kg (incl. qty=0 rows both above and below threshold); don't "fix" them back to qty-basis.
