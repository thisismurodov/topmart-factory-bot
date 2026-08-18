---
name: Telegram inline index-callbacks need a keyboard nonce
description: Index-based callback_data must be bound to the emitting keyboard via a short token, or stale messages silently select wrong items.
---

**Rule:** When inline-keyboard `callback_data` is an index into a list stored in `user_data`, the callback must also carry a short per-keyboard nonce (`prefix:token:idx`), and the store must be `(token, list)`. Resolve only on token match; mismatch → "Tugma eskirgan" guard, never a lookup against the newest list.

**Why:** Bounds checks alone cannot detect a *stale but in-range* index. With `allow_reentry=True` a user can open a second list with the same prefix, then tap an older message — the old index resolves against the new list and silently picks the WRONG product. For inventory movements that corrupts stock. Caught by architect review of the factory-bot kirim UX change (2026-08-18).

**How to apply:** Factory bot `bot/handlers/inventory.py` — `_product_inline(products, prefix, token)`, `_new_plist_token()` (6 hex chars), `_resolve_product_cb` with `_PLIST_CB_RE`. Backward compat: payloads not matching `^[0-9a-f]{6}:\d+$` are treated as legacy *name* callbacks (pre-publish messages), so digit-only or colon-containing product names still resolve as names. Keep callback ≤64 bytes (token form is ~13B). Any new index-based keyboard flow (bot or elsewhere) must copy this pattern.
