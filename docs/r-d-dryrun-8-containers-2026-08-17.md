# R-D DRY-RUN — QOLGAN 8 KONTEYNER (2026-08-17)

**Rejim:** 100% O'QISH — bazaga hech qanday INSERT/UPDATE/DELETE qilinmadi (`default_transaction_read_only=on`).
**Doira:** C-20, C-19, C-18, C-02, C-04, C-06, C-16, C-17. **C-15 (LOADED) tegilmadi. Sales, legacy arxiv, R-B registri tegilmadi.**
**Manba:** jonli Railway prod (registr + inventar + harakatlar + legacy arxiv), 2026-08-17.
**Maqsad:** har konteyner uchun GO'dan oldingi to'liq rasm. **GO berilmaguncha hech narsa yozilmaydi.**

---

## 1. Umumiy manzara (registr, jonli holat)

| id | Konteyner | wid | Pozitsiya | MAPPED | EXCL | Birlik | Registr kg | Registr dona | Holat |
|---|---|---|---|---|---|---|---|---|---|
| 1 | C-20 | 26 | 10 | 10 | 0 | kg | 10 136.45 | — | MAPPED |
| 2 | C-19 | 25 | 13 | 13 | 0 | kg | 8 713.30 | — | MAPPED |
| 3 | C-18 | 24 | 29 | 28 | **1** | kg | 9 839.45 | — | MAPPED |
| 4 | C-02 | 8 | 10 | 9 | **1** | kg | 6 053.00 | — | MAPPED |
| 5 | C-04 | 10 | 7 | 7 | 0 | kg | 6 363.30 | — | MAPPED |
| 6 | C-06 | 12 | 13 | 13 | 0 | kg | 7 435.50 | — | MAPPED |
| 7 | C-16 | 22 | 3 | 3 | 0 | dona | 7 045.20 | 61 080 | MAPPED |
| 8 | C-17 | 23 | 9 | 9 | 0 | dona | 3 256.00 | 65 280 | MAPPED |
| **Jami** | | | **94** | **92** | **2** | | **58 842.20** | **126 360** | |

Har konteynerda `SUM(pozitsiya kg) = baseline.total_weight_kg` — 8/8 MOS ✓. Ombor nomlari yorlig'i bilan bayt-ma-bayt teng, barchasi aktiv, maqsadi `finished` ✓.

## 2. Konteyner-kesim tafsilot

Yozish konvensiyasi (C-15 pretsedenti, egasi tasdiqlagan): kg-pozitsiya → `quantity=0, weight_kg=sanoq kg`; dona-pozitsiya → `quantity=dona, weight_kg=hisoblangan kg`. Har harakat: `BASELINE`, `to_warehouse_id=wid`, `from=NULL`, `created_by='thisismurodov'`, `reference` → R-B pozitsiya, `reason` → «R-D baseline yuklash C-XX — fizik sanoq 2026-08-15». Har konteyner — alohida GO, alohida atomar tranzaksiya, pre-GO zaxira, MAPPED→LOADED latch, STORNO-yo'l.

### 2.1 C-20 (wid=26) — sof additiv ✅

| № | Pozitsiya | kg | SKU |
|---|---|---|---|
| 1 | Neylon 210D / 45 | 80.00 | TM-000001 |
| 2 | Neylon 210D / 60 | 1 474.00 | TM-000002 |
| 3 | Neylon 210D / 90 | 330.00 | TM-000003 |
| 4 | Toshkent Oq 14 mm — Bir qavat | 942.05 | TM-000004 |
| 5 | FDY Igna Strupa | 4 572.25 | TM-000005 |
| 6 | Toshkent Qora 14 mm Ichki Sariq | 636.25 | TM-000006 |
| 7 | 16 mm Alpinist | 520.00 | TM-000007 |
| 8 | 14 mm Alpinist | 930.00 | TM-000008 |
| 9 | Toshkent Qora 14 mm Ichi Oq PP TWS | 309.60 | TM-000009 |
| 10 | Toshkent Oq 16 mm Ichi Oq PP TWS — 50 metr | 342.30 | TM-000010 |

Konflikt: inventar 0, harakat 0, iz 0, legacy 0 ✓. **Kutilma:** +10 BASELINE, +10 inventar (10 136.45 kg). Oldin 0 → keyin 10 satr.

### 2.2 C-19 (wid=25) — sof additiv ✅

