# P1 Ma'lumot xaritasi (Data Mapping) — canonical items uchun tasnif
**Sana:** 2026-08-14 · **Rejim:** faqat o'qish — hech qanday merge, rename, adjustment, migratsiya QILINMADI.
**Asos:** arxitektura tasdig'i (15 qoida) + jonli Railway bazasi. Migratsiya rejasi: `docs/canonical-inventory-architecture-audit.md` G-bo'lim (P2 boshlash uchun ushbu hujjatdagi Q-savollar yopilishi kerak).

## Mapping xulosasi

| Ko'rsatkich | Qiymat |
|---|---|
| Mahsulotlar (products) | 117 — hammasida SKU bor |
| Xomashyolar (raw_materials) | 17 |
| Ishlab chiqariladigan (BOM bor) | 59 |
| Xarid/qayta sotish NOMZODLARI (BOMsiz — dalil asosida) | 57 — yakuniy belgini egasi tasdiqlaydi |
| Dual (ikkala katalogda) — MERGE | 4 ta juftlik → −4 yozuv |
| Nom dublikatlari (aynan) | 2 juftlik (Qop ip 80/100) — egasi tanlaydi |
| Dublikat nomzodlari (format/xato farqi) | 4 juftlik: Reja ip PP / 115 gr ↔ Reja ip PP 115 gramm; Reja ip PP / 50 gr ↔ Reja ip PP 50 gramm; Reja ip PP / 80 gr ↔ Reja ip PP 80 gramm; Strupa Sari ↔ Strupa Sariq |
| O'xshash nomlar (egasi tekshiradi) | 2 juftlik: 5 MM GIBRID ↔ 5 mm Gibrid Lenta; Shroki 3.5 ↔ Shroki 3.5 Oq |
| SKU to'qnashuvlari (normallashtirilganda) | 1 ta: 5 MM GIBRID [5-MM-GIBRID] ↔ 5 mm Gibrid Lenta [5MMGIBRID] |
| Hech qayerda ishlatilmagan mahsulot | 1 ta — arxiv nomzodi |
| **Kutilayotgan items soni** | **max 130 → Qop ip (−2) va Q4 qarorlariga qarab ~122–130** |

## A. 117 mahsulot tasnifi

Ustunlar: Raw? = xomashyo sifatida ham mavjud · Ishl.ch.? = BOM bor (qavsda: haqiqatda ishlab chiqarilgan miqdor) · Xarid? = xarid/qayta sotish NOMZODI (BOMsiz+savdoda degan dalildan; tizimda xarid tarixi yo'q, yakuniy belgini egasi tasdiqlaydi) · Sotiladi? (qavsda: haqiqatda sotilgan) · Oraliq? = intermediate (bugun tizimda yo'q — transformation obyekti bilan keladi) · Qoldiq = jami ombor qoldig'i · WIP = bo'limlardagi hajm.

