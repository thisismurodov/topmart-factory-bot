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
- movement_type CHECK drift CLOSED 2026-08-15 (owner ordered it separately from the still-pending ADJUSTMENT-enum proposal); schema-drift workflow now guards parity. Lesson stands: schema truth = live pg_catalog, code truth = initializers; compare both. A future ADJUSTMENT enum must change every declaring source in lockstep AND replace the named constraint in the live DB. Convergent ADD CONSTRAINT in initializers must swallow duplicate_object (parallel bot+API boot race) but NEVER check_violation.
- Physical count itself validated the "duplicates are real" rule: count listed BOTH "Shroki 3.5 sm lenta" AND "Shroki 3.5 Oq" as separate physical goods (confirms Q3 keep-separate decision).

## P2 proposal delivered (2026-08-15) — awaiting owner decisions
- Owner froze ALL adjustments including the 2 EXACT ones (no UPDATE/IN/OUT/TRANSFER of the counted 48541 kg). P2 delivered proposal-only: `docs/p2-items-foundation-proposal.md` (134 items 1:1, no merges; 82 positions candidates-only; stages P2.0–P2.4 each owner-gated).
- Text-name identity lives in 8 tables (10 cols): products, raw_materials, product_materials×2, inventory, stock_movements, **batches** (easy to forget — bot writes product text there), wip_movements×2, sale_items. Deferred with reasons: sales.product header, packer_product_assignments, dead sale_products tables, distribution catalog, audit_logs.
- 39 orphan sale names overlap the physical-count vocabulary (Kanob Aralash, Tulpor Lenta, "N talik" strupa, Shlanka FDY/Polyamid…) — the factory's real vocabulary always diverged from the catalog; aliases (item_aliases) are the fix, never renames.
- Review lesson: every stage that writes anything (even backfill of NEW nullable columns) must carry an explicit owner-approval gate in the doc — "tests green" alone is not a gate under this owner's mandate.

## Owner decision 2026-08-15 — P2 approved WITH CONDITIONS
- Approved: items model (immutable id, immutable SKU, unit kg|dona, capability flags), item_aliases, backward compat, stages P2.0–P2.4 with a SEPARATE approval gate each. Mandatory: historical-data protection, no destructive migration.
- NOT approved / frozen: 15 POSSIBLE (individual review pending), 2 EXACT adjustments, 65 UNMATCHED = candidates only (no auto-create). Counted 48 541 kg = frozen "Physical Baseline" — must NEVER be written into ERP.
- IMPLEMENTATION RULE: before ANY write show exact migration plan, affected tables/fields, old→new mapping, backward-compat mechanism, rollback; then wait for explicit per-stage GO (e.g. "P2.1 GO").
- P2.0 read-only prep delivered: gated DDL lives in a standalone manual SQL script + dry-run inspector + runbook, deliberately NOT in initializers (initializers auto-apply to the live DB on boot); items DDL enters initializers/drizzle only at P2.1 GO. Gated psql runs need `-v ON_ERROR_STOP=1` — a BEGIN'd file can "succeed" after a silent rollback.

## C-16/C-17 addendum count (2026-08-15)
- C-16/C-17 real count recorded as a SEPARATE baseline-candidate set (12 positions, 10 301.20 kg / 126 360 pcs; doc `physical-count-c16-c17-2026-08-15.md`) — NOT folded into the frozen 48 541 kg six-container baseline.
- Source file's "C-17 TOTAL: 259 bags" contradicts its own line sum (279; its 162+59+58 subtotals also give 279) — kg/pieces totals unaffected; treat line rows as primary until owner confirms the bag-total typo.
- C-17 naming split: physical "Qop ip N gramm <color>" vs ERP "Reja ip N gr / <color>" (identical gram+color grid) — mapping deferred to item_aliases stage; ERP also holds "Reja ip PP / 50 gr" absent from the physical count. ERP rows there are dona-based (weight_kg=0), and the container was still moving on count day.

## Inventory-reset architecture (2026-08-16)
- Baseline 9 locations = 71 862.20 kg, fully position-detailed since 2026-08-16 (97 positions = 82+12+3). C-15 = 3 raw-filament positions «Polipropilen CF 1000D Qizil/Ko'k/Sariq» (kg-only; doc `physical-count-c15-2026-08-16.md`): ZERO exact match in raw_materials, and container purpose is 'finished' while content is raw → both are owner questions. C-17 bag total OWNER-CONFIRMED 279 («259» was a source-file typo; row-data-primary interpretation validated). Proposal doc: `docs/inventory-reset-implementation-proposal.md` — R-A…R-E gates layered onto approved P2.x, per-container «R-D GO C-xx» loads, no GO given yet.
- **Durable rule (survived architect review): rollback of any baseline/ledger write must be STORNO (reversing movement), never DELETE of movements; archives are append-only (no DROP of legacy schema). Owner brief forbids delete/overwrite even inside rollback paths.**
- Historical record vs current balance: "what old ERP believed" lives immutable in legacy schema + pre-baseline movements; the live inventory row is current-state and may change ONLY inside an audited movement transaction — never a bare UPDATE. Zeroing legacy via fake OUT movements is rejected (fabricated history).

