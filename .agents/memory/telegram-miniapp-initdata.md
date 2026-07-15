---
name: Telegram Mini App initData delivery
description: Why Mini App auth fails with missing initData and how to diagnose it
---

Rule: serve `telegram-web-app.js` from the app's own origin (public dir), never from `https://telegram.org/js/...`.

**Why:** Some ISPs (notably in Uzbekistan) block telegram.org over HTTPS. If the script fails to load, `window.Telegram` is undefined even inside the real Telegram mobile app, the client sends no `X-Telegram-Init-Data` header, and the server returns 401 — looking exactly like "opened outside Telegram".

**How to apply:** keep a local copy in the artifact's `public/` and reference it root-absolute in index.html (Vite rebases it with the base path at build). 

**Diagnosis tip:** in server logs, a 401 with ~2ms response time means the initData header was absent (early return); a slower 401 means HMAC/agent-lookup failed. A synthetic HMAC-signed initData (secret = HMAC("WebAppData", bot_token)) curl'ed against prod distinguishes server config problems from client-side delivery problems.

Also: initData is signed by the bot the app was opened from — the server's validation token must belong to that exact bot (getMe on the token shows the username).

Rule: launch Mini Apps from an INLINE keyboard button (`InlineKeyboardButton(web_app=...)` on a message), not only from a reply-keyboard `KeyboardButton(web_app=...)`.

**Why:** official iOS Telegram sometimes launches reply-keyboard web_app buttons with NO `tgWebAppData` in the location hash (hash has only tgWebAppVersion/platform/themeParams) → `WebApp.initData` is empty → server 401 even though the app runs in a genuine Mini App context. Inline-button launches reliably deliver initData.

**How to apply:** send a separate message carrying an InlineKeyboardMarkup web_app button wherever the delivery menu is shown (reply markup cannot hold inline buttons). Diagnose by printing hash param NAMES (never values — tgWebAppData's value is the signed user payload).

Rule: Field Mini App auth is anchored on `delivery_agents.telegram_id`; agent/supervisor/admin users without a delivery row authenticate via a users-table fallback with an id=0 sentinel (routes empty, writes key on telegramId).

**Why:** routes live only in delivery_routes (keyed to delivery_agents.id). A person can be BOTH a savdo agent (users.role) and a delivery agent (delivery_agents row) — the bot's /start auto-link must NOT demote agent/supervisor roles to 'delivery', or they lose their agent menu.

**How to apply:** to give an existing agent Mini App routes, link their delivery_agents.telegram_id; never insert with the id=0 sentinel into route tables.
