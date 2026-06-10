---
name: Product profitability cost model
description: How TopMart computes product cost/profit/margin — which inputs scale by weight and which are absolute.
---

# Product profitability cost model

For every profitability/cost calculation (api-server `products.ts`, `reports.ts`,
`dashboard.ts`, and the dashboard `CostSummary`):

- `default_sale_price`, `salary_cost`, `electricity_cost`, `other_cost` are entered
  **per unit** (per kg/dona) and MUST be multiplied by the product's `weight`.
- Raw-material (BOM) cost — `SUM(raw_materials.default_cost * product_materials.quantity_required)`
  — is already an **absolute** amount for the whole batch and MUST NOT be scaled by weight.
- `effective sale = default_sale_price * weight`; `total = BOM + (salary+elec+other) * weight`;
  `profit = effective_sale - total`; `margin = profit / effective_sale`.
- Guard weight everywhere: SQL `COALESCE(NULLIF(weight,0),1)`, JS `Number(w)>0?w:1`.
  Clamp on write (POST/PATCH) so a 0/negative weight can never produce negative prices.
- Revenue is separate: it stays on `sale_items.line_total` and is never re-scaled by weight.
- The bot sales/batch flow (`sales-products.ts`, bot `create_batch`) is already per-unit and
  must stay unchanged — only the product profitability math uses weight.

**Why:** sale price and per-kg overheads are quoted per kilogram, but the BOM total is
recorded for the full batch. Scaling the BOM too (or forgetting to scale the per-kg values)
gave wildly wrong margins (e.g. Shakar 2.8 kg showed -138.8% instead of ~5.2%).

**How to apply:** any new endpoint, report, or UI that shows product cost/profit/margin must
follow this split. Existing rows default to `weight=1` (backward compatible); kg-named products
were back-filled (e.g. "Shakar 2.8 kg" → 2.8).
