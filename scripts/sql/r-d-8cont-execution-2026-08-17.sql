-- ============================================================================
-- R-D FINAL — QOLGAN 8 KONTEYNER + 2 EXACT + №2 NOLLASH (bitta atomik tranzaksiya)
-- Sana: 2026-08-17 · Asos: FINAL MASTER PROMPT (attached_assets/Pasted--TOPMART-
-- ERP-FINAL-MASTER-PROMPT-...txt) + docs/r-d-dryrun-8-containers-2026-08-17.md
-- Andoza: scripts/sql/r-d-c15-execution-2026-08-17.sql (qulf-avval, isbotlangan)
--
-- QAMROV:
--   4a/5a) 92 MAPPED pozitsiya → BASELINE harakat + inventar (registrdan derivativ)
--          product_type: egasi §21 — raw: TM-000018/61/62 · pre-finished:
--          TM-000005/16/17 · qolgani finished (TM-000022 ikkala lokatsiyada finished)
--   4b/5b) 2 EXACT (egasi §5/§15: finished): «Rossiya Tros» 531.00 → C-18,
--          «Shroki 3.5 Oq» 676.55 → C-02. Mavjud katalog mahsulotiga biriktiriladi
--          (products id=46 ROSSIYATROS, id=108 SHROKI-3-5-OQ), YANGI SKU YARATILMAYDI,
--          item_id=NULL. Rekonsiliatsiya GATE0.14: joriy balans=0, arxiv=0, harakat=0.
--   6)     №2: C-16/C-17'dagi 13 legacy satr auditli NOLLANADI (DELETE YO'Q):
--          jonli=pin=arxiv bayt-solishtiruv → mos bo'lmasa EXCEPTION (to'liq ROLLBACK)
--   7)     physical_baselines id 1..8: MAPPED → LOADED
-- TAQIQLAR: C-15 (id=9, wid=21) daxlsiz; sales/sale_items, legacy arxiv,
--   R-B pozitsiyalari, products katalogi o'zgarmaydi; hech qanday DELETE yo'q.
-- KUTILMA: +94 inventar (46→140), +107 harakat (623→730), BASELINE 3→110,
--   9 joy jami 71,862.20 kg / 126,360 dona (mustaqil qayta hisob bilan).
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

-- ----------------------------------------------------------------------------
-- 0. QULFLAR — BIRINCHI SELECT'DAN OLDIN (C-15 arxitektor saboqi)
-- ----------------------------------------------------------------------------
LOCK TABLE physical_baselines, physical_baseline_positions, items, warehouses,
           inventory, stock_movements, products, sales, sale_items, raw_materials,
           legacy.inventory_baseline_pre
  IN SHARE ROW EXCLUSIVE MODE;
-- Izoh (arxitektor topilmasi): sales/sale_items/raw_materials ham qulflanadi —
-- aks holda REPEATABLE READ snapshot ostida parallel yozuv GATE0.13/9.9 uchun
-- ko'rinmay, «o'zgarmagan» degan da'vo yolg'on chiqishi mumkin edi (§20 STOP).

-- ----------------------------------------------------------------------------
-- TASNIF (egasi §21, FINAL): 6 istisno; ro'yxatda yo'q barcha SKU = finished
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE rd_class (sku text PRIMARY KEY, ptype text NOT NULL, expected_name text NOT NULL) ON COMMIT DROP;
INSERT INTO rd_class VALUES
  ('TM-000018','raw','Passport Xom BCF'),
  ('TM-000061','raw','Polipropilen CF 1500D Qora'),
  ('TM-000062','raw','Polipropilen CF 1000D Yashil'),
  ('TM-000005','pre-finished','FDY Igna Strupa'),
  ('TM-000016','pre-finished','Qop ip Yashil'),
  ('TM-000017','pre-finished','Qop ip Qizil');

