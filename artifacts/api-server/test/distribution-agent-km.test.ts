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
// GET /distribution/agent-km guard'i — GPS glitch va tartibsiz nuqtalar.
//
// Endpoint agent_locations nuqtalari orasidagi Haversine masofalarni agent+kun
// kesimida yig'adi. Qoidalar:
//   1) Yakka segment > 20 km — GPS glitch, hisobga olinmaydi;
//   2) Kunlar orasida (yarim tun orqali) segment hosil bo'lmaydi;
//   3) Kunning HAMMA segmentlari glitch bo'lsa km = 0 (NULL emas);
//   4) Nuqtalar bazaga tartibsiz (id bo'yicha aralash) yozilsa ham natija
//      created_at bo'yicha tartiblangani bilan bir xil;
//   5) agentId / from / to filtrlari ishlaydi.
//
// Geometriya: sof kenglik (latitude) siljishida 0.01° ≈ 1.112 km
// (6371 * radians(0.01)), shuning uchun kutilgan km'lar aniq hisoblanadi.
//
// Fixture:
//   Agent 9001, 2026-07-01: 40.00→40.01→40.02 →(glitch 41.50)→ 40.03
//     — 40.02→41.50 va 41.50→40.03 segmentlari >20 km, tashlanadi;
//       qolgan 2 ta segment ≈ 2×1.112 = 2.224 → 2.2 km.
//     Nuqtalar ATAYIN aralash tartibda INSERT qilinadi (out-of-order arrival).
//   Agent 9001, 2026-07-02: 40.04→40.05 — 1.1 km. Kun chegarasi: 40.03 (07-01
//     oxiri) → 40.04 (07-02 boshi) ~1.1 km, ya'ni glitch filtri (≤20 km)
//     uni USHLAMAYDI — faqat kun bo'yicha partitsiya to'sadi. lag() kunlar
//     bo'ylab o'tsa, kun 2 km'i 1.1 emas 2.2 bo'lib, test yiqiladi.
//   Agent 9002, 2026-07-01: 40.00→41.00→42.00 — hamma segment >20 km → km = 0.
//
// Throwaway DB — boshqa guard'lar kabi (nom pid+timestamp bilan unikal).
// ─────────────────────────────────────────────────────────────────────────────

const { Client } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

const TMP_DB = `topmart_agentkm_${process.pid}_${Date.now()}`;
const ssl = { rejectUnauthorized: false } as const;

