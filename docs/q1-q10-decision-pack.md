# Q1–Q10 Decision Pack — kanonik items uchun yakuniy qarorlar to'plami

*Tayyorlandi: 2026-08-14. Manba: jonli baza (faqat O'QISH — SELECT). Ushbu hujjatni tayyorlashda hech qanday merge, rename, adjustment, migration yoki tranzaksiyaga ta'sir qiluvchi o'zgarish QILINMADI.*

Bog'liq hujjatlar: `docs/canonical-inventory-architecture-audit.md` (arxitektura, 15 qoida — TASDIQLANGAN), `docs/p1-data-mapping.md` (A–H ma'lumot xaritasi).

Maqsad: **REAL DATA → DECISION → CANONICAL MODEL → SAFE MIGRATION.** Taxmin qilmaymiz — bilamiz.

---

## 1. Q1 — SHOLCHA oilasi: barcha faktlar bitta jadvalda

| Jihat | Xomashyo: "Sholcha" (#8) | Mahsulot: "Sholcha Oq" | Mahsulot: "Sholcha Sariq" |
|---|---|---|---|
| Hozirgi yozuv | raw_materials qatori | products qatori | products qatori |
| SKU | — (xomashyoda SKU maydoni yo'q; kanonik SKU P2'da beriladi) | `SHOLCHAOQUZUN` | `SHOLCHASARIQKALTA` |
| Joriy qoldiq | 25 000 kg | 47 000 (tizim birligi: **kg**, lekin og'irlik ustuni 0 ⚠) | 60 000 (tizim birligi: **kg**, og'irlik ustuni 0 ⚠) |
| BOM | — (o'zi 3 ta retseptda material: quyida) | 1 kg mahsulot = **1.0 kg Sholcha** (kg-ga-kg) | 1 kg mahsulot = **1.0 kg Sholcha** (kg-ga-kg) |
| Tarixiy tranzaksiyalar | 1 ta IN: 2026-06-27, 25 000 kg, C-01 ("Xom ashyo kirimi") | 2 ta IN: 2026-06-24 ("Umumiy Partiya") | 3 ta IN: 2026-06-24 ("Umumiy Partiya") |
| Ishlab chiqarish partiyalari | — | **0 ta** | **0 ta** |
| Sotuvlar | 0 | **0** (in_sales=false) | **0** (in_sales=false) |
| Konteyner qoldig'i | C-01: 25 000 kg | C-01: 25 000 + C-09: 22 000 (og'irlik **0** yozilgan) | C-03: 10 000 + C-08: 25 000 + C-13: 25 000 (og'irlik **0**) |
| WIP | 0 | 0 | 0 |
| Bazadan MA'LUM bo'lgan fizik ma'no | rulon/massa holidagi xomashyo, kg'da | tizimda kg turidagi mahsulot; SKU'da "UZUN" so'zi bor | tizimda kg turidagi mahsulot; SKU'da "KALTA" so'zi bor |
| NOMA'LUM (bazada javobi yo'q) | 107 000 birlik shu 25 t'dan qilinganmi — **YO'Q: mahsulotlar 06-24 kirgan, xomashyo 06-27 kelgan** (mahsulot xomashyodan OLDIN mavjud) | "47 000" REALda kg'mi yoki dona'mi — tizim kg deydi, lekin og'irlik ustuni 0 (kg bo'lsa og'irlik ham 47 000 bo'lishi kerak edi); kg deb olsak jami 107 t > ombordagi 25 t | Oq/Sariq farqi faqat rangmi yoki o'lcham hammi (SKU'lar UZUN/KALTA deydi — o'lcham farqi ehtimoli) |

