# Fizik sanoq ↔ ERP solishtiruv hisoboti — 6 konteyner

*Sana: 2026-08-15. Manba: REAL FIZIK SANOQ (o’zgartirilmagan) + jonli baza (faqat SELECT). Hech qanday ma’lumot o’zgartirilMADI: adjustment yo’q, yangi SKU yo’q, merge yo’q, tarix tegilmagan.*

Bog’liq: `docs/physical-count-sheets.md`, `docs/q1-q10-decision-pack.md`, `docs/p1-data-mapping.md`.

## 0. Bosh xulosa (3 satr)

1. **ERP bu 6 konteynerni mutlaqo bo’sh deb biladi**: inventory’da 0 qator, stock_movements’da 0 harakat. Fizik esa **48 541 kg / 82 pozitsiya** turibdi.
2. Moslik: **EXACT 2 ta (1 207.55 kg) · POSSIBLE 15 ta (10 872.6 kg) · UNMATCHED 65 ta (36 460.85 kg)** — ya’ni asosiy muammo qoldiq farqi emas, **katalog bo’shlig’i**: fizik assortimentning katta qismi ERP’da umuman mavjud emas.
3. Hozirgi arxitektura auditli adjustment’ni XAVFSIZ qo’llab-quvvatlamaydi (7-bosqichga qarang) — shuning uchun topshiriq talabiga ko’ra **ma’lumot o’zgartirishdan OLDIN TO’XTADIK**.

## 1-bosqich — Joy xaritasi (fizik yorliq → DB ID)

| Fizik yorliq | DB ID | DB nomi | Turi | Maqsadi | Sig’im | ERP qoldiq | Harakat tarixi | Xarita holati |
|---|---|---|---|---|---|---|---|---|
| C-20 | 26 | C-20 | container | finished | 20 000 kg | 0 qator | 0 ta | TASDIQLANDI (yagona aynan nom) |
| C-19 | 25 | C-19 | container | finished | 20 000 kg | 0 qator | 0 ta | TASDIQLANDI (yagona aynan nom) |
| C-18 | 24 | C-18 | container | finished | 20 000 kg | 0 qator | 0 ta | TASDIQLANDI (yagona aynan nom) |
| C-02 | 8 | C-02 | container | finished | 20 000 kg | 0 qator | 0 ta | TASDIQLANDI (yagona aynan nom) |
| C-04 | 10 | C-04 | container | finished | 20 000 kg | 0 qator | 0 ta | TASDIQLANDI (yagona aynan nom) |
| C-06 | 12 | C-06 | container | finished | 20 000 kg | 0 qator | 0 ta | TASDIQLANDI (yagona aynan nom) |

Dalil: `warehouses` jadvalida har yorliq uchun aynan bitta yozuv; `inventory`da bu 6 ID uchun 0 qator; `stock_movements`da from/to sifatida 0 marta uchraydi. Eslatma: fizik quti ↔ DB yozuvi aynanligi yorliq konventsiyasiga tayanadi, lekin ERP tomonda qarama-qarshi ma’lumot YO’Q (hammasi bo’sh), shuning uchun PHYSICAL_MAPPING_PENDING talab qilinmadi.

## 2-bosqich — Fizik sanoq nazorati

Deklaratsiya qilingan summalar bilan pozitsiyalar yig’indisi solishtirildi — **6/6 konteyner aynan mos** (farq 0.00): C-20=10 136.45, C-19=8 713.3, C-18=9 839.45, C-02=6 053, C-04=6 363.3, C-06=7 435.5. Jami **48 541 kg / 82 pozitsiya** ✓. Nomlar aynan yozilganidek saqlandi, hech biri normalizatsiya qilinmadi.

## 3-bosqich — Solishtiruv jadvali

### C-20 (DB ID: 26) — ERP joriy holati: BO’SH (0 qator, 0 harakat)

| # | Fizik nom (aynan yozilganidek) | Mos ERP item | SKU | ERP qoldiq (shu joyda) | Fizik sanoq | Farq | Birlik | Holat | Taklif |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Neylon 210D / 45 | — | — | 0 | 80 | +80 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 2 | Neylon 210D / 60 | — | — | 0 | 1 474 | +1 474 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 3 | Neylon 210D / 90 | — | — | 0 | 330 | +330 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 4 | Toshkent Oq 14 mm — Bir qavat | — | — | 0 | 942.05 | +942.05 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 5 | FDY Igna Strupa | — | — | 0 | 4 572.25 | +4 572.25 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 6 | Toshkent Qora 14 mm Ichki Sariq | — | — | 0 | 636.25 | +636.25 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 7 | 16 mm Alpinist | — | — | 0 | 520 | +520 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 8 | 14 mm Alpinist | — | — | 0 | 930 | +930 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 9 | Toshkent Qora 14 mm Ichi Oq PP TWS | — | — | 0 | 309.6 | +309.6 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 10 | Toshkent Oq 16 mm Ichi Oq PP TWS — 50 metr *(metr: NULL)* | — | — | 0 | 342.3 | +342.3 | kg | UNMATCHED | YO’Q — exception hisobotida |
| | **JAMI** | | | **0** | **10 136.45** | **+10 136.45** | kg | | |

### C-19 (DB ID: 25) — ERP joriy holati: BO’SH (0 qator, 0 harakat)

| # | Fizik nom (aynan yozilganidek) | Mos ERP item | SKU | ERP qoldiq (shu joyda) | Fizik sanoq | Farq | Birlik | Holat | Taklif |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Polyamide 144 oq TWS | mahsulot «Polyamide 144» | `ply144` | 0 | 552.9 | +552.9 | kg | POSSIBLE_MATCH | YO’Q — identifikatsiya tasdiqlanmaguncha |
| 2 | Polyamide Ko‘k 187 TWS | — | — | 0 | 94.05 | +94.05 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 3 | Polyamide Qizil 187 TWS | — | — | 0 | 73.65 | +73.65 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 4 | Polyamide Sariq 187 TWS | — | — | 0 | 44.6 | +44.6 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 5 | Polyamide Oq 187 TWS | — | — | 0 | 132.15 | +132.15 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 6 | Qop ip Yashil | xomashyo «Qop ip» | — (xomashyo) | 0 | 2 244.1 | +2 244.1 | kg | POSSIBLE_MATCH | YO’Q — identifikatsiya tasdiqlanmaguncha |
| 7 | Qop ip Qizil | xomashyo «Qop ip» | — (xomashyo) | 0 | 728.55 | +728.55 | kg | POSSIBLE_MATCH | YO’Q — identifikatsiya tasdiqlanmaguncha |
| 8 | Passport Xom BCF | — | — | 0 | 646 | +646 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 9 | Yashil PP TWS Strupa 24 talik | — | — | 0 | 643.4 | +643.4 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 10 | Passport Strupa 16 talik | — | — | 0 | 527.65 | +527.65 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 11 | Passport Strupa 24 talik | — | — | 0 | 273.75 | +273.75 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 12 | Yashil PP TWS Strupa 16 talik | — | — | 0 | 168.6 | +168.6 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 13 | Sariq Polyester Strupa 16 talik | — | — | 0 | 2 583.9 | +2 583.9 | kg | UNMATCHED | YO’Q — exception hisobotida |
| | **JAMI** | | | **0** | **8 713.3** | **+8 713.3** | kg | | |

