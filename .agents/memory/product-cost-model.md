---
name: Product profitability cost model
description: How TopMart computes product cost/profit/margin — which inputs scale by weight and which are absolute.
---

# Product profitability cost model

For every profitability/cost calculation (api-server `products.ts`, `reports.ts`,
`dashboard.ts`, and the dashboard `CostSummary`):

- **Labor is computed from `rate`/`rate_type` — the single source of truth.** Formula:
  `labor_per_unit = rate_type == 'kg' ? rate * weight : rate`. The `salary_cost` column is
  **deprecated** (kept in DB, defaults to 0, never dropped); never use it as the labor input.
- `default_sale_price`, `electricity_cost`, `other_cost` are entered **per unit** (per kg/dona)
  and MUST be multiplied by the product's `weight`.
- Raw-material (BOM) cost — `SUM(raw_materials.default_cost * product_materials.quantity_required)`
  — is already an **absolute** amount for the whole batch and MUST NOT be scaled by weight.
- `effective sale = default_sale_price * weight`;
  `total = BOM + labor + (elec+other) * weight`;
  `profit = effective_sale - total`; `margin = profit / effective_sale`.
- In SQL, labor is `CASE WHEN rate_type='kg' THEN rate*weight ELSE rate END`; any GROUP BY that
  used to list `salary_cost` must list `rate, rate_type` instead.
- Guard weight everywhere: SQL `COALESCE(NULLIF(weight,0),1)`, JS `Number(w)>0?w:1`.
  Clamp on write (POST/PATCH) so a 0/negative weight can never produce negative prices.
- Revenue is separate: it stays on `sale_items.line_total` and is never re-scaled by weight.
- The bot sales/batch flow is already per-unit and must stay unchanged — only the product
  profitability math uses weight.
- The API still returns the JSON key `salaryCost` (now = computed labor) for back-compat, so
  existing consumers (e.g. dashboard `reports.tsx`) keep working; it is the labor component.

**Why:** labor is quoted as a rate (per kg for kg-rated products, flat per dona otherwise), so a
separate per-unit `salary_cost` field duplicated that and could drift out of sync. Sale price and
per-kg overheads are quoted per kilogram, but the BOM total is recorded for the full batch.
Scaling the BOM too (or forgetting to scale per-kg values) gave wildly wrong margins
(e.g. Shakar 2.8 kg showed -138.8% instead of ~5.2%).

**How to apply:** any new endpoint, report, or UI that shows product cost/profit/margin must
follow this split. Existing rows default to `weight=1` (backward compatible); kg-named products
were back-filled (e.g. "Shakar 2.8 kg" → 2.8).
