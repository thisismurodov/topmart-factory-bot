import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import {
  childDbUrl,
  requireVehicleTestAdminUrl,
  sslFor,
} from "./helpers/vehicle-test-db";

const { Client, Pool } = pg;
const adminUrl = requireVehicleTestAdminUrl();
const ssl = sslFor(adminUrl);
const dbName = `topmart_external_cogs_${process.pid}_${Date.now()}`;
const dbUrl = childDbUrl(adminUrl, dbName);
let pool: pg.Pool;

async function dropDb(): Promise<void> {
  const client = new Client({ connectionString: adminUrl, ssl });
  await client.connect();
  await client.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname=$1 AND pid<>pg_backend_pid()`,
    [dbName],
  );
  await client.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await client.end();
}

beforeAll(async () => {
  await dropDb();
  const admin = new Client({ connectionString: adminUrl, ssl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const client = new Client({ connectionString: dbUrl, ssl });
  await client.connect();
  await client.query(`
    CREATE TABLE products (
      id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, sku TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE, in_sales BOOLEAN NOT NULL DEFAULT TRUE,
      in_production BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE warehouses (id SERIAL PRIMARY KEY);
    CREATE TABLE stock_movements (id SERIAL PRIMARY KEY);
  `);
  await client.end();

  const scriptsDir = path.resolve(import.meta.dirname, "../../../scripts");
  const { RAILWAY_DATABASE_URL: _railway, ...baseEnv } = process.env;
  execFileSync("pnpm", ["exec", "tsx", "src/init-distribution.ts"], {
    cwd: scriptsDir,
    env: { ...baseEnv, DATABASE_URL: dbUrl },
    stdio: "ignore",
  });
  pool = new Pool({ connectionString: dbUrl, ssl });
}, 90_000);

afterAll(async () => {
  await pool?.end();
  await dropDb();
});

beforeEach(async () => {
  await pool.query(`
    TRUNCATE distribution.topmart_external_cost_allocations,
      distribution.topmart_external_purchase_receipts,
      distribution.savdo_tafsilot, distribution.savdolar,
      distribution.mahsulotlar, stock_movements, warehouses, products
      RESTART IDENTITY CASCADE;
    INSERT INTO warehouses DEFAULT VALUES;
    INSERT INTO stock_movements DEFAULT VALUES;
    INSERT INTO stock_movements DEFAULT VALUES;
    INSERT INTO products(name,sku,in_production) VALUES
      ('External dona','EXT-D',FALSE),
      ('External kg','EXT-K',FALSE),
      ('Factory','FACT',TRUE);
    INSERT INTO distribution.mahsulotlar(nomi,narx,birlik,faol,sku) VALUES
      ('External dona',300,'dona',1,'EXT-D'),
      ('External kg',500,'kg',1,'EXT-K'),
      ('Factory',700,'dona',1,'FACT');
  `);
});

async function receipt(
  productId: number,
  movementId: number,
  reference: string,
  quantity: number,
  weight: number,
  cost: number,
  receivedAt: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO distribution.topmart_external_purchase_receipts
       (reference,reference_key,request_fingerprint,product_id,product_name,
        supplier,quantity,total_weight_kg,total_cost,c03_warehouse_id,
        stock_movement_id,received_by,received_at)
     SELECT $1,lower($1),$1,p.id,p.name,'Supplier',$2,$3,$4,1,$5,'tester',$6
       FROM products p WHERE p.id=$7`,
    [reference, quantity, weight, cost, movementId, receivedAt, productId],
  );
}

