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
// Xarita (Leaflet) marker-status klassifikatsiyasi guard'i.
//
// GET /distribution/map har bir do'kon uchun holatni shu ustuvorlikda
// hisoblashi SHART:
//   sold > nosale > visited > planned > none
//
// Muhim regressiya: `nosale` ILGARI faqat `sabab_text IS NOT NULL` bo'yicha
// aniqlanardi — lekin kanonik sabab `olmagan_dokonlar.sabab` (enum kod)
// ustunida saqlanadi va `sabab_text` NULL bo'lishi mumkin. Bu test aynan shu
// holatni qamrab oladi: sabab kodi bor, sabab_text NULL bo'lgan do'kon QIZIL
// (nosale) bo'lishi kerak.
//
// Fixture do'konlar (hammasi koordinatali, sana = 2026-07-06, dushanba dow=1):
//   A — savdo BOR + olmagan yozuvi ham bor         → sold   (sold ustun)
//   B — olmagan (sabab='tovari_bor', sabab_text NULL) + pul_olish → nosale
//   C — faqat pul_olish                            → visited
//   D — faqat shu kun marshrutida                  → planned
//   E — hech narsa                                 → none
//
// Throwaway DB xuddi boshqa fresh-db guard'lar kabi yaratiladi va tozalanadi
// (nom pid+timestamp bilan unikal — parallel validation'lar to'qnashmaydi).
// ─────────────────────────────────────────────────────────────────────────────

const { Client } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

const TMP_DB = `topmart_mapstatus_${process.pid}_${Date.now()}`;
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

let pool: pg.Pool;
let server: Server;
let apiUrl: string;

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
      TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_MAP_STATUS_GUARD",
    },
    stdio: "pipe",
  });

  // @workspace/db pool'ini throwaway DB'ga yo'naltiramiz (import'dan OLDIN).
  process.env.RAILWAY_DATABASE_URL = tmpUrl(false);

  const db = await import("@workspace/db");
  pool = db.pool as unknown as pg.Pool;

  // ── Fixture ────────────────────────────────────────────────────────────────
  await pool.query(
    `INSERT INTO distribution.users (telegram_id, name, role, viloyat) VALUES (9001, 'Test Agent', 'agent', 'Andijon')`,
  );

  const mkShop = async (nomi: string, lat: number, lng: number): Promise<number> => {
    const r = await pool.query(
      `INSERT INTO distribution.dokonlar (nomi, viloyat, hudud, holat, latitude, longitude, agent_id, created_at)
       VALUES ($1, 'Andijon', 'Test', 'faol', $2, $3, 9001, $4) RETURNING id`,
      [nomi, lat, lng, TS],
    );
    return r.rows[0].id as number;
  };

  const shopA = await mkShop("A sold", 40.9, 71.4);
  const shopB = await mkShop("B nosale", 40.91, 71.41);
  const shopC = await mkShop("C visited", 40.92, 71.42);
  const shopD = await mkShop("D planned", 40.93, 71.43);
  const shopE = await mkShop("E none", 40.94, 71.44);

  // A: savdo + olmagan yozuvi ham (sold ustunligini tekshirish uchun)
  await pool.query(
    `INSERT INTO distribution.savdolar (dokon_id, agent_id, jami_summa, tolov_turi, created_at)
     VALUES ($1, 9001, 150000, 'naqd', $2)`,
    [shopA, TS],
  );
  await pool.query(
    `INSERT INTO distribution.olmagan_dokonlar (dokon_id, agent_id, sabab, sabab_text, created_at)
     VALUES ($1, 9001, 'keyin_keling', NULL, $2)`,
    [shopA, TS],
  );

  // B: olmagan — sabab ENUM kodi bor, sabab_text ATAYIN NULL + pul_olish ham bor
  // (nosale ham sabab_text'siz ishlashi, ham visited'dan ustun bo'lishi kerak)
  await pool.query(
    `INSERT INTO distribution.olmagan_dokonlar (dokon_id, agent_id, sabab, sabab_text, qaytish_sanasi, created_at)
     VALUES ($1, 9001, 'tovari_bor', NULL, '20.07.2026', $2)`,
    [shopB, TS],
  );
  await pool.query(
    `INSERT INTO distribution.pul_olish (dokon_id, agent_id, summa, created_at)
     VALUES ($1, 9001, 50000, $2)`,
    [shopB, TS],
  );

  // C: faqat pul_olish
  await pool.query(
    `INSERT INTO distribution.pul_olish (dokon_id, agent_id, summa, created_at)
     VALUES ($1, 9001, 30000, $2)`,
    [shopC, TS],
  );

  // D: faqat marshrutda (faol yetkazib beruvchi agent, kun = dushanba)
  const da = await pool.query(
    `INSERT INTO distribution.delivery_agents (name, mashina_nomeri, telegram_id, faol)
     VALUES ('Test Dlv', '01 T 001 AA', 9002, 1) RETURNING id`,
  );
  const dlvId = da.rows[0].id as number;
  for (const [dokonId, tartib] of [
    [shopD, 1],
    [shopA, 2],
    [shopB, 3],
  ] as const) {
    await pool.query(
      `INSERT INTO distribution.delivery_routes (delivery_agent_id, kun, dokon_id, tartib)
       VALUES ($1, $2, $3, $4)`,
      [dlvId, DOW, dokonId, tartib],
    );
  }

  // E: hech narsa yo'q

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