13 pozitsiya (TM-000011…023), 8 713.30 kg: Polyamide TWS oilasi (5), Qop ip Yashil/Qizil (2 244.10 / 728.55), Passport Xom BCF 646.00, strupalar (Yashil PP 24t 643.40, Passport 16t/24t 527.65/273.75, **Yashil PP TWS Strupa 16 talik 168.60 = TM-000022**, Sariq Polyester 16t 2 583.90).
Konflikt: 0/0/0/0 ✓. **Kutilma:** +13 BASELINE, +13 inventar (8 713.30 kg).
⚠️ **TM-000022 ikki lokatsiyali** (C-19 + C-04) — inventar UNIQUE(warehouse_id, product) buzilmaydi (har xil ombor), lekin GO skriptlarida iz-tekshiruv OMBOR-DOIRALI bo'lishi shart (§6.3).

### 2.3 C-18 (wid=24) — additiv, 1 EXCLUDED ⚠️

29 pozitsiya, 9 839.45 kg; **28 tasi yuklanadi (9 308.45 kg)**: Toshkent Arqon oilasi (14), Alpinist 10–25 mm (6), FDY Fil/Tros Aralash, Ustki/Ichki kombinatsiyalar (5), Kanob Aralash 20 metr (TM-000024…051).
**Pos 40 «Rossiya Tros» 531.00 kg — EXCLUDED_EXACT_CANDIDATE, item_id=NULL** (№1 ochiq: legacy SKU ROSSIYATROS bilan aynan mos, avto-mapping taqiqlangan). Bu pozitsiya GO'da YUKLANMAYDI — №1 hal bo'lgach alohida qo'shimcha harakat bilan kiradi (EXCLUDED→MAPPED trigger-ruxsatli).
Konflikt: 0/0/0/0 ✓. **Kutilma:** +28 BASELINE, +28 inventar (9 308.45 kg); 531.00 kg keyinga.

### 2.4 C-02 (wid=8) — additiv, 1 EXCLUDED ⚠️

10 pozitsiya, 6 053.00 kg; **9 tasi yuklanadi (5 376.45 kg)**: Shroki 3.5 sm lenta 468.35, Rangli 2.5 sm 863.45, Reels Lenta 1 352.85, Tulpor Lenta oilasi (5 ta: Aralash/Yashil/Oq/Ko'k/qizil), Tahoe Lenta 197.80 (TM-000052…060).
**Pos 61 «Shroki 3.5 Oq» 676.55 kg — EXCLUDED** (№1: SHROKI-3-5-OQ bilan aynan mos). GO'da yuklanmaydi.
Konflikt: 0/0/0/0 ✓. Fizik sanoq «duplikatlar real» qoidasini tasdiqlagan: «Shroki 3.5 sm lenta» (MAPPED) va «Shroki 3.5 Oq» (EXCLUDED) — ikki alohida mol.
**Kutilma:** +9 BASELINE, +9 inventar (5 376.45 kg); 676.55 kg keyinga.

### 2.5 C-04 (wid=10) — sof additiv ✅

7 pozitsiya (TM-000061…066 + TM-000022), 6 363.30 kg: Polipropilen CF 1500D Qora 3 250.00, CF 1000D Yashil 1 020.00, Strupa Salafan 375.80, XB Strupa 349.90, PP Oq TWS 12t 875.55, Eshma Xitoy 230.85, **Yashil PP TWS Strupa 16 talik 261.20 = TM-000022 (2-lokatsiya)**.
Konflikt: 0/0/0/0 ✓. **Kutilma:** +7 BASELINE, +7 inventar (6 363.30 kg).

### 2.6 C-06 (wid=12) — sof additiv ✅

13 pozitsiya (TM-000067…079), 7 435.50 kg: Shlanka oilasi to'liq — Polyamide Yumshoq, Tortqi PP (2), Polipropilen CF (5 rang), Polyester FDY (5 rang).
Konflikt: 0/0/0/0 ✓. **Kutilma:** +13 BASELINE, +13 inventar (7 435.50 kg).

### 2.7 C-16 (wid=22) — additiv + LEGACY KONFLIKT 🟨

3 dona-pozitsiya (box-math DB CHECK bilan kafolatlangan):

| № | Pozitsiya | dona | Karobka×dona | g | kg | SKU |
|---|---|---|---|---|---|---|
| 83 | Qop ip 100 talik | 55 200 | 552×100 | 115 | 6 348.00 | TM-000080 |
| 84 | Qop ip 120 talik | 2 520 | 21×120 | 90 | 226.80 | TM-000081 |
| 85 | Qop ip 80 talik | 3 360 | 42×80 | 140 | 470.40 | TM-000082 |

**Mavjud inventar:** 3 legacy qator (90 180 dona, 0 kg) — §3. Nom to'qnashuvi YO'Q («Qop ip 100 talik» ≠ «Qop Ip - 100 talik») — yangi satrlar bemalol qo'shiladi, legacy satrlar №2 gacha yonma-yon turadi.
**Harakat tarixi:** 5 ta IN (2026-06-24…30) — GO skripti C-15'dagi «harakat=0» darvozasi O'RNIGA aniq before-count pin ishlatadi (§6.2).
**Kutilma (additiv):** +3 BASELINE, +3 inventar (61 080 dona / 7 045.20 kg); inventar 3→6 satr. Nollash (№2) BU GO'da EMAS.

### 2.8 C-17 (wid=23) — additiv + LEGACY KONFLIKT 🟨

9 dona-pozitsiya: Qop ip 50 gramm Qora/Sariq/Oq (12 000/12 800/7 600 dona), 30 gramm Qora/Sariq/Oq (4 800/10 400/8 400), 100 gramm Qora/Sariq/Oq (2 080/2 880/4 320) = TM-000083…091; jami 65 280 dona / 3 256.00 kg. Qop jami 279 — egasi tasdig'i (registr note'da).
**Mavjud inventar:** 10 legacy qator (149 980 dona) — §3. Nom to'qnashuvi YO'Q (legacy «Reja ip N gr / Rang» formati boshqa).
**Harakat tarixi:** 82 IN + 1 OUT (2026-06-24…08-15) — before-count pin (§6.2).
**Kutilma (additiv):** +9 BASELINE, +9 inventar (65 280 dona / 3 256.00 kg); inventar 10→19 satr. Nollash (№2) BU GO'da EMAS.

