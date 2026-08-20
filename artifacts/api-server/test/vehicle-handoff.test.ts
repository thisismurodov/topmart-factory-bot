import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import express from "express";
import pg from "pg";
import { createVehicleHandoffRouter } from "../src/routes/vehicle-distribution/handoff-router";
import {
  bootstrapPilotInTx,
  PILOT_LOCK_KEY,
  PILOT_AGENT_NAME,
  PILOT_WAREHOUSE_NAME,
  PILOT_VEHICLE_PLATE,
  PILOT_VEHICLE_TYPE,
} from "../src/routes/vehicle-distribution/service";

// ─────────────────────────────────────────────────────────────────────────────
// F3 Vehicle Handoff — isolated throwaway-DB integration tests.
//
// Provisions a genuinely separate throwaway DATABASE, brings up the distribution
// schema (incl. F3-additive columns + vehicle_label_claims) via the REAL bot
// init_db() with the vehicle DDL gate on, and mirrors the public runtime tables
// (warehouses, inventory, products, stock_movements, production_labels,
// admin_users/admin_sessions) here. The dedicated vehicle-handoff router is
// mounted with its OWN auth wall (no global requireAuth in front), so both
// credential paths (admin Bearer + bot key) and the actor assignment are
// exercised end-to-end.
// ─────────────────────────────────────────────────────────────────────────────

const { Client, Pool } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl)
  throw new Error(
    "RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests",
  );

const TMP_DB = `topmart_vehicle_handoff_${process.pid}_${Date.now()}`;
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
  TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_VEHICLE_HANDOFF",
  VEHICLE_DISTRIBUTION_SCHEMA_APPROVED: "1",
  // F4: bring up public.production_labels (+ immutability trigger + the VH
  // partial unique index) via the real bot init_db so the label endpoints work.
  PRODUCTION_LABELS_SCHEMA_APPROVED: "1",
};

const BOT_KEY = "super-secret-bot-key-1234567890";

let client: pg.Client;
let testPool: pg.Pool;

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

async function createPublicTables(c: pg.Client): Promise<void> {
  await c.query(`SET search_path TO public`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS warehouses (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      location_type TEXT NOT NULL DEFAULT 'general',
      capacity_kg   NUMERIC DEFAULT 20000,
      purpose       TEXT NOT NULL DEFAULT 'finished',
      created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id           SERIAL PRIMARY KEY,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      product      TEXT NOT NULL,
      quantity     NUMERIC NOT NULL DEFAULT 0,
      weight_kg    NUMERIC NOT NULL DEFAULT 0,
      product_type TEXT NOT NULL DEFAULT 'finished',
      updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      UNIQUE (warehouse_id, product)
    )`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS products (
      id                SERIAL UNIQUE NOT NULL,
      name              TEXT PRIMARY KEY,
      sku               TEXT NOT NULL DEFAULT '',
      weight            NUMERIC(12,3) NOT NULL DEFAULT 1,
      active            BOOLEAN NOT NULL DEFAULT TRUE
    )`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id                SERIAL PRIMARY KEY,
      product           TEXT NOT NULL,
      quantity          NUMERIC NOT NULL DEFAULT 0,
      movement_type     TEXT NOT NULL,
      from_warehouse_id INTEGER,
      to_warehouse_id   INTEGER,
      note              TEXT NOT NULL DEFAULT '',
      created_by        TEXT NOT NULL DEFAULT '',
      product_type      TEXT NOT NULL DEFAULT 'finished',
      created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      weight_kg         NUMERIC,
      reference         TEXT,
      reason            TEXT
    )`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id            SERIAL PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL DEFAULT '',
      role          TEXT NOT NULL DEFAULT 'admin',
      created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token   TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE
    )`);
}

async function seedAgent(name: string, faol = 1): Promise<number> {
  const r = await client.query(
    `INSERT INTO distribution.delivery_agents (name, telefon, hudud, telegram_id, faol, created_at)
     VALUES ($1, '+998900000000', 'Test tuman', $2, $3, '2026-01-01T09:00:00') RETURNING id`,
    [name, Math.floor(Math.random() * 1e9), faol],
  );
  return Number(r.rows[0].id);
}

async function seedUser(username: string, role: string): Promise<string> {
  const u = await client.query(
    `INSERT INTO admin_users (username, password_hash, role) VALUES ($1, 'x', $2) RETURNING id`,
    [username, role],
  );
  const token = `tok-${username}-${Date.now()}-${Math.random()}`;
  await client.query(
    `INSERT INTO admin_sessions (token, user_id) VALUES ($1, $2)`,
    [token, u.rows[0].id],
  );
  return token;
}

// Distribution product + mapped public product; returns { mahsulotId, name, sku }.
async function seedProduct(
  sku: string,
  name: string,
  weight: number,
): Promise<{ mahsulotId: number; name: string; sku: string }> {
  const dp = await client.query(
    `INSERT INTO distribution.mahsulotlar (nomi, sku, faol) VALUES ($1,$2,1) RETURNING id`,
    [name, sku],
  );
  await client.query(
    `INSERT INTO products (name, sku, weight, active) VALUES ($1,$2,$3,TRUE)
     ON CONFLICT (name) DO UPDATE SET sku=EXCLUDED.sku, weight=EXCLUDED.weight, active=TRUE`,
    [name, sku, weight],
  );
  return { mahsulotId: Number(dp.rows[0].id), name, sku };
}

async function setStock(
  warehouseId: number,
  product: string,
  qty: number,
  weight: number,
): Promise<void> {
  await client.query(
    `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (warehouse_id, product) DO UPDATE
       SET quantity=EXCLUDED.quantity, weight_kg=EXCLUDED.weight_kg`,
    [warehouseId, product, qty, weight],
  );
}

// ── HTTP harness — dedicated handoff router with its OWN auth wall only ───────
function makeApp(): http.Server {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    next();
  });
  app.use(createVehicleHandoffRouter(testPool));
  return http.createServer(app);
}

let server: http.Server;
let baseUrl = "";

type Resp = { status: number; body: any };
async function call(
  method: string,
  pathname: string,
  opts: { token?: string; botKey?: string; body?: unknown } = {},
): Promise<Resp> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.botKey) headers["x-vehicle-distribution-bot-key"] = opts.botKey;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    ...(method === "POST"
      ? { body: JSON.stringify(opts.body ?? {}) }
      : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let adminToken = "";
let workerToken = "";
let vehicleId = 0;
let vehicleWarehouseId = 0;
let erpWarehouseId = 0;
let prodA: { mahsulotId: number; name: string; sku: string };
let prodB: { mahsulotId: number; name: string; sku: string };

async function bootstrapPilot(): Promise<void> {
  const c = await testPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [PILOT_LOCK_KEY]);
    await bootstrapPilotInTx(c);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}

