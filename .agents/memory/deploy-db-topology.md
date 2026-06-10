---
name: Deploy DB topology (Replit + Railway)
description: How the Replit deployment, dev, and Railway databases relate, and why publish-time migrations are harmless.
---

# Deployment database topology

The app runs in three places that resolve their database differently:

- **Runtime connection** (`lib/db/src/index.ts`) uses `RAILWAY_DATABASE_URL || DATABASE_URL`. `RAILWAY_DATABASE_URL` is a **global secret** (present in dev AND Replit production), so both the dev API and the Replit deployment connect to **Railway** — the real data + the real `thisismurodov` admin account live there.
- **Railway services** (bot + api) don't set `RAILWAY_DATABASE_URL`; they fall back to Railway's injected `DATABASE_URL`. Same Railway DB. Correct everywhere.
- **`drizzle.config.ts` intentionally stays on `DATABASE_URL`** (the Replit-managed Helium DB, which is near-empty/unused). So Replit publish-time migrations (incl. any scary `truncate ... cascade`) hit that empty Replit DB, **never Railway**.

**Why:** This split is the safety property. Pointing `drizzle.config` at Railway would let `drizzle-kit push` DROP bot-only columns/tables not in the Drizzle schema (e.g. `customers.deleted_at`, `sales.currency/payment_type/paid_amount/debt_amount`, and tables like `salary_payments`, `inventory`, `sale_*`). Keep migrations off Railway.

**How to apply:** During Replit publish, the DB-migration step is harmless — it only edits the empty Replit DB. Don't repoint `drizzle.config` at Railway "to fix" the migration warning. If schema sync to Railway is ever truly needed, model the bot-only columns/tables in Drizzle first, or use `tablesFilter`, and review the SQL for DROP/TRUNCATE before applying.

## Login facts
- Production URL: `factory-bot-manager.replit.app` (autoscale). Real login: `thisismurodov` / `topmart2026` (verified 200 against prod + Railway).
- `admin` user is a **stale artifact in the Replit dev DB only** (old seed); it does not exist on Railway. Seeing `admin` when querying `DATABASE_URL` directly does NOT mean the app uses that DB.
- Autoscale cold starts / restarts emit transient `healthcheck ... 500` and can make a login attempt fail momentarily; retry after the instance is warm before assuming a real auth bug.
