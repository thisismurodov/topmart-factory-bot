# R-B ijro hisoboti — sanoq registri (2026-08-17)

**Holat: ✅ BAJARILDI.** «R-B GO» (egasi, 2026-08-17, `counted_by='thisismurodov'` tasdig'i bilan) bitta tranzaksiyada ijro etildi: 9.1–9.10 tekshiruvlarning **barchasi PASS**, COMMIT amalga oshdi. Muhrlangan spetsifikatsiya: `docs/r-b-mapping-preview-2026-08-17.md` (§3 jadvali — 97 satr).

---

## 1. Nima yozildi (faqat 2 YANGI jadval)

| Jadval | Satr | Tavsif |
|---|---|---|
| `physical_baselines` | 9 | Har joy-sanoq bitta satr: konteyner yorlig'i, `warehouse_id`, sanoq sanasi, manba hujjat, `counted_by='thisismurodov'`, pozitsiyalar soni, jami kg, `status='MAPPED'` |
| `physical_baseline_positions` | 97 | Fizik pozitsiyalar sanoq varag'idan BAYT-AYNAN: nom, miqdor (o'z birligida), birlik, dona-satrlar uchun karobka/qop soni + 1 karobkadagi dona + birlik og'irlik (gramm), `weight_kg`, `item_id` (95 satrda; 2 EXACT'da NULL), mapping holati, izoh |

`position_no` 1..97 = muhrlangan preview §3 tartibi. Boshqa BIRORTA jadvalga yozuv yo'q (9.9 isbotladi).

### Baseline satrlari

| Joy | warehouse_id | Sana | Pozitsiya | Jami kg |
|---|---|---|---|---|
| C-20 | 26 | 2026-08-15 | 10 | 10 136.45 |
| C-19 | 25 | 2026-08-15 | 13 | 8 713.30 |
| C-18 | 24 | 2026-08-15 | 29 | 9 839.45 |
| C-02 | 8 | 2026-08-15 | 10 | 6 053.00 |
| C-04 | 10 | 2026-08-15 | 7 | 6 363.30 |
| C-06 | 12 | 2026-08-15 | 13 | 7 435.50 |
| C-16 | 22 | 2026-08-15 | 3 | 7 045.20 |
| C-17 | 23 | 2026-08-15 | 9 | 3 256.00 |
| C-15 | 21 | 2026-08-16 | 3 | 13 020.00 |
| **Jami** | | | **97** | **71 862.20** |

## 2. Egasining GO shartlari ↔ isbotlar

| Shart | Natija | Isbot |
|---|---|---|
| Faqat R-B mapping/registr yozilsin | ✅ | Skriptda faqat 2 yangi jadvalga yozuv; 9.9: sales/sale_items/stock_movements/inventory/products/raw_materials/batches/wip/items/aliases/legacy — son ham, yig'indi ham o'zgarmagan |
| 97 pozitsiya to'liq saqlansin | ✅ | 9.2: 97 satr, `position_no` zich 1..97; 9.7: muhrlangan kutilma bilan maydonma-maydon FULL JOIN — 0 farq |
| Qiymatlar sanoqdan AYNAN | ✅ | Generator §3 muhri bilan 97/97 satr bayt-aynan; 9.3: jami 71 862.20 (60 353.45 + 10 301.20 + 1 207.55), dona 126 360; 9.8: dona arifmetikasi qayta isbot |
| TM-000022 = 1 SKU, 2 lokatsiya | ✅ | 9.5: faqat shu item 2 satrda — C-19 168.6 + C-04 261.2 = 429.8 kg |
| 2 EXACT mapping qilinmasin | ✅ | 9.4: aynan «Rossiya Tros» (C-18, 531) va «Shroki 3.5 Oq» (C-02, 676.55) — `item_id=NULL`, `EXCLUDED_EXACT_CANDIDATE` |
| R-D boshlanmasin | ✅ | 9.9: BASELINE harakatlar oldin ham, keyin ham 0; inventar son/yig'indi o'zgarmagan |
| Inventar/legacy/sotuvlar tegilmasin | ✅ | 9.9 (yuqorida) + post-commit mustaqil tekshiruv: inventory=43, legacy=43, items=94, aliases=0 |
| counted_by='thisismurodov' | ✅ | 9.10: 9/9 baseline + 97/97 pozitsiya (`created_by` ham) |
| PASS bo'lmasa COMMIT yo'q | ✅ | Bitta tranzaksiya, `ON_ERROR_STOP`; har tekshiruv EXCEPTION → to'liq ROLLBACK (mashqda isbotlangan) |
| Avto-o'tish yo'q | ✅ | R-B'dan keyin hech narsa ijro etilmadi; R-D muzlatilgan holda qoldi |

