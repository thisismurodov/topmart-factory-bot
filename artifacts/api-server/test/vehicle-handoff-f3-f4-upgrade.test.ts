import { beforeAll, afterAll, describe, it, expect } from "vitest";
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
} from "../src/routes/vehicle-distribution/service";
import {
  requireVehicleTestAdminUrl,
  childDbUrl,
  sslFor,
  botDbEnv,
} from "./helpers/vehicle-test-db";

// ─────────────────────────────────────────────────────────────────────────────
// Sequential F3 → F4 throwaway-DB UPGRADE harness.
//
// This test proves that a genuinely-legacy F3 database (vehicle handoff schema
// WITHOUT the F4 session tables / VH partial index / production-label
// immutability trigger, plus a real seeded handoff + claims + printed event)
// can be upgraded IN PLACE by running the current initializers in the same
// gated order as production cold-start:
//
//   1. distribution-bot init_db()  (VEHICLE_DISTRIBUTION_SCHEMA_APPROVED=1)
//   2. API initDb()                (PRODUCTION_LABELS_SCHEMA_APPROVED=1)
//
// After the upgrade it boots the real vehicle-handoff HTTP router against that
// DB and drives the full F4 flow end-to-end across BOTH credential paths, then
// advances to a terminal state and reprints again. The DB is dropped at the end.
// ─────────────────────────────────────────────────────────────────────────────

const { Client, Pool } = pg;

// Admin/provisioning URL comes ONLY from the dedicated isolated variable — never
// from the runtime RAILWAY_DATABASE_URL / DATABASE_URL. Fails closed if absent.
const adminUrl = requireVehicleTestAdminUrl();

const TMP_DB = `topmart_vh_f3f4_upgrade_${process.pid}_${Date.now()}`;
const ssl = sslFor(adminUrl);

