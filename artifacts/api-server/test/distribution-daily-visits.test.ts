import { beforeAll, afterAll, describe, it, expect } from "vitest";
import express from "express";
import type { Express } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

// ─────────────────────────────────────────────────────────────────────────────
// "Kunlik tashriflar" (Tashriflar tab) data feed guard'i.
//
// GET /distribution/daily-visits ILGARI jimgina 500 qaytarardi:
//   1) no-sale sabablari so'rovi umumiy params massivini ishlatib, $2 (dow)
//      bind qilinmagani uchun PG "could not determine data type" xatosi berardi;
//   2) agent filtri subquery'larda mavjud bo'lmagan jadval aliasiga murojaat
//      qilardi.
// Bu test aynan shu endpoint'ni 4 rejimda qo'riqlaydi: filtrsiz, agentId bilan,
// viloyat/hudud bilan va aniq sana bilan — hammasi 200 bo'lishi va javob
// agents[].trail + agents[].stops shakllarini o'z ichiga olishi SHART.
//
// Fixture (sana = 2026-07-06, dushanba dow=1), yetkazib beruvchi agent
// telegram_id=9001 (savdo yozuvlari ham shu id bilan):
//   A — savdo (sold stop)
//   B — olmagan (sabab='tovari_bor', sabab_text NULL — reasons so'rovi trigger)
//   C — faqat pul_olish (payment stop)
//   D — faqat marshrutda (planned)
// + agent_locations'da 3 ta GPS nuqta (trail).
//
// Throwaway DB nomi pid+timestamp bilan unikal — parallel validation'lar
// bir-birining bazasini o'chirmaydi.
// ─────────────────────────────────────────────────────────────────────────────

const { Client } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

const TMP_DB = `topmart_dailyvisits_${process.pid}_${Date.now()}`;
const ssl = { rejectUnauthorized: false } as const;

