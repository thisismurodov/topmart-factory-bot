import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// ── Isolation ──────────────────────────────────────────────────────────────
const SCHEMA = `topmart_mv_ledger_test_${process.pid}_${Date.now()}`;

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
let materialId: number;

const MAT = "Ip test (ledger)";

async function get(path: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}${path}`);
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function insertMovement(
  type: "IN" | "OUT" | "TRANSFER",
  qty: number,
  fromWarehouseId: number | null = null,
): Promise<void> {
  await pool.query(
    `INSERT INTO stock_movements (product, quantity, movement_type, from_warehouse_id, product_type)
     VALUES ($1,$2,$3,$4,'raw')`,
    [MAT, qty, type, fromWarehouseId],
  );
}

async function setStock(value: number): Promise<void> {
  await pool.query(
    `UPDATE raw_materials SET current_stock = $1 WHERE id = $2`,
    [value, materialId],
  );
}

function movesPath(extra = ""): string {
  return `/ombor/movements?type=raw&balance=ledger&product=${encodeURIComponent(MAT)}${extra}`;
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await pool.query(`
    CREATE TABLE raw_materials (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'kg',
      unit_type TEXT NOT NULL DEFAULT 'kg',
      current_stock NUMERIC NOT NULL DEFAULT 0,
      minimum_stock NUMERIC NOT NULL DEFAULT 0,
      default_cost NUMERIC NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'UZS',
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE warehouses (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      location_type TEXT NOT NULL DEFAULT 'container',
      capacity_kg NUMERIC NOT NULL DEFAULT 20000,
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
    `INSERT INTO raw_materials (name, current_stock) VALUES ($1, 0) RETURNING id`,
    [MAT],
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
  await setStock(0);
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
describe("GET /ombor/movements?balance=ledger — forward ledger walk", () => {
  it("walks forward from 0: final balance equals ledger sum (matches current_stock when no gap)", async () => {
    await insertMovement("IN", 100);
    await insertMovement("OUT", 30);   // global BOM deduction
    await setStock(70);

    const { status, json } = await get(movesPath());
    expect(status).toBe(200);
    // newest-first: OUT 30 (bal 70), IN 100 (bal 100)
    expect(json).toHaveLength(2);
    expect(json[0].movementType).toBe("OUT");
    expect(json[0].balanceAfter).toBeCloseTo(70, 3);
    expect(json[1].movementType).toBe("IN");
    expect(json[1].balanceAfter).toBeCloseTo(100, 3);
  });

  it("shows the divergence when a gap exists: final balance ≠ current_stock", async () => {
    await insertMovement("IN", 100);
    await setStock(60); // external edit → gap = -40

    const { json } = await get(movesPath());
    expect(json[0].balanceAfter).toBeCloseTo(100, 3); // ledger says 100, stock says 60
  });

  it("marks container-only rows (TRANSFER, OUT with from_warehouse_id) with balanceAfter null and skips them in the walk", async () => {
    await insertMovement("IN", 100);
    await insertMovement("OUT", 25, 7);   // container hand-off — global unchanged
    await insertMovement("TRANSFER", 10, 7);
    await insertMovement("OUT", 40);      // global deduction

    const { json } = await get(movesPath());
    // newest-first: OUT40(bal 60), TRANSFER(null), OUT25 c(null), IN100(bal 100)
    expect(json).toHaveLength(4);
    expect(json[0].balanceAfter).toBeCloseTo(60, 3);
    expect(json[1].balanceAfter).toBeNull();
    expect(json[2].balanceAfter).toBeNull();
    expect(json[3].balanceAfter).toBeCloseTo(100, 3);
  });

  it("anchors the walk at the SQL opening balance when history exceeds the limit", async () => {
    // 5 global movements; request only the newest 2.
    await insertMovement("IN", 100);  // bal 100
    await insertMovement("OUT", 10);  // bal 90
    await insertMovement("IN", 40);   // bal 130
    await insertMovement("OUT", 20);  // bal 110
    await insertMovement("IN", 5);    // bal 115
    await setStock(115);

    const { json } = await get(movesPath("&limit=2"));
    expect(json).toHaveLength(2);
    // newest-first: IN 5 (bal 115), OUT 20 (bal 110) — anchored at opening 130
    expect(json[0].balanceAfter).toBeCloseTo(115, 3);
    expect(json[1].balanceAfter).toBeCloseTo(110, 3);

    // Final ledger balance must equal /raw-reconcile's ledgerSum
    const { json: rec } = await get("/ombor/raw-reconcile");
    const row = (rec as any[]).find((r: any) => r.id === materialId);
    expect(row.ledgerSum).toBeCloseTo(json[0].balanceAfter, 3);
    expect(row.hasMismatch).toBe(false);
  });

  it("ignores container-only rows in the opening balance when they fall outside the window", async () => {
    await insertMovement("IN", 100);      // global
    await insertMovement("OUT", 30, 7);   // container hand-off — ignored
    await insertMovement("TRANSFER", 5, 7); // ignored
    await insertMovement("OUT", 25);      // global → ledger 75

    const { json } = await get(movesPath("&limit=1"));
    expect(json).toHaveLength(1);
    expect(json[0].balanceAfter).toBeCloseTo(75, 3);
  });

  it("without balance=ledger, keeps the existing backward anchor-to-current-stock behavior", async () => {
    await insertMovement("IN", 100);
    await setStock(60);

    const { json } = await get(`/ombor/movements?type=raw&product=${encodeURIComponent(MAT)}`);
    // anchored at current_stock: newest row balance = 60
    expect(json[0].balanceAfter).toBeCloseTo(60, 3);
  });
});