### C-18 (DB ID: 24) — ERP joriy holati: BO’SH (0 qator, 0 harakat)

| # | Fizik nom (aynan yozilganidek) | Mos ERP item | SKU | ERP qoldiq (shu joyda) | Fizik sanoq | Farq | Birlik | Holat | Taklif |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Toshkent Arqon 16 mm Ko‘k | — | — | 0 | 221.6 | +221.6 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 2 | Toshkent Arqon 16 mm Qora | — | — | 0 | 332.95 | +332.95 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 3 | Ustki Gilam Ichki Sariq Polyamide | — | — | 0 | 317.25 | +317.25 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 4 | Toshkent Arqon 10 mm Yashil | — | — | 0 | 171.9 | +171.9 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 5 | Toshkent Arqon 14 mm Qizil | — | — | 0 | 451.7 | +451.7 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 6 | Toshkent Arqon 12 mm Qora Ichki Polyamide Sariq | — | — | 0 | 866.25 | +866.25 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 7 | Toshkent Arqon 12 mm Qizil | — | — | 0 | 61.65 | +61.65 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 8 | Toshkent Arqon 14 mm Qora | — | — | 0 | 150 | +150 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 9 | Toshkent Arqon 10 mm Ko‘k | — | — | 0 | 150.25 | +150.25 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 10 | FDY Fil Arqon | — | — | 0 | 497.55 | +497.55 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 11 | Toshkent Arqon 16 mm Oq — 50 metr *(metr: NULL)* | — | — | 0 | 63.2 | +63.2 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 12 | Toshkent Arqon 14 mm Oq — 100 metr *(metr: NULL)* | — | — | 0 | 40.05 | +40.05 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 13 | Toshkent Arqon 16 mm Oq | — | — | 0 | 61.9 | +61.9 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 14 | Toshkent Arqon Qora 16 mm Ichki Polyamide Sariq | — | — | 0 | 717.35 | +717.35 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 15 | Toshkent Arqon 12 mm Sariq | — | — | 0 | 389.95 | +389.95 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 16 | FDY Tros Aralash | — | — | 0 | 386.75 | +386.75 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 17 | Rossiya Tros | mahsulot «Rossiya Tros» | `ROSSIYATROS` | 0 | 531 | +531 | kg | EXACT_MATCH | IN +531 kg (FAQAT tasdiqdan keyin) |
| 18 | Usti gilam ichki Sariq Polyamide Arqon | — | — | 0 | 370.5 | +370.5 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 19 | Ustki Oq TWS ichki Polyamide Oq Arqon | — | — | 0 | 1 264.1 | +1 264.1 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 20 | Ustki PP xom ichki Polyamide Oq Arqon | — | — | 0 | 105 | +105 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 21 | Ustki 187 TWS Oq ichki Zubr 16 mm Arqon | — | — | 0 | 926.4 | +926.4 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 22 | Ustki 187 TWS Oq ichki Strupa 14 mm Arqon | — | — | 0 | 520 | +520 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 23 | Kanob Aralash 20 metr *(metr: NULL)* | — | — | 0 | 113.55 | +113.55 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 24 | Alpinist 12 mm | — | — | 0 | 450.6 | +450.6 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 25 | Alpinist 10 mm | — | — | 0 | 106.2 | +106.2 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 26 | Alpinist 14 mm | — | — | 0 | 165.55 | +165.55 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 27 | Alpinist 16 mm | — | — | 0 | 199.3 | +199.3 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 28 | Alpinist 20 mm | — | — | 0 | 174.5 | +174.5 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 29 | Alpinist 25 mm | — | — | 0 | 32.45 | +32.45 | kg | UNMATCHED | YO’Q — exception hisobotida |
| | **JAMI** | | | **0** | **9 839.45** | **+9 839.45** | kg | | |

### C-02 (DB ID: 8) — ERP joriy holati: BO’SH (0 qator, 0 harakat)

| # | Fizik nom (aynan yozilganidek) | Mos ERP item | SKU | ERP qoldiq (shu joyda) | Fizik sanoq | Farq | Birlik | Holat | Taklif |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Shroki 3.5 sm lenta | mahsulot «Shroki 3.5» | `shrk35` | 0 | 468.35 | +468.35 | kg | POSSIBLE_MATCH | YO’Q — identifikatsiya tasdiqlanmaguncha |
| 2 | Rangli 2.5 sm ikki qavat lenta | — | — | 0 | 863.45 | +863.45 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 3 | Reels Lenta | mahsulot «Reels» | `REELS` | 0 | 1 352.85 | +1 352.85 | kg | POSSIBLE_MATCH | YO’Q — identifikatsiya tasdiqlanmaguncha |
| 4 | Tulpor Lenta Aralash | — | — | 0 | 556.4 | +556.4 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 5 | Tulpor Lenta Yashil | — | — | 0 | 1 019.35 | +1 019.35 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 6 | Tulpor Lenta Oq | — | — | 0 | 439.2 | +439.2 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 7 | Tulpor Lenta Ko‘k | — | — | 0 | 192.05 | +192.05 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 8 | Tulpor lenta qizil | — | — | 0 | 287 | +287 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 9 | Shroki 3.5 Oq | mahsulot «Shroki 3.5 Oq» | `SHROKI-3-5-OQ` | 0 | 676.55 | +676.55 | kg | EXACT_MATCH | IN +676.55 kg (FAQAT tasdiqdan keyin) |
| 10 | Tahoe Lenta | mahsulot «Tahoe 50 m» | `th50` | 0 | 197.8 | +197.8 | kg | POSSIBLE_MATCH | YO’Q — identifikatsiya tasdiqlanmaguncha |
| | **JAMI** | | | **0** | **6 053** | **+6 053** | kg | | |

### C-04 (DB ID: 10) — ERP joriy holati: BO’SH (0 qator, 0 harakat)

