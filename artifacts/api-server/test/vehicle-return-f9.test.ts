import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import pg from "pg";
import express from "express";
import http from "node:http";
import { createVehicleReturnRouter } from "../src/routes/vehicle-distribution/return-router";
import {
  applyReconciliationInTx,
  createReconciliationInTx,
  patchReconciliationItemsInTx,
  reviewReconciliationInTx,
} from "../src/routes/vehicle-distribution/reconciliation-service";
import {
  cancelReturnInTx,
  createReturnInTx,
  listReturnableLabels,
  markReturnHandedBackInTx,
  transferReturnStockInTx,
} from "../src/routes/vehicle-distribution/return-service";
import {
  childDbUrl,
  requireVehicleTestAdminUrl,
  sslFor,
} from "./helpers/vehicle-test-db";

const { Client, Pool } = pg;
const adminUrl = requireVehicleTestAdminUrl();
const ssl = sslFor(adminUrl);
const dbName = `topmart_vehicle_return_${process.pid}_${Date.now()}`;
const dbUrl = childDbUrl(adminUrl, dbName);
const actor = { type: "admin", ref: "f9-admin", actorId: 1 };
const execFileAsync = promisify(execFile);
let pool: pg.Pool;

async function dropDb() {
  const c = new Client({ connectionString: adminUrl, ssl });
  await c.connect();
  await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]);
  await c.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await c.end();
}

