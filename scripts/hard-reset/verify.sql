-- =============================================================================
-- TOPMART HARD RESET — YAKUNIY HOLAT TEKSHIRUVI (faqat SELECT)
-- Rehearsal klonida ham, real GO'dan keyin prod'da ham ishlatiladi.
-- =============================================================================
\set ON_ERROR_STOP on

\echo ''
\echo '=== 1. INVENTAR HOLATI ==='
SELECT
  CASE WHEN warehouse_id = ANY (ARRAY[8,10,12,21,22,23,24,25,26]) THEN 'BASELINE-9' ELSE 'BOSHQA' END AS guruh,
  count(*)                                  AS satrlar,
  count(*) FILTER (WHERE quantity <> 0 OR COALESCE(weight_kg,0) <> 0) AS nol_emas,
  COALESCE(sum(quantity),0)                 AS jami_dona,
  COALESCE(sum(weight_kg),0)                AS jami_kg
FROM public.inventory
GROUP BY 1 ORDER BY 1;

\echo ''
\echo '=== 2. OMBOR HARAKATLARI ==='
SELECT
  CASE
    WHEN movement_type = 'BASELINE' THEN 'BASELINE (guvohnoma)'
    WHEN note LIKE 'Savdo%' THEN 'SAVDO-IZLI'
    WHEN created_at > '2026-08-17 09:38:34.18822+00'::timestamptz THEN 'YANGI DAVR'
    ELSE 'LEGACY (0 bolishi kerak!)'
  END AS turkum,
  count(*) AS soni
FROM public.stock_movements
GROUP BY 1 ORDER BY 1;

\echo ''
\echo '=== 3. PARTIYALAR ==='
SELECT count(*) AS jami,
       count(*) FILTER (WHERE created_at <= '2026-08-17 09:38:34.18822+00'::timestamptz) AS legacy_qolgan_0_bolsin,
       count(*) FILTER (WHERE created_at >  '2026-08-17 09:38:34.18822+00'::timestamptz) AS yangi_davr
FROM public.batches;
SELECT id, batch_code, worker, product, quantity FROM public.batches ORDER BY id;

\echo ''
\echo '=== 4. WIP VA XOMASHYO ==='
SELECT (SELECT count(*) FROM public.wip_movements)                        AS wip_yozuvlar,
       (SELECT COALESCE(sum(CASE WHEN movement_type='RECEIVE' THEN weight_kg ELSE -weight_kg END),0)
          FROM public.wip_movements)                                      AS wip_balans_kg,
       (SELECT count(*) FROM public.wip_negative_alerts)                  AS alertlar,
       (SELECT count(*) FROM public.raw_materials WHERE current_stock<>0) AS xomashyo_nol_emas;

\echo ''
\echo '=== 5. SAVDO INVARIANTLARI (dry-run bilan solishtiring) ==='
SELECT 'public.sales' AS jadval, count(*)::text AS qiymat FROM public.sales
UNION ALL SELECT 'sales sum(total_amount)', COALESCE(sum(total_amount),0)::text FROM public.sales
UNION ALL SELECT 'sale_items', count(*)::text FROM public.sale_items
UNION ALL SELECT 'sale_payments', count(*)::text FROM public.sale_payments
UNION ALL SELECT 'sale_payments sum', COALESCE(sum(amount),0)::text FROM public.sale_payments
UNION ALL SELECT 'sale_events', count(*)::text FROM public.sale_events
UNION ALL SELECT 'customers', count(*)::text FROM public.customers
UNION ALL SELECT 'distribution.savdolar', count(*)::text FROM distribution.savdolar
UNION ALL SELECT 'savdolar sum(jami_summa)', COALESCE(sum(jami_summa),0)::text FROM distribution.savdolar
UNION ALL SELECT 'savdo_tafsilot', count(*)::text FROM distribution.savdo_tafsilot
UNION ALL SELECT 'dokonlar', count(*)::text FROM distribution.dokonlar
UNION ALL SELECT 'mahsulotlar (bot)', count(*)::text FROM distribution.mahsulotlar;

\echo ''
\echo '=== 6. ARXIVLAR ==='
SELECT 'legacy.stock_movements_pre_reset_20260817' AS arxiv, count(*)::text AS satr FROM legacy.stock_movements_pre_reset_20260817
UNION ALL SELECT 'legacy.batches_pre_reset_20260817', count(*)::text FROM legacy.batches_pre_reset_20260817
UNION ALL SELECT 'legacy.wip_movements_pre_reset_20260817', count(*)::text FROM legacy.wip_movements_pre_reset_20260817
UNION ALL SELECT 'legacy.wip_negative_alerts_pre_reset_20260817', count(*)::text FROM legacy.wip_negative_alerts_pre_reset_20260817
UNION ALL SELECT 'legacy.inventory_legacy_rows_pre_reset_20260817', count(*)::text FROM legacy.inventory_legacy_rows_pre_reset_20260817
UNION ALL SELECT 'legacy.raw_material_stock_pre_reset_20260817', count(*)::text FROM legacy.raw_material_stock_pre_reset_20260817
UNION ALL SELECT 'legacy.container_summary_pre (R-A)', count(*)::text FROM legacy.container_summary_pre
UNION ALL SELECT 'legacy.inventory_baseline_pre (R-A)', count(*)::text FROM legacy.inventory_baseline_pre;

\echo ''
\echo '=== 7. POYDEVOR (o''zgarmasligi kerak) ==='
SELECT (SELECT count(*) FROM public.items)                        AS items_94,
       (SELECT count(*) FROM public.physical_baselines)           AS registr_9,
       (SELECT count(*) FROM public.physical_baseline_positions)  AS pozitsiyalar_97,
       (SELECT count(*) FROM public.products)                     AS products_117,
       (SELECT count(*) FROM public.product_materials)            AS bom_62,
       (SELECT count(*) FROM public.warehouses)                   AS omborlar_36,
       (SELECT count(*) FROM public.salary_entries)               AS oylik_tarixi_29;
