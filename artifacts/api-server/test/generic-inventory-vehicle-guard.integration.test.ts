import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import {
  childDbUrl,
  requireVehicleTestAdminUrl,
  sslFor,
} from "./helpers/vehicle-test-db";

const { Client } = pg;
const adminUrl = requireVehicleTestAdminUrl();
const ssl = sslFor(adminUrl);
const TMP_DB = `topmart_generic_vehicle_guard_${process.pid}_${Date.now()}`;
const tmpUrl = () => childDbUrl(adminUrl, TMP_DB);

delete process.env.RAILWAY_DATABASE_URL;
process.env.DATABASE_URL = tmpUrl();

let pool: pg.Pool;
let db: pg.Client;
let server: Server;
let apiUrl = "";
let generalA = 0;
let generalB = 0;
let vehicle = 0;

async function dropDatabase(): Promise<void> {
  const admin = new Client({ connectionString: adminUrl, ssl });
  await admin.connect();
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname=$1 AND pid <> pg_backend_pid()`,
    [TMP_DB],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${TMP_DB}`);
  await admin.end();
}

async function post(path: string, body: unknown) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
}

async function state(): Promise<string> {
  const [inventory, movements, flows] = await Promise.all([
    db.query(`SELECT warehouse_id, product, quantity, weight_kg FROM inventory ORDER BY 1,2`),
    db.query(`SELECT * FROM stock_movements ORDER BY id`),
    db.query(`SELECT * FROM material_flow_events ORDER BY id`),
  ]);
  return JSON.stringify([inventory.rows, movements.rows, flows.rows]);
}

async function stock(warehouseId: number, product: string) {
  const result = await db.query(
    `SELECT quantity::float8 AS quantity, weight_kg::float8 AS weight_kg
       FROM inventory WHERE warehouse_id=$1 AND product=$2`,
    [warehouseId, product],
  );
  return result.rows[0] ?? null;
}

