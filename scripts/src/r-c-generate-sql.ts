// =============================================================================
// R-C SQL GENERATOR — docs/r-c-final-preview-2026-08-17.md §4 jadvalidan
// bitta tranzaksiyali ijro SQL faylini yaratadi.
//
// MUHIM: bu skript BAZAGA ULANMAYDI — faqat md o'qiydi, SQL fayl yozadi.
// Ijro alohida qadam: psql -v ON_ERROR_STOP=1 -f scripts/sql/r-c-execution-2026-08-17.sql
//
// Nomlar/sonlar preview jadvalidan BYTE-DARAJADA verbatim olinadi (apostrof
// variantlari ‘ ’ ' va probelli minglik ajratkichlar saqlanadi) — egasining
// "Physical-count nomlari verbatim" qoidasi.
// =============================================================================
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PREVIEW = path.join(ROOT, "docs/r-c-final-preview-2026-08-17.md");
const OUT = path.join(ROOT, "scripts/sql/r-c-execution-2026-08-17.sql");

const CREATED_BY = "thisismurodov"; // egasi tasdig'i 2026-08-17

// ── 1. Jadvalni o'qish ───────────────────────────────────────────────────────
const md = readFileSync(PREVIEW, "utf8");
const rowRe = /^\| (TM-\d{6}) \| (.+?) \| (kg|dona) \| (.+?) \| (.+?) \|\s*$/;
type Row = { sku: string; name: string; unit: "kg" | "dona"; countCell: string; joy: string };
const rows: Row[] = [];
for (const line of md.split("\n")) {
  const m = line.match(rowRe);
  if (m) rows.push({ sku: m[1], name: m[2], unit: m[3] as Row["unit"], countCell: m[4], joy: m[5] });
}

// ── 2. Validatsiya (fail-fast, hech narsa yozilmasin) ───────────────────────
function fail(msg: string): never {
  console.error(`GENERATOR FAIL: ${msg}`);
  process.exit(1);
}
if (rows.length !== 94) fail(`94 qator kutilgan, topildi: ${rows.length}`);
rows.forEach((r, i) => {
  const expected = `TM-${String(i + 1).padStart(6, "0")}`;
  if (r.sku !== expected) fail(`SKU tartibi buzildi: ${i}-indeksda ${r.sku}, kutilgan ${expected}`);
});
const kgRows = rows.filter((r) => r.unit === "kg");
const donaRows = rows.filter((r) => r.unit === "dona");
if (kgRows.length !== 82) fail(`kg-item 82 kutilgan, topildi ${kgRows.length}`);
if (donaRows.length !== 12) fail(`dona-item 12 kutilgan, topildi ${donaRows.length}`);

// son parsing: bold **, har xil probel turlarini olib tashlash
const num = (s: string) => {
  const clean = s.replace(/\*\*/g, "").replace(/[\s\u00A0\u202F\u2009]/g, "");
  const v = Number(clean);
  if (!Number.isFinite(v)) fail(`son o'qilmadi: "${s}"`);
  return v;
};
// centlarda yig'ish (float xatosiz)
let kgCents = 0;
for (const r of kgRows) {
  const cell = r.sku === "TM-000022" ? r.countCell.split("=")[0] : r.countCell; // "**429.8** = ..."
  kgCents += Math.round(num(cell) * 100);
}
if (kgCents !== 6035345) fail(`kg jami ${kgCents / 100}, kutilgan 60353.45`);
let donaTotal = 0;
let donaKgCents = 0;
for (const r of donaRows) {
  const m = r.countCell.match(/^([\d\s\u00A0\u202F\u2009]+) \(([\d\s\u00A0\u202F\u2009.,]+) kg\)$/);
  if (!m) fail(`dona katak formati: "${r.countCell}" (${r.sku})`);
  donaTotal += num(m[1]);
  donaKgCents += Math.round(num(m[2]) * 100);
}
if (donaTotal !== 126360) fail(`dona jami ${donaTotal}, kutilgan 126360`);
if (donaKgCents !== 1030120) fail(`dona kg-ekvivalenti ${donaKgCents / 100}, kutilgan 10301.20`);

