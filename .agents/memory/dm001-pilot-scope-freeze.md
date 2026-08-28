---
name: DM-001 pilot scope freeze
description: Business scope explicitly approved for the first NAVRUZBEK / DM-001 pilot.
---

The first pilot is limited to one loop: warehouse → individual labels → physical handoff → DM-001 stock → Distribution Bot sale → stock decrease → replenishment → one private warehouse Telegram recipient.

Field Assistant vehicle sales, multi-agent/multi-vehicle rollout, damaged or quarantine returns, advanced reconciliation stock adjustments, and new analytics are explicitly excluded. Normal returns and read-only weekly expected/physical/difference reporting remain in scope.

**Why:** The user froze scope to close only the private Telegram notification and real DTP-4207 acceptance blockers without further architecture expansion.

**How to apply:** Do not implement excluded capabilities as pilot prerequisites. Keep flags and bootstrap off until both blockers pass, deployment revision is verified, and the user separately issues NAVRUZBEK / DM-001 PILOT GO.