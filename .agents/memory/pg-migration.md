---
name: PostgreSQL migration from SQLite
description: Key decisions and gotchas when migrating TopMart bot + API from SQLite to PostgreSQL for Railway deployment
---

## Rules

1. **Table names changed**: `workers_config` → `workers`, `products_config` → `products`
2. **Column name**: `salary_payments.worker_name` (SQLite) → `salary_payments.worker` (PostgreSQL Drizzle schema)
3. **`db_meta` table**: Created only by bot's `init_db()`, NOT in Drizzle schema. Must be created manually on fresh PostgreSQL (e.g., `psql -c "CREATE TABLE db_meta ..."` or by running the bot once)
4. **Bot uses psycopg2**: `%s` placeholders, `RealDictCursor` for dict rows, context manager `get_conn()` yields `(conn, cur)`
5. **API uses pg Pool**: `pool.query(sql, [$1,$2,...])` with numbered params; all route handlers are `async`
6. **Unique constraint on salary_payments**: Added `UNIQUE (worker, year, month)` — allows `ON CONFLICT DO UPDATE` for upsert
7. **SQLite-specific syntax replaced**: `strftime('%Y-%m', ...)` → `TO_CHAR(..., 'YYYY-MM')`, `DATE(col)` → `col::date`, `datetime('now','-30 days')` → `NOW() - INTERVAL '30 days'`

**Why:** Railway deploys bot and API as separate containers — SQLite file cannot be shared. PostgreSQL is the only way to have a shared database between them.

**How to apply:** When adding new bot DB functions, use `%s` placeholders. When adding new API routes, import `pool` from `@workspace/db` and make handlers `async`. Run `pnpm --filter @workspace/db run push` after schema changes.
