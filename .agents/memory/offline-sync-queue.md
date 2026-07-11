---
name: Offline sync queue pitfalls
description: localStorage offline queue + TanStack optimistic updates — snapshot overwrite data loss, query-key mismatch, 4xx drop rules
---

# Offline sync queue pitfalls (Field Mini App pattern)

1. **Never save a start-of-flush snapshot back to storage.** If flush iterates a snapshot and writes `saveQueue(remaining)` after each success, an item enqueued *during* the flush gets erased. Always remove by id from a fresh `getQueue()` read on every save.
2. **Optimistic `setQueryData` must use the EXACT query key** the reading hook uses (same element count — a trailing `""` param still changes the hash). Share a key-factory function; a mismatched key writes to a dead cache entry and the UI silently reverts, tempting users to resubmit with a fresh clientOpId → real duplicate rows despite server idempotency.
3. **Guard submit buttons** (`submitted` state) — idempotency via clientOpId only protects retries of the SAME op id; a second tap generates a new UUID.
4. **Only drop queued items on true poison statuses (400/404/422).** 401/403/429 are retryable-after-reauth (Telegram initData expires after ~24h; reopening the Mini App refreshes it) — dropping them destroys sales data.

**Why:** all four were found by architect review of the first offline-queue implementation; two were data-loss bugs.
**How to apply:** any localStorage/offline queue + React Query optimistic UI combination.