## v2 reset strategy (2026-08-17) — owner reversed two defaults
- Legacy production balances are UNRELIABLE by decree: never reconcile counts against old ERP; archive-only. Live legacy rows in counted containers get ZEROED via audited BASELINE movements (reason=old value) — never OUT, never bare UPDATE.
- **Archive-verify gates destruction:** zeroing allowed ONLY after the legacy-archive stage completed AND row counts/values verified; pg_dump alone doesn't qualify (crash insurance, not a queryable archive). Zeroing txn: FOR UPDATE lock + compare live value to archived value; mismatch = STOP.
- Auto-SKU ban lifted for count-born items only: TM-NNNNNN, immutable, name-independent; deterministic assignment (count-doc container order, first occurrence wins for verbatim-duplicate names); historical SKUs never rewritten.
- Default for count positions = NEW item unless verbatim-EXACT catalog match; similarity merges stay forbidden (Qop ip ≠ Reja ip); owner links later via item_aliases; cross-container dedup only on verbatim-identical names. Attributes stay owner-editable; only SKU+id immutable.
**Why:** owner's v2 strategy decree + architect review caught the archive-before-zero ordering hole (docs originally allowed R-D before R-A).
**How to apply:** any destructive baseline/reset runbook must list verified-archive as a hard precondition, not a parallel stage. Current dry-run: `docs/inventory-reset-dry-run-report.md`.

## P2.1 + R-A executed on prod (2026-08-17)
- Live Railway DB now HAS: empty `items`/`item_aliases` (immutable-SKU + no-delete triggers proven via rolled-back smoke test), 10 nullable item_id cols, and append-only `legacy.*` archive (4 snapshot tables; UPDATE/DELETE/TRUNCATE blocked by triggers). R-D's verified-archive precondition is now SATISFIED, but R-D itself has no GO.
- items stayed at 0 rows on purpose: owner's "TM-SKU foundation allowed, no loading" was interpreted conservatively (94 item INSERTs are gated at R-C, which owner forbade starting); interpretation stated in the execution report.
- items id=1 was consumed by the rolled-back smoke insert — first real item gets id=2; business key is SKU, id gaps are by design.
- Archive triggers stop ACCIDENTAL writes only — the owner DB role can DISABLE TRIGGER (administrative bypass). Hence R-D re-reads + compares archive values inside the zeroing txn itself; corrective snapshots go to NEW timestamped tables under REPEATABLE READ, never appends into an existing *_pre table.
- Full prod pg_dumps live in `backups/` which is gitignored — they must never enter git history.
- Execution report with all before/after proofs: `docs/p2.1-r-a-execution-report-2026-08-17.md`; archive script (idempotent, NOT EXISTS-guarded): `scripts/sql/r-a-legacy-archive.sql`.

## R-C prep decisions (owner, 2026-08-17) — binding for the GO
- R-C = DDL (BASELINE enum + weight_kg/reference/reason, 3-source lockstep) + 94 NEUTRAL INSERTs ONLY: sku/display_name/unit/source_kind='physical_count'/note/created_by — classification flags are NOT written (DB defaults: all FALSE, inventory_tracked TRUE); owner sets attributes later in dashboard. Count provenance (date · container · qty) goes into items.note.
- 2 EXACT names (Rossiya Tros, Shroki 3.5 Oq) = unresolved candidates OUTSIDE R-C: no auto-mapping to existing SKUs AND no TM-000095/096 creation until owner decides.
- position→item_id backfill only AFTER R-B registry GO; R-D fully frozen (no zeroing of anything).
- items.created_by is TEXT NOT NULL with NO FK; identity is owner-picked text. Live identity sources: admin_users has a single admin; ERP bot user_roles ~24 (Superadmin + workers/packers); existing stock_movements convention = worker first names / 'system' / 'admin'. **CONFIRMED 2026-08-17: all 94 R-C INSERTs use created_by='thisismurodov'** (dashboard admin). counted_by for R-B and movement created_by for R-D remain open, decided separately.
- BASELINE DDL must ship INSIDE the GO txn window together with the initializer/Drizzle code edits — editing init code early IS a prod write (dev workflows boot against the prod Railway DB and auto-ALTER).
- Final preview (the exact document a GO executes): `docs/r-c-final-preview-2026-08-17.md`.
- **R-C executed 2026-08-17** (report: `docs/r-c-execution-report-2026-08-17.md`): 94 neutral items TM-000001…094 live (ids 2–95, seq consumed by smoke test — business key is SKU), BASELINE in movement CHECK + weight_kg/reference/reason columns live in prod and all three declaration sources. Items are classification-neutral (all flags FALSE) — owner classifies in dashboard. Position→item_id mapping deliberately NOT done (waits R-B registry); 2 EXACT candidates NOT created. R-D still frozen — no BASELINE rows written yet.
- R-C execution pattern worth reusing: generator emits SQL from sealed doc (byte-exact regen + cmp before psql), pre-gate pins doc counts + exact old CHECK def, LOCK only the tables the stage writes (items/item_aliases — factory keeps running), full-field FULL JOIN vs sealed expected temp table, restart-safety proven by read-only preflight of every initializer write predicate (all must be 0 candidates).

