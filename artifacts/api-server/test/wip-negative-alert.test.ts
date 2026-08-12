import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// ── Isolation ──────────────────────────────────────────────────────────────
// Throwaway schema per run (pid+timestamp) so parallel validations never
// collide — see flow-receive.test.ts for the pattern.
const SCHEMA = `topmart_kg_wip_neg_alert_test_${process.pid}_${Date.now()}`;

const baseUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL must be set to run these tests");
{
  const u = new URL(baseUrl);
  u.searchParams.set("options", `-c search_path=${SCHEMA}`);
  delete process.env.RAILWAY_DATABASE_URL;
  process.env.DATABASE_URL = u.toString();
}

// Real Telegramga chiqib ketmasin: soxta server + test token.
process.env.TELEGRAM_BOT_TOKEN = "test-token";
delete process.env.ADMIN_CHAT_ID;

let pool: Pool;
let server: Server;
let apiUrl: string;
let tgServer: Server;
let lineId: number;

const LINE = "Makaron bo'limi (tg alert test)";
const ADMIN_CHAT_1 = "111111";
const ADMIN_CHAT_2 = "222222";

// Soxta Telegram API — kelgan sendMessage so'rovlarini yig'adi.
const sent: { chat_id: string; text: string }[] = [];

async function getFlow(): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}/ombor/flow`);
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function addWip(type: "RECEIVE" | "PRODUCE", kg: number): Promise<void> {
  await pool.query(
    `INSERT INTO wip_movements (line_id, movement_type, raw_material, product, weight_kg)
     VALUES ($1,$2,$3,$4,$5)`,
    [lineId, type, type === "RECEIVE" ? "Un" : null, type === "PRODUCE" ? "Makaron" : null, kg],
  );
}

// Flow'dagi yuborish fire-and-forget — stub'ga xabar kelishini qisqa poll bilan kutamiz.
async function waitForSends(count: number, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (sent.length < count && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);

  // GET /ombor/flow o'qiydigan jadvallarning minimal nusxalari + alert jadvallari.
  await pool.query(`
    CREATE TABLE warehouses (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      capacity_kg   NUMERIC NOT NULL DEFAULT 20000,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      location_type TEXT NOT NULL DEFAULT 'general',
      purpose       TEXT NOT NULL DEFAULT 'finished'
    );
    CREATE TABLE production_lines (
      id     SERIAL PRIMARY KEY,
      name   TEXT NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE production_line_workers (
      id      SERIAL PRIMARY KEY,
      line_id INTEGER NOT NULL
    );
    CREATE TABLE products (
      id      SERIAL PRIMARY KEY,
      name    TEXT NOT NULL,
      line_id INTEGER,
      active  BOOLEAN NOT NULL DEFAULT TRUE,
      in_production BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE inventory (
      id           SERIAL PRIMARY KEY,
      warehouse_id INTEGER NOT NULL,
      product      TEXT NOT NULL,
      quantity     NUMERIC NOT NULL DEFAULT 0,
      weight_kg    NUMERIC NOT NULL DEFAULT 0,
      product_type TEXT NOT NULL DEFAULT 'finished',
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (warehouse_id, product)
    );
    CREATE TABLE stock_movements (
      id                SERIAL PRIMARY KEY,
      product           TEXT NOT NULL,
      quantity          NUMERIC NOT NULL,
      movement_type     TEXT NOT NULL,
      from_warehouse_id INTEGER,
      to_warehouse_id   INTEGER,
      note              TEXT NOT NULL DEFAULT '',
      created_by        TEXT NOT NULL DEFAULT '',
      product_type      TEXT NOT NULL DEFAULT 'finished',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE wip_movements (
      id                SERIAL PRIMARY KEY,
      line_id           INTEGER NOT NULL,
      movement_type     TEXT NOT NULL,
      raw_material      TEXT,
      product           TEXT,
      weight_kg         NUMERIC(12,3) NOT NULL DEFAULT 0,
      from_warehouse_id INTEGER,
      batch_id          INTEGER,
      note              TEXT NOT NULL DEFAULT '',
      created_by        TEXT NOT NULL DEFAULT 'admin',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE user_roles (
      chat_id     BIGINT PRIMARY KEY,
      worker_name TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'worker'
    );
    CREATE TABLE wip_negative_alerts (
      line_id    INTEGER NOT NULL,
      alert_date DATE NOT NULL,
      wip_kg     NUMERIC(12,3) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (line_id, alert_date)
    );
  `);

  await pool.query(
    `INSERT INTO user_roles (chat_id, worker_name, role) VALUES
       ($1, 'Admin Bir', 'admin'),
       ($2, 'Admin Ikki', 'admin'),
       (333333, 'Oddiy Ishchi', 'worker')`,
    [ADMIN_CHAT_1, ADMIN_CHAT_2],
  );

  await pool.query(
    `INSERT INTO warehouses (name, location_type, purpose)
     VALUES ('Xom konteyner (tg alert)', 'container', 'raw')`,
  );
  const line = await pool.query(
    `INSERT INTO production_lines (name) VALUES ($1) RETURNING id`, [LINE],
  );
  lineId = line.rows[0].id;

  // Soxta Telegram API server
  const tgApp = express();
  tgApp.use(express.json());
  tgApp.post("/bottest-token/sendMessage", (req, res) => {
    sent.push({ chat_id: String(req.body.chat_id), text: String(req.body.text) });
    res.json({ ok: true });
  });
  await new Promise<void>((resolve) => {
    tgServer = tgApp.listen(0, "127.0.0.1", resolve);
  });
  process.env.TELEGRAM_API_BASE =
    `http://127.0.0.1:${(tgServer.address() as AddressInfo).port}`;

  const { default: omborRouter } = await import("../src/routes/ombor");
  const app = express();
  app.use(express.json());
  app.use(omborRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await pool.query(`TRUNCATE wip_movements RESTART IDENTITY`);
  await pool.query(`TRUNCATE wip_negative_alerts`);
  sent.length = 0;
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (tgServer) await new Promise<void>((r) => tgServer.close(() => r()));
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }
});

describe("notifyNegativeWip helper", () => {
  it("sends one Telegram message per admin naming the department and shortfall", async () => {
    const { notifyNegativeWip } = await import("../src/lib/wipAlerts");
    const attempted = await notifyNegativeWip(lineId, LINE, -25);
    expect(attempted).toBe(true);
    await waitForSends(2);

    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((s) => s.chat_id))).toEqual(
      new Set([ADMIN_CHAT_1, ADMIN_CHAT_2]),
    );
    for (const s of sent) {
      expect(s.text).toContain(LINE);
      expect(s.text).toContain("25.00 kg");
      expect(s.text).toContain("minus");
    }
    // Dedupe qatori yozildi
    const { rows } = await pool.query(`SELECT * FROM wip_negative_alerts`);
    expect(rows).toHaveLength(1);
    expect(rows[0].line_id).toBe(lineId);
  });

  it("does not send twice for the same department on the same day", async () => {
    const { notifyNegativeWip } = await import("../src/lib/wipAlerts");
    expect(await notifyNegativeWip(lineId, LINE, -25)).toBe(true);
    expect(await notifyNegativeWip(lineId, LINE, -30)).toBe(false);
    await waitForSends(2, 500);
    expect(sent).toHaveLength(2); // faqat birinchi chaqiruvdan (2 admin)
  });

  it("does nothing for zero or positive balance", async () => {
    const { notifyNegativeWip } = await import("../src/lib/wipAlerts");
    expect(await notifyNegativeWip(lineId, LINE, 0)).toBe(false);
    expect(await notifyNegativeWip(lineId, LINE, 12.5)).toBe(false);
    await waitForSends(1, 300);
    expect(sent).toHaveLength(0);
    const { rows } = await pool.query(`SELECT * FROM wip_negative_alerts`);
    expect(rows).toHaveLength(0);
  });
});

describe("GET /ombor/flow — negative WIP triggers the Telegram alert", () => {
  it("alerts admins when a department balance is negative, once per day", async () => {
    await addWip("RECEIVE", 10);
    await addWip("PRODUCE", 35); // WIP = −25

    const res = await getFlow();
    expect(res.status).toBe(200);
    const dept = res.json.departments.find((d: any) => d.id === lineId);
    expect(dept.wipKg).toBe(-25);

    await waitForSends(2);
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toContain(LINE);

    // Ikkinchi so'rov — dedupe tufayli yangi xabar YO'Q.
    await getFlow();
    await waitForSends(3, 700);
    expect(sent).toHaveLength(2);
  });

  it("sends nothing when WIP stays non-negative", async () => {
    await addWip("RECEIVE", 30);
    await addWip("PRODUCE", 30); // WIP = 0

    const res = await getFlow();
    expect(res.status).toBe(200);
    await waitForSends(1, 500);
    expect(sent).toHaveLength(0);
  });
});
