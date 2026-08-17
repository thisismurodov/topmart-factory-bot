-- =============================================================================
-- R-B IJRO SKRIPTI (2026-08-17) — «R-B GO» egasi ruxsati bilan, BIR MARTA.
-- Manba (muhr): docs/r-b-mapping-preview-2026-08-17.md (§3 jadval, 97 satr)
-- Generator: scripts/src/r-b-generate-sql.ts (qo'lda tahrir QILINMASIN) —
--   dry-run'ning barcha nazoratlarini qayta bajaradi va §3 bilan bayt-aynan
--   solishtiradi; birorta farq bo'lsa bu fayl umuman yaratilmaydi.
-- Ijro: psql "$RAILWAY_DATABASE_URL" -v ON_ERROR_STOP=1 -f <shu fayl>
-- Birorta tekshiruv yiqilsa — butun tranzaksiya ROLLBACK, bazada iz qolmaydi
-- (CREATE TABLE ham tranzaksiya ichida: ROLLBACK'da sequence qoldig'i qolmaydi).
--
-- Egasining R-B GO chegaralari:
--   * faqat 2 YANGI jadval yoziladi: physical_baselines (9) + physical_baseline_positions (97)
--   * items/inventory/stock_movements/legacy/sales'ga 0 yozuv (9.9 isbotlaydi)
--   * 2 EXACT kandidat item_id=NULL (mapping YO'Q) · TM-000022 = 2 lokatsiya satri
--   * R-D BOSHLANMAYDI (BASELINE harakatlar 0 — 9.9 tekshiradi)
-- Rollback (taklif §13): DROP TABLE physical_baseline_positions, physical_baselines;
--   satr-darajali o'chirish/o'zgartirish trigger bilan muzlatilgan.
-- =============================================================================
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
-- R-B o'qiydigan/bog'lanadigan mavjud jadvallar barqarorligi uchun yozishni
-- bloklaymiz (o'qish ochiq qoladi — zavod ishlayveradi; biznes jadvallari
-- qulflanmaydi). warehouses ham SHART (arxitektor topilmasi 2026-08-17):
-- registr container_label ↔ warehouse_id bog'lanishini MUZLATIB yozadi —
-- parallel rename/deaktivatsiya pre-gate'dan keyin COMMIT bo'lsa, registr
-- noto'g'ri joyga qotib qolardi. Qulflar birinchi SELECT'dan (snapshot'dan)
-- OLDIN olinadi — hech qanday parallel yozuv oralikka sig'masligi kafolatlanadi.
LOCK TABLE items IN SHARE MODE;
LOCK TABLE item_aliases IN SHARE MODE;
LOCK TABLE warehouses IN SHARE MODE;

-- ── 0. PRE-GATE ──────────────────────────────────────────────────────────────
DO $pre$
DECLARE v bigint; t text;
BEGIN
  -- yangi jadvallar hali YO'Q bo'lishi shart (takroriy ijro bloklanadi)
  IF to_regclass('public.physical_baselines') IS NOT NULL THEN
    RAISE EXCEPTION 'PRE-GATE: physical_baselines allaqachon mavjud — takroriy ijro taqiqlangan';
  END IF;
  IF to_regclass('public.physical_baseline_positions') IS NOT NULL THEN
    RAISE EXCEPTION 'PRE-GATE: physical_baseline_positions allaqachon mavjud — takroriy ijro taqiqlangan';
  END IF;
  -- items R-C holatida ekani
  SELECT COUNT(*) INTO v FROM items;
  IF v <> 94 THEN RAISE EXCEPTION 'PRE-GATE: items=% (94 kutilgan)', v; END IF;
  SELECT COUNT(DISTINCT sku) INTO v FROM items;
  IF v <> 94 THEN RAISE EXCEPTION 'PRE-GATE: DISTINCT sku=%', v; END IF;
  SELECT MIN(sku) INTO t FROM items; IF t <> 'TM-000001' THEN RAISE EXCEPTION 'PRE-GATE: MIN(sku)=%', t; END IF;
  SELECT MAX(sku) INTO t FROM items; IF t <> 'TM-000094' THEN RAISE EXCEPTION 'PRE-GATE: MAX(sku)=%', t; END IF;
  SELECT MIN(id) INTO v FROM items; IF v <> 2 THEN RAISE EXCEPTION 'PRE-GATE: MIN(items.id)=% (2 kutilgan)', v; END IF;
  SELECT MAX(id) INTO v FROM items; IF v <> 95 THEN RAISE EXCEPTION 'PRE-GATE: MAX(items.id)=% (95 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v FROM item_aliases;
  IF v <> 0 THEN RAISE EXCEPTION 'PRE-GATE: item_aliases=% (0 kutilgan)', v; END IF;
  -- 9 konteyner warehouses'da aynan kutilgan (id, nom) juftligida
  IF NOT EXISTS (SELECT 1 FROM warehouses WHERE id=26 AND name='C-20' AND active) THEN
    RAISE EXCEPTION 'PRE-GATE: warehouses id=26 nomi ''C-20'' emas yoki aktiv emas'; END IF;
  IF NOT EXISTS (SELECT 1 FROM warehouses WHERE id=25 AND name='C-19' AND active) THEN
    RAISE EXCEPTION 'PRE-GATE: warehouses id=25 nomi ''C-19'' emas yoki aktiv emas'; END IF;
  IF NOT EXISTS (SELECT 1 FROM warehouses WHERE id=24 AND name='C-18' AND active) THEN
    RAISE EXCEPTION 'PRE-GATE: warehouses id=24 nomi ''C-18'' emas yoki aktiv emas'; END IF;
  IF NOT EXISTS (SELECT 1 FROM warehouses WHERE id=8 AND name='C-02' AND active) THEN
    RAISE EXCEPTION 'PRE-GATE: warehouses id=8 nomi ''C-02'' emas yoki aktiv emas'; END IF;
  IF NOT EXISTS (SELECT 1 FROM warehouses WHERE id=10 AND name='C-04' AND active) THEN
    RAISE EXCEPTION 'PRE-GATE: warehouses id=10 nomi ''C-04'' emas yoki aktiv emas'; END IF;
  IF NOT EXISTS (SELECT 1 FROM warehouses WHERE id=12 AND name='C-06' AND active) THEN
    RAISE EXCEPTION 'PRE-GATE: warehouses id=12 nomi ''C-06'' emas yoki aktiv emas'; END IF;
  IF NOT EXISTS (SELECT 1 FROM warehouses WHERE id=22 AND name='C-16' AND active) THEN
    RAISE EXCEPTION 'PRE-GATE: warehouses id=22 nomi ''C-16'' emas yoki aktiv emas'; END IF;
  IF NOT EXISTS (SELECT 1 FROM warehouses WHERE id=23 AND name='C-17' AND active) THEN
    RAISE EXCEPTION 'PRE-GATE: warehouses id=23 nomi ''C-17'' emas yoki aktiv emas'; END IF;
  IF NOT EXISTS (SELECT 1 FROM warehouses WHERE id=21 AND name='C-15' AND active) THEN
    RAISE EXCEPTION 'PRE-GATE: warehouses id=21 nomi ''C-15'' emas yoki aktiv emas'; END IF;
END $pre$;

-- ── 0b. Jonli items ≡ muhrlangan §4 (bayt-aynan, yozishdan OLDIN) ────────────
CREATE TEMP TABLE rb_items_expected (
  sku text PRIMARY KEY, display_name text NOT NULL, unit text NOT NULL, note text NOT NULL
) ON COMMIT DROP;
INSERT INTO rb_items_expected (sku, display_name, unit, note) VALUES
  ('TM-000001', 'Neylon 210D / 45', 'kg', 'Sanoq 2026-08-15 · C-20 · 80 kg'),
  ('TM-000002', 'Neylon 210D / 60', 'kg', 'Sanoq 2026-08-15 · C-20 · 1 474 kg'),
  ('TM-000003', 'Neylon 210D / 90', 'kg', 'Sanoq 2026-08-15 · C-20 · 330 kg'),
  ('TM-000004', 'Toshkent Oq 14 mm — Bir qavat', 'kg', 'Sanoq 2026-08-15 · C-20 · 942.05 kg'),
  ('TM-000005', 'FDY Igna Strupa', 'kg', 'Sanoq 2026-08-15 · C-20 · 4 572.25 kg'),
  ('TM-000006', 'Toshkent Qora 14 mm Ichki Sariq', 'kg', 'Sanoq 2026-08-15 · C-20 · 636.25 kg'),
  ('TM-000007', '16 mm Alpinist', 'kg', 'Sanoq 2026-08-15 · C-20 · 520 kg'),
  ('TM-000008', '14 mm Alpinist', 'kg', 'Sanoq 2026-08-15 · C-20 · 930 kg'),
  ('TM-000009', 'Toshkent Qora 14 mm Ichi Oq PP TWS', 'kg', 'Sanoq 2026-08-15 · C-20 · 309.6 kg'),
  ('TM-000010', 'Toshkent Oq 16 mm Ichi Oq PP TWS — 50 metr', 'kg', 'Sanoq 2026-08-15 · C-20 · 342.3 kg'),
  ('TM-000011', 'Polyamide 144 oq TWS', 'kg', 'Sanoq 2026-08-15 · C-19 · 552.9 kg'),
  ('TM-000012', 'Polyamide Ko‘k 187 TWS', 'kg', 'Sanoq 2026-08-15 · C-19 · 94.05 kg'),
  ('TM-000013', 'Polyamide Qizil 187 TWS', 'kg', 'Sanoq 2026-08-15 · C-19 · 73.65 kg'),
  ('TM-000014', 'Polyamide Sariq 187 TWS', 'kg', 'Sanoq 2026-08-15 · C-19 · 44.6 kg'),
  ('TM-000015', 'Polyamide Oq 187 TWS', 'kg', 'Sanoq 2026-08-15 · C-19 · 132.15 kg'),
  ('TM-000016', 'Qop ip Yashil', 'kg', 'Sanoq 2026-08-15 · C-19 · 2 244.1 kg'),
  ('TM-000017', 'Qop ip Qizil', 'kg', 'Sanoq 2026-08-15 · C-19 · 728.55 kg'),
  ('TM-000018', 'Passport Xom BCF', 'kg', 'Sanoq 2026-08-15 · C-19 · 646 kg'),
  ('TM-000019', 'Yashil PP TWS Strupa 24 talik', 'kg', 'Sanoq 2026-08-15 · C-19 · 643.4 kg'),
  ('TM-000020', 'Passport Strupa 16 talik', 'kg', 'Sanoq 2026-08-15 · C-19 · 527.65 kg'),
  ('TM-000021', 'Passport Strupa 24 talik', 'kg', 'Sanoq 2026-08-15 · C-19 · 273.75 kg'),
  ('TM-000022', 'Yashil PP TWS Strupa 16 talik', 'kg', 'Sanoq 2026-08-15 · C-19 168.6 kg + C-04 261.2 kg = 429.8 kg'),
  ('TM-000023', 'Sariq Polyester Strupa 16 talik', 'kg', 'Sanoq 2026-08-15 · C-19 · 2 583.9 kg'),
  ('TM-000024', 'Toshkent Arqon 16 mm Ko‘k', 'kg', 'Sanoq 2026-08-15 · C-18 · 221.6 kg'),
  ('TM-000025', 'Toshkent Arqon 16 mm Qora', 'kg', 'Sanoq 2026-08-15 · C-18 · 332.95 kg'),
  ('TM-000026', 'Ustki Gilam Ichki Sariq Polyamide', 'kg', 'Sanoq 2026-08-15 · C-18 · 317.25 kg'),
  ('TM-000027', 'Toshkent Arqon 10 mm Yashil', 'kg', 'Sanoq 2026-08-15 · C-18 · 171.9 kg'),
  ('TM-000028', 'Toshkent Arqon 14 mm Qizil', 'kg', 'Sanoq 2026-08-15 · C-18 · 451.7 kg'),
  ('TM-000029', 'Toshkent Arqon 12 mm Qora Ichki Polyamide Sariq', 'kg', 'Sanoq 2026-08-15 · C-18 · 866.25 kg'),
  ('TM-000030', 'Toshkent Arqon 12 mm Qizil', 'kg', 'Sanoq 2026-08-15 · C-18 · 61.65 kg'),
  ('TM-000031', 'Toshkent Arqon 14 mm Qora', 'kg', 'Sanoq 2026-08-15 · C-18 · 150 kg'),
  ('TM-000032', 'Toshkent Arqon 10 mm Ko‘k', 'kg', 'Sanoq 2026-08-15 · C-18 · 150.25 kg'),
  ('TM-000033', 'FDY Fil Arqon', 'kg', 'Sanoq 2026-08-15 · C-18 · 497.55 kg'),
  ('TM-000034', 'Toshkent Arqon 16 mm Oq — 50 metr', 'kg', 'Sanoq 2026-08-15 · C-18 · 63.2 kg'),
  ('TM-000035', 'Toshkent Arqon 14 mm Oq — 100 metr', 'kg', 'Sanoq 2026-08-15 · C-18 · 40.05 kg'),
  ('TM-000036', 'Toshkent Arqon 16 mm Oq', 'kg', 'Sanoq 2026-08-15 · C-18 · 61.9 kg'),
  ('TM-000037', 'Toshkent Arqon Qora 16 mm Ichki Polyamide Sariq', 'kg', 'Sanoq 2026-08-15 · C-18 · 717.35 kg'),
  ('TM-000038', 'Toshkent Arqon 12 mm Sariq', 'kg', 'Sanoq 2026-08-15 · C-18 · 389.95 kg'),
  ('TM-000039', 'FDY Tros Aralash', 'kg', 'Sanoq 2026-08-15 · C-18 · 386.75 kg'),
  ('TM-000040', 'Usti gilam ichki Sariq Polyamide Arqon', 'kg', 'Sanoq 2026-08-15 · C-18 · 370.5 kg'),
  ('TM-000041', 'Ustki Oq TWS ichki Polyamide Oq Arqon', 'kg', 'Sanoq 2026-08-15 · C-18 · 1 264.1 kg'),
  ('TM-000042', 'Ustki PP xom ichki Polyamide Oq Arqon', 'kg', 'Sanoq 2026-08-15 · C-18 · 105 kg'),
  ('TM-000043', 'Ustki 187 TWS Oq ichki Zubr 16 mm Arqon', 'kg', 'Sanoq 2026-08-15 · C-18 · 926.4 kg'),
  ('TM-000044', 'Ustki 187 TWS Oq ichki Strupa 14 mm Arqon', 'kg', 'Sanoq 2026-08-15 · C-18 · 520 kg'),
  ('TM-000045', 'Kanob Aralash 20 metr', 'kg', 'Sanoq 2026-08-15 · C-18 · 113.55 kg'),
  ('TM-000046', 'Alpinist 12 mm', 'kg', 'Sanoq 2026-08-15 · C-18 · 450.6 kg'),
  ('TM-000047', 'Alpinist 10 mm', 'kg', 'Sanoq 2026-08-15 · C-18 · 106.2 kg'),
  ('TM-000048', 'Alpinist 14 mm', 'kg', 'Sanoq 2026-08-15 · C-18 · 165.55 kg'),
  ('TM-000049', 'Alpinist 16 mm', 'kg', 'Sanoq 2026-08-15 · C-18 · 199.3 kg'),
  ('TM-000050', 'Alpinist 20 mm', 'kg', 'Sanoq 2026-08-15 · C-18 · 174.5 kg'),
  ('TM-000051', 'Alpinist 25 mm', 'kg', 'Sanoq 2026-08-15 · C-18 · 32.45 kg'),
  ('TM-000052', 'Shroki 3.5 sm lenta', 'kg', 'Sanoq 2026-08-15 · C-02 · 468.35 kg'),
  ('TM-000053', 'Rangli 2.5 sm ikki qavat lenta', 'kg', 'Sanoq 2026-08-15 · C-02 · 863.45 kg'),
  ('TM-000054', 'Reels Lenta', 'kg', 'Sanoq 2026-08-15 · C-02 · 1 352.85 kg'),
  ('TM-000055', 'Tulpor Lenta Aralash', 'kg', 'Sanoq 2026-08-15 · C-02 · 556.4 kg'),
  ('TM-000056', 'Tulpor Lenta Yashil', 'kg', 'Sanoq 2026-08-15 · C-02 · 1 019.35 kg'),
  ('TM-000057', 'Tulpor Lenta Oq', 'kg', 'Sanoq 2026-08-15 · C-02 · 439.2 kg'),
  ('TM-000058', 'Tulpor Lenta Ko‘k', 'kg', 'Sanoq 2026-08-15 · C-02 · 192.05 kg'),
  ('TM-000059', 'Tulpor lenta qizil', 'kg', 'Sanoq 2026-08-15 · C-02 · 287 kg'),
  ('TM-000060', 'Tahoe Lenta', 'kg', 'Sanoq 2026-08-15 · C-02 · 197.8 kg'),
  ('TM-000061', 'Polipropilen CF 1500D Qora', 'kg', 'Sanoq 2026-08-15 · C-04 · 3 250 kg'),
  ('TM-000062', 'Polipropilen CF 1000D Yashil', 'kg', 'Sanoq 2026-08-15 · C-04 · 1 020 kg'),
  ('TM-000063', 'Strupa Salafan', 'kg', 'Sanoq 2026-08-15 · C-04 · 375.8 kg'),
  ('TM-000064', 'XB Strupa', 'kg', 'Sanoq 2026-08-15 · C-04 · 349.9 kg'),
  ('TM-000065', 'PP Oq TWS Strupa 12 talik', 'kg', 'Sanoq 2026-08-15 · C-04 · 875.55 kg'),
  ('TM-000066', 'Eshma Xitoy Strupa PP Oq TWS', 'kg', 'Sanoq 2026-08-15 · C-04 · 230.85 kg'),
  ('TM-000067', 'Shlanka Polyamide Yumshoq', 'kg', 'Sanoq 2026-08-15 · C-06 · 86.3 kg'),
  ('TM-000068', 'Shlanka Tortqi PP Oq TWS — 50 metr', 'kg', 'Sanoq 2026-08-15 · C-06 · 236.25 kg'),
  ('TM-000069', 'Shlanka Tortqi PP Yashil TWS — 50 metr', 'kg', 'Sanoq 2026-08-15 · C-06 · 66.35 kg'),
  ('TM-000070', 'Shlanka Polipropilen CF Qora', 'kg', 'Sanoq 2026-08-15 · C-06 · 618.8 kg'),
  ('TM-000071', 'Shlanka Polipropilen CF Yashil', 'kg', 'Sanoq 2026-08-15 · C-06 · 710.45 kg'),
  ('TM-000072', 'Shlanka Polipropilen CF Ko‘k', 'kg', 'Sanoq 2026-08-15 · C-06 · 506.25 kg'),
  ('TM-000073', 'Shlanka Polipropilen CF Qizil', 'kg', 'Sanoq 2026-08-15 · C-06 · 581.4 kg'),
  ('TM-000074', 'Shlanka Polipropilen CF Oq', 'kg', 'Sanoq 2026-08-15 · C-06 · 874.95 kg'),
  ('TM-000075', 'Shlanka Polyester FDY Qora', 'kg', 'Sanoq 2026-08-15 · C-06 · 433.2 kg'),
  ('TM-000076', 'Shlanka Polyester FDY Yashil', 'kg', 'Sanoq 2026-08-15 · C-06 · 830.4 kg'),
  ('TM-000077', 'Shlanka Polyester FDY Ko‘k', 'kg', 'Sanoq 2026-08-15 · C-06 · 778.15 kg'),
  ('TM-000078', 'Shlanka Polyester FDY Qizil', 'kg', 'Sanoq 2026-08-15 · C-06 · 730.95 kg'),
  ('TM-000079', 'Shlanka Polyester FDY Oq', 'kg', 'Sanoq 2026-08-15 · C-06 · 982.05 kg'),
  ('TM-000080', 'Qop ip 100 talik', 'dona', 'Sanoq 2026-08-15 · C-16 · 55 200 dona (6 348.00 kg)'),
  ('TM-000081', 'Qop ip 120 talik', 'dona', 'Sanoq 2026-08-15 · C-16 · 2 520 dona (226.80 kg)'),
  ('TM-000082', 'Qop ip 80 talik', 'dona', 'Sanoq 2026-08-15 · C-16 · 3 360 dona (470.40 kg)'),
  ('TM-000083', 'Qop ip 50 gramm Qora', 'dona', 'Sanoq 2026-08-15 · C-17 · 12 000 dona (600.00 kg)'),
  ('TM-000084', 'Qop ip 50 gramm Sariq', 'dona', 'Sanoq 2026-08-15 · C-17 · 12 800 dona (640.00 kg)'),
  ('TM-000085', 'Qop ip 50 gramm Oq', 'dona', 'Sanoq 2026-08-15 · C-17 · 7 600 dona (380.00 kg)'),
  ('TM-000086', 'Qop ip 30 gramm Qora', 'dona', 'Sanoq 2026-08-15 · C-17 · 4 800 dona (144.00 kg)'),
  ('TM-000087', 'Qop ip 30 gramm Sariq', 'dona', 'Sanoq 2026-08-15 · C-17 · 10 400 dona (312.00 kg)'),
  ('TM-000088', 'Qop ip 30 gramm Oq', 'dona', 'Sanoq 2026-08-15 · C-17 · 8 400 dona (252.00 kg)'),
  ('TM-000089', 'Qop ip 100 gramm Qora', 'dona', 'Sanoq 2026-08-15 · C-17 · 2 080 dona (208.00 kg)'),
  ('TM-000090', 'Qop ip 100 gramm Sariq', 'dona', 'Sanoq 2026-08-15 · C-17 · 2 880 dona (288.00 kg)'),
  ('TM-000091', 'Qop ip 100 gramm Oq', 'dona', 'Sanoq 2026-08-15 · C-17 · 4 320 dona (432.00 kg)'),
  ('TM-000092', 'Polipropilen CF 1000D Qizil', 'kg', 'Sanoq 2026-08-16 · C-15 · 3 720.00 kg'),
  ('TM-000093', 'Polipropilen CF 1000D Ko''k', 'kg', 'Sanoq 2026-08-16 · C-15 · 3 840.00 kg'),
  ('TM-000094', 'Polipropilen CF 1000D Sariq', 'kg', 'Sanoq 2026-08-16 · C-15 · 5 460.00 kg');
DO $items$
DECLARE v bigint;
BEGIN
  SELECT COUNT(*) INTO v FROM rb_items_expected;
  IF v <> 94 THEN RAISE EXCEPTION '0b: rb_items_expected=% (94 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v
    FROM rb_items_expected e FULL JOIN items i ON i.sku = e.sku
   WHERE i.sku IS NULL OR e.sku IS NULL
      OR i.display_name IS DISTINCT FROM e.display_name
      OR i.unit IS DISTINCT FROM e.unit
      OR i.note IS DISTINCT FROM e.note
      OR i.source_kind IS DISTINCT FROM 'physical_count'
      OR i.created_by IS DISTINCT FROM 'thisismurodov';
  IF v <> 0 THEN RAISE EXCEPTION '0b: jonli items muhrlangan §4 bilan mos emas (% satr)', v; END IF;
END $items$;

-- tranzaksiya-ichki «oldin» surati (9.9 uchun): son + qiymat yig'indilari
CREATE TEMP TABLE rb_pre ON COMMIT DROP AS SELECT
  (SELECT COUNT(*) FROM sales)                                    AS sales_n,
  (SELECT COUNT(*) FROM sale_items)                               AS sale_items_n,
  (SELECT COALESCE(SUM(quantity),0) FROM sale_items)              AS sale_items_qty,
  (SELECT COUNT(*) FROM stock_movements)                          AS sm_n,
  (SELECT COALESCE(SUM(quantity),0) FROM stock_movements)         AS sm_qty,
  (SELECT COUNT(*) FROM inventory)                                AS inv_n,
  (SELECT COALESCE(SUM(quantity),0) FROM inventory)               AS inv_qty,
  (SELECT COALESCE(SUM(weight_kg),0) FROM inventory)              AS inv_kg,
  (SELECT COUNT(*) FROM products)                                 AS products_n,
  (SELECT COUNT(*) FROM raw_materials)                            AS rm_n,
  (SELECT COALESCE(SUM(current_stock),0) FROM raw_materials)      AS rm_stock,
  (SELECT COUNT(*) FROM batches)                                  AS batches_n,
  (SELECT COUNT(*) FROM wip_movements)                            AS wip_n,
  (SELECT COUNT(*) FROM items)                                    AS items_n,
  (SELECT COUNT(*) FROM item_aliases)                             AS aliases_n,
  (SELECT COUNT(*) FROM legacy.inventory_baseline_pre)            AS lg_inv_n,
  (SELECT COUNT(*) FROM legacy.raw_material_stock_pre)            AS lg_rm_n,
  (SELECT COUNT(*) FROM legacy.wip_balances_pre)                  AS lg_wip_n,
  (SELECT COUNT(*) FROM legacy.container_summary_pre)             AS lg_cont_n,
  (SELECT COUNT(*) FROM stock_movements WHERE movement_type='BASELINE') AS sm_baseline_n;

-- ── 1. DDL: sanoq registri (R-B'ning YAGONA yozuv obyektlari) ────────────────
CREATE TABLE physical_baselines (
  id              SERIAL PRIMARY KEY,
  container_label TEXT NOT NULL UNIQUE,
  warehouse_id    INTEGER NOT NULL UNIQUE REFERENCES warehouses(id),
  count_date      DATE NOT NULL,
  source_doc      TEXT NOT NULL,
  counted_by      TEXT NOT NULL,
  positions_count INTEGER NOT NULL CHECK (positions_count > 0),
  total_weight_kg NUMERIC NOT NULL CHECK (total_weight_kg > 0),
  status          TEXT NOT NULL CHECK (status IN ('RECORDED','TOTAL_ONLY','MAPPED','LOADED')),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      TEXT NOT NULL
);
COMMENT ON TABLE physical_baselines IS
  'R-B sanoq registri (2026-08-17): har joy-sanoq bitta satr. Satrlar muzlatilgan (trigger): faqat status MAPPED->LOADED (R-D) o''zgarishi mumkin. Rollback = DROP TABLE (taklif §13).';

CREATE TABLE physical_baseline_positions (
  id            SERIAL PRIMARY KEY,
  baseline_id   INTEGER NOT NULL REFERENCES physical_baselines(id),
  position_no   INTEGER NOT NULL UNIQUE,
  container_pos INTEGER NOT NULL,
  name          TEXT NOT NULL,
  quantity      NUMERIC NOT NULL CHECK (quantity > 0),
  unit          TEXT NOT NULL CHECK (unit IN ('kg','dona')),
  boxes         NUMERIC CHECK (boxes > 0),
  per_box       NUMERIC CHECK (per_box > 0),
  unit_weight_g NUMERIC CHECK (unit_weight_g > 0),
  weight_kg     NUMERIC NOT NULL CHECK (weight_kg > 0),
  item_id       INTEGER REFERENCES items(id),
  mapping_status TEXT NOT NULL CHECK (mapping_status IN ('MAPPED','EXCLUDED_EXACT_CANDIDATE')),
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT NOT NULL,
  UNIQUE (baseline_id, container_pos),
  UNIQUE (baseline_id, name),
  CHECK ((mapping_status = 'MAPPED') = (item_id IS NOT NULL)),
  CHECK (unit <> 'kg'   OR (boxes IS NULL AND per_box IS NULL AND unit_weight_g IS NULL)),
  CHECK (unit <> 'kg'   OR quantity = weight_kg),
  CHECK (unit <> 'dona' OR (boxes IS NOT NULL AND per_box IS NOT NULL AND unit_weight_g IS NOT NULL)),
  CHECK (unit <> 'dona' OR boxes * per_box = quantity),
  CHECK (unit <> 'dona' OR quantity * unit_weight_g = weight_kg * 1000)
);
CREATE INDEX physical_baseline_positions_item_id_idx ON physical_baseline_positions (item_id);
COMMENT ON TABLE physical_baseline_positions IS
  '97 fizik pozitsiya — sanoq varag''idan BAYT-AYNAN (position_no = muhrlangan preview §3 tartibi). weight_kg dona satrlarda hisobiy (quantity × unit_weight_g / 1000). Muzlatilgan (trigger): faqat EXACT kandidatda item_id NULL->qiymat (+EXCLUDED->MAPPED, note bilan) mumkin — egasi qarori №1.';

-- ── 1b. Muzlatish triggerlari (satr-darajali immutability) ───────────────────
CREATE OR REPLACE FUNCTION physical_baselines_freeze_upd_fn() RETURNS trigger AS $fn$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.container_label IS DISTINCT FROM OLD.container_label
     OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
     OR NEW.count_date IS DISTINCT FROM OLD.count_date
     OR NEW.source_doc IS DISTINCT FROM OLD.source_doc
     OR NEW.counted_by IS DISTINCT FROM OLD.counted_by
     OR NEW.positions_count IS DISTINCT FROM OLD.positions_count
     OR NEW.total_weight_kg IS DISTINCT FROM OLD.total_weight_kg
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'physical_baselines MUZLATILGAN (id=%, %): faqat status MAPPED->LOADED o''zgarishi mumkin', OLD.id, OLD.container_label;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'MAPPED' AND NEW.status = 'LOADED') THEN
    RAISE EXCEPTION 'physical_baselines.status faqat MAPPED->LOADED (id=%, % -> %)', OLD.id, OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER physical_baselines_freeze_upd
  BEFORE UPDATE ON physical_baselines
  FOR EACH ROW EXECUTE FUNCTION physical_baselines_freeze_upd_fn();

CREATE OR REPLACE FUNCTION physical_baselines_no_delete_fn() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'physical_baselines satri o''chirilmaydi — registr append-only; rollback = DROP TABLE (taklif §13)';
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER physical_baselines_no_delete
  BEFORE DELETE ON physical_baselines
  FOR EACH ROW EXECUTE FUNCTION physical_baselines_no_delete_fn();
CREATE TRIGGER physical_baselines_no_truncate
  BEFORE TRUNCATE ON physical_baselines
  FOR EACH STATEMENT EXECUTE FUNCTION physical_baselines_no_delete_fn();

CREATE OR REPLACE FUNCTION physical_baseline_positions_freeze_upd_fn() RETURNS trigger AS $fn$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.baseline_id IS DISTINCT FROM OLD.baseline_id
     OR NEW.position_no IS DISTINCT FROM OLD.position_no
     OR NEW.container_pos IS DISTINCT FROM OLD.container_pos
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.unit IS DISTINCT FROM OLD.unit
     OR NEW.boxes IS DISTINCT FROM OLD.boxes
     OR NEW.per_box IS DISTINCT FROM OLD.per_box
     OR NEW.unit_weight_g IS DISTINCT FROM OLD.unit_weight_g
     OR NEW.weight_kg IS DISTINCT FROM OLD.weight_kg
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'physical_baseline_positions MUZLATILGAN (position_no=%, %): sanoq qiymatlari o''zgarmaydi', OLD.position_no, OLD.name;
  END IF;
  IF NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.mapping_status IS DISTINCT FROM OLD.mapping_status
     OR NEW.note IS DISTINCT FROM OLD.note THEN
    IF NOT (OLD.item_id IS NULL AND NEW.item_id IS NOT NULL
            AND OLD.mapping_status = 'EXCLUDED_EXACT_CANDIDATE'
            AND NEW.mapping_status = 'MAPPED') THEN
      RAISE EXCEPTION 'physical_baseline_positions (position_no=%): faqat EXACT kandidatga item_id NULL->qiymat (EXCLUDED->MAPPED, egasi qarori №1) ruxsat etiladi', OLD.position_no;
    END IF;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER physical_baseline_positions_freeze_upd
  BEFORE UPDATE ON physical_baseline_positions
  FOR EACH ROW EXECUTE FUNCTION physical_baseline_positions_freeze_upd_fn();

CREATE OR REPLACE FUNCTION physical_baseline_positions_no_delete_fn() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'physical_baseline_positions satri o''chirilmaydi — registr append-only; rollback = DROP TABLE (taklif §13)';
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER physical_baseline_positions_no_delete
  BEFORE DELETE ON physical_baseline_positions
  FOR EACH ROW EXECUTE FUNCTION physical_baseline_positions_no_delete_fn();
CREATE TRIGGER physical_baseline_positions_no_truncate
  BEFORE TRUNCATE ON physical_baseline_positions
  FOR EACH STATEMENT EXECUTE FUNCTION physical_baseline_positions_no_delete_fn();

-- ── 2. 9 baseline satri ──────────────────────────────────────────────────────
INSERT INTO physical_baselines
  (container_label, warehouse_id, count_date, source_doc, counted_by, positions_count, total_weight_kg, status, note, created_by)
VALUES
  ('C-20', 26, '2026-08-15', 'docs/physical-count-reconciliation-2026-08-15.md (3-bosqich)', 'thisismurodov', 10, 10136.45, 'MAPPED', 'Mapping muhri: docs/r-b-mapping-preview-2026-08-17.md', 'thisismurodov'),
  ('C-19', 25, '2026-08-15', 'docs/physical-count-reconciliation-2026-08-15.md (3-bosqich)', 'thisismurodov', 13, 8713.30, 'MAPPED', 'Mapping muhri: docs/r-b-mapping-preview-2026-08-17.md', 'thisismurodov'),
  ('C-18', 24, '2026-08-15', 'docs/physical-count-reconciliation-2026-08-15.md (3-bosqich)', 'thisismurodov', 29, 9839.45, 'MAPPED', '29 pozitsiyadan 28 tasi mapping''da; «Rossiya Tros» (531 kg) — EXACT kandidat, item_id=NULL (egasi qarori №1). Mapping muhri: docs/r-b-mapping-preview-2026-08-17.md', 'thisismurodov'),
  ('C-02', 8, '2026-08-15', 'docs/physical-count-reconciliation-2026-08-15.md (3-bosqich)', 'thisismurodov', 10, 6053.00, 'MAPPED', '10 pozitsiyadan 9 tasi mapping''da; «Shroki 3.5 Oq» (676.55 kg) — EXACT kandidat, item_id=NULL (egasi qarori №1). Mapping muhri: docs/r-b-mapping-preview-2026-08-17.md', 'thisismurodov'),
  ('C-04', 10, '2026-08-15', 'docs/physical-count-reconciliation-2026-08-15.md (3-bosqich)', 'thisismurodov', 7, 6363.30, 'MAPPED', 'Mapping muhri: docs/r-b-mapping-preview-2026-08-17.md', 'thisismurodov'),
  ('C-06', 12, '2026-08-15', 'docs/physical-count-reconciliation-2026-08-15.md (3-bosqich)', 'thisismurodov', 13, 7435.50, 'MAPPED', 'Mapping muhri: docs/r-b-mapping-preview-2026-08-17.md', 'thisismurodov'),
  ('C-16', 22, '2026-08-15', 'docs/physical-count-c16-c17-2026-08-15.md', 'thisismurodov', 3, 7045.20, 'MAPPED', 'Mapping muhri: docs/r-b-mapping-preview-2026-08-17.md', 'thisismurodov'),
  ('C-17', 23, '2026-08-15', 'docs/physical-count-c16-c17-2026-08-15.md', 'thisismurodov', 9, 3256.00, 'MAPPED', 'Qop jami 279 — egasi tasdig''i 2026-08-16 (manba fayldagi «259» yozuv xatosi). Mapping muhri: docs/r-b-mapping-preview-2026-08-17.md', 'thisismurodov'),
  ('C-15', 21, '2026-08-16', 'docs/physical-count-c15-2026-08-16.md', 'thisismurodov', 3, 13020.00, 'MAPPED', 'Kuzatuv: joy maqsadi ''finished'', tarkib xomashyo (CF filament) — §16 №3 ochiq savol. Mapping muhri: docs/r-b-mapping-preview-2026-08-17.md', 'thisismurodov');

-- ── 3. 97 pozitsiya satri (muhrlangan §3 tartibida) ──────────────────────────
INSERT INTO physical_baseline_positions
  (baseline_id, position_no, container_pos, name, quantity, unit, boxes, per_box, unit_weight_g, weight_kg, item_id, mapping_status, note, created_by)
SELECT b.id, v.position_no::int, v.container_pos::int, v.name::text, v.quantity::numeric, v.unit::text,
       v.boxes::numeric, v.per_box::numeric, v.unit_weight_g::numeric, v.weight_kg::numeric,
       CASE WHEN v.item_sku IS NULL THEN NULL
            ELSE (SELECT i.id FROM items i WHERE i.sku = v.item_sku::text) END,
       v.mapping_status::text, v.note::text, 'thisismurodov'
FROM (VALUES
  ('C-20', 1, 1, 'Neylon 210D / 45', 80.00, 'kg', NULL, NULL, NULL, 80.00, 'TM-000001', 'MAPPED', NULL),
  ('C-20', 2, 2, 'Neylon 210D / 60', 1474.00, 'kg', NULL, NULL, NULL, 1474.00, 'TM-000002', 'MAPPED', NULL),
  ('C-20', 3, 3, 'Neylon 210D / 90', 330.00, 'kg', NULL, NULL, NULL, 330.00, 'TM-000003', 'MAPPED', NULL),
  ('C-20', 4, 4, 'Toshkent Oq 14 mm — Bir qavat', 942.05, 'kg', NULL, NULL, NULL, 942.05, 'TM-000004', 'MAPPED', NULL),
  ('C-20', 5, 5, 'FDY Igna Strupa', 4572.25, 'kg', NULL, NULL, NULL, 4572.25, 'TM-000005', 'MAPPED', NULL),
  ('C-20', 6, 6, 'Toshkent Qora 14 mm Ichki Sariq', 636.25, 'kg', NULL, NULL, NULL, 636.25, 'TM-000006', 'MAPPED', NULL),
  ('C-20', 7, 7, '16 mm Alpinist', 520.00, 'kg', NULL, NULL, NULL, 520.00, 'TM-000007', 'MAPPED', NULL),
  ('C-20', 8, 8, '14 mm Alpinist', 930.00, 'kg', NULL, NULL, NULL, 930.00, 'TM-000008', 'MAPPED', NULL),
  ('C-20', 9, 9, 'Toshkent Qora 14 mm Ichi Oq PP TWS', 309.60, 'kg', NULL, NULL, NULL, 309.60, 'TM-000009', 'MAPPED', NULL),
  ('C-20', 10, 10, 'Toshkent Oq 16 mm Ichi Oq PP TWS — 50 metr', 342.30, 'kg', NULL, NULL, NULL, 342.30, 'TM-000010', 'MAPPED', 'metr: NULL — «N metr» nom tarkibida, fizik metr sanog''i berilmagan'),
  ('C-19', 11, 1, 'Polyamide 144 oq TWS', 552.90, 'kg', NULL, NULL, NULL, 552.90, 'TM-000011', 'MAPPED', NULL),
  ('C-19', 12, 2, 'Polyamide Ko‘k 187 TWS', 94.05, 'kg', NULL, NULL, NULL, 94.05, 'TM-000012', 'MAPPED', NULL),
  ('C-19', 13, 3, 'Polyamide Qizil 187 TWS', 73.65, 'kg', NULL, NULL, NULL, 73.65, 'TM-000013', 'MAPPED', NULL),
  ('C-19', 14, 4, 'Polyamide Sariq 187 TWS', 44.60, 'kg', NULL, NULL, NULL, 44.60, 'TM-000014', 'MAPPED', NULL),
  ('C-19', 15, 5, 'Polyamide Oq 187 TWS', 132.15, 'kg', NULL, NULL, NULL, 132.15, 'TM-000015', 'MAPPED', NULL),
  ('C-19', 16, 6, 'Qop ip Yashil', 2244.10, 'kg', NULL, NULL, NULL, 2244.10, 'TM-000016', 'MAPPED', NULL),
  ('C-19', 17, 7, 'Qop ip Qizil', 728.55, 'kg', NULL, NULL, NULL, 728.55, 'TM-000017', 'MAPPED', NULL),
  ('C-19', 18, 8, 'Passport Xom BCF', 646.00, 'kg', NULL, NULL, NULL, 646.00, 'TM-000018', 'MAPPED', NULL),
  ('C-19', 19, 9, 'Yashil PP TWS Strupa 24 talik', 643.40, 'kg', NULL, NULL, NULL, 643.40, 'TM-000019', 'MAPPED', NULL),
  ('C-19', 20, 10, 'Passport Strupa 16 talik', 527.65, 'kg', NULL, NULL, NULL, 527.65, 'TM-000020', 'MAPPED', NULL),
  ('C-19', 21, 11, 'Passport Strupa 24 talik', 273.75, 'kg', NULL, NULL, NULL, 273.75, 'TM-000021', 'MAPPED', NULL),
  ('C-19', 22, 12, 'Yashil PP TWS Strupa 16 talik', 168.60, 'kg', NULL, NULL, NULL, 168.60, 'TM-000022', 'MAPPED', 'AYNAN · 2-JOYLI: ikkinchi joy C-04 (261.2 kg); jami 429.8 kg'),
  ('C-19', 23, 13, 'Sariq Polyester Strupa 16 talik', 2583.90, 'kg', NULL, NULL, NULL, 2583.90, 'TM-000023', 'MAPPED', NULL),
  ('C-18', 24, 1, 'Toshkent Arqon 16 mm Ko‘k', 221.60, 'kg', NULL, NULL, NULL, 221.60, 'TM-000024', 'MAPPED', NULL),
  ('C-18', 25, 2, 'Toshkent Arqon 16 mm Qora', 332.95, 'kg', NULL, NULL, NULL, 332.95, 'TM-000025', 'MAPPED', NULL),
  ('C-18', 26, 3, 'Ustki Gilam Ichki Sariq Polyamide', 317.25, 'kg', NULL, NULL, NULL, 317.25, 'TM-000026', 'MAPPED', NULL),
  ('C-18', 27, 4, 'Toshkent Arqon 10 mm Yashil', 171.90, 'kg', NULL, NULL, NULL, 171.90, 'TM-000027', 'MAPPED', NULL),
  ('C-18', 28, 5, 'Toshkent Arqon 14 mm Qizil', 451.70, 'kg', NULL, NULL, NULL, 451.70, 'TM-000028', 'MAPPED', NULL),
  ('C-18', 29, 6, 'Toshkent Arqon 12 mm Qora Ichki Polyamide Sariq', 866.25, 'kg', NULL, NULL, NULL, 866.25, 'TM-000029', 'MAPPED', NULL),
  ('C-18', 30, 7, 'Toshkent Arqon 12 mm Qizil', 61.65, 'kg', NULL, NULL, NULL, 61.65, 'TM-000030', 'MAPPED', NULL),
  ('C-18', 31, 8, 'Toshkent Arqon 14 mm Qora', 150.00, 'kg', NULL, NULL, NULL, 150.00, 'TM-000031', 'MAPPED', NULL),
  ('C-18', 32, 9, 'Toshkent Arqon 10 mm Ko‘k', 150.25, 'kg', NULL, NULL, NULL, 150.25, 'TM-000032', 'MAPPED', NULL),
  ('C-18', 33, 10, 'FDY Fil Arqon', 497.55, 'kg', NULL, NULL, NULL, 497.55, 'TM-000033', 'MAPPED', NULL),
  ('C-18', 34, 11, 'Toshkent Arqon 16 mm Oq — 50 metr', 63.20, 'kg', NULL, NULL, NULL, 63.20, 'TM-000034', 'MAPPED', 'metr: NULL — «N metr» nom tarkibida, fizik metr sanog''i berilmagan'),
  ('C-18', 35, 12, 'Toshkent Arqon 14 mm Oq — 100 metr', 40.05, 'kg', NULL, NULL, NULL, 40.05, 'TM-000035', 'MAPPED', 'metr: NULL — «N metr» nom tarkibida, fizik metr sanog''i berilmagan'),
  ('C-18', 36, 13, 'Toshkent Arqon 16 mm Oq', 61.90, 'kg', NULL, NULL, NULL, 61.90, 'TM-000036', 'MAPPED', NULL),
  ('C-18', 37, 14, 'Toshkent Arqon Qora 16 mm Ichki Polyamide Sariq', 717.35, 'kg', NULL, NULL, NULL, 717.35, 'TM-000037', 'MAPPED', NULL),
  ('C-18', 38, 15, 'Toshkent Arqon 12 mm Sariq', 389.95, 'kg', NULL, NULL, NULL, 389.95, 'TM-000038', 'MAPPED', NULL),
  ('C-18', 39, 16, 'FDY Tros Aralash', 386.75, 'kg', NULL, NULL, NULL, 386.75, 'TM-000039', 'MAPPED', NULL),
  ('C-18', 40, 17, 'Rossiya Tros', 531.00, 'kg', NULL, NULL, NULL, 531.00, NULL, 'EXCLUDED_EXACT_CANDIDATE', 'EXACT kandidat (egasi qarori №1 ochiq): avto-mapping YO''Q; legacy SKU ROSSIYATROS bilan aynan mos'),
  ('C-18', 41, 18, 'Usti gilam ichki Sariq Polyamide Arqon', 370.50, 'kg', NULL, NULL, NULL, 370.50, 'TM-000040', 'MAPPED', NULL),
  ('C-18', 42, 19, 'Ustki Oq TWS ichki Polyamide Oq Arqon', 1264.10, 'kg', NULL, NULL, NULL, 1264.10, 'TM-000041', 'MAPPED', NULL),
  ('C-18', 43, 20, 'Ustki PP xom ichki Polyamide Oq Arqon', 105.00, 'kg', NULL, NULL, NULL, 105.00, 'TM-000042', 'MAPPED', NULL),
  ('C-18', 44, 21, 'Ustki 187 TWS Oq ichki Zubr 16 mm Arqon', 926.40, 'kg', NULL, NULL, NULL, 926.40, 'TM-000043', 'MAPPED', NULL),
  ('C-18', 45, 22, 'Ustki 187 TWS Oq ichki Strupa 14 mm Arqon', 520.00, 'kg', NULL, NULL, NULL, 520.00, 'TM-000044', 'MAPPED', NULL),
  ('C-18', 46, 23, 'Kanob Aralash 20 metr', 113.55, 'kg', NULL, NULL, NULL, 113.55, 'TM-000045', 'MAPPED', 'metr: NULL — «N metr» nom tarkibida, fizik metr sanog''i berilmagan'),
  ('C-18', 47, 24, 'Alpinist 12 mm', 450.60, 'kg', NULL, NULL, NULL, 450.60, 'TM-000046', 'MAPPED', NULL),
  ('C-18', 48, 25, 'Alpinist 10 mm', 106.20, 'kg', NULL, NULL, NULL, 106.20, 'TM-000047', 'MAPPED', NULL),
  ('C-18', 49, 26, 'Alpinist 14 mm', 165.55, 'kg', NULL, NULL, NULL, 165.55, 'TM-000048', 'MAPPED', NULL),
  ('C-18', 50, 27, 'Alpinist 16 mm', 199.30, 'kg', NULL, NULL, NULL, 199.30, 'TM-000049', 'MAPPED', NULL),
  ('C-18', 51, 28, 'Alpinist 20 mm', 174.50, 'kg', NULL, NULL, NULL, 174.50, 'TM-000050', 'MAPPED', NULL),
  ('C-18', 52, 29, 'Alpinist 25 mm', 32.45, 'kg', NULL, NULL, NULL, 32.45, 'TM-000051', 'MAPPED', NULL),
  ('C-02', 53, 1, 'Shroki 3.5 sm lenta', 468.35, 'kg', NULL, NULL, NULL, 468.35, 'TM-000052', 'MAPPED', NULL),
  ('C-02', 54, 2, 'Rangli 2.5 sm ikki qavat lenta', 863.45, 'kg', NULL, NULL, NULL, 863.45, 'TM-000053', 'MAPPED', NULL),
  ('C-02', 55, 3, 'Reels Lenta', 1352.85, 'kg', NULL, NULL, NULL, 1352.85, 'TM-000054', 'MAPPED', NULL),
  ('C-02', 56, 4, 'Tulpor Lenta Aralash', 556.40, 'kg', NULL, NULL, NULL, 556.40, 'TM-000055', 'MAPPED', NULL),
  ('C-02', 57, 5, 'Tulpor Lenta Yashil', 1019.35, 'kg', NULL, NULL, NULL, 1019.35, 'TM-000056', 'MAPPED', NULL),
  ('C-02', 58, 6, 'Tulpor Lenta Oq', 439.20, 'kg', NULL, NULL, NULL, 439.20, 'TM-000057', 'MAPPED', NULL),
  ('C-02', 59, 7, 'Tulpor Lenta Ko‘k', 192.05, 'kg', NULL, NULL, NULL, 192.05, 'TM-000058', 'MAPPED', NULL),
  ('C-02', 60, 8, 'Tulpor lenta qizil', 287.00, 'kg', NULL, NULL, NULL, 287.00, 'TM-000059', 'MAPPED', NULL),
  ('C-02', 61, 9, 'Shroki 3.5 Oq', 676.55, 'kg', NULL, NULL, NULL, 676.55, NULL, 'EXCLUDED_EXACT_CANDIDATE', 'EXACT kandidat (egasi qarori №1 ochiq): avto-mapping YO''Q; legacy SKU SHROKI-3-5-OQ bilan aynan mos'),
  ('C-02', 62, 10, 'Tahoe Lenta', 197.80, 'kg', NULL, NULL, NULL, 197.80, 'TM-000060', 'MAPPED', NULL),
  ('C-04', 63, 1, 'Polipropilen CF 1500D Qora', 3250.00, 'kg', NULL, NULL, NULL, 3250.00, 'TM-000061', 'MAPPED', NULL),
  ('C-04', 64, 2, 'Polipropilen CF 1000D Yashil', 1020.00, 'kg', NULL, NULL, NULL, 1020.00, 'TM-000062', 'MAPPED', NULL),
  ('C-04', 65, 3, 'Strupa Salafan', 375.80, 'kg', NULL, NULL, NULL, 375.80, 'TM-000063', 'MAPPED', NULL),
  ('C-04', 66, 4, 'XB Strupa', 349.90, 'kg', NULL, NULL, NULL, 349.90, 'TM-000064', 'MAPPED', NULL),
  ('C-04', 67, 5, 'PP Oq TWS Strupa 12 talik', 875.55, 'kg', NULL, NULL, NULL, 875.55, 'TM-000065', 'MAPPED', NULL),
  ('C-04', 68, 6, 'Eshma Xitoy Strupa PP Oq TWS', 230.85, 'kg', NULL, NULL, NULL, 230.85, 'TM-000066', 'MAPPED', NULL),
  ('C-04', 69, 7, 'Yashil PP TWS Strupa 16 talik', 261.20, 'kg', NULL, NULL, NULL, 261.20, 'TM-000022', 'MAPPED', 'AYNAN · 2-JOYLI: ikkinchi joy C-19 (168.6 kg); jami 429.8 kg'),
  ('C-06', 70, 1, 'Shlanka Polyamide Yumshoq', 86.30, 'kg', NULL, NULL, NULL, 86.30, 'TM-000067', 'MAPPED', NULL),
  ('C-06', 71, 2, 'Shlanka Tortqi PP Oq TWS — 50 metr', 236.25, 'kg', NULL, NULL, NULL, 236.25, 'TM-000068', 'MAPPED', 'metr: NULL — «N metr» nom tarkibida, fizik metr sanog''i berilmagan'),
  ('C-06', 72, 3, 'Shlanka Tortqi PP Yashil TWS — 50 metr', 66.35, 'kg', NULL, NULL, NULL, 66.35, 'TM-000069', 'MAPPED', 'metr: NULL — «N metr» nom tarkibida, fizik metr sanog''i berilmagan'),
  ('C-06', 73, 4, 'Shlanka Polipropilen CF Qora', 618.80, 'kg', NULL, NULL, NULL, 618.80, 'TM-000070', 'MAPPED', NULL),
  ('C-06', 74, 5, 'Shlanka Polipropilen CF Yashil', 710.45, 'kg', NULL, NULL, NULL, 710.45, 'TM-000071', 'MAPPED', NULL),
  ('C-06', 75, 6, 'Shlanka Polipropilen CF Ko‘k', 506.25, 'kg', NULL, NULL, NULL, 506.25, 'TM-000072', 'MAPPED', NULL),
  ('C-06', 76, 7, 'Shlanka Polipropilen CF Qizil', 581.40, 'kg', NULL, NULL, NULL, 581.40, 'TM-000073', 'MAPPED', NULL),
  ('C-06', 77, 8, 'Shlanka Polipropilen CF Oq', 874.95, 'kg', NULL, NULL, NULL, 874.95, 'TM-000074', 'MAPPED', NULL),
  ('C-06', 78, 9, 'Shlanka Polyester FDY Qora', 433.20, 'kg', NULL, NULL, NULL, 433.20, 'TM-000075', 'MAPPED', NULL),
  ('C-06', 79, 10, 'Shlanka Polyester FDY Yashil', 830.40, 'kg', NULL, NULL, NULL, 830.40, 'TM-000076', 'MAPPED', NULL),
  ('C-06', 80, 11, 'Shlanka Polyester FDY Ko‘k', 778.15, 'kg', NULL, NULL, NULL, 778.15, 'TM-000077', 'MAPPED', NULL),
  ('C-06', 81, 12, 'Shlanka Polyester FDY Qizil', 730.95, 'kg', NULL, NULL, NULL, 730.95, 'TM-000078', 'MAPPED', NULL),
  ('C-06', 82, 13, 'Shlanka Polyester FDY Oq', 982.05, 'kg', NULL, NULL, NULL, 982.05, 'TM-000079', 'MAPPED', NULL),
  ('C-16', 83, 1, 'Qop ip 100 talik', 55200.00, 'dona', 552, 100, 115, 6348.00, 'TM-000080', 'MAPPED', NULL),
  ('C-16', 84, 2, 'Qop ip 120 talik', 2520.00, 'dona', 21, 120, 90, 226.80, 'TM-000081', 'MAPPED', NULL),
  ('C-16', 85, 3, 'Qop ip 80 talik', 3360.00, 'dona', 42, 80, 140, 470.40, 'TM-000082', 'MAPPED', NULL),
  ('C-17', 86, 1, 'Qop ip 50 gramm Qora', 12000.00, 'dona', 60, 200, 50, 600.00, 'TM-000083', 'MAPPED', NULL),
  ('C-17', 87, 2, 'Qop ip 50 gramm Sariq', 12800.00, 'dona', 64, 200, 50, 640.00, 'TM-000084', 'MAPPED', NULL),
  ('C-17', 88, 3, 'Qop ip 50 gramm Oq', 7600.00, 'dona', 38, 200, 50, 380.00, 'TM-000085', 'MAPPED', NULL),
  ('C-17', 89, 4, 'Qop ip 30 gramm Qora', 4800.00, 'dona', 12, 400, 30, 144.00, 'TM-000086', 'MAPPED', NULL),
  ('C-17', 90, 5, 'Qop ip 30 gramm Sariq', 10400.00, 'dona', 26, 400, 30, 312.00, 'TM-000087', 'MAPPED', NULL),
  ('C-17', 91, 6, 'Qop ip 30 gramm Oq', 8400.00, 'dona', 21, 400, 30, 252.00, 'TM-000088', 'MAPPED', NULL),
  ('C-17', 92, 7, 'Qop ip 100 gramm Qora', 2080.00, 'dona', 13, 160, 100, 208.00, 'TM-000089', 'MAPPED', NULL),
  ('C-17', 93, 8, 'Qop ip 100 gramm Sariq', 2880.00, 'dona', 18, 160, 100, 288.00, 'TM-000090', 'MAPPED', NULL),
  ('C-17', 94, 9, 'Qop ip 100 gramm Oq', 4320.00, 'dona', 27, 160, 100, 432.00, 'TM-000091', 'MAPPED', NULL),
  ('C-15', 95, 1, 'Polipropilen CF 1000D Qizil', 3720.00, 'kg', NULL, NULL, NULL, 3720.00, 'TM-000092', 'MAPPED', NULL),
  ('C-15', 96, 2, 'Polipropilen CF 1000D Ko''k', 3840.00, 'kg', NULL, NULL, NULL, 3840.00, 'TM-000093', 'MAPPED', NULL),
  ('C-15', 97, 3, 'Polipropilen CF 1000D Sariq', 5460.00, 'kg', NULL, NULL, NULL, 5460.00, 'TM-000094', 'MAPPED', NULL)
) AS v(container_label, position_no, container_pos, name, quantity, unit, boxes, per_box, unit_weight_g, weight_kg, item_sku, mapping_status, note)
JOIN physical_baselines b ON b.container_label = v.container_label::text;

-- ── 3b. Muhrlangan kutilma jadvali (97 satr, maydonma-maydon) ────────────────
CREATE TEMP TABLE rb_expected (
  container_label text NOT NULL, position_no int PRIMARY KEY, container_pos int NOT NULL,
  name text NOT NULL, quantity numeric NOT NULL, unit text NOT NULL,
  boxes numeric, per_box numeric, unit_weight_g numeric, weight_kg numeric NOT NULL,
  item_sku text, mapping_status text NOT NULL, note text
) ON COMMIT DROP;
INSERT INTO rb_expected
  (container_label, position_no, container_pos, name, quantity, unit, boxes, per_box, unit_weight_g, weight_kg, item_sku, mapping_status, note)
SELECT v.container_label::text, v.position_no::int, v.container_pos::int, v.name::text, v.quantity::numeric, v.unit::text,
       v.boxes::numeric, v.per_box::numeric, v.unit_weight_g::numeric, v.weight_kg::numeric,
       v.item_sku::text, v.mapping_status::text, v.note::text
FROM (VALUES
  ('C-20', 1, 1, 'Neylon 210D / 45', 80.00, 'kg', NULL, NULL, NULL, 80.00, 'TM-000001', 'MAPPED', NULL),
  ('C-20', 2, 2, 'Neylon 210D / 60', 1474.00, 'kg', NULL, NULL, NULL, 1474.00, 'TM-000002', 'MAPPED', NULL),
  ('C-20', 3, 3, 'Neylon 210D / 90', 330.00, 'kg', NULL, NULL, NULL, 330.00, 'TM-000003', 'MAPPED', NULL),
  ('C-20', 4, 4, 'Toshkent Oq 14 mm — Bir qavat', 942.05, 'kg', NULL, NULL, NULL, 942.05, 'TM-000004', 'MAPPED', NULL),
  ('C-20', 5, 5, 'FDY Igna Strupa', 4572.25, 'kg', NULL, NULL, NULL, 4572.25, 'TM-000005', 'MAPPED', NULL),
  ('C-20', 6, 6, 'Toshkent Qora 14 mm Ichki Sariq', 636.25, 'kg', NULL, NULL, NULL, 636.25, 'TM-000006', 'MAPPED', NULL),
  ('C-20', 7, 7, '16 mm Alpinist', 520.00, 'kg', NULL, NULL, NULL, 520.00, 'TM-000007', 'MAPPED', NULL),
  ('C-20', 8, 8, '14 mm Alpinist', 930.00, 'kg', NULL, NULL, NULL, 930.00, 'TM-000008', 'MAPPED', NULL),
  ('C-20', 9, 9, 'Toshkent Qora 14 mm Ichi Oq PP TWS', 309.60, 'kg', NULL, NULL, NULL, 309.60, 'TM-000009', 'MAPPED', NULL),
  ('C-20', 10, 10, 'Toshkent Oq 16 mm Ichi Oq PP TWS — 50 metr', 342.30, 'kg', NULL, NULL, NULL, 342.30, 'TM-000010', 'MAPPED', 'metr: NULL — «N metr» nom tarkibida, fizik metr sanog''i berilmagan'),
  ('C-19', 11, 1, 'Polyamide 144 oq TWS', 552.90, 'kg', NULL, NULL, NULL, 552.90, 'TM-000011', 'MAPPED', NULL),
  ('C-19', 12, 2, 'Polyamide Ko‘k 187 TWS', 94.05, 'kg', NULL, NULL, NULL, 94.05, 'TM-000012', 'MAPPED', NULL),
  ('C-19', 13, 3, 'Polyamide Qizil 187 TWS', 73.65, 'kg', NULL, NULL, NULL, 73.65, 'TM-000013', 'MAPPED', NULL),
  ('C-19', 14, 4, 'Polyamide Sariq 187 TWS', 44.60, 'kg', NULL, NULL, NULL, 44.60, 'TM-000014', 'MAPPED', NULL),
  ('C-19', 15, 5, 'Polyamide Oq 187 TWS', 132.15, 'kg', NULL, NULL, NULL, 132.15, 'TM-000015', 'MAPPED', NULL),
  ('C-19', 16, 6, 'Qop ip Yashil', 2244.10, 'kg', NULL, NULL, NULL, 2244.10, 'TM-000016', 'MAPPED', NULL),
  ('C-19', 17, 7, 'Qop ip Qizil', 728.55, 'kg', NULL, NULL, NULL, 728.55, 'TM-000017', 'MAPPED', NULL),
  ('C-19', 18, 8, 'Passport Xom BCF', 646.00, 'kg', NULL, NULL, NULL, 646.00, 'TM-000018', 'MAPPED', NULL),
  ('C-19', 19, 9, 'Yashil PP TWS Strupa 24 talik', 643.40, 'kg', NULL, NULL, NULL, 643.40, 'TM-000019', 'MAPPED', NULL),
  ('C-19', 20, 10, 'Passport Strupa 16 talik', 527.65, 'kg', NULL, NULL, NULL, 527.65, 'TM-000020', 'MAPPED', NULL),
  ('C-19', 21, 11, 'Passport Strupa 24 talik', 273.75, 'kg', NULL, NULL, NULL, 273.75, 'TM-000021', 'MAPPED', NULL),
  ('C-19', 22, 12, 'Yashil PP TWS Strupa 16 talik', 168.60, 'kg', NULL, NULL, NULL, 168.60, 'TM-000022', 'MAPPED', 'AYNAN · 2-JOYLI: ikkinchi joy C-04 (261.2 kg); jami 429.8 kg'),
  ('C-19', 23, 13, 'Sariq Polyester Strupa 16 talik', 2583.90, 'kg', NULL, NULL, NULL, 2583.90, 'TM-000023', 'MAPPED', NULL),
  ('C-18', 24, 1, 'Toshkent Arqon 16 mm Ko‘k', 221.60, 'kg', NULL, NULL, NULL, 221.60, 'TM-000024', 'MAPPED', NULL),
  ('C-18', 25, 2, 'Toshkent Arqon 16 mm Qora', 332.95, 'kg', NULL, NULL, NULL, 332.95, 'TM-000025', 'MAPPED', NULL),
  ('C-18', 26, 3, 'Ustki Gilam Ichki Sariq Polyamide', 317.25, 'kg', NULL, NULL, NULL, 317.25, 'TM-000026', 'MAPPED', NULL),
  ('C-18', 27, 4, 'Toshkent Arqon 10 mm Yashil', 171.90, 'kg', NULL, NULL, NULL, 171.90, 'TM-000027', 'MAPPED', NULL),
  ('C-18', 28, 5, 'Toshkent Arqon 14 mm Qizil', 451.70, 'kg', NULL, NULL, NULL, 451.70, 'TM-000028', 'MAPPED', NULL),
  ('C-18', 29, 6, 'Toshkent Arqon 12 mm Qora Ichki Polyamide Sariq', 866.25, 'kg', NULL, NULL, NULL, 866.25, 'TM-000029', 'MAPPED', NULL),
  ('C-18', 30, 7, 'Toshkent Arqon 12 mm Qizil', 61.65, 'kg', NULL, NULL, NULL, 61.65, 'TM-000030', 'MAPPED', NULL),
  ('C-18', 31, 8, 'Toshkent Arqon 14 mm Qora', 150.00, 'kg', NULL, NULL, NULL, 150.00, 'TM-000031', 'MAPPED', NULL),
  ('C-18', 32, 9, 'Toshkent Arqon 10 mm Ko‘k', 150.25, 'kg', NULL, NULL, NULL, 150.25, 'TM-000032', 'MAPPED', NULL),
  ('C-18', 33, 10, 'FDY Fil Arqon', 497.55, 'kg', NULL, NULL, NULL, 497.55, 'TM-000033', 'MAPPED', NULL),
  ('C-18', 34, 11, 'Toshkent Arqon 16 mm Oq — 50 metr', 63.20, 'kg', NULL, NULL, NULL, 63.20, 'TM-000034', 'MAPPED', 'metr: NULL — «N metr» nom tarkibida, fizik metr sanog''i berilmagan'),
  ('C-18', 35, 12, 'Toshkent Arqon 14 mm Oq — 100 metr', 40.05, 'kg', NULL, NULL, NULL, 40.05, 'TM-000035', 'MAPPED', 'metr: NULL — «N metr» nom tarkibida, fizik metr sanog''i berilmagan'),
  ('C-18', 36, 13, 'Toshkent Arqon 16 mm Oq', 61.90, 'kg', NULL, NULL, NULL, 61.90, 'TM-000036', 'MAPPED', NULL),
  ('C-18', 37, 14, 'Toshkent Arqon Qora 16 mm Ichki Polyamide Sariq', 717.35, 'kg', NULL, NULL, NULL, 717.35, 'TM-000037', 'MAPPED', NULL),
  ('C-18', 38, 15, 'Toshkent Arqon 12 mm Sariq', 389.95, 'kg', NULL, NULL, NULL, 389.95, 'TM-000038', 'MAPPED', NULL),
  ('C-18', 39, 16, 'FDY Tros Aralash', 386.75, 'kg', NULL, NULL, NULL, 386.75, 'TM-000039', 'MAPPED', NULL),
  ('C-18', 40, 17, 'Rossiya Tros', 531.00, 'kg', NULL, NULL, NULL, 531.00, NULL, 'EXCLUDED_EXACT_CANDIDATE', 'EXACT kandidat (egasi qarori №1 ochiq): avto-mapping YO''Q; legacy SKU ROSSIYATROS bilan aynan mos'),
  ('C-18', 41, 18, 'Usti gilam ichki Sariq Polyamide Arqon', 370.50, 'kg', NULL, NULL, NULL, 370.50, 'TM-000040', 'MAPPED', NULL),
  ('C-18', 42, 19, 'Ustki Oq TWS ichki Polyamide Oq Arqon', 1264.10, 'kg', NULL, NULL, NULL, 1264.10, 'TM-000041', 'MAPPED', NULL),
  ('C-18', 43, 20, 'Ustki PP xom ichki Polyamide Oq Arqon', 105.00, 'kg', NULL, NULL, NULL, 105.00, 'TM-000042', 'MAPPED', NULL),
  ('C-18', 44, 21, 'Ustki 187 TWS Oq ichki Zubr 16 mm Arqon', 926.40, 'kg', NULL, NULL, NULL, 926.40, 'TM-000043', 'MAPPED', NULL),
  ('C-18', 45, 22, 'Ustki 187 TWS Oq ichki Strupa 14 mm Arqon', 520.00, 'kg', NULL, NULL, NULL, 520.00, 'TM-000044', 'MAPPED', NULL),
  ('C-18', 46, 23, 'Kanob Aralash 20 metr', 113.55, 'kg', NULL, NULL, NULL, 113.55, 'TM-000045', 'MAPPED', 'metr: NULL — «N metr» nom tarkibida, fizik metr sanog''i berilmagan'),
  ('C-18', 47, 24, 'Alpinist 12 mm', 450.60, 'kg', NULL, NULL, NULL, 450.60, 'TM-000046', 'MAPPED', NULL),
  ('C-18', 48, 25, 'Alpinist 10 mm', 106.20, 'kg', NULL, NULL, NULL, 106.20, 'TM-000047', 'MAPPED', NULL),
  ('C-18', 49, 26, 'Alpinist 14 mm', 165.55, 'kg', NULL, NULL, NULL, 165.55, 'TM-000048', 'MAPPED', NULL),
  ('C-18', 50, 27, 'Alpinist 16 mm', 199.30, 'kg', NULL, NULL, NULL, 199.30, 'TM-000049', 'MAPPED', NULL),
  ('C-18', 51, 28, 'Alpinist 20 mm', 174.50, 'kg', NULL, NULL, NULL, 174.50, 'TM-000050', 'MAPPED', NULL),
  ('C-18', 52, 29, 'Alpinist 25 mm', 32.45, 'kg', NULL, NULL, NULL, 32.45, 'TM-000051', 'MAPPED', NULL),
  ('C-02', 53, 1, 'Shroki 3.5 sm lenta', 468.35, 'kg', NULL, NULL, NULL, 468.35, 'TM-000052', 'MAPPED', NULL),
  ('C-02', 54, 2, 'Rangli 2.5 sm ikki qavat lenta', 863.45, 'kg', NULL, NULL, NULL, 863.45, 'TM-000053', 'MAPPED', NULL),
  ('C-02', 55, 3, 'Reels Lenta', 1352.85, 'kg', NULL, NULL, NULL, 1352.85, 'TM-000054', 'MAPPED', NULL),
  ('C-02', 56, 4, 'Tulpor Lenta Aralash', 556.40, 'kg', NULL, NULL, NULL, 556.40, 'TM-000055', 'MAPPED', NULL),
  ('C-02', 57, 5, 'Tulpor Lenta Yashil', 1019.35, 'kg', NULL, NULL, NULL, 1019.35, 'TM-000056', 'MAPPED', NULL),
  ('C-02', 58, 6, 'Tulpor Lenta Oq', 439.20, 'kg', NULL, NULL, NULL, 439.20, 'TM-000057', 'MAPPED', NULL),
  ('C-02', 59, 7, 'Tulpor Lenta Ko‘k', 192.05, 'kg', NULL, NULL, NULL, 192.05, 'TM-000058', 'MAPPED', NULL),
  ('C-02', 60, 8, 'Tulpor lenta qizil', 287.00, 'kg', NULL, NULL, NULL, 287.00, 'TM-000059', 'MAPPED', NULL),
  ('C-02', 61, 9, 'Shroki 3.5 Oq', 676.55, 'kg', NULL, NULL, NULL, 676.55, NULL, 'EXCLUDED_EXACT_CANDIDATE', 'EXACT kandidat (egasi qarori №1 ochiq): avto-mapping YO''Q; legacy SKU SHROKI-3-5-OQ bilan aynan mos'),
  ('C-02', 62, 10, 'Tahoe Lenta', 197.80, 'kg', NULL, NULL, NULL, 197.80, 'TM-000060', 'MAPPED', NULL),
  ('C-04', 63, 1, 'Polipropilen CF 1500D Qora', 3250.00, 'kg', NULL, NULL, NULL, 3250.00, 'TM-000061', 'MAPPED', NULL),
  ('C-04', 64, 2, 'Polipropilen CF 1000D Yashil', 1020.00, 'kg', NULL, NULL, NULL, 1020.00, 'TM-000062', 'MAPPED', NULL),
  ('C-04', 65, 3, 'Strupa Salafan', 375.80, 'kg', NULL, NULL, NULL, 375.80, 'TM-000063', 'MAPPED', NULL),
  ('C-04', 66, 4, 'XB Strupa', 349.90, 'kg', NULL, NULL, NULL, 349.90, 'TM-000064', 'MAPPED', NULL),
  ('C-04', 67, 5, 'PP Oq TWS Strupa 12 talik', 875.55, 'kg', NULL, NULL, NULL, 875.55, 'TM-000065', 'MAPPED', NULL),
  ('C-04', 68, 6, 'Eshma Xitoy Strupa PP Oq TWS', 230.85, 'kg', NULL, NULL, NULL, 230.85, 'TM-000066', 'MAPPED', NULL),
  ('C-04', 69, 7, 'Yashil PP TWS Strupa 16 talik', 261.20, 'kg', NULL, NULL, NULL, 261.20, 'TM-000022', 'MAPPED', 'AYNAN · 2-JOYLI: ikkinchi joy C-19 (168.6 kg); jami 429.8 kg'),
  ('C-06', 70, 1, 'Shlanka Polyamide Yumshoq', 86.30, 'kg', NULL, NULL, NULL, 86.30, 'TM-000067', 'MAPPED', NULL),
  ('C-06', 71, 2, 'Shlanka Tortqi PP Oq TWS — 50 metr', 236.25, 'kg', NULL, NULL, NULL, 236.25, 'TM-000068', 'MAPPED', 'metr: NULL — «N metr» nom tarkibida, fizik metr sanog''i berilmagan'),
  ('C-06', 72, 3, 'Shlanka Tortqi PP Yashil TWS — 50 metr', 66.35, 'kg', NULL, NULL, NULL, 66.35, 'TM-000069', 'MAPPED', 'metr: NULL — «N metr» nom tarkibida, fizik metr sanog''i berilmagan'),
  ('C-06', 73, 4, 'Shlanka Polipropilen CF Qora', 618.80, 'kg', NULL, NULL, NULL, 618.80, 'TM-000070', 'MAPPED', NULL),
  ('C-06', 74, 5, 'Shlanka Polipropilen CF Yashil', 710.45, 'kg', NULL, NULL, NULL, 710.45, 'TM-000071', 'MAPPED', NULL),
  ('C-06', 75, 6, 'Shlanka Polipropilen CF Ko‘k', 506.25, 'kg', NULL, NULL, NULL, 506.25, 'TM-000072', 'MAPPED', NULL),
  ('C-06', 76, 7, 'Shlanka Polipropilen CF Qizil', 581.40, 'kg', NULL, NULL, NULL, 581.40, 'TM-000073', 'MAPPED', NULL),
  ('C-06', 77, 8, 'Shlanka Polipropilen CF Oq', 874.95, 'kg', NULL, NULL, NULL, 874.95, 'TM-000074', 'MAPPED', NULL),
  ('C-06', 78, 9, 'Shlanka Polyester FDY Qora', 433.20, 'kg', NULL, NULL, NULL, 433.20, 'TM-000075', 'MAPPED', NULL),
  ('C-06', 79, 10, 'Shlanka Polyester FDY Yashil', 830.40, 'kg', NULL, NULL, NULL, 830.40, 'TM-000076', 'MAPPED', NULL),
  ('C-06', 80, 11, 'Shlanka Polyester FDY Ko‘k', 778.15, 'kg', NULL, NULL, NULL, 778.15, 'TM-000077', 'MAPPED', NULL),
  ('C-06', 81, 12, 'Shlanka Polyester FDY Qizil', 730.95, 'kg', NULL, NULL, NULL, 730.95, 'TM-000078', 'MAPPED', NULL),
  ('C-06', 82, 13, 'Shlanka Polyester FDY Oq', 982.05, 'kg', NULL, NULL, NULL, 982.05, 'TM-000079', 'MAPPED', NULL),
  ('C-16', 83, 1, 'Qop ip 100 talik', 55200.00, 'dona', 552, 100, 115, 6348.00, 'TM-000080', 'MAPPED', NULL),
  ('C-16', 84, 2, 'Qop ip 120 talik', 2520.00, 'dona', 21, 120, 90, 226.80, 'TM-000081', 'MAPPED', NULL),
  ('C-16', 85, 3, 'Qop ip 80 talik', 3360.00, 'dona', 42, 80, 140, 470.40, 'TM-000082', 'MAPPED', NULL),
  ('C-17', 86, 1, 'Qop ip 50 gramm Qora', 12000.00, 'dona', 60, 200, 50, 600.00, 'TM-000083', 'MAPPED', NULL),
  ('C-17', 87, 2, 'Qop ip 50 gramm Sariq', 12800.00, 'dona', 64, 200, 50, 640.00, 'TM-000084', 'MAPPED', NULL),
  ('C-17', 88, 3, 'Qop ip 50 gramm Oq', 7600.00, 'dona', 38, 200, 50, 380.00, 'TM-000085', 'MAPPED', NULL),
  ('C-17', 89, 4, 'Qop ip 30 gramm Qora', 4800.00, 'dona', 12, 400, 30, 144.00, 'TM-000086', 'MAPPED', NULL),
  ('C-17', 90, 5, 'Qop ip 30 gramm Sariq', 10400.00, 'dona', 26, 400, 30, 312.00, 'TM-000087', 'MAPPED', NULL),
  ('C-17', 91, 6, 'Qop ip 30 gramm Oq', 8400.00, 'dona', 21, 400, 30, 252.00, 'TM-000088', 'MAPPED', NULL),
  ('C-17', 92, 7, 'Qop ip 100 gramm Qora', 2080.00, 'dona', 13, 160, 100, 208.00, 'TM-000089', 'MAPPED', NULL),
  ('C-17', 93, 8, 'Qop ip 100 gramm Sariq', 2880.00, 'dona', 18, 160, 100, 288.00, 'TM-000090', 'MAPPED', NULL),
  ('C-17', 94, 9, 'Qop ip 100 gramm Oq', 4320.00, 'dona', 27, 160, 100, 432.00, 'TM-000091', 'MAPPED', NULL),
  ('C-15', 95, 1, 'Polipropilen CF 1000D Qizil', 3720.00, 'kg', NULL, NULL, NULL, 3720.00, 'TM-000092', 'MAPPED', NULL),
  ('C-15', 96, 2, 'Polipropilen CF 1000D Ko''k', 3840.00, 'kg', NULL, NULL, NULL, 3840.00, 'TM-000093', 'MAPPED', NULL),
  ('C-15', 97, 3, 'Polipropilen CF 1000D Sariq', 5460.00, 'kg', NULL, NULL, NULL, 5460.00, 'TM-000094', 'MAPPED', NULL)
) AS v(container_label, position_no, container_pos, name, quantity, unit, boxes, per_box, unit_weight_g, weight_kg, item_sku, mapping_status, note);

-- ── 4. TEKSHIRUV (9.1–9.10) — birorta mismatch = EXCEPTION = ROLLBACK ────────
DO $ver$
DECLARE v bigint; v2 bigint; v3 bigint;
BEGIN
  -- 9.1 baselines: 9 satr, barcha maydonlar qoziqlarga mos
  SELECT COUNT(*) INTO v FROM physical_baselines;
  IF v <> 9 THEN RAISE EXCEPTION '9.1: baselines=% (9 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v FROM physical_baselines b
   JOIN (VALUES
     ('C-20',26,'2026-08-15'::date,10,10136.45::numeric), ('C-19',25,'2026-08-15',13,8713.30),
     ('C-18',24,'2026-08-15',29,9839.45), ('C-02',8,'2026-08-15',10,6053.00),
     ('C-04',10,'2026-08-15',7,6363.30), ('C-06',12,'2026-08-15',13,7435.50),
     ('C-16',22,'2026-08-15',3,7045.20), ('C-17',23,'2026-08-15',9,3256.00),
     ('C-15',21,'2026-08-16',3,13020.00)
   ) e(label, wid, cdate, pcount, kg)
     ON b.container_label = e.label AND b.warehouse_id = e.wid AND b.count_date = e.cdate
    AND b.positions_count = e.pcount AND b.total_weight_kg = e.kg
    AND b.status = 'MAPPED' AND b.counted_by = 'thisismurodov' AND b.created_by = 'thisismurodov';
  IF v <> 9 THEN RAISE EXCEPTION '9.1: % baseline satri qoziqlarga mos (9 kutilgan)', v; END IF;
  -- baselines ichki izchillik: positions_count va total_weight_kg = haqiqiy agregat
  SELECT COUNT(*) INTO v FROM physical_baselines b
   WHERE b.positions_count <> (SELECT COUNT(*) FROM physical_baseline_positions p WHERE p.baseline_id = b.id)
      OR b.total_weight_kg <> (SELECT COALESCE(SUM(p.weight_kg),0) FROM physical_baseline_positions p WHERE p.baseline_id = b.id);
  IF v <> 0 THEN RAISE EXCEPTION '9.1: % baselineda agregat mos emas', v; END IF;

  -- 9.2 pozitsiyalar: 97, position_no zich 1..97
  SELECT COUNT(*) INTO v FROM physical_baseline_positions;
  IF v <> 97 THEN RAISE EXCEPTION '9.2: positions=% (97 kutilgan)', v; END IF;
  SELECT COUNT(DISTINCT position_no), MIN(position_no), MAX(position_no) INTO v, v2, v3 FROM physical_baseline_positions;
  IF v <> 97 OR v2 <> 1 OR v3 <> 97 THEN RAISE EXCEPTION '9.2: position_no zich emas (%..%, distinct %)', v2, v3, v; END IF;

  -- 9.3 massa yig'indilari (sentgacha aynan)
  IF (SELECT SUM(weight_kg) FROM physical_baseline_positions) <> 71862.20 THEN
    RAISE EXCEPTION '9.3: jami kg % (71862.20 kutilgan)', (SELECT SUM(weight_kg) FROM physical_baseline_positions);
  END IF;
  IF (SELECT SUM(weight_kg) FROM physical_baseline_positions WHERE unit='kg' AND item_id IS NOT NULL) <> 60353.45 THEN
    RAISE EXCEPTION '9.3: mapped kg-massa noto''g''ri';
  END IF;
  IF (SELECT SUM(weight_kg) FROM physical_baseline_positions WHERE unit='dona') <> 10301.20 THEN
    RAISE EXCEPTION '9.3: dona kg-ekvivalent noto''g''ri';
  END IF;
  IF (SELECT SUM(weight_kg) FROM physical_baseline_positions WHERE item_id IS NULL) <> 1207.55 THEN
    RAISE EXCEPTION '9.3: EXACT chetdagi massa noto''g''ri';
  END IF;
  IF (SELECT SUM(quantity) FROM physical_baseline_positions WHERE unit='dona') <> 126360 THEN
    RAISE EXCEPTION '9.3: dona jami noto''g''ri';
  END IF;

  -- 9.4 mapping tarkibi: 95 MAPPED + 2 EXCLUDED (aynan qaysi satrlar ekani pin)
  SELECT COUNT(*) INTO v FROM physical_baseline_positions WHERE item_id IS NOT NULL AND mapping_status='MAPPED';
  IF v <> 95 THEN RAISE EXCEPTION '9.4: mapped=% (95 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v FROM physical_baseline_positions WHERE item_id IS NULL;
  IF v <> 2 THEN RAISE EXCEPTION '9.4: item_id IS NULL % satr (2 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v FROM physical_baseline_positions p JOIN physical_baselines b ON b.id=p.baseline_id
   WHERE p.item_id IS NULL AND p.mapping_status='EXCLUDED_EXACT_CANDIDATE'
     AND ((b.container_label='C-18' AND p.name='Rossiya Tros' AND p.weight_kg=531)
       OR (b.container_label='C-02' AND p.name='Shroki 3.5 Oq' AND p.weight_kg=676.55));
  IF v <> 2 THEN RAISE EXCEPTION '9.4: EXACT kandidat satrlari qoziqqa mos emas (%)', v; END IF;

  -- 9.5 bijeksiya: 94 SKU; faqat TM-000022 ikki satrda (C-19 168.6 + C-04 261.2)
  SELECT COUNT(DISTINCT item_id) INTO v FROM physical_baseline_positions WHERE item_id IS NOT NULL;
  IF v <> 94 THEN RAISE EXCEPTION '9.5: DISTINCT item_id=% (94 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v FROM (
    SELECT item_id FROM physical_baseline_positions WHERE item_id IS NOT NULL GROUP BY item_id HAVING COUNT(*) <> 1
  ) x;
  IF v <> 1 THEN RAISE EXCEPTION '9.5: ko''p-satrli itemlar % (faqat 1 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v FROM physical_baseline_positions p
   JOIN items i ON i.id = p.item_id JOIN physical_baselines b ON b.id = p.baseline_id
   WHERE i.sku='TM-000022'
     AND ((b.container_label='C-19' AND p.weight_kg=168.6) OR (b.container_label='C-04' AND p.weight_kg=261.2));
  IF v <> 2 THEN RAISE EXCEPTION '9.5: TM-000022 ikki lokatsiya qoziqqa mos emas (%)', v; END IF;

  -- 9.6 nom/birlik bayt-aynan items bilan (mapped satrlar)
  SELECT COUNT(*) INTO v FROM physical_baseline_positions p JOIN items i ON i.id = p.item_id
   WHERE i.display_name IS DISTINCT FROM p.name OR i.unit IS DISTINCT FROM p.unit;
  IF v <> 0 THEN RAISE EXCEPTION '9.6: % satrda nom/birlik items bilan mos emas', v; END IF;

  -- 9.7 TO'LIQ maydonma-maydon muvofiqlik muhrlangan kutilma bilan (FULL JOIN)
  SELECT COUNT(*) INTO v FROM rb_expected;
  IF v <> 97 THEN RAISE EXCEPTION '9.7: rb_expected=% (97 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v
    FROM rb_expected e
    FULL JOIN (
      SELECT p.*, b.container_label AS bl_label, i.sku AS item_sku
        FROM physical_baseline_positions p
        JOIN physical_baselines b ON b.id = p.baseline_id
        LEFT JOIN items i ON i.id = p.item_id
    ) a ON a.position_no = e.position_no
   WHERE a.position_no IS NULL OR e.position_no IS NULL
      OR a.bl_label IS DISTINCT FROM e.container_label
      OR a.container_pos IS DISTINCT FROM e.container_pos
      OR a.name IS DISTINCT FROM e.name
      OR a.quantity IS DISTINCT FROM e.quantity
      OR a.unit IS DISTINCT FROM e.unit
      OR a.boxes IS DISTINCT FROM e.boxes
      OR a.per_box IS DISTINCT FROM e.per_box
      OR a.unit_weight_g IS DISTINCT FROM e.unit_weight_g
      OR a.weight_kg IS DISTINCT FROM e.weight_kg
      OR a.item_sku IS DISTINCT FROM e.item_sku
      OR a.mapping_status IS DISTINCT FROM e.mapping_status
      OR a.note IS DISTINCT FROM e.note
      OR a.created_by IS DISTINCT FROM 'thisismurodov';
  IF v <> 0 THEN RAISE EXCEPTION '9.7: % satr muhrlangan kutilmaga mos emas', v; END IF;

  -- 9.8 dona arifmetikasi (CHECK'lardan mustaqil qayta isbot)
  SELECT COUNT(*) INTO v FROM physical_baseline_positions
   WHERE unit='dona' AND (boxes * per_box <> quantity OR quantity * unit_weight_g <> weight_kg * 1000);
  IF v <> 0 THEN RAISE EXCEPTION '9.8: % dona-satrda arifmetika buzilgan', v; END IF;
  SELECT COUNT(*) INTO v FROM physical_baseline_positions WHERE unit='kg' AND quantity <> weight_kg;
  IF v <> 0 THEN RAISE EXCEPTION '9.8: % kg-satrda quantity≠weight_kg', v; END IF;

  -- 9.9 boshqa hech narsa o'zgarmadi (son + yig'indi, tranzaksiya-ichki)
  IF (SELECT sales_n FROM rb_pre) <> (SELECT COUNT(*) FROM sales) THEN RAISE EXCEPTION '9.9: sales o''zgardi'; END IF;
  IF (SELECT sale_items_n FROM rb_pre) <> (SELECT COUNT(*) FROM sale_items) THEN RAISE EXCEPTION '9.9: sale_items o''zgardi'; END IF;
  IF (SELECT sale_items_qty FROM rb_pre) <> (SELECT COALESCE(SUM(quantity),0) FROM sale_items) THEN RAISE EXCEPTION '9.9: sale_items.quantity o''zgardi'; END IF;
  IF (SELECT sm_n FROM rb_pre) <> (SELECT COUNT(*) FROM stock_movements) THEN RAISE EXCEPTION '9.9: stock_movements o''zgardi'; END IF;
  IF (SELECT sm_qty FROM rb_pre) <> (SELECT COALESCE(SUM(quantity),0) FROM stock_movements) THEN RAISE EXCEPTION '9.9: stock_movements.quantity o''zgardi'; END IF;
  IF (SELECT inv_n FROM rb_pre) <> (SELECT COUNT(*) FROM inventory) THEN RAISE EXCEPTION '9.9: inventory soni o''zgardi'; END IF;
  IF (SELECT inv_qty FROM rb_pre) <> (SELECT COALESCE(SUM(quantity),0) FROM inventory) THEN RAISE EXCEPTION '9.9: inventory.quantity o''zgardi'; END IF;
  IF (SELECT inv_kg FROM rb_pre) <> (SELECT COALESCE(SUM(weight_kg),0) FROM inventory) THEN RAISE EXCEPTION '9.9: inventory.weight_kg o''zgardi'; END IF;
  IF (SELECT products_n FROM rb_pre) <> (SELECT COUNT(*) FROM products) THEN RAISE EXCEPTION '9.9: products o''zgardi'; END IF;
  IF (SELECT rm_n FROM rb_pre) <> (SELECT COUNT(*) FROM raw_materials) THEN RAISE EXCEPTION '9.9: raw_materials o''zgardi'; END IF;
  IF (SELECT rm_stock FROM rb_pre) <> (SELECT COALESCE(SUM(current_stock),0) FROM raw_materials) THEN RAISE EXCEPTION '9.9: raw_materials.current_stock o''zgardi'; END IF;
  IF (SELECT batches_n FROM rb_pre) <> (SELECT COUNT(*) FROM batches) THEN RAISE EXCEPTION '9.9: batches o''zgardi'; END IF;
  IF (SELECT wip_n FROM rb_pre) <> (SELECT COUNT(*) FROM wip_movements) THEN RAISE EXCEPTION '9.9: wip_movements o''zgardi'; END IF;
  IF (SELECT items_n FROM rb_pre) <> (SELECT COUNT(*) FROM items) OR (SELECT COUNT(*) FROM items) <> 94 THEN RAISE EXCEPTION '9.9: items o''zgardi'; END IF;
  IF (SELECT aliases_n FROM rb_pre) <> (SELECT COUNT(*) FROM item_aliases) OR (SELECT COUNT(*) FROM item_aliases) <> 0 THEN RAISE EXCEPTION '9.9: item_aliases o''zgardi'; END IF;
  IF (SELECT lg_inv_n FROM rb_pre) <> (SELECT COUNT(*) FROM legacy.inventory_baseline_pre) THEN RAISE EXCEPTION '9.9: legacy.inventory_baseline_pre o''zgardi'; END IF;
  IF (SELECT lg_rm_n FROM rb_pre) <> (SELECT COUNT(*) FROM legacy.raw_material_stock_pre) THEN RAISE EXCEPTION '9.9: legacy.raw_material_stock_pre o''zgardi'; END IF;
  IF (SELECT lg_wip_n FROM rb_pre) <> (SELECT COUNT(*) FROM legacy.wip_balances_pre) THEN RAISE EXCEPTION '9.9: legacy.wip_balances_pre o''zgardi'; END IF;
  IF (SELECT lg_cont_n FROM rb_pre) <> (SELECT COUNT(*) FROM legacy.container_summary_pre) THEN RAISE EXCEPTION '9.9: legacy.container_summary_pre o''zgardi'; END IF;
  -- R-D BOSHLANMAGANI: BASELINE harakatlar avval ham, hozir ham 0
  IF (SELECT sm_baseline_n FROM rb_pre) <> 0
     OR (SELECT COUNT(*) FROM stock_movements WHERE movement_type='BASELINE') <> 0 THEN
    RAISE EXCEPTION '9.9: BASELINE harakat topildi — R-D chegarasi buzilgan';
  END IF;

  -- 9.10 counted_by/created_by (egasi tasdig'i)
  SELECT COUNT(*) INTO v FROM physical_baselines WHERE counted_by <> 'thisismurodov' OR created_by <> 'thisismurodov';
  IF v <> 0 THEN RAISE EXCEPTION '9.10: baselines counted_by/created_by xato (%)', v; END IF;
  SELECT COUNT(*) INTO v FROM physical_baseline_positions WHERE created_by <> 'thisismurodov';
  IF v <> 0 THEN RAISE EXCEPTION '9.10: positions created_by xato (%)', v; END IF;

  RAISE NOTICE 'R-B TEKSHIRUV: 9.1–9.10 BARCHASI PASS';
END $ver$;

COMMIT;

-- ── 5. COMMIT'dan keyingi hisobot (faqat o'qish) ─────────────────────────────
SELECT b.container_label, b.warehouse_id, b.count_date, b.positions_count, b.total_weight_kg, b.status, b.counted_by
  FROM physical_baselines b ORDER BY b.id;
SELECT COUNT(*) AS positions,
       COUNT(*) FILTER (WHERE item_id IS NOT NULL) AS mapped,
       COUNT(*) FILTER (WHERE item_id IS NULL) AS excluded_exact,
       COUNT(DISTINCT item_id) AS distinct_items,
       SUM(weight_kg) AS total_kg,
       SUM(quantity) FILTER (WHERE unit='dona') AS total_dona
  FROM physical_baseline_positions;
SELECT p.position_no, b.container_label, p.name, p.quantity, p.unit, p.weight_kg,
       COALESCE(i.sku,'—') AS sku, p.mapping_status
  FROM physical_baseline_positions p
  JOIN physical_baselines b ON b.id=p.baseline_id
  LEFT JOIN items i ON i.id=p.item_id
 WHERE p.position_no IN (1, 22, 40, 61, 69, 83, 97)
 ORDER BY p.position_no;
