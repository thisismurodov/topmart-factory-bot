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
      in_sales BOOLEAN NOT NULL DEFAULT FALSE,
      in_production BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX idx_products_sku_unique ON public.products (sku) WHERE sku <> '';
    CREATE TABLE product_price_tiers (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL,
      min_quantity NUMERIC NOT NULL,
      max_quantity NUMERIC NOT NULL,
      price NUMERIC NOT NULL,
      currency TEXT NOT NULL DEFAULT 'UZS'
    );
    CREATE SCHEMA distribution;
    CREATE TABLE distribution.mahsulotlar (
      id SERIAL PRIMARY KEY,
      nomi TEXT NOT NULL,
      narx NUMERIC NOT NULL DEFAULT 0,
      birlik TEXT NOT NULL DEFAULT 'dona',
      faol INTEGER NOT NULL DEFAULT 1,
      sku TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE distribution.delivery_agents (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      telegram_id BIGINT NOT NULL,
      hudud TEXT,
      faol INTEGER NOT NULL DEFAULT 1
    );
  `);
  await pool.query(
    `INSERT INTO distribution.delivery_agents (name, telegram_id) VALUES ('Test agent', 777001)`,
  );

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
  const { default: distributionRouter } = await import("../src/routes/distribution");
  const { default: salesProductsRouter } = await import("../src/routes/sales-products");
  process.env.FIELD_DEV_BYPASS = "1";
  const { default: fieldRouter } = await import("../src/routes/field");
  const app = express();
  app.use(express.json());
  app.use(productsRouter);
  app.use(distributionRouter);
  app.use(salesProductsRouter);
  app.use(fieldRouter);
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

describe("Bitta mahsulot bazasi — in_sales sinxronizatsiyasi", () => {
  it("POST inSales=true yangi mahsulotni savdo katalogiga avtomatik qo'shadi", async () => {
    const r = await post({
      name: "Master yangi test", sku: "MASTER-NEW-T",
      defaultSalePrice: 5000, unitType: "kg", inSales: true,
    });
    expect(r.status).toBe(201);
    expect(r.json.inSales).toBe(true);
    const { rows } = await pool.query(
      `SELECT nomi, narx, birlik, faol FROM distribution.mahsulotlar WHERE sku = 'MASTER-NEW-T'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].nomi).toBe("Master yangi test");
    expect(Number(rows[0].narx)).toBe(5000);
    expect(rows[0].birlik).toBe("kg");
    expect(Number(rows[0].faol)).toBe(1);
  });

  it("POST inSales=true nom mos kelsa mavjud bog'lanmagan savdo qatorini SKU bilan bog'laydi (dublikat yaratmaydi)", async () => {
    const r = await post({
      name: "Bogliqsiz mahsulot", sku: "BOGLIQSIZ-T",
      defaultSalePrice: 11000, inSales: true,
    });
    expect(r.status).toBe(201);
    const { rows } = await pool.query(
      `SELECT id, sku, narx FROM distribution.mahsulotlar WHERE ${"regexp_replace(regexp_replace(lower(trim(nomi)), '[''’ʼ`´]', '', 'g'), '\\s+', ' ', 'g')"} = 'bogliqsiz mahsulot'`,
    );
    expect(rows.length).toBe(1); // yangi qator YARATILMAGAN
    expect(rows[0].sku).toBe("BOGLIQSIZ-T");
    expect(Number(rows[0].narx)).toBe(11000);
  });

  it("PATCH inSales=false bog'langan savdo qatorini nofaol qiladi, true qayta yoqadi", async () => {
    let r = await patch("Master yangi test", { inSales: false });
    expect(r.status).toBe(200);
    let q = await pool.query(`SELECT faol FROM distribution.mahsulotlar WHERE sku = 'MASTER-NEW-T'`);
    expect(Number(q.rows[0].faol)).toBe(0);

    r = await patch("Master yangi test", { inSales: true });
    expect(r.status).toBe(200);
    q = await pool.query(`SELECT faol FROM distribution.mahsulotlar WHERE sku = 'MASTER-NEW-T'`);
    expect(Number(q.rows[0].faol)).toBe(1);
  });

  it("inSales berilmagan POST upsert mavjud flag'ni saqlaydi", async () => {
    const r = await post({ name: "Master yangi test", defaultSalePrice: 5500 });
    expect(r.status).toBe(201);
    expect(r.json.inSales).toBe(true); // COALESCE — flag o'zgarmaydi
  });

  it("inSales=false faol mahsulot savdo katalogida ko'rinmaydi va narxlanmaydi", async () => {
    const r = await post({ name: "Savdodan tashqari test", defaultSalePrice: 4000, inSales: false });
    expect(r.status).toBe(201);
    const id = r.json.id;

    const list = await fetch(`${apiUrl}/sales-products`).then(x => x.json());
    expect(list.some((p: any) => p.name === "Savdodan tashqari test")).toBe(false);

    const price = await fetch(`${apiUrl}/sales-products/${id}/price?qty=1`);
    expect(price.status).toBe(404);
  });

  it("inSales=true mahsulot savdo katalogida ko'rinadi va narxlanadi", async () => {
    const r = await post({ name: "Savdoda bor test", defaultSalePrice: 3000, inSales: true });
    expect(r.status).toBe(201);
    const id = r.json.id;

    const list = await fetch(`${apiUrl}/sales-products`).then(x => x.json());
    expect(list.some((p: any) => p.name === "Savdoda bor test")).toBe(true);

    const price = await fetch(`${apiUrl}/sales-products/${id}/price?qty=1`).then(x => x.json());
    expect(price.price).toBe(3000);
  });

  it("legacy POST /sales-products in_sales=TRUE qo'yadi va savdo katalogiga sinxronlaydi", async () => {
    const r = await fetch(`${apiUrl}/sales-products`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Legacy shim test", defaultPrice: 2500 }),
    });
    expect(r.status).toBe(201);
    const p = await pool.query(`SELECT in_sales, sku FROM public.products WHERE name='Legacy shim test'`);
    expect(p.rows[0].in_sales).toBe(true);
    const d = await pool.query(
      `SELECT faol, narx FROM distribution.mahsulotlar WHERE sku = $1`, [p.rows[0].sku],
    );
    expect(d.rows).toHaveLength(1);
    expect(Number(d.rows[0].narx)).toBe(2500);
  });

  it("legacy PUT /sales-products narxni proyeksiyaga ham sinxronlaydi", async () => {
    const p = await pool.query(`SELECT id, sku FROM public.products WHERE name='Legacy shim test'`);
    const r = await fetch(`${apiUrl}/sales-products/${p.rows[0].id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultPrice: 2600 }),
    });
    expect(r.status).toBe(200);
    const d = await pool.query(
      `SELECT narx FROM distribution.mahsulotlar WHERE sku = $1`, [p.rows[0].sku],
    );
    expect(Number(d.rows[0].narx)).toBe(2600);
  });

  it("legacy DELETE /sales-products faqat savdodan chiqaradi — master active saqlanadi", async () => {
    const p = await pool.query(`SELECT id, sku FROM public.products WHERE name='Legacy shim test'`);
    const r = await fetch(`${apiUrl}/sales-products/${p.rows[0].id}`, { method: "DELETE" });
    expect(r.status).toBe(200);
    const m = await pool.query(`SELECT active, in_sales FROM public.products WHERE name='Legacy shim test'`);
    expect(m.rows[0].active).toBe(true);
    expect(m.rows[0].in_sales).toBe(false);
    const d = await pool.query(
      `SELECT faol FROM distribution.mahsulotlar WHERE sku = $1`, [p.rows[0].sku],
    );
    expect(Number(d.rows[0].faol)).toBe(0);
  });

  it("field katalogi: in_sales=false master'ga bog'langan qator ko'rinmaydi, legacy sku'siz qoladi", async () => {
    // Master savdodan chiqarilgan, lekin proyeksiya qatori qo'lda faol qoldirilgan holat
    await pool.query(`
      INSERT INTO public.products (name, sku, in_sales) VALUES ('Field disabled test', 'FIELD-DIS-T', FALSE);
      INSERT INTO distribution.mahsulotlar (nomi, narx, sku, faol) VALUES ('Field disabled test', 5000, 'FIELD-DIS-T', 1);
    `);
    const list = await fetch(`${apiUrl}/field/products`, {
      headers: { "X-Field-Dev-Id": "777001" },
    }).then((x) => x.json());
    const names = list.map((p: any) => p.nomi);
    expect(names).not.toContain("Field disabled test");
    expect(names).toContain("Bogliqsiz mahsulot"); // legacy sku='' sotuvda qoladi
  });

  it("field savdo narx so'rovi: in_sales=false mahsulot narxlanmaydi", async () => {
    // performFieldSale ishlatadigan narx sharti bilan bir xil so'rov:
    // bog'langan-lekin-o'chirilgan qator chiqmasligi, legacy sku='' chiqishi kerak.
    const m = await pool.query(`SELECT id FROM distribution.mahsulotlar WHERE sku='FIELD-DIS-T'`);
    const legacy = await pool.query(`SELECT id FROM distribution.mahsulotlar WHERE nomi='Bogliqsiz mahsulot'`);
    const ids = [Number(m.rows[0].id), Number(legacy.rows[0].id)];
    const q = await pool.query(
      `SELECT m.id FROM distribution.mahsulotlar m
        WHERE m.id = ANY($1) AND m.faol = 1
          AND (COALESCE(m.sku,'') = ''
               OR EXISTS (SELECT 1 FROM public.products p WHERE p.sku = m.sku AND p.in_sales = TRUE))`,
      [ids],
    );
    const found = q.rows.map((r) => Number(r.id));
    expect(found).toContain(ids[1]);
    expect(found).not.toContain(ids[0]);
  });

  it("bog'langan savdo qatorini to'g'ridan-to'g'ri PATCH qilish 409 — faqat master orqali", async () => {
    const q = await pool.query(
      `SELECT id FROM distribution.mahsulotlar WHERE sku = 'ARQON-5MM-T'`
    );
    const id = q.rows[0].id;
    const res = await fetch(`${apiUrl}/distribution/products/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ narx: 123456 }),
    });
    expect(res.status).toBe(409);
    const after = await pool.query(
      `SELECT narx FROM distribution.mahsulotlar WHERE id = $1`, [id]
    );
    expect(Number(after.rows[0].narx)).not.toBe(123456);
  });

  it("bog'lanmagan (sku='') qatorni PATCH qilish hali ham mumkin (legacy tahrir)", async () => {
    const q = await pool.query(
      `INSERT INTO distribution.mahsulotlar (nomi, narx, sku) VALUES ('Legacy tahrir testi', 100, '') RETURNING id`
    );
    const id = q.rows[0].id;
    const res = await fetch(`${apiUrl}/distribution/products/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ narx: 8888 }),
    });
    expect(res.status).toBe(200);
    const after = await pool.query(
      `SELECT narx FROM distribution.mahsulotlar WHERE id = $1`, [id]
    );
    expect(Number(after.rows[0].narx)).toBe(8888);
  });
});
