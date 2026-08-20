import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

const SCHEMA = `topmart_batches_payroll_${process.pid}_${Date.now()}`;
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

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await pool.query(`
    CREATE TABLE products (
      name TEXT PRIMARY KEY,
      line_id INTEGER
    );
    CREATE TABLE production_lines (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE batches (
      id SERIAL PRIMARY KEY,
      batch_code TEXT NOT NULL,
      worker TEXT NOT NULL,
      product TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      weight_kg NUMERIC NOT NULL,
      earnings NUMERIC NOT NULL,
      payroll_method TEXT NOT NULL,
      production_line_id INTEGER,
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE daily_payroll_runs (
      id SERIAL PRIMARY KEY,
      scope TEXT NOT NULL,
      line_id INTEGER NOT NULL,
      work_date DATE NOT NULL,
      total_kg NUMERIC NOT NULL,
      status TEXT NOT NULL,
      closed_by TEXT NOT NULL,
      closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (scope, work_date, line_id)
    );
    CREATE TABLE salary_entries (
      id SERIAL PRIMARY KEY,
      scope TEXT NOT NULL,
      line_id INTEGER,
      worker TEXT NOT NULL,
      role TEXT NOT NULL,
      source_type TEXT NOT NULL,
      work_date DATE NOT NULL,
      kg NUMERIC NOT NULL,
      rate NUMERIC NOT NULL,
      amount NUMERIC NOT NULL
    );
  `);

  const line = await pool.query(
    `INSERT INTO production_lines (name) VALUES ('Arqon liniyasi') RETURNING id`,
  );
  const lineId = Number(line.rows[0].id);
  await pool.query(
    `INSERT INTO products (name, line_id)
     VALUES ('Oddiy mahsulot', NULL), ('Liniya mahsuloti', $1)`,
    [lineId],
  );
  await pool.query(
    `INSERT INTO batches
       (batch_code, worker, product, quantity, weight_kg, earnings,
        payroll_method, production_line_id, created_at)
     VALUES
       ('TM-PRODUCT', 'Ali', 'Oddiy mahsulot', 10, 2, 18000,
        'PRODUCT_RATE', NULL, '2026-08-18 05:00:00+00'),
       ('TM-CLOSED', 'Vali', 'Liniya mahsuloti', 1, 20, 0,
        'ROLE_BASED_KG', $1, '2026-08-19 05:00:00+00'),
       ('TM-OPEN', 'Sami', 'Liniya mahsuloti', 1, 15, 0,
        'ROLE_BASED_KG', $1, '2026-08-20 05:00:00+00')`,
    [lineId],
  );
  await pool.query(
    `INSERT INTO daily_payroll_runs
       (scope, line_id, work_date, total_kg, status, closed_by)
     VALUES ('arqon', $1, '2026-08-19', 20, 'closed', 'test')`,
    [lineId],
  );
  await pool.query(
    `INSERT INTO salary_entries
       (scope, line_id, worker, role, source_type, work_date, kg, rate, amount)
     VALUES
       ('arqon', $1, 'Vali', 'producer', 'daily_shared', '2026-08-19', 20, 1000, 20000),
       ('arqon', $1, 'Yordamchi', 'packaging', 'daily_shared', '2026-08-19', 20, 500, 10000),
       ('arqon', $1, 'Boshqa', 'producer', 'manual', '2026-08-19', 0, 0, 99999)`,
    [lineId],
  );

  const { default: batchesRouter } = await import("../src/routes/batches");
  const app = express();
  app.use(express.json());
  app.use("/api", batchesRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }
});

describe("GET /batches payroll status", () => {
  it("keeps product-rate earnings and exposes open/closed line-day pay", async () => {
    const res = await fetch(`${apiUrl}/api/batches?limit=50&offset=0`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);

    const byCode = new Map(body.items.map((item: any) => [item.batchCode, item]));
    expect(byCode.get("TM-PRODUCT")).toMatchObject({
      earnings: 18000,
      payrollMethod: "PRODUCT_RATE",
      payrollStatus: "PRODUCT_RATE",
      frozenDailyEarnings: null,
    });
    expect(byCode.get("TM-OPEN")).toMatchObject({
      earnings: 0,
      payrollMethod: "ROLE_BASED_KG",
      payrollStatus: "OPEN",
      payrollLineName: "Arqon liniyasi",
      payrollWorkDate: "2026-08-20",
      frozenDailyEarnings: null,
    });
    expect(byCode.get("TM-CLOSED")).toMatchObject({
      earnings: 0,
      payrollMethod: "ROLE_BASED_KG",
      payrollStatus: "CLOSED",
      payrollLineName: "Arqon liniyasi",
      payrollWorkDate: "2026-08-19",
      frozenDailyEarnings: 30000,
    });
  });

  it("preserves date filtering and pagination", async () => {
    const filtered = await fetch(
      `${apiUrl}/api/batches?date=2026-08-19&limit=1&offset=0`,
    );
    expect(filtered.status).toBe(200);
    const body = await filtered.json();
    expect(body.total).toBe(1);
    expect(body.items.map((item: any) => item.batchCode)).toEqual(["TM-CLOSED"]);
  });
});