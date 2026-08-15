# P2 — Canonical Items Foundation: TAKLIF (proposal)

*Sana: 2026-08-15 · Holat: **FAQAT TAKLIF — bazaga hech narsa yozilmadi, hech narsa o’zgartirilmadi.** Asos: tasdiqlangan arxitektura auditi (`docs/canonical-inventory-architecture-audit.md`), P1 xaritasi (`docs/p1-data-mapping.md`), qabul qilingan sanoq hisoboti (`docs/physical-count-reconciliation-2026-08-15.md`) va jonli baza (faqat SELECT).*

## 0. Qabul qilingan cheklovlar (sizning buyrug’ingiz)

| # | Cheklov | Holat |
|---|---|---|
| 1 | Hech qanday inventory adjustment YO’Q (2 ta EXACT ham MUZLATILDI) | ✓ bajarilmoqda |
| 2 | 48 541 kg fizik mol UPDATE/IN/OUT/TRANSFER orqali kiritilMAYDI | ✓ kiritilmadi |
| 3 | Mavjud itemlar o’zgartirilMAYDI, merge YO’Q, rename YO’Q | ✓ taklifda ham yo’q |
| 4 | SKU migratsiya hali YO’Q, BOM tegilMAYDI, balanslar tegilMAYDI | ✓ P2 sxemasi additiv, xolos |
| 5 | Yangi itemlar avtomatik yaratilMAYDI | ✓ 82 pozitsiya — faqat KANDIDAT ro’yxati |

P2 nima QILADI: yagona `items` reestri va unga NULLABLE bog’lamlar (ustunlar) qo’shadi — hech bir mavjud qiymatga tegmasdan. P2 nima QILMAYDI: merge, rename, adjustment, o’qish yo’llarini o’zgartirish (ular P3–P6 fazalari, har biri alohida ruxsat bilan).

## 1. Canonical item modeli

Siz so’ragan har bir element modelda qanday hal bo’ladi:

| Talab | Yechim |
|---|---|
| Immutable item ID | `items.id` (SERIAL) — hech qachon o’zgarmaydi, qayta ishlatilmaydi; itemlar O’CHIRILMAYDI (faqat `active=false`) |
| SKU | `items.sku` UNIQUE NOT NULL — yaratilgach IMMUTABLE (trigger himoyasi); mavjud 117 SKU aynan ko’chiriladi, 17 xomashyoga `RM-…` taklif |
| Item type | ALOHIDA enum EMAS — tasdiqlangan 15-qoidaga ko’ra raw/finished HOLAT, identity emas; ko’rsatish turi bayroqlardan hisoblanadi |
| Raw / finished / intermediate qobiliyati | `is_raw`, `is_finished`, `is_intermediate` bayroqlari (bitta item bir nechtasiga ega bo’la oladi — «PP 1500D ham sotiladi, ham ishlatiladi» muammosining yechimi) |
| Purchasable | `is_purchasable` |
| Producible | `is_producible` (= is_manufactured; keyin «Producible + faol BOM yo’q = partiya blok» qoidasi P5’da) |
| Sellable | `is_sellable` |
| Inventory-tracked | `inventory_tracked` (default TRUE; xizmat-itemlar uchun kelajakda FALSE) |
| O’lchov birligi | `unit` CHECK ('kg','dona') — kengaytiriladigan; «50 metr» kabi yozuvlar NOM SPETSIFIKATSIYASI bo’lib qoladi (sanoq qoidasiga mos), metr birligi kerak bo’lsa keyin ADDITIV qo’shiladi |
| Location balance | `inventory(item_id, warehouse_id)` UNIQUE + WIP lokatsiya sifatida: **Global qoldiq = Σ konteynerlar + Σ WIP** (tasdiqlangan saqlanish qoidasi); `raw_materials.current_stock` P2’da TEGILMAYDI (P4’da keshga aylanadi) |
| BOM relationship | `product_materials`ga `product_item_id` + `material_item_id` (nullable) — BOM item’ga bog’lanadi, nomga emas; o’z-o’ziga 1:1 self-BOM’lar (dual egizaklar) P2’da SAQLANADI, faqat belgilanadi |
| Transformation relationship | `transformations` jadvali (input_item + kg → output_item + kg, atomik, 2 ledger yozuvi) — sxemasi quyida, JORIY ETISH P5’da |

### Ko’rsatish turi (hisoblanadi, saqlanmaydi)

```text
is_raw ∧ ¬is_finished             → XOMASHYO
is_finished ∧ ¬is_raw            → TAYYOR
is_intermediate                   → ORALIQ
bir nechta bayroq                 → ARALASH (masalan: xomashyo + sotiladigan)
```

## 2. Sxema taklifi (DDL — BAJARILMAGAN)

**Kirish sharti (R8):** har bir jadval/ustun bot `init_db` (Python) VA API `initDb` (TS) VA Drizzle mirror’iga BIR VAQTDA, idempotent qo’shiladi; `schema-drift` tekshiruvi yangilanadi. Aks holda yangi baza buziladi — bu bizda sinalgan xato.

```sql
-- P2.1a: yangi jadvallar (mavjud hech narsaga tegmaydi)
CREATE TABLE IF NOT EXISTS items (
  id                SERIAL PRIMARY KEY,        -- immutable ichki ID
  sku               TEXT NOT NULL UNIQUE,      -- immutable biznes kalit
  display_name      TEXT NOT NULL,             -- ko’rsatish nomi (o’zgarishi tarixga ta’sir qilmaydi)
  unit              TEXT NOT NULL CHECK (unit IN ('kg','dona')),
  is_raw            BOOLEAN NOT NULL DEFAULT FALSE,
  is_intermediate   BOOLEAN NOT NULL DEFAULT FALSE,
  is_finished       BOOLEAN NOT NULL DEFAULT FALSE,
  is_purchasable    BOOLEAN NOT NULL DEFAULT FALSE,
  is_producible     BOOLEAN NOT NULL DEFAULT FALSE,
  is_sellable       BOOLEAN NOT NULL DEFAULT FALSE,
  inventory_tracked BOOLEAN NOT NULL DEFAULT TRUE,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  source_kind       TEXT NOT NULL CHECK (source_kind IN ('product','raw_material','physical_count','manual')),
  source_id         INTEGER,                   -- backfill izi: products.id / raw_materials.id
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS items_source_uq ON items(source_kind, source_id) WHERE source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS item_aliases (      -- rename O’RNIGA: tarixiy/muqobil nomlar shu yerda yashaydi
  id         SERIAL PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES items(id),
  alias_name TEXT NOT NULL UNIQUE,
  source     TEXT NOT NULL CHECK (source IN ('legacy_name','sale_orphan','physical_count','distribution')),
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL
);

-- SKU immutability (trigger eskizi):
-- CREATE TRIGGER items_sku_immutable BEFORE UPDATE ON items
--   FOR EACH ROW WHEN (OLD.sku IS DISTINCT FROM NEW.sku)
--   EXECUTE FUNCTION reject_change();  -- 'SKU o’zgarmas' xatosi

-- P2.1b: tranzaksiya jadvallariga NULLABLE bog’lamlar (qiymatlar TEGILMAYDI)
ALTER TABLE products          ADD COLUMN IF NOT EXISTS item_id INTEGER REFERENCES items(id);
ALTER TABLE raw_materials     ADD COLUMN IF NOT EXISTS item_id INTEGER REFERENCES items(id);
ALTER TABLE product_materials ADD COLUMN IF NOT EXISTS product_item_id  INTEGER REFERENCES items(id);
ALTER TABLE product_materials ADD COLUMN IF NOT EXISTS material_item_id INTEGER REFERENCES items(id);
ALTER TABLE inventory         ADD COLUMN IF NOT EXISTS item_id INTEGER REFERENCES items(id);
ALTER TABLE stock_movements   ADD COLUMN IF NOT EXISTS item_id INTEGER REFERENCES items(id);
ALTER TABLE batches           ADD COLUMN IF NOT EXISTS item_id INTEGER REFERENCES items(id);
ALTER TABLE wip_movements     ADD COLUMN IF NOT EXISTS raw_material_item_id INTEGER REFERENCES items(id);
ALTER TABLE wip_movements     ADD COLUMN IF NOT EXISTS product_item_id      INTEGER REFERENCES items(id);
ALTER TABLE sale_items        ADD COLUMN IF NOT EXISTS item_id INTEGER REFERENCES items(id);
-- + har biriga index: CREATE INDEX IF NOT EXISTS ..._item_id_idx ON ...(item_id);

-- P5’DA (hozir YARATILMAYDI, faqat rezerv sxema): transformations
-- CREATE TABLE transformations (
--   id SERIAL PRIMARY KEY,
--   input_item_id  INTEGER NOT NULL REFERENCES items(id),
--   output_item_id INTEGER NOT NULL REFERENCES items(id),
--   input_kg NUMERIC NOT NULL CHECK (input_kg > 0),
--   output_kg NUMERIC NOT NULL CHECK (output_kg > 0),  -- loss hisobi: kelajak kengaytmasi
--   line_id INTEGER, from_warehouse_id INTEGER, to_warehouse_id INTEGER,
--   note TEXT, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
-- );
```

