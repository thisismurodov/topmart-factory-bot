---
name: Canonical item-master (SKU) migration
description: Target inventory identity model, owner-approval status, and the traps that corrupt stock math if forgotten
---

Full audit + phased plan: `docs/canonical-inventory-architecture-audit.md`; P1 data mapping (A–H tables): `docs/p1-data-mapping.md` (both 2026-08-14). Status: **architecture approved 2026-08-14 (all 15 canonical rules)** but implementation still forbidden until owner closes the P1 data decisions (Q1–Q10 in the mapping doc: Sholcha family, dual merges, negative-stock strategy, duplicate/similar pairs, stocktake date). Owner-mandated gate: physical inventory precedes ANY inventory-affecting change — COUNT -> RECONCILIATION -> PROPOSAL -> USER APPROVAL -> ADJUSTMENT; agent never self-adjusts stock. Count sheets: `docs/physical-count-sheets.md`. **Real count received 2026-08-15** (6 finished-goods containers C-02/04/06/18/19/20): reconciliation = `docs/physical-count-reconciliation-2026-08-15.md`; only 2 EXACT adjustments proposed, everything awaits owner approval + small schema prep. Special-control: Sholcha family (unit/origin unresolved — no merge/transformation assumptions); one-sided WIP lines (no auto-zero). P2 opens only after reconciliation; its stage 1 = immutable SKU + items foundation + legacy-name mapping + dual-read/write, zero automatic edits to existing transactions.

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

## Physical-count lessons (2026-08-15, 6 containers)
- ERP emptiness proves nothing: all 6 densely-loaded containers had ZERO inventory rows and ZERO movements — never infer physical state from ERP absence.
- Reconciliation turned out to be an item-CREATION problem, not a balance problem: ~80% of physical names (Toshkent Arqon, Alpinist, Neylon 210D, Passport, Tulpor Lenta, "N talik" strupa families) don't exist in the catalog at all — strong evidence P2 items foundation must precede most adjustments.
- Namangan negative balances correlate family-by-family (incl. 5/5 Shlanka FDY colors) with physical container stock → supports "sales were deducted from the wrong location" historical-error classification; still needs owner sign-off, never auto-close.
- Adjustments are architecturally blocked: stock_movements CHECK allows only IN/OUT/TRANSFER (no ADJUSTMENT), no reference/weight_kg columns, text-name identity; inventory.quantity semantics for kg products varies by row (sometimes packages, sometimes kg) — resolve per item with owner before writing.
- movement_type CHECK exists ONLY in the live Railway DB (verified via pg_constraint 2026-08-15) — both initializers create plain TEXT NOT NULL, so fresh DBs lack it. Drift must be closed together with the ADJUSTMENT-enum proposal, never separately. Don't trust either source alone: schema truth = live pg_catalog, code truth = initializers; compare both.
- Physical count itself validated the "duplicates are real" rule: count listed BOTH "Shroki 3.5 sm lenta" AND "Shroki 3.5 Oq" as separate physical goods (confirms Q3 keep-separate decision).

## P2 proposal delivered (2026-08-15) — awaiting owner decisions
- Owner froze ALL adjustments including the 2 EXACT ones (no UPDATE/IN/OUT/TRANSFER of the counted 48541 kg). P2 delivered proposal-only: `docs/p2-items-foundation-proposal.md` (134 items 1:1, no merges; 82 positions candidates-only; stages P2.0–P2.4 each owner-gated).
- Text-name identity lives in 8 tables (10 cols): products, raw_materials, product_materials×2, inventory, stock_movements, **batches** (easy to forget — bot writes product text there), wip_movements×2, sale_items. Deferred with reasons: sales.product header, packer_product_assignments, dead sale_products tables, distribution catalog, audit_logs.
- 39 orphan sale names overlap the physical-count vocabulary (Kanob Aralash, Tulpor Lenta, "N talik" strupa, Shlanka FDY/Polyamid…) — the factory's real vocabulary always diverged from the catalog; aliases (item_aliases) are the fix, never renames.
- Review lesson: every stage that writes anything (even backfill of NEW nullable columns) must carry an explicit owner-approval gate in the doc — "tests green" alone is not a gate under this owner's mandate.
