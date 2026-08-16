# C-15 — REAL FIZIK SANOQ TAFSILOTI (2026-08-16) — BASELINE NOMZOD

**Holat:** FAQAT HUJJATGA YOZIB OLINDI — bazaga yozish YO'Q, migratsiya YO'Q, adjustment YO'Q, SKU yaratish YO'Q (egasining shu xabardagi taqiqlariga aynan amal qilindi).
**Manba:** egasining 2026-08-16 tasdiqlash xabari (C-15 pozitsiya tafsiloti).
**Aloqa:** 9 joylik jami fizik baseline (71 862.20 kg) tarkibidagi C-15 ulushi. Asosiy reja: `docs/inventory-reset-implementation-proposal.md`.
**Audit reference:** PHYSICAL-COUNT-C15-2026-08-16

---

## 1. Pozitsiyalar (nomlar aynan, 3 ta)

| # | Nom | kg |
|---|---|---|
| 1 | Polipropilen CF 1000D Qizil | 3 720.00 |
| 2 | Polipropilen CF 1000D Ko'k | 3 840.00 |
| 3 | Polipropilen CF 1000D Sariq | 5 460.00 |
| **JAMI** | | **13 020.00** |

Arifmetik tekshiruv: 3 720.00 + 3 840.00 + 5 460.00 = **13 020.00 kg** ✓ — ilgari qayd etilgan C-15 jami bilan aynan mos; 9 joylik umumiy summa **71 862.20 kg** o'zgarmadi.

Eslatma: faqat kg berilgan (dona/bobina soni yo'q) — kg-itemlarda `quantity` semantikasi savoli (taklif §16) shu qatorlarga ham tegishli. Ranglar alohida qoladi (Qizil / Ko'k / Sariq — 3 mustaqil pozitsiya).

## 2. ERP joriy holati (faqat o'qildi, 2026-08-16)

- C-15 = DB ID 21 (container, sig'im 20 000 kg, **purpose: `finished`**) — inventar qatorlari: **0** (ERP bu konteynerni bo'sh deb biladi).
- ⚠️ Kuzatuv (qaror EMAS): konteyner maqsadi `finished`, lekin fizik tarkib sof XOMASHYO (polipropilen filament). Kelajakdagi purpose nazorati (R-E) uchun egasi qarori kerak — taklif §16'dagi savollar ro'yxatida.

## 3. Katalog mosligi (kuzatuv, mapping EMAS)

Jonli tekshiruv (faqat SELECT, 2026-08-16): `raw_materials` (17 nom)da «CF» ham, «1000D» ham uchramaydi — **EXACT mos: 0/3**. Yaqin oilalar (faqat NOMZOD sifatida, hech narsa ulanmadi): «Polipropilen ip», «PP Xom oq», «pp xom rangli», «Polipropilen 2 x 1500 / OQ», «Polipropilen 2 x 1500 / rangli». `products`da ham aynan mosi yo'q (eng yaqini: «Polipropilen Oq 2 x 1500»). Qaror — R-C bosqichida, faqat egasi bilan; avto-merge/avto-SKU YO'Q.

---

*Biz taxmin qilmaymiz. Biz bilamiz.*
