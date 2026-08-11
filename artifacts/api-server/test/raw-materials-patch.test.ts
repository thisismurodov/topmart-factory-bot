import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// ── Isolation ──────────────────────────────────────────────────────────────
// Every query runs in a throwaway schema (search_path) so the test never
// touches real Ombor data.
const SCHEMA = `topmart_rm_patch_test_${process.pid}_${Date.now()}`;

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

const MAT = "Shakar test (raw)";
const UNIT = "kg";

async function patch(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}${path}`, {
    method: "PATCH",
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

async function movements(): Promise<any[]> {
  const { rows } = await pool.query(
    `SELECT product, quantity, movement_type, from_warehouse_id, to_warehouse_id,
            note, created_by, product_type
     FROM stock_movements ORDER BY id`,
  );
  return rows;
}

async function seedLedger(qty: number): Promise<void> {
  await pool.query(
    `INSERT INTO stock_movements (product, quantity, movement_type, note, created_by, product_type)
     VALUES ($1,$2,'IN','seed','test','raw')`,
    [MAT, qty],
  );
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);

  // Minimal copies of the production tables the PATCH route + raw-reconcile touch.
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
      active BOOLEAN NOT NULL DEFAULT TRUE,
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
    `INSERT INTO raw_materials (name, unit, unit_type, current_stock) VALUES ($1,$2,$2,0) RETURNING id`,
    [MAT, UNIT],
  );
  materialId = rows[0].id;

  const { default: rawMaterialsRouter } = await import("../src/routes/raw-materials");
  const { default: omborRouter } = await import("../src/routes/ombor");
  const app = express();
  app.use(express.json());
  app.use(rawMaterialsRouter);
  app.use(omborRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await pool.query(`TRUNCATE stock_movements RESTART IDENTITY`);
  await pool.query(`UPDATE raw_materials SET current_stock = 100, name = $2, minimum_stock = 0 WHERE id = $1`, [materialId, MAT]);
  // Ledger agrees with the seeded 100 before every test.
  await seedLedger(100);
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }
});

describe("PATCH /raw-materials/:id — currentStock edits stay ledger-consistent", () => {
  it("increasing currentStock writes an IN raw movement with the edit note", async () => {
    const res = await patch(`/raw-materials/${materialId}`, { currentStock: 130 });
    expect(res.status).toBe(200);
    expect(await stockOf(materialId)).toBe(130);

    const mv = await movements();
    expect(mv).toHaveLength(2); // seed + edit
    expect(mv[1].movement_type).toBe("IN");
    expect(mv[1].product_type).toBe("raw");
    expect(mv[1].product).toBe(MAT);
    expect(Number(mv[1].quantity)).toBe(30);
    expect(mv[1].note).toContain("Tahrirlash orqali o'zgartirildi");
    expect(mv[1].note).toContain("100");
    expect(mv[1].note).toContain("130");
  });

  it("decreasing currentStock writes an OUT raw movement (from_warehouse_id NULL → global)", async () => {
    const res = await patch(`/raw-materials/${materialId}`, { currentStock: 60 });
    expect(res.status).toBe(200);
    expect(await stockOf(materialId)).toBe(60);

    const mv = await movements();
    expect(mv).toHaveLength(2);
    expect(mv[1].movement_type).toBe("OUT");
    expect(mv[1].from_warehouse_id).toBeNull();
    expect(Number(mv[1].quantity)).toBe(40);
  });

  it("after an edit, /ombor/raw-reconcile reports hasMismatch: false for that material", async () => {
    const res = await patch(`/raw-materials/${materialId}`, { currentStock: 250 });
    expect(res.status).toBe(200);

    const rec = await get("/ombor/raw-reconcile");
    expect(rec.status).toBe(200);
    const row = rec.json.find((r: any) => r.id === materialId);
    expect(row).toBeTruthy();
    expect(row.hasMismatch).toBe(false);
    expect(row.currentStock).toBe(250);
    expect(row.ledgerSum).toBe(250);
  });

  it("editing other fields together with currentStock applies both and logs one movement", async () => {
    const res = await patch(`/raw-materials/${materialId}`, { minimumStock: 5, currentStock: 90 });
    expect(res.status).toBe(200);

    const { rows } = await pool.query(`SELECT minimum_stock FROM raw_materials WHERE id=$1`, [materialId]);
    expect(Number(rows[0].minimum_stock)).toBe(5);
    expect(await stockOf(materialId)).toBe(90);

    const mv = await movements();
    expect(mv).toHaveLength(2);
    expect(mv[1].movement_type).toBe("OUT");
    expect(Number(mv[1].quantity)).toBe(10);
  });

  it("a no-op currentStock edit (same value) writes no movement and stays reconciled", async () => {
    const res = await patch(`/raw-materials/${materialId}`, { currentStock: 100 });
    expect(res.status).toBe(200);
    expect(await movements()).toHaveLength(1); // seed only

    const rec = await get("/ombor/raw-reconcile");
    const row = rec.json.find((r: any) => r.id === materialId);
    expect(row.hasMismatch).toBe(false);
  });

  it("editing only non-stock fields writes no movement", async () => {
    const res = await patch(`/raw-materials/${materialId}`, { minimumStock: 7 });
    expect(res.status).toBe(200);
    expect(await movements()).toHaveLength(1); // seed only
  });

  it("renaming and changing stock in one PATCH migrates history to the NEW name and stays reconciled", async () => {
    const NEW_NAME = "Shakar premium (raw)";
    const res = await patch(`/raw-materials/${materialId}`, { name: NEW_NAME, currentStock: 120 });
    expect(res.status).toBe(200);

    const mv = await movements();
    expect(mv).toHaveLength(2);
    // BOTH the seeded old-name history and the new delta carry the new name.
    expect(mv[0].product).toBe(NEW_NAME);
    expect(mv[1].product).toBe(NEW_NAME);
    expect(Number(mv[1].quantity)).toBe(20);

    const rec = await get("/ombor/raw-reconcile");
    const row = rec.json.find((r: any) => r.id === materialId);
    expect(row).toBeTruthy();
    expect(row.hasMismatch).toBe(false);
    expect(row.ledgerSum).toBe(120);
  });

  it("renaming WITHOUT a stock change also migrates ledger history and stays reconciled", async () => {
    const NEW_NAME = "Shakar oq (raw)";
    const res = await patch(`/raw-materials/${materialId}`, { name: NEW_NAME });
    expect(res.status).toBe(200);

    const mv = await movements();
    expect(mv).toHaveLength(1);
    expect(mv[0].product).toBe(NEW_NAME);

    const rec = await get("/ombor/raw-reconcile");
    const row = rec.json.find((r: any) => r.id === materialId);
    expect(row.hasMismatch).toBe(false);
  });

  it("rejects a negative currentStock (400) and leaves stock + ledger untouched", async () => {
    const res = await patch(`/raw-materials/${materialId}`, { currentStock: -3 });
    expect(res.status).toBe(400);
    expect(await stockOf(materialId)).toBe(100);
    expect(await movements()).toHaveLength(1);
  });

  it("rejects a non-finite currentStock (400)", async () => {
    const res = await patch(`/raw-materials/${materialId}`, { currentStock: "1e999" });
    expect(res.status).toBe(400);
    expect(await stockOf(materialId)).toBe(100);
    expect(await movements()).toHaveLength(1);
  });

  it("returns 404 for an unknown id and writes nothing", async () => {
    const res = await patch(`/raw-materials/999999`, { currentStock: 50 });
    expect(res.status).toBe(404);
    expect(await movements()).toHaveLength(1);
  });
});