describe("GET /distribution/map — marker status klassifikatsiyasi", () => {
  it("statuslarni sold > nosale > visited > planned > none tartibida hisoblaydi", async () => {
    const body = await getJson(`/distribution/map?date=${DATE}`);
    expect(body.date).toBe(DATE);
    expect(body.kun).toBe(DOW);

    const byName: Record<string, any> = {};
    for (const s of body.shops) byName[s.nomi] = s;

    // A: savdo bor — olmagan yozuviga qaramay sold
    expect(byName["A sold"].status).toBe("sold");
    // B: sabab kodi bor, sabab_text NULL — baribir nosale (pul_olish'dan ustun)
    expect(byName["B nosale"].status).toBe("nosale");
    // C: faqat pul_olish — visited
    expect(byName["C visited"].status).toBe("visited");
    // D: faqat marshrutda — planned
    expect(byName["D planned"].status).toBe("planned");
    // E: hech narsa — none
    expect(byName["E none"].status).toBe("none");
  });

  it("nosale do'kon uchun sabab kodi va qaytish sanasini qaytaradi (sabab_text NULL bo'lsa ham)", async () => {
    const body = await getJson(`/distribution/map?date=${DATE}`);
    const b = body.shops.find((s: any) => s.nomi === "B nosale");
    expect(b.sabab).toBe("tovari_bor");
    expect(b.sababText).toBeNull();
    expect(b.qaytishSanasi).toBe("20.07.2026");
  });

  it("marshrut to'xtashlarida sold/visited bayroqlari to'g'ri", async () => {
    const body = await getJson(`/distribution/map?date=${DATE}`);
    const stops: Record<string, any> = {};
    for (const r of body.routes) stops[r.dokonName] = r;

    expect(stops["A sold"].sold).toBe(true);
    expect(stops["A sold"].visited).toBe(true);
    expect(stops["B nosale"].sold).toBe(false);
    expect(stops["B nosale"].visited).toBe(true); // olmagan yozuvi = kirilgan
    expect(stops["D planned"].sold).toBe(false);
    expect(stops["D planned"].visited).toBe(false);
  });
});

describe("GET /distribution/route-progress", () => {
  it("reja/kirildi/savdo/qoldi hisoblarini to'g'ri qaytaradi", async () => {
    const body = await getJson(`/distribution/route-progress?date=${DATE}`);
    const ag = body.agents.find((a: any) => a.agentName === "Test Dlv");
    expect(ag).toBeTruthy();
    expect(ag.planned).toBe(3); // A, B, D
    expect(ag.visited).toBe(2); // A (savdo), B (olmagan+pul)
    expect(ag.sold).toBe(1); // A
    expect(ag.remaining).toBe(1); // D
  });
});