| SKU | Nomi | Birlik | Raw? | Ishl.ch.? | Xarid? | Sotiladi? | Oraliq? | Faol BOM? | BOM soni | Qoldiq | Konteyner | WIP kg | Dublikat/o'xshash | Tavsiya |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 05BABINOQ | 0.5 babin / oq | dona | — | Ha | — | Ha (sot. 30) | — | Ha | 1 | 0 | — | — | — | 1:1 yangi item |
| 05BABINQORA | 0.5 Babin / Qora | dona | — | Ha | — | Ha (sot. 48) | — | Ha | 1 | 0 | — | — | — | 1:1 yangi item |
| QAZI05 | 0.5 Kg qazi ip | dona | — | Ha | — | Ha (sot. 48) | — | Ha | 1 | 0 | — | — | — | 1:1 yangi item |
| 20MTRRANG | 20 METR RANGLI ingichka | kg | — | Ha | — | Ha (sot. 92.4) | — | Ha | 2 | 0 | — | — | — | 1:1 yangi item |
| 5-MM-GIBRID | 5 MM GIBRID | kg | — | — | Ha | Ha | — | — | — | 0 | — | — | o'xshash (tekshirish): 5 mm Gibrid Lenta | 1:1 (Q4 tekshiruv: 5 mm Gibrid Lenta) |
| 5MMGIBRID | 5 mm Gibrid Lenta | kg | — | Ha | — | Ha (sot. 121.7) | — | Ha | 2 | **−52** | 1 joy | — | o'xshash (tekshirish): 5 MM GIBRID | 1:1 (Q4 tekshiruv: 5 MM GIBRID) |
| 5MMSHRQALIN | 5 mm -  Qalin Shakar | kg | — | Ha | — | Ha (sot. 81.55) | — | Ha | 1 | 0 | — | — | — | 1:1 yangi item |
| 5MMTULPOR | 5 mm Tulpor | kg | — | Ha | — | Ha (sot. 201.1) | — | Ha | 1 | 0 | — | — | — | 1:1 yangi item |
| 5MMYPSHR | 5 mm - Yupqa shakar | kg | — | Ha | — | Ha (sot. 139.9) | — | Ha | 1 | 0 | — | — | — | 1:1 yangi item |
| BABQO/05 | Babin Qora 0.5 mm | kg | **Ha** | Ha | — | Ha (sot. 600.1) | — | Ha | 1 | 0 | — | — | xomashyo katalogida ham bor | MERGE → xomashyo #11 bilan bitta item (qobiliyat bayroqlari — Q5) |
| BABSA/05 | Babin Sariq 0.5 mm | kg | **Ha** | Ha | — | Ha (sot. 402.6) | — | Ha | 1 | 0 | — | — | xomashyo katalogida ham bor | MERGE → xomashyo #10 bilan bitta item (qobiliyat bayroqlari — Q5) |
| BOYIN-ARZON | Bo’yin Arzon | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| BOYIN-QIMMAT | Bo’yin Qimmat | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| CRDMSH | Cord Maloshni | kg | **Ha** | Ha | — | Ha (sot. 300) | — | Ha | 1 | 0 | — | — | xomashyo katalogida ham bor | MERGE → xomashyo #7 bilan bitta item (qobiliyat bayroqlari — Q5) |
| DOR-IP-10-METR | Dor Ip 10 metr | kg | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| DOR-IP-20-METR | Dor ip 20 metr | kg | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| GILAM-TROS-KURTKA-TROS | Gilam tros kurtka tros | kg | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| DVAR/4KG | Ikki Qavat Arqon / 4 kg | kg | — | Ha (ishl. 829) | — | Ha (sot. 824.7) | — | Ha | 1 | 465 | 2 joy | 2 856.7 | — | 1:1 yangi item |
| DVAR/5KG | Ikki Qavat Arqon / 5 kg | kg | — | Ha (ishl. 882) | — | Ha (sot. 1 732.35) | — | Ha | 1 | **−346** | 2 joy | 3 236.4 | — | 1:1 yangi item |
| DVAR/6kg | Ikki Qavat Arqon / 6 kg | kg | — | Ha (ishl. 566) | — | Ha (sot. 911.95) | — | Ha | 1 | 50 | 2 joy | 2 565.9 | — | 1:1 yangi item |
| IKKIRANAR | Ikki Qavat Arqon Rangli | kg | — | Ha | — | Ha (sot. 26.7) | — | Ha | 1 | **−27** | 1 joy | — | — | 1:1 yangi item |
| IKKI-QAVAT-DVAYNOY-ARQON | Ikki Qavat Dvaynoy Arqon Oq | kg | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| Kanoblar | Kanob | kg | **Ha** | Ha | — | Ha (sot. 38.05) | — | Ha | 1 | 0 | — | — | xomashyo katalogida ham bor | MERGE → xomashyo #16 bilan bitta item (qobiliyat bayroqlari — Q5) |
| KPT50 | Kaptiva | kg | — | Ha | — | Ha (sot. 488.35) | — | Ha | 1 | 0 | — | — | — | 1:1 yangi item |
| KATTA-MEXANIZM-5T-LIK | Katta mexanizm 5T lik | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| KICHIK-MEXANIZ-5-T-LIK | Kichik mexaniz 5 T lik | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| KURCHONNI-1-KG | Kurchonni 1 kg | kg | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| KURTKA-6-7-KG | Kurtka 6-7 kg | kg | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| KURTKATROS | Kurtka Tros 2-3 kg | kg | — | Ha | — | Ha (sot. 95.65) | — | Ha | 1 | 0 | — | — | — | 1:1 yangi item |
| KURTKATROS45 | Kurtka Tros 4-5 kg | kg | — | Ha (ishl. 26) | — | Ha (sot. 199.35) | — | Ha | 1 | 26 | 1 joy | 151.9 | — | 1:1 yangi item |
| LEBYOTKA-3-TONNALIK | Lebyotka 3 tonnalik | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| LEBYOTKA-IKKITALIK-QORA | Lebyotka ikkitalik qora | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| LEBYOTKA-IKKITALIK-YASHI | Lebyotka ikkitalik yashil | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| LEBYOTKA-KICHIK-5-METRLI | Lebyotka kichik 5 metrli | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| LEBYOTKA-ODDIY-ARQONLI | Lebyotka Oddiy arqonli | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| LEBYOTKA-QORA-OZI-TORTAR | Lebyotka Qora O’zi Tortar Mexanizm | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| LESKA-100-GRAMM-100-METR | Leska 100 gramm 100 metr | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| LESKA-60-GRAMM-50-METR | Leska 60 gramm 50 metr | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| NOVINKA | Novinka | kg | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| NUXTA-ORTA-PUSHTI | Nuxta O’rta Pushti | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| NUXTA-QIZIL-KICHIK | Nuxta qizil kichik | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| NUXTA-QIZIL-ORTA | Nuxta qizil o’rta | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| NUXTA-RANGLI-KATTA | Nuxta Rangli Katta | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| NUXTA-SHAKAR-KATTA | Nuxta Shakar Katta | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| NUXTA-SHAKAR-KICHIK | Nuxta shakar kichik | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| POKAK | Po’kak | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| POKAK-KILOLI-5-KG | Po’kak Kiloli 5 kg | kg | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| PP2X1500 | Polipropilen Oq 2 x 1500 | kg | — | Ha | — | Ha (sot. 1 059.05) | — | Ha | 1 | 0 | — | — | — | 1:1 yangi item |
| ply144 | Polyamide 144 | kg | — | Ha | — | Ha (sot. 524.9) | — | Ha | 1 | **−931** | 1 joy | — | — | 1:1 yangi item |
| PLYCORD03 | Polyamide Cord 0.3mm | kg | — | — | Ha | Ha (sot. 205) | — | — | — | **−410** | 1 joy | — | — | 1:1 yangi item |
| PP2X15OQ | PP 2 X 1500 / OQ | kg | — | Ha | — | Ha (sot. 1 883) | — | Ha | 1 | **−1 883** | 1 joy | — | — | 1:1 yangi item |
| PP2X1500/QIZIL | PP 2 X 1500 / Qizil | kg | — | Ha | — | Ha (sot. 87.9) | — | Ha | 1 | **−88** | 1 joy | — | — | 1:1 yangi item |
| QOP-IP-100-TALIK | Qop ip 100 talik | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | dublikat: Qop Ip - 100 talik | Dublikat juftlik — egasi nomni tanlaydi (Q3) |
| QP100 | Qop Ip - 100 talik | dona | — | Ha (ishl. 3 000) | — | Ha (sot. 5 000) | — | Ha | 1 | 77 900 | 1 joy | — | dublikat: Qop ip 100 talik | Dublikat juftlik — egasi nomni tanlaydi (Q3) |
| QP120 | Qop ip - 120 talik | dona | — | Ha | — | Ha (sot. 2 400) | — | Ha | 1 | 9 240 | 1 joy | — | — | 1:1 yangi item |
| QOP-IP-800-GRAMM | Qop ip 800 gramm | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| QP80 | Qop ip - 80 talik | dona | — | Ha | — | Ha (sot. 2 000) | — | Ha | 1 | 3 040 | 1 joy | — | dublikat: Qop ip 80 talik | Dublikat juftlik — egasi nomni tanlaydi (Q3) |
| QOP-IP-80-TALIK | Qop ip 80 talik | dona | — | — | Ha | Ha (sot. 2 000) | — | — | — | 0 | — | — | dublikat: Qop ip - 80 talik | Dublikat juftlik — egasi nomni tanlaydi (Q3) |
| QOra | Qora Rang | kg | — | — | Ha | Ha (sot. 4) | — | — | — | **−4** | 1 joy | — | — | 1:1 yangi item |
| RANGLI-10-METR-STRUPA | Rangli 10 Metr Strupa | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| RANGLI-20-METR | Rangli 20 metr | kg | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| RANGLI-50-METR-TULPOR | Rangli 50 metr ( Tulpor) | kg | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| REELS | Reels | kg | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| RJ100OQ | Reja ip 100 gr / Oq | dona | — | Ha (ishl. 5 120) | — | — | — | Ha | 1 | 8 800 | 1 joy | — | — | 1:1 yangi item |
| RJ100QORA | Reja ip 100 gr / Qora | dona | — | Ha (ishl. 4 200) | — | Ha (sot. 1 600) | — | Ha | 1 | 10 200 | 1 joy | — | — | 1:1 yangi item |
| RJ100SARIQ | Reja ip 100 gr / Sariq | dona | — | Ha (ishl. 7 880) | — | Ha (sot. 1 600) | — | Ha | 1 | 12 680 | 1 joy | — | — | 1:1 yangi item |
| RJ30OQ | Reja ip 30 gr / OQ | dona | — | Ha (ishl. 7 600) | — | — | — | Ha | 1 | 12 400 | 1 joy | — | — | 1:1 yangi item |
| RJ30QORA | Reja ip 30 gr / Qora | dona | — | Ha | — | Ha (sot. 2 000) | — | Ha | 1 | 18 800 | 1 joy | — | — | 1:1 yangi item |
| RJ30SARIQ | Reja ip 30 gr / Sariq | dona | — | Ha (ishl. 17 600) | — | Ha (sot. 2 000) | — | Ha | 1 | 25 600 | 1 joy | — | — | 1:1 yangi item |
| RJ50OQ | Reja ip 50 gr / OQ | dona | — | Ha (ishl. 4 200) | — | — | — | Ha | 1 | 12 800 | 1 joy | — | — | 1:1 yangi item |
| RJ50QORA | Reja ip 50 gr / Qora | dona | — | Ha (ishl. 16 024) | — | Ha (sot. 4 000) | — | Ha | 1 | 23 800 | 1 joy | — | — | 1:1 yangi item |
| RJ50SARIQ | Reja ip 50 gr / Sariq | dona | — | Ha (ishl. 17 624) | — | Ha (sot. 4 000) | — | Ha | 1 | 22 400 | 1 joy | — | — | 1:1 yangi item |
| REPP115GR | Reja ip PP / 115 gr | dona | — | Ha | — | — | — | Ha | 1 | 0 | — | — | dublikat nomzodi: Reja ip PP 115 gramm | Dublikat nomzodi — egasi tasdiqlasa MERGE (Q4) |
| REJA-IP-PP-115-GRAMM | Reja ip PP 115 gramm | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | dublikat nomzodi: Reja ip PP / 115 gr | Dublikat nomzodi — egasi tasdiqlasa MERGE (Q4) |
| REPP40GR | Reja ip PP / 40 gr | dona | — | Ha | — | Ha (sot. 4 200) | — | Ha | 1 | 0 | — | — | — | 1:1 yangi item |
| REPP50GR | Reja ip PP / 50 gr | dona | — | Ha (ishl. 100) | — | — | — | Ha | 1 | 100 | 1 joy | — | dublikat nomzodi: Reja ip PP 50 gramm | Dublikat nomzodi — egasi tasdiqlasa MERGE (Q4) |
| REJA-IP-PP-50-GRAMM | Reja ip PP 50 gramm | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | dublikat nomzodi: Reja ip PP / 50 gr | Dublikat nomzodi — egasi tasdiqlasa MERGE (Q4) |
| REPP60GR | Reja ip PP / 60 gr | dona | — | Ha | — | Ha (sot. 1 200) | — | Ha | 1 | 0 | — | — | — | 1:1 yangi item |
| REPP80GR | Reja ip PP / 80 gr | dona | — | — | Ha | Ha (sot. 1 200) | — | — | — | 0 | — | — | dublikat nomzodi: Reja ip PP 80 gramm | Dublikat nomzodi — egasi tasdiqlasa MERGE (Q4) |
| REJA-IP-PP-80-GRAMM | Reja ip PP 80 gramm | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | dublikat nomzodi: Reja ip PP / 80 gr | Dublikat nomzodi — egasi tasdiqlasa MERGE (Q4) |
| REJA-IP-SAPOJNIY-100-GRA | Reja ip Sapojniy 100 gramm | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| REJA-IP-SAPOJNIY-30-GRAM | Reja ip Sapojniy 30 gramm | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| REJA-IP-SAPOJNIY-50-GRAM | Reja ip Sapojniy 50 gramm | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| ROSSIYATROS | Rossiya Tros | kg | — | Ha | — | Ha (sot. 136) | — | Ha | 1 | 0 | — | — | — | 1:1 yangi item |
| SLFSTR | Salafan Strupa | kg | — | Ha | — | Ha (sot. 217.25) | — | Ha | 2 | 0 | — | — | — | 1:1 yangi item |
| SHAKAR | Shakar | kg | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| SHKR/18/85 | Shakar 1.5 kg | kg | — | Ha | — | Ha (sot. 371.3) | — | Ha | 1 | 0 | — | — | — | 1:1 yangi item |
| SHKR28 | Shakar 2.8 | kg | — | Ha | — | Ha (sot. 277.7) | — | Ha | 1 | 0 | — | — | — | 1:1 yangi item |
| SHFDY/KOK | Shlanka FDY/ Ko'k | dona | — | Ha | — | Ha (sot. 120.2) | — | Ha | 1 | **−32** | 1 joy | — | — | 1:1 yangi item |
| SHFDY/OQ | Shlanka FDY / OQ | dona | — | Ha | — | Ha (sot. 595.05) | — | Ha | 1 | **−104** | 1 joy | — | — | 1:1 yangi item |
| SHFDY/QIZIL | Shlanka FDY / QIzil | dona | — | Ha | — | Ha (sot. 176.65) | — | Ha | 1 | **−32** | 1 joy | — | — | 1:1 yangi item |
| SHFDY/QORA | Shlanka FDY / Qora | dona | — | Ha | — | Ha (sot. 16) | — | Ha | 1 | **−16** | 1 joy | — | — | 1:1 yangi item |
| SHFDY/YASHIL | Shlanka FDY/Yashil | dona | — | Ha | — | Ha (sot. 124.9) | — | Ha | 1 | **−32** | 1 joy | — | — | 1:1 yangi item |
| SHLANKA-PARASHUT-50-METR | Shlanka Parashut 50 metr | kg | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| SHLPOLYD | Shlanka Polyamide | dona | — | Ha | — | Ha (sot. 40) | — | Ha | 1 | 0 | — | — | — | 1:1 yangi item |
| SHLPP/OQ | Shlanka PP / Oq | kg | — | Ha | — | Ha (sot. 1 166.65) | — | Ha | 1 | **−798** | 1 joy | — | — | 1:1 yangi item |
| SHLPP/RANGli | Shlanka PP / Rangli | kg | — | Ha | — | Ha (sot. 105.9) | — | Ha | 1 | **−68** | 1 joy | — | — | 1:1 yangi item |
| SHOLCHAOQUZUN | Sholcha Oq | kg | — | Ha | — | — | — | Ha | 1 | 47 000 | 2 joy ⚠ raw omborda | — | Sholcha oilasi | Ochiq — Sholcha oilasi qarori (Q1) |
| SHOLCHASARIQKALTA | Sholcha Sariq | kg | — | Ha | — | — | — | Ha | 1 | 60 000 | 3 joy ⚠ raw omborda | — | Sholcha oilasi | Ochiq — Sholcha oilasi qarori (Q1) |
| shrk35 | Shroki 3.5 | kg | — | Ha | — | Ha (sot. 125) | — | Ha | 1 | **−125** | 1 joy | — | o'xshash (tekshirish): Shroki 3.5 Oq | 1:1 (Q4 tekshiruv: Shroki 3.5 Oq) |
| SHROKI-3-5-OQ | Shroki 3.5 Oq | kg | — | — | Ha | Ha | — | — | — | 0 | — | — | o'xshash (tekshirish): Shroki 3.5 | 1:1 (Q4 tekshiruv: Shroki 3.5) |
| STRUPA-OQ-100-METR | Strupa Oq 100 metr | kg | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| ST70M | Strupa Sari | kg | — | Ha | — | Ha (sot. 12.55) | — | Ha | 1 | **−13** | 1 joy | — | dublikat nomzodi: Strupa Sariq | Dublikat nomzodi — egasi tasdiqlasa MERGE (Q4) |
| STRUPA-SARIQ | Strupa Sariq | kg | — | — | Ha | Ha | — | — | — | 0 | — | — | dublikat nomzodi: Strupa Sari | Dublikat nomzodi — egasi tasdiqlasa MERGE (Q4) |
| th50 | Tahoe 50 m | kg | — | — | — | — | — | — | — | 0 | — | — | — | Arxiv nomzodi (hech qayerda ishlatilmagan) |
| TAROQ-BRITVA | Taroq Britva | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| TAROQ-PANSHAXA | Taroq Panshaxa | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| TAROQ-PERCHATKA | Taroq Perchatka | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| TAROQ-YUMALOQ-4-TALIK | Taroq Yumaloq 4 talik | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| TAROQ-YUMALOQ-5-TALIK | Taroq Yumaloq 5 talik | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| TAROQ-YUMALOQ-6-TALIK | Taroq Yumaloq 6 talik | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| TORTPOLYD | Tortqi Polyamide | dona | — | Ha | — | Ha (sot. 181.25) | — | Ha | 1 | **−50** | 1 joy | — | — | 1:1 yangi item |
| TULPOR | Tulpor | kg | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| TUP80 | Tulpor 80 metr | kg | — | Ha | — | Ha (sot. 157.3) | — | Ha | 1 | 0 | — | — | — | 1:1 yangi item |
| TULPOR-NUXTA | Tulpor Nuxta | dona | — | — | Ha | Ha | — | — | — | 0 | — | — | — | 1:1 yangi item |
| TLPRANG80 | Tulpor Rangli 80 metr | kg | — | Ha | — | Ha (sot. 94.7) | — | Ha | 1 | 0 | — | — | — | 1:1 yangi item |
| ZUBRL | Zubr Lenta | kg | — | Ha | — | Ha (sot. 67.85) | — | Ha | 1 | 0 | — | — | — | 1:1 yangi item |