| # | Fizik nom (aynan yozilganidek) | Mos ERP item | SKU | ERP qoldiq (shu joyda) | Fizik sanoq | Farq | Birlik | Holat | Taklif |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Polipropilen CF 1500D Qora | — | — | 0 | 3 250 | +3 250 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 2 | Polipropilen CF 1000D Yashil | — | — | 0 | 1 020 | +1 020 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 3 | Strupa Salafan | mahsulot «Salafan Strupa» | `SLFSTR` | 0 | 375.8 | +375.8 | kg | POSSIBLE_MATCH | YO’Q — identifikatsiya tasdiqlanmaguncha |
| 4 | XB Strupa | — | — | 0 | 349.9 | +349.9 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 5 | PP Oq TWS Strupa 12 talik | — | — | 0 | 875.55 | +875.55 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 6 | Eshma Xitoy Strupa PP Oq TWS | — | — | 0 | 230.85 | +230.85 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 7 | Yashil PP TWS Strupa 16 talik | — | — | 0 | 261.2 | +261.2 | kg | UNMATCHED | YO’Q — exception hisobotida |
| | **JAMI** | | | **0** | **6 363.3** | **+6 363.3** | kg | | |

### C-06 (DB ID: 12) — ERP joriy holati: BO’SH (0 qator, 0 harakat)

| # | Fizik nom (aynan yozilganidek) | Mos ERP item | SKU | ERP qoldiq (shu joyda) | Fizik sanoq | Farq | Birlik | Holat | Taklif |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Shlanka Polyamide Yumshoq | mahsulot «Shlanka Polyamide» ⚠birlik zid | `SHLPOLYD` | 0 | 86.3 | +86.3 | kg | POSSIBLE_MATCH | YO’Q — identifikatsiya tasdiqlanmaguncha |
| 2 | Shlanka Tortqi PP Oq TWS — 50 metr *(metr: NULL)* | mahsulot «Shlanka PP / Oq» | `SHLPP/OQ` | 0 | 236.25 | +236.25 | kg | POSSIBLE_MATCH | YO’Q — identifikatsiya tasdiqlanmaguncha |
| 3 | Shlanka Tortqi PP Yashil TWS — 50 metr *(metr: NULL)* | — | — | 0 | 66.35 | +66.35 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 4 | Shlanka Polipropilen CF Qora | — | — | 0 | 618.8 | +618.8 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 5 | Shlanka Polipropilen CF Yashil | — | — | 0 | 710.45 | +710.45 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 6 | Shlanka Polipropilen CF Ko‘k | — | — | 0 | 506.25 | +506.25 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 7 | Shlanka Polipropilen CF Qizil | — | — | 0 | 581.4 | +581.4 | kg | UNMATCHED | YO’Q — exception hisobotida |
| 8 | Shlanka Polipropilen CF Oq | mahsulot «Shlanka PP / Oq» | `SHLPP/OQ` | 0 | 874.95 | +874.95 | kg | POSSIBLE_MATCH | YO’Q — identifikatsiya tasdiqlanmaguncha |
| 9 | Shlanka Polyester FDY Qora | mahsulot «Shlanka FDY / Qora» ⚠birlik zid | `SHFDY/QORA` | 0 | 433.2 | +433.2 | kg | POSSIBLE_MATCH | YO’Q — identifikatsiya tasdiqlanmaguncha |
| 10 | Shlanka Polyester FDY Yashil | mahsulot «Shlanka FDY/Yashil» ⚠birlik zid | `SHFDY/YASHIL` | 0 | 830.4 | +830.4 | kg | POSSIBLE_MATCH | YO’Q — identifikatsiya tasdiqlanmaguncha |
| 11 | Shlanka Polyester FDY Ko‘k | mahsulot «Shlanka FDY/ Ko'k» ⚠birlik zid | `SHFDY/KOK` | 0 | 778.15 | +778.15 | kg | POSSIBLE_MATCH | YO’Q — identifikatsiya tasdiqlanmaguncha |
| 12 | Shlanka Polyester FDY Qizil | mahsulot «Shlanka FDY / QIzil» ⚠birlik zid | `SHFDY/QIZIL` | 0 | 730.95 | +730.95 | kg | POSSIBLE_MATCH | YO’Q — identifikatsiya tasdiqlanmaguncha |
| 13 | Shlanka Polyester FDY Oq | mahsulot «Shlanka FDY / OQ» ⚠birlik zid | `SHFDY/OQ` | 0 | 982.05 | +982.05 | kg | POSSIBLE_MATCH | YO’Q — identifikatsiya tasdiqlanmaguncha |
| | **JAMI** | | | **0** | **7 435.5** | **+7 435.5** | kg | | |

## 4-bosqich — Maxsus holatlar qo’llanishi

1. **Takror nomlar alohida saqlandi**: «Yashil PP TWS Strupa 16 talik» C-19 (168.6) va C-04 (261.2) — 2 alohida qator; «16/14 mm Alpinist» (C-20) vs «Alpinist 16/14 mm» (C-18) — 4 alohida qator; «Ustki Gilam…» vs «Usti gilam…» — 2 alohida qator.
2. **Metr spetsifikatsiyalari**: 6 pozitsiyada «… N metr» nom qismi sifatida qabul qilindi; fizik metr sanog’i berilmagani uchun metr = NULL, kg’dan hisoblanMADI.
3. **Dona chiqarilmadi**: birlik ziddiyatli 6 ta POSSIBLE qatorda (Shlanka FDY oilasi + Shlanka Polyamide) dona soni yo’q — kg’dan dona hisoblash taqiqlangani uchun adjustment ham taklif qilinmadi.
4. **Bitta ERP itemga 2 da’vogar**: «Shlanka PP / Oq» uchun C-06 #2 va C-06 #8 — ikkalasi ham POSSIBLE, egasi ajratmaguncha hech biri biriktirilmaydi.

## 5-bosqich — Adjustment taklifi (FAQAT EXACT_MATCH; BAJARILMAGAN)

Ikkala item ham kg-tipli mahsulot, ERP’da hech qayerda qoldig’i yo’q edi.

| Maydon | Taklif #1 | Taklif #2 |
|---|---|---|
| Joy | C-18 (DB ID 24) | C-02 (DB ID 8) |
| Item / SKU | Rossiya Tros / `ROSSIYATROS` | Shroki 3.5 Oq / `SHROKI-3-5-OQ` |
| Eski qoldiq (shu joyda) | 0 | 0 |
| Eski qoldiq (global) | 0 | 0 |
| Fizik sanoq | 531 kg | 676.55 kg |
| Farq | +531 kg | +676.55 kg |
| Birlik | kg | kg |
| Sabab | PHYSICAL INVENTORY COUNT | PHYSICAL INVENTORY COUNT |
| Reference | PHYSICAL-COUNT-2026-08-15 | PHYSICAL-COUNT-2026-08-15 |
| Sanoq sanasi | 2026-08-15 | 2026-08-15 |
| Operator | ______ (egasi kiritadi) | ______ (egasi kiritadi) |
| Timestamp | bajarilish payti (avtomatik) | bajarilish payti (avtomatik) |

