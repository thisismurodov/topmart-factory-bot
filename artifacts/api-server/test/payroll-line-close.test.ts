import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// Real Telegram xabarini testdan yubormaymiz.
process.env.TELEGRAM_BOT_TOKEN = "";

const SCHEMA = `topmart_payroll_line_close_${process.pid}_${Date.now()}`;
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
let lineId: number;

async function closeDay(): Promise<{ status: number; json: any }> {
  const res = await fetch(`${apiUrl}/api/payroll/close-day`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return { status: res.status, json: await res.json() };
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await pool.query(`
    CREATE TABLE payroll_role_rates (
      scope TEXT NOT NULL,
      role TEXT NOT NULL,
      rate NUMERIC NOT NULL
    );
    CREATE TABLE production_lines (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE line_role_config (
      id SERIAL PRIMARY KEY,
      line_id INTEGER NOT NULL,
      role_key TEXT NOT NULL,
      label TEXT NOT NULL,
      rate NUMERIC NOT NULL,
      max_workers INTEGER NOT NULL,
      pay_mode TEXT NOT NULL DEFAULT 'pooled'
    );
    CREATE TABLE production_line_workers (
      id SERIAL PRIMARY KEY,
      line_id INTEGER NOT NULL,
      worker_name TEXT NOT NULL,
      role TEXT NOT NULL
    );
    CREATE TABLE products (
      name TEXT PRIMARY KEY,
      rate_type TEXT NOT NULL,
      line_id INTEGER
    );
    CREATE TABLE batches (
      id SERIAL PRIMARY KEY,
      worker TEXT NOT NULL,
      product TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      weight_kg NUMERIC NOT NULL,
      payroll_method TEXT NOT NULL,
      production_line_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE salary_entries (
      id SERIAL PRIMARY KEY,
      scope TEXT NOT NULL,
      line_id INTEGER,
      worker TEXT NOT NULL,
      role TEXT NOT NULL,
      source_type TEXT NOT NULL,
      work_date DATE NOT NULL,
      kg NUMERIC NOT NULL,
      rate NUMERIC NOT NULL,
      amount NUMERIC NOT NULL
    );
    CREATE UNIQUE INDEX salary_entries_daily_shared_uniq
      ON salary_entries (scope, worker, role, work_date)
      WHERE source_type='daily_shared';
    CREATE TABLE daily_payroll_runs (
      id SERIAL PRIMARY KEY,
      scope TEXT NOT NULL,
      line_id INTEGER NOT NULL,
      work_date DATE NOT NULL,
      total_kg NUMERIC NOT NULL,
      status TEXT NOT NULL,
      closed_by TEXT NOT NULL,
      closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (scope, work_date, line_id)
    );
  `);

  const line = await pool.query(
    `INSERT INTO production_lines (name) VALUES ('Arqon Bo''lim 3') RETURNING id`,
  );
  lineId = Number(line.rows[0].id);

  await pool.query(
    `INSERT INTO line_role_config
       (line_id, role_key, label, rate, max_workers, pay_mode)
     VALUES
       ($1, 'IShlabchiqaruvchi', 'Chiqaruvchi', 1125, 5, 'individual'),
       ($1, 'pock', 'Pochkalash', 750, 2, 'pooled'),
       ($1, 'Uvopchi', 'Ip O''rovchi', 375, 5, 'pooled')`,
    [lineId],
  );
  await pool.query(
    `INSERT INTO production_line_workers (line_id, worker_name, role)
     VALUES
       ($1, 'Aziza', 'IShlabchiqaruvchi'),
       ($1, 'Gullola', 'IShlabchiqaruvchi'),
       ($1, 'Xusnida', 'IShlabchiqaruvchi'),
       ($1, 'Dilnoza', 'pock'),
       ($1, 'Madina M', 'pock'),
       ($1, 'Zulxumor', 'Uvopchi')`,
    [lineId],
  );
  await pool.query(
    `INSERT INTO products (name, rate_type, line_id)
     VALUES ('Ikki Qavat Arqon | 4 kg', 'kg', $1)`,
    [lineId],
  );
  await pool.query(
    `INSERT INTO batches
       (worker, product, quantity, weight_kg, payroll_method,
        production_line_id, created_at)
     VALUES
       ('Aziza', 'Ikki Qavat Arqon | 4 kg', 1, 55.60, 'ROLE_BASED_KG', $1, NOW()),
       ('Gullola', 'Ikki Qavat Arqon | 4 kg', 1, 46.60, 'ROLE_BASED_KG', $1, NOW()),
       ('Xusnida', 'Ikki Qavat Arqon | 4 kg', 1, 5.95, 'ROLE_BASED_KG', $1, NOW())`,
    [lineId],
  );

  const { default: payrollRouter } = await import("../src/routes/payroll");
  const app = express();
  app.use(express.json());
  app.use("/api", payrollRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }
});

