import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// ── Isolation ──────────────────────────────────────────────────────────────
// Throwaway schema per run so we never touch real assignments.
const SCHEMA = `topmart_packer_assign_test_${process.pid}_${Date.now()}`;

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

const PACKER = "Test Packer";
const OTHER_PACKER = "Boshqa Packer";

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function storedRows(packer: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT product_name FROM packer_product_assignments WHERE packer_name=$1 ORDER BY product_name`,
    [packer],
  );
  return rows.map((r: any) => r.product_name);
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);

  // Minimal copies of the tables the router touches.
  await pool.query(`
    CREATE TABLE workers (
      name   TEXT PRIMARY KEY,
      prefix TEXT NOT NULL DEFAULT '',
      phone  TEXT NOT NULL DEFAULT '',
      role   TEXT NOT NULL DEFAULT 'worker'
    );
    CREATE TABLE products (
      cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      name      TEXT PRIMARY KEY,
      id        SERIAL UNIQUE,
      unit_type TEXT NOT NULL DEFAULT 'dona',
      rate      NUMERIC(12,2) NOT NULL DEFAULT 100,
      rate_type TEXT NOT NULL DEFAULT 'dona',
      active    BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE packer_product_assignments (
      id           SERIAL PRIMARY KEY,
      packer_name  TEXT NOT NULL REFERENCES workers(name) ON DELETE CASCADE,
      product_name TEXT NOT NULL REFERENCES products(name) ON DELETE CASCADE,
      UNIQUE (packer_name, product_name)
    );
    CREATE TABLE user_roles (
      chat_id     BIGINT PRIMARY KEY,
      worker_name TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'worker'
    );
    CREATE TABLE packer_assignments (
      packer_chat_id BIGINT NOT NULL,
      worker_name    TEXT   NOT NULL,
      PRIMARY KEY (packer_chat_id, worker_name)
    );
  `);

  await pool.query(
    `INSERT INTO workers (name, role) VALUES ($1,'packer'), ($2,'packer'), ('Oddiy Ishchi','worker')`,
    [PACKER, OTHER_PACKER],
  );
  await pool.query(`
    INSERT INTO products (name, unit_type, active) VALUES
      ('Arqon 5mm', 'kg',   TRUE),
      ('Arqon 8mm', 'kg',   TRUE),
      ('Qop 50kg',  'dona', TRUE),
      ('Eski mahsulot', 'dona', FALSE)
  `);

  const { default: router } = await import("../src/routes/packer-product-assignments");
  const app = express();
  app.use(express.json());
  app.use(router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await pool.query(`TRUNCATE packer_product_assignments RESTART IDENTITY`);
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }
});

describe("packer product assignments API (dashboard surface)", () => {
  it("GET /packer-assignments lists every packer, with empty products when unrestricted", async () => {
    const res = await api("GET", "/packer-assignments");
    expect(res.status).toBe(200);
    const names = res.json.map((p: any) => p.packerName).sort();
    expect(names).toEqual([OTHER_PACKER, PACKER].sort());
    for (const p of res.json) expect(p.products).toEqual([]);
    // non-packer workers are not listed
    expect(res.json.find((p: any) => p.packerName === "Oddiy Ishchi")).toBeUndefined();
  });

  it("PUT /packer-assignments/:packerName replaces the full list (same semantics as bot set_packer_products)", async () => {
    let res = await api("PUT", `/packer-assignments/${encodeURIComponent(PACKER)}`, {
      productNames: ["Arqon 5mm", "Qop 50kg"],
    });
    expect(res.status).toBe(200);
    expect(res.json.count).toBe(2);
    expect(await storedRows(PACKER)).toEqual(["Arqon 5mm", "Qop 50kg"]);

    // Second PUT fully replaces, not appends.
    res = await api("PUT", `/packer-assignments/${encodeURIComponent(PACKER)}`, {
      productNames: ["Arqon 8mm"],
    });
    expect(res.status).toBe(200);
    expect(await storedRows(PACKER)).toEqual(["Arqon 8mm"]);
  });

  it("PUT with an empty list clears all rows → bot falls back to all active products", async () => {
    await api("PUT", `/packer-assignments/${encodeURIComponent(PACKER)}`, {
      productNames: ["Arqon 5mm"],
    });
    const res = await api("PUT", `/packer-assignments/${encodeURIComponent(PACKER)}`, {
      productNames: [],
    });
    expect(res.status).toBe(200);
    expect(res.json.count).toBe(0);
    expect(await storedRows(PACKER)).toEqual([]);
  });

  it("PUT does not disturb another packer's assignments", async () => {
    await api("PUT", `/packer-assignments/${encodeURIComponent(OTHER_PACKER)}`, {
      productNames: ["Qop 50kg"],
    });
    await api("PUT", `/packer-assignments/${encodeURIComponent(PACKER)}`, {
      productNames: ["Arqon 5mm"],
    });
    expect(await storedRows(OTHER_PACKER)).toEqual(["Qop 50kg"]);
  });

  it("PUT tolerates duplicate names in the payload (unique constraint, ON CONFLICT)", async () => {
    const res = await api("PUT", `/packer-assignments/${encodeURIComponent(PACKER)}`, {
      productNames: ["Arqon 5mm", "Arqon 5mm"],
    });
    expect(res.status).toBe(200);
    expect(await storedRows(PACKER)).toEqual(["Arqon 5mm"]);
  });

  it("PUT rejects a missing/invalid productNames body with 400", async () => {
    const res = await api("PUT", `/packer-assignments/${encodeURIComponent(PACKER)}`, {
      productNames: "Arqon 5mm",
    });
    expect(res.status).toBe(400);
  });

  it("PUT with an unknown product fails the whole transaction (FK) and leaves prior rows intact", async () => {
    await api("PUT", `/packer-assignments/${encodeURIComponent(PACKER)}`, {
      productNames: ["Arqon 5mm"],
    });
    const res = await api("PUT", `/packer-assignments/${encodeURIComponent(PACKER)}`, {
      productNames: ["Arqon 8mm", "Yo'q mahsulot"],
    });
    expect(res.status).toBe(500);
    // rolled back — old assignment untouched
    expect(await storedRows(PACKER)).toEqual(["Arqon 5mm"]);
  });

  it("GET /packer-assignments reflects saved rows including inactive products (raw stored view, like the bot admin panel)", async () => {
    await api("PUT", `/packer-assignments/${encodeURIComponent(PACKER)}`, {
      productNames: ["Arqon 5mm", "Eski mahsulot"],
    });
    const res = await api("GET", "/packer-assignments");
    const row = res.json.find((p: any) => p.packerName === PACKER);
    expect(row.products.map((x: any) => x.productName)).toEqual(["Arqon 5mm", "Eski mahsulot"]);
  });

  it("POST + DELETE toggle a single assignment", async () => {
    let res = await api("POST", "/packer-assignments", { packerName: PACKER, productName: "Qop 50kg" });
    expect(res.status).toBe(201);
    expect(await storedRows(PACKER)).toEqual(["Qop 50kg"]);

    res = await api("DELETE", "/packer-assignments", { packerName: PACKER, productName: "Qop 50kg" });
    expect(res.status).toBe(200);
    expect(await storedRows(PACKER)).toEqual([]);
  });
});
