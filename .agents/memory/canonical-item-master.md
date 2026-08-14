---
name: Canonical item-master (SKU) migration
description: Target inventory identity model, owner-approval status, and the traps that corrupt stock math if forgotten
---

Full audit + phased plan: `docs/canonical-inventory-architecture-audit.md`; P1 data mapping (A–H tables): `docs/p1-data-mapping.md` (both 2026-08-14). Status: **architecture approved 2026-08-14 (all 15 canonical rules)** but implementation still forbidden until owner closes the P1 data decisions (Q1–Q10 in the mapping doc: Sholcha family, dual merges, negative-stock strategy, duplicate/similar pairs, stocktake date). Owner-mandated gate: physical inventory precedes ANY inventory-affecting change — COUNT -> RECONCILIATION -> PROPOSAL -> USER APPROVAL -> ADJUSTMENT; agent never self-adjusts stock. Count sheets: `docs/physical-count-sheets.md`. Special-control: Sholcha family (unit/origin unresolved — no merge/transformation assumptions); one-sided WIP lines (no auto-zero). P2 opens only after reconciliation; its stage 1 = immutable SKU + items foundation + legacy-name mapping + dual-read/write, zero automatic edits to existing transactions.

## Decided target model
One `items` master (immutable id + globally unique SKU + capability flags is_raw/is_manufactured/is_purchased/is_intermediate/is_saleable); `products` and `raw_materials` remain as profile tables. Additive migration only (nullable item_id + backfill + dual-write), never absorb raw_materials into products.
**Why:** products' payroll/pricing fields are alien to raw items and `in_production DEFAULT TRUE` would leak raw items into production lists.

## Stock-math conservation rule (critical)
Global on-hand for a raw item = Σ container inventory **+ Σ WIP balances**. Issuing to a department (WIP_ISSUE) moves quantity between locations and must NOT change global; only production consumption / sale / transformation deduct it. This matches current semantics (raw_materials.current_stock is deducted at batch time, not at issue time).
**Why:** an earlier draft defined global = SUM(containers) only; independent review showed WIP-issued material would vanish or double-deduct.
**How to apply:** any reconciliation check, cache formula, or ledger design must treat WIP as a first-class inventory location.

## Guard gaps that shape data trust (verified 2026-08-14)
- BOM-less batches pass silently (bot reads BOM only to compute deductions) — "ever produced" is weak evidence for is_manufactured classification.
- Batch output warehouse is unvalidated (any active warehouse; default = first active) — explains finished rows parked in raw containers.
- WIP line resolves from products.line_id OR the producer worker's line; only when both are missing does a batch bypass WIP accounting.
- SKU uniqueness helper (`uniqueProductSku`) checks products only — items.sku backfill needs a global allocator across products ∪ raw ∪ distribution.
- Dual raw↔product copies bridge via a 1:1 self-BOM (product "consumes" 1 kg of its own raw twin); their 4 historic sales bypassed inventory entirely (no rows, no movements). At merge, self-BOMs must be dropped, not migrated.
- PP 2x1500/OQ carries a 144 kg stock delta not reconstructable from stock_movements (pre-ledger-sync era) — never assume ledger completeness when reconciling.

- Duplicate catalog rows follow a bulk re-entry pattern: one day someone re-created clean-name copies (in_sales=true, zero history) while old rows keep BOM/stock/sales — merge = old row survives + owner-chosen display name; check created_at clustering before calling anything a typo.
- WIP ledger can be one-sided (PRODUCE without RECEIVE → large negative WIP) with NULL material names; never trust a WIP figure without checking both movement types exist.
- Sholcha products are unit_type=kg with weight 0 and were entered BEFORE their raw material arrived — unit semantics unresolved (owner question), don't assume dona or derive weights from BOM.