## 3. Registr dizayni

- **Muzlatish triggerlari** (satr-darajali immutability):
  - `physical_baselines`: faqat `status MAPPED→LOADED` (R-D yo'li) — boshqa har qanday UPDATE/DELETE/TRUNCATE EXCEPTION.
  - `physical_baseline_positions`: faqat EXACT kandidatda `item_id NULL→qiymat` + `EXCLUDED→MAPPED` (+izoh) bitta UPDATE'da (egasi qarori №1 yo'li) — qolgan hamma narsa bloklangan.
  - 13 trigger-sinov mashq bazasida tasdiqlangan (11 blok + 2 ruxsat).
- **`status='MAPPED'`** yozildi (GO mapping'ni o'z ichiga oladi); `LOADED` R-D'da konteyner-boshiga o'tish uchun zaxiralangan. `RECORDED`/`TOTAL_ONLY` — kelajakdagi joylar uchun enum'da mavjud.
- **CHECK'lar:** kg-satrda `quantity=weight_kg`; dona-satrda `boxes×per_box=quantity` va `quantity×unit_weight_g=weight_kg×1000` — arifmetika DB darajasida majburiy.
- **Izoh siyosati:** DB'da faqat fakt-izohlar (metr-annotatsiya, EXACT sabab, TM-000022 ikkinchi joy). Legacy POSSIBLE nomzodlar DB'ga KIRMAYDI — faqat muhrlangan preview hujjatida.
- **Jadvallar atayin faqat prod'da** (items pretsedenti): initializer'lar (`init-db.ts`, bot `database.py`), Drizzle sxema va drift-xarita TABLES ro'yxatiga KIRITILMAGAN — drift-parity qurilish bo'yicha yashil; init-kod tahriri = prod yozuvi qoidasi ham buzilmaydi. Rollback (taklif §13): `DROP TABLE physical_baseline_positions, physical_baselines`.

## 4. Ijro jarayoni (xronologiya)

