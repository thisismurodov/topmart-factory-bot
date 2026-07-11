import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// ── Isolation ──────────────────────────────────────────────────────────────
// Every query runs in a throwaway schema (search_path) so the test never
// touches real Ombor data. The search_path is injected via the libpq `options`
// connection parameter, applied to every new pool connection at connect time.
const SCHEMA = `topmart_kg_flow_receive_test_${process.pid}_${Date.now()}`;

const baseUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL must be set to run these tests");
{
  const u = new URL(baseUrl);
  u.searchParams.set("options", `-c search_path=${SCHEMA}`);
  // lib/db prefers RAILWAY_DATABASE_URL (and enables SSL for it); keep this a
  // plain local connection so the schema isolation is the only override.
  delete process.env.RAILWAY_DATABASE_URL;
  process.env.DATABASE_URL = u.toString();
}

let pool: Pool;
let server: Server;
let apiUrl: string;
let materialId: number;
let rawWarehouseId: number;
let finishedWarehouseId: number;
let lineId: number;

const MAT = "Un test (flow receive)";
const UNIT = "kg";
const START_STOCK = 100; // global raw_materials.current_stock
const CONTAINER_KG = 50; // seeded container inventory per test

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function materialStock(id: number): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT current_stock FROM raw_materials WHERE id = $1`, [id],
  );
  return rows.length ? Number(rows[0].current_stock) : null;
}

async function inventoryRows(): Promise<any[]> {
  const { rows } = await pool.query(
    `SELECT warehouse_id, product, quantity, weight_kg, product_type
       FROM inventory ORDER BY id`,
  );
  return rows;
}

async function movements(): Promise<any[]> {
  const { rows } = await pool.query(
    `SELECT product, quantity, movement_type, from_warehouse_id, to_warehouse_id,
            note, created_by, product_type
     FROM stock_movements ORDER BY id`,
  );
  return rows;
}

async function wipMovements(): Promise<any[]> {
  const { rows } = await pool.query(`SELECT * FROM wip_movements ORDER BY id`);
  return rows;
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);

  // Minimal copies of the production tables /ombor/flow/receive touches. These
  // tables are not in the Drizzle schema (created out-of-band in prod), so we
  // mirror only the columns the route actually uses. receive decrements the
  // container inventory AND writes a RECEIVE wip_movements row inside one
  // transaction (plus an OUT stock_movements log line). It must NEVER touch
  // raw_materials — the material is still in-factory as WIP.
  await pool.query(`
    CREATE TABLE warehouses (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      location_type TEXT NOT NULL DEFAULT 'general',
      purpose       TEXT NOT NULL DEFAULT 'finished'
    );
    CREATE TABLE production_lines (
      id     SERIAL PRIMARY KEY,
      name   TEXT NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE raw_materials (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      unit          TEXT NOT NULL DEFAULT 'kg',
      current_stock NUMERIC NOT NULL DEFAULT 0,
      minimum_stock NUMERIC NOT NULL DEFAULT 0,
      default_cost  NUMERIC NOT NULL DEFAULT 0,
      currency      TEXT NOT NULL DEFAULT 'UZS',
      active        BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE inventory (
      id           SERIAL PRIMARY KEY,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
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
  `);

  const wh = await pool.query(
    `INSERT INTO warehouses (name, location_type, purpose) VALUES
       ('Xom ashyo konteyneri', 'container', 'raw'),
       ('Tayyor mahsulot konteyneri', 'container', 'finished')
     RETURNING id, purpose`,
  );
  rawWarehouseId = wh.rows.find((r) => r.purpose === "raw").id;
  finishedWarehouseId = wh.rows.find((r) => r.purpose === "finished").id;

  const line = await pool.query(
    `INSERT INTO production_lines (name) VALUES ('Makaron bo''limi (test)') RETURNING id`,
  );
  lineId = line.rows[0].id;

  const { rows } = await pool.query(
    `INSERT INTO raw_materials (name, unit, current_stock)
     VALUES ($1,$2,$3) RETURNING id`,
    [MAT, UNIT, START_STOCK],
  );
  materialId = rows[0].id;

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
  await pool.query(`TRUNCATE stock_movements RESTART IDENTITY`);
  await pool.query(`TRUNCATE wip_movements RESTART IDENTITY`);
  await pool.query(`TRUNCATE inventory RESTART IDENTITY`);
  await pool.query(
    `UPDATE raw_materials SET current_stock = $1 WHERE id = $2`,
    [START_STOCK, materialId],
  );
  // Seed the raw container with CONTAINER_KG of the material (as raw-in would).
  await pool.query(
    `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type)
     VALUES ($1,$2,$3,$3,'raw')`,
    [rawWarehouseId, MAT, CONTAINER_KG],
  );
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }
});

// Convenience: state that must be unchanged after any rejected request.
async function expectUntouched(): Promise<void> {
  const inv = await inventoryRows();
  expect(inv).toHaveLength(1);
  expect(Number(inv[0].weight_kg)).toBe(CONTAINER_KG);
  expect(Number(inv[0].quantity)).toBe(CONTAINER_KG);
  expect(await wipMovements()).toHaveLength(0);
  expect(await movements()).toHaveLength(0);
  expect(await materialStock(materialId)).toBe(START_STOCK);
}

describe("POST /ombor/flow/receive — container → department hand-off integrity", () => {
  it("decrements the container AND writes exactly one RECEIVE wip row in lockstep", async () => {
    const res = await post("/ombor/flow/receive", {
      warehouseId: rawWarehouseId, lineId, materialName: MAT, kg: 30,
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);

    // Container: 50 − 30 = 20, quantity mirrors weight_kg.
    const inv = await inventoryRows();
    expect(inv).toHaveLength(1);
    expect(Number(inv[0].weight_kg)).toBe(20);
    expect(Number(inv[0].quantity)).toBe(20);
    expect(inv[0].product_type).toBe("raw");

    // Exactly ONE RECEIVE row for +30 kg — the department's WIP credit.
    const wip = await wipMovements();
    expect(wip).toHaveLength(1);
    expect(wip[0].movement_type).toBe("RECEIVE");
    expect(wip[0].line_id).toBe(lineId);
    expect(wip[0].raw_material).toBe(MAT);
    expect(Number(wip[0].weight_kg)).toBe(30);
    expect(wip[0].from_warehouse_id).toBe(rawWarehouseId);

    // Audit trail: one OUT/raw stock_movement from the container.
    const mv = await movements();
    expect(mv).toHaveLength(1);
    expect(mv[0].movement_type).toBe("OUT");
    expect(mv[0].product_type).toBe("raw");
    expect(mv[0].product).toBe(MAT);
    expect(Number(mv[0].quantity)).toBe(30);
    expect(mv[0].from_warehouse_id).toBe(rawWarehouseId);
    expect(mv[0].to_warehouse_id).toBeNull();
  });

  it("does NOT change raw_materials.current_stock (material is still in-factory WIP)", async () => {
    const res = await post("/ombor/flow/receive", {
      warehouseId: rawWarehouseId, lineId, materialName: MAT, kg: 30,
    });
    expect(res.status).toBe(200);
    // Global raw stock only drops when a batch consumes it (BOM), not here.
    expect(await materialStock(materialId)).toBe(START_STOCK);
  });

  it("handles fractional kg precisely across container + WIP ledger", async () => {
    const res = await post("/ombor/flow/receive", {
      warehouseId: rawWarehouseId, lineId, materialName: MAT, kg: 2.5,
    });
    expect(res.status).toBe(200);
    const inv = await inventoryRows();
    expect(Number(inv[0].weight_kg)).toBe(47.5);
    const wip = await wipMovements();
    expect(wip).toHaveLength(1);
    expect(Number(wip[0].weight_kg)).toBe(2.5);
  });

  it("allows draining the container to exactly zero (kg == available)", async () => {
    const res = await post("/ombor/flow/receive", {
      warehouseId: rawWarehouseId, lineId, materialName: MAT, kg: CONTAINER_KG,
    });
    expect(res.status).toBe(200);
    const inv = await inventoryRows();
    expect(Number(inv[0].weight_kg)).toBe(0);
    expect(Number(inv[0].quantity)).toBe(0);
    const wip = await wipMovements();
    expect(wip).toHaveLength(1);
    expect(Number(wip[0].weight_kg)).toBe(CONTAINER_KG);
  });

  it("accumulates consecutive hand-offs: container drains, WIP rows add up", async () => {
    await post("/ombor/flow/receive", { warehouseId: rawWarehouseId, lineId, materialName: MAT, kg: 10 });
    await post("/ombor/flow/receive", { warehouseId: rawWarehouseId, lineId, materialName: MAT, kg: 15 });

    const inv = await inventoryRows();
    expect(Number(inv[0].weight_kg)).toBe(25); // 50 − 10 − 15

    // WIP = SUM(RECEIVE) − SUM(PRODUCE) → two RECEIVE rows totalling 25 kg.
    const wip = await wipMovements();
    expect(wip).toHaveLength(2);
    expect(wip.map((w) => Number(w.weight_kg))).toEqual([10, 15]);
    expect(wip.every((w) => w.movement_type === "RECEIVE")).toBe(true);
  });

  it("records the custom note on the wip_movements row", async () => {
    const res = await post("/ombor/flow/receive", {
      warehouseId: rawWarehouseId, lineId, materialName: MAT, kg: 5, note: "Ertalabki smena",
    });
    expect(res.status).toBe(200);
    const wip = await wipMovements();
    expect(wip[0].note).toBe("Ertalabki smena");
  });

  // ── Over-draw: the race-safe "weight_kg >= amount" guard ───────────────────

  it("rejects kg > available (400) and leaves container + WIP + log untouched", async () => {
    const res = await post("/ombor/flow/receive", {
      warehouseId: rawWarehouseId, lineId, materialName: MAT, kg: CONTAINER_KG + 0.001,
    });
    expect(res.status).toBe(400);
    // The error surfaces how much IS available so the user can correct.
    expect(res.json.error).toContain(`${CONTAINER_KG}`);
    await expectUntouched();
  });

  it("rejects a grossly over-drawn amount (400) with nothing written", async () => {
    const res = await post("/ombor/flow/receive", {
      warehouseId: rawWarehouseId, lineId, materialName: MAT, kg: 9999,
    });
    expect(res.status).toBe(400);
    await expectUntouched();
  });

  it("stops a second hand-off that would overshoot the remaining balance", async () => {
    const ok = await post("/ombor/flow/receive", {
      warehouseId: rawWarehouseId, lineId, materialName: MAT, kg: 40,
    });
    expect(ok.status).toBe(200);

    // Only 10 kg left — asking for 11 must fail and change NOTHING further.
    const res = await post("/ombor/flow/receive", {
      warehouseId: rawWarehouseId, lineId, materialName: MAT, kg: 11,
    });
    expect(res.status).toBe(400);

    const inv = await inventoryRows();
    expect(Number(inv[0].weight_kg)).toBe(10);
    expect(await wipMovements()).toHaveLength(1); // only the first hand-off
    expect(await movements()).toHaveLength(1);
  });

  it("rejects a hand-off from an empty container (material never stocked)", async () => {
    const res = await post("/ombor/flow/receive", {
      warehouseId: rawWarehouseId, lineId, materialName: "Boshqa xom ashyo", kg: 1,
    });
    expect(res.status).toBe(400);
    // Reported availability is 0 — the row simply doesn't exist.
    expect(res.json.error).toContain("0");
    await expectUntouched();
  });

  // ── Invalid input: nothing may be written ───────────────────────────────────

  it("rejects kg = 0 (400) and writes nothing", async () => {
    const res = await post("/ombor/flow/receive", {
      warehouseId: rawWarehouseId, lineId, materialName: MAT, kg: 0,
    });
    expect(res.status).toBe(400);
    await expectUntouched();
  });

  it("rejects a negative kg (400) — cannot inflate the container by 'receiving' −kg", async () => {
    const res = await post("/ombor/flow/receive", {
      warehouseId: rawWarehouseId, lineId, materialName: MAT, kg: -20,
    });
    expect(res.status).toBe(400);
    await expectUntouched();
  });

  it("rejects a non-numeric kg (400) and writes nothing", async () => {
    const res = await post("/ombor/flow/receive", {
      warehouseId: rawWarehouseId, lineId, materialName: MAT, kg: "abc",
    });
    expect(res.status).toBe(400);
    await expectUntouched();
  });

  it("rejects a missing warehouseId (400) and writes nothing", async () => {
    const res = await post("/ombor/flow/receive", { lineId, materialName: MAT, kg: 10 });
    expect(res.status).toBe(400);
    await expectUntouched();
  });

  it("rejects a missing lineId (400) and writes nothing", async () => {
    const res = await post("/ombor/flow/receive", {
      warehouseId: rawWarehouseId, materialName: MAT, kg: 10,
    });
    expect(res.status).toBe(400);
    await expectUntouched();
  });

  it("rejects a missing materialName (400) and writes nothing", async () => {
    const res = await post("/ombor/flow/receive", { warehouseId: rawWarehouseId, lineId, kg: 10 });
    expect(res.status).toBe(400);
    await expectUntouched();
  });

  it("returns 404 for an unknown line and writes nothing", async () => {
    const res = await post("/ombor/flow/receive", {
      warehouseId: rawWarehouseId, lineId: 999999, materialName: MAT, kg: 10,
    });
    expect(res.status).toBe(404);
    await expectUntouched();
  });

  it("returns 404 for an unknown container id and writes nothing", async () => {
    const res = await post("/ombor/flow/receive", {
      warehouseId: 999999, lineId, materialName: MAT, kg: 10,
    });
    expect(res.status).toBe(404);
    await expectUntouched();
  });

  it("returns 404 for a non-raw (finished) container and writes nothing", async () => {
    const res = await post("/ombor/flow/receive", {
      warehouseId: finishedWarehouseId, lineId, materialName: MAT, kg: 10,
    });
    expect(res.status).toBe(404);
    await expectUntouched();
  });
});
