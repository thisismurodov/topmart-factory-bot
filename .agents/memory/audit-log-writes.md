---
name: Audit-log writes must be transactional
description: Pattern for any read→update→audit-insert endpoint in this project
---

Any endpoint that records an audit trail of a mutation (old value → new value → who) must do the read, the UPDATE, and the audit INSERT on ONE checked-out client inside BEGIN…COMMIT, with the target row locked via `SELECT … FOR UPDATE`.

**Why:** Completion code review rejected a non-transactional version (shop pin audit): two parallel PATCHes both read the same "old" value, producing a corrupt transition chain, and an INSERT failure after UPDATE leaves a mutation with no audit row.

**How to apply:** `const client = await pool.connect(); BEGIN; SELECT … FOR UPDATE; UPDATE; INSERT audit; COMMIT;` rollback in catch, release in finally. Skip the audit insert when nothing actually changed. Cover with a concurrency test (N parallel requests → chain where each row's old_* equals previous row's new_*).

Related gotcha found in the same endpoint: `body.field ?? body.alias` swallows an explicit `null` (meaning "clear the value") — use `body.field !== undefined ? body.field : body.alias`.
