# R-B DRY-RUN — MAPPING PREVIEW (2026-08-17)

**Holat: FAQAT PREVIEW — bazaga 0 yozuv. Hech qanday item yaratilmadi/ulanmadi/rename qilinmadi. R-D boshlanmadi. «R-B GO» kutilmoqda.**

Generator: `scripts/src/r-b-dryrun-mapping.ts` (deterministik — qayta ishga tushirilsa bayt-aynan shu hujjat chiqadi). Skript boshida avvalgi preview o'chiriladi va hujjat faqat BARCHA nazoratlar o'tgachgina yoziladi — demak bu faylning diskda mavjudligi = oxirgi ijro 100% PASS.
Manbalar: jonli `items` (94) · muhrlangan `docs/r-c-final-preview-2026-08-17.md` §4/§5 · `docs/physical-count-reconciliation-2026-08-15.md` (3-bosqich) · `docs/physical-count-c15-2026-08-16.md` · `docs/physical-count-c16-c17-2026-08-15.md`.

## 1. Nazorat paneli (egasining talablari)

| Talab | Natija |
|---|---|
| 97 fizik pozitsiya to'liq chiqdi (9 joy) | 97/97 ✓ (C-20:10 · C-19:13 · C-18:29 · C-02:10 · C-04:7 · C-06:13 · C-16:3 · C-17:9 · C-15:3) |
| 94 kanonik SKU bilan bog'landi | 95 pozitsiya → 94 SKU (bijeksiya, har biri roppa-rosa 1 marta) ✓ |
| TM-000022 = 1 SKU, 2 lokatsiya | C-19 168.6 kg + C-04 261.2 kg = 429.8 kg ✓ |
| Jami 71 862.20 kg mosligi | 60 353.45 (kg-itemlar) + 10 301.20 (dona ekviv.) + 1 207.55 (2 EXACT) = 71 862.20 ✓ |
| 2 EXACT kandidat mapping'ga KIRMADI | Rossiya Tros (C-18, 531) · Shroki 3.5 Oq (C-02, 676.55) — item_id bo'sh qoladi ✓ |
| Nom mosligi bayt-aynan | 95/95 pozitsiya nomi = kanonik nom (0 normalizatsiya, 0 trim, 0 rename; 6 metr-annotatsiya qat'iy qolipda ajratildi va joylari tasdiqlandi) ✓ |
| Jonli DB ≡ muhrlangan §4 | 94/94: sku+nom+birlik+note+created_by aynan; id 2..95; item_aliases=0 ✓ |
| Legacy POSSIBLE nomzodlar tegilmadi | 15/15 faqat ma'lumot ustunida ✓ |
| Bazaga yozuv | 0 (sessiya read-only, faqat SELECT) ✓ |

## 2. Joy kesimida balans

| Joy | Pozitsiya | Mapping'da | Jami kg | Mapped kg | Chetda |
|---|---|---|---|---|---|
| C-20 | 10 | 10 | 10 136.45 | 10 136.45 | — |
| C-19 | 13 | 13 | 8 713.30 | 8 713.30 | — |
| C-18 | 29 | 28 | 9 839.45 | 9 308.45 | 531.00 (EXACT) |
| C-02 | 10 | 9 | 6 053.00 | 5 376.45 | 676.55 (EXACT) |
| C-04 | 7 | 7 | 6 363.30 | 6 363.30 | — |
| C-06 | 13 | 13 | 7 435.50 | 7 435.50 | — |
| C-16 | 3 | 3 | 7 045.20 | 7 045.20 | — |
| C-17 | 9 | 9 | 3 256.00 | 3 256.00 | — |
| C-15 | 3 | 3 | 13 020.00 | 13 020.00 | — |
| **JAMI** | **97** | **95** | **71 862.20** | **70 654.65** | **1 207.55** |

Dona bloki: **126 360 dona** (C-16: 61 080 · C-17: 65 280) = hisobiy **10 301.20 kg** (birlik og'irlik × dona, sanoq varag'idan).

## 3. To'liq mapping jadvali — 97 pozitsiya

Nomlar sanoq varaqlaridan **aynan** (bayt-aynan solishtirilgan). «Mapping turi»: AYNAN 1:1 — nom va joy bo'yicha yagona mos; AYNAN · 2-JOYLI — bitta SKU'ning ikki joydagi qismi; CHIQARILGAN — egasi qarori bilan R-B'dan tashqarida.

| № | Joy | Fizik nom (aynan) | Real sanoq | Birlik | kg | TM-SKU | Kanonik nom | Mapping turi | Izoh |
|---|---|---|---|---|---|---|---|---|---|
| 1 | C-20 | Neylon 210D / 45 | 80 | kg | 80 | TM-000001 | Neylon 210D / 45 | AYNAN 1:1 | — |
| 2 | C-20 | Neylon 210D / 60 | 1 474 | kg | 1 474 | TM-000002 | Neylon 210D / 60 | AYNAN 1:1 | — |
| 3 | C-20 | Neylon 210D / 90 | 330 | kg | 330 | TM-000003 | Neylon 210D / 90 | AYNAN 1:1 | — |
| 4 | C-20 | Toshkent Oq 14 mm — Bir qavat | 942.05 | kg | 942.05 | TM-000004 | Toshkent Oq 14 mm — Bir qavat | AYNAN 1:1 | — |
| 5 | C-20 | FDY Igna Strupa | 4 572.25 | kg | 4 572.25 | TM-000005 | FDY Igna Strupa | AYNAN 1:1 | — |
| 6 | C-20 | Toshkent Qora 14 mm Ichki Sariq | 636.25 | kg | 636.25 | TM-000006 | Toshkent Qora 14 mm Ichki Sariq | AYNAN 1:1 | — |
| 7 | C-20 | 16 mm Alpinist | 520 | kg | 520 | TM-000007 | 16 mm Alpinist | AYNAN 1:1 | — |
| 8 | C-20 | 14 mm Alpinist | 930 | kg | 930 | TM-000008 | 14 mm Alpinist | AYNAN 1:1 | — |
| 9 | C-20 | Toshkent Qora 14 mm Ichi Oq PP TWS | 309.6 | kg | 309.6 | TM-000009 | Toshkent Qora 14 mm Ichi Oq PP TWS | AYNAN 1:1 | — |
| 10 | C-20 | Toshkent Oq 16 mm Ichi Oq PP TWS — 50 metr | 342.3 | kg | 342.3 | TM-000010 | Toshkent Oq 16 mm Ichi Oq PP TWS — 50 metr | AYNAN 1:1 | metr: NULL |
| 11 | C-19 | Polyamide 144 oq TWS | 552.9 | kg | 552.9 | TM-000011 | Polyamide 144 oq TWS | AYNAN 1:1 | legacy nomzod: mahsulot «Polyamide 144» ply144 (faqat ma'lumot — R-B'da ishlatilmaydi) |
| 12 | C-19 | Polyamide Ko‘k 187 TWS | 94.05 | kg | 94.05 | TM-000012 | Polyamide Ko‘k 187 TWS | AYNAN 1:1 | — |
| 13 | C-19 | Polyamide Qizil 187 TWS | 73.65 | kg | 73.65 | TM-000013 | Polyamide Qizil 187 TWS | AYNAN 1:1 | — |
| 14 | C-19 | Polyamide Sariq 187 TWS | 44.6 | kg | 44.6 | TM-000014 | Polyamide Sariq 187 TWS | AYNAN 1:1 | — |
| 15 | C-19 | Polyamide Oq 187 TWS | 132.15 | kg | 132.15 | TM-000015 | Polyamide Oq 187 TWS | AYNAN 1:1 | — |
| 16 | C-19 | Qop ip Yashil | 2 244.1 | kg | 2 244.1 | TM-000016 | Qop ip Yashil | AYNAN 1:1 | legacy nomzod: xomashyo «Qop ip» — (xomashyo) (faqat ma'lumot — R-B'da ishlatilmaydi) |
| 17 | C-19 | Qop ip Qizil | 728.55 | kg | 728.55 | TM-000017 | Qop ip Qizil | AYNAN 1:1 | legacy nomzod: xomashyo «Qop ip» — (xomashyo) (faqat ma'lumot — R-B'da ishlatilmaydi) |
| 18 | C-19 | Passport Xom BCF | 646 | kg | 646 | TM-000018 | Passport Xom BCF | AYNAN 1:1 | — |
| 19 | C-19 | Yashil PP TWS Strupa 24 talik | 643.4 | kg | 643.4 | TM-000019 | Yashil PP TWS Strupa 24 talik | AYNAN 1:1 | — |
| 20 | C-19 | Passport Strupa 16 talik | 527.65 | kg | 527.65 | TM-000020 | Passport Strupa 16 talik | AYNAN 1:1 | — |
| 21 | C-19 | Passport Strupa 24 talik | 273.75 | kg | 273.75 | TM-000021 | Passport Strupa 24 talik | AYNAN 1:1 | — |
| 22 | C-19 | Yashil PP TWS Strupa 16 talik | 168.6 | kg | 168.6 | TM-000022 | Yashil PP TWS Strupa 16 talik | AYNAN · 2-JOYLI | ikkinchi joy: C-04 |
| 23 | C-19 | Sariq Polyester Strupa 16 talik | 2 583.9 | kg | 2 583.9 | TM-000023 | Sariq Polyester Strupa 16 talik | AYNAN 1:1 | — |
| 24 | C-18 | Toshkent Arqon 16 mm Ko‘k | 221.6 | kg | 221.6 | TM-000024 | Toshkent Arqon 16 mm Ko‘k | AYNAN 1:1 | — |
| 25 | C-18 | Toshkent Arqon 16 mm Qora | 332.95 | kg | 332.95 | TM-000025 | Toshkent Arqon 16 mm Qora | AYNAN 1:1 | — |
| 26 | C-18 | Ustki Gilam Ichki Sariq Polyamide | 317.25 | kg | 317.25 | TM-000026 | Ustki Gilam Ichki Sariq Polyamide | AYNAN 1:1 | — |
| 27 | C-18 | Toshkent Arqon 10 mm Yashil | 171.9 | kg | 171.9 | TM-000027 | Toshkent Arqon 10 mm Yashil | AYNAN 1:1 | — |
| 28 | C-18 | Toshkent Arqon 14 mm Qizil | 451.7 | kg | 451.7 | TM-000028 | Toshkent Arqon 14 mm Qizil | AYNAN 1:1 | — |
| 29 | C-18 | Toshkent Arqon 12 mm Qora Ichki Polyamide Sariq | 866.25 | kg | 866.25 | TM-000029 | Toshkent Arqon 12 mm Qora Ichki Polyamide Sariq | AYNAN 1:1 | — |
| 30 | C-18 | Toshkent Arqon 12 mm Qizil | 61.65 | kg | 61.65 | TM-000030 | Toshkent Arqon 12 mm Qizil | AYNAN 1:1 | — |
| 31 | C-18 | Toshkent Arqon 14 mm Qora | 150 | kg | 150 | TM-000031 | Toshkent Arqon 14 mm Qora | AYNAN 1:1 | — |
| 32 | C-18 | Toshkent Arqon 10 mm Ko‘k | 150.25 | kg | 150.25 | TM-000032 | Toshkent Arqon 10 mm Ko‘k | AYNAN 1:1 | — |
| 33 | C-18 | FDY Fil Arqon | 497.55 | kg | 497.55 | TM-000033 | FDY Fil Arqon | AYNAN 1:1 | — |
| 34 | C-18 | Toshkent Arqon 16 mm Oq — 50 metr | 63.2 | kg | 63.2 | TM-000034 | Toshkent Arqon 16 mm Oq — 50 metr | AYNAN 1:1 | metr: NULL |
| 35 | C-18 | Toshkent Arqon 14 mm Oq — 100 metr | 40.05 | kg | 40.05 | TM-000035 | Toshkent Arqon 14 mm Oq — 100 metr | AYNAN 1:1 | metr: NULL |
| 36 | C-18 | Toshkent Arqon 16 mm Oq | 61.9 | kg | 61.9 | TM-000036 | Toshkent Arqon 16 mm Oq | AYNAN 1:1 | — |
| 37 | C-18 | Toshkent Arqon Qora 16 mm Ichki Polyamide Sariq | 717.35 | kg | 717.35 | TM-000037 | Toshkent Arqon Qora 16 mm Ichki Polyamide Sariq | AYNAN 1:1 | — |
| 38 | C-18 | Toshkent Arqon 12 mm Sariq | 389.95 | kg | 389.95 | TM-000038 | Toshkent Arqon 12 mm Sariq | AYNAN 1:1 | — |
| 39 | C-18 | FDY Tros Aralash | 386.75 | kg | 386.75 | TM-000039 | FDY Tros Aralash | AYNAN 1:1 | — |
| 40 | C-18 | Rossiya Tros | 531 | kg | 531 | — | — | **CHIQARILGAN** (EXACT kandidat) | egasi qarori №1: avto-mapping YO'Q — alohida kandidat (legacy ROSSIYATROS bilan aynan mos) |
| 41 | C-18 | Usti gilam ichki Sariq Polyamide Arqon | 370.5 | kg | 370.5 | TM-000040 | Usti gilam ichki Sariq Polyamide Arqon | AYNAN 1:1 | — |
| 42 | C-18 | Ustki Oq TWS ichki Polyamide Oq Arqon | 1 264.1 | kg | 1 264.1 | TM-000041 | Ustki Oq TWS ichki Polyamide Oq Arqon | AYNAN 1:1 | — |
| 43 | C-18 | Ustki PP xom ichki Polyamide Oq Arqon | 105 | kg | 105 | TM-000042 | Ustki PP xom ichki Polyamide Oq Arqon | AYNAN 1:1 | — |
| 44 | C-18 | Ustki 187 TWS Oq ichki Zubr 16 mm Arqon | 926.4 | kg | 926.4 | TM-000043 | Ustki 187 TWS Oq ichki Zubr 16 mm Arqon | AYNAN 1:1 | — |
| 45 | C-18 | Ustki 187 TWS Oq ichki Strupa 14 mm Arqon | 520 | kg | 520 | TM-000044 | Ustki 187 TWS Oq ichki Strupa 14 mm Arqon | AYNAN 1:1 | — |
| 46 | C-18 | Kanob Aralash 20 metr | 113.55 | kg | 113.55 | TM-000045 | Kanob Aralash 20 metr | AYNAN 1:1 | metr: NULL |
| 47 | C-18 | Alpinist 12 mm | 450.6 | kg | 450.6 | TM-000046 | Alpinist 12 mm | AYNAN 1:1 | — |
| 48 | C-18 | Alpinist 10 mm | 106.2 | kg | 106.2 | TM-000047 | Alpinist 10 mm | AYNAN 1:1 | — |
| 49 | C-18 | Alpinist 14 mm | 165.55 | kg | 165.55 | TM-000048 | Alpinist 14 mm | AYNAN 1:1 | — |
| 50 | C-18 | Alpinist 16 mm | 199.3 | kg | 199.3 | TM-000049 | Alpinist 16 mm | AYNAN 1:1 | — |
| 51 | C-18 | Alpinist 20 mm | 174.5 | kg | 174.5 | TM-000050 | Alpinist 20 mm | AYNAN 1:1 | — |
| 52 | C-18 | Alpinist 25 mm | 32.45 | kg | 32.45 | TM-000051 | Alpinist 25 mm | AYNAN 1:1 | — |
| 53 | C-02 | Shroki 3.5 sm lenta | 468.35 | kg | 468.35 | TM-000052 | Shroki 3.5 sm lenta | AYNAN 1:1 | legacy nomzod: mahsulot «Shroki 3.5» shrk35 (faqat ma'lumot — R-B'da ishlatilmaydi) |
| 54 | C-02 | Rangli 2.5 sm ikki qavat lenta | 863.45 | kg | 863.45 | TM-000053 | Rangli 2.5 sm ikki qavat lenta | AYNAN 1:1 | — |
| 55 | C-02 | Reels Lenta | 1 352.85 | kg | 1 352.85 | TM-000054 | Reels Lenta | AYNAN 1:1 | legacy nomzod: mahsulot «Reels» REELS (faqat ma'lumot — R-B'da ishlatilmaydi) |
| 56 | C-02 | Tulpor Lenta Aralash | 556.4 | kg | 556.4 | TM-000055 | Tulpor Lenta Aralash | AYNAN 1:1 | — |
| 57 | C-02 | Tulpor Lenta Yashil | 1 019.35 | kg | 1 019.35 | TM-000056 | Tulpor Lenta Yashil | AYNAN 1:1 | — |
| 58 | C-02 | Tulpor Lenta Oq | 439.2 | kg | 439.2 | TM-000057 | Tulpor Lenta Oq | AYNAN 1:1 | — |
| 59 | C-02 | Tulpor Lenta Ko‘k | 192.05 | kg | 192.05 | TM-000058 | Tulpor Lenta Ko‘k | AYNAN 1:1 | — |
| 60 | C-02 | Tulpor lenta qizil | 287 | kg | 287 | TM-000059 | Tulpor lenta qizil | AYNAN 1:1 | — |
| 61 | C-02 | Shroki 3.5 Oq | 676.55 | kg | 676.55 | — | — | **CHIQARILGAN** (EXACT kandidat) | egasi qarori №1: avto-mapping YO'Q — alohida kandidat (legacy SHROKI-3-5-OQ bilan aynan mos) |
| 62 | C-02 | Tahoe Lenta | 197.8 | kg | 197.8 | TM-000060 | Tahoe Lenta | AYNAN 1:1 | legacy nomzod: mahsulot «Tahoe 50 m» th50 (faqat ma'lumot — R-B'da ishlatilmaydi) |
| 63 | C-04 | Polipropilen CF 1500D Qora | 3 250 | kg | 3 250 | TM-000061 | Polipropilen CF 1500D Qora | AYNAN 1:1 | — |
| 64 | C-04 | Polipropilen CF 1000D Yashil | 1 020 | kg | 1 020 | TM-000062 | Polipropilen CF 1000D Yashil | AYNAN 1:1 | — |
| 65 | C-04 | Strupa Salafan | 375.8 | kg | 375.8 | TM-000063 | Strupa Salafan | AYNAN 1:1 | legacy nomzod: mahsulot «Salafan Strupa» SLFSTR (faqat ma'lumot — R-B'da ishlatilmaydi) |
| 66 | C-04 | XB Strupa | 349.9 | kg | 349.9 | TM-000064 | XB Strupa | AYNAN 1:1 | — |
| 67 | C-04 | PP Oq TWS Strupa 12 talik | 875.55 | kg | 875.55 | TM-000065 | PP Oq TWS Strupa 12 talik | AYNAN 1:1 | — |
| 68 | C-04 | Eshma Xitoy Strupa PP Oq TWS | 230.85 | kg | 230.85 | TM-000066 | Eshma Xitoy Strupa PP Oq TWS | AYNAN 1:1 | — |
| 69 | C-04 | Yashil PP TWS Strupa 16 talik | 261.2 | kg | 261.2 | TM-000022 | Yashil PP TWS Strupa 16 talik | AYNAN · 2-JOYLI | ikkinchi joy: C-19 |
| 70 | C-06 | Shlanka Polyamide Yumshoq | 86.3 | kg | 86.3 | TM-000067 | Shlanka Polyamide Yumshoq | AYNAN 1:1 | legacy nomzod: mahsulot «Shlanka Polyamide» ⚠birlik zid SHLPOLYD (faqat ma'lumot — R-B'da ishlatilmaydi) |
| 71 | C-06 | Shlanka Tortqi PP Oq TWS — 50 metr | 236.25 | kg | 236.25 | TM-000068 | Shlanka Tortqi PP Oq TWS — 50 metr | AYNAN 1:1 | legacy nomzod: mahsulot «Shlanka PP / Oq» SHLPP/OQ (faqat ma'lumot — R-B'da ishlatilmaydi) · metr: NULL |
| 72 | C-06 | Shlanka Tortqi PP Yashil TWS — 50 metr | 66.35 | kg | 66.35 | TM-000069 | Shlanka Tortqi PP Yashil TWS — 50 metr | AYNAN 1:1 | metr: NULL |
| 73 | C-06 | Shlanka Polipropilen CF Qora | 618.8 | kg | 618.8 | TM-000070 | Shlanka Polipropilen CF Qora | AYNAN 1:1 | — |
| 74 | C-06 | Shlanka Polipropilen CF Yashil | 710.45 | kg | 710.45 | TM-000071 | Shlanka Polipropilen CF Yashil | AYNAN 1:1 | — |
| 75 | C-06 | Shlanka Polipropilen CF Ko‘k | 506.25 | kg | 506.25 | TM-000072 | Shlanka Polipropilen CF Ko‘k | AYNAN 1:1 | — |
| 76 | C-06 | Shlanka Polipropilen CF Qizil | 581.4 | kg | 581.4 | TM-000073 | Shlanka Polipropilen CF Qizil | AYNAN 1:1 | — |
| 77 | C-06 | Shlanka Polipropilen CF Oq | 874.95 | kg | 874.95 | TM-000074 | Shlanka Polipropilen CF Oq | AYNAN 1:1 | legacy nomzod: mahsulot «Shlanka PP / Oq» SHLPP/OQ (faqat ma'lumot — R-B'da ishlatilmaydi) |
| 78 | C-06 | Shlanka Polyester FDY Qora | 433.2 | kg | 433.2 | TM-000075 | Shlanka Polyester FDY Qora | AYNAN 1:1 | legacy nomzod: mahsulot «Shlanka FDY / Qora» ⚠birlik zid SHFDY/QORA (faqat ma'lumot — R-B'da ishlatilmaydi) |
| 79 | C-06 | Shlanka Polyester FDY Yashil | 830.4 | kg | 830.4 | TM-000076 | Shlanka Polyester FDY Yashil | AYNAN 1:1 | legacy nomzod: mahsulot «Shlanka FDY/Yashil» ⚠birlik zid SHFDY/YASHIL (faqat ma'lumot — R-B'da ishlatilmaydi) |
| 80 | C-06 | Shlanka Polyester FDY Ko‘k | 778.15 | kg | 778.15 | TM-000077 | Shlanka Polyester FDY Ko‘k | AYNAN 1:1 | legacy nomzod: mahsulot «Shlanka FDY/ Ko'k» ⚠birlik zid SHFDY/KOK (faqat ma'lumot — R-B'da ishlatilmaydi) |
| 81 | C-06 | Shlanka Polyester FDY Qizil | 730.95 | kg | 730.95 | TM-000078 | Shlanka Polyester FDY Qizil | AYNAN 1:1 | legacy nomzod: mahsulot «Shlanka FDY / QIzil» ⚠birlik zid SHFDY/QIZIL (faqat ma'lumot — R-B'da ishlatilmaydi) |
| 82 | C-06 | Shlanka Polyester FDY Oq | 982.05 | kg | 982.05 | TM-000079 | Shlanka Polyester FDY Oq | AYNAN 1:1 | legacy nomzod: mahsulot «Shlanka FDY / OQ» ⚠birlik zid SHFDY/OQ (faqat ma'lumot — R-B'da ishlatilmaydi) |
| 83 | C-16 | Qop ip 100 talik | 55 200 | dona | 6 348.00 (hisobiy) | TM-000080 | Qop ip 100 talik | AYNAN 1:1 | 552 karobka × 100 dona × 115 g |
| 84 | C-16 | Qop ip 120 talik | 2 520 | dona | 226.80 (hisobiy) | TM-000081 | Qop ip 120 talik | AYNAN 1:1 | 21 karobka × 120 dona × 90 g |
| 85 | C-16 | Qop ip 80 talik | 3 360 | dona | 470.40 (hisobiy) | TM-000082 | Qop ip 80 talik | AYNAN 1:1 | 42 karobka × 80 dona × 140 g |
| 86 | C-17 | Qop ip 50 gramm Qora | 12 000 | dona | 600.00 (hisobiy) | TM-000083 | Qop ip 50 gramm Qora | AYNAN 1:1 | 60 qop × 200 dona × 50 g |
| 87 | C-17 | Qop ip 50 gramm Sariq | 12 800 | dona | 640.00 (hisobiy) | TM-000084 | Qop ip 50 gramm Sariq | AYNAN 1:1 | 64 qop × 200 dona × 50 g |
| 88 | C-17 | Qop ip 50 gramm Oq | 7 600 | dona | 380.00 (hisobiy) | TM-000085 | Qop ip 50 gramm Oq | AYNAN 1:1 | 38 qop × 200 dona × 50 g |
| 89 | C-17 | Qop ip 30 gramm Qora | 4 800 | dona | 144.00 (hisobiy) | TM-000086 | Qop ip 30 gramm Qora | AYNAN 1:1 | 12 qop × 400 dona × 30 g |
| 90 | C-17 | Qop ip 30 gramm Sariq | 10 400 | dona | 312.00 (hisobiy) | TM-000087 | Qop ip 30 gramm Sariq | AYNAN 1:1 | 26 qop × 400 dona × 30 g |
| 91 | C-17 | Qop ip 30 gramm Oq | 8 400 | dona | 252.00 (hisobiy) | TM-000088 | Qop ip 30 gramm Oq | AYNAN 1:1 | 21 qop × 400 dona × 30 g |
| 92 | C-17 | Qop ip 100 gramm Qora | 2 080 | dona | 208.00 (hisobiy) | TM-000089 | Qop ip 100 gramm Qora | AYNAN 1:1 | 13 qop × 160 dona × 100 g |
| 93 | C-17 | Qop ip 100 gramm Sariq | 2 880 | dona | 288.00 (hisobiy) | TM-000090 | Qop ip 100 gramm Sariq | AYNAN 1:1 | 18 qop × 160 dona × 100 g |
| 94 | C-17 | Qop ip 100 gramm Oq | 4 320 | dona | 432.00 (hisobiy) | TM-000091 | Qop ip 100 gramm Oq | AYNAN 1:1 | 27 qop × 160 dona × 100 g |
| 95 | C-15 | Polipropilen CF 1000D Qizil | 3 720.00 | kg | 3 720.00 | TM-000092 | Polipropilen CF 1000D Qizil | AYNAN 1:1 | sanoq 2026-08-16 |
| 96 | C-15 | Polipropilen CF 1000D Ko'k | 3 840.00 | kg | 3 840.00 | TM-000093 | Polipropilen CF 1000D Ko'k | AYNAN 1:1 | sanoq 2026-08-16 |
| 97 | C-15 | Polipropilen CF 1000D Sariq | 5 460.00 | kg | 5 460.00 | TM-000094 | Polipropilen CF 1000D Sariq | AYNAN 1:1 | sanoq 2026-08-16 |

## 4. Noaniqliklar va e'tibor punktlari

1. **2 EXACT kandidat (№1 ochiq qaror):** «Rossiya Tros» (C-18, 531 kg, legacy `ROSSIYATROS`) va «Shroki 3.5 Oq» (C-02, 676.55 kg, legacy `SHROKI-3-5-OQ`) — egasi qarorigacha registrda **item_id = NULL** bo'lib turadi (pozitsiya sifatida saqlanadi, mapping YO'Q). Bular 94 ta TM-SKU'ga ta'sir qilmaydi.
2. **TM-000022 (Yashil PP TWS Strupa 16 talik):** registrda 2 alohida pozitsiya satri (C-19 168.6 + C-04 261.2), ikkalasi bitta SKU'ga ulanadi — R-D'da ham 2 alohida BASELINE harakat bo'ladi (har joyning o'z miqdori).
3. **«metr» spetsifikatsiyali 6 pozitsiya** (C-20 №10; C-18 №11/№12/№23; C-06 №2/№3 — sanoq varag'idagi `*(metr: NULL)*` belgisidan avtomatik aniqlandi va joylari tasdiqlandi): «N metr» nom tarkibida, fizik metr sanog'i berilmagan — kg'dan metr hisoblanmagan va hisoblanmaydi.
4. **Dona↔kg:** 12 dona-itemning kg qiymati **hisobiy** (karobka/qop × dona × birlik og'irlik — sanoq varag'i dalili bilan qatorma-qator qayta tekshirildi). R-D'da `weight_kg` sifatida yozish taklif etiladi; kg-itemlarda `quantity` semantikasi (№ ochiq savol, recon 5-bosqich) R-D'gacha egasi javobini kutadi.
5. **Legacy POSSIBLE nomzodlar (15 ta)** jadvalning «Izoh» ustunida faqat ma'lumot sifatida turibdi — R-B ularni ISHLATMAYDI (alias/merge alohida bosqich, alohida GO). Bundan tashqari C-17 oilasi bo'yicha sanoq hujjatida (`docs/physical-count-c16-c17-2026-08-15.md`, §5 ERP snapshot va nomlash-farqi qaydi) fizik «Qop ip N gramm RANG» ↔ legacy ERP «Reja ip N gr / RANG» juftliklari alias-NOMZOD sifatida qayd etilgan — bular ham R-B'dan tashqarida.
6. **Legacy «Reja ip PP / 50 gr» (C-17, ERP'da 100 dona):** fizik sanoqda YO'Q — R-B registriga kirmaydi (registr faqat sanalgan faktni saqlaydi); taqdiri legacy-arxiv siyosati bilan hal bo'ladi.
7. **C-15 purpose ziddiyati** (sanoq hujjatida qayd etilgan kuzatuv, qaror EMAS — `docs/physical-count-c15-2026-08-16.md`): konteyner maqsadi `finished` (DB ID 21), tarkibi esa sof xomashyo (CF filament) — R-E/keyingi bosqich savoli, mapping'ga ta'sir qilmaydi.
8. **C-17 «259 qop» manba xatosi:** sanoq hujjatida «✅ HAL QILINDI (2026-08-16)» deb qayd etilgan — egasi tasdig'i bilan to'g'risi **279 qop** (162+59+58); jadval 279 asosida, dona/kg jamlariga ta'sir yo'q (manba: `docs/physical-count-c16-c17-2026-08-15.md`, arifmetik tekshiruv bo'limi).
9. **Oilalar birlashtirilmadi:** «80/100/120 talik», «30/50/100 gramm», ranglar — barchasi alohida SKU (egasi taqiqi bo'yicha); «16 mm Alpinist» (C-20) va «Alpinist 16 mm» (C-18) ham 2 alohida SKU (TM-000007 / TM-000049) — nomlar sanoqda shunday yozilgan.

## 5. «R-B GO» nimani anglatadi (bu hujjat EMAS — faqat ma'lumot)

R-B GO = sanoq registri jadvallari (`physical_baselines` + `physical_baseline_positions`, 97 satr — shu jadvaldagi tartibda) + 95 satrda `item_id` mapping (2 EXACT satrda NULL). **Inventar qoldiqlariga, harakatlarga, legacy/sotuvlarga TEGILMAYDI** — bular R-D (konteyner-boshiga alohida GO). `counted_by` qiymati (№6 savolning R-B qismi) GO'dan oldin egasidan so'raladi.

---

**Business Impact:** ★★★★☆ — 95/97 pozitsiya kanonik SKU bilan isbotlangan bog'lanishga ega, 2 EXACT pozitsiya egasi qarori bilan ataylab ochiq; registr uchun hamma narsa tayyor.
**Technical Risk:** ☆☆☆☆☆ — 0 yozuv (read-only sessiya), 9 qatlam nazorat, bayt-aynan solishtiruv.
**User Value:** ★★★★★ — to'liq shaffof preview: egasi har bir satrni GO'dan oldin ko'radi.
**Future Dependency:** ★★★★★ — R-B GO shu jadvalni muhrlangan spetsifikatsiya sifatida oladi; R-D har pozitsiyani BASELINE harakatga aylantiradi.

«Biz taxmin qilmaymiz. Biz bilamiz.»
