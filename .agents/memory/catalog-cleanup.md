---
name: Catalog cleanup to bot-only products
description: 2026-08-17 prod cleanup — products reduced to savdo-bot subset + 3 pre-finished; raw_materials replaced by 3 pre-finished; BOM/tiers emptied; archive naming.
---

# Catalog cleanup (EXECUTED 2026-08-17 on prod, after item-master v2 reset)

**What holds now:**
- `public.products` = 58 bot-matching (in_sales=true) + 3 pre-finished (Qop ip Qizil, Qop ip Yashil, FDY Igna Strupa; kg/UZS, in_sales=false, in_production=true, rate=0, price=0 — owner fills prices later).
- `public.raw_materials` = 9 rows: 3 pre-finished + 6 container raws (Passport Xom BCF, 4× Polipropilen CF 1000D colors, CF 1500D Qora), current_stock = live container weights (total ≈25 481 kg), all UZS/cost 0 until owner edits.
- **Ledger rule:** raw-reconcile sums ONLY `product_type='raw'` rows: IN → +quantity, OUT with from_warehouse_id NULL → −quantity; BASELINE rows are quantity=0 (weight_kg only) and count as 0. Any direct current_stock seed MUST be paired with a matching IN movement ("Boshlang'ich balans...") or the dashboard shows yellow drift badges.
- `product_materials` (BOM) and `product_price_tiers` are EMPTY — recipes must be re-entered against the new raw materials before bot batch BOM deduction works again.
- Deleted set included Reja ip 100 gr Qora/Sariq (had batches same day) and Rossiya Tros — container inventory rows untouched, but no new batches/sales for them until re-added.

**Why:** owner restructured: sellable catalog = savdo bot goods; pre-finished yarn is both a producible product and the raw input for qop production.

**Crisp criterion used:** `in_sales=true` ⇔ apostrophe-normalized name match with `distribution.mahsulotlar` (was a perfect 58/58 + 59/59 crosstab). 12 bot products have no ERP row (intentionally not imported).

**Recovery:** full pre-state archived as `legacy.*_pre_catalog_cleanup_20260817` (products 117, raw_materials 17, product_materials 62, product_price_tiers 12, packer_product_assignments 38). Restore = INSERT...SELECT back. Do not re-run the cleanup.

**How to apply:** any future "add product to dashboard" request for non-bot goods is now the NORMAL path (catalog no longer mirrors production list); check in_sales semantics before bulk ops keyed on it.
