# Diyor Mahsulotlari ERP — Canonical Inventory/SKU/BOM arxitektura auditi

**Sana:** 2026-08-14 · **Holat:** TASDIQ KUTILMOQDA — hech qanday kod yozilmadi, hech qanday ma'lumot o'zgartirilmadi.
**Manba:** jonli Railway bazasi (faqat o'qish rejimida) + to'liq kod auditi + mustaqil arxitektura ko'rigi.

---

## 0. Xulosa (Executive Summary)

1. **SKU allaqachon yarim yo'lda:** `products` jadvalida `sku` ustuni bor, **117/117 mahsulotda to'ldirilgan** va unikal indeks bilan himoyalangan. Lekin **birorta tranzaksiya jadvali SKU'dan foydalanmaydi** — hammasi mahsulot NOMI (matn) orqali bog'langan.
2. **Ikkita (aslida uchta) mustaqil katalog bor:** `products` (117), `raw_materials` (17), `distribution.mahsulotlar` (69, savdo bot). "Bitta mahsulot = bitta identity" printsipi hozir buzilgan: **4 ta material ikkala katalogda bir vaqtda mavjud** (Cord Maloshni, Babin Sariq 0.5, Babin Qora 0.5, Kanob) — bu hujjatdagi "PP 1500D" muammosining jonli isboti.
3. **Xomashyoni to'g'ridan-to'g'ri sotib bo'lmaydi** — sotuv faqat `products` katalogidan ishlaydi. Shu sabab 4 ta xomashyo products'ga nusxa qilingan (dublikat identity).
4. **Transformation (material → material) tushunchasi umuman yo'q** — twist kabi jarayonni hozir faqat qo'lda "adjustment" bilan soxtalashtirish mumkin, audit izi yo'qoladi.
5. **Global xomashyo qoldig'i konteynerlardan MUSTAQIL raqam:** 5 ta xomashyoda global qoldiq MANFIY (eng og'iri: Polipropilen 2×1500/OQ = **−12 092 kg**), konteyner darajasida esa faqat 1 ta yozuv bor (Sholcha 25 000 kg). Bu §14 talabining to'liq buzilishi.
6. **WIP daftarida faqat PRODUCE yozuvlari bor (167 ta, 8 811 kg), birorta RECEIVE yo'q** — "Bo'limga berish" oqimi hech qachon ishlatilmagan, Arqon Bo'lim 3 balansi **−8 811 kg**.
7. **BOMsiz partiya bloklanmaydi:** bot BOM yozuvlarini faqat ayirish hisobi uchun o'qiydi — BOM bo'lmasa partiya hech narsa ayirmasdan jim o'tib ketadi. "Manufactured + Active BOM yo'q = xato" qoidasi (canonical qoida 7) hozir amalda YO'Q.
8. **Partiya chiqishi istalgan faol omborga tushishi mumkin:** bot ombor tanlovida "finished konteyner" majburiyatini tekshirmaydi (tanlanmasa — birinchi faol ombor). Raw yoki viloyat omboriga tayyor mahsulot yozilib qolishi mumkin.
9. **WIP himoyasi liniya orqali ishlaydi:** liniya mahsulotdan (`line_id`) yoki ishlab chiqargan ishchining liniyasidan aniqlanadi. 108/117 mahsulot liniyasiz — ular ishchi liniyasiga tayanadi; ishchi ham liniyaga bog'lanmagan bo'lsa, partiya WIP hisobidan butunlay chetda qoladi.
10. Yaxshi tomonlar ham bor: bot partiyasi **atomik** (BOM ayirish + WIP + tayyor ombor + harakat + partiya + ish haqi bitta tranzaksiyada, FOR UPDATE qulflar bilan); BOM'da orphan yo'q; BOM material tomoni allaqachon **ID orqali** bog'langan (faqat mahsulot tomoni nom orqali).
11. **Xulosa:** to'liq rewrite KERAK EMAS. Mavjud arxitektura canonical modelga ~60% mos. Yetishmayotgani: yagona item-master, tranzaksiyalarni ID'ga o'tkazish, transformation obyekti, WIP'ni lokatsiya sifatida hisobga oluvchi yagona qoldiq formulasi, va reconciliation.

---

## A. Hozirgi sxema auditi (koddan)

### A.1 Master-data jadvallari

