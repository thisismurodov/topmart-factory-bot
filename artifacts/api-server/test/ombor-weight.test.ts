import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// ── Isolation ──────────────────────────────────────────────────────────────
// Every query runs in a throwaway schema (search_path) so the test never
// touches real Ombor data. The search_path is injected via the libpq `options`
// connection parameter, applied to every new pool connection at connect time.
const SCHEMA = "topmart_kg_api_test";

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
const wh: Record<string, number> = {};

const KG = "Oq 5 kg test";
const DONA = "Tulpor test";

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function items(containerId: number): Promise<any[]> {
  const r = await fetch(`${apiUrl}/ombor/containers/${containerId}/items`);
  const body = await r.json();
  return body.items as any[];
}

async function containers(): Promise<any[]> {
  const r = await fetch(`${apiUrl}/ombor/containers`);
  return (await r.json()) as any[];
}

function weightOf(rows: any[], product: string): number | null {
  const row = rows.find((r) => r.product === product);
  return row ? row.weightKg : undefined as never;
}

function qtyOf(rows: any[], product: string): number {
  const row = rows.find((r) => r.product === product);
  return row ? row.quantity : 0;
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);

  // Minimal copies of the production tables the Ombor routes touch. These tables
  // are not in the Drizzle schema (created out-of-band in prod), so we define the
  // columns the queries actually use.
  await pool.query(`
    CREATE TABLE warehouses (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      location_type TEXT NOT NULL DEFAULT 'general',
      capacity_kg NUMERIC DEFAULT 20000
    );
    CREATE TABLE products (
      name TEXT PRIMARY KEY,
      unit_type TEXT NOT NULL DEFAULT 'dona',
      currency_type TEXT NOT NULL DEFAULT 'UZS',
      default_sale_price NUMERIC(12,2) NOT NULL DEFAULT 0
    );
    CREATE TABLE batches (
      id SERIAL PRIMARY KEY,
      batch_code TEXT NOT NULL DEFAULT '',
      worker TEXT NOT NULL DEFAULT '',
      product TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      weight_kg NUMERIC(10,3) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

  await pool.query(
    `INSERT INTO products (name, unit_type, currency_type, default_sale_price)
     VALUES ($1,'kg','UZS',1000), ($2,'dona','UZS',500)`,
    [KG, DONA],
  );

  // Batch ratio for KG = 250/100 = 2.5 kg/unit (used by finished-in WITHOUT an
  // explicit weight). Deliberately different from the stored inventory weight in
  // the transfer test so we can prove the stored value is used, not this ratio.
  await pool.query(
    `INSERT INTO batches (product, quantity, weight_kg) VALUES ($1, 100, 250)`,
    [KG],
  );

  for (const name of ["A", "B", "C", "D", "E"]) {
    const { rows } = await pool.query(
      `INSERT INTO warehouses (name, location_type) VALUES ($1,'container') RETURNING id`,
      [`C-${name}`],
    );
    wh[name] = rows[0].id;
  }

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
  await pool.query(`TRUNCATE inventory, stock_movements RESTART IDENTITY`);
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }
});

describe("Ombor container weight (kg) integrity", () => {
  it("finished-in with an explicit weight stores that exact weight", async () => {
    const res = await post("/ombor/finished-in", {
      warehouseId: wh.C, product: KG, qty: 10, weightKg: 33,
    });
    expect(res.status).toBe(200);

    const rows = await items(wh.C);
    expect(qtyOf(rows, KG)).toBe(10);
    expect(weightOf(rows, KG)).toBeCloseTo(33, 3);
  });

  it("finished-in without a weight derives kg from the batch ratio", async () => {
    // ratio 2.5 kg/unit × 8 = 20 kg
    const res = await post("/ombor/finished-in", {
      warehouseId: wh.D, product: KG, qty: 8,
    });
    expect(res.status).toBe(200);

    const rows = await items(wh.D);
    expect(qtyOf(rows, KG)).toBe(8);
    expect(weightOf(rows, KG)).toBeCloseTo(20, 3);
  });

  it("finished-in without a weight leaves dona products weightless", async () => {
    const res = await post("/ombor/finished-in", {
      warehouseId: wh.E, product: DONA, qty: 5,
    });
    expect(res.status).toBe(200);

    const rows = await items(wh.E);
    expect(qtyOf(rows, DONA)).toBe(5);
    // dona product → no stored weight → endpoint reports null
    expect(weightOf(rows, DONA)).toBeNull();
  });

  it("container aggregation values kg stock by its stored weight", async () => {
    // 33 kg stored × 1000 UZS/kg = 33000 UZS (price is per-kg for kg products).
    const res = await post("/ombor/finished-in", {
      warehouseId: wh.C, product: KG, qty: 10, weightKg: 33,
    });
    expect(res.status).toBe(200);

    const list = await containers();
    const c = list.find((x) => x.id === wh.C);
    expect(c).toBeTruthy();
    expect(c.totalQty).toBe(10);
    expect(c.totalValueUzs).toBeCloseTo(33000, 0);
  });

  it("partial transfer moves proportional STORED weight, remainder stays at source", async () => {
    // Seed source with a stored weight (3.0 kg/unit) that differs from the batch
    // ratio (2.5) so the assertions prove the stored value drives the math.
    await pool.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type)
       VALUES ($1,$2,100,300,'finished')`,
      [wh.A, KG],
    );

    const res = await post("/ombor/transfer", {
      fromId: wh.A, toId: wh.B, product: KG, qty: 40,
    });
    expect(res.status).toBe(200);

    // moveWeight = 300 * 40/100 = 120 → source 60 units / 180 kg, dest 40 / 120
    const src = await items(wh.A);
    const dst = await items(wh.B);
    expect(qtyOf(src, KG)).toBe(60);
    expect(weightOf(src, KG)).toBeCloseTo(180, 3);
    expect(qtyOf(dst, KG)).toBe(40);
    expect(weightOf(dst, KG)).toBeCloseTo(120, 3);

    // Reported source weight (180) must be the stored value, NOT the batch ratio
    // (2.5 × 60 = 150) — guards against regressing to the old ratio model.
    expect(weightOf(src, KG)).not.toBeCloseTo(150, 1);
  });
});
