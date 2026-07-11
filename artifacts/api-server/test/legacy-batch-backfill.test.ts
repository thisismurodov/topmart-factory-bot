import { beforeAll, afterAll, describe, it, expect } from "vitest";
import express from "express";
import type { Express } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

// ─────────────────────────────────────────────────────────────────────────────
// Legacy batch raw-consumption backfill test.
//
// Batches created BEFORE movement logging deducted raw stock silently (no
// stock_movements row). API initDb() now reconstructs those OUT/raw rows from
// batches × product_materials (BOM), stamped with the batch's created_at.
// This suite verifies on a throwaway DB that:
//   1. a legacy batch (no movement row) gets exactly one backfilled OUT row
//      per BOM material, with the right quantity/note/timestamp
//   2. batches that already logged their consumption are skipped
//   3. re-running initDb() inserts nothing (idempotent)
//   4. GET /ombor/movements returns a chronological timeline with correct
//      running balances that include the backfilled rows
// ─────────────────────────────────────────────────────────────────────────────

const { Client } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

// Unique throwaway DB name per run (parallel validations must not collide).
const TMP_DB = `topmart_backfill_test_${process.pid}_${Date.now()}`;
const ssl = { rejectUnauthorized: false } as const;

function tmpUrl(extraParams = false): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${TMP_DB}`;
  if (extraParams) u.searchParams.set("sslmode", "require");
  return u.toString();
}

let pool: pg.Pool;
let server: Server;
let apiUrl: string;
let initDbFn: () => Promise<void>;

const here = path.dirname(fileURLToPath(import.meta.url));
const botDir = path.resolve(here, "../../telegram-bot");

const MATERIAL = "Backfill Polipropilen";
const PRODUCT = "Backfill Arqon";
const LEGACY_CODE = "BF-250101-01";
const LOGGED_CODE = "BF-250601-01";
const LEGACY_AT = "2025-01-01T10:00:00Z";
const LOGGED_AT = "2025-06-01T10:00:00Z";

// Multi-item batch session: two products under ONE batch_code, where only one
// item's consumption was logged. The other item must still be backfilled
// (idempotency is per batch row + material, NOT per batch code).
const MATERIAL2 = "Backfill Kanop";
const PRODUCT2 = "Backfill Shpagat";
const PRODUCT3 = "Backfill Kanat";
const MIXED_CODE = "BF-250301-01";
const MIXED_AT = "2025-03-01T10:00:00Z";

async function dropTmpDb(): Promise<void> {
  const admin = new Client({ connectionString: adminUrl, ssl });
  await admin.connect();
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [TMP_DB],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${TMP_DB}`);
  await admin.end();
}

