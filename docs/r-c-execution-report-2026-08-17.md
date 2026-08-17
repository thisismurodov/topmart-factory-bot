# R-C IJRO HISOBOTI — 2026-08-17

**Vakolat:** egasining aniq «R-C GO» buyrug'i (2026-08-17).
**Bajarilgan spetsifikatsiya:** `docs/r-c-final-preview-2026-08-17.md` (muhrlangan preview, §9 checklist tartibida).
**Ijro fayli:** `scripts/sql/r-c-execution-2026-08-17.sql` (generator: `scripts/src/r-c-generate-sql.ts` — §4 jadvalidan bayt-aynan).
**Natija:** ✅ COMMIT — barcha tekshiruvlar PASS, ROLLBACK kerak bo'lmadi.

---

## 1. Nima qilindi (aynan GO chegarasida)

| # | Ish | Natija |
|---|-----|--------|
| 1 | `stock_movements_movement_type_check` yangilandi | `IN/OUT/TRANSFER` → `IN/OUT/TRANSFER/BASELINE` |
| 2 | 3 ta additiv ustun | `weight_kg NUMERIC`, `reference TEXT`, `reason TEXT` — nullable, default'siz, hammasi hozircha NULL |
| 3 | **94 ta neytral item** | `TM-000001…TM-000094`, id `2…95`, `created_by='thisismurodov'`, `source_kind='physical_count'` |

**Qilinmagani (ataylab, GO chegarasi):** pozitsiya→item_id mapping YO'Q · inventar baseline yuklanmadi (R-D muzlatilgan) · 2 EXACT kandidat (Rossiya Tros, Shroki 3.5 Oq) yaratilmadi ham, ulanmadi ham · legacy/sotuvlar/sanoq qiymatlariga tegilmadi · klassifikatsiya bayroqlari yozilmadi (hammasi FALSE — egasi dashboardda belgilaydi) · alias/narx o'zgarishi yo'q.

## 2. Item tarkibi (§4 jadvalga aynan mos)

- **82 kg-item** — jami 60 353.45 kg
- **12 dona-item** — jami 126 360 dona (10 301.20 kg ekvivalent)
- **Fizik massa:** 70 654.65 kg
- Notlarda provenans: sanoq sanasi (2026-08-15, C-15 uchun 2026-08-16) · konteyner · miqdor. TM-000022 ikki lokatsiyali maxsus not bilan: «C-19 168.6 kg + C-04 261.2 kg = 429.8 kg».
- id=1 yo'qligi normal: P2.1 smoke-testi sequence'dan id=1 ni sarflagan (ROLLBACK bilan). **Biznes kaliti SKU**, id emas.

## 3. Xavfsizlik arxitekturasi (2 tur mustaqil arxitektor ko'rigi)

1-tur ko'rik 3 SEVERE topdi, barchasi tuzatildi:
- **95-item poygasi:** tranzaksiya boshida `LOCK TABLE items, item_aliases IN ACCESS EXCLUSIVE MODE` (RR snapshot'dan OLDIN) — R-C yozadigan yagona ikki jadval to'liq qulflandi; jonli biznes jadvallari ataylab qulflanmadi (zavod ishlayveradi).
- **Sequence qoldig'i:** pre-gate `last_value=1 AND is_called=true` talab qiladi; ROLLBACK bo'lsa keyingi urinish ataylab bloklanadi; tiklanish yo'li fayl sarlavhasida hujjatlashtirilgan (kerak bo'lmadi).
- **Bayt-aynan muhr:** (a) ijro oldidan generator QAYTA ishga tushirilib sha256 taqqoslandi — deterministik, bayt-aynan; (b) tranzaksiya ichida `rc_expected` temp-jadval (94 satr) bilan FULL JOIN — har satrning sku/nom/birlik/not/source_kind/created_by maydonlari NULL-xavfsiz (`IS DISTINCT FROM`) tekshirildi (8.9).
- Eski CHECK DROP'dan oldin **aynan** kutilgan ta'rifga tenglashtirildi; `lock_timeout=5s`, `statement_timeout=120s`.

