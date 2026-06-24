---
name: Raw-material currency and USD cost conversion
description: How raw_materials currency works and where USD costs get converted to UZS for cost/profit.
---

`raw_materials.currency` (UZS or USD) describes the unit in which `default_cost` is expressed — `default_cost` is the original price in that currency (no pre-conversion stored).

**Rule:** Anywhere raw-material cost feeds a cost/profit calc, USD rows must be converted to UZS at the live rate; UZS rows pass through unchanged.

**Why:** Costs and revenue must be compared in one currency (UZS). Storing the original currency keeps reporting honest (you can show the source price), so conversion happens at query time, not at write time.

**How to apply:**
- Live rate comes from the shared helper `getUsdToUzsRate()` in `api-server/src/lib/exchangeRate.ts` (cbu.uz + cache + stale fallback). Pass `rate` as a SQL param.
- Conversion pattern in SQL: `SUM(rm.default_cost * pm.quantity_required * CASE WHEN UPPER(rm.currency)='USD' THEN $rate::numeric ELSE 1 END)`. Used in `products.ts` (list + `/:name/profitability`) and `reports.ts` (product-profitability).
- `raw-materials` GET returns `calculatedUzsCost` (= `default_cost * rate` for USD, else `default_cost`) alongside the original price/currency.
- Product sale price has its own `currency_type` converted the same way (`UPPER(currency_type)='USD'`).