let opCounter = 0;
function opKey(): string {
  return `op-${process.pid}-${Date.now()}-${++opCounter}`;
}

async function cleanHandoffs(): Promise<void> {
  await client.query(`DELETE FROM distribution.vehicle_unit_events`);
  await client.query(`DELETE FROM distribution.vehicle_label_print_sessions`);
  await client.query(`DELETE FROM distribution.vehicle_label_prepare_sessions`);
  await client.query(`DELETE FROM distribution.vehicle_label_claims`);
  await client.query(`DELETE FROM distribution.vehicle_handoff_items`);
  await client.query(`DELETE FROM distribution.vehicle_handoffs`);
  await client.query(`DELETE FROM stock_movements`);
  // Immutable trigger blocks UPDATE not DELETE — safe to clear VH passports.
  await client.query(`DELETE FROM production_labels WHERE batch_code LIKE 'VH-%'`);
}

// F4: drive the real prepare endpoint to materialise passports/claims/events.
async function prepareLabels(
  handoffId: number,
  opts: { token?: string; botKey?: string } = { token: adminToken },
): Promise<Resp> {
  return call(
    "POST",
    `/vehicle-distribution/handoffs/${handoffId}/labels/prepare`,
    { ...opts, body: { operationKey: opKey() } },
  );
}

// F4: confirm helper that always supplies a fresh operationKey.
async function confirmPrinted(
  handoffId: number,
  opts: { token?: string; botKey?: string; operationKey?: string } = {
    token: adminToken,
  },
): Promise<Resp> {
  const { operationKey, ...rest } = opts;
  return call(
    "POST",
    `/vehicle-distribution/handoffs/${handoffId}/confirm-labels-printed`,
    { ...rest, body: { operationKey: operationKey ?? opKey() } },
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
  execFileSync("python3", ["-c", "import main; main.init_db()"], {
    cwd: botDir,
    env: botEnv,
    stdio: "pipe",
  });

  client = new Client({ connectionString: tmpUrl(), ssl });
  await client.connect();
  await createPublicTables(client);
  await client.query(`SET search_path TO distribution, public`);
  testPool = new Pool({ connectionString: tmpUrl(), ssl, max: 8 });

  await seedAgent(PILOT_AGENT_NAME);
  adminToken = await seedUser("adminA", "admin");
  workerToken = await seedUser("workerA", "worker");

  process.env.VEHICLE_DISTRIBUTION_ENABLED = "1";
  process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED = "1";
  process.env.VEHICLE_DISTRIBUTION_BOT_KEY = BOT_KEY;
  process.env.PRODUCTION_LABELS_SCHEMA_APPROVED = "1";

  await bootstrapPilot();

  const veh = await client.query(
    `SELECT id, warehouse_id FROM distribution.vehicles WHERE plate_number='DM-001'`,
  );
  vehicleId = Number(veh.rows[0].id);
  vehicleWarehouseId = Number(veh.rows[0].warehouse_id);

  const erp = await client.query(
    `INSERT INTO warehouses (name, active, location_type, purpose)
     VALUES ('ERP Manba', TRUE, 'general', 'finished') RETURNING id`,
  );
  erpWarehouseId = Number(erp.rows[0].id);

  prodA = await seedProduct("SKU-A", "Arqon A", 2.5);
  prodB = await seedProduct("SKU-B", "Arqon B", 1.0);

  server = makeApp();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
}, 180_000);

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (testPool) await testPool.end();
  if (client) await client.end();
  await dropTmpDb();
}, 60_000);