**Izohlar:** "Faol BOM" — tizimda BOM'ning aktiv/noaktiv belgisi yo'q, mavjudligi faol deb qabul qilindi. 18 mahsulotda jami ombor qoldig'i manfiy (qalin) — P3 inventarizatsiyasida yopiladi. 4 dual mahsulotning "Ishl.ch.? Ha" belgisi o'z-o'ziga 1:1 BOM'dan kelgan (D bo'limga qarang) — real ishlab chiqarish emas. "Xarid?" ustuni dalil asosidagi NOMZOD — hozirgi tizim BOMsiz partiyani ham o'tkazib yuborgani uchun (audit C.16) bu tasnif faqat egasi tasdig'i bilan yakunlanadi. "Shakar"/"Tulpor" kabi oila variantlari (o'lcham/turi farqli) alohida SKU bo'lib qoladi — ular dublikat EMAS.

## B. 17 xomashyo

| ID | Nomi | Valyuta | Global qoldiq | Konteyner qoldiq | WIP | BOM'da | Sotiladimi | Transformatsiyada | Dublikat | Tavsiya |
|---|---|---|---|---|---|---|---|---|---|---|
| 11 | Babin Qora 0.5 mm | USD | **−1 018.96** kg | 0 | 0 | Ha (4 mahsulot) | Nusxa orqali (1 sotuv) | Yoʻq (obyekt yoʻq) | products katalogida ham bor | MERGE → product 'Babin Qora 0.5 mm' bilan bitta item |
| 19 | Babin Sariq 0.4 | USD | 5 000 kg | 0 | 0 | Ha (1 mahsulot) | Yoʻq | Yoʻq (obyekt yoʻq) | — | Qoldiq harakatsiz kiritilgan (forma) — inventarizatsiyada tasdiqlash |
| 10 | Babin Sariq 0.5 mm | USD | **−1 844.96** kg | 0 | 0 | Ha (5 mahsulot) | Nusxa orqali (1 sotuv) | Yoʻq (obyekt yoʻq) | products katalogida ham bor | MERGE → product 'Babin Sariq 0.5 mm' bilan bitta item |
| 7 | Cord Maloshni | USD | 0 kg | 0 | 0 | Ha (2 mahsulot) | Nusxa orqali (1 sotuv) | Yoʻq (obyekt yoʻq) | products katalogida ham bor | MERGE → product 'Cord Maloshni' bilan bitta item |
| 6 | FDY YARN | USD | 0 kg | 0 | 0 | Ha (5 mahsulot) | Yoʻq | Yoʻq (obyekt yoʻq) | — | 1:1 yangi item |
| 16 | Kanob | USD | 0 kg | 0 | 0 | Ha (1 mahsulot) | Nusxa orqali (1 sotuv) | Yoʻq (obyekt yoʻq) | products katalogida ham bor | MERGE → product 'Kanob' bilan bitta item |
| 5 | Polipropilen 2 x 1500 / OQ | USD | **−12 092.3** kg | 0 | 0 | Ha (11 mahsulot) | Yoʻq | Yoʻq (obyekt yoʻq) | — | Manfiy — E-trail; inventarizatsiya kuni yopiladi (Q2) |
| 9 | Polipropilen 2 x 1500 / rangli | USD | 0 kg | 0 | 0 | Ha (2 mahsulot) | Yoʻq | Yoʻq (obyekt yoʻq) | — | 1:1 yangi item |
| 2 | Polipropilen BSF | USD | **−117** kg | 0 | 0 | Ha (8 mahsulot) | Yoʻq | Yoʻq (obyekt yoʻq) | — | Manfiy — E-trail; inventarizatsiya kuni yopiladi (Q2) |
| 1 | Polipropilen ip | UZS | 0 kg | 0 | 0 | — | Yoʻq | Yoʻq (obyekt yoʻq) | — | Ishlatilmagan — arxiv nomzodi |
| 15 | Polyamide | USD | 0 kg | 0 | 0 | Ha (5 mahsulot) | Yoʻq | Yoʻq (obyekt yoʻq) | — | 1:1 yangi item |
| 12 | PP Xom oq | USD | 0 kg | 0 | 0 | Ha (5 mahsulot) | Yoʻq | Yoʻq (obyekt yoʻq) | — | 1:1 yangi item |
| 13 | pp xom rangli | USD | 0 kg | 0 | 0 | Ha (5 mahsulot) | Yoʻq | Yoʻq (obyekt yoʻq) | — | 1:1 yangi item |
| 17 | Qazi ip | UZS | 0 kg | 0 | 0 | Ha (1 mahsulot) | Yoʻq | Yoʻq (obyekt yoʻq) | — | 1:1 yangi item |
| 3 | Qop ip | USD | **−255** kg | 0 | 0 | Ha (3 mahsulot) | Yoʻq | Yoʻq (obyekt yoʻq) | — | Manfiy — E-trail; inventarizatsiya kuni yopiladi (Q2) |
| 18 | Salafan | UZS | 0 kg | 0 | 0 | Ha (1 mahsulot) | Yoʻq | Yoʻq (obyekt yoʻq) | — | 1:1 yangi item |
| 8 | Sholcha | USD | 25 000 kg | 25 000 kg (1 joy) | 0 | Ha (3 mahsulot) | Yoʻq | Yoʻq (obyekt yoʻq) | — | Ochiq — Sholcha oilasi qarori (Q1) |

