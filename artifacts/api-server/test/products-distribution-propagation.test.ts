import { beforeAll, afterAll, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";

// ─────────────────────────────────────────────────────────────────────────────
// ERP → savdo bot narx sinxronizatsiyasi (propagateToDistribution) guard testi.
//
// PATCH /products/:name public.products'ni yangilagach, SKU orqali bog'langan
// distribution.mahsulotlar qatoriga nomi/narx'ni uzatadi. Bu query ikkala
// sxemani TO'LIQ nom bilan (public.products, distribution.mahsulotlar)
// ishlatgani uchun search_path izolyatsiyasi ish bermaydi — shuning uchun
// throwaway DATABASE yaratamiz (pid+timestamp bilan unikal, parallel
// validation'lar bir-birini o'chirmasligi uchun) va unda ikkala sxemaning
// minimal nusxalarini ko'taramiz.
//
// Tekshiriladi:
//   1. UZS mahsulot PATCH → mahsulotlar.narx ROUND(narx) va nomi yangilanadi
//   2. USD mahsulot PATCH → nomi yangilanadi, lekin narx TEGILMAYDI
//   3. SKU bog'lanmagan mahsulot PATCH → mahsulotlar'da hech narsa o'zgarmaydi
//   4. POST'da band SKU → 409 (boshqa mahsulot buzilmaydi)
//   5. POST upsert (mavjud nom) → mavjud SKU SAQLANADI, yangi narx propagate
// ─────────────────────────────────────────────────────────────────────────────

const { Client } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

const TMP_DB = `topmart_price_prop_${process.pid}_${Date.now()}`;
const ssl = { rejectUnauthorized: false } as const;

function tmpUrl(): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${TMP_DB}`;
  return u.toString();
}

let pool: pg.Pool;
let server: Server;
let apiUrl: string;

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

async function patch(name: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}/products/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function post(body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}/products`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function mahsulot(sku: string): Promise<{ nomi: string; narx: number } | null> {
  const { rows } = await pool.query(
    `SELECT nomi, narx FROM distribution.mahsulotlar WHERE sku = $1`,
    [sku],
  );
  return rows.length ? { nomi: rows[0].nomi, narx: Number(rows[0].narx) } : null;
}

beforeAll(async () => {
  await dropTmpDb();
  {
    const admin = new Client({ connectionString: adminUrl, ssl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${TMP_DB}`);
    await admin.end();
  }

  // lib/db RAILWAY_DATABASE_URL'ni afzal ko'radi va u uchun SSL yoqadi —
  // throwaway DB o'sha serverda, shuning uchun uni ko'rsatamiz.
  process.env.RAILWAY_DATABASE_URL = tmpUrl();
  process.env.DATABASE_URL = tmpUrl();

  const db = await import("@workspace/db");
  pool = db.pool as unknown as pg.Pool;

  // Minimal sxema nusxalari: routes/products.ts POST/PATCH tegadigan ustunlar
  // + prod'dagi kabi partial unique SKU indeksi (409 yo'li shu indeks nomiga
  // bog'liq) + distribution.mahsulotlar'ning propagate tegadigan ustunlari.
  await pool.query(`
    CREATE TABLE public.products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      sku TEXT NOT NULL DEFAULT '',
      unit_type TEXT NOT NULL DEFAULT 'dona',
      currency_type TEXT NOT NULL DEFAULT 'UZS',
      default_sale_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      weight NUMERIC(12,3) NOT NULL DEFAULT 1,
      rate NUMERIC(12,2) NOT NULL DEFAULT 0,
      rate_type TEXT NOT NULL DEFAULT 'dona',
      salary_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
      electricity_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
      other_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
      minimum_stock INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      pieces_per_box INTEGER NOT NULL DEFAULT 1,
      line_id INTEGER,
      payroll_method TEXT NOT NULL DEFAULT 'PRODUCT_RATE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX idx_products_sku_unique ON public.products (sku) WHERE sku <> '';
    CREATE SCHEMA distribution;
    CREATE TABLE distribution.mahsulotlar (
      id SERIAL PRIMARY KEY,
      nomi TEXT NOT NULL,
      narx NUMERIC NOT NULL DEFAULT 0,
      birlik TEXT NOT NULL DEFAULT 'dona',
      faol INTEGER NOT NULL DEFAULT 1,
      sku TEXT NOT NULL DEFAULT ''
    );
  `);

  // ERP mahsulotlari
  await pool.query(`
    INSERT INTO public.products (name, sku, currency_type, default_sale_price) VALUES
      ('Arqon 5mm test',  'ARQON-5MM-T',  'UZS', 12000),
      ('Kanop USD test',  'KANOP-USD-T',  'USD', 3.5),
      ('Yolgiz ERP test', '',             'UZS', 7000)
  `);
  // Savdo bot mahsulotlari (birinchi ikkitasi SKU orqali bog'langan)
  await pool.query(`
    INSERT INTO distribution.mahsulotlar (nomi, narx, sku) VALUES
      ('Arqon 5mm eski nom', 10000, 'ARQON-5MM-T'),
      ('Kanop eski nom',     45000, 'KANOP-USD-T'),
      ('Bogliqsiz mahsulot', 9999,  '')
  `);

  const { default: productsRouter } = await import("../src/routes/products");
  const app = express();
  app.use(express.json());
  app.use(productsRouter);
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  apiUrl = `http://127.0.0.1:${port}`;
}, 60_000);

afterAll(async () => {
  server?.close();
  await pool?.end().catch(() => {});
  await dropTmpDb();
});

describe("PATCH /products → distribution.mahsulotlar propagation", () => {
  it("UZS mahsulot narxi PATCH qilinganda bog'langan mahsulotlar.narx va nomi yangilanadi", async () => {
    const r = await patch("Arqon 5mm test", { defaultSalePrice: 13500.4 });
    expect(r.status).toBe(200);

    const m = await mahsulot("ARQON-5MM-T");
    expect(m).not.toBeNull();
    expect(m!.narx).toBe(13500); // ROUND(13500.4)
    expect(m!.nomi).toBe("Arqon 5mm test"); // nomi ERP nomiga tenglashadi
  });

  it("USD mahsulot PATCH qilinganda narx TEGILMAYDI (mahsulotlar.narx faqat UZS)", async () => {
    const r = await patch("Kanop USD test", { defaultSalePrice: 4.25 });
    expect(r.status).toBe(200);

    const m = await mahsulot("KANOP-USD-T");
    expect(m).not.toBeNull();
    expect(m!.narx).toBe(45000); // eski UZS narx saqlanadi
    expect(m!.nomi).toBe("Kanop USD test"); // nomi baribir sinxronlanadi
  });

  it("narxi 0 bo'lgan UZS PATCH ham narxni buzmaydi", async () => {
    const r = await patch("Arqon 5mm test", { defaultSalePrice: 0 });
    expect(r.status).toBe(200);
    const m = await mahsulot("ARQON-5MM-T");
    expect(m!.narx).toBe(13500); // 0 propagate qilinmaydi
  });

  it("SKU bog'lanmagan mahsulot PATCH qilinganda mahsulotlar'da hech narsa o'zgarmaydi", async () => {
    const before = await pool.query(
      `SELECT id, nomi, narx FROM distribution.mahsulotlar ORDER BY id`,
    );
    const r = await patch("Yolgiz ERP test", { defaultSalePrice: 8800 });
    expect(r.status).toBe(200);

    const after = await pool.query(
      `SELECT id, nomi, narx FROM distribution.mahsulotlar ORDER BY id`,
    );
    expect(after.rows).toEqual(before.rows);
  });
});

describe("POST /products SKU to'qnashuv va upsert", () => {
  it("band SKU bilan yangi mahsulot yaratish 409 qaytaradi", async () => {
    const r = await post({ name: "Boshqa mahsulot test", sku: "ARQON-5MM-T" });
    expect(r.status).toBe(409);
    expect(String(r.json?.error)).toContain("ARQON-5MM-T");
    // Yangi qator yaratilmagan
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM public.products WHERE name = 'Boshqa mahsulot test'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it("mavjud nom bilan upsert'da eski SKU saqlanadi (bog'lanish uzilmaydi)", async () => {
    const r = await post({
      name: "Arqon 5mm test",
      sku: "YANGI-SKU-T",
      defaultSalePrice: 15000,
    });
    expect(r.status).toBe(201);
    expect(r.json.sku).toBe("ARQON-5MM-T"); // mavjud SKU ustun

    // Keyingi PATCH hali ham eski SKU orqali propagate qiladi
    const p = await patch("Arqon 5mm test", { defaultSalePrice: 16000 });
    expect(p.status).toBe(200);
    const m = await mahsulot("ARQON-5MM-T");
    expect(m!.narx).toBe(16000);
  });
});