## R-B registry executed on prod (2026-08-17)
- Registry LIVE: `physical_baselines` (9, status='MAPPED', counted_by='thisismurodov') + `physical_baseline_positions` (97; item_id on 95, NULL on 2 EXACT; TM-000022 = 2 location rows; position_no 1..97 = sealed preview §3 order). Report: `docs/r-b-execution-report-2026-08-17.md`; script `scripts/sql/r-b-execution-2026-08-17.sql` (generator `scripts/src/r-b-generate-sql.ts`).
- Rows are trigger-frozen; ONLY allowed transitions: baselines status MAPPED→LOADED (R-D per container), positions item_id NULL→value + EXCLUDED→MAPPED (+note) in one UPDATE (owner decision №1 on the 2 EXACT). Everything else (incl. note-only edits, DELETE, TRUNCATE) raises. Stage rollback = DROP both tables.
- Registry tables follow the items precedent: they exist ONLY via gated SQL — intentionally NOT in initializers/Drizzle/drift TABLES map (drift green by construction). Do not "fix" this later by adding them to schema sources.
- kg rows: quantity=weight_kg enforced by CHECK; dona rows carry boxes/per_box/unit_weight_g with CHECK boxes×per_box=quantity and quantity×g=kg×1000. Legacy POSSIBLE candidates deliberately NOT in DB notes (sealed preview doc only).
- Prod-write rehearsal pattern that caught real issues: throwaway DB on the same Railway server + CSV-copy live items/warehouses + stub business tables → run full script + trigger battery + lock-concurrency probe BEFORE prod. Architect catch worth keeping: pre-gate-pinning FK reference rows (warehouses) is not enough — LOCK the table (SHARE) before the snapshot or a concurrent rename corrupts the frozen registry.
- pg_dump vs Railway: server is PG 18.4; PATH pg_dump 16.10 refuses (version mismatch). Working client already in nix store — use full path `/nix/store/*-postgresql-18.6/bin/pg_dump`; no install needed.
- Reusable pattern: preview generators must `rm` their output file FIRST so doc-existence ⇔ last-run-PASS (architect caught the stale-doc-after-failed-rerun hazard).
- "Byte-exact name" claims must be enforced, not assumed: never `.trim()` identity cells — assert `cell === cell.trim()` and fail; annotations (`*(metr: NULL)*`) get a strict whitelist regex + expected-location set instead of generic stripping.
- Still open after R-B: 2 EXACT candidates (owner №1), §16 №2 (C-16/C-17 zeroing — decided in their own GO), №4 (WIP cut at full R-D), №7; №5 (qty=0+weight_kg) and R-D created_by='thisismurodov' RESOLVED via C-15 precedent (2026-08-17).

## R-D C-15 executed on prod (2026-08-17) — first container LOADED
- C-15 (wid=21) loaded in one gated txn: 3 BASELINE movements + 3 inventory rows (13 020.00 kg; quantity=0 kg-only convention and movement created_by='thisismurodov' are now owner-approved precedents), baselines id=9 MAPPED→LOADED (the only trigger-allowed transition). Report `docs/r-d-c15-execution-report-2026-08-17.md`; script `scripts/sql/r-d-c15-execution-2026-08-17.sql`. Remaining 8 containers stay frozen behind per-container GOs; **future R-D scripts must pin global BASELINE=3 (+prior containers), not 0** — GATE cleanliness is per-container from now on.
- **Lock-before-snapshot rule (architect catch, generalizes to every gated prod-write script):** under REPEATABLE READ the snapshot forms at the FIRST query; a row-level FOR UPDATE latch does NOT make concurrent domain inserts visible to the checks. LOCK TABLE (SHARE ROW EXCLUSIVE — blocks writers, self-conflicting so parallel gated scripts serialize) every table the script pins or writes, BEFORE any SELECT. Probe: holder txn with same locks + writer with lock_timeout must fail, then succeed after release.
- Rehearsal-from-dump: full pg_restore of the prod dump into a throwaway DB exceeds 5 min on the distribution schema — restore `-n public -n legacy` only, and CREATE SCHEMA legacy first (`-n` never emits CREATE SCHEMA; symptom = dozens of "schema does not exist" errors). Faster than CSV-copy and preserves all triggers/constraints.

