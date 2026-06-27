---
name: Dual init schema (bot + API)
description: Any table written at runtime must be created by BOTH the bot's init_db (Python) and the API's initDb (TS), or fresh DBs crash.
---

# Dual init schema must stay in sync

The schema is created at runtime in TWO independent places that must agree by hand:
- `artifacts/telegram-bot/bot/database.py` → `init_db()` (psycopg2 `CREATE TABLE IF NOT EXISTS`)
- `artifacts/api-server/src/init-db.ts` → `initDb()` (pg pool)

**Rule:** if either the bot or the API *writes* to a table, that table (and its
indexes/constraints) must be created in BOTH init paths. Whichever process runs
first on a brand-new DB must not hit `relation <x> does not exist`.

**Why:** `sale_items` was inserted by the bot's `create_sale()` and read by the
API but only ever created by the API's `initDb()`. On a fresh DB, if the bot
recorded a sale before the API booted, it crashed. (It only ever worked in prod
because long-gone code had made the table.) Same class of bug as the Ombor
warehouse tables.

**How to apply:** when adding a table or column used at runtime, add identical
DDL to both init paths, keep column types/defaults identical (e.g. sale_items:
quantity NUMERIC(12,3), unit_price NUMERIC(12,2), line_total NUMERIC(14,2),
currency default 'UZS'), and rely on the fresh-db-boot test + schema-drift
validation to catch divergence.
