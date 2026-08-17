-- =============================================================================
-- TOPMART ERP — PRODUCTION/WAREHOUSE HARD RESET — GO SKRIPTI
-- Manba hujjat: docs/hard-reset-dry-run-2026-08-17.md (muhrlangan dry-run)
-- Ishga tushirish: FAQAT owner «RESET GO» bergandan keyin, run-reset-go.sh orqali.
--
-- Kafolatlar:
--   * BUTUN ish BITTA tranzaksiyada — istalgan tekshiruv yiqilsa hamma narsa ROLLBACK.
--   * Savdo jadvallariga (public.sales*, customers, distribution.*) BITTA ham
--     yozuv operatori YO'Q — statik tekshirish mumkin.
--   * Destruksiya faqat arxiv jadvallar orqali id-pinned (USING legacy.*).
--   * CASCADE/TRUNCATE ishlatilmaydi.
-- =============================================================================
\set ON_ERROR_STOP on

-- §G0: arxiv jadvallar oldindan mavjud bo'lmasligi kerak (qayta ishga tushirishdan himoya)
DO $$
BEGIN
  IF to_regclass('legacy.stock_movements_pre_reset_20260817') IS NOT NULL
   OR to_regclass('legacy.batches_pre_reset_20260817') IS NOT NULL
   OR to_regclass('legacy.wip_movements_pre_reset_20260817') IS NOT NULL
   OR to_regclass('legacy.wip_negative_alerts_pre_reset_20260817') IS NOT NULL
   OR to_regclass('legacy.inventory_legacy_rows_pre_reset_20260817') IS NOT NULL
   OR to_regclass('legacy.raw_material_stock_pre_reset_20260817') IS NOT NULL THEN
    RAISE EXCEPTION 'G0 STOP: reset arxiv jadvallari allaqachon mavjud — skript avval ishlatilgan. Qo''lda tekshiring.';
  END IF;
END $$;

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;

-- §G1: MUZLATISH — snapshot OLDIDAN lock (v2 qoidasi)
LOCK TABLE public.inventory            IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.stock_movements      IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.batches              IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.wip_movements        IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.raw_materials        IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.wip_negative_alerts  IN SHARE ROW EXCLUSIVE MODE;

-- §G2: konstantalar (dry-run hujjatidan muhrlangan)
CREATE TEMP TABLE _cfg AS SELECT
  '2026-08-17 09:38:34.18822+00'::timestamptz          AS cutoff,
  ARRAY[8,10,12,21,22,23,24,25,26]::int[]              AS base9;

-- §G3: PRE-SNAPSHOT — skript o'zi hech narsani buzmaganini isbotlash uchun
CREATE TEMP TABLE _before AS SELECT
  (SELECT count(*) FROM public.sales)                                        AS sales_n,
  (SELECT count(*) FROM public.sale_items)                                   AS sale_items_n,
  (SELECT count(*) FROM public.sale_payments)                                AS sale_payments_n,
  (SELECT count(*) FROM public.sale_events)                                  AS sale_events_n,
  (SELECT count(*) FROM public.customers)                                    AS customers_n,
  (SELECT coalesce(sum(total_amount),0) FROM public.sales)                   AS sales_sum,
  (SELECT count(*) FROM distribution.savdolar)                               AS savdolar_n,
  (SELECT coalesce(sum(jami_summa),0) FROM distribution.savdolar)            AS savdolar_sum,
  (SELECT count(*) FROM distribution.savdo_tafsilot)                         AS tafsilot_n,
  (SELECT count(*) FROM distribution.dokonlar)                               AS dokonlar_n,
  (SELECT coalesce(sum(quantity),0) FROM public.inventory i, _cfg c
    WHERE i.warehouse_id = ANY(c.base9))                                     AS base9_qty,
  (SELECT coalesce(sum(weight_kg),0) FROM public.inventory i, _cfg c
    WHERE i.warehouse_id = ANY(c.base9))                                     AS base9_kg,
  (SELECT count(*) FROM public.wip_negative_alerts)                          AS alerts_n;

