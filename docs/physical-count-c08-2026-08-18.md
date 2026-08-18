# C-08 — REAL FIZIK SANOQ (2026-08-18) — BASELINE YUKLANDI

**Holat:** BAZAGA YUKLANDI (LOADED) — `physical_baselines` (C-08), 2026-08-18.
**Manba:** egasining 2026-08-18 xabari — real count, tasnif: PRE-FINISHED, JAMI berilgan (bitta pozitsiya).
**Audit reference:** PHYSICAL-COUNT-C08-2026-08-18

---

## 1. Pozitsiyalar (1 ta)

| # | Nom (kanonik) | Tasnif | kg | Item (SKU) |
|---|---|---|---|---|
| 1 | 1-5 metr Sholcha Sariq | yarim tayyor | 20 620.00 | TM-000101 (mavjud, C-13da yaratilgan) |
| **JAMI** | | | **20 620.00** | ✓ egasi bergan JAMI bilan mos |

## 2. Qarorlar va normalizatsiya

- Xabarda nom **uzun tire** bilan kelgan («1–5 metr…») — katalogdagi kanonik defisli nomga («1-5 metr Sholcha Sariq») normalizatsiya qilindi. Yangi item OCHILMADI — bu C-13dagi mahsulotning o'zi, boshqa konteynerdagi qo'shimcha zaxirasi (C-12dagi CF 1500D Qora precedenti).
- Sig'im: 20 620 kg ≤ 25 000 kg (egasi 2026-08-18 ko'targan limit) — savol talab qilinmadi.
- C-08da yuklashdan oldin 1 ta nol qoldiqli qator bor edi («Sholcha Sariq», 0 kg, item'siz) — tegilmadi, hisobga ta'sir qilmaydi.

## 3. ERP holati

- C-08 = DB ID 14 (container). Yuklandi: 1 `inventory` qatori (pre-finished, item 102), 1 BASELINE `stock_movements`, baseline №15.
- `raw_materials` balansi: 23 678 → **44 298 kg** («Qo'shimcha balans» IN yozuvi bilan). Mahsulot ikki konteynerda: C-13 23 678 + C-08 20 620.
- Katalogga YANGI yozuv qo'shilmadi (products/raw_materials/items allaqachon bor). Egasi narxni allaqachon kiritgan: 1.00 USD/kg — tegilmadi.

---

*Biz taxmin qilmaymiz. Biz bilamiz.*