**MUHIM chegara:** 'ADJUSTMENT' harakat turini kiritish bu taklifga KIRMAYDI — u sanoq hisobotining 7-bosqichidagi ALOHIDA taklif bo’lib qoladi (P3 oldidan alohida ruxsat). Aniqlik (2026-08-15, jonli bazadan `pg_constraint` orqali tekshirildi): JONLI bazada `stock_movements_movement_type_check` CHECK’i BOR (faqat IN/OUT/TRANSFER — adjustment hozir arxitektura darajasida bloklangan), LEKIN ikkala initializer’da (bot `init_db`, API `initDb`) bu CHECK YO’Q — yangi (fresh) baza uni olmaydi. Bu drift P3 ADJUSTMENT taklifi bilan BIRGA hal qilinadi (jonli CHECK’ni kengaytirish + initializer’larga bir xil CHECK qo’shish); P2 unga TEGMAYDI.

## 3. Mavjud katalog inventarizatsiyasi — 117 mahsulot

Bayroqlar — DALIL asosidagi TAKLIF (yakuniy belgini SIZ tasdiqlaysiz; ayniqsa «Ha?» belgilangan xarid nomzodlari). Hech narsa o’zgartirilmagan.

Yig’ma: ishlab chiqariladigan (BOM bor) **59** · xarid nomzodi (BOMsiz) **57** · arxiv nomzodi **1** · dual (xomashyo egizagi) **4** · savdo botida nom-mos **58/69**.