-- §G4: SALES PRE-GATE — dry-run'dagi muhrlangan minimal qiymatlar (kamayish = STOP)
DO $$
DECLARE b _before%ROWTYPE;
BEGIN
  SELECT * INTO b FROM _before;
  IF b.sales_n        < 45          THEN RAISE EXCEPTION 'G4 STOP: sales % < 45 — savdo satri YO''QOLGAN', b.sales_n; END IF;
  IF b.sale_items_n   < 143         THEN RAISE EXCEPTION 'G4 STOP: sale_items % < 143', b.sale_items_n; END IF;
  IF b.sale_payments_n< 10          THEN RAISE EXCEPTION 'G4 STOP: sale_payments % < 10', b.sale_payments_n; END IF;
  IF b.customers_n    < 31          THEN RAISE EXCEPTION 'G4 STOP: customers % < 31', b.customers_n; END IF;
  IF b.savdolar_n     < 193         THEN RAISE EXCEPTION 'G4 STOP: distribution.savdolar % < 193', b.savdolar_n; END IF;
  IF b.savdolar_sum   < 66653390    THEN RAISE EXCEPTION 'G4 STOP: savdolar summa % < 66 653 390', b.savdolar_sum; END IF;
  IF b.tafsilot_n     < 497         THEN RAISE EXCEPTION 'G4 STOP: savdo_tafsilot % < 497', b.tafsilot_n; END IF;
  IF b.dokonlar_n     < 280         THEN RAISE EXCEPTION 'G4 STOP: dokonlar % < 280', b.dokonlar_n; END IF;
  RAISE NOTICE 'G4 OK: savdo invariantlari joyida (sales=%, bot savdolar=%, summa=%)', b.sales_n, b.savdolar_n, b.savdolar_sum;
END $$;

-- =============================================================================
-- §G5: ARXIV (append-only nusxalar) — destruksiya FAQAT shu jadvallar orqali
-- =============================================================================

-- 5.1 Legacy ombor harakatlari: kesimgacha, BASELINE emas, savdoga bog'lanmagan
CREATE TABLE legacy.stock_movements_pre_reset_20260817 AS
SELECT sm.* FROM public.stock_movements sm, _cfg c
WHERE sm.created_at <= c.cutoff
  AND sm.movement_type <> 'BASELINE'
  AND COALESCE(sm.note,'') NOT LIKE 'Savdo%';

-- 5.2 Legacy partiyalar: kesimgacha (bugungi yangi-davr 283/284 KIRMAYDI — D1)
CREATE TABLE legacy.batches_pre_reset_20260817 AS
SELECT b.* FROM public.batches b, _cfg c WHERE b.created_at <= c.cutoff;

-- 5.3 WIP ledger: kesimgacha (hammasi bir tomonlama legacy)
CREATE TABLE legacy.wip_movements_pre_reset_20260817 AS
SELECT w.* FROM public.wip_movements w, _cfg c WHERE w.created_at <= c.cutoff;

-- 5.4 WIP alertlar (hosila ma'lumot — to'liq arxiv)
CREATE TABLE legacy.wip_negative_alerts_pre_reset_20260817 AS
SELECT * FROM public.wip_negative_alerts;

-- 5.5 Legacy inventar satrlari: 9 baseline konteynerdan TASHQARIDA, nol bo'lmagan
CREATE TABLE legacy.inventory_legacy_rows_pre_reset_20260817 AS
SELECT i.* FROM public.inventory i, _cfg c
WHERE NOT (i.warehouse_id = ANY(c.base9))
  AND (i.quantity <> 0 OR COALESCE(i.weight_kg,0) <> 0);

-- 5.6 Xomashyo eski stock qiymatlari (katalog satrlari SAQLANADI, faqat raqamlar 0)
CREATE TABLE legacy.raw_material_stock_pre_reset_20260817 AS
SELECT * FROM public.raw_materials;

