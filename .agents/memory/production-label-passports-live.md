---
name: Production label passports live
description: Live migration state and the confirmed print-format boundary for physical production labels.
---

The `production_labels` production migration was applied on 2026-08-19. It was additive, created no backfill rows, and left legacy batches without invented passport barcodes.

**Why:** The user requires one immutable identity per physical unit or box, but explicitly confirmed that the established 100×80 thermal-label design and print pagination must remain unchanged. A six-label image is only a comparison contact sheet, never the production print format.

**How to apply:** Every physical label remains one 100×80 PDF page. Preserve the six-row layout and existing print flow; only the Code 128 payload becomes the persisted `TM` passport token. Reprints must reuse that token and snapshot. Never fabricate passports for legacy batches without one.

Schema startup remains approval-gated; do not treat a normal service restart as authorization for future production schema changes.