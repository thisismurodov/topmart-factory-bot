import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// ── Isolation ──────────────────────────────────────────────────────────────
// Every query runs in a throwaway schema (search_path) so the test never
// touches real Ombor data. The search_path is injected via the libpq `options`
// connection parameter, applied to every new pool connection at connect time.
const SCHEMA = "topmart_kg_raw_in_test";

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

const MAT = "Un test (raw-in)";
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

async function materialRow(id: number): Promise<{ stock: number; cost: number; currency: string } | null> {
  const { rows } = await pool.query(
    `SELECT current_stock, default_cost, currency FROM raw_materials WHERE id = $1`, [id],
  );
  if (!rows.length) return null;
  return {
    stock: Number(rows[0].current_stock),
    cost: Number(rows[0].default_cost),
    currency: String(rows[0].currency),
  };
}

async function movements(): Promise<any[]> {
  const { rows } = await pool.query(
    `SELECT product, quantity, movement_type, from_warehouse_id, to_warehouse_id,
            note, created_by, product_type
     FROM stock_movements ORDER BY id`,
  );
  return rows;
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);

  // Minimal copies of the production tables /ombor/raw-in touches. These tables
  // are not in the Drizzle schema (created out-of-band in prod), so we define
  // only the columns the route actually uses.
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
  await pool.query(
    `UPDATE raw_materials SET current_stock = $1, default_cost = $2, currency = $3 WHERE id = $4`,
    [START_STOCK, START_COST, START_CURRENCY, materialId],
  );
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }
});

describe("POST /ombor/raw-in — additive stock intake integrity", () => {
  it("ADDS qty to the existing stock (not overwrite) and logs a single IN raw movement", async () => {
    const res = await post("/ombor/raw-in", { materialId, qty: 25 });
    expect(res.status).toBe(200);
    // Additive: 100 + 25, never replaced by 25.
    expect(res.json.newStock).toBe(125);

    const row = await materialRow(materialId);
    expect(row?.stock).toBe(125);

    const mv = await movements();
    expect(mv).toHaveLength(1);
    expect(mv[0].movement_type).toBe("IN");
    expect(mv[0].product_type).toBe("raw");
    expect(mv[0].product).toBe(MAT);
    // The logged quantity is the amount that came in, not the running total.
    expect(Number(mv[0].quantity)).toBe(25);
  });

  it("adds a fractional qty precisely to the existing stock", async () => {
    const res = await post("/ombor/raw-in", { materialId, qty: 2.5 });
    expect(res.status).toBe(200);
    expect(res.json.newStock).toBe(102.5);
    expect((await materialRow(materialId))?.stock).toBe(102.5);
    const mv = await movements();
    expect(mv).toHaveLength(1);
    expect(Number(mv[0].quantity)).toBe(2.5);
  });

  it("accepts a numeric-string qty and still adds it to stock", async () => {
    const res = await post("/ombor/raw-in", { materialId, qty: "30" });
    expect(res.status).toBe(200);
    expect(res.json.newStock).toBe(130);
    expect((await materialRow(materialId))?.stock).toBe(130);
    expect(await movements()).toHaveLength(1);
  });

  it("updates default_cost and currency ONLY when provided", async () => {
    const res = await post("/ombor/raw-in", { materialId, qty: 10, cost: 7200, currency: "USD" });
    expect(res.status).toBe(200);

    const row = await materialRow(materialId);
    expect(row?.stock).toBe(110);
    expect(row?.cost).toBe(7200);
    expect(row?.currency).toBe("USD");
  });

  it("leaves default_cost and currency UNCHANGED when omitted", async () => {
    const res = await post("/ombor/raw-in", { materialId, qty: 10 });
    expect(res.status).toBe(200);

    const row = await materialRow(materialId);
    expect(row?.stock).toBe(110);
    expect(row?.cost).toBe(START_COST);
    expect(row?.currency).toBe(START_CURRENCY);
  });

  it("leaves default_cost and currency UNCHANGED when passed empty strings", async () => {
    const res = await post("/ombor/raw-in", { materialId, qty: 10, cost: "", currency: "" });
    expect(res.status).toBe(200);

    const row = await materialRow(materialId);
    expect(row?.stock).toBe(110);
    expect(row?.cost).toBe(START_COST);
    expect(row?.currency).toBe(START_CURRENCY);
  });

  it("updates only cost when currency is omitted (and vice versa)", async () => {
    const res1 = await post("/ombor/raw-in", { materialId, qty: 5, cost: 6000 });
    expect(res1.status).toBe(200);
    let row = await materialRow(materialId);
    expect(row?.cost).toBe(6000);
    expect(row?.currency).toBe(START_CURRENCY);

    const res2 = await post("/ombor/raw-in", { materialId, qty: 5, currency: "USD" });
    expect(res2.status).toBe(200);
    row = await materialRow(materialId);
    // cost carried over from the first call (row was not reset between the two).
    expect(row?.cost).toBe(6000);
    expect(row?.currency).toBe("USD");
  });

  it("records the incoming note on the movement", async () => {
    const res = await post("/ombor/raw-in", { materialId, qty: 15, note: "Yetkazib beruvchi X" });
    expect(res.status).toBe(200);
    const mv = await movements();
    expect(mv).toHaveLength(1);
    expect(mv[0].note).toBe("Yetkazib beruvchi X");
  });

  it("rejects qty <= 0 (400) and leaves stock + log untouched", async () => {
    const res = await post("/ombor/raw-in", { materialId, qty: 0 });
    expect(res.status).toBe(400);

    expect((await materialRow(materialId))?.stock).toBe(START_STOCK);
    expect(await movements()).toHaveLength(0);
  });

  it("rejects a negative qty (400) and writes nothing", async () => {
    const res = await post("/ombor/raw-in", { materialId, qty: -20 });
    expect(res.status).toBe(400);

    expect((await materialRow(materialId))?.stock).toBe(START_STOCK);
    expect(await movements()).toHaveLength(0);
  });

  it("rejects a non-numeric qty (400) so current_stock can never be corrupted", async () => {
    const res = await post("/ombor/raw-in", { materialId, qty: "abc" });
    expect(res.status).toBe(400);

    expect((await materialRow(materialId))?.stock).toBe(START_STOCK);
    expect(await movements()).toHaveLength(0);
  });

  it("rejects a missing materialId (400) and writes nothing", async () => {
    const res = await post("/ombor/raw-in", { qty: 10 });
    expect(res.status).toBe(400);
    expect(await movements()).toHaveLength(0);
  });

  it("rejects a non-numeric materialId (400) and writes nothing", async () => {
    const res = await post("/ombor/raw-in", { materialId: String(materialId), qty: 10 });
    expect(res.status).toBe(400);
    expect(await movements()).toHaveLength(0);
  });

  it("returns 404 for an unknown materialId and writes nothing", async () => {
    const res = await post("/ombor/raw-in", { materialId: 999999, qty: 10 });
    expect(res.status).toBe(404);

    // The seeded material is untouched and no movement is logged.
    expect((await materialRow(materialId))?.stock).toBe(START_STOCK);
    expect(await movements()).toHaveLength(0);
  });
});
