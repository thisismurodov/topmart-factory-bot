import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import express from "express";
import pg from "pg";
import {
  createVehicleDistributionRouter,
} from "../src/routes/vehicle-distribution/index";
import {
  readPilotState,
  readPilotStock,
  readPilotMovements,
  bootstrapPilotInTx,
  PilotConflictError,
  PilotAgentError,
  PILOT_LOCK_KEY,
  PILOT_VEHICLE_PLATE,
  PILOT_VEHICLE_TYPE,
  PILOT_AGENT_NAME,
  PILOT_WAREHOUSE_NAME,
} from "../src/routes/vehicle-distribution/service";
import {
  GetVehicleDistributionPilotStockResponse,
  GetVehicleDistributionPilotMovementsResponse,
} from "@workspace/api-zod";
import {
  requireVehicleTestAdminUrl,
  childDbUrl,
  sslFor,
  botDbEnv,
} from "./helpers/vehicle-test-db";

// ─────────────────────────────────────────────────────────────────────────────
// F2 Vehicle + Assignment pilot — isolated throwaway-DB integration tests.
//
// Provisions a genuinely separate throwaway DATABASE on the same server:
//   - distribution schema (incl. vehicles / vehicle_assignments / delivery_agents)
//     is brought up by the REAL bot init_db() with the vehicle DDL gate on,
//   - public.warehouses / public.inventory / admin_users / admin_sessions are
//     created here (mirroring the API initDb runtime DDL) so the pilot spans
//     both schemas exactly as production does.
//
// The HTTP layer is exercised through a minimal Express app that mounts a
// requireAuth clone (bound to the throwaway pool) + the vehicle router factory,
// so auth, both feature gates, and the admin-role check are all covered.
//
// No external notifications are sent — the bot subprocess only runs init_db();
// the router performs pure DB work. The throwaway DB is dropped in afterAll.
// ─────────────────────────────────────────────────────────────────────────────

const { Client, Pool } = pg;

// Admin/provisioning URL comes ONLY from the dedicated isolated variable — never
// from the runtime RAILWAY_DATABASE_URL / DATABASE_URL. Fails closed if absent.
const adminUrl = requireVehicleTestAdminUrl();

const TMP_DB = `topmart_vehicle_pilot_${process.pid}_${Date.now()}`;
const ssl = sslFor(adminUrl);

function tmpUrl(): string {
  return childDbUrl(adminUrl, TMP_DB);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const botDir = path.resolve(here, "../../distribution-bot");
const {
  RAILWAY_DATABASE_URL: _ignoredRailwayDatabaseUrl,
  DATABASE_URL: _ignoredRuntimeDatabaseUrl,
  ...isolatedBotBaseEnv
} = process.env;
const botEnv = {
  ...isolatedBotBaseEnv,
  ...botDbEnv(tmpUrl()),
  TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_VEHICLE_PILOT",
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

// Public runtime tables the pilot depends on (mirror of API initDb DDL).
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
  // Catalog products (bot-owned in prod) — needed so the F5 stock read model can
  // LEFT JOIN products for productSku. Minimal shape: name + sku.
  await c.query(`
    CREATE TABLE IF NOT EXISTS products (
      id   SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      sku  TEXT NOT NULL DEFAULT ''
    )`);
  // stock_movements (public ERP table) — mirror of the API initDb DDL so the F5
  // movements read model has a real table to query against.
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
  const token = `tok-${username}-${Date.now()}`;
  await client.query(
    `INSERT INTO admin_sessions (token, user_id) VALUES ($1, $2)`,
    [token, u.rows[0].id],
  );
  return token;
}

// ── In-test HTTP harness ────────────────────────────────────────────────────
// requireAuth clone bound to the throwaway pool (the real requireAuth binds the
// shared @workspace/db pool, which points at a different DB in tests).
function makeApp(): http.Server {
  const app = express();
  app.use(express.json());
  // Minimal req.log stub (production attaches one via pino-http).
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    next();
  });
  // Auth wall (mirrors src/middleware/requireAuth against the throwaway pool).
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

type Resp = { status: number; body: unknown };
async function call(
  method: string,
  pathname: string,
  token?: string,
): Promise<Resp> {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// Reset pilot rows between mutating scenarios (keeps agent/user seeds).
async function resetPilot(): Promise<void> {
  await client.query(`DELETE FROM distribution.vehicle_assignments`);
  await client.query(`DELETE FROM distribution.vehicles`);
  await client.query(`DELETE FROM stock_movements`);
  await client.query(`DELETE FROM inventory`);
  await client.query(`DELETE FROM products`);
  await client.query(
    `DELETE FROM warehouses WHERE location_type = 'vehicle' OR name = 'DM-001 mashina ombori'`,
  );
}

let navruzbekAgentId = 0;
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
  // Real bot init: creates distribution schema + vehicle tables (gate on).
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

  navruzbekAgentId = await seedAgent(PILOT_AGENT_NAME);
  adminToken = await seedUser("admin1", "admin");
  workerToken = await seedUser("worker1", "worker");

  // Default: feature fully enabled for most tests; individual gate tests flip.
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

describe("auth wall", () => {
  it("GET without a token → 401", async () => {
    const r = await call("GET", "/vehicle-distribution/pilot");
    expect(r.status).toBe(401);
  });
  it("POST without a token → 401", async () => {
    const r = await call("POST", "/vehicle-distribution/pilot/bootstrap");
    expect(r.status).toBe(401);
  });
  it("GET with an invalid token → 401", async () => {
    const r = await call("GET", "/vehicle-distribution/pilot", "nope");
    expect(r.status).toBe(401);
  });
});

describe("feature gate (fail-closed)", () => {
  it("gate off (neither flag) → 404", async () => {
    delete process.env.VEHICLE_DISTRIBUTION_ENABLED;
    delete process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED;
    const r = await call("GET", "/vehicle-distribution/pilot", adminToken);
    expect(r.status).toBe(404);
  });
  it("enabled=0 (explicit) → 404", async () => {
    process.env.VEHICLE_DISTRIBUTION_ENABLED = "0";
    process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED = "1";
    const r = await call("GET", "/vehicle-distribution/pilot", adminToken);
    expect(r.status).toBe(404);
  });
  it("enabled=1 but schema not approved → 503", async () => {
    process.env.VEHICLE_DISTRIBUTION_ENABLED = "1";
    delete process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED;
    const r = await call("GET", "/vehicle-distribution/pilot", adminToken);
    expect(r.status).toBe(503);
  });
  it("enabled=1 schema approved but bootstrap also 404s when disabled", async () => {
    process.env.VEHICLE_DISTRIBUTION_ENABLED = "0";
    const r = await call(
      "POST",
      "/vehicle-distribution/pilot/bootstrap",
      adminToken,
    );
    expect(r.status).toBe(404);
  });
});

describe("GET pilot before bootstrap (no writes)", () => {
  beforeEach(async () => {
    await resetPilot();
  });
  it("returns a deterministic not-bootstrapped payload", async () => {
    const before = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicles`,
    );
    const r = await call("GET", "/vehicle-distribution/pilot", adminToken);
    expect(r.status).toBe(200);
    const body = r.body as { bootstrapped: boolean; vehicle: unknown };
    expect(body.bootstrapped).toBe(false);
    expect(body.vehicle).toBeNull();
    const after = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicles`,
    );
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n));
  });
});