| SKU | Nomi | Birlik | Dalillar | Qoldiq | Producible? | Purchasable? | Sellable? | Belgi |
|---|---|---|---|---|---|---|---|---|
| `05BABINOQ` | 0.5 babin / oq | dona | BOM 1 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `05BABINQORA` | 0.5 Babin / Qora | dona | BOM 1 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `QAZI05` | 0.5 Kg qazi ip | dona | BOM 1 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `20MTRRANG` | 20 METR RANGLI ingichka | kg | BOM 2 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 2) | — | Ha (sot. 1) |  |
| `5-MM-GIBRID` | 5 MM GIBRID | kg | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha | o’xshash ↔ `5MMGIBRID`, SKU ham to’qnashadi (Q4) |
| `5MMGIBRID` | 5 mm Gibrid Lenta | kg | BOM 2 · partiya 0 · sotuv 2 · harakat 1 | −52 | Ha (BOM 2) | — | Ha (sot. 2) | o’xshash ↔ `5-MM-GIBRID` (Q4) |
| `5MMSHRQALIN` | 5 mm -  Qalin Shakar | kg | BOM 1 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `5MMTULPOR` | 5 mm Tulpor | kg | BOM 1 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `5MMYPSHR` | 5 mm - Yupqa shakar | kg | BOM 1 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `BABQO/05` | Babin Qora 0.5 mm | kg | BOM 1 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 1) | DUAL — xomashyo egizagi bor (Q5), P2’da 2 alohida item, merge KEYIN |
| `BABSA/05` | Babin Sariq 0.5 mm | kg | BOM 1 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 1) | DUAL — xomashyo egizagi bor (Q5), P2’da 2 alohida item, merge KEYIN |
| `BOYIN-ARZON` | Bo’yin Arzon | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `BOYIN-QIMMAT` | Bo’yin Qimmat | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `CRDMSH` | Cord Maloshni | kg | BOM 1 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 1) | DUAL — xomashyo egizagi bor (Q5), P2’da 2 alohida item, merge KEYIN |
| `DOR-IP-10-METR` | Dor Ip 10 metr | kg | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `DOR-IP-20-METR` | Dor ip 20 metr | kg | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `GILAM-TROS-KURTKA-TROS` | Gilam tros kurtka tros | kg | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `DVAR/4KG` | Ikki Qavat Arqon / 4 kg | kg | BOM 1 · partiya 82 · sotuv 3 · harakat 87 | 465 | Ha (BOM 1) | — | Ha (sot. 3) |  |
| `DVAR/5KG` | Ikki Qavat Arqon / 5 kg | kg | BOM 1 · partiya 65 · sotuv 3 · harakat 68 | −346 | Ha (BOM 1) | — | Ha (sot. 3) |  |
| `DVAR/6kg` | Ikki Qavat Arqon / 6 kg | kg | BOM 1 · partiya 54 · sotuv 2 · harakat 56 | 50 | Ha (BOM 1) | — | Ha (sot. 2) |  |
| `IKKIRANAR` | Ikki Qavat Arqon Rangli | kg | BOM 1 · partiya 0 · sotuv 1 · harakat 1 | −27 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `IKKI-QAVAT-DVAYNOY-ARQON` | Ikki Qavat Dvaynoy Arqon Oq | kg | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `Kanoblar` | Kanob | kg | BOM 1 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 1) | DUAL — xomashyo egizagi bor (Q5), P2’da 2 alohida item, merge KEYIN |
| `KPT50` | Kaptiva | kg | BOM 1 · partiya 0 · sotuv 2 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 2) |  |
| `KATTA-MEXANIZM-5T-LIK` | Katta mexanizm 5T lik | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `KICHIK-MEXANIZ-5-T-LIK` | Kichik mexaniz 5 T lik | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `KURCHONNI-1-KG` | Kurchonni 1 kg | kg | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `KURTKA-6-7-KG` | Kurtka 6-7 kg | kg | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `KURTKATROS` | Kurtka Tros 2-3 kg | kg | BOM 1 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `KURTKATROS45` | Kurtka Tros 4-5 kg | kg | BOM 1 · partiya 3 · sotuv 1 · harakat 3 | 26 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `LEBYOTKA-3-TONNALIK` | Lebyotka 3 tonnalik | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `LEBYOTKA-IKKITALIK-QORA` | Lebyotka ikkitalik qora | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `LEBYOTKA-IKKITALIK-YASHI` | Lebyotka ikkitalik yashil | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `LEBYOTKA-KICHIK-5-METRLI` | Lebyotka kichik 5 metrli | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `LEBYOTKA-ODDIY-ARQONLI` | Lebyotka Oddiy arqonli | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `LEBYOTKA-QORA-OZI-TORTAR` | Lebyotka Qora O’zi Tortar Mexanizm | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `LESKA-100-GRAMM-100-METR` | Leska 100 gramm 100 metr | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `LESKA-60-GRAMM-50-METR` | Leska 60 gramm 50 metr | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `NOVINKA` | Novinka | kg | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `NUXTA-ORTA-PUSHTI` | Nuxta O’rta Pushti | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `NUXTA-QIZIL-KICHIK` | Nuxta qizil kichik | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `NUXTA-QIZIL-ORTA` | Nuxta qizil o’rta | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `NUXTA-RANGLI-KATTA` | Nuxta Rangli Katta | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `NUXTA-SHAKAR-KATTA` | Nuxta Shakar Katta | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `NUXTA-SHAKAR-KICHIK` | Nuxta shakar kichik | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `POKAK` | Po’kak | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `POKAK-KILOLI-5-KG` | Po’kak Kiloli 5 kg | kg | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `PP2X1500` | Polipropilen Oq 2 x 1500 | kg | BOM 1 · partiya 0 · sotuv 2 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 2) |  |
| `ply144` | Polyamide 144 | kg | BOM 1 · partiya 0 · sotuv 1 · harakat 4 | −931 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `PLYCORD03` | Polyamide Cord 0.3mm | kg | BOM 0 · partiya 0 · sotuv 1 · harakat 2 | −410 | — | Ha? (BOMsiz — tasdiq kerak) | Ha (sot. 1) |  |
| `PP2X15OQ` | PP 2 X 1500 / OQ | kg | BOM 1 · partiya 0 · sotuv 5 · harakat 5 | −1 883 | Ha (BOM 1) | — | Ha (sot. 5) |  |
| `PP2X1500/QIZIL` | PP 2 X 1500 / Qizil | kg | BOM 1 · partiya 0 · sotuv 1 · harakat 1 | −88 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `QOP-IP-100-TALIK` | Qop ip 100 talik | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha | dublikat juftlik ↔ `QP100` (Q3) |
| `QP100` | Qop Ip - 100 talik | dona | BOM 1 · partiya 1 · sotuv 1 · harakat 3 | 77 900 | Ha (BOM 1) | — | Ha (sot. 1) | dublikat juftlik ↔ `QOP-IP-100-TALIK` (Q3) |
| `QP120` | Qop ip - 120 talik | dona | BOM 1 · partiya 0 · sotuv 1 · harakat 1 | 9 240 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `QOP-IP-800-GRAMM` | Qop ip 800 gramm | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `QP80` | Qop ip - 80 talik | dona | BOM 1 · partiya 0 · sotuv 1 · harakat 1 | 3 040 | Ha (BOM 1) | — | Ha (sot. 1) | dublikat juftlik ↔ `QOP-IP-80-TALIK` (Q3) |
| `QOP-IP-80-TALIK` | Qop ip 80 talik | dona | BOM 0 · partiya 0 · sotuv 1 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha (sot. 1) | dublikat juftlik ↔ `QP80` (Q3) |
| `QOra` | Qora Rang | kg | BOM 0 · partiya 0 · sotuv 1 · harakat 1 | −4 | — | Ha? (BOMsiz — tasdiq kerak) | Ha (sot. 1) |  |
| `RANGLI-10-METR-STRUPA` | Rangli 10 Metr Strupa | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `RANGLI-20-METR` | Rangli 20 metr | kg | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `RANGLI-50-METR-TULPOR` | Rangli 50 metr ( Tulpor) | kg | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `REELS` | Reels | kg | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `RJ100OQ` | Reja ip 100 gr / Oq | dona | BOM 1 · partiya 3 · sotuv 0 · harakat 4 | 8 800 | Ha (BOM 1) | — | — |  |
| `RJ100QORA` | Reja ip 100 gr / Qora | dona | BOM 1 · partiya 5 · sotuv 1 · harakat 9 | 10 200 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `RJ100SARIQ` | Reja ip 100 gr / Sariq | dona | BOM 1 · partiya 9 · sotuv 1 · harakat 10 | 12 680 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `RJ30OQ` | Reja ip 30 gr / OQ | dona | BOM 1 · partiya 4 · sotuv 0 · harakat 5 | 12 400 | Ha (BOM 1) | — | — |  |
| `RJ30QORA` | Reja ip 30 gr / Qora | dona | BOM 1 · partiya 0 · sotuv 1 · harakat 1 | 18 800 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `RJ30SARIQ` | Reja ip 30 gr / Sariq | dona | BOM 1 · partiya 8 · sotuv 1 · harakat 9 | 25 600 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `RJ50OQ` | Reja ip 50 gr / OQ | dona | BOM 1 · partiya 2 · sotuv 0 · harakat 3 | 12 800 | Ha (BOM 1) | — | — |  |
| `RJ50QORA` | Reja ip 50 gr / Qora | dona | BOM 1 · partiya 18 · sotuv 1 · harakat 20 | 23 800 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `RJ50SARIQ` | Reja ip 50 gr / Sariq | dona | BOM 1 · partiya 19 · sotuv 1 · harakat 21 | 22 400 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `REPP115GR` | Reja ip PP / 115 gr | dona | BOM 1 · partiya 0 · sotuv 0 · harakat 0 | 0 | Ha (BOM 1) | — | — | dublikat nomzodi ↔ `REJA-IP-PP-115-GRAMM` (Q4) |
| `REJA-IP-PP-115-GRAMM` | Reja ip PP 115 gramm | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha | dublikat nomzodi ↔ `REPP115GR` (Q4) |
| `REPP40GR` | Reja ip PP / 40 gr | dona | BOM 1 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `REPP50GR` | Reja ip PP / 50 gr | dona | BOM 1 · partiya 1 · sotuv 0 · harakat 1 | 100 | Ha (BOM 1) | — | — | dublikat nomzodi ↔ `REJA-IP-PP-50-GRAMM` (Q4) |
| `REJA-IP-PP-50-GRAMM` | Reja ip PP 50 gramm | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha | dublikat nomzodi ↔ `REPP50GR` (Q4) |
| `REPP60GR` | Reja ip PP / 60 gr | dona | BOM 1 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `REPP80GR` | Reja ip PP / 80 gr | dona | BOM 0 · partiya 0 · sotuv 1 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha (sot. 1) | dublikat nomzodi ↔ `REJA-IP-PP-80-GRAMM` (Q4) |
| `REJA-IP-PP-80-GRAMM` | Reja ip PP 80 gramm | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha | dublikat nomzodi ↔ `REPP80GR` (Q4) |
| `REJA-IP-SAPOJNIY-100-GRA` | Reja ip Sapojniy 100 gramm | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `REJA-IP-SAPOJNIY-30-GRAM` | Reja ip Sapojniy 30 gramm | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `REJA-IP-SAPOJNIY-50-GRAM` | Reja ip Sapojniy 50 gramm | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `ROSSIYATROS` | Rossiya Tros | kg | BOM 1 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `SLFSTR` | Salafan Strupa | kg | BOM 2 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 2) | — | Ha (sot. 1) |  |
| `SHAKAR` | Shakar | kg | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `SHKR/18/85` | Shakar 1.5 kg | kg | BOM 1 · partiya 0 · sotuv 2 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 2) |  |
| `SHKR28` | Shakar 2.8 | kg | BOM 1 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `SHFDY/KOK` | Shlanka FDY/ Ko'k | dona | BOM 1 · partiya 0 · sotuv 2 · harakat 1 | −32 | Ha (BOM 1) | — | Ha (sot. 2) |  |
| `SHFDY/OQ` | Shlanka FDY / OQ | dona | BOM 1 · partiya 0 · sotuv 3 · harakat 1 | −104 | Ha (BOM 1) | — | Ha (sot. 3) |  |
| `SHFDY/QIZIL` | Shlanka FDY / QIzil | dona | BOM 1 · partiya 0 · sotuv 2 · harakat 1 | −32 | Ha (BOM 1) | — | Ha (sot. 2) |  |
| `SHFDY/QORA` | Shlanka FDY / Qora | dona | BOM 1 · partiya 0 · sotuv 1 · harakat 1 | −16 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `SHFDY/YASHIL` | Shlanka FDY/Yashil | dona | BOM 1 · partiya 0 · sotuv 2 · harakat 1 | −32 | Ha (BOM 1) | — | Ha (sot. 2) |  |
| `SHLANKA-PARASHUT-50-METR` | Shlanka Parashut 50 metr | kg | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `SHLPOLYD` | Shlanka Polyamide | dona | BOM 1 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `SHLPP/OQ` | Shlanka PP / Oq | kg | BOM 1 · partiya 0 · sotuv 6 · harakat 2 | −798 | Ha (BOM 1) | — | Ha (sot. 6) |  |
| `SHLPP/RANGli` | Shlanka PP / Rangli | kg | BOM 1 · partiya 0 · sotuv 2 · harakat 1 | −68 | Ha (BOM 1) | — | Ha (sot. 2) |  |
| `SHOLCHAOQUZUN` | Sholcha Oq | kg | BOM 1 · partiya 0 · sotuv 0 · harakat 2 | 47 000 | Ha (BOM 1) | — | — | Sholcha oilasi — MAXSUS NAZORAT (Q1) |
| `SHOLCHASARIQKALTA` | Sholcha Sariq | kg | BOM 1 · partiya 0 · sotuv 0 · harakat 3 | 60 000 | Ha (BOM 1) | — | — | Sholcha oilasi — MAXSUS NAZORAT (Q1) |
| `shrk35` | Shroki 3.5 | kg | BOM 1 · partiya 0 · sotuv 1 · harakat 1 | −125 | Ha (BOM 1) | — | Ha (sot. 1) | o’xshash ↔ `SHROKI-3-5-OQ` — fizik sanoq IKKALASINI alohida tasdiqladi (Q4 ✓) |
| `SHROKI-3-5-OQ` | Shroki 3.5 Oq | kg | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha | o’xshash ↔ `shrk35` — fizik sanoq IKKALASINI alohida tasdiqladi (Q4 ✓) |
| `STRUPA-OQ-100-METR` | Strupa Oq 100 metr | kg | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `ST70M` | Strupa Sari | kg | BOM 1 · partiya 0 · sotuv 1 · harakat 1 | −13 | Ha (BOM 1) | — | Ha (sot. 1) | dublikat nomzodi ↔ `STRUPA-SARIQ` (Q4) |
| `STRUPA-SARIQ` | Strupa Sariq | kg | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha | dublikat nomzodi ↔ `ST70M` (Q4) |
| `th50` | Tahoe 50 m | kg | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | — | — | hech qayerda ishlatilmagan — ARXIV NOMZODI (Q9) |
| `TAROQ-BRITVA` | Taroq Britva | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `TAROQ-PANSHAXA` | Taroq Panshaxa | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `TAROQ-PERCHATKA` | Taroq Perchatka | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `TAROQ-YUMALOQ-4-TALIK` | Taroq Yumaloq 4 talik | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `TAROQ-YUMALOQ-5-TALIK` | Taroq Yumaloq 5 talik | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `TAROQ-YUMALOQ-6-TALIK` | Taroq Yumaloq 6 talik | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `TORTPOLYD` | Tortqi Polyamide | dona | BOM 1 · partiya 0 · sotuv 3 · harakat 1 | −50 | Ha (BOM 1) | — | Ha (sot. 3) |  |
| `TULPOR` | Tulpor | kg | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `TUP80` | Tulpor 80 metr | kg | BOM 1 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `TULPOR-NUXTA` | Tulpor Nuxta | dona | BOM 0 · partiya 0 · sotuv 0 · harakat 0 | 0 | — | Ha? (BOMsiz — tasdiq kerak) | Ha |  |
| `TLPRANG80` | Tulpor Rangli 80 metr | kg | BOM 1 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 1) |  |
| `ZUBRL` | Zubr Lenta | kg | BOM 1 · partiya 0 · sotuv 1 · harakat 0 | 0 | Ha (BOM 1) | — | Ha (sot. 1) |  |

