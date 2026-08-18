# C-05 — REAL FIZIK SANOQ (2026-08-18) — BASELINE YUKLANDI

**Holat:** BAZAGA YUKLANDI (LOADED) — `physical_baselines` (C-05), 2026-08-18.
**Manba:** egasining 2026-08-18 xabari — real count, tasnif: ikkalasi PRE-FINISHED, JAMI berilgan.
**Audit reference:** PHYSICAL-COUNT-C05-2026-08-18

---

## 1. Pozitsiyalar (2 ta)

| # | Nom | Tasnif | kg | Item (SKU) |
|---|---|---|---|---|
| 1 | Qop ip 1 kg | yarim tayyor | 14 000.00 | TM-000115 (yangi) |
| 2 | 0.6 mm Babin Sariq | yarim tayyor | 4 616.50 | TM-000109 (qayta ishlatildi) |
| **JAMI** | | | **18 616.50** | ✓ egasi bergan JAMI bilan mos |

## 2. Qarorlar

- **«Qop ip 1 kg»** — Qop ip oilasida yangi o'lcham («Qop ip 800 gramm»dan alohida, o'sha seriya davomi) → yangi TM-000115. Oila narxi qo'llandi: **2.50 USD/kg**.
- **«0.6 mm Babin Sariq»** — C-10da ochilgan TM-000109 bilan bir xil mahsulot → yangi TM ochilmadi, mavjud item qayta ishlatildi. `raw_materials` zaxira: 523.10 + 4 616.50 = **5 139.60 kg** («Qo'shimcha balans» IN yozuvi bilan). Narxi (2.50 USD) egasi tomonidan avval kiritilgan — tegilmadi.
- Sig'im: 18 616.5 kg ≤ 25 000 kg — savol talab qilinmadi.
- C-05da yuklashdan oldin 4 ta eski nol qoldiqli qator bor edi (Ikki Qavat Arqon 4/5/6 kg, Kurtka Tros 4-5 kg), hammasi item'siz — TEGILMADI.

## 3. ERP holati

- C-05 = container ombori. Yuklandi: 2 `inventory` qatori (pre-finished; item 116 yangi, item 110 reuse), 2 BASELINE `stock_movements`, baseline №18.
- Yarim tayyor konventsiyasi: «Qop ip 1 kg» uchun `products` qatori **in_sales=t, in_production=t** + `raw_materials` 14 000 kg / 2.50 USD + «Boshlang'ich balans» IN.
- Himoyalar: JAMI assert, «qop ip … 1 kg» regex-guard (variant to'qnashuvi yo'q), reuse yo'lida FOR UPDATE + kutilgan zaxira 523.10 assert, MAX sku assert (114), nol qoldiqlarga ruxsat + holat tekshiruvi — toza o'tdi.

---

*Biz taxmin qilmaymiz. Biz bilamiz.*
