import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// ── Isolation ──────────────────────────────────────────────────────────────
// Throwaway schema per run (pid+timestamp) so parallel validations never
// collide — see flow-receive.test.ts for the pattern.
const SCHEMA = `topmart_kg_flow_alerts_test_${process.pid}_${Date.now()}`;

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
let rawWarehouseId: number;
let lineId: number;

const LINE = "Makaron bo'limi (alerts test)";

async function getFlow(): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}/ombor/flow`);
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function addWip(type: "RECEIVE" | "PRODUCE", kg: number): Promise<void> {
  await pool.query(
    `INSERT INTO wip_movements (line_id, movement_type, raw_material, product, weight_kg)
     VALUES ($1,$2,$3,$4,$5)`,
    [lineId, type, type === "RECEIVE" ? "Un" : null, type === "PRODUCE" ? "Makaron" : null, kg],
  );
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);

  // Minimal mirrors of the tables GET /ombor/flow reads.
  await pool.query(`
    CREATE TABLE warehouses (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      capacity_kg   NUMERIC NOT NULL DEFAULT 20000,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      location_type TEXT NOT NULL DEFAULT 'general',
      purpose       TEXT NOT NULL DEFAULT 'finished'
    );
    CREATE TABLE production_lines (
      id     SERIAL PRIMARY KEY,
      name   TEXT NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE production_line_workers (
      id      SERIAL PRIMARY KEY,
      line_id INTEGER NOT NULL
    );
    CREATE TABLE products (
      id      SERIAL PRIMARY KEY,
      name    TEXT NOT NULL,
      line_id INTEGER,
      active  BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE inventory (
      id           SERIAL PRIMARY KEY,
      warehouse_id INTEGER NOT NULL,
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
    `INSERT INTO warehouses (name, location_type, purpose)
     VALUES ('Xom ashyo konteyneri (alerts)', 'container', 'raw') RETURNING id`,
  );
  rawWarehouseId = wh.rows[0].id;

  const line = await pool.query(
    `INSERT INTO production_lines (name) VALUES ($1) RETURNING id`, [LINE],
  );
  lineId = line.rows[0].id;

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
  await pool.query(`TRUNCATE wip_movements RESTART IDENTITY`);
  await pool.query(`TRUNCATE inventory RESTART IDENTITY`);
  // Keep the raw container non-empty so the "empty container" info alert
  // doesn't muddy assertions.
  await pool.query(
    `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type)
     VALUES ($1,'Un',50,50,'raw')`,
    [rawWarehouseId],
  );
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }
});

describe("GET /ombor/flow — negative-WIP department alert", () => {
  it("emits a danger alert naming the department and the shortfall when wipKg < 0", async () => {
    await addWip("RECEIVE", 10);
    await addWip("PRODUCE", 35); // WIP = 10 − 35 = −25

    const res = await getFlow();
    expect(res.status).toBe(200);

    const dept = res.json.departments.find((d: any) => d.id === lineId);
    expect(dept.wipKg).toBe(-25);

    const alert = res.json.alerts.find(
      (a: any) => a.level === "danger" && a.text.includes(LINE),
    );
    expect(alert).toBeDefined();
    // Shows how far below zero the balance is.
    expect(alert.text).toContain("-25");
    expect(alert.text).toContain("manfiy");
  });

  it("does NOT emit the danger alert when WIP is zero or positive", async () => {
    await addWip("RECEIVE", 30);
    await addWip("PRODUCE", 30); // WIP = 0

    const res = await getFlow();
    expect(res.status).toBe(200);
    expect(res.json.departments.find((d: any) => d.id === lineId).wipKg).toBe(0);
    expect(res.json.alerts.filter((a: any) => a.level === "danger")).toHaveLength(0);
  });
});