-- ----------------------------------------------------------------------------
-- 1. GATE-0: PINLAR (birortasi mos kelmasa — EXCEPTION, hech narsa yozilmaydi)
-- ----------------------------------------------------------------------------
DO $$
DECLARE v bigint; v2 bigint; v3 numeric; bad bigint;
BEGIN
  -- 1.1 Items katalogi
  SELECT count(*) INTO v FROM items;
  IF v <> 94 THEN RAISE EXCEPTION 'GATE0.1: items=% (kutilgan 94)', v; END IF;
  SELECT count(*) INTO v FROM items WHERE sku !~ '^TM-\d{6}$';
  IF v <> 0 THEN RAISE EXCEPTION 'GATE0.1b: noto''g''ri SKU format: %', v; END IF;

  -- 1.2 Baseline registri: 9 satr; id=9 C-15 LOADED; id 1..8 MAPPED, pinlangan
  SELECT count(*) INTO v FROM physical_baselines;
  IF v <> 9 THEN RAISE EXCEPTION 'GATE0.2: baselines=% (9 emas)', v; END IF;
  PERFORM 1 FROM physical_baselines
   WHERE id=9 AND container_label='C-15' AND warehouse_id=21 AND status='LOADED'
     AND positions_count=3 AND total_weight_kg=13020.00;
  IF NOT FOUND THEN RAISE EXCEPTION 'GATE0.2b: C-15 (id=9) holati kutilgandek emas'; END IF;
  SELECT count(*) INTO bad FROM (
    SELECT b.id, b.container_label, b.warehouse_id, b.positions_count, b.total_weight_kg, b.status
      FROM physical_baselines b WHERE b.id BETWEEN 1 AND 8
  ) x FULL JOIN (VALUES
      (1,'C-20',26,10,10136.45), (2,'C-19',25,13, 8713.30),
      (3,'C-18',24,29, 9839.45), (4,'C-02', 8,10, 6053.00),
      (5,'C-04',10, 7, 6363.30), (6,'C-06',12,13, 7435.50),
      (7,'C-16',22, 3, 7045.20), (8,'C-17',23, 9, 3256.00)
  ) e(id,label,wid,pc,kg)
    ON x.id=e.id AND x.container_label=e.label AND x.warehouse_id=e.wid
   AND x.positions_count=e.pc AND x.total_weight_kg=e.kg AND x.status='MAPPED'
  WHERE x.id IS NULL OR e.id IS NULL;
  IF bad <> 0 THEN RAISE EXCEPTION 'GATE0.2c: id1..8 pin mos emas (%)', bad; END IF;

  -- 1.3 Pozitsiyalar: 97 jami; 95 MAPPED + 2 EXCLUDED (pinlangan)
  SELECT count(*) INTO v FROM physical_baseline_positions;
  IF v <> 97 THEN RAISE EXCEPTION 'GATE0.3: positions=% (97 emas)', v; END IF;
  SELECT count(*) FILTER (WHERE mapping_status='MAPPED'),
         count(*) FILTER (WHERE mapping_status='EXCLUDED_EXACT_CANDIDATE')
    INTO v, v2 FROM physical_baseline_positions;
  IF v <> 95 OR v2 <> 2 THEN RAISE EXCEPTION 'GATE0.3b: MAPPED=% EXCL=% (95/2 emas)', v, v2; END IF;
  SELECT count(*) INTO v FROM physical_baseline_positions p
   WHERE p.mapping_status='EXCLUDED_EXACT_CANDIDATE'
     AND ( (p.baseline_id=3 AND p.position_no=40 AND p.name='Rossiya Tros'  AND p.weight_kg=531.00  AND p.item_id IS NULL)
        OR (p.baseline_id=4 AND p.position_no=61 AND p.name='Shroki 3.5 Oq' AND p.weight_kg=676.55 AND p.item_id IS NULL) );
  IF v <> 2 THEN RAISE EXCEPTION 'GATE0.3c: 2 EXACT pin mos emas'; END IF;

  -- 1.4 MAPPED yig'indilari konteyner-kesim (kg va dona)
  SELECT count(*) INTO bad FROM (
    SELECT p.baseline_id bid, count(*) c,
           COALESCE(sum(p.weight_kg),0) kg,
           COALESCE(sum(p.quantity) FILTER (WHERE p.unit='dona'),0) dona
      FROM physical_baseline_positions p
     WHERE p.baseline_id BETWEEN 1 AND 8 AND p.mapping_status='MAPPED'
     GROUP BY 1
  ) x FULL JOIN (VALUES
      (1,10,10136.45,0), (2,13,8713.30,0), (3,28,9308.45,0), (4, 9,5376.45,0),
      (5, 7,6363.30,0), (6,13,7435.50,0), (7, 3,7045.20,61080), (8, 9,3256.00,65280)
  ) e(bid,c,kg,dona)
    ON x.bid=e.bid AND x.c=e.c AND x.kg=e.kg::numeric AND x.dona=e.dona::numeric
  WHERE x.bid IS NULL OR e.bid IS NULL;
  IF bad <> 0 THEN RAISE EXCEPTION 'GATE0.4: MAPPED yig''indi pin mos emas (%)', bad; END IF;

  -- 1.5 Har MAPPED pozitsiya: item bor, nom bayt-teng, birlik to'g'ri
  SELECT count(*) INTO bad
    FROM physical_baseline_positions p
    LEFT JOIN items i ON i.id=p.item_id
   WHERE p.baseline_id BETWEEN 1 AND 8 AND p.mapping_status='MAPPED'
     AND (i.id IS NULL OR i.display_name IS DISTINCT FROM p.name
          OR p.unit NOT IN ('kg','dona')
          OR (p.unit='kg'   AND p.quantity <> p.weight_kg)
          OR (p.unit='dona' AND (p.quantity <= 0 OR p.weight_kg <= 0)));
  IF bad <> 0 THEN RAISE EXCEPTION 'GATE0.5: pozitsiya-item bog''i buzilgan (%)', bad; END IF;

  -- 1.6 Global before-holat (preview-paytdagi pinlar; drift = STOP + qayta-pin)
  SELECT count(*) INTO v FROM inventory;
  IF v <> 46 THEN RAISE EXCEPTION 'GATE0.6: inventory=% (46 emas — drift, qayta preview)', v; END IF;
  SELECT count(*) INTO v FROM stock_movements;
  IF v <> 623 THEN RAISE EXCEPTION 'GATE0.6b: movements=% (623 emas — drift)', v; END IF;
  SELECT count(*) INTO v FROM stock_movements WHERE movement_type='BASELINE';
  IF v <> 3 THEN RAISE EXCEPTION 'GATE0.6c: BASELINE=% (3 emas)', v; END IF;

  -- 1.7 Omborlar: nom=yorliq, aktiv; C-15 daxlsiz
  SELECT count(*) INTO v FROM warehouses w
   JOIN (VALUES (26,'C-20'),(25,'C-19'),(24,'C-18'),(8,'C-02'),
                (10,'C-04'),(12,'C-06'),(22,'C-16'),(23,'C-17')) e(wid,nm)
     ON w.id=e.wid AND w.name=e.nm AND w.active AND w.purpose='finished';
  IF v <> 8 THEN RAISE EXCEPTION 'GATE0.7: ombor pin mos emas (%)', v; END IF;
  SELECT count(*), COALESCE(sum(weight_kg),0) INTO v, v3 FROM inventory WHERE warehouse_id=21;
  IF v <> 3 OR v3 <> 13020.00 THEN RAISE EXCEPTION 'GATE0.7b: C-15 inventar % / % (3/13020 emas)', v, v3; END IF;
  SELECT count(*) INTO v FROM stock_movements
   WHERE (from_warehouse_id=21 OR to_warehouse_id=21);
  IF v <> 3 THEN RAISE EXCEPTION 'GATE0.7c: C-15 harakatlari % (3 emas)', v; END IF;
  SELECT count(*) INTO v FROM inventory inv JOIN items i ON i.id=inv.item_id
   WHERE inv.warehouse_id=21 AND i.sku IN ('TM-000092','TM-000093','TM-000094') AND inv.product_type='raw';
  IF v <> 3 THEN RAISE EXCEPTION 'GATE0.7d: C-15 raw tasnifi buzilgan (%)', v; END IF;

  -- 1.8 6 kg-konteyner tozaligi (inventar=0, harakat=0)
  SELECT count(*) INTO v FROM inventory WHERE warehouse_id IN (26,25,24,8,10,12);
  IF v <> 0 THEN RAISE EXCEPTION 'GATE0.8: kg-konteynerlarda inventar bor (%)', v; END IF;
  SELECT count(*) INTO v FROM stock_movements
   WHERE from_warehouse_id IN (26,25,24,8,10,12) OR to_warehouse_id IN (26,25,24,8,10,12);
  IF v <> 0 THEN RAISE EXCEPTION 'GATE0.8b: kg-konteynerlarda harakat bor (%)', v; END IF;

  -- 1.9 C-16/C-17 before-pin: aynan 13 legacy satr + 5/83 harakat, BASELINE=0
  SELECT count(*) INTO v FROM inventory WHERE warehouse_id=22;
  IF v <> 3 THEN RAISE EXCEPTION 'GATE0.9: C-16 inventar=% (3 emas)', v; END IF;
  SELECT count(*) INTO v FROM inventory WHERE warehouse_id=23;
  IF v <> 10 THEN RAISE EXCEPTION 'GATE0.9b: C-17 inventar=% (10 emas)', v; END IF;
  SELECT count(*) INTO v FROM stock_movements WHERE from_warehouse_id=22 OR to_warehouse_id=22;
  IF v <> 5 THEN RAISE EXCEPTION 'GATE0.9c: C-16 harakat=% (5 emas)', v; END IF;
  SELECT count(*) INTO v FROM stock_movements WHERE from_warehouse_id=23 OR to_warehouse_id=23;
  IF v <> 83 THEN RAISE EXCEPTION 'GATE0.9d: C-17 harakat=% (83 emas)', v; END IF;
  SELECT count(*) INTO v FROM stock_movements
   WHERE (from_warehouse_id IN (22,23) OR to_warehouse_id IN (22,23)) AND movement_type='BASELINE';
  IF v <> 0 THEN RAISE EXCEPTION 'GATE0.9e: C-16/17''da BASELINE allaqachon bor (%)', v; END IF;

  -- 1.10 13 legacy satr: jonli = pin = arxiv (bayt-solishtiruv)
  SELECT count(*) INTO bad FROM (
    SELECT inv.id, inv.warehouse_id, inv.product, inv.quantity, inv.product_type, inv.weight_kg, inv.item_id
      FROM inventory inv WHERE inv.warehouse_id IN (22,23)
  ) x FULL JOIN (VALUES
      (10,22,'Qop Ip - 100 talik',77900.000), (11,22,'Qop ip - 120 talik',9240.000),
      (12,22,'Qop ip - 80 talik',3040.000),
      ( 1,23,'Reja ip 100 gr / Oq',8800.000), ( 2,23,'Reja ip 100 gr / Qora',10200.000),
      ( 3,23,'Reja ip 100 gr / Sariq',12680.000), ( 4,23,'Reja ip 30 gr / OQ',12400.000),
      ( 5,23,'Reja ip 30 gr / Qora',18800.000), ( 6,23,'Reja ip 30 gr / Sariq',25600.000),
      ( 7,23,'Reja ip 50 gr / OQ',12800.000), ( 8,23,'Reja ip 50 gr / Qora',25000.000),
      ( 9,23,'Reja ip 50 gr / Sariq',23600.000), (104,23,'Reja ip PP / 50 gr',100.000)
  ) e(id,wid,product,qty)
    ON x.id=e.id AND x.warehouse_id=e.wid AND x.product=e.product
   AND x.quantity=e.qty AND x.product_type='finished' AND x.weight_kg=0 AND x.item_id IS NULL
  WHERE x.id IS NULL OR e.id IS NULL;
  IF bad <> 0 THEN RAISE EXCEPTION 'GATE0.10: 13 legacy pin mos emas (%)', bad; END IF;
  SELECT count(*) INTO bad
    FROM inventory inv
    JOIN legacy.inventory_baseline_pre a ON a.inventory_id=inv.id
   WHERE inv.warehouse_id IN (22,23)
     AND (a.warehouse_id<>inv.warehouse_id OR a.product IS DISTINCT FROM inv.product
          OR a.quantity IS DISTINCT FROM inv.quantity OR a.weight_kg IS DISTINCT FROM inv.weight_kg
          OR a.product_type IS DISTINCT FROM inv.product_type);
  IF bad <> 0 THEN RAISE EXCEPTION 'GATE0.10b: jonli≠arxiv (%) — STOP', bad; END IF;
  SELECT count(*) INTO v FROM legacy.inventory_baseline_pre WHERE warehouse_id IN (22,23);
  IF v <> 13 THEN RAISE EXCEPTION 'GATE0.10c: arxivda C-16/17 satrlari=% (13 emas)', v; END IF;

  -- 1.11 Iz yo'qligi: 92 item/nom inventar+harakatlarda hech qayerda yo'q
  SELECT count(*) INTO v FROM inventory inv WHERE inv.item_id IN (
    SELECT p.item_id FROM physical_baseline_positions p WHERE p.baseline_id BETWEEN 1 AND 8 AND p.mapping_status='MAPPED');
  IF v <> 0 THEN RAISE EXCEPTION 'GATE0.11: inventarda item izi bor (%)', v; END IF;
  SELECT count(*) INTO v FROM inventory inv WHERE inv.product IN (
    SELECT p.name FROM physical_baseline_positions p WHERE p.baseline_id BETWEEN 1 AND 8 AND p.mapping_status='MAPPED');
  IF v <> 0 THEN RAISE EXCEPTION 'GATE0.11b: inventarda nom izi bor (%)', v; END IF;
  SELECT count(*) INTO v FROM stock_movements m WHERE m.item_id IN (
    SELECT p.item_id FROM physical_baseline_positions p WHERE p.baseline_id BETWEEN 1 AND 8 AND p.mapping_status='MAPPED')
    OR m.product IN (
    SELECT p.name FROM physical_baseline_positions p WHERE p.baseline_id BETWEEN 1 AND 8 AND p.mapping_status='MAPPED');
  IF v <> 0 THEN RAISE EXCEPTION 'GATE0.11c: harakatlarda iz bor (%)', v; END IF;

  -- 1.12 TASNIF validatsiyasi (egasi §21): 6 istisno SKU mavjud, nomlar bayt-teng
  SELECT count(*) INTO v FROM rd_class;
  IF v <> 6 THEN RAISE EXCEPTION 'GATE0.12: rd_class=% (6 emas)', v; END IF;
  SELECT count(*) FILTER (WHERE ptype='raw'), count(*) FILTER (WHERE ptype='pre-finished')
    INTO v, v2 FROM rd_class;
  IF v <> 3 OR v2 <> 3 THEN RAISE EXCEPTION 'GATE0.12b: raw=%/pre=% (3/3 emas)', v, v2; END IF;
  SELECT count(*) INTO bad FROM rd_class r
   LEFT JOIN items i ON i.sku=r.sku
   WHERE i.id IS NULL OR i.display_name IS DISTINCT FROM r.expected_name
      OR NOT EXISTS (SELECT 1 FROM physical_baseline_positions p
                      WHERE p.item_id=i.id AND p.baseline_id BETWEEN 1 AND 8 AND p.mapping_status='MAPPED');
  IF bad <> 0 THEN RAISE EXCEPTION 'GATE0.12c: tasnif SKU/nom mos emas (%) — classification mismatch STOP', bad; END IF;

  -- 1.13 Daxlsizlar before-pin (preview-paytdagi; drift = STOP + qayta-pin)
  SELECT count(*) INTO v FROM sales;       IF v <> 45  THEN RAISE EXCEPTION 'GATE0.13: sales=%', v; END IF;
  SELECT count(*) INTO v FROM sale_items;  IF v <> 143 THEN RAISE EXCEPTION 'GATE0.13b: sale_items=%', v; END IF;
  SELECT count(*) INTO v FROM legacy.inventory_baseline_pre; IF v <> 43 THEN RAISE EXCEPTION 'GATE0.13c: arxiv=%', v; END IF;
  SELECT count(*) INTO v FROM raw_materials; IF v <> 17 THEN RAISE EXCEPTION 'GATE0.13d: raw_materials=%', v; END IF;

  -- 1.14 EXACT rekonsiliatsiya (egasi §5/§15): katalog pinlari + dublikat=0 isboti
  PERFORM 1 FROM products WHERE id=46  AND name='Rossiya Tros'  AND sku='ROSSIYATROS'   AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'GATE0.14: products id=46 ROSSIYATROS pin mos emas'; END IF;
  PERFORM 1 FROM products WHERE id=108 AND name='Shroki 3.5 Oq' AND sku='SHROKI-3-5-OQ' AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'GATE0.14b: products id=108 SHROKI-3-5-OQ pin mos emas'; END IF;
  SELECT count(*) INTO v FROM inventory WHERE product IN ('Rossiya Tros','Shroki 3.5 Oq');
  IF v <> 0 THEN RAISE EXCEPTION 'GATE0.14c: EXACT nomlarda joriy balans bor (%) — double-count xavfi, STOP', v; END IF;
  SELECT count(*) INTO v FROM legacy.inventory_baseline_pre WHERE product IN ('Rossiya Tros','Shroki 3.5 Oq');
  IF v <> 0 THEN RAISE EXCEPTION 'GATE0.14d: EXACT nomlar arxivda bor (%) — rekonsiliatsiya buzildi', v; END IF;
  SELECT count(*) INTO v FROM stock_movements WHERE product IN ('Rossiya Tros','Shroki 3.5 Oq');
  IF v <> 0 THEN RAISE EXCEPTION 'GATE0.14e: EXACT nomlarda harakat tarixi bor (%) — kutilmagan', v; END IF;

  RAISE NOTICE 'GATE-0: BARCHA PINLAR PASS (1.1–1.14)';
