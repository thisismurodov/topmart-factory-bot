---
name: Bot user-facing timestamps are Tashkent fixed +5
description: Railway container and Railway PG both run UTC; any bot-rendered date/time (labels, receipts, reports) must convert explicitly.
---

Rule: everything the factory/distribution bot renders for humans (labels, receipts, AI reports) must convert timestamps to Asia/Tashkent explicitly. Uzbekistan is permanently UTC+5 (no DST), so use `timezone(timedelta(hours=5))` — NOT `zoneinfo.ZoneInfo("Asia/Tashkent")`, because slim Docker images may lack tzdata and ZoneInfo raises at import/lookup time in prod only.

**Why:** Railway container TZ and Railway PG both run `Etc/UTC`. `datetime.now()` on the server is UTC-naive; `timestamptz` rows come back UTC-aware. During the 100×80 label redesign (Aug 2026) review caught that reprints stamped "now" instead of the batch's original time, and that entry-time stamps were silently UTC (5h early).

**How to apply:**
- Rendering a stored `created_at` (aware): `ts.astimezone(TASHKENT_TZ).replace(tzinfo=None)`.
- Stamping "now": `datetime.now(TASHKENT_TZ).replace(tzinfo=None)`.
- Reprint/re-render paths must pass the ORIGINAL event time through, or the artifact's identity (e.g. barcode `SKU-YYYYMMDD-HHMM`) drifts on every reprint.
- SQL-side the codebase already uses `(col AT TIME ZONE 'Asia/Tashkent')::date` for day boundaries — prefer that in queries; note some older queries (`get_today_batches`) still use UTC `CURRENT_DATE` day boundary.
