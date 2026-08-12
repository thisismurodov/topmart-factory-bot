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
// GET /distribution/routes — kunlik marshrutlar ro'yxatida kesishish (⚠️) signali.
//
// Haftalik xaritada (RouteWeekMap) har kun uchun crossCount ko'rsatiladi, lekin
// kunlik ro'yxat ilgari bu signalni bermasdi. Endi endpoint har (agent, kun)
// guruhi uchun agentStats[].crossCount qaytarishi SHART:
//   - Agent X: marshrut tartibi atayin "X" shaklida (A→B→C→D chizig'i o'zini
//     kesib o'tadi) → crossCount >= 1
//   - Agent Y: to'g'ri chiziq → crossCount = 0
//   - Koordinatasiz to'xtashlar hisobga olinmaydi (crash bo'lmasin)
//
// Throwaway DB nomi pid+timestamp bilan unikal — parallel validation'lar
// bir-birining bazasini o'chirmaydi.
// ─────────────────────────────────────────────────────────────────────────────

const { Client } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

const TMP_DB = `topmart_routescross_${process.pid}_${Date.now()}`;
const ssl = { rejectUnauthorized: false } as const;

function tmpUrl(sslRequire = false): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${TMP_DB}`;
  if (sslRequire) u.searchParams.set("sslmode", "require");
  return u.toString();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const distBotDir = path.resolve(here, "../../distribution-bot");

const KUN = 2; // seshanba

let pool: pg.Pool;
let server: Server;
let apiUrl: string;
let crossAgentId: number;
let straightAgentId: number;

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
      TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_ROUTES_CROSS_GUARD",
    },
    stdio: "pipe",
  });

  // @workspace/db pool'ini throwaway DB'ga yo'naltiramiz (import'dan OLDIN).
  process.env.RAILWAY_DATABASE_URL = tmpUrl(false);

  const db = await import("@workspace/db");
  pool = db.pool as unknown as pg.Pool;

  const mkShop = async (nomi: string, lat: number | null, lng: number | null): Promise<number> => {
    const r = await pool.query(
      `INSERT INTO distribution.dokonlar (nomi, viloyat, hudud, holat, latitude, longitude, created_at)
       VALUES ($1, 'Andijon', 'Markaz', 'faol', $2, $3, '2026-07-06 09:00:00') RETURNING id`,
      [nomi, lat, lng],
    );
    return r.rows[0].id as number;
  };

  const mkAgent = async (name: string): Promise<number> => {
    const r = await pool.query(
      `INSERT INTO distribution.delivery_agents (name, mashina_nomeri, faol) VALUES ($1, '01 T 001 AA', 1) RETURNING id`,
      [name],
    );
    return r.rows[0].id as number;
  };

  const addStop = async (agentId: number, dokonId: number, tartib: number): Promise<void> => {
    await pool.query(
      `INSERT INTO distribution.delivery_routes (delivery_agent_id, kun, dokon_id, tartib)
       VALUES ($1, $2, $3, $4)`,
      [agentId, KUN, dokonId, tartib],
    );
  };

  // Agent X: A(0,0)→B(1,1)→C(1,0)→D(0,1) — AB va CD segmentlari kesishadi.
  crossAgentId = await mkAgent("Cross Agent");
  const xa = await mkShop("XA", 40.9, 71.4);
  const xb = await mkShop("XB", 40.91, 71.41);
  const xc = await mkShop("XC", 40.91, 71.4);
  const xd = await mkShop("XD", 40.9, 71.41);
  await addStop(crossAgentId, xa, 1);
  await addStop(crossAgentId, xb, 2);
  await addStop(crossAgentId, xc, 3);
  await addStop(crossAgentId, xd, 4);

  // Agent Y: to'g'ri chiziq + bitta koordinatasiz to'xtash (crash guard).
  straightAgentId = await mkAgent("Straight Agent");
  const ya = await mkShop("YA", 40.9, 71.5);
  const yb = await mkShop("YB", 40.91, 71.51);
  const yc = await mkShop("YC", 40.92, 71.52);
  const ynull = await mkShop("YNULL", null, null);
  await addStop(straightAgentId, ya, 1);
  await addStop(straightAgentId, yb, 2);
  await addStop(straightAgentId, yc, 3);
  await addStop(straightAgentId, ynull, 4);

  // Distribution router'ni mount qilamiz (auth devorisiz — sxema/mantiq testi)
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

describe("GET /distribution/routes — agentStats[].crossCount", () => {
  it("kesishgan marshrut uchun crossCount >= 1, to'g'ri chiziq uchun 0", async () => {
    const r = await fetch(`${apiUrl}/distribution/routes?kun=${KUN}`);
    expect(r.status).toBe(200);
    const body = await r.json();

    expect(body.kun).toBe(KUN);
    expect(Array.isArray(body.agentStats)).toBe(true);

    const cross = body.agentStats.find((s: any) => s.agentId === crossAgentId);
    expect(cross).toBeTruthy();
    expect(cross.crossCount).toBeGreaterThanOrEqual(1);

    const straight = body.agentStats.find((s: any) => s.agentId === straightAgentId);
    expect(straight).toBeTruthy();
    expect(straight.crossCount).toBe(0);

    // routes ro'yxati o'zi ham to'liq qaytadi (koordinatasiz to'xtash ham)
    const yStops = body.routes.filter((x: any) => x.agentId === straightAgentId);
    expect(yStops).toHaveLength(4);
  });
});
