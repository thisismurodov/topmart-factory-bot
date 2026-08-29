---
name: Vehicle pilot sale atomicity
description: Transaction and locking rules for exact-pilot vehicle sales.
---

NAVRUZBEK vehicle sales must run on one physical PostgreSQL connection and transaction across `distribution` and `public`; never split sale creation and stock allocation across an HTTP call.

**Why:** A network timeout between independent commits can leave a sale without stock allocation or stock allocation without a sale. F6 also needs a shared lock boundary to detect every stock change.

**How to apply:** Resolve the exact active pilot assignment server-side, lock the vehicle warehouse parent before vehicle reads, use a stable operation key and fingerprint, and atomically commit sale/debt/balance, inventory movement, one allocation per loaded label, claim status, and unit events. Pilot quantities are whole labeled units. Posted pilot sales stay immutable until a compensating reversal model exists.
## Dispatch identity + flow stability
Pilot routing must never key on users.name spelling — prod spells the same person differently across tables ("Navro'zbek" vs "Navruzbek"); names are display data, telegram_id matched against the active assignment chain is identity. Deactivating the assignment is the official pilot-off switch.
The pilot decision is PINNED once per sale flow and re-checked only at the final write: a mid-flow assignment change must abort with refund + explicit error, never switch writers.
**Why:** dispatch and the transactional guard must share one identity source; a DB-backed decision re-evaluated mid-flow becomes a money-corruption window (double debit or unbacked debt reduction).
**How to apply:** pilot-gated features read the pinned flow flag / shared helper — never re-compare names, never re-evaluate the route mid-flow.