async function transaction<T>(fn: (c: pg.PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

async function approvedReconciliation() {
  const created = await transaction((c) => createReconciliationInTx(
    c, "2027-01-01", null, actor,
  ));
  const entries = created.reconciliation.items.map((item) => ({
    itemId: item.id,
    actualQuantity: item.expectedQuantity,
    notes: null,
  }));
  await transaction((c) => patchReconciliationItemsInTx(
    c, created.reconciliation.id, entries, actor,
  ));
  await transaction((c) => reviewReconciliationInTx(
    c, created.reconciliation.id, actor,
  ));
  return created.reconciliation.id;
}

beforeAll(async () => {
  await dropDb();
  const admin = new Client({ connectionString: adminUrl, ssl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const c = new Client({ connectionString: dbUrl, ssl });
  await c.connect();
  await c.query(`
    CREATE TABLE warehouses (
      id SERIAL PRIMARY KEY,name TEXT UNIQUE NOT NULL,active BOOLEAN NOT NULL DEFAULT TRUE,
      location_type TEXT NOT NULL DEFAULT 'general',purpose TEXT NOT NULL DEFAULT 'finished'
    );
    CREATE TABLE products (
      id SERIAL PRIMARY KEY,name TEXT UNIQUE NOT NULL,sku TEXT NOT NULL,weight NUMERIC NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,in_sales BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE inventory (
      id SERIAL PRIMARY KEY,warehouse_id INTEGER NOT NULL,product TEXT NOT NULL,
      quantity NUMERIC NOT NULL DEFAULT 0,weight_kg NUMERIC NOT NULL DEFAULT 0,
      product_type TEXT NOT NULL DEFAULT 'finished',updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(warehouse_id,product)
    );
    CREATE TABLE stock_movements (
      id SERIAL PRIMARY KEY,product TEXT NOT NULL,quantity NUMERIC NOT NULL,
      movement_type TEXT NOT NULL,from_warehouse_id INTEGER,to_warehouse_id INTEGER,
      note TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL DEFAULT '',
      product_type TEXT NOT NULL DEFAULT 'finished',weight_kg NUMERIC,reference TEXT,reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE admin_users (
      id SERIAL PRIMARY KEY,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE admin_sessions (
      token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES admin_users(id)
    );
  `);
  await c.end();
  const scriptsDir = path.resolve(import.meta.dirname, "../../../scripts");
  const { RAILWAY_DATABASE_URL: _railway, ...baseEnv } = process.env;
  execFileSync("pnpm", ["exec", "tsx", "src/init-distribution.ts"], {
    cwd: scriptsDir,
    env: { ...baseEnv, DATABASE_URL: dbUrl, VEHICLE_DISTRIBUTION_SCHEMA_APPROVED: "1" },
    stdio: "ignore",
  });
  pool = new Pool({ connectionString: dbUrl, ssl });
});

afterAll(async () => {
  await pool?.end();
  await dropDb();
});

beforeEach(async () => {
  await pool.query(`
    TRUNCATE distribution.vehicle_reconciliation_items,distribution.vehicle_reconciliations,
      distribution.vehicle_return_items,distribution.vehicle_returns,
      distribution.vehicle_unit_events,distribution.vehicle_label_claims,
      distribution.vehicle_handoff_items,distribution.vehicle_handoffs,
      distribution.vehicle_assignments,distribution.vehicles,
      distribution.delivery_agents,distribution.mahsulotlar,
      stock_movements,inventory,products,warehouses,admin_sessions,admin_users RESTART IDENTITY CASCADE;
    INSERT INTO warehouses(name,active,location_type,purpose) VALUES
      ('DM-001 mashina ombori',TRUE,'vehicle','finished'),
      ('Source A',TRUE,'general','finished'),
      ('Source B',TRUE,'general','finished');
    INSERT INTO products(name,sku,weight) VALUES ('Product A','SKU-A',2),('Product B','SKU-B',3);
    INSERT INTO distribution.delivery_agents(name,faol,telegram_id) VALUES ('NAVRUZBEK',1,777);
    INSERT INTO distribution.dokonlar(nomi,agent_id,holat) VALUES ('Race shop',777,'faol');
    INSERT INTO distribution.mahsulotlar(nomi,faol,sku) VALUES ('A',1,'SKU-A'),('B',1,'SKU-B');
    INSERT INTO distribution.vehicles(plate_number,vehicle_type,warehouse_id)
      VALUES ('DM-001','DAMAS',1);
    INSERT INTO distribution.vehicle_assignments(vehicle_id,delivery_agent_id,status)
      VALUES (1,1,'active');
    INSERT INTO distribution.vehicle_handoffs
      (vehicle_id,delivery_agent_id,source_warehouse_id,vehicle_warehouse_id,handoff_date,status)
      VALUES (1,1,2,1,CURRENT_DATE,'stock_transferred'),
             (1,1,3,1,CURRENT_DATE,'stock_transferred');
    INSERT INTO distribution.vehicle_handoff_items
      (handoff_id,mahsulot_id,sku,quantity_dispatched,product_name,unit_weight_kg,total_weight_kg)
      VALUES (1,1,'SKU-A',1,'Product A',2,2),(2,2,'SKU-B',1,'Product B',3,3);
    INSERT INTO distribution.vehicle_label_claims
      (vehicle_id,handoff_id,handoff_item_id,production_label_id,barcode,mahsulot_id,sku,unit_weight_kg,status)
      VALUES (1,1,1,101,'TMRETURNLABELAAAA',1,'SKU-A',2,'loaded'),
             (1,2,2,102,'TMRETURNLABELBBBB',2,'SKU-B',3,'loaded'),
             (1,1,1,103,'TMSOLDLABELAAAAAA',1,'SKU-A',2,'sold'),
             (1,1,1,104,'TMRETURNEDLABELAA',1,'SKU-A',2,'returned'),
             (1,1,1,105,'TMRETURNLABELCCCC',1,'SKU-A',2,'loaded'),
             (1,2,2,106,'TMRETURNLABELDDDD',2,'SKU-B',3,'loaded');
    INSERT INTO distribution.vehicle_unit_events
      (vehicle_id,handoff_id,handoff_item_id,mahsulot_id,sku,event_type,quantity,
       actor_id,production_label_id,barcode,label_claim_id,operation_key)
      VALUES (1,1,1,1,'SKU-A','load',1,777,101,'TMRETURNLABELAAAA',1,'load-race-a'),
             (1,2,2,2,'SKU-B','load',1,777,102,'TMRETURNLABELBBBB',2,'load-race-b'),
             (1,1,1,1,'SKU-A','load',1,777,105,'TMRETURNLABELCCCC',5,'load-race-c'),
             (1,2,2,2,'SKU-B','load',1,777,106,'TMRETURNLABELDDDD',6,'load-race-d');
    INSERT INTO inventory(warehouse_id,product,quantity,weight_kg)
      VALUES (1,'Product A',1,2),(1,'Product B',1,3),(2,'Product A',4,8),(3,'Product B',5,15);
    INSERT INTO admin_users(username,role) VALUES ('admin','admin'),('viewer','viewer');
    INSERT INTO admin_sessions(token,user_id) VALUES ('admin-token',1),('viewer-token',2);
  `);
});

describe("F9 exact-pilot vehicle returns", () => {
  it.each([1, 2, 3])(
    "serializes actual F7 sale vs F9 reservation on the vehicle parent (iteration %s)",
    async (iteration) => {
      await pool.query(`UPDATE distribution.vehicle_label_claims SET status='sold' WHERE id IN (5,6)`);
      const blocker = await pool.connect();
      await blocker.query("BEGIN");
      await blocker.query(`SELECT id FROM warehouses WHERE id=1 FOR UPDATE`);
      const returnAttempt = transaction((c) => createReturnInTx(c, {
        barcodes: ["TMRETURNLABELAAAA"],
        operationKey: `f9-race-${iteration}`,
        notes: null,
      }, actor));
      const botDir = path.resolve(import.meta.dirname, "../../distribution-bot");
      const uuid = `00000000-0000-4000-8000-${String(iteration).padStart(12, "0")}`;
      const { RAILWAY_DATABASE_URL: _railway, ...baseEnv } = process.env;
      const pythonAttempt = execFileAsync(
        path.resolve(import.meta.dirname, "../../../.pythonlibs/bin/python3"),
        ["-c", [
          "from database.sales import create_vehicle_pilot_sale",
          `print(create_vehicle_pilot_sale(1,777,[(1,1,10)],10,'cash',None,0,'${uuid}'))`,
        ].join(";")],
        { cwd: botDir, env: { ...baseEnv, DATABASE_URL: dbUrl } },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await blocker.query("COMMIT");
      blocker.release();
      const [ret, sale] = await Promise.allSettled([returnAttempt, pythonAttempt]);
      expect([ret.status, sale.status].sort()).toEqual(["fulfilled", "rejected"]);
      const claim = (await pool.query(`SELECT status,return_id FROM distribution.vehicle_label_claims WHERE id=1`)).rows[0];
      const counts = (await pool.query(`
        SELECT
          (SELECT count(*) FROM distribution.vehicle_returns) returns,
          (SELECT count(*) FROM distribution.vehicle_return_items) return_items,
          (SELECT count(*) FROM distribution.savdolar WHERE operation_key LIKE 'vehicle-sale:%') sales,
          (SELECT count(*) FROM distribution.vehicle_sale_allocations) sale_allocations,
          (SELECT count(*) FROM distribution.vehicle_unit_events WHERE event_type='sale') sale_events
      `)).rows[0];
      if (ret.status === "fulfilled") {
        if (sale.status === "rejected") expect(String(sale.reason)).toMatch(/VehiclePilotSaleError|loaded|label/i);
        expect(claim.status).toBe("return_reserved");
        expect(Number(counts.returns)).toBe(1);
        expect(Number(counts.return_items)).toBe(1);
        expect(Number(counts.sales)).toBe(0);
        expect(Number(counts.sale_allocations)).toBe(0);
        expect(Number(counts.sale_events)).toBe(0);
        expect(Number((await pool.query(`SELECT quantity FROM inventory WHERE warehouse_id=1 AND product='Product A'`)).rows[0].quantity)).toBe(1);
      } else {
        expect(String(ret.reason)).toMatch(/loaded|return|label|claim/i);
        expect(claim.status).toBe("sold");
        expect(claim.return_id).toBeNull();
        expect(Number(counts.returns)).toBe(0);
        expect(Number(counts.return_items)).toBe(0);
        expect(Number(counts.sales)).toBe(1);
        expect(Number(counts.sale_allocations)).toBe(1);
        expect(Number(counts.sale_events)).toBe(1);
        expect(Number((await pool.query(`SELECT quantity FROM inventory WHERE warehouse_id=1 AND product='Product A'`)).rows[0].quantity)).toBe(0);
      }
    },
  );

  it.each([1, 2, 3])(
    "sorts overlapping multi-destination parent sets independent of barcode order (iteration %s)",
    async (iteration) => {
      const blocker = await pool.connect();
      await blocker.query("BEGIN");
      await blocker.query(`SELECT id FROM warehouses WHERE id=1 FOR UPDATE`);
      const firstInput = {
        barcodes: ["TMRETURNLABELAAAA", "TMRETURNLABELBBBB"],
        operationKey: `f9-multi-first-${iteration}`,
        notes: null,
      };
      const secondInput = {
        barcodes: ["TMRETURNLABELDDDD", "TMRETURNLABELCCCC"],
        operationKey: `f9-multi-second-${iteration}`,
        notes: null,
      };
      const first = transaction((c) => createReturnInTx(c, firstInput, actor));
      const second = transaction((c) => createReturnInTx(c, secondInput, actor));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await blocker.query("COMMIT");
      blocker.release();
      const results = await Promise.allSettled([first, second]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      const reserved = await pool.query(
        `SELECT barcode FROM distribution.vehicle_label_claims WHERE status='return_reserved' ORDER BY barcode`,
      );
      expect(reserved.rows).toHaveLength(2);
      const open = await pool.query(`SELECT count(*) n FROM distribution.vehicle_returns WHERE status='prepared'`);
      expect(Number(open.rows[0].n)).toBe(1);
      const winnerIndex = results[0].status === "fulfilled" ? 0 : 1;
      const winner = results[winnerIndex];
      if (winner.status !== "fulfilled") throw new Error("Expected one winning return");
      await transaction((c) => cancelReturnInTx(c, winner.value.id, actor));
      const loserInput = winnerIndex === 0 ? secondInput : firstInput;
      const retried = await transaction((c) => createReturnInTx(c, loserInput, actor));
      expect(retried.items.map((x) => x.destinationWarehouseId).sort()).toEqual([2, 3]);
      expect((await pool.query(`SELECT status,count(*)::int n FROM distribution.vehicle_returns GROUP BY status ORDER BY status`)).rows)
        .toEqual([{ status: "cancelled", n: 1 }, { status: "prepared", n: 1 }]);
    },
  );

  it("serializes overlapping-claim F9 creates into one owner and one clean conflict", async () => {
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(`SELECT id FROM warehouses WHERE id=1 FOR UPDATE`);
    const a = transaction((c) => createReturnInTx(c, {
      barcodes: ["TMRETURNLABELAAAA", "TMRETURNLABELBBBB"],
      operationKey: "f9-overlap-a", notes: null,
    }, actor));
    const b = transaction((c) => createReturnInTx(c, {
      barcodes: ["TMRETURNLABELAAAA", "TMRETURNLABELDDDD"],
      operationKey: "f9-overlap-b", notes: null,
    }, actor));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await blocker.query("COMMIT");
    blocker.release();
    const results = await Promise.allSettled([a, b]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(Number((await pool.query(
      `SELECT count(*) n FROM distribution.vehicle_label_claims WHERE barcode='TMRETURNLABELAAAA' AND status='return_reserved'`,
    )).rows[0].n)).toBe(1);
    expect(Number((await pool.query(`SELECT count(*) n FROM distribution.vehicle_returns`)).rows[0].n)).toBe(1);
  });

  it("F6 apply rejects a prepared return and leaves the reconciliation approved", async () => {
    const reconciliationId = await approvedReconciliation();
    await transaction((c) => createReturnInTx(c, {
      barcodes: ["TMRETURNLABELAAAA"],
      operationKey: "f9-f6-prepared-guard", notes: null,
    }, actor));
    await expect(transaction((c) => applyReconciliationInTx(c, reconciliationId, actor)))
      .rejects.toThrow(/open vehicle return|blocks reconciliation/i);
    expect((await pool.query(
      `SELECT status,applied_by,applied_at FROM distribution.vehicle_reconciliations WHERE id=$1`,
      [reconciliationId],
    )).rows[0]).toEqual({ status: "approved", applied_by: null, applied_at: null });
  });

  it("F6 apply may succeed after a prepared return is cancelled without inventory change", async () => {
    const reconciliationId = await approvedReconciliation();
    const ret = await transaction((c) => createReturnInTx(c, {
      barcodes: ["TMRETURNLABELAAAA"],
      operationKey: "f9-f6-cancelled-terminal", notes: null,
    }, actor));
    await transaction((c) => cancelReturnInTx(c, ret.id, actor));
    const applied = await transaction((c) => applyReconciliationInTx(c, reconciliationId, actor));
    expect(applied.status).toBe("applied");
    expect(Number((await pool.query(
      `SELECT quantity FROM inventory WHERE warehouse_id=1 AND product='Product A'`,
    )).rows[0].quantity)).toBe(1);
  });

  it.each([1, 2, 3])(
    "return-first F9 transfer makes queued F6 apply stale without overwrite (iteration %s)",
    async (iteration) => {
      const reconciliationId = await approvedReconciliation();
      const ret = await transaction((c) => createReturnInTx(c, {
        barcodes: ["TMRETURNLABELAAAA"],
        operationKey: `f9-f6-return-first-${iteration}`, notes: null,
      }, actor));
      await transaction((c) => markReturnHandedBackInTx(c, ret.id, actor));
      const blocker = await pool.connect();
      await blocker.query("BEGIN");
      await blocker.query(`SELECT id FROM warehouses WHERE id=1 FOR UPDATE`);
      const transfer = transaction((c) => transferReturnStockInTx(c, ret.id, actor));
      await new Promise((resolve) => setTimeout(resolve, 40));
      const apply = transaction((c) => applyReconciliationInTx(c, reconciliationId, actor));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await blocker.query("COMMIT");
      blocker.release();
      const [transferResult, applyResult] = await Promise.allSettled([transfer, apply]);
      expect(transferResult.status).toBe("fulfilled");
      expect(applyResult.status).toBe("rejected");
      if (applyResult.status === "rejected") {
        expect(String(applyResult.reason)).toMatch(/stale|changed/i);
      }
      expect((await pool.query(`SELECT status FROM distribution.vehicle_returns WHERE id=$1`, [ret.id])).rows[0].status)
        .toBe("stock_transferred");
      expect((await pool.query(`SELECT status FROM distribution.vehicle_reconciliations WHERE id=$1`, [reconciliationId])).rows[0].status)
        .toBe("approved");
      expect(Number((await pool.query(`SELECT quantity FROM inventory WHERE warehouse_id=1 AND product='Product A'`)).rows[0].quantity))
        .toBe(0);
    },
  );

  it.each([1, 2, 3])(
    "apply-first F6 guards open return before queued F9 transfer succeeds (iteration %s)",
    async (iteration) => {
      const reconciliationId = await approvedReconciliation();
      const ret = await transaction((c) => createReturnInTx(c, {
        barcodes: ["TMRETURNLABELAAAA"],
        operationKey: `f9-f6-apply-first-${iteration}`, notes: null,
      }, actor));
      await transaction((c) => markReturnHandedBackInTx(c, ret.id, actor));
      const blocker = await pool.connect();
      await blocker.query("BEGIN");
      await blocker.query(`SELECT id FROM warehouses WHERE id=1 FOR UPDATE`);
      const apply = transaction((c) => applyReconciliationInTx(c, reconciliationId, actor));
      await new Promise((resolve) => setTimeout(resolve, 40));
      const transfer = transaction((c) => transferReturnStockInTx(c, ret.id, actor));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await blocker.query("COMMIT");
      blocker.release();
      const [applied, transferred] = await Promise.allSettled([apply, transfer]);
      expect(applied.status).toBe("rejected");
      if (applied.status === "rejected") {
        expect(String(applied.reason)).toMatch(/open vehicle return|blocks reconciliation/i);
      }
      expect(transferred.status).toBe("fulfilled");
      expect(Number((await pool.query(`SELECT quantity FROM inventory WHERE warehouse_id=1 AND product='Product A'`)).rows[0].quantity))
        .toBe(0);
      expect((await pool.query(`SELECT status FROM distribution.vehicle_reconciliations WHERE id=$1`, [reconciliationId])).rows[0].status)
        .toBe("approved");
    },
  );

  it("all routes require an admin session and explicitly reject the valid vehicle bot key", async () => {
    const old = {
      enabled: process.env.VEHICLE_DISTRIBUTION_ENABLED,
      schema: process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED,
      labels: process.env.PRODUCTION_LABELS_SCHEMA_APPROVED,
      bot: process.env.VEHICLE_DISTRIBUTION_BOT_KEY,
    };
    Object.assign(process.env, {
      VEHICLE_DISTRIBUTION_ENABLED: "1",
      VEHICLE_DISTRIBUTION_SCHEMA_APPROVED: "1",
      PRODUCTION_LABELS_SCHEMA_APPROVED: "1",
      VEHICLE_DISTRIBUTION_BOT_KEY: "f9-valid-bot-key",
    });
    const app = express();
    app.use(express.json());
    app.use(createVehicleReturnRouter(pool));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/vehicle-distribution/pilot/returns`;
    try {
      expect((await fetch(url, { headers: { "x-vehicle-distribution-bot-key": "f9-valid-bot-key" } })).status).toBe(403);
      expect((await fetch(url, { headers: { authorization: "Bearer viewer-token" } })).status).toBe(403);
      expect((await fetch(url, { headers: { authorization: "Bearer admin-token" } })).status).toBe(200);
      process.env.VEHICLE_DISTRIBUTION_ENABLED = "0";
      expect((await fetch(url, { headers: { authorization: "Bearer admin-token" } })).status).toBe(404);
      process.env.VEHICLE_DISTRIBUTION_ENABLED = "1";
      process.env.PRODUCTION_LABELS_SCHEMA_APPROVED = "0";
      expect((await fetch(url, { headers: { authorization: "Bearer admin-token" } })).status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (old.enabled == null) delete process.env.VEHICLE_DISTRIBUTION_ENABLED; else process.env.VEHICLE_DISTRIBUTION_ENABLED = old.enabled;
      if (old.schema == null) delete process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED; else process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED = old.schema;
      if (old.labels == null) delete process.env.PRODUCTION_LABELS_SCHEMA_APPROVED; else process.env.PRODUCTION_LABELS_SCHEMA_APPROVED = old.labels;
      if (old.bot == null) delete process.env.VEHICLE_DISTRIBUTION_BOT_KEY; else process.env.VEHICLE_DISTRIBUTION_BOT_KEY = old.bot;
    }
  });

  it("lists only loaded returnable labels and supports search", async () => {
    const c = await pool.connect();
    try {
      const all = await listReturnableLabels(c);
      expect(all.labels.map((x) => x.barcode)).toEqual([
        "TMRETURNLABELAAAA", "TMRETURNLABELBBBB",
        "TMRETURNLABELCCCC", "TMRETURNLABELDDDD",
      ]);
      expect((await listReturnableLabels(c, "Product B")).labels).toHaveLength(2);
    } finally { c.release(); }
  });

  it("reserves multi-destination labels, replays exactly, and rejects fingerprint mismatch", async () => {
    const input = { barcodes: ["TMRETURNLABELBBBB", "TMRETURNLABELAAAA"], operationKey: "f9-create-1", notes: "all" };
    const first = await transaction((c) => createReturnInTx(c, input, actor));
    expect(first.items.map((x) => x.destinationWarehouseId).sort()).toEqual([2, 3]);
    expect(await pool.query(`SELECT status FROM distribution.vehicle_label_claims WHERE id IN (1,2) ORDER BY id`).then((r) => r.rows.map((x) => x.status)))
      .toEqual(["return_reserved", "return_reserved"]);
    expect((await transaction((c) => createReturnInTx(c, input, actor))).id).toBe(first.id);
    await expect(transaction((c) => createReturnInTx(c, { ...input, notes: "changed" }, actor))).rejects.toThrow(/different payload/);
  });

  it("handed-back moves no stock; transfer is exact and retry creates no duplicates", async () => {
    const ret = await transaction((c) => createReturnInTx(c, {
      barcodes: ["TMRETURNLABELAAAA", "TMRETURNLABELBBBB"], operationKey: "f9-transfer", notes: null,
    }, actor));
    await transaction((c) => markReturnHandedBackInTx(c, ret.id, actor));
    expect(Number((await pool.query(`SELECT sum(quantity) q FROM inventory WHERE warehouse_id=1`)).rows[0].q)).toBe(2);
    await transaction((c) => transferReturnStockInTx(c, ret.id, actor));
    await transaction((c) => transferReturnStockInTx(c, ret.id, actor));
    expect(Number((await pool.query(`SELECT count(*) n FROM stock_movements WHERE reference LIKE 'vehicle-return:%'`)).rows[0].n)).toBe(2);
    expect(Number((await pool.query(`SELECT count(*) n FROM distribution.vehicle_unit_events WHERE event_type='return'`)).rows[0].n)).toBe(2);
    expect(Number((await pool.query(`SELECT sum(quantity) q FROM inventory WHERE warehouse_id=1`)).rows[0].q)).toBe(0);
    expect((await pool.query(`SELECT status FROM distribution.vehicle_label_claims WHERE id IN (1,2) ORDER BY id`)).rows.map((x) => x.status))
      .toEqual(["returned", "returned"]);
  });

  it("insufficient stock rolls back every item and prepared cancel releases exactly once", async () => {
    const ret = await transaction((c) => createReturnInTx(c, {
      barcodes: ["TMRETURNLABELAAAA", "TMRETURNLABELBBBB"], operationKey: "f9-rollback", notes: null,
    }, actor));
    await transaction((c) => markReturnHandedBackInTx(c, ret.id, actor));
    await pool.query(`UPDATE inventory SET weight_kg=0 WHERE warehouse_id=1 AND product='Product B'`);
    await expect(transaction((c) => transferReturnStockInTx(c, ret.id, actor))).rejects.toThrow(/Insufficient/);
    expect(Number((await pool.query(`SELECT count(*) n FROM stock_movements WHERE reference LIKE 'vehicle-return:%'`)).rows[0].n)).toBe(0);
    expect(Number((await pool.query(`SELECT quantity FROM inventory WHERE warehouse_id=1 AND product='Product A'`)).rows[0].quantity)).toBe(1);

    await pool.query(`UPDATE distribution.vehicle_returns SET status='prepared',handed_back_by=NULL,handed_back_at=NULL WHERE id=$1`, [ret.id]);
    await transaction((c) => cancelReturnInTx(c, ret.id, actor));
    await transaction((c) => cancelReturnInTx(c, ret.id, actor));
    expect((await pool.query(`SELECT status,return_id FROM distribution.vehicle_label_claims WHERE id IN (1,2) ORDER BY id`)).rows)
      .toEqual([{ status: "loaded", return_id: null }, { status: "loaded", return_id: null }]);
  });
});