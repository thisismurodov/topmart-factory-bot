---
name: Deploy DB topology (Replit + Railway)
description: How the Replit deployment, dev, and Railway databases relate, and why publish-time migrations are harmless.
---

# Deployment database topology

The app runs in three places that resolve their database differently:

- **Runtime connection** (`lib/db/src/index.ts`) uses `RAILWAY_DATABASE_URL || DATABASE_URL`. `RAILWAY_DATABASE_URL` is a **global secret** (present in dev AND Replit production), so both the dev API and the Replit deployment connect to **Railway** — the real data + the real admin account live there.
- **Railway services** (bot + api) don't set `RAILWAY_DATABASE_URL`; they fall back to Railway's injected `DATABASE_URL`. Same Railway DB. Correct everywhere.
- **`drizzle.config.ts` intentionally stays on `DATABASE_URL`** (the Replit-managed Helium DB, which is near-empty/unused). So Replit publish-time migrations (incl. any scary `truncate ... cascade`) hit that empty Replit DB, **never Railway**.

**Why:** This split is the safety property. Pointing `drizzle.config` at Railway would let `drizzle-kit push` DROP bot-only columns/tables not in the Drizzle schema (e.g. `customers.deleted_at`, `sales.currency/payment_type/paid_amount/debt_amount`, and tables like `salary_payments`, `inventory`, `sale_*`). Keep migrations off Railway.

**How to apply:** During Replit publish, the DB-migration step is harmless — it only edits the empty Replit DB. Don't repoint `drizzle.config` at Railway "to fix" the migration warning. If schema sync to Railway is ever truly needed, model the bot-only columns/tables in Drizzle first, or use `tablesFilter`, and review the SQL for DROP/TRUNCATE before applying.

## Distribution bot Railway topology
- The distribution bot deploys in a SEPARATE Railway project from the central Postgres (which lives in the factory-bot project). The distribution project's own Postgres is a decoy — pointing the bot at it silently yields an empty fresh schema (init_db is idempotent, no errors, bot "works" but sees no data).
- Cross-project DB access needs the central Postgres `DATABASE_PUBLIC_URL` (proxy host), set as `RAILWAY_DATABASE_URL` on the bot service — that env name also switches the bot's psycopg2 layer to sslmode=require.
- To verify which DB a deployed bot is actually on: check `pg_stat_activity` on the central DB — the bot's ThreadedConnectionPool keeps ≥1 idle connection; absence means it's connected elsewhere.

## Backups / ops
- Railway runs Postgres **server 18**; the sandbox `pg_dump` is **16** → `pg_dump` aborts with "server version mismatch". For ad-hoc backups before destructive ops, dump via `psql "$RAILWAY_DATABASE_URL" -c "\copy (SELECT * FROM <t>) TO '<file>.csv' CSV HEADER"` (works across versions). Railway is external — Replit checkpoints do NOT cover it, so back up Railway data yourself before any TRUNCATE/DELETE.
- Transactional vs config split (for "reset to real data" requests): transactional = `batches`, `salary_entries`, `salary_payments`, `daily_payroll_runs`, `inventory`, `stock_movements` (+ zero `raw_materials.current_stock`). Config to PRESERVE = `workers`, `products`, `production_lines`, `line_role_config`, `production_line_workers`, `warehouses`, `raw_materials` defs, `product_materials` (BOM), price tiers, `customers`, all `sale*`. `inventory`/`stock_movements` are finished-goods only; raw stock lives in `raw_materials.current_stock`.

## Login facts
- Production URL: `factory-bot-manager.replit.app` (autoscale). The real admin account lives on Railway; token-based login verified working against prod (do NOT store the actual credentials here).
- `admin` user is a **stale artifact in the Replit dev DB only** (old seed); it does not exist on Railway. Seeing `admin` when querying `DATABASE_URL` directly does NOT mean the app uses that DB.
- Autoscale cold starts / restarts emit transient 5xx (e.g. `healthcheck ... 500`) and can make a login attempt fail momentarily; the dashboard now retries these (login.tsx + layout.tsx useGetMe) and only logs out on a true 401. Retry after the instance is warm before assuming a real auth bug.