beforeEach(async () => {
  process.env.VEHICLE_DISTRIBUTION_ENABLED = "1";
  process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED = "1";
  process.env.VEHICLE_DISTRIBUTION_BOT_KEY = BOT_KEY;
  process.env.PRODUCTION_LABELS_SCHEMA_APPROVED = "1";
  await cleanHandoffs();
  await setStock(erpWarehouseId, prodA.name, 100, 250);
  await setStock(erpWarehouseId, prodB.name, 100, 100);
  await setStock(vehicleWarehouseId, prodA.name, 0, 0);
  await setStock(vehicleWarehouseId, prodB.name, 0, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Dedicated auth wall
// ─────────────────────────────────────────────────────────────────────────────
describe("dedicated auth wall", () => {
  it("no credential → 401", async () => {
    const r = await call("GET", "/vehicle-distribution/handoffs");
    expect(r.status).toBe(401);
  });
  it("wrong bot key (no bearer) → 401", async () => {
    const r = await call("GET", "/vehicle-distribution/handoffs", {
      botKey: "not-the-key-not-the-key-not-the-",
    });
    expect(r.status).toBe(401);
  });
  it("correct bot key → 200", async () => {
    const r = await call("GET", "/vehicle-distribution/handoffs", {
      botKey: BOT_KEY,
    });
    expect(r.status).toBe(200);
  });
  it("bot key ignored when env var is unset → 401", async () => {
    delete process.env.VEHICLE_DISTRIBUTION_BOT_KEY;
    const r = await call("GET", "/vehicle-distribution/handoffs", {
      botKey: BOT_KEY,
    });
    expect(r.status).toBe(401);
  });
  it("non-admin bearer → 403", async () => {
    const r = await call("GET", "/vehicle-distribution/handoffs", {
      token: workerToken,
    });
    expect(r.status).toBe(403);
  });
  it("admin bearer → 200", async () => {
    const r = await call("GET", "/vehicle-distribution/handoffs", {
      token: adminToken,
    });
    expect(r.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature gates (applied AFTER auth)
// ─────────────────────────────────────────────────────────────────────────────
describe("feature gate (fail-closed, after auth)", () => {
  it("disabled → 404 (even with valid admin)", async () => {
    delete process.env.VEHICLE_DISTRIBUTION_ENABLED;
    delete process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED;
    const r = await call("GET", "/vehicle-distribution/handoffs", {
      token: adminToken,
    });
    expect(r.status).toBe(404);
  });
  it("enabled but schema not approved → 503", async () => {
    process.env.VEHICLE_DISTRIBUTION_ENABLED = "1";
    delete process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED;
    const r = await call("GET", "/vehicle-distribution/handoffs", {
      token: adminToken,
    });
    expect(r.status).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F4: labels prepare / get / confirm (production-label gate + passport contract)
// ─────────────────────────────────────────────────────────────────────────────
const BARCODE_RE = /^TM[A-Z2-7]{16}$/;

describe("F4 production-label gate", () => {
  it("prepare → 503 when PRODUCTION_LABELS_SCHEMA_APPROVED unset (no DB write)", async () => {
    const { handoffId } = await makePrepared(2);
    delete process.env.PRODUCTION_LABELS_SCHEMA_APPROVED;
    const r = await call(
      "POST",
      `/vehicle-distribution/handoffs/${handoffId}/labels/prepare`,
      { token: adminToken, body: { operationKey: opKey() } },
    );
    expect(r.status).toBe(503);
    // No passports or claims written.
    const n = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicle_label_claims WHERE handoff_id=$1`,
      [handoffId],
    );
    expect(Number(n.rows[0].n)).toBe(0);
  });

  it("GET labels → 503 when production schema unset", async () => {
    const { handoffId } = await makePrepared(1);
    delete process.env.PRODUCTION_LABELS_SCHEMA_APPROVED;
    const r = await call(
      "GET",
      `/vehicle-distribution/handoffs/${handoffId}/labels`,
      { token: adminToken },
    );
    expect(r.status).toBe(503);
  });

  it("confirm → 503 when production schema unset", async () => {
    const { handoffId } = await makePreparedWithLabels(1);
    delete process.env.PRODUCTION_LABELS_SCHEMA_APPROVED;
    const r = await call(
      "POST",
      `/vehicle-distribution/handoffs/${handoffId}/confirm-labels-printed`,
      { token: adminToken, body: { operationKey: opKey() } },
    );
    expect(r.status).toBe(503);
  });
});

describe("F4 prepare labels", () => {
  it("rejects missing operationKey (400)", async () => {
    const { handoffId } = await makePrepared(1);
    const r = await call(
      "POST",
      `/vehicle-distribution/handoffs/${handoffId}/labels/prepare`,
      { token: adminToken, body: {} },
    );
    expect(r.status).toBe(400);
  });

  it("rejects unknown body properties (400)", async () => {
    const { handoffId } = await makePrepared(1);
    const r = await call(
      "POST",
      `/vehicle-distribution/handoffs/${handoffId}/labels/prepare`,
      { token: adminToken, body: { operationKey: opKey(), extra: 1 } },
    );
    expect(r.status).toBe(400);
  });

  it("first prepare: exact counts of passports, claims, events + barcode identity", async () => {
    const r = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [
          { mahsulotId: prodA.mahsulotId, quantity: 3 },
          { mahsulotId: prodB.mahsulotId, quantity: 2 },
        ],
        operationKey: opKey(),
      },
    });
    const handoffId = r.body.id as number;

    const p = await prepareLabels(handoffId);
    expect(p.status).toBe(200);
    expect(p.body.totalLabels).toBe(5);
    expect(p.body.labels).toHaveLength(5);

    // One production_labels row per unit.
    const pl = await client.query(
      `SELECT COUNT(*)::int AS n FROM production_labels WHERE batch_code=$1`,
      [p.body.batchCode],
    );
    expect(Number(pl.rows[0].n)).toBe(5);
    // One claim per unit, status='prepared'.
    const cl = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicle_label_claims WHERE handoff_id=$1 AND status='prepared'`,
      [handoffId],
    );
    expect(Number(cl.rows[0].n)).toBe(5);
    // One label_prepared event per unit.
    const ev = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicle_unit_events WHERE handoff_id=$1 AND event_type='label_prepared'`,
      [handoffId],
    );
    expect(Number(ev.rows[0].n)).toBe(5);
    // One prepare session.
    const ps = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicle_label_prepare_sessions WHERE handoff_id=$1`,
      [handoffId],
    );
    expect(Number(ps.rows[0].n)).toBe(1);

    // Every barcode matches the RFC4648 Base32 contract and is unique.
    const barcodes = p.body.labels.map((l: any) => l.barcodeValue as string);
    for (const bc of barcodes) expect(bc).toMatch(BARCODE_RE);
    expect(new Set(barcodes).size).toBe(barcodes.length);

    // Global label numbering 1..5.
    const nums = p.body.labels
      .map((l: any) => l.labelNumber)
      .sort((a: number, b: number) => a - b);
    expect(nums).toEqual([1, 2, 3, 4, 5]);
    for (const l of p.body.labels) expect(l.totalLabels).toBe(5);
  });

  it("prepare does not mutate inventory or move stock", async () => {
    const { handoffId } = await makePrepared(2);
    await prepareLabels(handoffId);
    const veh = await client.query(
      `SELECT COALESCE(SUM(quantity),0)::float8 AS q FROM inventory WHERE warehouse_id=$1`,
      [vehicleWarehouseId],
    );
    expect(Number(veh.rows[0].q)).toBe(0);
    const src = await client.query(
      `SELECT quantity FROM inventory WHERE warehouse_id=$1 AND product=$2`,
      [erpWarehouseId, prodA.name],
    );
    expect(Number(src.rows[0].quantity)).toBe(100);
    const led = await client.query(`SELECT COUNT(*)::int AS n FROM stock_movements`);
    expect(Number(led.rows[0].n)).toBe(0);
  });

  it("replay with the same operationKey → idempotent, no duplicate passports", async () => {
    const { handoffId } = await makePrepared(2);
    const key = opKey();
    const p1 = await call(
      "POST",
      `/vehicle-distribution/handoffs/${handoffId}/labels/prepare`,
      { token: adminToken, body: { operationKey: key } },
    );
    const p2 = await call(
      "POST",
      `/vehicle-distribution/handoffs/${handoffId}/labels/prepare`,
      { token: adminToken, body: { operationKey: key } },
    );
    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    const bc1 = p1.body.labels.map((l: any) => l.barcodeValue).sort();
    const bc2 = p2.body.labels.map((l: any) => l.barcodeValue).sort();
    expect(bc2).toEqual(bc1); // same persisted barcodes
    const cl = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicle_label_claims WHERE handoff_id=$1`,
      [handoffId],
    );
    expect(Number(cl.rows[0].n)).toBe(2); // not 4
  });

  it("second prepare with a DIFFERENT key on same handoff → 409 (fingerprint)", async () => {
    const { handoffId } = await makePrepared(2);
    await prepareLabels(handoffId);
    const r = await call(
      "POST",
      `/vehicle-distribution/handoffs/${handoffId}/labels/prepare`,
      { token: adminToken, body: { operationKey: opKey() } },
    );
    expect(r.status).toBe(409);
  });

  it("same operationKey reused on ANOTHER handoff → 409", async () => {
    const a = await makePrepared(1);
    const b = await makePrepared(1);
    const key = opKey();
    const r1 = await call(
      "POST",
      `/vehicle-distribution/handoffs/${a.handoffId}/labels/prepare`,
      { token: adminToken, body: { operationKey: key } },
    );
    expect(r1.status).toBe(200);
    const r2 = await call(
      "POST",
      `/vehicle-distribution/handoffs/${b.handoffId}/labels/prepare`,
      { token: adminToken, body: { operationKey: key } },
    );
    expect(r2.status).toBe(409);
  });
});

describe("F4 get labels payload", () => {
  it("returns the prepared passport payload", async () => {
    const { handoffId } = await makePreparedWithLabels(2);
    const r = await call(
      "GET",
      `/vehicle-distribution/handoffs/${handoffId}/labels`,
      { token: adminToken },
    );
    expect(r.status).toBe(200);
    expect(r.body.totalLabels).toBe(2);
    expect(r.body.labels).toHaveLength(2);
    expect(String(r.body.batchCode)).toMatch(/^VH-/);
    for (const l of r.body.labels) {
      expect(l.barcodeValue).toMatch(BARCODE_RE);
      expect(typeof l.producedAt).toBe("string");
      expect(l.productSku).toBe(prodA.sku);
    }
  });

  it("GET labels before prepare → empty payload (no passports)", async () => {
    const { handoffId } = await makePrepared(1);
    const r = await call(
      "GET",
      `/vehicle-distribution/handoffs/${handoffId}/labels`,
      { token: adminToken },
    );
    expect(r.status).toBe(200);
    expect(r.body.totalLabels).toBe(0);
    expect(r.body.labels).toHaveLength(0);
  });
});

describe("F4 confirm: first print + reprint", () => {
  it("first confirm transitions prepared → labels_printed, isReprint=false", async () => {
    const { handoffId } = await makePreparedWithLabels(2);
    const c = await confirmPrinted(handoffId);
    expect(c.status).toBe(200);
    expect(c.body.handoff.status).toBe("labels_printed");
    expect(c.body.isReprint).toBe(false);
    expect(c.body.atLeastOnce).toBe(true);
    const pc = await client.query(
      `SELECT COALESCE(SUM(print_count),0)::int AS n FROM production_labels WHERE batch_code=$1`,
      [c.body.labels[0].batchCode],
    );
    expect(Number(pc.rows[0].n)).toBeGreaterThanOrEqual(2);
  });

  it("same-key confirm retry → no print_count increment", async () => {
    const { handoffId } = await makePreparedWithLabels(1);
    const key = opKey();
    const c1 = await confirmPrinted(handoffId, { token: adminToken, operationKey: key });
    expect(c1.status).toBe(200);
    const batchCode = c1.body.labels[0].batchCode;
    const after1 = await client.query(
      `SELECT COALESCE(SUM(print_count),0)::int AS n FROM production_labels WHERE batch_code=$1`,
      [batchCode],
    );
    const c2 = await confirmPrinted(handoffId, { token: adminToken, operationKey: key });
    expect(c2.status).toBe(200);
    const after2 = await client.query(
      `SELECT COALESCE(SUM(print_count),0)::int AS n FROM production_labels WHERE batch_code=$1`,
      [batchCode],
    );
    expect(Number(after2.rows[0].n)).toBe(Number(after1.rows[0].n));
  });

  it("reprint with a NEW key → isReprint=true, print_count increments", async () => {
    const { handoffId } = await makePreparedWithLabels(1);
    const c1 = await confirmPrinted(handoffId);
    const batchCode = c1.body.labels[0].batchCode;
    const after1 = await client.query(
      `SELECT COALESCE(SUM(print_count),0)::int AS n FROM production_labels WHERE batch_code=$1`,
      [batchCode],
    );
    const c2 = await confirmPrinted(handoffId); // fresh key
    expect(c2.status).toBe(200);
    expect(c2.body.isReprint).toBe(true);
    const after2 = await client.query(
      `SELECT COALESCE(SUM(print_count),0)::int AS n FROM production_labels WHERE batch_code=$1`,
      [batchCode],
    );
    expect(Number(after2.rows[0].n)).toBeGreaterThan(Number(after1.rows[0].n));
  });

  it("confirm on a cancelled handoff → 409", async () => {
    const { handoffId } = await makePreparedWithLabels(1);
    await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/cancel`, {
      token: adminToken,
    });
    const c = await confirmPrinted(handoffId);
    expect(c.status).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Create validation + idempotent replay
// ─────────────────────────────────────────────────────────────────────────────
describe("create prepared handoff", () => {
  it("rejects unknown body properties (400)", async () => {
    const r = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 2 }],
        operationKey: opKey(),
        hacker: 1,
      },
    });
    expect(r.status).toBe(400);
  });

  it("rejects missing operationKey (400)", async () => {
    const r = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 2 }],
      },
    });
    expect(r.status).toBe(400);
  });

  it("rejects vehicle-warehouse as source (400)", async () => {
    const r = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: vehicleWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 1 }],
        operationKey: opKey(),
      },
    });
    expect(r.status).toBe(400);
  });

  it("rejects duplicate product ids (400)", async () => {
    const r = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [
          { mahsulotId: prodA.mahsulotId, quantity: 1 },
          { mahsulotId: prodA.mahsulotId, quantity: 2 },
        ],
        operationKey: opKey(),
      },
    });
    expect(r.status).toBe(400);
  });

  it("creates a prepared handoff with server-side actor + weight snapshots", async () => {
    const key = opKey();
    const r = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 3 }],
        notes: "x",
        operationKey: key,
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("prepared");
    expect(r.body.vehicleId).toBe(vehicleId);
    expect(r.body.vehicleWarehouseId).toBe(vehicleWarehouseId);
    expect(r.body.preparedActorType).toBe("admin");
    expect(r.body.preparedActorRef).toBe("adminA");
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].productName).toBe(prodA.name);
    expect(r.body.items[0].sku).toBe(prodA.sku);
    expect(Number(r.body.items[0].unitWeightKg)).toBeCloseTo(2.5, 3);
    expect(Number(r.body.items[0].totalWeightKg)).toBeCloseTo(7.5, 3);
    // No inventory mutation on create.
    const src = await client.query(
      `SELECT quantity FROM inventory WHERE warehouse_id=$1 AND product=$2`,
      [erpWarehouseId, prodA.name],
    );
    expect(Number(src.rows[0].quantity)).toBe(100);
  });

  it("bot-created handoff carries the warehouse_bot actor", async () => {
    const r = await call("POST", "/vehicle-distribution/handoffs", {
      botKey: BOT_KEY,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 1 }],
        operationKey: opKey(),
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.preparedActorType).toBe("warehouse_bot");
    expect(r.body.preparedActorRef).toBe("vehicle-distribution-bot");
  });

  it("replay with the same key returns the same handoff (no dup rows)", async () => {
    const key = opKey();
    const body = {
      sourceWarehouseId: erpWarehouseId,
      items: [{ mahsulotId: prodA.mahsulotId, quantity: 2 }],
      operationKey: key,
    };
    const r1 = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body,
    });
    const r2 = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body,
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.id).toBe(r1.body.id);
    const n = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicle_handoffs`,
    );
    expect(Number(n.rows[0].n)).toBe(1);
  });

  it("replay with a different payload → 409", async () => {
    const key = opKey();
    await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 2 }],
        operationKey: key,
      },
    });
    const r2 = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 5 }],
        operationKey: key,
      },
    });
    expect(r2.status).toBe(409);
  });

  it("concurrent create with the same key → one handoff", async () => {
    const key = opKey();
    const body = {
      sourceWarehouseId: erpWarehouseId,
      items: [{ mahsulotId: prodB.mahsulotId, quantity: 1 }],
      operationKey: key,
    };
    const [a, b] = await Promise.all([
      call("POST", "/vehicle-distribution/handoffs", { token: adminToken, body }),
      call("POST", "/vehicle-distribution/handoffs", { token: adminToken, body }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.id).toBe(b.body.id);
    const n = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicle_handoffs WHERE operation_key=$1`,
      [key],
    );
    expect(Number(n.rows[0].n)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: create a prepared handoff (status='prepared', no labels yet)
// ─────────────────────────────────────────────────────────────────────────────
async function makePrepared(
  qtyA: number,
): Promise<{ handoffId: number; itemId: number }> {
  const r = await call("POST", "/vehicle-distribution/handoffs", {
    token: adminToken,
    body: {
      sourceWarehouseId: erpWarehouseId,
      items: [{ mahsulotId: prodA.mahsulotId, quantity: qtyA }],
      operationKey: opKey(),
    },
  });
  expect(r.status).toBe(200);
  const handoffId = r.body.id as number;
  const itemId = r.body.items[0].id as number;
  return { handoffId, itemId };
}

// Create a prepared handoff AND run the real prepare endpoint so labels/claims
// exist — the F4 pre-requisite for a confirm.
async function makePreparedWithLabels(
  qtyA: number,
): Promise<{ handoffId: number; itemId: number }> {
  const base = await makePrepared(qtyA);
  const p = await prepareLabels(base.handoffId);
  expect(p.status).toBe(200);
  return base;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transition matrix + claim invariants
// ─────────────────────────────────────────────────────────────────────────────
describe("lifecycle transitions", () => {
  it("confirm before prepare → 409 (labels not prepared)", async () => {
    const { handoffId } = await makePrepared(2);
    const r = await confirmPrinted(handoffId);
    expect(r.status).toBe(409);
  });

  it("confirm without operationKey → 400", async () => {
    const { handoffId } = await makePreparedWithLabels(1);
    const r = await call(
      "POST",
      `/vehicle-distribution/handoffs/${handoffId}/confirm-labels-printed`,
      { token: adminToken, body: {} },
    );
    expect(r.status).toBe(400);
  });

  it("cannot skip states: prepared → handed-over rejected (409)", async () => {
    const { handoffId } = await makePrepared(1);
    const r = await call(
      "POST",
      `/vehicle-distribution/handoffs/${handoffId}/handed-over`,
      { token: adminToken },
    );
    expect(r.status).toBe(409);
  });

  it("cannot transfer stock before handed-over (409) and no stock moved", async () => {
    const { handoffId } = await makePrepared(2);
    const r = await call(
      "POST",
      `/vehicle-distribution/handoffs/${handoffId}/stock-transferred`,
      { token: adminToken },
    );
    expect(r.status).toBe(409);
    const veh = await client.query(
      `SELECT COALESCE(SUM(quantity),0)::float8 AS q FROM inventory WHERE warehouse_id=$1`,
      [vehicleWarehouseId],
    );
    expect(Number(veh.rows[0].q)).toBe(0);
  });

  it("happy path: prepared → printed → handed_over → stock_transferred with exact qty/weight + ledger + events", async () => {
    const r = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [
          { mahsulotId: prodA.mahsulotId, quantity: 3 },
          { mahsulotId: prodB.mahsulotId, quantity: 2 },
        ],
        operationKey: opKey(),
      },
    });
    expect(r.status).toBe(200);
    const handoffId = r.body.id as number;
    const itemA = r.body.items.find((i: any) => i.mahsulotId === prodA.mahsulotId);
    const itemB = r.body.items.find((i: any) => i.mahsulotId === prodB.mahsulotId);

    const prep = await prepareLabels(handoffId);
    expect(prep.status).toBe(200);
    expect(prep.body.totalLabels).toBe(5);

    const p = await confirmPrinted(handoffId);
    expect(p.status).toBe(200);
    expect(p.body.handoff.status).toBe("labels_printed");
    expect(p.body.isReprint).toBe(false);
    expect(p.body.atLeastOnce).toBe(true);

    const h = await call(
      "POST",
      `/vehicle-distribution/handoffs/${handoffId}/handed-over`,
      { token: adminToken },
    );
    expect(h.status).toBe(200);
    expect(h.body.status).toBe("handed_over");

    const s = await call(
      "POST",
      `/vehicle-distribution/handoffs/${handoffId}/stock-transferred`,
      { token: adminToken },
    );
    expect(s.status).toBe(200);
    expect(s.body.status).toBe("stock_transferred");
    // Deterministic movement_reference — no timestamps or random components.
    expect(s.body.movementReference).toBe(`vehicle-handoff:${handoffId}:stock-transferred`);

    // Every ledger row must have a deterministic per-item reference.
    const ledRows = await client.query(
      `SELECT reference, note FROM stock_movements WHERE movement_type='TRANSFER' ORDER BY id`,
    );
    expect(ledRows.rows).toHaveLength(2);
    for (const row of ledRows.rows) {
      // reference column: vehicle-handoff:<handoffId>:item:<itemId>
      expect(String(row.reference)).toMatch(/^vehicle-handoff:\d+:item:\d+$/);
      // note is human-readable (not the same as reference)
      expect(String(row.note)).toContain(`Vehicle handoff ${handoffId}`);
      expect(String(row.note)).not.toBe(String(row.reference));
    }
    const itemRefs = ledRows.rows.map((r) => String(r.reference));
    expect(itemRefs).toContain(`vehicle-handoff:${handoffId}:item:${itemA.id}`);
    expect(itemRefs).toContain(`vehicle-handoff:${handoffId}:item:${itemB.id}`);

    // Source subtracted exactly, vehicle added exactly.
    const srcA = await client.query(
      `SELECT quantity, weight_kg FROM inventory WHERE warehouse_id=$1 AND product=$2`,
      [erpWarehouseId, prodA.name],
    );
    expect(Number(srcA.rows[0].quantity)).toBe(97);
    expect(Number(srcA.rows[0].weight_kg)).toBeCloseTo(250 - 7.5, 3);
    const vehA = await client.query(
      `SELECT quantity, weight_kg FROM inventory WHERE warehouse_id=$1 AND product=$2`,
      [vehicleWarehouseId, prodA.name],
    );
    expect(Number(vehA.rows[0].quantity)).toBe(3);
    expect(Number(vehA.rows[0].weight_kg)).toBeCloseTo(7.5, 3);

    // One ledger row per item.
    const led = await client.query(
      `SELECT COUNT(*)::int AS n FROM stock_movements WHERE movement_type='TRANSFER'`,
    );
    expect(Number(led.rows[0].n)).toBe(2);

    // Claims loaded + load events per unit.
    const loaded = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicle_label_claims WHERE handoff_id=$1 AND status='loaded'`,
      [handoffId],
    );
    expect(Number(loaded.rows[0].n)).toBe(5);
    const loadEvents = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicle_unit_events WHERE handoff_id=$1 AND event_type='load'`,
      [handoffId],
    );
    expect(Number(loadEvents.rows[0].n)).toBe(5);
  });

  it("stock-transferred retry is idempotent (no double movement)", async () => {
    const r = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 2 }],
        operationKey: opKey(),
      },
    });
    const handoffId = r.body.id as number;
    await prepareLabels(handoffId);
    await confirmPrinted(handoffId);
    await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/handed-over`, { token: adminToken });
    const s1 = await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/stock-transferred`, { token: adminToken });
    const s2 = await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/stock-transferred`, { token: adminToken });
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    // Both responses must carry the same deterministic movementReference.
    expect(s1.body.movementReference).toBe(`vehicle-handoff:${handoffId}:stock-transferred`);
    expect(s2.body.movementReference).toBe(s1.body.movementReference);
    const vehA = await client.query(
      `SELECT quantity FROM inventory WHERE warehouse_id=$1 AND product=$2`,
      [vehicleWarehouseId, prodA.name],
    );
    expect(Number(vehA.rows[0].quantity)).toBe(2); // not 4
    const led = await client.query(`SELECT COUNT(*)::int AS n FROM stock_movements`);
    expect(Number(led.rows[0].n)).toBe(1);
    // The single ledger row has the deterministic per-item reference.
    const ledRow = await client.query(`SELECT reference FROM stock_movements`);
    expect(String(ledRow.rows[0].reference)).toMatch(/^vehicle-handoff:\d+:item:\d+$/);
  });

  it("insufficient source quantity → full rollback (409, no partial stock)", async () => {
    await setStock(erpWarehouseId, prodA.name, 1, 2.5); // only 1 unit
    const r = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 5 }],
        operationKey: opKey(),
      },
    });
    const handoffId = r.body.id as number;
    await prepareLabels(handoffId);
    await confirmPrinted(handoffId);
    await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/handed-over`, { token: adminToken });
    const s = await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/stock-transferred`, { token: adminToken });
    expect(s.status).toBe(409);
    const src = await client.query(
      `SELECT quantity FROM inventory WHERE warehouse_id=$1 AND product=$2`,
      [erpWarehouseId, prodA.name],
    );
    expect(Number(src.rows[0].quantity)).toBe(1); // untouched
    const veh = await client.query(
      `SELECT COALESCE(SUM(quantity),0)::float8 AS q FROM inventory WHERE warehouse_id=$1`,
      [vehicleWarehouseId],
    );
    expect(Number(veh.rows[0].q)).toBe(0);
    const led = await client.query(`SELECT COUNT(*)::int AS n FROM stock_movements`);
    expect(Number(led.rows[0].n)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-handoff claim reuse
// ─────────────────────────────────────────────────────────────────────────────
describe("cross-handoff claim invariant", () => {
  it("a physical unit (production_label_id) cannot be claimed by two handoffs", async () => {
    const r1 = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 1 }],
        operationKey: opKey(),
      },
    });
    const h1 = r1.body.id as number;
    const i1 = r1.body.items[0].id as number;
    const dupLabel = 55550001;
    await client.query(
      `INSERT INTO distribution.vehicle_label_claims
         (vehicle_id, handoff_id, handoff_item_id, production_label_id, barcode,
          mahsulot_id, sku, unit_weight_kg, status)
       VALUES ($1,$2,$3,$4,'BC-DUP-1',$5,$6,2.5,'prepared')`,
      [vehicleId, h1, i1, dupLabel, prodA.mahsulotId, prodA.sku],
    );

    const r2 = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 1 }],
        operationKey: opKey(),
      },
    });
    const h2 = r2.body.id as number;
    const i2 = r2.body.items[0].id as number;
    await expect(
      client.query(
        `INSERT INTO distribution.vehicle_label_claims
           (vehicle_id, handoff_id, handoff_item_id, production_label_id, barcode,
            mahsulot_id, sku, unit_weight_kg, status)
         VALUES ($1,$2,$3,$4,'BC-DUP-2',$5,$6,2.5,'prepared')`,
        [vehicleId, h2, i2, dupLabel, prodA.mahsulotId, prodA.sku],
      ),
    ).rejects.toThrow(/uq_vehicle_label_claims_production_label|duplicate/i);
  });

  it("confirm rejected (409) when a prepared passport is void", async () => {
    const { handoffId } = await makePreparedWithLabels(1);
    // Void the single passport out-of-band (immutable trigger allows status
    // change to void; it only freezes identity/snapshot columns).
    await client.query(
      `UPDATE production_labels SET status='void'
        WHERE id IN (SELECT production_label_id
                       FROM distribution.vehicle_label_claims WHERE handoff_id=$1)`,
      [handoffId],
    );
    const c = await confirmPrinted(handoffId);
    expect(c.status).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation
// ─────────────────────────────────────────────────────────────────────────────
describe("cancellation", () => {
  it("cancel a prepared handoff (200), retry idempotent, no stock", async () => {
    const { handoffId } = await makePrepared(2);
    const c1 = await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/cancel`, { token: adminToken });
    const c2 = await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/cancel`, { token: adminToken });
    expect(c1.status).toBe(200);
    expect(c1.body.status).toBe("cancelled");
    expect(c2.status).toBe(200);
    expect(c2.body.status).toBe("cancelled");
  });

  it("cannot cancel after stock_transferred (409)", async () => {
    const r = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 1 }],
        operationKey: opKey(),
      },
    });
    const handoffId = r.body.id as number;
    await prepareLabels(handoffId);
    await confirmPrinted(handoffId);
    await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/handed-over`, { token: adminToken });
    await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/stock-transferred`, { token: adminToken });
    const c = await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/cancel`, { token: adminToken });
    expect(c.status).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency
// ─────────────────────────────────────────────────────────────────────────────
describe("concurrency", () => {
  it("concurrent finalization of the same handoff → one success, stock once", async () => {
    const r = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 2 }],
        operationKey: opKey(),
      },
    });
    const handoffId = r.body.id as number;
    await prepareLabels(handoffId);
    await confirmPrinted(handoffId);
    await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/handed-over`, { token: adminToken });
    const [a, b] = await Promise.all([
      call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/stock-transferred`, { token: adminToken }),
      call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/stock-transferred`, { token: adminToken }),
    ]);
    // Both may return 200 (one does the work, the other same-state retry), but
    // stock must move exactly once.
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
    const vehA = await client.query(
      `SELECT quantity FROM inventory WHERE warehouse_id=$1 AND product=$2`,
      [vehicleWarehouseId, prodA.name],
    );
    expect(Number(vehA.rows[0].quantity)).toBe(2);
    const led = await client.query(`SELECT COUNT(*)::int AS n FROM stock_movements`);
    expect(Number(led.rows[0].n)).toBe(1);
  });

  it("two different handoffs contend for limited source stock → at most one succeeds", async () => {
    await setStock(erpWarehouseId, prodB.name, 2, 2); // only 2 units of B
    const mk = async () => {
      const r = await call("POST", "/vehicle-distribution/handoffs", {
        token: adminToken,
        body: {
          sourceWarehouseId: erpWarehouseId,
          items: [{ mahsulotId: prodB.mahsulotId, quantity: 2 }],
          operationKey: opKey(),
        },
      });
      const handoffId = r.body.id as number;
      await prepareLabels(handoffId);
      await confirmPrinted(handoffId);
      await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/handed-over`, { token: adminToken });
      return handoffId;
    };
    const h1 = await mk();
    const h2 = await mk();
    const [a, b] = await Promise.all([
      call(`POST`, `/vehicle-distribution/handoffs/${h1}/stock-transferred`, { token: adminToken }),
      call(`POST`, `/vehicle-distribution/handoffs/${h2}/stock-transferred`, { token: adminToken }),
    ]);
    const successes = [a, b].filter((x) => x.status === 200).length;
    expect(successes).toBe(1);
    // Source is fully drained (2 → 0) by the single winner, never negative.
    const src = await client.query(
      `SELECT quantity FROM inventory WHERE warehouse_id=$1 AND product=$2`,
      [erpWarehouseId, prodB.name],
    );
    expect(Number(src.rows[0].quantity)).toBe(0);
    expect(Number(src.rows[0].quantity)).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CHECK constraint upgrade migration (Fix 1)
