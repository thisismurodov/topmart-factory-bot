# OMBOR QAYTA QURISH — IJRO TAKLIFI (Inventory Reset Implementation Proposal)

*Sana: 2026-08-16 · Holat: **FAQAT TAKLIF — bazaga hech narsa yozilmadi.** Manba topshiriq: `attached_assets/Pasted-TOPMART-ERP-INVENTORY-RESET-PRODUCTION-WAREHOUSE-ARCHIT_1786905730862.txt` (egasining 17 bo'limlik arxitektura brifi, 14 bandlik taklif talabi bilan).*

> **DARVOZA:** Ushbu hujjatdagi HAR BIR yozuv bosqichi egasining alohida, aniq GO buyrug'ini kutadi.
> Ungacha ruxsat etilgan yagona ish — read-only tahlil va hujjatlashtirish. Bu talab brifning
> §15/§17 bandlariga to'g'ridan-to'g'ri javob: NO DATABASE WRITE YET · FIRST PRODUCE THE PROPOSAL.

Asos hujjatlar (barchasi kuchda qoladi, bu taklif ULARNI BEKOR QILMAYDI, kengaytiradi):
- `docs/p2-items-foundation-proposal.md` — kanonik items modeli (egasi 2026-08-15 shartlar bilan TASDIQLAGAN)
- `docs/p2-1-execution-runbook.md` + `scripts/sql/p2.1-items-foundation.sql` — P2.1 DDL (KUTMOQDA, GO yo'q)
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
| 2. `legacy` sxema | `CREATE SCHEMA legacy` + kesim jadvallar: `legacy.inventory_baseline_pre` (43 qator), `legacy.raw_material_stock_pre` (17), `legacy.wip_balances_pre` (liniya kesimi), `legacy.container_summary_pre` (9 band ombor) — har birida `archived_at` va manba izohi |
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
3. **C-16/C-17 maxsus holati (ERP bo'sh emas):** bu yerda ikki tushunchani qat'iy ajratamiz:
   - **Tarixiy YOZUV** (eski ERP nimaga ishongan: 90 180 / 149 980 dona) — `legacy` sxemada + baseline'dan oldingi harakatlar tarixida ABADIY, O'ZGARMAS saqlanadi. U hech qachon yangilanmaydi, o'chirilmaydi, «tiklanmaydi».
   - **Joriy balans qatori** (`inventory`) — bu tarixiy hujjat emas, joriy holat ko'rsatkichi; u kelajakda ham har bir IN/OUT bilan o'zgarib turadi. Baseline kunida u FAQAT auditli BASELINE harakati orqali (harakat + balans bitta tranzaksiyada) fizik qiymatga keladi; harakatning `reference` = sanoq hujjati, `reason` = eski ERP qiymati.
   Ya'ni tarixiy balans QAYTA YOZILMAYDI — u arxivda qoladi; joriy balans esa faqat harakat-hujjat bilan o'zgaradi (kelajakdagi barcha o'zgarishlar kabi). Qatorni harakatsiz «to'g'irlab qo'yish» MUTLAQO TAQIQLANADI. *(Muqobil variant — legacy'ni OUT harakati bilan nolga tushirish — RAD ETILADI: soxta chiqim tarixini yaratadi, brif §17 taqiqiga zid.)*
4. Yuklash KONTEYNER-KESIMDA, har biriga alohida GO (masalan «R-D GO C-20»). Hammasi birdan emas.

## 3. Kanonik item / SKU mapping (brif §5, §9)

Tasdiqlangan P2 modeli o'zgarishsiz qo'llanadi: immutable `items.id` + immutable SKU + qobiliyat bayroqlari (`is_raw/is_intermediate/is_finished/is_purchasable/is_producible/is_sellable/inventory_tracked` — brif §9 «capability flags» talabiga aynan javob) + `item_aliases` (rename o'rniga).

| Manba | Soni | Qoida |
|---|---|---|
| Mavjud mahsulotlar | 117 | 1:1 backfill, SKU aynan ko'chiriladi, MERGE YO'Q |
| Mavjud xomashyolar | 17 | 1:1 backfill, `RM-…` SKU taklifi |
| Fizik pozitsiyalar (C-20…C-06) | 82 | EXACT 2 · POSSIBLE 15 · UNMATCHED 65 — har biri EGASI qarori bilan: mavjud itemga ulash YOKI yangi item (source_kind='physical_count') |
| Fizik pozitsiyalar (C-16/C-17) | 12 | C-16 nomlari ERP bilan bir oila; C-17'da **«Qop ip N gramm RANG» ↔ ERP «Reja ip N gr / RANG»** — to'r bir xil, nom oilasi har xil → egasi qarori (Q-jadval №3) |
| C-15 pozitsiyalari (2026-08-16) | 3 | «Polipropilen CF 1000D Qizil/Ko'k/Sariq» — 17 xomashyo nomida EXACT mos YO'Q (jonli tekshirildi); yangi item YOKI mavjud PP oilasiga ulash — egasi qarori (SKU hozircha yaratilmaydi) |

Avto-merge, avto-SKU, avto-rename — MUTLAQO YO'Q. Dublikat juftliklar (QP100↔QOP-IP-100-TALIK va h.k.), dual egizaklar (4), Sholcha oilasi — Q1–Q10 paketidagi qarorlar bilan birga hal qilinadi.

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
| P2.1 | Items poydevor DDL | 2 jadval + 2 trigger + 10 nullable ustun (TAYYOR: runbook + SQL) | «P2.1 GO» |
| R-A | Legacy arxiv | pg_dump + `legacy` sxema nusxalari | «R-A GO» |
| R-B | Sanoq registri | `physical_baselines` + `positions` (97 satr — barcha 9 joy pozitsiyali) | «R-B GO» |
| P2.2–2.3 | Katalog backfill | 134 item + mavjud qatorlarga item_id | «P2.2 GO» / «P2.3 GO» |
| R-C | Baseline DDL + mapping | `BASELINE` turi, `weight_kg`/`reference`/`reason` ustunlari; pozitsiya↔item qarorlari (egasi bilan) | «R-C GO» |
| R-D | Baseline yuklash | konteyner-kesim BASELINE harakatlar + inventar | «R-D GO C-20» … har biri alohida |
| R-E | Jonli oqimlar | ISSUE/RECEIVE, chiqish-joyi tanlovi, purpose nazorati, global VIEW, transformations | «R-E GO» (alohida texnik reja bilan) |
| P6 | Sotuv ulanishi | sale_items item-bog'lam o'qish yo'li | keyinroq, alohida taklif |

Tartib qat'iy emas faqat bitta joyda: R-A istalgan payt (hatto P2.1'dan oldin) bajarilishi mumkin — u faqat nusxa oladi.

## 16. Egasi qarorlari kutilmoqda

**Hal qilindi (2026-08-16):** ✅ C-15 pozitsiya tafsiloti keldi va tasdiqlandi (3 pozitsiya = 13 020.00 kg ✓) · ✅ C-17 qop jami = **279** tasdiqlandi (qator ma'lumotlari to'g'ri edi, «259» — manba fayldagi yozuv xatosi).

| № | Savol | Bloklaydi |
|---|---|---|
| 1 | C-17 nomlari: fizik «Qop ip N gramm» ERP'dagi «Reja ip N gr» itemlariga ULANADIMI yoki YANGI itemlar ochiladimi? | R-C mapping |
| 2 | C-15 pozitsiyalari «Polipropilen CF 1000D (Qizil/Ko'k/Sariq)» xomashyo katalogida aynan mosi yo'q: YANGI itemlar ochiladimi yoki mavjud PP oilasiga ulanadimi? | R-C mapping |
| 3 | C-15 konteyner maqsadi hozir `finished`, ichidagi mol esa sof xomashyo — maqsadi `raw`ga o'zgartirilsinmi? | R-E purpose nazorati (baseline yuklashni bloklamaydi) |
| 4 | Baseline kunida liniyalardagi WIP: sanaladimi yoki liniyalar bo'sh holda kesiladimi? | R-D to'liq yakuni |
| 5 | kg-itemlarda `quantity` maydoni semantikasi: o'ram/karobka soni yoki 0? (C-15 uchun ayniqsa dolzarb — faqat kg berilgan) | R-D yozish formati |
| 6 | Baseline harakatlarining `created_by` operatori kim bo'lsin? | R-D |
| 7 | Eski Q1–Q10 paketi javoblari (Sholcha, manfiy globallar, dublikat juftliklar…) | R-C'dagi tegishli pozitsiyalar |

---

*Hech narsa bajarilmadi. Barcha 9 joy pozitsiya darajasida to'liq — tavsiya etiladigan birinchi qadamlar: «P2.1 GO» va «R-A GO» (ikkalasi ham eng past xavfli, qaytariladigan bosqichlar).*

*Biz taxmin qilmaymiz. Biz bilamiz.*
