import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import pg from "pg";
import {
  childDbUrl,
  requireVehicleTestAdminUrl,
  sslFor,
} from "./helpers/vehicle-test-db";

// A PostgreSQL schema is not sufficient isolation here: `distribution` is a
// real schema name and therefore collides with concurrent tests sharing the
// same database. Provision a whole temporary database before @workspace/db is
// imported, matching the distribution integration-test convention.
const { Client } = pg;
const originalRailwayUrl = process.env.RAILWAY_DATABASE_URL;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalWarehouseBotKey = process.env.WAREHOUSE_BOT_KEY;
const originalAiInternalKey = process.env.AI_INTERNAL_KEY;
const WAREHOUSE_BOT_KEY = "warehouse-receipts-test-key";
const AI_INTERNAL_KEY = "broad-ai-test-key";
const adminUrl = requireVehicleTestAdminUrl();
const TMP_DB = `topmart_external_purchase_${process.pid}_${Date.now()}`;
const tmpUrl = childDbUrl(adminUrl, TMP_DB);

let pool: pg.Pool;
let server: Server;
let apiUrl: string;
let eligibleId: number;
let ineligibleId: number;
let c03Id: number;

async function dropTmpDb(): Promise<void> {
  const admin = new Client({ connectionString: adminUrl, ssl: sslFor(adminUrl) });
  await admin.connect();
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname=$1 AND pid <> pg_backend_pid()`,
    [TMP_DB],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${TMP_DB}`);
  await admin.end();
}

async function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as any };
}

