---
name: Worker name is denormalized across many tables
description: A worker's name is a value copied into several tables, not a single FK; renaming/deleting must account for all copies and must NOT be passed as a URL path param.
---

A worker's `name` is the PRIMARY KEY of `workers` AND is stored as a plain value in several other tables. Any feature that renames or deletes a worker must touch all of them, or it leaves orphaned history.

Known copies (audit before adding new ones):
- `workers.name` (PK)
- `batches.worker` (plain text history)
- `salary_payments.worker` (plain text; UNIQUE(worker, year, month))
- `packer_assignments.worker_name` (plain text)
- `packer_product_assignments.packer_name` — the ONLY real FK → `workers(name)`, `ON DELETE CASCADE`, **no `ON UPDATE CASCADE`**, UNIQUE(packer_name, product_name)
- `user_roles.worker_name` (bot chat_id → worker mapping; also has a `role` column the bot authorizes from)
- `stock_movements.created_by` — holds the worker NAME (bot writes `worker` here on batch IN movements), not a user id. Easy to miss.

Rename approach: copy → repoint → delete, all in ONE transaction.
Insert the new `workers` row first, UPDATE every copy from old→new (including `stock_movements.created_by` and `user_roles.role`), THEN delete the old row.
**Why:** the FK lacks `ON UPDATE CASCADE`, so a plain `UPDATE workers.name` would fail; and because of `ON DELETE CASCADE`, the old row must be deleted LAST (after children are repointed) or it cascade-deletes the packer rows.
**How to apply:** `SELECT ... FOR UPDATE` the current row; 404 if missing, 409 if the new name already exists. Sync `user_roles.role` so the bot's authorization matches the UI edit. Trim name/prefix/phone server-side.

NEVER identify a worker by URL path param. The bot auto-creates workers from Telegram display names, so names are routinely empty, `"."`, or contain `/ ? #` — and this edit feature exists precisely to fix those junk names. A name in the URL breaks: the browser normalizes `/api/workers/.` and an empty name both to `/api/workers/` → 404, and `/` splits the path.
**Therefore:** the worker is identified in the JSON request BODY, not the path. Endpoints are `PUT /workers/update` (body has `currentName` + new fields) and `POST /workers/delete` (body has `name`). Delete is POST, not DELETE-with-body, because proxies handle DELETE bodies unreliably.
