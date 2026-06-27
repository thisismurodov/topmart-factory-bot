import { getTableColumns } from "drizzle-orm";
import {
  pool,
  warehousesTable,
  inventoryTable,
  stockMovementsTable,
} from "@workspace/db";

// Ombor jadvallari runtime'da (bot init_db / API initDb) idempotent yaratiladi,
// Drizzle sxemasi esa faqat typed-access uchun. Ikkalasi ajralib ketmasligi
// (drift) uchun bu skript Drizzle sxemasidagi ustunlarni jonli DB bilan solishtiradi
// va farq bo'lsa non-zero bilan chiqadi (ship'dan oldin ushlanadi).
const TABLES = {
  warehouses: warehousesTable,
  inventory: inventoryTable,
  stock_movements: stockMovementsTable,
} as const;

async function main(): Promise<void> {
  let drift = false;

  for (const [tableName, table] of Object.entries(TABLES)) {
    const expected = Object.values(getTableColumns(table)).map((c) => c.name);

    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [tableName],
    );

    if (rows.length === 0) {
      console.error(`✗ "${tableName}" jadvali bazada topilmadi`);
      drift = true;
      continue;
    }

    const actual = new Set(rows.map((r) => r.column_name));
    const expectedSet = new Set(expected);
    // Simmetrik solishtirish — Drizzle'da bor lekin bazada yo'q (missing) VA
    // bazada bor lekin Drizzle'da yo'q (extra) ikkala drift turi ham ushlanadi.
    const missing = expected.filter((c) => !actual.has(c));
    const extra = [...actual].filter((c) => !expectedSet.has(c));

    if (missing.length || extra.length) {
      if (missing.length) console.error(`✗ ${tableName}: bazada yo'q ustun(lar): ${missing.join(", ")}`);
      if (extra.length)   console.error(`✗ ${tableName}: Drizzle sxemasida yo'q ustun(lar): ${extra.join(", ")}`);
      drift = true;
    } else {
      console.log(`✓ ${tableName}: ${expected.length} ustun mos`);
    }
  }

  await pool.end();

  if (drift) {
    console.error("\nOmbor sxemasida drift aniqlandi (Drizzle ↔ baza). lib/db/src/schema/ ni yangilang yoki migratsiya qiling.");
    process.exit(1);
  }

  console.log("\nOmbor sxemasi mos — drift yo'q.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
