# PRODUCTION FLOW — VIZUAL ARXITEKTURA TAKLIFI (2026-08-17)

**Asos:** Egasining «TOPMART ERP — PRODUCTION / WAREHOUSE VISUAL FLOW» topshirig'i (§1–21).
**Rejim:** READ / ANALYZE / DESIGN / PREVIEW — **bazaga NOL yozuv** (isbot §11da).
**Holat: TAKLIF — «PRODUCTION FLOW GO» kutilmoqda. Hech qanday implementatsiya boshlanmagan.**

---

## 1. Mavjud sxema tahlili (§21.1)

Jonli bazadan (read-only sessiya) va Drizzle sxemasidan tekshirildi. Public sxemada 40 jadval.
Oqim grafigi uchun bevosita tegishli 15 jadval quyida; qolganlari (sales, distribution, admin va h.k.) bu bosqichga aloqasiz.

**Muhim umumiy topilma:** P2.1 bosqichida qo'shilgan `item_id` ustunlari HAMMA joyda mavjud,
lekin faqat `inventory` (reset qamrovidagi 92 satr) va `stock_movements`da to'ldirilgan.
`wip_movements`, `batches`, `products`, `product_materials`dagi item bog'lari **bo'sh (0 satr)** —
bugungi amaldagi bog'lanish TEXT nom orqali ishlaydi.

## 2. Tegishli jadvallar (§21.2)

