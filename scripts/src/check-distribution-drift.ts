import { execFileSync } from "node:child_process";
import path from "node:path";
import { getTableColumns } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import pg from "pg";
import {
  normalizeDrizzleDefault,
  normalizeRuntimeDefault,
  normalizeType,
  withDatabase,
} from "./drift-utils";
import {
  agentPlansTable,
  deliveryAgentsTable,
  deliveryRoutesTable,
  distMahsulotlarTable,
  distUsersTable,
  dokonlarTable,
  mijozBalansTable,
  nasiyaTable,
  olmaganDokonlarTable,
  pulOlishTable,
  revisitlarTable,
  savdolarTable,
  savdoTafsilotTable,
} from "@workspace/db";

// Distribution sxemasi UCH joyda ta'riflangan va qo'lda sinxron saqlanadi:
//
//   1. Bot runtime DDL — artifacts/distribution-bot/database/connection.py
//      (_INIT_DDL, har startupda ishlaydi)
//   2. Mustaqil DDL skript — scripts/src/init-distribution.ts
//   3. Kanonik Drizzle mirror — lib/db/src/schema/distribution.ts
//
// Bu skript driftni ushlaydi:
//
//   1. IKKITA tashlanadigan (throwaway) baza yaratadi
//   2. Bot init_db() ni bittasiga, init-distribution.ts ni ikkinchisiga qarshi
//      ishga tushiradi (bitta bazada IF NOT EXISTS ikkinchi DDLni yashirardi)
//   3. Har ikkala natijani Drizzle mirror bilan solishtiradi: jadval to'plami,
//      ustun nomlari, turlari, nullability va defaultlar
//
// Bir nusxaga ustun/jadval qo'shilsa-yu boshqalariga qo'shilmasa — non-zero exit.
//
// TABLES — Drizzle mirror'dagi har bir distribution jadvali. Yangi jadval
// qo'shsangiz (connection.py _INIT_DDL + init-distribution.ts + Drizzle),
// shu yerga ham qo'shing. Qo'shimcha jadval (Drizzle'da yo'q) ham xato —
// mirror to'liq bo'lishi shart.
// Parallel validation'lar bir-birining bazasini DROP qilmasligi uchun nom
// har bir ishga tushirishda unikal (pid + timestamp).
const RUN_ID = `${process.pid}_${Date.now()}`;
const BOT_DB = `dist_drift_bot_${RUN_ID}`;
const TS_DB = `dist_drift_ts_${RUN_ID}`;
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

const TABLES = {
  agent_plans: agentPlansTable,
  delivery_agents: deliveryAgentsTable,
  delivery_routes: deliveryRoutesTable,
  dokonlar: dokonlarTable,
  mahsulotlar: distMahsulotlarTable,
  mijoz_balans: mijozBalansTable,
  nasiya: nasiyaTable,
  olmagan_dokonlar: olmaganDokonlarTable,
  pul_olish: pulOlishTable,
  revisitlar: revisitlarTable,
  savdo_tafsilot: savdoTafsilotTable,
  savdolar: savdolarTable,
  users: distUsersTable,
} as const;

type ColSpec = { type: string; notNull: boolean; def: string | null };

function drizzleExpected(): Map<string, Map<string, ColSpec>> {
  const out = new Map<string, Map<string, ColSpec>>();
  for (const [tableName, table] of Object.entries(TABLES)) {
    out.set(
      tableName,
      new Map(
        Object.values(getTableColumns(table)).map((c: Column) => [
          c.name,
          {
            type: normalizeType(c.getSQLType()),
            notNull: c.notNull,
            def: normalizeDrizzleDefault(c),
          },
        ]),
      ),
    );
  }
  return out;
}