-- §G6: ARXIV TASDIQ — dry-run'da muhrlangan aniq sonlar (kesim yopiq to'plamlar!)
DO $$
DECLARE n bigint; b _before%ROWTYPE;
BEGIN
  SELECT * INTO b FROM _before;
  SELECT count(*) INTO n FROM legacy.stock_movements_pre_reset_20260817;
  IF n <> 583 THEN RAISE EXCEPTION 'G6 STOP: legacy harakatlar arxivi % <> 583', n; END IF;
  SELECT count(*) INTO n FROM legacy.batches_pre_reset_20260817;
  IF n <> 280 THEN RAISE EXCEPTION 'G6 STOP: legacy partiyalar arxivi % <> 280', n; END IF;
  SELECT count(*) INTO n FROM legacy.wip_movements_pre_reset_20260817;
  IF n <> 171 THEN RAISE EXCEPTION 'G6 STOP: WIP arxivi % <> 171', n; END IF;
  SELECT count(*) INTO n FROM legacy.inventory_legacy_rows_pre_reset_20260817;
  IF n <> 30 THEN RAISE EXCEPTION 'G6 STOP: legacy inventar satrlari % <> 30 — yangi satr paydo bo''lgan, qo''lda ko''rib chiqing', n; END IF;
  SELECT count(*) INTO n FROM legacy.raw_material_stock_pre_reset_20260817;
  IF n <> 17 THEN RAISE EXCEPTION 'G6 STOP: raw_materials arxivi % <> 17', n; END IF;
  SELECT count(*) INTO n FROM legacy.wip_negative_alerts_pre_reset_20260817;
  IF n <> b.alerts_n THEN RAISE EXCEPTION 'G6 STOP: alert arxivi % <> jonli %', n, b.alerts_n; END IF;
  -- Savdoga bog'liq harakatlar arxivga KIRMAGANINI isbotlash
  SELECT count(*) INTO n FROM legacy.stock_movements_pre_reset_20260817 WHERE note LIKE 'Savdo%';
  IF n <> 0 THEN RAISE EXCEPTION 'G6 STOP: arxivda % ta savdo-harakat — TAQIQ', n; END IF;
  SELECT count(*) INTO n FROM legacy.stock_movements_pre_reset_20260817 WHERE movement_type = 'BASELINE';
  IF n <> 0 THEN RAISE EXCEPTION 'G6 STOP: arxivda % ta BASELINE harakat — TAQIQ', n; END IF;
  RAISE NOTICE 'G6 OK: arxivlar to''liq (583 harakat / 280 partiya / 171 WIP / 30 inventar / 17 xomashyo / % alert)', b.alerts_n;
END $$;

-- =============================================================================
-- §G7: DESTRUKSIYA (faqat arxiv orqali, id-pinned)
-- =============================================================================

-- 7.1 30 legacy inventar satri: AUDITLI 0-lash (satr o'chirilmaydi — D4)
--     Har satr uchun eski qiymatni qayd etuvchi BASELINE harakat yoziladi (R-D naqshi)
INSERT INTO public.stock_movements
  (product, quantity, movement_type, from_warehouse_id, to_warehouse_id,
   note, created_by, product_type, item_id, weight_kg, reference, reason)
SELECT
  a.product,
  a.quantity,
  'BASELINE',
  a.warehouse_id,
  NULL,
  format('HARD RESET 2026-08-17 · legacy satr 0-landi · eski qiymat: %s dona / %s kg · inventory.id=%s',
         a.quantity, COALESCE(a.weight_kg,0), a.id),
  'reset-go (owner RESET GO)',
  COALESCE(a.product_type, 'finished'),
  a.item_id,
  a.weight_kg,
  'docs/hard-reset-dry-run-2026-08-17.md',
  'HARD RESET Phase 3 — legacy konteyner qoldiqlarini auditli 0-lash'
FROM legacy.inventory_legacy_rows_pre_reset_20260817 a;

UPDATE public.inventory i
SET quantity = 0, weight_kg = 0, updated_at = now()
FROM legacy.inventory_legacy_rows_pre_reset_20260817 a
WHERE i.id = a.id;

-- 7.2 Legacy harakatlar / partiyalar / WIP / alertlar — id-pinned DELETE
DELETE FROM public.stock_movements sm
USING legacy.stock_movements_pre_reset_20260817 a WHERE sm.id = a.id;

DELETE FROM public.batches b
USING legacy.batches_pre_reset_20260817 a WHERE b.id = a.id;

DELETE FROM public.wip_movements w
USING legacy.wip_movements_pre_reset_20260817 a WHERE w.id = a.id;

DELETE FROM public.wip_negative_alerts;  -- to'liq arxivlangan hosila jadval (id ustuni yo'q)

-- 7.3 Xomashyo eski stock raqamlari → 0 (satrlar/BOM saqlanadi; eski qiymatlar arxivda)
UPDATE public.raw_materials SET current_stock = 0 WHERE current_stock <> 0;