async function saleLine(mahsulotId: number, quantity: number, revenue: number): Promise<number> {
  const sale = await pool.query(
    `INSERT INTO distribution.savdolar(jami_summa,status,created_at)
     VALUES ($1,'active','2026-09-07T10:00:00') RETURNING id`,
    [revenue],
  );
  const line = await pool.query(
    `INSERT INTO distribution.savdo_tafsilot(savdo_id,mahsulot_id,miqdor,narx,summa)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [sale.rows[0].id, mahsulotId, quantity, revenue / quantity, revenue],
  );
  return Number(line.rows[0].id);
}

describe("Top Mart external FIFO COGS", () => {
  it("allocates partial dona sales across receipt lots in FIFO order", async () => {
    await receipt(1, 1, "R-1", 10, 10, 1000, "2026-09-01T10:00:00Z");
    await receipt(1, 2, "R-2", 10, 10, 2000, "2026-09-02T10:00:00Z");
    const lineId = await saleLine(1, 15, 4500);

    const { rows } = await pool.query(
      `SELECT receipt_id,allocated_quantity,allocated_cost
         FROM distribution.topmart_external_cost_allocations
        WHERE savdo_tafsilot_id=$1 ORDER BY receipt_id`,
      [lineId],
    );
    expect(rows.map((row) => ({
      receiptId: Number(row.receipt_id),
      quantity: Number(row.allocated_quantity),
      cost: Number(row.allocated_cost),
    }))).toEqual([
      { receiptId: 1, quantity: 10, cost: 1000 },
      { receiptId: 2, quantity: 5, cost: 1000 },
    ]);
  });

  it("uses receipt weight for kg products and never allocates factory products", async () => {
    await receipt(2, 1, "KG-1", 4, 20, 1000, "2026-09-01T10:00:00Z");
    const kgLine = await saleLine(2, 7.5, 3750);
    const factoryLine = await saleLine(3, 2, 1400);
    const { rows } = await pool.query(
      `SELECT savdo_tafsilot_id,allocated_quantity,allocated_cost
         FROM distribution.topmart_external_cost_allocations ORDER BY id`,
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].savdo_tafsilot_id)).toBe(kgLine);
    expect(Number(rows[0].allocated_quantity)).toBe(7.5);
    expect(Number(rows[0].allocated_cost)).toBe(375);
    expect(Number(rows[0].savdo_tafsilot_id)).not.toBe(factoryLine);
  });

  it("clears costs while a distributor SKU mapping is inactive or ambiguous", async () => {
    await receipt(1, 1, "R-1", 10, 10, 1000, "2026-09-01T10:00:00Z");
    const eligibleLine = await saleLine(1, 5, 1500);
    expect(Number((await pool.query(
      `SELECT SUM(allocated_cost) cost
         FROM distribution.topmart_external_cost_allocations
        WHERE savdo_tafsilot_id=$1`,
      [eligibleLine],
    )).rows[0].cost)).toBe(500);

    const duplicateId = Number((await pool.query(
      `INSERT INTO distribution.mahsulotlar(nomi,narx,birlik,faol,sku)
       VALUES ('External duplicate',300,'kg',1,'EXT-D') RETURNING id`,
    )).rows[0].id);
    expect(Number((await pool.query(
      `SELECT COUNT(*) count FROM distribution.topmart_external_cost_allocations`,
    )).rows[0].count)).toBe(0);

    const duplicateLine = await saleLine(duplicateId, 2, 600);
    expect(Number((await pool.query(
      `SELECT COUNT(*) count FROM distribution.topmart_external_cost_allocations`,
    )).rows[0].count)).toBe(0);

    await pool.query(`UPDATE distribution.mahsulotlar SET faol=0 WHERE id=$1`, [duplicateId]);
    const restored = await pool.query(
      `SELECT savdo_tafsilot_id,SUM(allocated_cost) cost
         FROM distribution.topmart_external_cost_allocations
        GROUP BY savdo_tafsilot_id`,
    );
    expect(restored.rows.map((row) => [
      Number(row.savdo_tafsilot_id), Number(row.cost),
    ])).toEqual([[eligibleLine, 500]]);
    expect(restored.rows.some(
      (row) => Number(row.savdo_tafsilot_id) === duplicateLine,
    )).toBe(false);
  });

  it("releases and reallocates cost when a partial sale line is corrected or removed", async () => {
    await receipt(1, 1, "R-1", 10, 10, 1000, "2026-09-01T10:00:00Z");
    const lineId = await saleLine(1, 8, 2400);
    await pool.query(
      `UPDATE distribution.savdo_tafsilot SET miqdor=3,summa=900 WHERE id=$1`,
      [lineId],
    );
    expect(Number((await pool.query(
      `SELECT SUM(allocated_cost) cost FROM distribution.topmart_external_cost_allocations
        WHERE savdo_tafsilot_id=$1`,
      [lineId],
    )).rows[0].cost)).toBe(300);
    await pool.query(`DELETE FROM distribution.savdo_tafsilot WHERE id=$1`, [lineId]);
    expect(Number((await pool.query(
      `SELECT COUNT(*) count FROM distribution.topmart_external_cost_allocations`,
    )).rows[0].count)).toBe(0);
  });

  it("reflows later sales back onto older FIFO lots after an earlier correction", async () => {
    await receipt(1, 1, "R-1", 10, 10, 1000, "2026-09-01T10:00:00Z");
    await receipt(1, 2, "R-2", 10, 10, 2000, "2026-09-02T10:00:00Z");
    const firstLine = await saleLine(1, 8, 2400);
    const secondLine = await saleLine(1, 8, 2400);

    await pool.query(
      `UPDATE distribution.savdo_tafsilot SET miqdor=3,summa=900 WHERE id=$1`,
      [firstLine],
    );
    const afterCorrection = await pool.query(
      `SELECT savdo_tafsilot_id,SUM(allocated_cost) cost
         FROM distribution.topmart_external_cost_allocations
        GROUP BY savdo_tafsilot_id ORDER BY savdo_tafsilot_id`,
    );
    expect(afterCorrection.rows.map((row) => [
      Number(row.savdo_tafsilot_id), Number(row.cost),
    ])).toEqual([[firstLine, 300], [secondLine, 900]]);

    await pool.query(`DELETE FROM distribution.savdo_tafsilot WHERE id=$1`, [firstLine]);
    expect(Number((await pool.query(
      `SELECT SUM(allocated_cost) cost
         FROM distribution.topmart_external_cost_allocations
        WHERE savdo_tafsilot_id=$1`,
      [secondLine],
    )).rows[0].cost)).toBe(800);
  });

  it("releases cancelled-sale costs and restores them if the sale is reactivated", async () => {
    await receipt(1, 1, "R-1", 10, 10, 1000, "2026-09-01T10:00:00Z");
    const lineId = await saleLine(1, 8, 2400);
    const saleId = Number((await pool.query(
      `SELECT savdo_id FROM distribution.savdo_tafsilot WHERE id=$1`,
      [lineId],
    )).rows[0].savdo_id);
    await pool.query(`UPDATE distribution.savdolar SET status='cancelled' WHERE id=$1`, [saleId]);
    expect(Number((await pool.query(
      `SELECT COUNT(*) count FROM distribution.topmart_external_cost_allocations WHERE savdo_id=$1`,
      [saleId],
    )).rows[0].count)).toBe(0);
    await pool.query(`UPDATE distribution.savdolar SET status='active' WHERE id=$1`, [saleId]);
    expect(Number((await pool.query(
      `SELECT SUM(allocated_cost) cost FROM distribution.topmart_external_cost_allocations WHERE savdo_id=$1`,
      [saleId],
    )).rows[0].cost)).toBe(800);
  });

  it("cannot leave reserved cost when cancellation races a line correction", async () => {
    await receipt(1, 1, "R-1", 10, 10, 1000, "2026-09-01T10:00:00Z");
    const lineId = await saleLine(1, 8, 2400);
    const saleId = Number((await pool.query(
      `SELECT savdo_id FROM distribution.savdo_tafsilot WHERE id=$1`,
      [lineId],
    )).rows[0].savdo_id);
    await Promise.all([
      pool.query(`UPDATE distribution.savdolar SET status='cancelled' WHERE id=$1`, [saleId]),
      pool.query(`UPDATE distribution.savdo_tafsilot SET miqdor=9,summa=2700 WHERE id=$1`, [lineId]),
    ]);
    expect(Number((await pool.query(
      `SELECT COUNT(*) count FROM distribution.topmart_external_cost_allocations WHERE savdo_id=$1`,
      [saleId],
    )).rows[0].count)).toBe(0);
  });

  it("rebuilds cost when a detail moves between active and cancelled sales", async () => {
    await receipt(1, 1, "R-1", 10, 10, 1000, "2026-09-01T10:00:00Z");
    const lineId = await saleLine(1, 5, 1500);
    const originalSaleId = Number((await pool.query(
      `SELECT savdo_id FROM distribution.savdo_tafsilot WHERE id=$1`,
      [lineId],
    )).rows[0].savdo_id);
    const cancelledSaleId = Number((await pool.query(
      `INSERT INTO distribution.savdolar(dokon_id,jami_summa,created_at,status)
       VALUES (1,1500,NOW()::text,'cancelled') RETURNING id`,
    )).rows[0].id);

    await pool.query(
      `UPDATE distribution.savdo_tafsilot SET savdo_id=$1 WHERE id=$2`,
      [cancelledSaleId, lineId],
    );
    expect(Number((await pool.query(
      `SELECT COUNT(*) count FROM distribution.topmart_external_cost_allocations
        WHERE savdo_tafsilot_id=$1`,
      [lineId],
    )).rows[0].count)).toBe(0);

    await pool.query(
      `UPDATE distribution.savdo_tafsilot SET savdo_id=$1 WHERE id=$2`,
      [originalSaleId, lineId],
    );
    expect(Number((await pool.query(
      `SELECT SUM(allocated_cost) cost
         FROM distribution.topmart_external_cost_allocations
        WHERE savdo_tafsilot_id=$1`,
      [lineId],
    )).rows[0].cost)).toBe(500);
  });

  it("serializes concurrent sales so a receipt lot is never over-allocated", async () => {
    await receipt(1, 1, "R-1", 10, 10, 1000, "2026-09-01T10:00:00Z");
    await Promise.all([saleLine(1, 8, 2400), saleLine(1, 8, 2400)]);
    const totals = await pool.query(
      `SELECT SUM(allocated_quantity) quantity,SUM(allocated_cost) cost
         FROM distribution.topmart_external_cost_allocations WHERE receipt_id=1`,
    );
    expect(Number(totals.rows[0].quantity)).toBe(10);
    expect(Number(totals.rows[0].cost)).toBe(1000);
  });
});