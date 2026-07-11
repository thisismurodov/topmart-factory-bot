import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// ── Isolation ──────────────────────────────────────────────────────────────
// Every query runs in a throwaway schema (search_path) so the test never
// touches real Ombor data. The search_path is injected via the libpq `options`
// connection parameter, applied to every new pool connection at connect time.
const SCHEMA = `topmart_kg_flow_produce_test_${process.pid}_${Date.now()}`;

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
let rawWarehouseId: number;
let finishedWarehouseId: number;
let generalWarehouseId: number;
let lineId: number;

// Canonical product name as stored in `products` — requests may use any case.
const PRODUCT = "Makaron Test 5kg";
const UNIT_WEIGHT = 5; // products.weight — kg per unit, used for the kg fallback
const ZERO_WEIGHT_PRODUCT = "Etiketka Test (og'irliksiz)";

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
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

  // Minimal copies of the production tables /ombor/flow/produce touches.
  // produce writes ONE PRODUCE wip_movements row (-kg from the department's
  // WIP ledger) and upserts the finished container inventory (quantity +
  // weight_kg together) inside one transaction, plus one IN stock_movements
  // audit line. It must NEVER touch raw containers or raw_materials.
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
    CREATE TABLE products (
      id     SERIAL PRIMARY KEY,
      name   TEXT NOT NULL,
      weight NUMERIC NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE
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
       ('Tayyor mahsulot konteyneri', 'container', 'finished'),
       ('Umumiy ombor', 'general', 'finished')
     RETURNING id, purpose, location_type`,
  );
  rawWarehouseId = wh.rows.find((r) => r.purpose === "raw").id;
  finishedWarehouseId = wh.rows.find(
    (r) => r.purpose === "finished" && r.location_type === "container",
  ).id;
  generalWarehouseId = wh.rows.find((r) => r.location_type === "general").id;

  const line = await pool.query(
    `INSERT INTO production_lines (name) VALUES ('Makaron bo''limi (test)') RETURNING id`,
  );
  lineId = line.rows[0].id;

  await pool.query(
    `INSERT INTO products (name, weight) VALUES ($1,$2), ($3,0)`,
    [PRODUCT, UNIT_WEIGHT, ZERO_WEIGHT_PRODUCT],
  );

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
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }
});

// State that must be unchanged after any rejected request: NOTHING written.
async function expectNothingWritten(): Promise<void> {
  expect(await inventoryRows()).toHaveLength(0);
  expect(await wipMovements()).toHaveLength(0);
  expect(await movements()).toHaveLength(0);
}

describe("POST /ombor/flow/produce — finished-goods output integrity", () => {
  it("writes exactly one PRODUCE wip row AND increments finished inventory in lockstep (+ one IN log)", async () => {
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, product: PRODUCT, quantity: 10, kg: 48,
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);

    // Exactly ONE PRODUCE row for 48 kg — the department's WIP debit.
    const wip = await wipMovements();
    expect(wip).toHaveLength(1);
    expect(wip[0].movement_type).toBe("PRODUCE");
    expect(wip[0].line_id).toBe(lineId);
    expect(wip[0].product).toBe(PRODUCT);
    expect(Number(wip[0].weight_kg)).toBe(48);

    // Finished container: quantity AND weight_kg move together.
    const inv = await inventoryRows();
    expect(inv).toHaveLength(1);
    expect(inv[0].warehouse_id).toBe(finishedWarehouseId);
    expect(inv[0].product).toBe(PRODUCT);
    expect(Number(inv[0].quantity)).toBe(10);
    expect(Number(inv[0].weight_kg)).toBe(48);
    expect(inv[0].product_type).toBe("finished");

    // Audit trail: exactly one IN/finished stock_movement into the container.
    const mv = await movements();
    expect(mv).toHaveLength(1);
    expect(mv[0].movement_type).toBe("IN");
    expect(mv[0].product_type).toBe("finished");
    expect(mv[0].product).toBe(PRODUCT);
    expect(Number(mv[0].quantity)).toBe(10);
    expect(mv[0].to_warehouse_id).toBe(finishedWarehouseId);
    expect(mv[0].from_warehouse_id).toBeNull();
  });

  it("accumulates consecutive produces into one inventory row (upsert, no duplicates)", async () => {
    await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, product: PRODUCT, quantity: 10, kg: 48,
    });
    await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, product: PRODUCT, quantity: 4, kg: 20.5,
    });

    const inv = await inventoryRows();
    expect(inv).toHaveLength(1); // upsert — never a second row for the same product
    expect(Number(inv[0].quantity)).toBe(14);
    expect(Number(inv[0].weight_kg)).toBe(68.5);

    // WIP = SUM(RECEIVE) − SUM(PRODUCE) → two PRODUCE rows totalling 68.5 kg.
    const wip = await wipMovements();
    expect(wip).toHaveLength(2);
    expect(wip.map((w) => Number(w.weight_kg))).toEqual([48, 20.5]);
    expect(wip.every((w) => w.movement_type === "PRODUCE")).toBe(true);

    // One IN log per produce — never double-logged.
    expect(await movements()).toHaveLength(2);
  });

  it("records the custom note on the wip_movements row", async () => {
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, product: PRODUCT, quantity: 2, kg: 10,
      note: "Kechki smena",
    });
    expect(res.status).toBe(200);
    const wip = await wipMovements();
    expect(wip[0].note).toBe("Kechki smena");
  });

  // ── kg fallback: produceKg = quantity × products.weight ────────────────────

  it("falls back to quantity × products.weight when kg is omitted", async () => {
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, product: PRODUCT, quantity: 10,
    });
    expect(res.status).toBe(200);

    const wip = await wipMovements();
    expect(wip).toHaveLength(1);
    expect(Number(wip[0].weight_kg)).toBe(10 * UNIT_WEIGHT); // 50

    const inv = await inventoryRows();
    expect(Number(inv[0].quantity)).toBe(10);
    expect(Number(inv[0].weight_kg)).toBe(10 * UNIT_WEIGHT);
  });

  it("treats kg = 0 the same as omitted (fallback to quantity × weight)", async () => {
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, product: PRODUCT, quantity: 3, kg: 0,
    });
    expect(res.status).toBe(200);
    const wip = await wipMovements();
    expect(Number(wip[0].weight_kg)).toBe(3 * UNIT_WEIGHT); // 15
    const inv = await inventoryRows();
    expect(Number(inv[0].weight_kg)).toBe(3 * UNIT_WEIGHT);
  });

  it("lets an explicit kg override the quantity × weight fallback", async () => {
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, product: PRODUCT, quantity: 10, kg: 47.3,
    });
    expect(res.status).toBe(200);
    const wip = await wipMovements();
    expect(Number(wip[0].weight_kg)).toBe(47.3); // NOT 50
    const inv = await inventoryRows();
    expect(Number(inv[0].weight_kg)).toBe(47.3);
  });

  // ── Canonical product name (case-insensitive match) ─────────────────────────

  it("stores the canonical product name everywhere on a case-insensitive match", async () => {
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId,
      product: PRODUCT.toUpperCase(), quantity: 2, kg: 9,
    });
    expect(res.status).toBe(200);

    const wip = await wipMovements();
    expect(wip[0].product).toBe(PRODUCT);
    const inv = await inventoryRows();
    expect(inv[0].product).toBe(PRODUCT);
    const mv = await movements();
    expect(mv[0].product).toBe(PRODUCT);
  });

  it("merges differently-cased requests into ONE inventory row (no case-split stock)", async () => {
    await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, product: PRODUCT.toLowerCase(), quantity: 1, kg: 5,
    });
    await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, product: PRODUCT.toUpperCase(), quantity: 1, kg: 5,
    });
    const inv = await inventoryRows();
    expect(inv).toHaveLength(1);
    expect(inv[0].product).toBe(PRODUCT);
    expect(Number(inv[0].quantity)).toBe(2);
    expect(Number(inv[0].weight_kg)).toBe(10);
  });

  // ── Invalid input: nothing may be written ───────────────────────────────────

  it("rejects quantity = 0 (400) and writes nothing", async () => {
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, product: PRODUCT, quantity: 0, kg: 10,
    });
    expect(res.status).toBe(400);
    await expectNothingWritten();
  });

  it("rejects a negative quantity (400) — cannot shrink stock via 'producing' −n", async () => {
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, product: PRODUCT, quantity: -5, kg: 10,
    });
    expect(res.status).toBe(400);
    await expectNothingWritten();
  });

  it("rejects a non-numeric quantity (400) and writes nothing", async () => {
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, product: PRODUCT, quantity: "abc", kg: 10,
    });
    expect(res.status).toBe(400);
    await expectNothingWritten();
  });

  it("rejects a missing quantity (400) and writes nothing", async () => {
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, product: PRODUCT, kg: 10,
    });
    expect(res.status).toBe(400);
    await expectNothingWritten();
  });

  it("rejects a negative kg (400) — cannot credit WIP back via 'producing' −kg", async () => {
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, product: PRODUCT, quantity: 5, kg: -10,
    });
    expect(res.status).toBe(400);
    await expectNothingWritten();
  });

  it("rejects a non-numeric kg (400) and writes nothing", async () => {
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, product: PRODUCT, quantity: 5, kg: "abc",
    });
    expect(res.status).toBe(400);
    await expectNothingWritten();
  });

  it("rejects a missing lineId (400) and writes nothing", async () => {
    const res = await post("/ombor/flow/produce", {
      warehouseId: finishedWarehouseId, product: PRODUCT, quantity: 5, kg: 10,
    });
    expect(res.status).toBe(400);
    await expectNothingWritten();
  });

  it("rejects a missing warehouseId (400) and writes nothing", async () => {
    const res = await post("/ombor/flow/produce", {
      lineId, product: PRODUCT, quantity: 5, kg: 10,
    });
    expect(res.status).toBe(400);
    await expectNothingWritten();
  });

  it("rejects a missing product (400) and writes nothing", async () => {
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, quantity: 5, kg: 10,
    });
    expect(res.status).toBe(400);
    await expectNothingWritten();
  });

  it("returns 404 for an unknown line and writes nothing", async () => {
    const res = await post("/ombor/flow/produce", {
      lineId: 999999, warehouseId: finishedWarehouseId, product: PRODUCT, quantity: 5, kg: 10,
    });
    expect(res.status).toBe(404);
    await expectNothingWritten();
  });

  it("returns 404 for an unknown container id and writes nothing", async () => {
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: 999999, product: PRODUCT, quantity: 5, kg: 10,
    });
    expect(res.status).toBe(404);
    await expectNothingWritten();
  });

  it("returns 404 for a raw (non-finished) container and writes nothing", async () => {
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: rawWarehouseId, product: PRODUCT, quantity: 5, kg: 10,
    });
    expect(res.status).toBe(404);
    await expectNothingWritten();
  });

  it("returns 404 for a finished but NON-container warehouse and writes nothing", async () => {
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: generalWarehouseId, product: PRODUCT, quantity: 5, kg: 10,
    });
    expect(res.status).toBe(404);
    await expectNothingWritten();
  });

  it("rejects an unknown product name (400) and writes nothing", async () => {
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, product: "Yo'q mahsulot", quantity: 5, kg: 10,
    });
    expect(res.status).toBe(400);
    await expectNothingWritten();
  });
});
