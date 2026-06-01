# TopMart Factory Bot

Arqon ishlab chiqarish zavodi uchun Telegram bot — partiyalarni kiritish, nazorat qilish va KPI hisoblash tizimi.

## Run & Operate

- `cd artifacts/telegram-bot && python3 main.py` — botni ishga tushirish (Workflow: "TopMart Factory Bot")
- `pnpm --filter @workspace/api-server run dev` — API server (port 5000)
- Required env: `TELEGRAM_BOT_TOKEN` — Telegram bot tokeni (@BotFather orqali olinadi)

## Stack

- Python 3.11
- python-telegram-bot 20.7 (polling rejimi)
- SQLite (ma'lumotlar bazasi: `artifacts/telegram-bot/data/topmart.db`)
- pnpm workspaces, Node.js 24, TypeScript 5.9 (API server uchun)

## Where things live

- `artifacts/telegram-bot/main.py` — bot entry point
- `artifacts/telegram-bot/bot/config.py` — ishlab chiqaruvchilar va mahsulotlar ro'yxati
- `artifacts/telegram-bot/bot/database.py` — SQLite operatsiyalari
- `artifacts/telegram-bot/bot/keyboards.py` — Telegram tugmalari
- `artifacts/telegram-bot/bot/handlers/start.py` — /start va asosiy menu
- `artifacts/telegram-bot/bot/handlers/input_handler.py` — Tovar kiritish oqimi (ConversationHandler)
- `artifacts/telegram-bot/bot/handlers/batches.py` — (start.py ichiga ko'chirilgan)

## Architecture decisions

- Polling rejimi ishlatilgan (webhook emas) — Replit'da soddaroq va ishonchli.
- ConversationHandler faqat "Tovar kiritish" oqimini boshqaradi; boshqa tugmalar oddiy MessageHandler'da.
- Batch kodi formati: `XX-YYMMDD-NN` (har bir ishlab chiqaruvchi uchun kunlik ketma-ket).
- SQLite fayl `data/` papkasida saqlangan — keyingi modullar uchun kengaytirish oson.
- Kod modulli tuzilgan: config, database, keyboards, handlers alohida fayllar — etiketka printer va KPI modul qo'shish oson.

## Product

- Telegram bot orqali arqon partiyalarini kiritish (ishlab chiqaruvchi + mahsulot + miqdor)
- Avtomatik partiya kodi generatsiyasi (AZ/GL/SH-YYMMDD-NN formatida)
- Bugungi partiyalar ro'yxatini ko'rish

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- `python-telegram-bot` paketi `.pythonlibs/` papkasida (uv virtual env).
- Bot ma'lumotlari `artifacts/telegram-bot/data/topmart.db` da saqlanadi (git ignore kerak).
- Ishlab chiqaruvchi yoki mahsulot qo'shish uchun `bot/config.py` faylini tahrirlang.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
