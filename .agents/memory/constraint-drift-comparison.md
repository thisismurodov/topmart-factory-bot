---
name: Constraint drift comparison via drizzle-kit push
description: How to compare CHECK/UNIQUE constraints between hand-written runtime DDL and a Drizzle schema without parsing SQL text.
---

Rule: to compare CHECK/UNIQUE rules between two schema definitions, materialize BOTH into throwaway Postgres databases and diff the catalogs (`pg_get_constraintdef` for CHECKs, `pg_get_indexdef` for unique indexes) — never string-compare source DDL.

**Why:** Postgres rewrites expressions (`price >= 0` → `(price >= (0)::numeric)`, `IN (...)` → `= ANY (ARRAY[...])`), so textual comparison of source SQL is hopeless; letting the same server normalize both sides makes definitions byte-identical when equivalent. `drizzle-kit push --force` (available in lib/db as the `push-force` script) is safe against a throwaway DB even though prod deploys avoid push.

**How to apply:**
- Compare unique rules via unique *indexes* (pg_index, `indisunique AND NOT indisprimary`), not pg_constraint — that unifies `UNIQUE (...)` table constraints with `CREATE UNIQUE INDEX` (incl. partial WHERE) into one comparable form. Strip the index name with a regex on `pg_get_indexdef` output.
- Compare as SETS of definitions per table, names ignored: runtime legitimately has duplicate unique indexes (e.g. products.id has both a constraint from `SERIAL UNIQUE` and a separate `uq_products_id` index) — duplicates are redundancy, not drift.
- Filter `contype = 'c'` only; on PG17+ NOT NULL shows up as `contype = 'n'` and must not pollute the CHECK diff.
