-- =============================================================================
-- P2.1 — Canonical Items Foundation DDL (TopMart ERP)
--
-- HOLAT: KUTMOQDA. Bu fayl egasining aniq "P2.1 GO" ruxsatisiz BAJARILMAYDI.
-- U hech qanday boot/migratsiya yo'liga ULANMAGAN — faqat qo'lda,
-- docs/p2-1-execution-runbook.md tartibi bo'yicha ishga tushiriladi.
--
-- Xususiyatlari:
--   * 100% ADDITIV: faqat CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS
--   * IDEMPOTENT: qayta ishga tushirish xavfsiz
--   * 0 satr o'zgaradi: yangi ustunlar NULLABLE, DEFAULT'siz -> metadata-only
--   * Hech qanday UPDATE/DELETE/INSERT yo'q (backfill = P2.2/P2.3, alohida ruxsat)
--
-- Manba: docs/p2-items-foundation-proposal.md §2 (egasi 2026-08-15 shartlar
-- bilan tasdiqlagan model). Rollback: docs/p2-1-execution-runbook.md §6.
-- =============================================================================

BEGIN;

-- ── 1. items — kanonik reestr ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS items (
  id                SERIAL PRIMARY KEY,        -- immutable ichki ID (qayta ishlatilmaydi)
  sku               TEXT NOT NULL UNIQUE,      -- immutable biznes kalit (trigger himoyasi quyida)
  display_name      TEXT NOT NULL,             -- ko'rsatish nomi (o'zgarishi tarixga ta'sir qilmaydi)
  unit              TEXT NOT NULL CHECK (unit IN ('kg', 'dona')),
  is_raw            BOOLEAN NOT NULL DEFAULT FALSE,
  is_intermediate   BOOLEAN NOT NULL DEFAULT FALSE,
  is_finished       BOOLEAN NOT NULL DEFAULT FALSE,
  is_purchasable    BOOLEAN NOT NULL DEFAULT FALSE,
  is_producible     BOOLEAN NOT NULL DEFAULT FALSE,
  is_sellable       BOOLEAN NOT NULL DEFAULT FALSE,
  inventory_tracked BOOLEAN NOT NULL DEFAULT TRUE,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  source_kind       TEXT NOT NULL CHECK (source_kind IN ('product', 'raw_material', 'physical_count', 'manual')),
  source_id         INTEGER,                   -- backfill izi: products.id / raw_materials.id
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS items_source_uq
  ON items (source_kind, source_id) WHERE source_id IS NOT NULL;

-- ── 2. item_aliases — tarixiy/muqobil nomlar (rename O'RNIGA) ────────────────
CREATE TABLE IF NOT EXISTS item_aliases (
  id         SERIAL PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES items(id),
  alias_name TEXT NOT NULL UNIQUE,
  source     TEXT NOT NULL CHECK (source IN ('legacy_name', 'sale_orphan', 'physical_count', 'distribution')),
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS item_aliases_item_id_idx ON item_aliases (item_id);

-- ── 3. Himoya triggerlari ────────────────────────────────────────────────────
-- 3a. SKU immutable (tasdiqlangan qaror №3): UPDATE'da sku o'zgartirish taqiq.
CREATE OR REPLACE FUNCTION items_sku_immutable_fn() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'items.sku IMMUTABLE (id=%): "%" -> "%" taqiqlangan; yangi nom kerak bo''lsa item_aliases yozing',
    OLD.id, OLD.sku, NEW.sku;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS items_sku_immutable ON items;
CREATE TRIGGER items_sku_immutable
  BEFORE UPDATE OF sku ON items
  FOR EACH ROW WHEN (OLD.sku IS DISTINCT FROM NEW.sku)
  EXECUTE FUNCTION items_sku_immutable_fn();

-- 3b. items o'chirilmaydi (faqat active=false). P2.2 rollback'ida trigger
-- vaqtincha DISABLE qilinadi (runbook §6) — ongli, hujjatlashtirilgan yo'l.
-- DIQQAT: hech qachon TRUNCATE ... CASCADE ishlatmang — item_id ustunli katta
-- jadvallarni ham bo'shatib yuboradi!
CREATE OR REPLACE FUNCTION items_no_delete_fn() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'items satri o''chirilmaydi (id=%, sku=%): active=false ishlating', OLD.id, OLD.sku;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS items_no_delete ON items;
CREATE TRIGGER items_no_delete
  BEFORE DELETE ON items
  FOR EACH ROW EXECUTE FUNCTION items_no_delete_fn();

-- ── 4. Tranzaksiya jadvallariga NULLABLE bog'lamlar (10 ustun / 8 jadval) ────
-- NULLABLE + DEFAULT'siz -> Postgres'da metadata-only, satrlar qayta yozilmaydi.
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

CREATE INDEX IF NOT EXISTS products_item_id_idx                    ON products (item_id);
CREATE INDEX IF NOT EXISTS raw_materials_item_id_idx               ON raw_materials (item_id);
CREATE INDEX IF NOT EXISTS product_materials_product_item_id_idx   ON product_materials (product_item_id);
CREATE INDEX IF NOT EXISTS product_materials_material_item_id_idx  ON product_materials (material_item_id);
CREATE INDEX IF NOT EXISTS inventory_item_id_idx                   ON inventory (item_id);
CREATE INDEX IF NOT EXISTS stock_movements_item_id_idx             ON stock_movements (item_id);
CREATE INDEX IF NOT EXISTS batches_item_id_idx                     ON batches (item_id);
CREATE INDEX IF NOT EXISTS wip_movements_raw_material_item_id_idx  ON wip_movements (raw_material_item_id);
CREATE INDEX IF NOT EXISTS wip_movements_product_item_id_idx       ON wip_movements (product_item_id);
CREATE INDEX IF NOT EXISTS sale_items_item_id_idx                  ON sale_items (item_id);

COMMIT;

-- Kutilgan natija: 2 yangi jadval, 2 trigger (+2 funksiya), 10 yangi NULLABLE
-- ustun, 11 indeks. Mavjud satrlarga: 0 UPDATE, 0 DELETE, 0 INSERT.
