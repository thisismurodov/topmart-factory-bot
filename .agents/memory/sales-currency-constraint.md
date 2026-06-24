---
name: Sales are single-currency at the parent level
description: Why a single sale cannot mix UZS and USD items, and where the constraint is enforced.
---

A `sales` row stores ONE `currency`, one numeric `total_amount`, and one `paid_amount`/`debt_amount`. Per-item history in `sale_items` is per-currency-correct, but the parent aggregate is not.

**Rule:** A single sale must contain items of exactly one currency. Mixed UZS+USD items in one sale are rejected.

**Why:** Tier pricing lets a product carry a USD tier (e.g. a UZS-default product can have USD-priced tiers, and some products are USD-priced outright). Without a guard, a sale mixing a UZS item and a USD item would sum their `line_total` numerically into one corrupted `total_amount`, pick a single arbitrary `currency`, and compute wrong `paid`/`debt`. Reports that aggregate `sale_items` FILTER-ed by currency stay correct, but the sale-level total/debt/payment UI is wrong.

**How to apply:** Enforced in two places — keep them in lockstep:
- API `POST /sales`: after resolving items server-side, reject when `new Set(currencies).size > 1` (400, Uzbek message).
- Dashboard `sales.tsx addItem()`: block adding an item whose tier/default currency differs from items already in the draft, with an inline Uzbek error.

If real multi-currency invoices are ever needed, that requires a larger redesign (per-currency totals/debts on the sale), not loosening this guard.