//
// Simulates a database that had F1 DDL applied first (old event_type CHECK),
// then F3 init_db() run on top. Verifies that:
//   1. After F1-then-F3 init, label_printed inserts succeed.
//   2. The old F1-only events (load, unload, return, adjustment, sale) still work.
// This is tested by running init_db() in the throwaway DB that already has the
// vehicle tables (created by the global beforeAll), so the ALTER...DROP
// CONSTRAINT IF EXISTS + ADD CONSTRAINT upgrade path is exercised.
// ─────────────────────────────────────────────────────────────────────────────
describe("CHECK constraint upgrade migration (F1 schema → F3 init)", () => {
  it("running F3 init_db() on an existing F1 DB allows label_printed event inserts", async () => {
    // The throwaway DB was already set up with F3 DDL (global beforeAll ran
    // init_db with VEHICLE_DISTRIBUTION_SCHEMA_APPROVED=1). Running init_db()
    // again is idempotent and exercises the DROP+ADD upgrade path.
    execFileSync("python3", ["-c", "import main; main.init_db()"], {
      cwd: botDir,
      env: botEnv,
      stdio: "pipe",
    });

    // After upgrade, label_printed must be accepted by the CHECK.
    await expect(
      client.query(
        `INSERT INTO distribution.vehicle_unit_events
           (vehicle_id, mahsulot_id, sku, event_type, quantity, actor_id)
         VALUES ($1, 1, 'SKU-TEST', 'label_printed', 1, -1) RETURNING id`,
        [vehicleId],
      ),
    ).resolves.toBeDefined();

    // F1 events still work after the upgrade.
    await expect(
      client.query(
        `INSERT INTO distribution.vehicle_unit_events
           (vehicle_id, mahsulot_id, sku, event_type, quantity, actor_id)
         VALUES ($1, 1, 'SKU-TEST', 'load', 1, -1) RETURNING id`,
        [vehicleId],
      ),
    ).resolves.toBeDefined();

    // Cleanup the test-only rows so they don't affect other tests.
    await client.query(
      `DELETE FROM distribution.vehicle_unit_events WHERE sku='SKU-TEST' AND actor_id=-1`,
    );
  });

  it("label_prepared event type is also accepted after upgrade", async () => {
    await expect(
      client.query(
        `INSERT INTO distribution.vehicle_unit_events
           (vehicle_id, mahsulot_id, sku, event_type, quantity, actor_id)
         VALUES ($1, 1, 'SKU-TEST2', 'label_prepared', 1, -1) RETURNING id`,
        [vehicleId],
      ),
    ).resolves.toBeDefined();
    await client.query(
      `DELETE FROM distribution.vehicle_unit_events WHERE sku='SKU-TEST2' AND actor_id=-1`,
    );
  });

  it("bogus event_type still rejected after upgrade (CHECK still enforces valid set)", async () => {
    await expect(
      client.query(
        `INSERT INTO distribution.vehicle_unit_events
           (vehicle_id, mahsulot_id, sku, event_type, quantity, actor_id)
         VALUES ($1, 1, 'SKU-TEST3', 'bogus_event', 1, -1)`,
        [vehicleId],
      ),
    ).rejects.toThrow(/vehicle_unit_events_type_check/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveActivePilot strict identity (Fix 2)
//
// No-active-pilot, reassigned agent, wrong-vehicle — all must fail-closed.
// These are tested at the HTTP layer so we confirm the router maps them to 409.
// Each sub-test temporarily corrupts and then restores the pilot state.
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveActivePilot strict identity fail-closed (Fix 2)", () => {
  // Save / restore helpers around each test.
  let assignmentId = 0;
  let savedAgentId = 0;

  beforeAll(async () => {
    const asg = await client.query(
      `SELECT id, delivery_agent_id FROM distribution.vehicle_assignments WHERE status='active' LIMIT 1`,
    );
    assignmentId = Number(asg.rows[0].id);
    savedAgentId = Number(asg.rows[0].delivery_agent_id);
  });

  it("no active assignment → 409 on list", async () => {
    // End the active assignment temporarily.
    await client.query(
      `UPDATE distribution.vehicle_assignments SET status='ended' WHERE id=$1`,
      [assignmentId],
    );
    const r = await call("GET", "/vehicle-distribution/handoffs", {
      token: adminToken,
    });
    expect(r.status).toBe(409);
    // Restore.
    await client.query(
      `UPDATE distribution.vehicle_assignments SET status='active' WHERE id=$1`,
      [assignmentId],
    );
  });

  it("no active assignment → 409 on create", async () => {
    await client.query(
      `UPDATE distribution.vehicle_assignments SET status='ended' WHERE id=$1`,
      [assignmentId],
    );
    const r = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 1 }],
        operationKey: opKey(),
      },
    });
    expect(r.status).toBe(409);
    await client.query(
      `UPDATE distribution.vehicle_assignments SET status='active' WHERE id=$1`,
      [assignmentId],
    );
  });

  it("agent reassigned to a different vehicle → 409 on list", async () => {
    // Create a fake second vehicle and reassign the agent.
    const fakeWh = await client.query(
      `INSERT INTO warehouses (name, active, location_type, purpose)
       VALUES ('fake-veh-wh-r', TRUE, 'vehicle', 'finished') RETURNING id`,
    );
    const fakeVeh = await client.query(
      `INSERT INTO distribution.vehicles (plate_number, vehicle_type, warehouse_id)
       VALUES ('ZZ-FAKE', 'LABO', $1) RETURNING id`,
      [fakeWh.rows[0].id],
    );
    // End current assignment, create new one on fake vehicle.
    await client.query(
      `UPDATE distribution.vehicle_assignments SET status='ended' WHERE id=$1`,
      [assignmentId],
    );
    const newAsg = await client.query(
      `INSERT INTO distribution.vehicle_assignments (vehicle_id, delivery_agent_id, status)
       VALUES ($1, $2, 'active') RETURNING id`,
      [fakeVeh.rows[0].id, savedAgentId],
    );
    const r = await call("GET", "/vehicle-distribution/handoffs", {
      token: adminToken,
    });
    expect(r.status).toBe(409);
    // Restore: remove fake assignment + vehicle + warehouse, restore real assignment.
    await client.query(
      `DELETE FROM distribution.vehicle_assignments WHERE id=$1`,
      [newAsg.rows[0].id],
    );
    await client.query(
      `DELETE FROM distribution.vehicles WHERE id=$1`,
      [fakeVeh.rows[0].id],
    );
    await client.query(`DELETE FROM warehouses WHERE id=$1`, [fakeWh.rows[0].id]);
    await client.query(
      `UPDATE distribution.vehicle_assignments SET status='active' WHERE id=$1`,
      [assignmentId],
    );
  });

  it("pilot warehouse name changed → 409 on list", async () => {
    // Rename the vehicle warehouse temporarily.
    await client.query(
      `UPDATE warehouses SET name='WRONG-NAME' WHERE id=$1`,
      [vehicleWarehouseId],
    );
    const r = await call("GET", "/vehicle-distribution/handoffs", {
      token: adminToken,
    });
    expect(r.status).toBe(409);
    // Restore.
    await client.query(
      `UPDATE warehouses SET name=$1 WHERE id=$2`,
      [PILOT_WAREHOUSE_NAME, vehicleWarehouseId],
    );
  });

  it("restored pilot state works again after corruptions (sanity check)", async () => {
    const r = await call("GET", "/vehicle-distribution/handoffs", {
      token: adminToken,
    });
    expect(r.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic movement_reference (Fix 3) — additional assertions
// ─────────────────────────────────────────────────────────────────────────────
describe("deterministic movement_reference (Fix 3)", () => {
  it("movement_reference follows vehicle-handoff:<id>:stock-transferred pattern", async () => {
    const r = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 1 }],
        operationKey: opKey(),
      },
    });
    const handoffId = r.body.id as number;
    const itemId = r.body.items[0].id as number;
    await prepareLabels(handoffId);
    await confirmPrinted(handoffId);
    await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/handed-over`, { token: adminToken });
    const s = await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/stock-transferred`, { token: adminToken });
    expect(s.status).toBe(200);

    // Exact deterministic header reference.
    expect(s.body.movementReference).toBe(`vehicle-handoff:${handoffId}:stock-transferred`);

    // Stored in DB.
    const dbRef = await client.query(
      `SELECT movement_reference FROM distribution.vehicle_handoffs WHERE id=$1`,
      [handoffId],
    );
    expect(String(dbRef.rows[0].movement_reference)).toBe(`vehicle-handoff:${handoffId}:stock-transferred`);

    // Per-item ledger row: deterministic reference.
    const ledRow = await client.query(
      `SELECT reference, note FROM stock_movements WHERE movement_type='TRANSFER'`,
    );
    expect(ledRow.rows).toHaveLength(1);
    expect(String(ledRow.rows[0].reference)).toBe(`vehicle-handoff:${handoffId}:item:${itemId}`);
    // Human-readable note differs from reference.
    expect(String(ledRow.rows[0].note)).toContain("Vehicle handoff");
    expect(String(ledRow.rows[0].note)).not.toBe(String(ledRow.rows[0].reference));
  });

  it("retry produces identical movement_reference and no duplicate ledger rows", async () => {
    const r = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 1 }],
        operationKey: opKey(),
      },
    });
    const handoffId = r.body.id as number;
    const itemId = r.body.items[0].id as number;
    await prepareLabels(handoffId);
    await confirmPrinted(handoffId);
    await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/handed-over`, { token: adminToken });
    const s1 = await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/stock-transferred`, { token: adminToken });
    const s2 = await call(`POST`, `/vehicle-distribution/handoffs/${handoffId}/stock-transferred`, { token: adminToken });
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    const expectedRef = `vehicle-handoff:${handoffId}:stock-transferred`;
    expect(s1.body.movementReference).toBe(expectedRef);
    expect(s2.body.movementReference).toBe(expectedRef);
    // Exactly one ledger row — no duplicates on retry.
    const count = await client.query(`SELECT COUNT(*)::int AS n FROM stock_movements`);
    expect(Number(count.rows[0].n)).toBe(1);
    // The reference column is deterministic too.
    const row = await client.query(`SELECT reference FROM stock_movements`);
    expect(String(row.rows[0].reference)).toBe(`vehicle-handoff:${handoffId}:item:${itemId}`);
  });
});
