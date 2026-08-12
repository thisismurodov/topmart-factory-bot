import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// ── WIP balance guard parity test ──────────────────────────────────────────
// The Telegram bot's create_batch_session guard is covered by
// artifacts/telegram-bot/tests/test_wip_balance_guard.py. This file covers the
// sibling guard in POST /ombor/flow/produce so the dashboard side can never
// drift and let an operator overstate output:
//   • produce with EMPTY WIP history → 400, nothing written anywhere.
//   • produce > current WIP balance  → 400, nothing written anywhere.
//   • produce <= balance             → 200, PRODUCE ledger row + inventory,
//                                      remaining ledger balance is correct.
//
// Isolation: every query runs in a throwaway schema (search_path via libpq
// `options`), unique per run so parallel validations can't collide.
const SCHEMA = `topmart_flow_produce_guard_test_${process.pid}_${Date.now()}`;

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
let finishedWarehouseId: number;
let lineId: number;

const PRODUCT = "Guard makaron (test)"; // kg-mahsulot, weight = 1 kg/dona

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function count(table: string): Promise<number> {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM ${table}`);
  return rows[0].c;
}

async function wipBalance(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN movement_type='RECEIVE' THEN weight_kg
                              WHEN movement_type='PRODUCE' THEN -weight_kg ELSE 0 END), 0)::numeric AS b
       FROM wip_movements WHERE line_id=$1`,
    [lineId],
  );
  return Number(rows[0].b);
}

async function receive(kg: number): Promise<void> {
  await pool.query(
    `INSERT INTO wip_movements (line_id, movement_type, weight_kg) VALUES ($1,'RECEIVE',$2)`,
    [lineId, kg],
  );
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);

  // Minimal copies of the tables /ombor/flow/produce touches.
  await pool.query(`
    CREATE TABLE warehouses (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      location_type TEXT NOT NULL DEFAULT 'general',
      purpose       TEXT NOT NULL DEFAULT 'finished'
    );
    CREATE TABLE production_lines (
      id     SERIAL PRIMARY KEY,
      name   TEXT NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE products (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      unit_type     TEXT NOT NULL DEFAULT 'dona',
      weight        NUMERIC(12,3) NOT NULL DEFAULT 1,
      line_id       INTEGER,
      in_production BOOLEAN NOT NULL DEFAULT TRUE
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
    `INSERT INTO warehouses (name, location_type, purpose)
     VALUES ('Tayyor konteyner (produce guard)', 'container', 'finished') RETURNING id`,
  );
  finishedWarehouseId = wh.rows[0].id;

  const line = await pool.query(
    `INSERT INTO production_lines (name) VALUES ('Makaron bo''limi (produce guard)') RETURNING id`,
  );
  lineId = line.rows[0].id;

  await pool.query(
    `INSERT INTO products (name, unit_type, weight, line_id) VALUES ($1, 'kg', 1, $2)`,
    [PRODUCT, lineId],
  );

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
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }
});

// State that must be unchanged after any rejected produce request.
async function expectNothingWritten(): Promise<void> {
  expect(await count("inventory")).toBe(0);
  expect(await count("stock_movements")).toBe(0);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM wip_movements WHERE movement_type <> 'RECEIVE'`,
  );
  expect(rows[0].c).toBe(0);
}

describe("POST /ombor/flow/produce — WIP balance guard (parity with bot create_batch_session)", () => {
  it("rejects produce when the WIP history is empty, writing nothing", async () => {
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, product: PRODUCT, quantity: 10, kg: 50,
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/yetarli xom ashyo yo'q/i);
    await expectNothingWritten();
    expect(await wipBalance()).toBe(0);
  });

  it("rejects produce greater than the current WIP balance, writing nothing", async () => {
    await receive(100);
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, product: PRODUCT, quantity: 10, kg: 100.5,
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/yetarli xom ashyo yo'q/i);
    await expectNothingWritten();
    // The RECEIVE credit is untouched.
    expect(await wipBalance()).toBe(100);
  });

  it("accepts produce within balance and leaves the ledger balance correct", async () => {
    await receive(100);
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, product: PRODUCT, quantity: 20, kg: 60,
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);

    // Exactly one PRODUCE row for −60 kg; balance = 100 − 60 = 40.
    const { rows: wip } = await pool.query(
      `SELECT * FROM wip_movements WHERE movement_type='PRODUCE'`,
    );
    expect(wip).toHaveLength(1);
    expect(wip[0].line_id).toBe(lineId);
    expect(wip[0].product).toBe(PRODUCT);
    expect(Number(wip[0].weight_kg)).toBe(60);
    expect(await wipBalance()).toBe(40);

    // Finished container credited with qty + kg.
    const { rows: inv } = await pool.query(`SELECT * FROM inventory`);
    expect(inv).toHaveLength(1);
    expect(inv[0].warehouse_id).toBe(finishedWarehouseId);
    expect(inv[0].product).toBe(PRODUCT);
    expect(Number(inv[0].quantity)).toBe(20);
    expect(Number(inv[0].weight_kg)).toBe(60);
    expect(inv[0].product_type).toBe("finished");

    // Audit trail: one IN/finished stock movement into the container.
    const { rows: mv } = await pool.query(`SELECT * FROM stock_movements`);
    expect(mv).toHaveLength(1);
    expect(mv[0].movement_type).toBe("IN");
    expect(mv[0].product_type).toBe("finished");
    expect(Number(mv[0].quantity)).toBe(20);
    expect(mv[0].to_warehouse_id).toBe(finishedWarehouseId);
  });

  it("falls back to quantity × unit weight when kg is omitted and still enforces the guard", async () => {
    await receive(15);
    // weight = 1 kg/dona → produceKg = 20 > 15 → rejected.
    const res = await post("/ombor/flow/produce", {
      lineId, warehouseId: finishedWarehouseId, product: PRODUCT, quantity: 20,
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/yetarli xom ashyo yo'q/i);
    await expectNothingWritten();
    expect(await wipBalance()).toBe(15);
  });
});
