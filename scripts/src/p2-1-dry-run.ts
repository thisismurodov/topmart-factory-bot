import pg from "pg";

// ─────────────────────────────────────────────────────────────────────────────
// P2.1 DRY-RUN — 100% READ-ONLY inspektor.
//
// Maqsad: egasiga "P2.1 aynan nimani o'zgartiradi va baza hozir qaysi holatda"
// ni ko'rsatish (egasining IMPLEMENTATION RULE talabi: har qanday yozuvdan
// OLDIN aniq reja + ta'sir ko'rsatiladi). Bu skript HECH NARSA YOZMAYDI —
// faqat pg katalogidan SELECT qiladi. Istalgan payt, istalgancha ishga
// tushirish xavfsiz.
//
// Ishga tushirish: pnpm --filter @workspace/scripts run p2-1-dry-run
// Ijro rejasi:     docs/p2-1-execution-runbook.md
// DDL fayli:       scripts/sql/p2.1-items-foundation.sql (hech qaerga ulanmagan)
// ─────────────────────────────────────────────────────────────────────────────

const url = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error("RAILWAY_DATABASE_URL yoki DATABASE_URL o'rnatilishi kerak");

const NEW_TABLES = ["items", "item_aliases"] as const;

const NEW_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["products", "item_id"],
  ["raw_materials", "item_id"],
  ["product_materials", "product_item_id"],
  ["product_materials", "material_item_id"],
  ["inventory", "item_id"],
  ["stock_movements", "item_id"],
  ["batches", "item_id"],
  ["wip_movements", "raw_material_item_id"],
  ["wip_movements", "product_item_id"],
  ["sale_items", "item_id"],
];

const TRIGGERS = ["items_sku_immutable", "items_no_delete"] as const;

async function main(): Promise<void> {
  const ssl =
    url!.includes("localhost") || url!.includes("127.0.0.1")
      ? undefined
      : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString: url, ssl, max: 1 });

  console.log("P2.1 DRY-RUN (read-only) —", new Date().toISOString());
  console.log("");

  let pending = 0;
  let exists = 0;

  // 1. Yangi jadvallar holati
  console.log("── Yangi jadvallar ──");
  for (const t of NEW_TABLES) {
    const r = await pool.query<{ ok: string | null }>(
      "SELECT to_regclass('public.' || $1)::text AS ok",
      [t],
    );
    const there = r.rows[0]?.ok != null;
    if (there) exists++;
    else pending++;
    console.log(`  ${there ? "MAVJUD " : "KUTMOQDA"}  CREATE TABLE ${t}`);
  }

  // 2. Yangi ustunlar holati
  console.log("── Yangi NULLABLE ustunlar (10) ──");
  for (const [table, column] of NEW_COLUMNS) {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
      [table, column],
    );
    const there = (r.rowCount ?? 0) > 0;
    if (there) exists++;
    else pending++;
    console.log(`  ${there ? "MAVJUD " : "KUTMOQDA"}  ALTER TABLE ${table} ADD COLUMN ${column}`);
  }

  // 3. Triggerlar (faqat items jadvali mavjud bo'lsa ma'noli)
  console.log("── Himoya triggerlari ──");
  for (const trg of TRIGGERS) {
    const r = await pool.query(
      `SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgname = $1 AND c.relname = 'items' AND NOT t.tgisinternal`,
      [trg],
    );
    const there = (r.rowCount ?? 0) > 0;
    if (there) exists++;
    else pending++;
    console.log(`  ${there ? "MAVJUD " : "KUTMOQDA"}  TRIGGER ${trg}`);
  }

  // 4. Ta'sirlanadigan jadvallar hajmi (dalil: ALTER'lar metadata-only,
  //    birorta satr o'zgarmaydi)
  console.log("── Ta'sirlanadigan jadvallar (satr soni — MA'LUMOT O'ZGARMAYDI) ──");
  const affected = [...new Set(NEW_COLUMNS.map(([t]) => t))];
  for (const t of affected) {
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
    console.log(`  ${t.padEnd(18)} ${String(r.rows[0].n).padStart(6)} satr — 0 UPDATE/DELETE/INSERT`);
  }

  // 5. Drift-tuzatish holati (2026-08-15 egasi buyurgan): movement_type CHECK
  console.log("── movement_type CHECK (drift-tuzatish nazorati) ──");
  const chk = await pool.query<{ def: string }>(`
    SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'public.stock_movements'::regclass
       AND conname  = 'stock_movements_movement_type_check'
  `);
  if (chk.rowCount) {
    console.log(`  MAVJUD  ${chk.rows[0].def}`);
  } else {
    console.log("  YO'Q — initializer keyingi bootda qo'shadi (konvergensiya bloki)");
  }

  console.log("");
  console.log(`Xulosa: ${pending} obyekt KUTMOQDA, ${exists} obyekt allaqachon mavjud.`);
  console.log("Bu skript hech narsa yozmadi — faqat SELECT bajarildi.");
  console.log("Ijro faqat egasining aniq 'P2.1 GO' ruxsati bilan (runbook §5).");

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
