import { beforeAll, afterAll, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// ── Isolation ──────────────────────────────────────────────────────────────
// Throwaway schema per run (see ombor-weight.test.ts for the pattern).
const SCHEMA = `topmart_wledger_test_${process.pid}_${Date.now()}`;

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

const LEDGERED = "Oq 5kg guard test";
const FRESH = "Yangi guard test";

async function patch(name: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}/products/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function post(body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}/products`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function weightOf(name: string): Promise<number> {
  const { rows } = await pool.query("SELECT weight FROM products WHERE name=$1", [name]);
  return Number(rows[0].weight);
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);

  await pool.query(`
    CREATE TABLE products (
      cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      id SERIAL,
      name TEXT PRIMARY KEY,
      sku TEXT NOT NULL DEFAULT '',
      unit_type TEXT NOT NULL DEFAULT 'kg',
      currency_type TEXT NOT NULL DEFAULT 'UZS',
      default_sale_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      weight NUMERIC(10,3) NOT NULL DEFAULT 1,
      rate NUMERIC NOT NULL DEFAULT 0,
      rate_type TEXT NOT NULL DEFAULT 'kg',
      salary_cost NUMERIC NOT NULL DEFAULT 0,
      electricity_cost NUMERIC NOT NULL DEFAULT 0,
      other_cost NUMERIC NOT NULL DEFAULT 0,
      minimum_stock NUMERIC NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      payroll_method TEXT NOT NULL DEFAULT 'PRODUCT_RATE',
      pieces_per_box INTEGER NOT NULL DEFAULT 1,
      line_id INTEGER,
      in_sales BOOLEAN NOT NULL DEFAULT FALSE,
      in_production BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE wip_movements (
      id SERIAL PRIMARY KEY,
      line_id INTEGER NOT NULL,
      movement_type TEXT NOT NULL,
      product TEXT,
      weight_kg NUMERIC NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(
    `INSERT INTO products (name, weight) VALUES ($1, 5), ($2, 5)`,
    [LEDGERED, FRESH],
  );
  // Ledger rows only for LEDGERED (case differs on purpose — match is case-insensitive)
  await pool.query(
    `INSERT INTO wip_movements (line_id, movement_type, product, weight_kg)
     VALUES (1,'PRODUCE',UPPER($1),50), (1,'PRODUCE',$1,25), (1,'RECEIVE',NULL,100)`,
    [LEDGERED],
  );

  const { default: productsRouter } = await import("../src/routes/products");
  const app = express();
  app.use(express.json());
  app.use(productsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }
});

describe("PATCH /products weight vs wip ledger guard", () => {
  it("blocks a weight change with 409 when PRODUCE ledger rows exist", async () => {
    const res = await patch(LEDGERED, { weight: 7 });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("WEIGHT_LEDGER_CONFLICT");
    expect(res.json.ledgerRows).toBe(2); // RECEIVE rows don't count
    expect(res.json.oldWeight).toBe(5);
    expect(res.json.newWeight).toBe(7);
    expect(await weightOf(LEDGERED)).toBe(5); // unchanged
  });

  it("allows the change when explicitly confirmed", async () => {
    const res = await patch(LEDGERED, { weight: 7, confirmWeightChange: true });
    expect(res.status).toBe(200);
    expect(await weightOf(LEDGERED)).toBe(7);
    // ledger rows stay at their historical values
    const { rows } = await pool.query(
      `SELECT SUM(weight_kg)::numeric AS s FROM wip_movements WHERE movement_type='PRODUCE'`,
    );
    expect(Number(rows[0].s)).toBe(75);
  });

  it("allows unchanged weight without confirmation (no-op weight in payload)", async () => {
    const res = await patch(LEDGERED, { weight: 7, minimumStock: 3 });
    expect(res.status).toBe(200);
  });

  it("allows a weight change freely when the product has no ledger rows", async () => {
    const res = await patch(FRESH, { weight: 9 });
    expect(res.status).toBe(200);
    expect(await weightOf(FRESH)).toBe(9);
  });

  it("POST upsert on a ledgered product blocks an unconfirmed weight change", async () => {
    const res = await post({ name: LEDGERED, weight: 12 });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("WEIGHT_LEDGER_CONFLICT");
    expect(await weightOf(LEDGERED)).toBe(7); // unchanged from earlier confirm test
  });

  it("POST upsert allows the weight change when confirmed", async () => {
    const res = await post({ name: LEDGERED, weight: 12, confirmWeightChange: true });
    expect(res.status).toBe(201);
    expect(await weightOf(LEDGERED)).toBe(12);
  });

  it("POST upsert with unchanged weight still works without confirmation", async () => {
    const res = await post({ name: LEDGERED, weight: 12, minimumStock: 4 });
    expect(res.status).toBe(201);
    const { rows } = await pool.query(
      "SELECT minimum_stock FROM products WHERE name=$1", [LEDGERED],
    );
    expect(Number(rows[0].minimum_stock)).toBe(4);
  });

  it("POST creates a brand-new product without any ledger check", async () => {
    const res = await post({ name: "Butunlay yangi guard test", weight: 3 });
    expect(res.status).toBe(201);
  });

  it("still blocks other-field updates bundled with a conflicting weight change", async () => {
    const res = await patch(LEDGERED, { weight: 11, rate: 999 });
    expect(res.status).toBe(409);
    const { rows } = await pool.query("SELECT rate FROM products WHERE name=$1", [LEDGERED]);
    expect(Number(rows[0].rate)).toBe(0);
  });
});