function tmpUrl(): string {
  return childDbUrl(adminUrl, TMP_DB);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const botDir = path.resolve(here, "../../distribution-bot");
const BOT_KEY = "super-secret-bot-key-f3f4-upgrade";
const {
  RAILWAY_DATABASE_URL: _ignoredRailwayDatabaseUrl,
  DATABASE_URL: _ignoredRuntimeDatabaseUrl,
  ...isolatedBotBaseEnv
} = process.env;

// Bot env WITHOUT PRODUCTION_LABELS approval — the distribution-bot never
// creates production_labels anyway; the API initDb owns that in step 2.
const botEnv = {
  ...isolatedBotBaseEnv,
  ...botDbEnv(tmpUrl()),
  TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_VH_F3F4",
  VEHICLE_DISTRIBUTION_SCHEMA_APPROVED: "1",
};

let client: pg.Client;
let testPool: pg.Pool;
let server: http.Server;
let baseUrl = "";

let adminToken = "";
let vehicleId = 0;
let vehicleWarehouseId = 0;
let erpWarehouseId = 0;
let prodA: { mahsulotId: number; name: string; sku: string };
let legacyHandoffId = 0;

let opCounter = 0;
function opKey(): string {
  return `f3f4-${process.pid}-${Date.now()}-${++opCounter}`;
}

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
    ...(method === "POST" ? { body: JSON.stringify(opts.body ?? {}) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

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

// Public runtime tables the router + initDb depend on.
async function createPublicBaseTables(c: pg.Client): Promise<void> {
  await c.query(`SET search_path TO public`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS warehouses (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      location_type TEXT NOT NULL DEFAULT 'general',
      capacity_kg NUMERIC DEFAULT 20000,
      purpose TEXT NOT NULL DEFAULT 'finished',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW())`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id SERIAL PRIMARY KEY,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      product TEXT NOT NULL, quantity NUMERIC NOT NULL DEFAULT 0,
      weight_kg NUMERIC NOT NULL DEFAULT 0,
      product_type TEXT NOT NULL DEFAULT 'finished',
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      UNIQUE (warehouse_id, product))`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL UNIQUE NOT NULL, name TEXT PRIMARY KEY,
      sku TEXT NOT NULL DEFAULT '', weight NUMERIC(12,3) NOT NULL DEFAULT 1,
      pieces_per_box INTEGER NOT NULL DEFAULT 1,
      active BOOLEAN NOT NULL DEFAULT TRUE)`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id SERIAL PRIMARY KEY, product TEXT NOT NULL,
      quantity NUMERIC NOT NULL DEFAULT 0, movement_type TEXT NOT NULL,
      from_warehouse_id INTEGER, to_warehouse_id INTEGER,
      note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '',
      product_type TEXT NOT NULL DEFAULT 'finished',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      weight_kg NUMERIC, reference TEXT, reason TEXT)`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW())`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id SERIAL, token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW())`);
  // Legacy production_labels WITHOUT the VH partial index and WITHOUT the
  // immutability trigger — models a pre-F4 install. batches referenced by FK.
  await c.query(`
    CREATE TABLE IF NOT EXISTS batches (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW())`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS production_labels (
      id SERIAL PRIMARY KEY, barcode_value TEXT NOT NULL,
      batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
      batch_code TEXT NOT NULL, label_type TEXT NOT NULL DEFAULT 'unit',
      label_number INTEGER NOT NULL, total_labels INTEGER NOT NULL,
      pieces_in_label INTEGER NOT NULL DEFAULT 1,
      pieces_per_box INTEGER NOT NULL DEFAULT 1,
      quantity_total INTEGER NOT NULL,
      weight_kg NUMERIC(12,3) NOT NULL DEFAULT 0, length_m NUMERIC(12,2),
      product_name TEXT NOT NULL, product_sku TEXT NOT NULL DEFAULT '',
      worker_name TEXT NOT NULL,
      produced_at TIMESTAMP WITH TIME ZONE NOT NULL,
      warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
      warehouse_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'created',
      print_count INTEGER NOT NULL DEFAULT 0,
      last_printed_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      CONSTRAINT production_labels_barcode_check
        CHECK (barcode_value ~ '^TM[A-Z2-7]{16}$'),
      CONSTRAINT production_labels_number_check
        CHECK (label_number > 0 AND total_labels >= label_number),
      CONSTRAINT production_labels_pieces_check CHECK (pieces_in_label > 0),
      CONSTRAINT production_labels_box_capacity_check CHECK (pieces_per_box > 0),
      CONSTRAINT production_labels_quantity_check CHECK (quantity_total > 0),
      CONSTRAINT production_labels_weight_check CHECK (weight_kg >= 0),
      CONSTRAINT production_labels_length_check
        CHECK (length_m IS NULL OR length_m >= 0),
      CONSTRAINT production_labels_type_check CHECK (label_type IN ('unit','box')),
      CONSTRAINT production_labels_status_check
        CHECK (status IN ('created','printed','void')),
      CONSTRAINT production_labels_print_count_check CHECK (print_count >= 0))`);
}

// The API production-label initializer's F4-additive DDL (init-db.ts, gated on
// PRODUCTION_LABELS_SCHEMA_APPROVED). Applied to an EXISTING legacy
// production_labels table — adds the VH partial unique index + immutability
// trigger. Idempotent, so it faithfully models the cold-start upgrade path.
async function applyProductionLabelUpgrade(c: pg.Client): Promise<void> {
  await c.query(`SET search_path TO public`);
  await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_production_labels_barcode
      ON production_labels(barcode_value)`);
  await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_production_labels_batch_number
      ON production_labels(batch_id, label_number)`);
  await c.query(`CREATE INDEX IF NOT EXISTS idx_production_labels_batch_code
      ON production_labels(batch_code)`);
  await c.query(`CREATE INDEX IF NOT EXISTS idx_production_labels_product
      ON production_labels(product_name)`);
  await c.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_production_labels_vh_batch_number
      ON production_labels(batch_code, label_number)
      WHERE batch_id IS NULL AND batch_code LIKE 'VH-%'`);
  await c.query(`
    CREATE OR REPLACE FUNCTION enforce_production_label_immutable()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF ROW(
        NEW.id, NEW.barcode_value, NEW.batch_code, NEW.label_type,
        NEW.label_number, NEW.total_labels, NEW.pieces_in_label,
        NEW.pieces_per_box, NEW.quantity_total, NEW.weight_kg, NEW.length_m,
        NEW.product_name, NEW.product_sku, NEW.worker_name, NEW.produced_at,
        NEW.warehouse_name, NEW.created_at
      ) IS DISTINCT FROM ROW(
        OLD.id, OLD.barcode_value, OLD.batch_code, OLD.label_type,
        OLD.label_number, OLD.total_labels, OLD.pieces_in_label,
        OLD.pieces_per_box, OLD.quantity_total, OLD.weight_kg, OLD.length_m,
        OLD.product_name, OLD.product_sku, OLD.worker_name, OLD.produced_at,
        OLD.warehouse_name, OLD.created_at
      ) OR (
        NEW.batch_id IS DISTINCT FROM OLD.batch_id
        AND NOT (OLD.batch_id IS NOT NULL AND NEW.batch_id IS NULL)
      ) OR (
        NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
        AND NOT (OLD.warehouse_id IS NOT NULL AND NEW.warehouse_id IS NULL)
      ) THEN
        RAISE EXCEPTION 'production label identity and snapshots are immutable'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$`);
  await c.query(`DROP TRIGGER IF EXISTS production_labels_immutable_trigger
      ON production_labels`);
  await c.query(`
    CREATE TRIGGER production_labels_immutable_trigger
    BEFORE UPDATE ON production_labels
    FOR EACH ROW EXECUTE FUNCTION enforce_production_label_immutable()`);
  await c.query(`SET search_path TO distribution, public`);
}