describe("POST /payroll/close-day — individual producers and pooled helpers", () => {
  it("writes exact per-worker pay once and returns the frozen snapshot on rerun", async () => {
    const first = await closeDay();
    expect(first.status).toBe(200);
    expect(first.json.alreadyClosed).toBe(false);
    expect(first.json.totalKg).toBeCloseTo(108.15, 6);
    expect(first.json.newEntryCount).toBe(6);

    const { rows } = await pool.query(
      `SELECT worker, role, kg, rate, amount
       FROM salary_entries ORDER BY role, worker`,
    );
    expect(rows).toHaveLength(6);
    const byKey = new Map(rows.map((r) => [`${r.role}::${r.worker}`, r]));

    const expected: Record<string, { kg: number; rate: number; amount: number }> = {
      "IShlabchiqaruvchi::Aziza": { kg: 55.60, rate: 1125, amount: 55.60 * 1125 },
      "IShlabchiqaruvchi::Gullola": { kg: 46.60, rate: 1125, amount: 46.60 * 1125 },
      "IShlabchiqaruvchi::Xusnida": { kg: 5.95, rate: 1125, amount: 5.95 * 1125 },
      "pock::Dilnoza": { kg: 108.15, rate: 750, amount: 108.15 * 750 / 2 },
      "pock::Madina M": { kg: 108.15, rate: 750, amount: 108.15 * 750 / 2 },
      "Uvopchi::Zulxumor": { kg: 108.15, rate: 375, amount: 108.15 * 375 },
    };
    expect([...byKey.keys()].sort()).toEqual(Object.keys(expected).sort());
    for (const [key, value] of Object.entries(expected)) {
      const row = byKey.get(key);
      expect(Number(row.kg)).toBeCloseTo(value.kg, 6);
      expect(Number(row.rate)).toBeCloseTo(value.rate, 6);
      expect(Number(row.amount)).toBeCloseTo(value.amount, 6);
    }

    await pool.query(`UPDATE line_role_config SET rate=9999`);
    await pool.query(
      `INSERT INTO batches
         (worker, product, quantity, weight_kg, payroll_method,
          production_line_id, created_at)
       VALUES ('Aziza', 'Ikki Qavat Arqon | 4 kg', 1, 10,
               'ROLE_BASED_KG', $1, NOW())`,
      [lineId],
    );

    const second = await closeDay();
    expect(second.status).toBe(200);
    expect(second.json.alreadyClosed).toBe(true);
    expect(second.json.newEntryCount).toBe(0);
    expect(second.json.totalKg).toBeCloseTo(108.15, 6);

    const counts = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM salary_entries) AS entries,
         (SELECT COUNT(*)::int FROM daily_payroll_runs) AS runs`,
    );
    expect(counts.rows[0]).toEqual({ entries: 6, runs: 1 });
    const aziza = await pool.query(
      `SELECT amount FROM salary_entries
       WHERE worker='Aziza' AND role='IShlabchiqaruvchi'`,
    );
    expect(Number(aziza.rows[0].amount)).toBeCloseTo(55.60 * 1125, 6);

    // Partial/legacy state: salary row exists but its daily run does not.
    // ON CONFLICT must not report or notify this row as newly inserted.
    const conflictLine = await pool.query(
      `INSERT INTO production_lines (name) VALUES ('Conflict liniya') RETURNING id`,
    );
    const conflictLineId = Number(conflictLine.rows[0].id);
    await pool.query(
      `INSERT INTO line_role_config
         (line_id, role_key, label, rate, max_workers, pay_mode)
       VALUES ($1, 'producer', 'Chiqaruvchi', 1000, 1, 'individual')`,
      [conflictLineId],
    );
    await pool.query(
      `INSERT INTO production_line_workers (line_id, worker_name, role)
       VALUES ($1, 'Conflict Worker', 'producer')`,
      [conflictLineId],
    );
    await pool.query(
      `INSERT INTO products (name, rate_type, line_id)
       VALUES ('Conflict mahsulot', 'kg', $1)`,
      [conflictLineId],
    );
    await pool.query(
      `INSERT INTO batches
         (worker, product, quantity, weight_kg, payroll_method,
          production_line_id, created_at)
       VALUES ('Conflict Worker', 'Conflict mahsulot', 1, 7,
               'ROLE_BASED_KG', $1, NOW())`,
      [conflictLineId],
    );
    await pool.query(
      `INSERT INTO salary_entries
         (scope, line_id, worker, role, source_type, work_date, kg, rate, amount)
       VALUES ('arqon', $1, 'Conflict Worker', 'producer',
               'daily_shared', $2, 7, 1000, 7000)`,
      [conflictLineId, first.json.workDate],
    );

    const conflict = await closeDay();
    expect(conflict.status).toBe(200);
    expect(conflict.json.alreadyClosed).toBe(false);
    expect(conflict.json.newEntryCount).toBe(0);
    const conflictResult = conflict.json.lines.find(
      (line: any) => line.lineId === conflictLineId,
    );
    expect(conflictResult.entries).toEqual([]);
    const conflictCounts = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM salary_entries) AS entries,
         (SELECT COUNT(*)::int FROM daily_payroll_runs) AS runs`,
    );
    expect(conflictCounts.rows[0]).toEqual({ entries: 7, runs: 2 });
  });
});