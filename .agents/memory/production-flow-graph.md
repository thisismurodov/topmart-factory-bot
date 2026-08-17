---
name: Production Flow visual graph — data reality
description: What the flow-graph feature can/can't derive from live data; gaps found during the 2026-08 analysis (wip item ids empty, no RECEIVE rows, stale purpose, items flags unset).
---

# Production Flow graph — live-data reality (found 2026-08-17)

- "Department" == `production_lines` row (no departments table; /ombor/flow aliases it). Active: line 6 Arqon Bo'lim 3 (11 workers, 3 cfg roles), line 9 Qop Ip (2, 2); Lenta 1 (8) has config but 0 workers. "CF Lenta" from owner examples does NOT exist.
- `wip_movements` has **zero RECEIVE rows ever** (all 171 are PRODUCE, line 6) → container→department supply edges have no actual data and line-6 WIP balance is **negative −8,964.77 kg**. The receive endpoint exists but operations never used it. Any flow UI must show this honestly (red badge), not fake supply edges; BOM edges may be shown as dashed "recipe" layer.
- **item_id columns exist but are EMPTY** on wip_movements (0/171), batches (0/280), products (0/117), product_materials (0/62). Only inventory (reset scope) + stock_movements are item-linked. Graph joins must go through normalized TEXT names (apostrophe variants!) until a separate backfill GO.
- `items` classification flags (is_raw/is_intermediate/is_finished) are ALL false — the canonical classification source is `inventory.product_type` (raw 6 / pre-finished 3 / finished 88 per v2 reset). Don't read items flags; don't set them without owner GO.
- `warehouses.purpose` is stale vs content: C-15 purpose='finished' but holds only raw PP → the existing Ish jarayoni page (filters purpose='raw') does NOT list C-15 as a raw source. Derive container type badges from CONTENT (product_type per row: RAW/PRE-FINISHED/FINISHED/MIXED); fixing purpose is owner's open question №3 (R-E gate).
- Dept→employees→salary is REAL data: production_line_workers + line_role_config (+pay_mode) + salary_entries (line-scoped, closed days); salary_payments is worker-global (no line_id).
- Dashboard has NO node-graph lib (recharts/leaflet only). Plan approved direction: @xyflow/react + fixed 5-column layered layout (no dagre needed); new read-only endpoint /ombor/flow/graph; new /flow-map route; do NOT touch the existing ish-jarayoni page.
- Owner gate: implementation only after explicit «PRODUCTION FLOW GO»; proposal doc = docs/production-flow-visual-architecture-proposal-2026-08-17.md.