beforeAll(async () => {
  await dropTmpDb();
  {
    const admin = new Client({ connectionString: adminUrl, ssl: sslFor(adminUrl) });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${TMP_DB}`);
    await admin.end();
  }
  // Must be assigned before the first @workspace/db import, whose pool reads
  // its URL during module initialization.
  // @workspace/db enables TLS whenever RAILWAY_DATABASE_URL is present.
  // The isolated loopback PostgreSQL started by global setup is non-TLS.
  delete process.env.RAILWAY_DATABASE_URL;
  process.env.DATABASE_URL = tmpUrl;
  process.env.WAREHOUSE_BOT_KEY = WAREHOUSE_BOT_KEY;
  process.env.AI_INTERNAL_KEY = AI_INTERNAL_KEY;
  const db = await import("@workspace/db");
  pool = db.pool as unknown as pg.Pool;
  await pool.query(`
    CREATE TABLE products (
      id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, sku TEXT NOT NULL DEFAULT '',
      unit_type TEXT NOT NULL DEFAULT 'dona', active BOOLEAN NOT NULL,
      in_sales BOOLEAN NOT NULL, in_production BOOLEAN NOT NULL
    );
    CREATE TABLE warehouses (
      id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, active BOOLEAN NOT NULL,
      purpose TEXT NOT NULL, location_type TEXT NOT NULL DEFAULT 'general'
    );
    CREATE TABLE inventory (
      id SERIAL PRIMARY KEY, warehouse_id INTEGER NOT NULL, product TEXT NOT NULL,
      quantity NUMERIC NOT NULL DEFAULT 0, weight_kg NUMERIC NOT NULL DEFAULT 0,
      product_type TEXT NOT NULL DEFAULT 'finished', updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (warehouse_id, product)
    );
    CREATE TABLE stock_movements (
      id SERIAL PRIMARY KEY, product TEXT NOT NULL, quantity NUMERIC NOT NULL,
      movement_type TEXT NOT NULL, from_warehouse_id INTEGER, to_warehouse_id INTEGER,
      note TEXT NOT NULL, created_by TEXT NOT NULL, product_type TEXT NOT NULL,
      weight_kg NUMERIC, reference TEXT, reason TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE admin_users (id SERIAL PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE admin_sessions (
      token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES admin_users(id)
    );
    CREATE TABLE user_roles (chat_id BIGINT PRIMARY KEY, worker_name TEXT NOT NULL, role TEXT NOT NULL);
  `);
  execFileSync("pnpm", ["--filter", "@workspace/scripts", "run", "init-distribution"], {
    env: {
      ...process.env,
      RAILWAY_DATABASE_URL: "",
      DATABASE_URL: tmpUrl,
    },
    stdio: "pipe",
  });
  await pool.query(`INSERT INTO user_roles(chat_id, worker_name, role) VALUES (100, 'Canonical Omborchi', 'omborchi'), (101, 'Denied Worker', 'worker')`);
  await pool.query(`INSERT INTO admin_users(username, role) VALUES ('admin-user', 'admin'), ('viewer', 'viewer')`);
  await pool.query(`INSERT INTO admin_sessions(token, user_id) VALUES ('admin-token', 1), ('viewer-token', 2)`);
  ({ rows: [{ id: eligibleId }] } = await pool.query(
    `INSERT INTO products(name,sku,active,in_sales,in_production)
     VALUES ('External','EXT-1',TRUE,TRUE,FALSE) RETURNING id`,
  ));
  ({ rows: [{ id: ineligibleId }] } = await pool.query(
    `INSERT INTO products(name,sku,active,in_sales,in_production)
     VALUES ('Factory','FACT-1',TRUE,TRUE,TRUE) RETURNING id`,
  ));
  await pool.query(
    `INSERT INTO distribution.mahsulotlar(nomi,narx,birlik,faol,sku)
     VALUES ('External',100000,'dona',1,'EXT-1')`,
  );
  ({ rows: [{ id: c03Id }] } = await pool.query(
    `INSERT INTO warehouses(name,active,purpose) VALUES ('C-03',TRUE,'finished') RETURNING id`,
  ));
  const { topmartExternalPurchaseRouter } = await import("../src/routes/topmart");
  const { requireAuthOrWarehouseBotKey } = await import("../src/middleware/requireAuthOrWarehouseBotKey");
  const app = express();
  app.use(express.json());
  app.use(requireAuthOrWarehouseBotKey, topmartExternalPurchaseRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (pool) await pool.end();
  if (originalRailwayUrl == null) delete process.env.RAILWAY_DATABASE_URL;
  else process.env.RAILWAY_DATABASE_URL = originalRailwayUrl;
  if (originalDatabaseUrl == null) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalWarehouseBotKey == null) delete process.env.WAREHOUSE_BOT_KEY;
  else process.env.WAREHOUSE_BOT_KEY = originalWarehouseBotKey;
  if (originalAiInternalKey == null) delete process.env.AI_INTERNAL_KEY;
  else process.env.AI_INTERNAL_KEY = originalAiInternalKey;
  await dropTmpDb();
}, 60_000);

function payload(reference: string) {
  return {
    productId: eligibleId, supplier: "Import LLC", quantity: 7,
    totalWeightKg: 12.25, totalCost: 400000, receiptReference: reference,
  };
}

const warehouseHeaders = {
  "x-warehouse-bot-key": WAREHOUSE_BOT_KEY,
  "x-telegram-chat-id": "100",
};

describe("Top Mart external purchase receipts", () => {
  it("lists only active sales-only external products", async () => {
    const response = await request("/topmart/external-products", "GET", undefined, {
      ...warehouseHeaders,
    });
    expect(response.status).toBe(200);
    expect(response.json.map((row: any) => row.id)).toEqual([eligibleId]);
  });

  it("credits canonical C-03 and writes exactly one auditable IN", async () => {
    const response = await request("/topmart/external-purchases", "POST", payload("INV-1"), {
      ...warehouseHeaders,
    });
    expect(response.status).toBe(201);
    expect(response.json.warehouseId).toBe(c03Id);
    const stock = await pool.query(`SELECT * FROM inventory WHERE product='External'`);
    expect(stock.rows).toHaveLength(1);
    expect(Number(stock.rows[0].quantity)).toBe(7);
    expect(Number(stock.rows[0].weight_kg)).toBe(12.25);
    const movements = await pool.query(`SELECT * FROM stock_movements WHERE reference=$1`, ["topmart-external:inv-1"]);
    expect(movements.rows).toHaveLength(1);
    expect(movements.rows[0].movement_type).toBe("IN");
    expect(movements.rows[0].reason).toBe("external_purchase");
    expect(movements.rows[0].created_by).toBe("Canonical Omborchi");
  });

  it("returns read-only receipt history joined to its stock movement and applies filters", async () => {
    const historyProduct = await pool.query(
      `INSERT INTO products(name,sku,active,in_sales,in_production)
       VALUES ('History Product','HISTORY-1',TRUE,TRUE,FALSE) RETURNING id`,
    );
    const historyProductId = Number(historyProduct.rows[0].id);
    await pool.query(
      `INSERT INTO distribution.mahsulotlar(nomi,narx,birlik,faol,sku)
       VALUES ('History Product',100000,'dona',1,'HISTORY-1')`,
    );
    const created = await request("/topmart/external-purchases", "POST", {
      ...payload("INV-HISTORY"),
      productId: historyProductId,
    }, {
      ...warehouseHeaders,
    });
    expect(created.status).toBe(201);
    const history = await request(
      "/topmart/external-purchases?supplier=Import&product=History&reference=history",
      "GET",
      undefined,
      { authorization: "Bearer admin-token" },
    );
    expect(history.status).toBe(200);
    expect(history.json).toHaveLength(1);
    expect(history.json[0]).toMatchObject({
      reference: "INV-HISTORY",
      productId: historyProductId,
      productName: "History Product",
      supplier: "Import LLC",
      quantity: 7,
      totalWeightKg: "12.250",
      totalCost: "400000.00",
      receivedBy: "Canonical Omborchi",
      stockMovement: {
        type: "IN",
        reference: "topmart-external:inv-history",
      },
    });
    expect(history.json[0].stockMovement.id).toEqual(expect.any(Number));
    expect((await request(
      "/topmart/external-purchases?from=2999-01-01",
      "GET",
      undefined,
      { authorization: "Bearer admin-token" },
    )).json).toEqual([]);
    expect((await request(
      "/topmart/external-purchases?from=2026-02-31",
      "GET",
      undefined,
      { authorization: "Bearer admin-token" },
    )).status).toBe(400);
  });

  it("replays the same payload, conflicts on different payload, and never mutates twice", async () => {
    const replay = await request("/topmart/external-purchases", "POST", payload(" inv-1 "), {
      ...warehouseHeaders,
    });
    expect(replay.status).toBe(200);
    expect(replay.json.replayed).toBe(true);
    const conflict = await request("/topmart/external-purchases", "POST", {
      ...payload("INV-1"), quantity: 8,
    }, warehouseHeaders);
    expect(conflict.status).toBe(409);
    const stock = await pool.query(`SELECT quantity FROM inventory WHERE product='External'`);
    expect(Number(stock.rows[0].quantity)).toBe(7);
  });

  it("serializes concurrent duplicates into one mutation", async () => {
    const [first, second] = await Promise.all([
      request("/topmart/external-purchases", "POST", payload("INV-concurrent"), warehouseHeaders),
      request("/topmart/external-purchases", "POST", payload("INV-concurrent"), warehouseHeaders),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    const receipts = await pool.query(
      `SELECT COUNT(*)::int count FROM distribution.topmart_external_purchase_receipts
       WHERE reference_key='inv-concurrent'`,
    );
    expect(receipts.rows[0].count).toBe(1);
  });

  it("rejects ineligible products and rolls back when C-03 is inactive", async () => {
    const badProduct = await request("/topmart/external-purchases", "POST", {
      ...payload("INV-ineligible"), productId: ineligibleId,
    }, warehouseHeaders);
    expect(badProduct.status).toBe(404);
    await pool.query(`UPDATE warehouses SET active=FALSE WHERE id=$1`, [c03Id]);
    const before = await pool.query(`SELECT COUNT(*)::int count FROM stock_movements`);
    const unavailable = await request("/topmart/external-purchases", "POST", payload("INV-no-c03"), warehouseHeaders);
    expect(unavailable.status).toBe(409);
    const after = await pool.query(`SELECT COUNT(*)::int count FROM stock_movements`);
    expect(after.rows[0].count).toBe(before.rows[0].count);
    await pool.query(`UPDATE warehouses SET active=TRUE WHERE id=$1`, [c03Id]);
  });

  it("requires the dedicated key and mapped role, while allowing only admin sessions", async () => {
    expect((await request("/topmart/external-products")).status).toBe(401);
    expect((await request("/topmart/external-products", "GET", undefined, {
      "x-warehouse-bot-key": "wrong",
      "x-telegram-chat-id": "100",
    })).status).toBe(401);
    expect((await request("/topmart/external-products", "GET", undefined, {
      "x-internal-key": AI_INTERNAL_KEY,
      "x-telegram-chat-id": "100",
    })).status).toBe(401);
    expect((await request("/topmart/external-products", "GET", undefined, {
      "x-warehouse-bot-key": WAREHOUSE_BOT_KEY,
      "x-telegram-chat-id": "101",
    })).status).toBe(403);
    expect((await request("/topmart/external-products", "GET", undefined, {
      authorization: "Bearer viewer-token",
    })).status).toBe(403);
    expect((await request("/topmart/external-products", "GET", undefined, {
      authorization: "Bearer admin-token",
    })).status).toBe(200);
    const accepted = await request("/topmart/external-purchases", "POST", {
      ...payload("INV-spoof"), operator: "Mallory",
    }, warehouseHeaders);
    expect(accepted.status).toBe(201);
    const movement = await pool.query(`SELECT created_by FROM stock_movements WHERE reference='topmart-external:inv-spoof'`);
    expect(movement.rows[0].created_by).toBe("Canonical Omborchi");
  });

  it("rejects exponent, blank, overprecision and out-of-range decimal input", async () => {
    for (const [reference, patch] of [
      ["INV-exp", { totalWeightKg: "1e2" }],
      ["INV-weight-scale", { totalWeightKg: "1.0001" }],
      ["INV-cost-scale", { totalCost: "1.001" }],
      ["INV-blank", { totalCost: "" }],
      ["INV-limit", { totalWeightKg: "1000000000" }],
    ]) {
      const response = await request("/topmart/external-purchases", "POST", {
        ...payload(reference), ...patch,
      }, warehouseHeaders);
      expect(response.status).toBe(400);
    }
  });
});