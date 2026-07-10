import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// ── Isolation ──────────────────────────────────────────────────────────────
// Every query runs in a throwaway schema (search_path) so the test never
// touches real Ombor data. The search_path is injected via the libpq `options`
// connection parameter, applied to every new pool connection at connect time.
const SCHEMA = "topmart_kg_flow_raw_in_test";

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

const MAT = "Un test (flow raw-in)";
const UNIT = "kg";
const START_STOCK = 100;
const START_COST = 5000;
const START_CURRENCY = "UZS";

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

  // Minimal copies of the production tables /ombor/flow/raw-in touches. These
  // tables are not in the Drizzle schema (created out-of-band in prod), so we
  // mirror only the columns the route actually uses. flow/raw-in updates
  // raw_materials AND inventory in lockstep inside one transaction, then logs a
  // single stock_movements row. wip_movements must stay untouched by raw-in.
  await pool.query(`
    CREATE TABLE warehouses (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      location_type TEXT NOT NULL DEFAULT 'general',
      purpose       TEXT NOT NULL DEFAULT 'finished'
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

  const { rows } = await pool.query(
    `INSERT INTO raw_materials (name, unit, current_stock, default_cost, currency)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [MAT, UNIT, START_STOCK, START_COST, START_CURRENCY],
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
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }
});

