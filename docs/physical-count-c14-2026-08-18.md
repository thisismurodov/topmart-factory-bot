# C-14 — REAL FIZIK SANOQ (2026-08-18) — BASELINE YUKLANDI

**Holat:** BAZAGA YUKLANDI (LOADED) — `physical_baselines` id=10, 2026-08-18.
**Manba:** egasining 2026-08-18 xabari — real count + tasnif tasdig'i (5 finished + 1 raw).
**Audit reference:** PHYSICAL-COUNT-C14-2026-08-18

---

## 1. Pozitsiyalar (nomlar aynan, 6 ta)

| # | Nom | Tasnif | kg | Item (SKU) |
|---|---|---|---|---|
| 1 | Kanob 10 mm | finished | 145.40 | TM-000095 |
| 2 | Kanob 14 mm | finished | 264.55 | TM-000096 |
| 3 | Kanob 16 mm | finished | 202.00 | TM-000097 |
| 4 | Kanob 12 mm | finished | 402.80 | TM-000098 |
| 5 | XB Lomboz Arqon | finished | 933.40 | TM-000099 |
| 6 | FDY Polyester (Raw) | raw | 7 980.00 | TM-000100 |
| **JAMI** | | | **9 928.15** | |

Arifmetik tekshiruv: 145.40 + 264.55 + 202.00 + 402.80 + 933.40 + 7 980.00 = **9 928.15 kg** ✓ — egasi bergan JAMI bilan aynan mos.

## 2. ERP holati (yuklashdan oldin/keyin)

- C-14 = DB ID 20 (container). Yuklashdan oldin inventar qatorlari: **0** (bo'sh edi) — to'qnashuv yo'q.
- Yuklandi: 6 ta `inventory` qatori (quantity=0, weight_kg bilan), 6 ta `stock_movements` BASELINE yozuvi (item_id + pos reference bilan), 6 ta yangi `items` (source_kind=physical_count).

## 3. Katalog mosligi

- 6/6 nom katalogda YO'Q edi (items + item_aliases tekshirildi) — barchasi yangi item sifatida EXACT nom bilan yaratildi, mapping_status=MAPPED.
- 5 finished nom `products`ga ombor-mahsuloti sifatida qo'shildi (in_sales=f, in_production=f) — bot kirim «🏬 Ombor mahsuloti» bo'limida ko'rinadi.
- FDY Polyester (Raw) — konventsiya bo'yicha `products`/`raw_materials`ga qo'shilmadi (raw faqat egasi bot katalogiga qo'shganda kiradi).

---

*Biz taxmin qilmaymiz. Biz bilamiz.*
