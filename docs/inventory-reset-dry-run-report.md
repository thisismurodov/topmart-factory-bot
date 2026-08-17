# QURUQ SINOV (DRY-RUN) HISOBOTI — Ishlab chiqarish inventari qayta qurish, v2 strategiya

*Sana: 2026-08-17 · Holat: **DRY-RUN — bazaga HECH NARSA yozilmadi** (faqat SELECT tekshiruvlar) · Manba: `attached_assets/Pasted-IMPORTANT-NEW-PRODUCTION-INVENTORY-RESET-STRATEGY-We-ar_1786907653533.txt` · Asosiy reja (v2'ga yangilandi): `docs/inventory-reset-implementation-proposal.md`*

> **YANGILANISH (2026-08-17):** egasi «P2.1 GO + R-A GO» berdi — ikkala bosqich bajarildi va tekshirildi: `docs/p2.1-r-a-execution-report-2026-08-17.md`. Quyidagi matn GO'dan OLDINGI muzlatilgan holatni aks ettiradi; 97 pozitsiya haliyam inventarga YUKLANMAGAN, R-B/R-C/R-D/R-E GO berilmagan. Bitta ijro farqi: joy-yig'ma arxivi (`legacy.container_summary_pre`) 9 emas, BARCHA 36 joy bo'yicha olindi (9 sanoq joyi shu ichida — to'liqroq qamrov).

> Egasi strategiyasi §14 talabi: har qanday baza o'zgarishidan OLDIN 10 band ko'rsatilsin va dry-run hisoboti berilsin. Quyida barchasi. **Hech bir bosqich aniq GO buyrug'isiz bajarilmaydi.**

---

## 0. v2'da nima o'zgardi (qabul qilingan yangi qarorlar)

| Mavzu | Eski holat | v2 qarori |
|---|---|---|
| Eski ERP ishlab chiqarish qoldiqlari | pozitsiyalab solishtirish savollari ochiq edi | **ISHONCHSIZ deb e'lon qilindi** — moslashtirish YO'Q; faqat LEGACY arxiv; joriy ochilish balansi sifatida ISHLATILMAYDI |
| Katalogda yo'q fizik pozitsiya | har biriga egasi qarori kutilardi | **DEFAULT: YANGI kanonik item** — avto-ulash TAQIQ («Qop ip» ≠ «Reja ip»; CF 1000D hech narsaga ulanmaydi) |
| Avto-SKU | taqiq edi | **RUXSAT: `TM-NNNNNN`** — unikal, nomdan mustaqil, immutable, barcode/QR-tayyor |
| Item atributlari | — | sanoqdan ma'lum bo'lganigina yoziladi; tur/narx/material/tasnif/birlik spetsifikatsiyasi… egasi dashboardda to'ldiradi (SKU o'zgarmaydi) |

O'zgarmagan qoidalar: TopMart sotuv ma'lumotlari mutlaqo daxlsiz · tarixiy harakatlar o'chirilmaydi · 97 pozitsiya immutable manba-dalil · har bosqich alohida GO · qolgan joylar keyin, o'z sanog'i bilan qo'shiladi (bu 9 joy ularni kutmaydi).

## 1. Aniq ta'sirlanadigan jadvallar (§14.1)

| Bosqich | CREATE (yangi) | ALTER (additiv) | INSERT | Mavjud qatorlarga UPDATE |
|---|---|---|---|---|
| P2.1 | `items`, `item_aliases` (+2 himoya trigger) | 8 jadvalga 10 NULLABLE `item_id` ustuni (metadata-only) | 0 | 0 |
| R-A | `legacy` sxema: 4 nusxa-jadval | — | nusxa qatorlar (inventory 43 · raw 17 · WIP liniya kesimi · 9 joy jami) | 0 (asl jadvallar tegilmaydi) |
| R-B | `physical_baselines`, `physical_baseline_positions` | — | 9 + 97 immutable qator | 0 |
| P2.2/2.3 | — | — | 134 item (117 mahsulot + 17 xomashyo, 1:1) | faqat yangi NULLABLE `item_id` ustunlari to'ldiriladi — qiymat/narx/tarix ustunlariga 0 ta'sir |
| R-C | — | `stock_movements`: +`weight_kg`, +`reference`, +`reason` (nullable); CHECK += `BASELINE` (3 manbada lockstep: jonli ALTER + bot init_db + API initDb/Drizzle) | **94 yangi item (TM-SKU)** + 97 pozitsiyaga `item_id` | 0 |
| R-D | — | — | BASELINE harakatlar: **97 kirim + 13 nollash = 110** · `inventory`: +97 yangi qator | **13 ta C-16/C-17 legacy qatori nollanadi** — FAQAT auditli BASELINE harakati bilan, bitta tranzaksiyada (§3) |
| R-E | `transformations` (rezerv sxema) | — | jonli oqim yozuvlari (ISSUE/RECEIVE…) | odatiy auditli operatsiyalar |