describe("POST /ombor/flow/raw-in — two-table intake integrity", () => {
  it("adds kg to raw_materials.current_stock AND the container inventory in lockstep", async () => {
    const res = await post("/ombor/flow/raw-in", {
      warehouseId: rawWarehouseId, materialName: MAT, kg: 40,
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);

    // Global raw stock: 100 + 40, never overwritten.
    expect(await materialStock(materialId)).toBe(140);

    // Container inventory: a single 'raw' row with quantity == weight_kg == 40.
    const inv = await inventoryRows();
    expect(inv).toHaveLength(1);
    expect(inv[0].warehouse_id).toBe(rawWarehouseId);
    expect(inv[0].product).toBe(MAT);
    expect(Number(inv[0].quantity)).toBe(40);
    expect(Number(inv[0].weight_kg)).toBe(40);
    expect(inv[0].product_type).toBe("raw");
  });

  it("writes EXACTLY one IN/raw stock_movement and no wip_movements (no double entry)", async () => {
    const res = await post("/ombor/flow/raw-in", {
      warehouseId: rawWarehouseId, materialName: MAT, kg: 25,
    });
    expect(res.status).toBe(200);

    const mv = await movements();
    expect(mv).toHaveLength(1);
    expect(mv[0].movement_type).toBe("IN");
    expect(mv[0].product_type).toBe("raw");
    expect(mv[0].product).toBe(MAT);
    expect(Number(mv[0].quantity)).toBe(25);
    expect(mv[0].to_warehouse_id).toBe(rawWarehouseId);
    expect(mv[0].from_warehouse_id).toBeNull();

    // raw-in is the intake step only — it must NOT touch the WIP ledger.
    expect(await wipMovements()).toHaveLength(0);
  });

  it("adds a fractional kg precisely to both tables", async () => {
    const res = await post("/ombor/flow/raw-in", {
      warehouseId: rawWarehouseId, materialName: MAT, kg: 2.5,
    });
    expect(res.status).toBe(200);
    expect(await materialStock(materialId)).toBe(102.5);
    const inv = await inventoryRows();
    expect(Number(inv[0].weight_kg)).toBe(2.5);
    expect(await movements()).toHaveLength(1);
  });

  it("accumulates consecutive intakes on the same container row (ON CONFLICT adds)", async () => {
    await post("/ombor/flow/raw-in", { warehouseId: rawWarehouseId, materialName: MAT, kg: 10 });
    await post("/ombor/flow/raw-in", { warehouseId: rawWarehouseId, materialName: MAT, kg: 15 });

    // Global stock: 100 + 10 + 15.
    expect(await materialStock(materialId)).toBe(125);

    // Still a single container row holding the running total, in lockstep.
    const inv = await inventoryRows();
    expect(inv).toHaveLength(1);
    expect(Number(inv[0].quantity)).toBe(25);
    expect(Number(inv[0].weight_kg)).toBe(25);

    // One movement per intake — no missing or duplicated ledger rows.
    const mv = await movements();
    expect(mv).toHaveLength(2);
    expect(mv.map((m) => Number(m.quantity))).toEqual([10, 15]);
  });

  it("resolves the canonical material name case-insensitively and stores it everywhere", async () => {
    const res = await post("/ombor/flow/raw-in", {
      warehouseId: rawWarehouseId, materialName: MAT.toUpperCase(), kg: 20,
    });
    expect(res.status).toBe(200);

    // Stock still updated once (matched the single seeded row).
    expect(await materialStock(materialId)).toBe(120);

    // Inventory + movement store the canonical (seeded) name, not the caller's
    // casing — otherwise the container row would drift from global stock.
    const inv = await inventoryRows();
    expect(inv).toHaveLength(1);
    expect(inv[0].product).toBe(MAT);
    const mv = await movements();
    expect(mv[0].product).toBe(MAT);
  });

  it("records the incoming note on the movement", async () => {
    const res = await post("/ombor/flow/raw-in", {
      warehouseId: rawWarehouseId, materialName: MAT, kg: 15, note: "Yetkazib beruvchi X",
    });
    expect(res.status).toBe(200);
    const mv = await movements();
    expect(mv).toHaveLength(1);
    expect(mv[0].note).toBe("Yetkazib beruvchi X");
  });

  // ── Rejection paths: BOTH tables must be left untouched ────────────────────

  it("rejects kg <= 0 (400) and leaves raw_materials + inventory + log untouched", async () => {
    const res = await post("/ombor/flow/raw-in", {
      warehouseId: rawWarehouseId, materialName: MAT, kg: 0,
    });
    expect(res.status).toBe(400);
    expect(await materialStock(materialId)).toBe(START_STOCK);
    expect(await inventoryRows()).toHaveLength(0);
    expect(await movements()).toHaveLength(0);
  });

  it("rejects a negative kg (400) and writes nothing", async () => {
    const res = await post("/ombor/flow/raw-in", {
      warehouseId: rawWarehouseId, materialName: MAT, kg: -20,
    });
    expect(res.status).toBe(400);
    expect(await materialStock(materialId)).toBe(START_STOCK);
    expect(await inventoryRows()).toHaveLength(0);
    expect(await movements()).toHaveLength(0);
  });

  it("rejects a non-numeric kg (400) so neither table can be corrupted", async () => {
    const res = await post("/ombor/flow/raw-in", {
      warehouseId: rawWarehouseId, materialName: MAT, kg: "abc",
    });
    expect(res.status).toBe(400);
    expect(await materialStock(materialId)).toBe(START_STOCK);
    expect(await inventoryRows()).toHaveLength(0);
    expect(await movements()).toHaveLength(0);
  });

  it("rejects a missing warehouseId (400) and writes nothing", async () => {
    const res = await post("/ombor/flow/raw-in", { materialName: MAT, kg: 10 });
    expect(res.status).toBe(400);
    expect(await materialStock(materialId)).toBe(START_STOCK);
    expect(await inventoryRows()).toHaveLength(0);
    expect(await movements()).toHaveLength(0);
  });

  it("rejects a missing materialName (400) and writes nothing", async () => {
    const res = await post("/ombor/flow/raw-in", { warehouseId: rawWarehouseId, kg: 10 });
    expect(res.status).toBe(400);
    expect(await materialStock(materialId)).toBe(START_STOCK);
    expect(await inventoryRows()).toHaveLength(0);
    expect(await movements()).toHaveLength(0);
  });

  it("returns 404 for a non-raw container and leaves both tables untouched", async () => {
    const res = await post("/ombor/flow/raw-in", {
      warehouseId: finishedWarehouseId, materialName: MAT, kg: 10,
    });
    expect(res.status).toBe(404);
    expect(await materialStock(materialId)).toBe(START_STOCK);
    expect(await inventoryRows()).toHaveLength(0);
    expect(await movements()).toHaveLength(0);
  });

  it("returns 404 for an unknown container id and writes nothing", async () => {
    const res = await post("/ombor/flow/raw-in", {
      warehouseId: 999999, materialName: MAT, kg: 10,
    });
    expect(res.status).toBe(404);
    expect(await materialStock(materialId)).toBe(START_STOCK);
    expect(await inventoryRows()).toHaveLength(0);
    expect(await movements()).toHaveLength(0);
  });

  it("rejects a material name that matches no raw_material (400) and writes nothing", async () => {
    const res = await post("/ombor/flow/raw-in", {
      warehouseId: rawWarehouseId, materialName: "Nomavjud xom ashyo", kg: 10,
    });
    expect(res.status).toBe(400);
    // The seeded material is untouched and no container/ledger rows appear —
    // proves the unknown-name guard rolls the whole transaction back.
    expect(await materialStock(materialId)).toBe(START_STOCK);
    expect(await inventoryRows()).toHaveLength(0);
    expect(await movements()).toHaveLength(0);
  });
});