## 3. C-16/C-17: 13 LEGACY QATOR — ALOHIDA MASALA (№2, HOZIR NOLLANMAYDI)

Jonli inventar vs legacy arxiv solishtiruvi — **13/13 MOS** (nollash oldsharti §2.3 buzilmagan, fabrika bu satrlarga tegmagan):

| wid | Mahsulot (legacy nom) | dona | Arxiv | Holat |
|---|---|---|---|---|
| 22 | Qop Ip - 100 talik | 77 900 | 77 900 | MOS |
| 22 | Qop ip - 120 talik | 9 240 | 9 240 | MOS |
| 22 | Qop ip - 80 talik | 3 040 | 3 040 | MOS |
| 23 | Reja ip 100 gr / Oq · Qora · Sariq | 8 800 · 10 200 · 12 680 | = | MOS |
| 23 | Reja ip 30 gr / OQ · Qora · Sariq | 12 400 · 18 800 · 25 600 | = | MOS |
| 23 | Reja ip 50 gr / OQ · Qora · Sariq | 12 800 · 25 000 · 23 600 | = | MOS |
| 23 | Reja ip PP / 50 gr (fizikda topilmagan) | 100 | 100 | MOS |
| | **Jami 13 qator** | **240 160 dona / 0 kg** | | |

- Bu qatorlar **hozir NOLLANMAYDI** — №2 qarori C-16/C-17 GO'sida: auditli BASELINE harakati bilan (reason=eski qiymat, arxiv qiymati bilan solishtirish + FOR UPDATE), DELETE/bare UPDATE emas.
- Legacy nomlarga bog'liq 90 tarixiy harakat bor — teginmaymiz, arxiv tarix bo'lib qoladi.
- Nollashdan keyin: C-16/C-17 qty 240 160 → 0 (legacy), yangi 126 360 dona qoladi; kg ta'sirlanmaydi (legacy kg=0).

## 4. Tekshiruv batareyasi (barchasi o'qish, jonli prod)

| Tekshiruv | Natija |
|---|---|
| Registr ichki mosligi (pozitsiya kg = header kg, 8/8) | ✅ PASS |
| Ombor mosligi (nom=yorliq, aktiv, 8/8) | ✅ PASS |
| Item bog'lari: 92 mapped — item mavjud, nom=display_name, SKU `TM-\d{6}` | ✅ PASS (0 xato) |
| Bir konteyner ichida takror item (UNIQUE xavfi) | ✅ PASS (0) |
| Iz: 92 item / 94 nom bo'yicha inventar+harakatlar | ✅ PASS (0 iz) |
| (warehouse_id, product) kolliziya | ✅ PASS (0) |
| 6 kg-konteyner tozaligi (inventar/harakat = 0) | ✅ PASS |
| C-16/C-17 jonli vs arxiv (13 qator) | ✅ PASS (13/13 MOS) |
| mapping_status: 95 MAPPED + 2 EXCLUDED = 97 | ✅ PASS |
| Dona box-math (DB CHECK) | ✅ PASS (12/12) |
| C-15 daxlsizligi (3 satr / 13 020 kg / LOADED) | ✅ PASS |
| Global: BASELINE=3, inventar=46, harakat=623, items=94 | ✅ PASS |