## 4. Mavjud katalog inventarizatsiyasi — 17 xomashyo

Hammasi: `is_raw=Ha`, `is_purchasable=Ha` (taklif), `inventory_tracked=Ha`. SKU ustuni — taklif (xomashyolarda SKU hech qachon bo’lmagan).

| ID | Nomi | SKU (taklif) | Birlik | Valyuta | Global qoldiq | BOM’da | Harakat | Belgi |
|---|---|---|---|---|---|---|---|---|
| 11 | Babin Qora 0.5 mm | `RM-BABIN-QORA-0-5-MM` *(taklif)* | kg | USD | −1 018.96 | 4 | 23 | DUAL — mahsulot egizagi bor (Q5); GLOBAL MANFIY — P3 reconciliation (Q2) |
| 19 | Babin Sariq 0.4 | `RM-BABIN-SARIQ-0-4` *(taklif)* | kg | USD | 5 000 | 1 | 0 | 5 000 kg harakatsiz kiritilgan (Q7) |
| 10 | Babin Sariq 0.5 mm | `RM-BABIN-SARIQ-0-5-MM` *(taklif)* | kg | USD | −1 844.96 | 5 | 36 | DUAL — mahsulot egizagi bor (Q5); GLOBAL MANFIY — P3 reconciliation (Q2) |
| 7 | Cord Maloshni | `RM-CORD-MALOSHNI` *(taklif)* | kg | USD | 0 | 2 | 0 | DUAL — mahsulot egizagi bor (Q5) |
| 6 | FDY YARN | `RM-FDY-YARN` *(taklif)* | kg | USD | 0 | 5 | 0 |  |
| 16 | Kanob | `RM-KANOB` *(taklif)* | kg | USD | 0 | 1 | 0 | DUAL — mahsulot egizagi bor (Q5) |
| 5 | Polipropilen 2 x 1500 / OQ | `RM-POLIPROPILEN-2-X-1500-OQ` *(taklif)* | kg | USD | −12 092.3 | 11 | 211 | GLOBAL MANFIY — P3 reconciliation (Q2) |
| 9 | Polipropilen 2 x 1500 / rangli | `RM-POLIPROPILEN-2-X-1500-RANGLI` *(taklif)* | kg | USD | 0 | 2 | 0 |  |
| 2 | Polipropilen BSF | `RM-POLIPROPILEN-BSF` *(taklif)* | kg | USD | −117 | 8 | 3 | GLOBAL MANFIY — P3 reconciliation (Q2) |
| 1 | Polipropilen ip | `RM-POLIPROPILEN-IP` *(taklif)* | kg | UZS | 0 | 0 | 0 | BOM 0, qoldiq 0, harakat 0 — ARXIV NOMZODI (Q8) |
| 15 | Polyamide | `RM-POLYAMIDE` *(taklif)* | kg | USD | 0 | 5 | 0 |  |
| 12 | PP Xom oq | `RM-PP-XOM-OQ` *(taklif)* | kg | USD | 0 | 5 | 0 |  |
| 13 | pp xom rangli | `RM-PP-XOM-RANGLI` *(taklif)* | kg | USD | 0 | 5 | 0 |  |
| 17 | Qazi ip | `RM-QAZI-IP` *(taklif)* | kg | UZS | 0 | 1 | 0 |  |
| 3 | Qop ip | `RM-QOP-IP` *(taklif)* | kg | USD | −255 | 3 | 1 | GLOBAL MANFIY — P3 reconciliation (Q2) |
| 18 | Salafan | `RM-SALAFAN` *(taklif)* | kg | UZS | 0 | 1 | 0 |  |
| 8 | Sholcha | `RM-SHOLCHA` *(taklif)* | kg | USD | 25 000 | 3 | 1 | Sholcha oilasi — MAXSUS NAZORAT (Q1) |

**P2 backfill natijasi (taklif): 117 + 17 = 134 item, 1:1, MERGE YO’Q.** Dual juftliklar (4), dublikatlar (Q3/Q4) va Sholcha oilasi (Q1) — censusda BELGILANDI, lekin P2’da ikkala yozuv ham alohida item bo’lib qoladi. Merge — keyingi faza, har juftlik uchun sizning alohida qaroringiz bilan (jarayoni: item_id’larni bitta itemga qayta ulash bitta tranzaksiyada + eski nom `item_aliases`ga + eski item `active=false`; tarix o’chirilmaydi).

## 5. Fizik sanoq: 82 pozitsiya — KANDIDAT registri

Manba: qabul qilingan sanoq hisoboti. **Birorta kandidat avtomatik yaratilmaydi** — har biri sizning tasdig’ingizni kutadi. Yig’ma: EXACT **2** (1 207.55 kg) · POSSIBLE **15** (10 872.6 kg) · UNMATCHED **65** (36 460.85 kg) · jami **48 541 kg**.

### C-20

| # | Fizik nom (aynan) | kg | Holat | P2 taklifi |
|---|---|---|---|---|
| 1 | Neylon 210D / 45 | 80 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 2 | Neylon 210D / 60 | 1 474 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 3 | Neylon 210D / 90 | 330 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 4 | Toshkent Oq 14 mm — Bir qavat | 942.05 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 5 | FDY Igna Strupa | 4 572.25 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 6 | Toshkent Qora 14 mm Ichki Sariq | 636.25 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 7 | 16 mm Alpinist | 520 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 8 | 14 mm Alpinist | 930 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 9 | Toshkent Qora 14 mm Ichi Oq PP TWS | 309.6 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 10 | Toshkent Oq 16 mm Ichi Oq PP TWS — 50 metr *(metr-spec)* | 342.3 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |

### C-19

| # | Fizik nom (aynan) | kg | Holat | P2 taklifi |
|---|---|---|---|---|
| 1 | Polyamide 144 oq TWS | 552.9 | POSSIBLE_MATCH | 5a-qaror jadvalida — egasi HA/YO’Q deydi |
| 2 | Polyamide Ko‘k 187 TWS | 94.05 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 3 | Polyamide Qizil 187 TWS | 73.65 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 4 | Polyamide Sariq 187 TWS | 44.6 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 5 | Polyamide Oq 187 TWS | 132.15 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 6 | Qop ip Yashil | 2 244.1 | POSSIBLE_MATCH | 5a-qaror jadvalida — egasi HA/YO’Q deydi |
| 7 | Qop ip Qizil | 728.55 | POSSIBLE_MATCH | 5a-qaror jadvalida — egasi HA/YO’Q deydi |
| 8 | Passport Xom BCF | 646 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 9 | Yashil PP TWS Strupa 24 talik | 643.4 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 10 | Passport Strupa 16 talik | 527.65 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 11 | Passport Strupa 24 talik | 273.75 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 12 | Yashil PP TWS Strupa 16 talik | 168.6 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 13 | Sariq Polyester Strupa 16 talik | 2 583.9 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |

### C-18

| # | Fizik nom (aynan) | kg | Holat | P2 taklifi |
|---|---|---|---|---|
| 1 | Toshkent Arqon 16 mm Ko‘k | 221.6 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 2 | Toshkent Arqon 16 mm Qora | 332.95 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 3 | Ustki Gilam Ichki Sariq Polyamide | 317.25 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 4 | Toshkent Arqon 10 mm Yashil | 171.9 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 5 | Toshkent Arqon 14 mm Qizil | 451.7 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 6 | Toshkent Arqon 12 mm Qora Ichki Polyamide Sariq | 866.25 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 7 | Toshkent Arqon 12 mm Qizil | 61.65 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 8 | Toshkent Arqon 14 mm Qora | 150 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 9 | Toshkent Arqon 10 mm Ko‘k | 150.25 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 10 | FDY Fil Arqon | 497.55 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 11 | Toshkent Arqon 16 mm Oq — 50 metr *(metr-spec)* | 63.2 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 12 | Toshkent Arqon 14 mm Oq — 100 metr *(metr-spec)* | 40.05 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 13 | Toshkent Arqon 16 mm Oq | 61.9 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 14 | Toshkent Arqon Qora 16 mm Ichki Polyamide Sariq | 717.35 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 15 | Toshkent Arqon 12 mm Sariq | 389.95 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 16 | FDY Tros Aralash | 386.75 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 17 | Rossiya Tros | 531 | EXACT_MATCH | mavjud itemga bog’lanadi: «Rossiya Tros» — yangi item KERAK EMAS |
| 18 | Usti gilam ichki Sariq Polyamide Arqon | 370.5 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 19 | Ustki Oq TWS ichki Polyamide Oq Arqon | 1 264.1 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 20 | Ustki PP xom ichki Polyamide Oq Arqon | 105 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 21 | Ustki 187 TWS Oq ichki Zubr 16 mm Arqon | 926.4 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 22 | Ustki 187 TWS Oq ichki Strupa 14 mm Arqon | 520 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 23 | Kanob Aralash 20 metr *(metr-spec)* | 113.55 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 24 | Alpinist 12 mm | 450.6 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 25 | Alpinist 10 mm | 106.2 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 26 | Alpinist 14 mm | 165.55 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 27 | Alpinist 16 mm | 199.3 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 28 | Alpinist 20 mm | 174.5 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 29 | Alpinist 25 mm | 32.45 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |

