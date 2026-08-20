import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import express from "express";
import pg from "pg";
import { createVehicleDistributionRouter } from "../src/routes/vehicle-distribution/index";
import {
  PILOT_AGENT_NAME,
  PILOT_WAREHOUSE_NAME,
} from "../src/routes/vehicle-distribution/service";
import {
  requireVehicleTestAdminUrl,
  childDbUrl,
  sslFor,
  botDbEnv,
} from "./helpers/vehicle-test-db";

// ─────────────────────────────────────────────────────────────────────────────
// F6 Vehicle Reconciliation — isolated throwaway-DB integration tests.
//
// Label-preserving variance detection ONLY. Every mutating scenario asserts that
// inventory / stock_movements are never touched, and a static source guard
// proves the F6 service contains no inventory/stock/claim/event mutations.
// ─────────────────────────────────────────────────────────────────────────────

const { Client, Pool } = pg;

const adminUrl = requireVehicleTestAdminUrl();
const TMP_DB = `topmart_vehicle_recon_${process.pid}_${Date.now()}`;
const ssl = sslFor(adminUrl);

function tmpUrl(): string {
  return childDbUrl(adminUrl, TMP_DB);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const botDir = path.resolve(here, "../../distribution-bot");
const botEnv = {
  ...process.env,
  ...botDbEnv(tmpUrl()),
  TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_VEHICLE_RECON",
  VEHICLE_DISTRIBUTION_SCHEMA_APPROVED: "1",
};

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
  // Full ERP products table (with active) so F6 product resolution works.
  await c.query(`
    CREATE TABLE IF NOT EXISTS products (
      id     SERIAL PRIMARY KEY,
      name   TEXT NOT NULL UNIQUE,
      sku    TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE
    )`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id                SERIAL PRIMARY KEY,
      product           TEXT NOT NULL,
      quantity          NUMERIC NOT NULL DEFAULT 0,
      movement_type     TEXT NOT NULL CHECK (movement_type IN ('IN', 'OUT', 'TRANSFER', 'BASELINE')),
      from_warehouse_id INTEGER REFERENCES warehouses(id),
      to_warehouse_id   INTEGER REFERENCES warehouses(id),
      note              TEXT NOT NULL DEFAULT '',
      created_by        TEXT NOT NULL DEFAULT '',
      product_type      TEXT NOT NULL DEFAULT 'finished',
      created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      weight_kg         NUMERIC,
      reference         TEXT,
      reason            TEXT
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
  const token = `tok-${username}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await client.query(
    `INSERT INTO admin_sessions (token, user_id) VALUES ($1, $2)`,
    [token, u.rows[0].id],
  );
  return token;
}

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
  app.use(async (req, res, next) => {
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const r = await testPool.query(
      `SELECT s.user_id, u.username FROM admin_sessions s
       JOIN admin_users u ON u.id = s.user_id WHERE s.token = $1`,
      [token],
    );
    if (!r.rows.length) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }
    (req as unknown as { userId: number }).userId = r.rows[0].user_id;
    next();
  });
  app.use(createVehicleDistributionRouter(testPool));
  return http.createServer(app);
}

let server: http.Server;
let baseUrl = "";

type Resp = { status: number; body: any };
async function call(
  method: string,
  pathname: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Resp> {
  const hasBody = opts.body !== undefined;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let pilotWarehouseId = 0;

// Reset the pilot + its inventory/products between scenarios, then re-bootstrap.
async function resetAndBootstrap(): Promise<void> {
  await client.query(`DELETE FROM distribution.vehicle_reconciliation_items`);
  await client.query(`DELETE FROM distribution.vehicle_reconciliations`);
  await client.query(`DELETE FROM distribution.vehicle_assignments`);
  await client.query(`DELETE FROM distribution.vehicles`);
  await client.query(`DELETE FROM stock_movements`);
  await client.query(`DELETE FROM inventory`);
  await client.query(`DELETE FROM products`);
  await client.query(
    `DELETE FROM warehouses WHERE location_type = 'vehicle' OR name = $1`,
    [PILOT_WAREHOUSE_NAME],
  );

  const boot = await call("POST", "/vehicle-distribution/pilot/bootstrap", {
    token: adminToken,
    body: {},
  });
  expect(boot.status).toBe(200);
  const wh = await client.query(`SELECT id FROM warehouses WHERE name = $1`, [
    PILOT_WAREHOUSE_NAME,
  ]);
  pilotWarehouseId = Number(wh.rows[0].id);
}

async function seedProduct(name: string, sku: string, active = true): Promise<void> {
  await client.query(
    `INSERT INTO products (name, sku, active) VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET sku = EXCLUDED.sku, active = EXCLUDED.active`,
    [name, sku, active],
  );
}

async function seedVehicleStock(
  name: string,
  quantity: number,
  weightKg: number,
): Promise<void> {
  await client.query(
    `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (warehouse_id, product)
     DO UPDATE SET quantity = EXCLUDED.quantity, weight_kg = EXCLUDED.weight_kg`,
    [pilotWarehouseId, name, quantity, weightKg],
  );
}

async function inventorySnapshotHash(): Promise<string> {
  const r = await client.query(
    `SELECT product, quantity, weight_kg FROM inventory ORDER BY warehouse_id, product`,
  );
  return JSON.stringify(r.rows);
}

async function stockMovementCount(): Promise<number> {
  const r = await client.query(`SELECT count(*)::int AS c FROM stock_movements`);
  return Number(r.rows[0].c);
}

let adminToken = "";
let workerToken = "";

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

  testPool = new Pool({ connectionString: tmpUrl(), ssl, max: 6 });

  await seedAgent(PILOT_AGENT_NAME);
  adminToken = await seedUser("admin1", "admin");
  workerToken = await seedUser("worker1", "worker");

  process.env.VEHICLE_DISTRIBUTION_ENABLED = "1";
  process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED = "1";

  server = makeApp();
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = server.address();
  if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
}, 180_000);

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (testPool) await testPool.end();
  if (client) await client.end();
  await dropTmpDb();
}, 60_000);

beforeEach(() => {
  process.env.VEHICLE_DISTRIBUTION_ENABLED = "1";
  process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED = "1";
});

const LIST = "/vehicle-distribution/pilot/reconciliations";

describe("F6 reconciliation — auth wall + feature gates", () => {
  it("GET list without a token → 401", async () => {
    const r = await call("GET", LIST);
    expect(r.status).toBe(401);
  });
  it("GET list with invalid token → 401", async () => {
    const r = await call("GET", LIST, { token: "nope" });
    expect(r.status).toBe(401);
  });
  it("gate off → 404", async () => {
    delete process.env.VEHICLE_DISTRIBUTION_ENABLED;
    delete process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED;
    const r = await call("GET", LIST, { token: adminToken });
    expect(r.status).toBe(404);
  });
  it("enabled without schema approval → 503", async () => {
    process.env.VEHICLE_DISTRIBUTION_ENABLED = "1";
    delete process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED;
    const r = await call("GET", LIST, { token: adminToken });
    expect(r.status).toBe(503);
  });
});

describe("F6 reconciliation — create (admin role + snapshot)", () => {
  beforeEach(async () => {
    await resetAndBootstrap();
  });

  it("worker (non-admin) cannot create → 403", async () => {
    const r = await call("POST", LIST, {
      token: workerToken,
      body: { reconciliationDate: "2026-02-01" },
    });
    expect(r.status).toBe(403);
  });

  it("empty list when none exist", async () => {
    const r = await call("GET", LIST, { token: adminToken });
    expect(r.status).toBe(200);
    expect(r.body.reconciliations).toEqual([]);
  });

  it("bad body (extra prop / missing date) → 400", async () => {
    const bad1 = await call("POST", LIST, {
      token: adminToken,
      body: { reconciliationDate: "2026-02-01", vehicleId: 9 },
    });
    expect(bad1.status).toBe(400);
    const bad2 = await call("POST", LIST, { token: adminToken, body: {} });
    expect(bad2.status).toBe(400);
  });

  it("snapshots the complete nonzero vehicle inventory with actual=null", async () => {
    await seedProduct("Arqon A", "SKU-A");
    await seedProduct("Arqon B", "SKU-B");
    await seedVehicleStock("Arqon A", 10, 25.5);
    await seedVehicleStock("Arqon B", 5, 12);
    // A zero-quantity row must be excluded from the snapshot.
    await seedVehicleStock("Arqon Zero", 0, 0);
    await seedProduct("Arqon Zero", "SKU-Z");

    const invBefore = await inventorySnapshotHash();
    const r = await call("POST", LIST, {
      token: adminToken,
      body: { reconciliationDate: "2026-02-01", notes: "eod" },
    });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(true);
    const rec = r.body.reconciliation;
    expect(rec.status).toBe("draft");
    expect(rec.createdBy).not.toBeNull();
    expect(rec.items).toHaveLength(2);
    for (const it of rec.items) {
      expect(it.publicProductId).not.toBeNull();
      expect(it.mahsulotId).toBeNull();
      expect(it.actualQuantity).toBeNull();
      expect(it.discrepancy).toBe(0);
    }
    const a = rec.items.find((i: any) => i.productName === "Arqon A");
    expect(a.expectedQuantity).toBe(10);
    expect(a.expectedWeightKg).toBe(25.5);
    // No inventory mutation.
    expect(await inventorySnapshotHash()).toBe(invBefore);
    expect(await stockMovementCount()).toBe(0);
  });

  it("empty vehicle → zero-line draft is allowed", async () => {
    const r = await call("POST", LIST, {
      token: adminToken,
      body: { reconciliationDate: "2026-02-02" },
    });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(true);
    expect(r.body.reconciliation.items).toEqual([]);
  });

  it("missing public product → 409", async () => {
    await seedVehicleStock("Ghost", 3, 3);
    const r = await call("POST", LIST, {
      token: adminToken,
      body: { reconciliationDate: "2026-02-03" },
    });
    expect(r.status).toBe(409);
  });

  it("inactive public product counts as missing → 409", async () => {
    await seedProduct("Sleepy", "SKU-S", false);
    await seedVehicleStock("Sleepy", 3, 3);
    const r = await call("POST", LIST, {
      token: adminToken,
      body: { reconciliationDate: "2026-02-03" },
    });
    expect(r.status).toBe(409);
  });

  it("same-date draft retry returns existing draft with created=false", async () => {
    await seedProduct("Arqon A", "SKU-A");
    await seedVehicleStock("Arqon A", 10, 25.5);
    const first = await call("POST", LIST, {
      token: adminToken,
      body: { reconciliationDate: "2026-02-04" },
    });
    expect(first.status).toBe(200);
    expect(first.body.created).toBe(true);
    const again = await call("POST", LIST, {
      token: adminToken,
      body: { reconciliationDate: "2026-02-04" },
    });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.reconciliation.id).toBe(first.body.reconciliation.id);
  });

  it("an existing active draft (different date) blocks a new create → 409", async () => {
    await seedProduct("Arqon A", "SKU-A");
    await seedVehicleStock("Arqon A", 10, 25.5);
    const first = await call("POST", LIST, {
      token: adminToken,
      body: { reconciliationDate: "2026-02-05" },
    });
    expect(first.status).toBe(200);
    const other = await call("POST", LIST, {
      token: adminToken,
      body: { reconciliationDate: "2026-02-06" },
    });
    expect(other.status).toBe(409);
  });
});

describe("F6 reconciliation — patch counts / review / apply / cancel", () => {
  beforeEach(async () => {
    await resetAndBootstrap();
    await seedProduct("Arqon A", "SKU-A");
    await seedProduct("Arqon B", "SKU-B");
    await seedVehicleStock("Arqon A", 10, 25);
    await seedVehicleStock("Arqon B", 5, 12);
  });

  async function openDraft(date: string): Promise<any> {
    const r = await call("POST", LIST, {
      token: adminToken,
      body: { reconciliationDate: date },
    });
    expect(r.status).toBe(200);
    return r.body.reconciliation;
  }

  it("patch: worker cannot patch → 403; invalid actual → 400; sets counted actor", async () => {
    const rec = await openDraft("2026-03-01");
    const itemsUrl = `${LIST}/${rec.id}/items`;
    const itemId = rec.items[0].id;

    const w = await call("PATCH", itemsUrl, {
      token: workerToken,
      body: { items: [{ itemId, actualQuantity: 10 }] },
    });
    expect(w.status).toBe(403);

    const neg = await call("PATCH", itemsUrl, {
      token: adminToken,
      body: { items: [{ itemId, actualQuantity: -1 }] },
    });
    expect(neg.status).toBe(400);

    const ok = await call("PATCH", itemsUrl, {
      token: adminToken,
      body: { items: [{ itemId, actualQuantity: 10 }] },
    });
    expect(ok.status).toBe(200);
    const patched = ok.body.items.find((i: any) => i.id === itemId);
    expect(patched.actualQuantity).toBe(10);
    expect(patched.discrepancy).toBe(0);
    expect(patched.countedBy).not.toBeNull();
    expect(patched.countedAt).not.toBeNull();
  });

  it("review requires all lines counted → 409 when incomplete", async () => {
    const rec = await openDraft("2026-03-02");
    await call("PATCH", `${LIST}/${rec.id}/items`, {
      token: adminToken,
      body: { items: [{ itemId: rec.items[0].id, actualQuantity: 10 }] },
    });
    const rev = await call("POST", `${LIST}/${rec.id}/review`, {
      token: adminToken,
      body: {},
    });
    expect(rev.status).toBe(409);
  });

  it("clean counts → approved (no mutations); idempotent replay", async () => {
    const rec = await openDraft("2026-03-03");
    const invBefore = await inventorySnapshotHash();
    await call("PATCH", `${LIST}/${rec.id}/items`, {
      token: adminToken,
      body: {
        items: rec.items.map((i: any) => ({
          itemId: i.id,
          actualQuantity: i.expectedQuantity,
        })),
      },
    });
    const rev = await call("POST", `${LIST}/${rec.id}/review`, {
      token: adminToken,
      body: {},
    });
    expect(rev.status).toBe(200);
    expect(rev.body.status).toBe("approved");
    expect(rev.body.reviewedBy).not.toBeNull();
    expect(await inventorySnapshotHash()).toBe(invBefore);
    expect(await stockMovementCount()).toBe(0);
    // Idempotent replay.
    const again = await call("POST", `${LIST}/${rec.id}/review`, {
      token: adminToken,
      body: {},
    });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("approved");
  });

  it("any nonzero discrepancy → disputed (terminal, no mutations)", async () => {
    const rec = await openDraft("2026-03-04");
    const invBefore = await inventorySnapshotHash();
    await call("PATCH", `${LIST}/${rec.id}/items`, {
      token: adminToken,
      body: {
        items: rec.items.map((i: any, idx: number) => ({
          itemId: i.id,
          actualQuantity: idx === 0 ? i.expectedQuantity - 2 : i.expectedQuantity,
        })),
      },
    });
    const rev = await call("POST", `${LIST}/${rec.id}/review`, {
      token: adminToken,
      body: {},
    });
    expect(rev.status).toBe(200);
    expect(rev.body.status).toBe("disputed");
    expect(await inventorySnapshotHash()).toBe(invBefore);
    expect(await stockMovementCount()).toBe(0);
    // Disputed is terminal — apply is rejected.
    const ap = await call("POST", `${LIST}/${rec.id}/apply`, {
      token: adminToken,
      body: {},
    });
    expect(ap.status).toBe(409);
  });

  it("apply blocks when the snapshot is stale → 409", async () => {
    const rec = await openDraft("2026-03-05");
    await call("PATCH", `${LIST}/${rec.id}/items`, {
      token: adminToken,
      body: {
        items: rec.items.map((i: any) => ({
          itemId: i.id,
          actualQuantity: i.expectedQuantity,
        })),
      },
    });
    const rev = await call("POST", `${LIST}/${rec.id}/review`, {
      token: adminToken,
      body: {},
    });
    expect(rev.body.status).toBe("approved");
    // World moves after approval.
    await seedVehicleStock("Arqon A", 99, 200);
    const ap = await call("POST", `${LIST}/${rec.id}/apply`, {
      token: adminToken,
      body: {},
    });
    expect(ap.status).toBe(409);
  });

  it("clean apply → applied (no mutations); idempotent replay", async () => {
    const rec = await openDraft("2026-03-06");
    const invBefore = await inventorySnapshotHash();
    await call("PATCH", `${LIST}/${rec.id}/items`, {
      token: adminToken,
      body: {
        items: rec.items.map((i: any) => ({
          itemId: i.id,
          actualQuantity: i.expectedQuantity,
        })),
      },
    });
    await call("POST", `${LIST}/${rec.id}/review`, { token: adminToken, body: {} });
    const ap = await call("POST", `${LIST}/${rec.id}/apply`, {
      token: adminToken,
      body: {},
    });
    expect(ap.status).toBe(200);
    expect(ap.body.status).toBe("applied");
    expect(ap.body.appliedBy).not.toBeNull();
    expect(await inventorySnapshotHash()).toBe(invBefore);
    expect(await stockMovementCount()).toBe(0);
    const again = await call("POST", `${LIST}/${rec.id}/apply`, {
      token: adminToken,
      body: {},
    });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("applied");
  });

  it("cancel: draft-only; worker denied; idempotent; non-draft rejected", async () => {
    const rec = await openDraft("2026-03-07");
    const w = await call("POST", `${LIST}/${rec.id}/cancel`, {
      token: workerToken,
      body: {},
    });
    expect(w.status).toBe(403);
    const c = await call("POST", `${LIST}/${rec.id}/cancel`, {
      token: adminToken,
      body: {},
    });
    expect(c.status).toBe(200);
    expect(c.body.status).toBe("cancelled");
    // Idempotent replay.
    const again = await call("POST", `${LIST}/${rec.id}/cancel`, {
      token: adminToken,
      body: {},
    });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("cancelled");

    // Approved → cancel rejected.
    const rec2 = await openDraft("2026-03-08");
    await call("PATCH", `${LIST}/${rec2.id}/items`, {
      token: adminToken,
      body: {
        items: rec2.items.map((i: any) => ({
          itemId: i.id,
          actualQuantity: i.expectedQuantity,
        })),
      },
    });
    await call("POST", `${LIST}/${rec2.id}/review`, { token: adminToken, body: {} });
    const rej = await call("POST", `${LIST}/${rec2.id}/cancel`, {
      token: adminToken,
      body: {},
    });
    expect(rej.status).toBe(409);
  });

  it("get by unknown id → 404; strict empty body rejects extra props", async () => {
    const nf = await call("GET", `${LIST}/999999`, { token: adminToken });
    expect(nf.status).toBe(404);
    const rec = await openDraft("2026-03-09");
    const bad = await call("POST", `${LIST}/${rec.id}/cancel`, {
      token: adminToken,
      body: { foo: 1 },
    });
    expect(bad.status).toBe(400);
  });
});

// ── Static source guard: F6 service performs NO inventory/stock mutations ─────
describe("F6 static guard — service is label-preserving", () => {
  it("reconciliation-service.ts contains no inventory/stock/claim/event mutations", () => {
    const src = readFileSync(
      path.join(here, "../src/routes/vehicle-distribution/reconciliation-service.ts"),
      "utf8",
    );
    // Strip line + block comments so prose that mentions these words doesn't
    // trip the guard; we only scan executable code.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");

    const forbidden: RegExp[] = [
      /update\s+inventory/i,
      /insert\s+into\s+inventory/i,
      /delete\s+from\s+inventory/i,
      /insert\s+into\s+stock_movements/i,
      /update\s+stock_movements/i,
      /vehicle_label_claims/i,
      /vehicle_unit_events/i,
      /vehicle_sale_allocations/i,
    ];
    for (const re of forbidden) {
      expect(re.test(code), `forbidden mutation matched: ${re}`).toBe(false);
    }
  });
});
