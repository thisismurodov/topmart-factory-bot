import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// ── Isolation ──────────────────────────────────────────────────────────────
const SCHEMA = `topmart_invv2_attr_test_${process.pid}_${Date.now()}`;

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
let warehouseId: number;

// Simulated session user, set per-test. Mirrors requireAuth attaching
// req.username after session validation.
let sessionUser: string | undefined;

async function postMovement(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}/inventory/movement`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function lastCreatedBy(): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT created_by FROM stock_movements ORDER BY id DESC LIMIT 1`,
  );
  return rows.length ? rows[0].created_by : null;
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
      cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
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
    `INSERT INTO warehouses (name) VALUES ('K-Attr') RETURNING id`,
  );
  warehouseId = rows[0].id;

  const { default: inventoryV2Router } = await import("../src/routes/inventory-v2");
  const app = express();
  app.use(express.json());
  // Mimic the session middleware: attach req.username when a session exists.
  app.use((req: any, _res, next) => {
    if (sessionUser) req.username = sessionUser;
    next();
  });
  app.use(inventoryV2Router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  sessionUser = undefined;
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
describe("POST /inventory/movement — created_by attribution", () => {
  it("session user always wins: body created_by/operator cannot spoof", async () => {
    sessionUser = "admin1";
    const { status } = await postMovement({
      product: "P1", quantity: 5, movement_type: "IN", to_warehouse_id: warehouseId,
      created_by: "hacker", operator: "hacker2",
    });
    expect(status).toBe(200);
    expect(await lastCreatedBy()).toBe("admin1");
  });

  it("without a session, body created_by is ignored (no arbitrary attribution)", async () => {
    const { status } = await postMovement({
      product: "P2", quantity: 3, movement_type: "IN", to_warehouse_id: warehouseId,
      created_by: "somebody",
    });
    expect(status).toBe(200);
    const by = await lastCreatedBy();
    expect(by).not.toBe("somebody");
    expect(by).toBe("bot");
  });

  it("without a session, a bot-style operator field is recorded", async () => {
    const { status } = await postMovement({
      product: "P3", quantity: 2, movement_type: "IN", to_warehouse_id: warehouseId,
      operator: "Omborchi Ali",
    });
    expect(status).toBe(200);
    expect(await lastCreatedBy()).toBe("Omborchi Ali");
  });

  it("never records an empty created_by", async () => {
    const { status } = await postMovement({
      product: "P4", quantity: 1, movement_type: "IN", to_warehouse_id: warehouseId,
      created_by: "",
    });
    expect(status).toBe(200);
    expect(await lastCreatedBy()).toBe("bot");
  });
});
