---
name: Ledger backfill ordering
description: Backfilled ledger rows get new ids with old timestamps — history queries must order by created_at, not id.
---

**Rule:** Whenever historical rows are backfilled into an append-only ledger (e.g. stock_movements), any history/timeline query that ordered by `id DESC` must switch to `created_at DESC, id DESC`.

**Why:** Backfilled rows are inserted later (high serial ids) but stamped with the original event time. Ordering by id puts old events at the top of the list and corrupts running-balance walks that assume newest-first chronology.

**How to apply:** When adding a backfill (idempotent INSERT…SELECT with NOT EXISTS guard on a note prefix works well; use `starts_with()` to avoid LIKE wildcard traps in codes), audit every consumer that sorts the table by id. Also wrap the backfill in an advisory-lock transaction so parallel boots can't double-insert.
