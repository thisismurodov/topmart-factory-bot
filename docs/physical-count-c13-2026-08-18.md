# C-13 — REAL FIZIK SANOQ (2026-08-18) — BASELINE YUKLANDI

**Holat:** BAZAGA YUKLANDI (LOADED) — `physical_baselines` (C-13), 2026-08-18.
**Manba:** egasining 2026-08-18 xabari — real count + tasnif (pre-finished). Og'irlik alohida savol bilan tasdiqlatildi (sig'im masalasi).
**Audit reference:** PHYSICAL-COUNT-C13-2026-08-18

---

## 1. Pozitsiyalar (nom aynan, 1 ta)

| # | Nom | Tasnif | kg | Item (SKU) |
|---|---|---|---|---|
| 1 | 1-5 metr Sholcha Sariq | pre-finished | 23 678.00 | TM-000101 |
| **JAMI** | | | **23 678.00** | |

Egasi 23 678 kg ni alohida tasdiqladi (2026-08-18): konteyner sig'imi 20 000 kg edi — egasi ko'rsatmasi bilan **barcha konteynerlar sig'imi 25 000 kg ga oshirildi** (30 ta, location_type=container).

## 2. ERP holati (yuklashdan oldin/keyin)

- C-13 = DB ID 19 (container, purpose: `raw`). Yuklashdan oldin: 1 ta NOL qoldiqli qator — «Sholcha Sariq» (0 kg, 0 dona, item'siz, 2026-08-17 UI qoldig'i). Tegilmadi — mavjudlik semantikasi bo'yicha (qty>0 OR weight>0) ko'rinmaydi. Egasi xohlasa keyin o'chiriladi.
- ⚠️ Kuzatuv (qaror EMAS): konteyner maqsadi `raw`, tarkib tasnifi `pre-finished` — C-15 dagi kabi purpose/tarkib nomuvofiqlik kuzatuvi.
- Yuklandi: 1 `inventory` qatori, 1 BASELINE `stock_movements` yozuvi, 1 yangi `items` (TM-000101).

## 3. Katalog mosligi

- Nom katalogda YO'Q edi (items, item_aliases, products, raw_materials tekshirildi) — yangi item EXACT nom bilan yaratildi, MAPPED.
- Pre-finished konventsiyasi (Qop ip / FDY Igna Strupa precedenti): `products`ga ombor-mahsuloti sifatida (in_sales=f, in_production=f) HAM `raw_materials`ga (boshlang'ich balans 23 678.00 kg, default_cost=0 — narx egasidan kutilmoqda, USD, min 300 kg) qo'shildi.

---

*Biz taxmin qilmaymiz. Biz bilamiz.*
