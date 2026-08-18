import { beforeAll, afterAll, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

// ── Isolation ──────────────────────────────────────────────────────────────
// Har bir run uchun throwaway sxema — real katalogga tegilmaydi.
const SCHEMA = `topmart_sku_suggest_test_${process.pid}_${Date.now()}`;

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

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

function sugg(name?: string, exclude?: string): string {
  const qs = new URLSearchParams();
  if (name !== undefined) qs.set("name", name);
  if (exclude !== undefined) qs.set("exclude", exclude);
  return `/products/sku-suggest?${qs.toString()}`;
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);

  // Prod strukturaning aynan nusxasi (ustunlar + default + indekslar, jumladan
  // idx_products_sku_unique partial-unique indeksi ham o'z nomi bilan ko'chadi).
  // FK'lar LIKE bilan ko'chmaydi — test uchun ayni muddao.
  await pool.query(`CREATE TABLE products (LIKE public.products INCLUDING ALL)`);

  // Ikkita bo'sh-SKU qator — partial indeks predikati ('' istisno) ko'chganini
  // ham bilvosita isbotlaydi (aks holda shu INSERT'ning o'zi 23505 berardi).
  await pool.query(`
    INSERT INTO products (name, sku) VALUES
      ('Sinov Arqon', 'SINOV-ARQON'),
      ('Sinov Qop',   'SINOV-QOP'),
      ('Bosh Sku A',  ''),
      ('Bosh Sku B',  '')
  `);

  const { default: router } = await import("../src/routes/products");
  const app = express();
  app.use(express.json());
  app.use(router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }
});

describe("GET /products/sku-suggest", () => {
  it("bo'sh nomda 400 qaytaradi", async () => {
    const r = await api("GET", sugg());
    expect(r.status).toBe(400);
  });

  it("band bo'lmagan nomdan bazaviy SKU yasaydi", async () => {
    const r = await api("GET", sugg("Yangi Sinov Mahsulot"));
    expect(r.status).toBe(200);
    expect(r.json.sku).toBe("YANGI-SINOV-MAHSULOT");
  });

  it("apostrof va maxsus belgilarni tozalaydi", async () => {
    const r = await api("GET", sugg("Po'kak  Sinov 6 mm"));
    expect(r.status).toBe(200);
    expect(r.json.sku).toBe("POKAK-SINOV-6-MM");
  });

  it("band SKU'ga -2 suffiks qo'shadi", async () => {
    const r = await api("GET", sugg("Sinov Arqon"));
    expect(r.status).toBe(200);
    expect(r.json.sku).toBe("SINOV-ARQON-2");
  });

  it("exclude=o'zi bo'lsa o'z SKU'sini band deb hisoblamaydi (tahrirlash)", async () => {
    const r = await api("GET", sugg("Sinov Arqon", "Sinov Arqon"));
    expect(r.status).toBe(200);
    expect(r.json.sku).toBe("SINOV-ARQON");
  });

  it("exclude=boshqa mahsulot bo'lsa suffiks saqlanadi", async () => {
    const r = await api("GET", sugg("Sinov Arqon", "Sinov Qop"));
    expect(r.status).toBe(200);
    expect(r.json.sku).toBe("SINOV-ARQON-2");
  });
});

describe("PATCH /products/:name SKU to'qnashuvi", () => {
  it("band SKU'da 500 emas, tushunarli 409 qaytaradi va qiymat o'zgarmaydi", async () => {
    const r = await api("PATCH", `/products/${encodeURIComponent("Sinov Qop")}`, { sku: "SINOV-ARQON" });
    expect(r.status).toBe(409);
    expect(String(r.json?.error ?? "")).toContain("SINOV-ARQON");
    expect(String(r.json?.error ?? "")).toContain("allaqachon");

    const { rows } = await pool.query(`SELECT sku FROM products WHERE name='Sinov Qop'`);
    expect(rows[0].sku).toBe("SINOV-QOP");
  });

  it("kichik harfda yuborilgan band SKU ham normalizatsiyadan keyin 409 bo'ladi", async () => {
    const r = await api("PATCH", `/products/${encodeURIComponent("Sinov Qop")}`, { sku: "sinov-arqon" });
    expect(r.status).toBe(409);
  });
});
