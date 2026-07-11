---
name: Distribution bot integration
description: How the standalone distribution Telegram bot was folded into this monorepo and onto the central Postgres.
---

# Distribution bot ↔ central Postgres

The distribution Telegram bot (originally a standalone SQLite single-file app, pyTelegramBotAPI/telebot) lives at `artifacts/distribution-bot/main.py` and runs against the SAME central ERP Postgres as everything else (`RAILWAY_DATABASE_URL`), inside a dedicated `distribution` Postgres schema.

## Key decisions
- **Single source of truth = existing factory ERP Postgres** (`RAILWAY_DATABASE_URL`). Distribution data is a separate *schema*, not a separate database. The separate Postgres that was briefly provisioned (`DISTRIBUTION_DATABASE_URL`) is NOT used.
- **Uzbek table names kept** (dokonlar, savdolar, savdo_tafsilot, nasiya, pul_olish, mijoz_balans, olmagan_dokonlar, revisitlar, agent_plans, delivery_agents, delivery_routes, users, mahsulotlar). Isolation is via the `distribution` schema, NOT renaming — the bot has ~234 queries referencing these names; renaming would be high-risk.
- **Date/time columns are TEXT (ISO-8601)**, mirroring the old SQLite storage, so data migrates 1:1 and the bot's `substr(created_at,1,7)` / `LIKE 'YYYY-MM%'` style filters keep working unchanged.

## Why a shim instead of rewriting 234 queries
`artifacts/distribution-bot/main.py` keeps a thin psycopg2 wrapper (`_Conn`/`_Cur`) returned by `get_db()`:
- translates qmark `?` → `%s`,
- escapes literal `%` → `%%` only when params are supplied (so `LIKE` params still work),
- auto-appends `RETURNING id` to plain INSERTs so `cursor.lastrowid` keeps working,
- every connection runs `SET search_path TO distribution, public`.
**Why:** lets the original SQLite-era query strings run under psycopg2 untouched. Only ~5 genuinely SQLite-specific spots were hand-converted (`INSERT OR IGNORE`→`ON CONFLICT DO NOTHING`, `sqlite_master`/`PRAGMA table_info`→`information_schema`, `SELECT changes()`→`cursor.rowcount`, one SQL `strftime`→`substr`).
**How to apply:** when touching bot SQL, write it qmark-style as before; do NOT hand-convert placeholders. Only reach for Postgres-specific syntax when a construct has no SQLite equivalent already handled by the shim.

## SQLite→Postgres SQL gotchas beyond placeholders
The shim handles paramstyle + lastrowid, but SQL *dialect* differences still leak through and the shim cannot catch them. Two classes bit us:
- **GROUP BY strictness.** SQLite lets you `SELECT` bare non-aggregated columns not in `GROUP BY`; Postgres rejects them unless they are functionally dependent — and Postgres recognizes functional dependency ONLY from a table's PRIMARY KEY. `GROUP BY u.telegram_id` (a UNIQUE col, not the PK) while selecting `u.name` FAILS; `GROUP BY d.id` (PK) selecting `d.nomi` is fine, but selecting a *joined* table's column still needs that column in GROUP BY. Fix: add every selected non-aggregated column (including joined-table cols) to GROUP BY.
- **`GROUP_CONCAT(expr, sep)` → `string_agg(expr::text, sep)`.** Postgres has no GROUP_CONCAT; also cast integer operands in a `||` chain to `::text` to be safe.
- **Unqualified column in `ON CONFLICT ... DO UPDATE SET col=col+?` is ambiguous in Postgres** (SQLite allows it). Qualify with the table name: `SET balans=mijoz_balans.balans+?` — valid in both dialects. This bit `update_balans_delta` (every nasiya sale touching a customer balance would have crashed).
**Why:** these parse fine as strings so the shim passes them straight through; they only fail at plan time in Postgres.
**How to apply:** when reviewing/adding bot SQL, grep case-INSENSITIVELY (`rg -i`) for `group_concat`, and audit every `GROUP BY` for bare columns — SQLite-era queries are routinely non-conformant.
- **Systematic guard now exists:** the fresh-DB test has an EXPLAIN sweep that AST-extracts every `execute()` SQL literal from bot sources (with `%s`→NULL substitution) and EXPLAINs each on the throwaway DB — verified to catch all four trap classes (ambiguous upsert, bare GROUP BY, GROUP_CONCAT, strftime). A 2026-07 full-sweep audit of all ~220 statements found zero remaining dialect errors. Caveat: NULL params can't catch wrong-typed *parameters* (e.g. int param into a TEXT column) — only real-execution e2e tests catch those.

## Fresh-DB guard
`artifacts/api-server/test/distribution-fresh-db.test.ts` (runs inside the `api-tests` validation step) creates a throwaway DB, brings `distribution` up via the REAL bot `main.init_db()` (python3 subprocess, dummy token — importing main.py is side-effect-free), auto-extracts every table name from main.py SQL (case-SENSITIVE FROM/JOIN/INTO/UPDATE regex — case-insensitive matches Python `from x import`), asserts a column manifest, asserts `users` column ORDER (bot indexes `SELECT *` rows positionally, u[3]=role), and runs a sale flow end-to-end through the shim. A green run is required before distribution-schema changes are safe.

## Schema source of truth
Drizzle mirror in `lib/db/src/schema/distribution.ts` (pgSchema `distribution`) and an idempotent DDL script `scripts/src/init-distribution.ts` (`pnpm --filter @workspace/scripts run init-distribution`). The bot's own `init_db()` runs the same CREATE SCHEMA + CREATE TABLE IF NOT EXISTS on startup, so it is self-sufficient on Railway.
**Drift guard:** `check-distribution-drift` (part of the `schema-drift` validation) runs bot `_INIT_DDL` and `init-distribution.ts` on TWO separate throwaway DBs (one DB would let IF NOT EXISTS mask the second DDL) and compares both against the Drizzle mirror at table+column level (name/type/nullability/default). Any new distribution table must be added in all three places AND to the script's TABLES map.

## Deploy / running notes
- Deploys on Railway as its own service (Dockerfile + railway.json + nixpacks.toml, mirroring the factory bot). reportlab PDF needs `fonts-dejavu-core`.
- Needs its OWN `TELEGRAM_BOT_TOKEN` (distinct from the factory bot's — two bots cannot share one token/polling). Hardcoded token fallback was removed; token is env-only.
- Do NOT run it as a Replit dev workflow with the factory token — polling would conflict.

## Migration status
- One-time SQLite→Postgres data migration COMPLETED 2026-07-11 (452 rows across all 13 tables, IDs preserved, sequences reset via setval). Do NOT re-run — any migration script must guard on non-empty target tables.
- Snapshot caveat: the old SQLite bot on Railway may still be live and writing; records created after the backup exist only in SQLite until the user switches Railway to the monorepo Postgres bot.
- Dashboard "Distribution" section + read-only API routes are built and live.