| Jadval | Kalit | Muhim ustunlar | Izoh |
|---|---|---|---|
| `products` (117) | **name TEXT PK** (+ id serial unique) | sku (unikal, to'ldirilgan), unit_type (dona/kg), rate/rate_type/payroll_method (ish haqi), currency_type, default_sale_price, weight, salary/electricity/other_cost, minimum_stock, pieces_per_box, **in_sales**, **in_production**, active, line_id | Capability bayroqlar allaqachon boshlangan (savdo/ishlab chiqarish moduli) |
| `raw_materials` (17) | id serial PK, name unique | unit(kg), default_cost + currency (UZS/USD CHECK), **current_stock (global kesh)**, minimum_stock, active | Global qoldiq konteynerlardan hisoblanmaydi — mustaqil raqam |
| `product_materials` = BOM (62) | unique(product_name, raw_material_id) | **product_name TEXT (nom!)**, **raw_material_id INT (ID ✓)**, quantity_required (0.001 aniqlik) | Yarim-yarim: material tomoni ID, mahsulot tomoni nom |
| `warehouses` (36) | id PK | location_type (general/container), purpose (raw/finished), capacity_kg | 6 viloyat + 24 finished + 6 raw konteyner |
| `production_lines` (5) | id PK | name | Arqon Bo'lim 3, Lenta 1, Qop Ip, Arqon Bo'limi, Naycha |
| `product_price_tiers`, `sales_product_tiers` | | narx pog'onalari | |
| `distribution.mahsulotlar` (69) | id PK | nomi, narx, birlik, faol, **sku (o'z ustuni!)** | Savdo bot katalogi — ERP bilan faqat NOM orqali ko'prik |

### A.2 Tranzaksiya jadvallari

| Jadval | Item bog'lanishi | Izoh |
|---|---|---|
| `inventory` | **product TEXT** + warehouse_id, unique(warehouse, product) | quantity + weight_kg + product_type (raw/finished) |
| `stock_movements` | **product TEXT** | movement_type IN/OUT (+TRANSFER inventory-v2 orqali), from/to warehouse NULL bo'lishi mumkin |
| `wip_movements` | **raw_material TEXT / product TEXT** | line_id, RECEIVE/PRODUCE, batch_id, weight_kg |
| `batches` (274) | **product TEXT** | batch_code, worker TEXT, quantity, weight_kg, earnings, production_line_id |
| `sales` + `sale_items` (45/143) | **product_name TEXT** | sale_items'da og'irlik ustuni YO'Q; currency har item'da |
| `sale_payments`, `sale_events`, `audit_logs`, `wip_negative_alerts` | — | qo'shimcha daftarlar |

**Muhim:** `inventory`, `stock_movements`, `wip_movements` va boshqa runtime jadvallar Drizzle emas, **bot `init_db` (Python) VA API `initDb` (TS)** tomonidan idempotent DDL bilan yaratiladi — har qanday sxema o'zgarishi IKKALA joyga birga kiritilishi shart (aks holda yangi baza buziladi; buni `schema-drift` tekshiruvi qo'riqlaydi).

### A.3 Identity mexanizmi bugun

```
products.name (TEXT PK) ─────────┬─< product_materials.product_name
                                 ├─< batches.product
                                 ├─< inventory.product
                                 ├─< stock_movements.product
                                 ├─< wip_movements.product / .raw_material
                                 └─< sale_items.product_name
raw_materials.id ────────────────┴─< product_materials.raw_material_id (yagona ID-bog'lanish!)
products.sku ──────────────────────  HECH QAYERDA ishlatilmaydi (faqat katalog ko'rinishi)
```

**Nom o'zgartirish oqibati bugun:** mahsulot nomi o'zgarsa BOM, ombor, tarix, sotuvlar zanjiri uziladi. (Xomashyo tomonida esa rename allaqachon himoyalangan — API xomashyo nomini o'zgartirganda tarixiy ledger yozuvlarini ham yangi nomga ko'chiradi.)

### A.4 Yozish yo'llari (inventory'ga kim yozadi?)

1. **Bot partiyasi** (`create_batch_session`) — atomik: BOM bo'lsa global raw −, WIP PRODUCE (liniya mahsulotdan yoki ishchidan aniqlansa), tayyor ombor +, stock_movements, partiya, ish haqi. FOR UPDATE qulflar. Kamchiliklar: BOMsiz ham o'tadi (hech narsa ayirmay); ombor tanlovi finished-konteyner bilan cheklanmagan; xomashyo ayirmasi faqat global (konteynersiz).
2. **Dashboard "Ish jarayoni"** — raw-in (konteyner+global sinxron ✓), bo'limga berish (konteyner guard ✓), tayyor chiqarish (WIP+ombor, lekin BOM/ish haqi YO'Q).
3. **`inventory-v2` umumiy movement API** — IN/OUT/TRANSFER, og'irlikni taxmin qiladi, 0 dan pastga tushirmaydi (GREATEST(0,...)), global raw qoldiqqa TEGMAYDI → raw uchun ishlatilsa drift.
4. **Sotuv** — eng katta qoldiqli ombordan kamaytiradi, yetmasa asosiy omborga MANFIY yozadi.
5. **Xomashyo formasi/adjust** — faqat global current_stock'ni o'zgartiradi, harakat omborsiz (NULL) yoziladi → konteyner bo'sh qoladi. **§14'ning asosiy buzilishi shu yerda.**

---

## B. Hozirgi ma'lumotlar auditi (jonli baza, 2026-08-14)

### B.1 Umumiy raqamlar