// ── 3. note (provenans) qurish — preview §4 formati ─────────────────────────
function noteFor(r: Row): string {
  if (r.sku === "TM-000022") {
    return "Sanoq 2026-08-15 · C-19 168.6 kg + C-04 261.2 kg = 429.8 kg";
  }
  const date = r.joy === "C-15" ? "2026-08-16" : "2026-08-15";
  if (r.unit === "dona") {
    // "55 200 (6 348.00 kg)" -> "55 200 dona (6 348.00 kg)"
    return `Sanoq ${date} · ${r.joy} · ${r.countCell.replace(" (", " dona (")}`;
  }
  return `Sanoq ${date} · ${r.joy} · ${r.countCell} kg`;
}
const esc = (s: string) => s.replace(/'/g, "''");

// ── 4. SQL fayl ──────────────────────────────────────────────────────────────
const values = rows
  .map((r) => `  ('${r.sku}', '${esc(r.name)}', '${r.unit}', 'physical_count', '${esc(noteFor(r))}', '${CREATED_BY}')`)
  .join(",\n");
const expectedValues = rows
  .map((r) => `  ('${r.sku}', '${esc(r.name)}', '${r.unit}', '${esc(noteFor(r))}')`)
  .join(",\n");

const tm1 = esc(noteFor(rows[0]));
const tm22 = esc(noteFor(rows[21]));
const tm92 = esc(noteFor(rows[91]));

const sql = `-- =============================================================================
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
\\set ON_ERROR_STOP on
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
${values};

-- ── 2b. Muhrlangan kutilma jadvali (94 qator TO'LIQ maydonma-maydon tekshiriladi)
CREATE TEMP TABLE rc_expected (
  sku text PRIMARY KEY, display_name text NOT NULL, unit text NOT NULL, note text NOT NULL
) ON COMMIT DROP;
INSERT INTO rc_expected (sku, display_name, unit, note) VALUES
${expectedValues};

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
  SELECT COUNT(*) INTO v FROM items WHERE created_by <> '${CREATED_BY}';
  IF v <> 0 THEN RAISE EXCEPTION '8.8: created_by xato (% satr)', v; END IF;

  -- 8.4 item_aliases o'zgarmagan
  SELECT COUNT(*) INTO v FROM item_aliases;
  IF v <> 0 THEN RAISE EXCEPTION '8.4: item_aliases=% (0 kutilgan)', v; END IF;

  -- 8.5 note formati
  SELECT COUNT(*) INTO v FROM items WHERE note NOT LIKE 'Sanoq 2026-08-1%';
  IF v <> 0 THEN RAISE EXCEPTION '8.5: % satrda note format buzildi', v; END IF;
  SELECT note INTO t FROM items WHERE sku='TM-000001';
  IF t <> '${tm1}' THEN RAISE EXCEPTION '8.5: TM-000001 note="%"', t; END IF;
  SELECT note INTO t FROM items WHERE sku='TM-000022';
  IF t <> '${tm22}' THEN RAISE EXCEPTION '8.5: TM-000022 note="%"', t; END IF;
  SELECT note INTO t FROM items WHERE sku='TM-000092';
  IF t <> '${tm92}' THEN RAISE EXCEPTION '8.5: TM-000092 note="%"', t; END IF;
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
      OR i.created_by IS DISTINCT FROM '${CREATED_BY}';
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
`;

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, sql, "utf8");
console.log(`OK: ${rows.length} qator -> ${path.relative(ROOT, OUT)}`);
console.log(`kg-item: ${kgRows.length} (jami ${kgCents / 100} kg) · dona-item: ${donaRows.length} (jami ${donaTotal} dona, ${donaKgCents / 100} kg ekv.)`);
console.log(`Fizik massa: ${(kgCents + donaKgCents) / 100} kg (kutilgan 70654.65)`);
console.log(`Namuna notlar:\n  TM-000001: ${noteFor(rows[0])}\n  TM-000022: ${noteFor(rows[21])}\n  TM-000080: ${noteFor(rows[79])}\n  TM-000092: ${noteFor(rows[91])}`);