Mexanizm: tarix O’CHIRILMAYDI/QAYTA YOZILMAYDI — yangi auditli harakat yoziladi (7-bosqichdagi model). Diqqat: «Shroki 3.5 Oq» tuzatilsa ham eski egizak «Shroki 3.5» (Namangan −125) TEGILMAYDI.

**Ochiq savol (bajarishdan oldin egasi javob beradi):** kg-tipli mahsulotlarda `inventory.quantity` maydoni ba’zi qatorlarda o’ram soni sifatida ishlatilgan (mas. C-05: 700 dona / 3 292.65 kg). Bu 2 item uchun quantity=kg deb yozamizmi yoki o’ram soni ham sanaladimi?

## 6-bosqich — Exception hisoboti (POSSIBLE 15 + UNMATCHED 65)

Qoida: POSSIBLE — avtomatik adjustment YO’Q; UNMATCHED — avtomatik yangi SKU YO’Q, avtomatik merge YO’Q.

### C-20

**Neylon 210D / 45** — 80 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: Neylon oilasi ERP katalogida umuman yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Neylon 210D / 60** — 1 474 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: Neylon oilasi ERP katalogida umuman yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Neylon 210D / 90** — 330 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: Neylon oilasi ERP katalogida umuman yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Toshkent Oq 14 mm — Bir qavat** — 942.05 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Toshkent» oilasi ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**FDY Igna Strupa** — 4 572.25 kg — `UNMATCHED`
- Nomzodlar: xomashyo «FDY YARN» (birlik kg, global 0 kg)
- Noaniqlik sababi: Bunday kombinatsiya ERP’da yo’q; FDY YARN xomashyosi bor, lekin «Igna Strupa» spetsifikatsiyasi hech qaysi itemda uchramaydi
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Toshkent Qora 14 mm Ichki Sariq** — 636.25 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Toshkent» oilasi ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**16 mm Alpinist** — 520 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: Alpinist oilasi ERP’da yo’q. Diqqat: C-18’da «Alpinist 16 mm» yozuvi ham bor — so’z tartibi farqli, ikkalasi alohida qator sifatida saqlanadi (4-bosqich, 1-qoida)
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**14 mm Alpinist** — 930 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: Alpinist oilasi ERP’da yo’q; C-18’dagi «Alpinist 14 mm» bilan tartibi farqli — alohida saqlanadi
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Toshkent Qora 14 mm Ichi Oq PP TWS** — 309.6 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Toshkent» oilasi ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Toshkent Oq 16 mm Ichi Oq PP TWS — 50 metr** — 342.3 kg (metr: NULL) — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Toshkent» oilasi ERP’da yo’q; «50 metr» spetsifikatsiya, metr sanog’i berilmagan (NULL)
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI


### C-19

**Polyamide 144 oq TWS** — 552.9 kg — `POSSIBLE_MATCH`
- Nomzodlar: mahsulot «Polyamide 144» (SKU `ply144`, birlik kg; Namangan Markaziy Ombor: −931); xomashyo «Polyamide» (birlik kg, global 0 kg)
- Noaniqlik sababi: Nom «oq TWS» qo’shimchasi bilan farq qiladi; birlik mos (kg). Namangan’da −931 kg minus bor — tarixiy bog’lanish ehtimoli
- Tavsiya: egasi «HA/YO’Q» deb tasdiqlaydi; HA bo’lsa adjustment ro’yxatiga qo’shiladi

**Polyamide Ko‘k 187 TWS** — 94.05 kg — `UNMATCHED`
- Nomzodlar: xomashyo «Polyamide» (birlik kg, global 0 kg)
- Noaniqlik sababi: «187 TWS» spetsifikatsiyali va rangli Polyamide itemlari ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Polyamide Qizil 187 TWS** — 73.65 kg — `UNMATCHED`
- Nomzodlar: xomashyo «Polyamide» (birlik kg, global 0 kg)
- Noaniqlik sababi: «187 TWS» spetsifikatsiyali va rangli Polyamide itemlari ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Polyamide Sariq 187 TWS** — 44.6 kg — `UNMATCHED`
- Nomzodlar: xomashyo «Polyamide» (birlik kg, global 0 kg)
- Noaniqlik sababi: «187 TWS» spetsifikatsiyali va rangli Polyamide itemlari ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Polyamide Oq 187 TWS** — 132.15 kg — `UNMATCHED`
- Nomzodlar: xomashyo «Polyamide» (birlik kg, global 0 kg)
- Noaniqlik sababi: «187 TWS» spetsifikatsiyali va rangli Polyamide itemlari ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Qop ip Yashil** — 2 244.1 kg — `POSSIBLE_MATCH`
- Nomzodlar: xomashyo «Qop ip» (birlik kg, global −255 kg)
- Noaniqlik sababi: ERP’dagi xomashyo «Qop ip» rangsiz (global −255 kg); fizik nomda Yashil rang bor — rang varianti ERP’da mavjud emas. Dona-tipli «Qop ip N talik» MAHSULOTLARI bu emas (birlik zid)
- Tavsiya: egasi «HA/YO’Q» deb tasdiqlaydi; HA bo’lsa adjustment ro’yxatiga qo’shiladi

**Qop ip Qizil** — 728.55 kg — `POSSIBLE_MATCH`
- Nomzodlar: xomashyo «Qop ip» (birlik kg, global −255 kg)
- Noaniqlik sababi: Xuddi shu: rang varianti ERP’da yo’q
- Tavsiya: egasi «HA/YO’Q» deb tasdiqlaydi; HA bo’lsa adjustment ro’yxatiga qo’shiladi

**Passport Xom BCF** — 646 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Passport» va «BCF» so’zlari ERP katalogida umuman uchramaydi
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Yashil PP TWS Strupa 24 talik** — 643.4 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «N talik» strupa spetsifikatsiyalari ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Passport Strupa 16 talik** — 527.65 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Passport» ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Passport Strupa 24 talik** — 273.75 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Passport» ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Yashil PP TWS Strupa 16 talik** — 168.6 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «N talik» strupa spetsifikatsiyalari ERP’da yo’q. Diqqat: xuddi shu nom C-04’da ham sanalgan (261.2 kg) — 4-bosqich 1-qoidasiga ko’ra qatorlar alohida saqlanadi
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Sariq Polyester Strupa 16 talik** — 2 583.9 kg — `UNMATCHED`
- Nomzodlar: mahsulot «Strupa Sariq» (SKU `STRUPA-SARIQ`, birlik kg; hech qayerda qoldiq yo’q); mahsulot «Strupa Sari» (SKU `ST70M`, birlik kg; Namangan Markaziy Ombor: −13)
- Noaniqlik sababi: «16 talik / Polyester» spetsifikatsiyasi ERP’dagi Strupa itemlarida yo’q — o’xshash nomlar isbot emas
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI


### C-18

