---
name: Role-based kg payroll engine (Arqon)
description: Durable invariants/decisions for the ROLE_BASED_KG payroll engine — kg-only rule, day-close freeze, batch method snapshot.
---

# Role-based kg payroll engine (Arqon dept)

Two payroll methods per product: `PRODUCT_RATE` (dona, original flow) and
`ROLE_BASED_KG` (kg). Producers paid per batch (kg × producer role-rate); assigned
prep/packers paid DAILY total producer kg × role-rate, computed once at bot "day close".

## ROLE_BASED_KG is kg-only — enforce at the DB, not just the app
`payroll_method='ROLE_BASED_KG'` is only valid when `products.rate_type='kg'`.
**Why:** multiple write paths can set/break this (API PATCH, API POST upsert, bot,
manual SQL). App-level checks on one path leave the others open — a POST upsert that
flips `rate_type` to non-kg silently violated it.
**How to apply:** the global backstop is a DB CHECK constraint
`products_role_kg_requires_kg = CHECK(payroll_method <> 'ROLE_BASED_KG' OR rate_type='kg')`,
added idempotently in bot `init_db()` AND applied directly to the Railway runtime DB.
App routes still validate the *effective final* (rate_type, payroll_method) state for
friendly errors, but the CHECK is the guarantee. Not mirrored in Drizzle — so a fresh
Drizzle-only DB won't carry it unless `init_db()` (or an equivalent migration) runs.

## Day-close is "computed once" — freeze, don't recompute
On first close, snapshot kg/rate/amount into `salary_entries` (daily_shared) and record
the run. Reruns return the existing snapshot WITHOUT recomputing/overwriting and WITHOUT
re-notifying workers.
**Why:** rates are editable globally; recomputing on rerun would rewrite historical pay,
and re-notify would double-message workers.
**How to apply:** if a `daily_payroll_runs` row exists for the date, read & return it;
first-close inserts use `ON CONFLICT DO NOTHING`; a `pg_advisory_xact_lock` keyed on
`close_day:{scope}:{work_date}` serializes concurrent double-clicks.

## Shared-kg basis must match what producers were actually paid
Daily total producer kg (used for shared pay) must come from each batch's snapshot of
the method at creation time, not the product's CURRENT method at close.
**Why:** a product's method can change between batch creation and day close; producer
`earnings` were already locked under the method at creation, so the shared kg total must
use the same basis or the two diverge.
**How to apply:** `batches.payroll_method` is snapshotted at batch creation; the bot
captures the method ONCE at cart-add (passed into earnings calc and stored on the item),
so producer earnings and the stored snapshot derive from one read. close_day and the API
day-status SUM `batches.weight_kg WHERE batches.payroll_method='ROLE_BASED_KG'` (no join
on current product method).