| Ko'rsatkich | Qiymat |
|---|---|
| Mahsulotlar | 117 (63 dona, 54 kg) — hammasi active, hammasi in_production, 58 in_sales, **117 SKU to'ldirilgan**, 108 liniyasiz |
| Xomashyolar | 17 (hammasi kg; 13 USD, 4 UZS narxda) |
| BOM | 62 qator, 59 mahsulot, 16 xomashyo; 3 ta gibrid (2 materialli); miqdorlar 0.020–6.000; **orphan yo'q** |
| Omborlar | 36 = 6 viloyat (general/finished) + 24 finished konteyner + 6 raw konteyner |
| Inventory | 43 qator: 1 raw ✓, 37 finished, **5 ta "finished" qator RAW konteynerlarda** (anomaliya) |
| WIP | 167 PRODUCE (8 811 kg), **0 RECEIVE**; Arqon Bo'lim 3 = **−8 811 kg** |
| Harakatlar | IN finished 296 · OUT raw 274 (hammasi **omborsiz** — global BOM ayirmalari) · OUT finished 37 · IN raw 1 |
| Partiyalar | 274 (2026-06-24 → 2026-08-13), 14 mahsulot, 85 651 dona / 11 568 kg; 69 tasi liniyasiz |
| Sotuvlar | 45 (2026-06-05 → 2026-07-03), 143 item, 95 nom |

### B.2 Mahsulotlarning REAL tasnifi (dalillar matritsasi)

| BOM bor | Ishlab chiqarilgan | Sotilgan | in_sales | Soni | Ehtimoliy turi |
|---|---|---|---|---|---|
| — | — | — | ✓ | **53** | Purchased/Resale (savdo katalogi importi) |
| ✓ | — | ✓ | — | **38** | Manufactured (partiya hali kiritilmagan) |
| ✓ | ✓ | ✓ | — | **10** | Faol Manufactured |
| ✓ | — | ✓ | ✓ | 4 | Manufactured + savdo modulida |
| ✓ | ✓ | — | — | 4 | Manufactured (hali sotilmagan) |
| ✓ | — | — | — | 3 | Manufactured (yangi) |
| — | — | ✓ | — | 3 | Purchased/Resale dalili |
| — | — | ✓ | ✓ | 1 | Purchased/Resale |
| — | — | — | — | 1 | O'lik yozuv (tekshirish kerak) |

**Xulosa:** 59 Manufactured + ~57 Purchased/Resale + 1 noma'lum. Hujjatdagi "117 mahsulot = 117 BOM emas" qoidasi ma'lumotlar bilan tasdiqlandi — **BOM yo'qligi xato emas**, 53+ mahsulot chakana savdo importi. DIQQAT: bu tasnif faqat DALIL, avtomatik qo'llanmaydi — yakuniy `is_manufactured`/`is_purchased` belgilarini egasi tasdiqlaydi (ayniqsa BOMsiz partiya bloklanmagani uchun "ishlab chiqarilgan = manufactured" degani hali ishonchli emas).

### B.3 Dual-identity holatlar (jonli "PP 1500D" misollari)

| Item | products'da | raw_materials'da | Sotilganmi | Global qoldiq |
|---|---|---|---|---|
| Cord Maloshni | ✓ (CRDMSH) | ✓ (id 7) | ✓ | 0 |
| Babin Sariq 0.5 mm | ✓ (BABSA/05) | ✓ (id 10) | ✓ | **−1 845** |
| Babin Qora 0.5 mm | ✓ (BABQO/05) | ✓ (id 11) | ✓ | **−1 019** |
| Kanob | ✓ (Kanoblar) | ✓ (id 16) | ✓ | 0 |
| Sholcha (xomashyo) ↔ Sholcha Oq / Sholcha Sariq (mahsulotlar) | 2 ta variant | 1 ta | — | 25 000 |

Bular xomashyo sotish uchun katalogga QO'LDA nusxalangan — ikkala yozuvning qoldig'i bir-biridan bexabar. Canonical modelda bu **bitta item** bo'ladi (`is_raw + is_saleable`).

### B.4 Ma'lumot sifati muammolari

