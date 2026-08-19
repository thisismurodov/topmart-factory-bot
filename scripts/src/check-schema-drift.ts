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
  productionLabelsTable,
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
// sale_products, line_role_config, wip_negative_alerts — bu yerga KIRMAYDI
// (kanonik sxema yo'q).
// Parallel validation'lar bir-birining bazasini DROP qilmasligi uchun nom
// har bir ishga tushirishda unikal (pid + timestamp).
//
// CHECK/UNIQUE solishtirish: Drizzle sxemasi IKKINCHI throwaway bazaga
// `drizzle-kit push --force` bilan qo'llanadi, keyin ikkala bazaning
// pg_constraint/pg_index katalogi solishtiriladi. Shunda Postgres har ikki
// tomonning ifodalarini BIR XIL normallashtiradi (masalan `price >= 0` →
// `(price >= (0)::numeric)`) — matnni qo'lda parse qilish shart emas.
// Nomlar e'tiborga olinmaydi: CHECK'lar ta'rif matni bo'yicha, UNIQUE'lar
// ustunlar to'plami (+ partial WHERE) bo'yicha solishtiriladi.
const RUN_ID = `${process.pid}_${Date.now()}`;
const DRIFT_DB = `schema_drift_check_${RUN_ID}`;
const DRIZZLE_DB = `schema_drift_drizzle_${RUN_ID}`;
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
  production_labels: productionLabelsTable,
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

// Jadval → CHECK ta'riflari to'plami (pg_get_constraintdef, nomsiz).
// NOT NULL (contype='n', PG17+) bu yerga kirmaydi — faqat haqiqiy CHECK'lar.
async function readCheckConstraints(pool: pg.Pool): Promise<Map<string, Set<string>>> {
  const { rows } = await pool.query<{ table_name: string; def: string }>(`
    SELECT rel.relname AS table_name, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = 'public' AND c.contype = 'c'
  `);
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!out.has(r.table_name)) out.set(r.table_name, new Set());
    out.get(r.table_name)!.add(r.def);
  }
  return out;
}

// Jadval → UNIQUE indeks ta'riflari to'plami (indeks nomi olib tashlangan).
// UNIQUE constraint ham, CREATE UNIQUE INDEX ham bitta unique indeks yaratadi,
// shuning uchun ikkala shakl bir xil ko'rinishga tushadi (partial WHERE ham
// ta'rif ichida). PK indekslari chiqarilmaydi. Set ishlatiladi — bir xil
// ustunlar ustidagi dublikat unique indekslar (masalan products.id) drift emas.
async function readUniqueIndexes(pool: pg.Pool): Promise<Map<string, Set<string>>> {
  const { rows } = await pool.query<{ table_name: string; def: string }>(`
    SELECT t.relname AS table_name, pg_get_indexdef(i.indexrelid) AS def
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND i.indisunique AND NOT i.indisprimary
  `);
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!out.has(r.table_name)) out.set(r.table_name, new Set());
    out.get(r.table_name)!.add(r.def.replace(/^CREATE UNIQUE INDEX \S+ ON /, "CREATE UNIQUE INDEX ON "));
  }
  return out;
}

function setDiff(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => !b.has(x));
}

