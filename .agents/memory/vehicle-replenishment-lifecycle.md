---
name: Vehicle replenishment lifecycle
description: Locking and stock-mutation boundaries for exact-pilot replenishment.
---

Replenishment targets and requests never mutate vehicle inventory. A low-stock request is fully approved into one existing F3 prepared handoff, and only that handoff's final `stock_transferred` transaction may fulfill the request and increase vehicle stock.

**Why:** Partial approval can leave stock below minimum without an open request, and a separate replenishment writer would bypass label identity and F6 stale detection. Locking a request before its warehouse parent can deadlock with F7 auto-request creation.

**How to apply:** Use whole labeled units, lock source and vehicle warehouse parents in deterministic order before request/handoff/inventory rows, require full requested quantity, and keep one pending/approved request per vehicle and canonical product. F7 auto-request creation relies on the open-request partial unique conflict and does not add a late advisory lock.