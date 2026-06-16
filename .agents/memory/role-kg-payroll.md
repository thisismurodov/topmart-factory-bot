---
name: Role-based kg payroll engine (Arqon) — per-line model
description: Durable invariants/decisions for the ROLE_BASED_KG payroll engine — per-line pool division, one-line-per-(worker,role), kg-only rule, day-close freeze, batch method snapshot, line-delete safety.
---

# Role-based kg payroll engine (Arqon dept)

Two payroll methods per product: `PRODUCT_RATE` (dona, original flow) and
`ROLE_BASED_KG` (kg). Payroll is organized by PRODUCTION LINE: each line has its own
producers / preparation / packaging workers and its own daily kg total. Rates are
GLOBAL per role (editable). Producers are paid per batch (kg × producer rate,
immediate). Shared roles are paid at day-close.

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
two lines makes the 2nd close-day insert `DO NOTHING` while both the API and bot still
report/notify it → false Telegram messages + missing pay.
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

## ROLE_BASED_KG is kg-only — enforce at the DB, not just the app
`payroll_method='ROLE_BASED_KG'` is only valid when `products.rate_type='kg'`.
**Why:** multiple write paths can set/break this (API PATCH, API POST upsert, bot,
manual SQL). App-level checks on one path leave the others open.
**How to apply:** global backstop is a DB CHECK constraint
`products_role_kg_requires_kg = CHECK(payroll_method <> 'ROLE_BASED_KG' OR rate_type='kg')`,
added idempotently in bot `init_db()` AND applied directly to the Railway runtime DB.
Not mirrored in Drizzle — a fresh Drizzle-only DB won't carry it unless `init_db()` runs.

## Day-close is "computed once" — freeze, don't recompute; per (line, date)
On first close of a line, snapshot kg/rate/amount into `salary_entries` (daily_shared)
and record the run in `daily_payroll_runs`. Reruns return the existing snapshot WITHOUT
recomputing/overwriting and WITHOUT re-notifying workers.
**Why:** rates are editable globally; recomputing on rerun would rewrite historical pay,
and re-notify would double-message workers.
**How to apply:** runs/uniqueness are keyed per `(scope, work_date, line_id)`; first-close
inserts use `ON CONFLICT DO NOTHING`; a `pg_advisory_xact_lock` keyed on the line+date
serializes concurrent double-clicks. Close-day runs from BOTH bot and dashboard.

## Shared-kg basis must match what producers were actually paid
Daily line kg (used for shared pay) must come from each batch's snapshot of the method
at creation time, not the product's CURRENT method at close.
**Why:** a product's method can change between batch creation and day close; producer
`earnings` were already locked under the method at creation, so the shared kg total must
use the same basis or the two diverge.
**How to apply:** `batches.payroll_method` is snapshotted at batch creation. close_day
and API day-status SUM `batches.weight_kg WHERE batches.payroll_method='ROLE_BASED_KG'`
grouped by `production_line_id` (no join on current product method).