**Izoh:** WIP ustuni hamma uchun 0 — chunki "Bo'limga berish" (RECEIVE) hech qachon ishlatilmagan; bo'limlar hisobiga material rasman kirmagan.

## C. 62 BOM qatori — SKU'ga ko'chirish xavfsizligi

| # | Mahsulot | SKU (product id) | Material | Miqdor | Mahsulot birligi | SKU'ga o'tish | Konflikt/izoh |
|---|---|---|---|---|---|---|---|
| 1 | 0.5 babin / oq | 05BABINOQ (id 64) | Polyamide (#15) | 0.4 kg | dona | Xavfsiz ✓ | — |
| 2 | 0.5 Babin / Qora | 05BABINQORA (id 65) | Babin Sariq 0.5 mm (#10) | 0.4 kg | dona | Xavfsiz ✓ | ⚠ rang mos emas — tekshirish kerak |
| 3 | 0.5 Kg qazi ip | QAZI05 (id 63) | Qazi ip (#17) | 0.4 kg | dona | Xavfsiz ✓ | — |
| 4 | 20 METR RANGLI ingichka | 20MTRRANG (id 31) | Polipropilen 2 x 1500 / rangli (#9) | 0.6 kg | kg | Xavfsiz ✓ | — |
| 5 | 20 METR RANGLI ingichka | 20MTRRANG (id 31) | Sholcha (#8) | 0.6 kg | kg | Xavfsiz ✓ | — |
| 6 | 5 mm Gibrid Lenta | 5MMGIBRID (id 49) | Polipropilen BSF (#2) | 1.6 kg | kg | Xavfsiz ✓ | — |
| 7 | 5 mm Gibrid Lenta | 5MMGIBRID (id 49) | pp xom rangli (#13) | 1.7 kg | kg | Xavfsiz ✓ | — |
| 8 | 5 mm -  Qalin Shakar | 5MMSHRQALIN (id 38) | Polipropilen BSF (#2) | 2.8 kg | kg | Xavfsiz ✓ | — |
| 9 | 5 mm Tulpor | 5MMTULPOR (id 50) | pp xom rangli (#13) | 4 kg | kg | Xavfsiz ✓ | — |
| 10 | 5 mm - Yupqa shakar | 5MMYPSHR (id 39) | Polipropilen BSF (#2) | 2.8 kg | kg | Xavfsiz ✓ | — |
| 11 | Babin Qora 0.5 mm | BABQO/05 (id 33) | Babin Qora 0.5 mm (#11) | 1 kg | kg | Xavfsiz ✓ | ⚠ o'z-o'ziga BOM 1:1 (dual ko'prik) — merge'da olib tashlanadi (Q5) |
| 12 | Babin Sariq 0.5 mm | BABSA/05 (id 32) | Babin Sariq 0.5 mm (#10) | 1 kg | kg | Xavfsiz ✓ | ⚠ o'z-o'ziga BOM 1:1 (dual ko'prik) — merge'da olib tashlanadi (Q5) |
| 13 | Cord Maloshni | CRDMSH (id 14) | Cord Maloshni (#7) | 1 kg | kg | Xavfsiz ✓ | ⚠ o'z-o'ziga BOM 1:1 (dual ko'prik) — merge'da olib tashlanadi (Q5) |
| 14 | Ikki Qavat Arqon / 4 kg | DVAR/4KG (id 26) | Polipropilen 2 x 1500 / OQ (#5) | 4 kg | kg | Xavfsiz ✓ | — |
| 15 | Ikki Qavat Arqon / 5 kg | DVAR/5KG (id 27) | Polipropilen 2 x 1500 / OQ (#5) | 5 kg | kg | Xavfsiz ✓ | — |
| 16 | Ikki Qavat Arqon / 6 kg | DVAR/6kg (id 28) | Polipropilen 2 x 1500 / OQ (#5) | 6 kg | kg | Xavfsiz ✓ | — |
| 17 | Ikki Qavat Arqon Rangli | IKKIRANAR (id 74) | Polipropilen 2 x 1500 / rangli (#9) | 1 kg | kg | Xavfsiz ✓ | — |
| 18 | Kanob | Kanoblar (id 47) | Kanob (#16) | 1 kg | kg | Xavfsiz ✓ | ⚠ o'z-o'ziga BOM 1:1 (dual ko'prik) — merge'da olib tashlanadi (Q5) |
| 19 | Kaptiva | KPT50 (id 30) | Polipropilen BSF (#2) | 2.8 kg | kg | Xavfsiz ✓ | — |
| 20 | Kurtka Tros 2-3 kg | KURTKATROS (id 44) | Polipropilen BSF (#2) | 2.5 kg | kg | Xavfsiz ✓ | — |
| 21 | Kurtka Tros 4-5 kg | KURTKATROS45 (id 45) | Polipropilen BSF (#2) | 4.5 kg | kg | Xavfsiz ✓ | — |
| 22 | Polipropilen Oq 2 x 1500 | PP2X1500 (id 34) | Polipropilen 2 x 1500 / OQ (#5) | 1 kg | kg | Xavfsiz ✓ | — |
| 23 | Polyamide 144 | ply144 (id 76) | Polyamide (#15) | 1 kg | kg | Xavfsiz ✓ | — |
| 24 | PP 2 X 1500 / OQ | PP2X15OQ (id 72) | PP Xom oq (#12) | 1 kg | kg | Xavfsiz ✓ | — |
| 25 | PP 2 X 1500 / Qizil | PP2X1500/QIZIL (id 73) | pp xom rangli (#13) | 1 kg | kg | Xavfsiz ✓ | — |
| 26 | Qop Ip - 100 talik | QP100 (id 60) | Qop ip (#3) | 0.09 kg | dona | Xavfsiz ✓ | dublikat mahsulot (Qop ip 100 talik) |
| 27 | Qop ip - 120 talik | QP120 (id 61) | Qop ip (#3) | 0.08 kg | dona | Xavfsiz ✓ | — |
| 28 | Qop ip - 80 talik | QP80 (id 62) | Qop ip (#3) | 0.13 kg | dona | Xavfsiz ✓ | dublikat mahsulot (Qop ip 80 talik) |
| 29 | Reja ip 100 gr / Oq | RJ100OQ (id 51) | Polipropilen 2 x 1500 / OQ (#5) | 0.09 kg | dona | Xavfsiz ✓ | — |
| 30 | Reja ip 100 gr / Qora | RJ100QORA (id 52) | Babin Qora 0.5 mm (#11) | 0.09 kg | dona | Xavfsiz ✓ | — |
| 31 | Reja ip 100 gr / Sariq | RJ100SARIQ (id 53) | Babin Sariq 0.5 mm (#10) | 0.1 kg | dona | Xavfsiz ✓ | — |
| 32 | Reja ip 30 gr / OQ | RJ30OQ (id 59) | Polipropilen 2 x 1500 / OQ (#5) | 0.02 kg | dona | Xavfsiz ✓ | — |
| 33 | Reja ip 30 gr / Qora | RJ30QORA (id 58) | Babin Qora 0.5 mm (#11) | 0.02 kg | dona | Xavfsiz ✓ | — |
| 34 | Reja ip 30 gr / Sariq | RJ30SARIQ (id 57) | Babin Sariq 0.5 mm (#10) | 0.02 kg | dona | Xavfsiz ✓ | — |
| 35 | Reja ip 50 gr / OQ | RJ50OQ (id 56) | Polipropilen 2 x 1500 / OQ (#5) | 0.05 kg | dona | Xavfsiz ✓ | — |
| 36 | Reja ip 50 gr / Qora | RJ50QORA (id 54) | Babin Qora 0.5 mm (#11) | 0.04 kg | dona | Xavfsiz ✓ | — |
| 37 | Reja ip 50 gr / Sariq | RJ50SARIQ (id 55) | Babin Sariq 0.5 mm (#10) | 0.04 kg | dona | Xavfsiz ✓ | — |
| 38 | Reja ip PP / 115 gr | REPP115GR (id 25) | Polipropilen 2 x 1500 / OQ (#5) | 0.1 kg | dona | Xavfsiz ✓ | — |
| 39 | Reja ip PP / 40 gr | REPP40GR (id 21) | Polipropilen 2 x 1500 / OQ (#5) | 0.03 kg | dona | Xavfsiz ✓ | — |
| 40 | Reja ip PP / 50 gr | REPP50GR (id 22) | Polipropilen 2 x 1500 / OQ (#5) | 0.04 kg | dona | Xavfsiz ✓ | — |
| 41 | Reja ip PP / 60 gr | REPP60GR (id 23) | Polipropilen 2 x 1500 / OQ (#5) | 0.05 kg | dona | Xavfsiz ✓ | — |
| 42 | Rossiya Tros | ROSSIYATROS (id 46) | Polyamide (#15) | 1 kg | kg | Xavfsiz ✓ | — |
| 43 | Salafan Strupa | SLFSTR (id 66) | PP Xom oq (#12) | 0.5 kg | kg | Xavfsiz ✓ | — |
| 44 | Salafan Strupa | SLFSTR (id 66) | Salafan (#18) | 0.5 kg | kg | Xavfsiz ✓ | — |
| 45 | Shakar 1.5 kg | SHKR/18/85 (id 29) | Cord Maloshni (#7) | 1.6 kg | kg | Xavfsiz ✓ | — |
| 46 | Shakar 2.8 | SHKR28 (id 35) | Polipropilen BSF (#2) | 2.8 kg | kg | Xavfsiz ✓ | — |
| 47 | Shlanka FDY/ Ko'k | SHFDY/KOK (id 17) | FDY YARN (#6) | 3.5 kg | dona | Xavfsiz ✓ | — |
| 48 | Shlanka FDY / OQ | SHFDY/OQ (id 15) | FDY YARN (#6) | 3.5 kg | dona | Xavfsiz ✓ | — |
| 49 | Shlanka FDY / QIzil | SHFDY/QIZIL (id 18) | FDY YARN (#6) | 3.5 kg | dona | Xavfsiz ✓ | — |
| 50 | Shlanka FDY / Qora | SHFDY/QORA (id 19) | FDY YARN (#6) | 3.5 kg | dona | Xavfsiz ✓ | — |
| 51 | Shlanka FDY/Yashil | SHFDY/YASHIL (id 16) | FDY YARN (#6) | 3.5 kg | dona | Xavfsiz ✓ | — |
| 52 | Shlanka Polyamide | SHLPOLYD (id 41) | Polyamide (#15) | 3.3 kg | dona | Xavfsiz ✓ | — |
| 53 | Shlanka PP / Oq | SHLPP/OQ (id 42) | PP Xom oq (#12) | 3.2 kg | kg | Xavfsiz ✓ | — |
| 54 | Shlanka PP / Rangli | SHLPP/RANGli (id 43) | pp xom rangli (#13) | 3.2 kg | kg | Xavfsiz ✓ | — |
| 55 | Sholcha Oq | SHOLCHAOQUZUN (id 69) | Sholcha (#8) | 1 kg | kg | Xavfsiz ✓ | Sholcha oilasi (Q1) |
| 56 | Sholcha Sariq | SHOLCHASARIQKALTA (id 70) | Sholcha (#8) | 1 kg | kg | Xavfsiz ✓ | Sholcha oilasi (Q1) |
| 57 | Shroki 3.5 | shrk35 (id 71) | Polipropilen BSF (#2) | 2.2 kg | kg | Xavfsiz ✓ | — |
| 58 | Strupa Sari | ST70M (id 75) | Babin Sariq 0.4 (#19) | 1 kg | kg | Xavfsiz ✓ | — |
| 59 | Tortqi Polyamide | TORTPOLYD (id 48) | Polyamide (#15) | 3.3 kg | dona | Xavfsiz ✓ | — |
| 60 | Tulpor 80 metr | TUP80 (id 36) | PP Xom oq (#12) | 3 kg | kg | Xavfsiz ✓ | — |
| 61 | Tulpor Rangli 80 metr | TLPRANG80 (id 37) | pp xom rangli (#13) | 3 kg | kg | Xavfsiz ✓ | — |
| 62 | Zubr Lenta | ZUBRL (id 40) | PP Xom oq (#12) | 2.2 kg | kg | Xavfsiz ✓ | — |

**Xulosa:** 62/62 qatorda mahsulot katalogda bor va SKU'ga ega — texnik jihatdan hammasi xavfsiz ko'chadi. 9 qatorda e'tibor talab qiluvchi izoh bor (yuqorida ⚠ bilan).

## D. 4 dual material — reconciliation hisoboti

| Ko'rsatkich | Cord Maloshni | Babin Sariq 0.5 mm | Babin Qora 0.5 mm | Kanob |
|---|---|---|---|---|
| Product SKU | CRDMSH | BABSA/05 | BABQO/05 | Kanoblar |
| Xomashyo ID | #7 | #10 | #11 | #16 |
| Xomashyo global qoldiq (kg) | 0 | **−1 844.96** | **−1 018.96** | 0 |
| BOMʻda ishlatiladi | 2 mahsulotda | 5 mahsulotda | 4 mahsulotda | 1 mahsulotda |
| Product tomonda ombor qoldigʻi | 0 (0 qator) | 0 (0 qator) | 0 (0 qator) | 0 (0 qator) |
| Product tomonda partiya | 0 | 0 | 0 | 0 |
| Sotilgan (kg) | 300 (1 sotuv) | 402.6 (1 sotuv) | 600.1 (1 sotuv) | 38.05 (1 sotuv) |
| Product tomonda ombor harakati | 0 ta | 0 ta | 0 ta | 0 ta |
| in_sales hozir | Oʻchirilgan | Oʻchirilgan | Oʻchirilgan | Oʻchirilgan |

*Izoh: "BOM'da ishlatiladi" soniga o'z-o'ziga (self) BOM ham kiradi — Kanob xomashyosi FAQAT o'z nusxasining BOM'ida turibdi, boshqa retseptlarda yo'q.*

**Tahlil:** to'rttalasida ham product tomoni deyarli bo'sh — ombor yozuvi 0, partiya 0, harakat 0, faqat **bittadan sotuv** bor (jami 4 qator sotuv tarixi). Ya'ni nusxalar faqat "sotish tugmasi" uchun ochilgan, sotuv omborga umuman tegmagan (qoldiqsiz o'tgan). Xomashyo tomonida esa jonli BOM iste'moli bor.

**MERGE rejasi (tasdiqdan keyin, P2'da):** har juftlik → bitta item (is_raw + is_saleable; is_purchased — Q5). MUHIM: to'rttala mahsulotning BOM'i **o'z-o'ziga 1:1** (masalan "Babin Qora 0.5 mm" mahsuloti 1 kg "Babin Qora 0.5 mm" xomashyosini "iste'mol qiladi") — bu real retsept emas, sotish uchun ochilgan nusxaning texnik ko'prigi. Merge'dan keyin bunday BOM "item o'z-o'zini iste'mol qiladi" degan ma'nosiz holatga aylanadi, shuning uchun 4 ta self-BOM qatori migratsiya qilinmaydi — olib tashlash Q5'da tasdiqlanadi. is_manufactured belgisi KERAK EMAS (real partiya 0 ta). Tarix ko'chirishi minimal: 4 ta sale_items qatoriga item_id beriladi, xomashyo harakatlari o'z-o'zidan bog'lanadi. Xavf: past. Diqqat: Kanob'ning SKU'si "Kanoblar" — SKU emas, so'zga o'xshaydi; items'ga o'tishda toza SKU berish tavsiya etiladi (Q5).

## E. 5 manfiy xomashyo — tranzaksiya izi (hech narsa TUZATILMADI)

Umumiy xulosa: **beshalasida ham sabab bir xil — birorta XARID (kirim) hech qachon kiritilmagan**, barcha chiqimlar partiya (BOM) ayirmalari bo'lib, har biri izoh bilan aniq partiyaga bog'lanadi ("Ishlab chiqarish: KOD (Mahsulot × soni)"). Polipropilen 2×1500/OQ'da qo'shimcha **144 kg harakat yozuvisiz ayirma** bor — hozirgi harakat daftaridan tiklab BO'LMAYDI (hozirgi forma/adjust kodi har o'zgarishga harakat yozadi; demak bu farq eski kod davrida yoki daftardan tashqari yo'l bilan kiritilgan). Inventarizatsiyada shu 144 kg ham hisobga olinadi.

### Babin Qora 0.5 mm — global qoldiq **−1 018.96 kg**

| Ko'rsatkich | Qiymat |
|---|---|
| Kirim (IN) harakatlari | 0 kg (birorta xarid kiritilmagan) |
| Chiqim (OUT) harakatlari | 1 018.96 kg |
| BOM bo'yicha kutilgan iste'mol | 1 019 kg (23 partiya, 2026-06-24 → 2026-08-13) |
| Harakatlar bo'yicha hisob (IN−OUT) | −1 018.96 kg |
| Joriy qoldiq va harakatlar farqi | 0 — toʻliq izlanadi ✓ |

Oylik taqsimot:

| Oy | Turi | Soni | Hajm |
|---|---|---|---|
| 2026-06 | OUT | 2 | 49 kg |
| 2026-07 | OUT | 13 | 536 kg |
| 2026-08 | OUT | 8 | 434 kg |

### Babin Sariq 0.5 mm — global qoldiq **−1 844.96 kg**

| Ko'rsatkich | Qiymat |
|---|---|
| Kirim (IN) harakatlari | 0 kg (birorta xarid kiritilmagan) |
| Chiqim (OUT) harakatlari | 1 844.96 kg |
| BOM bo'yicha kutilgan iste'mol | 1 845 kg (36 partiya, 2026-06-24 → 2026-08-13) |
| Harakatlar bo'yicha hisob (IN−OUT) | −1 844.96 kg |
| Joriy qoldiq va harakatlar farqi | 0 — toʻliq izlanadi ✓ |

Oylik taqsimot:

| Oy | Turi | Soni | Hajm |
|---|---|---|---|
| 2026-06 | OUT | 7 | 289 kg |
| 2026-07 | OUT | 17 | 744 kg |
| 2026-08 | OUT | 12 | 812 kg |

### Polipropilen 2 x 1500 / OQ — global qoldiq **−12 092.3 kg**

| Ko'rsatkich | Qiymat |
|---|---|
| Kirim (IN) harakatlari | 0 kg (birorta xarid kiritilmagan) |
| Chiqim (OUT) harakatlari | 11 948.3 kg |
| BOM bo'yicha kutilgan iste'mol | 11 948.3 kg (211 partiya, 2026-06-25 → 2026-08-13) |
| Harakatlar bo'yicha hisob (IN−OUT) | −11 948.3 kg |
| Joriy qoldiq va harakatlar farqi | **−144 kg — harakat yozuvisiz oʻzgargan (hozirgi daftardan tiklab boʻlmaydi, ehtimol eski kod davri) ⚠** |

Oylik taqsimot:

| Oy | Turi | Soni | Hajm |
|---|---|---|---|
| 2026-06 | OUT | 37 | 2 462 kg |
| 2026-07 | OUT | 146 | 7 912.3 kg |
| 2026-08 | OUT | 28 | 1 574 kg |

### Polipropilen BSF — global qoldiq **−117 kg**

| Ko'rsatkich | Qiymat |
|---|---|
| Kirim (IN) harakatlari | 0 kg (birorta xarid kiritilmagan) |
| Chiqim (OUT) harakatlari | 117 kg |
| BOM bo'yicha kutilgan iste'mol | 117 kg (3 partiya, 2026-07-25 → 2026-07-25) |
| Harakatlar bo'yicha hisob (IN−OUT) | −117 kg |
| Joriy qoldiq va harakatlar farqi | 0 — toʻliq izlanadi ✓ |

Oylik taqsimot:

| Oy | Turi | Soni | Hajm |
|---|---|---|---|
| 2026-07 | OUT | 3 | 117 kg |

### Qop ip — global qoldiq **−255 kg**

| Ko'rsatkich | Qiymat |
|---|---|
| Kirim (IN) harakatlari | 0 kg (birorta xarid kiritilmagan) |
| Chiqim (OUT) harakatlari | 255 kg |
| BOM bo'yicha kutilgan iste'mol | 255 kg (1 partiya, 2026-06-24 → 2026-06-24) |
| Harakatlar bo'yicha hisob (IN−OUT) | −255 kg |
| Joriy qoldiq va harakatlar farqi | 0 — toʻliq izlanadi ✓ |

Oylik taqsimot:

| Oy | Turi | Soni | Hajm |
|---|---|---|---|
| 2026-06 | OUT | 1 | 255 kg |


**Namuna yozuvlar (har materialning eng birinchi va oxirgi harakatlari):**

| Material | Sana | Turi | Miqdor | Izoh | Kim |
|---|---|---|---|---|---|
| Babin Qora 0.5 mm | 2026-06-24 | OUT | 0.96 | Ishlab chiqarish: RI-260624-01 (Reja ip 50 gr / Qora × 24) | Risolat |
| Babin Qora 0.5 mm | 2026-06-25 | OUT | 48 | Ishlab chiqarish: RI-260625-01 (Reja ip 50 gr / Qora × 1200) | Risolat |
| Babin Qora 0.5 mm | 2026-07-01 | OUT | 32 | Ishlab chiqarish: RI-260701-01 (Reja ip 50 gr / Qora × 800) | Risolat |
| Babin Qora 0.5 mm | 2026-08-11 | OUT | 40 | Ishlab chiqarish: RI-260811-03 (Reja ip 50 gr / Qora × 1000) | Risolat |
| Babin Qora 0.5 mm | 2026-08-12 | OUT | 40 | Ishlab chiqarish: RI-260812-01 (Reja ip 50 gr / Qora × 1000) | Risolat |
| Babin Qora 0.5 mm | 2026-08-13 | OUT | 40 | Ishlab chiqarish: RI-260813-01 (Reja ip 50 gr / Qora × 1000) | Risolat |
| Babin Sariq 0.5 mm | 2026-06-24 | OUT | 0.96 | Ishlab chiqarish: RI-260624-01 (Reja ip 50 gr / Sariq × 24) | Risolat |
| Babin Sariq 0.5 mm | 2026-06-25 | OUT | 56 | Ishlab chiqarish: RI-260625-01 (Reja ip 50 gr / Sariq × 1400) | Risolat |
| Babin Sariq 0.5 mm | 2026-06-26 | OUT | 40 | Ishlab chiqarish: RI-260626-01 (Reja ip 30 gr / Sariq × 2000) | Risolat |
| Babin Sariq 0.5 mm | 2026-08-11 | OUT | 24 | Ishlab chiqarish: RI-260811-03 (Reja ip 50 gr / Sariq × 600) | Risolat |
| Babin Sariq 0.5 mm | 2026-08-12 | OUT | 40 | Ishlab chiqarish: RI-260812-01 (Reja ip 50 gr / Sariq × 1000) | Risolat |
| Babin Sariq 0.5 mm | 2026-08-13 | OUT | 40 | Ishlab chiqarish: RI-260813-01 (Reja ip 50 gr / Sariq × 1000) | Risolat |
| Polipropilen 2 x 1500 / OQ | 2026-06-25 | OUT | 92 | Ishlab chiqarish: AZ-260625-01 (Ikki Qavat Arqon / 4 kg × 23) | Aziza |
| Polipropilen 2 x 1500 / OQ | 2026-06-25 | OUT | 95 | Ishlab chiqarish: AZ-260625-02 (Ikki Qavat Arqon / 5 kg × 19) | Aziza |
| Polipropilen 2 x 1500 / OQ | 2026-06-25 | OUT | 120 | Ishlab chiqarish: AZ-260625-03 (Ikki Qavat Arqon / 6 kg × 20) | Aziza |
| Polipropilen 2 x 1500 / OQ | 2026-08-13 | OUT | 84 | Ishlab chiqarish: GL-260813-01 (Ikki Qavat Arqon / 4 kg × 21) | Gullola |
| Polipropilen 2 x 1500 / OQ | 2026-08-13 | OUT | 25 | Ishlab chiqarish: HU-260813-01 (Ikki Qavat Arqon / 5 kg × 5) | Husnida |
| Polipropilen 2 x 1500 / OQ | 2026-08-13 | OUT | 40 | Ishlab chiqarish: HU-260813-01 (Ikki Qavat Arqon / 4 kg × 10) | Husnida |
| Polipropilen BSF | 2026-07-25 | OUT | 22.5 | Ishlab chiqarish: AZ-260725-01 (Kurtka Tros 4-5 kg × 5) | Aziza |
| Polipropilen BSF | 2026-07-25 | OUT | 36 | Ishlab chiqarish: GL-260725-01 (Kurtka Tros 4-5 kg × 8) | Gullola |
| Polipropilen BSF | 2026-07-25 | OUT | 58.5 | Ishlab chiqarish: SH-260725-01 (Kurtka Tros 4-5 kg × 13) | Shohida |
| Qop ip | 2026-06-24 | OUT | 255 | Ishlab chiqarish: MU-260624-01 (Qop Ip - 100 talik × 3000) | Muxtasarxon |

**Q2 (egasi qarori):** bu minuslar (a) o'tgan xaridlarni orqaga kiritish (backfill) bilan yopiladimi, yoki (b) inventarizatsiya kuni ADJUSTMENT bilanmi? Hozircha hech narsa qilinmadi.

## F. Sholcha oilasi — OCHIQ savol (merge qilinmadi)

Jonli ma'lumot:

| Manba | Nomi | Miqdor | Og'irlik kg | Qo'shimcha |
|---|---|---|---|---|
| raw_master | Sholcha | 25 000 | — | kg |
| raw_inv | Sholcha | 25 000 | 25 000 | C-01 |
| fin_inv | Sholcha Oq | 25 000 | 0 | C-01 [raw/container] |
| fin_inv | Sholcha Sariq | 10 000 | 0 | C-03 [raw/container] |
| fin_inv | Sholcha Sariq | 25 000 | 0 | C-08 [raw/container] |
| fin_inv | Sholcha Oq | 22 000 | 0 | C-09 [raw/container] |
| fin_inv | Sholcha Sariq | 25 000 | 0 | C-13 [raw/container] |
| product_master | Sholcha Oq | — | — | SHOLCHAOQUZUN in_sales=false |
| product_master | Sholcha Sariq | — | — | SHOLCHASARIQKALTA in_sales=false |
| bom_usage | Sholcha | 3 | — | 20 METR RANGLI ingichka; Sholcha Oq; Sholcha Sariq |
| movements | Sholcha IN/raw | 25 000 | — | 1 |
| movements | Sholcha Oq IN/finished | 47 000 | — | 2 |
| movements | Sholcha Sariq IN/finished | 60 000 | — | 3 |

Faktlar:
1. Xomashyo "Sholcha": 25 000 kg, C-01 raw konteynerda, bitta IN bilan kirgan — sof va izli ✓
2. "Sholcha Oq" (47 000 birlik) va "Sholcha Sariq" (60 000 birlik) — **mahsulot sifatida raw konteynerlarda** turibdi (C-01/03/08/09/13), og'irliklari 0 yozilgan, partiya orqali EMAS — qo'lda IN bilan kirgan (5 harakat).
3. Ikkala mahsulotning **BOM'i bor: xomashyosi — o'sha "Sholcha"** (birlikka 1.0 kg; 0.6 kg esa "20 METR RANGLI ingichka" BOM'iga tegishli). Ya'ni tizim nazarida bular Sholcha'dan ISHLAB CHIQARILADIGAN mahsulotlar, lekin hech qachon partiya kiritilmagan.
4. Hech biri hali sotilmagan, ikkalasida in_sales o'chirilgan.

**Q1 (egasi qarori) — variantlar:**
- (a) 3 alohida item: "Sholcha" (raw) + "Sholcha Oq"/"Sholcha Sariq" (manufactured, BOM orqali) — hozirgi BOM tuzilishiga mos; 107 000 birlikning kelib chiqishi (qaysi Sholcha'dan qilingan?) inventarizatsiyada hal qilinadi;
- (b) rang varianti sifatida bitta "Sholcha" item — lekin unda BOM/ishlab chiqarish semantikasi yo'qoladi;
- (c) transformation sifatida (Sholcha → Sholcha Oq) — P5'da transformation obyekti bilan.
Taxmin bilan birlashtirilmadi — real jarayonni (kesish? bo'yash? o'rash?) egasi aytishi kerak.

## G. Inventory arxitekturasi — YAKUNIY NOMZOD diagramma

```text
                              ┌─────────────────────────────────────────┐
                              │ ITEMS (item master)                     │
                              │ id PK · sku UNIQUE NOT NULL · name(disp)│
                              │ unit(dona/kg) · is_raw · is_manufactured│
                              │ is_purchased · is_intermediate          │
                              │ is_saleable · active                    │
                              └───┬────────┬───────────┬────────────────┘
              0..1 profil         │        │           │
   ┌──────────────────────┐      │        │           │
   │ products (ishlab      │◄─────┤        │           │
   │ chiq. profili: rate,  │      │        │           │
   │ payroll, cost, tier)  │      │        │           │
   └──────────────────────┘      │        │           │
   ┌──────────────────────┐      │        │           │
   │ raw_materials (xarid  │◄─────┘        │           │
   │ profili: cost,currency│               │           │
   │ min_stock)            │               │           │
   └──────────────────────┘               │           │
        ┌──────────────────────────────────┴──┐   ┌────┴──────────────────────────┐
        │ BOM (product_item_id → items,       │   │ INVENTORY (item_id,           │
        │ material_item_id → items,           │   │ warehouse_id) UNIQUE          │
        │ qty_per_unit 0.001)                 │   │ qty + weight_kg               │
        └─────────────────────────────────────┘   └────┬──────────────────────────┘
                                                        │   WAREHOUSES (36):
                                                        │   general/container × raw/finished
   ┌────────────────────────────────────────────────────┴────────────────────────┐
   │ INVENTORY LEDGER (yagona daftar)                                            │
   │ id · item_id · ±qty · ±kg · movement_type · from_loc · to_loc               │
   │ ref_type + ref_id (batch/sale/transformation/purchase/adjustment)           │
   │ user · timestamp · note                                                     │
   │ type'lar: PURCHASE│RAW_INPUT│TRANSFER│WIP_ISSUE│PRODUCTION_CONSUMPTION│     │
   │ PRODUCTION_OUTPUT│TRANSFORMATION_IN/OUT│SALE│ADJUSTMENT│RETURN              │
   └───────────────┬─────────────────────────────────────────────────────────────┘
                   │
   ┌───────────────┴───────────┐  ┌──────────────────────────────┐
   │ WIP = LOKATSIYA           │  │ TRANSFORMATIONS               │
   │ (line_id + item_id        │  │ input_item+kg → output_item+kg│
   │ kesimida balans;          │  │ line/dept · from_loc · to_loc │
   │ RECEIVE/PRODUCE ledger)   │  │ (loss — kelajak kengaytmasi)  │
   └───────────────────────────┘  └──────────────────────────────┘
   ┌───────────────────────────┐  ┌──────────────────────────────┐
   │ BATCHES (production event)│  │ SALES + SALE_ITEMS (item_id)  │
   │ batch_code · product_item │  │ + kelajak: weight_kg          │
   │ qty · kg · line · worker  │  └──────────────────────────────┘
   │ SKU ≠ Batch ✓             │
   └───────────────────────────┘
```

**Qoldiq saqlanish qoidasi (miqdor yo'qolmaydi):**

```text
Global qoldiq (item) = Σ konteyner qoldiqlari + Σ WIP qoldiqlari

WIP_ISSUE (bo'limga berish):    konteyner −X → WIP +X   (global O'ZGARMAYDI)
PRODUCTION_CONSUMPTION:         WIP −X                   (global −X)
PRODUCTION_OUTPUT:              finished konteyner +Y    (tayyor item +Y)
TRANSFORMATION:                 manba −X → yangi item +X
SALE (shu jumladan raw sale):   lokatsiya −X             (global −X)
ADJUSTMENT:                     faqat izoh + audit bilan
```

Tasdiqlangan 15 qoidaning har biri shu modelda qanoatlantiriladi (moslik jadvali audit hujjatida, H-bo'lim).

## H. Migratsiyadan kutiladigan OLDIN/KEYIN misollari (real raqamlar bilan)

### Misol 1 — Dual merge: Babin Sariq 0.5 mm
**Oldin (bugun):** 2 ta mustaqil yozuv:
| Yozuv | Qoldiq | Tarix |
|---|---|---|
| Xomashyo #10 | **−1 844.96 kg** | 36 ta partiya ayirmasi, 5 BOM'da |
| Mahsulot BABSA/05 | 0 (ombor yozuvi yo'q) | 1 sotuv (402.6 kg) — omborga tegmagan |

**Keyin (canonical):** bitta item `BABSA/05` (is_raw + is_saleable; is_purchased — Q5; o'z-o'ziga 1:1 BOM olib tashlanadi):
| Bosqich | Natija |
|---|---|
| P2 backfill | ikkala tarix bitta item_id ostida: 36 partiya + 1 sotuv + BOM bog'lari |
| P3 inventarizatsiya | real qoldiq sanaladi; −1 844.96 farqi Q2 qaroriga ko'ra yopiladi (backfill xarid yoki ADJUSTMENT) |
| P4+ | sotuv ham, partiya ham BITTA qoldiqdan; minusga tushish faqat ruxsatli ADJUSTMENT bilan |

### Misol 2 — Real partiya: HU-260813-01 (2026-08-13)
15 dona Ikki Qavat Arqon (4kg×10 + 5kg×5), PP 2×1500/OQ iste'moli 65 kg.

| | Oldin (bugungi tizim) | Keyin (canonical) |
|---|---|---|
| Xomashyo ayirmasi | global current_stock −65 (konteyner O'ZGARMAYDI, harakat omborsiz) | liniya WIP'idan −65 kg (PRODUCTION_CONSUMPTION, item kesimida); WIP yetmasa — partiya bloklanadi yoki ruxsatli ADJUSTMENT |
| Tayyor kirim | ombor +15 dona (80.7 kg) — istalgan faol omborga tushishi mumkin | faqat finished konteynerga +15 dona / +80.7 kg (PRODUCTION_OUTPUT, ref=batch) |
| Global qoldiq | mustaqil raqam (minusga ketaveradi) | Σ(konteyner+WIP) — avtomatik, alohida tuzatib bo'lmaydi |
| BOMsiz bo'lsa | jim o'tadi | is_manufactured bo'lsa bloklanadi (15-qoidalar №9) |

### Misol 3 — Xomashyoni to'g'ridan-to'g'ri sotish (bugun MUMKIN EMAS)
Sholcha 500 kg mijozga:
| | Oldin | Keyin |
|---|---|---|
| Yo'l | faqat products'ga nusxa ochib (dual muammosi) | to'g'ridan-to'g'ri: item is_raw+is_saleable |
| Yozuvlar | sotuv omborga tegmasligi mumkin (D-bo'limdagi 4 misol) | SALE: C-01 −500 kg, ref=sale; global avtomatik −500 |
| Narx | products'dagi nusxa narxi | items narx profili (USD/UZS qoidasi saqlanadi) |

## Egasidan kutilayotgan P1 qarorlari (Q-ro'yxat)

| # | Savol | Tegishli bo'lim |
|---|---|---|
| Q1 | Sholcha oilasi: (a) 3 item + BOM, (b) bitta item, (c) transformation? Va 107 000 birlikning real holati (og'irligi 0 yozilgan!) | F |
| Q2 | 5 manfiy material: backfill xaridlar bilanmi yoki inventarizatsiya ADJUSTMENT bilanmi yopiladi? | E |
| Q3 | Qop ip 80/100 dublikatlari: qaysi nom qoladi? (har juftlikning bittasida BOM bor) | A, C |
| Q4 | Dublikat/o'xshash juftliklar: 3× "Reja ip PP … gr ↔ gramm", "Strupa Sari ↔ Strupa Sariq", "5 MM GIBRID ↔ 5 mm Gibrid Lenta" (SKU'lari ham to'qnashadi), "Shroki 3.5 ↔ Shroki 3.5 Oq" — qaysilari bitta mahsulot? | A |
| Q5 | 4 dual MERGE tasdig'i + o'z-o'ziga 1:1 BOM'larni olib tashlash + is_purchased belgisi + Kanob'ga toza SKU | D |
| Q6 | "0.5 Babin / Qora" BOM'ida material "Babin Sariq 0.5 mm" — xatomi? (Qora #11 bo'lishi kutilgan edi) | C |
| Q7 | Babin Sariq 0.4: 5 000 kg qoldiq birorta harakatsiz kiritilgan — inventarizatsiyada tasdiqlanadimi? | B |
| Q8 | "Polipropilen ip" (UZS): BOM'da yo'q, qoldiq 0, harakat 0 — arxivga o'tsinmi? | B |
| Q9 | Hech qayerda ishlatilmagan 1 ta mahsulot — arxivga? | A |
| Q10 | Inventarizatsiya sanasi va mas'ul shaxs (P3 shunga bog'liq) | — |

Javoblar kelgach: P2 (items + item_id ustunlari + dual-write) boshlanadi — reja audit hujjatining G-bo'limida.
