-- =============================================================================
-- R-C IJRO SKRIPTI (2026-08-17) — «R-C GO» egasi ruxsati bilan, BIR MARTA.
-- Manba: docs/r-c-final-preview-2026-08-17.md (§4 jadval, §6 DDL, §8 tekshiruv)
-- Generator: scripts/src/r-c-generate-sql.ts (qo'lda tahrir QILINMASIN)
-- Ijro: psql "$RAILWAY_DATABASE_URL" -v ON_ERROR_STOP=1 -f <shu fayl>
-- Birorta tekshiruv yiqilsa — butun tranzaksiya ROLLBACK, bazada iz qolmaydi.
--
-- SEQUENCE QOLDIG'I (ROLLBACK bo'lsa): items_id_seq nextval() tranzaksiyaviy
-- EMAS — abort bo'lsa satrlar/DDL qaytadi, lekin sequence oldinga siljigan
-- bo'ladi va keyingi urinish PRE-GATE'da to'xtaydi (bu ATAYIN: ko'r qayta
-- ijro bloklanadi). Tiklash (FAQAT egasiga hisobot + ruxsatdan keyin,
-- items=0 ekanini tekshirib): SELECT setval('items_id_seq', 1, true);
-- =============================================================================
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
-- R-C yozadigan YAGONA ikki jadvalni to'liq qulflaymiz: tranzaksiya davomida
-- boshqa hech kim items/item_aliases'ga yoza olmaydi (95-item poygasi yopiq).
-- Jonli biznes jadvallari (sales, stock_movements, ...) ATAYIN qulflanmaydi:
-- zavod ishlashda davom etadi; 8.6 invarianti "R-C o'zi hech narsani
-- o'zgartirmadi"ni isbotlaydi (RR snapshot ichida oldin/keyin tenglik).
LOCK TABLE items IN ACCESS EXCLUSIVE MODE;
LOCK TABLE item_aliases IN ACCESS EXCLUSIVE MODE;

-- ── 0. PRE-GATE: §8.6 hujjat qoziqlari + toza boshlanish holati ─────────────
DO $pre$
DECLARE v bigint; cdef text;
BEGIN
  SELECT COUNT(*) INTO v FROM items;
  IF v <> 0 THEN RAISE EXCEPTION 'PRE-GATE: items=% (0 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v FROM item_aliases;
  IF v <> 0 THEN RAISE EXCEPTION 'PRE-GATE: item_aliases=% (0 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v FROM sales;
  IF v <> 45 THEN RAISE EXCEPTION 'PRE-GATE: sales=% (45 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v FROM sale_items;
  IF v <> 143 THEN RAISE EXCEPTION 'PRE-GATE: sale_items=% (143 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v FROM stock_movements;
  IF v <> 620 THEN RAISE EXCEPTION 'PRE-GATE: stock_movements=% (620 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v FROM inventory;
  IF v <> 43 THEN RAISE EXCEPTION 'PRE-GATE: inventory=% (43 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v FROM products;
  IF v <> 117 THEN RAISE EXCEPTION 'PRE-GATE: products=% (117 kutilgan)', v; END IF;
  -- items id ketma-ketligi: birinchi real item id=2 olishi kerak
  SELECT last_value INTO v FROM items_id_seq;
  IF v <> 1 THEN RAISE EXCEPTION 'PRE-GATE: items_id_seq last_value=% (1 kutilgan). Avvalgi ROLLBACK qoldig''i bo''lishi mumkin — fayl sarlavhasidagi tiklanish yo''lini o''qing (faqat egasi ruxsati bilan)', v; END IF;
  IF NOT (SELECT is_called FROM items_id_seq) THEN
    RAISE EXCEPTION 'PRE-GATE: items_id_seq.is_called=false (true kutilgan — P2.1 smoke-testi id=1 ni sarflagan bo''lishi kerak)';
  END IF;
  -- eski CHECK AYNAN kutilgan shaklda bo'lishi shart (destruktiv DROP oldidan)
  SELECT pg_get_constraintdef(oid) INTO cdef FROM pg_constraint
   WHERE conrelid='public.stock_movements'::regclass
     AND conname='stock_movements_movement_type_check';
  IF cdef IS NULL THEN RAISE EXCEPTION 'PRE-GATE: movement_type CHECK topilmadi'; END IF;
  IF cdef <> 'CHECK ((movement_type = ANY (ARRAY[''IN''::text, ''OUT''::text, ''TRANSFER''::text])))' THEN
    RAISE EXCEPTION 'PRE-GATE: CHECK kutilgan eski shaklda emas: %', cdef;
  END IF;
  -- yangi ustunlar hali bo'lmasligi kerak
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='stock_movements'
                AND column_name IN ('weight_kg','reference','reason')) THEN
    RAISE EXCEPTION 'PRE-GATE: weight_kg/reference/reason allaqachon mavjud — takroriy ijro?';
  END IF;