1. **Jonli qoziqlar** (faqat SELECT): 9 warehouse nomi aynan konteyner yorliqlari (C-02=8 … C-20=26), yangi jadvallar yo'q, items=94 (id 2..95), aliases=0.
2. **Generator** `scripts/src/r-b-generate-sql.ts`: dry-run'ning BARCHA nazoratlarini qayta bajaradi (97 pozitsiya, kg-yig'indilar sentgacha, metr-whitelist, bijeksiya, TM-000022, EXACT chetlash) + §3 muhri bilan 97/97 satr bayt-aynan solishtiradi; birorta farq — SQL fayl umuman yaratilmaydi (`rm` birinchi). Determinizm: ikki ijro sha256 aynan. TSC toza.
3. **Dry-run qayta ijro:** PASS, preview sha256 o'zgarmagan (muhr butun).
4. **Mashq №1** (o'sha serverdagi vaqtinchalik bazada, jonli items/warehouses CSV nusxasi bilan): skript COMMIT'gacha, 9.1–9.10 PASS, 13 trigger-sinov to'g'ri.
5. **Arxitektor tekshiruvi (prod'dan OLDIN):** 1 jiddiy topilma — warehouses qulflanmagan (parallel rename registrni buzishi mumkin). **Tuzatildi:** `LOCK TABLE warehouses IN SHARE MODE` snapshot'dan oldin. Qolgan barcha nazorat yo'nalishlari sog'lom deb baholandi.
6. **Mashq №2:** parallel warehouses UPDATE qulf tufayli bloklanishi jonli isbotlandi (lock_timeout) + to'liq skript qayta PASS.
7. **Zaxira:** `pg_dump` 18.6 (nix-store to'liq yo'l — server PG 18.4, PATH'dagi 16.10 versiya rad etdi) → `backups/pre-r-b-2026-08-17.dump` (992 467 bayt, gitignored).
8. **Prod ijro:** sha256 ijro oldidan tasdiqlandi (`9d8b73ca…`), `psql -v ON_ERROR_STOP=1`, bitta tranzaksiya REPEATABLE READ, `lock_timeout 5s` — NOTICE «9.1–9.10 BARCHASI PASS» → COMMIT.
9. **Post-commit mustaqil tekshiruv** (faqat o'qish): 9/97/95/2/94/71 862.20 — hammasi mos; BASELINE harakatlar 0; inventory/legacy o'zgarmagan.

Qulflar: `items`, `item_aliases`, `warehouses` — SHARE MODE (yozish bloklanadi, o'qish ochiq; biznes jadvallariga qulf YO'Q — zavod ishlayveradi). Tekshiruv 9.9 semantikasi: REPEATABLE READ ichida «oldin/keyin» tengligi SHU TRANZAKSIYA hech narsani o'zgartirmaganini isbotlaydi (boshqa sessiyalar cheklanmaydi) — shart aynan shu ko'lamda edi.

## 5. Ataylab QILINMAGAN ishlar (chegara)

- ❌ 2 EXACT kandidat mapping/yaratish — egasi qarori №1 ochiq (trigger faqat shu yo'lni keyinga ochiq qoldiradi).
- ❌ R-D: BASELINE harakatlar, inventar yozuvlari, legacy nollash — 0 ta.
- ❌ items/aliases'ga yozuv, rename, klassifikatsiya — 0 ta.
- ❌ Initializer/Drizzle/drift-xarita tahriri — atayin yo'q (items pretsedenti).
- ❌ Keyingi bosqichga avto-o'tish — yo'q; har bir R-D konteyner-yuklashi o'z «R-D GO C-xx» darvozasini kutadi.

Workflow'lar: `schema-drift` ta'sirlanmaydi (sxema-manba fayllari o'zgarmadi — yangi jadvallar drift xaritasidan tashqarida, qurilish bo'yicha); `api-tests` (~28 daq) o'tkazib yuborildi — runtime kod yo'llari o'zgarmadi (faqat `scripts/`, `scripts/sql/`, `docs/`).

## 6. Fayllar

| Fayl | Roli |
|---|---|
| `scripts/src/r-b-generate-sql.ts` | Deterministik SQL generator (muhr-tekshiruv bilan) |
| `scripts/sql/r-b-execution-2026-08-17.sql` | Ijro etilgan SQL (sha256 `9d8b73ca…`, qo'lda tahrir taqiqlangan) |
| `docs/r-b-mapping-preview-2026-08-17.md` | Muhrlangan spetsifikatsiya (o'zgartirilmadi — muhr butun) |
| `backups/pre-r-b-2026-08-17.dump` | GO oldidan to'liq prod zaxira (gitignored) |
| `docs/r-b-execution-report-2026-08-17.md` | Ushbu hisobot |

---

**Biznes ta'siri:** ★★★★☆ — 97 pozitsiyalik sanoq endi bazada muzlatilgan huquqiy fakt; R-D yuklash uchun yagona manba tayyor.
**Texnik xavf:** ★☆☆☆☆ — faqat yangi jadvallar, triggerlar bilan muzlatilgan; rollback = DROP TABLE; to'liq zaxira mavjud.
**Foydalanuvchi qiymati:** ★★★☆☆ — hozircha interfeys o'zgarmadi; qiymat R-D'da ochiladi (registr → balans).
**Kelajak bog'liqligi:** ★★★★★ — R-D har bir konteyner yuklashi aynan shu registrga tayanadi; 2 EXACT va №2–№5 savollar egasi qarorini kutadi.

«Biz taxmin qilmaymiz. Biz bilamiz.»
