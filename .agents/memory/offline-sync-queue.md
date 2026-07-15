---
name: Offline sync queue pitfalls
description: localStorage offline queue + TanStack optimistic updates — snapshot overwrite data loss, query-key mismatch, 4xx drop rules
---

# Offline sync queue pitfalls (Field Mini App pattern)

1. **Never save a start-of-flush snapshot back to storage.** If flush iterates a snapshot and writes `saveQueue(remaining)` after each success, an item enqueued *during* the flush gets erased. Always remove by id from a fresh `getQueue()` read on every save.
2. **Optimistic `setQueryData` must use the EXACT query key** the reading hook uses (same element count — a trailing `""` param still changes the hash). Share a key-factory function; a mismatched key writes to a dead cache entry and the UI silently reverts, tempting users to resubmit with a fresh clientOpId → real duplicate rows despite server idempotency.
3. **Guard submit buttons** (`submitted` state) — idempotency via clientOpId only protects retries of the SAME op id; a second tap generates a new UUID.
4. **Only drop queued items on true poison statuses (400/404/422).** 401/403/429 are retryable-after-reauth (Telegram initData expires after ~24h; reopening the Mini App refreshes it) — dropping them destroys sales data.
5. **Every fallback storage needs its own submit path.** If enqueue falls back to a secondary store (e.g. localStorage when IndexedDB is broken in private-mode WebViews), the sync engine must also be able to flush directly from that store — otherwise writes strand there forever while sync only reads the primary.
6. **Boot sync should ignore backoff timers.** App reopen = fresh Telegram initData, so auth-backoffed events must not wait out their 60s delay; run the boot flush in "manual" mode. Also queue a re-run when a manual sync request arrives while a sync is already in flight, instead of silently no-oping.

**Why:** items 1-4 from architect review of the v0 localStorage queue (two were data-loss bugs); 5-6 from the Offline First v1.0 (IndexedDB) review.
**How to apply:** any offline queue (localStorage or IndexedDB) + React Query optimistic UI combination.
