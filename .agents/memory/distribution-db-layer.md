---
name: Distribution bot PostgreSQL layer
description: Rules for the distribution bot's native psycopg2 database/ package after the SQLite shim removal
---

# Distribution bot database layer

- All SQL is native PostgreSQL: `%s` params, `RETURNING id` (never `.lastrowid`). An AST-based guard test in `artifacts/api-server/test/distribution-fresh-db.test.ts` fails the suite if `?` placeholders or `.lastrowid` reappear in `main.py` or `database/*.py`.
- **Why:** the SQLite→psycopg2 shim was fully removed (Phase 2 spec). Blind regex `?`→`%s` rewrites are unsafe — Uzbek UI strings contain `?`; use AST (string literals inside `.execute()` calls) plus a check for dynamically-assembled `=?` fragments (`_scope_clause`-style helpers and `IN (...)` placeholder builders were missed by the literal-only pass).
- Handlers read DB rows positionally (`u[3]` = role) — domain modules must return raw tuples, not dicts.
- `main.py` must keep re-exporting `get_db`/`init_db`/`get_user`/`get_balans`/`update_balans_delta` (the fresh-db test drives them via `import main`).
- Connection lifecycle: `PooledConnection.close()` → putconn (with rollback); `__del__` is a GC safety net against pool-slot leaks from handlers that raise before close.
- Global error policy: `SafeTeleBot.message_handler` wrapper catches `DatabaseUnavailable`/`psycopg2.Error`, logs, sends a friendly Uzbek message; scheduler loop wraps `run_pending()` so a DB blip can't kill the thread.

## Telegram reply keyboard limiti
- ReplyKeyboardMarkup ~10KB dan oshsa send_message jimgina 400 bilan yiqiladi — agent "bot ishlamayapti" deb ko'radi. 256 dokonli ro'yxat ~15KB bo'lgan edi.
- Yechim: SAVDO_KB_MAX (80) dan oshsa viloyat→hudud bosqichli tanlov (_viloyat_kb/_hudud_kb/_dokon_in_hudud_kb — rt_ marshrutdagi bilan bir xil helperlar).
- Dokon tanlashda _savdo_dokon_ruxsat: bosh agent faqat o'z dokonini tanlaydi; delivery/admin uchun faqat faollik tekshiriladi (marshrut dokonlari boshqa agentga biriktirilgan).
