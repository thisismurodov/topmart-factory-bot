import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

// ─────────────────────────────────────────────────────────────────────────────
// Guard: eski (biz_score IS NULL) marshrut qatorlari backfill orqali
// biz_score/biz_reasons oladi — agentlar yangilanishdan OLDIN saqlangan
// marshrutlarda ham shoshilinchlik belgilarini ko'rishi kerak.
//
// QAROR (hujjatlashtirilgan): bot orqali qo'shilgan to'xtashlar (added_by_dlv=1)
// HAM ball oladi — shoshilinchlik do'konning biznes holatiga bog'liq, to'xtash
// qanday qo'shilganiga emas.
//
// Tekshiriladi:
//   1. NULL biz_score qatorlar rejalashtiruvchi bilan BIR XIL signallardan
//      (nasiya, 90-kunlik savdo, oxirgi tashrif) ball oladi
//   2. added_by_dlv=1 qatorlar ham ball oladi
//   3. Allaqachon ball olgan qatorlar QAYTA yozilmaydi (idempotentlik)
//   4. Signal umuman yo'q agent kohortida qatorlar NULL qoladi
// ─────────────────────────────────────────────────────────────────────────────

const { Client } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

const TMP_DB = `topmart_bizbackfill_${process.pid}_${Date.now()}`;
const ssl = { rejectUnauthorized: false } as const;

function tmpUrl(sslRequire = false): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${TMP_DB}`;
  if (sslRequire) u.searchParams.set("sslmode", "require");
  return u.toString();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const distBotDir = path.resolve(here, "../../distribution-bot");

let pool: pg.Pool;
let backfillRouteBizScores: () => Promise<{ scanned: number; updated: number }>;

// Fixture idlar
let agentA: number; // signalli kohort
let agentB: number; // signalsiz kohort
let shopCredit: number; // katta nasiya
let shopStale: number; // 30 kun bormagan
let shopQuiet: number; // signal yo'q (lekin kohortda boshqalar bor)
let shopNoSignal: number; // agentB kohorti — umuman signal yo'q
let shopPreScored: number; // allaqachon biz_score bor

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

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return `${d.toISOString().slice(0, 10)} 10:00:00`;
}

beforeAll(async () => {
  await dropTmpDb();
  {
    const admin = new Client({ connectionString: adminUrl, ssl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${TMP_DB}`);
    await admin.end();
  }

  // Distribution sxemasini FAQAT haqiqiy bot init kodi bilan ko'taramiz.
  execFileSync("python3", ["-c", "import main; main.init_db()"], {
    cwd: distBotDir,
    env: {
      ...process.env,
      RAILWAY_DATABASE_URL: tmpUrl(true),
      DATABASE_URL: tmpUrl(true),
      TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_BIZ_BACKFILL_GUARD",
    },
    stdio: "pipe",
  });

  // @workspace/db pool'ini throwaway DB'ga yo'naltiramiz (import'dan OLDIN).
  process.env.RAILWAY_DATABASE_URL = tmpUrl(false);

  const db = await import("@workspace/db");
  pool = db.pool as unknown as pg.Pool;
  ({ backfillRouteBizScores } = await import("../src/lib/routePlanService"));

  const mkShop = async (nomi: string): Promise<number> => {
    const r = await pool.query(
      `INSERT INTO distribution.dokonlar (nomi, viloyat, hudud, holat, latitude, longitude, created_at)
       VALUES ($1, 'Andijon', 'Test', 'faol', 40.9, 71.4, $2) RETURNING id`,
      [nomi, isoDaysAgo(100)],
    );
    return r.rows[0].id as number;
  };
  const mkAgent = async (name: string, tg: number): Promise<number> => {
    const r = await pool.query(
      `INSERT INTO distribution.delivery_agents (name, mashina_nomeri, telegram_id, faol)
       VALUES ($1, '01 T 001 AA', $2, 1) RETURNING id`,
      [name, tg],
    );
    return r.rows[0].id as number;
  };

  agentA = await mkAgent("Agent A", 9101);
  agentB = await mkAgent("Agent B", 9102);
  shopCredit = await mkShop("Nasiya dokon");
  shopStale = await mkShop("Eski tashrif dokon");
  shopQuiet = await mkShop("Jim dokon");
  shopNoSignal = await mkShop("Signalsiz dokon");
  shopPreScored = await mkShop("Oldin ballangan dokon");

  // Signallar: shopCredit — katta nasiya; shopStale — 30 kun oldin tashrif
  await pool.query(
    `INSERT INTO distribution.nasiya (dokon_id, qoldiq, created_at) VALUES ($1, 2000000, $2)`,
    [shopCredit, isoDaysAgo(20)],
  );
  await pool.query(
    `INSERT INTO distribution.olmagan_dokonlar (dokon_id, agent_id, sabab, created_at)
     VALUES ($1, 9101, 'keyin_keling', $2)`,
    [shopStale, isoDaysAgo(30)],
  );

  // Marshrut qatorlari:
  //  - agentA: shopCredit (eski, NULL, planner-saqlangan), shopStale (bot qo'shgan,
  //    added_by_dlv=1, NULL), shopQuiet (NULL, signal yo'q), shopPreScored (biz_score=77)
  //  - agentB: shopNoSignal (NULL, kohortda umuman signal yo'q)
  const mkRoute = async (
    agentId: number,
    dokonId: number,
    tartib: number,
    addedByDlv: number,
    bizScore: number | null,
    bizReasons: string | null,
  ) => {
    await pool.query(
      `INSERT INTO distribution.delivery_routes (delivery_agent_id, kun, dokon_id, tartib, added_by_dlv, biz_score, biz_reasons)
       VALUES ($1, 1, $2, $3, $4, $5, $6)`,
      [agentId, dokonId, tartib, addedByDlv, bizScore, bizReasons],
    );
  };
  await mkRoute(agentA, shopCredit, 1, 0, null, null);
  await mkRoute(agentA, shopStale, 2, 1, null, null); // bot qo'shgan
  await mkRoute(agentA, shopQuiet, 3, 0, null, null);
  await mkRoute(agentA, shopPreScored, 4, 0, 77, JSON.stringify(["VIP"]));
  await mkRoute(agentB, shopNoSignal, 1, 0, null, null);
}, 120_000);