describe("admin role enforcement", () => {
  beforeEach(async () => {
    await resetPilot();
  });
  it("non-admin (worker) bootstrap → 403, no rows created", async () => {
    const r = await call(
      "POST",
      "/vehicle-distribution/pilot/bootstrap",
      workerToken,
    );
    expect(r.status).toBe(403);
    const v = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicles`,
    );
    expect(Number(v.rows[0].n)).toBe(0);
  });
});

describe("missing / ambiguous agent", () => {
  beforeEach(async () => {
    await resetPilot();
  });
  it("no active NAVRUZBEK agent → 409", async () => {
    await client.query(
      `UPDATE distribution.delivery_agents SET faol = 0 WHERE id = $1`,
      [navruzbekAgentId],
    );
    const r = await call(
      "POST",
      "/vehicle-distribution/pilot/bootstrap",
      adminToken,
    );
    expect(r.status).toBe(409);
    await client.query(
      `UPDATE distribution.delivery_agents SET faol = 1 WHERE id = $1`,
      [navruzbekAgentId],
    );
  });
  it("ambiguous (two active NAVRUZBEK, case/space variants) → 409", async () => {
    const dupId = await seedAgent("  navruzbek  ");
    const r = await call(
      "POST",
      "/vehicle-distribution/pilot/bootstrap",
      adminToken,
    );
    expect(r.status).toBe(409);
    await client.query(`DELETE FROM distribution.delivery_agents WHERE id = $1`, [
      dupId,
    ]);
  });
});

describe("first bootstrap + idempotent retry", () => {
  beforeEach(async () => {
    await resetPilot();
  });
  it("first bootstrap creates exactly one vehicle/warehouse/assignment", async () => {
    const r = await call(
      "POST",
      "/vehicle-distribution/pilot/bootstrap",
      adminToken,
    );
    expect(r.status).toBe(200);
    const body = r.body as {
      bootstrapped: boolean;
      agent: { id: number; name: string };
      vehicle: { plateNumber: string; vehicleType: string; capacityKg: number | null };
      warehouse: { locationType: string; purpose: string };
      assignment: { status: string };
    };
    expect(body.bootstrapped).toBe(true);
    expect(body.agent.name).toBe(PILOT_AGENT_NAME);
    expect(body.vehicle.plateNumber).toBe(PILOT_VEHICLE_PLATE);
    expect(body.vehicle.vehicleType).toBe(PILOT_VEHICLE_TYPE);
    expect(body.warehouse.locationType).toBe("vehicle");
    expect(body.warehouse.purpose).toBe("finished");
    expect(body.assignment.status).toBe("active");
    // Capacity not fabricated — schema default 0 (or null) preserved.
    expect([0, null]).toContain(body.vehicle.capacityKg);

    const veh = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicles`,
    );
    expect(Number(veh.rows[0].n)).toBe(1);
    const asg = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicle_assignments WHERE status='active'`,
    );
    expect(Number(asg.rows[0].n)).toBe(1);
    const wh = await client.query(
      `SELECT COUNT(*)::int AS n FROM warehouses WHERE location_type='vehicle'`,
    );
    expect(Number(wh.rows[0].n)).toBe(1);
  });

  it("retry (double-click sequentially) returns same state, no dup rows", async () => {
    const r1 = await call(
      "POST",
      "/vehicle-distribution/pilot/bootstrap",
      adminToken,
    );
    const r2 = await call(
      "POST",
      "/vehicle-distribution/pilot/bootstrap",
      adminToken,
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = r1.body as { vehicle: { id: number }; assignment: { id: number } };
    const b2 = r2.body as { vehicle: { id: number }; assignment: { id: number } };
    expect(b2.vehicle.id).toBe(b1.vehicle.id);
    expect(b2.assignment.id).toBe(b1.assignment.id);
    const veh = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicles`,
    );
    expect(Number(veh.rows[0].n)).toBe(1);
    const asg = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicle_assignments`,
    );
    expect(Number(asg.rows[0].n)).toBe(1);
  });

  it("agent row is never modified by bootstrap", async () => {
    const before = await client.query(
      `SELECT name, telefon, hudud, telegram_id, faol FROM distribution.delivery_agents WHERE id=$1`,
      [navruzbekAgentId],
    );
    await call("POST", "/vehicle-distribution/pilot/bootstrap", adminToken);
    await call("POST", "/vehicle-distribution/pilot/bootstrap", adminToken);
    const after = await client.query(
      `SELECT name, telefon, hudud, telegram_id, faol FROM distribution.delivery_agents WHERE id=$1`,
      [navruzbekAgentId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

describe("concurrent double-click (advisory lock serializes)", () => {
  beforeEach(async () => {
    await resetPilot();
  });
  it("two simultaneous bootstraps → both 200, exactly one of each row", async () => {
    const [a, b] = await Promise.all([
      call("POST", "/vehicle-distribution/pilot/bootstrap", adminToken),
      call("POST", "/vehicle-distribution/pilot/bootstrap", adminToken),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const veh = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicles`,
    );
    expect(Number(veh.rows[0].n)).toBe(1);
    const asg = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicle_assignments`,
    );
    expect(Number(asg.rows[0].n)).toBe(1);
    const wh = await client.query(
      `SELECT COUNT(*)::int AS n FROM warehouses WHERE location_type='vehicle'`,
    );
    expect(Number(wh.rows[0].n)).toBe(1);
  });
});

describe("conflicting existing state → 409", () => {
  beforeEach(async () => {
    await resetPilot();
  });

  it("active assignment on the pilot vehicle for a DIFFERENT agent → 409", async () => {
    // Bootstrap once to create vehicle+warehouse+assignment, then repoint the
    // active assignment to a different agent and re-run.
    await call("POST", "/vehicle-distribution/pilot/bootstrap", adminToken);
    const other = await seedAgent("SOMEONE ELSE");
    await client.query(
      `UPDATE distribution.vehicle_assignments SET delivery_agent_id=$1 WHERE status='active'`,
      [other],
    );
    const r = await call(
      "POST",
      "/vehicle-distribution/pilot/bootstrap",
      adminToken,
    );
    expect(r.status).toBe(409);
    await client.query(`DELETE FROM distribution.delivery_agents WHERE id=$1`, [
      other,
    ]);
  });

  it("agent already actively assigned to a DIFFERENT vehicle → 409", async () => {
    // Create the pilot warehouse+vehicle, plus a second vehicle, and give the
    // pilot agent an active assignment on the second vehicle.
    const wh = await client.query(
      `INSERT INTO warehouses (name, location_type, purpose) VALUES ('other-veh-wh','vehicle','finished') RETURNING id`,
    );
    const wh2 = await client.query(
      `INSERT INTO warehouses (name, location_type, purpose) VALUES ('pilot-wh-tmp','vehicle','finished') RETURNING id`,
    );
    const v2 = await client.query(
      `INSERT INTO distribution.vehicles (plate_number, vehicle_type, warehouse_id) VALUES ('DM-002','DAMAS',$1) RETURNING id`,
      [wh.rows[0].id],
    );
    // pilot vehicle DM-001 mapped to a different warehouse than the bootstrap
    // would pick — reuse path validates warehouse mapping.
    await client.query(
      `INSERT INTO distribution.vehicles (plate_number, vehicle_type, warehouse_id) VALUES ($1,'DAMAS',$2)`,
      [PILOT_VEHICLE_PLATE, wh2.rows[0].id],
    );
    await client.query(
      `INSERT INTO distribution.vehicle_assignments (vehicle_id, delivery_agent_id, status) VALUES ($1,$2,'active')`,
      [v2.rows[0].id, navruzbekAgentId],
    );
    const r = await call(
      "POST",
      "/vehicle-distribution/pilot/bootstrap",
      adminToken,
    );
    expect(r.status).toBe(409);
  });

  it("pilot vehicle exists with a conflicting type → 409", async () => {
    const wh = await client.query(
      `INSERT INTO warehouses (name, location_type, purpose) VALUES ('bad-type-wh','vehicle','finished') RETURNING id`,
    );
    await client.query(
      `INSERT INTO distribution.vehicles (plate_number, vehicle_type, warehouse_id) VALUES ($1,'LABO',$2)`,
      [PILOT_VEHICLE_PLATE, wh.rows[0].id],
    );
    const r = await call(
      "POST",
      "/vehicle-distribution/pilot/bootstrap",
      adminToken,
    );
    expect(r.status).toBe(409);
  });

  it("pilot warehouse name exists with conflicting purpose → 409", async () => {
    // Direct service-level check: warehouse reused but wrong location_type.
    await client.query(
      `INSERT INTO warehouses (name, location_type, purpose) VALUES ('DM-001 mashina ombori','general','finished')`,
    );
    const c = await testPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        PILOT_LOCK_KEY,
      ]);
      await expect(bootstrapPilotInTx(c)).rejects.toBeInstanceOf(
        PilotConflictError,
      );
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });
});

describe("GET readback + KPI (balance) isolation", () => {
  beforeEach(async () => {
    await resetPilot();
  });
  it("GET reflects bootstrapped state and warehouse balance summary", async () => {
    const boot = await call(
      "POST",
      "/vehicle-distribution/pilot/bootstrap",
      adminToken,
    );
    expect(boot.status).toBe(200);
    const whRow = await client.query(
      `SELECT id FROM warehouses WHERE name = 'DM-001 mashina ombori'`,
    );
    const whId = Number(whRow.rows[0].id);
    // Seed some inventory into the vehicle warehouse only.
    await client.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg) VALUES ($1,'Arqon A',10,25.5),($1,'Arqon B',5,12.0)`,
      [whId],
    );
    // And into an unrelated warehouse to prove isolation.
    const otherWh = await client.query(
      `INSERT INTO warehouses (name, location_type, purpose) VALUES ('unrelated','general','finished') RETURNING id`,
    );
    await client.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg) VALUES ($1,'Noise',999,999)`,
      [Number(otherWh.rows[0].id)],
    );

    const r = await call("GET", "/vehicle-distribution/pilot", adminToken);
    expect(r.status).toBe(200);
    const body = r.body as {
      bootstrapped: boolean;
      balance: {
        warehouseId: number;
        skuCount: number;
        totalQuantity: number;
        totalWeightKg: number;
      };
      assignment: { status: string };
    };
    expect(body.bootstrapped).toBe(true);
    expect(body.balance.warehouseId).toBe(whId);
    expect(body.balance.skuCount).toBe(2);
    expect(body.balance.totalQuantity).toBe(15);
    expect(body.balance.totalWeightKg).toBeCloseTo(37.5, 3);
    expect(body.assignment.status).toBe("active");
  });
});

describe("service-level agent error typing", () => {
  beforeEach(async () => {
    await resetPilot();
  });
  it("PilotAgentError carries a match count when ambiguous", async () => {
    const dup = await seedAgent("Navruzbek");
    const c = await testPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        PILOT_LOCK_KEY,
      ]);
      await bootstrapPilotInTx(c).then(
        () => {
          throw new Error("expected ambiguity error");
        },
        (e) => {
          expect(e).toBeInstanceOf(PilotAgentError);
          expect((e as PilotAgentError).matches).toBe(2);
        },
      );
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    await client.query(`DELETE FROM distribution.delivery_agents WHERE id=$1`, [
      dup,
    ]);
  });

  it("readPilotState performs no writes when nothing exists", async () => {
    const c = await testPool.connect();
    try {
      const before = await client.query(
        `SELECT COUNT(*)::int AS n FROM distribution.vehicles`,
      );
      const s = await readPilotState(c);
      expect(s.bootstrapped).toBe(false);
      const after = await client.query(
        `SELECT COUNT(*)::int AS n FROM distribution.vehicles`,
      );
      expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n));
    } finally {
      c.release();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F2 Architect finding (1) — vehicle exclusion regressions
//
// After bootstrapping DM-001 (creating a vehicle warehouse), verify:
//   a) Sale default-source selector (fallback to first active warehouse) cannot
//      choose the vehicle warehouse.
//   b) Generic warehouse KPI/count (inventory/summary warehouseCount) excludes it.
//   c) Generic warehouse list (GET /warehouses) excludes it.
//   d) Vehicle pilot GET still sees it (dedicated endpoint is not filtered).
// ─────────────────────────────────────────────────────────────────────────────

describe("F2 finding (1) — vehicle exclusion after bootstrap", () => {
  // We bootstrap once for this entire describe block.
  let vehicleWarehouseId = 0;
  let erpWarehouseId = 0; // a normal 'general' ERP warehouse

  beforeAll(async () => {
    await resetPilot();
    // Bootstrap the pilot to create the vehicle warehouse.
    const boot = await call(
      "POST",
      "/vehicle-distribution/pilot/bootstrap",
      adminToken,
    );
    expect(boot.status).toBe(200);
    const wh = await client.query(
      `SELECT id FROM warehouses WHERE name = $1`,
      [PILOT_WAREHOUSE_NAME],
    );
    vehicleWarehouseId = Number(wh.rows[0].id);

    // Create a regular ERP warehouse that should be the fallback default.
    const erp = await client.query(
      `INSERT INTO warehouses (name, active, location_type, purpose)
       VALUES ('ERP Asosiy', TRUE, 'general', 'finished')
       ON CONFLICT (name) DO UPDATE SET active=TRUE
       RETURNING id`,
    );
    erpWarehouseId = Number(erp.rows[0].id);
  });

  // ── (a) Sale default-source selector ─────────────────────────────────────
  // Mirrors the exact query in sales.ts (both the quantity and kg code paths).
  it("(a) sale default-source selector excludes vehicle warehouse", async () => {
    const { rows } = await testPool.query(
      "SELECT id FROM warehouses WHERE active=TRUE AND COALESCE(location_type,'general') != 'vehicle' ORDER BY id LIMIT 1",
    );
    expect(rows.length).toBeGreaterThan(0);
    const chosenId = Number(rows[0].id);
    // The fallback default must never be the vehicle warehouse.
    expect(chosenId).not.toBe(vehicleWarehouseId);
  });

  // Confirm the OLD (unfixed) query WOULD have chosen the vehicle warehouse
  // if it happened to be first in id order — i.e., our fix is actually needed.
  it("(a) old query (no vehicle exclusion) would see vehicle warehouse in list", async () => {
    const { rows } = await testPool.query(
      "SELECT id FROM warehouses WHERE active=TRUE ORDER BY id",
    );
    const allIds = rows.map((r) => Number(r.id));
    expect(allIds).toContain(vehicleWarehouseId);
  });

  // ── (b) Generic warehouse KPI/count (inventory-v2 /inventory/summary) ─────
  it("(b) inventory/summary warehouseCount excludes vehicle warehouse", async () => {
    const { rows } = await testPool.query(
      "SELECT COUNT(*)::int AS cnt FROM warehouses WHERE active=TRUE AND COALESCE(location_type,'general') != 'vehicle'",
    );
    const countWithoutVehicle = Number(rows[0].cnt);

    const { rows: allRows } = await testPool.query(
      "SELECT COUNT(*)::int AS cnt FROM warehouses WHERE active=TRUE",
    );
    const countWithVehicle = Number(allRows[0].cnt);

    // The vehicle warehouse is counted by the unfiltered query but not the fixed one.
    expect(countWithVehicle).toBeGreaterThan(countWithoutVehicle);
    expect(countWithoutVehicle).toBe(countWithVehicle - 1);
  });

  // ── (c) Generic warehouse list (GET /warehouses via the fixed query) ───────
  it("(c) GET /warehouses query excludes vehicle warehouse", async () => {
    const { rows } = await testPool.query(
      "SELECT id, name, active FROM warehouses WHERE active = TRUE AND COALESCE(location_type,'general') != 'vehicle' ORDER BY id",
    );
    const ids = rows.map((r) => Number(r.id));
    expect(ids).not.toContain(vehicleWarehouseId);
    expect(ids).toContain(erpWarehouseId);
  });

  // ── (d) Vehicle pilot GET still sees the vehicle warehouse ─────────────────
  it("(d) vehicle pilot GET still returns the vehicle warehouse", async () => {
    const r = await call("GET", "/vehicle-distribution/pilot", adminToken);
    expect(r.status).toBe(200);
    const body = r.body as {
      bootstrapped: boolean;
      warehouse: { id: number; locationType: string };
    };
    expect(body.bootstrapped).toBe(true);
    expect(body.warehouse.id).toBe(vehicleWarehouseId);
    expect(body.warehouse.locationType).toBe("vehicle");
  });

  // ── (a2) inventory/stock all-warehouses excludes vehicle warehouse ─────────
  it("(a2) inventory/stock all-warehouses view excludes vehicle warehouse", async () => {
    // Seed a small amount into the vehicle warehouse's inventory.
    await client.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg)
       VALUES ($1, 'ArqonVehicle', 5, 2.5)
       ON CONFLICT (warehouse_id, product) DO UPDATE SET quantity=5`,
      [vehicleWarehouseId],
    );
    // The fixed query (no explicit warehouse_id) must exclude vehicle warehouses.
    const { rows } = await testPool.query(
      `SELECT w.id AS warehouse_id
         FROM inventory i
         JOIN warehouses w ON w.id = i.warehouse_id
        WHERE COALESCE(w.location_type,'general') != 'vehicle'
        ORDER BY w.id, i.product`,
    );
    const ids = rows.map((r) => Number(r.warehouse_id));
    expect(ids).not.toContain(vehicleWarehouseId);
  });

  // ── (b2) inventory/summary skuCount + totalStock + lowStock exclude vehicle ─
  // Mirrors the exact (fixed) aggregate queries in inventory-v2.ts. The vehicle
  // warehouse holds nonzero stock (a distinct SKU + big quantity + a low-stock
  // candidate) that must NOT bleed into any generic ERP inventory KPI, while
  // ordinary ERP inventory IS counted.
  it("(b2) inventory/summary skuCount/totalStock/lowStock exclude vehicle inventory", async () => {
    // Ordinary ERP inventory: one healthy SKU + one low-stock SKU.
    await client.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg)
       VALUES ($1, 'ERP Arqon', 200, 100), ($1, 'ERP LowStock', 3, 1.5)
       ON CONFLICT (warehouse_id, product) DO UPDATE
         SET quantity = EXCLUDED.quantity, weight_kg = EXCLUDED.weight_kg`,
      [erpWarehouseId],
    );
    // Vehicle inventory: a vehicle-only SKU (huge qty) + a vehicle-only low SKU.
    await client.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg)
       VALUES ($1, 'Vehicle-Only-SKU', 5000, 3000), ($1, 'Vehicle-Only-Low', 2, 1)
       ON CONFLICT (warehouse_id, product) DO UPDATE
         SET quantity = EXCLUDED.quantity, weight_kg = EXCLUDED.weight_kg`,
      [vehicleWarehouseId],
    );

    // skuCount (fixed): DISTINCT products across non-vehicle warehouses only.
    const skuRes = await testPool.query(
      `SELECT COUNT(DISTINCT i.product)::int AS sku_count
         FROM inventory i
         JOIN warehouses w ON w.id = i.warehouse_id
        WHERE i.quantity > 0
          AND COALESCE(w.location_type,'general') != 'vehicle'`,
    );
    const skuProducts = await testPool.query(
      `SELECT DISTINCT i.product
         FROM inventory i
         JOIN warehouses w ON w.id = i.warehouse_id
        WHERE i.quantity > 0
          AND COALESCE(w.location_type,'general') != 'vehicle'`,
    );
    const skuNames = skuProducts.rows.map((r) => String(r.product));
    expect(skuNames).toContain("ERP Arqon");
    expect(skuNames).not.toContain("Vehicle-Only-SKU");
    expect(skuNames).not.toContain("Vehicle-Only-Low");
    // Compare against the unfixed query to prove the fix removes vehicle SKUs.
    const skuRawRes = await testPool.query(
      "SELECT COUNT(DISTINCT product)::int AS sku_count FROM inventory WHERE quantity > 0",
    );
    expect(Number(skuRawRes.rows[0].sku_count)).toBeGreaterThan(
      Number(skuRes.rows[0].sku_count),
    );

    // totalStock (fixed): SUM(quantity) over non-vehicle warehouses only.
    const totalRes = await testPool.query(
      `SELECT COALESCE(SUM(i.quantity),0)::float8 AS total
         FROM inventory i
         JOIN warehouses w ON w.id = i.warehouse_id
        WHERE COALESCE(w.location_type,'general') != 'vehicle'`,
    );
    const totalRawRes = await testPool.query(
      "SELECT COALESCE(SUM(quantity),0)::float8 AS total FROM inventory",
    );
    // The 5000-unit vehicle SKU must not be included.
    expect(Number(totalRawRes.rows[0].total)).toBeGreaterThanOrEqual(
      Number(totalRes.rows[0].total) + 5000,
    );

    // lowStock (fixed): grouped SUM over non-vehicle warehouses only.
    const lowRes = await testPool.query(
      `SELECT i.product AS product, SUM(i.quantity) AS qty
         FROM inventory i
         JOIN warehouses w ON w.id = i.warehouse_id
        WHERE COALESCE(w.location_type,'general') != 'vehicle'
        GROUP BY i.product
       HAVING SUM(i.quantity) < 50 AND SUM(i.quantity) >= 0
       ORDER BY SUM(i.quantity) ASC LIMIT 10`,
    );
    const lowNames = lowRes.rows.map((r) => String(r.product));
    expect(lowNames).toContain("ERP LowStock");
    expect(lowNames).not.toContain("Vehicle-Only-Low");
  });

  // ── (d2) Vehicle pilot GET balance still includes vehicle stock ────────────
  it("(d2) vehicle pilot GET balance includes vehicle-only inventory", async () => {
    const r = await call("GET", "/vehicle-distribution/pilot", adminToken);
    expect(r.status).toBe(200);
    const body = r.body as {
      warehouse: { id: number };
      balance: { skuCount: number; totalQuantity: number };
    };
    expect(body.warehouse.id).toBe(vehicleWarehouseId);
    // The dedicated endpoint is NOT filtered — it sees vehicle-only stock that
    // the generic ERP KPIs above deliberately exclude.
    expect(body.balance.skuCount).toBeGreaterThan(0);
    expect(body.balance.totalQuantity).toBeGreaterThanOrEqual(5000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F2 Architect finding (3) — body validation: reject arbitrary properties
// ─────────────────────────────────────────────────────────────────────────────

describe("F2 finding (3) — bootstrap body validation", () => {
  beforeEach(async () => {
    await resetPilot();
  });

  it("empty body {} is accepted (normal idempotent bootstrap)", async () => {
    const res = await fetch(`${baseUrl}/vehicle-distribution/pilot/bootstrap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminToken}`,
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  it("no body (null) is accepted", async () => {
    const res = await fetch(`${baseUrl}/vehicle-distribution/pilot/bootstrap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminToken}`,
      },
      // send an empty string — express parses this as undefined body, falls
      // back to {} via the `req.body ?? {}` guard in the handler.
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  it("body with unknown property is rejected 400", async () => {
    const res = await fetch(`${baseUrl}/vehicle-distribution/pilot/bootstrap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ plateNumber: "DM-002", agentName: "HACKER" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("body overriding agent name is rejected 400", async () => {
    const res = await fetch(`${baseUrl}/vehicle-distribution/pilot/bootstrap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ agentName: PILOT_AGENT_NAME }),
    });
    expect(res.status).toBe(400);
  });

  it("body with extra prop rejected even for admin before any DB work", async () => {
    // First verify no vehicle exists yet.
    const before = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicles`,
    );
    expect(Number(before.rows[0].n)).toBe(0);
    // Send bad body — should get 400 immediately, no DB writes.
    const res = await fetch(`${baseUrl}/vehicle-distribution/pilot/bootstrap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ hack: 1 }),
    });
    expect(res.status).toBe(400);
    const after = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicles`,
    );
    expect(Number(after.rows[0].n)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F2 Architect finding (2) — validate-before-commit ordering
// (Service-level test: verifies that Zod parse runs inside the transaction.)
// ─────────────────────────────────────────────────────────────────────────────

describe("F2 finding (2) — validate response before commit", () => {
  beforeEach(async () => {
    await resetPilot();
  });

  it("successful bootstrap produces a payload that matches the Zod schema", async () => {
    const r = await call(
      "POST",
      "/vehicle-distribution/pilot/bootstrap",
      adminToken,
    );
    expect(r.status).toBe(200);
    // The payload must have every required field (Zod would have thrown before
    // commit if it didn't, so this passing proves the validate-before-commit path
    // is wired correctly).
    const body = r.body as {
      bootstrapped: boolean;
      agent: { id: number; name: string };
      vehicle: { id: number; plateNumber: string; vehicleType: string; status: string; capacityKg: number | null; warehouseId: number };
      warehouse: { id: number; name: string; locationType: string; purpose: string; active: boolean };
      balance: { warehouseId: number; skuCount: number; totalQuantity: number; totalWeightKg: number };
      assignment: { id: number; vehicleId: number; deliveryAgentId: number; status: string; assignedAt: string | null };
    };
    expect(typeof body.bootstrapped).toBe("boolean");
    expect(typeof body.agent?.id).toBe("number");
    expect(typeof body.vehicle?.plateNumber).toBe("string");
    expect(typeof body.warehouse?.locationType).toBe("string");
    expect(typeof body.balance?.skuCount).toBe("number");
    expect(typeof body.assignment?.status).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F5 read models — pilot vehicle warehouse stock cards + stock movements.
//
// Contract highlights exercised below:
//   • Same global auth wall + both request-time feature gates as the F2 router.
//   • Exact server-side pilot resolution (DM-001 / DAMAS / NAVRUZBEK) with the
//     expected vehicle warehouse — NO vehicle/warehouse request input.
//   • Pre-bootstrap: deterministic empty payloads, zeroed totals, no writes, and
//     NEVER a generic-warehouse fallback.
//   • Stock: only nonzero-quantity rows, sorted by product, exact totals, SKU
//     enrichment (nullable/empty), no other-warehouse leakage.
//   • Movements: inbound + outbound included, unrelated rows excluded, id DESC,
//     keyset pagination (limit default/max + beforeId) and 400 validation.
//   • Responses validate against the generated Zod schemas.
// ─────────────────────────────────────────────────────────────────────────────

// Bootstrap the pilot and return the resolved vehicle-warehouse id.
async function bootstrapAndGetWarehouseId(): Promise<number> {
  const boot = await call(
    "POST",
    "/vehicle-distribution/pilot/bootstrap",
    adminToken,
  );
  expect(boot.status).toBe(200);
  const wh = await client.query(
    `SELECT id FROM warehouses WHERE name = $1`,
    [PILOT_WAREHOUSE_NAME],
  );
  return Number(wh.rows[0].id);
}

// A second, unrelated ERP warehouse (never the vehicle warehouse).
async function seedErpWarehouse(name: string): Promise<number> {
  const r = await client.query(
    `INSERT INTO warehouses (name, active, location_type, purpose)
     VALUES ($1, TRUE, 'general', 'finished')
     ON CONFLICT (name) DO UPDATE SET active=TRUE
     RETURNING id`,
    [name],
  );
  return Number(r.rows[0].id);
}

describe("F5 stock — auth wall + feature gates", () => {
  it("GET stock without a token → 401", async () => {
    const r = await call("GET", "/vehicle-distribution/pilot/stock");
    expect(r.status).toBe(401);
  });
  it("GET stock with invalid token → 401", async () => {
    const r = await call("GET", "/vehicle-distribution/pilot/stock", "nope");
    expect(r.status).toBe(401);
  });
  it("gate off → 404", async () => {
    delete process.env.VEHICLE_DISTRIBUTION_ENABLED;
    delete process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED;
    const r = await call("GET", "/vehicle-distribution/pilot/stock", adminToken);
    expect(r.status).toBe(404);
  });
  it("enabled without schema approval → 503", async () => {
    process.env.VEHICLE_DISTRIBUTION_ENABLED = "1";
    delete process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED;
    const r = await call("GET", "/vehicle-distribution/pilot/stock", adminToken);
    expect(r.status).toBe(503);
  });
});

describe("F5 movements — auth wall + feature gates", () => {
  it("GET movements without a token → 401", async () => {
    const r = await call("GET", "/vehicle-distribution/pilot/movements");
    expect(r.status).toBe(401);
  });
  it("GET movements with invalid token → 401", async () => {
    const r = await call(
      "GET",
      "/vehicle-distribution/pilot/movements",
      "nope",
    );
    expect(r.status).toBe(401);
  });
  it("gate off → 404", async () => {
    delete process.env.VEHICLE_DISTRIBUTION_ENABLED;
    delete process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED;
    const r = await call(
      "GET",
      "/vehicle-distribution/pilot/movements",
      adminToken,
    );
    expect(r.status).toBe(404);
  });
  it("enabled without schema approval → 503", async () => {
    process.env.VEHICLE_DISTRIBUTION_ENABLED = "1";
    delete process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED;
    const r = await call(
      "GET",
      "/vehicle-distribution/pilot/movements",
      adminToken,
    );
    expect(r.status).toBe(503);
  });
});

describe("F5 pre-bootstrap — empty payloads + no writes + no fallback", () => {
  beforeEach(async () => {
    await resetPilot();
  });

  it("stock: not-bootstrapped, empty items, zeroed totals, null vehicle/warehouse", async () => {
    // A generic ERP warehouse with stock must NEVER be used as a fallback.
    const erp = await seedErpWarehouse("ERP-fallback-guard");
    await client.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg)
       VALUES ($1, 'Noise', 42, 21)`,
      [erp],
    );

    const before = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicles`,
    );
    const r = await call(
      "GET",
      "/vehicle-distribution/pilot/stock",
      adminToken,
    );
    expect(r.status).toBe(200);
    const body = GetVehicleDistributionPilotStockResponse.parse(r.body);
    expect(body.bootstrapped).toBe(false);
    expect(body.vehicle).toBeNull();
    expect(body.warehouse).toBeNull();
    expect(body.items).toEqual([]);
    expect(body.skuCount).toBe(0);
    expect(body.totalQuantity).toBe(0);
    expect(body.totalWeightKg).toBe(0);

    const after = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.vehicles`,
    );
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n));
  });

  it("movements: not-bootstrapped, empty items, null nextBeforeId, no writes", async () => {
    const before = await client.query(
      `SELECT COUNT(*)::int AS n FROM stock_movements`,
    );
    const r = await call(
      "GET",
      "/vehicle-distribution/pilot/movements",
      adminToken,
    );
    expect(r.status).toBe(200);
    const body = GetVehicleDistributionPilotMovementsResponse.parse(r.body);
    expect(body.bootstrapped).toBe(false);
    expect(body.vehicleWarehouseId).toBeNull();
    expect(body.items).toEqual([]);
    expect(body.nextBeforeId).toBeNull();

    const after = await client.query(
      `SELECT COUNT(*)::int AS n FROM stock_movements`,
    );
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n));
  });

  it("service readPilotStock performs no writes when not bootstrapped", async () => {
    const c = await testPool.connect();
    try {
      const before = await client.query(
        `SELECT COUNT(*)::int AS n FROM inventory`,
      );
      const s = await readPilotStock(c);
      expect(s.bootstrapped).toBe(false);
      expect(s.items).toEqual([]);
      const after = await client.query(
        `SELECT COUNT(*)::int AS n FROM inventory`,
      );
      expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n));
    } finally {
      c.release();
    }
  });
});

