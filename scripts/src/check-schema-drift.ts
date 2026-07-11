import { execFileSync } from "node:child_process";
import path from "node:path";
import { getTableColumns } from "drizzle-orm";
import pg from "pg";
import {
  normalizeDrizzleDefault,
  normalizeRuntimeDefault,
  normalizeType,
  withDatabase,
} from "./drift-utils";
import {
  adminUsersTable,
  batchesTable,
  customersTable,
  dailyPayrollRunsTable,
  inventoryTable,
  kgPayrollWorkersTable,
  packerAssignmentsTable,
  packerProductAssignmentsTable,
  payrollRoleRatesTable,
  pendingUsersTable,
  productionLineWorkersTable,
  productionLinesTable,
  productMaterialsTable,
  productPriceTiersTable,
  productsTable,
  rawMaterialsTable,
  salaryEntriesTable,
  salaryPaymentsTable,
  salesTable,
  stockMovementsTable,
  userRolesTable,
  warehousesTable,
  wipMovementsTable,
  workersTable,
} from "@workspace/db";

// Bu jadvallar IKKI joyda qo'lda sinxron saqlanadi: runtime DDL (bot init_db +
// API initDb) va kanonik Drizzle sxemasi (lib/db/src/schema/). Bu skript
// driftni ushlaydi:
//
// 1. Tashlanadigan (throwaway) baza yaratadi
// 2. Bot init_db() va API initDb() ni o'sha bazaga qarshi ishga tushiradi —
//    ya'ni aynan runtime DDL natijasini oladi (dev bazadagi eski holat emas)
// 3. Natijaviy ustunlar + turlar + nullability'ni Drizzle sxemasi bilan solishtiradi
//
// Bir tomonga ustun qo'shilsa-yu ikkinchisiga qo'shilmasa — non-zero exit.
//
// TABLES — Drizzle sxemasida HAM, runtime init yo'lida HAM mavjud har bir
// jadval. Yangi jadval qo'shsangiz (Drizzle + init_db/initDb), shu yerga ham
// qo'shing. Faqat runtime'da bo'lgan (Drizzle'siz) yordamchi jadvallar —
// db_meta, admin_sessions, audit_logs, ai_analysis_runs, sale_items,
// sale_payments, sale_events, sales_products, sales_product_tiers,
// sale_products, line_role_config — bu yerga KIRMAYDI (kanonik sxema yo'q).
// Parallel validation'lar bir-birining bazasini DROP qilmasligi uchun nom
// har bir ishga tushirishda unikal (pid + timestamp).
const DRIFT_DB = `schema_drift_check_${process.pid}_${Date.now()}`;
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

const TABLES = {
  admin_users: adminUsersTable,
  batches: batchesTable,
  customers: customersTable,
  daily_payroll_runs: dailyPayrollRunsTable,
  inventory: inventoryTable,
  kg_payroll_workers: kgPayrollWorkersTable,
  packer_assignments: packerAssignmentsTable,
  packer_product_assignments: packerProductAssignmentsTable,
  payroll_role_rates: payrollRoleRatesTable,
  pending_users: pendingUsersTable,
  production_line_workers: productionLineWorkersTable,
  production_lines: productionLinesTable,
  product_materials: productMaterialsTable,
  product_price_tiers: productPriceTiersTable,
  products: productsTable,
  raw_materials: rawMaterialsTable,
  salary_entries: salaryEntriesTable,
  salary_payments: salaryPaymentsTable,
  sales: salesTable,
  stock_movements: stockMovementsTable,
  user_roles: userRolesTable,
  warehouses: warehousesTable,
  wip_movements: wipMovementsTable,
  workers: workersTable,
} as const;

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
      Object.values(getTableColumns(table)).map((c) => [
        c.name,
        {
          type: normalizeType(c.getSQLType()),
          notNull: c.notNull,
          def: normalizeDrizzleDefault(c),
        },
      ]),
    );

    const { rows } = await driftPool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [tableName],
    );

    if (rows.length === 0) {
      console.error(`✗ "${tableName}" jadvali runtime DDL'da yaratilmagan`);
      drift = true;
      continue;
    }

    const actual = new Map(
      rows.map((r) => [
        r.column_name,
        {
          type: r.data_type.toLowerCase(),
          notNull: r.is_nullable.toUpperCase() === "NO",
          def: normalizeRuntimeDefault(r.column_default),
        },
      ]),
    );

    const missing = [...expected.keys()].filter((c) => !actual.has(c));
    const extra = [...actual.keys()].filter((c) => !expected.has(c));
    const typeMismatch = [...expected.entries()]
      .filter(([name, e]) => actual.has(name) && actual.get(name)!.type !== e.type)
      .map(([name, e]) => `${name} (Drizzle: ${e.type}, runtime: ${actual.get(name)!.type})`);
    const nullMismatch = [...expected.entries()]
      .filter(([name, e]) => actual.has(name) && actual.get(name)!.notNull !== e.notNull)
      .map(
        ([name, e]) =>
          `${name} (Drizzle: ${e.notNull ? "NOT NULL" : "nullable"}, runtime: ${
            actual.get(name)!.notNull ? "NOT NULL" : "nullable"
          })`,
      );
    const defaultMismatch = [...expected.entries()]
      .filter(([name, e]) => actual.has(name) && actual.get(name)!.def !== e.def)
      .map(
        ([name, e]) =>
          `${name} (Drizzle: ${e.def ?? "yo'q"}, runtime: ${actual.get(name)!.def ?? "yo'q"})`,
      );

    if (
      missing.length ||
      extra.length ||
      typeMismatch.length ||
      nullMismatch.length ||
      defaultMismatch.length
    ) {
      if (missing.length)
        console.error(`✗ ${tableName}: runtime DDL'da yo'q ustun(lar): ${missing.join(", ")}`);
      if (extra.length)
        console.error(`✗ ${tableName}: Drizzle sxemasida yo'q ustun(lar): ${extra.join(", ")}`);
      if (typeMismatch.length)
        console.error(`✗ ${tableName}: tur mos emas: ${typeMismatch.join("; ")}`);
      if (nullMismatch.length)
        console.error(`✗ ${tableName}: nullability mos emas: ${nullMismatch.join("; ")}`);
      if (defaultMismatch.length)
        console.error(`✗ ${tableName}: default mos emas: ${defaultMismatch.join("; ")}`);
      drift = true;
    } else {
      console.log(
        `✓ ${tableName}: ${expected.size} ustun mos (nom + tur + nullability + default)`,
      );
    }
  }

  await driftPool.end();

  // Toza bo'lishi uchun throwaway bazani o'chirish
  const cleanupPool = new pg.Pool({ connectionString: adminUrl });
  await cleanupPool.query(`DROP DATABASE IF EXISTS ${DRIFT_DB} WITH (FORCE)`).catch(() => {});
  await cleanupPool.end();

  if (drift) {
    console.error(
      "\nSxema drifti aniqlandi (Drizzle ↔ runtime DDL). " +
        "lib/db/src/schema/ ni HAM, bot init_db + API initDb ni HAM yangilang.",
    );
    process.exit(1);
  }

  console.log("\nSxema mos — drift yo'q.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
