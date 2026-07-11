---
name: Distribution free-text date/interval quirks
description: qaytish_sanasi is free-text (DD.MM.YY etc.) and avg_repeat_days is all zeros in real data — SQL must parse defensively and provide fallbacks.
---

# Distribution free-text date/interval quirks

Rules:

- `dokonlar.qaytish_sanasi` is TEXT filled by agents in mixed formats: `DD.MM.YYYY`, `DD.MM.YY` (2-digit year needs `'20'||yy`), and ISO. Never cast with `to_date`/`::date` directly — use regexp branch parsing to ISO text, else one bad row 500s the endpoint.
- Real production data has `avg_repeat_days = 0` for ALL shops, so any "overdue" logic keyed on avg must have a fallback branch (e.g. `avg<=0 AND days_since_last_order > 21`), otherwise the feature silently returns nothing.
- Aggregated map centroids can be NULL when a hudud's shops all lack coordinates (`latitude` nullable) — client types and loops must guard for null centroid.

**Why:** These are data-quality realities of the agent-entered distribution DB, not schema facts; features built on "clean" assumptions pass e2e on today's data and break later.

**How to apply:** Any new distribution analytics/SQL touching dates, repeat intervals, or coordinates must assume dirty/empty values and include fallbacks + null guards.
