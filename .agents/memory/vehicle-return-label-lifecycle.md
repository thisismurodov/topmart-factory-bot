---
name: Vehicle return label lifecycle
description: Label identity, locking, and reconciliation boundaries for pilot vehicle returns.
---

Vehicle returns accept concrete loaded barcodes only. Claims move `loaded → return_reserved → returned`; cancellation is allowed only before physical hand-back and restores `loaded`. Returned label identities are terminal and cannot be printed or loaded again in the pilot.

**Why:** A generic or source-selected return can corrupt lineage, while selling a reserved label or reissuing a returned passport duplicates physical identity. A handed-back manifest also makes inventory-only reconciliation physically ambiguous until transfer completes.

**How to apply:** Derive each destination from the claim's original F3 source handoff, lock all source and vehicle warehouse parents in sorted order before return/claim/inventory rows, and transfer one claim-derived unit and weight atomically. F6 create/review/apply must reject prepared or handed-back returns; cancelled and transferred returns do not block.