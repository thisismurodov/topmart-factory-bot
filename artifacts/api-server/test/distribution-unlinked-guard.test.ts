import { beforeAll, afterAll, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";

// ─────────────────────────────────────────────────────────────────────────────
// Bog'lanmagan savdo mahsuloti qayta paydo bo'lsa darhol sezilsin (data guard).
//
// Task #104 migratsiyasidan keyin barcha faol distribution.mahsulotlar SKU
// orqali public.products masteriga bog'langan. Agar kelajakda yana bog'lanmagan
// yozuv paydo bo'lsa (bot orqali, qo'lda SQL, sync xatosi) — yoki sku masterda
// YO'Q qiymatga ishora qilsa (dangling) — GET /distribution/products javobidan
// buni aniqlash mumkin bo'lishi shart, chunki dashboard banneri aynan shu
// maydonlarga tayanadi:
//
//   • bog'lanmagan:  faol=1 va sku=''            → sku maydoni bo'sh
//   • dangling sku:  faol=1, sku≠'', master yo'q → erpNomi null
//
// Va bir bosishda tuzatish: POST auto-link nomi mos kelganini bog'laydi.
//
// Throwaway DATABASE (pid+timestamp — parallel validation'lar to'qnashmasin,
// qarang test-schema-contention memory) minimal ikkala sxema nusxasi bilan.
// ─────────────────────────────────────────────────────────────────────────────

const { Client } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

const TMP_DB = `topmart_unlinked_guard_${process.pid}_${Date.now()}`;
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

type Row = {
  id: number;
  nomi: string;
  faol: boolean;
  sku: string;
  erpNomi: string | null;
  taklifSku: string | null;
};

async function fetchProducts(): Promise<Row[]> {
  const r = await fetch(`${apiUrl}/distribution/products`);
  expect(r.status).toBe(200);
  return (await r.json()) as Row[];
}

beforeAll(async () => {
  await dropTmpDb();
  {
    const admin = new Client({ connectionString: adminUrl, ssl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${TMP_DB}`);
    await admin.end();
  }

  process.env.RAILWAY_DATABASE_URL = tmpUrl();
  process.env.DATABASE_URL = tmpUrl();

  const db = await import("@workspace/db");
  pool = db.pool as unknown as pg.Pool;

  // Minimal sxema nusxalari: GET /distribution/products va auto-link tegadigan
  // ustunlar (savdo statistikasi jadvallari bo'sh bo'lsa ham bo'lishi kerak).
  await pool.query(`
    CREATE TABLE public.products (
      cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      sku TEXT NOT NULL DEFAULT '',
      in_sales BOOLEAN NOT NULL DEFAULT FALSE
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
    CREATE TABLE distribution.savdolar (
      id SERIAL PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE distribution.savdo_tafsilot (
      id SERIAL PRIMARY KEY,
      savdo_id INTEGER NOT NULL,
      mahsulot_id INTEGER NOT NULL,
      miqdor NUMERIC NOT NULL DEFAULT 0,
      summa NUMERIC NOT NULL DEFAULT 0
    );
  `);

  // Master katalog
  await pool.query(`
    INSERT INTO public.products (name, sku, in_sales) VALUES
      ('Arqon 5mm guard',  'ARQ-G-1', TRUE),
      ('Kanop guard',      'KAN-G-1', FALSE)
  `);
  // Savdo bot katalogi:
  //   1. sog'lom bog'langan
  //   2. bog'lanmagan, nomi masterga mos (auto-link tuzatadi)
  //   3. bog'lanmagan, masterda umuman yo'q
  //   4. dangling — sku masterda mavjud emas
  //   5. nofaol bog'lanmagan — guard'ga KIRMASLIGI kerak
  await pool.query(`
    INSERT INTO distribution.mahsulotlar (nomi, narx, faol, sku) VALUES
      ('Arqon 5mm guard',   12000, 1, 'ARQ-G-1'),
      ('Kanop guard',        9000, 1, ''),
      ('Notanish mahsulot',  5000, 1, ''),
      ('Uzilgan mahsulot',   7000, 1, 'YOQ-SKU-9'),
      ('Eski nofaol',        1000, 0, '')
  `);

  const { default: distributionRouter } = await import("../src/routes/distribution");
  const app = express();
  app.use(express.json());
  app.use(distributionRouter);
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  apiUrl = `http://127.0.0.1:${port}`;
}, 60_000);

afterAll(async () => {
  server?.close();
  await pool?.end().catch(() => {});
  await dropTmpDb();
});

describe("bog'lanmagan/dangling savdo mahsuloti data-guard", () => {
  it("GET /distribution/products bog'lanmagan va dangling faol yozuvlarni ko'rsatadi", async () => {
    const rows = await fetchProducts();
    const by = (n: string) => rows.find((r) => r.nomi === n)!;

    // Sog'lom bog'langan: sku bor va master nomi keladi
    expect(by("Arqon 5mm guard").sku).toBe("ARQ-G-1");
    expect(by("Arqon 5mm guard").erpNomi).toBe("Arqon 5mm guard");

    // Bog'lanmaganlar: sku bo'sh (dashboard banneri shu holatni sanaydi)
    expect(by("Kanop guard").sku).toBe("");
    expect(by("Kanop guard").taklifSku).toBe("KAN-G-1"); // nomi mos — taklif bor
    expect(by("Notanish mahsulot").sku).toBe("");
    expect(by("Notanish mahsulot").taklifSku).toBeNull();

    // Dangling: sku bor, lekin masterga mos kelmaydi → erpNomi null
    expect(by("Uzilgan mahsulot").sku).toBe("YOQ-SKU-9");
    expect(by("Uzilgan mahsulot").erpNomi).toBeNull();

    // Guard sanog'i (frontend bilan bir xil formula)
    const unlinked = rows.filter((r) => r.faol && r.sku === "");
    const dangling = rows.filter((r) => r.faol && r.sku !== "" && r.erpNomi === null);
    expect(unlinked.map((r) => r.nomi).sort()).toEqual(["Kanop guard", "Notanish mahsulot"]);
    expect(dangling.map((r) => r.nomi)).toEqual(["Uzilgan mahsulot"]);

    // Nofaol yozuv guard'ga kirmaydi
    expect(rows.find((r) => r.nomi === "Eski nofaol")!.faol).toBe(false);
  });

  it("POST auto-link nomi mos bog'lanmaganni bir bosishda tuzatadi va in_sales muhrlaydi", async () => {
    const r = await fetch(`${apiUrl}/distribution/products/auto-link`, { method: "POST" });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { linked: number; items: { nomi: string; sku: string }[] };
    expect(j.linked).toBe(1);
    expect(j.items[0]).toMatchObject({ nomi: "Kanop guard", sku: "KAN-G-1" });

    const rows = await fetchProducts();
    const kanop = rows.find((x) => x.nomi === "Kanop guard")!;
    expect(kanop.sku).toBe("KAN-G-1");
    expect(kanop.erpNomi).toBe("Kanop guard");

    const { rows: p } = await pool.query(
      `SELECT in_sales FROM public.products WHERE sku = 'KAN-G-1'`,
    );
    expect(p[0].in_sales).toBe(true);

    // Auto-link'dan keyin ham qolganlar guard'da ko'rinishda davom etadi
    const unlinked = rows.filter((x) => x.faol && x.sku === "");
    const dangling = rows.filter((x) => x.faol && x.sku !== "" && x.erpNomi === null);
    expect(unlinked.map((x) => x.nomi)).toEqual(["Notanish mahsulot"]);
    expect(dangling.map((x) => x.nomi)).toEqual(["Uzilgan mahsulot"]);
  });
});
