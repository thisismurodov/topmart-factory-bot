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
// PATCH /distribution/shops/:id — GPS outlier guard testi
//
// - Yangi koordinata viloyat medianidan >60 km → 409 gps_outlier
// - confirmOutlier: true bilan qayta yuborilsa → saqlanadi
// - QISMAN yangilash (faqat latitude) ham yakuniy juftlik bo'yicha tekshiriladi
//   (guard'ni bitta koordinata bilan chetlab o'tib bo'lmaydi)
// - Klaster ichidagi normal yangilash 409'siz o'tadi
// ─────────────────────────────────────────────────────────────────────────────

const { Client } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

const TMP_DB = `topmart_gpsoutlier_${process.pid}_${Date.now()}`;
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
let server: Server;
let apiUrl: string;
let targetId = 0;

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

  execFileSync("python3", ["-c", "import main; main.init_db()"], {
    cwd: distBotDir,
    env: {
      ...process.env,
      RAILWAY_DATABASE_URL: tmpUrl(true),
      DATABASE_URL: tmpUrl(true),
      TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_GPS_OUTLIER",
    },
    stdio: "pipe",
  });

  process.env.RAILWAY_DATABASE_URL = tmpUrl(false);
  const db = await import("@workspace/db");
  pool = db.pool as unknown as pg.Pool;

  // Namangan klasteri (~41.0N, 71.6E) — median ishonchli bo'lishi uchun 4 ta do'kon
  const mkShop = async (nomi: string, lat: number, lng: number): Promise<number> => {
    const r = await pool.query(
      `INSERT INTO distribution.dokonlar (nomi, viloyat, hudud, holat, latitude, longitude, agent_id, created_at)
       VALUES ($1, 'Namangan', 'Test', 'faol', $2, $3, 9001, '2026-07-06 09:00:00') RETURNING id`,
      [nomi, lat, lng],
    );
    return r.rows[0].id as number;
  };
  await mkShop("N1", 41.0, 71.6);
  await mkShop("N2", 41.01, 71.62);
  await mkShop("N3", 40.99, 71.58);
  targetId = await mkShop("Target", 41.02, 71.61);

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

async function patchShop(id: number, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}/distribution/shops/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

describe("PATCH /distribution/shops/:id — GPS outlier guard", () => {
  it("klaster ichidagi yangilash 409'siz saqlanadi", async () => {
    const { status, json } = await patchShop(targetId, { latitude: 41.015, longitude: 71.605 });
    expect(status).toBe(200);
    expect(json.latitude).toBeCloseTo(41.015);
  });

  it("Toshkent koordinatasi (>60 km) → 409 gps_outlier, saqlanmaydi", async () => {
    const { status, json } = await patchShop(targetId, { latitude: 41.31, longitude: 69.28 });
    expect(status).toBe(409);
    expect(json.error).toBe("gps_outlier");
    expect(json.distanceKm).toBeGreaterThan(60);
    const q = await pool.query(`SELECT latitude FROM distribution.dokonlar WHERE id = $1`, [targetId]);
    expect(Number(q.rows[0].latitude)).toBeCloseTo(41.015); // eski qiymat qoldi
  });

  it("confirmOutlier: true bilan uzoq koordinata saqlanadi", async () => {
    const { status, json } = await patchShop(targetId, {
      latitude: 41.31,
      longitude: 69.28,
      confirmOutlier: true,
    });
    expect(status).toBe(200);
    expect(json.longitude).toBeCloseTo(69.28);
    // Keyingi test uchun klaster ichiga qaytaramiz
    await patchShop(targetId, { latitude: 41.02, longitude: 71.61, confirmOutlier: true });
  });

  it("QISMAN yangilash (faqat longitude) ham yakuniy juftlik bo'yicha 409 qaytaradi", async () => {
    // Mavjud lat=41.02 + yangi lng=69.28 → Toshkent tomonga >60 km
    const { status, json } = await patchShop(targetId, { longitude: 69.28 });
    expect(status).toBe(409);
    expect(json.error).toBe("gps_outlier");
  });

  it("mavjud bo'lmagan do'kon → 404 (guard yo'lida ham)", async () => {
    const { status } = await patchShop(99_999_999, { latitude: 41.0, longitude: 71.6 });
    expect(status).toBe(404);
  });
});
