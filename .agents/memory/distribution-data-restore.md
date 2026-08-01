---
name: Distribution data restore paths
description: How to recover deleted distribution-schema data (shops/sales) and how the blok role behaves.
---

**Rule:** The distribution bot's admin "agent full delete" flow cascades and permanently wipes the agent's dokonlar + savdolar + nasiya + routes from Postgres. The only recovery sources are the old SQLite snapshots in `attached_assets/topmart_*.db` (July 2026 era) — DISTRIBUTION_DATABASE_URL (the old separate PG) is empty.

**Why:** Cascade-deleted shops have already had to be restored once from the SQLite snapshots; without them the data is unrecoverable. When restoring, keep original ids if free and `setval` `dokonlar_id_seq` afterwards.

**How to apply:**
- Before any destructive distribution-data op, snapshot affected tables into an in-DB backup schema (`CREATE TABLE backup.x AS SELECT ...`) — local `pg_dump` (v16) fails against the Railway server (v18) with version mismatch.
- To show a former agent's name in dashboard joins WITHOUT granting bot/field access, insert a `distribution.users` row with `role='blok'`: main_kb gives blok an empty keyboard, field auth requires agent/supervisor/admin, dashboard agent dropdowns filter to agent/supervisor.
- Restored stale shops legitimately flood "lost shops"/COLD heatmap reports (old last_order_date) — expected, warn the user.

## 2026-08-01 katta tozalash
- User buyrug'i bilan faqat 2 agent qoldirildi: Navro'zbek (tg 1045077572, role=agent) va Navruzbek Test (tg 8991328594, role=delivery — rolini O'ZGARTIRMA, delivery bot oqimi buziladi; dashboard endi savdosi bor userlarni roldan qat'i nazar ko'rsatadi).
- Boshqa agentlarning savdo/tashrif/lokatsiya/pul_olish/delivery yozuvlari o'chirildi; BARCHA do'konlar saqlanib, boshqalarniki Navro'zbek hisobiga (agent_id) o'tkazildi.
- To'liq zaxira: Railway DB'dagi `dist_backup_20260801` sxemasi (15 jadval, tozalashdan OLDINGI holat). pg_dump ishlamaydi (server PG18 vs lokal pg_dump 16) — sxema-nusxa usulini ishlat.
