---
name: Vehicle package-label quantities
description: Durable quantity semantics for box labels, partial sales, returns, and vehicle readiness.
---

Vehicle inventory, handoffs, sales, replenishment, and events are always measured in pieces. A physical label claim represents one package: its initial piece count is immutable, while its remaining-piece balance decreases across partial sales. A claim closes as sold only at zero; a return transfers the complete remaining balance and its proportional weight.

**Why:** Treating one label as one inventory piece made a 100-piece box produce 100 labels and made partial sales impossible without corrupting label ownership. Claim count and stock quantity are different units.

**How to apply:** Snapshot package capacity when the handoff item is created; prepare `ceil(piece quantity / package capacity)` labels, allowing a smaller final package. In production, verify the created handoff exposes the expected package-capacity snapshot before preparing labels; stop and cancel if it does not, because a stale deployment can otherwise create one label per piece. Allocate sales FIFO by load-event chronology, not claim ID. Aggregate readiness from remaining pieces and show physical-label count separately. Legacy claims remain one initial/remaining piece unless already sold or returned.