import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// ── Isolation ──────────────────────────────────────────────────────────────
// Every query runs inside a throwaway schema so the test never touches real
// production data.
const SCHEMA = `topmart_raw_reconcile_test_${process.pid}_${Date.now()}`;

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

const MAT  = "Vata test (reconcile)";
const UNIT = "kg";

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

async function stockOf(id: number): Promise<number> {
  const { rows } = await pool.query(
    `SELECT current_stock FROM raw_materials WHERE id = $1`, [id],
  );
  return rows.length ? Number(rows[0].current_stock) : NaN;
}

/** Sum the "global" ledger for a material (mirrors the reconcile endpoint logic). */
async function ledgerOf(name: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(
        CASE
          WHEN movement_type = 'IN'                                   THEN  quantity
          WHEN movement_type = 'OUT' AND from_warehouse_id IS NULL    THEN -quantity
          ELSE 0
        END
      ), 0)::numeric AS total
     FROM stock_movements
     WHERE product = $1 AND product_type = 'raw'`,
    [name],
  );
  return Number(rows[0].total);
}

async function allMovements(): Promise<any[]> {
  const { rows } = await pool.query(
    `SELECT movement_type, quantity, from_warehouse_id, product_type, note
     FROM stock_movements ORDER BY id`,
  );
  return rows;
}

/** Directly write a movement row without going through the API (to simulate
 *  historical gaps — e.g. BOM deletion after a batch). */
async function insertMovement(
  type: "IN" | "OUT",
  qty: number,
  fromWarehouseId: number | null = null,
): Promise<void> {
  await pool.query(
    `INSERT INTO stock_movements (product, quantity, movement_type, from_warehouse_id, product_type)
     VALUES ($1,$2,$3,$4,'raw')`,
    [MAT, qty, type, fromWarehouseId],
  );
}

/** Directly set current_stock without writing a movement (simulates a manual
 *  DB edit or a legacy import that bypassed the movement ledger). */
async function setStockDirectly(value: number): Promise<void> {
  await pool.query(
    `UPDATE raw_materials SET current_stock = $1 WHERE id = $2`,
    [value, materialId],
  );
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);

  // Minimal table definitions matching what the routes use.
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
    `INSERT INTO raw_materials (name, unit, unit_type, current_stock) VALUES ($1,$2,$2,0) RETURNING id`,
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
  await setStockDirectly(0);
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
describe("GET /ombor/raw-reconcile — mismatch detection", () => {
  it("reports hasMismatch:false when ledger matches current_stock exactly", async () => {
    // current_stock = 0, no movements → gap = 0
    const { status, json } = await get("/ombor/raw-reconcile");
    expect(status).toBe(200);
    const row = (json as any[]).find((r: any) => r.id === materialId);
    expect(row).toBeDefined();
    expect(row.hasMismatch).toBe(false);
    expect(row.gap).toBeCloseTo(0, 3);
  });

  it("detects a positive gap when stock was edited directly (stock > ledger)", async () => {
    // stock=200, no movements → ledger=0, gap=+200
    await setStockDirectly(200);

    const { json } = await get("/ombor/raw-reconcile");
    const row = (json as any[]).find((r: any) => r.id === materialId);
    expect(row.hasMismatch).toBe(true);
    expect(row.gap).toBeCloseTo(200, 3);
    expect(row.currentStock).toBeCloseTo(200, 3);
    expect(row.ledgerSum).toBeCloseTo(0, 3);
  });

  it("detects a negative gap when movements exceed current_stock (deleted BOM edits)", async () => {
    // stock=50, but movements show IN=100 and OUT=0 → ledger=100, gap=−50
    await setStockDirectly(50);
    await insertMovement("IN", 100);

    const { json } = await get("/ombor/raw-reconcile");
    const row = (json as any[]).find((r: any) => r.id === materialId);
    expect(row.hasMismatch).toBe(true);
    expect(row.gap).toBeCloseTo(-50, 3);
    expect(row.ledgerSum).toBeCloseTo(100, 3);
  });

  it("ignores OUT rows that have a from_warehouse_id (container hand-offs don't affect global stock)", async () => {
    // stock=100, IN=100, OUT=30 with from_warehouse_id (container-only) → ledger=100, gap=0
    await setStockDirectly(100);
    await insertMovement("IN",  100, null);
    await insertMovement("OUT",  30, 99);  // container hand-off, should be ignored

    const { json } = await get("/ombor/raw-reconcile");
    const row = (json as any[]).find((r: any) => r.id === materialId);
    expect(row.hasMismatch).toBe(false);
    expect(row.gap).toBeCloseTo(0, 3);
    expect(row.ledgerSum).toBeCloseTo(100, 3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("POST /ombor/raw-reconcile-resolve — gap closure", () => {
  it("closes a positive gap: writes an IN movement equal to the gap and leaves current_stock unchanged", async () => {
    // stock=200, ledger=0 → gap=+200
    await setStockDirectly(200);
    const stockBefore = await stockOf(materialId);

    const { status, json } = await post("/ombor/raw-reconcile-resolve", { materialId });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.movementType).toBe("IN");

    // current_stock must NOT change
    expect(await stockOf(materialId)).toBe(stockBefore);

    // After resolve the ledger must match current_stock exactly
    expect(await ledgerOf(MAT)).toBeCloseTo(200, 3);

    // Reconcile endpoint now reports hasMismatch:false
    const { json: reconcile } = await get("/ombor/raw-reconcile");
    const row = (reconcile as any[]).find((r: any) => r.id === materialId);
    expect(row.hasMismatch).toBe(false);
    expect(row.gap).toBeCloseTo(0, 3);
  });

  it("closes a negative gap: writes an OUT movement equal to |gap| and leaves current_stock unchanged", async () => {
    // stock=50, ledger=100 → gap=−50
    await setStockDirectly(50);
    await insertMovement("IN", 100);
    const stockBefore = await stockOf(materialId);

    const { status, json } = await post("/ombor/raw-reconcile-resolve", { materialId });
    expect(status).toBe(200);
    expect(json.movementType).toBe("OUT");

    expect(await stockOf(materialId)).toBe(stockBefore);
    expect(await ledgerOf(MAT)).toBeCloseTo(50, 3);

    const { json: reconcile } = await get("/ombor/raw-reconcile");
    const row = (reconcile as any[]).find((r: any) => r.id === materialId);
    expect(row.hasMismatch).toBe(false);
    expect(row.gap).toBeCloseTo(0, 3);
  });

  it("records the note and 'Tarixiy tuzatish' in the movement note", async () => {
    await setStockDirectly(300);
    await post("/ombor/raw-reconcile-resolve", { materialId, note: "BOM qayta yuklandi" });

    const mv = await allMovements();
    expect(mv).toHaveLength(1);
    expect(mv[0].note).toContain("BOM qayta yuklandi");
    expect(mv[0].note).toContain("Tarixiy tuzatish");
    expect(mv[0].product_type).toBe("raw");
  });

  it("writes a ledger OUT with from_warehouse_id IS NULL so it counts toward global stock", async () => {
    // Negative gap: stock < ledger
    await setStockDirectly(10);
    await insertMovement("IN", 100);

    await post("/ombor/raw-reconcile-resolve", { materialId });

    const mv = await allMovements();
    const correction = mv.find((r) => r.note.includes("Tarixiy tuzatish"));
    expect(correction).toBeDefined();
    expect(correction.movement_type).toBe("OUT");
    expect(correction.from_warehouse_id).toBeNull();  // must be null to count in ledger
  });

  it("returns 400 when there is no gap to close", async () => {
    // stock=0, no movements → gap=0
    const { status } = await post("/ombor/raw-reconcile-resolve", { materialId });
    expect(status).toBe(400);
    expect(await allMovements()).toHaveLength(0);
  });

  it("returns 400 when materialId is missing", async () => {
    const { status } = await post("/ombor/raw-reconcile-resolve", { note: "test" });
    expect(status).toBe(400);
  });

  it("returns 404 for an unknown materialId", async () => {
    await setStockDirectly(100);
    const { status } = await post("/ombor/raw-reconcile-resolve", { materialId: 999999 });
    expect(status).toBe(404);
    expect(await allMovements()).toHaveLength(0);
  });
});
