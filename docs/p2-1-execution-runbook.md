# P2.1 Ijro Runbook — Canonical Items Foundation DDL

*Sana: 2026-08-15 · Holat: **KUTMOQDA — «P2.1 GO» ruxsati berilmagan, hech narsa bajarilmagan.***

> **DARVOZA (GATE):** Ushbu runbook egasining IMPLEMENTATION RULE talabiga javob:
> *«Har qanday yozuvdan oldin: aniq migratsiya rejasi, ta'sirlanadigan jadvallar/maydonlar,
> eski→yangi bog'lam, orqaga moslik mexanizmi va rollback strategiyasi ko'rsatilsin».*
> Quyidagi §5 bosqichlari FAQAT egasi aynan **«P2.1 GO»** deb yozgandan keyin bajariladi.
> Ungacha ruxsat etilgan yagona amal — §4 dry-run (100% read-only).

## 1. Qamrov — aynan nima yaratiladi

| Obyekt | Soni | Tafsilot |
|---|---|---|
| Yangi jadval | 2 | `items` (kanonik reestr), `item_aliases` (tarixiy nomlar) |
| Himoya trigger | 2 | `items_sku_immutable` (SKU o'zgartirish taqiqi), `items_no_delete` (o'chirish taqiqi — faqat `active=false`) |
| Yangi NULLABLE ustun | 10 | 8 jadvalda (quyida §2) |
| Indeks | 11 | item_id ustunlari + `items_source_uq` + `item_aliases_item_id_idx` |
| **Ma'lumot o'zgarishi** | **0** | 0 UPDATE, 0 DELETE, 0 INSERT — sof DDL |

DDL fayli: `scripts/sql/p2.1-items-foundation.sql` — hech qanday boot/migratsiya yo'liga ulanmagan, faqat qo'lda ishlatiladi. Model manbasi: `docs/p2-items-foundation-proposal.md` §1–2 (egasi 2026-08-15 shartlar bilan tasdiqlagan).

**Bu bosqichda BO'LMAYDIGAN narsalar:** items satrlari yaratilmaydi (P2.2), item_id to'ldirilmaydi (P2.3), dual-write yo'q (P2.4), 15 POSSIBLE/65 UNMATCHED/2 EXACT bo'yicha hech qanday amal yo'q, 48 541 kg Fizik Baseline ERP'ga yozilmaydi, BOM/rename/merge yo'q.

## 2. Ta'sirlanadigan jadvallar va eski→yangi bog'lam

| Jadval | Yangi ustun | Eski identity (qoladi!) | Yangi bog'lam (P2.3'da to'ldiriladi) |
|---|---|---|---|
| `products` | `item_id` | `sku`, `name` | items(source_kind='product', source_id=id) |
| `raw_materials` | `item_id` | `name` | items(source_kind='raw_material', source_id=id) |
| `product_materials` | `product_item_id`, `material_item_id` | `product_name` (matn), `raw_material_id` (ID ✓) | mahsulot-item + xomashyo-item |
| `inventory` | `item_id` | `product` (matn) + `product_type` | kontekstli nom→item |
| `stock_movements` | `item_id` | `product` (matn) + `product_type` | kontekstli nom→item |
| `batches` | `item_id` | `product` (matn) | mahsulot-item |
| `wip_movements` | `raw_material_item_id`, `product_item_id` | `raw_material`, `product` (matn) | ikkala tomon |
| `sale_items` | `item_id` | `product_name` (matn) | mahsulot-item (39 orphan NULL qoladi) |

**Eski→yangi tamoyili:** matn-nom ustunlari MANBA bo'lib qoladi va hech qachon o'chirilmaydi/o'zgartirilmaydi; item_id — yonma-yon qo'shimcha bog'lam. P4'gacha hech bir o'qish yo'li item_id'ga qaramaydi.

## 3. Orqaga moslik mexanizmi

1. Barcha yangi ustunlar NULLABLE va DEFAULT'siz → Postgres'da metadata-only ALTER (satrlar qayta yozilmaydi, lock qisqa).
2. Hech bir mavjud so'rov buzilmaydi: `SELECT *` kengayadi, xolos; INSERT'lar ustun ro'yxatini ko'rsatadi (kod tekshirilgan) yoki NULL qabul qilinadi.
3. Dual-init qoidasi: GO'dan keyin bot `init_db` + API `initDb` + Drizzle sxemasi + `check-schema-drift` TABLES ro'yxatiga `items`/`item_aliases` BIR VAQTDA qo'shiladi — `schema-drift` workflow buni doimiy qo'riqlaydi.
4. Yangi (fresh) baza: initializer'lar orqali xuddi shu sxemani oladi — `fresh-db-boot` guard testi tasdiqlaydi.
5. Production: deploy paytida initializer idempotent qo'llaydi (drizzle push EMAS — deploy qoidasi).

## 4. Dry-run (hozir ham mumkin, read-only)

```
pnpm --filter @workspace/scripts run p2-1-dry-run
```

Har bir obyekt uchun MAVJUD/KUTMOQDA holatini, ta'sirlanadigan jadvallar satr sonini (o'zgarmasligining dalili) va movement_type CHECK holatini chiqaradi. Hech narsa yozmaydi.

## 5. Ijro tartibi (FAQAT «P2.1 GO»dan keyin)

