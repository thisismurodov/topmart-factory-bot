import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// ── Isolation ──────────────────────────────────────────────────────────────
// Throwaway schema per run (pid+timestamp) so parallel validations never
// collide — see wip-negative-alert.test.ts for the pattern.
const SCHEMA = `topmart_packer_empty_alert_test_${process.pid}_${Date.now()}`;

const baseUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL must be set to run these tests");
{
  const u = new URL(baseUrl);
  u.searchParams.set("options", `-c search_path=${SCHEMA}`);
  delete process.env.RAILWAY_DATABASE_URL;
  process.env.DATABASE_URL = u.toString();
}

// Real Telegramga chiqib ketmasin: soxta server + test token.
process.env.TELEGRAM_BOT_TOKEN = "test-token";
delete process.env.ADMIN_CHAT_ID;

let pool: Pool;
let server: Server;
let apiUrl: string;
let tgServer: Server;

const ADMIN_CHAT_1 = "111111";
const ADMIN_CHAT_2 = "222222";

// Soxta Telegram API — kelgan sendMessage so'rovlarini yig'adi.
const sent: { chat_id: string; text: string }[] = [];

async function patchProduct(name: string, body: unknown): Promise<number> {
  const r = await fetch(`${apiUrl}/products/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.status;
}

// Yuborish fire-and-forget — stub'ga xabar kelishini qisqa poll bilan kutamiz.
async function waitForSends(count: number, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (sent.length < count && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);

  await pool.query(`
    CREATE TABLE products (
      cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      roll_length_m NUMERIC(12,2) NOT NULL DEFAULT 0,
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      sku           TEXT NOT NULL DEFAULT '',
      unit_type     TEXT NOT NULL DEFAULT 'dona',
      currency_type TEXT NOT NULL DEFAULT 'UZS',
      default_sale_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      weight        NUMERIC(12,3) NOT NULL DEFAULT 1,
      minimum_stock INTEGER NOT NULL DEFAULT 0,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      in_sales      BOOLEAN NOT NULL DEFAULT FALSE,
      in_production BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE workers (
      name TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'worker'
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
  `);

  await pool.query(
    `INSERT INTO user_roles (chat_id, worker_name, role) VALUES
       ($1, 'Admin Bir', 'admin'),
       ($2, 'Admin Ikki', 'admin'),
       (333333, 'Oddiy Ishchi', 'worker')`,
    [ADMIN_CHAT_1, ADMIN_CHAT_2],
  );

  // Soxta Telegram API server
  const tgApp = express();
  tgApp.use(express.json());
  tgApp.post("/bottest-token/sendMessage", (req, res) => {
    sent.push({ chat_id: String(req.body.chat_id), text: String(req.body.text) });
    res.json({ ok: true });
  });
  await new Promise<void>((resolve) => {
    tgServer = tgApp.listen(0, "127.0.0.1", resolve);
  });
  process.env.TELEGRAM_API_BASE =
    `http://127.0.0.1:${(tgServer.address() as AddressInfo).port}`;

  const { default: productsRouter } = await import("../src/routes/products");
  const app = express();
  app.use(express.json());
  app.use(productsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await pool.query(`TRUNCATE packer_product_assignments RESTART IDENTITY`);
  await pool.query(`DELETE FROM products`);
  await pool.query(`DELETE FROM workers`);
  await pool.query(
    `INSERT INTO products (name, active) VALUES
       ('Arqon 4mm', TRUE), ('Arqon 6mm', TRUE)`,
  );
  await pool.query(
    `INSERT INTO workers (name, role) VALUES
       ('PackerSolo','packer'), ('PackerRich','packer')`,
  );
  await pool.query(
    `INSERT INTO packer_product_assignments (packer_name, product_name) VALUES
       ('PackerSolo','Arqon 4mm'),
       ('PackerRich','Arqon 4mm'), ('PackerRich','Arqon 6mm')`,
  );
  sent.length = 0;
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (tgServer) await new Promise<void>((r) => tgServer.close(() => r()));
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }
});

describe("packersLeftWithoutProducts helper", () => {
  it("returns only packers whose active-assigned count dropped to zero", async () => {
    await pool.query(`UPDATE products SET active = FALSE WHERE name = 'Arqon 4mm'`);
    const { packersLeftWithoutProducts } = await import("../src/lib/packerAlerts");
    expect(await packersLeftWithoutProducts("Arqon 4mm")).toEqual(["PackerSolo"]);
  });

  it("returns empty when every assigned packer still has an active product", async () => {
    await pool.query(`UPDATE products SET active = FALSE WHERE name = 'Arqon 6mm'`);
    const { packersLeftWithoutProducts } = await import("../src/lib/packerAlerts");
    expect(await packersLeftWithoutProducts("Arqon 6mm")).toEqual([]);
  });
});

describe("PATCH /products/:name active=false — packer empty-list alert", () => {
  it("notifies each admin naming the packer left without products", async () => {
    expect(await patchProduct("Arqon 4mm", { active: false })).toBe(200);
    await waitForSends(2);

    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((s) => s.chat_id))).toEqual(
      new Set([ADMIN_CHAT_1, ADMIN_CHAT_2]),
    );
    for (const s of sent) {
      expect(s.text).toContain("Arqon 4mm");
      expect(s.text).toContain("PackerSolo");
      expect(s.text).not.toContain("PackerRich");
    }
  });

  it("sends nothing when no packer is left empty", async () => {
    expect(await patchProduct("Arqon 6mm", { active: false })).toBe(200);
    await waitForSends(1, 700);
    expect(sent).toHaveLength(0);
  });

  it("does not re-alert when an already-inactive product is patched again", async () => {
    expect(await patchProduct("Arqon 4mm", { active: false })).toBe(200);
    await waitForSends(2);
    expect(sent).toHaveLength(2);

    expect(await patchProduct("Arqon 4mm", { active: false })).toBe(200);
    await waitForSends(3, 700);
    expect(sent).toHaveLength(2); // yangi xabar yo'q
  });

  it("does not alert on unrelated field updates", async () => {
    expect(await patchProduct("Arqon 4mm", { minimumStock: 5 })).toBe(200);
    await waitForSends(1, 500);
    expect(sent).toHaveLength(0);
  });
});