### C-02

| # | Fizik nom (aynan) | kg | Holat | P2 taklifi |
|---|---|---|---|---|
| 1 | Shroki 3.5 sm lenta | 468.35 | POSSIBLE_MATCH | 5a-qaror jadvalida — egasi HA/YO’Q deydi |
| 2 | Rangli 2.5 sm ikki qavat lenta | 863.45 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 3 | Reels Lenta | 1 352.85 | POSSIBLE_MATCH | 5a-qaror jadvalida — egasi HA/YO’Q deydi |
| 4 | Tulpor Lenta Aralash | 556.4 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 5 | Tulpor Lenta Yashil | 1 019.35 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 6 | Tulpor Lenta Oq | 439.2 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 7 | Tulpor Lenta Ko‘k | 192.05 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 8 | Tulpor lenta qizil | 287 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 9 | Shroki 3.5 Oq | 676.55 | EXACT_MATCH | mavjud itemga bog’lanadi: «Shroki 3.5 Oq» — yangi item KERAK EMAS |
| 10 | Tahoe Lenta | 197.8 | POSSIBLE_MATCH | 5a-qaror jadvalida — egasi HA/YO’Q deydi |

### C-04

| # | Fizik nom (aynan) | kg | Holat | P2 taklifi |
|---|---|---|---|---|
| 1 | Polipropilen CF 1500D Qora | 3 250 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 2 | Polipropilen CF 1000D Yashil | 1 020 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 3 | Strupa Salafan | 375.8 | POSSIBLE_MATCH | 5a-qaror jadvalida — egasi HA/YO’Q deydi |
| 4 | XB Strupa | 349.9 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 5 | PP Oq TWS Strupa 12 talik | 875.55 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 6 | Eshma Xitoy Strupa PP Oq TWS | 230.85 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 7 | Yashil PP TWS Strupa 16 talik | 261.2 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |

### C-06

| # | Fizik nom (aynan) | kg | Holat | P2 taklifi |
|---|---|---|---|---|
| 1 | Shlanka Polyamide Yumshoq | 86.3 | POSSIBLE_MATCH | 5a-qaror jadvalida — egasi HA/YO’Q deydi |
| 2 | Shlanka Tortqi PP Oq TWS — 50 metr *(metr-spec)* | 236.25 | POSSIBLE_MATCH | 5a-qaror jadvalida — egasi HA/YO’Q deydi |
| 3 | Shlanka Tortqi PP Yashil TWS — 50 metr *(metr-spec)* | 66.35 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 4 | Shlanka Polipropilen CF Qora | 618.8 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 5 | Shlanka Polipropilen CF Yashil | 710.45 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 6 | Shlanka Polipropilen CF Ko‘k | 506.25 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 7 | Shlanka Polipropilen CF Qizil | 581.4 | UNMATCHED | 5b-kandidat — egasi tasdiqlasa YANGI item ochiladi |
| 8 | Shlanka Polipropilen CF Oq | 874.95 | POSSIBLE_MATCH | 5a-qaror jadvalida — egasi HA/YO’Q deydi |
| 9 | Shlanka Polyester FDY Qora | 433.2 | POSSIBLE_MATCH | 5a-qaror jadvalida — egasi HA/YO’Q deydi |
| 10 | Shlanka Polyester FDY Yashil | 830.4 | POSSIBLE_MATCH | 5a-qaror jadvalida — egasi HA/YO’Q deydi |
| 11 | Shlanka Polyester FDY Ko‘k | 778.15 | POSSIBLE_MATCH | 5a-qaror jadvalida — egasi HA/YO’Q deydi |
| 12 | Shlanka Polyester FDY Qizil | 730.95 | POSSIBLE_MATCH | 5a-qaror jadvalida — egasi HA/YO’Q deydi |
| 13 | Shlanka Polyester FDY Oq | 982.05 | POSSIBLE_MATCH | 5a-qaror jadvalida — egasi HA/YO’Q deydi |

### 5a. POSSIBLE_MATCH — 15 ta QAROR JADVALI (sizniki)

**HA** = fizik nom `item_aliases`ga yoziladi (source='physical_count') va pozitsiya mavjud itemga bog’lanadi — **balans baribir TEGILMAYDI** (adjustment alohida bosqich). **YO’Q** = pozitsiya 5b’ga o’tadi (yangi item kandidati).

| # | Kont. | Fizik nom | kg | Nomzod ERP item | Birlik ziddiyati | Qisqa sabab | QARORINGIZ (HA/YO’Q) |
|---|---|---|---|---|---|---|---|
| 1 | C-19 | Polyamide 144 oq TWS | 552.9 | mahsulot «Polyamide 144» | yo’q | Nom «oq TWS» qo’shimchasi bilan farq qiladi; birlik mos (kg). Namangan’da −931 kg minus bor — tarixiy bog’lanish ehtimoli | ______ |
| 2 | C-19 | Qop ip Yashil | 2 244.1 | xomashyo «Qop ip» | yo’q | ERP’dagi xomashyo «Qop ip» rangsiz (global −255 kg); fizik nomda Yashil rang bor — rang varianti ERP’da mavjud emas. Dona-tipli «Qop ip N talik»… ⚠ bitta nomzodga 2 da’vogar (2, 3-qatorlar) | ______ |
| 3 | C-19 | Qop ip Qizil | 728.55 | xomashyo «Qop ip» | yo’q | Xuddi shu: rang varianti ERP’da yo’q ⚠ bitta nomzodga 2 da’vogar (2, 3-qatorlar) | ______ |
| 4 | C-02 | Shroki 3.5 sm lenta | 468.35 | mahsulot «Shroki 3.5» | yo’q | «sm lenta» qo’shimchasi bilan farq; Namangan’da −125 kg minus bor. MUHIM: fizik sanoqda «Shroki 3.5 Oq» ham ALOHIDA sanalgan — bu Q3’dagi «bular… | ______ |
| 5 | C-02 | Reels Lenta | 1 352.85 | mahsulot «Reels» | yo’q | «Reels» unikal brend-token, ERP’da faqat bitta; fizik nomda «Lenta» qo’shimchasi bor | ______ |
| 6 | C-02 | Tahoe Lenta | 197.8 | mahsulot «Tahoe 50 m» | yo’q | ERP’da yagona Tahoe itemi «Tahoe 50 m» (Q9: hamma ko’rsatkichi 0 — arxiv nomzodi edi); nom farqli — tasdiq kerak | ______ |
| 7 | C-04 | Strupa Salafan | 375.8 | mahsulot «Salafan Strupa» | yo’q | So’z tartibi almashgan, token to’plami 100% teng — lekin topshiriq qoidasiga ko’ra bu ISBOT EMAS; bundan tashqari xomashyo «Salafan» ham bor — qaysi… | ______ |
| 8 | C-06 | Shlanka Polyamide Yumshoq | 86.3 | mahsulot «Shlanka Polyamide» | ⚠ dona vs kg | Nomga «Yumshoq» qo’shilgan; BIRLIK ZIDDIYATI: ERP’da dona, fizik sanoq kg — dona soni yo’q, kg’dan chiqarish taqiqlangan (4-bosqich) | ______ |
| 9 | C-06 | Shlanka Tortqi PP Oq TWS — 50 metr | 236.25 | mahsulot «Shlanka PP / Oq» | yo’q | Ikkita jiddiy nomzod: «Shlanka PP / Oq» (kg; Namangan −798) va «Shlanka Parashut 50 metr» (kg); «Tortqi Polyamide» (dona) ham bor. Qaysi biri — egasi… ⚠ bitta nomzodga 2 da’vogar (9, 10-qatorlar) | ______ |
| 10 | C-06 | Shlanka Polipropilen CF Oq | 874.95 | mahsulot «Shlanka PP / Oq» | yo’q | PP=Polipropilen sinonimi + Oq rang mos; «CF» qo’shimchasi va Namangan −798 tarixiy minus bor. Diqqat: C-06 #2 ham shu itemga da’vogar — ikkala qator… ⚠ bitta nomzodga 2 da’vogar (9, 10-qatorlar) | ______ |
| 11 | C-06 | Shlanka Polyester FDY Qora | 433.2 | mahsulot «Shlanka FDY / Qora» | ⚠ dona vs kg | Rang 1:1 mos (FDY oilasi), lekin fizik nomda «Polyester» bor va BIRLIK ZIDDIYATI: ERP dona, sanoq kg. Namangan’da −16 dona minus | ______ |
| 12 | C-06 | Shlanka Polyester FDY Yashil | 830.4 | mahsulot «Shlanka FDY/Yashil» | ⚠ dona vs kg | Rang mos; birlik ziddiyati (dona vs kg); Namangan −32 | ______ |
| 13 | C-06 | Shlanka Polyester FDY Ko‘k | 778.15 | mahsulot «Shlanka FDY/ Ko'k» | ⚠ dona vs kg | Rang mos; birlik ziddiyati; Namangan −32 | ______ |
| 14 | C-06 | Shlanka Polyester FDY Qizil | 730.95 | mahsulot «Shlanka FDY / QIzil» | ⚠ dona vs kg | Rang mos; birlik ziddiyati; Namangan −32 | ______ |
| 15 | C-06 | Shlanka Polyester FDY Oq | 982.05 | mahsulot «Shlanka FDY / OQ» | ⚠ dona vs kg | Rang mos; birlik ziddiyati; Namangan −104 | ______ |