END $pre$;

-- tranzaksiya-ichki snapshot (§8.6 «oldin»)
CREATE TEMP TABLE rc_pre ON COMMIT DROP AS SELECT
  (SELECT COUNT(*) FROM sales)           AS sales,
  (SELECT COUNT(*) FROM sale_items)      AS sale_items,
  (SELECT COUNT(*) FROM stock_movements) AS stock_movements,
  (SELECT COUNT(*) FROM inventory)       AS inventory,
  (SELECT COUNT(*) FROM products)        AS products,
  (SELECT COUNT(*) FROM raw_materials)   AS raw_materials,
  (SELECT COUNT(*) FROM batches)         AS batches,
  (SELECT COUNT(*) FROM wip_movements)   AS wip_movements;

-- ── 1. DDL (§6): BASELINE + 3 ustun ─────────────────────────────────────────
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
  CHECK (movement_type IN ('IN', 'OUT', 'TRANSFER', 'BASELINE'));
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS weight_kg numeric;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS reference text;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS reason    text;

-- ── 2. 94 NEYTRAL INSERT (§4) — bayroqlar atayin yozilmaydi (DB defaultlari) ─
INSERT INTO items (sku, display_name, unit, source_kind, note, created_by) VALUES
  ('TM-000001', 'Neylon 210D / 45', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-20 · 80 kg', 'thisismurodov'),
  ('TM-000002', 'Neylon 210D / 60', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-20 · 1 474 kg', 'thisismurodov'),
  ('TM-000003', 'Neylon 210D / 90', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-20 · 330 kg', 'thisismurodov'),
  ('TM-000004', 'Toshkent Oq 14 mm — Bir qavat', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-20 · 942.05 kg', 'thisismurodov'),
  ('TM-000005', 'FDY Igna Strupa', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-20 · 4 572.25 kg', 'thisismurodov'),
  ('TM-000006', 'Toshkent Qora 14 mm Ichki Sariq', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-20 · 636.25 kg', 'thisismurodov'),
  ('TM-000007', '16 mm Alpinist', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-20 · 520 kg', 'thisismurodov'),
  ('TM-000008', '14 mm Alpinist', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-20 · 930 kg', 'thisismurodov'),
  ('TM-000009', 'Toshkent Qora 14 mm Ichi Oq PP TWS', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-20 · 309.6 kg', 'thisismurodov'),
  ('TM-000010', 'Toshkent Oq 16 mm Ichi Oq PP TWS — 50 metr', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-20 · 342.3 kg', 'thisismurodov'),
  ('TM-000011', 'Polyamide 144 oq TWS', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-19 · 552.9 kg', 'thisismurodov'),
  ('TM-000012', 'Polyamide Ko‘k 187 TWS', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-19 · 94.05 kg', 'thisismurodov'),
  ('TM-000013', 'Polyamide Qizil 187 TWS', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-19 · 73.65 kg', 'thisismurodov'),
  ('TM-000014', 'Polyamide Sariq 187 TWS', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-19 · 44.6 kg', 'thisismurodov'),
  ('TM-000015', 'Polyamide Oq 187 TWS', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-19 · 132.15 kg', 'thisismurodov'),
  ('TM-000016', 'Qop ip Yashil', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-19 · 2 244.1 kg', 'thisismurodov'),
  ('TM-000017', 'Qop ip Qizil', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-19 · 728.55 kg', 'thisismurodov'),
  ('TM-000018', 'Passport Xom BCF', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-19 · 646 kg', 'thisismurodov'),
  ('TM-000019', 'Yashil PP TWS Strupa 24 talik', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-19 · 643.4 kg', 'thisismurodov'),
  ('TM-000020', 'Passport Strupa 16 talik', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-19 · 527.65 kg', 'thisismurodov'),
  ('TM-000021', 'Passport Strupa 24 talik', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-19 · 273.75 kg', 'thisismurodov'),
  ('TM-000022', 'Yashil PP TWS Strupa 16 talik', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-19 168.6 kg + C-04 261.2 kg = 429.8 kg', 'thisismurodov'),
  ('TM-000023', 'Sariq Polyester Strupa 16 talik', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-19 · 2 583.9 kg', 'thisismurodov'),
  ('TM-000024', 'Toshkent Arqon 16 mm Ko‘k', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 221.6 kg', 'thisismurodov'),
  ('TM-000025', 'Toshkent Arqon 16 mm Qora', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 332.95 kg', 'thisismurodov'),
  ('TM-000026', 'Ustki Gilam Ichki Sariq Polyamide', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 317.25 kg', 'thisismurodov'),
  ('TM-000027', 'Toshkent Arqon 10 mm Yashil', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 171.9 kg', 'thisismurodov'),
  ('TM-000028', 'Toshkent Arqon 14 mm Qizil', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 451.7 kg', 'thisismurodov'),
  ('TM-000029', 'Toshkent Arqon 12 mm Qora Ichki Polyamide Sariq', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 866.25 kg', 'thisismurodov'),
  ('TM-000030', 'Toshkent Arqon 12 mm Qizil', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 61.65 kg', 'thisismurodov'),
  ('TM-000031', 'Toshkent Arqon 14 mm Qora', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 150 kg', 'thisismurodov'),
  ('TM-000032', 'Toshkent Arqon 10 mm Ko‘k', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 150.25 kg', 'thisismurodov'),
  ('TM-000033', 'FDY Fil Arqon', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 497.55 kg', 'thisismurodov'),
  ('TM-000034', 'Toshkent Arqon 16 mm Oq — 50 metr', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 63.2 kg', 'thisismurodov'),
  ('TM-000035', 'Toshkent Arqon 14 mm Oq — 100 metr', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 40.05 kg', 'thisismurodov'),
  ('TM-000036', 'Toshkent Arqon 16 mm Oq', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 61.9 kg', 'thisismurodov'),
  ('TM-000037', 'Toshkent Arqon Qora 16 mm Ichki Polyamide Sariq', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 717.35 kg', 'thisismurodov'),
  ('TM-000038', 'Toshkent Arqon 12 mm Sariq', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 389.95 kg', 'thisismurodov'),
  ('TM-000039', 'FDY Tros Aralash', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 386.75 kg', 'thisismurodov'),
  ('TM-000040', 'Usti gilam ichki Sariq Polyamide Arqon', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 370.5 kg', 'thisismurodov'),
  ('TM-000041', 'Ustki Oq TWS ichki Polyamide Oq Arqon', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 1 264.1 kg', 'thisismurodov'),
  ('TM-000042', 'Ustki PP xom ichki Polyamide Oq Arqon', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 105 kg', 'thisismurodov'),
  ('TM-000043', 'Ustki 187 TWS Oq ichki Zubr 16 mm Arqon', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 926.4 kg', 'thisismurodov'),
  ('TM-000044', 'Ustki 187 TWS Oq ichki Strupa 14 mm Arqon', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 520 kg', 'thisismurodov'),
  ('TM-000045', 'Kanob Aralash 20 metr', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 113.55 kg', 'thisismurodov'),
  ('TM-000046', 'Alpinist 12 mm', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 450.6 kg', 'thisismurodov'),
  ('TM-000047', 'Alpinist 10 mm', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 106.2 kg', 'thisismurodov'),
  ('TM-000048', 'Alpinist 14 mm', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 165.55 kg', 'thisismurodov'),
  ('TM-000049', 'Alpinist 16 mm', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 199.3 kg', 'thisismurodov'),
  ('TM-000050', 'Alpinist 20 mm', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 174.5 kg', 'thisismurodov'),
  ('TM-000051', 'Alpinist 25 mm', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-18 · 32.45 kg', 'thisismurodov'),
  ('TM-000052', 'Shroki 3.5 sm lenta', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-02 · 468.35 kg', 'thisismurodov'),
  ('TM-000053', 'Rangli 2.5 sm ikki qavat lenta', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-02 · 863.45 kg', 'thisismurodov'),
  ('TM-000054', 'Reels Lenta', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-02 · 1 352.85 kg', 'thisismurodov'),
  ('TM-000055', 'Tulpor Lenta Aralash', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-02 · 556.4 kg', 'thisismurodov'),
  ('TM-000056', 'Tulpor Lenta Yashil', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-02 · 1 019.35 kg', 'thisismurodov'),
  ('TM-000057', 'Tulpor Lenta Oq', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-02 · 439.2 kg', 'thisismurodov'),
  ('TM-000058', 'Tulpor Lenta Ko‘k', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-02 · 192.05 kg', 'thisismurodov'),
  ('TM-000059', 'Tulpor lenta qizil', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-02 · 287 kg', 'thisismurodov'),
  ('TM-000060', 'Tahoe Lenta', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-02 · 197.8 kg', 'thisismurodov'),
  ('TM-000061', 'Polipropilen CF 1500D Qora', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-04 · 3 250 kg', 'thisismurodov'),
  ('TM-000062', 'Polipropilen CF 1000D Yashil', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-04 · 1 020 kg', 'thisismurodov'),
  ('TM-000063', 'Strupa Salafan', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-04 · 375.8 kg', 'thisismurodov'),
  ('TM-000064', 'XB Strupa', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-04 · 349.9 kg', 'thisismurodov'),
  ('TM-000065', 'PP Oq TWS Strupa 12 talik', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-04 · 875.55 kg', 'thisismurodov'),
  ('TM-000066', 'Eshma Xitoy Strupa PP Oq TWS', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-04 · 230.85 kg', 'thisismurodov'),
  ('TM-000067', 'Shlanka Polyamide Yumshoq', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-06 · 86.3 kg', 'thisismurodov'),
  ('TM-000068', 'Shlanka Tortqi PP Oq TWS — 50 metr', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-06 · 236.25 kg', 'thisismurodov'),
  ('TM-000069', 'Shlanka Tortqi PP Yashil TWS — 50 metr', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-06 · 66.35 kg', 'thisismurodov'),
  ('TM-000070', 'Shlanka Polipropilen CF Qora', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-06 · 618.8 kg', 'thisismurodov'),
  ('TM-000071', 'Shlanka Polipropilen CF Yashil', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-06 · 710.45 kg', 'thisismurodov'),
  ('TM-000072', 'Shlanka Polipropilen CF Ko‘k', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-06 · 506.25 kg', 'thisismurodov'),
  ('TM-000073', 'Shlanka Polipropilen CF Qizil', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-06 · 581.4 kg', 'thisismurodov'),
  ('TM-000074', 'Shlanka Polipropilen CF Oq', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-06 · 874.95 kg', 'thisismurodov'),
  ('TM-000075', 'Shlanka Polyester FDY Qora', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-06 · 433.2 kg', 'thisismurodov'),
  ('TM-000076', 'Shlanka Polyester FDY Yashil', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-06 · 830.4 kg', 'thisismurodov'),
  ('TM-000077', 'Shlanka Polyester FDY Ko‘k', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-06 · 778.15 kg', 'thisismurodov'),
  ('TM-000078', 'Shlanka Polyester FDY Qizil', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-06 · 730.95 kg', 'thisismurodov'),
  ('TM-000079', 'Shlanka Polyester FDY Oq', 'kg', 'physical_count', 'Sanoq 2026-08-15 · C-06 · 982.05 kg', 'thisismurodov'),
  ('TM-000080', 'Qop ip 100 talik', 'dona', 'physical_count', 'Sanoq 2026-08-15 · C-16 · 55 200 dona (6 348.00 kg)', 'thisismurodov'),
  ('TM-000081', 'Qop ip 120 talik', 'dona', 'physical_count', 'Sanoq 2026-08-15 · C-16 · 2 520 dona (226.80 kg)', 'thisismurodov'),
  ('TM-000082', 'Qop ip 80 talik', 'dona', 'physical_count', 'Sanoq 2026-08-15 · C-16 · 3 360 dona (470.40 kg)', 'thisismurodov'),
  ('TM-000083', 'Qop ip 50 gramm Qora', 'dona', 'physical_count', 'Sanoq 2026-08-15 · C-17 · 12 000 dona (600.00 kg)', 'thisismurodov'),
  ('TM-000084', 'Qop ip 50 gramm Sariq', 'dona', 'physical_count', 'Sanoq 2026-08-15 · C-17 · 12 800 dona (640.00 kg)', 'thisismurodov'),
  ('TM-000085', 'Qop ip 50 gramm Oq', 'dona', 'physical_count', 'Sanoq 2026-08-15 · C-17 · 7 600 dona (380.00 kg)', 'thisismurodov'),
  ('TM-000086', 'Qop ip 30 gramm Qora', 'dona', 'physical_count', 'Sanoq 2026-08-15 · C-17 · 4 800 dona (144.00 kg)', 'thisismurodov'),
  ('TM-000087', 'Qop ip 30 gramm Sariq', 'dona', 'physical_count', 'Sanoq 2026-08-15 · C-17 · 10 400 dona (312.00 kg)', 'thisismurodov'),
  ('TM-000088', 'Qop ip 30 gramm Oq', 'dona', 'physical_count', 'Sanoq 2026-08-15 · C-17 · 8 400 dona (252.00 kg)', 'thisismurodov'),
  ('TM-000089', 'Qop ip 100 gramm Qora', 'dona', 'physical_count', 'Sanoq 2026-08-15 · C-17 · 2 080 dona (208.00 kg)', 'thisismurodov'),
  ('TM-000090', 'Qop ip 100 gramm Sariq', 'dona', 'physical_count', 'Sanoq 2026-08-15 · C-17 · 2 880 dona (288.00 kg)', 'thisismurodov'),
  ('TM-000091', 'Qop ip 100 gramm Oq', 'dona', 'physical_count', 'Sanoq 2026-08-15 · C-17 · 4 320 dona (432.00 kg)', 'thisismurodov'),
  ('TM-000092', 'Polipropilen CF 1000D Qizil', 'kg', 'physical_count', 'Sanoq 2026-08-16 · C-15 · 3 720.00 kg', 'thisismurodov'),
  ('TM-000093', 'Polipropilen CF 1000D Ko''k', 'kg', 'physical_count', 'Sanoq 2026-08-16 · C-15 · 3 840.00 kg', 'thisismurodov'),
  ('TM-000094', 'Polipropilen CF 1000D Sariq', 'kg', 'physical_count', 'Sanoq 2026-08-16 · C-15 · 5 460.00 kg', 'thisismurodov');

-- ── 2b. Muhrlangan kutilma jadvali (94 qator TO'LIQ maydonma-maydon tekshiriladi)
CREATE TEMP TABLE rc_expected (
  sku text PRIMARY KEY, display_name text NOT NULL, unit text NOT NULL, note text NOT NULL
) ON COMMIT DROP;
INSERT INTO rc_expected (sku, display_name, unit, note) VALUES
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

-- ── 3. TEKSHIRUV (§8.1–8.8) — birorta mismatch = EXCEPTION = ROLLBACK ───────
DO $ver$
DECLARE v bigint; v2 bigint; t text; cdef text;
BEGIN
  -- 8.1 son, SKU chegaralari, id chegaralari
  SELECT COUNT(*) INTO v FROM items;
  IF v <> 94 THEN RAISE EXCEPTION '8.1: items=% (94 kutilgan)', v; END IF;
  SELECT MIN(sku) INTO t FROM items;
  IF t <> 'TM-000001' THEN RAISE EXCEPTION '8.1: MIN(sku)=%', t; END IF;
  SELECT MAX(sku) INTO t FROM items;
  IF t <> 'TM-000094' THEN RAISE EXCEPTION '8.1: MAX(sku)=%', t; END IF;
  SELECT MIN(id) INTO v FROM items;
  IF v <> 2 THEN RAISE EXCEPTION '8.1: MIN(id)=% (2 kutilgan)', v; END IF;
  SELECT MAX(id) INTO v FROM items;
  IF v <> 95 THEN RAISE EXCEPTION '8.1: MAX(id)=% (95 kutilgan)', v; END IF;
  SELECT COUNT(DISTINCT sku) INTO v FROM items;
  IF v <> 94 THEN RAISE EXCEPTION '8.1: DISTINCT sku=%', v; END IF;

  -- 8.2 birlik kesimi
  SELECT COUNT(*) INTO v FROM items WHERE unit='kg';
  IF v <> 82 THEN RAISE EXCEPTION '8.2: kg=% (82 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v FROM items WHERE unit='dona';
  IF v <> 12 THEN RAISE EXCEPTION '8.2: dona=% (12 kutilgan)', v; END IF;

  -- 8.3 neytrallik (№3 qaror) — NULL-xavfsiz predikatlar
  SELECT COUNT(*) INTO v FROM items
   WHERE is_raw IS NOT FALSE OR is_intermediate IS NOT FALSE OR is_finished IS NOT FALSE
      OR is_purchasable IS NOT FALSE OR is_producible IS NOT FALSE OR is_sellable IS NOT FALSE;
  IF v <> 0 THEN RAISE EXCEPTION '8.3: % satrda klassifikatsiya bayrog''i FALSE emas', v; END IF;
  SELECT COUNT(*) INTO v FROM items WHERE inventory_tracked IS NOT TRUE OR active IS NOT TRUE;
  IF v <> 0 THEN RAISE EXCEPTION '8.3: inventory_tracked/active default buzildi (%)', v; END IF;
  SELECT COUNT(*) INTO v FROM items WHERE source_id IS NOT NULL;
  IF v <> 0 THEN RAISE EXCEPTION '8.3: source_id NULL emas (%)', v; END IF;
  SELECT COUNT(*) INTO v FROM items WHERE source_kind <> 'physical_count';
  IF v <> 0 THEN RAISE EXCEPTION '8.3: source_kind xato (%)', v; END IF;

  -- 8.8 created_by (egasi tasdig'i)
  SELECT COUNT(*) INTO v FROM items WHERE created_by <> 'thisismurodov';
  IF v <> 0 THEN RAISE EXCEPTION '8.8: created_by xato (% satr)', v; END IF;

  -- 8.4 item_aliases o'zgarmagan
  SELECT COUNT(*) INTO v FROM item_aliases;
  IF v <> 0 THEN RAISE EXCEPTION '8.4: item_aliases=% (0 kutilgan)', v; END IF;

  -- 8.5 note formati
  SELECT COUNT(*) INTO v FROM items WHERE note NOT LIKE 'Sanoq 2026-08-1%';
  IF v <> 0 THEN RAISE EXCEPTION '8.5: % satrda note format buzildi', v; END IF;
  SELECT note INTO t FROM items WHERE sku='TM-000001';
  IF t <> 'Sanoq 2026-08-15 · C-20 · 80 kg' THEN RAISE EXCEPTION '8.5: TM-000001 note="%"', t; END IF;
  SELECT note INTO t FROM items WHERE sku='TM-000022';
  IF t <> 'Sanoq 2026-08-15 · C-19 168.6 kg + C-04 261.2 kg = 429.8 kg' THEN RAISE EXCEPTION '8.5: TM-000022 note="%"', t; END IF;
  SELECT note INTO t FROM items WHERE sku='TM-000092';
  IF t <> 'Sanoq 2026-08-16 · C-15 · 3 720.00 kg' THEN RAISE EXCEPTION '8.5: TM-000092 note="%"', t; END IF;
  SELECT COUNT(*) INTO v FROM items WHERE unit='dona' AND note NOT LIKE '% dona (%kg)';
  IF v <> 0 THEN RAISE EXCEPTION '8.5: % dona-satrda kg-ekvivalent yo''q', v; END IF;

  -- 8.6 boshqa jadvallar o'zgarmagan (tranzaksiya-ichki oldin/keyin)
  SELECT sales INTO v FROM rc_pre; SELECT COUNT(*) INTO v2 FROM sales;
  IF v <> v2 THEN RAISE EXCEPTION '8.6: sales % -> %', v, v2; END IF;
  SELECT sale_items INTO v FROM rc_pre; SELECT COUNT(*) INTO v2 FROM sale_items;
  IF v <> v2 THEN RAISE EXCEPTION '8.6: sale_items % -> %', v, v2; END IF;
  SELECT stock_movements INTO v FROM rc_pre; SELECT COUNT(*) INTO v2 FROM stock_movements;
  IF v <> v2 THEN RAISE EXCEPTION '8.6: stock_movements % -> %', v, v2; END IF;
  SELECT inventory INTO v FROM rc_pre; SELECT COUNT(*) INTO v2 FROM inventory;
  IF v <> v2 THEN RAISE EXCEPTION '8.6: inventory % -> %', v, v2; END IF;
  SELECT products INTO v FROM rc_pre; SELECT COUNT(*) INTO v2 FROM products;
  IF v <> v2 THEN RAISE EXCEPTION '8.6: products % -> %', v, v2; END IF;
  SELECT raw_materials INTO v FROM rc_pre; SELECT COUNT(*) INTO v2 FROM raw_materials;
  IF v <> v2 THEN RAISE EXCEPTION '8.6: raw_materials % -> %', v, v2; END IF;
  SELECT batches INTO v FROM rc_pre; SELECT COUNT(*) INTO v2 FROM batches;
  IF v <> v2 THEN RAISE EXCEPTION '8.6: batches % -> %', v, v2; END IF;
  SELECT wip_movements INTO v FROM rc_pre; SELECT COUNT(*) INTO v2 FROM wip_movements;
  IF v <> v2 THEN RAISE EXCEPTION '8.6: wip_movements % -> %', v, v2; END IF;
  -- yangi ustunlar mavjud satrlarda to'liq NULL
  SELECT COUNT(*) INTO v FROM stock_movements
   WHERE weight_kg IS NOT NULL OR reference IS NOT NULL OR reason IS NOT NULL;
  IF v <> 0 THEN RAISE EXCEPTION '8.6: % satrda yangi ustun NULL emas', v; END IF;

  -- 8.7 CHECK endi BASELINE'ni o'z ichiga oladi
  SELECT pg_get_constraintdef(oid) INTO cdef FROM pg_constraint
   WHERE conrelid='public.stock_movements'::regclass
     AND conname='stock_movements_movement_type_check';
  IF cdef IS NULL OR cdef NOT LIKE '%BASELINE%' THEN
    RAISE EXCEPTION '8.7: CHECK BASELINE''siz: %', COALESCE(cdef,'YO''Q');
  END IF;

  -- 8.9 TO'LIQ maydonma-maydon muvofiqlik: har 94 satr muhrlangan kutilma
  -- bilan aynan (FULL JOIN — har ikki tomondagi ortiqcha/kam satr ham tutiladi)
  SELECT COUNT(*) INTO v FROM rc_expected;
  IF v <> 94 THEN RAISE EXCEPTION '8.9: rc_expected=% (94 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v
    FROM rc_expected e FULL JOIN items i ON i.sku = e.sku
   WHERE i.sku IS NULL OR e.sku IS NULL
      OR i.display_name IS DISTINCT FROM e.display_name
      OR i.unit IS DISTINCT FROM e.unit
      OR i.note IS DISTINCT FROM e.note
      OR i.source_kind IS DISTINCT FROM 'physical_count'
      OR i.created_by IS DISTINCT FROM 'thisismurodov';
  IF v <> 0 THEN RAISE EXCEPTION '8.9: % satr muhrlangan jadvalga mos emas', v; END IF;

  RAISE NOTICE 'R-C TEKSHIRUV: 8.1–8.8 BARCHASI PASS';
END $ver$;

COMMIT;

-- ── 4. COMMIT'dan keyingi hisobot (faqat o'qish) ─────────────────────────────
SELECT COUNT(*) AS items, MIN(sku) AS min_sku, MAX(sku) AS max_sku,
       MIN(id) AS min_id, MAX(id) AS max_id FROM items;
SELECT unit, COUNT(*) FROM items GROUP BY unit ORDER BY unit;
SELECT pg_get_constraintdef(oid) AS movement_check FROM pg_constraint
 WHERE conname='stock_movements_movement_type_check';
SELECT sku, display_name, unit, note FROM items
 WHERE sku IN ('TM-000001','TM-000022','TM-000080','TM-000092','TM-000094') ORDER BY sku;