| # | Muammo | Ko'lam |
|---|---|---|
| D1 | Global xomashyo qoldig'i manfiy | 5 ta: P2×1500/OQ −12 092; Babin Sariq 0.5 −1 845; Babin Qora 0.5 −1 019; Qop ip −255; PP BSF −117 |
| D2 | Konteyner-darajali xomashyo deyarli yo'q | 1/17 materialda bor (Sholcha); Babin Sariq 0.4: global 5 000, konteyner 0 |
| D3 | RAW konteynerlarda "finished" qatorlar | 5 qator (Sholcha Oq/Sariq C-01/03/08/09/13, 107 000 birlik, og'irlik 0) |
| D4 | Manfiy tayyor inventory | 20 qator (hammasi Namangan Markaziy — sotuv manfiy fallback) + 3 manfiy kg |
| D5 | WIP RECEIVE'siz PRODUCE | 167 yozuv, Arqon Bo'lim 3 = −8 811 kg; WIP balansi himoyasi endi shu liniyada yangi partiyani to'sadi |
| D6 | Sotuvlarda valyuta tartibsizligi | 'usd'/'USD'/'uzs'/'UZS' aralash; 30 item valyutasi ota-sotuvnikidan farq qiladi; USD deb yozilgan ~260 mln qiymatlar (aslida UZS bo'lishi ehtimol) — hisobotlarni buzadi |
| D7 | Sotilgan 39 nom katalogda yo'q | Rename/o'chirish izlari: "PP 2 x 1500 OQ" vs "PP 2 x 1500 / OQ", "Dvaynoy 4/5/6 kg"... |
| D8 | Nom dublikatlari | "Qop ip - 80 talik"/"Qop ip 80 talik", "Qop Ip - 100 talik"/"Qop ip 100 talik" |
| D9 | 108/117 mahsulot liniyasiz | Liniya ishchi orqali aniqlanadi (products.line_id bo'lmasa); ishchi ham liniyasiz bo'lsa partiya WIP hisobidan chetda; 69/274 partiya liniyasiz yozilgan |
| D10 | sale_items'da og'irlik yo'q | kg-mahsulot sotuvida og'irlik tarixi yo'qoladi |

---

## C. Gap tahlili — hozirgi vs canonical

| # | Canonical talab | Hozirgi holat | Baho |
|---|---|---|---|
| 1 | Yagona Item/SKU master | 2 master (products, raw_materials) + distribution katalogi | ✗ |
| 2 | SKU immutable identity, tranzaksiyalar SKU orqali | SKU bor va to'ldirilgan, lekin 0 ta tranzaksiya ishlatadi; name=PK | ✗ (poydevor tayyor) |
| 3 | Capability model (is_raw/is_manufactured/is_purchased/is_intermediate/is_saleable) | in_sales/in_production bor — qisman | ◐ |
| 4 | Inventory = Item + Location + Qty; WIP ham hisobda ko'rinadigan lokatsiya | Bor, lekin item=nom; WIP alohida daftar, global qoldiq bilan bog'lanmagan | ◐ |
| 5 | Qoldiqning yagona haqiqat manbai (ledger → lokatsiyalar → global) | Global raw qoldiq mustaqil kesh; forma orqali qo'lda o'zgartiriladi | ✗ |
| 6 | Yagona inventory ledger, boy movement type'lar + reference | 2 daftar (stock_movements IN/OUT + wip_movements) + reference yo'q | ◐ |
| 7 | Transformation obyekti | Yo'q | ✗ |
| 8 | Production tranzaksiyasi atomik | Bot partiyasi ✓ atomik; dashboard "Tayyor chiqarish" alohida qisman oqim | ◐ |
| 9 | WIP item kesimida | Yozuvlarda material/mahsulot nomi bor, balans esa liniya bo'yicha jami kg | ◐ |
| 10 | Purchased flow (Purchase → Inventory → Sale) | Purchase obyekti yo'q; generik IN bilan kiritiladi | ◐ |
| 11 | SKU ≠ Batch | batches alohida ✓, lekin traceability bog'lari (batch→inventory→sale) yo'q | ◐ |
| 12 | Tolerance (standard/min/max kg) SKU konfiguratsiyasida | Sxemada yo'q | ✗ |
| 13 | Barcode/Label (SKU/Batch/Label ayrim) | Yo'q (kelajak) | ✗ |
| 14 | Master vs Transaction ajratilgan | Asosan ✓ | ✓ |
| 15 | Raw/WIP/Finished — holat, identity emas | purpose/product_type sifatida bor, lekin dual-identity nusxalash amaliyoti buni buzgan | ◐ |
| 16 | Manufactured + Active BOM validatsiyasi (qoida 7) | Yo'q — BOMsiz partiya jim o'tadi, hech narsa ayirilmaydi | ✗ |
| 17 | Partiya chiqishi faqat finished lokatsiyaga | Yo'q — istalgan faol ombor qabul qilinadi (default: birinchi faol) | ✗ |

---

## D. Migratsiya risk reestri

| # | Risk | Og'irlik | Izoh |
|---|---|---|---|
| R1 | Nom-kalitli tarix: 6 jadvalda item=TEXT | Yuqori | SKU'ga o'tishda 39 orphan sotuv nomi + rename variantlari qo'lda mapping talab qiladi |
| R2 | Dual-identity itemlar (4 + Sholcha oilasi) | Yuqori | Ikki katalogdagi tarixni bitta itemga birlashtirish — egasi qarori kerak |
| R3 | Manfiy qoldiqlar (D1, D4, D5) | Yuqori | Yagona qoldiq formulasiga o'tishdan OLDIN reconciliation shart, aks holda farq muzlab qoladi |
| R4 | Konteyner qoldiqlari yo'q (D2) | Yuqori | Haqiqiy inventarizatsiya (sanash) kerak — tizim buni o'ylab topa olmaydi |
| R5 | Qoldiq formulasi WIP'ni unutsa — yangi xato tug'iladi | Yuqori | Hozirgi semantikada material bo'limga berilganda ham globalda turadi (ayirish faqat partiyada). "Global = SUM(konteyner)" deb olinsa, WIP'dagi material "yo'qoladi" yoki ikki marta ayiriladi. To'g'risi: **Global on-hand = konteynerlar + WIP lokatsiyasi**, harakatlar miqdorni lokatsiyalar orasida SAQLAB ko'chiradi |
| R6 | `products.name` = PK, API marshrutlari nom bilan | O'rta | ID'ga o'tish bot + dashboard + field'da birga qilinishi kerak (breaking) |
| R7 | 4 ta parallel yozish yo'li | O'rta | Har fazada hamma yo'l birga o'tkaziladi, aks holda drift |
| R8 | Runtime DDL ikki joyda (bot init_db + API initDb) | O'rta | Har bir yangi jadval/ustun IKKALA initializer'ga idempotent qo'shilmasa yangi baza buziladi — bu P2'ning KIRISH SHARTI, test emas |
| R9 | SKU unikalligi global emas | O'rta | Hozirgi `uniqueProductSku` faqat products ichida tekshiradi; items.sku uchun butun to'plam (products ∪ raw ∪ distribution mapping) bo'ylab yagona ajratish jarayoni kerak, aks holda backfill'da kolliziya |
| R10 | Valyuta tartibsizligi (D6) | O'rta | SKU migratsiyasiga to'siq emas, lekin hisobotlar noto'g'ri — alohida tozalash |
| R11 | Distribution katalogi (69, 60 tasi nom bo'yicha mos) | O'rta | SKU ko'prik kalitiga aylanishi kerak, hozir nom |
| R12 | Dublikatlar (D8) va sale_items'da og'irlik yo'qligi (D10) | Past | Merge qarori + ustun qo'shish |

---

## E. Canonical ER modeli (maqsad) va minimal-migratsiya strategiyasi

### E.1 Tanlangan yo'l: **yangi `items` jadvali — additiv, buzmaydigan**

Ko'rib chiqilgan 2 variant:
- **A (tavsiya):** yangi `items` master; `products`/`raw_materials` PROFIL jadvallariga aylanadi (item_id FK oladi). Hamma mavjud oqim ishlashda davom etadi, ustunlar qo'shiladi, hech narsa o'chirilmaydi. Har bosqich qaytarilishi mumkin.
- **B (rad etildi):** `raw_materials`'ni `products` ichiga singdirish. Sabab: products'dagi ish haqi/narx maydonlari xomashyoga yot; `in_production DEFAULT TRUE` xomashyolarni ishlab chiqarish ro'yxatlariga qo'shib yuboradi; bot va payroll oqimlariga katta xavf.

### E.2 Maqsadli ER diagramma

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
                                           │           │
        ┌──────────────────────────────────┴──┐   ┌────┴──────────────────────────┐
        │ BOM (product_item_id → items,       │   │ INVENTORY (item_id,           │
        │ material_item_id → items,           │   │ warehouse_id) UNIQUE          │
        │ qty_per_unit 0.001)                 │   │ qty + weight_kg               │
        └─────────────────────────────────────┘   └────┬──────────────────────────┘
                                                        │        WAREHOUSES (36):
                                                        │        general/container ×
                                                        │        raw/finished
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

**Qoldiq saqlanish printsipi (miqdor yo'qolmaydi):**

```text
Global on-hand (item) = Σ konteyner qoldiqlari (item) + Σ WIP qoldiqlari (item)

WIP_ISSUE:               konteyner −X  →  WIP +X        (global O'ZGARMAYDI)
PRODUCTION_CONSUMPTION:  WIP −X                          (global −X)
PRODUCTION_OUTPUT:       finished konteyner +Y           (tayyor item +Y)
TRANSFORMATION:          manba lokatsiya −X → yangi item +X
SALE:                    lokatsiya −X                    (global −X)
```

Bu hozirgi semantikaga mos: material bo'limga berilganda hali "bor" hisoblanadi, faqat partiya iste'molida kamayadi. `raw_materials.current_stock` shu formulaning KESHI bo'lib qoladi (bir tranzaksiyada yangilanadi + kunlik reconciliation hisoboti), operator formadan bevosita o'zgartira olmaydi — faqat ADJUSTMENT (majburiy izoh + audit) orqali.

### E.3 Mavjud jadvallarga mapping (minimal delta)

| Canonical | Amalga oshirish | Yangi/O'zgarish |
|---|---|---|
| ITEMS | Yangi jadval; backfill: 117 product + 17 raw − 4 dual − (Sholcha qarori) ≈ **129–130 item** | Yangi |
| SKU | products.sku ko'chiriladi; raw'larga SKU **global ajratish jarayoni** bilan beriladi: unikallik butun items to'plami bo'ylab tekshiriladi (hozirgi `uniqueProductSku` faqat products ichida qaraydi — yetarli emas); distribution.sku moslashtiriladi | Mavjud poydevor + yangi allocator |
| BOM | product_materials'ga product_item_id + material_item_id (nullable) → backfill → keyin NOT NULL | Ustun qo'shish |
| Inventory/Ledger/WIP/Batches/Sale_items | har biriga item_id nullable ustun + backfill + dual-write | Ustun qo'shish |
| Transformation | yangi jadval + 2 ledger yozuvi (atomik) | Yangi |
| Purchase | ledger'da PURCHASE type + ref (alohida jadval shart emas, kelajakda qo'shilishi mumkin) | Kengaytma |
| Manufactured+BOM validatsiyasi | `is_manufactured=true` va faol BOM yo'q bo'lsa partiya bloklanadi (canonical qoida 7) — bot va API'da bir xil | Yangi qoida |
| Partiya chiqish lokatsiyasi | faqat `purpose='finished'` konteyner qabul qilinadi (default taklif bilan) | Yangi qoida |
| Tolerance | products profiliga standard_kg/min_kg/max_kg (bot partiyada tekshiradi) | Ustun qo'shish |
| Barcode/Label | alohida bosqich — arxitektura joyi ajratilgan (SKU/Batch/Label uchlik) | Kelajak |

---

## F. 10 real biznes-stsenariy simulyatsiyasi

Belgi: 🔴 bugun ishlamaydi · 🟡 qisman · 🟢 ishlaydi. "PP 1500D" = bazadagi "Polipropilen 2 x 1500 / OQ".

### S1. PP 1500D → Direct Sale (500 kg) — 🔴 bugun / 🟢 canonical
Bugun: xomashyo sotuvda mavjud emas; buning uchun 4 ta material products'ga nusxalangan (qoldiqlar ajralgan).
Canonical (PP-1500D: is_raw + is_saleable):
| Joy | Oldin | Harakat | Keyin |
|---|---|---|---|
| C-01 (PP-1500D) | 10 000 kg | SALE −500 (ref: sale#) | 9 500 kg |
| Global (hisoblanadi) | 10 000 | = Σ lokatsiyalar | 9 500 |

### S2. PP 1500D → Twist → Twisted Yarn (800 kg) — 🔴 bugun / 🟢 canonical
Bugun: transformation yo'q; faqat ikki tomonlama qo'lda adjustment (audit izi yo'q).
Canonical (bitta atomik tranzaksiya, TRANSFORMATION_IN/OUT):
| Joy | Oldin | Harakat | Keyin |
|---|---|---|---|
| C-01 PP-1500D | 9 500 | TRANSFORM_IN −800 | 8 700 |
| C-04 TW-1500D | 0 | TRANSFORM_OUT +800 | 800 |

### S3. PP 1500D → Tulpor (50 dona, BOM 3 kg/dona) — 🟡 bugun / 🟢 canonical
Bugun bot partiyasi: global raw −150 ✓, WIP PRODUCE ✓ (liniya aniqlansa), tayyor ombor +50 dona ✓, ish haqi ✓ — LEKIN konteyner darajasida xomashyo kamayMAYDI (omborsiz OUT) va chiqish ombori finished-konteyner deb tekshirilmaydi.
Canonical:
| Joy | Oldin | Harakat | Keyin |
|---|---|---|---|
| Liniya WIP PP-1500D | 300 | PROD_CONSUMPTION −150 | 150 |
| C-02 TULPOR-003 | 0 | PROD_OUTPUT +50 dona/+150 kg | 50 dona / 150 kg |

### S4. Twisted Yarn → Arqon bo'limi (300 kg) — 🟡 bugun / 🟢 canonical
Bugun "Bo'limga berish" ishlaydi, LEKIN konteynerda qoldiq bo'lsa (hozir konteynerlar bo'sh — real to'siq) va WIP balansi liniya bo'yicha jami kg (material kesimida emas).
Canonical: C-04 TW-1500D 800→500; Arqon WIP TW-1500D 0→300 (item kesimida); global o'zgarmaydi (lokatsiyalararo ko'chirish).

### S5. PP CF (1.7) + PP BCF (1.6) → Hybrid (100 dona) — 🟢 bugun (global) / 🟢 canonical (lokatsiya kesimida)
Bugun 3 ta gibrid BOM bor, bot ikkala materialni to'g'ri ayiradi. Canonical'da farq: ayirma konteyner/WIP darajasida item bo'yicha.
| Joy | Oldin | Harakat | Keyin |
|---|---|---|---|
| WIP PP CF | 200 | −170 | 30 |
| WIP PP BCF | 200 | −160 | 40 |
| C-02 HYB | 0 | +100 dona / +330 kg | 100 / 330 |

### S6. Purchased Product → Inventory → Sale — 🟡 bugun / 🟢 canonical
Bugun: BOMsiz mahsulot yaratish ✓ (58 ta bor), kirim generik IN (og'irlik taxminiy, purchase ref yo'q), sotuv ✓.
Canonical: PURCHASE type + ref bilan kirim; qolgani bir xil. BOM talab qilinmaydi ✓.

### S7. Partiya → Tayyor konteyner C-02 — 🟡 bugun / 🟢 canonical
Bugun: operator konteyner tanlasa C-02'ga tushadi ✓, LEKIN tizim istalgan faol omborni qabul qiladi (tanlanmasa — ro'yxatdagi birinchi faol ombor); "finished konteyner" majburiyati tekshirilmaydi — raw konteynerga tayyor mahsulot yozilib qolishi mumkin (D3 anomaliyasining ehtimoliy manbai).
Canonical: faqat purpose='finished' lokatsiya qabul qilinadi, default taklif bilan.

### S8. Bir SKU → boshqa finished konteyner — 🟢 bugun
inventory unique(warehouse, product) allaqachon ruxsat beradi; ma'lumotlarda bir mahsulot bir nechta omborda yotibdi ✓.

### S9. Qisman WIP iste'moli — 🟡 bugun / 🟢 canonical
Bugun: liniya jami kg bo'yicha to'g'ri ishlaydi (300 berildi, 150 ishlatildi → 150 qoladi). Item kesimida ko'rinmaydi.
Canonical: WIP balans har item bo'yicha yuritiladi (wip_movements'da ustunlar allaqachon bor — faqat balans hisobini item kesimiga o'tkazish kerak).

### S10. Yetarli emas qoldiq — 🟡 bugun / 🟢 canonical
Bugun 3 xil xulq: (a) global raw yetmasa — RawStockError + operator tasdig'i bilan MANFIYGA o'tish mumkin (natija: −12 092 kg); (b) konteynerdan berish — qat'iy blok ✓; (c) WIP'dan ortiq chiqarish — liniya aniqlansa blok ✓ (liniya mahsulotdan YOKI ishchidan topiladi); mahsulot ham, ishchi ham liniyasiz bo'lsa WIP hisobi umuman chetlab o'tiladi.
Canonical: yagona qoida — barcha kamaytirishlar manba lokatsiya qoldig'i bilan cheklanadi; istisno faqat ADJUSTMENT (majburiy izoh + audit) orqali.

---

## G. Bosqichli migratsiya rejasi (tasdiqdan keyin)

| Faza | Nima qilinadi | Xavf | Qaytarish |
|---|---|---|---|
| **P0** | Ushbu audit ✓ | — | — |
| **P1. Qarorlar + inventarizatsiya** | Egasi javoblari (I bo'lim); konteynerlar bo'yicha REAL qoldiqlarni sanash varag'i | Kod yo'q | — |
| **P2. Additiv sxema** | **KIRISH SHARTI: har bir yangi jadval/ustun/indeks bot `init_db` VA API `initDb`'ga idempotent qo'shiladi + Drizzle mirror + `schema-drift` tekshiruvi yangilanadi — dual-write'dan OLDIN.** `items` jadvali; SKU global allocator (butun to'plam bo'ylab unikal); 6 tranzaksiya jadvaliga `item_id` NULLABLE; nom→item backfill mapping (orphan/dublikatlar P1 qarori bo'yicha); yangi yozuvlarda dual-write (nom + item_id) | Past — hech bir oqim o'zgarmaydi | Ustunlar e'tiborsiz qoladi |
| **P3. Reconciliation** | Inventarizatsiya asosida konteyner ochilish qoldiqlari (ADJUSTMENT, izoh bilan); manfiy global/inventory/WIP'larni hujjatlashtirilgan tuzatish; **global = Σ(konteyner) + Σ(WIP)** tekshiruvi (hisobot rejimida doimiy check) | O'rta — faqat ma'lumot, kod emas | Adjustment'lar teskari yoziladi |
| **P4. O'qishni ID'ga o'tkazish** | BOM, inventory, WIP, sotuv item_id orqali; nom faqat display; global qoldiq hisoblanadigan qiymatga aylanadi (kesh sinxron, WIP'ni qo'shgan holda); API marshrutlari nom→id (bot + dashboard + field birga) | O'rta-yuqori | Feature-flag bilan nomga qaytish |
| **P5. Yangi imkoniyatlar va qoidalar** | Transformation tranzaksiyasi; PURCHASE kirimi; xomashyo direct sale; item-kesim WIP; **Manufactured+BOM validatsiyasi (BOMsiz partiya blok)**; **partiya chiqishi faqat finished lokatsiyaga**; tolerance (standard/min/max kg) + bot tekshiruvi | O'rta | Yangi obyektlar mustaqil |
| **P6. Qat'iylashtirish** | item_id NOT NULL + FK; nom-kalit yozish taqiqlanadi; dublikat kataloglar arxivlanadi; distribution ko'prigi SKU orqali | O'rta | Faqat hamma testlar yashil bo'lsa |

**Har fazada majburiy testlar:** fresh-DB init guard (bot `init_db` + API `initDb` — mavjud qoida), `schema-drift` tekshiruvi, 10 stsenariyli e2e to'plam, global=Σ(lokatsiyalar) drift hisoboti.

---

## H. 15 Acceptance qoidasiga javoblar

| # | Savol | Canonical | Bugun |
|---|---|---|---|
| 1 | Xomashyo sotilishi mumkinmi? | Ha | Yo'q (faqat nusxa orqali) |
| 2 | Xomashyo boshqa materialga aylanadimi? | Ha | Yo'q |
| 3 | Intermediate sotilishi mumkinmi? | Ha | Faqat products'ga nusxalansa |
| 4 | Bitta raw → bir nechta mahsulot? | Ha | Ha ✓ (16 material 59 mahsulotda) |
| 5 | Bitta mahsulot → bir nechta raw? | Ha | Ha ✓ (3 gibrid BOM) |
| 6 | Purchased product BOMsiz? | Ha | Ha ✓ (58 ta) |
| 7 | Manufactured BOMsiz production? | Yo'q (bloklanishi kerak) | **Bloklanmaydi ✗ — BOMsiz partiya jim o'tadi, xomashyo ayirilmaydi** |
| 8 | Raw va finished konteyner mustaqilmi? | Ha | Ha ✓ (purpose bor), lekin partiya chiqishi purpose bilan cheklanmagan va 5 anomal qator bor |
| 9 | Raw inputda global+konteyner sinxronmi? | Ha | Faqat "Ish jarayoni" oqimida ✓; forma/adjust yo'lida ✗ |
| 10 | Production atomikmi? | Ha | Bot partiyasi ✓; dashboard produce qisman oqim |
| 11 | BOM nomga bog'lanadimi? | Yo'q | Hozir yarmi nomga bog'langan ✗ |
| 12 | BOM SKU/ID'ga bog'lanadimi? | Ha | Material tomoni ✓, mahsulot tomoni ✗ |
| 13 | SKU = Batch'mi? | Yo'q | To'g'ri ajratilgan ✓ |
| 14 | Bir SKU turli konteynerlardami? | Ha | Ha ✓ |
| 15 | Raw bir vaqtda saleable + input? | Ha | Faqat dublikat orqali ✗ |

---

## I. Ochiq savollar — egasi qarori kerak

1. **Sholcha oilasi:** "Sholcha" (xomashyo) va "Sholcha Oq"/"Sholcha Sariq" (mahsulotlar) — bitta itemmi (rang varianti) yoki 3 alohida item? C-01/03/08/09/13'dagi 107 000 birlik "finished" qatorlar aslida nima?
2. **4 dual item** (Cord Maloshni, Babin Sariq/Qora 0.5, Kanob): birlashtirilsinmi? Ikkala tomondagi tarix bitta itemga ko'chsinmi?
3. **Manfiy qoldiqlar:** −12 092 kg va boshqalar — yetishmagan kirimlarni keyin kiritasizmi (backfill) yoki inventarizatsiya kuni ADJUSTMENT bilan yopiladimi?
4. **39 orphan sotuv nomi:** hozirgi mahsulotlarga mapping qilinsinmi (masalan "PP 2 x 1500 OQ" → "PP 2 x 1500 / OQ") yoki tarixiy arxiv sifatida qolsinmi?
5. **Qop ip dublikatlari:** qaysi nom qoladi?
6. **Valyuta tozalash (D6):** USD deb yozilgan UZS'ga o'xshash summalarni tekshirib tuzatamizmi?
7. **Inventarizatsiya:** konteynerlardagi real qoldiqlarni kim, qachon sanab beradi? (P3 shunga bog'liq)
8. **Distribution katalogi:** savdo bot mahsulotlari ERP SKU'siga bog'lansinmi (60 tasi nom bo'yicha mos, 9 tasi qo'lda)?
9. **Yield/Loss:** transformationda yo'qotish hisobi hozircha KERAK EMAS deb qabul qilamizmi? (arxitekturada joy qoldirilgan)
10. **BOMsiz partiya:** Manufactured mahsulotda BOM bo'lmasa partiya DARHOL bloklansinmi, yoki avval ogohlantirish davri bo'lsinmi? (hozir jim o'tadi — 274 partiyaning hammasi BOM'li mahsulotlarda bo'lgan, lekin himoya yo'q)
11. **API'ni nomdan ID'ga o'tkazish vaqti:** P4 breaking bosqich — bot, dashboard, field bir vaqtda yangilanadi. Qulay payt?

---

*Hisobot jonli bazani faqat o'qish rejimida tekshirish, kod auditi va mustaqil arxitektura ko'rigi asosida tuzildi. Keyingi qadam: I bo'limdagi savollarga javob + arxitektura tasdig'i → P2 boshlash mumkin.*
