---
name: Fresh-DB boot ordering & missing tables
description: Latent init bugs that only surface on a brand-new empty DB (ordering / never-created tables) and how the guard test catches them.
---

# Fresh-DB boot ordering & missing tables

On an established DB, init code is forgiving: idempotent `CREATE TABLE IF NOT EXISTS`
and `ALTER ... ADD COLUMN IF NOT EXISTS` succeed regardless of statement order because
the referenced tables already exist. On a **brand-new empty DB** two failure classes
appear that production never hits:

1. **Order-dependent ALTER before CREATE.** An `ALTER TABLE x ADD COLUMN ... REFERENCES y`
   that runs *before* `CREATE TABLE y` throws `relation "y" does not exist` (42P01).
   This is NOT caught by the `duplicate_object` exception handlers, so init aborts and
   the app never boots.
2. **A table that is written/altered but never created by any init path.** If routes
   INSERT/SELECT it and init only ALTERs it (e.g. to add a CHECK constraint), a fresh DB
   has no such table and init crashes. In production it "works" only because the table
   was created by some long-gone code or by hand.

**Why this matters:** these are invisible until someone provisions a clean database
(new deploy, disaster recovery, a fork). The fix is always to make every queried table
self-created by init, in dependency order.

**How to apply:**
- Any FK target must be `CREATE TABLE IF NOT EXISTS`-ed before the column that references
  it. If the full definition lives later, add an early idempotent create (it becomes a
  no-op later) and leave a comment, or move the block up.
- If a table is only ever ALTERed in init but routes read/write it, add a
  `CREATE TABLE IF NOT EXISTS` for it right before the ALTER, mirroring the defensive
  self-create pattern the API uses for the Ombor tables.
- Guard test: `artifacts/api-server/test/fresh-db-boot.test.ts` spins up a throwaway
  Railway DB (`topmart_freshboot_test_<pid>`), runs bot `init_db()` then API `initDb()`,
  asserts a schema manifest covering ALL route groups, smoke-GETs one+ endpoint per
  group (mounted without auth middleware; pino-http supplies `req.log`), and runs a
  raw-in→receive→read flow. Remote Railway latency is high — the bot init alone is
  ~16s, full setup ~32s, so the `beforeAll`/`afterAll` hooks need explicit long
  timeouts (120s/60s) and the whole file runs ~80s. Vitest file isolation keeps the
  `@workspace/db` singleton from leaking the temp connection into other suites.
- Fastest way to find gaps: diff `information_schema.columns` of a fresh-init DB vs the
  live DB. That surfaced never-created sale_payments/sale_events/sales_products/
  sales_product_tiers, missing sales.currency/payment_type/paid_amount/debt_amount,
  customers.deleted_at, and a `sales.product NOT NULL` mismatch (API inserts without
  product — needed `DROP NOT NULL` in init).

## Local Neon DB suspends during Railway-only stretches of the test suite

The api-server vitest suite has a long stretch (distribution-fresh-db +
fresh-db-boot, ~110s) that talks ONLY to throwaway Railway DBs. During that
gap the local Replit dev Postgres (Neon, scale-to-zero) can suspend; the next
schema-isolated local-DB test files (ombor-weight, raw-in, flow-raw-in) then
flake with wake-up connect errors: `pool.connect()` rejects OUTSIDE the route
try-block → Express 5 renders the default HTML error page → tests report
`SyntaxError: Unexpected token '<', "<!DOCTYPE"` plus cascading zero/stale
assertions. Failures hop between files run-to-run.

**Fix in place:** `artifacts/api-server/test/global-setup.ts` (vitest
`globalSetup`) pings the local `DATABASE_URL` with a fresh connection every
10s for the whole run.

**How to apply:** if these local-DB tests flake again with HTML-instead-of-JSON
errors, suspect DB suspend/connect instability first, not test logic. Never
kill a full-suite vitest run via bash timeout — orphaned runs clobber the
fixed-schema tests of concurrent runs (use the api-tests workflow instead).