beforeAll(async () => {
  await dropTmpDb();
  {
    const admin = new Client({ connectionString: adminUrl, ssl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${TMP_DB}`);
    await admin.end();
  }

  // Bot init_db creates the bot-owned tables (batches, raw_materials,
  // product_materials, …) exactly like production.
  execFileSync("python3", ["-c", "from bot.database import init_db; init_db()"], {
    cwd: botDir,
    env: { ...process.env, DATABASE_URL: tmpUrl(true) },
    stdio: "pipe",
  });

  process.env.RAILWAY_DATABASE_URL = tmpUrl(false);
  const db = await import("@workspace/db");
  pool = db.pool as unknown as pg.Pool;

  // ── Seed the "pre-update" world BEFORE the API initDb backfill runs ────────
  // A raw material + product + BOM (2.5 units of material per piece).
  await pool.query(
    `INSERT INTO raw_materials (name, unit, unit_type, default_cost, currency, current_stock, minimum_stock)
     VALUES ($1, 'kg', 'kg', 0, 'UZS', 100, 0)`,
    [MATERIAL],
  );
  await pool.query(
    `INSERT INTO products (name, active) VALUES ($1, TRUE) ON CONFLICT (name) DO NOTHING`,
    [PRODUCT],
  );
  await pool.query(
    `INSERT INTO product_materials (product_name, raw_material_id, quantity_required)
     VALUES ($1, (SELECT id FROM raw_materials WHERE name = $2), 2.5)`,
    [PRODUCT, MATERIAL],
  );
  // Legacy batch: deducted stock silently — NO stock_movements row.
  await pool.query(
    `INSERT INTO batches (batch_code, worker, product, quantity, weight_kg, created_at)
     VALUES ($1, 'Backfill Tester', $2, 10, 0, $3)`,
    [LEGACY_CODE, PRODUCT, LEGACY_AT],
  );
  // New-style batch: its consumption row was written by the bot at creation.
  await pool.query(
    `INSERT INTO batches (batch_code, worker, product, quantity, weight_kg, created_at)
     VALUES ($1, 'Backfill Tester', $2, 4, 0, $3)`,
    [LOGGED_CODE, PRODUCT, LOGGED_AT],
  );
  await pool.query(
    `INSERT INTO stock_movements (product, quantity, movement_type, note, created_by, product_type, created_at)
     VALUES ($1, 10, 'OUT', $2, 'Backfill Tester', 'raw', $3)`,
    [MATERIAL, `Ishlab chiqarish: ${LOGGED_CODE} (${PRODUCT} × 4)`, LOGGED_AT],
  );

  // Mixed multi-item session under ONE batch_code: PRODUCT2 item already
  // logged its consumption, PRODUCT3 item did not (legacy).
  await pool.query(
    `INSERT INTO raw_materials (name, unit, unit_type, default_cost, currency, current_stock, minimum_stock)
     VALUES ($1, 'kg', 'kg', 0, 'UZS', 50, 0)`,
    [MATERIAL2],
  );
  await pool.query(
    `INSERT INTO products (name, active) VALUES ($1, TRUE), ($2, TRUE) ON CONFLICT (name) DO NOTHING`,
    [PRODUCT2, PRODUCT3],
  );
  await pool.query(
    `INSERT INTO product_materials (product_name, raw_material_id, quantity_required)
     VALUES ($1, (SELECT id FROM raw_materials WHERE name = $3), 1.5),
            ($2, (SELECT id FROM raw_materials WHERE name = $3), 3)`,
    [PRODUCT2, PRODUCT3, MATERIAL2],
  );
  await pool.query(
    `INSERT INTO batches (batch_code, worker, product, quantity, weight_kg, created_at)
     VALUES ($1, 'Backfill Tester', $2, 6, 0, $4),
            ($1, 'Backfill Tester', $3, 2, 0, $4)`,
    [MIXED_CODE, PRODUCT2, PRODUCT3, MIXED_AT],
  );
  await pool.query(
    `INSERT INTO stock_movements (product, quantity, movement_type, note, created_by, product_type, created_at)
     VALUES ($1, 9, 'OUT', $2, 'Backfill Tester', 'raw', $3)`,
    [MATERIAL2, `Ishlab chiqarish: ${MIXED_CODE} (${PRODUCT2} × 6)`, MIXED_AT],
  );

  // ── Run the real API initDb (includes the backfill) ────────────────────────
  const mod = await import("../src/init-db");
  initDbFn = mod.initDb;
  await initDbFn();

  // Mount the ombor router to verify the timeline endpoint.
  const omborRouter = (await import("../src/routes/ombor")).default;
  const { default: pinoHttp } = await import("pino-http");
  const app: Express = express();
  app.use(pinoHttp({ logger: (await import("../src/lib/logger")).logger }));
  app.use(express.json());
  app.use(omborRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) await pool.end();
  process.env.RAILWAY_DATABASE_URL = adminUrl;
  await dropTmpDb();
}, 60_000);

async function movementRows(): Promise<any[]> {
  const { rows } = await pool.query(
    `SELECT product, quantity, movement_type, note, created_by, product_type, created_at
       FROM stock_movements
      WHERE product_type = 'raw' AND movement_type = 'OUT'
      ORDER BY created_at, id`,
  );
  return rows;
}

describe("Legacy batch raw-consumption backfill", () => {
  it("backfills exactly one OUT row for the legacy batch with BOM quantity and batch timestamp", async () => {
    const rows = await movementRows();
    const legacy = rows.filter((r) => String(r.note).startsWith(`Ishlab chiqarish: ${LEGACY_CODE} (`));
    expect(legacy).toHaveLength(1);
    expect(legacy[0].product).toBe(MATERIAL);
    expect(Number(legacy[0].quantity)).toBeCloseTo(25, 3); // 2.5 × 10
    expect(legacy[0].created_by).toBe("Backfill Tester");
    expect(new Date(legacy[0].created_at).toISOString()).toBe(new Date(LEGACY_AT).toISOString());
  });

  it("does not duplicate consumption for batches that already logged a movement", async () => {
    const rows = await movementRows();
    const logged = rows.filter((r) => String(r.note).startsWith(`Ishlab chiqarish: ${LOGGED_CODE} (`));
    expect(logged).toHaveLength(1); // only the pre-existing row
    expect(Number(logged[0].quantity)).toBeCloseTo(10, 3);
  });

  it("backfills the unlogged item of a multi-item session sharing one batch_code", async () => {
    const rows = await movementRows();
    const mixed = rows.filter((r) => String(r.note).startsWith(`Ishlab chiqarish: ${MIXED_CODE} (`));
    // PRODUCT2 item: only the pre-existing logged row (no duplicate).
    const p2 = mixed.filter((r) => String(r.note).includes(PRODUCT2));
    expect(p2).toHaveLength(1);
    expect(Number(p2[0].quantity)).toBeCloseTo(9, 3);
    // PRODUCT3 item: backfilled despite the shared batch_code.
    const p3 = mixed.filter((r) => String(r.note).includes(PRODUCT3));
    expect(p3).toHaveLength(1);
    expect(p3[0].product).toBe(MATERIAL2);
    expect(Number(p3[0].quantity)).toBeCloseTo(6, 3); // 3 × 2
    expect(new Date(p3[0].created_at).toISOString()).toBe(new Date(MIXED_AT).toISOString());
  });

  it("is idempotent — re-running initDb() inserts nothing new", async () => {
    const before = (await movementRows()).length;
    await initDbFn();
    const after = (await movementRows()).length;
    expect(after).toBe(before);
  });

  it("GET /ombor/movements shows a chronological timeline with correct running balances", async () => {
    const r = await fetch(`${apiUrl}/ombor/movements?type=raw&product=${encodeURIComponent(MATERIAL)}`);
    expect(r.status).toBe(200);
    const rows: any[] = await r.json();
    expect(rows.length).toBe(2);

    // Newest-first by created_at (backfilled rows have high ids but old
    // timestamps — ordering must follow the timestamp, not the id).
    expect(new Date(rows[0].createdAt).getTime()).toBeGreaterThan(new Date(rows[1].createdAt).getTime());
    expect(rows[0].note).toContain(LOGGED_CODE);
    expect(rows[1].note).toContain(LEGACY_CODE);

    // Balance walk anchors the newest row at current_stock (100) and walks
    // back: before the newest OUT 10 the stock was 110.
    expect(rows[0].balanceAfter).toBeCloseTo(100, 3);
    expect(rows[1].balanceAfter).toBeCloseTo(110, 3);
  });
});
