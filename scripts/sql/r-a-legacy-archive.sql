-- =============================================================================
-- R-A — Legacy Arxiv (TopMart ERP, v2 inventar-reset strategiyasi)
--
-- HOLAT: Egasi 2026-08-17 «P2.1 GO + R-A GO» berdi. Bu skript FAQAT arxiv
-- yaratadi — mavjud jadvallarga 0 UPDATE / 0 DELETE / 0 INSERT.
--
-- Xususiyatlari:
--   * APPEND-ONLY arxiv: legacy.* jadvallariga UPDATE/DELETE/TRUNCATE trigger
--     bilan taqiqlanadi. Xato bo'lsa — YANGI timestamp'li snapshot yoniga
--     yoziladi, eski hech qachon o'chirilmaydi (rollback YO'Q).
--   * IDEMPOTENT: qayta ishga tushirilsa duplikat YOZMAYDI (NOT EXISTS guard —
--     jadvalda satr bo'lsa, INSERT o'tkazib yuboriladi).
--   * R-D uchun QATTIQ SHART: C-16/C-17 nollashtirish faqat shu arxiv
--     tekshirilgach mumkin (docs/inventory-reset-dry-run-report.md §9).
--   * HIMOYA CHEGARASI (arxitektor ko'rigi 2026-08-17): triggerlar TASODIFIY
--     yozuvdan saqlaydi; DB egasi roli ALTER TABLE ... DISABLE TRIGGER bilan
--     chetlab o'ta oladi (administrativ bypass). Shu sababli R-D qoidasi:
--     nollash tranzaksiyasining O'ZIDA arxiv qiymati qayta o'qib solishtiriladi.
--   * KELAJAK SNAPSHOTLARI uchun shablon eslatmasi: bu jadvallar BIR martalik
--     (NOT EXISTS bo'sh jadvalgagina yozadi). Tuzatish snapshoti YANGI
--     vaqt-belgili jadvalga yoziladi (masalan *_pre_20260901) va tranzaksiya
--     REPEATABLE READ darajasida ochiladi — 4 INSERT bitta izchil kesim bo'lsin.
--
-- Manba: docs/inventory-reset-implementation-proposal.md §2.2, §15 (R-A);
--        docs/inventory-reset-dry-run-report.md §9.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS legacy;

-- ── 0. Himoya: legacy.* — append-only ────────────────────────────────────────
CREATE OR REPLACE FUNCTION legacy.no_touch_fn() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'legacy.% APPEND-ONLY arxiv: UPDATE/DELETE/TRUNCATE taqiqlangan (xato bo''lsa yangi snapshot yoniga yoziladi)', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

-- ── 1. legacy.inventory_baseline_pre — public.inventory to'liq nusxasi ──────
CREATE TABLE IF NOT EXISTS legacy.inventory_baseline_pre (
  archive_id     SERIAL PRIMARY KEY,
  archived_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_note    TEXT NOT NULL,
  inventory_id   INTEGER NOT NULL,      -- public.inventory.id (asl PK)
  warehouse_id   INTEGER,
  warehouse_name TEXT,                  -- arxiv o'zi o'qiladigan bo'lsin
  product        TEXT,
  product_type   TEXT,
  quantity       NUMERIC,
  weight_kg      NUMERIC,
  updated_at     TIMESTAMPTZ            -- asl satrning oxirgi yangilanishi
);

INSERT INTO legacy.inventory_baseline_pre
  (source_note, inventory_id, warehouse_id, warehouse_name, product,
   product_type, quantity, weight_kg, updated_at)
SELECT
  'R-A arxiv 2026-08-17: public.inventory to''liq nusxasi (reset''dan OLDIN). '
  || 'v2 strategiya: legacy qoldiqlar ISHONCHSIZ, reconcile qilinmaydi, faqat hisobot.',
  i.id, i.warehouse_id, w.name, i.product, i.product_type,
  i.quantity, i.weight_kg, i.updated_at
FROM inventory i
LEFT JOIN warehouses w ON w.id = i.warehouse_id
WHERE NOT EXISTS (SELECT 1 FROM legacy.inventory_baseline_pre);

-- ── 2. legacy.raw_material_stock_pre — public.raw_materials nusxasi ─────────
CREATE TABLE IF NOT EXISTS legacy.raw_material_stock_pre (
  archive_id      SERIAL PRIMARY KEY,
  archived_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_note     TEXT NOT NULL,
  raw_material_id INTEGER NOT NULL,     -- public.raw_materials.id
  name            TEXT,
  unit            TEXT,
  unit_type       TEXT,
  currency        TEXT,
  default_cost    NUMERIC,
  current_stock   NUMERIC,
  minimum_stock   NUMERIC,
  active          BOOLEAN,
  created_at      TIMESTAMPTZ
);

INSERT INTO legacy.raw_material_stock_pre
  (source_note, raw_material_id, name, unit, unit_type, currency,
   default_cost, current_stock, minimum_stock, active, created_at)
SELECT
  'R-A arxiv 2026-08-17: public.raw_materials qoldiq holati (reset''dan OLDIN).',
  r.id, r.name, r.unit, r.unit_type, r.currency,
  r.default_cost, r.current_stock, r.minimum_stock, r.active, r.created_at
FROM raw_materials r
WHERE NOT EXISTS (SELECT 1 FROM legacy.raw_material_stock_pre);

-- ── 3. legacy.wip_balances_pre — liniya kesimida WIP balans (hisoblangan) ───
-- WIP formulasi (Material Flow): SUM(RECEIVE) - SUM(PRODUCE) wip_movements
-- ledger bo'yicha. 2026-08-17 holatda ledgerda faqat PRODUCE bor (171 satr) —
-- arxiv BORICHA muhrlanadi, hech qanday "tuzatish" kiritilmaydi.
CREATE TABLE IF NOT EXISTS legacy.wip_balances_pre (
  archive_id     SERIAL PRIMARY KEY,
  archived_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_note    TEXT NOT NULL,
  line_id        INTEGER,
  line_name      TEXT,
  receive_kg     NUMERIC NOT NULL,
  produce_kg     NUMERIC NOT NULL,
  wip_kg         NUMERIC NOT NULL,      -- receive_kg - produce_kg
  movement_count INTEGER NOT NULL
);

INSERT INTO legacy.wip_balances_pre
  (source_note, line_id, line_name, receive_kg, produce_kg, wip_kg, movement_count)
SELECT * FROM (
  SELECT
    'R-A arxiv 2026-08-17: WIP balans liniya kesimida (wip_movements ledgeridan '
    || 'hisoblangan; formulasi SUM(RECEIVE)-SUM(PRODUCE)). Ledger o''zi o''zgarmaydi.',
    wm.line_id,
    pl.name,
    COALESCE(SUM(wm.weight_kg) FILTER (WHERE wm.movement_type = 'RECEIVE'), 0),
    COALESCE(SUM(wm.weight_kg) FILTER (WHERE wm.movement_type = 'PRODUCE'), 0),
    COALESCE(SUM(wm.weight_kg) FILTER (WHERE wm.movement_type = 'RECEIVE'), 0)
      - COALESCE(SUM(wm.weight_kg) FILTER (WHERE wm.movement_type = 'PRODUCE'), 0),
    count(*)::integer
  FROM wip_movements wm
  LEFT JOIN production_lines pl ON pl.id = wm.line_id
  GROUP BY wm.line_id, pl.name
) q
WHERE NOT EXISTS (SELECT 1 FROM legacy.wip_balances_pre);

-- ── 4. legacy.container_summary_pre — 36 joy bo'yicha yig'ma ────────────────
CREATE TABLE IF NOT EXISTS legacy.container_summary_pre (
  archive_id     SERIAL PRIMARY KEY,
  archived_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_note    TEXT NOT NULL,
  warehouse_id   INTEGER NOT NULL,
  warehouse_name TEXT,
  location_type  TEXT,
  purpose        TEXT,
  row_count      INTEGER NOT NULL,
  sum_quantity   NUMERIC NOT NULL,
  sum_weight_kg  NUMERIC NOT NULL
);

INSERT INTO legacy.container_summary_pre
  (source_note, warehouse_id, warehouse_name, location_type, purpose,
   row_count, sum_quantity, sum_weight_kg)
SELECT * FROM (
  SELECT
    'R-A arxiv 2026-08-17: inventar yig''masi joy (warehouse/konteyner) kesimida '
    || '(public.inventory + public.warehouses dan hisoblangan).',
    w.id, w.name, w.location_type, w.purpose,
    count(i.id)::integer,
    COALESCE(SUM(i.quantity), 0),
    COALESCE(SUM(i.weight_kg), 0)
  FROM warehouses w
  LEFT JOIN inventory i ON i.warehouse_id = w.id
  GROUP BY w.id, w.name, w.location_type, w.purpose
) q
WHERE NOT EXISTS (SELECT 1 FROM legacy.container_summary_pre);

-- ── 5. Append-only triggerlarni o'rnatish (4 jadval × 2 trigger) ────────────
DROP TRIGGER IF EXISTS inventory_baseline_pre_no_touch ON legacy.inventory_baseline_pre;
CREATE TRIGGER inventory_baseline_pre_no_touch
  BEFORE UPDATE OR DELETE ON legacy.inventory_baseline_pre
  FOR EACH ROW EXECUTE FUNCTION legacy.no_touch_fn();
DROP TRIGGER IF EXISTS inventory_baseline_pre_no_truncate ON legacy.inventory_baseline_pre;
CREATE TRIGGER inventory_baseline_pre_no_truncate
  BEFORE TRUNCATE ON legacy.inventory_baseline_pre
  FOR EACH STATEMENT EXECUTE FUNCTION legacy.no_touch_fn();

DROP TRIGGER IF EXISTS raw_material_stock_pre_no_touch ON legacy.raw_material_stock_pre;
CREATE TRIGGER raw_material_stock_pre_no_touch
  BEFORE UPDATE OR DELETE ON legacy.raw_material_stock_pre
  FOR EACH ROW EXECUTE FUNCTION legacy.no_touch_fn();
DROP TRIGGER IF EXISTS raw_material_stock_pre_no_truncate ON legacy.raw_material_stock_pre;
CREATE TRIGGER raw_material_stock_pre_no_truncate
  BEFORE TRUNCATE ON legacy.raw_material_stock_pre
  FOR EACH STATEMENT EXECUTE FUNCTION legacy.no_touch_fn();

DROP TRIGGER IF EXISTS wip_balances_pre_no_touch ON legacy.wip_balances_pre;
CREATE TRIGGER wip_balances_pre_no_touch
  BEFORE UPDATE OR DELETE ON legacy.wip_balances_pre
  FOR EACH ROW EXECUTE FUNCTION legacy.no_touch_fn();
DROP TRIGGER IF EXISTS wip_balances_pre_no_truncate ON legacy.wip_balances_pre;
CREATE TRIGGER wip_balances_pre_no_truncate
  BEFORE TRUNCATE ON legacy.wip_balances_pre
  FOR EACH STATEMENT EXECUTE FUNCTION legacy.no_touch_fn();

DROP TRIGGER IF EXISTS container_summary_pre_no_touch ON legacy.container_summary_pre;
CREATE TRIGGER container_summary_pre_no_touch
  BEFORE UPDATE OR DELETE ON legacy.container_summary_pre
  FOR EACH ROW EXECUTE FUNCTION legacy.no_touch_fn();
DROP TRIGGER IF EXISTS container_summary_pre_no_truncate ON legacy.container_summary_pre;
CREATE TRIGGER container_summary_pre_no_truncate
  BEFORE TRUNCATE ON legacy.container_summary_pre
  FOR EACH STATEMENT EXECUTE FUNCTION legacy.no_touch_fn();

COMMIT;

-- Kutilgan natija: legacy sxema + 4 arxiv jadvali (43 + 17 + N liniya + 36
-- satr) + 8 himoya trigger. Mavjud jadvallarga: 0 UPDATE, 0 DELETE, 0 INSERT.
-- Majburiy yakuniy tekshiruv (R-A "bajarildi" hisoblanishi uchun):
--   satr soni + qiymat yig'indilari asl jadvallar bilan solishtiriladi,
--   13 ta C-16/C-17 satri ALOHIDA sanab ko'rsatiladi.