| # | Qadam | Tekshiruv |
|---|---|---|
| 1 | `pg_dump` snapshot (sxema+ma'lumot) + Replit checkpoint | fayl hajmi > 0 |
| 2 | Kod: bot `init_db` + API `initDb`ga items/item_aliases/ustunlar DDL'i; Drizzle sxemasiga `itemsTable`/`itemAliasesTable`; drift TABLES ro'yxatiga qo'shish | diff ko'rib chiqiladi |
| 3 | `schema-drift` workflow yashil (throwaway bazalarda — jonliga tegmaydi) | exit 0 |
| 4 | `api-tests` workflow yashil (fresh-db-boot guard shu yerda) | exit 0 |
| 5 | Jonli bazaga: `psql -X -v ON_ERROR_STOP=1 "$RAILWAY_DATABASE_URL" -f scripts/sql/p2.1-items-foundation.sql` | exit 0 **va** §7 katalog tekshiruvi — ikkalasi majburiy |
| 6 | §7 verifikatsiya so'rovlari — BEFORE/AFTER solishtirish | quyida |
| 7 | Dashboard/bot/field xulqi o'zgarmaganini smoke-test | asosiy sahifalar ochiladi |
| 8 | Egasiga natija hisoboti | — |

*Muhim: `-v ON_ERROR_STOP=1`siz psql server xatosidan keyin ham 0 bilan chiqa oladi (fayl `BEGIN` bilan boshlangani uchun xatodan keyingi `COMMIT` aslida ROLLBACK bo'ladi — "muvaffaqiyat" yolg'on bo'lardi). Shuning uchun muvaffaqiyat mezoni = exit 0 **plus** §7 verifikatsiya, hech qachon faqat exit kodi emas.*

## 6. Rollback strategiyasi

P4'gacha hech narsa item_id'ni O'QIMAYDI, shuning uchun istalgan nuqtada to'liq qaytish mumkin:

```sql
-- 6a. Ustunlarni olib tashlash (indekslari avtomatik ketadi):
ALTER TABLE products          DROP COLUMN IF EXISTS item_id;
ALTER TABLE raw_materials     DROP COLUMN IF EXISTS item_id;
ALTER TABLE product_materials DROP COLUMN IF EXISTS product_item_id;
ALTER TABLE product_materials DROP COLUMN IF EXISTS material_item_id;
ALTER TABLE inventory         DROP COLUMN IF EXISTS item_id;
ALTER TABLE stock_movements   DROP COLUMN IF EXISTS item_id;
ALTER TABLE batches           DROP COLUMN IF EXISTS item_id;
ALTER TABLE wip_movements     DROP COLUMN IF EXISTS raw_material_item_id;
ALTER TABLE wip_movements     DROP COLUMN IF EXISTS product_item_id;
ALTER TABLE sale_items        DROP COLUMN IF EXISTS item_id;
-- 6b. Jadvallar (item_aliases birinchi — FK):
DROP TABLE IF EXISTS item_aliases;
DROP TABLE IF EXISTS items;      -- no_delete trigger DROP TABLE'ga xalaqit qilmaydi
DROP FUNCTION IF EXISTS items_sku_immutable_fn();
DROP FUNCTION IF EXISTS items_no_delete_fn();
```

P2.2 backfill rollback'i (kelajak): `ALTER TABLE items DISABLE TRIGGER items_no_delete;` → `DELETE FROM items WHERE created_by='p2-backfill';` → `ENABLE TRIGGER`. **Hech qachon `TRUNCATE ... CASCADE` ishlatilmaydi** (item_id ustunli katta jadvallarni bo'shatib yuboradi). Halokat holati: snapshot restore + checkpoint rollback. Kod tomoni: initializer/Drizzle qo'shimchalari git revert.

## 7. Verifikatsiya so'rovlari (BEFORE/AFTER)

```sql
-- Yangi obyektlar paydo bo'ldi:
SELECT to_regclass('public.items'), to_regclass('public.item_aliases');
-- Ma'lumot o'zgarmadi (BEFORE qiymatlari bilan solishtiriladi):
SELECT (SELECT COUNT(*) FROM stock_movements),  -- kutilma: 608
       (SELECT COUNT(*) FROM batches),          -- kutilma: 274
       (SELECT COUNT(*) FROM sale_items),       -- kutilma: 143
       (SELECT COUNT(*) FROM inventory),        -- kutilma: 43
       (SELECT COUNT(*) FROM wip_movements),    -- kutilma: 167
       (SELECT COUNT(*) FROM products),         -- kutilma: 117
       (SELECT COUNT(*) FROM raw_materials);    -- kutilma: 17
-- Hamma yangi ustunlar NULL (hech narsa to'ldirilmagan):
SELECT COUNT(*) FROM products WHERE item_id IS NOT NULL;         -- 0
SELECT COUNT(*) FROM stock_movements WHERE item_id IS NOT NULL;  -- 0
-- SKU trigger ishlayapti (xato berishi KERAK):
-- UPDATE items SET sku='TEST' WHERE id=1;  -- RAISE EXCEPTION kutiladi
```

*Eslatma: BEFORE satr sonlari 2026-08-15 holati; GO kuni yangidan olinadi (jonli tizim ishlab turibdi).*

## 8. Bog'liq hujjatlar

- `docs/p2-items-foundation-proposal.md` — tasdiqlangan model + bosqichlar (P2.0–P2.4)
- `docs/physical-count-reconciliation-2026-08-15.md` — 48 541 kg Fizik Baseline (MUZLATILGAN)
- Drift-tuzatish (movement_type CHECK) — 2026-08-15'da alohida bajarildi (egasi buyrug'i), bu runbook'ka KIRMAYDI.
