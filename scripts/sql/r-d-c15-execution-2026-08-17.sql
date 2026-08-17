-- ═══════════════════════════════════════════════════════════════════════════
-- R-D GO C-15 — baseline yuklash (2026-08-17)
-- Egasi GO: «R-D GO C-15» (2026-08-17). Tasdiqlangan qarorlar:
--   quantity=0 · weight_kg=sanoq kg · created_by='thisismurodov' · product_type='raw'
-- Qamrov: FAQAT C-15 (baseline id=9, warehouse_id=21):
--   3 ta BASELINE harakat + 3 ta inventar satri + status MAPPED→LOADED.
-- R-B registri, legacy, sales, raw_materials, boshqa konteynerlar TEGILMAYDI —
--   txn ichida before/after solishtiruv bilan isbotlanadi.
-- Har qanday xato = EXCEPTION = to'liq ROLLBACK. Dublikat GO = GATE1 LATCH'da to'xtaydi.
-- Dry-run: docs/r-d-dryrun-c15-2026-08-17.md
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ;

-- QULFLAR — snapshot'dan OLDIN (arxitektor ko'rigi, 2026-08-17):
-- SHARE ROW EXCLUSIVE yozuvchilarni bloklaydi (o'qish erkin) va o'z-o'zi bilan
-- konfliktlashadi — parallel R-D skriptlari shu yerda navbatga turadi.
-- Qulflar olingach birinchi SELECT yangi snapshot oladi: GATE2 va 9.x
-- tekshiruvlari YAKUNIY holatni ko'radi; parallel yozuvlar COMMIT'gacha
-- kutadi (~1-2 soniya). R-B'dagi warehouses-qulf saboqning davomi.
LOCK TABLE physical_baselines, physical_baseline_positions, items,
           warehouses, inventory, stock_movements
  IN SHARE ROW EXCLUSIVE MODE;

DO $rd$
DECLARE
  v_cnt        bigint;
  v_sum        numeric;
  v_qty        numeric;
  v_dona       numeric;
  v_bad        bigint;
  v_mov_before bigint;
  v_inv_o_rows bigint; v_inv_o_qty numeric; v_inv_o_kg numeric;
  v_rm_cnt     bigint; v_rm_sum numeric;
  v_lg_inv bigint; v_lg_cont bigint; v_lg_raw bigint; v_lg_wip bigint;
  v_sales bigint; v_sitems bigint;
BEGIN
  --------------------------------------------------------------------------
  -- GATE 0 — muzlatilgan registr va muhit qoziqlari
  --------------------------------------------------------------------------
  SELECT COUNT(*) INTO v_cnt FROM physical_baselines;
  IF v_cnt <> 9 THEN
    RAISE EXCEPTION 'GATE0: physical_baselines soni % (9 kutildi)', v_cnt;
  END IF;

  SELECT COUNT(*) INTO v_cnt FROM items;
  IF v_cnt <> 94 THEN
    RAISE EXCEPTION 'GATE0: items soni % (94 kutildi)', v_cnt;
  END IF;

  SELECT COUNT(*),
         SUM(COALESCE(weight_kg, 0)),
         COALESCE(SUM(quantity) FILTER (WHERE unit = 'dona'), 0)
    INTO v_cnt, v_sum, v_dona
    FROM physical_baseline_positions;
  IF v_cnt <> 97 OR v_sum <> 71862.20 OR v_dona <> 126360.00 THEN
    RAISE EXCEPTION 'GATE0: registr pozitsiyalari %/%/% (97/71862.20/126360.00 kutildi)', v_cnt, v_sum, v_dona;
  END IF;

  -- Warehouse 21 = C-15 (rename'dan himoya: satr FOR SHARE qulfi)
  PERFORM 1 FROM warehouses WHERE id = 21 AND name = 'C-15' AND active FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GATE0: warehouse 21 ''C-15'' emas yoki noaktiv';
  END IF;

  -- Items qoziqlari (byte-exact)
  SELECT COUNT(*) INTO v_cnt FROM items i
   WHERE (i.id, i.sku, i.display_name, i.unit) IN (
     (93, 'TM-000092', 'Polipropilen CF 1000D Qizil', 'kg'),
     (94, 'TM-000093', 'Polipropilen CF 1000D Ko''k',  'kg'),
     (95, 'TM-000094', 'Polipropilen CF 1000D Sariq', 'kg'));
  IF v_cnt <> 3 THEN
    RAISE EXCEPTION 'GATE0: items qoziqlari mos emas (%/3)', v_cnt;
  END IF;

  -- C-15 pozitsiya qoziqlari (byte-exact, muzlatilgan qiymatlar)
  SELECT COUNT(*) INTO v_cnt
    FROM physical_baseline_positions p
    JOIN physical_baselines b ON b.id = p.baseline_id
   WHERE b.container_label = 'C-15'
     AND (p.position_no, p.name, p.quantity, p.unit, p.weight_kg, p.item_id, p.mapping_status) IN (
     (95, 'Polipropilen CF 1000D Qizil', 3720.00, 'kg', 3720.00, 93, 'MAPPED'),
     (96, 'Polipropilen CF 1000D Ko''k',  3840.00, 'kg', 3840.00, 94, 'MAPPED'),
     (97, 'Polipropilen CF 1000D Sariq', 5460.00, 'kg', 5460.00, 95, 'MAPPED'));
  IF v_cnt <> 3 THEN
    RAISE EXCEPTION 'GATE0: C-15 pozitsiya qoziqlari mos emas (%/3)', v_cnt;
  END IF;

  -- Baseline 9 da BOSHQA pozitsiya yo'qligi + jami kg
  SELECT COUNT(*), COALESCE(SUM(weight_kg), 0) INTO v_cnt, v_sum
    FROM physical_baseline_positions WHERE baseline_id = 9;
  IF v_cnt <> 3 OR v_sum <> 13020.00 THEN
    RAISE EXCEPTION 'GATE0: baseline 9 pozitsiyalari %/% (3/13020.00 kutildi)', v_cnt, v_sum;
  END IF;

  -- Registr nomi ↔ item display_name aynanligi
  SELECT COUNT(*) INTO v_bad
    FROM physical_baseline_positions p JOIN items i ON i.id = p.item_id
   WHERE p.baseline_id = 9 AND p.name <> i.display_name;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'GATE0: % pozitsiyada nom <> display_name', v_bad;
  END IF;

  --------------------------------------------------------------------------
  -- GATE 1 — bir-martalik qulf (LATCH): C-15 hali MAPPED bo'lishi SHART
  --------------------------------------------------------------------------
  PERFORM 1 FROM physical_baselines
   WHERE id = 9 AND container_label = 'C-15' AND warehouse_id = 21
     AND count_date = DATE '2026-08-16' AND positions_count = 3
     AND total_weight_kg = 13020.00 AND status = 'MAPPED'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LATCH: C-15 (id=9) MAPPED holatda topilmadi — allaqachon LOADED yoki qoziqlar mos emas. HECH NARSA YOZILMADI.';
  END IF;

  --------------------------------------------------------------------------
  -- GATE 2 — qulfdan keyingi tozalik (dublikat yuklash himoyasi)
  --------------------------------------------------------------------------
  SELECT COUNT(*) INTO v_cnt FROM stock_movements WHERE movement_type = 'BASELINE';
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'GATE2: bazada allaqachon % BASELINE harakat bor', v_cnt;
  END IF;

  SELECT COUNT(*) INTO v_cnt FROM stock_movements
   WHERE from_warehouse_id = 21 OR to_warehouse_id = 21;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'GATE2: C-15 (wid=21) bo''yicha % harakat allaqachon bor', v_cnt;
  END IF;

  SELECT COUNT(*) INTO v_cnt FROM inventory WHERE warehouse_id = 21;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'GATE2: C-15 inventari bo''sh emas (% satr)', v_cnt;
  END IF;

  SELECT COUNT(*) INTO v_cnt FROM inventory
   WHERE item_id IN (93, 94, 95)
      OR product IN ('Polipropilen CF 1000D Qizil', 'Polipropilen CF 1000D Ko''k', 'Polipropilen CF 1000D Sariq');
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'GATE2: bu itemlar bo''yicha inventar izi bor (%)', v_cnt;
  END IF;

  SELECT COUNT(*) INTO v_cnt FROM stock_movements
   WHERE item_id IN (93, 94, 95)
      OR product IN ('Polipropilen CF 1000D Qizil', 'Polipropilen CF 1000D Ko''k', 'Polipropilen CF 1000D Sariq');
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'GATE2: bu itemlar bo''yicha harakat izi bor (%)', v_cnt;
  END IF;

  --------------------------------------------------------------------------
  -- BEFORE-SNAPSHOT — «tegilmaydi» kafolatlari (txn oxirida solishtiriladi)
  --------------------------------------------------------------------------
  SELECT COUNT(*), COALESCE(SUM(quantity),0), COALESCE(SUM(weight_kg),0)
    INTO v_inv_o_rows, v_inv_o_qty, v_inv_o_kg
    FROM inventory WHERE warehouse_id <> 21;
  SELECT COUNT(*) INTO v_mov_before FROM stock_movements;
  SELECT COUNT(*), COALESCE(SUM(current_stock),0) INTO v_rm_cnt, v_rm_sum FROM raw_materials;
  SELECT COUNT(*) INTO v_lg_inv  FROM legacy.inventory_baseline_pre;
  SELECT COUNT(*) INTO v_lg_cont FROM legacy.container_summary_pre;
  SELECT COUNT(*) INTO v_lg_raw  FROM legacy.raw_material_stock_pre;
  SELECT COUNT(*) INTO v_lg_wip  FROM legacy.wip_balances_pre;
  SELECT COUNT(*) INTO v_sales  FROM sales;
  SELECT COUNT(*) INTO v_sitems FROM sale_items;

  --------------------------------------------------------------------------
  -- YOZUV 1 — 3 ta BASELINE harakat (manba: muzlatilgan registr)
  --------------------------------------------------------------------------
  INSERT INTO stock_movements
    (product, quantity, movement_type, from_warehouse_id, to_warehouse_id,
     note, created_by, product_type, item_id, weight_kg, reference, reason)
  SELECT i.display_name,
         0,
         'BASELINE',
         NULL,
         21,
         'R-D BASELINE C-15 · ' || i.sku || ' ' || i.display_name || ' · ' || to_char(p.weight_kg, 'FM999990.00') || ' kg',
         'thisismurodov',
         'raw',
         p.item_id,
         p.weight_kg,
         'R-B: physical_baseline_positions pos=' || p.position_no || ' · docs/r-b-mapping-preview-2026-08-17.md',
         'R-D baseline yuklash C-15 — fizik sanoq 2026-08-16'
    FROM physical_baseline_positions p
    JOIN items i ON i.id = p.item_id
   WHERE p.baseline_id = 9
   ORDER BY p.position_no;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 3 THEN
    RAISE EXCEPTION 'YOZUV1: % harakat yozildi (3 kutildi)', v_cnt;
  END IF;

  --------------------------------------------------------------------------
  -- YOZUV 2 — 3 ta inventar satri
  --------------------------------------------------------------------------
  INSERT INTO inventory (warehouse_id, product, quantity, product_type, weight_kg, item_id)
  SELECT 21, i.display_name, 0, 'raw', p.weight_kg, p.item_id
    FROM physical_baseline_positions p
    JOIN items i ON i.id = p.item_id
   WHERE p.baseline_id = 9
   ORDER BY p.position_no;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 3 THEN
    RAISE EXCEPTION 'YOZUV2: % inventar satri yozildi (3 kutildi)', v_cnt;
  END IF;

  --------------------------------------------------------------------------
  -- YOZUV 3 — status MAPPED → LOADED (trigger faqat shu o'tishga ruxsat beradi)
  --------------------------------------------------------------------------
  UPDATE physical_baselines SET status = 'LOADED' WHERE id = 9 AND status = 'MAPPED';
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'YOZUV3: status yangilanishi % satr (1 kutildi)', v_cnt;
  END IF;

  --------------------------------------------------------------------------
  -- VERIFIKATSIYA 9.1–9.10 (birortasi FAIL = to'liq ROLLBACK)
  --------------------------------------------------------------------------
  -- 9.1 C-15 inventari: kutilma bilan to'liq solishtiruv (0 farq)
  SELECT COUNT(*) INTO v_bad FROM (
    SELECT e.product AS ep, a.product AS ap
      FROM (VALUES
        ('Polipropilen CF 1000D Qizil', 0::numeric, 3720.00::numeric, 'raw', 93),
        ('Polipropilen CF 1000D Ko''k',  0::numeric, 3840.00::numeric, 'raw', 94),
        ('Polipropilen CF 1000D Sariq', 0::numeric, 5460.00::numeric, 'raw', 95)
      ) e(product, quantity, weight_kg, product_type, item_id)
      FULL JOIN (SELECT product, quantity, weight_kg, product_type, item_id
                   FROM inventory WHERE warehouse_id = 21) a
        ON  a.product = e.product AND a.quantity = e.quantity
        AND a.weight_kg = e.weight_kg AND a.product_type = e.product_type
        AND a.item_id = e.item_id
     WHERE e.product IS NULL OR a.product IS NULL
  ) x;
  IF v_bad <> 0 THEN RAISE EXCEPTION '9.1 FAIL: C-15 inventari kutilmadan % farq', v_bad; END IF;

  -- 9.2 C-15 inventar yig'indilari
  SELECT COUNT(*), COALESCE(SUM(quantity),0), COALESCE(SUM(weight_kg),0)
    INTO v_cnt, v_qty, v_sum FROM inventory WHERE warehouse_id = 21;
  IF v_cnt <> 3 OR v_qty <> 0 OR v_sum <> 13020.00 THEN
    RAISE EXCEPTION '9.2 FAIL: C-15 inventari %/%/% (3/0/13020.00 kutildi)', v_cnt, v_qty, v_sum;
  END IF;

  -- 9.3 BASELINE harakatlar: kutilma bilan to'liq solishtiruv (0 farq)
  SELECT COUNT(*) INTO v_bad FROM (
    SELECT e.product AS ep, a.product AS ap
      FROM (VALUES
        ('Polipropilen CF 1000D Qizil', 93, 3720.00::numeric, 'R-B: physical_baseline_positions pos=95 · docs/r-b-mapping-preview-2026-08-17.md'),
        ('Polipropilen CF 1000D Ko''k',  94, 3840.00::numeric, 'R-B: physical_baseline_positions pos=96 · docs/r-b-mapping-preview-2026-08-17.md'),
        ('Polipropilen CF 1000D Sariq', 95, 5460.00::numeric, 'R-B: physical_baseline_positions pos=97 · docs/r-b-mapping-preview-2026-08-17.md')
      ) e(product, item_id, weight_kg, reference)
      FULL JOIN (SELECT product, item_id, weight_kg, reference
                   FROM stock_movements
                  WHERE movement_type = 'BASELINE' AND to_warehouse_id = 21
                    AND from_warehouse_id IS NULL AND quantity = 0
                    AND product_type = 'raw' AND created_by = 'thisismurodov'
                    AND reason = 'R-D baseline yuklash C-15 — fizik sanoq 2026-08-16') a
        ON  a.product = e.product AND a.item_id = e.item_id
        AND a.weight_kg = e.weight_kg AND a.reference = e.reference
     WHERE e.product IS NULL OR a.product IS NULL
  ) x;
  IF v_bad <> 0 THEN RAISE EXCEPTION '9.3 FAIL: BASELINE harakatlar kutilmadan % farq', v_bad; END IF;

  -- 9.4 BASELINE harakat yig'indilari (butun jadvalda ham faqat shu 3 ta)
  SELECT COUNT(*), COALESCE(SUM(weight_kg),0) INTO v_cnt, v_sum
    FROM stock_movements WHERE movement_type = 'BASELINE';
  IF v_cnt <> 3 OR v_sum <> 13020.00 THEN
    RAISE EXCEPTION '9.4 FAIL: BASELINE %/% (3/13020.00 kutildi)', v_cnt, v_sum;
  END IF;

  -- 9.5 Status: C-15 LOADED, qolgan 8 ta MAPPED
  SELECT COUNT(*) FILTER (WHERE status = 'LOADED' AND id = 9),
         COUNT(*) FILTER (WHERE status = 'MAPPED')
    INTO v_cnt, v_bad FROM physical_baselines;
  IF v_cnt <> 1 OR v_bad <> 8 THEN
    RAISE EXCEPTION '9.5 FAIL: statuslar LOADED(id9)=% MAPPED=% (1/8 kutildi)', v_cnt, v_bad;
  END IF;

  -- 9.6 Registr o'zgarmagan (97 satr / yig'indilar / items 94)
  SELECT COUNT(*), SUM(COALESCE(weight_kg,0)),
         COALESCE(SUM(quantity) FILTER (WHERE unit = 'dona'), 0)
    INTO v_cnt, v_sum, v_dona FROM physical_baseline_positions;
  IF v_cnt <> 97 OR v_sum <> 71862.20 OR v_dona <> 126360.00 THEN
    RAISE EXCEPTION '9.6 FAIL: registr o''zgargan %/%/%', v_cnt, v_sum, v_dona;
  END IF;
  SELECT COUNT(*) INTO v_cnt FROM items;
  IF v_cnt <> 94 THEN RAISE EXCEPTION '9.6 FAIL: items soni %', v_cnt; END IF;

  -- 9.7 Boshqa joylar inventari o'zgarmagan
  SELECT COUNT(*), COALESCE(SUM(quantity),0), COALESCE(SUM(weight_kg),0)
    INTO v_cnt, v_qty, v_sum FROM inventory WHERE warehouse_id <> 21;
  IF v_cnt <> v_inv_o_rows OR v_qty <> v_inv_o_qty OR v_sum <> v_inv_o_kg THEN
    RAISE EXCEPTION '9.7 FAIL: boshqa joylar inventari o''zgargan';
  END IF;

  -- 9.8 Harakatlar: aynan +3
  SELECT COUNT(*) INTO v_cnt FROM stock_movements;
  IF v_cnt <> v_mov_before + 3 THEN
    RAISE EXCEPTION '9.8 FAIL: harakatlar % (%+3 kutildi)', v_cnt, v_mov_before;
  END IF;

  -- 9.9 Legacy + sales tegilmagan
  SELECT COUNT(*) INTO v_cnt FROM legacy.inventory_baseline_pre;
  IF v_cnt <> v_lg_inv THEN RAISE EXCEPTION '9.9 FAIL: legacy.inventory_baseline_pre o''zgargan'; END IF;
  SELECT COUNT(*) INTO v_cnt FROM legacy.container_summary_pre;
  IF v_cnt <> v_lg_cont THEN RAISE EXCEPTION '9.9 FAIL: legacy.container_summary_pre o''zgargan'; END IF;
  SELECT COUNT(*) INTO v_cnt FROM legacy.raw_material_stock_pre;
  IF v_cnt <> v_lg_raw THEN RAISE EXCEPTION '9.9 FAIL: legacy.raw_material_stock_pre o''zgargan'; END IF;
  SELECT COUNT(*) INTO v_cnt FROM legacy.wip_balances_pre;
  IF v_cnt <> v_lg_wip THEN RAISE EXCEPTION '9.9 FAIL: legacy.wip_balances_pre o''zgargan'; END IF;
  SELECT COUNT(*) INTO v_cnt FROM sales;
  IF v_cnt <> v_sales THEN RAISE EXCEPTION '9.9 FAIL: sales o''zgargan'; END IF;
  SELECT COUNT(*) INTO v_cnt FROM sale_items;
  IF v_cnt <> v_sitems THEN RAISE EXCEPTION '9.9 FAIL: sale_items o''zgargan'; END IF;

  -- 9.10 raw_materials tegilmagan
  SELECT COUNT(*), COALESCE(SUM(current_stock),0) INTO v_cnt, v_sum FROM raw_materials;
  IF v_cnt <> v_rm_cnt OR v_sum <> v_rm_sum THEN
    RAISE EXCEPTION '9.10 FAIL: raw_materials o''zgargan';
  END IF;

  RAISE NOTICE 'R-D C-15: 9.1-9.10 BARCHASI PASS — 3 BASELINE harakat + 3 inventar satri + status LOADED';
END
$rd$;

COMMIT;
