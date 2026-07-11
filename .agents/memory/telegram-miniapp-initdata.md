---
name: Telegram Mini App initData delivery
description: Why Mini App auth fails with missing initData and how to diagnose it
---

Rule: serve `telegram-web-app.js` from the app's own origin (public dir), never from `https://telegram.org/js/...`.

**Why:** Some ISPs (notably in Uzbekistan) block telegram.org over HTTPS. If the script fails to load, `window.Telegram` is undefined even inside the real Telegram mobile app, the client sends no `X-Telegram-Init-Data` header, and the server returns 401 — looking exactly like "opened outside Telegram".

**How to apply:** keep a local copy in the artifact's `public/` and reference it root-absolute in index.html (Vite rebases it with the base path at build). 

**Diagnosis tip:** in server logs, a 401 with ~2ms response time means the initData header was absent (early return); a slower 401 means HMAC/agent-lookup failed. A synthetic HMAC-signed initData (secret = HMAC("WebAppData", bot_token)) curl'ed against prod distinguishes server config problems from client-side delivery problems.

Also: initData is signed by the bot the app was opened from — the server's validation token must belong to that exact bot (getMe on the token shows the username).
