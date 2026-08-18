---
name: Test schema must mirror prod columns
description: Seeded test CREATEs must be generated from the real DB's information_schema, never from assumptions — column drift makes tests pass while prod 500s.
---

**Rule:** Before writing CREATE TABLE statements for a seeded test schema, dump the real
columns from the live DB (`information_schema.columns`: name, type, is_nullable,
column_default) and mirror them exactly. Never "remember" or assume a column exists.

**Why:** A department-detail endpoint selected `production_lines.active`. The test schema
also created that column, so 22/22 tests passed — but prod `production_lines` has NO
`active` column (activity is a hardcoded ACTIVE_LINE_IDS convention from the flow-graph
work), so the live endpoint 500'd on first real request. The test and the code shared the
same wrong assumption, so the test proved nothing about prod compatibility.

**How to apply:**
- One query gives everything: `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name IN (...) ORDER BY table_name, ordinal_position;` (read-only).
- Mirror nullability and defaults too, not just names — NOT NULL columns without defaults catch seed rows that quietly rely on impossible NULLs (e.g. batches.worker is NOT NULL in prod; a seeded "orphan batch with NULL worker" scenario was unrepresentable, i.e. a fake test case).
- In this project activity/visibility flags often do NOT exist as columns (production_lines has none); they are app-level conventions like ACTIVE_LINE_IDS. Check the flow-graph lib before inventing flag columns.
- Related but distinct memories: dual-init-schema (bot+API both CREATE), fresh-DB boot ordering, shared-DB test schema contention.

**New products column ⇒ update ~15 hand-rolled test DDLs.** Many api-server test files each
hand-roll their own `CREATE TABLE ... products (` DDL (find them:
`grep -rl "CREATE TABLE[^(]*products\s*(" test/`). When a new column is added to prod
`products`, every one of those DDLs must gain it or POST/GET products in those tests fail with
`column ... does not exist` (surfaces as 409 from the POST upsert catch, not 500 — misleading).
Only files whose tests hit an affected endpoint fail; the rest break silently later. Inserting
the new column right after the opening paren is safe HERE because test inserts are all
column-list based — verify first with `grep -rn "INSERT INTO [^ ]*products\s*VALUES" test/`
(positional inserts would break on column-order changes).