-- =============================================================================
-- §G8: POST-GATE — yakuniy holat tekshiruvi (yiqilsa → to'liq ROLLBACK)
-- =============================================================================
DO $$
DECLARE b _before%ROWTYPE; cfg _cfg%ROWTYPE; n bigint; q numeric; w numeric;
BEGIN
  SELECT * INTO b FROM _before;
  SELECT * INTO cfg FROM _cfg;

  -- 8.1 Legacy to'liq yo'qolgan
  SELECT count(*) INTO n FROM public.stock_movements sm
   WHERE sm.created_at <= cfg.cutoff AND sm.movement_type <> 'BASELINE' AND COALESCE(sm.note,'') NOT LIKE 'Savdo%';
  IF n <> 0 THEN RAISE EXCEPTION 'G8 STOP: % ta legacy harakat qolgan', n; END IF;
  SELECT count(*) INTO n FROM public.batches WHERE created_at <= cfg.cutoff;
  IF n <> 0 THEN RAISE EXCEPTION 'G8 STOP: % ta legacy partiya qolgan', n; END IF;
  SELECT count(*) INTO n FROM public.wip_movements WHERE created_at <= cfg.cutoff;
  IF n <> 0 THEN RAISE EXCEPTION 'G8 STOP: % ta legacy WIP qolgan', n; END IF;
  SELECT count(*) INTO n FROM public.raw_materials WHERE current_stock <> 0;
  IF n <> 0 THEN RAISE EXCEPTION 'G8 STOP: % ta xomashyo stock <> 0', n; END IF;
  SELECT count(*) INTO n FROM public.wip_negative_alerts;
  IF n <> 0 THEN RAISE EXCEPTION 'G8 STOP: % ta alert qolgan', n; END IF;
  SELECT count(*) INTO n FROM public.inventory i
   WHERE NOT (i.warehouse_id = ANY(cfg.base9)) AND (i.quantity <> 0 OR COALESCE(i.weight_kg,0) <> 0);
  IF n <> 0 THEN RAISE EXCEPTION 'G8 STOP: baseline''dan tashqarida % ta nol bo''lmagan satr', n; END IF;

  -- 8.2 Saqlanishi SHART bo'lganlar joyida
  SELECT count(*) INTO n FROM public.stock_movements WHERE movement_type = 'BASELINE' AND created_at <= cfg.cutoff;
  IF n <> 110 THEN RAISE EXCEPTION 'G8 STOP: BASELINE harakatlar % <> 110', n; END IF;
  SELECT count(*) INTO n FROM public.stock_movements WHERE note LIKE 'Savdo%' AND created_at <= cfg.cutoff;
  IF n <> 37 THEN RAISE EXCEPTION 'G8 STOP: savdo-harakatlar % <> 37', n; END IF;
  SELECT count(*) INTO n FROM public.batches WHERE id IN (283, 284);
  IF n <> 2 THEN RAISE EXCEPTION 'G8 STOP: bugungi yangi-davr partiyalari (283/284) topilmadi (soni: %) — D1 buzilgan!', n; END IF;

  -- 8.3 Baseline-9 konteynerlarga UMUMAN tegilmagan (skript-o'z-integriteti)
  SELECT coalesce(sum(quantity),0), coalesce(sum(weight_kg),0) INTO q, w
    FROM public.inventory i WHERE i.warehouse_id = ANY(cfg.base9);
  IF q <> b.base9_qty OR w <> b.base9_kg THEN
    RAISE EXCEPTION 'G8 STOP: baseline-9 o''zgargan! qty %->%, kg %->%', b.base9_qty, q, b.base9_kg, w;
  END IF;

  -- 8.4 SAVDO POST-GATE: skript savdo ma'lumotlarini o'zgartirmagan
  IF (SELECT count(*) FROM public.sales)         <> b.sales_n         THEN RAISE EXCEPTION 'G8 STOP: sales o''zgargan'; END IF;
  IF (SELECT count(*) FROM public.sale_items)    <> b.sale_items_n    THEN RAISE EXCEPTION 'G8 STOP: sale_items o''zgargan'; END IF;
  IF (SELECT count(*) FROM public.sale_payments) <> b.sale_payments_n THEN RAISE EXCEPTION 'G8 STOP: sale_payments o''zgargan'; END IF;
  IF (SELECT count(*) FROM public.sale_events)   <> b.sale_events_n   THEN RAISE EXCEPTION 'G8 STOP: sale_events o''zgargan'; END IF;
  IF (SELECT count(*) FROM public.customers)     <> b.customers_n     THEN RAISE EXCEPTION 'G8 STOP: customers o''zgargan'; END IF;
  IF (SELECT coalesce(sum(total_amount),0) FROM public.sales) <> b.sales_sum THEN RAISE EXCEPTION 'G8 STOP: sales summa o''zgargan'; END IF;
  IF (SELECT count(*) FROM distribution.savdolar)       <> b.savdolar_n  THEN RAISE EXCEPTION 'G8 STOP: bot savdolar o''zgargan'; END IF;
  IF (SELECT coalesce(sum(jami_summa),0) FROM distribution.savdolar) <> b.savdolar_sum THEN RAISE EXCEPTION 'G8 STOP: bot summa o''zgargan'; END IF;
  IF (SELECT count(*) FROM distribution.savdo_tafsilot) <> b.tafsilot_n  THEN RAISE EXCEPTION 'G8 STOP: tafsilot o''zgargan'; END IF;
  IF (SELECT count(*) FROM distribution.dokonlar)       <> b.dokonlar_n  THEN RAISE EXCEPTION 'G8 STOP: dokonlar o''zgargan'; END IF;

  RAISE NOTICE 'G8 OK: post-gate to''liq o''tdi — baseline-9: % dona / % kg; savdo daxlsiz', q, w;
END $$;

-- §G9: arxiv jadvallarni muhrlash (mavjud legacy naqsh: no_touch_fn)
CREATE TRIGGER stock_movements_pre_reset_20260817_no_touch
  BEFORE UPDATE OR DELETE ON legacy.stock_movements_pre_reset_20260817
  FOR EACH ROW EXECUTE FUNCTION legacy.no_touch_fn();
CREATE TRIGGER stock_movements_pre_reset_20260817_no_truncate
  BEFORE TRUNCATE ON legacy.stock_movements_pre_reset_20260817
  FOR EACH STATEMENT EXECUTE FUNCTION legacy.no_touch_fn();
CREATE TRIGGER batches_pre_reset_20260817_no_touch
  BEFORE UPDATE OR DELETE ON legacy.batches_pre_reset_20260817
  FOR EACH ROW EXECUTE FUNCTION legacy.no_touch_fn();
CREATE TRIGGER batches_pre_reset_20260817_no_truncate
  BEFORE TRUNCATE ON legacy.batches_pre_reset_20260817
  FOR EACH STATEMENT EXECUTE FUNCTION legacy.no_touch_fn();
CREATE TRIGGER wip_movements_pre_reset_20260817_no_touch
  BEFORE UPDATE OR DELETE ON legacy.wip_movements_pre_reset_20260817
  FOR EACH ROW EXECUTE FUNCTION legacy.no_touch_fn();
CREATE TRIGGER wip_movements_pre_reset_20260817_no_truncate
  BEFORE TRUNCATE ON legacy.wip_movements_pre_reset_20260817
  FOR EACH STATEMENT EXECUTE FUNCTION legacy.no_touch_fn();
CREATE TRIGGER wip_negative_alerts_pre_reset_20260817_no_touch
  BEFORE UPDATE OR DELETE ON legacy.wip_negative_alerts_pre_reset_20260817
  FOR EACH ROW EXECUTE FUNCTION legacy.no_touch_fn();
CREATE TRIGGER wip_negative_alerts_pre_reset_20260817_no_truncate
  BEFORE TRUNCATE ON legacy.wip_negative_alerts_pre_reset_20260817
  FOR EACH STATEMENT EXECUTE FUNCTION legacy.no_touch_fn();
CREATE TRIGGER inventory_legacy_rows_pre_reset_20260817_no_touch
  BEFORE UPDATE OR DELETE ON legacy.inventory_legacy_rows_pre_reset_20260817
  FOR EACH ROW EXECUTE FUNCTION legacy.no_touch_fn();
CREATE TRIGGER inventory_legacy_rows_pre_reset_20260817_no_truncate
  BEFORE TRUNCATE ON legacy.inventory_legacy_rows_pre_reset_20260817
  FOR EACH STATEMENT EXECUTE FUNCTION legacy.no_touch_fn();
CREATE TRIGGER raw_material_stock_pre_reset_20260817_no_touch
  BEFORE UPDATE OR DELETE ON legacy.raw_material_stock_pre_reset_20260817
  FOR EACH ROW EXECUTE FUNCTION legacy.no_touch_fn();
CREATE TRIGGER raw_material_stock_pre_reset_20260817_no_truncate
  BEFORE TRUNCATE ON legacy.raw_material_stock_pre_reset_20260817
  FOR EACH STATEMENT EXECUTE FUNCTION legacy.no_touch_fn();

COMMIT;

\echo '=== HARD RESET GO — MUVAFFAQIYATLI YAKUNLANDI (COMMIT) ==='
