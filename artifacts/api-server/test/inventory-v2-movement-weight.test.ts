import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// ── Isolation ──────────────────────────────────────────────────────────────
const SCHEMA = `topmart_invv2_wt_test_${process.pid}_${Date.now()}`;

const baseUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL must be set to run these tests");
{
  const u = new URL(baseUrl);
  u.searchParams.set("options", `-c search_path=${SCHEMA}`);
  delete process.env.RAILWAY_DATABASE_URL;
  process.env.DATABASE_URL = u.toString();
}

let pool: Pool;
let server: Server;
let apiUrl: string;
let whA: number;
let whB: number;

async function postMovement(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}/inventory/movement`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function invRow(warehouseId: number, product: string) {
  const { rows } = await pool.query(
    `SELECT quantity::float AS quantity, weight_kg::float AS weight_kg, product_type
     FROM inventory WHERE warehouse_id=$1 AND product=$2`,
    [warehouseId, product],
  );
  return rows[0] ?? null;
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await pool.query(`
    CREATE TABLE warehouses (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      location_type TEXT NOT NULL DEFAULT 'container',
      capacity_kg NUMERIC NOT NULL DEFAULT 20000,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE inventory (
      id SERIAL PRIMARY KEY,
      warehouse_id INTEGER NOT NULL,
      product TEXT NOT NULL,
      quantity NUMERIC NOT NULL DEFAULT 0,
      weight_kg NUMERIC NOT NULL DEFAULT 0,
      product_type TEXT NOT NULL DEFAULT 'finished',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (warehouse_id, product)
    );
    CREATE TABLE products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      unit_type TEXT NOT NULL DEFAULT 'dona'
    );
    CREATE TABLE batches (
      id SERIAL PRIMARY KEY,
      product TEXT NOT NULL,
      quantity NUMERIC NOT NULL DEFAULT 0,
      weight_kg NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE stock_movements (
      id SERIAL PRIMARY KEY,
      product TEXT NOT NULL,
      quantity NUMERIC NOT NULL,
      movement_type TEXT NOT NULL,
      from_warehouse_id INTEGER,
      to_warehouse_id INTEGER,
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      product_type TEXT NOT NULL DEFAULT 'finished',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const { rows } = await pool.query(
    `INSERT INTO warehouses (name) VALUES ('K-A'),('K-B') RETURNING id`,
  );
  whA = rows[0].id;
  whB = rows[1].id;

  // kg-product with batch history: 10 kg per unit (100 units / 1000 kg).
  await pool.query(`INSERT INTO products (name, unit_type) VALUES ('KgMahsulot','kg'), ('DonaMahsulot','dona')`);
  await pool.query(`INSERT INTO batches (product, quantity, weight_kg) VALUES ('KgMahsulot', 100, 1000)`);

  const { default: inventoryV2Router } = await import("../src/routes/inventory-v2");
  const app = express();
  app.use(express.json());
  app.use(inventoryV2Router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await pool.query(`TRUNCATE stock_movements RESTART IDENTITY`);
  await pool.query(`TRUNCATE inventory RESTART IDENTITY`);
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
describe("POST /inventory/movement — weight_kg sync", () => {
  it("IN derives weight from batch ratio for kg-products", async () => {
    const { status } = await postMovement({
      product: "KgMahsulot", quantity: 5, movement_type: "IN", to_warehouse_id: whA,
    });
    expect(status).toBe(200);
    const row = await invRow(whA, "KgMahsulot");
    expect(row.quantity).toBe(5);
    expect(row.weight_kg).toBeCloseTo(50); // 10 kg/unit × 5
  });

  it("IN leaves weight at 0 for dona-products", async () => {
    await postMovement({
      product: "DonaMahsulot", quantity: 7, movement_type: "IN", to_warehouse_id: whA,
    });
    const row = await invRow(whA, "DonaMahsulot");
    expect(row.quantity).toBe(7);
    expect(row.weight_kg).toBe(0);
  });

  it("OUT removes weight proportionally to quantity", async () => {
    await pool.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type)
       VALUES ($1,'KgMahsulot',10,80,'finished')`,
      [whA],
    );
    const { status } = await postMovement({
      product: "KgMahsulot", quantity: 4, movement_type: "OUT", from_warehouse_id: whA,
    });
    expect(status).toBe(200);
    const row = await invRow(whA, "KgMahsulot");
    expect(row.quantity).toBe(6);
    expect(row.weight_kg).toBeCloseTo(48); // 80 × (1 − 4/10)
  });

  it("TRANSFER moves proportional weight and product_type to the destination", async () => {
    await pool.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type)
       VALUES ($1,'KgMahsulot',10,80,'wip')`,
      [whA],
    );
    const { status } = await postMovement({
      product: "KgMahsulot", quantity: 5, movement_type: "TRANSFER",
      from_warehouse_id: whA, to_warehouse_id: whB,
    });
    expect(status).toBe(200);
    const src = await invRow(whA, "KgMahsulot");
    const dst = await invRow(whB, "KgMahsulot");
    expect(src.quantity).toBe(5);
    expect(src.weight_kg).toBeCloseTo(40);
    expect(dst.quantity).toBe(5);
    expect(dst.weight_kg).toBeCloseTo(40);
    expect(dst.product_type).toBe("wip");
  });

  it("OUT of more than available floors both quantity and weight at 0", async () => {
    await pool.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type)
       VALUES ($1,'KgMahsulot',3,30,'finished')`,
      [whA],
    );
    await postMovement({
      product: "KgMahsulot", quantity: 99, movement_type: "OUT", from_warehouse_id: whA,
    });
    const row = await invRow(whA, "KgMahsulot");
    expect(row.quantity).toBe(0);
    expect(row.weight_kg).toBe(0);
  });
});
