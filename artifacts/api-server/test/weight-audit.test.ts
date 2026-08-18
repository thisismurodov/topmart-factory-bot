import { beforeAll, afterAll, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// ── Isolation ──────────────────────────────────────────────────────────────
// Throwaway schema via search_path (see flow-produce.test.ts for details).
const SCHEMA = `topmart_weight_audit_test_${process.pid}_${Date.now()}`;

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

// Current weight is 5 kg/unit; historical rows were written at 4 kg/unit.
const PRODUCT = "Makaron Audit 5kg";
const CURRENT_WEIGHT = 5;

async function get(path: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}${path}`);
  return { status: r.status, json: await r.json().catch(() => null) };
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);

  await pool.query(`
    CREATE TABLE products (
      cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      id      SERIAL PRIMARY KEY,
      name    TEXT NOT NULL UNIQUE,
      weight  NUMERIC NOT NULL DEFAULT 0,
      unit_type TEXT NOT NULL DEFAULT 'dona'
    );
    CREATE TABLE wip_movements (
      id            SERIAL PRIMARY KEY,
      line_id       INTEGER NOT NULL,
      movement_type TEXT NOT NULL,
      raw_material  TEXT,
      product       TEXT,
      weight_kg     NUMERIC(12,3) NOT NULL DEFAULT 0,
      note          TEXT NOT NULL DEFAULT '',
      created_by    TEXT NOT NULL DEFAULT 'admin',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE batches (
      id         SERIAL PRIMARY KEY,
      batch_code TEXT NOT NULL,
      product    TEXT NOT NULL,
      quantity   NUMERIC NOT NULL DEFAULT 0,
      weight_kg  NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(
    `INSERT INTO products (name, weight, unit_type) VALUES ($1,$2,'dona')`,
    [PRODUCT, CURRENT_WEIGHT],
  );

  // 1) Bot batch row: 10 units at the OLD 4 kg weight → 40 kg (outdated)
  await pool.query(
    `INSERT INTO batches (batch_code, product, quantity, weight_kg) VALUES ('B-1', $1, 10, 40)`,
    [PRODUCT],
  );
  await pool.query(
    `INSERT INTO wip_movements (line_id, movement_type, product, weight_kg, note)
     VALUES (1,'PRODUCE',$1,40,'Partiya: B-1')`,
    [PRODUCT],
  );
  // 2) Dashboard flow row with the default note: 4 units × 5 kg = 20 kg (ok)
  await pool.query(
    `INSERT INTO wip_movements (line_id, movement_type, product, weight_kg, note)
     VALUES (1,'PRODUCE',$1,20,'Tayyor chiqarildi: 4')`,
    [PRODUCT],
  );
  // 3) Custom note — quantity cannot be recovered (unknown)
  await pool.query(
    `INSERT INTO wip_movements (line_id, movement_type, product, weight_kg, note)
     VALUES (1,'PRODUCE',$1,15,'qo''lda kiritildi')`,
    [PRODUCT],
  );
  // Unrelated rows must not leak into the audit.
  await pool.query(
    `INSERT INTO wip_movements (line_id, movement_type, raw_material, weight_kg, note)
     VALUES (1,'RECEIVE','Un',100,'seed')`,
  );
  await pool.query(
    `INSERT INTO wip_movements (line_id, movement_type, product, weight_kg, note)
     VALUES (1,'PRODUCE','Boshqa mahsulot',9,'Tayyor chiqarildi: 3')`,
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
  await new Promise<void>((resolve, reject) =>
    server?.close((e) => (e ? reject(e) : resolve())),
  );
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
});

describe("GET /products/:name/weight-audit", () => {
  it("404s for a missing product", async () => {
    const r = await get(`/products/${encodeURIComponent("Yo'q mahsulot")}/weight-audit`);
    expect(r.status).toBe(404);
  });

  it("classifies ledger rows against the current weight", async () => {
    const r = await get(`/products/${encodeURIComponent(PRODUCT)}/weight-audit`);
    expect(r.status).toBe(200);
    expect(r.json.currentWeight).toBe(CURRENT_WEIGHT);
    expect(r.json.totals).toMatchObject({
      ledgerRows: 3, ok: 1, outdated: 1, unknownQty: 1,
    });
    expect(r.json.totals.totalKg).toBeCloseTo(75, 3);

    const byNote = Object.fromEntries(r.json.rows.map((row: any) => [row.note, row]));

    // Bot batch at old 4 kg/unit → outdated with −1 kg (−20%) deviation
    const batchRow = byNote["Partiya: B-1"];
    expect(batchRow.quantity).toBe(10);
    expect(batchRow.impliedUnitWeight).toBeCloseTo(4, 3);
    expect(batchRow.deviationKg).toBeCloseTo(-1, 3);
    expect(batchRow.deviationPct).toBeCloseTo(-20, 2);
    expect(batchRow.status).toBe("outdated");

    // Dashboard flow row at the current weight → ok
    const flowRow = byNote["Tayyor chiqarildi: 4"];
    expect(flowRow.quantity).toBe(4);
    expect(flowRow.impliedUnitWeight).toBeCloseTo(5, 3);
    expect(flowRow.status).toBe("ok");

    // Custom note → quantity unrecoverable → unknown (honest audit)
    const unknownRow = byNote["qo'lda kiritildi"];
    expect(unknownRow.quantity).toBeNull();
    expect(unknownRow.impliedUnitWeight).toBeNull();
    expect(unknownRow.status).toBe("unknown");
  });
});