## 5. YAKUNIY CHIQISHLAR (egasi so'ragan 5 band)

**5.1 Har konteyner PASS/FAIL:**

| Konteyner | Hukm | Izoh |
|---|---|---|
| C-20 | ✅ PASS | sof additiv, 10 pozitsiya tayyor |
| C-19 | ✅ PASS | sof additiv, 13 pozitsiya (TM-000022 eslatmasi §6.3) |
| C-18 | ✅ PASS (28/29) | «Rossiya Tros» 531.00 kg — №1 gacha chetda |
| C-02 | ✅ PASS (9/10) | «Shroki 3.5 Oq» 676.55 kg — №1 gacha chetda |
| C-04 | ✅ PASS | sof additiv, 7 pozitsiya |
| C-06 | ✅ PASS | sof additiv, 13 pozitsiya |
| C-16 | ✅ PASS (additiv) | 3 legacy qator yonma-yon qoladi, №2 alohida |
| C-17 | ✅ PASS (additiv) | 10 legacy qator yonma-yon qoladi, №2 alohida |

**FAIL yo'q. 8/8 GO'ga tayyor** (C-18/C-02 — MAPPED qismi bilan).

**5.2 8 konteyner jami:** registr 94 pozitsiya = **58 842.20 kg + 126 360 dona**; hozir yuklanadigani (92 MAPPED) = **57 634.65 kg + 126 360 dona**; chetda (№1) = 1 207.55 kg (2 pozitsiya).

**5.3 9 konteyner joriy inventar jami (hozir, yozishdan OLDIN):** 16 satr = C-15: 3 satr (0 dona / 13 020.00 kg) + C-16: 3 satr (90 180 dona) + C-17: 10 satr (149 980 dona) + qolgan 6 konteyner: 0 satr. **Jami: 240 160 dona / 13 020.00 kg.**

**5.4 Kutilayotgan BASELINE soni:** hozir **3** (C-15) → 8 additiv GO'dan keyin **95** (3+92) → №2 nollash (13) bilan **108** → №1 hal bo'lsa (+2) **110**.

**5.5 Barcha verifikatsiya:** 12/12 PASS (§4), FAIL yo'q; 3 ochiq qaror GO'larga bog'langan: №1 (2 EXACT), №2 (13 legacy nollash — C-16/C-17 GO'sida), №4 (WIP — R-D to'liq yakunida).

**Yakuniy nishon (barcha GO + №1 + №2'dan keyin):** 9 konteyner = 71 862.20 kg / 126 360 dona = registr bilan aynan; global: inventar 46→138 satr (+92), harakatlar 623→715 (+92), keyin №2 bilan +13.

## 6. GO skriptlari uchun majburiy dizayn eslatmalari (C-15 saboqlaridan + shu dry-run)

1. **Qulflar snapshot'dan OLDIN** (SHARE ROW EXCLUSIVE, 6 jadval) — C-15 andozasi.
2. **BASELINE pin endi 0 emas** — har skript o'z paytidagi aniq global BASELINE sonini pin qiladi (birinchi GO: 3). C-16/C-17'da «wid harakat=0» darvozasi ISHLAMAYDI (5/83 tarixiy IN bor) — aniq before-count pin.
3. **Iz-tekshiruv OMBOR-DOIRALI** — TM-000022 C-19+C-04'da: birinchisi yuklangach, global item-iz tekshiruvi ikkinchisida yolg'on-FAIL berardi.
4. C-18/C-02: faqat MAPPED pozitsiyalar; EXCLUDED satrlar skript pinlarida «2 EXCLUDED mavjud» deb qayd etiladi.
5. Har GO: yangi pre-GO zaxira dump + mashq (throwaway DB, `-n public -n legacy`, sxemani oldindan yaratish) + SHA-256 + post-COMMIT mustaqil tekshiruv + hisobot.
6. Rollback faqat STORNO; C-16/C-17 nollashida FOR UPDATE + arxiv-solishtirish (§3 MOS holati GO kunida qayta tekshiriladi).

---

**HOZIRGI HOLAT: HECH NARSA YOZILMADI. Har konteyner alohida «R-D GO C-XX» buyrug'ini kutadi.**

*Biz taxmin qilmaymiz. Biz bilamiz.*
