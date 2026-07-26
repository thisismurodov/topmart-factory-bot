---
name: Two product catalogs (ERP vs savdo bot)
description: public.products and distribution.mahsulotlar are separate by design; how they bridge and how names are matched
---

# Two product catalogs

The project has TWO product catalogs on the same Railway DB:

- `public.products` — ERP/factory catalog (name is PK; cost/profit model, BOM, tiers). Shown in the dashboard products page main table.
- `distribution.mahsulotlar` — savdo (agent) bot catalog (id, nomi, narx BIGINT UZS, birlik dona/kg, faol 0/1 soft delete). Written by the distribution bot; sales reference it via `savdo_tafsilot.mahsulot_id`.

They are NOT synced automatically. Products added in the savdo bot do not appear in the ERP catalog and vice versa — this was the root cause of a "bot products invisible in dashboard" complaint.

**Bridge (July 2026):** dashboard products page has a "Savdo bot mahsulotlari" section (API: `/api/distribution/products` CRUD + `/api/distribution/products/sync-to-erp` which copies missing active bot products into public.products with narx as UZS default_sale_price).

**Rules to preserve:**
- Dashboard edits must stay write-compatible with the bot's SQL (plain insert/update on the same columns; faol=0 = soft delete, never hard DELETE — sales history references mahsulot_id).
- Name matching between catalogs must normalize: lower, trim, collapse spaces, strip apostrophe variants (' ' ʼ ` ´) — Uzbek names like Po'kak/Po'kak differ only by apostrophe glyph.
- Creating a bot product whose normalized name matches an inactive (faol=0) row should reactivate it, not insert a duplicate.
- **Why:** user's long-term wish is ONE unified catalog ("we should see the same products in both"); full unification (bot reading public.products) is a known possible follow-up — don't deepen the split.
