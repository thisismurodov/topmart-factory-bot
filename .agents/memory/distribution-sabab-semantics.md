---
name: Distribution olmagan sabab semantics
description: Which column is canonical for no-sale reasons in distribution.olmagan_dokonlar and how to classify visit status.
---

Rule: `olmagan_dokonlar.sabab` (enum code from the bot's SABAB_MAP, e.g. `tovari_bor`, `narx_qimmat`) is the canonical no-sale reason; `sabab_text` is auxiliary display text and CAN be NULL. Never gate "visited but no order" logic on `sabab_text IS NOT NULL` — use row existence (or `sabab IS NOT NULL`).

**Why:** Map marker status originally used `sabab_text IS NOT NULL` to detect no-sale visits; code review rejected it because rows with a valid `sabab` code but NULL `sabab_text` silently fell through to visited/planned/none, breaking marker color semantics.

**How to apply:** Any status/visit classification over `olmagan_dokonlar` should use EXISTS on the row. Return both `sabab` and `sababText` to clients; the dashboard has `SABAB_LABELS`/`sababLabel()` (MapTab) to render the Uzbek label with fallback. Visit-status precedence used across map + route-progress: sold > nosale > visited(pul_olish) > planned(on route) > none. A regression test guards this (map status classification test in api-server, runs in the api-tests validation).
