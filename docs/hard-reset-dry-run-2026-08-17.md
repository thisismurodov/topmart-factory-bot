# TOPMART ERP — PRODUCTION/WAREHOUSE HARD RESET — DRY-RUN HISOBOTI
**Sana:** 2026-08-17 13:50 (Asia/Tashkent) · **Rejim:** FAQAT SELECT (PGOPTIONS read-only) · **DB WRITE = 0**

Bu hujjat kelajakdagi «RESET GO» skriptlari uchun muhrlangan manba. Hech bir raqam taxmin emas —
barchasi jonli Railway prod bazasidan o'qildi (o'qish vaqti yuqorida). Zavod ishlayotgani uchun
ayrim sonlar GO paytida farq qilishi mumkin; GO skripti pre-gate'da qayta pin qiladi.

---

## 0. ENG MUHIM TOPILMA — resetning yadrosi ALLAQACHON BAJARILGAN

Owner spec'dagi «9 real konteyner → yangi inventar» bosqichi **2026-08-17 kuni prod'da to'liq
bajarib bo'lingan** (R-A → R-B → R-C → R-D dasturi). Jonli tasdiq (13:45):

| Bosqich | Holat (jonli bazadan) |
|---|---|
| R-A legacy arxiv | `legacy.*` 4 jadval (36/43/17/1 satr), append-only trigger bilan muhrlangan |
| R-C 94 TM SKU | `items`: 94 satr, TM-000001…094 (id 2–95), immutable trigger |
| R-B registr | `physical_baselines` 9/9 **LOADED** + `physical_baseline_positions` 97, trigger-frozen |
| R-D yuklash | 110 BASELINE harakat; 9 konteynerda **71 862.20 kg / 126 360 dona — AYNAN fizik sanoq** |
| 2 EXACT | Rossiya Tros 531 kg (C-18, inv id=430) + Shroki 3.5 Oq 676.55 kg (C-02, id=431) — mavjud katalogga biriktirilgan, yangi SKU yaratilmagan |

**Demak PHASE 5 («9 konteyner yuklash») QAYTA BAJARILMAYDI — u faqat VERIFY bosqichiga aylanadi.**
Qolgan reset ishi = eski OPERATSION qatlam: legacy inventar qoldiqlari, 583 legacy harakat,
280 legacy partiya, 171 WIP yozuvi, raw_materials stock raqamlari.

---

## 1. Jonli holat — asosiy raqamlar

### 1.1 Inventory (140 satr; jami 255 688 qty / 98 014.47 kg)

| Guruh | Satr | Qty (dona) | Kg | Izoh |
|---|---|---|---|---|
| BASELINE-9 konteyner, item_id bor | 95 | 126 360 | 70 654.65 | Fizik sanoq pozitsiyalari — **SAQLANADI** |
| BASELINE-9, item_id yo'q, nol emas | 4 | 1 760 | 1 207.55 | 2 EXACT (531+676.55 kg) **SAQLANADI** + 2 yangi-davr Reja ip satri (1 760 dona) — **QAROR D1** |
| BASELINE-9, nol satrlar | 11 | 0 | 0 | R-D auditli 0-langan legacy (C-16: 3, C-17: 8) — tegilmaydi |
| **BASELINE-9 JAMI** | **110** | **128 120** | **71 862.20** | kg bo'yicha AYNAN fizik sanoq |
| Boshqa joylar (legacy) | 30 | 127 568 | 26 152.27 | **RESET NOMZODI** |

Legacy 30 satr taqsimoti: C-01 (2 satr, 50 000/25 000 kg) · C-03 (10 000) · C-05 (4 satr, 2 055/10 455.43 kg) ·
C-08 (25 000) · C-09 (22 000) · C-13 (25 000) · **Namangan Markaziy Ombor (20 satr, −6 487 / −9 303.16 kg — fantom manfiylar)**.
Eslatma: C-01/03/08/09/13 raw konteynerlarda ~132 000 birlik legacy «xomashyo» bor deb da'vo qilinadi —
fizik sanoq esa real xomashyo faqat C-15 da 13 020 kg ekanini tasdiqlagan. Legacy raqamlar ishonchsiz (owner dekreti).

### 1.2 Stock movements (734 satr; 2026-06-24 → bugun)