2-tur ko'rik tranzaksiyani qabul qildi, lekin restart xavfini ko'rsatdi — **initDb har bootda shartli backfill'lar bajaradi**. Preflight (faqat o'qish) bilan isbotladik:

| Predikat | Nomzodlar |
|----------|-----------|
| A: `products.in_sales` backfill | **0** |
| B: `line_role_config.pay_mode` backfill | **0** |
| C: legacy `stock_movements` backfill (batch×BOM) | **0** |
| D: admin seed (`thisismurodov` mavjudmi) | 1 (mavjud → seed yo'q) |

Bot tarafi: seedlar `db_meta` bayroqlari bilan qulflangan; bot bu operatsiyada restart qilinmaydi (deploy yo'q).

## 4. Ijro xronologiyasi

1. Jonli invariantlar hujjat qoziqlariga aynan mos edi: sales=45 · sale_items=143 · stock_movements=620 · inventory=43 · products=117 · items=0 · item_aliases=0 · seq=1/t.
2. `psql -v ON_ERROR_STOP=1` — bitta REPEATABLE READ tranzaksiya, **real 8.17 s**, exit=0.
3. In-txn NOTICE: «R-C TEKSHIRUV: 8.1–8.8 BARCHASI PASS» + 8.9 to'liq muvofiqlik → COMMIT.
4. Post-COMMIT mustaqil sanity: `items=94`, `created_by` faqat `thisismurodov`, id `2..95`, `aliases=0`, yangi ustunlar 100% NULL, biznes jadvallari o'zgarmagan (45/143/620/43/117).

## 5. Lockstep kod-diff (COMMIT'dan KEYIN, §9 tartibida)

Uchala deklaratsiya manbasi bir xil yangilandi (jonli baza allaqachon shu holatda edi — kod unga tenglashdi):

| Manba | O'zgarish |
|-------|-----------|
| `artifacts/telegram-bot/bot/database.py` | inline CHECK + BASELINE; CREATE'ga 3 ustun; konvergensiya DO-blokiga 3 `ADD COLUMN IF NOT EXISTS`; constraint-blokida CHECK + BASELINE |
| `artifacts/api-server/src/init-db.ts` | aynan shu 3 o'zgarish (o'z naqshlarida) |
| `lib/db/src/schema/stock_movements.ts` | `weightKg`/`reference`/`reason` ustunlari + `check()`da BASELINE |

Tekshiruvlar: `py_compile` OK · api-server toza boot («DB initialized», **«Backfilled» yozuvi YO'Q** — preflight tasdiqlandi) · **schema-drift workflow YASHIL**: `stock_movements: 13 ustun mos, 1 CHECK` — bot ↔ API ↔ Drizzle uch tomonlama parity, distribution parity ham to'liq.

api-tests ataylab ishga tushirilmadi (≈28 min): runtime kod yo'llari o'zgarmadi (faqat additiv sxema + init), 450/450 bugun ertalab yashil edi, drift-qo'riqchi sxema muvofiqligini qamrab oladi.

## 6. Keyingi darvozalar (hech biri avto-boshlanmaydi)

| Bosqich | Holat |
|---------|-------|
| Egasi klassifikatsiyasi | 94 item dashboardda bayroq kutmoqda (ixtiyoriy tezlikda) |
| R-B (sanoq registri) | GO berilmagan |
| R-D (110 baseline harakat) | **MUZLATILGAN** — konteyner-boshiga alohida GO |
| 2 EXACT kandidat | alohida qaror kutmoqda |
| §16 savollar №2–№5, №7 | ochiq |

---

**Business Impact:** ★★★★★ — inventar-resetning yuragi jonli: 94 kanonik SKU endi mavjud.
**Technical Risk:** ★☆☆☆☆ — bitta atomik txn, 9 qatlam tekshiruv, 0 side-effect isbotlangan.
**User Value:** ★★★★☆ — egasi endi dashboardda itemlarni klassifikatsiya qila oladi; baseline uchun poydevor tayyor.
**Future Dependency:** ★★★★★ — R-B/R-D shu 94 SKU ustiga quriladi; drift-qo'riqchi uch manbani bir xilda ushlab turadi.

«Biz taxmin qilmaymiz. Biz bilamiz.»
