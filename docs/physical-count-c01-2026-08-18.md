# C-01 — REAL FIZIK SANOQ (2026-08-18) — BASELINE YUKLANDI

**Holat:** BAZAGA YUKLANDI (LOADED) — `physical_baselines` (C-01), 2026-08-18.
**Manba:** egasining 2026-08-18 xabari — real count, tasnif: PRE-FINISHED, JAMI berilgan (bitta pozitsiya).
**Audit reference:** PHYSICAL-COUNT-C01-2026-08-18

---

## 1. Pozitsiyalar (1 ta)

| # | Nom | Tasnif | kg | Item (SKU) |
|---|---|---|---|---|
| 1 | Sholcha Maloshni | yarim tayyor | 22 127.00 | TM-000114 (yangi) |
| **JAMI** | | | **22 127.00** | ✓ egasi bergan JAMI bilan mos |

## 2. Qarorlar

- **«Sholcha Maloshni»** — Sholcha oilasida yangi variant, «1-5 metr Sholcha Sariq»dan (TM-000101) alohida mahsulot → yangi TM-000114. Nom egasi yozganidek saqlandi.
- Oila narxi qo'llandi: **1.00 USD/kg** (egasi «1-5 metr Sholcha Sariq»ga o'zi kiritgan narx bilan bir xil). Xohlasa o'zgartiradi.
- Sig'im: 22 127 kg ≤ 25 000 kg — savol talab qilinmadi.
- C-01da yuklashdan oldin 2 ta eski nol qoldiqli qator bor edi: «Sholcha Oq» (finished, 0) va «Sholcha» (raw, 0), ikkalasi item'siz — TEGILMADI (C-13dagi «Sholcha Sariq» kabi tarixiy qoldiqlar).

## 3. ERP holati

- C-01 = DB ID 7 (container). Yuklandi: 1 `inventory` qatori (pre-finished, item 115), 1 BASELINE `stock_movements`, baseline №17.
- Yarim tayyor konventsiyasi (egasi ta'rifi 2026-08-18): `products` qatori **in_sales=t, in_production=t** bilan; `raw_materials` qatori 22 127 kg / 1.00 USD; «Boshlang'ich balans» IN yozuvi bilan.
- Himoyalar: Sholcha fuzzy guard («1-5 metr Sholcha Sariq» istisno), MAX sku assert (113), nol qoldiqlarga ruxsat + nom to'qnashuv tekshiruvi — toza o'tdi.

---

*Biz taxmin qilmaymiz. Biz bilamiz.*