END $$;

-- ----------------------------------------------------------------------------
-- 2. GATE-1 LATCH: 8 baseline'ni qulflash; takror GO'ni bloklash
-- ----------------------------------------------------------------------------
DO $$
DECLARE v int;
BEGIN
  PERFORM 1 FROM physical_baselines WHERE id BETWEEN 1 AND 8 FOR UPDATE;
  SELECT count(*) INTO v FROM physical_baselines WHERE id BETWEEN 1 AND 8 AND status='MAPPED';
  IF v <> 8 THEN RAISE EXCEPTION 'LATCH: % ta MAPPED (8 emas) — takror GO yoki holat o''zgargan', v; END IF;
  RAISE NOTICE 'GATE-1 LATCH: 8/8 MAPPED qulflandi';
END $$;

-- ----------------------------------------------------------------------------
-- 3. Boshqa omborlar snapshot (daxlsizlik isboti uchun)
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE rd_other_wh_before ON COMMIT DROP AS
  SELECT warehouse_id, count(*) c, COALESCE(sum(quantity),0) q, COALESCE(sum(weight_kg),0) kg
    FROM inventory WHERE warehouse_id NOT IN (26,25,24,8,10,12,22,23)  -- C-15 (21) ham kiradi
   GROUP BY 1;

-- ----------------------------------------------------------------------------
-- 4a. YUKLASH: 92 TM BASELINE harakat (registrdan derivativ — transkripsiya yo'q)
-- ----------------------------------------------------------------------------
INSERT INTO stock_movements
      (product, quantity, movement_type, from_warehouse_id, to_warehouse_id,
       note, created_by, product_type, item_id, weight_kg, reference, reason)
SELECT i.display_name,
       CASE WHEN p.unit='dona' THEN p.quantity ELSE 0 END,
       'BASELINE', NULL, b.warehouse_id,
       'R-D BASELINE '||b.container_label||' · '||i.sku||' '||i.display_name||' · '||
         CASE WHEN p.unit='dona'
              THEN p.quantity::bigint||' dona / '||p.weight_kg||' kg'
              ELSE p.weight_kg||' kg' END,
       'thisismurodov',
       COALESCE((SELECT c.ptype FROM rd_class c WHERE c.sku=i.sku), 'finished'),
       p.item_id, p.weight_kg,
       'R-B: physical_baseline_positions pos='||p.position_no||' · docs/r-b-mapping-preview-2026-08-17.md',
       'R-D baseline yuklash '||b.container_label||' — fizik sanoq 2026-08-15 — FINAL GO 2026-08-17'
  FROM physical_baseline_positions p
  JOIN physical_baselines b ON b.id=p.baseline_id
  JOIN items i ON i.id=p.item_id
 WHERE b.id BETWEEN 1 AND 8 AND p.mapping_status='MAPPED'
 ORDER BY b.id, p.position_no;

-- ----------------------------------------------------------------------------
-- 4b. YUKLASH: 2 EXACT BASELINE harakat (egasi §5/§15 — finished, dublikat SKU yo'q)
-- ----------------------------------------------------------------------------
INSERT INTO stock_movements
      (product, quantity, movement_type, from_warehouse_id, to_warehouse_id,
       note, created_by, product_type, item_id, weight_kg, reference, reason)
VALUES
  ('Rossiya Tros', 0, 'BASELINE', NULL, 24,
   'R-D EXACT C-18 · Rossiya Tros · 531.00 kg (mavjud katalog: products.id=46 ROSSIYATROS)',
   'thisismurodov', 'finished', NULL, 531.00,
   'R-B: physical_baseline_positions pos=40 (EXCLUDED_EXACT_CANDIDATE) · products.id=46 · FINAL MASTER PROMPT §5/§15/§21',
   'R-D EXACT yuklash C-18 — egasi yakuniy qarori: finished; joriy balans=0 isbotlangan, dublikat SKU yaratilmadi — FINAL GO 2026-08-17'),
  ('Shroki 3.5 Oq', 0, 'BASELINE', NULL, 8,
   'R-D EXACT C-02 · Shroki 3.5 Oq · 676.55 kg (mavjud katalog: products.id=108 SHROKI-3-5-OQ)',
   'thisismurodov', 'finished', NULL, 676.55,
   'R-B: physical_baseline_positions pos=61 (EXCLUDED_EXACT_CANDIDATE) · products.id=108 · FINAL MASTER PROMPT §5/§15/§21',
   'R-D EXACT yuklash C-02 — egasi yakuniy qarori: finished; joriy balans=0 isbotlangan, dublikat SKU yaratilmadi — FINAL GO 2026-08-17');

-- ----------------------------------------------------------------------------
-- 5a. YUKLASH: 92 TM inventar satri (xuddi shu manbadan)
-- ----------------------------------------------------------------------------
INSERT INTO inventory (warehouse_id, product, quantity, product_type, weight_kg, item_id)
SELECT b.warehouse_id, i.display_name,
       CASE WHEN p.unit='dona' THEN p.quantity ELSE 0 END,
       COALESCE((SELECT c.ptype FROM rd_class c WHERE c.sku=i.sku), 'finished'),
       p.weight_kg, p.item_id
  FROM physical_baseline_positions p
  JOIN physical_baselines b ON b.id=p.baseline_id
  JOIN items i ON i.id=p.item_id
 WHERE b.id BETWEEN 1 AND 8 AND p.mapping_status='MAPPED'
 ORDER BY b.id, p.position_no;

-- ----------------------------------------------------------------------------
-- 5b. YUKLASH: 2 EXACT inventar satri (item_id NULL — TM SKU yaratilmadi)
-- ----------------------------------------------------------------------------
INSERT INTO inventory (warehouse_id, product, quantity, product_type, weight_kg, item_id) VALUES
  (24, 'Rossiya Tros',  0, 'finished', 531.00, NULL),
  ( 8, 'Shroki 3.5 Oq', 0, 'finished', 676.55, NULL);

-- ----------------------------------------------------------------------------
-- 6. №2 NOLLASH: 13 legacy satr — FOR UPDATE + arxiv bilan qayta solishtiruv,
--    auditli BASELINE (eski qiymat bilan), so'ng quantity=0 (DELETE YO'Q)
-- ----------------------------------------------------------------------------
DO $$
DECLARE r RECORD; live RECORD; arch RECORD; lbl text; zcount int := 0;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      (10,22,'Qop Ip - 100 talik',77900.000), (11,22,'Qop ip - 120 talik',9240.000),
      (12,22,'Qop ip - 80 talik',3040.000),
      ( 1,23,'Reja ip 100 gr / Oq',8800.000), ( 2,23,'Reja ip 100 gr / Qora',10200.000),
      ( 3,23,'Reja ip 100 gr / Sariq',12680.000), ( 4,23,'Reja ip 30 gr / OQ',12400.000),
      ( 5,23,'Reja ip 30 gr / Qora',18800.000), ( 6,23,'Reja ip 30 gr / Sariq',25600.000),
      ( 7,23,'Reja ip 50 gr / OQ',12800.000), ( 8,23,'Reja ip 50 gr / Qora',25000.000),
      ( 9,23,'Reja ip 50 gr / Sariq',23600.000), (104,23,'Reja ip PP / 50 gr',100.000)
    ) t(inv_id, wid, product, qty)
  LOOP
    SELECT * INTO live FROM inventory WHERE id=r.inv_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOLLASH: inventar id=% topilmadi', r.inv_id; END IF;
    IF live.warehouse_id<>r.wid OR live.product<>r.product OR live.quantity<>r.qty
       OR live.weight_kg<>0 OR live.product_type<>'finished' OR live.item_id IS NOT NULL THEN
      RAISE EXCEPTION 'NOLLASH-MISMATCH (pin): id=% · % · qty=%', r.inv_id, live.product, live.quantity;
    END IF;
    SELECT * INTO arch FROM legacy.inventory_baseline_pre WHERE inventory_id=r.inv_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOLLASH: arxivda inventory_id=% yo''q — STOP', r.inv_id; END IF;
    IF arch.product IS DISTINCT FROM live.product OR arch.quantity IS DISTINCT FROM live.quantity
       OR arch.weight_kg IS DISTINCT FROM live.weight_kg OR arch.warehouse_id IS DISTINCT FROM live.warehouse_id
       OR arch.product_type IS DISTINCT FROM live.product_type THEN
      RAISE EXCEPTION 'NOLLASH-MISMATCH (arxiv): id=% jonli≠arxiv — STOP + ROLLBACK', r.inv_id;
    END IF;
    lbl := CASE WHEN r.wid=22 THEN 'C-16' ELSE 'C-17' END;
    INSERT INTO stock_movements
          (product, quantity, movement_type, from_warehouse_id, to_warehouse_id,
           note, created_by, product_type, item_id, weight_kg, reference, reason)
    VALUES (live.product, live.quantity, 'BASELINE', live.warehouse_id, NULL,
           'R-D NOLLASH '||lbl||' · '||live.product||' · eski qiymat '||live.quantity::bigint||' dona (arxiv bilan MOS tasdiqlandi)',
           'thisismurodov', live.product_type, NULL, live.weight_kg,
           'legacy.inventory_baseline_pre inventory_id='||r.inv_id||' · №2 qaror — FINAL MASTER PROMPT §6',
           'R-D legacy nollash '||lbl||' — eski ERP qoldig''i R-A arxivida muhrlangan; joriy balansdan auditli chiqarish (DELETE emas) — FINAL GO 2026-08-17');
    UPDATE inventory SET quantity=0, updated_at=now() WHERE id=r.inv_id;
    zcount := zcount + 1;
  END LOOP;
  IF zcount <> 13 THEN RAISE EXCEPTION 'NOLLASH: % ta bajarildi (13 emas)', zcount; END IF;
  RAISE NOTICE 'NOLLASH: 13/13 auditli BASELINE bilan nollandi';
