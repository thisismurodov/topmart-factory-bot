---
name: Shared-DB test schema contention
description: Why api-server test schemas must have unique per-run names on the shared Railway DB
---
The rule: every throwaway test schema/database in `artifacts/api-server/test/*` must include `${process.pid}_${Date.now()}` in its name.

**Why:** All environments (main agent + isolated task agents) share the same Railway Postgres server via `RAILWAY_DATABASE_URL`. When two validation runs execute the suite concurrently with FIXED schema names, each run's `DROP SCHEMA ... CASCADE` destroys the other's tables mid-test → "relation does not exist" during TRUNCATE and stale-value assertion failures that look like real regressions.

**How to apply:** When adding a new test file that creates a throwaway schema or DB, always suffix the name with pid+timestamp. If a run is hard-killed, orphan `topmart_*_test_*` schemas may leak on Railway — safe to drop manually.