afterAll(async () => {
  if (pool) await pool.end();
  process.env.RAILWAY_DATABASE_URL = adminUrl;
  await dropTmpDb();
}, 60_000);

async function routeRow(agentId: number, dokonId: number) {
  const r = await pool.query(
    `SELECT biz_score, biz_reasons FROM distribution.delivery_routes
      WHERE delivery_agent_id = $1 AND dokon_id = $2`,
    [agentId, dokonId],
  );
  return r.rows[0];
}

describe("backfillRouteBizScores — eski marshrutlarga urgency badge", () => {
  it("NULL qatorlarga signal asosida ball yozadi; bot qo'shganlar ham; ballanganlar tegilmaydi; signalsiz kohort NULL qoladi", async () => {
    const { scanned, updated } = await backfillRouteBizScores();
    expect(scanned).toBeGreaterThan(0);
    // agentA kohortida 3 ta NULL qator ballanadi (shopQuiet ham 0 ball bilan)
    expect(updated).toBe(3);

    // 1. Eski planner-saqlangan qator — nasiya sababi bilan ball oldi
    const credit = await routeRow(agentA, shopCredit);
    expect(Number(credit.biz_score)).toBeGreaterThan(0);
    expect(JSON.parse(credit.biz_reasons as string)).toEqual(
      expect.arrayContaining([expect.stringContaining("Nasiya")]),
    );

    // 2. Bot qo'shgan (added_by_dlv=1) qator HAM ball oldi — tashrif sababi bilan
    const stale = await routeRow(agentA, shopStale);
    expect(Number(stale.biz_score)).toBeGreaterThan(0);
    expect(JSON.parse(stale.biz_reasons as string)).toEqual(
      expect.arrayContaining([expect.stringContaining("kun bormagan")]),
    );

    // 3. Signalsiz do'kon signalli kohortda 0 ball oladi (NULL emas — qayta skan bo'lmaydi)
    const quiet = await routeRow(agentA, shopQuiet);
    expect(Number(quiet.biz_score)).toBe(0);
    expect(quiet.biz_reasons).toBeNull();

    // 4. Allaqachon ballangan qator o'zgarmadi
    const pre = await routeRow(agentA, shopPreScored);
    expect(Number(pre.biz_score)).toBe(77);
    expect(JSON.parse(pre.biz_reasons as string)).toEqual(["VIP"]);

    // 5. Umuman signalsiz kohort — NULL qoladi (badge yo'q, ma'lumot yo'q)
    const none = await routeRow(agentB, shopNoSignal);
    expect(none.biz_score).toBeNull();
  });

  it("ikkinchi ishga tushirish idempotent — faqat hali NULL qolganlarni skan qiladi, hech narsani yangilamaydi", async () => {
    const { updated } = await backfillRouteBizScores();
    expect(updated).toBe(0);
  });
});