**Umuman tegilmaydiganlar (kafolat, 2026-08-17 jonli SELECT):** `sales` (45) · `sale_items` qiymatlari (143 — faqat NULLABLE `item_id` ustuni qo'shiladi, qiymatlar tegilmaydi) · `distribution.*` savdo bot sxemasi (70 mahsulot katalogi — 0 DDL / 0 DML) · `products`/`raw_materials` qiymat ustunlari · mavjud 620 `stock_movements` · 171 `wip_movements` · 280 `batches` · 62 `product_materials`.

## 2. Legacy qanday izolyatsiya qilinadi (§14.2)

1. Har yozuv-GO'dan oldin `pg_dump` snapshot + Replit checkpoint (halokat sug'urtasi; odatiy rollback uchun EMAS — u storno bilan, §6).
2. `CREATE SCHEMA legacy` + nusxalar: `legacy.inventory_baseline_pre` (43 qator — shu jumladan C-16/C-17'ning 13 qatori va Namangan minusi), `legacy.raw_material_stock_pre` (17), `legacy.wip_balances_pre`, `legacy.container_summary_pre`. Har qatorda `archived_at` + manba izoh.
3. **R-A yakun tekshiruvi (majburiy):** `legacy.*` qator sonlari va qiymat yig'indilari asl jadvallar bilan solishtiriladi (13 ta C-16/C-17 qatori ALOHIDA sanab tasdiqlanadi), natija hisobotga yoziladi — shu tekshiruvsiz R-A «bajarilgan» HISOBLANMAYDI.
4. **Tartib kafolati (QATTIQ SHART):** R-D — ayniqsa C-16/C-17 nollashi — FAQAT tekshirilgan R-A'dan KEYIN ruxsat etiladi; pg_dump bu shartni ALMASHTIRMAYDI (u halokat sug'urtasi, so'raladigan arxiv emas). Aks holda nollangan qiymat arxivga tushib qolish xavfi bo'lardi.
5. Mantiqiy chegara: baseline sanasidan OLDINGI barcha harakatlar «legacy davri» — joyida, belgisiz, o'zgarishsiz qoladi (`created_at` o'zi chegara).
6. «Eski ERP nimani ko'rsatgan?» — ABADIY javobli: `SELECT * FROM legacy.*`. Legacy qiymatlar joriy ochilish balansi sifatida HECH QAYERDA ishlatilmaydi (v2 §1 talabiga aynan).
7. Arxiv append-only: DROP ham, DELETE ham yo'q — hatto rollback stsenariysida ham.

## 3. 97 fizik pozitsiya joriy inventarga qanday aylanadi (§14.3)

```text
Sanoq hujjatlari (muzlatilgan, 3 ta doc)                 ← HOZIR SHU YERDAMIZ
   ↓ «R-B GO»
physical_baselines (9) + physical_baseline_positions (97)
   nom/karobka-qop/dona/birlik og'irlik/kg AYNAN + sana + manba + counted_by
   qiymatlar IMMUTABLE — mapping paytida ham o'zgartirilmaydi (§14.12)
   ↓ «R-C GO»
94 yangi item (TM-SKU, §4) + har pozitsiyaga item_id
   (pozitsiya qiymatlariga tegilmaydi — faqat item_id ustuni to'ladi)
   ↓ «R-D GO C-xx» (har konteyner alohida)
har pozitsiya → 1 ta BASELINE harakat (item_id, quantity, weight_kg,
   reference = sanoq hujjati, reason, created_by) → inventory qatori (+97)
C-16/C-17 qo'shimcha qadami (QATTIQ SHART: tekshirilgan R-A arxivi mavjud, §2):
   13 eski qator → 13 ta NOLLASH-BASELINE harakati
   (reason = eski ERP qiymati, reference = v2 strategiya hujjati) —
   eski qoldiq «joriy» maqomini yo'qotadi, arxivda ABADIY qoladi
   ↓
Joriy balans = faqat tasdiqlangan fizik haqiqat
Global qoldiq = Σ konteynerlar + Σ WIP (read-only VIEW, R-E)
```

