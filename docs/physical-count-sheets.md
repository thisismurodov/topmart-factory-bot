# Fizik inventarizatsiya — YAKUNIY SANOQ VARAQLARI

*Tayyorlandi: 2026-08-14. Manba: jonli baza (faqat SELECT). Holat: egasi tomonidan buyurtilgan (decision pack qabul qilingandan keyingi qadam).*

Bog'liq: `docs/q1-q10-decision-pack.md` (7-bo'lim asos), `docs/p1-data-mapping.md`, `docs/canonical-inventory-architecture-audit.md`.

## MAJBURIY TARTIB (egasi belgilagan)

```
COUNT → RECONCILIATION → PROPOSAL → USER APPROVAL → ADJUSTMENT
```

- Sanoq tugamaguncha **hech qanday** inventory'ga ta'sir qiluvchi migration/adjustment boshlanmaydi.
- Adjustment'ni tizim (Replit) o'zi bajarmaydi — faqat sizning yozma tasdig'ingizdan keyin.
- Sanoq davomida tizimda kirim/chiqim qilinmasin (yoki qilinsa — varaqqa vaqti bilan yozilsin).

## Sanoq rekvizitlari (to'ldiring)

| Maydon | Qiymat |
|---|---|
| Sanoq sanasi | ______________ |
| Mas'ul shaxs | ______________ |
| Sanoqchi 1 | ______________ |
| Sanoqchi 2 | ______________ |
| Tekshiruvchi (imzo) | ______________ |

## Qoidalar

