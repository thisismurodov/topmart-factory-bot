import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

// ─────────────────────────────────────────────────────────────────────────────
// Savdo bot dokon-egalik guard testi (task: begona do'kon ID qabul qilinmasin).
//
// _savdo_dokon_ruxsat / _dokon_ruxsat_guard — savdo, pul olish va nasiya
// to'lovi YOZILISHIDAN oldingi yakuniy server-side ruxsat tekshiruvi.
// Agent klaviaturadan tashqari matn ("🏪 <id>||...") yuborishi mumkin, shuning
// uchun bu predicate quyidagilarni kafolatlashi shart:
//   1. oddiy agent — faqat O'ZIGA biriktirilgan faol dokon (begona → False)
//   2. delivery agent — faqat BUGUNGI marshrutidagi dokon (route'ga a'zolik),
//      shunchaki holat='faol' YETARLI EMAS
//   3. nofaol dokon — hech kimga (tanlov va tasdiq orasida o'chirilsa ham)
//
// Throwaway DB nomi pid+timestamp bilan unikal (parallel validation'lar
// bir-birining bazasini o'chirmasligi uchun). _today_kun test ichida
// monkeypatch qilinadi — Juma (dam kuni) da ham deterministik.
// ─────────────────────────────────────────────────────────────────────────────

const { Client } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

const TMP_DB = `topmart_dist_ruxsat_${process.pid}_${Date.now()}`;
const ssl = { rejectUnauthorized: false } as const;

function tmpUrl(): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${TMP_DB}`;
  return u.toString();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const botDir = path.resolve(here, "../../distribution-bot");

const botEnv = {
  ...process.env,
  RAILWAY_DATABASE_URL: tmpUrl(),
  DATABASE_URL: tmpUrl(),
  TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_RUXSAT_GUARD",
  ADMIN_IDS: "999000999", // test uid'lari admin bo'lib qolmasligi uchun aniq ro'yxat
};

const AGENT_A = 555000001; // oddiy agent, dokon A egasi
const AGENT_B = 555000002; // oddiy agent, dokon B egasi
const DLV_TG = 555000003; // delivery agent

let client: pg.Client;

async function dropTmpDb(): Promise<void> {
  const admin = new Client({ connectionString: adminUrl, ssl });
  await admin.connect();
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [TMP_DB],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${TMP_DB}`);
  await admin.end();
}

let dokonA = 0; // AGENT_A ga biriktirilgan, faol
let dokonB = 0; // AGENT_B ga biriktirilgan, faol; delivery marshrutida
let dokonC = 0; // AGENT_A ga biriktirilgan, NOFAOL
let dokonD = 0; // AGENT_B ga biriktirilgan, faol; delivery marshrutida YO'Q

beforeAll(async () => {
  await dropTmpDb();
  {
    const admin = new Client({ connectionString: adminUrl, ssl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${TMP_DB}`);
    await admin.end();
  }
  execFileSync("python3", ["-c", "import main; main.init_db()"], {
    cwd: botDir,
    env: botEnv,
    stdio: "pipe",
  });
  client = new Client({ connectionString: tmpUrl(), ssl });
  await client.connect();
  await client.query(`SET search_path TO distribution`);

  const now = new Date().toISOString();
  await client.query(
    `INSERT INTO users (telegram_id,name,role,viloyat,created_at) VALUES
       ($1,'Agent A','agent','Toshkent',$4),
       ($2,'Agent B','agent','Toshkent',$4),
       ($3,'Dlv Agent','delivery','Toshkent',$4)`,
    [AGENT_A, AGENT_B, DLV_TG, now],
  );
  const mk = async (nomi: string, agent: number, holat: string) => {
    const r = await client.query(
      `INSERT INTO dokonlar (nomi,agent_id,holat,viloyat,hudud,created_at)
       VALUES ($1,$2,$3,'Toshkent','Chilonzor',$4) RETURNING id`,
      [nomi, agent, holat, now],
    );
    return Number(r.rows[0].id);
  };
  dokonA = await mk("Dokon A", AGENT_A, "faol");
  dokonB = await mk("Dokon B", AGENT_B, "faol");
  dokonC = await mk("Dokon C", AGENT_A, "nofaol");
  dokonD = await mk("Dokon D", AGENT_B, "faol");

  const dlv = await client.query(
    `INSERT INTO delivery_agents (name,telegram_id,faol,created_at)
     VALUES ('Dlv Agent',$1,1,$2) RETURNING id`,
    [DLV_TG, now],
  );
  // Marshrut: kun=1 (test _today_kun ni 1 ga monkeypatch qiladi), faqat dokonB
  await client.query(
    `INSERT INTO delivery_routes (delivery_agent_id,kun,dokon_id,tartib,created_at)
     VALUES ($1,1,$2,1,$3)`,
    [Number(dlv.rows[0].id), dokonB, now],
  );
}, 120_000);

afterAll(async () => {
  if (client) await client.end();
  await dropTmpDb();
}, 60_000);

function runRuxsat(uid: number, did: number): boolean {
  const py = [
    "import main",
    "main._today_kun = lambda: 1", // deterministik: Juma bo'lsa ham marshrut kuni = 1
    `print(main._savdo_dokon_ruxsat(${uid}, ${did}))`,
  ].join("\n");
  const out = execFileSync("python3", ["-c", py], { cwd: botDir, env: botEnv, stdio: "pipe" })
    .toString()
    .trim();
  return out.endsWith("True");
}

describe("_savdo_dokon_ruxsat — persist-oldi egalik tekshiruvi", () => {
  it("oddiy agent o'z faol dokoniga ruxsat oladi", () => {
    expect(runRuxsat(AGENT_A, dokonA)).toBe(true);
  });

  it("oddiy agent BEGONA dokon ID yuborsa rad etiladi (forged keyboard text)", () => {
    expect(runRuxsat(AGENT_A, dokonB)).toBe(false);
  });

  it("nofaol dokon egasiga ham rad etiladi (tanlovdan keyin o'chirilgan holat)", () => {
    expect(runRuxsat(AGENT_A, dokonC)).toBe(false);
  });

  it("delivery agent bugungi marshrutdagi dokonga ruxsat oladi", () => {
    expect(runRuxsat(DLV_TG, dokonB)).toBe(true);
  });

  it("delivery agent marshrutda YO'Q faol dokon ID yuborsa rad etiladi", () => {
    expect(runRuxsat(DLV_TG, dokonD)).toBe(false);
  });

  it("mavjud bo'lmagan dokon ID rad etiladi", () => {
    expect(runRuxsat(AGENT_A, 99999999)).toBe(false);
  });
});
