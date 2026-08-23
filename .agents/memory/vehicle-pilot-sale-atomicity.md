---
name: Vehicle pilot sale atomicity
description: Transaction and locking rules for exact-pilot vehicle sales.
---

NAVRUZBEK vehicle sales must run on one physical PostgreSQL connection and transaction across `distribution` and `public`; never split sale creation and stock allocation across an HTTP call.

**Why:** A network timeout between independent commits can leave a sale without stock allocation or stock allocation without a sale. F6 also needs a shared lock boundary to detect every stock change.

**How to apply:** Resolve the exact active pilot assignment server-side, lock the vehicle warehouse parent before vehicle reads, use a stable operation key and fingerprint, and atomically commit sale/debt/balance, inventory movement, one allocation per loaded label, claim status, and unit events. Pilot quantities are whole labeled units. Posted pilot sales stay immutable until a compensating reversal model exists.