Birlik ziddiyatli qatorlarda (⚠) «HA» desangiz ham dona soni SANALMAGUNCHA hech qanday miqdor yozilmaydi — kg’dan dona chiqarish taqiqlangan (sanoq qoidasi).

### 5b. UNMATCHED — 65 ta YANGI ITEM KANDIDATI

Nom — sanoqda yozilganidek, AYNAN (o’zgartirilmagan). SKU — shunchaki taklif (siz istalgancha o’zgartirasiz). Tur (raw/finished) va bayroqlarni SIZ belgilaysiz — biz taxmin qilmaymiz (masalan «Neylon 210D» ip-xomashyomi yoki sotiladigan tayyor molmi — buni faqat siz bilasiz).

| # | Kont. | Fizik nom (aynan) | kg | Birlik | SKU (taklif) | Tur/bayroqlar (SIZ) | Izoh |
|---|---|---|---|---|---|---|---|
| 1 | C-20 | Neylon 210D / 45 | 80 | kg | `NEYLON-210D-45` *(taklif)* | ______ | — |
| 2 | C-20 | Neylon 210D / 60 | 1 474 | kg | `NEYLON-210D-60` *(taklif)* | ______ | — |
| 3 | C-20 | Neylon 210D / 90 | 330 | kg | `NEYLON-210D-90` *(taklif)* | ______ | — |
| 4 | C-20 | Toshkent Oq 14 mm — Bir qavat | 942.05 | kg | `TOSHKENT-OQ-14-MM-BIR-QAVAT` *(taklif)* | ______ | — |
| 5 | C-20 | FDY Igna Strupa | 4 572.25 | kg | `FDY-IGNA-STRUPA` *(taklif)* | ______ | uzoq nomzod: «FDY YARN» — isbotsiz |
| 6 | C-20 | Toshkent Qora 14 mm Ichki Sariq | 636.25 | kg | `TOSHKENT-QORA-14-MM-ICHKI-SARIQ` *(taklif)* | ______ | — |
| 7 | C-20 | 16 mm Alpinist | 520 | kg | `16-MM-ALPINIST` *(taklif)* | ______ | — |
| 8 | C-20 | 14 mm Alpinist | 930 | kg | `14-MM-ALPINIST` *(taklif)* | ______ | — |
| 9 | C-20 | Toshkent Qora 14 mm Ichi Oq PP TWS | 309.6 | kg | `TOSHKENT-QORA-14-MM-ICHI-OQ-PP-TWS` *(taklif)* | ______ | — |
| 10 | C-20 | Toshkent Oq 16 mm Ichi Oq PP TWS — 50 metr | 342.3 | kg | `TOSHKENT-OQ-16-MM-ICHI-OQ-PP-TWS-50-METR` *(taklif)* | ______ | —; metr-spec nom ichida |
| 11 | C-19 | Polyamide Ko‘k 187 TWS | 94.05 | kg | `POLYAMIDE-KOK-187-TWS` *(taklif)* | ______ | uzoq nomzod: «Polyamide» — isbotsiz |
| 12 | C-19 | Polyamide Qizil 187 TWS | 73.65 | kg | `POLYAMIDE-QIZIL-187-TWS` *(taklif)* | ______ | uzoq nomzod: «Polyamide» — isbotsiz |
| 13 | C-19 | Polyamide Sariq 187 TWS | 44.6 | kg | `POLYAMIDE-SARIQ-187-TWS` *(taklif)* | ______ | uzoq nomzod: «Polyamide» — isbotsiz |
| 14 | C-19 | Polyamide Oq 187 TWS | 132.15 | kg | `POLYAMIDE-OQ-187-TWS` *(taklif)* | ______ | uzoq nomzod: «Polyamide» — isbotsiz |
| 15 | C-19 | Passport Xom BCF | 646 | kg | `PASSPORT-XOM-BCF` *(taklif)* | ______ | — |
| 16 | C-19 | Yashil PP TWS Strupa 24 talik | 643.4 | kg | `YASHIL-PP-TWS-STRUPA-24-TALIK` *(taklif)* | ______ | — |
| 17 | C-19 | Passport Strupa 16 talik | 527.65 | kg | `PASSPORT-STRUPA-16-TALIK` *(taklif)* | ______ | — |
| 18 | C-19 | Passport Strupa 24 talik | 273.75 | kg | `PASSPORT-STRUPA-24-TALIK` *(taklif)* | ______ | — |
| 19 | C-19 | Yashil PP TWS Strupa 16 talik | 168.6 | kg | `YASHIL-PP-TWS-STRUPA-16-TALIK` *(taklif)* | ______ | — |
| 20 | C-19 | Sariq Polyester Strupa 16 talik | 2 583.9 | kg | `SARIQ-POLYESTER-STRUPA-16-TALIK` *(taklif)* | ______ | uzoq nomzod: «Strupa Sariq», «Strupa Sari» — isbotsiz |
| 21 | C-18 | Toshkent Arqon 16 mm Ko‘k | 221.6 | kg | `TOSHKENT-ARQON-16-MM-KOK` *(taklif)* | ______ | — |
| 22 | C-18 | Toshkent Arqon 16 mm Qora | 332.95 | kg | `TOSHKENT-ARQON-16-MM-QORA` *(taklif)* | ______ | — |
| 23 | C-18 | Ustki Gilam Ichki Sariq Polyamide | 317.25 | kg | `USTKI-GILAM-ICHKI-SARIQ-POLYAMIDE` *(taklif)* | ______ | uzoq nomzod: «Gilam tros kurtka tros» — isbotsiz |
| 24 | C-18 | Toshkent Arqon 10 mm Yashil | 171.9 | kg | `TOSHKENT-ARQON-10-MM-YASHIL` *(taklif)* | ______ | — |
| 25 | C-18 | Toshkent Arqon 14 mm Qizil | 451.7 | kg | `TOSHKENT-ARQON-14-MM-QIZIL` *(taklif)* | ______ | — |
| 26 | C-18 | Toshkent Arqon 12 mm Qora Ichki Polyamide Sariq | 866.25 | kg | `TOSHKENT-ARQON-12-MM-QORA-ICHKI-POLYAMIDE-SARIQ` *(taklif)* | ______ | — |
| 27 | C-18 | Toshkent Arqon 12 mm Qizil | 61.65 | kg | `TOSHKENT-ARQON-12-MM-QIZIL` *(taklif)* | ______ | — |
| 28 | C-18 | Toshkent Arqon 14 mm Qora | 150 | kg | `TOSHKENT-ARQON-14-MM-QORA` *(taklif)* | ______ | — |
| 29 | C-18 | Toshkent Arqon 10 mm Ko‘k | 150.25 | kg | `TOSHKENT-ARQON-10-MM-KOK` *(taklif)* | ______ | — |
| 30 | C-18 | FDY Fil Arqon | 497.55 | kg | `FDY-FIL-ARQON` *(taklif)* | ______ | uzoq nomzod: «FDY YARN» — isbotsiz |
| 31 | C-18 | Toshkent Arqon 16 mm Oq — 50 metr | 63.2 | kg | `TOSHKENT-ARQON-16-MM-OQ-50-METR` *(taklif)* | ______ | —; metr-spec nom ichida |
| 32 | C-18 | Toshkent Arqon 14 mm Oq — 100 metr | 40.05 | kg | `TOSHKENT-ARQON-14-MM-OQ-100-METR` *(taklif)* | ______ | —; metr-spec nom ichida |
| 33 | C-18 | Toshkent Arqon 16 mm Oq | 61.9 | kg | `TOSHKENT-ARQON-16-MM-OQ` *(taklif)* | ______ | — |
| 34 | C-18 | Toshkent Arqon Qora 16 mm Ichki Polyamide Sariq | 717.35 | kg | `TOSHKENT-ARQON-QORA-16-MM-ICHKI-POLYAMIDE-SARIQ` *(taklif)* | ______ | — |
| 35 | C-18 | Toshkent Arqon 12 mm Sariq | 389.95 | kg | `TOSHKENT-ARQON-12-MM-SARIQ` *(taklif)* | ______ | — |
| 36 | C-18 | FDY Tros Aralash | 386.75 | kg | `FDY-TROS-ARALASH` *(taklif)* | ______ | uzoq nomzod: «FDY YARN» — isbotsiz |
| 37 | C-18 | Usti gilam ichki Sariq Polyamide Arqon | 370.5 | kg | `USTI-GILAM-ICHKI-SARIQ-POLYAMIDE-ARQON` *(taklif)* | ______ | — |
| 38 | C-18 | Ustki Oq TWS ichki Polyamide Oq Arqon | 1 264.1 | kg | `USTKI-OQ-TWS-ICHKI-POLYAMIDE-OQ-ARQON` *(taklif)* | ______ | — |
| 39 | C-18 | Ustki PP xom ichki Polyamide Oq Arqon | 105 | kg | `USTKI-PP-XOM-ICHKI-POLYAMIDE-OQ-ARQON` *(taklif)* | ______ | uzoq nomzod: «PP Xom oq» — isbotsiz |
| 40 | C-18 | Ustki 187 TWS Oq ichki Zubr 16 mm Arqon | 926.4 | kg | `USTKI-187-TWS-OQ-ICHKI-ZUBR-16-MM-ARQON` *(taklif)* | ______ | uzoq nomzod: «Zubr Lenta» — isbotsiz |
| 41 | C-18 | Ustki 187 TWS Oq ichki Strupa 14 mm Arqon | 520 | kg | `USTKI-187-TWS-OQ-ICHKI-STRUPA-14-MM-ARQON` *(taklif)* | ______ | — |
| 42 | C-18 | Kanob Aralash 20 metr | 113.55 | kg | `KANOB-ARALASH-20-METR` *(taklif)* | ______ | uzoq nomzod: «Kanob», «Kanob», «Dor ip 20 metr» — isbotsiz; metr-spec nom ichida |
| 43 | C-18 | Alpinist 12 mm | 450.6 | kg | `ALPINIST-12-MM` *(taklif)* | ______ | — |
| 44 | C-18 | Alpinist 10 mm | 106.2 | kg | `ALPINIST-10-MM` *(taklif)* | ______ | — |
| 45 | C-18 | Alpinist 14 mm | 165.55 | kg | `ALPINIST-14-MM` *(taklif)* | ______ | — |
| 46 | C-18 | Alpinist 16 mm | 199.3 | kg | `ALPINIST-16-MM` *(taklif)* | ______ | — |
| 47 | C-18 | Alpinist 20 mm | 174.5 | kg | `ALPINIST-20-MM` *(taklif)* | ______ | — |
| 48 | C-18 | Alpinist 25 mm | 32.45 | kg | `ALPINIST-25-MM` *(taklif)* | ______ | — |
| 49 | C-02 | Rangli 2.5 sm ikki qavat lenta | 863.45 | kg | `RANGLI-2-5-SM-IKKI-QAVAT-LENTA` *(taklif)* | ______ | uzoq nomzod: «Ikki Qavat Arqon Rangli» — isbotsiz |
| 50 | C-02 | Tulpor Lenta Aralash | 556.4 | kg | `TULPOR-LENTA-ARALASH` *(taklif)* | ______ | uzoq nomzod: «Tulpor», «5 mm Tulpor», «Tulpor 80 metr» — isbotsiz |
| 51 | C-02 | Tulpor Lenta Yashil | 1 019.35 | kg | `TULPOR-LENTA-YASHIL` *(taklif)* | ______ | uzoq nomzod: «Tulpor» — isbotsiz |
| 52 | C-02 | Tulpor Lenta Oq | 439.2 | kg | `TULPOR-LENTA-OQ` *(taklif)* | ______ | uzoq nomzod: «Tulpor» — isbotsiz |
| 53 | C-02 | Tulpor Lenta Ko‘k | 192.05 | kg | `TULPOR-LENTA-KOK` *(taklif)* | ______ | uzoq nomzod: «Tulpor» — isbotsiz |
| 54 | C-02 | Tulpor lenta qizil | 287 | kg | `TULPOR-LENTA-QIZIL` *(taklif)* | ______ | uzoq nomzod: «Tulpor» — isbotsiz |
| 55 | C-04 | Polipropilen CF 1500D Qora | 3 250 | kg | `POLIPROPILEN-CF-1500D-QORA` *(taklif)* | ______ | uzoq nomzod: «Polipropilen 2 x 1500 / OQ», «Polipropilen 2 x 1500 / rangli», «Polipropilen ip» — isbotsiz |
| 56 | C-04 | Polipropilen CF 1000D Yashil | 1 020 | kg | `POLIPROPILEN-CF-1000D-YASHIL` *(taklif)* | ______ | uzoq nomzod: «Polipropilen 2 x 1500 / rangli», «Polipropilen ip» — isbotsiz |
| 57 | C-04 | XB Strupa | 349.9 | kg | `XB-STRUPA` *(taklif)* | ______ | — |
| 58 | C-04 | PP Oq TWS Strupa 12 talik | 875.55 | kg | `PP-OQ-TWS-STRUPA-12-TALIK` *(taklif)* | ______ | — |
| 59 | C-04 | Eshma Xitoy Strupa PP Oq TWS | 230.85 | kg | `ESHMA-XITOY-STRUPA-PP-OQ-TWS` *(taklif)* | ______ | — |
| 60 | C-04 | Yashil PP TWS Strupa 16 talik | 261.2 | kg | `YASHIL-PP-TWS-STRUPA-16-TALIK-2` *(taklif)* | ______ | — |
| 61 | C-06 | Shlanka Tortqi PP Yashil TWS — 50 metr | 66.35 | kg | `SHLANKA-TORTQI-PP-YASHIL-TWS-50-METR` *(taklif)* | ______ | uzoq nomzod: «Shlanka PP / Rangli», «Shlanka Parashut 50 metr» — isbotsiz; metr-spec nom ichida |
| 62 | C-06 | Shlanka Polipropilen CF Qora | 618.8 | kg | `SHLANKA-POLIPROPILEN-CF-QORA` *(taklif)* | ______ | uzoq nomzod: «Shlanka PP / Rangli» — isbotsiz |
| 63 | C-06 | Shlanka Polipropilen CF Yashil | 710.45 | kg | `SHLANKA-POLIPROPILEN-CF-YASHIL` *(taklif)* | ______ | uzoq nomzod: «Shlanka PP / Rangli» — isbotsiz |
| 64 | C-06 | Shlanka Polipropilen CF Ko‘k | 506.25 | kg | `SHLANKA-POLIPROPILEN-CF-KOK` *(taklif)* | ______ | uzoq nomzod: «Shlanka PP / Rangli» — isbotsiz |
| 65 | C-06 | Shlanka Polipropilen CF Qizil | 581.4 | kg | `SHLANKA-POLIPROPILEN-CF-QIZIL` *(taklif)* | ______ | uzoq nomzod: «Shlanka PP / Rangli» — isbotsiz |