**Toshkent Arqon 16 mm Ko‘k** — 221.6 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Toshkent Arqon» oilasi (14 pozitsiya) ERP’da butunlay yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Toshkent Arqon 16 mm Qora** — 332.95 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Toshkent Arqon» oilasi ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Ustki Gilam Ichki Sariq Polyamide** — 317.25 kg — `UNMATCHED`
- Nomzodlar: mahsulot «Gilam tros kurtka tros» (SKU `GILAM-TROS-KURTKA-TROS`, birlik kg; hech qayerda qoldiq yo’q)
- Noaniqlik sababi: «Ustki/Gilam» kombinatsiyasi ERP’da yo’q; «Gilam tros kurtka tros» butunlay boshqa tuzilishdagi nom — xavfli o’xshashlik, isbot yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Toshkent Arqon 10 mm Yashil** — 171.9 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Toshkent Arqon» oilasi ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Toshkent Arqon 14 mm Qizil** — 451.7 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Toshkent Arqon» oilasi ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Toshkent Arqon 12 mm Qora Ichki Polyamide Sariq** — 866.25 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Toshkent Arqon» oilasi ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Toshkent Arqon 12 mm Qizil** — 61.65 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Toshkent Arqon» oilasi ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Toshkent Arqon 14 mm Qora** — 150 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Toshkent Arqon» oilasi ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Toshkent Arqon 10 mm Ko‘k** — 150.25 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Toshkent Arqon» oilasi ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**FDY Fil Arqon** — 497.55 kg — `UNMATCHED`
- Nomzodlar: xomashyo «FDY YARN» (birlik kg, global 0 kg)
- Noaniqlik sababi: «Fil Arqon» ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Toshkent Arqon 16 mm Oq — 50 metr** — 63.2 kg (metr: NULL) — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Toshkent Arqon» oilasi ERP’da yo’q; metr sanog’i berilmagan (NULL)
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Toshkent Arqon 14 mm Oq — 100 metr** — 40.05 kg (metr: NULL) — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Toshkent Arqon» oilasi ERP’da yo’q; «Strupa Oq 100 metr» butunlay boshqa oila — rad etildi; metr NULL
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Toshkent Arqon 16 mm Oq** — 61.9 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Toshkent Arqon» oilasi ERP’da yo’q. Diqqat: #11’dagi «… Oq — 50 metr» bilan ALOHIDA qator (spetsifikatsiya farqi)
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Toshkent Arqon Qora 16 mm Ichki Polyamide Sariq** — 717.35 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Toshkent Arqon» oilasi ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Toshkent Arqon 12 mm Sariq** — 389.95 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Toshkent Arqon» oilasi ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**FDY Tros Aralash** — 386.75 kg — `UNMATCHED`
- Nomzodlar: xomashyo «FDY YARN» (birlik kg, global 0 kg)
- Noaniqlik sababi: Bunday kombinatsiya ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Usti gilam ichki Sariq Polyamide Arqon** — 370.5 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: ERP’da yo’q. Diqqat: C-18 #3 «Ustki Gilam Ichki Sariq Polyamide» bilan o’xshash, lekin yozuvlari farqli — ikkala qator ALOHIDA saqlanadi, birlashtirish taqiqlangan
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Ustki Oq TWS ichki Polyamide Oq Arqon** — 1 264.1 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Ustki … ichki …» qatlamli arqon nomlari ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Ustki PP xom ichki Polyamide Oq Arqon** — 105 kg — `UNMATCHED`
- Nomzodlar: xomashyo «PP Xom oq» (birlik kg, global 0 kg)
- Noaniqlik sababi: ERP’da yo’q; «PP Xom oq» xomashyosi bor, lekin bu qatlamli TAYYOR arqon — boshqa narsa
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Ustki 187 TWS Oq ichki Zubr 16 mm Arqon** — 926.4 kg — `UNMATCHED`
- Nomzodlar: mahsulot «Zubr Lenta» (SKU `ZUBRL`, birlik kg; hech qayerda qoldiq yo’q)
- Noaniqlik sababi: ERP’da yo’q; «Zubr Lenta» faqat bitta so’z mosligi — isbot emas
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Ustki 187 TWS Oq ichki Strupa 14 mm Arqon** — 520 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Kanob Aralash 20 metr** — 113.55 kg (metr: NULL) — `UNMATCHED`
- Nomzodlar: mahsulot «Kanob» (SKU `Kanoblar`, birlik kg; hech qayerda qoldiq yo’q); xomashyo «Kanob» (birlik kg, global 0 kg); mahsulot «Dor ip 20 metr» (SKU `DOR-IP-20-METR`, birlik kg; hech qayerda qoldiq yo’q)
- Noaniqlik sababi: «Kanob» ERP’da bor (mahsulot ham, xomashyo ham), lekin «Aralash 20 metr» spetsifikatsiyasi hech birida yo’q; metr sanog’i berilmagan (NULL)
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Alpinist 12 mm** — 450.6 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: Alpinist oilasi ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Alpinist 10 mm** — 106.2 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: Alpinist oilasi ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Alpinist 14 mm** — 165.55 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: Alpinist oilasi ERP’da yo’q; C-20’da «14 mm Alpinist» bor — alohida saqlanadi
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Alpinist 16 mm** — 199.3 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: Alpinist oilasi ERP’da yo’q; C-20’da «16 mm Alpinist» bor — alohida saqlanadi
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Alpinist 20 mm** — 174.5 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: Alpinist oilasi ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Alpinist 25 mm** — 32.45 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: Alpinist oilasi ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI


### C-02

**Shroki 3.5 sm lenta** — 468.35 kg — `POSSIBLE_MATCH`
- Nomzodlar: mahsulot «Shroki 3.5» (SKU `shrk35`, birlik kg; Namangan Markaziy Ombor: −125)
- Noaniqlik sababi: «sm lenta» qo’shimchasi bilan farq; Namangan’da −125 kg minus bor. MUHIM: fizik sanoqda «Shroki 3.5 Oq» ham ALOHIDA sanalgan — bu Q3’dagi «bular boshqa-boshqa mahsulot» xulosasini QUVVATLAYDI
- Tavsiya: egasi «HA/YO’Q» deb tasdiqlaydi; HA bo’lsa adjustment ro’yxatiga qo’shiladi

**Rangli 2.5 sm ikki qavat lenta** — 863.45 kg — `UNMATCHED`
- Nomzodlar: mahsulot «Ikki Qavat Arqon Rangli» (SKU `IKKIRANAR`, birlik kg; Namangan Markaziy Ombor: −27)
- Noaniqlik sababi: LENTA ≠ ARQON: «Ikki Qavat Arqon Rangli» nomzodi arqon, fizik esa lenta — topshiriqda ogohlantirilgan xavfli o’xshashlik turi, isbotsiz biriktirilmaydi
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Reels Lenta** — 1 352.85 kg — `POSSIBLE_MATCH`
- Nomzodlar: mahsulot «Reels» (SKU `REELS`, birlik kg; hech qayerda qoldiq yo’q)
- Noaniqlik sababi: «Reels» unikal brend-token, ERP’da faqat bitta; fizik nomda «Lenta» qo’shimchasi bor
- Tavsiya: egasi «HA/YO’Q» deb tasdiqlaydi; HA bo’lsa adjustment ro’yxatiga qo’shiladi