| Turkum | Soni | Taqdir |
|---|---|---|
| BASELINE (R-D tug'ilish guvohnomalari) | 110 | **SAQLANADI** |
| 'Savdo #' izli (savdo kamaytirishlari) | 37 (hammasi kesimdan oldin) | **SAQLANADI — SALES AUDIT IZI** |
| Yangi davr (kesimdan keyin, bugungi partiya) | 4 | **QAROR D1** (tavsiya: saqlanadi) |
| Legacy IN/OUT (kesimgacha, savdosiz) | **583** | **ARXIV → EXPLICIT DELETE nomzodi** |

Kesim nuqtasi (baseline yakuni): **2026-08-17 09:38:34 UTC**.

### 1.3 Qolganlari

- **batches**: 282 = 280 legacy + 2 yangi davr (id 283/284, Risolat, bugun 12:53, Reja ip Qora/Sariq). item_id 0/282.
  `salary_entries.batch_id` bog'i: **0 ta** (tekshirildi) — partiyalarni arxivlash oylik tarixini buzmaydi.
- **wip_movements**: 171, hammasi legacy PRODUCE (6-liniya), oxirgisi 2026-08-15. WIP balans = **−8 964.77 kg**. batch_id bog'i 0.
- **wip_negative_alerts**: 3 (hosila signal).
- **raw_materials**: 17 satr; current_stock: 2 musbat / 5 manfiy / 10 nol; jami 14 254.38 kg (ishonchsiz:
  Sholcha +25 000, PP 2x1500/OQ −12 247.3, Babin −1 972.96/−1 153.36 …). item_id 0/17.
- **products**: 117; in_sales=58; in_production=117 (default-TRUE tuzog'i); item_id 0/117.

---

## 2. §15 RESET DEPENDENCY GRAPH

Format: TABLE | ROWS | RESET? | SALES DEP? | FK BLOCK? | ACTION

### 2.1 Reset doirasi (operatsion legacy)

| TABLE | ROWS | RESET? | SALES DEP? | FK BLOCK? | ACTION |
|---|---|---|---|---|---|
| inventory (30 legacy satr) | 30/140 | HA | Bilvosita (kelajak savdolar inventardan ayiradi) | warehouses→inventory CASCADE (ota tomonda; warehouses o'chirilmasa xavfsiz) | Auditli BASELINE bilan 0-lash (reason=eski qiymat), DELETE EMAS |
| stock_movements (legacy) | 583/734 | HA | 37 savdo satri CHIQARIB tashlangan | Unga FK yo'q | Yangi legacy jadvalga ARXIV → tasdiq → id-ro'yxatli EXPLICIT DELETE |
| wip_movements | 171 | HA | YO'Q | Unga FK yo'q | ARXIV → DELETE → WIP=0 |
| batches (legacy) | 280/282 | HA | YO'Q (salary bog'i 0 — tekshirildi) | Unga FK yo'q | ARXIV → DELETE (yoki archived=true — QAROR D2) |
| raw_materials.current_stock | 17 satr qiymatlari | HA (faqat raqamlar) | YO'Q | Satr DELETE → product_materials CASCADE — TAQIQ | Satrlar qoladi; current_stock auditli 0 |
| wip_negative_alerts | 3 | HA | YO'Q | yo'q | Tozalash (hosila) |

### 2.2 MUTLAQO DAXLSIZ — savdo (§3)

| TABLE | ROWS | RESET? | SALES DEP? | ACTION |
|---|---|---|---|---|
| sales | 45 | YO'Q | O'ZI | NEVER TOUCH |
| sale_items | 143 | YO'Q | O'ZI | NEVER TOUCH |
| sale_payments / sale_events / customers | 10 / 57 / 31 | YO'Q | O'ZI | NEVER TOUCH |
| product_price_tiers / sales_product_tiers | 12 / 6 | YO'Q | Narxlash | NEVER TOUCH |
| sale_products / sales_products (eski savdo kataloglari) | 8 / 47 | YO'Q | Legacy savdo | NEVER TOUCH |
| **distribution.* (savdo bot, 19 jadval)** | savdolar 193 · savdo_tafsilot 497 · dokonlar 280 · users 8 · mahsulotlar 70 · nasiya 5 · pul_olish 2 · mijoz_balans 1 · qolganlari | YO'Q | O'ZI (Telegram savdo bot) | NEVER TOUCH — alohida sxema, reset skriptlari faqat public sxemada ishlaydi |

### 2.3 STOP BAYROQ — products (§4 javobi)

| Tekshiruv | Natija |
|---|---|
| sale_items → products (nom orqali) | 95 xil sotilgan nomdan **56 tasi products.name ga mos** (39 orphan nom) |
| distribution.mahsulotlar → products (SKU orqali) | 70 tadan **58 tasi bog'langan** |
| batches → products | 14/14 nom mos |
| BOM (product_materials) | 59 mahsulotda 62 retsept |

**XULOSA: `products` — HAM warehouse, HAM sales ishlatadigan YAGONA master jadval.
«sales dependency mavjud» — DELETE MUMKIN EMAS. STOP.**
Arxitektura allaqachon tayyor: `items` (94 TM) — yangi identitet asosi; products profil sifatida qoladi;
kelajakda modul-flaglar (in_production) bilan boshqariladi — bu resetdan ALOHIDA, owner-gated ish.

### 2.4 Saqlanadigan poydevor / konfiguratsiya

| TABLE | ROWS | Sabab |
|---|---|---|
| items / item_aliases | 94 / 0 | Yangi SKU asosi (§10) — 10 ta jadval FK qiladi; immutable trigger |
| physical_baselines / positions | 9 / 97 | Manba hujjat (§9) — trigger-frozen, qayta yozilmaydi |
| legacy.* | 36/43/17/1 | Append-only arxiv |
| warehouses | 36 | DELETE → inventory CASCADE! Struktura qoladi |
| production_lines + line_role_config + production_line_workers | 5 / 7 / 13 | Bo'lim strukturasi + oylik konfiguratsiyasi (CASCADE zanjir) |
| workers / user_roles / packer_* | 34 / 24 / 17+38 | Xodimlar va bot kirishlari |
| payroll_role_rates / kg_payroll_workers | 4 / 2 | Oylik stavkalari |
| product_materials (BOM) | 62 | Retseptlar (raw_materials CASCADE dan himoya qilinadi); №3 R-E gate alohida |
| admin_* / db_meta / audit_logs / ai_analysis_runs | — | Tizim |

### 2.5 QAROR KUTILMOQDA (owner)

| # | Savol | Tavsiya |
|---|---|---|
| D1 | Yangi davr ma'lumotlari (bugungi 2 partiya, 4 harakat, C-17 dagi +1 760 dona) reset ichidami? | **SAQLASH** — bu yangi baseline USTIDAGI real ishlab chiqarish (Risolat, 12:53). O'chirish real fizik mahsulotni yashiradi |
| D2 | Legacy 280 partiya: DELETE yoki archived=true belgisi? | Arxiv-jadval + DELETE (operatsion 0 talabiga to'g'ri keladi); istasangiz flag varianti ham mumkin |
| D3 | Oylik tarixi (salary_entries 29, daily_payroll_runs 18) | **SAQLASH** — bu to'langan pul tarixi; spec reset ro'yxatida yo'q |
| D4 | Legacy 30 inventar satri: auditli 0-lash (satr qoladi) yoki DELETE? | **Auditli 0-lash** — v2 dekret (hech qachon bare DELETE; tarix harakatda saqlanadi) |

---

## 3. SALES INVARIANT SNAPSHOT (himoya isboti uchun asos)

Reset OLDIDAN va KEYIN quyidagilar AYNAN teng bo'lishi shart:

**public (ERP savdo):**
- sales: 45 (usd 10 → 10 951.27 · USD 25 → 260 140 401.06 (paid 260 122 119.59, debt 18 281.47) · uzs 4 → 27 190 581.98 · UZS 6 → 97 227 309.20) — valyuta katta-kichik harf holati AS-IS qayd etildi
- sale_items: 143 (USD 95 → 60 627.5125 · UZS 48 → 384 508 615.96)
- sale_payments: 10 → 14 407 005.67 · sale_events: 57 · customers: 31
- Oxirgi savdo: 2026-07-03 (baseline'dan ancha oldin — 37 savdo-harakatning barchasi kesimdan oldin ✓)

**distribution (savdo bot):**
- savdolar: 193 → 66 653 390 · savdo_tafsilot: 497 → 66 653 390 (ikkisi teng ✓)
- dokonlar 280 · users 8 · mahsulotlar 70 · nasiya 5 · pul_olish 2 · mijoz_balans 1 · agent_locations 1605 · field_ops 493 · qolgan jadvallar 1.1 bo'limdagi ro'yxatda

GO skripti bu bo'limni pre/post-gate sifatida qayta hisoblaydi; birortasi farq qilsa — **STOP**.

---

## 4. FK / CASCADE xavf xaritasi (§16)

- `warehouses` DELETE → `inventory` **CASCADE** — warehouses'ga tegilmaydi.
- `raw_materials` DELETE → `product_materials` **CASCADE** (BOM yo'qoladi) — satr DELETE taqiqlanadi, faqat stock=0.
- `products` DELETE → packer_product_assignments + product_materials + product_price_tiers **CASCADE** + savdo tarixining nom-boglari uziladi — TAQIQ (STOP bayrog'i).
- `production_lines` DELETE → line_role_config + production_line_workers **CASCADE** — tegilmaydi.
- batches / stock_movements / wip_movements ga hech kim FK qilmaydi — arxivdan keyin xavfsiz DELETE mumkin.
- TRUNCATE/CASCADE ishlatilmaydi — faqat id-pinned, explicit, bo'lakli DELETE.

## 5. Reset tartibi — PHASE 0–7 (hozir HECH BIRI bajarilmaydi)

| Phase | Ish | Gate |
|---|---|---|
| 0 | To'liq pg_dump (nix-store `postgresql-18.6/bin/pg_dump` — PATH'dagi 16.10 versiya mos kelmaydi) + checksum. api-tests bilan bir vaqtda EMAS (ACCESS SHARE ↔ TRUNCATE to'qnashuvi) | Dump fayli + hajm tasdiqlangach |
| 1 | Sales invariant qayta-pin (§3 raqamlari) | Farq = STOP |
| 2 | Yangi append-only arxiv jadvallar: `legacy.stock_movements_pre_reset_YYYYMMDD`, `legacy.batches_pre_reset_…`, `legacy.wip_movements_pre_reset_…`, `legacy.inventory_legacy_rows_pre_reset_…`, `legacy.raw_material_stock_pre_reset_…` + count/md5 tasdiq + no-touch triggerlar | **Arxiv tasdiqlanmagunча destruktsiya taqiqlanadi** (v2 qoida) |
| 3 | Ombor tozalash: 30 legacy inventar satri auditli BASELINE bilan 0 (reason=eski qiymat); 583 legacy harakat id-ro'yxat bo'yicha DELETE | LOCK TABLE (SHARE ROW EXCLUSIVE) snapshot'dan OLDIN; live↔arxiv solishtiruv txn ichida |
| 4 | Ishlab chiqarish tozalash: 280 legacy partiya (D2), 171 WIP DELETE → WIP=0; raw_materials.current_stock auditli 0; wip_negative_alerts tozalash | Har jadval alohida pin |
| 5 | ~~9 konteyner yuklash~~ — **BAJARILGAN (R-D)**. Faqat VERIFY: registr LOADED 9/9, pozitsiyalar 97 | O'zgartirish yo'q |
| 6 | Yakuniy tekshiruv: 9 konteynerda 71 862.20 kg / 126 360 dona (+D1 yangi davr deltasi hujjatlashtiriladi); sales invariantlar §3 bilan teng | Farq = STOP + rollback |
| 7 | Ishlab chiqarish 0 dan: yangi partiyalar toza baseline ustiga yoziladi (bugungi 283/284 birinchi yangi-davr namunasi) | — |

## 6. Rollback strategiyasi

1. **Phase 0 dump** — to'liq tiklash yo'li (pg_restore; rehearsal: `-n public -n legacy`, avval CREATE SCHEMA legacy).
2. **Arxiv jadvallar** — append-only, DROP qilinmaydi; har o'chirilgan satr arxivda 1:1.
3. **Auditli 0-lash xatosi** → STORNO (teskari BASELINE harakat) — harakat DELETE qilinmaydi (v2 dekret).
4. Har phase o'z txn'ida; pre-gate pin farq qilsa avtomatik ROLLBACK + hisobot.
5. Baseline registri va items trigger-frozen — reset skriptlari ularga umuman yozmaydi.

## 7. §18 SUCCESS CONDITION — 10 javob

1. **Nima o'chadi:** 583 legacy harakat; 280 legacy partiya (D2); 171 WIP yozuvi; 3 alert. 30 legacy inventar satri 0-lanadi (D4).
2. **Nima saqlanadi:** 9-konteyner baseline (110 satr = 71 862.20 kg/126 360 dona), 110 BASELINE harakat, 37 savdo-harakat, items 94, registr 9/97, BOM 62, strukturalar (liniyalar/omborlar/xodimlar), oylik tarixi (D3), 2 EXACT.
3. **Nima arxivlanadi:** Phase 2 dagi 5 yangi legacy jadval + Phase 0 to'liq dump.
4. **Sales himoyasi:** public savdo jadvallari va butun distribution sxemasi skript doirasidan tashqarida; §3 invariantlar pre/post teng bo'lishi majburiy; 37 savdo-harakat saqlanadi.
5. **FK muammolar:** §4 xarita — warehouses/raw_materials/products/production_lines CASCADE zanjirlari; ledger jadvallarga FK yo'q.
6. **Salesga bog'langan productlar:** 56 nom-orqali + 58 SKU-orqali (58 ⊂ in_sales) → products STOP, DELETE yo'q.
7. **Reset qilinadigan production data:** §2.1 jadvali (WIP −8 964.77 ham 0 bo'ladi).
8. **9 fizik sanoq qayta yuklash:** KERAK EMAS — allaqachon LOADED; Phase 5 verify-only.
9. **Final holat:** ombor = faqat 9 real konteyner + real sanoq (71 862.20/126 360 ± D1); production/WIP/partiyalar operatsion 0; legacy faqat arxivda.
10. **Rollback:** §6.

---
*Hisobot muhrlandi. Keyingi qadam faqat owner «RESET GO» (yoki alohida phase GO) bergandan keyin.*
*Biz taxmin qilmaymiz. Biz bilamiz.*
