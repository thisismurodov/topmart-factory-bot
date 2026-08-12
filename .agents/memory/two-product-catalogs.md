---
name: Master product record (ERP vs savdo bot)
description: One master product with module flags; sales catalog is a downstream projection
---
# Master product / projection decision

- The ERP product table is the ONE master; per-module participation flags say where each product is used. The distribution sales catalog is a downstream projection keyed by SKU — never a second source of truth.
- **Why:** two independently-edited catalogs required manual "Bog'lash" linking and produced dozens of orphaned sales products; projection-side edits silently diverged from ERP.
- **How to apply:**
  - Create/edit products only through the master API; projections update via sync. Direct projection edits are reserved for legacy unlinked rows (migration only).
  - A module flag must be enforced in that module's *selection and pricing* queries everywhere (dashboard, API, both Telegram bots) — a flag that is stored and displayed but not filtered on is a lie in the UI and will be rejected in review.
  - Historical/report queries stay unfiltered; flags gate selection, not history.