beforeAll(async () => {
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(adminUrl).hostname)) {
    throw new Error("VEHICLE_TEST_DATABASE_ADMIN_URL must use a loopback host");
  }
  await dropDatabase();
  const admin = new Client({ connectionString: adminUrl, ssl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${TMP_DB}`);
  await admin.end();

  db = new Client({ connectionString: tmpUrl(), ssl });
  await db.connect();
  await db.query(`
    CREATE TABLE warehouses (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, active BOOLEAN NOT NULL DEFAULT TRUE,
      location_type TEXT NOT NULL DEFAULT 'general', capacity_kg NUMERIC DEFAULT 20000,
      purpose TEXT NOT NULL DEFAULT 'finished'
    );
    CREATE TABLE products (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, sku TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE, unit_type TEXT NOT NULL DEFAULT 'dona',
      default_sale_price NUMERIC NOT NULL DEFAULT 10, currency_type TEXT NOT NULL DEFAULT 'UZS',
      minimum_stock NUMERIC NOT NULL DEFAULT 0, in_production BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE product_price_tiers (
      id SERIAL PRIMARY KEY, product_id INTEGER NOT NULL, min_quantity NUMERIC NOT NULL,
      max_quantity NUMERIC NOT NULL, price NUMERIC NOT NULL, currency TEXT NOT NULL
    );
    CREATE TABLE batches (
      id SERIAL PRIMARY KEY, product TEXT NOT NULL, quantity NUMERIC NOT NULL DEFAULT 0,
      weight_kg NUMERIC NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE inventory (
      id SERIAL PRIMARY KEY, warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      product TEXT NOT NULL, quantity NUMERIC NOT NULL DEFAULT 0,
      weight_kg NUMERIC NOT NULL DEFAULT 0, product_type TEXT NOT NULL DEFAULT 'finished',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(warehouse_id, product)
    );
    CREATE TABLE stock_movements (
      id SERIAL PRIMARY KEY, product TEXT NOT NULL, quantity NUMERIC NOT NULL,
      movement_type TEXT NOT NULL, from_warehouse_id INTEGER, to_warehouse_id INTEGER,
      note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '',
      product_type TEXT NOT NULL DEFAULT 'finished', weight_kg NUMERIC,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE material_flow_events (
      id SERIAL PRIMARY KEY, event_type TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE customers (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, deleted_at TIMESTAMPTZ
    );
    CREATE TABLE sales (
      id SERIAL PRIMARY KEY, customer_id INTEGER, customer_name TEXT, status TEXT, note TEXT,
      total_amount NUMERIC NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'UZS',
      payment_type TEXT NOT NULL DEFAULT 'naqd', paid_amount NUMERIC NOT NULL DEFAULT 0,
      debt_amount NUMERIC NOT NULL DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE sale_items (
      id SERIAL PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_name TEXT, sale_type TEXT, quantity NUMERIC, unit_price NUMERIC,
      currency TEXT, line_total NUMERIC
    );
    CREATE TABLE sale_payments (
      id SERIAL PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      amount NUMERIC NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE sale_events (
      id SERIAL PRIMARY KEY, sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', amount NUMERIC,
      currency TEXT, user_id INTEGER, created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  const warehouses = await db.query(
    `INSERT INTO warehouses(name, location_type) VALUES
       ('General A','general'),('General B','container'),('Vehicle','vehicle') RETURNING id`,
  );
  [generalA, generalB, vehicle] = warehouses.rows.map((row) => Number(row.id));
  await db.query(
    `INSERT INTO products(name, unit_type) VALUES ('Qty Product','dona'),('Kg Product','kg');
     INSERT INTO batches(product, quantity, weight_kg) VALUES ('Kg Product',10,20);
     INSERT INTO customers(name) VALUES ('Test Customer')`,
  );

  const workspaceDb = await import("@workspace/db");
  pool = workspaceDb.pool as unknown as pg.Pool;
  const [{ default: ombor }, { createInventoryV2Router }, { default: sales }] =
    await Promise.all([
      import("../src/routes/ombor"),
      import("../src/routes/inventory-v2"),
      import("../src/routes/sales"),
    ]);
  const app = express();
  app.use(express.json());
  app.use(ombor);
  app.use(createInventoryV2Router(pool));
  app.use(sales);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

beforeEach(async () => {
  await db.query(`
    TRUNCATE sale_events, sale_payments, sale_items, sales, stock_movements,
      material_flow_events, inventory RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (pool) await pool.end();
  if (db) await db.end();
  await dropDatabase();
}, 30_000);

describe("generic Ombor vehicle warehouse guard", () => {
  it("transfer rejects vehicle source and vehicle destination/new SKU with no side effects", async () => {
    await db.query(
      `INSERT INTO inventory(warehouse_id,product,quantity,weight_kg) VALUES
       ($1,'Qty Product',5,0),($2,'Qty Product',5,0)`,
      [vehicle, generalA],
    );
    for (const body of [
      { fromId: vehicle, toId: generalA, product: "Qty Product", qty: 1 },
      { fromId: generalA, toId: vehicle, product: "Qty Product", qty: 1 },
      { fromId: generalA, toId: vehicle, product: "Absent Destination SKU", qty: 1 },
    ]) {
      if (body.product === "Absent Destination SKU") {
        await db.query(
          `INSERT INTO inventory(warehouse_id,product,quantity) VALUES ($1,$2,1)`,
          [generalA, body.product],
        );
      }
      const before = await state();
      expect((await post("/ombor/transfer", body)).status).toBe(400);
      expect(await state()).toBe(before);
    }
  });

  it("finished-in and adjust reject vehicle zero-to-nonzero/absolute writes", async () => {
    await db.query(
      `INSERT INTO inventory(warehouse_id,product,quantity,weight_kg) VALUES ($1,'Qty Product',0,0)`,
      [vehicle],
    );
    for (const [path, body] of [
      ["/ombor/finished-in", { warehouseId: vehicle, product: "Qty Product", qty: 3 }],
      ["/ombor/adjust", { warehouseId: vehicle, product: "Qty Product", qty: 9 }],
    ] as const) {
      const before = await state();
      expect((await post(path, body)).status).toBe(400);
      expect(await state()).toBe(before);
    }
  });
});

describe("generic inventory movement vehicle guard", () => {
  it("rejects IN/OUT/TRANSFER vehicle IDs with no writes", async () => {
    await db.query(
      `INSERT INTO inventory(warehouse_id,product,quantity,weight_kg) VALUES
       ($1,'Qty Product',10,0),($2,'Qty Product',10,0)`,
      [vehicle, generalA],
    );
    const attempts = [
      { product: "New SKU", quantity: 1, movement_type: "IN", to_warehouse_id: vehicle },
      { product: "Qty Product", quantity: 1, movement_type: "OUT", from_warehouse_id: vehicle },
      { product: "Qty Product", quantity: 1, movement_type: "TRANSFER", from_warehouse_id: generalA, to_warehouse_id: vehicle },
      { product: "Qty Product", quantity: 1, movement_type: "TRANSFER", from_warehouse_id: vehicle, to_warehouse_id: generalA },
    ];
    for (const body of attempts) {
      const before = await state();
      expect((await post("/inventory/movement", body)).status).toBe(400);
      expect(await state()).toBe(before);
    }
  });
});

describe("sales never selects or decrements vehicle stock", () => {
  async function sell(productName: string, quantity: number) {
    return post("/sales", {
      customerId: 1,
      paymentType: "naqd",
      items: [{ productName, quantity }],
    });
  }

  it("quantity sale consumes general stock/fallback only when both exist", async () => {
    await db.query(
      `INSERT INTO inventory(warehouse_id,product,quantity) VALUES
       ($1,'Qty Product',3),($2,'Qty Product',100)`,
      [generalA, vehicle],
    );
    expect((await sell("Qty Product", 5)).status).toBe(201);
    expect((await stock(vehicle, "Qty Product")).quantity).toBe(100);
    const movementWarehouses = await db.query(
      `SELECT DISTINCT from_warehouse_id FROM stock_movements`,
    );
    expect(movementWarehouses.rows.every((row) => Number(row.from_warehouse_id) !== vehicle)).toBe(true);
  });

  it("vehicle-only quantity stock is untouched and fallback is nonvehicle", async () => {
    await db.query(
      `INSERT INTO inventory(warehouse_id,product,quantity) VALUES ($1,'Qty Product',100)`,
      [vehicle],
    );
    expect((await sell("Qty Product", 2)).status).toBe(201);
    expect((await stock(vehicle, "Qty Product")).quantity).toBe(100);
    expect((await stock(generalA, "Qty Product")).quantity).toBe(-2);
  });

  it("kg sale consumes general weight only and never vehicle weight", async () => {
    await db.query(
      `INSERT INTO inventory(warehouse_id,product,quantity,weight_kg) VALUES
       ($1,'Kg Product',0,2),($2,'Kg Product',0,100)`,
      [generalB, vehicle],
    );
    expect((await sell("Kg Product", 3)).status).toBe(201);
    expect((await stock(vehicle, "Kg Product")).weight_kg).toBe(100);
    const movements = await db.query(`SELECT from_warehouse_id FROM stock_movements`);
    expect(movements.rows.every((row) => Number(row.from_warehouse_id) !== vehicle)).toBe(true);
  });

  it("vehicle-only kg stock is untouched and kg fallback is nonvehicle", async () => {
    await db.query(
      `INSERT INTO inventory(warehouse_id,product,quantity,weight_kg) VALUES ($1,'Kg Product',0,100)`,
      [vehicle],
    );
    expect((await sell("Kg Product", 2)).status).toBe(201);
    expect((await stock(vehicle, "Kg Product")).weight_kg).toBe(100);
    expect((await stock(generalA, "Kg Product")).weight_kg).toBe(-2);
  });
});