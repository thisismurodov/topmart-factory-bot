import { execFileSync } from "node:child_process";
import path from "node:path";
import { getTableColumns } from "drizzle-orm";
import pg from "pg";
import {
  warehousesTable,
  inventoryTable,
  stockMovementsTable,
  wipMovementsTable,
} from "@workspace/db";

// Ombor jadvallari (warehouses, inventory, stock_movements, wip_movements)
// IKKI joyda qo'lda sinxron saqlanadi: runtime DDL (bot init_db + API initDb)
// va kanonik Drizzle sxemasi (lib/db/src/schema/). Bu skript driftni ushlaydi:
//
// 1. Tashlanadigan (throwaway) baza yaratadi
// 2. Bot init_db() va API initDb() ni o'sha bazaga qarshi ishga tushiradi —
//    ya'ni aynan runtime DDL natijasini oladi (dev bazadagi eski holat emas)
// 3. Natijaviy ustunlar + turlarni Drizzle sxemasi bilan solishtiradi
//
// Bir tomonga ustun qo'shilsa-yu ikkinchisiga qo'shilmasa — non-zero exit.
const DRIFT_DB = "warehouse_drift_check";
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

const TABLES = {
  warehouses: warehousesTable,
  inventory: inventoryTable,
  stock_movements: stockMovementsTable,
  wip_movements: wipMovementsTable,
} as const;

// Drizzle getSQLType() → information_schema.columns.data_type normalizatsiyasi
function normalizeType(sqlType: string): string {
  const t = sqlType.toLowerCase().replace(/\(.*\)/, "").trim();
  switch (t) {
    case "serial":
    case "int":
    case "int4":
      return "integer";
    case "bigserial":
    case "int8":
      return "bigint";
    case "bool":
      return "boolean";
    case "decimal":
      return "numeric";
    case "timestamptz":
    case "timestamp with time zone":
      return "timestamp with time zone";
    case "timestamp":
      return "timestamp without time zone";
    case "varchar":
    case "character varying":
      return "character varying";
    default:
      return t;
  }
}

function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function main(): Promise<void> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error("DATABASE_URL must be set");

  // 1. Throwaway bazani yaratish
  const adminPool = new pg.Pool({ connectionString: adminUrl });
  await adminPool.query(`DROP DATABASE IF EXISTS ${DRIFT_DB} WITH (FORCE)`);
  await adminPool.query(`CREATE DATABASE ${DRIFT_DB}`);
  await adminPool.end();

  const driftUrl = withDatabase(adminUrl, DRIFT_DB);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: driftUrl };
  delete childEnv["RAILWAY_DATABASE_URL"]; // lib/db avval RAILWAY_DATABASE_URL ni oladi

  // 2a. Bot runtime DDL (python init_db)
  console.log("→ bot init_db() ishlamoqda (throwaway baza)...");
  execFileSync("python3", ["-c", "from bot.database import init_db; init_db()"], {
    cwd: path.join(REPO_ROOT, "artifacts", "telegram-bot"),
    env: childEnv,
    stdio: ["ignore", "inherit", "inherit"],
  });

  // 2b. API runtime DDL (initDb)
  console.log("→ API initDb() ishlamoqda (throwaway baza)...");
  execFileSync("pnpm", ["--filter", "@workspace/api-server", "run", "init-db"], {
    cwd: REPO_ROOT,
    env: childEnv,
    stdio: ["ignore", "inherit", "inherit"],
  });

  // 3. Solishtirish
  const driftPool = new pg.Pool({ connectionString: driftUrl });
  let drift = false;

  for (const [tableName, table] of Object.entries(TABLES)) {
    const expected = new Map(
      Object.values(getTableColumns(table)).map((c) => [c.name, normalizeType(c.getSQLType())]),
    );

    const { rows } = await driftPool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [tableName],
    );

    if (rows.length === 0) {
      console.error(`✗ "${tableName}" jadvali runtime DDL'da yaratilmagan`);
      drift = true;
      continue;
    }

    const actual = new Map(rows.map((r) => [r.column_name, r.data_type.toLowerCase()]));

    const missing = [...expected.keys()].filter((c) => !actual.has(c));
    const extra = [...actual.keys()].filter((c) => !expected.has(c));
    const typeMismatch = [...expected.entries()]
      .filter(([name, type]) => actual.has(name) && actual.get(name) !== type)
      .map(([name, type]) => `${name} (Drizzle: ${type}, runtime: ${actual.get(name)})`);

    if (missing.length || extra.length || typeMismatch.length) {
      if (missing.length)
        console.error(`✗ ${tableName}: runtime DDL'da yo'q ustun(lar): ${missing.join(", ")}`);
      if (extra.length)
        console.error(`✗ ${tableName}: Drizzle sxemasida yo'q ustun(lar): ${extra.join(", ")}`);
      if (typeMismatch.length)
        console.error(`✗ ${tableName}: tur mos emas: ${typeMismatch.join("; ")}`);
      drift = true;
    } else {
      console.log(`✓ ${tableName}: ${expected.size} ustun mos (nom + tur)`);
    }
  }

  await driftPool.end();

  // Toza bo'lishi uchun throwaway bazani o'chirish
  const cleanupPool = new pg.Pool({ connectionString: adminUrl });
  await cleanupPool.query(`DROP DATABASE IF EXISTS ${DRIFT_DB} WITH (FORCE)`).catch(() => {});
  await cleanupPool.end();

  if (drift) {
    console.error(
      "\nOmbor sxemasida drift aniqlandi (Drizzle ↔ runtime DDL). " +
        "lib/db/src/schema/ ni HAM, bot init_db + API initDb ni HAM yangilang.",
    );
    process.exit(1);
  }

  console.log("\nOmbor sxemasi mos — drift yo'q.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