1. Har bir joyda **dona alohida, kg alohida** yoziladi (kerak bo'lsa metr ham) — bittasini ikkinchisidan hisoblab chiqarmang, ikkalasini ham o'lchang.
2. Ro'yxatda YO'Q narsa topilsa — varaq oxiriga yangi qator qilib qo'shing (nomi, joyi, miqdori, birligi).
3. KUTILGAN ustuni tizim ko'rsatkichi — unga qarab "moslashtirmang", REAL SANOQ mustaqil o'tkaziladi.
4. Minus kutilgan qatorlar (🔴) fizikada bo'lmaydi — u qatorlar uchun REAL SANOQ yangi ochilish balansi bo'ladi.
5. Har varaq to'lgach sanoqchi va tekshiruvchi imzo qo'yadi.

## ⚠ MAXSUS NAZORAT (egasi ajratgan 2 ta holat)

**1. SHOLCHA oilasi** — mahsulotlar (Sholcha Oq/Sariq) xomashyodan 3 kun OLDIN kirgan; 107 000 birlikning kelib chiqishi va birligi (kg'mi/dona'mi) tasdiqlanmagan. Sanoqda: **donasini ham sanang, tortib kg'ini ham yozing** (kamida 3 joydan namunaviy tortish: 1 dona o'rtacha og'irligi chiqsin). Hech qanday merge/transformation taxmini qilinmaydi.

**2. ARQON BO'LIM 3 WIP = −8 810.97 kg** — 167 ta PRODUCE yozuvi bor, RECEIVE yo'q (bir tomonlama ledger). Bu alohida reconciliation case: sanoqda liniyadagi real materialni o'lchang, tranzaksiya auditi alohida o'tkaziladi. Avtomatik 0 ga tushirish TAQIQLANGAN.

---

## VARAQ 1 — Xomashyo konteynerlari

| # | Konteyner | Material | Birlik | KUTILGAN | REAL SANOQ (kg) | REAL SANOQ (dona, agar donali) | FARQ | Izoh |
|---|---|---|---|---|---|---|---|---|
| 1 | C-01 | Sholcha ⚠**SHOLCHA** | kg | 25 000 kg | ______ | ______ | ______ | |
| | **JAMI** | | | **25 000** | ______ | | | |

Sanoqchi imzosi: ______________  Tekshiruvchi: ______________

## VARAQ 2 — Tayyor mahsulot konteynerlari

| # | Konteyner | Mahsulot | SKU | Tizim birligi | KUTILGAN miqdor | KUTILGAN og'irlik (kg) | REAL dona | REAL kg | REAL metr (kerak bo'lsa) | FARQ | Izoh |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | C-01 | Sholcha Oq ⚠**SHOLCHA** | `SHOLCHAOQUZUN` | kg | 25 000 | 0 | ______ | ______ | ______ | ______ | |
| 2 | C-03 | Sholcha Sariq ⚠**SHOLCHA** | `SHOLCHASARIQKALTA` | kg | 10 000 | 0 | ______ | ______ | ______ | ______ | |
| 3 | C-05 | Ikki Qavat Arqon / 4 kg | `DVAR/4KG` | kg | 700 | 3 292.65 | ______ | ______ | ______ | ______ | |
| 4 | C-05 | Ikki Qavat Arqon / 5 kg | `DVAR/5KG` | kg | 812 | 4 044.42 | ______ | ______ | ______ | ______ | |
| 5 | C-05 | Ikki Qavat Arqon / 6 kg | `DVAR/6kg` | kg | 479 | 2 812.67 | ______ | ______ | ______ | ______ | |
| 6 | C-05 | Kurtka Tros 4-5 kg | `KURTKATROS45` | kg | 26 | 151.9 | ______ | ______ | ______ | ______ | |
| 7 | C-08 | Sholcha Sariq ⚠**SHOLCHA** | `SHOLCHASARIQKALTA` | kg | 25 000 | 0 | ______ | ______ | ______ | ______ | |
| 8 | C-09 | Sholcha Oq ⚠**SHOLCHA** | `SHOLCHAOQUZUN` | kg | 22 000 | 0 | ______ | ______ | ______ | ______ | |
| 9 | C-13 | Sholcha Sariq ⚠**SHOLCHA** | `SHOLCHASARIQKALTA` | kg | 25 000 | 0 | ______ | ______ | ______ | ______ | |
| 10 | C-16 | Qop Ip - 100 talik | `QP100` | dona | 77 900 | 0 | ______ | ______ | ______ | ______ | |
| 11 | C-16 | Qop ip - 120 talik | `QP120` | dona | 9 240 | 0 | ______ | ______ | ______ | ______ | |
| 12 | C-16 | Qop ip - 80 talik | `QP80` | dona | 3 040 | 0 | ______ | ______ | ______ | ______ | |
| 13 | C-17 | Reja ip 100 gr / Oq | `RJ100OQ` | dona | 8 800 | 0 | ______ | ______ | ______ | ______ | |
| 14 | C-17 | Reja ip 100 gr / Qora | `RJ100QORA` | dona | 10 200 | 0 | ______ | ______ | ______ | ______ | |
| 15 | C-17 | Reja ip 100 gr / Sariq | `RJ100SARIQ` | dona | 12 680 | 0 | ______ | ______ | ______ | ______ | |
| 16 | C-17 | Reja ip 30 gr / OQ | `RJ30OQ` | dona | 12 400 | 0 | ______ | ______ | ______ | ______ | |
| 17 | C-17 | Reja ip 30 gr / Qora | `RJ30QORA` | dona | 18 800 | 0 | ______ | ______ | ______ | ______ | |
| 18 | C-17 | Reja ip 30 gr / Sariq | `RJ30SARIQ` | dona | 25 600 | 0 | ______ | ______ | ______ | ______ | |
| 19 | C-17 | Reja ip 50 gr / OQ | `RJ50OQ` | dona | 12 800 | 0 | ______ | ______ | ______ | ______ | |
| 20 | C-17 | Reja ip 50 gr / Qora | `RJ50QORA` | dona | 23 800 | 0 | ______ | ______ | ______ | ______ | |
| 21 | C-17 | Reja ip 50 gr / Sariq | `RJ50SARIQ` | dona | 22 400 | 0 | ______ | ______ | ______ | ______ | |
| 22 | C-17 | Reja ip PP / 50 gr | `REPP50GR` | dona | 100 | 0 | ______ | ______ | ______ | ______ | |

*Sholcha qatorlari uchun: REAL dona VA REAL kg ikkalasi majburiy (maxsus nazorat №1).*

Sanoqchi imzosi: ______________  Tekshiruvchi: ______________

## VARAQ 3 — Umumiy omborlar

### 3a. Kutilgan qoldig'i bor omborlar (shu jumladan 20 ta minus qator)

| # | Ombor | Item | SKU | Turi | Birlik | KUTILGAN miqdor | KUTILGAN og'irlik (kg) | REAL dona | REAL kg | FARQ | Izoh |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Namangan Markaziy Ombor | PP 2 X 1500 / OQ 🔴 | `PP2X15OQ` | tayyor | kg | −1 883 | 0 | ______ | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi bo'ladi |
| 2 | Namangan Markaziy Ombor | Ikki Qavat Arqon / 5 kg 🔴 | `DVAR/5KG` | tayyor | kg | −1 158 | −5 921.8 | ______ | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi bo'ladi |
| 3 | Namangan Markaziy Ombor | Polyamide 144 🔴 | `ply144` | tayyor | kg | −931 | 0 | ______ | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi bo'ladi |
| 4 | Namangan Markaziy Ombor | Shlanka PP / Oq 🔴 | `SHLPP/OQ` | tayyor | kg | −798 | 0 | ______ | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi bo'ladi |
| 5 | Namangan Markaziy Ombor | Ikki Qavat Arqon / 6 kg 🔴 | `DVAR/6kg` | tayyor | kg | −429 | −2 405.67 | ______ | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi bo'ladi |
| 6 | Namangan Markaziy Ombor | Polyamide Cord 0.3mm 🔴 | `PLYCORD03` | tayyor | kg | −410 | 0 | ______ | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi bo'ladi |
| 7 | Namangan Markaziy Ombor | Ikki Qavat Arqon / 4 kg 🔴 | `DVAR/4KG` | tayyor | kg | −235 | −975.69 | ______ | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi bo'ladi |
| 8 | Namangan Markaziy Ombor | Shroki 3.5 🔴 | `shrk35` | tayyor | kg | −125 | 0 | ______ | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi bo'ladi |
| 9 | Namangan Markaziy Ombor | Shlanka FDY / OQ 🔴 | `SHFDY/OQ` | tayyor | dona | −104 | 0 | ______ | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi bo'ladi |
| 10 | Namangan Markaziy Ombor | PP 2 X 1500 / Qizil 🔴 | `PP2X1500/QIZIL` | tayyor | kg | −88 | 0 | ______ | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi bo'ladi |
| 11 | Namangan Markaziy Ombor | Shlanka PP / Rangli 🔴 | `SHLPP/RANGli` | tayyor | kg | −68 | 0 | ______ | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi bo'ladi |
| 12 | Namangan Markaziy Ombor | 5 mm Gibrid Lenta 🔴 | `5MMGIBRID` | tayyor | kg | −52 | 0 | ______ | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi bo'ladi |
| 13 | Namangan Markaziy Ombor | Tortqi Polyamide 🔴 | `TORTPOLYD` | tayyor | dona | −50 | 0 | ______ | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi bo'ladi |
| 14 | Namangan Markaziy Ombor | Shlanka FDY/ Ko'k 🔴 | `SHFDY/KOK` | tayyor | dona | −32 | 0 | ______ | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi bo'ladi |
| 15 | Namangan Markaziy Ombor | Shlanka FDY / QIzil 🔴 | `SHFDY/QIZIL` | tayyor | dona | −32 | 0 | ______ | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi bo'ladi |
| 16 | Namangan Markaziy Ombor | Shlanka FDY/Yashil 🔴 | `SHFDY/YASHIL` | tayyor | dona | −32 | 0 | ______ | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi bo'ladi |
| 17 | Namangan Markaziy Ombor | Ikki Qavat Arqon Rangli 🔴 | `IKKIRANAR` | tayyor | kg | −27 | 0 | ______ | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi bo'ladi |
| 18 | Namangan Markaziy Ombor | Shlanka FDY / Qora 🔴 | `SHFDY/QORA` | tayyor | dona | −16 | 0 | ______ | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi bo'ladi |
| 19 | Namangan Markaziy Ombor | Strupa Sari 🔴 | `ST70M` | tayyor | kg | −13 | 0 | ______ | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi bo'ladi |
| 20 | Namangan Markaziy Ombor | Qora Rang 🔴 | `QOra` | tayyor | kg | −4 | 0 | ______ | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi bo'ladi |

### 3b. Bo'sh deb kutilayotgan joylar (tasdiqlash majburiy)

| # | Joy | Turi | Holat (belgilang) | Topilgan bo'lsa nima/qancha |
|---|---|---|---|---|
| 1 | C-02 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 2 | C-04 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 3 | C-06 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 4 | C-07 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 5 | C-10 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 6 | C-11 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 7 | C-12 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 8 | C-14 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 9 | C-15 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 10 | C-18 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 11 | C-19 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 12 | C-20 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 13 | C-21 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 14 | C-22 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 15 | C-23 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 16 | C-24 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 17 | C-25 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 18 | C-26 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 19 | C-27 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 20 | C-28 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 21 | C-29 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 22 | C-30 | konteyner | BO'SH ☐ / STOK TOPILDI ☐ | |
| 23 | Andijon Ombori | ombor | BO'SH ☐ / STOK TOPILDI ☐ | |
| 24 | Fargona Ombori | ombor | BO'SH ☐ / STOK TOPILDI ☐ | |
| 25 | Namangan-1 | ombor | BO'SH ☐ / STOK TOPILDI ☐ | |
| 26 | Namangan-2 | ombor | BO'SH ☐ / STOK TOPILDI ☐ | |
| 27 | Toshkent Ombori | ombor | BO'SH ☐ / STOK TOPILDI ☐ | |

Sanoqchi imzosi: ______________  Tekshiruvchi: ______________

## VARAQ 4 — WIP (liniyalardagi tugallanmagan ishlab chiqarish)

| # | Liniya | Bo'lim | KUTILGAN WIP (kg) | REAL WIP (kg) | FARQ | Izoh |
|---|---|---|---|---|---|---|
| 1 | 6 | Arqon Bo'lim 3 | −8 810.97 | ______ | ______ | 🔴 ALOHIDA RECONCILIATION CASE: 167 ta PRODUCE, 0 ta RECEIVE — bir tomonlama ledger. Avtomatik 0 ga tushirish TAQIQLANGAN |
| 2 | 8 | Lenta 1 | 0 | ______ | ______ |  |
| 3 | 9 | Qop Ip | 0 | ______ | ______ |  |
| 4 | 10 | Arqon Bo'limi | 0 | ______ | ______ |  |
| 5 | 97 | Naycha | 0 | ______ | ______ |  |

Sanoqchi imzosi: ______________  Tekshiruvchi: ______________

## VARAQ 5 — Global xomashyo balansi

*Global KUTILGAN = raw_materials jadvalidagi tizim qoldig'i. REAL jami = shu material bo'yicha BARCHA joylardagi sanoqlar yig'indisi (Varaq 1 + Varaq 3 + liniyalardagi).*

| # | Material | Birlik | Global KUTILGAN | Konteynerlarda (tizim) | REAL jami sanoq | FARQ | Izoh |
|---|---|---|---|---|---|---|---|
| 1 | Babin Qora 0.5 mm 🔴 | kg | −1 018.96 | 0 | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi |
| 2 | Babin Sariq 0.4 | kg | 5 000 | 0 | ______ | ______ |  |
| 3 | Babin Sariq 0.5 mm 🔴 | kg | −1 844.96 | 0 | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi |
| 4 | Cord Maloshni | kg | 0 | 0 | ______ | ______ |  |
| 5 | FDY YARN | kg | 0 | 0 | ______ | ______ |  |
| 6 | Kanob | kg | 0 | 0 | ______ | ______ |  |
| 7 | Polipropilen 2 x 1500 / OQ 🔴 | kg | −12 092.3 | 0 | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi |
| 8 | Polipropilen 2 x 1500 / rangli | kg | 0 | 0 | ______ | ______ |  |
| 9 | Polipropilen BSF 🔴 | kg | −117 | 0 | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi |
| 10 | Polipropilen ip | kg | 0 | 0 | ______ | ______ |  |
| 11 | Polyamide | kg | 0 | 0 | ______ | ______ |  |
| 12 | PP Xom oq | kg | 0 | 0 | ______ | ______ |  |
| 13 | pp xom rangli | kg | 0 | 0 | ______ | ______ |  |
| 14 | Qazi ip | kg | 0 | 0 | ______ | ______ |  |
| 15 | Qop ip 🔴 | kg | −255 | 0 | ______ | ______ | minus — REAL SANOQ yangi ochilish balansi |
| 16 | Salafan | kg | 0 | 0 | ______ | ______ |  |
| 17 | Sholcha ⚠**SHOLCHA** | kg | 25 000 | 25 000 | ______ | ______ |  |

Sanoqchi imzosi: ______________  Tekshiruvchi: ______________

## VARAQ 6 — Yakuniy solishtirish (sanoqdan KEYIN to'ldiriladi)

Har bir farq quyidagi 4 tasnifdan biriga kiritiladi (egasi belgilagan):

| Tasnif | Ma'nosi |
|---|---|
| **Kamomad (shortage)** | REAL < KUTILGAN, sabab aniqlanmagan yo'qotish |
| **Ortiqcha (surplus)** | REAL > KUTILGAN, hujjatsiz kirim |
| **Tushuntirilmagan (unexplained)** | farqning manbasi tranzaksiya tarixidan topilmadi |
| **Tarixiy ma'lumot xatosi (historical data issue)** | omborsiz davr / bir tomonlama ledger / noto'g'ri birlik kabi isbotlangan tizim sababi |

| # | Item / SKU | Joy | Birlik | KUTILGAN | REAL | FARQ | Tasnif | Keyingi qadam (taklif) |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | Kamomad ☐ Ortiqcha ☐ Tushuntirilmagan ☐ Tarixiy ☐ | |
| 2 | | | | | | | Kamomad ☐ Ortiqcha ☐ Tushuntirilmagan ☐ Tarixiy ☐ | |
| 3 | | | | | | | Kamomad ☐ Ortiqcha ☐ Tushuntirilmagan ☐ Tarixiy ☐ | |
| 4 | | | | | | | Kamomad ☐ Ortiqcha ☐ Tushuntirilmagan ☐ Tarixiy ☐ | |
| 5 | | | | | | | Kamomad ☐ Ortiqcha ☐ Tushuntirilmagan ☐ Tarixiy ☐ | |
| … | | | | | | | | |

**Shu varaq to'lgandan keyingina** EXPECTED vs REAL taqqoslash reporti tuziladi va adjustment PROPOSAL tayyorlanadi. Proposal sizning tasdig'ingizsiz bajarilmaydi.

---

*Ushbu hujjat faqat o'qish rejimida tayyorlangan: bazaga, BOM'ga, SKU'larga, inventarga hech qanday o'zgarish kiritilmagan. P2 boshlanmagan.*