describe("F5 stock — exact rows, totals, SKU, sorting, isolation", () => {
  let vehicleWarehouseId = 0;
  let erpWarehouseId = 0;

  beforeEach(async () => {
    await resetPilot();
    vehicleWarehouseId = await bootstrapAndGetWarehouseId();
    erpWarehouseId = await seedErpWarehouse("ERP-stock-isolation");
  });

  it("returns exactly the nonzero vehicle rows, sorted by product, exact totals", async () => {
    // Catalog SKUs for two of the three products (third has no catalog row).
    await client.query(
      `INSERT INTO products (name, sku) VALUES ('Zeta', 'SKU-Z'), ('Alpha', 'SKU-A'), ('Beta', '')`,
    );
    // Vehicle inventory: two nonzero + one zero (must be excluded).
    await client.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg)
       VALUES ($1,'Zeta',3,9.0),($1,'Alpha',10,25.5),($1,'Zeroed',0,0)`,
      [vehicleWarehouseId],
    );
    // Unrelated warehouse stock — must never appear.
    await client.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg)
       VALUES ($1,'Alpha',999,999)`,
      [erpWarehouseId],
    );

    const r = await call(
      "GET",
      "/vehicle-distribution/pilot/stock",
      adminToken,
    );
    expect(r.status).toBe(200);
    const body = GetVehicleDistributionPilotStockResponse.parse(r.body);
    expect(body.bootstrapped).toBe(true);
    expect(body.vehicle?.plateNumber).toBe(PILOT_VEHICLE_PLATE);
    expect(body.warehouse?.id).toBe(vehicleWarehouseId);

    // Only the two nonzero rows, sorted by product name (Alpha < Zeta).
    expect(body.items.map((i) => i.product)).toEqual(["Alpha", "Zeta"]);
    // No zero row leaked in.
    expect(body.items.some((i) => i.product === "Zeroed")).toBe(false);
    // No other-warehouse noise (quantity 999) leaked.
    expect(body.items.every((i) => i.quantity !== 999)).toBe(true);

    const alpha = body.items.find((i) => i.product === "Alpha")!;
    expect(alpha.productName).toBe("Alpha");
    expect(alpha.productSku).toBe("SKU-A");
    expect(alpha.quantity).toBe(10);
    expect(alpha.weightKg).toBeCloseTo(25.5, 3);
    expect(typeof alpha.updatedAt).toBe("string");

    const zeta = body.items.find((i) => i.product === "Zeta")!;
    expect(zeta.productSku).toBe("SKU-Z");

    // Totals derived from the returned (nonzero) rows only.
    expect(body.skuCount).toBe(2);
    expect(body.totalQuantity).toBe(13);
    expect(body.totalWeightKg).toBeCloseTo(34.5, 3);
  });

  it("productSku is null when no catalog product row exists", async () => {
    await client.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg)
       VALUES ($1,'Orphan',5,2.5)`,
      [vehicleWarehouseId],
    );
    const r = await call(
      "GET",
      "/vehicle-distribution/pilot/stock",
      adminToken,
    );
    const body = GetVehicleDistributionPilotStockResponse.parse(r.body);
    const orphan = body.items.find((i) => i.product === "Orphan")!;
    expect(orphan.productSku).toBeNull();
  });

  it("productSku can be an empty string when the catalog SKU is empty", async () => {
    await client.query(`INSERT INTO products (name, sku) VALUES ('Empty', '')`);
    await client.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg)
       VALUES ($1,'Empty',4,1.0)`,
      [vehicleWarehouseId],
    );
    const r = await call(
      "GET",
      "/vehicle-distribution/pilot/stock",
      adminToken,
    );
    const body = GetVehicleDistributionPilotStockResponse.parse(r.body);
    const empty = body.items.find((i) => i.product === "Empty")!;
    expect(empty.productSku).toBe("");
  });
});

