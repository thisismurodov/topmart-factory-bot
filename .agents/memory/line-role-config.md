---
name: Per-line role config
description: line_role_config table and how per-line roles/rates/maxWorkers work across API and dashboard.
---

## Rule
Each production line can have its own set of roles, rates, and max worker counts stored in `line_role_config(line_id, role_key, label, rate, max_workers)`.

**Why:** Different lines have 2–4 roles (not always the 3 standard ones) and different rates per kg.

## How to apply

- **DB**: `CREATE TABLE IF NOT EXISTS line_role_config` in both `api-server/src/index.ts` (initDb) and `bot/database.py` (init_db). Idempotent. ON DELETE CASCADE from production_lines.
- **day-status**: Fetches `line_role_config` in the same `Promise.all`; builds per-line rate maps; falls back to global `payroll_role_rates` when no line config exists. Response includes `roles[]` per line — Zod parse is **skipped** (`res.json(...)` directly) so the extra field passes through.
- **close-day**: For each line queries `line_role_config WHERE role_key != 'producer'`; if empty falls back to `preparation`+`packaging` with global rates. Handles ANY role key, not just hardcoded two.
- **add-worker**: Checks `line_role_config.max_workers` first; falls back to `ROLE_MAX` constant; rejects unknown roles only if neither source has it.
- **New API routes** (raw, no codegen): `GET /payroll/line-configs`, `POST/PATCH/DELETE /payroll/lines/:id/roles`, `PATCH /payroll/lines/:id` (rename).
- **Dashboard**: `LineStatus.roles?: LineRoleStatus[]` extended type; `LineCard` renders dynamically from `line.roles` (grid cols: 2→sm:2, 3→md:3, 4+→xl:4); `LineConfigDialog` (⚙️ button) handles add/edit/delete roles + rename; `globalRoleMembers` is `Map<roleKey, Set<string>>` not 3 separate sets.
