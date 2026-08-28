---
name: DM-001 pilot scope freeze
description: Business scope explicitly approved for the first NAVRUZBEK / DM-001 pilot.
---

The first pilot is limited to one loop: warehouse → individual labels → physical handoff → DM-001 stock → Distribution Bot sale → stock decrease → replenishment → one private warehouse Telegram recipient.

Field Assistant vehicle sales, multi-agent/multi-vehicle rollout, damaged or quarantine returns, advanced reconciliation stock adjustments, and new analytics are explicitly excluded. Normal returns and read-only weekly expected/physical/difference reporting remain in scope.

**Why:** The user froze scope to close only the private Telegram notification and real DTP-4207 acceptance blockers without further architecture expansion.

**How to apply:** Do not implement excluded capabilities as pilot prerequisites. Keep flags and bootstrap off until both blockers pass, deployment revision is verified, and the user separately issues NAVRUZBEK / DM-001 PILOT GO.

The user issued PILOT GO on 2026-08-28 after exact revision and zero-state verification. The NAVRUZBEK / DM-001 Distribution Bot gate is now intentionally enabled; do not treat the pilot as awaiting activation.