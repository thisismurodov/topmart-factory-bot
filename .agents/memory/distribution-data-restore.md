---
name: Distribution data restore paths
description: How to recover deleted distribution-schema data (shops/sales) and how the blok role behaves.
---

**Rule:** The distribution bot's admin "agent full delete" flow cascades and permanently wipes the agent's dokonlar + savdolar + nasiya + routes from Postgres. The only recovery sources are the old SQLite snapshots in `attached_assets/topmart_*.db` (July 2026 era) — DISTRIBUTION_DATABASE_URL (the old separate PG) is empty.

**Why:** Two former agents' 101 shops were cascade-deleted; they were restored (2026-07-15) into `distribution.dokonlar` from the newest SQLite snapshot, keeping original ids (no collisions with the live id set) and `setval`ing `dokonlar_id_seq`.

**How to apply:**
- Before any destructive distribution-data op, snapshot affected tables into an in-DB backup schema (`CREATE TABLE backup.x AS SELECT ...`) — local `pg_dump` (v16) fails against the Railway server (v18) with version mismatch.
- To show a former agent's name in dashboard joins WITHOUT granting bot/field access, insert a `distribution.users` row with `role='blok'`: main_kb gives blok an empty keyboard, field auth requires agent/supervisor/admin, dashboard agent dropdowns filter to agent/supervisor.
- Restored stale shops legitimately flood "lost shops"/COLD heatmap reports (old last_order_date) — expected, warn the user.