**Barcha 6 ta harakat (to'liq):**

| Sana | Item | Turi | Harakat | Miqdor | Qayerga | Izoh | Kim |
|---|---|---|---|---|---|---|---|
| 2026-06-24 | Sholcha Oq | tayyor | IN | 25 000 | C-01 | Umumiy Partiya | admin |
| 2026-06-24 | Sholcha Sariq | tayyor | IN | 10 000 | C-03 | Umumiy Partiya | admin |
| 2026-06-24 | Sholcha Sariq | tayyor | IN | 25 000 | C-08 | Umumiy Partiya | admin |
| 2026-06-24 | Sholcha Oq | tayyor | IN | 22 000 | C-09 | Umumiy Partiya | admin |
| 2026-06-24 | Sholcha Sariq | tayyor | IN | 25 000 | C-13 | Umumiy Partiya | admin |
| 2026-06-27 | Sholcha | xomashyo | IN | 25 000 | C-01 | Xom ashyo kirimi: 25000 kg | admin |

### Q1 variantlari (hech biri hozir amalga oshirilmaydi)

| | A) 3 alohida item | B) 1 item + variantlar | C) Sholcha → Oq/Sariq transformation |
|---|---|---|---|
| Mohiyati | Har biri o'z SKU'si bilan mustaqil item (xomashyo is_raw, ikkitasi is_manufactured) | Bitta "Sholcha" itemi, rang/o'lcham variant sifatida | Xomashyo alohida item; Oq/Sariq partiyalar orqali undan ishlab chiqariladi (mavjud BOM 1.0 kg ishlaydi) |
| Nimaga tayanadi | Bugungi holatni aynan aks ettiradi | SKU'lardagi UZUN/KALTA farqiga ZID bo'lishi mumkin (variant emas, boshqa o'lcham) | BOM allaqachon shunday sozlangan (1 kg = 1 kg) |
| Tarixga ta'siri | Yo'q — 107 000 birlik ochilish qoldig'i bo'lib qoladi | 107 000 birlik variantlarga bo'linadi | Yo'q — eski 107 000 birlik baribir ochilish qoldig'i (xomashyodan keyin kirgani isbotlangan) |
| Kamchiligi | Transformation avtomatikasi yo'q (keyin qo'shsa bo'ladi) | Kanonik modelda (15 qoida) variant tizimi YO'Q — qamrov kengayadi, P2 kechikadi | Faqat KELAJAK ishlab chiqarishga ta'sir qiladi; o'tmishni tushuntirmaydi |
| Xavf | Minimal | O'rta (yangi kontsept) | Minimal (A bilan birga yashaydi) |

**Muhim:** A va C bir-biriga zid EMAS — A katalog tuzilishi, C esa jarayon. Tavsiya: **A (3 alohida item) + ishlab chiqarish boshlanganda C tabiiy ishlaydi** (BOM tayyor). B faqat "Oq/Sariq bir mahsulotning ranglari xolos" desangiz o'rinli.

**MUHIM savol sizga:** 107 000 raqami aslida NIMA — kilogrammmi yoki dona? Tizimda birlik **kg** deb turibdi, lekin og'irlik ustuni 0. Agar kg bo'lsa — omborda haqiqatan 107 t sholcha bormi (xom Sholcha atigi 25 t)? Agar dona bo'lsa — 1 donasi necha kg va birlik turi tuzatilishi kerak bo'ladi.

- **Egasining qarori (A/B/C):** ______________________

---

## 2. Q2 — MINUS balanslar: rekonsiliatsiya jadvali

Beshala materialda ham manzara BIR XIL: **kirim (xarid) BIRORTA ham kiritilmagan**, barcha chiqimlar partiyalarga nomma-nom bog'langan (izoh maydonida partiya kodi bor).

| Material | Joriy balans (kg) | Jami KIRIM | Jami CHIQIM | Davr | Hisoblangan balans | Tushuntirilmagan farq |
|---|---|---|---|---|---|---|
| Polipropilen 2 x 1500 / OQ | **-12 092.3** | 0 (kirim YO'Q) | 11 948.3 — 211 ta, hammasi partiya | 2026-06-25 → 2026-08-13 | -11 948.3 | **-144** ⚠ |
| Babin Sariq 0.5 mm | **-1 844.96** | 0 (kirim YO'Q) | 1 844.96 — 36 ta, hammasi partiya | 2026-06-24 → 2026-08-13 | -1 844.96 | 0 ✅ |
| Babin Qora 0.5 mm | **-1 018.96** | 0 (kirim YO'Q) | 1 018.96 — 23 ta, hammasi partiya | 2026-06-24 → 2026-08-13 | -1 018.96 | 0 ✅ |
| Qop ip | **-255** | 0 (kirim YO'Q) | 255 — 1 ta, hammasi partiya | 2026-06-24 → 2026-06-24 | -255 | 0 ✅ |
| Polipropilen BSF | **-117** | 0 (kirim YO'Q) | 117 — 3 ta, hammasi partiya | 2026-07-25 → 2026-07-25 | -117 | 0 ✅ |

### Polipropilen 2 × 1500 / OQ — 144 kg farq (ALOHIDA)

| Ko'rsatkich | Qiymat |
|---|---|
| Joriy balans | **-12 092.3 kg** |
| Harakat daftari bo'yicha hisoblangan | -11 948.3 kg (211 ta harakat, 2026-06-25 → 2026-08-13) |
| Tushuntirilmagan farq | **−144.0 kg** |
| Tahlil | Hozirgi kod har qanday qoldiq o'zgarishiga harakat yozadi; demak bu farq **eski kod davrida yoki daftardan tashqari yo'l bilan** kiritilgan. Hozirgi daftardan tiklab BO'LMAYDI. |
| Taklif | Inventarizatsiya (Q10) kuni real sanoq bilan yopiladi — alohida "STOCKTAKE" izli yozuv sifatida. Hozir HECH QANDAY tuzatish kiritilmadi. |

### Rekonsiliatsiya usuli — variantlar

| Variant | Mohiyati | Sharti | Tavsiya |
|---|---|---|---|
| 1. Hujjatli backfill | Haqiqiy xarid invoyslari topilib, sanasi bilan kirim kiritiladi | Invoys/nakladnoylar mavjud bo'lsa | Hujjat bo'lsa — ENG TO'G'RI usul |
| 2. Inventarizatsiya kuni ochilish korreksiyasi | Q10 sanog'ida real qoldiq aniqlanadi, farq "STOCKTAKE" turidagi IZLI yozuv bilan yopiladi | Sanoq o'tkazilishi | **TAVSIYA** — hujjat topilmagan qism uchun |
| 3. Hech narsa qilmaslik | Minus davom etadi | — | Tavsiya etilmaydi (hisob-kitob buziladi) |

**Hech qanday adjustment QILINMADI.** — **Egasining qarori (1/2/aralash):** ______________________

---

## 3. Q3–Q4 — DUBLIKATLAR: har juftlik bo'yicha to'liq karta

**Umumiy sxema (dalil):** har juftlikda bitta qator ESKI (2026-06-17…07-03, BOM/tarix/ombor unda), ikkinchisi **2026-08-08 (Gibrid: 07-28) kuni ommaviy kiritilgan YANGI "toza nomli" nusxa** — deyarli hammasi bo'sh, lekin savdo katalogida ko'rinadi (in_sales=true). Ya'ni: eski qatorlar tarixni, yangilari esa savdo vitrinasini ushlab turibdi.

### Q3.1 — "Qop Ip - 100 talik" ↔ "Qop ip 100 talik"

| Nom | SKU | Yaratilgan | BOM | Ishlab chiq. (dona) | Sotuv | Ombor qoldiq | Harakat | Savdoda ko'rinadi |
|---|---|---|---|---|---|---|---|---|
| Qop Ip - 100 talik | `QP100` | 2026-06-17 | 1 | 3 000 (1 partiya) | 5 000 | 77 900 | 3 | Yo'q |
| Qop ip 100 talik | `QOP-IP-100-TALIK` | 2026-08-08 | 0 | 0 | 0 | 0 | 0 | Ha |

- **Farq turi:** Aynan bir xil nom (chiziqcha/katta-kichik harf farqi)
- **Fizik jihatdan bir xilmi:** Amalda isbotlangan — nom semantikasi bir xil (100 talik qop ipi)
- **Tavsiya etilgan kanonik yozuv:** Eski qator (QP100) qoladi — butun tarix unda; ko'rinadigan nom sifatida egasi xohlagan yozuv tanlanadi
- **Merge xavfi:** PAST — yangi qator bo'sh (0 foydalanish), shunchaki arxivlanadi; hech narsa repoint qilinmaydi
- **Egasining qarori:** ______________________

### Q3.2 — "Qop ip - 80 talik" ↔ "Qop ip 80 talik"

| Nom | SKU | Yaratilgan | BOM | Ishlab chiq. (dona) | Sotuv | Ombor qoldiq | Harakat | Savdoda ko'rinadi |
|---|---|---|---|---|---|---|---|---|
| Qop ip - 80 talik | `QP80` | 2026-06-17 | 1 | 0 | 2 000 | 3 040 | 1 | Yo'q |
| Qop ip 80 talik | `QOP-IP-80-TALIK` | 2026-08-08 | 0 | 0 | 2 000 | 0 | 0 | Ha |

- **Farq turi:** Aynan bir xil nom (chiziqcha farqi)
- **Fizik jihatdan bir xilmi:** Amalda isbotlangan — nom semantikasi bir xil
- **Tavsiya etilgan kanonik yozuv:** Eski qator (QP80) qoladi; yangi qatordagi 2 000 dona sotuv unga repoint qilinadi
- **Merge xavfi:** O'RTA — IKKALA tomonda ham sotuv bor (2 000 + 2 000 dona); sale_items'da nom almashtiriladi, summalar o'zgarmaydi
- **Egasining qarori:** ______________________

### Q4.3 — "Reja ip PP / 115 gr" ↔ "Reja ip PP 115 gramm"

| Nom | SKU | Yaratilgan | BOM | Ishlab chiq. (dona) | Sotuv | Ombor qoldiq | Harakat | Savdoda ko'rinadi |
|---|---|---|---|---|---|---|---|---|
| Reja ip PP / 115 gr | `REPP115GR` | 2026-06-17 | 1 | 0 | 0 | 0 | 0 | Yo'q |
| Reja ip PP 115 gramm | `REJA-IP-PP-115-GRAMM` | 2026-08-08 | 0 | 0 | 0 | 0 | 0 | Ha |

- **Farq turi:** Format farqi: gr ↔ gramm
- **Fizik jihatdan bir xilmi:** Amalda isbotlangan — 115 gramm = 115 gr, birlik dona
- **Tavsiya etilgan kanonik yozuv:** Eski qator (REPP115GR, BOM'li) qoladi
- **Merge xavfi:** PAST — yangi qator bo'sh
- **Egasining qarori:** ______________________

### Q4.4 — "Reja ip PP / 50 gr" ↔ "Reja ip PP 50 gramm"

| Nom | SKU | Yaratilgan | BOM | Ishlab chiq. (dona) | Sotuv | Ombor qoldiq | Harakat | Savdoda ko'rinadi |
|---|---|---|---|---|---|---|---|---|
| Reja ip PP / 50 gr | `REPP50GR` | 2026-06-17 | 1 | 100 (1 partiya) | 0 | 100 | 1 | Yo'q |
| Reja ip PP 50 gramm | `REJA-IP-PP-50-GRAMM` | 2026-08-08 | 0 | 0 | 0 | 0 | 0 | Ha |

- **Farq turi:** Format farqi: gr ↔ gramm
- **Fizik jihatdan bir xilmi:** Amalda isbotlangan
- **Tavsiya etilgan kanonik yozuv:** Eski qator (REPP50GR) qoladi — partiya 100 dona + ombordagi 100 dona unda
- **Merge xavfi:** PAST — yangi qator bo'sh
- **Egasining qarori:** ______________________

### Q4.5 — "Reja ip PP / 80 gr" ↔ "Reja ip PP 80 gramm"

| Nom | SKU | Yaratilgan | BOM | Ishlab chiq. (dona) | Sotuv | Ombor qoldiq | Harakat | Savdoda ko'rinadi |
|---|---|---|---|---|---|---|---|---|
| Reja ip PP / 80 gr | `REPP80GR` | 2026-06-17 | 0 | 0 | 1 200 | 0 | 0 | Yo'q |
| Reja ip PP 80 gramm | `REJA-IP-PP-80-GRAMM` | 2026-08-08 | 0 | 0 | 0 | 0 | 0 | Ha |

- **Farq turi:** Format farqi: gr ↔ gramm
- **Fizik jihatdan bir xilmi:** Amalda isbotlangan
- **Tavsiya etilgan kanonik yozuv:** Eski qator (REPP80GR) qoladi — 1 200 dona sotuv tarixi unda
- **Merge xavfi:** PAST — yangi qator bo'sh
- **Egasining qarori:** ______________________

### Q4.6 — "Strupa Sari" ↔ "Strupa Sariq"

| Nom | SKU | Yaratilgan | BOM | Ishlab chiq. (dona) | Sotuv | Ombor qoldiq | Harakat | Savdoda ko'rinadi |
|---|---|---|---|---|---|---|---|---|
| Strupa Sari | `ST70M` | 2026-07-03 | 1 | 0 | 12.6 | -13 | 1 | Yo'q |
| Strupa Sariq | `STRUPA-SARIQ` | 2026-08-08 | 0 | 0 | 0 | 0 | 0 | Ha |

- **Farq turi:** Harf xatosi ehtimoli: Sari ↔ Sariq
- **Fizik jihatdan bir xilmi:** Taxmin — 'Sari' yozuvda 'q' tushib qolgan bo'lishi ehtimol katta, lekin isbot yo'q
- **Tavsiya etilgan kanonik yozuv:** Eski qator (ST70M, BOM'li) qoladi; nom 'Strupa Sariq' deb tuzatiladi
- **Merge xavfi:** PAST-O'RTA — yangi qator bo'sh; lekin identiklik taxmin, egasi tasdiqlashi shart
- **Egasining qarori:** ______________________

### Q4.7 — "5 mm Gibrid Lenta" ↔ "5 MM GIBRID"

| Nom | SKU | Yaratilgan | BOM | Ishlab chiq. (dona) | Sotuv | Ombor qoldiq | Harakat | Savdoda ko'rinadi |
|---|---|---|---|---|---|---|---|---|
| 5 mm Gibrid Lenta | `5MMGIBRID` | 2026-06-17 | 2 | 0 | 121.7 | -52 | 1 | Yo'q |
| 5 MM GIBRID | `5-MM-GIBRID` | 2026-07-28 | 0 | 0 | 0 | 0 | 0 | Ha |

- **Farq turi:** O'xshash nom + SKU TO'QNASHUVI (5MMGIBRID ↔ 5-MM-GIBRID normallashganda bir xil)
- **Fizik jihatdan bir xilmi:** Taxmin — narxlari farq qiladi (27 000 vs 31 000 UZS); bir mahsulotning eski/yangi narxi bo'lishi ham, ikki xil mahsulot bo'lishi ham mumkin
- **Tavsiya etilgan kanonik yozuv:** AGAR bir xil bo'lsa: eski qator (BOM 2 ta, tarix) qoladi, SKU sifatida toza yangi kod (masalan GIBRID-LENTA-5MM) beriladi
- **Merge xavfi:** YUQORI — SKU to'qnashuvi bor; egangiz qoidasiga ko'ra AVTOMATIK MERGE TAQIQLANGAN, faqat qo'lda tasdiq bilan
- **Egasining qarori:** ______________________

### Q4.8 — "Shroki 3.5" ↔ "Shroki 3.5 Oq"

| Nom | SKU | Yaratilgan | BOM | Ishlab chiq. (dona) | Sotuv | Ombor qoldiq | Harakat | Savdoda ko'rinadi |
|---|---|---|---|---|---|---|---|---|
| Shroki 3.5 | `shrk35` | 2026-06-25 | 1 | 0 | 125 | -125 | 1 | Ha |
| Shroki 3.5 Oq | `SHROKI-3-5-OQ` | 2026-08-08 | 0 | 0 | 0 | 0 | 0 | Ha |

- **Farq turi:** O'xshash nom ('Oq' — rang belgisi bo'lishi mumkin)
- **Fizik jihatdan bir xilmi:** ZAIF taxmin — valyutalari boshqa (USD 1.85 vs UZS 32 000), 'Oq' rang spetsifikatsiyasi bo'lishi mumkin → ikki xil mahsulot ehtimoli katta
- **Tavsiya etilgan kanonik yozuv:** Tavsiya: MERGE QILMASLIK — alohida qoldirish; egasi fizik farqni tekshiradi
- **Merge xavfi:** YUQORI — noto'g'ri merge ikki har xil mahsulotni chalkashtiradi
- **Egasining qarori:** ______________________

**SKU to'qnashuvi bo'lgan juftlik (Q4.7) hech qachon avtomatik merge qilinmaydi** — faqat sizning yozma tasdig'ingiz bilan.

---

## 4. Q5 — 4 DUAL material: merge MIGRATION PROPOSAL (bajarilmagan — faqat taklif)

| Eski yozuv (product) | Eski SKU | Nishon (canonical item) | Taklif SKU | Ta'sirlanadigan sotuvlar | Ta'sirlanadigan BOM | Ombor ta'siri |
|---|---|---|---|---|---|---|
| Cord Maloshni (#23) | `CRDMSH` | xomashyo #7 asosida bitta item | `CRDMSH` (saqlanadi) | 1 ta (sotuv #37) — nom o'zgarmaydi | self-BOM 1 qator O'CHADI; "Shakar 1.5 kg" retsepti o'zgarmaydi | product tomonida 0 qator — ko'chadigan narsa yo'q |
| Babin Sariq 0.5 mm (#29) | `BABSA/05` | xomashyo #10 asosida | `BABSA/05` (saqlanadi) | 1 ta (sotuv #41, **QARZ ochiq**) — nom o'zgarmaydi | self-BOM O'CHADI; Reja ip 100/50/30 Sariq + "0.5 Babin / Qora" retseptlari o'zgarmaydi | 0 qator; global −1 844.96 kg Q2 bilan yopiladi |
| Babin Qora 0.5 mm (#30) | `BABQO/05` | xomashyo #11 asosida | `BABQO/05` (saqlanadi) | 1 ta (sotuv #41, **QARZ ochiq**) | self-BOM O'CHADI; Reja ip 100/50/30 Qora retseptlari o'zgarmaydi | 0 qator; global −1 018.96 kg Q2 bilan yopiladi |
| Kanob (#51) | `Kanoblar` (g'alati ko'plik) | xomashyo #16 asosida | **`KANOB`** (yangi toza SKU — tasdiq kerak) | 1 ta (sotuv #42) | self-BOM O'CHADI; boshqa retsept YO'Q | 0 qator |

**To'rttala tarixiy sotuv (to'liq):**

| Sotuv # | Sana | Mijoz | Mahsulot | Miqdor | Narx | Summa | Holat |
|---|---|---|---|---|---|---|---|
| 37 | 2026-06-17 | MIrzohid Aka | Cord Maloshni | 300 kg | $2.2 | $660 | to'langan |
| 41 | 2026-06-17 | Toraboy Amaki | Babin Qora 0.5 mm | 600.1 kg | $3.7 | $2 220.37 | **QARZ (pending)** |
| 41 | 2026-06-17 | Toraboy Amaki | Babin Sariq 0.5 mm | 402.6 kg | $3.5 | $1 409.1 | **QARZ (pending)** |
| 42 | 2026-06-17 | Avazbek Amakim | Kanob | 38.05 kg | $3.75 | $142.69 | to'langan |

⚠ **Sotuv #41 hali QARZ (pending, jami $3 629.47)** — merge'da nom o'zgarmagani uchun qarz hisobiga MUTLAQO ta'sir yo'q; faqat katalogda 2 yozuv 1 ta bo'ladi.

**Xomashyo tomonining jonli retseptlari (merge'da O'ZGARMAYDI):**

| Xomashyo | Qaysi retseptda | Miqdor | Merge'dan keyin |
|---|---|---|---|
| Cord Maloshni (#7) | Shakar 1.5 kg | 1.6 kg/dona | o'zgarmaydi (raw id 7 kanonik itemga aylanadi) |
| Babin Sariq 0.5 mm (#10) | Reja ip 100 gr / Sariq | 0.1 kg/dona | o'zgarmaydi (raw id 10 kanonik itemga aylanadi) |
| Babin Sariq 0.5 mm (#10) | 0.5 Babin / Qora | 0.4 kg/dona | o'zgarmaydi (raw id 10 kanonik itemga aylanadi) |
| Babin Sariq 0.5 mm (#10) | Reja ip 30 gr / Sariq | 0.02 kg/dona | o'zgarmaydi (raw id 10 kanonik itemga aylanadi) |
| Babin Sariq 0.5 mm (#10) | Reja ip 50 gr / Sariq | 0.04 kg/dona | o'zgarmaydi (raw id 10 kanonik itemga aylanadi) |
| Babin Qora 0.5 mm (#11) | Reja ip 50 gr / Qora | 0.04 kg/dona | o'zgarmaydi (raw id 11 kanonik itemga aylanadi) |
| Babin Qora 0.5 mm (#11) | Reja ip 30 gr / Qora | 0.02 kg/dona | o'zgarmaydi (raw id 11 kanonik itemga aylanadi) |
| Babin Qora 0.5 mm (#11) | Reja ip 100 gr / Qora | 0.09 kg/dona | o'zgarmaydi (raw id 11 kanonik itemga aylanadi) |

**O'chiriladigan self-BOM'lar (4 ta, texnik ko'prik):** "Cord Maloshni" ×1; "Babin Sariq 0.5 mm" ×1; "Babin Qora 0.5 mm" ×1; "Kanob" ×1.

**Tarixiy mapping:** nomlar ikkala tomonda AYNAN bir xil → legacy_names jadvalida product-id → canonical-item yozuvi qoladi, barcha eski hisobotlar ishlashda davom etadi.

**Hozir merge QILINMADI.** — **Egasining qarori (4 juftlik + KANOB SKU'si):** ______________________

---

## 5. Q6 — "0.5 Babin / Qora" BOM'idagi rang nomuvofiqligi

| Dalil | Natija |
|---|---|
| Joriy BOM | "0.5 Babin / Qora" (`05BABINQORA`) → **Babin Sariq 0.5 mm x 0.400** (QORA mahsulot SARIQ material iste'mol qiladi) |
| Aka-uka mahsulot | "0.5 babin / oq" (`05BABINOQ`) → **Polyamide x 0.400** (OQ mahsulot Polyamide ishlatadi!) |
| Tarixiy ishlab chiqarish | **0 ta partiya** — ikkala 0.5 Babin mahsuloti ham HECH QACHON partiya orqali ishlab chiqarilmagan → **xato BOM birorta marta ham ishga tushmagan, tarixiy zarar YO'Q** |
| Xomashyo harakatlarida izi | "Babin Sariq 0.5 mm"ning 36 ta chiqimi tekshirildi — "0.5 Babin" partiyasiga tegishlisi: **0 ta** (hammasi Reja ip / boshqa mahsulotlarga) |
| Sotuv dalili | Qora: 48 dona sotilgan (sale_items), Oq: 30 dona — sotuv omborga tegmagan (qoldiq 0) |
| BOM yaratilish/o'zgarish tarixi | **Mavjud emas** — product_materials jadvalida sana maydoni yo'q, audit_logs'da "babin" bo'yicha yozuv 0 ta |
| Joriy ombor | Mahsulot qoldig'i: 0. Xomashyolar: Babin Sariq 0.5 = −1 844.96 kg, Babin Qora 0.5 = −1 018.96 kg (Q2) |

**Mo'ljallangan material bo'yicha 2 gipoteza:**
1. **"Babin Qora 0.5 mm" (#11) × 0.4** — rang mantig'i bo'yicha (Qora mahsulot → Qora material);
2. **"Polyamide" × 0.4** — aka-uka "0.5 babin / oq" sxemasi bo'yicha (u Polyamide ishlatadi).

Tuzatish — faqat sozlama o'zgarishi (retsept qatori), tarixiy qayta hisob-kitob KERAK EMAS (BOM hech qachon ishlamagan). **Hozir hech qanday BOM correction qilinmadi.**

- **Egasining qarori (1/2/boshqa):** ______________________

---

## 6. Q7 — "Babin Sariq 0.4": 5 000 kg harakatsiz qoldiq

| Dalil | Qiymat |
|---|---|
| Joriy balans | **5 000 kg** (USD) |
| Harakatlar soni | **0 ta** — kirim ham, chiqim ham YO'Q |
| Hisoblangan balans | 0 kg → tushuntirilmagan farq **+5 000 kg** |
| BOM'da ishlatilishi | 1 ta retseptda |
| Xulosa | Qoldiq forma orqali bevosita kiritilgan (o'sha davrda daftar yozilmagan). Real mavjudligini FAQAT sanoq tasdiqlaydi. |

**Variantlar:** (a) Q10 sanog'ida tasdiqlanadi → ochilish yozuvi (STOCKTAKE) bilan qonuniylashtiriladi; (b) sanoq boshqa raqam ko'rsatsa → sanoq raqami olinadi. — **Egasining qarori:** ______________________

## Q8 — "Polipropilen ip" (UZS): arxiv nomzodi

| Dalil | Qiymat |
|---|---|
| Joriy balans | 0 | 
| Harakatlar | 0 ta |
| BOM'da ishlatilishi | 0 ta |
| Xulosa | Hech qayerda ishlatilmagan konfiguratsiya qatori. Arxivlash (active=false) hech narsani buzmaydi, istalgan payt qaytariladi. |

- **Egasining qarori (arxiv: ha/yo'q):** ______________________

## Q9 — "Tahoe 50 m": arxiv nomzodi

| Dalil | Qiymat |
|---|---|
| SKU | `th50` |
| Sotuv / partiya / ombor / harakat / BOM | 0 / 0 / 0 / 0 / 0 — hammasi NOL |
| Xulosa | Faqat katalog qatori. Arxivlash xavfsiz, qaytariladigan. |

- **Egasining qarori (arxiv: ha/yo'q):** ______________________

---

## 7. Q10 — INVENTARIZATSIYA: sanoq varaqlari (count sheets)

Qoida: **KUTILGAN** ustunlar tizimdan (bugungi holat, 2026-08-14), **REAL SANOQ** ustunlari qo'lda to'ldiriladi. Farq ustuni sanoqdan keyin hisoblanadi. Sanoq kuni yangi kirim-chiqim to'xtatiladi yoki alohida yoziladi.

### 7.1 Xomashyo konteynerlari
#### C-01, C-03, C-08, C-09, C-10, C-13 (raw maqsadli)

**C-01** (sig'im 20 000 kg)

| # | Item | Turi | KUTILGAN (dona/qty) | KUTILGAN og'irlik (kg) | REAL SANOQ (qty) | REAL og'irlik (kg) | Farq | Izoh |
|---|---|---|---|---|---|---|---|---|
| 1 | Sholcha | xomashyo | 25 000 | 25 000 | ______ | ______ | ______ | ______ |
| 2 | Sholcha Oq | tayyor | 25 000 | 0 | ______ | ______ | ______ | ______ |
| + | *(ro'yxatda yo'q item topilsa)* | | 0 | 0 | ______ | ______ | ______ | ______ |

**C-03** (sig'im 20 000 kg)

| # | Item | Turi | KUTILGAN (dona/qty) | KUTILGAN og'irlik (kg) | REAL SANOQ (qty) | REAL og'irlik (kg) | Farq | Izoh |
|---|---|---|---|---|---|---|---|---|
| 1 | Sholcha Sariq | tayyor | 10 000 | 0 | ______ | ______ | ______ | ______ |
| + | *(ro'yxatda yo'q item topilsa)* | | 0 | 0 | ______ | ______ | ______ | ______ |

**C-08** (sig'im 20 000 kg)

| # | Item | Turi | KUTILGAN (dona/qty) | KUTILGAN og'irlik (kg) | REAL SANOQ (qty) | REAL og'irlik (kg) | Farq | Izoh |
|---|---|---|---|---|---|---|---|---|
| 1 | Sholcha Sariq | tayyor | 25 000 | 0 | ______ | ______ | ______ | ______ |
| + | *(ro'yxatda yo'q item topilsa)* | | 0 | 0 | ______ | ______ | ______ | ______ |

**C-09** (sig'im 20 000 kg)

| # | Item | Turi | KUTILGAN (dona/qty) | KUTILGAN og'irlik (kg) | REAL SANOQ (qty) | REAL og'irlik (kg) | Farq | Izoh |
|---|---|---|---|---|---|---|---|---|
| 1 | Sholcha Oq | tayyor | 22 000 | 0 | ______ | ______ | ______ | ______ |
| + | *(ro'yxatda yo'q item topilsa)* | | 0 | 0 | ______ | ______ | ______ | ______ |

**C-10** (sig'im 20 000 kg) — tizim bo‘yicha BO‘SH (topilgan item bo‘lsa, qo‘shib yozing)


**C-13** (sig'im 20 000 kg)

| # | Item | Turi | KUTILGAN (dona/qty) | KUTILGAN og'irlik (kg) | REAL SANOQ (qty) | REAL og'irlik (kg) | Farq | Izoh |
|---|---|---|---|---|---|---|---|---|
| 1 | Sholcha Sariq | tayyor | 25 000 | 0 | ______ | ______ | ______ | ______ |
| + | *(ro'yxatda yo'q item topilsa)* | | 0 | 0 | ______ | ______ | ______ | ______ |

⚠ Diqqat: xomashyo konteynerlarida TAYYOR mahsulot ham turibdi (Sholcha Oq/Sariq) — bu Q1 bilan bog'liq, sanoqda aynan joyida sanang.

### 7.2 Tayyor mahsulot konteynerlari (nol bo'lmaganlari)
#### C-05, C-16, C-17

**C-05** (sig'im 20 000 kg)

| # | Item | Turi | KUTILGAN (dona/qty) | KUTILGAN og'irlik (kg) | REAL SANOQ (qty) | REAL og'irlik (kg) | Farq | Izoh |
|---|---|---|---|---|---|---|---|---|
| 1 | Ikki Qavat Arqon / 4 kg | tayyor | 700 | 3 292.6 | ______ | ______ | ______ | ______ |
| 2 | Ikki Qavat Arqon / 5 kg | tayyor | 812 | 4 044.4 | ______ | ______ | ______ | ______ |
| 3 | Ikki Qavat Arqon / 6 kg | tayyor | 479 | 2 812.7 | ______ | ______ | ______ | ______ |
| 4 | Kurtka Tros 4-5 kg | tayyor | 26 | 151.9 | ______ | ______ | ______ | ______ |
| + | *(ro'yxatda yo'q item topilsa)* | | 0 | 0 | ______ | ______ | ______ | ______ |

**C-16** (sig'im 20 000 kg)

| # | Item | Turi | KUTILGAN (dona/qty) | KUTILGAN og'irlik (kg) | REAL SANOQ (qty) | REAL og'irlik (kg) | Farq | Izoh |
|---|---|---|---|---|---|---|---|---|
| 1 | Qop Ip - 100 talik | tayyor | 77 900 | 0 | ______ | ______ | ______ | ______ |
| 2 | Qop ip - 120 talik | tayyor | 9 240 | 0 | ______ | ______ | ______ | ______ |
| 3 | Qop ip - 80 talik | tayyor | 3 040 | 0 | ______ | ______ | ______ | ______ |
| + | *(ro'yxatda yo'q item topilsa)* | | 0 | 0 | ______ | ______ | ______ | ______ |

**C-17** (sig'im 20 000 kg)

| # | Item | Turi | KUTILGAN (dona/qty) | KUTILGAN og'irlik (kg) | REAL SANOQ (qty) | REAL og'irlik (kg) | Farq | Izoh |
|---|---|---|---|---|---|---|---|---|
| 1 | Reja ip 100 gr / Oq | tayyor | 8 800 | 0 | ______ | ______ | ______ | ______ |
| 2 | Reja ip 100 gr / Qora | tayyor | 10 200 | 0 | ______ | ______ | ______ | ______ |
| 3 | Reja ip 100 gr / Sariq | tayyor | 12 680 | 0 | ______ | ______ | ______ | ______ |
| 4 | Reja ip 30 gr / OQ | tayyor | 12 400 | 0 | ______ | ______ | ______ | ______ |
| 5 | Reja ip 30 gr / Qora | tayyor | 18 800 | 0 | ______ | ______ | ______ | ______ |
| 6 | Reja ip 30 gr / Sariq | tayyor | 25 600 | 0 | ______ | ______ | ______ | ______ |
| 7 | Reja ip 50 gr / OQ | tayyor | 12 800 | 0 | ______ | ______ | ______ | ______ |
| 8 | Reja ip 50 gr / Qora | tayyor | 23 800 | 0 | ______ | ______ | ______ | ______ |
| 9 | Reja ip 50 gr / Sariq | tayyor | 22 400 | 0 | ______ | ______ | ______ | ______ |
| 10 | Reja ip PP / 50 gr | tayyor | 100 | 0 | ______ | ______ | ______ | ______ |
| + | *(ro'yxatda yo'q item topilsa)* | | 0 | 0 | ______ | ______ | ______ | ______ |

Qolgan tayyor konteynerlar (C-02, C-04, C-06, C-07, C-11, C-12, C-14, C-15, C-18, C-19, C-20, C-21, C-22, C-23, C-24, C-25, C-26, C-27, C-28, C-29, C-30) tizim bo'yicha BO'SH — topilgan item bo'lsa, varaqqa qo'shib yozing.

### 7.3 Umumiy omborlar
#### Namangan Markaziy, Namangan-1/2, Andijon, Farg'ona, Toshkent

**Andijon Ombori** (sig'im 20 000 kg) — tizim bo‘yicha BO‘SH (topilgan item bo‘lsa, qo‘shib yozing)


**Fargona Ombori** (sig'im 20 000 kg) — tizim bo‘yicha BO‘SH (topilgan item bo‘lsa, qo‘shib yozing)


**Namangan-1** (sig'im 20 000 kg) — tizim bo‘yicha BO‘SH (topilgan item bo‘lsa, qo‘shib yozing)


**Namangan-2** (sig'im 20 000 kg) — tizim bo‘yicha BO‘SH (topilgan item bo‘lsa, qo‘shib yozing)


**Namangan Markaziy Ombor** (sig'im 20 000 kg)

| # | Item | Turi | KUTILGAN (dona/qty) | KUTILGAN og'irlik (kg) | REAL SANOQ (qty) | REAL og'irlik (kg) | Farq | Izoh |
|---|---|---|---|---|---|---|---|---|
| 1 | 5 mm Gibrid Lenta | tayyor | -52 | 0 | ______ | ______ | ______ | ______ |
| 2 | Ikki Qavat Arqon / 4 kg | tayyor | -235 | -975.7 | ______ | ______ | ______ | ______ |
| 3 | Ikki Qavat Arqon / 5 kg | tayyor | -1 158 | -5 921.8 | ______ | ______ | ______ | ______ |
| 4 | Ikki Qavat Arqon / 6 kg | tayyor | -429 | -2 405.7 | ______ | ______ | ______ | ______ |
| 5 | Ikki Qavat Arqon Rangli | tayyor | -27 | 0 | ______ | ______ | ______ | ______ |
| 6 | Polyamide 144 | tayyor | -931 | 0 | ______ | ______ | ______ | ______ |
| 7 | Polyamide Cord 0.3mm | tayyor | -410 | 0 | ______ | ______ | ______ | ______ |
| 8 | PP 2 X 1500 / OQ | tayyor | -1 883 | 0 | ______ | ______ | ______ | ______ |
| 9 | PP 2 X 1500 / Qizil | tayyor | -88 | 0 | ______ | ______ | ______ | ______ |
| 10 | Qora Rang | tayyor | -4 | 0 | ______ | ______ | ______ | ______ |
| 11 | Shlanka FDY/ Ko'k | tayyor | -32 | 0 | ______ | ______ | ______ | ______ |
| 12 | Shlanka FDY / OQ | tayyor | -104 | 0 | ______ | ______ | ______ | ______ |
| 13 | Shlanka FDY / QIzil | tayyor | -32 | 0 | ______ | ______ | ______ | ______ |
| 14 | Shlanka FDY / Qora | tayyor | -16 | 0 | ______ | ______ | ______ | ______ |
| 15 | Shlanka FDY/Yashil | tayyor | -32 | 0 | ______ | ______ | ______ | ______ |
| 16 | Shlanka PP / Oq | tayyor | -798 | 0 | ______ | ______ | ______ | ______ |
| 17 | Shlanka PP / Rangli | tayyor | -68 | 0 | ______ | ______ | ______ | ______ |
| 18 | Shroki 3.5 | tayyor | -125 | 0 | ______ | ______ | ______ | ______ |
| 19 | Strupa Sari | tayyor | -13 | 0 | ______ | ______ | ______ | ______ |
| 20 | Tortqi Polyamide | tayyor | -50 | 0 | ______ | ______ | ______ | ______ |
| + | *(ro'yxatda yo'q item topilsa)* | | 0 | 0 | ______ | ______ | ______ | ______ |

**Toshkent Ombori** (sig'im 20 000 kg) — tizim bo‘yicha BO‘SH (topilgan item bo‘lsa, qo‘shib yozing)


⚠ **Namangan Markaziy Ombordagi 20 ta MINUS qator** — omborsiz kamaytirish davrining izi. Fizikada minus bo'lmaydi: REAL SANOQ ustuni shu itemlar uchun yangi ochilish balansi bo'ladi (Q2 usuli bilan izli yopiladi).

### 7.4 WIP (bo'limlardagi tugallanmagan ishlab chiqarish)

| Liniya/Bo'lim | KUTILGAN WIP (kg) | Yozuvlar | REAL SANOQ (kg) | Izoh |
|---|---|---|---|---|
| Arqon Bo'lim 3 | **-8 810.97** ⚠ | 167 ta (faqat PRODUCE) | ______ | Daftar bir tomonlama: RECEIVE yozuvlari YO'Q, material nomi bo'sh — WIP raqami ishonchsiz. Sanoqda bo'limdagi real materiallar ro'yxati bilan yoziladi. |
| Boshqa liniyalar | 0 | — | ______ | Topilgan material bo'lsa yozing |

⚠ **YANGI TOPILMA:** WIP daftari −8 810.97 kg ko'rsatmoqda (fizik jihatdan mumkin emas) — 167 ta PRODUCE yozuvi bor, lekin birorta RECEIVE yo'q. Bu kanonik modeldagi "global = konteynerlar + WIP" qoidasini hozircha buzadi va sanoqda albatta yopilishi kerak.

### 7.5 Global xomashyo balanslari (raw_materials bo'yicha)

| # | Xomashyo | Birlik | KUTILGAN global | REAL (konteynerlar+WIP yig'indisi) | Farq | Izoh |
|---|---|---|---|---|---|---|
| 1 | Babin Qora 0.5 mm | kg | -1 018.96 | ______ | ______ | ______ |
| 2 | Babin Sariq 0.4 | kg | 5 000 | ______ | ______ | ______ |
| 3 | Babin Sariq 0.5 mm | kg | -1 844.96 | ______ | ______ | ______ |
| 4 | Cord Maloshni | kg | 0 | ______ | ______ | ______ |
| 5 | FDY YARN | kg | 0 | ______ | ______ | ______ |
| 6 | Kanob | kg | 0 | ______ | ______ | ______ |
| 7 | Polipropilen 2 x 1500 / OQ | kg | -12 092.3 | ______ | ______ | ______ |
| 8 | Polipropilen 2 x 1500 / rangli | kg | 0 | ______ | ______ | ______ |
| 9 | Polipropilen BSF | kg | -117 | ______ | ______ | ______ |
| 10 | Polipropilen ip | kg | 0 | ______ | ______ | ______ |
| 11 | Polyamide | kg | 0 | ______ | ______ | ______ |
| 12 | PP Xom oq | kg | 0 | ______ | ______ | ______ |
| 13 | pp xom rangli | kg | 0 | ______ | ______ | ______ |
| 14 | Qazi ip | kg | 0 | ______ | ______ | ______ |
| 15 | Qop ip | kg | -255 | ______ | ______ | ______ |
| 16 | Salafan | kg | 0 | ______ | ______ | ______ |
| 17 | Sholcha | kg | 25 000 | ______ | ______ | ______ |

### 7.6 Kategoriya bo'yicha yakun (sanoqdan keyin to'ldiriladi)

| Kategoriya | Itemlar soni | Mos keldi | Farq chiqdi | Izoh |
|---|---|---|---|---|
| Xomashyo (17) | | | | |
| Tayyor — konteynerlarda | | | | |
| Tayyor — umumiy omborlarda | | | | |
| WIP | | | | |

- **Sanoq sanasi:** ______________ **Mas'ul shaxs:** ______________ **Egasining tasdig'i:** ______________

---

## 8. YAKUNIY DECISION TABLE

| Question | Current Evidence | Decision Needed | Options | Recommended | Risk | User Decision |
|---|---|---|---|---|---|---|
| Q1 Sholcha | 25 000 kg xomashyo + 107 000 birlik mahsulot (tizimda kg, og'irlik 0); mahsulotlar xomashyodan 3 kun OLDIN kirgan; BOM 1 kg-ga-1 kg; SKU'larda UZUN/KALTA | Katalog tuzilishi | A) 3 item / B) 1 item+variant / C) transformation | **A + C** (A tuzilish, C jarayon — BOM tayyor) | Past | ______ |
| Q2 Minuslar | 5 material minusda; kirim 0; chiqimlar 100% partiyalarga bog'langan | Yopish usuli | 1) hujjatli backfill / 2) sanoq korreksiyasi / 3) hech narsa | **2** (hujjat topilgan qismga 1) | Past (izli) | ______ |
| Q2b PP 144 kg | Daftardan tiklab bo'lmaydi (eski kod davri) | Yopish usuli | sanoq korreksiyasi | Sanoq bilan | Past | ______ |
| Q3 Qop ip 80/100 | Har juftlikda tarix eski qatorda; 80'da ikkala tomonda sotuv | Qaysi nom/qator qoladi | eski qoladi + yangi arxiv / aksincha | Eski qator (tarix) + siz tanlagan nom | Past–O'rta | ______ |
| Q4 gr↔gramm (3 juftlik) | Yangi qatorlar bo'sh (0 foydalanish); 115/50/80 "gramm" = "gr" | Merge tasdig'i | merge / alohida | Merge (eski qator qoladi) | Past | ______ |
| Q4 Strupa Sari↔Sariq | Eski qatorda BOM + ombor (−13); yangi bo'sh; harf xatosi — TAXMIN, isbot yo'q | Bir mahsulotmi? | merge / alohida | Faqat siz tasdiqlasangiz merge | Past–O'rta | ______ |
| Q4 Gibrid | SKU to'qnashuvi; narx 27k vs 31k | Bir mahsulotmi? | merge (yangi SKU bilan) / alohida | Sizning fizik tekshiruvingizsiz merge YO'Q | Yuqori | ______ |
| Q4 Shroki | Valyuta USD vs UZS; "Oq" belgisi | Bir mahsulotmi? | merge / alohida | **Alohida qoldirish** | Yuqori | ______ |
| Q5 4 dual | Product tomoni bo'sh (faqat 1 tadan sotuv); self-BOM 1:1; nomlar aynan | Merge + KANOB SKU | merge / qoldirish | Merge (nol amaliy ta'sir) + `KANOB` | Past | ______ |
| Q6 Babin BOM | Xato BOM 0 marta ishlagan; aka-uka Polyamide ishlatadi | To'g'ri material | 1) Babin Qora / 2) Polyamide | Siz aytasiz (ishlab chiqarish bilim kerak) | Nol (config) | ______ |
| Q7 Babin 0.4 | 5 000 kg, 0 harakat | Sanoqda tasdiqlash | tasdiqlash / sanoq raqami | Sanoq hal qiladi | Past | ______ |
| Q8 Polipropilen ip | Hamma ko'rsatkich 0 | Arxivlash | ha / yo'q | Arxiv (qaytariladigan) | Nol | ______ |
| Q9 Tahoe 50 m | Hamma ko'rsatkich 0 | Arxivlash | ha / yo'q | Arxiv (qaytariladigan) | Nol | ______ |
| Q10 Sanoq | Varaqlar tayyor (7.1–7.6); Namangan Markaziy 20 minus qator | Sana + mas'ul | — | Tezroq belgilash (P3 shunga bog'liq) | — | ______ |
| ⚠ Yangi: WIP anomaliyasi | Arqon Bo'lim 3: −8 810.97 kg, faqat PRODUCE (167 ta), RECEIVE yo'q | Sanoqda WIP'ni real holatga keltirish | sanoq bilan yopish | Q10 tarkibida yopish | O'rta | ______ |

---

## 9. P2 PRECONDITION — approval checklist

P2 quyidagi checklist TO'LIQ yopilmaguncha BOSHLANMAYDI:

- [ ] Q1 approved
- [ ] Q2 approved
- [ ] Q3 approved
- [ ] Q4 approved
- [ ] Q5 approved
- [ ] Q6 approved
- [ ] Q7 approved
- [ ] Q8 approved
- [ ] Q9 approved
- [ ] Q10 approved
- [ ] Physical inventory plan approved

**P2 birinchi bosqichi FAQAT quyidagilardan iborat bo'ladi:**
- items foundation (yangi jadval, hech narsani almashtirmaydi)
- immutable SKU identity (SKU bir marta beriladi, o'zgarmaydi)
- legacy-name mapping (eski nom → item, hech narsa o'chmaydi)
- dual-write/read compatibility (eski va yangi yo'l parallel, eski yo'l asosiy bo'lib qoladi)

**Kafolat:** P2'da mavjud transaction flow, ombor balanslari, BOM, sotuvlar va ishlab chiqarish ma'lumotlariga TEGILMAYDI.

*Taxmin qilmaymiz — bilamiz.*