END $$;

-- ----------------------------------------------------------------------------
-- 7. STATUS: id 1..8 MAPPED → LOADED (trigger-ruxsatli yagona o'tish)
-- ----------------------------------------------------------------------------
DO $$
DECLARE v int;
BEGIN
  UPDATE physical_baselines SET status='LOADED' WHERE id BETWEEN 1 AND 8 AND status='MAPPED';
  GET DIAGNOSTICS v = ROW_COUNT;
  IF v <> 8 THEN RAISE EXCEPTION 'STATUS: % ta yangilandi (8 emas)', v; END IF;
  RAISE NOTICE 'STATUS: 8/8 LOADED';
END $$;

-- ----------------------------------------------------------------------------
-- 8. COMMIT'DAN OLDINGI VERIFIKATSIYA (9.x — birortasi yiqilsa ROLLBACK)
-- ----------------------------------------------------------------------------
DO $$
DECLARE v bigint; v2 bigint; v3 bigint; kg numeric; kg2 numeric; dona numeric; bad bigint;
BEGIN
  -- 9.1 Global BASELINE = 110 (3 C-15 + 92 TM + 2 EXACT + 13 nollash)
  SELECT count(*) INTO v FROM stock_movements WHERE movement_type='BASELINE';
  IF v <> 110 THEN RAISE EXCEPTION '9.1: BASELINE=% (110 emas)', v; END IF;

  -- 9.2 Yangi harakatlar: 92 TM + 2 EXACT + 13 nollash
  SELECT count(*) INTO v FROM stock_movements WHERE reason LIKE 'R-D baseline yuklash %FINAL GO 2026-08-17';
  IF v <> 92 THEN RAISE EXCEPTION '9.2: TM yuk harakatlari=% (92 emas)', v; END IF;
  SELECT count(*) INTO v FROM stock_movements WHERE reason LIKE 'R-D EXACT yuklash %';
  IF v <> 2 THEN RAISE EXCEPTION '9.2b: EXACT harakatlari=% (2 emas)', v; END IF;
  SELECT count(*) INTO v FROM stock_movements WHERE reason LIKE 'R-D legacy nollash %';
  IF v <> 13 THEN RAISE EXCEPTION '9.2c: nollash harakatlari=% (13 emas)', v; END IF;

  -- 9.3 Global sonlar: inventar 140, harakatlar 730
  SELECT count(*) INTO v FROM inventory;        IF v <> 140 THEN RAISE EXCEPTION '9.3: inventory=% (140 emas)', v; END IF;
  SELECT count(*) INTO v FROM stock_movements;  IF v <> 730 THEN RAISE EXCEPTION '9.3b: movements=% (730 emas)', v; END IF;

  -- 9.4 Konteyner-kesim (BARCHA satrlar: yangi + nollangan legacy): son/kg/dona
  SELECT count(*) INTO bad FROM (
    SELECT inv.warehouse_id wid, count(*) c, sum(inv.weight_kg) kg, sum(inv.quantity) dona
      FROM inventory inv
     WHERE inv.warehouse_id IN (26,25,24,8,10,12,22,23)
     GROUP BY 1
  ) x FULL JOIN (VALUES
      (26,10,10136.45,0), (25,13,8713.30,0), (24,29,9839.45,0), (8,10,6053.00,0),
      (10, 7,6363.30,0), (12,13,7435.50,0), (22, 6,7045.20,61080), (23,19,3256.00,65280)
  ) e(wid,c,kg,dona)
    ON x.wid=e.wid AND x.c=e.c AND x.kg=e.kg::numeric AND x.dona=e.dona::numeric
  WHERE x.wid IS NULL OR e.wid IS NULL;
  IF bad <> 0 THEN RAISE EXCEPTION '9.4: konteyner-kesim pin mos emas (%)', bad; END IF;

  -- 9.5 13 legacy satr: saqlangan, hammasi quantity=0
  SELECT count(*), COALESCE(sum(quantity),0) INTO v, dona
    FROM inventory WHERE warehouse_id IN (22,23) AND item_id IS NULL;
  IF v <> 13 OR dona <> 0 THEN RAISE EXCEPTION '9.5: legacy satrlar %/% (13/0 emas)', v, dona; END IF;

  -- 9.6 YAKUNIY NAZORAT (egasi §16): 9 joy = 71,862.20 kg / 126,360 dona.
  --     MUSTAQIL QAYTA HISOB: inventar yig'indisi ↔ registr yig'indisi ↔ literal.
  SELECT COALESCE(sum(weight_kg),0), COALESCE(sum(quantity),0) INTO kg, dona
    FROM inventory WHERE warehouse_id IN (21,26,25,24,8,10,12,22,23);
  SELECT COALESCE(sum(weight_kg),0) INTO kg2 FROM physical_baseline_positions;  -- 97 pozitsiya, mustaqil manba
  IF kg <> kg2 THEN RAISE EXCEPTION '9.6: inventar kg=% ≠ registr kg=% — MUSTAQIL HISOB MOS EMAS', kg, kg2; END IF;
  IF kg <> 71862.20 THEN RAISE EXCEPTION '9.6b: jami kg=% (71862.20 emas)', kg; END IF;
  SELECT COALESCE(sum(quantity),0) INTO v FROM physical_baseline_positions WHERE unit='dona';
  IF dona <> v THEN RAISE EXCEPTION '9.6c: inventar dona=% ≠ registr dona=%', dona, v; END IF;
  IF dona <> 126360 THEN RAISE EXCEPTION '9.6d: jami dona=% (126360 emas)', dona; END IF;

  -- 9.7 C-15 daxlsiz: 3 satr / 13,020 kg / 3 harakat / raw
  SELECT count(*), COALESCE(sum(weight_kg),0) INTO v, kg FROM inventory WHERE warehouse_id=21;
  IF v <> 3 OR kg <> 13020.00 THEN RAISE EXCEPTION '9.7: C-15 buzilgan (%/%)', v, kg; END IF;
  SELECT count(*) INTO v FROM stock_movements WHERE from_warehouse_id=21 OR to_warehouse_id=21;
  IF v <> 3 THEN RAISE EXCEPTION '9.7b: C-15 harakatlari=% (3 emas)', v; END IF;

  -- 9.8 Boshqa omborlar snapshot bilan teng
  SELECT count(*) INTO bad FROM (
    SELECT warehouse_id, count(*) c, COALESCE(sum(quantity),0) q, COALESCE(sum(weight_kg),0) kg
      FROM inventory WHERE warehouse_id NOT IN (26,25,24,8,10,12,22,23) GROUP BY 1
  ) now_ FULL JOIN rd_other_wh_before b
    ON now_.warehouse_id=b.warehouse_id AND now_.c=b.c AND now_.q=b.q AND now_.kg=b.kg
  WHERE now_.warehouse_id IS NULL OR b.warehouse_id IS NULL;
  IF bad <> 0 THEN RAISE EXCEPTION '9.8: boshqa omborlar o''zgargan (%)', bad; END IF;

  -- 9.9 Daxlsizlar: sales/arxiv/raw_materials/pozitsiyalar/items/products
  SELECT count(*) INTO v FROM sales;      IF v <> 45  THEN RAISE EXCEPTION '9.9: sales=%', v; END IF;
  SELECT count(*) INTO v FROM sale_items; IF v <> 143 THEN RAISE EXCEPTION '9.9b: sale_items=%', v; END IF;
  SELECT count(*) INTO v FROM legacy.inventory_baseline_pre; IF v <> 43 THEN RAISE EXCEPTION '9.9c: arxiv=%', v; END IF;
  SELECT count(*) INTO v FROM raw_materials; IF v <> 17 THEN RAISE EXCEPTION '9.9d: raw_materials=%', v; END IF;
  SELECT count(*) INTO v FROM physical_baseline_positions; IF v <> 97 THEN RAISE EXCEPTION '9.9e: positions=%', v; END IF;
  SELECT count(*) INTO v FROM physical_baseline_positions WHERE mapping_status='EXCLUDED_EXACT_CANDIDATE';
  IF v <> 2 THEN RAISE EXCEPTION '9.9f: EXACT holati o''zgargan (%)', v; END IF;
  SELECT count(*) INTO v FROM items; IF v <> 94 THEN RAISE EXCEPTION '9.9g: items=% — yangi SKU yaratilgan!', v; END IF;
  SELECT count(*) INTO v FROM products; IF v NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION '9.9h: products anomaliya'; END IF;
  PERFORM 1 FROM products WHERE id=46 AND name='Rossiya Tros' AND sku='ROSSIYATROS';
  IF NOT FOUND THEN RAISE EXCEPTION '9.9i: products id=46 o''zgargan'; END IF;
  PERFORM 1 FROM products WHERE id=108 AND name='Shroki 3.5 Oq' AND sku='SHROKI-3-5-OQ';
  IF NOT FOUND THEN RAISE EXCEPTION '9.9j: products id=108 o''zgargan'; END IF;

  -- 9.10 Statuslar: 9/9 LOADED
  SELECT count(*) INTO v FROM physical_baselines WHERE status='LOADED';
  IF v <> 9 THEN RAISE EXCEPTION '9.10: LOADED=% (9 emas)', v; END IF;

  -- 9.11 2 EXACT inventarda AYNAN pinlangan ko'rinishda
  SELECT count(*) INTO v FROM inventory
   WHERE (warehouse_id=24 AND product='Rossiya Tros'  AND quantity=0 AND weight_kg=531.00  AND product_type='finished' AND item_id IS NULL)
      OR (warehouse_id= 8 AND product='Shroki 3.5 Oq' AND quantity=0 AND weight_kg=676.55 AND product_type='finished' AND item_id IS NULL);
  IF v <> 2 THEN RAISE EXCEPTION '9.11: EXACT satrlari=% (2 emas)', v; END IF;
  SELECT count(*) INTO v FROM inventory WHERE product IN ('Rossiya Tros','Shroki 3.5 Oq');
  IF v <> 2 THEN RAISE EXCEPTION '9.11b: EXACT nomlarda % satr (dublikat!)', v; END IF;

  -- 9.12 Harakat↔inventar o'zaro tenglik: TM (item_id orqali) + EXACT ((wid,product) orqali)
  SELECT count(*) INTO bad FROM (
    SELECT m.to_warehouse_id wid, m.item_id, sum(m.quantity) q, sum(m.weight_kg) kg
      FROM stock_movements m
     WHERE m.reason LIKE 'R-D baseline yuklash %FINAL GO 2026-08-17'
     GROUP BY 1,2
  ) mv FULL JOIN (
    SELECT inv.warehouse_id wid, inv.item_id, inv.quantity q, inv.weight_kg kg
      FROM inventory inv
     WHERE inv.warehouse_id IN (26,25,24,8,10,12,22,23) AND inv.item_id IS NOT NULL
  ) iv ON mv.wid=iv.wid AND mv.item_id=iv.item_id AND mv.q=iv.q AND mv.kg=iv.kg
  WHERE mv.wid IS NULL OR iv.wid IS NULL;
  IF bad <> 0 THEN RAISE EXCEPTION '9.12: TM harakat≠inventar (%)', bad; END IF;
  SELECT count(*) INTO bad FROM (
    SELECT m.to_warehouse_id wid, m.product, m.weight_kg kg
      FROM stock_movements m WHERE m.reason LIKE 'R-D EXACT yuklash %'
  ) mv FULL JOIN (
    SELECT inv.warehouse_id wid, inv.product, inv.weight_kg kg
      FROM inventory inv WHERE inv.product IN ('Rossiya Tros','Shroki 3.5 Oq')
  ) iv ON mv.wid=iv.wid AND mv.product=iv.product AND mv.kg=iv.kg
  WHERE mv.wid IS NULL OR iv.wid IS NULL;
  IF bad <> 0 THEN RAISE EXCEPTION '9.12b: EXACT harakat≠inventar (%)', bad; END IF;

  -- 9.13 Tasnif taqsimoti (egasi §21): yangi 94 satr = 3 raw + 3 pre-finished + 88 finished
  SELECT count(*) FILTER (WHERE product_type='raw'),
         count(*) FILTER (WHERE product_type='pre-finished'),
         count(*) FILTER (WHERE product_type='finished')
    INTO v, v2, v3
    FROM inventory
   WHERE warehouse_id IN (26,25,24,8,10,12,22,23)
     AND (item_id IS NOT NULL OR product IN ('Rossiya Tros','Shroki 3.5 Oq'));
  IF v <> 3 OR v2 <> 3 OR v3 <> 88 THEN RAISE EXCEPTION '9.13: tasnif %/%/% (3/3/88 emas)', v, v2, v3; END IF;
  SELECT count(*) INTO v FROM inventory inv JOIN items i ON i.id=inv.item_id
   WHERE i.sku='TM-000022' AND inv.product_type='finished';
  IF v <> 2 THEN RAISE EXCEPTION '9.13b: TM-000022 ikkala lokatsiyada finished emas (%)', v; END IF;
  SELECT count(*) INTO bad FROM inventory inv
    JOIN items i ON i.id=inv.item_id
    JOIN rd_class c ON c.sku=i.sku
   WHERE inv.warehouse_id IN (26,25,24,8,10,12,22,23) AND inv.product_type <> c.ptype;
  IF bad <> 0 THEN RAISE EXCEPTION '9.13c: istisno tasnif mos emas (%)', bad; END IF;

  RAISE NOTICE '9.x: BARCHA VERIFIKATSIYA PASS — COMMIT xavfsiz';
END $$;

COMMIT;

\echo '=============================================================='
\echo 'R-D FINAL: COMMIT BAJARILDI (94 yuk + 13 nollash + 8 LOADED)'
\echo 'Keyingi qadam: mustaqil read-only post-verify (alohida sessiya)'
\echo '=============================================================='
