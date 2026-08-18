---
name: 23505 handlers vs cloned schemas
description: Why unique-violation catch blocks must not compare exact constraint names when tests clone tables via CREATE TABLE (LIKE ... INCLUDING ALL)
---

Rule: in API error handlers for Postgres `23505` (unique violation), match the violated constraint by **column substring** (e.g. `e.constraint.includes("sku")`), not by exact index name.

**Why:** `CREATE TABLE tst.products (LIKE public.products INCLUDING ALL)` copies partial/unique indexes but does NOT preserve their names — `idx_products_sku_unique` becomes `products_sku_idx` in the clone. An exact-name check worked in prod but fell through to a 500 in the isolated test schema; the substring check passes in both. Auto-generated names always contain the column name, and other unique indexes on the table (pkey, id) don't collide with the substring.

**How to apply:** any test that clones prod tables with LIKE (good mirroring technique per test-schema-prod-mirror) + any route that maps 23505 → 4xx. Check all unique indexes on the table share no misleading substrings before choosing the token.
