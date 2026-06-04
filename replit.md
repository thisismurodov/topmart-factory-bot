# TopMart Factory Bot

Arqon ishlab chiqarish zavodi uchun Telegram bot — partiyalarni kiritish, nazorat qilish va KPI hisoblash tizimi.

## Run & Operate

- `cd artifacts/telegram-bot && python3 main.py` — botni ishga tushirish (Workflow: "TopMart Factory Bot")
- `pnpm --filter @workspace/api-server run dev` — API server (port 5000)
- Required env: `TELEGRAM_BOT_TOKEN` — Telegram bot tokeni (@BotFather orqali olinadi)

## Stack

- Python 3.11 + python-telegram-bot 20.7 + psycopg2-binary (bot)
- PostgreSQL (shared database — both bot and API use same DB)
- Node.js 24, TypeScript 5.9, Express 5, Drizzle ORM (API server)
- React + Vite + TanStack Query (dashboard)
- pnpm workspaces monorepo

## Where things live

- `artifacts/telegram-bot/main.py` — bot entry point
- `artifacts/telegram-bot/bot/config.py` — seed data, DATABASE_URL
- `artifacts/telegram-bot/bot/database.py` — psycopg2 PostgreSQL operatsiyalari
- `artifacts/telegram-bot/bot/keyboards.py` — Telegram tugmalari
- `artifacts/telegram-bot/bot/handlers/` — bot handlers
- `artifacts/api-server/src/routes/` — REST API (workers, products, batches, dashboard, salary, customers, sales, inventory)
- `lib/db/src/schema/` — Drizzle ORM schema (PostgreSQL)
- `artifacts/dashboard/src/pages/` — React sahifalar

## Architecture decisions

- PostgreSQL shared between bot (psycopg2) and API server (pg pool + Drizzle)
- Bot uses `init_db()` to create tables with IF NOT EXISTS — idempotent, safe to run alongside Drizzle
- Polling rejimi ishlatilgan (webhook emas) — Replit'da soddaroq
- Batch kodi: `XX-YYMMDD-NN` formatida
- `db_meta` table bot tomonidan yaratiladi (Drizzle sxemasida yo'q)
- Railway deploy: `artifacts/telegram-bot/Dockerfile` (bot), `artifacts/api-server/Dockerfile` (API)

## Required env vars

- `DATABASE_URL` — PostgreSQL connection string
- `TELEGRAM_BOT_TOKEN` — Telegram bot tokeni (@BotFather)
- `SESSION_SECRET` — Express session secret

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- `psycopg2-binary` paketi `.pythonlibs/` papkasida (uv virtual env)
- Bot `workers_config`/`products_config` (SQLite eski nom) o'rniga `workers`/`products` (PostgreSQL) ishlatadi
- `salary_payments` jadvalida `worker` ustuni (SQLite'dagi `worker_name` emas)
- `db_meta` jadvalini Drizzle boshqarmaydi — bot yaratadi; Railway uchun ham kerak
- Ishlab chiqaruvchi yoki mahsulot qo'shish: dashboard yoki `bot/config.py` `SEED_WORKERS`/`SEED_PRODUCTS`

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
