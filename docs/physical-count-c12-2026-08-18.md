# C-12 — REAL FIZIK SANOQ (2026-08-18) — BASELINE YUKLANDI

**Holat:** BAZAGA YUKLANDI (LOADED) — `physical_baselines` (C-12), 2026-08-18.
**Manba:** egasining 2026-08-18 xabari — real count + tasnif har pozitsiyada (RAW/RAW/FINISHED) + JAMI.
**Audit reference:** PHYSICAL-COUNT-C12-2026-08-18

---

## 1. Pozitsiyalar (3 ta)

| # | Nom (kanonik) | Tasnif | kg | Item (SKU) |
|---|---|---|---|---|
| 1 | Polipropilen CF 1000D Qora | xomashyo | 10 461.00 | TM-000102 (yangi) |
| 2 | Polipropilen CF 1500D Qora | xomashyo | 4 060.00 | TM-000061 (mavjud) |
| 3 | 70 metr Sariq Strupa 16 | tayyor | 639.25 | TM-000103 (yangi) |
| **JAMI** | | | **15 160.25** | ✓ egasi bergan JAMI bilan mos |

## 2. Egasi qarorlari (2026-08-18)

- **«Sariq Strupa 16» ≠ «Sariq Polyester Strupa 16 talik»** (savol berildi, javob: boshqa mahsulot). Egasi ko'rsatmasi: nomga «70 metr» qo'shilsin → kanonik nom **«70 metr Sariq Strupa 16»**, yangi TM-000103. Qisqa nom `item_aliases`ga yozildi (source=physical_count).
- **Polipropilen CF 1500D Qora** allaqachon TM-000061 (C-04 sanog'ida 3 250 kg). C-12 dagi 4 060 kg — qo'shimcha zaxira: mavjud item'ga ulandi, xomashyo katalog balansi 3 250 → **7 310 kg** («Qo'shimcha balans» IN yozuvi bilan).
- **CF 1000D Qora narxi:** CF oilasining barcha 5 varianti 1.75 USD/kg bo'lgani uchun 1.75 USD qo'yildi (egasiga aytildi, e'tiroz bo'lsa o'zgartiriladi).

## 3. ERP holati

- C-12 = DB ID 18 (container). Yuklashdan oldin: inventory bo'sh, baseline yo'q. Yuklandi: 3 `inventory` qatori, 3 BASELINE `stock_movements`, 2 yangi `items`, 1 alias.
- Katalog: CF 1000D Qora → `raw_materials` (10 461 kg, 1.75 USD); CF 1500D Qora → mavjud qator balansi +4 060; 70 metr Sariq Strupa 16 → `products` ombor-mahsuloti (in_sales=f, in_production=f) — bot kirim «🏬 Ombor mahsuloti»da ko'rinadi.

---

*Biz taxmin qilmaymiz. Biz bilamiz.*
