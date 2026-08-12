import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

// ─────────────────────────────────────────────────────────────────────────────
// AI tavsiya keshi eskirmasin — filterVisitedToday guard'i.
//
// AI reyting 10 daqiqa keshda turadi (aiSuggestCache). Agent tavsiya etilgan
// do'konga kirib bo'lsa (savdolar YOKI olmagan_dokonlar qatori bugun paydo
// bo'lsa), o'sha do'kon TTL tugashini kutmasdan kartadan yo'qolishi SHART.
// Bu test aynan post-filtr funksiyasini qo'riqlaydi:
//   A — bugun savdo bor            → chiqib ketadi
//   B — bugun olmagan qatori bor   → chiqib ketadi
//   C — kecha savdo, bugun yo'q    → QOLADI
//   D — hech qanday tashrif yo'q   → QOLADI
//
// Throwaway DB nomi pid+timestamp bilan unikal — parallel validation'lar
// bir-birining bazasini o'chirmaydi.
// ─────────────────────────────────────────────────────────────────────────────

const { Client } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

const TMP_DB = `topmart_aivisited_${process.pid}_${Date.now()}`;
const ssl = { rejectUnauthorized: false } as const;

function tmpUrl(sslRequire = false): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${TMP_DB}`;
  if (sslRequire) u.searchParams.set("sslmode", "require");
  return u.toString();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const distBotDir = path.resolve(here, "../../distribution-bot");

const TODAY = "2026-07-06";
const YESTERDAY = "2026-07-05";
const AGENT_TG = 9007;

let pool: pg.Pool;
let filterVisitedToday: (items: any[] | null, today: string) => Promise<any[] | null>;
let shopA: number, shopB: number, shopC: number, shopD: number;

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
      TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_AI_VISITED_GUARD",
    },
    stdio: "pipe",
  });

  // @workspace/db pool'ini throwaway DB'ga yo'naltiramiz (import'dan OLDIN).
  process.env.RAILWAY_DATABASE_URL = tmpUrl(false);

  const db = await import("@workspace/db");
  pool = db.pool as unknown as pg.Pool;

  const routerMod = await import("../src/routes/distribution");
  filterVisitedToday = routerMod.filterVisitedToday;

  const mkShop = async (nomi: string): Promise<number> => {
    const r = await pool.query(
      `INSERT INTO distribution.dokonlar (nomi, viloyat, hudud, holat, agent_id, created_at)
       VALUES ($1, 'Andijon', 'Markaz', 'faol', $2, $3) RETURNING id`,
      [nomi, AGENT_TG, `${YESTERDAY} 09:00:00`],
    );
    return r.rows[0].id as number;
  };
  shopA = await mkShop("A savdo bugun");
  shopB = await mkShop("B olmagan bugun");
  shopC = await mkShop("C savdo kecha");
  shopD = await mkShop("D tashrifsiz");

  // A — bugun savdo
  await pool.query(
    `INSERT INTO distribution.savdolar (dokon_id, agent_id, jami_summa, tolov_turi, created_at)
     VALUES ($1, $2, 100000, 'naqd', $3)`,
    [shopA, AGENT_TG, `${TODAY} 10:00:00`],
  );
  // B — bugun olmagan (no-sale tashrif)
  await pool.query(
    `INSERT INTO distribution.olmagan_dokonlar (dokon_id, agent_id, sabab, created_at)
     VALUES ($1, $2, 'tovari_bor', $3)`,
    [shopB, AGENT_TG, `${TODAY} 10:05:00`],
  );
  // C — KECHA savdo (bugungi filtr uni chiqarib yubormasligi kerak)
  await pool.query(
    `INSERT INTO distribution.savdolar (dokon_id, agent_id, jami_summa, tolov_turi, created_at)
     VALUES ($1, $2, 50000, 'naqd', $3)`,
    [shopC, AGENT_TG, `${YESTERDAY} 15:00:00`],
  );
}, 120_000);

afterAll(async () => {
  if (pool) await pool.end();
  process.env.RAILWAY_DATABASE_URL = adminUrl;
  await dropTmpDb();
}, 60_000);

function mkItem(dokonId: number): any {
  return { dokonId, nomi: `shop ${dokonId}`, hudud: "Markaz", agentName: null, score: 80, reason: "test" };
}

describe("filterVisitedToday — keshdagi AI reyting bugungi tashriflarga qarshi filtrlanadi", () => {
  it("bugun savdo/olmagan qatori bor do'konlar chiqib ketadi, qolganlari qoladi", async () => {
    const items = [shopA, shopB, shopC, shopD].map(mkItem);
    const out = await filterVisitedToday(items, TODAY);
    expect(out).not.toBeNull();
    expect(out!.map((i) => i.dokonId).sort((a, b) => a - b)).toEqual(
      [shopC, shopD].sort((a, b) => a - b),
    );
  });

  it("hech kim tashrif buyurmagan kun uchun ro'yxat o'zgarishsiz qoladi", async () => {
    const items = [shopA, shopB].map(mkItem);
    const out = await filterVisitedToday(items, "2026-01-01");
    expect(out!.map((i) => i.dokonId)).toEqual([shopA, shopB]);
  });

  it("null va bo'sh ro'yxat o'zgarishsiz qaytadi (AI fallback buzilmaydi)", async () => {
    expect(await filterVisitedToday(null, TODAY)).toBeNull();
    expect(await filterVisitedToday([], TODAY)).toEqual([]);
  });
});
