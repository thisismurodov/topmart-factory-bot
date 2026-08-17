# OMBOR QAYTA QURISH — IJRO TAKLIFI (Inventory Reset Implementation Proposal)

*Sana: 2026-08-16 · Holat: **P2.1 + R-A BAJARILDI (2026-08-17, «P2.1 GO + R-A GO» bilan); qolgan bosqichlar alohida GO kutmoqda** — ijro hisoboti: `docs/p2.1-r-a-execution-report-2026-08-17.md`. Manba topshiriq: `attached_assets/Pasted-TOPMART-ERP-INVENTORY-RESET-PRODUCTION-WAREHOUSE-ARCHIT_1786905730862.txt` (egasining 17 bo'limlik arxitektura brifi, 14 bandlik taklif talabi bilan).*

**🔄 v2 YANGILANISH (2026-08-17):** egasining yangi strategiyasi (`attached_assets/Pasted-IMPORTANT-NEW-PRODUCTION-INVENTORY-RESET-STRATEGY-We-ar_1786907653533.txt`) qabul qilindi: eski ishlab chiqarish qoldiqlari ISHONCHSIZ (moslashtirilmaydi, faqat LEGACY arxiv); fizik pozitsiyalardan YANGI kanonik itemlar ochiladi; **avto-SKU (`TM-NNNNNN`) endi RUXSAT ETILGAN**; atributlarni egasi keyin dashboardda to'ldiradi. To'liq quruq sinov: `docs/inventory-reset-dry-run-report.md` (§2.3, §3 va §16 shu hujjatda yangilangan).

> **DARVOZA:** Ushbu hujjatdagi HAR BIR yozuv bosqichi egasining alohida, aniq GO buyrug'ini kutadi.
> Ungacha ruxsat etilgan yagona ish — read-only tahlil va hujjatlashtirish. Bu talab brifning
> §15/§17 bandlariga to'g'ridan-to'g'ri javob: NO DATABASE WRITE YET · FIRST PRODUCE THE PROPOSAL.

Asos hujjatlar (barchasi kuchda qoladi, bu taklif ULARNI BEKOR QILMAYDI, kengaytiradi):
- `docs/p2-items-foundation-proposal.md` — kanonik items modeli (egasi 2026-08-15 shartlar bilan TASDIQLAGAN)
- `docs/p2-1-execution-runbook.md` + `scripts/sql/p2.1-items-foundation.sql` — P2.1 DDL (✅ BAJARILDI 2026-08-17)
- `docs/physical-count-reconciliation-2026-08-15.md` — 6 konteyner solishtiruvi (MUZLATILGAN)
- `docs/physical-count-c16-c17-2026-08-15.md` — C-16/C-17 qo'shimcha sanoq (baseline nomzod)
- `docs/q1-q10-decision-pack.md` — ochiq egasi savollari

---

## 0. Daxlsizlik va joriy holat (tasdiqlangan raqamlar)

### 0.1 TEGILMAYDIGAN narsalar (brif §1, §12)

| Soha | Kafolat |
|---|---|
| TopMart sotuv katalogi (`products` qiymatlari), sotuv tarixi (`sales`, `sale_items` 143 qator), narxlar, mijozlar | 0 UPDATE / 0 DELETE. Yagona ta'sir: P2.1'dagi NULLABLE `item_id` ustuni (qiymatlar tegilmaydi) |
| Savdo bot katalogi (`distribution.mahsulotlar`) | umuman qamrovdan tashqari (ikki katalog — ataylab alohida) |
| Tarixiy harakatlar (620 `stock_movements`), partiyalar (280), WIP (171), BOM (62) | hech biri o'chirilmaydi/qayta yozilmaydi — arxiv bosqichida NUSXA olinadi, asli joyida qoladi |

### 0.2 Jonli baza — 2026-08-16 snapshot (faqat SELECT)

| Ko'rsatkich | Qiymat |
|---|---|
| Omborlar | 36 ta: 6 mintaqaviy (`general`) + 30 konteyner C-01…C-30 (`container`) |
| Konteyner maqsadi | `raw`: C-01, C-03, C-08, C-09, C-10, C-13 · qolgan hammasi `finished` |
| Inventar | 43 qator · 37 nom · 367 728 dona · 26 152.27 kg (shundan Namangan Markaziy: 20 qator, **−6 487 dona / −9 303.16 kg** — legacy minus) |
| Harakatlar | 620 (IN 303 · OUT 317 · TRANSFER 0) · davr 2026-06-24 → 2026-08-15 |
| WIP ledger | 171 qator — **hammasi PRODUCE, RECEIVE 0 ta** (muhim dalil, §5'ga qarang) |
| Katalog | 117 mahsulot + 17 xomashyo (xomashyo global stok yig'indisi 14 420.78 kg, manfiylar bilan) |
| P2.1 obyektlari | `items`/`item_aliases` MAVJUD EMAS — P2.1 GO berilmagan ✓ (brif §15 bilan mos) |
| Testlar | 450/450 (2026-08-15) · drift-himoya yashil ✓ (brif §15 bilan mos) |

### 0.3 Fizik baseline nazorati (brif §3, §16)

9 joy yig'indisi qayta hisoblandi: 10 136.45 + 8 713.30 + 9 839.45 + 6 053.00 + 6 363.30 + 7 435.50 + 7 045.20 + 3 256.00 + 13 020.00 = **71 862.20 kg ✓** (brif bilan aynan mos).

| Segment | kg | Pozitsiya tafsiloti | ERP joriy holati |
|---|---|---|---|
| C-20, C-19, C-18, C-02, C-04, C-06 | 48 541.00 | ✓ 82 pozitsiya (muzlatilgan hisobot) | 6 joyda ham BO'SH (0 qator) |
| C-16, C-17 | 10 301.20 | ✓ 12 pozitsiya (qo'shimcha hujjat) | **BO'SH EMAS**: C-16 3 qator / 90 180 dona; C-17 10 qator / 149 980 dona |
| C-15 | 13 020.00 | ✓ 3 pozitsiya (egasi 2026-08-16 tasdiqladi) | BO'SH (0 qator, DB ID 21 tasdiqlandi) |

✅ **C-15 blokeri YOPILDI (2026-08-16):** egasi 3 pozitsiyani tasdiqladi — Polipropilen CF 1000D: Qizil 3 720.00 + Ko'k 3 840.00 + Sariq 5 460.00 = **13 020.00 kg** ✓ (tafsilot: `docs/physical-count-c15-2026-08-16.md`). Endi barcha 9 joy pozitsiya darajasida to'liq — jami **97 pozitsiya** (82 + 12 + 3). Shu kuni C-17 qop jami ham tasdiqlandi: **279** («259» manba fayldagi yozuv xatosi edi; kg/dona jamlariga ta'sir yo'q).

---

## 1. Legacy inventar arxiv strategiyasi (brif §2, §14)

**Tamoyil:** arxiv = NUSXA + muzlatish. Asl jadvallar joyida qoladi (tarix o'chirilmaydi), eski holat alohida `legacy` sxemaga ko'chiriladi va faqat o'qish uchun qoladi.

| Qadam | Mexanizm |
|---|---|
| 1. To'liq snapshot | `pg_dump` (sxema + ma'lumot) fayli — halokat sug'urtasi |
| 2. `legacy` sxema | `CREATE SCHEMA legacy` + kesim jadvallar: `legacy.inventory_baseline_pre` (43 qator), `legacy.raw_material_stock_pre` (17), `legacy.wip_balances_pre` (liniya kesimi), `legacy.container_summary_pre` (amalda 36 joy yig'masi — 9 sanoq joyi shu ichida) — har birida `archived_at` va manba izohi |
| 3. Mantiqiy chegara | Baseline sanasidan OLDINGI barcha `stock_movements` qatorlari «legacy davri» deb hisoblanadi — ular joyida qoladi, hech qanday belgi ham o'zgartirilmaydi (created_at o'zi chegara) |
| 4. Auditlik | «Eski ERP nimaga ishongan?» = `SELECT * FROM legacy.*` (doim ochiq); «Fizik tasdiqlangan holat?» = yangi baseline registri (§2) |

Arxiv YARATADI, hech narsani O'ZGARTIRMAYDI: jonli jadvallarga 0 UPDATE/DELETE. Eski daftar davri tranzaksiyalari QAYTA YARATILMAYDI (brif §2: no invented transactions).

## 2. Yangi tasdiqlangan fizik baseline strategiyasi (brif §3, §4)

**Tamoyil:** fizik sanoq → ochilish qoldig'i TO'G'RIDAN-TO'G'RI (eski ERP ± tuzatish EMAS — brif §4 taqiqi).

1. **Sanoq registri (DB ichida, manba-ma'lumot sifatida):** 2 yangi jadval:
   - `physical_baselines` — har konteyner-sanoq: warehouse_id, sanoq sanasi, jami kg, manba hujjat, holat (`RECORDED` / `TOTAL_ONLY` / `MAPPED` / `LOADED`)
   - `physical_baseline_positions` — 97 pozitsiya AYNAN yozilganidek: nom (verbatim), karobka/qop soni, dona, birlik og'irlik, kg; keyin `item_id` (mapping bosqichida to'ldiriladi)
   Bu brifning «physical-count source data saqlansin» talabini hujjat + DB darajasida bajaradi.
2. **Ochilish qoldig'i:** har pozitsiya uchun bitta `BASELINE` turidagi harakat (yangi movement_type, §12) + `inventory` qatori. Hech qanday «silent» qiymat o'rnatish yo'q — har kg/dona harakat yozuvi bilan kiradi, reference = sanoq hujjati.
3. **C-16/C-17 maxsus holati (ERP bo'sh emas, 13 legacy qator):** bu yerda ikki tushunchani qat'iy ajratamiz:
   - **Tarixiy YOZUV** (eski ERP nimaga ishongan: 90 180 / 149 980 dona) — `legacy` sxemada + baseline'dan oldingi harakatlar tarixida ABADIY, O'ZGARMAS saqlanadi. U hech qachon yangilanmaydi, o'chirilmaydi, «tiklanmaydi».
   - **Joriy balans qatorlari** (`inventory`) — tarixiy hujjat emas, joriy holat ko'rsatkichi. v2'da fizik pozitsiyalar YANGI itemlarga yozilgani uchun R-D'da: (a) 13 eski qator auditli BASELINE harakati bilan NOLLANADI (`reason` = eski ERP qiymati, `reference` = v2 strategiya hujjati) — eski qoldiq «joriy» maqomini yo'qotadi, arxivda qoladi; (b) 12 yangi pozitsiya o'z BASELINE harakatlari bilan kiradi. Harakat + balans — bitta tranzaksiyada. **Qattiq shartlar:** (1) nollashdan OLDIN R-A yakunlangan va `legacy.*` nusxasi (13 qator alohida sanab) TEKSHIRILGAN bo'lishi SHART — aks holda arxivga nol tushish xavfi; pg_dump bu shartni almashtirmaydi; (2) tranzaksiyada qator `SELECT … FOR UPDATE` bilan qulflanadi va joriy qiymat legacy arxiv qiymati bilan solishtiriladi — mos kelmasa STOP (parallel o'zgarish belgisi).
   Ya'ni tarixiy balans QAYTA YOZILMAYDI — u arxivda qoladi; joriy balans esa faqat harakat-hujjat bilan o'zgaradi. Qatorni harakatsiz «to'g'irlab qo'yish» MUTLAQO TAQIQLANADI. *(OUT harakati bilan nollash RAD ETILADI — soxta chiqim tarixi; BASELINE turi aynan shu maqsadga xizmat qiladi: «bu chiqim emas, qayta asoslash» degan oshkora belgi.)*
4. Yuklash KONTEYNER-KESIMDA, har biriga alohida GO (masalan «R-D GO C-20»). Hammasi birdan emas.

## 3. Kanonik item / SKU strategiyasi (v2, 2026-08-17 yangilangan)

Tasdiqlangan P2 modeli o'zgarishsiz qo'llanadi: immutable `items.id` + immutable SKU + qobiliyat bayroqlari (`is_raw/is_intermediate/is_finished/is_purchasable/is_producible/is_sellable/inventory_tracked` — brif §9 «capability flags» talabiga aynan javob) + `item_aliases` (rename o'rniga).

**v2 siyosati (egasi strategiyasi §3, §4, §13):** fizik pozitsiya katalogda AYNAN topilmasa — DEFAULT endi «YANGI kanonik item» (avto-ulash TAQIQ). Har yangi itemga **avto-SKU `TM-NNNNNN`** (unikal, nomdan mustaqil, immutable — trigger himoyasida, barcode/QR-tayyor; jonli tekshiruv 2026-08-17: katalogda `TM-` prefiksli SKU 0 ta, tizimli konventsiya mavjud emas — TM- yangi toza nomfazo). Tarixiy SKUlar qayta yozilmaydi. Atributlar sanoqdan ma'lum bo'lganicha yoziladi, qolganini egasi dashboardda to'ldiradi (SKU o'zgarmaydi).

| Manba | Soni | Qoida |
|---|---|---|
| Mavjud mahsulotlar | 117 | 1:1 backfill, tarixiy SKU aynan ko'chiriladi, MERGE YO'Q |
| Mavjud xomashyolar | 17 | 1:1 backfill, `RM-…` SKU taklifi |
| Fizik pozitsiyalar | 97 → 96 distinct nom | **94 YANGI item (`TM-000001…TM-000094`)** + 2 EXACT nom («Rossiya Tros», «Shroki 3.5 Oq») mavjud katalog itemiga ulash — egasi tasdig'i bilan (rad etilsa TM-000095/096) |

Muhim chegara: «bitta item ko'p joyda» (strategiya §7) faqat **verbatim-AYNAN bir xil nom**ga qo'llanadi — yagona holat: «Yashil PP TWS Strupa 16 talik» (C-19 168.6 kg + C-04 261.2 kg) = bitta item `TM-000022`, ikki joy balansi. O'xshash-nom merge haliyam MUTLAQO TAQIQ: «Qop ip» ≠ «Reja ip» (strategiya §3 aynan), «16 mm Alpinist» ≠ «Alpinist 16 mm», CF 1000D hech narsaga ulanmaydi — hammasi alohida itemlar; keyinchalik egasi xohlasa `item_aliases` orqali OSHKORA bog'laydi. To'liq SKU ro'yxati: `docs/inventory-reset-dry-run-report.md` §4. Dublikat juftliklar (QP100↔QOP-IP-100-TALIK va h.k.), dual egizaklar (4), Sholcha oilasi — legacy katalog masalalari, endi baselineni bloklamaydi (Q1–Q10, dashboard-era).

## 4. Konteyner / joy mapping (brif §5)

`warehouses` jadvali 36 joyni allaqachon modellashtiradi — yangi jadval KERAK EMAS.

| Fizik yorliq | DB ID | Tasdiqlangan | Fizik yorliq | DB ID | Tasdiqlangan |
|---|---|---|---|---|---|
| C-20 | 26 | ✓ (hisobot) | C-04 | 10 | ✓ (hisobot) |
| C-19 | 25 | ✓ (hisobot) | C-06 | 12 | ✓ (hisobot) |
| C-18 | 24 | ✓ (hisobot) | C-16 | 22 | ✓ (qo'shimcha hujjat) |
| C-02 | 8 | ✓ (hisobot) | C-17 | 23 | ✓ (qo'shimcha hujjat) |
| C-15 | 21 | ✓ (2026-08-16, yagona aynan nom) | | | |

ITEM ≠ KONTEYNER tamoyili (brif §5): `inventory(warehouse_id, product→item_id)` — bitta item ko'p konteynerda yashay oladi (jadval buni hozir ham qo'llaydi). P2.3'dan keyin unikallik `(item_id, warehouse_id)` darajasida mustahkamlanadi.

## 5. WIP arxitekturasi (brif §6, §7)

Mavjud poydevor: `wip_movements` liniya-darajali ledger. **Jonli dalil:** 171 yozuvning HAMMASI `PRODUCE`, `RECEIVE` 0 ta — ya'ni «konteyner → liniya» kirim tomoni ERP'da HECH QACHON yozilmagan (daftar davri). Yangi tizimda bu majburiy yopiladi:

```text
Konteyner (raw)  --ISSUE-->  Liniya WIP  --PRODUCE (BOM bo'yicha)-->  Tayyor mahsulot konteyneri
     -300 kg                  +300 kg                −150 kg WIP · +150 kg finished
```

- WIP balans (liniya kesimi) = Σ RECEIVE − Σ PRODUCE (ledger'dan hisoblanadi, alohida saqlanmaydi)
- **Global qoldiq = Σ konteyner balanslari + Σ WIP balanslari** (brif §6 formulasi) — read-only VIEW sifatida joriy etiladi; qo'lda yuritiladigan «global» jadval YO'Q
- Konteyner→WIP ko'chishda global KAMAYMAYDI (faqat joy o'zgaradi) — ikkala yozuv bitta tranzaksiyada
- P2.1 ustunlari (`raw_material_item_id`, `product_item_id`) ledger'ni item'ga bog'laydi

## 6. BOM arxitekturasi (brif §10)

Mavjud `product_materials` (62 qator) saqlanadi: 1 birlik mahsulot uchun norma, bir BOM'da bir nechta xomashyo ✓ (gibrid misol: 1 birlik = PP CF 1.700 + PP BCF 1.600 = 2 qator), bitta xomashyo ko'p mahsulotda ✓ (hozir ham shunday). O'zgarish: P2.1 `product_item_id`/`material_item_id` ustunlari + P2.3 backfill — **BOM nomga emas, kanonik item ID'ga bog'lanadi** (brif talabi aynan). BOM qiymatlari bu rejada O'ZGARTIRILMAYDI (tasdiqlangan P2 sharti).

## 7. Transformatsiya arxitekturasi (brif §8)

Tasdiqlangan P2 rezerv sxemasi: `transformations` (input_item_id + input_kg → output_item_id + output_kg, liniya/joy konteksti, atomik 2 ledger yozuvi). Oraliq mahsulot = `is_intermediate` bayrog'i; u sotilishi (`is_sellable`), boshqa BOM'da ishlatilishi (`material_item_id`), boshqa bo'limga o'tkazilishi (TRANSFER) mumkin — RAW→INTERMEDIATE→FINISHED va RAW/INTERMEDIATE→SALE zanjirlari (brif §8) bayroqlar kombinatsiyasi bilan yopiladi. Ijro — R-E bosqichida (jadval yaratish + bot/dashboard oqimi), hozir faqat sxema rezervda.

## 8. Ishlab chiqarish partiyasi oqimi (brif §7, §11)

Kelajak oqim (R-E): partiya yaratishda operator (1) liniya WIP'dan BOM bo'yicha xomashyo iste'moli, (2) **tayyor mahsulot uchun konteyner TANLAYDI** — tizim faqat `purpose='finished'` joylarni taklif qiladi, raw-only joyga yozish ARXITEKTURA darajasida rad etiladi (brif §11 «container purpose enforced»); (3) partiya → IN harakati (batch reference bilan) → konteyner balansi. Hozirgi bot oqimi (BOM ayirish bot ichida) R-E'gacha o'zgarishsiz ishlayveradi.

## 9. Tayyor mahsulot oqimi (brif §11, §12)

Partiya chiqishi → tanlangan finished-konteyner → konteyner-darajali balans → sotuv iste'moli. Sotuv tomoni MEXANIZMI hozirgicha qoladi (dashboard sotuvlari konteyner zaxirasini kamaytiradi); item_id'ga o'tish — P6, alohida bosqich.

## 10. Xomashyo oqimi (brif §7)

Kirim yagona nuqtadan (mavjud Material Flow «raw-in»): xomashyo → `purpose='raw'` konteyner (+ `raw_materials` sinxron). So'ng ISSUE: konteyner → liniya WIP (RECEIVE yozuvi — yangi majburiy qism). `raw_materials.current_stock` P4'da hisoblanadigan keshga aylanadi (tasdiqlangan P2 yo'nalishi), ungacha tegilmaydi.

## 11. Kelajak sotuv ulanishi (brif §12)

SALES → FINISHED GOODS INVENTORY → CONTAINER BALANCE zanjiri bosqichma-bosqich: hozir sotuv tarixi va logikasi 100% daxlsiz; P2.1 faqat `sale_items.item_id` NULLABLE ustunini qo'shadi (39 orphan NULL qoladi); P6'da (alohida taklif + GO) sotuv iste'moli item-darajali bog'lamga o'tadi. Distribution (savdo bot) katalogi alohida qoladi — ko'prik mavjud sync mexanizmida.

## 12. Audit trail (brif §13)

Brif talabi ↔ hozirgi holat taftishi:

| Talab maydoni | Hozir `stock_movements`da | Yechim |
|---|---|---|
| item ID / SKU | ✗ (faqat matn `product`) | P2.1 `item_id` (+SKU items orqali) |
| quantity / unit | `quantity` bor; birlik item'dan | ✓ P2.1'dan keyin to'liq |
| **kg og'irlik** | **✗ USTUN YO'Q** | R-C: additiv `weight_kg NUMERIC` (nullable) — kg'siz harakat «silent kg o'zgarishi» degani, hozirgi eng katta audit teshigi |
| manba/manzil joy | ✓ from/to_warehouse_id | — |
| movement type | ✓ CHECK (IN/OUT/TRANSFER) | R-C: CHECK'ga `BASELINE` qo'shiladi (3 manbada birga: jonli + bot init_db + API initDb + Drizzle — drift qoidasi) |
| operator | ✓ created_by | — |
| timestamp | ✓ created_at | — |
| **reference** | **✗ (faqat erkin `note`)** | R-C: additiv `reference TEXT` |
| **reason** | **✗** | R-C: additiv `reason TEXT` |

Qoida: inventar qiymatini o'zgartiradigan HAR QANDAY kod yo'li bitta tranzaksiyada harakat yozuvi bilan yozadi (o'qish→UPDATE→audit INSERT + FOR UPDATE — sinalgan qoida). ADJUSTMENT turi bu taklifga KIRMAYDI — u P3'ning alohida taklifi bo'lib qoladi.

## 13. Rollback strategiyasi (brif §17)

**Umumiy qoida (buxgalteriya tamoyili):** bekor qilish ham FAQAT qo'shimcha yozuv orqali — daftar hech qachon o'chirib tozalanmaydi. Harakatlar DELETE qilinmaydi, arxiv DROP qilinmaydi, balanslar «qo'lda tiklanmaydi». Xato — storno (teskari) yozuv bilan tuzatiladi.

| Bosqich | Rollback |
|---|---|
| P2.1 DDL | runbook §6 tayyor (ustunlar DROP, jadvallar DROP) |
| R-A arxiv | rollback KERAK EMAS va TAQIQLANADI — arxiv append-only, hech qachon o'chirilmaydi; xato bo'lsa yoniga yangi vaqt-belgili snapshot olinadi |
| R-B registr | yangi jadvallar xolos → `DROP TABLE physical_baseline_positions, physical_baselines` |
| R-C DDL (BASELINE + 3 ustun) | additiv/nullable → ustun DROP + CHECK'ni eski holatga qaytarish (3 manbada birga) |
| R-C mapping | `positions.item_id = NULL`ga qaytarish + shu bosqichda ochilgan itemlar `active=false` |
| R-D yuklash (konteyner-kesim) | **STORNO**: har asl BASELINE harakatiga teskari BASELINE yozuvi (reference='ROLLBACK <asl reference>', qiymat manbai — legacy sxema); balans shu storno harakatlar orqali avvalgi holatga qaytadi. Asl harakatlar ham, storno ham tarixda qoladi — har konteyner mustaqil, hech narsa o'chirilmaydi |
| R-E jonli oqimlar | git revert (kod) — ma'lumot strukturasi o'zgarmaydi |
| Halokat yo'li | har GO oldidan `pg_dump` + Replit checkpoint olinadi. To'liq tiklash — FAQAT texnik falokat (baza buzilishi) stsenariysi; odatiy «fikr o'zgardi» rollback'i uchun ishlatilmaydi (u storno bilan hal qilinadi) |

## 14. Qolgan (sanalmagan) joylar siyosati (brif §16)

**Bo'sh deb faraz qilinmaydi. Sanoqsiz baseline yozilmaydi.** 27 joy kutmoqda: 6 mintaqaviy ombor + 21 konteyner. Shulardan ERP'da qoldiq KO'RSATAYOTGANLARI (ehtiyot ro'yxati — bular sanalganda C-16/C-17 kabi «bo'sh emas» stsenariysi qo'llanadi):

| Joy | ERP qoldiq | Izoh |
|---|---|---|
| C-01 (raw) | 50 000 dona / 25 000 kg | eng katta sanalmagan zaxira |
| C-03 / C-08 / C-09 / C-13 (raw) | 10 000 / 25 000 / 22 000 / 25 000 dona | kg=0 — dona konvensiyasi |
| C-05 (finished) | 2 055 dona / 10 455.43 kg | |
| Namangan Markaziy (general) | −6 487 dona / −9 303.16 kg | legacy minus — arxivda muzlaydi, «tuzatish» YO'Q |

O'tish davri qoidasi: sanalmagan joylarda joriy operatsiyalar ODATDAGIDEK davom etadi (arxitektura additiv — hech kim to'xtamaydi); har joy O'Z sanog'i kelgach, o'z GO'si bilan baseline'ga o'tadi.

---

## 15. Bosqichlar va darvozalar (yagona jadval)

| # | Bosqich | Nima yoziladi | GO formulasi |
|---|---|---|---|
| P2.1 | Items poydevor DDL | 2 jadval + 2 trigger + 10 nullable ustun | ✅ **BAJARILDI 2026-08-17** (items bo'sh — 94 item R-C'da) |
| R-A | Legacy arxiv | pg_dump + `legacy` sxema nusxalari + yakun tekshiruvi (qator soni/yig'indilar) | ✅ **BAJARILDI 2026-08-17**, 12/12 PASS — R-D'ning majburiy sharti qondirildi |
| R-B | Sanoq registri | `physical_baselines` + `positions` (97 satr — barcha 9 joy pozitsiyali) | ✅ **BAJARILDI 2026-08-17** (9 baseline + 97 pozitsiya, 9.1–9.10 PASS; 95 satrda item_id, 2 EXACT NULL; TM-000022 = 2 lokatsiya; muzlatish triggerlari; jadvallar atayin faqat prod'da — items pretsedenti; hisobot: `docs/r-b-execution-report-2026-08-17.md`) |
| P2.2–2.3 | Katalog backfill | 134 item + mavjud qatorlarga item_id | «P2.2 GO» / «P2.3 GO» |
| R-C | Baseline DDL + item yaratish | `BASELINE` turi, `weight_kg`/`reference`/`reason` ustunlari; **94 yangi item (TM-000001…094)** | ✅ **BAJARILDI 2026-08-17** (id 2–95; pozitsiya→item_id YO'Q — R-B'dan keyin; 2 EXACT yaratilmadi — alohida kandidat; hisobot: `docs/r-c-execution-report-2026-08-17.md`) |
| R-D | Baseline yuklash — **SHART: tekshirilgan R-A** | konteyner-kesim BASELINE harakatlar + inventar (C-16/C-17'da 13 legacy qator ham auditli BASELINE bilan nollanadi) | ✅ **C-15 BAJARILDI 2026-08-17** (3 harakat + 3 satr, 13 020.00 kg, LOADED — `docs/r-d-c15-execution-report-2026-08-17.md`); qolgan 8 konteyner: «R-D GO C-XX» har biri alohida |
| R-E | Jonli oqimlar | ISSUE/RECEIVE, chiqish-joyi tanlovi, purpose nazorati, global VIEW, transformations | «R-E GO» (alohida texnik reja bilan) |
| P6 | Sotuv ulanishi | sale_items item-bog'lam o'qish yo'li | keyinroq, alohida taklif |

Tartib qat'iy emas faqat bitta joyda: R-A istalgan payt (hatto P2.1'dan oldin) bajarilishi mumkin — u faqat nusxa oladi. Lekin TESKARISI QAT'IY: R-D (ayniqsa C-16/C-17 nollashi) tekshirilgan R-A'siz BOSHLANMAYDI (§2.3 qattiq shartlari).

## 16. Egasi qarorlari kutilmoqda

**Hal qilindi (2026-08-16):** ✅ C-15 pozitsiya tafsiloti tasdiqlandi (3 pozitsiya = 13 020.00 kg ✓) · ✅ C-17 qop jami = **279** («259» — manba fayldagi yozuv xatosi).
**Hal qilindi (2026-08-17, v2 strategiya bilan):** ✅ Qop ip ↔ Reja ip — ULANMAYDI, alohida yangi itemlar (xohlasa egasi keyin alias bilan bog'laydi) · ✅ CF 1000D — YANGI itemlar (`TM-000092…094`) · ✅ avto-SKU taqiqi BEKOR — `TM-NNNNNN` tasdiqlandi · ✅ katalogda yo'q pozitsiyalar uchun DEFAULT = yangi item.
**Hal qilindi (2026-08-17, R-C PREP qarorlari):** ✅ R-C = faqat NEYTRAL INSERT — klassifikatsiya bayroqlari YOZILMAYDI, atributlar dashboardda (egasi) · ✅ 2 EXACT — avto-mapping YO'Q, alohida kandidat (R-C tashqarisida) · ✅ pozitsiya→item_id faqat R-B registridan keyin · ✅ R-D MUZLATILGAN (hech qanday nollash yo'q, alohida GO'gacha) · ✅ BASELINE/weight_kg/reference/reason DDL — faqat taklif, GO tarkibida yoziladi (`docs/r-c-final-preview-2026-08-17.md` §6).

| № | Savol | Bloklaydi |
|---|---|---|
| 1 | 2 EXACT nom («Rossiya Tros» 531 kg, «Shroki 3.5 Oq» 676.55 kg): mavjud katalog itemiga ULANADIMI (tarixiy SKU saqlanadi) yoki ular ham YANGI item (TM-000095/096)? **2026-08-17 egasi: avto-mapping QILINMAYDI — alohida kandidat; R-C 94 item bilan cheklanadi, bu savol endi R-C'ni bloklamaydi.** | EXACT'larning o'z taqdiri (keyinroq) |
| 2 | C-16/C-17'dagi 13 legacy inventar qatori R-D'da auditli BASELINE harakati bilan NOLLANADI (arxiv nusxasi legacy sxemada; shu jumladan fizikda topilmagan «Reja ip PP / 50 gr» 100 dona) — tasdiqlaysizmi? | R-D GO C-16/C-17 |
| 3 | C-15 konteyner maqsadi hozir `finished`, ichidagi mol esa sof xomashyo — maqsadi `raw`ga o'zgartirilsinmi? | R-E purpose nazorati (baseline yuklashni bloklamaydi) |
| 4 | Baseline kunida liniyalardagi WIP: sanaladimi yoki liniyalar bo'sh holda kesiladimi? | R-D to'liq yakuni |
| 5 | kg-only pozitsiyalarda (85 ta) `inventory.quantity` = 0 + `weight_kg` = sanoq kg konvensiyasi ma'qulmi? (dona-pozitsiyalarda quantity = dona) **HAL QILINDI (2026-08-17): egasi «R-D GO C-15» bilan tasdiqladi va C-15'da qo'llandi — qolgan konteynerlarga pretsedent.** | ~~R-D yozish formati~~ HAL (C-15 pretsedenti) |
| 6 | Sanoq operatori (`counted_by`) va baseline harakatlarining `created_by` qiymati kim bo'lsin? **R-C qismi HAL QILINDI (2026-08-17): `items.created_by = 'thisismurodov'`. R-B qismi HAL QILINDI (2026-08-17): `counted_by = 'thisismurodov'` — egasi «R-B GO» bilan tasdiqladi; registr shu qiymat bilan yozildi. R-D qismi C-15 uchun HAL QILINDI (2026-08-17): harakatlar `created_by = 'thisismurodov'` — egasi «R-D GO C-15» bilan tasdiqladi; qolgan konteynerlar GO'ida shu pretsedent amal qiladi.** | HAL (C-15 pretsedenti) |
| 7 | Eski Q1–Q10 paketi javoblari (Sholcha, manfiy globallar, dublikat juftliklar…) — endi baselineni BLOKLAMAYDI, legacy katalog tozaligi uchun | dashboard-era |

---

*Holat 2026-08-17 (kech): «R-C GO» va «R-B GO» BAJARILDI. R-C: 94 neytral item (TM-000001…094, id 2–95, `created_by='thisismurodov'`) + §6 DDL, 8.1–8.9 PASS (`docs/r-c-execution-report-2026-08-17.md`). R-B: sanoq registri `physical_baselines` (9) + `physical_baseline_positions` (97: 95 satrda item_id, 2 EXACT NULL, TM-000022 = 2 lokatsiya, jami 71 862.20 kg, `counted_by='thisismurodov'`), 9.1–9.10 PASS, satrlar muzlatish triggerlari bilan qotirilgan (`docs/r-b-execution-report-2026-08-17.md`). Registr jadvallari atayin faqat prod'da (items pretsedenti) — initializer/Drizzle/drift xaritasiga kirmaydi. Chegara qat'iy: 2 EXACT kandidat ochiq (№1), keyingi bosqichga avto-o'tish yo'q.*

*Holat 2026-08-17 (R-D C-15): «R-D GO C-15» BAJARILDI — birinchi konteyner yuklandi: 3 BASELINE harakat (id 625–627) + 3 inventar satri (13 020.00 kg, quantity=0 konvensiyasi, created_by='thisismurodov'), baseline id=9 MAPPED→LOADED. Skript snapshot'dan OLDIN SHARE ROW EXCLUSIVE qulflar + LATCH + 9.1–9.10 COMMIT-oldi tekshiruvlari bilan; mashqda dublikat-GO bloki va qulf probasi isbotlandi — `docs/r-d-c15-execution-report-2026-08-17.md`. Qolgan 8 konteyner (C-20/19/18/02/04/06/16/17) MUZLATILGAN — har biriga alohida «R-D GO C-XX»; C-16/C-17 GO'sida №2 nollash tasdiqlanadi, №4 R-D to'liq yakunida, №3/№7 ochiq. №5 va №6 to'liq HAL (C-15 pretsedenti).*

*Biz taxmin qilmaymiz. Biz bilamiz.*
