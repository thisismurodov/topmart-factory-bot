# C-10 — REAL FIZIK SANOQ (2026-08-18) — BASELINE YUKLANDI

**Holat:** BAZAGA YUKLANDI (LOADED) — `physical_baselines` (C-10), 2026-08-18.
**Manba:** egasining 2026-08-18 xabari — real count, tasnif: hammasi PRE-FINISHED, JAMI berilgan.
**Audit reference:** PHYSICAL-COUNT-C10-2026-08-18

---

## 1. Pozitsiyalar (4 ta)

| # | Nom | Tasnif | kg | Item (SKU) |
|---|---|---|---|---|
| 1 | 0.4 mm Babin Sariq | yarim tayyor | 8 827.10 | TM-000107 (yangi) |
| 2 | 0.4 mm Babin K/Qora | yarim tayyor | 1 826.50 | TM-000108 (yangi) |
| 3 | 0.6 mm Babin Sariq | yarim tayyor | 523.10 | TM-000109 (yangi) |
| 4 | 0.5 mm Babin Qora | yarim tayyor | 3 759.90 | TM-000110 (yangi) |
| **JAMI** | | | **14 936.60** | ✓ egasi bergan JAMI bilan mos |

## 2. Egasi qarori (2026-08-18)

- **«0.5 mm Babin Qora» ≠ «0.5 Babin / Qora»** (bot ishlab chiqarish katalogidagi dona mahsulot, 1 000 so'm/dona stavka, sotuvda). Savol berildi — javob: **boshqa mahsulot, «bu pre finished»** → yangi TM-000110. Taxallus YO'Q (ikkalasi alohida mahsulot sifatida yashaydi).
- Eski harakat tarixidagi «Babin Qora 0.5 mm» / «Babin Sariq 0.5 mm» nomlari (1 tadan OUT) — tarixiy iz, tegilmadi, item ochilmadi.
- «0.5 babin / oq» (bot katalogi) — sanoqqa aloqasi yo'q, tegilmadi.

## 3. ERP holati

- C-10 = DB ID 16 (container). Yuklashdan oldin: inventory bo'sh, baseline yo'q. Yuklandi: 4 `inventory` qatori (pre-finished), 4 BASELINE `stock_movements`, 4 yangi `items`.
- Himoya birinchi urinishda to'xtatgan edi (Babin-ga o'xshash nomlar topilgani uchun) — egasi javobidan keyin ikkita ma'lum katalog yozuvi istisno qilinib qayta yuklandi. Atomarlik buzilmadi.

## 4. Katalog (yarim tayyor konventsiyasi)

- To'rttala nom `products`ga ombor-mahsuloti sifatida (in_sales=f, in_production=f) — bot kirim «🏬 Ombor mahsuloti»da ko'rinadi.
- To'rttala nom `raw_materials`ga ham: balans = konteyner kg, **narx 0 — egasidan kutilmoqda** (USD, min 300 kg), «Boshlang'ich balans» IN yozuvlari bilan.

---

*Biz taxmin qilmaymiz. Biz bilamiz.*