function tmpUrl(sslRequire = false): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${TMP_DB}`;
  if (sslRequire) u.searchParams.set("sslmode", "require");
  return u.toString();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const distBotDir = path.resolve(here, "../../distribution-bot");

const DATE = "2026-07-06"; // dushanba → ISODOW 1
const DOW = 1;
const TS = `${DATE} 09:30:00`;
const AGENT_TG = 9001;

let pool: pg.Pool;
let server: Server;
let apiUrl: string;
let dlvId: number;

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
      TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_DAILY_VISITS_GUARD",
    },
    stdio: "pipe",
  });

  // @workspace/db pool'ini throwaway DB'ga yo'naltiramiz (import'dan OLDIN).
  process.env.RAILWAY_DATABASE_URL = tmpUrl(false);

  const db = await import("@workspace/db");
  pool = db.pool as unknown as pg.Pool;

  // ── Fixture ────────────────────────────────────────────────────────────────
  await pool.query(
    `INSERT INTO distribution.users (telegram_id, name, role, viloyat) VALUES ($1, 'Test Agent', 'agent', 'Andijon')`,
    [AGENT_TG],
  );

  const mkShop = async (nomi: string, hudud: string, lat: number, lng: number): Promise<number> => {
    const r = await pool.query(
      `INSERT INTO distribution.dokonlar (nomi, viloyat, hudud, holat, latitude, longitude, agent_id, created_at)
       VALUES ($1, 'Andijon', $2, 'faol', $3, $4, $5, $6) RETURNING id`,
      [nomi, hudud, lat, lng, AGENT_TG, TS],
    );
    return r.rows[0].id as number;
  };

  const shopA = await mkShop("A sold", "Markaz", 40.9, 71.4);
  const shopB = await mkShop("B nosale", "Markaz", 40.91, 71.41);
  const shopC = await mkShop("C payment", "Chekka", 40.92, 71.42);
  const shopD = await mkShop("D planned", "Markaz", 40.93, 71.43);

  // A: savdo
  await pool.query(
    `INSERT INTO distribution.savdolar (dokon_id, agent_id, jami_summa, tolov_turi, created_at)
     VALUES ($1, $2, 150000, 'naqd', $3)`,
    [shopA, AGENT_TG, TS],
  );

  // B: olmagan — sabab kodi bor, sabab_text ATAYIN NULL (reasons so'rovini trigger qiladi)
  await pool.query(
    `INSERT INTO distribution.olmagan_dokonlar (dokon_id, agent_id, sabab, sabab_text, qaytish_sanasi, created_at)
     VALUES ($1, $2, 'tovari_bor', NULL, '20.07.2026', $3)`,
    [shopB, AGENT_TG, TS],
  );

  // C: faqat pul_olish
  await pool.query(
    `INSERT INTO distribution.pul_olish (dokon_id, agent_id, summa, created_at)
     VALUES ($1, $2, 30000, $3)`,
    [shopC, AGENT_TG, TS],
  );

  // Yetkazib beruvchi agent — telegram_id savdo yozuvlari bilan BIR XIL
  const da = await pool.query(
    `INSERT INTO distribution.delivery_agents (name, mashina_nomeri, telegram_id, faol, hudud)
     VALUES ('Test Dlv', '01 T 001 AA', $1, 1, 'Markaz') RETURNING id`,
    [AGENT_TG],
  );
  dlvId = da.rows[0].id as number;
  for (const [dokonId, tartib] of [
    [shopA, 1],
    [shopB, 2],
    [shopD, 3],
  ] as const) {
    await pool.query(
      `INSERT INTO distribution.delivery_routes (delivery_agent_id, kun, dokon_id, tartib)
       VALUES ($1, $2, $3, $4)`,
      [dlvId, DOW, dokonId, tartib],
    );
  }

  // GPS trail — 3 nuqta, vaqt tartibida
  for (const [lat, lng, t] of [
    [40.9, 71.4, "09:00:00"],
    [40.91, 71.41, "09:15:00"],
    [40.92, 71.42, "09:30:00"],
  ] as const) {
    await pool.query(
      `INSERT INTO distribution.agent_locations (agent_id, latitude, longitude, created_at)
       VALUES ($1, $2, $3, $4)`,
      [AGENT_TG, lat, lng, `${DATE} ${t}`],
    );
  }

  // ── Distribution router'ni mount qilamiz (auth devorisiz — sxema/mantiq testi)
  const routerMod = await import("../src/routes/distribution");
  const { default: pinoHttp } = await import("pino-http");
  const { logger } = await import("../src/lib/logger");
  const app: Express = express();
  app.use(pinoHttp({ logger }));
  app.use(express.json());
  app.use(routerMod.default);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) await pool.end();
  process.env.RAILWAY_DATABASE_URL = adminUrl;
  await dropTmpDb();
}, 60_000);

async function getJson(p: string): Promise<any> {
  const r = await fetch(`${apiUrl}${p}`);
  expect(r.status).toBe(200);
  return r.json();
}

function expectShape(body: any): any {
  expect(Array.isArray(body.agents)).toBe(true);
  const ag = body.agents.find((a: any) => a.agentId === dlvId);
  expect(ag).toBeTruthy();
  // agents[].trail va agents[].stops shakli — Tashriflar tab kartalar + xarita
  expect(Array.isArray(ag.trail)).toBe(true);
  expect(Array.isArray(ag.stops)).toBe(true);
  return ag;
}

describe("GET /distribution/daily-visits — Tashriflar tab data feed guard", () => {
  it("filtrsiz 200 qaytaradi va agents[].trail/stops shaklini saqlaydi", async () => {
    const body = await getJson(`/distribution/daily-visits?date=${DATE}`);
    expect(body.date).toBe(DATE);
    expect(body.kun).toBe(DOW);
    const ag = expectShape(body);

    expect(ag.planned).toBe(3); // A, B, D
    expect(ag.visited).toBe(3); // A (savdo), B (olmagan), C (pul_olish)
    expect(ag.sold).toBe(1);
    expect(ag.noSale).toBe(1);
    expect(ag.salesTotal).toBe(150000);

    // trail — 3 GPS nuqta, {lat,lng,at} shaklida, vaqt tartibida
    expect(ag.trail).toHaveLength(3);
    for (const p of ag.trail) {
      expect(typeof p.lat).toBe("number");
      expect(typeof p.lng).toBe("number");
      expect(p).toHaveProperty("at");
    }

    // stops — sold + nosale + payment
    expect(ag.stops).toHaveLength(3);
    const outcomes = ag.stops.map((s: any) => s.outcome).sort();
    expect(outcomes).toEqual(["nosale", "payment", "sold"]);
    const nosale = ag.stops.find((s: any) => s.outcome === "nosale");
    expect(nosale.sabab).toBe("tovari_bor");
    expect(nosale.qaytishSanasi).toBe("20.07.2026");
    const sold = ag.stops.find((s: any) => s.outcome === "sold");
    expect(sold.saleTotal).toBe(150000);
    expect(sold.onRoute).toBe(true);

    // reasons breakdown — aynan shu so'rov ilgari 500 berardi
    expect(ag.reasons).toEqual([{ sabab: "tovari_bor", cnt: 1 }]);
  });

  it("agentId filtri bilan 200 (subquery alias regressiyasi guard'i)", async () => {
    const body = await getJson(`/distribution/daily-visits?date=${DATE}&agentId=${AGENT_TG}`);
    const ag = expectShape(body);
    expect(ag.visited).toBe(3);
    expect(ag.trail).toHaveLength(3);
    expect(ag.reasons).toEqual([{ sabab: "tovari_bor", cnt: 1 }]);

    // Mavjud bo'lmagan agent — 200, bo'sh ro'yxat (500 emas)
    const empty = await getJson(`/distribution/daily-visits?date=${DATE}&agentId=777777`);
    expect(empty.agents).toEqual([]);
  });

  it("viloyat/hudud filtrlari bilan 200 va to'g'ri toraytiradi", async () => {
    const body = await getJson(
      `/distribution/daily-visits?date=${DATE}&viloyat=Andijon&hudud=Markaz`,
    );
    const ag = expectShape(body);
    // "Chekka" hududdagi C (payment) chiqib ketadi
    expect(ag.visited).toBe(2);
    const outcomes = ag.stops.map((s: any) => s.outcome).sort();
    expect(outcomes).toEqual(["nosale", "sold"]);

    // Boshqa viloyat — bo'sh, lekin baribir 200
    const other = await getJson(`/distribution/daily-visits?date=${DATE}&viloyat=Toshkent`);
    expect(other.agents).toEqual([]);
  });

  it("aniq sana bilan (ma'lumotsiz kun) 200 va bo'sh natija", async () => {
    const body = await getJson(`/distribution/daily-visits?date=2026-07-07`);
    expect(body.date).toBe("2026-07-07");
    expect(body.kun).toBe(2);
    expect(body.agents).toEqual([]);
  });

  it("sana berilmasa ham 200 (bugungi kun default)", async () => {
    const body = await getJson(`/distribution/daily-visits`);
    expect(typeof body.date).toBe("string");
    expect(Array.isArray(body.agents)).toBe(true);
  });
});
