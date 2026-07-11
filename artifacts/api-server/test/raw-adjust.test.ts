import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// ── Isolation ──────────────────────────────────────────────────────────────
// Every query runs in a throwaway schema (search_path) so the test never
// touches real Ombor data. The search_path is injected via the libpq `options`
// connection parameter, applied to every new pool connection at connect time.
const SCHEMA = `topmart_kg_raw_adjust_test_${process.pid}_${Date.now()}`;

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

const MAT = "Un test (raw)";
const UNIT = "kg";

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function stockOf(id: number): Promise<number> {
  const { rows } = await pool.query(
    `SELECT current_stock FROM raw_materials WHERE id = $1`, [id],
  );
  return rows.length ? Number(rows[0].current_stock) : NaN;
}

async function movements(): Promise<any[]> {
  const { rows } = await pool.query(
    `SELECT product, quantity, movement_type, from_warehouse_id, to_warehouse_id,
            note, created_by, product_type
     FROM stock_movements ORDER BY id`,
  );
  return rows;
}

async function seedStock(value: number): Promise<void> {
  await pool.query(`UPDATE raw_materials SET current_stock = $1 WHERE id = $2`, [value, materialId]);
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);

  // Minimal copies of the production tables /ombor/raw-adjust touches. These
  // tables are not in the Drizzle schema (created out-of-band in prod), so we
  // define only the columns the route actually uses.
  await pool.query(`
    CREATE TABLE raw_materials (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'kg',
      current_stock NUMERIC NOT NULL DEFAULT 0,
      minimum_stock NUMERIC NOT NULL DEFAULT 0,
      default_cost NUMERIC NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'UZS',
      active BOOLEAN NOT NULL DEFAULT TRUE
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
    `INSERT INTO raw_materials (name, unit, current_stock) VALUES ($1,$2,0) RETURNING id`,
    [MAT, UNIT],
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
  await seedStock(100);
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }
});

describe("POST /ombor/raw-adjust — absolute-set stock integrity", () => {
  it("increasing the stock sets the exact value and logs a single IN raw movement", async () => {
    const res = await post("/ombor/raw-adjust", { materialId, stock: 175 });
    expect(res.status).toBe(200);
    expect(res.json.newStock).toBe(175);

    // Stock is set to the absolute value, not added to the old 100.
    expect(await stockOf(materialId)).toBe(175);

    const mv = await movements();
    expect(mv).toHaveLength(1);
    expect(mv[0].movement_type).toBe("IN");
    expect(mv[0].product_type).toBe("raw");
    expect(mv[0].product).toBe(MAT);
    // quantity is the absolute delta (175 − 100).
    expect(Number(mv[0].quantity)).toBe(75);
  });

  it("decreasing the stock sets the exact value and logs a single OUT raw movement", async () => {
    const res = await post("/ombor/raw-adjust", { materialId, stock: 40 });
    expect(res.status).toBe(200);
    expect(res.json.newStock).toBe(40);

    expect(await stockOf(materialId)).toBe(40);

    const mv = await movements();
    expect(mv).toHaveLength(1);
    expect(mv[0].movement_type).toBe("OUT");
    expect(mv[0].product_type).toBe("raw");
    // quantity is the absolute delta (|40 − 100|).
    expect(Number(mv[0].quantity)).toBe(60);
  });

  it("can set the stock to exactly 0 (logs OUT for the full old amount)", async () => {
    const res = await post("/ombor/raw-adjust", { materialId, stock: 0 });
    expect(res.status).toBe(200);
    expect(await stockOf(materialId)).toBe(0);

    const mv = await movements();
    expect(mv).toHaveLength(1);
    expect(mv[0].movement_type).toBe("OUT");
    expect(Number(mv[0].quantity)).toBe(100);
  });

  it("records the old → new transition in the movement note", async () => {
    const res = await post("/ombor/raw-adjust", { materialId, stock: 175, note: "Qayta sanash" });
    expect(res.status).toBe(200);

    const mv = await movements();
    expect(mv).toHaveLength(1);
    // The note must capture both the operator note and the old→new transition.
    expect(mv[0].note).toContain("100");
    expect(mv[0].note).toContain("175");
    expect(mv[0].note).toContain("→");
    expect(mv[0].note).toContain(UNIT);
    expect(mv[0].note).toContain("Qayta sanash");
  });

  it("rejects a negative new stock (400) and leaves stock + log untouched", async () => {
    const res = await post("/ombor/raw-adjust", { materialId, stock: -5 });
    expect(res.status).toBe(400);

    expect(await stockOf(materialId)).toBe(100);
    expect(await movements()).toHaveLength(0);
  });

  it("rejects a no-op adjust to the same value (400) and writes nothing", async () => {
    const res = await post("/ombor/raw-adjust", { materialId, stock: 100 });
    expect(res.status).toBe(400);

    expect(await stockOf(materialId)).toBe(100);
    expect(await movements()).toHaveLength(0);
  });

  it("rejects a non-finite new stock (400) so current_stock can never be corrupted", async () => {
    // "1e999" parses to Infinity; an Infinity stock would corrupt the row and
    // the logged delta, so the route must refuse it. Sent as a string because
    // JSON.stringify(Infinity) collapses to null on the wire.
    const res = await post("/ombor/raw-adjust", { materialId, stock: "1e999" });
    expect(res.status).toBe(400);

    expect(await stockOf(materialId)).toBe(100);
    expect(await movements()).toHaveLength(0);
  });

  it("returns 404 for an unknown materialId and writes nothing", async () => {
    const res = await post("/ombor/raw-adjust", { materialId: 999999, stock: 50 });
    expect(res.status).toBe(404);

    // The seeded material is untouched and no movement is logged.
    expect(await stockOf(materialId)).toBe(100);
    expect(await movements()).toHaveLength(0);
  });

  it("rejects a missing materialId (400)", async () => {
    const res = await post("/ombor/raw-adjust", { stock: 50 });
    expect(res.status).toBe(400);
    expect(await movements()).toHaveLength(0);
  });
});
