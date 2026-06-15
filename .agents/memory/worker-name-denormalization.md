---
name: Worker name is denormalized across many tables
description: A worker's name is a value copied into several tables, not a single FK; renaming/deleting must account for all copies.
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

Rename approach (used by `PUT /workers/:name`): copy → repoint → delete.
Insert the new `workers` row first, UPDATE every copy from old→new (including `stock_movements.created_by` and `user_roles.role`), THEN delete the old row.
**Why:** the FK lacks `ON UPDATE CASCADE`, so a plain `UPDATE workers.name` would fail; and because of `ON DELETE CASCADE`, the old row must be deleted LAST (after children are repointed) or it cascade-deletes the packer rows.

**How to apply:** wrap the whole thing in one transaction; `SELECT ... FOR UPDATE` the current row; 404 if missing, 409 if the new name already exists. Sync `user_roles.role` so the bot's authorization matches the UI edit. Trim name/prefix/phone server-side to avoid whitespace-only duplicate workers.

Path-param caveat: worker names come from Telegram display names and can contain `/ ? #`. The generated client does NOT encode path params — encode at the call site (`encodeURIComponent`) for update/delete. A literal `/` may still break through the reverse proxy (it can decode `%2F`); that is a known edge-case limitation.