| Jadval | Satr | Grafikdagi roli | Kalit ustunlar |
|---|---|---|---|
| `warehouses` | 36 (30 konteyner + 6 viloyat) | Container node | id, name, **purpose** (raw/finished), location_type, capacity_kg |
| `inventory` | 140 | Container ichidagi pozitsiyalar; Product→Container edge | warehouse_id→warehouses, **item_id→items** (92 satrda), product (text), quantity, weight_kg, **product_type** (raw/pre-finished/finished) |
| `items` | 94 | Kanonik SKU (TM-xxxxxx) node identifikatori | sku, display_name, is_raw/is_intermediate/is_finished (❗hozircha BARI false), unit |
| `stock_movements` | 730 | Product→Container tarix (IN/OUT/BASELINE) | from/to_warehouse_id, item_id, movement_type, reason |
| `production_lines` | 5 | **Department node** (alohida "departments" jadvali YO'Q — bo'lim = production_line) | id, name |
| `wip_movements` | 171 | Container→Dept (RECEIVE) va Dept→Product (PRODUCE) edge'lar; WIP balans | line_id, movement_type, raw_material (text), product (text), weight_kg, from_warehouse_id, batch_id, raw_material_item_id/product_item_id (❗bo'sh) |
| `production_line_workers` | 13 | Dept→Employees | line_id→production_lines, worker_name, role |
| `line_role_config` | 7 | Dept rollari/stavkalari | line_id, role_key, label, rate, max_workers, pay_mode |
| `salary_entries` | 29 | Dept→Salary (yopilgan kunlar) | worker, line_id, work_date, kg, amount |
| `salary_payments` | — | Oylik to'lovlar (worker-global, line'siz) | worker, year, month, amount |
| `batches` | 280 | Ishlab chiqarish faktlari | worker, product (text), production_line_id (209/280 to'la), item_id (❗bo'sh), weight_kg, quantity |
| `product_materials` | 62 | **BOM** — RawMaterial→Product retsept edge | product_name, raw_material_id→raw_materials, material_item_id/product_item_id (❗bo'sh) |
| `products` | 117 | Katalog; line_id (❗faqat 9/117) | name, item_id (❗bo'sh), line_id→production_lines, rate_type |
| `raw_materials` | 17 | Xomashyo katalogi | name, item_id→items ✅, current_stock, currency |
| `wip_negative_alerts` | — | WIP manfiy ogohlantirishlari | line_id, alert_date, wip_kg |

## 3. Mavjud relationshiplar (§21.3)

**FK darajasida (bazada e'lon qilingan):** inventory→warehouses/items · stock_movements→warehouses(2)/items · physical_baseline_positions→physical_baselines/items · wip_movements→items(2, lekin qiymatlar NULL) · production_line_workers→production_lines · line_role_config→production_lines · products→items/production_lines · product_materials→products/raw_materials/items(2) · batches→items · raw_materials→items · item_aliases→items.
`wip_movements.line_id` ataylab FK'siz (init-db izohi) — line o'chirish boshqa joyda 409 bilan qo'riqlanadi.

**Amaldagi (data bor) bog'lanishlar:**

| Edge (§10 semantika) | Manba | Bugungi holat |
|---|---|---|
| Container → pozitsiyalar | inventory (warehouse_id+item_id) | ✅ TO'LIQ (reset 9 lokatsiya aynan) |
| Department → WIP → Product («Production»/«Output») | wip_movements PRODUCE (line_id, product text, kg) | ✅ 171 satr — line 6 (Arqon Bo'lim 3) → Ikki Qavat Arqon 4/5/6 kg, Kurtka Tros; TEXT nom orqali |
| Product → Container («Storage») | inventory + stock_movements IN | ✅ TO'LIQ |
| RawMaterial → Product (retsept) | product_materials (BOM, 62 satr) | ✅ text/raw_material_id orqali |
| Department → Employees | production_line_workers (line 6: 11 kishi, line 9: 2 kishi) | ✅ REAL |
| Department → Salary | salary_entries (line 6: 21 yozuv/7 ishchi/3 244 162,50; line 9: 8/2/480 000) + line_role_config stavkalari | ✅ REAL (yopilgan kunlar) |
| Batch → Line | batches.production_line_id (209/280) | ✅ qisman |

## 4–5. Qaysi relationshiplar BOR / YO'Q (§21.4–5) — halol xulosa

**BOR (yuqorida ✅).** **YO'Q yoki BO'SH — UI'da aniq «ma'lumot yo'q» deb ko'rsatiladi, FAKE chizilmaydi:**

1. **Container → Department («Material supply») REAL DATA = 0.** `wip_movements`da RECEIVE yozuvi **umuman yo'q** (171 satrning hammasi PRODUCE). Model/endpoint mavjud (`POST /ombor/flow/receive`, from_warehouse_id ustuni bor), lekin operatsiyada hali ishlatilmagan. Shu sababli **line 6 WIP balansi manfiy: −8 964,77 kg** (chiqim yozilgan, kirim yozilmagan). Grafikda bu edge'lar faqat RECEIVE yozila boshlagach paydo bo'ladi; hozircha BOM retsept-edge'lari (punktir, «retsept bo'yicha» yorlig'i bilan) ko'rsatilishi mumkin — bu ham real data (retsept), lekin oqim fakti emas.
2. **item_id bog'lari bo'sh:** wip_movements (0/171), batches (0/280), products (0/117), product_materials (0/62). Grafik hozircha TEXT nom bilan bog'laydi (apostrof variantlarini normalizatsiya qilib — oldingi tajriba). Backfill = kelajakdagi alohida taklif, MVP uchun SHART EMAS.
3. **items flaglari bo'sh:** is_raw/is_intermediate/is_finished = 94 satrda ham false. Klassifikatsiya manbai — `inventory.product_type` (reset'da tasdiqlangan: raw 6 / pre-finished 3 / finished 88). Grafik shundan o'qiydi, flaglarni O'ZGARTIRMAYDI (§13).
4. **`warehouses.purpose` eskirgan:** C-15 purpose='finished', lekin ichida 100% RAW (PP CF 1000D ×3). Hozirgi «Ish jarayoni» sahifasi raw-konteynerlarni purpose='raw' bilan filtrlaydi — shuning uchun C-15 u yerda xomashyo manbai sifatida KO'RINMAYDI. Yangi grafik turini **kontentdan** (product_type) hisoblaydi (§11: RAW/PRE-FINISHED/FINISHED/MIXED) va purpose≠kontent nomuvofiqligini vizual belgi bilan ko'rsatadi. purpose'ni TUZATISH — №3 ochiq savol (R-E), bu bosqichda tegilmaydi.
5. **«CF Lenta» bo'limi hali mavjud emas** — misoldagi nom. Real bo'limlar: Arqon Bo'lim 3 (id 6, faol), Qop Ip (id 9, faol), Lenta 1 (id 8, 0 ishchi), Arqon Bo'limi (10), Naycha (97). Grafik real linelarni ko'rsatadi.
6. **RECEIVE→PRODUCE lot-darajali bog' yo'q** (qaysi kg qaysi partiyaga ketgani). WIP — line bo'yicha agregat pool. «Qancha ishlatilgan/qolgan» faqat (konteyner, material, line) agregatida ko'rsatiladi.
7. `salary_payments` line'ga bog'lanmagan (worker-global) — bo'lim panelida «yopilgan kunlar bo'yicha hisoblangan» summalar (salary_entries) ko'rsatiladi, to'lovlar esa ishchi kesimida.

## 6. Vizual arxitektura taklifi (§21.6)

**5 qatlamli DAG (chapdan o'ngga):**

```
[RAW CONTAINER] → [DEPARTMENT] → [WIP] → [PRODUCT] → [FINISHED CONTAINER]
   (C-15…)      (Arqon Bo'lim 3)  (balans)  (TM SKU)      (C-02…)
```

- **Node turlari:** ContainerNode (nom, tur badge RAW/PRE-FINISHED/FINISHED/MIXED — kontentdan; kg/dona; sig'im %; purpose-mismatch belgisi), DepartmentNode (nom, WIP kg — manfiy bo'lsa qizil ⚠️, ishchilar soni, bugungi produce), WipNode (line ichida, RECEIVE−PRODUCE balans), ProductNode (SKU, nom, tur, joriy qoldiq joylari), EmployeeNode (drawer ichida, alohida graf node emas — §14).
- **Edge semantikasi (§10):** RAW→DEPT «Material supply» (RECEIVE, hozircha bo'sh) · DEPT→WIP «Production» · WIP→PRODUCT «Output» (PRODUCE) · PRODUCT→CONTAINER «Storage» (inventory/stock IN) · punktir «Retsept (BOM)» qatlarni faqat real jadvallardan. Har edge ustida kg + material nomi; click → drawer: material, kg, SKU (bo'lsa), from/to, sana, operator. Status (Available/Consumed/Partial) — faqat real ledger'dan hisoblansa ko'rsatiladi, aks holda ko'rsatilmaydi.
- **Interaktivlik (§9):** pan/zoom, node click → o'ng drawer (Container: pozitsiyalar+connections; Dept: Input/WIP/Output/Employees/Production/Salary — §4 tartibida; Product: SKU/nom/tur/kg/dona/joylar; Edge: yuqoridagi), qidiruv «TM-000092» → tegishli yo'l highlight + qolganlar xira (§12), filtrlar: node turi, konteyner, bo'lim, SKU, tur (§12).
- **Kutubxona:** dashboardda graf kutubxonasi YO'Q (recharts/leaflet bor, node-graph emas). Taklif: **@xyflow/react (React Flow v12, MIT)** — 1 yangi frontend dependency. Layout: 5 ustunli deterministik joylashuv (dagre/elk KERAK EMAS — qatlamlar aniq). Muqobil (dependency'siz): ish-jarayoni'dagi custom-CSS uslubini kengaytirish — lekin pan/zoom/highlight/edge-click sifati ancha past bo'ladi. Qaror sizniki; tavsiya — React Flow.
- **Joylashuv:** yangi route **`/flow-map`** («Oqim xaritasi») sidebar'da «Ish jarayoni» ostida. Mavjud «Ish jarayoni» sahifasi TEGILMAYDI (u jonli operatsion panel bo'lib qoladi); Ombor konteyner detali va flow-map o'zaro link qilinadi (§2: card → connections).
- **Ma'lumot manbai:** BITTA yangi read-only endpoint `GET /api/ombor/flow/graph` — nodes[], edges[], gaps[] (yetishmayotgan bog'lar ro'yxati UI'da «kutilmoqda» sifatida). Faqat SELECT'lar; mavjud jadvallardan agregat. Hech qanday yozuv yo'q. Javob react-query bilan keshlanadi (60s stale), polling ixtiyoriy.
- **Zichlik nazorati:** default'da faqat FAOL node'lar (qoldiq>0 yoki harakat bor); 94 SKU birdan chizilmaydi — bo'lim/konteyner node'lari ichida «N mahsulot» agregati, click bilan ochiladi. Viloyat omborlari (6) alohida guruh, default yig'ilgan.
- **Responsive:** iPad-first (any-pointer:coarse qoidasi), pinch-zoom, drawer to'liq ekran bo'ladi mobil'da.

## 7. UI mock/preview plan (§21.7, §18)

1. **Mockup-sandbox preview (dashboardga TEGMASDAN):** React Flow bilan real `/flow/graph` ma'lumotining statik snapshot'ida (read-only JSON fixture) interaktiv mockup — canvas'da ko'rasiz: node dizayni, drawer, highlight, filtr. Sizning vizual OK'ingizgacha dashboard kodiga kirilmaydi.
2. OK'dan keyin: endpoint (read-only) + `/flow-map` sahifasi dashboardda, xuddi shu dizayn.
3. Har bosqichda screenshot/preview taqdim etiladi.

## 8. Minimal sxema o'zgarishlari (§21.8)

**MVP uchun: NOL DDL, NOL yangi jadval, NOL data yozuv.** Hammasi mavjud jadvallardan SELECT bilan chiqadi (§21: «yangi table majburiy emas» — tasdiqlayman, majburiy emas).
Kelajak uchun (har biri ALOHIDA taklif + sizning GO'ingiz, bu bosqichga KIRMAYDI):
- (a) wip_movements/batches/products/product_materials item_id backfill (text→item nom-normalizatsiya bilan) — grafni mustahkamlaydi;
- (b) RECEIVE oqimini operatsiyada boshlash (C-15→bo'lim kirimlari yozilsa, supply edge'lar + WIP musbat bo'ladi);
- (c) №3: C-15 (va C-19) purpose tuzatish — R-E;
- (d) items flaglarini inventory.product_type'dan sinxronlash.

## 9. Risklar (§21.9)

| Risk | Baho | Yumshatish |
|---|---|---|
| TEXT-nom bog'lash (item_id bo'sh) — apostrof/registr variantlari | O'rta | Ikki tomonlama normalizatsiya (oldingi savdo-bot tajribasi); moslik topilmasa edge chizilmaydi, «bog'lanmagan» ro'yxatida ko'rinadi |
| WIP manfiy (−8 964,77) foydalanuvchini chalg'itadi | O'rta | Yashirmaymiz: qizil badge + izoh «RECEIVE yozuvlari boshlanmagan»; wip_negative_alerts bilan uyg'un |
| Graf zichligi (36 ombor, 117 mahsulot) | O'rta | Faol-node default + agregat + filtr/qidiruv (§12) |
| purpose≠kontent (C-15) chalkashligi | Past | Tur badge kontentdan; mismatch belgisi; №3 alohida |
| Yangi dependency (@xyflow/react) | Past | MIT, faqat frontend, server tarafi yo'q; siz rad etsangiz custom-SVG varianti bor |
| item_id NULL satrlar (2 EXACT + reset-tashqari eski omborlar) | Past | Node kaliti item_id YOKI normallashgan nom — hech kim tashqarida qolmaydi |
| Performance (agregat so'rov) | Past | Bitta endpoint, indexlangan ustunlar, react-query kesh |

## 10. Implementation phases (§21.10) — faqat «PRODUCTION FLOW GO»dan keyin

- **F1 — Mockup preview:** sandbox'da interaktiv graf (real snapshot fixture) → sizning vizual OK.
- **F2 — Read-only backend:** `GET /ombor/flow/graph` (faqat SELECT) + testlar.
- **F3 — Dashboard integratsiya:** `/flow-map` sahifa, node/edge/drawer/search/filter, iPad responsive.
- **F4 — Bo'lim paneli to'liq:** Employees/Production/Salary drawer bo'limlari (real salary_entries/line_role_config).
- Har faza oxirida preview + hisobot; F2–F4 birga ham berilishi mumkin, siz hal qilasiz.
- Data-hygiene takliflar (§8 a–d) — bu dasturdan TASHQARIDA, alohida GO'lar.

## 11. Bazaga yozilmaganining isboti (§21 «VA ENG MUHIMI»)

- Barcha tahlil sessiyalari `PGOPTIONS='-c default_transaction_read_only=on'` bilan ochildi (faqat SELECT).
- Pin tekshiruv (tahlil boshida = oxirida, o'zgarishsiz):
  `inv=140 · mov=730 · BASELINE=110 · items=94 · pos=97 · LOADED=9 · sales=45/143 · arxiv=43 · rawmat=17 · wipmov=171`
- Dashboard/API kodiga ham hech narsa yozilmadi (faqat ushbu hujjat `docs/`da yaratildi).

**GO hali berilmagan — «PRODUCTION FLOW GO»ni kutaman. Biz taxmin qilmaymiz. Biz bilamiz.**
