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
// PATCH /distribution/shops/:id — pin ko'chirish audit jurnali
//
// - Koordinata o'zgarsa distribution.dokon_location_log ga bitta yozuv:
//   eski/yangi lat/lng + changed_by
// - Bir xil koordinata bilan PATCH — yozuv YO'Q (shovqin emas)
// - Koordinatani o'chirish (null) ham loglanadi
// - GET /distribution/shops/:id locationChanges qaytaradi (eng yangisi birinchi)
// - Parallel PATCH'lar audit zanjirini buzmaydi (old→new uzluksiz)
// ─────────────────────────────────────────────────────────────────────────────

const { Client } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

const TMP_DB = `topmart_locaudit_${process.pid}_${Date.now()}`;
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
let shopId = 0;
let chainShopId = 0;

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
      TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_LOC_AUDIT",
    },
    stdio: "pipe",
  });

  process.env.RAILWAY_DATABASE_URL = tmpUrl(false);
  const db = await import("@workspace/db");
  pool = db.pool as unknown as pg.Pool;

  // Namangan klasteri — outlier guard xalaqit bermasligi uchun zich joylashuv
  const mkShop = async (nomi: string, lat: number | null, lng: number | null): Promise<number> => {
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
  shopId = await mkShop("Audit target", 41.02, 71.61);
  chainShopId = await mkShop("Chain target", 41.0, 71.6);

  const routerMod = await import("../src/routes/distribution");
  const { default: pinoHttp } = await import("pino-http");
  const { logger } = await import("../src/lib/logger");
  const app: Express = express();
  app.use(pinoHttp({ logger }));
  app.use(express.json());
  // Auth middleware o'rniga username stub — audit changed_by shu qiymatni olishi kerak
  app.use((req, _res, next) => {
    req.username = "test-manager";
    next();
  });
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

async function logsFor(id: number): Promise<any[]> {
  const q = await pool.query(
    `SELECT * FROM distribution.dokon_location_log WHERE dokon_id = $1 ORDER BY id`,
    [id],
  );
  return q.rows;
}

describe("PATCH /distribution/shops/:id — joylashuv audit jurnali", () => {
  it("koordinata o'zgarishi eski/yangi qiymat + username bilan loglanadi", async () => {
    const { status } = await patchShop(shopId, { latitude: 41.015, longitude: 71.605 });
    expect(status).toBe(200);
    const rows = await logsFor(shopId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].old_latitude)).toBeCloseTo(41.02);
    expect(Number(rows[0].old_longitude)).toBeCloseTo(71.61);
    expect(Number(rows[0].new_latitude)).toBeCloseTo(41.015);
    expect(Number(rows[0].new_longitude)).toBeCloseTo(71.605);
    expect(rows[0].changed_by).toBe("test-manager");
    expect(rows[0].created_at).toBeTruthy();
  });

  it("bir xil koordinata bilan PATCH yangi yozuv qo'shmaydi", async () => {
    const { status } = await patchShop(shopId, { latitude: 41.015, longitude: 71.605 });
    expect(status).toBe(200);
    expect(await logsFor(shopId)).toHaveLength(1);
  });

  it("koordinatani o'chirish (null) ham loglanadi", async () => {
    const { status } = await patchShop(shopId, { latitude: null, longitude: null });
    expect(status).toBe(200);
    const rows = await logsFor(shopId);
    expect(rows).toHaveLength(2);
    expect(Number(rows[1].old_latitude)).toBeCloseTo(41.015);
    expect(rows[1].new_latitude).toBeNull();
    expect(rows[1].new_longitude).toBeNull();
  });

  it("GET /distribution/shops/:id locationChanges qaytaradi (eng yangisi birinchi)", async () => {
    const r = await fetch(`${apiUrl}/distribution/shops/${shopId}`);
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.locationChanges).toHaveLength(2);
    expect(json.locationChanges[0].newLatitude).toBeNull(); // eng oxirgi o'zgarish
    expect(json.locationChanges[0].changedBy).toBe("test-manager");
    expect(json.locationChanges[1].oldLatitude).toBeCloseTo(41.02);
    expect(json.locationChanges[1].newLatitude).toBeCloseTo(41.015);
  });

  it("parallel PATCH'larda audit zanjiri uzilmaydi (old→new uzluksiz)", async () => {
    // 10 ta parallel yangilash — FOR UPDATE qulfi tufayli har bir yozuvning
    // old_* qiymati oldingi yozuvning new_* qiymatiga teng bo'lishi shart.
    const moves = Array.from({ length: 10 }, (_, i) => ({
      latitude: 41.0 + (i + 1) * 0.001,
      longitude: 71.6 + (i + 1) * 0.001,
    }));
    const results = await Promise.all(moves.map((m) => patchShop(chainShopId, m)));
    for (const r of results) expect(r.status).toBe(200);

    const rows = await logsFor(chainShopId);
    expect(rows).toHaveLength(10);
    expect(Number(rows[0].old_latitude)).toBeCloseTo(41.0);
    for (let i = 1; i < rows.length; i++) {
      expect(Number(rows[i].old_latitude)).toBeCloseTo(Number(rows[i - 1].new_latitude));
      expect(Number(rows[i].old_longitude)).toBeCloseTo(Number(rows[i - 1].new_longitude));
    }
    // Yakuniy do'kon koordinatasi = oxirgi audit yozuvining new_* qiymati
    const shop = await pool.query(
      `SELECT latitude, longitude FROM distribution.dokonlar WHERE id = $1`,
      [chainShopId],
    );
    expect(Number(shop.rows[0].latitude)).toBeCloseTo(Number(rows[9].new_latitude));
    expect(Number(shop.rows[0].longitude)).toBeCloseTo(Number(rows[9].new_longitude));
  });
});