async function readActual(pool: pg.Pool): Promise<Map<string, Map<string, ColSpec>>> {
  const { rows } = await pool.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'distribution'`,
  );
  const out = new Map<string, Map<string, ColSpec>>();
  for (const r of rows) {
    if (!out.has(r.table_name)) out.set(r.table_name, new Map());
    out.get(r.table_name)!.set(r.column_name, {
      type: r.data_type.toLowerCase(),
      notNull: r.is_nullable.toUpperCase() === "NO",
      def: normalizeRuntimeDefault(r.column_default),
    });
  }
  return out;
}

// `expected` (Drizzle mirror) ↔ `actual` (runtime DDL natijasi) solishtirish.
// `label` — qaysi runtime manba tekshirilayotgani (xato xabarlari uchun).
function compare(
  label: string,
  expected: Map<string, Map<string, ColSpec>>,
  actual: Map<string, Map<string, ColSpec>>,
): boolean {
  let drift = false;

  for (const tableName of actual.keys()) {
    if (!expected.has(tableName)) {
      console.error(`✗ [${label}] "${tableName}" jadvali Drizzle mirror'da yo'q`);
      drift = true;
    }
  }

  for (const [tableName, expCols] of expected) {
    const actCols = actual.get(tableName);
    if (!actCols) {
      console.error(`✗ [${label}] "${tableName}" jadvali yaratilmagan`);
      drift = true;
      continue;
    }

    const missing = [...expCols.keys()].filter((c) => !actCols.has(c));
    const extra = [...actCols.keys()].filter((c) => !expCols.has(c));
    const typeMismatch = [...expCols.entries()]
      .filter(([name, e]) => actCols.has(name) && actCols.get(name)!.type !== e.type)
      .map(([name, e]) => `${name} (Drizzle: ${e.type}, ${label}: ${actCols.get(name)!.type})`);
    const nullMismatch = [...expCols.entries()]
      .filter(([name, e]) => actCols.has(name) && actCols.get(name)!.notNull !== e.notNull)
      .map(
        ([name, e]) =>
          `${name} (Drizzle: ${e.notNull ? "NOT NULL" : "nullable"}, ${label}: ${
            actCols.get(name)!.notNull ? "NOT NULL" : "nullable"
          })`,
      );
    const defaultMismatch = [...expCols.entries()]
      .filter(([name, e]) => actCols.has(name) && actCols.get(name)!.def !== e.def)
      .map(
        ([name, e]) =>
          `${name} (Drizzle: ${e.def ?? "yo'q"}, ${label}: ${actCols.get(name)!.def ?? "yo'q"})`,
      );

    if (
      missing.length ||
      extra.length ||
      typeMismatch.length ||
      nullMismatch.length ||
      defaultMismatch.length
    ) {
      if (missing.length)
        console.error(`✗ [${label}] ${tableName}: yo'q ustun(lar): ${missing.join(", ")}`);
      if (extra.length)
        console.error(
          `✗ [${label}] ${tableName}: Drizzle mirror'da yo'q ustun(lar): ${extra.join(", ")}`,
        );
      if (typeMismatch.length)
        console.error(`✗ [${label}] ${tableName}: tur mos emas: ${typeMismatch.join("; ")}`);
      if (nullMismatch.length)
        console.error(
          `✗ [${label}] ${tableName}: nullability mos emas: ${nullMismatch.join("; ")}`,
        );
      if (defaultMismatch.length)
        console.error(
          `✗ [${label}] ${tableName}: default mos emas: ${defaultMismatch.join("; ")}`,
        );
      drift = true;
    } else {
      console.log(
        `✓ [${label}] ${tableName}: ${expCols.size} ustun mos (nom + tur + nullability + default)`,
      );
    }
  }

  return drift;
}

async function main(): Promise<void> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error("DATABASE_URL must be set");

  // 1. Ikkita throwaway baza yaratish
  const adminPool = new pg.Pool({ connectionString: adminUrl });
  for (const db of [BOT_DB, TS_DB]) {
    await adminPool.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE ${db}`);
  }
  await adminPool.end();

  const botUrl = withDatabase(adminUrl, BOT_DB);
  const tsUrl = withDatabase(adminUrl, TS_DB);

  // Bola jarayonlar throwaway bazaga ulanishi shart; lib/db va bot
  // RAILWAY_DATABASE_URL ni birinchi o'ringa qo'yadi — olib tashlaymiz.
  const botEnv: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: botUrl };
  delete botEnv["RAILWAY_DATABASE_URL"];
  const tsEnv: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: tsUrl };
  delete tsEnv["RAILWAY_DATABASE_URL"];

  // 2a. Distribution bot runtime DDL (python _INIT_DDL)
  console.log("→ distribution bot init_db() ishlamoqda (throwaway baza)...");
  execFileSync("python3", ["-c", "from database.connection import init_db; init_db()"], {
    cwd: path.join(REPO_ROOT, "artifacts", "distribution-bot"),
    env: botEnv,
    stdio: ["ignore", "inherit", "inherit"],
  });

  // 2b. Mustaqil DDL skript (init-distribution.ts)
  console.log("→ init-distribution.ts ishlamoqda (throwaway baza)...");
  execFileSync("pnpm", ["--filter", "@workspace/scripts", "run", "init-distribution"], {
    cwd: REPO_ROOT,
    env: tsEnv,
    stdio: ["ignore", "inherit", "inherit"],
  });

  // 3. Har ikkala natijani Drizzle mirror bilan solishtirish
  const expected = drizzleExpected();

  const botPool = new pg.Pool({ connectionString: botUrl });
  const botActual = await readActual(botPool);
  await botPool.end();

  const tsPool = new pg.Pool({ connectionString: tsUrl });
  const tsActual = await readActual(tsPool);
  await tsPool.end();

  const botDrift = compare("bot _INIT_DDL", expected, botActual);
  const tsDrift = compare("init-distribution.ts", expected, tsActual);

  // Toza bo'lishi uchun throwaway bazalarni o'chirish
  const cleanupPool = new pg.Pool({ connectionString: adminUrl });
  for (const db of [BOT_DB, TS_DB]) {
    await cleanupPool.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
  }
  await cleanupPool.end();

  if (botDrift || tsDrift) {
    console.error(
      "\nDistribution sxema drifti aniqlandi. UCHALA nusxani ham yangilang: " +
        "artifacts/distribution-bot/database/connection.py (_INIT_DDL), " +
        "scripts/src/init-distribution.ts va lib/db/src/schema/distribution.ts.",
    );
    process.exit(1);
  }

  console.log("\nDistribution sxema mos — drift yo'q (bot DDL ↔ init skript ↔ Drizzle mirror).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
