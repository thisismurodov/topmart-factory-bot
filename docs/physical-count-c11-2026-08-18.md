# C-11 — REAL FIZIK SANOQ (2026-08-18) — BASELINE YUKLANDI

**Holat:** BAZAGA YUKLANDI (LOADED) — `physical_baselines` (C-11), 2026-08-18.
**Manba:** egasining 2026-08-18 xabari — real count, qop hisobi bilan (dona × 30 kg), tasnif: hammasi RAW, JAMI berilgan.
**Audit reference:** PHYSICAL-COUNT-C11-2026-08-18

---

## 1. Pozitsiyalar (3 ta)

| # | Nom | Tasnif | Qop hisobi | kg | Item (SKU) |
|---|---|---|---|---|---|
| 1 | Polipropilen CF 1500D Ko'k | xomashyo | 99 × 30 | 2 970.00 | TM-000104 (yangi) |
| 2 | Polipropilen CF 1500D Qizil | xomashyo | 118 × 30 | 3 540.00 | TM-000105 (yangi) |
| 3 | Polipropilen CF 1500D Sariq | xomashyo | 96 × 30 | 2 880.00 | TM-000106 (yangi) |
| **JAMI** | | | 313 qop | **9 390.00** | ✓ egasi bergan JAMI bilan mos |

Arifmetika tekshirildi: 99×30=2970 ✓, 118×30=3540 ✓, 96×30=2880 ✓, yig'indi 9390 ✓.

## 2. ERP holati

- C-11 = DB ID 17 (container). Yuklashdan oldin: inventory bo'sh, baseline yo'q. Yuklandi: 3 `inventory` qatori, 3 BASELINE `stock_movements`, 3 yangi `items`.
- «Ko'k» nomidagi apostrof mavjud katalog yozuvidan (Polipropilen CF 1000D Ko'k) dasturiy nusxalandi — katalogda bir xil belgi uslubi saqlanadi.
- 1500D oilasida endi 4 rang: Qora (TM-000061, C-04+C-12, 7 310 kg), Ko'k, Qizil, Sariq (C-11).

## 3. Katalog

- Uchala nom `raw_materials`ga qo'shildi: boshlang'ich balans = konteyner kg, narx **1.75 USD/kg** (CF oilasi konventsiyasi — barcha variantlar shu narxda, egasi xabardor), min 300 kg, «Boshlang'ich balans» IN yozuvlari bilan.
- RAW konventsiyasi bo'yicha `products`ga qo'shilmadi.

---

*Biz taxmin qilmaymiz. Biz bilamiz.*