## R-D final 8+2 EXECUTED on prod (2026-08-17) — reset baseline COMPLETE
- «R-D FINAL GO» executed: ALL 9 locations LOADED; current inventory = physical count exactly (110 BASELINE movements, 140 inventory rows, 71 862.20 kg / 126 360 dona, classification 6 raw / 3 pre-finished / 88 finished); 13 C-16/C-17 legacy rows zeroed via audited BASELINE (old value in reason); 2 EXACT loaded as finished attached to EXISTING products (id=46 Rossiya Tros→C-18 531 kg, id=108 Shroki 3.5 Oq→C-02 676.55 kg; item_id NULL, no new SKU; registry positions stay frozen EXCLUDED). Namangan «Shroki 3.5» −125 is a DIFFERENT product (id=71) — untouched. Report: `docs/r-d-final-execution-report-2026-08-17.md`; backup `backups/pre-r-d-8cont-2026-08-17.dump`.
- Container GO scripts reuse the reason prefix «R-D baseline yuklash» — any count-by-reason across the whole table must ALSO scope by warehouse (95 = 92 final GO + 3 C-15), or pins drift on the next stage.
- Ad-hoc post-verify joins must use stock_movements.item_id (P2.1 column), never parse SKUs out of reference text — reference cites registry positions, not SKUs (a reference-regex join falsely reported 92 mismatches).
- pg_dump of the shared Railway DB while api-tests run causes false test failures: dump's ACCESS SHARE blocks the tests' TRUNCATE (ACCESS EXCLUSIVE) → 30s hook timeout. Schedule backups outside test runs or expect one-off hook timeouts.
- Architect catch (generalizes): protected-table claims (sales/sale_items/raw_materials "unchanged") need those tables IN the SHARE ROW EXCLUSIVE lock list too — REPEATABLE READ pins+9.x reread the same snapshot, so unlocked concurrent commits are invisible and the claim can be falsely green.
- legacy.* archive is APPEND-ONLY via trigger (legacy.no_touch_fn): rehearsal tamper-tests must corrupt INVENTORY (pin gate catches), not the archive; live≠arxiv mismatch can only arise from inventory-side corruption.
- product_type has NO DB CHECK — 'pre-finished' stores fine; sales decrement path is name-based (no type filter) so pre-finished sells OK; BUT some panels filter ='finished'/'raw' equality (ombor container/raw panels, dashboard badge fallback «Tayyor») — later dashboard pass per owner §17–18, NOT part of R-D.

**Container count loading recipe (est. C-15, repeated C-14 2026-08-18).** New container
physical count = ONE txn: `physical_baselines` row (LOADED, source_doc docs/physical-count-cNN-<date>.md)
→ per position: `items` (ALL class flags false, inventory_tracked=t, source_kind='physical_count',
sku TM-<max+1>) → `physical_baseline_positions` (position_no = GLOBAL max+i, container_pos = sheet
order, MAPPED) → `stock_movements` BASELINE (product_type = owner's tasnif) → `inventory`
(quantity=0, weight_kg). finished/pre-finished names ALSO get ombor-only `products` rows (sku='',
item_id NULL, in_sales=f, in_production=f, weight=1) so bot kirim 'store' sees them; raw names go into raw_materials too (owner expects them in the xomashyo section):
current_stock = container kg, IN movement note "Boshlang'ich balans: N kg (katalogga qo'shishda …)",
default_cost 0 until owner gives a price — EXCEPT clear same-family precedent (CF variants all 1.75 USD → use it, tell owner),
currency USD like peers, minimum_stock 300 — but NOT products.
If a count name already EXISTS as an item in another container: reuse item_id, ADD kg to the existing
raw_materials row ("Qo'shimcha balans" IN movement), never duplicate. raw_materials.current_stock mirrors
the SUM over container holdings. Owner may amend count names (e.g. add "70 metr") → canonical name gets
the amendment, short form goes to item_aliases (source='physical_count'). Weight >20t is possible —
owner raised all container capacity_kg to 25000 on 2026-08-18; confirm anomalies, don't assume typo. Guards first: container inventory
empty + no baseline row + names absent in items/item_aliases + SUM equals owner's JAMI.
