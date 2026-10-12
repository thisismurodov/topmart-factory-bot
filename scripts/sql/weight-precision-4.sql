-- Explicit release migration, not an automatic startup write.
-- Run once before enabling four-decimal profile editing in production.
-- Extends precision only: no stock/profile values or label identities are replaced.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('topmart-weight-precision-4'));
DO $$
DECLARE
  target RECORD;
  col RECORD;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('public','products','weight'),
    ('public','production_labels','weight_kg'),
    ('distribution','topmart_label_receipts','weight_kg'),
    ('distribution','topmart_external_purchase_receipts','total_weight_kg'),
    ('distribution','vehicle_handoff_items','unit_weight_kg'),
    ('distribution','vehicle_handoff_items','total_weight_kg'),
    ('distribution','vehicle_label_claims','unit_weight_kg'),
    ('distribution','vehicle_sale_allocations','allocated_weight_kg'),
    ('distribution','vehicle_reconciliation_items','expected_weight_kg'),
    ('distribution','vehicle_return_items','unit_weight_kg'),
    ('distribution','vehicle_return_items','return_weight_kg')
  ) AS t(schema_name,table_name,column_name)
  LOOP
    SELECT data_type,numeric_precision,numeric_scale INTO col
      FROM information_schema.columns
      WHERE table_schema=target.schema_name AND table_name=target.table_name
        AND column_name=target.column_name;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Missing weight migration target %.%.%',
        target.schema_name,target.table_name,target.column_name;
    END IF;
    IF col.data_type <> 'numeric' THEN
      RAISE EXCEPTION 'Unexpected weight column type: %',col.data_type;
    END IF;
    -- Unbounded NUMERIC or already-expanded columns need no ALTER.
    IF col.numeric_scale IS NOT NULL AND col.numeric_scale < 4 THEN
      EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I TYPE NUMERIC(%s,4)',
        target.schema_name,target.table_name,target.column_name,
        GREATEST(13,col.numeric_precision-col.numeric_scale+4));
    END IF;
  END LOOP;
END $$;
COMMIT;