function tmpUrl(sslRequire = false): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${TMP_DB}`;
  if (sslRequire) u.searchParams.set("sslmode", "require");
  return u.toString();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const distBotDir = path.resolve(here, "../../distribution-bot");

const D1 = "2026-07-01";
const D2 = "2026-07-02";

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

async function insertLoc(agentId: number, lat: number, lng: number, ts: string): Promise<void> {
  await pool.query(
    `INSERT INTO distribution.agent_locations (agent_id, latitude, longitude, source, created_at)
     VALUES ($1, $2, $3, 'test', $4)`,
    [agentId, lat, lng, ts],
  );
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
      TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_AGENT_KM_GUARD",
    },
    stdio: "pipe",
  });

  // @workspace/db pool'ini throwaway DB'ga yo'naltiramiz (import'dan OLDIN).
  process.env.RAILWAY_DATABASE_URL = tmpUrl(false);

  const db = await import("@workspace/db");
  pool = db.pool as unknown as pg.Pool;

  // ── Fixture ────────────────────────────────────────────────────────────────
  // Agent 9001, kun 1 — nuqtalar ATAYIN aralash INSERT tartibida (id tartibi
  // created_at tartibiga mos kelmaydi — out-of-order arrival simulyatsiyasi).
  // created_at bo'yicha to'g'ri ketma-ketlik:
  //   09:00 (40.00) → 09:10 (40.01) → 09:20 (40.02) → 09:30 (41.50 glitch)
  //   → 09:40 (40.03)
  await insertLoc(9001, 41.5, 71.0, `${D1} 09:30:00`); // glitch nuqta birinchi yozildi
  await insertLoc(9001, 40.01, 71.0, `${D1} 09:10:00`);
  await insertLoc(9001, 40.03, 71.0, `${D1} 09:40:00`);
  await insertLoc(9001, 40.0, 71.0, `${D1} 09:00:00`);
  await insertLoc(9001, 40.02, 71.0, `${D1} 09:20:00`);

  // Agent 9001, kun 2 — kun 1 oxiriga (40.03) ATAYIN yaqin (40.04, ~1.1 km):
  // agar lag() kunlar bo'ylab o'tib ketsa, 40.03→40.04 segmenti ≤20 km bo'lgani
  // uchun glitch filtri uni tashlab yubormaydi va kun 2 km'i 2.2 bo'lib qoladi.
  await insertLoc(9001, 40.04, 71.0, `${D2} 08:00:00`);
  await insertLoc(9001, 40.05, 71.0, `${D2} 08:10:00`);

  // Agent 9002, kun 1 — HAMMA segmentlar glitch (>20 km)
  await insertLoc(9002, 40.0, 71.0, `${D1} 10:00:00`);
  await insertLoc(9002, 41.0, 71.0, `${D1} 10:10:00`);
  await insertLoc(9002, 42.0, 71.0, `${D1} 10:20:00`);

  // ── Router mount (auth devorisiz — sxema/mantiq testi) ────────────────────
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

function dailyOf(body: any, agentId: string, date: string): any {
  return body.daily.find((d: any) => d.agentId === agentId && d.date === date);
}

describe("GET /distribution/agent-km — GPS glitch va kun chegarasi", () => {
  it("glitch segmentlarni (>20 km) tashlab, qolganini to'g'ri yig'adi — nuqtalar tartibsiz yozilgan bo'lsa ham", async () => {
    const body = await getJson(`/distribution/agent-km?from=${D1}&to=${D2}`);
    const d = dailyOf(body, "9001", D1);
    expect(d).toBeTruthy();
    // 2 ta haqiqiy segment × ~1.112 km = 2.224 → 2.2; glitch atrofidagi
    // 2 ta ~165 km segment hisobga olinmagan. Agar tartib id bo'yicha
    // olinsa yoki glitch qo'shilsa, qiymat keskin boshqacha bo'lardi.
    expect(d.km).toBeCloseTo(2.2, 1);
  });

  it("kunlar orasida segment hosil qilmaydi (yarim tun bo'linishi)", async () => {
    const body = await getJson(`/distribution/agent-km?from=${D1}&to=${D2}`);
    const d2 = dailyOf(body, "9001", D2);
    expect(d2).toBeTruthy();
    // Faqat 40.04→40.05 ≈ 1.1 km. 07-01 oxiri (40.03) → 07-02 boshi (40.04)
    // orasi ham ~1.1 km (≤20, glitch filtri ushlamaydi) — agar lag() kun
    // bo'yicha bo'linmasa, bu segment qo'shilib km 2.2 bo'lardi.
    expect(d2.km).toBeCloseTo(1.1, 1);
  });

  it("hamma segmentlari glitch bo'lgan kun uchun km = 0 (NULL emas)", async () => {
    const body = await getJson(`/distribution/agent-km?from=${D1}&to=${D1}`);
    const d = dailyOf(body, "9002", D1);
    expect(d).toBeTruthy();
    expect(d.km).toBe(0);
    const agent = body.agents.find((a: any) => a.agentId === "9002");
    expect(agent.totalKm).toBe(0);
    expect(agent.days).toBe(1);
  });

  it("agentId filtri faqat shu agent qatorlarini qaytaradi", async () => {
    const body = await getJson(`/distribution/agent-km?from=${D1}&to=${D2}&agentId=9001`);
    expect(body.daily.every((d: any) => d.agentId === "9001")).toBe(true);
    expect(body.agents.map((a: any) => a.agentId)).toEqual(["9001"]);
    // 9001 jami: 2.2 (kun1) + 1.1 (kun2) = 3.3
    expect(body.agents[0].totalKm).toBeCloseTo(3.3, 1);
    expect(body.agents[0].days).toBe(2);
  });

  it("from/to filtrlari sanalarni cheklaydi", async () => {
    const body = await getJson(`/distribution/agent-km?from=${D2}&to=${D2}`);
    expect(body.from).toBe(D2);
    expect(body.to).toBe(D2);
    expect(body.daily.every((d: any) => d.date === D2)).toBe(true);
    // 9002 faqat kun 1 da harakat qilgan — kun 2 filtri uni chiqarib tashlaydi
    expect(body.daily.some((d: any) => d.agentId === "9002")).toBe(false);
    const d = dailyOf(body, "9001", D2);
    expect(d.km).toBeCloseTo(1.1, 1);
  });
});
