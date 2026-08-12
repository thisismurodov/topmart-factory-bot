import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// Deterministic USD→UZS rate — the low-stock flag must not depend on cbu.uz.
vi.mock("../src/lib/exchangeRate", () => ({
  getUsdToUzsRate: async () => ({
    rate: 12000, date: "2026-08-12", source: "fallback", cached: false, stale: false,
  }),
}));

// ── Isolation ──────────────────────────────────────────────────────────────
// Throwaway schema per run (shared Railway DB — unique name is mandatory).
const SCHEMA = `topmart_fg_low_test_${process.pid}_${Date.now()}`;

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

async function getGoods(): Promise<any[]> {
  const r = await fetch(`${apiUrl}/ombor/finished-goods`);
  expect(r.status).toBe(200);
  return r.json();
}

async function seedProduct(name: string, minimumStock: number, opts?: {
  unitType?: string; currency?: string; price?: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO products (name, unit_type, currency_type, default_sale_price, minimum_stock)
     VALUES ($1,$2,$3,$4,$5)`,
    [name, opts?.unitType ?? "dona", opts?.currency ?? "UZS", opts?.price ?? 1000, minimumStock],
  );
}

async function seedStock(product: string, qty: number, weightKg = 0): Promise<void> {
  await pool.query(
    `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type)
     VALUES ($1,$2,$3,$4,'finished')
     ON CONFLICT (warehouse_id, product)
     DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity,
                   weight_kg = inventory.weight_kg + EXCLUDED.weight_kg`,
    [warehouseId, product, qty, weightKg],
  );
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await pool.query(`
    CREATE TABLE warehouses (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      location_type TEXT NOT NULL DEFAULT 'container'
    );
    CREATE TABLE products (
      id                 SERIAL PRIMARY KEY,
      name               TEXT NOT NULL UNIQUE,
      unit_type          TEXT NOT NULL DEFAULT 'dona',
      currency_type      TEXT NOT NULL DEFAULT 'UZS',
      default_sale_price NUMERIC NOT NULL DEFAULT 0,
      minimum_stock      NUMERIC NOT NULL DEFAULT 0
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
  `);
  const wh = await pool.query(
    `INSERT INTO warehouses (name) VALUES ('Tayyor konteyner (test)') RETURNING id`,
  );
  warehouseId = wh.rows[0].id;

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
  await pool.query(`TRUNCATE inventory RESTART IDENTITY`);
  await pool.query(`TRUNCATE products RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
});

describe("GET /ombor/finished-goods — low-stock flag", () => {
  it("flags low ONLY at or below the product's minimum_stock", async () => {
    await seedProduct("Past zahira", 50);
    await seedProduct("Chegarada", 50);
    await seedProduct("Yetarli", 50);
    await seedStock("Past zahira", 20);
    await seedStock("Chegarada", 50); // boundary: qty == minimum → low
    await seedStock("Yetarli", 51);   // just above → not low

    const goods = await getGoods();
    const byName = Object.fromEntries(goods.map((g: any) => [g.product, g]));
    expect(byName["Past zahira"]).toMatchObject({ minimumStock: 50, low: true, stockQty: 20 });
    expect(byName["Chegarada"]).toMatchObject({ minimumStock: 50, low: true });
    expect(byName["Yetarli"]).toMatchObject({ minimumStock: 50, low: false });
  });

  it("never flags products with zero/unset threshold, even at tiny stock", async () => {
    await seedProduct("Chegarasiz", 0);
    await seedStock("Chegarasiz", 1);

    const goods = await getGoods();
    expect(goods).toHaveLength(1);
    expect(goods[0]).toMatchObject({ product: "Chegarasiz", minimumStock: 0, low: false });
  });

  it("compares the threshold against stock summed across all containers", async () => {
    const wh2 = await pool.query(
      `INSERT INTO warehouses (name) VALUES ('Ikkinchi konteyner (test)') RETURNING id`,
    );
    await seedProduct("Bo'lingan zahira", 30);
    await seedStock("Bo'lingan zahira", 10);
    await pool.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, product_type)
       VALUES ($1,$2,25,'finished')`,
      [wh2.rows[0].id, "Bo'lingan zahira"],
    );

    const goods = await getGoods();
    // 10 + 25 = 35 > 30 → jami zahira bo'yicha low emas.
    expect(goods[0]).toMatchObject({ product: "Bo'lingan zahira", stockQty: 35, low: false });
  });

  it("excludes zero-stock rows and keeps low flag for USD products (kg unit)", async () => {
    await seedProduct("Sotilib bo'lgan", 10);
    await seedStock("Sotilib bo'lgan", 0);
    await seedProduct("USD kg mahsulot", 5, { unitType: "kg", currency: "USD", price: 2 });
    await seedStock("USD kg mahsulot", 4, 20);

    const goods = await getGoods();
    expect(goods.map((g: any) => g.product)).toEqual(["USD kg mahsulot"]);
    // qty (4) ≤ min (5) → low; value uses weight × price × rate for kg/USD.
    expect(goods[0]).toMatchObject({ low: true, stockQty: 4 });
    expect(goods[0].totalValueUzs).toBe(20 * 2 * 12000);
  });
});
