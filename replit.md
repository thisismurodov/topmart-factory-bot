# TopMart Factory Bot

Arqon ishlab chiqarish zavodi uchun Telegram bot — partiyalarni kiritish, nazorat qilish va KPI hisoblash tizimi.

## Run & Operate

- `cd artifacts/telegram-bot && python3 main.py` — botni ishga tushirish (Workflow: "TopMart Factory Bot")
- `pnpm --filter @workspace/api-server run dev` — API server (port 5000)
- `pnpm --filter @workspace/api-server run test` — api-server vitest suite (fresh-DB boot guards for BOTH the factory side and the distribution bot's `distribution` schema). Registered as the `api-tests` validation step; requires `DATABASE_URL`/`RAILWAY_DATABASE_URL` (creates+drops throwaway DBs). Runs alongside `schema-drift` as an automated quality gate.
- Required env: `TELEGRAM_BOT_TOKEN` — Telegram bot tokeni (@BotFather orqali olinadi)

## Stack

- Python 3.11 + python-telegram-bot 20.7 + psycopg2-binary (bot)
- PostgreSQL (shared database — both bot and API use same DB)
- Node.js 24, TypeScript 5.9, Express 5, Drizzle ORM (API server)
- React + Vite + TanStack Query (dashboard)
- pnpm workspaces monorepo

## Where things live

- `artifacts/telegram-bot/main.py` — factory (production) bot entry point
- `artifacts/distribution-bot/main.py` — distribution (savdo/agent) bot; single-file telebot app on central Postgres `distribution` schema
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
- Railway deploy: `artifacts/telegram-bot/Dockerfile` (bot), `artifacts/api-server/Dockerfile` (API), `artifacts/distribution-bot/Dockerfile` (distribution bot)
- Distribution modul: bitta markaziy Postgres (`RAILWAY_DATABASE_URL`) ichida alohida `distribution` sxema. O'zbekcha table nomlari saqlangan; izolyatsiya sxema orqali. Bot TABIIY psycopg2 qatlamida ishlaydi (`artifacts/distribution-bot/database/` paketi): ThreadedConnectionPool (1-10), `%s` parametrlar, `RETURNING id`, `transaction()` contextmanager (savdo/to'lovlar all-or-nothing), `search_path=distribution,public` har ulanishda. SQLite shim OLIB TASHLANGAN — `?` placeholder yoki `.lastrowid` qaytsa `distribution-fresh-db.test.ts` dagi AST guard yiqiladi. `SafeTeleBot` barcha handlerlarda DB xatolarini ushlaydi (log + foydalanuvchiga o'zbekcha xabar, polling to'xtamaydi). Drizzle mirror: `lib/db/src/schema/distribution.ts`; DDL: `pnpm --filter @workspace/scripts run init-distribution`. Distribution botning O'ZINING `TELEGRAM_BOT_TOKEN`i bo'lishi shart (factory bilan bir xil token bo'lolmaydi — polling to'qnashadi).
- AI Zavod Yordamchisi: barcha LLM chaqiruvlari Node API'da (`/api/ai/*`); bot (Python) + dashboard faqat shu endpointlarni chaqiradi. Daily-analysis kuniga bir marta hisoblanadi va `ai_analysis_runs` jadvaliga saqlanadi (refresh=1 qayta hisoblaydi). Bot/dashboard `x-internal-key`/`Bearer` bilan kiradi (`requireAuthOrInternalKey`). Daily model `gpt-5.4`, packer-tip `gpt-5-mini` (`reasoning_effort: minimal`, aks holda reasoning tokenlari budjetni yeb tip bo'sh chiqadi).

## Required env vars

- `DATABASE_URL` — PostgreSQL connection string
- `TELEGRAM_BOT_TOKEN` — Telegram bot tokeni (@BotFather)
- `SESSION_SECRET` — Express session secret
- `AI_INTERNAL_KEY` — bot↔API ichki autentifikatsiya kaliti (bot va API'da bir xil bo'lishi shart)
- `API_BASE_URL` — bot uchun API manzili (`https://<api-host>/api`). Replit'da default `http://localhost:80/api`
- `AI_HOUR` — kunlik AI tahlil yuboriladigan soat (0-23, Asia/Tashkent). Standart: 20
- `AI_INTEGRATIONS_OPENAI_*` — Replit AI integration o'zgaruvchilari. Railway deploy'da bot+API servislarida ham bo'lishi kerak

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