### 5c. Dalil: 39 «katalogda yo’q sotuv nomi’» bilan ustma-ustlik

Sotuv tarixida katalogda yo’q 39 nom bor (P1, D7). Ulardan bir nechtasi fizik sanoq lug’ati bilan ustma-ust tushadi — ya’ni zavodning REAL lug’ati katalogdan doim farq qilgan, sanoq buni faqat fosh qildi:

| Sotuvdagi nom (katalogda yo’q) | Fizik sanoqdagi o’xshash oila |
|---|---|
| Kanob Aralash | Kanob Aralash 20 metr (C-18) |
| Tulpor Lenta 2,5 sm | Tulpor Lenta oilasi / Rangli 2.5 sm ikki qavat lenta (C-02) |
| Strupa 16 talik / Oq | «N talik» strupa oilasi (C-19/C-04) |
| Shlanka FDY | Shlanka Polyester FDY oilasi (C-06) |
| Shlanka Polyamid | Shlanka Polyamide Yumshoq (C-06) |
| Xb Arqon 50 metr | XB Strupa (C-04) |
| Tros FIl | FDY Fil Arqon (C-18) |
| Tros Rossiya Aralash | Rossiya Tros / FDY Tros Aralash (C-18) |
| Lomboz 50 metr | — (sanoqda yo’q, lekin xuddi shu «metr-spec» uslub) |

Bu MAPPING EMAS — faqat dalil. 39 nomning to’liq ro’yxati (mapping qarori keyin, `item_aliases` orqali, tarix o’zgartirilmasdan):

- 3.5 sm lik pp oq lenta
- Dvaynoy 4 kg
- Dvaynoy 5 Kg
- Dvaynoy 6 kg
- Ikki Qavatli Arqon Oq Pp
- Kanob Aralash
- Lenta Kaptiva
- Lenta Rangli 2.5 sm
- Lomboz 50 metr
- PoliPropilen Sariq Kurtka
- PP 2 x 1500 / Ko'k
- PP 2 x 1500 OQ
- PP 2 x 1500 / Qizil
- PP 2 x 1500 / Qora
- PP 2 x 1500 / Sariq
- PP 2 x 1500 / Yashil
- QopIp/100
- Qop Ip 100 talik
- Qop ip 120 talik
- Qop ip Yashil 100 talik
- Reja Ip 100 gramm
- Reja Ip 30 gramm
- Reja Ip 50 gramm
- Sariq Babin 0.4 mm
- Sariq Dvaynoy 6 kg
- Shakar 100 metr 2.8 kg
- Shakar Lenta 1.8 kg
- Shlanka FDY
- Shlanka Polyamid
- Shunur oq / Salafan
- Strupa 100 metr oq pp
- Strupa 16 talik / Oq
- Tros FIl
- Tros Kurtka 3-4 kg
- Tros Kurtka 5-6 kg
- Tros Qora/sariq
- Tros Rossiya Aralash
- Tulpor Lenta 2,5 sm
- Xb Arqon 50 metr