Nima uchun NOLLASH ham BASELINE turi bilan: OUT harakati soxta «chiqim» tarixini yaratadi (taqiq); BASELINE esa oshkora «qayta asoslash» belgisi — chiqim emas. 13 qatorning har biri uchun eski qiymat harakat `reason`ida saqlanadi, to'liq nusxasi `legacy` sxemada. Nollash tranzaksiyasi qat'iy: qator `SELECT … FOR UPDATE` bilan qulflanadi → joriy qiymat `legacy` arxiv qiymati bilan solishtiriladi (mos kelmasa — STOP, parallel o'zgarish belgisi) → BASELINE harakat + balans yangilash BITTA tranzaksiyada.

Yozish konvensiyalari (savollar №5/№6 bilan): **dona-pozitsiyalar** (12 ta — C-16/C-17): `quantity` = dona, `weight_kg` = hisoblangan kg · **kg-only pozitsiyalar** (85 ta): taklif `quantity = 0`, `weight_kg` = sanoq kg (dona hech qachon kg'dan chiqarilmaydi — taqiq kuchda).

## 4. Generatsiya qilinadigan SKUlar — to'liq ro'yxat (§14.4)

**Qoidalar:**
- Format `TM-NNNNNN` — egasi strategiyasidagi namuna aynan. Jonli tekshiruv (2026-08-17): mavjud katalogda `TM-` prefiksli SKU **0 ta** — to'qnashuv yo'q; mavjud SKUlarda tizimli konventsiya yo'q (`ply144`, `ROSSIYATROS`, `SHLPP/OQ`…), shu sabab yangi toza nomfazo ochiladi. Tarixiy SKUlar QAYTA YOZILMAYDI.
- Tartib deterministik: konteynerlar sanoq hujjatlari tartibida (C-20 → C-19 → C-18 → C-02 → C-04 → C-06 → C-16 → C-17 → C-15), har birida pozitsiya raqami bo'yicha. Verbatim-aynan nom ikkinchi marta uchrasa — birinchi SKU ishlatiladi (yagona holat: №22/№69).
- SKU nomdan mustaqil va immutable (P2.1 trigger UPDATE'da EXCEPTION beradi), barcode/QR uchun tayyor.
- 2 EXACT nom uchun DEFAULT taklif: mavjud katalog itemiga ULASH (tarixiy SKU saqlanadi, dublikat item ochilmaydi) — egasi tasdig'i bilan; RAD etilsa: «Rossiya Tros» → `TM-000095`, «Shroki 3.5 Oq» → `TM-000096`.

| № | Joy | Fizik nom (aynan) | Dona | kg | SKU | Holati |
|---|---|---|---|---|---|---|
| 1 | C-20 | Neylon 210D / 45 | — | 80 | TM-000001 | YANGI |
| 2 | C-20 | Neylon 210D / 60 | — | 1 474 | TM-000002 | YANGI |
| 3 | C-20 | Neylon 210D / 90 | — | 330 | TM-000003 | YANGI |
| 4 | C-20 | Toshkent Oq 14 mm — Bir qavat | — | 942.05 | TM-000004 | YANGI |
| 5 | C-20 | FDY Igna Strupa | — | 4 572.25 | TM-000005 | YANGI |
| 6 | C-20 | Toshkent Qora 14 mm Ichki Sariq | — | 636.25 | TM-000006 | YANGI |
| 7 | C-20 | 16 mm Alpinist | — | 520 | TM-000007 | YANGI |
| 8 | C-20 | 14 mm Alpinist | — | 930 | TM-000008 | YANGI |
| 9 | C-20 | Toshkent Qora 14 mm Ichi Oq PP TWS | — | 309.6 | TM-000009 | YANGI |
| 10 | C-20 | Toshkent Oq 16 mm Ichi Oq PP TWS — 50 metr | — | 342.3 | TM-000010 | YANGI |
| 11 | C-19 | Polyamide 144 oq TWS | — | 552.9 | TM-000011 | YANGI |
| 12 | C-19 | Polyamide Ko‘k 187 TWS | — | 94.05 | TM-000012 | YANGI |
| 13 | C-19 | Polyamide Qizil 187 TWS | — | 73.65 | TM-000013 | YANGI |
| 14 | C-19 | Polyamide Sariq 187 TWS | — | 44.6 | TM-000014 | YANGI |
| 15 | C-19 | Polyamide Oq 187 TWS | — | 132.15 | TM-000015 | YANGI |
| 16 | C-19 | Qop ip Yashil | — | 2 244.1 | TM-000016 | YANGI |
| 17 | C-19 | Qop ip Qizil | — | 728.55 | TM-000017 | YANGI |
| 18 | C-19 | Passport Xom BCF | — | 646 | TM-000018 | YANGI |
| 19 | C-19 | Yashil PP TWS Strupa 24 talik | — | 643.4 | TM-000019 | YANGI |
| 20 | C-19 | Passport Strupa 16 talik | — | 527.65 | TM-000020 | YANGI |
| 21 | C-19 | Passport Strupa 24 talik | — | 273.75 | TM-000021 | YANGI |
| 22 | C-19 | Yashil PP TWS Strupa 16 talik | — | 168.6 | TM-000022 | YANGI ★ №69 bilan BITTA item (2 joy) |
| 23 | C-19 | Sariq Polyester Strupa 16 talik | — | 2 583.9 | TM-000023 | YANGI |
| 24 | C-18 | Toshkent Arqon 16 mm Ko‘k | — | 221.6 | TM-000024 | YANGI |
| 25 | C-18 | Toshkent Arqon 16 mm Qora | — | 332.95 | TM-000025 | YANGI |
| 26 | C-18 | Ustki Gilam Ichki Sariq Polyamide | — | 317.25 | TM-000026 | YANGI |
| 27 | C-18 | Toshkent Arqon 10 mm Yashil | — | 171.9 | TM-000027 | YANGI |
| 28 | C-18 | Toshkent Arqon 14 mm Qizil | — | 451.7 | TM-000028 | YANGI |
| 29 | C-18 | Toshkent Arqon 12 mm Qora Ichki Polyamide Sariq | — | 866.25 | TM-000029 | YANGI |
| 30 | C-18 | Toshkent Arqon 12 mm Qizil | — | 61.65 | TM-000030 | YANGI |
| 31 | C-18 | Toshkent Arqon 14 mm Qora | — | 150 | TM-000031 | YANGI |
| 32 | C-18 | Toshkent Arqon 10 mm Ko‘k | — | 150.25 | TM-000032 | YANGI |
| 33 | C-18 | FDY Fil Arqon | — | 497.55 | TM-000033 | YANGI |
| 34 | C-18 | Toshkent Arqon 16 mm Oq — 50 metr | — | 63.2 | TM-000034 | YANGI |
| 35 | C-18 | Toshkent Arqon 14 mm Oq — 100 metr | — | 40.05 | TM-000035 | YANGI |
| 36 | C-18 | Toshkent Arqon 16 mm Oq | — | 61.9 | TM-000036 | YANGI |
| 37 | C-18 | Toshkent Arqon Qora 16 mm Ichki Polyamide Sariq | — | 717.35 | TM-000037 | YANGI |
| 38 | C-18 | Toshkent Arqon 12 mm Sariq | — | 389.95 | TM-000038 | YANGI |
| 39 | C-18 | FDY Tros Aralash | — | 386.75 | TM-000039 | YANGI |
| 40 | C-18 | Rossiya Tros | — | 531 | `ROSSIYATROS` (mavjud) | MAVJUDGA ULASH — tasdiq kutilmoqda (rad → TM-000095) |
| 41 | C-18 | Usti gilam ichki Sariq Polyamide Arqon | — | 370.5 | TM-000040 | YANGI |
| 42 | C-18 | Ustki Oq TWS ichki Polyamide Oq Arqon | — | 1 264.1 | TM-000041 | YANGI |
| 43 | C-18 | Ustki PP xom ichki Polyamide Oq Arqon | — | 105 | TM-000042 | YANGI |
| 44 | C-18 | Ustki 187 TWS Oq ichki Zubr 16 mm Arqon | — | 926.4 | TM-000043 | YANGI |
| 45 | C-18 | Ustki 187 TWS Oq ichki Strupa 14 mm Arqon | — | 520 | TM-000044 | YANGI |
| 46 | C-18 | Kanob Aralash 20 metr | — | 113.55 | TM-000045 | YANGI |
| 47 | C-18 | Alpinist 12 mm | — | 450.6 | TM-000046 | YANGI |
| 48 | C-18 | Alpinist 10 mm | — | 106.2 | TM-000047 | YANGI |
| 49 | C-18 | Alpinist 14 mm | — | 165.55 | TM-000048 | YANGI |
| 50 | C-18 | Alpinist 16 mm | — | 199.3 | TM-000049 | YANGI |
| 51 | C-18 | Alpinist 20 mm | — | 174.5 | TM-000050 | YANGI |
| 52 | C-18 | Alpinist 25 mm | — | 32.45 | TM-000051 | YANGI |
| 53 | C-02 | Shroki 3.5 sm lenta | — | 468.35 | TM-000052 | YANGI |
| 54 | C-02 | Rangli 2.5 sm ikki qavat lenta | — | 863.45 | TM-000053 | YANGI |
| 55 | C-02 | Reels Lenta | — | 1 352.85 | TM-000054 | YANGI |
| 56 | C-02 | Tulpor Lenta Aralash | — | 556.4 | TM-000055 | YANGI |
| 57 | C-02 | Tulpor Lenta Yashil | — | 1 019.35 | TM-000056 | YANGI |
| 58 | C-02 | Tulpor Lenta Oq | — | 439.2 | TM-000057 | YANGI |
| 59 | C-02 | Tulpor Lenta Ko‘k | — | 192.05 | TM-000058 | YANGI |
| 60 | C-02 | Tulpor lenta qizil | — | 287 | TM-000059 | YANGI |
| 61 | C-02 | Shroki 3.5 Oq | — | 676.55 | `SHROKI-3-5-OQ` (mavjud) | MAVJUDGA ULASH — tasdiq kutilmoqda (rad → TM-000096) |
| 62 | C-02 | Tahoe Lenta | — | 197.8 | TM-000060 | YANGI |
| 63 | C-04 | Polipropilen CF 1500D Qora | — | 3 250 | TM-000061 | YANGI |
| 64 | C-04 | Polipropilen CF 1000D Yashil | — | 1 020 | TM-000062 | YANGI |
| 65 | C-04 | Strupa Salafan | — | 375.8 | TM-000063 | YANGI |
| 66 | C-04 | XB Strupa | — | 349.9 | TM-000064 | YANGI |
| 67 | C-04 | PP Oq TWS Strupa 12 talik | — | 875.55 | TM-000065 | YANGI |
| 68 | C-04 | Eshma Xitoy Strupa PP Oq TWS | — | 230.85 | TM-000066 | YANGI |
| 69 | C-04 | Yashil PP TWS Strupa 16 talik | — | 261.2 | TM-000022 | = №22 (C-19) bilan BITTA item — 2-joy balansi |
| 70 | C-06 | Shlanka Polyamide Yumshoq | — | 86.3 | TM-000067 | YANGI |
| 71 | C-06 | Shlanka Tortqi PP Oq TWS — 50 metr | — | 236.25 | TM-000068 | YANGI |
| 72 | C-06 | Shlanka Tortqi PP Yashil TWS — 50 metr | — | 66.35 | TM-000069 | YANGI |
| 73 | C-06 | Shlanka Polipropilen CF Qora | — | 618.8 | TM-000070 | YANGI |
| 74 | C-06 | Shlanka Polipropilen CF Yashil | — | 710.45 | TM-000071 | YANGI |
| 75 | C-06 | Shlanka Polipropilen CF Ko‘k | — | 506.25 | TM-000072 | YANGI |
| 76 | C-06 | Shlanka Polipropilen CF Qizil | — | 581.4 | TM-000073 | YANGI |
| 77 | C-06 | Shlanka Polipropilen CF Oq | — | 874.95 | TM-000074 | YANGI |
| 78 | C-06 | Shlanka Polyester FDY Qora | — | 433.2 | TM-000075 | YANGI |
| 79 | C-06 | Shlanka Polyester FDY Yashil | — | 830.4 | TM-000076 | YANGI |
| 80 | C-06 | Shlanka Polyester FDY Ko‘k | — | 778.15 | TM-000077 | YANGI |
| 81 | C-06 | Shlanka Polyester FDY Qizil | — | 730.95 | TM-000078 | YANGI |
| 82 | C-06 | Shlanka Polyester FDY Oq | — | 982.05 | TM-000079 | YANGI |
| 83 | C-16 | Qop ip 100 talik | 55 200 | 6 348.00 | TM-000080 | YANGI |
| 84 | C-16 | Qop ip 120 talik | 2 520 | 226.80 | TM-000081 | YANGI |
| 85 | C-16 | Qop ip 80 talik | 3 360 | 470.40 | TM-000082 | YANGI |
| 86 | C-17 | Qop ip 50 gramm Qora | 12 000 | 600.00 | TM-000083 | YANGI |
| 87 | C-17 | Qop ip 50 gramm Sariq | 12 800 | 640.00 | TM-000084 | YANGI |
| 88 | C-17 | Qop ip 50 gramm Oq | 7 600 | 380.00 | TM-000085 | YANGI |
| 89 | C-17 | Qop ip 30 gramm Qora | 4 800 | 144.00 | TM-000086 | YANGI |
| 90 | C-17 | Qop ip 30 gramm Sariq | 10 400 | 312.00 | TM-000087 | YANGI |
| 91 | C-17 | Qop ip 30 gramm Oq | 8 400 | 252.00 | TM-000088 | YANGI |
| 92 | C-17 | Qop ip 100 gramm Qora | 2 080 | 208.00 | TM-000089 | YANGI |
| 93 | C-17 | Qop ip 100 gramm Sariq | 2 880 | 288.00 | TM-000090 | YANGI |
| 94 | C-17 | Qop ip 100 gramm Oq | 4 320 | 432.00 | TM-000091 | YANGI |
| 95 | C-15 | Polipropilen CF 1000D Qizil | — | 3 720.00 | TM-000092 | YANGI |
| 96 | C-15 | Polipropilen CF 1000D Ko'k | — | 3 840.00 | TM-000093 | YANGI |
| 97 | C-15 | Polipropilen CF 1000D Sariq | — | 5 460.00 | TM-000094 | YANGI |

Nomlar sanoq hujjatlaridan AYNAN ko'chirildi (apostrof/tire belgilari bilan) — R-B'da ham aynan shunday yoziladi.

**Nazorat jamlari (muzlatilgan hujjatlar bilan aynan):**

| Joy | Pozitsiya | kg | Joy | Pozitsiya | kg |
|---|---|---|---|---|---|
| C-20 | 10 | 10 136.45 | C-06 | 13 | 7 435.50 |
| C-19 | 13 | 8 713.30 | C-16 | 3 | 7 045.20 |
| C-18 | 29 | 9 839.45 | C-17 | 9 | 3 256.00 |
| C-02 | 10 | 6 053.00 | C-15 | 3 | 13 020.00 |
| C-04 | 7 | 6 363.30 | **JAMI** | **97** | **71 862.20** ✓ |

## 5. Eski ↔ yangi bog'lanish (§14.5)

| Bog'lam | Mexanizm |
|---|---|
| Yangi item → sanoq manbasi | `items.source_kind = 'physical_count'` + `physical_baseline_positions.item_id` (97 qator) + har BASELINE harakatida `reference` = sanoq hujjati |
| Mavjud katalog → item | P2.2/2.3: 117 mahsulot + 17 xomashyo 1:1 (tarixiy SKU / `RM-…`), `source_kind='product'/'raw_material'` + `source_id` |
| Fizik nom ↔ eski katalog nomi | FAQAT egasining oshkora qarori bilan `item_aliases` yozuvi (masalan, keyinchalik «Qop ip 50 gramm Qora» ↔ «Reja ip 50 gr / Qora» deb qaror qilsa). Balanslarni birlashtirish — alohida auditli operatsiya, alohida taklif bilan |
| 2 EXACT pozitsiya | `positions.item_id` → mahsulotdan tug'ilgan item (P2.2'dan keyin), tarixiy SKU saqlanadi — tasdiq kutilmoqda |
| Eski qoldiqlar | `legacy` sxemada o'qish uchun doim ochiq; joriy hisobga ta'siri 0 |

## 6. Rollback / storno strategiyasi (§14.6)

| Bosqich | Rollback yo'li |
|---|---|
| P2.1 DDL | runbook §6: ustunlar/jadvallar DROP (hech qanday ma'lumot yo'qolmaydi — hammasi bo'sh/NULLABLE) |
| R-A arxiv | rollback KERAK EMAS va TAQIQ — arxiv append-only; xato bo'lsa yoniga yangi vaqt-belgili snapshot |
| R-B registr | `DROP TABLE physical_baseline_positions, physical_baselines` (faqat yangi jadvallar) |
| R-C DDL | additiv/nullable → ustun DROP + CHECK eski holatga (3 manbada birga) |
| R-C itemlar | shu bosqichda ochilgan itemlar `active=false` + `positions.item_id=NULL` (items DELETE trigger bilan taqiqlangan) |
| R-D yuklash | **STORNO**: har BASELINE harakatiga teskari BASELINE (reference='ROLLBACK <asl>'); nollangan 13 legacy qator ham storno bilan qaytadi (qiymat manbai — legacy sxema). Hech narsa DELETE qilinmaydi, har konteyner mustaqil |
| R-E oqimlar | git revert (kod) — ma'lumot strukturasi o'zgarmaydi |
| Halokat (baza buzilishi) | pg_dump + checkpoint tiklash — FAQAT texnik falokat uchun; «fikr o'zgardi» stsenariysi storno bilan hal qilinadi |

## 7. TopMart sotuv ma'lumotlari tegilmasligi (§14.7)

- `sales` (45) va `sale_items` (143): 0 UPDATE / 0 DELETE / 0 INSERT. Yagona ta'sir — P2.1'da `sale_items`ga NULLABLE `item_id` USTUNI (qiymatlar, narxlar, mijozlar, tarix aynan qoladi; 39 orphan nom NULL bo'lib qolaveradi — P6'gacha).
- `distribution.*` (savdo bot, 70 mahsulot): bu rejada umuman qamrov TASHQARISIDA — 0 DDL, 0 DML.
- Sotuv katalogi/narxlari/mijozlari hech bir bosqichda o'qish-dan boshqa maqsadda ishlatilmaydi.
- Invariant tekshiruv (har GO'dan keyin qayta o'lchanadi va hisobotga yoziladi):

```sql
SELECT COUNT(*) FROM sales;                    -- 45  (o'zgarmasligi shart)
SELECT COUNT(*) FROM sale_items;               -- 143 (o'zgarmasligi shart)
SELECT COUNT(*) FROM distribution.mahsulotlar; -- 70  (o'zgarmasligi shart)
```

## 8. Tarixiy harakatlar o'chirilmasligi (§14.8)

- Mavjud 620 `stock_movements`, 171 `wip_movements`, 280 `batches`: 0 DELETE, 0 UPDATE. Harakatlar soni faqat O'SADI (R-D'da +110 BASELINE).
- Arxiv = NUSXA (asl joyida qoladi); nollash = YANGI harakat (DELETE emas); rollback = STORNO (DELETE emas).
- `items` satrlari DELETE trigger bilan himoyalangan (faqat `active=false`); SKU UPDATE trigger bilan taqiqlangan.
- Baseline'dan oldingi davr «legacy davri» deb faqat SANA orqali ajratiladi — mavjud qatorlarga hech qanday belgi ham yozilmaydi.

## 9. Yaratiladigan yangi itemlar soni (§14.9)

| Hisob | Qiymat |
|---|---|
| Fizik pozitsiyalar | 97 |
| Distinct verbatim nomlar | 96 (bitta nom 2 konteynerda: «Yashil PP TWS Strupa 16 talik» — №22/№69) |
| Katalogga AYNAN mos nomlar | 2 («Rossiya Tros», «Shroki 3.5 Oq» — mavjudligi jonli tasdiqlandi) |
| **YANGI item (TM-000001…TM-000094)** | **94** |
| Agar egasi 2 EXACT'ni ham «yangi» desa | 96 (TM-000095/096 qo'shiladi) |
| Birliklar kesimi | 82 kg-item + 12 dona-item |
| Qamrov nazorati | 94 item = 95 pozitsiya = 70 654.65 kg; + 2 EXACT (1 207.55 kg) = 97 pozitsiya = **71 862.20 kg** ✓ |

O'xshash-nom merge YO'Q: «16 mm Alpinist» (C-20) va «Alpinist 16 mm» (C-18) — 2 ALOHIDA item; «Qop ip N gramm RANG» (C-17) ERP'dagi «Reja ip N gr / RANG»ga ULANMAYDI; CF 1000D oilasi hech narsaga ulanmaydi. Bularni keyin faqat egasi `item_aliases` orqali oshkora bog'lashi mumkin.

## 10. Xulosa: bosqichlar, GO menyusi, ochiq savollar (§14.10)

**Ushbu hisobot doirasida bajarilgan yozuv: 0.** Barcha sonlar 2026-08-17 jonli SELECT + muzlatilgan sanoq hujjatlaridan.

| # | Bosqich | Nima yoziladi | GO formulasi |
|---|---|---|---|
| P2.1 | Items poydevor DDL | `items`/`item_aliases` + 10 NULLABLE ustun (0 satr o'zgaradi) | «P2.1 GO» |
| R-A | Legacy arxiv | pg_dump + `legacy` sxema nusxalari + yakun tekshiruvi (§2) | «R-A GO» — **R-D'dan oldin MAJBURIY** |
| R-B | Sanoq registri | 9 + 97 immutable qator | «R-B GO» |
| P2.2/2.3 | Katalog backfill | 134 item + mavjud qatorlarga item_id | «P2.2 GO» / «P2.3 GO» |
| R-C | Baseline DDL + itemlar | `BASELINE` turi + 3 ustun; **94 yangi TM-item**; 2 EXACT ulash (savol №1) | «R-C GO» |
| R-D | Yuklash (konteyner-kesim) — **SHART: R-A yakunlangan va tekshirilgan** | 97 kirim + 13 nollash BASELINE; 97 inventar qatori | «R-D GO C-20» … har biri alohida |
| R-E | Jonli oqimlar | ISSUE/RECEIVE, chiqish-konteyner tanlovi, purpose nazorati, global VIEW, transformatsiyalar | «R-E GO» (alohida texnik reja) |
| Keyin | Dashboard: items tahriri (atributlar ochiq, SKU qulflangan) · vizual oqim xaritasi (chiziqlar = real harakatlar) · P6 sotuv ulanishi | alohida takliflar | — |

**Qolgan egasi savollari** (to'liq matn: taklif §16): №1 2 EXACT ulash · №2 C-16/C-17'dagi 13 legacy qatorni nollash tasdig'i (shu jumladan fizikda topilmagan «Reja ip PP / 50 gr» 100 dona) · №3 C-15 maqsadi `finished`→`raw`? · №4 baseline kunida WIP · №5 kg-only'da quantity=0 konvensiyasi · №6 counted_by/created_by operatori · №7 eski Q1–Q10 (endi baselineni bloklamaydi).

Tavsiya etiladigan birinchi qadamlar: **«P2.1 GO»** va **«R-A GO»** — ikkalasi eng past xavfli, to'liq qaytariladigan.

---

*Biz taxmin qilmaymiz. Biz bilamiz.*