async function main(): Promise<void> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error("DATABASE_URL must be set");

  // 1. Throwaway bazalarni yaratish (runtime DDL uchun + Drizzle push uchun)
  const adminPool = new pg.Pool({ connectionString: adminUrl });
  for (const db of [DRIFT_DB, DRIZZLE_DB]) {
    await adminPool.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE ${db}`);
  }
  await adminPool.end();

  const driftUrl = withDatabase(adminUrl, DRIFT_DB);
  const drizzleUrl = withDatabase(adminUrl, DRIZZLE_DB);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: driftUrl,
    PRODUCTION_LABELS_SCHEMA_APPROVED: "1",
  };
  delete childEnv["RAILWAY_DATABASE_URL"]; // lib/db avval RAILWAY_DATABASE_URL ni oladi
  const drizzleEnv: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: drizzleUrl };
  delete drizzleEnv["RAILWAY_DATABASE_URL"];

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

  // 2c. Drizzle sxemasini ikkinchi throwaway bazaga materiallashtirish —
  // CHECK/UNIQUE constraint'larni Postgres katalogi orqali solishtirish uchun
  console.log("→ drizzle-kit push ishlamoqda (ikkinchi throwaway baza)...");
  execFileSync("pnpm", ["--filter", "@workspace/db", "run", "push-force"], {
    cwd: REPO_ROOT,
    env: drizzleEnv,
    stdio: ["ignore", "inherit", "inherit"],
  });

  // TEST-ONLY hook: sun'iy drift kiritish uchun. Faqat drift-checkning o'zini
  // sinovdan o'tkazadigan test ishlatadi (masalan runtime nusxaga ortiqcha
  // ustun qo'shib, skript non-zero bilan chiqishini tasdiqlash uchun).
  // Oddiy ishga tushirishlarda bu env var hech qachon o'rnatilmaydi.
  const testExtraDdl = process.env["FACTORY_DRIFT_TEST_EXTRA_DDL"];
  if (testExtraDdl) {
    console.log("→ [TEST] FACTORY_DRIFT_TEST_EXTRA_DDL qo'llanmoqda (sun'iy drift)...");
    const hookPool = new pg.Pool({ connectionString: driftUrl });
    await hookPool.query(testExtraDdl);
    await hookPool.end();
  }

  // 3. Solishtirish
  const driftPool = new pg.Pool({ connectionString: driftUrl });
  const drizzlePool = new pg.Pool({ connectionString: drizzleUrl });
  const [runtimeChecks, runtimeUniques, drizzleChecks, drizzleUniques] = await Promise.all([
    readCheckConstraints(driftPool),
    readUniqueIndexes(driftPool),
    readCheckConstraints(drizzlePool),
    readUniqueIndexes(drizzlePool),
  ]);
  await drizzlePool.end();
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

    // CHECK / UNIQUE constraint'lar (nomlar e'tiborga olinmaydi)
    const expCheckSet = drizzleChecks.get(tableName) ?? new Set<string>();
    const actCheckSet = runtimeChecks.get(tableName) ?? new Set<string>();
    const checkOnlyDrizzle = setDiff(expCheckSet, actCheckSet);
    const checkOnlyRuntime = setDiff(actCheckSet, expCheckSet);

    const expUniqSet = drizzleUniques.get(tableName) ?? new Set<string>();
    const actUniqSet = runtimeUniques.get(tableName) ?? new Set<string>();
    const uniqOnlyDrizzle = setDiff(expUniqSet, actUniqSet);
    const uniqOnlyRuntime = setDiff(actUniqSet, expUniqSet);

    if (
      missing.length ||
      extra.length ||
      typeMismatch.length ||
      nullMismatch.length ||
      defaultMismatch.length ||
      checkOnlyDrizzle.length ||
      checkOnlyRuntime.length ||
      uniqOnlyDrizzle.length ||
      uniqOnlyRuntime.length
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
      if (checkOnlyRuntime.length)
        console.error(
          `✗ ${tableName}: Drizzle sxemasida yo'q CHECK(lar): ${checkOnlyRuntime.join("; ")}`,
        );
      if (checkOnlyDrizzle.length)
        console.error(
          `✗ ${tableName}: runtime DDL'da yo'q CHECK(lar): ${checkOnlyDrizzle.join("; ")}`,
        );
      if (uniqOnlyRuntime.length)
        console.error(
          `✗ ${tableName}: Drizzle sxemasida yo'q UNIQUE(lar): ${uniqOnlyRuntime.join("; ")}`,
        );
      if (uniqOnlyDrizzle.length)
        console.error(
          `✗ ${tableName}: runtime DDL'da yo'q UNIQUE(lar): ${uniqOnlyDrizzle.join("; ")}`,
        );
      drift = true;
    } else {
      console.log(
        `✓ ${tableName}: ${expected.size} ustun mos (nom + tur + nullability + default), ` +
          `${actCheckSet.size} CHECK, ${actUniqSet.size} UNIQUE`,
      );
    }
  }

  await driftPool.end();

  // Toza bo'lishi uchun throwaway bazalarni o'chirish
  const cleanupPool = new pg.Pool({ connectionString: adminUrl });
  for (const db of [DRIFT_DB, DRIZZLE_DB]) {
    await cleanupPool.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
  }
  await cleanupPool.end();

  if (drift) {
    console.error(
      "\nSxema drifti aniqlandi (Drizzle ↔ runtime DDL). " +
        "lib/db/src/schema/ ni HAM, bot init_db + API initDb ni HAM yangilang.",
    );
    process.exit(1);
  }

  console.log("\nSxema mos — drift yo'q (ustunlar + CHECK + UNIQUE).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
