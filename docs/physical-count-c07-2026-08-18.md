# C-07 — REAL FIZIK SANOQ (2026-08-18) — BASELINE YUKLANDI

**Holat:** BAZAGA YUKLANDI (LOADED) — `physical_baselines` (C-07), 2026-08-18.
**Manba:** egasining 2026-08-18 xabari — real count, tasnif: 2 PRE-FINISHED + 1 RAW, JAMI berilgan.
**Audit reference:** PHYSICAL-COUNT-C07-2026-08-18

---

## 1. Pozitsiyalar (3 ta)

| # | Nom (kanonik) | Tasnif | kg | Item (SKU) |
|---|---|---|---|---|
| 1 | 0.5 mm Babin Sariq | yarim tayyor | 1 065.50 | TM-000111 (yangi) |
| 2 | Qop ip 800 gramm | yarim tayyor | 2 140.00 | TM-000112 (yangi) |
| 3 | Polipropilen CF 1000D Oq | xomashyo | 7 200.00 | TM-000113 (yangi) |
| **JAMI** | | | **10 405.50** | ✓ egasi bergan JAMI bilan mos |

## 2. Egasi qarorlari va normalizatsiya

- Sanoqda **«Qop ip»** rangsiz kelgan. Savol berildi (Qizil? Yashil? yangi?) — javob: **«bu Qop ip 800 gr deb kiri alohida»** → mavjud bot mahsuloti «Qop ip 800 gramm» nomi kanonik qilindi, Qizil/Yashilga QO'SHILMADI, yangi TM-000112 ochildi. Qisqa shakl «Qop ip 800 gr» → `item_aliases` (source: physical_count).
- **«0.5 mm Babin Sariq»** — C-10 qaroriga muvofiq (Babin sanoq nomlari bot dona mahsulotlaridan alohida) yangi TM-000111. Katalogda 0.4/0.6 Sariq va 0.5 Qora bor edi; 0.5 Sariq yangi.
- **«Polipropilen CF 1000D Oq»** — CF 1000D oilasida yangi rang (Yashil/Qizil/Ko'k/Sariq/Qora bor edi). Oila narxi qo'llandi: **1.75 USD/kg**.
- «Qop ip 800 gramm» narxi Qop ip oilasi precedenti bo'yicha: **2.50 USD/kg** (Qizil/Yashil kabi). Xohlasangiz o'zgartiring.

## 3. ERP holati

- C-07 = DB ID 13 (container). Yuklashdan oldin: bo'sh, baseline yo'q. Yuklandi: 3 `inventory`, 3 BASELINE `stock_movements`, baseline №16.
- Yarim tayyor konventsiyasi (egasi ta'rifi 2026-08-18): «0.5 mm Babin Sariq» products'ga **in_sales=t, in_production=t** bilan qo'shildi; «Qop ip 800 gramm» products'da allaqachon bor edi (t/t) — tegilmadi. Ikkalasi raw_materials'da ham.
- CF Oq — RAW: faqat raw_materials (products'siz).
- Himoyalar: Babin fuzzy guard (ma'lum 10 yozuv istisno), CF 1000D fuzzy guard (ma'lum 5 rang istisno), MAX sku assert (110) — hammasi toza o'tdi.

---

*Biz taxmin qilmaymiz. Biz bilamiz.*
