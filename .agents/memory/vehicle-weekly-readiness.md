---
name: Vehicle weekly readiness semantics
description: Meaning and boundaries of the exact-pilot weekly operations cockpit.
---

The weekly cockpit is a read-only diagnostic and readiness report, not an accounting approval or inventory certification.

**Why:** Inventory, concrete label claims, unit events, and stock movements are independent evidence. A handed-back return has physically left the vehicle before inventory transfer, so reporting a matching physical balance would be false.

**How to apply:** Compare claims to inventory and event net to movement net independently, mark products with handed-back reservations indeterminate, and make any identity, flow, balance, lifecycle, or required F6 coverage issue a blocker. Use fixed Tashkent `+05:00` half-open weeks; current weeks require coverage only through today.