# TopMart Factory Bot

Arqon ishlab chiqarish zavodi uchun Telegram bot — partiyalarni kiritish, nazorat qilish va KPI hisoblash tizimi.

## Run & Operate

- `cd artifacts/telegram-bot && python3 main.py` — botni ishga tushirish (Workflow: "TopMart Factory Bot")
- `pnpm --filter @workspace/api-server run dev` — API server (port 5000)
- `schema-drift` validation: `check-schema-drift` (factory: bot init_db + API initDb ↔ Drizzle; ustunlar + CHECK/UNIQUE constraint'lar — Drizzle sxema `drizzle-kit push` bilan ikkinchi throwaway bazaga qo'llanib pg katalog orqali solishtiriladi) HAMDA `check-distribution-drift` (distribution: bot `_INIT_DDL` ↔ `init-distribution.ts` ↔ `lib/db/src/schema/distribution.ts`, uch nusxa ham throwaway bazalarda solishtiriladi)
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
- `artifacts/field/` — TopMart Field Assistant: yetkazib beruvchi agent uchun Telegram Mini App (`/field`); React+Vite+Leaflet, wouter sahifalar: `/` (start), `/map`, `/drive`, `/visit/:id(/sale|/nosale)`, `/summary`
- `artifacts/api-server/src/routes/field.ts` — Mini App REST API (`/api/field/*`), auth: `middleware/telegramInitData.ts` (initData HMAC + dev bypass)
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
- Distribution "Savdo markazi" sahifasi (dashboard `/distribution`): KPI kartalar + kombinatsiyalangan filtr paneli (sana presetlari, agent, viloyat→tuman, to'lov turi, mahsulot, qidiruv) URL query paramlarda saqlanadi (wouter, replace:true). Tablar: Savdolar (jadval), Agentlar/Do'konlar (kartochkalar), Nasiya, Marshrut (delivery_routes, kun=1..7 isoweekday). Do'kon drill-down Sheet drawer (`/api/distribution/shops/:id`). Sana presetlari Asia/Tashkent kalendarida hisoblanadi (Intl en-CA), backend `substr(created_at,1,10)` TEXT ISO ustunlarda filtrlaydi.
- Mahsulotlar sahifasida "Savdo bot mahsulotlari" bo'limi (`SalesBotProductsSection.tsx`): `distribution.mahsulotlar` katalogi dashboard'dan boshqariladi — `GET/POST/PATCH /api/distribution/products` (soft delete `faol=0`, bot bilan bir xil semantika; POST nofaol dublikatni qayta faollashtiradi) + `POST /api/distribution/products/sync-to-erp` yetishmayotgan bot mahsulotlarini `public.products`ga nusxalaydi (narx → UZS sotuv narxi). Nom solishtirish normalizatsiya bilan (apostrof variantlari + bo'shliqlar); `faol=1`ga qaytarishda dublikat-faol himoyasi (409). ERP va savdo bot kataloglari alohida jadvallar — to'liq birlashtirish keyinroq mumkin.
- Marshrut tabida haftalik xarita (`RouteWeekMap.tsx` + `GET /api/distribution/route-map?agentId=`): har hafta kuni o'z rangida polyline+tartib markerlar (juma=5 dam — ma'lumot yo'q), chiziqlar (kun,agent) bo'yicha guruhlangan; hech bir faol agentning marshrutiga kirmagan do'konlar kulrang nuqta (nofaol holat chiqarilmaydi); legenda chiplari kunni yoqish/o'chirish; agentId=delivery_agents.id (telegram_id EMAS); tooltip matni MapTab `esc()` bilan qochiriladi. Map v2: jonli GPS markerlar `liveMarkersRef` + `setLatLng` bilan silliq siljiydi (`.tm-live-marker` CSS transition), LIVE badge chip, tez zoom tugmalari (Home/Truck/Crosshair), cluster rangi ichidagi markerlarning dominant status rangiga moslashadi (`tmColor` marker option + `color-mix`).
- AI Zavod Yordamchisi: barcha LLM chaqiruvlari Node API'da (`/api/ai/*`); bot (Python) + dashboard faqat shu endpointlarni chaqiradi. Daily-analysis kuniga bir marta hisoblanadi va `ai_analysis_runs` jadvaliga saqlanadi (refresh=1 qayta hisoblaydi). Bot/dashboard `x-internal-key`/`Bearer` bilan kiradi (`requireAuthOrInternalKey`). Daily model `gpt-5.4`, packer-tip `gpt-5-mini` (`reasoning_effort: minimal`, aks holda reasoning tokenlari budjetni yeb tip bo'sh chiqadi).

- Field Assistant navigatsiya: 4 tugma QAYTARILDI — Yandex asosiy (katta, radar/kamera uchun) + Google/Waze/Apple grid (`NavButtons.tsx`). Sprint v1.1 talabi bo'yicha 2026-07-15 da qayta tiklandi (o'sha kuni ertalab faqat-Yandex qilingan edi — REVERSAL). Dashboard `GeoNavLinks` o'zgarmagan.
- AI Route Planning v2: `artifacts/api-server/src/lib/routePlanner.ts` — balanced k-means klasterlash + multi-start nearest-neighbor + 2-opt + Or-opt + uncross loop (kesishishlar 0 bo'lguncha); `splitOutliers` mediandan 60km+ uzoq GPS'li do'konlarni chiqarib tashlaydi (`badCoord[]` sifatida qaytadi). KPI'lar (`computeRouteStats`): `driveMinutes` FAQAT harakat vaqti (km/25), `visitMinutes` (n×5), `totalMinutes`, `crossCount`, `backtrackPct`, `longJumps`, `avgHopKm`, `maxHopKm`, `efficiency`, `score` — UI vaqt ko'rsatishda `totalMinutes` ishlatilsin. `validatePlan()` saqlashdan OLDIN tekshiradi (dublikat/yo'qolgan do'kon/tartib uzilishi/kesishish → 422, saqlanmaydi; long jump/past score → warning); har javobda `validation` maydoni. `POST /api/distribution/route-plan` (auth wall ortida): `{viloyat, agentId, dryRun?, replace?}` — dryRun=preview, replace'siz mavjud marshrut bo'lsa 409. Saqlash tranzaksiyada (DELETE+INSERT). Limit: maks 6 kun × ~28 do'kon (~168 do'kon/viloyat). `route-map` endpoint `routeStats[]` (barcha yangi KPI'lar bilan) va `allAgents[]` qaytaradi. UI: `RoutePlanDialog.tsx` (kunlik KPI qatorlar + validation panellari), `RouteWeekMap.tsx` (yo'nalish strelkalari, start yashil / finish qora halqa, bugungi marshrut qalin + birinchi to'xtash pulsatsiya, chiplarda ⚡eff% + ✂️cross). Eslatma: score kalibrovkasi qattiq — tarqoq qishloq hududlarida 41-85 normal, zich shaharda 95+ chiqadi; adolatli taqqoslash metrikasi = km.
- Marshrut limiti: har kun uchun maksimum 25 ta dokon (2026-07-15 da 20→25 ko'tarilgan; bot `main.py` da hardcoded)
- Field Assistant Offline First v1.0 (2026-07-15): biznes-ma'lumotlar uchun Service Worker YO'Q — hammasi IndexedDB (`idb` paketi, `lib/idb.ts`: events/snapshots/meta/tiles do'konlari). Yozuvlar avval `lib/eventQueue.ts` navbatiga tushadi (envelope: eventId=clientOpId — server `field_ops.client_op_id` UNIQUE bilan bir xil UUID), keyin `lib/syncEngine.ts` yuboradi. Xato siyosati: 400/404/422→`failed` (Sync Center'da KO'RINADI, jim o'chirilmaydi); 401/403→pending+60s; tarmoq/5xx→eksponensial backoff (cap 5min, cheksiz retry). FIFO: birinchi backoff'dagi hodisada butun navbat to'xtaydi (to'lovlar tartibi buzilmasin). Boot sync manual rejimda (backoff'ni chetlab o'tadi — yangi initData). IDB ishlamasa localStorage zaxirasi to'g'ridan-to'g'ri flush qilinadi. react-query keshi IDB'ga persist (`lib/queryPersister.ts`, maxAge 24h, buster "offline-v1"). Crash recovery: oxirgi sahifa meta'dan tiklanadi (whitelist). Xarita plitkalari IDB'da cache-first (`lib/tileCache.ts` LRU 3000 + `OfflineTileLayer.tsx`), marshrut bbox z12-15 kuniga bir prefetch (cap 700). Sync Center: `/sync`. Testlar: `pnpm --filter @workspace/field run test` (vitest + fake-indexeddb, 14 test).
- Field Assistant (Mini App): auth — `X-Telegram-Init-Data` header HMAC bilan tekshiriladi (`DISTRIBUTION_BOT_TOKEN` kaliti; factory `TELEGRAM_BOT_TOKEN` EMAS). Dev bypass: `NODE_ENV!==production` VA `FIELD_DEV_BYPASS=1` bo'lsa `X-Field-Dev-Id` header (klient `?dev_tg=` query paramdan oladi, faqat `import.meta.env.DEV`). Dev'da `?kun=1..7` bilan boshqa kun marshrutini ko'rish mumkin. `fieldRouter` routes/index.ts'da BARCHA auth wall'lardan oldin mount qilinadi (path'siz `router.use(middleware, ...)` hamma so'rovga qo'llanadi!). Idempotentlik: `field_ops.client_op_id` UNIQUE — offline queue takror yuborsa `duplicate:true`. Juma (kun=5) — dam kuni (2026-07-12 da yakshanbadan ko'chirildi; API field.ts `kun===5` + bot `_today_kun()` sinxron bo'lishi shart). Distribution bot "🗺 BOSHLASH" web_app tugmasi `FIELD_APP_URL` (env yoki `https://$REPLIT_DEV_DOMAIN/field/`).

## Required env vars

- `DATABASE_URL` — PostgreSQL connection string
- `TELEGRAM_BOT_TOKEN` — Telegram bot tokeni (@BotFather)
- `SESSION_SECRET` — Express session secret
- `AI_INTERNAL_KEY` — bot↔API ichki autentifikatsiya kaliti (bot va API'da bir xil bo'lishi shart)
- `API_BASE_URL` — bot uchun API manzili (`https://<api-host>/api`). Replit'da default `http://localhost:80/api`
- `AI_HOUR` — kunlik AI tahlil yuboriladigan soat (0-23, Asia/Tashkent). Standart: 20
- `AI_INTEGRATIONS_OPENAI_*` — Replit AI integration o'zgaruvchilari. Railway deploy'da bot+API servislarida ham bo'lishi kerak
- `DISTRIBUTION_BOT_TOKEN` — API serverda Mini App initData'ni tekshirish uchun distribution bot tokeni (productionda majburiy)
- `FIELD_DEV_BYPASS` — faqat dev: `1` bo'lsa `X-Field-Dev-Id` bypass yoqiladi (productionda hech qachon qo'yilmasin)
- `FIELD_APP_URL` — distribution bot uchun Mini App manzili (default: `https://$REPLIT_DEV_DOMAIN/field/`)

## User preferences

- Har bir task yakunidagi hisobotga qo'shilsin: Business Impact (★1-5), Technical Risk (★1-5), Estimated User Value (★1-5), Future Dependency (Yes/No).
- Roadmap ustuvorligi (2026-07-11): #69 → #70 → #62, keyin #66, #65, #64, #63, #72, #73. #69+#70 "Distribution Intelligence" epic sifatida ketma-ket bajarilsin.

## Gotchas

- `psycopg2-binary` paketi `.pythonlibs/` papkasida (uv virtual env)
- Bot `workers_config`/`products_config` (SQLite eski nom) o'rniga `workers`/`products` (PostgreSQL) ishlatadi
- `salary_payments` jadvalida `worker` ustuni (SQLite'dagi `worker_name` emas)
- `db_meta` jadvalini Drizzle boshqarmaydi — bot yaratadi; Railway uchun ham kerak
- Ishlab chiqaruvchi yoki mahsulot qo'shish: dashboard yoki `bot/config.py` `SEED_WORKERS`/`SEED_PRODUCTS`

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