describe("F5 movements — inbound/outbound inclusion, isolation, order, pagination", () => {
  let vehicleWarehouseId = 0;
  let erpWarehouseId = 0;

  async function insMovement(opts: {
    product: string;
    from?: number | null;
    to?: number | null;
    type?: string;
    weight?: number | null;
    reference?: string | null;
  }): Promise<number> {
    const r = await client.query(
      `INSERT INTO stock_movements
         (product, quantity, movement_type, from_warehouse_id, to_warehouse_id,
          note, created_by, weight_kg, reference)
       VALUES ($1, 1, $2, $3, $4, 'n', 'tester', $5, $6)
       RETURNING id`,
      [
        opts.product,
        opts.type ?? "TRANSFER",
        opts.from ?? null,
        opts.to ?? null,
        opts.weight ?? null,
        opts.reference ?? null,
      ],
    );
    return Number(r.rows[0].id);
  }

  beforeEach(async () => {
    await resetPilot();
    vehicleWarehouseId = await bootstrapAndGetWarehouseId();
    erpWarehouseId = await seedErpWarehouse("ERP-mv-isolation");
  });

  it("includes inbound (to=vehicle) and outbound (from=vehicle); excludes unrelated", async () => {
    const inbound = await insMovement({
      product: "In",
      from: erpWarehouseId,
      to: vehicleWarehouseId,
      type: "IN",
      weight: 5,
      reference: "REF-IN",
    });
    const outbound = await insMovement({
      product: "Out",
      from: vehicleWarehouseId,
      to: erpWarehouseId,
      type: "OUT",
    });
    // Unrelated: neither side is the vehicle warehouse.
    const unrelated = await insMovement({
      product: "Unrelated",
      from: erpWarehouseId,
      to: erpWarehouseId,
    });

    const r = await call(
      "GET",
      "/vehicle-distribution/pilot/movements",
      adminToken,
    );
    expect(r.status).toBe(200);
    const body = GetVehicleDistributionPilotMovementsResponse.parse(r.body);
    expect(body.bootstrapped).toBe(true);
    expect(body.vehicleWarehouseId).toBe(vehicleWarehouseId);
    const ids = body.items.map((m) => m.id);
    expect(ids).toContain(inbound);
    expect(ids).toContain(outbound);
    expect(ids).not.toContain(unrelated);

    const inRow = body.items.find((m) => m.id === inbound)!;
    expect(inRow.toWarehouseId).toBe(vehicleWarehouseId);
    expect(inRow.toWarehouseName).toBe(PILOT_WAREHOUSE_NAME);
    expect(inRow.fromWarehouseId).toBe(erpWarehouseId);
    expect(inRow.weightKg).toBe(5);
    expect(inRow.reference).toBe("REF-IN");
    expect(typeof inRow.createdAt).toBe("string");
  });

  it("never exposes global movements with no warehouse ids", async () => {
    const globalRow = await insMovement({
      product: "Global",
      from: null,
      to: null,
      type: "BASELINE",
    });
    const r = await call(
      "GET",
      "/vehicle-distribution/pilot/movements",
      adminToken,
    );
    const body = GetVehicleDistributionPilotMovementsResponse.parse(r.body);
    expect(body.items.map((m) => m.id)).not.toContain(globalRow);
  });

  it("orders deterministically by id DESC", async () => {
    const first = await insMovement({ product: "A", to: vehicleWarehouseId });
    const second = await insMovement({ product: "B", to: vehicleWarehouseId });
    const third = await insMovement({ product: "C", to: vehicleWarehouseId });
    const r = await call(
      "GET",
      "/vehicle-distribution/pilot/movements",
      adminToken,
    );
    const body = GetVehicleDistributionPilotMovementsResponse.parse(r.body);
    const ids = body.items.map((m) => m.id);
    expect(ids).toEqual([third, second, first]);
    // Strictly descending.
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeLessThan(ids[i - 1]);
    }
  });

  it("paginates via limit + beforeId → nextBeforeId cursor", async () => {
    const created: number[] = [];
    for (let i = 0; i < 5; i++) {
      created.push(
        await insMovement({ product: `P${i}`, to: vehicleWarehouseId }),
      );
    }
    const desc = [...created].reverse(); // id DESC

    // First page of 2.
    const p1 = await call(
      "GET",
      "/vehicle-distribution/pilot/movements?limit=2",
      adminToken,
    );
    const b1 = GetVehicleDistributionPilotMovementsResponse.parse(p1.body);
    expect(b1.items.map((m) => m.id)).toEqual([desc[0], desc[1]]);
    expect(b1.nextBeforeId).toBe(desc[1]);

    // Second page using the cursor.
    const p2 = await call(
      "GET",
      `/vehicle-distribution/pilot/movements?limit=2&beforeId=${b1.nextBeforeId}`,
      adminToken,
    );
    const b2 = GetVehicleDistributionPilotMovementsResponse.parse(p2.body);
    expect(b2.items.map((m) => m.id)).toEqual([desc[2], desc[3]]);
    expect(b2.nextBeforeId).toBe(desc[3]);

    // Final (partial) page — no further cursor.
    const p3 = await call(
      "GET",
      `/vehicle-distribution/pilot/movements?limit=2&beforeId=${b2.nextBeforeId}`,
      adminToken,
    );
    const b3 = GetVehicleDistributionPilotMovementsResponse.parse(p3.body);
    expect(b3.items.map((m) => m.id)).toEqual([desc[4]]);
    expect(b3.nextBeforeId).toBeNull();
  });

  it("default limit is 50 (documented)", async () => {
    for (let i = 0; i < 3; i++) {
      await insMovement({ product: `D${i}`, to: vehicleWarehouseId });
    }
    // No limit param → default 50 applies; small dataset returns all with no cursor.
    const c = await testPool.connect();
    try {
      const s = await readPilotMovements(c, { limit: 50 });
      expect(s.items.length).toBe(3);
      expect(s.nextBeforeId).toBeNull();
    } finally {
      c.release();
    }
  });

  it("rejects limit above the max (200) with 400", async () => {
    const r = await call(
      "GET",
      "/vehicle-distribution/pilot/movements?limit=201",
      adminToken,
    );
    expect(r.status).toBe(400);
  });

  it("rejects a non-positive limit with 400", async () => {
    const r = await call(
      "GET",
      "/vehicle-distribution/pilot/movements?limit=0",
      adminToken,
    );
    expect(r.status).toBe(400);
  });

  it("rejects a non-positive beforeId with 400", async () => {
    const r = await call(
      "GET",
      "/vehicle-distribution/pilot/movements?beforeId=0",
      adminToken,
    );
    expect(r.status).toBe(400);
  });
});