**Tulpor Lenta Aralash** — 556.4 kg — `UNMATCHED`
- Nomzodlar: mahsulot «Tulpor» (SKU `TULPOR`, birlik kg; hech qayerda qoldiq yo’q); mahsulot «5 mm Tulpor» (SKU `5MMTULPOR`, birlik kg; hech qayerda qoldiq yo’q); mahsulot «Tulpor 80 metr» (SKU `TUP80`, birlik kg; hech qayerda qoldiq yo’q)
- Noaniqlik sababi: Tulpor oilasi ERP’da bor, lekin «Lenta + rang» variantlari yo’q; qaysi biriga tegishli ekani isbotlanmaydi
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Tulpor Lenta Yashil** — 1 019.35 kg — `UNMATCHED`
- Nomzodlar: mahsulot «Tulpor» (SKU `TULPOR`, birlik kg; hech qayerda qoldiq yo’q)
- Noaniqlik sababi: Tulpor rang variantlari ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Tulpor Lenta Oq** — 439.2 kg — `UNMATCHED`
- Nomzodlar: mahsulot «Tulpor» (SKU `TULPOR`, birlik kg; hech qayerda qoldiq yo’q)
- Noaniqlik sababi: Tulpor rang variantlari ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Tulpor Lenta Ko‘k** — 192.05 kg — `UNMATCHED`
- Nomzodlar: mahsulot «Tulpor» (SKU `TULPOR`, birlik kg; hech qayerda qoldiq yo’q)
- Noaniqlik sababi: Tulpor rang variantlari ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Tulpor lenta qizil** — 287 kg — `UNMATCHED`
- Nomzodlar: mahsulot «Tulpor» (SKU `TULPOR`, birlik kg; hech qayerda qoldiq yo’q)
- Noaniqlik sababi: Tulpor rang variantlari ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Tahoe Lenta** — 197.8 kg — `POSSIBLE_MATCH`
- Nomzodlar: mahsulot «Tahoe 50 m» (SKU `th50`, birlik kg; hech qayerda qoldiq yo’q)
- Noaniqlik sababi: ERP’da yagona Tahoe itemi «Tahoe 50 m» (Q9: hamma ko’rsatkichi 0 — arxiv nomzodi edi); nom farqli — tasdiq kerak
- Tavsiya: egasi «HA/YO’Q» deb tasdiqlaydi; HA bo’lsa adjustment ro’yxatiga qo’shiladi


### C-04

**Polipropilen CF 1500D Qora** — 3 250 kg — `UNMATCHED`
- Nomzodlar: xomashyo «Polipropilen 2 x 1500 / OQ» (birlik kg, global −12 092.3 kg); xomashyo «Polipropilen 2 x 1500 / rangli» (birlik kg, global 0 kg); xomashyo «Polipropilen ip» (birlik kg, global 0 kg)
- Noaniqlik sababi: XAVFLI O’XSHASHLIK: xomashyo «Polipropilen 2 x 1500 / OQ» (global −12 092 kg!) bor, lekin fizik mol QORA va «CF 1500D» spetsifikatsiyali — rang ham, yozuv ham mos emas. Isbotsiz biriktirish taqiqlangan
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Polipropilen CF 1000D Yashil** — 1 020 kg — `UNMATCHED`
- Nomzodlar: xomashyo «Polipropilen 2 x 1500 / rangli» (birlik kg, global 0 kg); xomashyo «Polipropilen ip» (birlik kg, global 0 kg)
- Noaniqlik sababi: «CF 1000D» spetsifikatsiyasi ERP’da yo’q; rang varianti ham yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Strupa Salafan** — 375.8 kg — `POSSIBLE_MATCH`
- Nomzodlar: mahsulot «Salafan Strupa» (SKU `SLFSTR`, birlik kg; hech qayerda qoldiq yo’q); xomashyo «Salafan» (birlik kg, global 0 kg)
- Noaniqlik sababi: So’z tartibi almashgan, token to’plami 100% teng — lekin topshiriq qoidasiga ko’ra bu ISBOT EMAS; bundan tashqari xomashyo «Salafan» ham bor — qaysi biri ekanini egasi tasdiqlashi kerak
- Tavsiya: egasi «HA/YO’Q» deb tasdiqlaydi; HA bo’lsa adjustment ro’yxatiga qo’shiladi

**XB Strupa** — 349.9 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «XB» belgisi ERP’da uchramaydi
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**PP Oq TWS Strupa 12 talik** — 875.55 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «N talik» strupa spetsifikatsiyalari ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Eshma Xitoy Strupa PP Oq TWS** — 230.85 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «Eshma/Xitoy» ERP’da yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Yashil PP TWS Strupa 16 talik** — 261.2 kg — `UNMATCHED`
- Nomzodlar: yo’q
- Noaniqlik sababi: «N talik» spetsifikatsiyasi ERP’da yo’q. C-19’dagi xuddi shu nomli qator bilan ALOHIDA saqlanadi
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI


### C-06

**Shlanka Polyamide Yumshoq** — 86.3 kg — `POSSIBLE_MATCH`
- Nomzodlar: mahsulot «Shlanka Polyamide» (SKU `SHLPOLYD`, birlik dona; hech qayerda qoldiq yo’q)
- Noaniqlik sababi: Nomga «Yumshoq» qo’shilgan; BIRLIK ZIDDIYATI: ERP’da dona, fizik sanoq kg — dona soni yo’q, kg’dan chiqarish taqiqlangan (4-bosqich)
- Tavsiya: egasi «HA/YO’Q» deb tasdiqlaydi; HA bo’lsa adjustment ro’yxatiga qo’shiladi va dona soni sanaladi (kg’dan hisoblab chiqarish taqiqlangan)

**Shlanka Tortqi PP Oq TWS — 50 metr** — 236.25 kg (metr: NULL) — `POSSIBLE_MATCH`
- Nomzodlar: mahsulot «Shlanka PP / Oq» (SKU `SHLPP/OQ`, birlik kg; Namangan Markaziy Ombor: −798); mahsulot «Shlanka Parashut 50 metr» (SKU `SHLANKA-PARASHUT-50-METR`, birlik kg; hech qayerda qoldiq yo’q); mahsulot «Tortqi Polyamide» (SKU `TORTPOLYD`, birlik dona; Namangan Markaziy Ombor: −50)
- Noaniqlik sababi: Ikkita jiddiy nomzod: «Shlanka PP / Oq» (kg; Namangan −798) va «Shlanka Parashut 50 metr» (kg); «Tortqi Polyamide» (dona) ham bor. Qaysi biri — egasi aytishi kerak; metr NULL. MUHIM: C-06 #8 ham «Shlanka PP / Oq»ga da’vogar — bitta ERP itemga 2 fizik qator
- Tavsiya: egasi «HA/YO’Q» deb tasdiqlaydi; HA bo’lsa adjustment ro’yxatiga qo’shiladi