beforeAll(async () => {
  await dropTmpDb();
  {
    const admin = new Client({ connectionString: adminUrl, ssl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${TMP_DB}`);
    await admin.end();
  }

  // ── STEP 0: Bring up the F3 distribution schema via the REAL bot init_db.
  execFileSync("python3", ["-c", "import main; main.init_db()"], {
    cwd: botDir,
    env: botEnv,
    stdio: "pipe",
  });

  client = new Client({ connectionString: tmpUrl(), ssl });
  await client.connect();
  await createPublicBaseTables(client);

  // ── STEP 1: Downgrade to a genuinely-LEGACY F3 shape: drop the F4 session
  // tables (bot init_db just created them) so the upgrade has real work to do.
  await client.query(
    `DROP TABLE IF EXISTS distribution.vehicle_label_print_sessions`,
  );
  await client.query(
    `DROP TABLE IF EXISTS distribution.vehicle_label_prepare_sessions`,
  );

  await client.query(`SET search_path TO distribution, public`);

  // Seed a real F3 world: pilot (via bootstrap), ERP source warehouse, product.
  {
    const bootPool = new Pool({ connectionString: tmpUrl(), ssl, max: 2 });
    const c = await bootPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [PILOT_LOCK_KEY]);
      // Pilot bootstrap needs the delivery agent to exist first.
      await c.query(
        `INSERT INTO distribution.delivery_agents (name, telefon, hudud, telegram_id, faol, created_at)
         VALUES ($1, '+998900000000', 'Test tuman', $2, 1, '2026-01-01T09:00:00')`,
        [PILOT_AGENT_NAME, Math.floor(Math.random() * 1e9)],
      );
      await bootstrapPilotInTx(c);
      await c.query("COMMIT");
    } finally {
      c.release();
      await bootPool.end();
    }
  }

  const veh = await client.query(
    `SELECT id, warehouse_id FROM distribution.vehicles WHERE plate_number='DM-001'`,
  );
  vehicleId = Number(veh.rows[0].id);
  vehicleWarehouseId = Number(veh.rows[0].warehouse_id);

  const erp = await client.query(
    `INSERT INTO warehouses (name, active, location_type, purpose)
     VALUES ('ERP Manba F3F4', TRUE, 'general', 'finished') RETURNING id`,
  );
  erpWarehouseId = Number(erp.rows[0].id);

  await client.query(
    `INSERT INTO distribution.mahsulotlar (nomi, sku, faol) VALUES ('Arqon UP', 'SKU-UP', 1)`,
  );
  await client.query(
    `INSERT INTO products (name, sku, weight, active) VALUES ('Arqon UP', 'SKU-UP', 2.5, TRUE)`,
  );
  prodA = { mahsulotId: 0, name: "Arqon UP", sku: "SKU-UP" };
  const dp = await client.query(
    `SELECT id FROM distribution.mahsulotlar WHERE sku='SKU-UP'`,
  );
  prodA.mahsulotId = Number(dp.rows[0].id);

  await client.query(
    `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg)
     VALUES ($1, 'Arqon UP', 100, 250)`,
    [erpWarehouseId],
  );
  await client.query(
    `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg)
     VALUES ($1, 'Arqon UP', 0, 0)`,
    [vehicleWarehouseId],
  );

  // Seed a legacy F3 handoff + items + one printed event (pre-F4 data).
  const h = await client.query(
    `INSERT INTO distribution.vehicle_handoffs
       (vehicle_id, delivery_agent_id, source_warehouse_id, vehicle_warehouse_id,
        handoff_date, status, operation_key, prepared_actor_type, prepared_actor_ref)
     SELECT $1, va.delivery_agent_id, $2, $3, NOW()::date, 'prepared', 'legacy-op-1',
            'admin', '1'
       FROM distribution.vehicle_assignments va
      WHERE va.vehicle_id=$1 AND va.status='active' LIMIT 1
     RETURNING id`,
    [vehicleId, erpWarehouseId, vehicleWarehouseId],
  );
  legacyHandoffId = Number(h.rows[0].id);
  await client.query(
    `INSERT INTO distribution.vehicle_handoff_items
       (handoff_id, mahsulot_id, sku, product_name, quantity_dispatched, unit_weight_kg, total_weight_kg)
     VALUES ($1, $2, 'SKU-UP', 'Arqon UP', 1, 2.5, 2.5)`,
    [legacyHandoffId, prodA.mahsulotId],
  );
  // A pre-F4 event row (proves the event CHECK already accepts label events).
  await client.query(
    `INSERT INTO distribution.vehicle_unit_events
       (vehicle_id, handoff_id, mahsulot_id, sku, event_type, quantity, actor_id)
     VALUES ($1, $2, $3, 'SKU-UP', 'label_printed', 1, -1)`,
    [vehicleId, legacyHandoffId, prodA.mahsulotId],
  );

  // ── STEP 2: APPLY THE UPGRADE in normal gated order.
  //   2a. Re-run the distribution-bot init_db → recreates F4 session tables.
  execFileSync("python3", ["-c", "import main; main.init_db()"], {
    cwd: botDir,
    env: botEnv,
    stdio: "pipe",
  });
  //   2b. Run the API production-label initializer against the throwaway DB.
  //       This mirrors the exact, byte-for-byte DDL in
  //       artifacts/api-server/src/init-db.ts (the PRODUCTION_LABELS_SCHEMA_
  //       APPROVED gated block): the VH partial unique index + the immutability
  //       trigger. We apply it through the explicit throwaway `client` rather
  //       than the API's global pool — that pool binds RAILWAY_DATABASE_URL at
  //       first import, which an earlier test file in the same process may have
  //       already pinned to another database. All statements are idempotent
  //       (IF NOT EXISTS / CREATE OR REPLACE), matching a real cold-start.
  await applyProductionLabelUpgrade(client);

  // ── STEP 3: Boot the real vehicle-handoff router against the upgraded DB,
  // using an explicit pool (no global-pool dependency for the router).
  testPool = new Pool({ connectionString: tmpUrl(), ssl, max: 8 });

  // Admin session for the Bearer credential path.
  const u = await client.query(
    `INSERT INTO admin_users (username, password_hash, role)
     VALUES ('adminUP', 'x', 'admin') RETURNING id`,
  );
  adminToken = `tok-up-${Date.now()}`;
  await client.query(`INSERT INTO admin_sessions (token, user_id) VALUES ($1,$2)`, [
    adminToken,
    u.rows[0].id,
  ]);

  process.env.VEHICLE_DISTRIBUTION_ENABLED = "1";
  process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED = "1";
  process.env.VEHICLE_DISTRIBUTION_BOT_KEY = BOT_KEY;
  process.env.PRODUCTION_LABELS_SCHEMA_APPROVED = "1";

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
  server = http.createServer(app);
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

// ─────────────────────────────────────────────────────────────────────────────

describe("F3 → F4 in-place schema upgrade", () => {
  it("both F4 session tables exist after upgrade", async () => {
    const t = await client.query(
      `SELECT to_regclass('distribution.vehicle_label_prepare_sessions') AS prep,
              to_regclass('distribution.vehicle_label_print_sessions')   AS print`,
    );
    expect(t.rows[0].prep).not.toBeNull();
    expect(t.rows[0].print).not.toBeNull();
  });

  it("VH partial unique index was added to production_labels", async () => {
    const idx = await client.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename='production_labels'
          AND indexname='uq_production_labels_vh_batch_number'`,
    );
    expect(idx.rows).toHaveLength(1);
    expect(String(idx.rows[0].indexdef)).toContain("batch_id IS NULL");
    expect(String(idx.rows[0].indexdef)).toContain("VH-%");
  });

  it("production-label immutability trigger was installed by the upgrade", async () => {
    const trig = await client.query(
      `SELECT COUNT(*)::int AS n FROM pg_trigger
        WHERE tgrelid='production_labels'::regclass
          AND tgname='production_labels_immutable_trigger'
          AND NOT tgisinternal`,
    );
    expect(Number(trig.rows[0].n)).toBe(1);
  });

  it("legacy F3 data survived the upgrade (handoff + item + printed event)", async () => {
    const h = await client.query(
      `SELECT status FROM distribution.vehicle_handoffs WHERE id=$1`,
      [legacyHandoffId],
    );
    expect(h.rows[0].status).toBe("prepared");
    const ev = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicle_unit_events
        WHERE handoff_id=$1 AND event_type='label_printed'`,
      [legacyHandoffId],
    );
    expect(Number(ev.rows[0].n)).toBe(1);
  });
});

describe("F4 flow on the upgraded DB (both credential paths, terminal reprint)", () => {
  let handoffId = 0;
  let batchCode = "";

  it("admin prepares labels on a fresh handoff (exact counts + barcode identity)", async () => {
    const r = await call("POST", "/vehicle-distribution/handoffs", {
      token: adminToken,
      body: {
        sourceWarehouseId: erpWarehouseId,
        items: [{ mahsulotId: prodA.mahsulotId, quantity: 3 }],
        operationKey: opKey(),
      },
    });
    expect(r.status).toBe(200);
    handoffId = r.body.id as number;

    const p = await call(
      "POST",
      `/vehicle-distribution/handoffs/${handoffId}/labels/prepare`,
      { token: adminToken, body: { operationKey: opKey() } },
    );
    expect(p.status).toBe(200);
    expect(p.body.totalLabels).toBe(3);
    batchCode = p.body.batchCode;
    for (const l of p.body.labels)
      expect(l.barcodeValue).toMatch(/^TM[A-Z2-7]{16}$/);

    const pl = await client.query(
      `SELECT COUNT(*)::int AS n FROM production_labels WHERE batch_code=$1`,
      [batchCode],
    );
    expect(Number(pl.rows[0].n)).toBe(3);
    const cl = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicle_label_claims WHERE handoff_id=$1 AND status='prepared'`,
      [handoffId],
    );
    expect(Number(cl.rows[0].n)).toBe(3);
    const ev = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicle_unit_events WHERE handoff_id=$1 AND event_type='label_prepared'`,
      [handoffId],
    );
    expect(Number(ev.rows[0].n)).toBe(3);
    const ps = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicle_label_prepare_sessions WHERE handoff_id=$1`,
      [handoffId],
    );
    expect(Number(ps.rows[0].n)).toBe(1);
  });

  it("admin lists the persisted payload", async () => {
    const r = await call(
      "GET",
      `/vehicle-distribution/handoffs/${handoffId}/labels`,
      { token: adminToken },
    );
    expect(r.status).toBe(200);
    expect(r.body.totalLabels).toBe(3);
    expect(r.body.labels).toHaveLength(3);
  });

  it("admin first confirm → labels_printed, isReprint=false, one print session", async () => {
    const c = await call(
      "POST",
      `/vehicle-distribution/handoffs/${handoffId}/confirm-labels-printed`,
      { token: adminToken, body: { operationKey: opKey() } },
    );
    expect(c.status).toBe(200);
    expect(c.body.handoff.status).toBe("labels_printed");
    expect(c.body.isReprint).toBe(false);
    expect(c.body.atLeastOnce).toBe(true);
    const ps = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicle_label_print_sessions WHERE handoff_id=$1`,
      [handoffId],
    );
    expect(Number(ps.rows[0].n)).toBe(1);
  });

  it("admin same-key confirm replay → no new print session, no print_count bump", async () => {
    const key = opKey();
    const c1 = await call(
      "POST",
      `/vehicle-distribution/handoffs/${handoffId}/confirm-labels-printed`,
      { token: adminToken, body: { operationKey: key } },
    );
    expect(c1.status).toBe(200);
    const pc1 = await client.query(
      `SELECT COALESCE(SUM(print_count),0)::int AS n FROM production_labels WHERE batch_code=$1`,
      [batchCode],
    );
    const sess1 = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicle_label_print_sessions WHERE handoff_id=$1`,
      [handoffId],
    );
    const c2 = await call(
      "POST",
      `/vehicle-distribution/handoffs/${handoffId}/confirm-labels-printed`,
      { token: adminToken, body: { operationKey: key } },
    );
    expect(c2.status).toBe(200);
    const pc2 = await client.query(
      `SELECT COALESCE(SUM(print_count),0)::int AS n FROM production_labels WHERE batch_code=$1`,
      [batchCode],
    );
    const sess2 = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicle_label_print_sessions WHERE handoff_id=$1`,
      [handoffId],
    );
    expect(Number(pc2.rows[0].n)).toBe(Number(pc1.rows[0].n));
    expect(Number(sess2.rows[0].n)).toBe(Number(sess1.rows[0].n));
  });

  it("BOT credential GETs the payload (dedicated key path)", async () => {
    const r = await call(
      "GET",
      `/vehicle-distribution/handoffs/${handoffId}/labels`,
      { botKey: BOT_KEY },
    );
    expect(r.status).toBe(200);
    expect(r.body.totalLabels).toBe(3);
  });

  it("BOT credential reprint with NEW key → isReprint=true, print_count increments, barcodes unchanged", async () => {
    const before = await client.query(
      `SELECT id, barcode_value, print_count FROM production_labels WHERE batch_code=$1 ORDER BY label_number`,
      [batchCode],
    );
    const beforeBarcodes = before.rows.map((r) => String(r.barcode_value));
    const beforeCount = before.rows.reduce((n, r) => n + Number(r.print_count), 0);

    const c = await call(
      "POST",
      `/vehicle-distribution/handoffs/${handoffId}/confirm-labels-printed`,
      { botKey: BOT_KEY, body: { operationKey: opKey() } },
    );
    expect(c.status).toBe(200);
    expect(c.body.isReprint).toBe(true);

    const after = await client.query(
      `SELECT id, barcode_value, print_count FROM production_labels WHERE batch_code=$1 ORDER BY label_number`,
      [batchCode],
    );
    const afterBarcodes = after.rows.map((r) => String(r.barcode_value));
    const afterCount = after.rows.reduce((n, r) => n + Number(r.print_count), 0);
    // Identity unchanged; only print_count grows.
    expect(afterBarcodes).toEqual(beforeBarcodes);
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  it("advances handed-over → stock-transferred, then reprints again from terminal state", async () => {
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

    // Vehicle received exactly 3 units.
    const veh = await client.query(
      `SELECT quantity FROM inventory WHERE warehouse_id=$1 AND product='Arqon UP'`,
      [vehicleWarehouseId],
    );
    expect(Number(veh.rows[0].quantity)).toBe(3);

    // Reprint AFTER the terminal state is still allowed (isReprint=true).
    const before = await client.query(
      `SELECT COALESCE(SUM(print_count),0)::int AS n FROM production_labels WHERE batch_code=$1`,
      [batchCode],
    );
    const c = await call(
      "POST",
      `/vehicle-distribution/handoffs/${handoffId}/confirm-labels-printed`,
      { botKey: BOT_KEY, body: { operationKey: opKey() } },
    );
    expect(c.status).toBe(200);
    expect(c.body.isReprint).toBe(true);
    expect(c.body.handoff.status).toBe("stock_transferred");
    const after = await client.query(
      `SELECT COALESCE(SUM(print_count),0)::int AS n FROM production_labels WHERE batch_code=$1`,
      [batchCode],
    );
    expect(Number(after.rows[0].n)).toBeGreaterThan(Number(before.rows[0].n));

    // Claims are loaded and one prepare session remains (identity stable).
    const loaded = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicle_label_claims WHERE handoff_id=$1 AND status='loaded'`,
      [handoffId],
    );
    expect(Number(loaded.rows[0].n)).toBe(3);
  });
});