## 6. Migratsiya strategiyasi (bosqichma-bosqich, har biri qaytariladigan)

| Bosqich | Nima | Yozadimi? | Darvoza (gate) |
|---|---|---|---|
| **P2.0 tayyorgarlik** | pg_dump snapshot + checkpoint; bot `init_db` + API `initDb` + Drizzle + `schema-drift` yangilanadi; yangi bazada fresh-boot guard testi | Kod, baza EMAS | Sizning P2’ni boshlash ruxsatingiz + api-tests/schema-drift yashil |
| **P2.1 DDL** | 2-bo’limdagi CREATE/ALTER’lar (idempotent; production’ga ham idempotent ALTER skripti bilan — drizzle push EMAS) | Sxema (additiv) | Sizning ruxsatingiz |
| **P2.2 items backfill** | 134 item (117 product + 17 raw) INSERT…SELECT; bayroqlar — SIZ tasdiqlagan censusdan; SKU global unikallik tekshiruvi (products ∪ RM-taklif ∪ distribution); so’ng `products.item_id` / `raw_materials.item_id` o’z item’iga bog’lanadi | Faqat YANGI jadval + 2 master ustun | Census (3–4-bo’lim) tasdig’i |
| **P2.3 item_id backfill** | 6 tranzaksiya jadvalida nom+kontekst bo’yicha item_id to’ldiriladi: `inventory`/`stock_movements` → product_type ('raw'→xomashyo, 'finished'→mahsulot); `product_materials` (material tomoni allaqachon ID ✓); `batches`, `sale_items` → mahsulot; `wip_movements` → ikkala ustun. 39 orphan sotuv nomi NULL qoladi + hisobot | Faqat YANGI ustunlar | **Sizning ruxsatingiz** (P2.2 natija hisoboti bilan) + qamrov kutilmasi: sale_items’da ~39 NULL |
| **P2.4 dual-write** | Yangi yozuvlarda nom BILAN BIRGA item_id ham yoziladi (bot partiyasi, dashboard oqimlari, inventory-v2, sotuv) — `ITEMS_DUAL_WRITE` bayrog’i ostida, default O’CHIQ | Yangi yozuvlargina | e2e + api-tests yashil bo’lsa ham bayroq FAQAT **sizning ruxsatingiz** bilan yoqiladi |
| *(P3+)* | Reconciliation/adjustment, o’qishni ID’ga o’tkazish, merge’lar, transformation, distribution SKU ko’prigi | — | Har biri ALOHIDA taklif + ruxsat |

**82 kandidat qachon itemga aylanadi?** P2.2’da EMAS. Siz 5a/5b jadvallarini to’ldirib qaytargach, alohida «P2.2b» ro’yxati tuziladi (faqat siz tasdiqlagan qatorlar, source_kind='physical_count') va yana ko’rsatiladi — shundan keyingina INSERT. Balanslar bu bosqichda ham TEGILMAYDI (miqdor kiritish — P3 adjustment, 7-bosqich taklifi tasdiqlangach).

## 7. Backward compatibility (orqaga moslik)

1. P2 davomida BARCHA o’qish yo’llari nom asosida ishlashda davom etadi — dashboard, bot, field hech narsani sezmaydi.
2. item_id ustunlari NULLABLE — eski kod ularni ko’rmaydi ham, buzilmaydi ham.
3. Yangi baza (fresh boot) ikkala initializer orqali bir xil sxema oladi — `schema-drift` buni qo’riqlaydi.
4. Distribution (savdo bot) katalogi TEGILMAYDI — u alohida mahsulot reestri (58/69 nom-mos), SKU ko’prigi P6’da.
5. `raw_materials.current_stock` semantikasi P2’da o’zgarmaydi.

## 8. Eski ma’lumot himoyasi

1. P2 hech bir mavjud USTUN QIYMATINI o’zgartirmaydi — faqat yangi jadvallar + yangi nullable ustunlar to’ldiriladi.
2. Tarix (608 harakat, 274 partiya, 143 sotuv qatori, 167 WIP) bayt-ma-bayt joyida qoladi.
3. Har bosqich oldidan pg_dump snapshot + checkpoint; backfill’lar tranzaksiyada, oldin/keyin COUNT assertlari bilan.
4. Backfill izi: `items.source_kind + source_id + created_by='p2-backfill'` — har item qayerdan kelgani ko’rinadi.
5. Rename o’rniga `item_aliases` — eski nomlar hech qachon o’chirilmaydi.

## 9. Rollback strategiyasi

| Bosqich | Qaytarish |
|---|---|
| P2.1 | `DROP TABLE item_aliases, items; ALTER TABLE … DROP COLUMN item_id/…_item_id` — xavfsiz, chunki hech narsa ularga bog’lanmagan |
| P2.2 | `DELETE FROM items WHERE created_by='p2-backfill'` (yoki TRUNCATE) — boshqa jadvallar hali ishora qilmaydi |
| P2.3 | `UPDATE … SET item_id=NULL` — nomlar asl manba bo’lib turibdi |
| P2.4 | `ITEMS_DUAL_WRITE=false` — bir zumda eski xulq |
| Halokat holati | pg_dump snapshot’dan tiklash + checkpoint rollback |

Qo’shimcha kafolat: P4 (o’qishni ID’ga o’tkazish) boshlanmaguncha item_id’ni HECH NARSA o’qimaydi — shuning uchun P2’ning istalgan nuqtasida to’liq orqaga qaytish mumkin.

## 10. Aniq ta’sirlanadigan jadval/maydonlar

**YANGI jadvallar (2):** `items`, `item_aliases` *(+P5 rezervi: `transformations` — hozir yaratilmaydi)*

**ALTER — faqat nullable ustun qo’shish (10 ustun / 8 jadval):**

| Jadval | Yangi ustun(lar) | Backfill manbasi |
|---|---|---|
| `products` | item_id | items(source='product') |
| `raw_materials` | item_id | items(source='raw_material') |
| `product_materials` | product_item_id, material_item_id | product_name → mahsulot-item; raw_material_id → xomashyo-item (ID allaqachon bor ✓) |
| `inventory` | item_id | product + product_type kontekst |
| `stock_movements` | item_id | product + product_type kontekst |
| `batches` | item_id | product → mahsulot-item (bot partiyalari, 274 qator) |
| `wip_movements` | raw_material_item_id, product_item_id | raw_material / product ustunlari |
| `sale_items` | item_id | product_name (39 orphan NULL qoladi) |

**Yangilanadigan kod yuzalari (xulq o’zgarmaydi):** bot `init_db`, API `initDb`, Drizzle sxema mirror, `check-schema-drift` skripti; P2.4’da (bayroq ostida): bot partiya yozuvi, dashboard raw-in/berish/chiqarish, inventory-v2 harakatlar, sotuv POST.

**Ataylab TEGILMAYDIGANLAR (sabab bilan):**

| Obyekt | Sabab |
|---|---|
| `sales.product` (header) | Legacy displey maydoni; haqiqiy qatorlar sale_items’da — P6 qarori |
| `packer_product_assignments.product_name` | Bot konfiguratsiyasi; P4’da item_id’ga o’tadi |
| `sale_products`, `sales_products` (0 qator) | O’lik legacy kataloglar — arxivlash P6’da |
| `distribution.mahsulotlar` | Alohida katalog (ataylab) — SKU ko’prigi P6’da |
| `raw_materials.current_stock` | P4’gacha mustaqil kesh bo’lib qoladi |
| `stock_movements.movement_type` CHECK | Jonli bazada BOR (IN/OUT/TRANSFER), initializer’larda YO’Q (drift!); ADJUSTMENT qo’shish + driftni yopish — 7-bosqich taklifi, ALOHIDA ruxsat |
| `audit_logs` | O’zgarish yo’q |

## 11. Sizdan kutilayotgan qarorlar

| # | Qaror | Qayerda |
|---|---|---|
| 1 | Item modeli + DDL (2-bo’lim) ma’qulmi? | 1–2-bo’lim |
| 2 | 117 mahsulot bayroqlari — ayniqsa 57 ta «Ha?» xarid nomzodi va 1 ta arxiv nomzodi | 3-bo’lim |
| 3 | 17 xomashyo `RM-…` SKU shabloni ma’qulmi? | 4-bo’lim |
| 4 | 134 ta 1:1 backfill (merge YO’Q) tasdiqlaysizmi? | 4-bo’lim |
| 5 | 15 POSSIBLE — har biriga HA/YO’Q | 5a |
| 6 | 65 kandidat — nom/SKU/tur belgilab tasdiqlash (xohlagan qismini) | 5b |
| 7 | P2.0–P2.1’ni boshlashga ruxsat — keyingi HAR BIR bosqich (P2.2/2.3/2.4) alohida so’raladi | 6-bo’lim |
| 8 | 39 orphan sotuv nomi mappingini qachon qilamiz? | 5c |

*Ushbu hujjat 100% o’qish rejimida tayyorlandi. Bazada bitta ham yozuv o’zgarmadi.*

*Biz taxmin qilmaymiz. Biz bilamiz.*