**Shlanka Tortqi PP Yashil TWS — 50 metr** — 66.35 kg (metr: NULL) — `UNMATCHED`
- Nomzodlar: mahsulot «Shlanka PP / Rangli» (SKU `SHLPP/RANGli`, birlik kg; Namangan Markaziy Ombor: −68); mahsulot «Shlanka Parashut 50 metr» (SKU `SHLANKA-PARASHUT-50-METR`, birlik kg; hech qayerda qoldiq yo’q)
- Noaniqlik sababi: Yashil variant ERP’da yo’q; «Rangli» umumlashmasiga isbotsiz biriktirilmaydi; metr NULL
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Shlanka Polipropilen CF Qora** — 618.8 kg — `UNMATCHED`
- Nomzodlar: mahsulot «Shlanka PP / Rangli» (SKU `SHLPP/RANGli`, birlik kg; Namangan Markaziy Ombor: −68)
- Noaniqlik sababi: «Polipropilen=PP» sinonim bo’lsa ham QORA rang varianti ERP’da alohida yo’q; «Rangli» umumlashmasiga biriktirish isbotsiz
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Shlanka Polipropilen CF Yashil** — 710.45 kg — `UNMATCHED`
- Nomzodlar: mahsulot «Shlanka PP / Rangli» (SKU `SHLPP/RANGli`, birlik kg; Namangan Markaziy Ombor: −68)
- Noaniqlik sababi: Rang varianti ERP’da alohida yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Shlanka Polipropilen CF Ko‘k** — 506.25 kg — `UNMATCHED`
- Nomzodlar: mahsulot «Shlanka PP / Rangli» (SKU `SHLPP/RANGli`, birlik kg; Namangan Markaziy Ombor: −68)
- Noaniqlik sababi: Rang varianti ERP’da alohida yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Shlanka Polipropilen CF Qizil** — 581.4 kg — `UNMATCHED`
- Nomzodlar: mahsulot «Shlanka PP / Rangli» (SKU `SHLPP/RANGli`, birlik kg; Namangan Markaziy Ombor: −68)
- Noaniqlik sababi: Rang varianti ERP’da alohida yo’q
- Tavsiya: P2 items foundation’da yangi kanonik item sifatida ochish (sanoq nomi bilan) YOKI egasi mavjud itemga biriktirish dalilini beradi. Hozircha yangi SKU YARATILMAYDI

**Shlanka Polipropilen CF Oq** — 874.95 kg — `POSSIBLE_MATCH`
- Nomzodlar: mahsulot «Shlanka PP / Oq» (SKU `SHLPP/OQ`, birlik kg; Namangan Markaziy Ombor: −798)
- Noaniqlik sababi: PP=Polipropilen sinonimi + Oq rang mos; «CF» qo’shimchasi va Namangan −798 tarixiy minus bor. Diqqat: C-06 #2 ham shu itemga da’vogar — ikkala qator alohida turadi, egasi ajratadi
- Tavsiya: egasi «HA/YO’Q» deb tasdiqlaydi; HA bo’lsa adjustment ro’yxatiga qo’shiladi

**Shlanka Polyester FDY Qora** — 433.2 kg — `POSSIBLE_MATCH`
- Nomzodlar: mahsulot «Shlanka FDY / Qora» (SKU `SHFDY/QORA`, birlik dona; Namangan Markaziy Ombor: −16)
- Noaniqlik sababi: Rang 1:1 mos (FDY oilasi), lekin fizik nomda «Polyester» bor va BIRLIK ZIDDIYATI: ERP dona, sanoq kg. Namangan’da −16 dona minus
- Tavsiya: egasi «HA/YO’Q» deb tasdiqlaydi; HA bo’lsa adjustment ro’yxatiga qo’shiladi va dona soni sanaladi (kg’dan hisoblab chiqarish taqiqlangan)

**Shlanka Polyester FDY Yashil** — 830.4 kg — `POSSIBLE_MATCH`
- Nomzodlar: mahsulot «Shlanka FDY/Yashil» (SKU `SHFDY/YASHIL`, birlik dona; Namangan Markaziy Ombor: −32)
- Noaniqlik sababi: Rang mos; birlik ziddiyati (dona vs kg); Namangan −32
- Tavsiya: egasi «HA/YO’Q» deb tasdiqlaydi; HA bo’lsa adjustment ro’yxatiga qo’shiladi va dona soni sanaladi (kg’dan hisoblab chiqarish taqiqlangan)

**Shlanka Polyester FDY Ko‘k** — 778.15 kg — `POSSIBLE_MATCH`
- Nomzodlar: mahsulot «Shlanka FDY/ Ko'k» (SKU `SHFDY/KOK`, birlik dona; Namangan Markaziy Ombor: −32)
- Noaniqlik sababi: Rang mos; birlik ziddiyati; Namangan −32
- Tavsiya: egasi «HA/YO’Q» deb tasdiqlaydi; HA bo’lsa adjustment ro’yxatiga qo’shiladi va dona soni sanaladi (kg’dan hisoblab chiqarish taqiqlangan)

**Shlanka Polyester FDY Qizil** — 730.95 kg — `POSSIBLE_MATCH`
- Nomzodlar: mahsulot «Shlanka FDY / QIzil» (SKU `SHFDY/QIZIL`, birlik dona; Namangan Markaziy Ombor: −32)
- Noaniqlik sababi: Rang mos; birlik ziddiyati; Namangan −32
- Tavsiya: egasi «HA/YO’Q» deb tasdiqlaydi; HA bo’lsa adjustment ro’yxatiga qo’shiladi va dona soni sanaladi (kg’dan hisoblab chiqarish taqiqlangan)

**Shlanka Polyester FDY Oq** — 982.05 kg — `POSSIBLE_MATCH`
- Nomzodlar: mahsulot «Shlanka FDY / OQ» (SKU `SHFDY/OQ`, birlik dona; Namangan Markaziy Ombor: −104)
- Noaniqlik sababi: Rang mos; birlik ziddiyati; Namangan −104
- Tavsiya: egasi «HA/YO’Q» deb tasdiqlaydi; HA bo’lsa adjustment ro’yxatiga qo’shiladi va dona soni sanaladi (kg’dan hisoblab chiqarish taqiqlangan)


## 7-bosqich — Arxitektura xulosasi: TO’XTALDIK (ma’lumot mutatsiyasidan oldin)

