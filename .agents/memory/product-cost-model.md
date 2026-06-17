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
- `default_sale_price` behavior is **unit_type-dependent**:
  - `unit_type = 'kg'`: revenue = `default_sale_price × weight` (price entered per kg).
  - `unit_type = 'dona'` (piece): revenue = `default_sale_price` only — weight is **NOT** multiplied.
    Weight still applies to electricity_cost, other_cost, and labor (if rate_type='kg').
- `electricity_cost`, `other_cost` are entered per unit:
  - `unit_type = 'kg'`: effective = cost × weight (price-per-kg entered, multiplied by weight).
  - `unit_type = 'dona'`: effective = cost (fixed per piece — weight is NOT applied).
  Weight only affects electricity/other for kg products.
- Raw-material (BOM) cost — `SUM(raw_materials.default_cost * product_materials.quantity_required)`
  — is already an **absolute** amount for the whole batch and MUST NOT be scaled by weight.
- `effective_sale = default_sale_price * weight` (kg) OR `= default_sale_price` (dona);
  `total = BOM + labor + (elec+other)*weight` (kg) OR `BOM + labor + (elec+other)` (dona);
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

## Currency normalization (USD/UZS) — profit/cost are ALWAYS UZS

Both `products.currency_type` and `raw_materials.currency` can be USD or UZS. Profitability must
be computed in a single currency or it is meaningless. The rule:

- **Normalize everything to UZS before subtracting.** Multiply a USD `default_sale_price` and any
  USD raw-material `default_cost` by the live `getUsdToUzsRate()` (cbu.uz, cached, stale-fallback)
  before computing `total`, `profit`, `margin`. Labor/electricity/other are already UZS.
- This applies to EVERY profitability path: `products.ts` (list + `/:name/profitability`),
  `reports.ts` (`/product-profitability`), AND `dashboard.ts` (`/dashboard/v2` enriched CTE +
  `/dashboard/product-highlights`). Missing even one endpoint reintroduces the mixed-currency bug.
- **What stays in native currency (do NOT normalize):** `sale_items` revenue/unit_price (stored at
  sale time for historical accuracy), the raw-material *original* price display, and tier prices.
  So API profit/cost/margin = UZS; revenue + original raw/tier prices = their own currency.
- **UI contract:** dashboard formats sale/cost/profit/margin with `formatCurrency` (UZS) only —
  never a `$` branch on these. Revenue and original raw-material/tier prices keep `$` for USD.

**Why:** subtracting UZS costs from an unconverted USD sale price gave absurd margins (~100% for a
$1.85 product) and a `$`-labeled UZS number in the UI. This was found and re-found across 4 review
rounds because each endpoint/UI spot had its own copy of the calc.

## Gotcha: Postgres infers a `$n` param as integer from a sibling integer literal

`CASE WHEN ... THEN $1 ELSE 1 END` makes Postgres type `$1` as **integer** (from the `ELSE 1`
literal), so passing a non-integer rate (e.g. `12012.12`) throws
`invalid input syntax for type integer`. **Always cast: `THEN $1::numeric ELSE 1 END`.** This bit
both the raw-material CASE and the sale-price CASE; it was latent because the affected endpoints
weren't curl-tested until late.
