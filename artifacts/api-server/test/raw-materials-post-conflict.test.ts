import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// ── Isolation ──────────────────────────────────────────────────────────────
const SCHEMA = `topmart_rm_post_test_${process.pid}_${Date.now()}`;

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

const MAT = "Un test (raw)";

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function get(path: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}${path}`);
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function movements(): Promise<any[]> {
  const { rows } = await pool.query(
    `SELECT product, quantity, movement_type, note, created_by, product_type
     FROM stock_movements ORDER BY id`,
  );
  return rows;
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);

  await pool.query(`
    CREATE TABLE raw_materials (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      unit TEXT NOT NULL DEFAULT 'kg',
      unit_type TEXT NOT NULL DEFAULT 'kg',
      current_stock NUMERIC NOT NULL DEFAULT 0,
      minimum_stock NUMERIC NOT NULL DEFAULT 0,
      default_cost NUMERIC NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'UZS',
      active BOOLEAN NOT NULL DEFAULT TRUE,
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

  const { default: rawMaterialsRouter } = await import("../src/routes/raw-materials");
  const { default: omborRouter } = await import("../src/routes/ombor");
  const app = express();
  app.use(express.json());
  app.use(rawMaterialsRouter);
  app.use(omborRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await pool.query(`TRUNCATE stock_movements RESTART IDENTITY`);
  await pool.query(`DELETE FROM raw_materials`);
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }
});

async function seedMaterial(stock: number): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO raw_materials (name, unit, unit_type, current_stock) VALUES ($1,'kg','kg',$2) RETURNING id`,
    [MAT, stock],
  );
  // Ledger agrees with the seeded stock.
  if (stock !== 0) {
    await pool.query(
      `INSERT INTO stock_movements (product, quantity, movement_type, note, created_by, product_type)
       VALUES ($1,$2,'IN','seed','test','raw')`,
      [MAT, stock],
    );
  }
  return rows[0].id;
}

describe("POST /raw-materials — conflicting name must not silently reset stock", () => {
  it("creates a brand-new material with an opening IN movement", async () => {
    const res = await post("/raw-materials", { name: MAT, currentStock: 50 });
    expect(res.status).toBe(201);
    expect(res.json.currentStock).toBe(50);

    const mv = await movements();
    expect(mv).toHaveLength(1);
    expect(mv[0].movement_type).toBe("IN");
    expect(mv[0].product_type).toBe("raw");
    expect(mv[0].product).toBe(MAT);
    expect(Number(mv[0].quantity)).toBe(50);

    const rec = await get("/ombor/raw-reconcile");
    expect(rec.status).toBe(200);
    const row = rec.json.find((r: any) => r.id === res.json.id);
    expect(row.hasMismatch).toBe(false);
    expect(row.ledgerSum).toBe(50);
  });

  it("creates a zero-stock material with no movement", async () => {
    const res = await post("/raw-materials", { name: MAT });
    expect(res.status).toBe(201);
    expect(res.json.currentStock).toBe(0);
    expect(await movements()).toHaveLength(0);
  });

  it("re-POST with a higher stock writes an IN movement for the delta", async () => {
    const id = await seedMaterial(100);
    const res = await post("/raw-materials", { name: MAT, currentStock: 140 });
    expect(res.status).toBe(201);
    expect(res.json.id).toBe(id); // updated, not duplicated
    expect(res.json.currentStock).toBe(140);

    const mv = await movements();
    expect(mv).toHaveLength(2); // seed + delta
    expect(mv[1].movement_type).toBe("IN");
    expect(mv[1].product_type).toBe("raw");
    expect(mv[1].product).toBe(MAT);
    expect(Number(mv[1].quantity)).toBe(40);
    expect(mv[1].note).toContain("100");
    expect(mv[1].note).toContain("140");
  });

  it("re-POST with a lower stock writes an OUT movement for the delta", async () => {
    await seedMaterial(100);
    const res = await post("/raw-materials", { name: MAT, currentStock: 30 });
    expect(res.status).toBe(201);

    const mv = await movements();
    expect(mv).toHaveLength(2);
    expect(mv[1].movement_type).toBe("OUT");
    expect(Number(mv[1].quantity)).toBe(70);
  });

  it("after a conflicting POST, /ombor/raw-reconcile reports hasMismatch: false", async () => {
    const id = await seedMaterial(100);
    const res = await post("/raw-materials", { name: MAT, currentStock: 250 });
    expect(res.status).toBe(201);

    const rec = await get("/ombor/raw-reconcile");
    expect(rec.status).toBe(200);
    const row = rec.json.find((r: any) => r.id === id);
    expect(row).toBeTruthy();
    expect(row.hasMismatch).toBe(false);
    expect(row.currentStock).toBe(250);
    expect(row.ledgerSum).toBe(250);
  });

  it("re-POST with the SAME stock writes no movement and stays reconciled", async () => {
    const id = await seedMaterial(100);
    const res = await post("/raw-materials", { name: MAT, currentStock: 100, minimumStock: 9 });
    expect(res.status).toBe(201);
    expect(await movements()).toHaveLength(1); // seed only

    const { rows } = await pool.query(`SELECT minimum_stock FROM raw_materials WHERE id=$1`, [id]);
    expect(Number(rows[0].minimum_stock)).toBe(9); // other fields still updated

    const rec = await get("/ombor/raw-reconcile");
    const row = rec.json.find((r: any) => r.id === id);
    expect(row.hasMismatch).toBe(false);
  });

  it("re-POST with default stock (omitted → 0) logs an OUT for the whole balance, not a silent reset", async () => {
    await seedMaterial(80);
    const res = await post("/raw-materials", { name: MAT });
    expect(res.status).toBe(201);
    expect(res.json.currentStock).toBe(0);

    const mv = await movements();
    expect(mv).toHaveLength(2);
    expect(mv[1].movement_type).toBe("OUT");
    expect(Number(mv[1].quantity)).toBe(80);
  });

  it("rejects a negative currentStock (400) and leaves everything untouched", async () => {
    await seedMaterial(100);
    const res = await post("/raw-materials", { name: MAT, currentStock: -5 });
    expect(res.status).toBe(400);
    const { rows } = await pool.query(`SELECT current_stock FROM raw_materials WHERE name=$1`, [MAT]);
    expect(Number(rows[0].current_stock)).toBe(100);
    expect(await movements()).toHaveLength(1);
  });
});