Hozirgi arxitektura auditli adjustment uchun **yetarli emas**, sabablari:

1. `stock_movements.movement_type` CHECK faqat IN/OUT/TRANSFER — **ADJUSTMENT turi yo’q**; IN sifatida yozish tuzatishni oddiy kirimga niqoblaydi.
2. Jadvalda **reason/reference maydonlari yo’q** (faqat erkin `note`), audit izi strukturasiz qoladi.
3. Identifikatsiya **matnli nom orqali** (`product` TEXT) — aynan shu loyihada tozalanayotgan zaiflik; noto’g’ri yozilgan nom yangi «arvoh» qator ochib yuboradi.
4. `inventory`da quantity+weight_kg juftligi bor, `stock_movements`da faqat quantity — og’irlik harakati kuzatilmaydi; kg-tip mahsulotlarda quantity semantikasi (kg yoki o’ram) qatordan qatorga farq qiladi.

### Talab qilinadigan o’zgarish (egasi ruxsatidan keyin, P2’dan MUSTAQIL kichik tayyorgarlik)

1. **Sxema**: CHECK’ga 'ADJUSTMENT' qo’shish + `reference TEXT`, `weight_kg NUMERIC` ustunlari (idempotent ALTER; mavjud qatorlar tegilmaydi).
2. **API**: `POST /api/inventory/adjustments` (faqat admin) — kirish: warehouse_id, product (MAVJUD ERP nomi — yangi nom rad etiladi), product_type, physical_qty, physical_weight_kg, reason, reference, operator.
3. **Tranzaksiya modeli** (bitta txn):
```sql
BEGIN;
SELECT * FROM inventory WHERE warehouse_id=$1 AND product=$2 FOR UPDATE; -- eski qoldiqni qulflab o’qish
INSERT INTO stock_movements(product, product_type, quantity, weight_kg, movement_type, to_warehouse_id, note, created_by, reference)
VALUES ($2,$3,$delta_qty,$delta_kg,'ADJUSTMENT',$1,
        'PHYSICAL INVENTORY COUNT | old:<eski> | count:<sanoq> | diff:<farq> | unit:kg | date:2026-08-15 | operator:<kim>',
        $operator,'PHYSICAL-COUNT-2026-08-15');
INSERT INTO inventory(warehouse_id,product,product_type,quantity,weight_kg) VALUES(...)
  ON CONFLICT (warehouse_id,product) DO UPDATE SET quantity=EXCLUDED.quantity, weight_kg=EXCLUDED.weight_kg, updated_at=now();
COMMIT;
```
4. **Bajarish rejasi**: (1) egasi 5-bosqich taklifini tasdiqlaydi → (2) sxema ALTER → (3) endpoint + test → (4) 2 ta EXACT adjustment bajariladi → (5) 8-bosqich tekshiruvi → (6) hisobot yangilanadi.
5. **Rollback strategiyasi**: har adjustment `reference` tegi bilan; bekor qilish = xuddi shu reference’ga teskari ADJUSTMENT yozuvi (tarix o’chirilmaydi); bajarishdan oldin checkpoint + ta’sirlangan qatorlarning SQL nusxasi saqlanadi.

## 8-bosqich — Tasdiqdan keyingi tekshiruv (KUTILMOQDA)

Adjustment bajarilgach: inventory qayta o’qiladi, har EXACT item uchun `ERP AFTER == PHYSICAL` tekshiriladi, natija MATCHED/UNRESOLVED/PENDING_MAPPING statuslari bilan shu hujjatga qo’shiladi. Hozircha: bajarilgan adjustment — **0 ta**.

## 9-bosqich — Yakuniy hisobot holati

| Bo’lim | Holat |
|---|---|
| 1. Fizik sanoq xulosasi | ✓ 82 pozitsiya, 48 541 kg, 6/6 summa mos |
| 2. Konteyner xaritasi | ✓ 6/6 TASDIQLANDI |
| 3. Exact match | ✓ 2 ta (1 207.55 kg) |
| 4. Possible match | ✓ 15 ta (10 872.6 kg) — egasi tasdig’ini kutmoqda |
| 5. Unmatched | ✓ 65 ta (36 460.85 kg) — exception hisobotida |
| 6. ERP oldingi qoldiqlar | ✓ hammasi 0 (6 konteyner bo’sh edi) |
| 7. Taklif qilingan adjustmentlar | ✓ 2 ta (jami +1 207.55 kg) — TASDIQ KUTILMOQDA |
| 8. Bajarilgan adjustmentlar | 0 ta (hech narsa o’zgartirilmagan) |
| 9. ERP keyingi qoldiqlar | — (bajarilmagan) |
| 10. Qolgan tafovutlar | 80 pozitsiya (47 333.45 kg) egasi qarorini kutmoqda |
| 11. Audit reference | PHYSICAL-COUNT-2026-08-15 |
| 12. Tekshiruv natijasi | KUTILMOQDA (8-bosqich) |

## Namangan minuslari bilan bog’lanish (dalil, qaror emas)

Fizik topilgan oilalar bilan Namangan Markaziy Ombordagi minuslar ustma-ust tushadi: Shlanka FDY (5 rang; Namangan jami −216 dona) ↔ C-06’da 3 754.75 kg FDY oilasi; Shlanka PP/Oq (−798) ↔ C-06’da PP Oq qatorlari; Polyamide 144 (−931) ↔ C-19’da 552.9 kg; Shroki 3.5 (−125) ↔ C-02’da 468.35 kg. Bu «sotuvlar omborsiz davrda aslida shu konteynerlardagi moldan qilingan» gipotezasini kuchaytiradi — tasnifi: **tarixiy ma’lumot xatosi**. (Bu bog’lanishlar ham isbotsiz avtomatik yopilmaydi.)

## EGASINING QARORLARI (to’ldiring)

| # | Savol | Javob |
|---|---|---|
| 1 | 2 ta EXACT adjustment (Rossiya Tros +531; Shroki 3.5 Oq +676.55) bajarilsinmi? | ______ |
| 2 | Bu 2 item uchun quantity=kg konventsiyasi to’g’rimi (o’ram sanalmaydimi)? | ______ |
| 3 | 15 ta POSSIBLE juftlikdan qaysilari «HA» (6-bosqich ro’yxati bo’yicha birma-bir)? | ______ |
| 4 | 65 ta UNMATCHED: P2’da sanoq nomlari bilan yangi kanonik item ochilsinmi? | ______ |
| 5 | ADJUSTMENT arxitektura tayyorgarligiga (CHECK+ustunlar+endpoint) ruxsat? | ______ |
| 6 | Birlik ziddiyatli 6 qator uchun dona sanog’i o’tkaziladimi? | ______ |

*Biz taxmin qilmaymiz. Biz bilamiz.*
