---
name: Role-based kg payroll engine (Arqon) — per-line model
description: Durable invariants/decisions for the ROLE_BASED_KG payroll engine — per-line pool division, one-line-per-(worker,role), kg-only rule, day-close freeze, batch method snapshot, line-delete safety.
---

# Role-based kg payroll engine (Arqon dept)

Two payroll methods per product: `PRODUCT_RATE` (original per-product-rate flow) and
`ROLE_BASED_KG`. Payroll is organized by PRODUCTION LINE. There are now TWO kinds of
line — CONFIG lines (have `line_role_config` rows) and LEGACY lines (none) — and they
pay DIFFERENTLY. Read `## Config line vs legacy line` first; it overrides the older
"producers per batch / kg-only / shared-kg basis" sections below for config lines.

## Config line vs legacy line — the unit basis and attribution (NEW, authoritative)
At day-close, ROLE_BASED_KG work is aggregated per line as WORK-UNITS, not kg:
`units = SUM(CASE WHEN products.rate_type='kg' THEN batches.weight_kg ELSE batches.quantity END)`
attributed via `COALESCE(batches.production_line_id, products.line_id)`, filtered to
`batches.payroll_method='ROLE_BASED_KG'` (JOIN batches→products on name).
- CONFIG line: pay EVERY configured role (INCLUDING producer) that has ≥1 worker, but
  HOW depends on `line_role_config.pay_mode` ('pooled' default | 'individual'):
  - pay_mode='pooled' (pochkalash / ip o'rovchi / preparation / packaging):
    `amount = line_total_units × rate ÷ (#workers in that role on the line)`.
  - pay_mode='individual' (PRODUCERS): each worker paid by their OWN production —
    `amount = own_units × rate`, attributed via `batches.worker` (GROUP BY worker),
    NOT divided by headcount. Example: Aziza 98.5kg, Gullola 100kg, Shohida 50kg each
    ×1125 individually (NOT (98.5+100+50)/3).
  The entering worker's per-batch `batches.earnings` is stored as 0 (paid at close) to
  avoid double pay. The product `rate` column is NOT used to pay anyone on a config line.
  **pay_mode migration:** added via idempotent ALTER in BOTH api-server initDb AND bot
  init_db; a config role is auto-flagged 'individual' iff its members ALSO hold the
  standard 'producer' role on the same line (backfill UPDATE runs in BOTH services so
  startup order doesn't matter). Endpoints (line-configs, role-config, POST/PATCH roles)
  expose/accept payMode. Dashboard isPool keys off payMode (NOT roleKey==='producer').
- LEGACY line: unchanged — producer paid per batch from product rate; prep/packaging
  global-rate pools ÷count at close.
**Why:** dona products (e.g. Qop Ip line 9: Qopiporash=100/dona, karopkalash=60/dona)
have weight_kg=0, so the old kg-only pool gave them 0. Bot `close_day`, API close-day,
AND any data-fix MUST use this identical SQL or they diverge. Example: 6000 dona, one
Qopiporash worker → 600,000.
**How to apply:** bot `create_batch_session` sets `production_line_id` from
`products.line_id` (fallback producer lookup) and stores per-batch earnings=0 on
config-line ROLE_BASED_KG batches; the old per-batch "other roles" block was removed.
The confirmation/cart DISPLAY value (`calc_earnings`) is DISPLAY-ONLY (config-line
batches store `earnings`=0; real pay is computed at day-close from `line_role_config`),
so changing it never corrupts actual payroll. Rule: if the ENTERING worker holds a
config role on the line (`get_line_role_rate_strict` matches `line_role_config.role_key`),
show `units × that role's rate` (e.g. producer 300.2kg → 300.2×1125). ONLY when the
enterer is NOT a line worker (operator/admin) fall back to
`units × get_line_staffed_role_rate_sum(product)` (sum of staffed-role rates) so the
preview isn't 0. **Why:** users read the number as "this producer's batch pay"; a combined
line-sum (e.g. 1875 = producer 1125 + pochkalash 750) looked wrong — each role earns its
own rate separately. The earlier always-show-the-line-sum design was wrong for line
workers. Note staffed-rate-sum still excludes UNstaffed roles (an Ip O'rovchi role with no
assigned worker drops out), which is also why the old sum looked short (1875 not 2250).

## (Legacy-only) producers paid per batch; rates GLOBAL per role
Applies ONLY to LEGACY lines. Producers are paid per batch (kg × producer rate,
immediate); preparation/packaging are paid at day-close as global-rate pools.

## Shared-role pay is a per-line POOL DIVIDED by worker count in that line
- preparation pool = `line_total_kg × prepRate ÷ (#prep workers in that line)`
- packaging  pool = `line_total_kg × packagingRate ÷ (#packaging workers in that line)`
- producer pay is unchanged (per batch, not pooled).
**Why:** the whole point of the multi-line redesign — a line's shared budget is split
among the people who worked that line, not paid in full to each. Division-by-count per
line is the key behavior; bot `close_day` and API close-day MUST compute identical
amounts (same line/date lock, same `amount = totalKg * roleRate / count`).

## Each (worker, role) belongs to exactly ONE line
Enforced by a global `UNIQUE(worker_name, role)` index on `production_line_workers`
(plus the older partial producer-only index, now subsumed). A worker may hold a
*different* role on another line, but not the *same* role on two lines.
**Why:** `salary_entries` daily-shared uniqueness is `(scope, worker, role, work_date)`
— NOT line-aware. Without this constraint, the same worker in the same shared role on
two lines makes the 2nd close-day insert `DO NOTHING`, causing missing pay. Actual-insert
gating prevents a false Telegram message, but cannot recover the missing second-line pay.
**How to apply:** index added in Drizzle schema AND bot `init_db()` AND applied to the
Railway runtime DB. API add-worker catches `23505` → role-aware 409. Dashboard filters
preparation/packaging dropdowns GLOBALLY (like producers) so an already-assigned worker
isn't offered for another line.

## Line deletion must be blocked when referenced — kg snapshot has no FK
`batches.production_line_id` is a plain int snapshot (no FK, set at batch creation).
DELETE `/payroll/lines/:id` returns 409 if the line is referenced by `batches`,
`daily_payroll_runs`, or `salary_entries`.
**Why:** day-status only attributes kg to line IDs that still exist in
`production_lines`; deleting a line with today's batches would make that kg vanish from
both "assigned" and "unassigned" and it would never be closed/paid.
**How to apply:** the delete guard is the primary defense; as a safety net, day-status
folds any kg whose `production_line_id` is non-null but absent from `production_lines`
into `unassignedKg` (so it stays visible). Per-(line,role) add-worker uses
`pg_advisory_xact_lock(hashtext('add_worker:{lineId}:{role}'))` + in-txn re-count so
concurrent adds cannot exceed role caps (producers 5 / prep 3 / packaging 5).

## ROLE_BASED_KG is NOT kg-only anymore — dona config lines are valid
Earlier this engine assumed `ROLE_BASED_KG` ⇒ `rate_type='kg'` (with a DB CHECK
`products_role_kg_requires_kg`). That invariant is OBSOLETE: config lines legitimately
run dona products under ROLE_BASED_KG (Qop Ip line 9 products are `rate_type='dona'`,
`payroll_method='ROLE_BASED_KG'`), so the close/preview math keys off `rate_type`
(kg→weight_kg, dona→quantity) rather than rejecting dona.
**Why:** the whole Qop Ip fix depends on paying dona work; a kg-only constraint would
forbid the data that must exist.
**How to apply:** do NOT re-add a kg-only CHECK; the live Railway DB does not enforce
one on these rows. Treat units by `rate_type` everywhere (close_day, day-status,
calc_earnings, data-fixes).

## Day-close is "computed once" — freeze, don't recompute; per (line, date)
On first close of a line, snapshot kg/rate/amount into `salary_entries` (daily_shared)
and record the run in `daily_payroll_runs`. Reruns return the existing snapshot WITHOUT
recomputing/overwriting and WITHOUT re-notifying workers.
**Why:** rates are editable globally; recomputing on rerun would rewrite historical pay,
and re-notify would double-message workers.
**How to apply:** runs/uniqueness are keyed per `(scope, work_date, line_id)`; first-close
inserts use `ON CONFLICT DO NOTHING`; a `pg_advisory_xact_lock` keyed on the line+date
serializes concurrent double-clicks. Salary inserts use `RETURNING id`/`rowCount`; append
to result and notify only when a row was actually inserted. A pre-existing salary row
without its run may be frozen into a run, but must not be reported or notified as new.
Close-day runs from BOTH bot and dashboard. ROLE_BASED_KG batch creation MUST acquire the
same per-line/Tashkent-date lock before it writes: batch-first is included by the close,
while close-first rejects the late batch instead of silently leaving it unpaid.
**Why:** a close query can otherwise read pooled and individual aggregates from different
committed snapshots, then freeze an internally inconsistent payroll run.
**How to apply:** coordinate every ROLE_BASED_KG batch writer with the close lock; after
acquiring it, reject a line/day that already has a closed run. Test both lock orderings.

## Shared pay basis uses the batch's snapshotted method, attribution via product line
Daily line totals (for shared/role pay) filter on each batch's snapshot
`batches.payroll_method='ROLE_BASED_KG'` (locked at creation), NOT the product's
current method. Attribution is `COALESCE(batches.production_line_id, products.line_id)`
(JOIN on product name) — needed because `production_line_id` is often NULL for
non-producer/custom-role lines, and the unit basis comes from `products.rate_type`.
**Why:** a product's method/rate can change between batch creation and day close;
mixing bases makes producer per-batch pay and the close-day totals diverge, and a
producer-only line fallback can't attribute lines that have no producer (Qop Ip).
**How to apply:** close_day, API close-day, API day-status, and data-fixes all use the
same `units` CASE + COALESCE attribution + ROLE_BASED_KG filter (see the config-line
section above).
