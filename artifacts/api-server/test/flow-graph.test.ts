import { beforeAll, afterAll, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ── Izolyatsiya ──────────────────────────────────────────────────────────────
// Har bir so'rov tashlab yuboriladigan unikal sxemada ishlaydi (search_path
// libpq `options` orqali) — real Ombor ma'lumotlariga hech qachon tegilmaydi.
const SCHEMA = `topmart_flowgraph_test_${process.pid}_${Date.now()}`;

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
const wh: Record<string, number> = {};

// Apostrof-normalizatsiya testi: DB'dagi mahsulot nomi ASCII apostrof bilan,
// items katalogida esa U+02BC modifier apostrof bilan yozilgan.
const ARQON = "Test Arqon' 4 kg";
const ARQON_ITEM = "Test Arqon\u02BC 4 kg";
const QOP = "Qop Mahsulot Test";

// flowGraph.ts qaysi jadvallarga tegishi mumkin — read-only isbot ro'yxati.
const TABLES = [
  "warehouses",
  "inventory",
  "items",
  "production_lines",
  "production_line_workers",
  "line_role_config",
  "wip_movements",
  "batches",
  "product_materials",
  "raw_materials",
  "salary_payments",
  "products",
];

async function getGraph(): Promise<any> {
  const r = await fetch(`${apiUrl}/ombor/flow/graph`);
  expect(r.status).toBe(200);
  return r.json();
}

async function tableSnapshot(): Promise<Record<string, { n: number; maxId: string }>> {
  const out: Record<string, { n: number; maxId: string }> = {};
  for (const t of TABLES) {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(MAX(id), 0)::bigint::text AS max_id FROM ${t}`,
    );
    out[t] = { n: r.rows[0].n, maxId: r.rows[0].max_id };
  }
  return out;
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);

  // flowGraph so'rovlari tegadigan jadvallarning minimal nusxalari.
  await pool.query(`
    CREATE TABLE warehouses (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      location_type TEXT NOT NULL DEFAULT 'container',
      capacity_kg NUMERIC DEFAULT 20000,
      purpose TEXT
    );
    CREATE TABLE inventory (
      id SERIAL PRIMARY KEY,
      warehouse_id INTEGER NOT NULL,
      product TEXT NOT NULL,
      quantity NUMERIC NOT NULL DEFAULT 0,
      weight_kg NUMERIC NOT NULL DEFAULT 0,
      product_type TEXT,
      item_id INTEGER
    );
    CREATE TABLE items (
      id SERIAL PRIMARY KEY,
      display_name TEXT NOT NULL,
      sku TEXT
    );
    CREATE TABLE production_lines (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE production_line_workers (
      id SERIAL PRIMARY KEY,
      line_id INTEGER NOT NULL,
      worker_name TEXT NOT NULL,
      role TEXT NOT NULL
    );
    CREATE TABLE line_role_config (
      id SERIAL PRIMARY KEY,
      line_id INTEGER NOT NULL,
      role_key TEXT NOT NULL,
      label TEXT NOT NULL,
      rate NUMERIC NOT NULL DEFAULT 0,
      max_workers INTEGER NOT NULL DEFAULT 0,
      pay_mode TEXT NOT NULL DEFAULT 'individual'
    );
    CREATE TABLE wip_movements (
      id SERIAL PRIMARY KEY,
      line_id INTEGER,
      movement_type TEXT NOT NULL,
      raw_material TEXT,
      product TEXT,
      weight_kg NUMERIC NOT NULL DEFAULT 0,
      from_warehouse_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      product_item_id INTEGER,
      raw_material_item_id INTEGER
    );
    CREATE TABLE batches (
      id SERIAL PRIMARY KEY,
      product TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      weight_kg NUMERIC NOT NULL DEFAULT 0,
      production_line_id INTEGER,
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      item_id INTEGER
    );
    CREATE TABLE product_materials (
      id SERIAL PRIMARY KEY,
      product_name TEXT NOT NULL,
      raw_material_id INTEGER,
      quantity_required NUMERIC NOT NULL DEFAULT 0,
      product_item_id INTEGER,
      material_item_id INTEGER
    );
    CREATE TABLE raw_materials (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      current_stock NUMERIC NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'UZS'
    );
    CREATE TABLE salary_payments (
      id SERIAL PRIMARY KEY,
      worker TEXT NOT NULL,
      amount NUMERIC NOT NULL DEFAULT 0,
      paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE products (
      cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      item_id INTEGER
    );
  `);

  // ── Seed: prod semantikasini aks ettiruvchi kichik stsenariy ───────────────
  // Konteynerlar: C-T1 purpose='finished' LEKIN kontenti raw (mismatch),
  // C-T2 finished (mos), C-T3 bo'sh, R-1 viloyat ombori (container emas).
  for (const [name, loc, purpose] of [
    ["C-T1", "container", "finished"],
    ["C-T2", "container", "finished"],
    ["C-T3", "container", "finished"],
    ["R-1", "general", "finished"],
  ] as const) {
    const { rows } = await pool.query(
      `INSERT INTO warehouses (name, location_type, purpose) VALUES ($1,$2,$3) RETURNING id`,
      [name, loc, purpose],
    );
    wh[name] = rows[0].id;
  }

  await pool.query(`
    INSERT INTO production_lines (id, name) VALUES
      (6, 'Test Arqon Line'), (8, 'Test Lenta Line'), (9, 'Test Qop Line'), (10, 'Test Inactive Line')
  `);
  await pool.query(`
    INSERT INTO production_line_workers (line_id, worker_name, role) VALUES
      (6, 'Alice', 'producer'), (6, 'Bob', 'pock')
  `);
  await pool.query(`
    INSERT INTO line_role_config (line_id, role_key, label, rate, max_workers, pay_mode)
    VALUES (6, 'producer', 'Chiqaruvchi', 1000, 5, 'individual')
  `);

  // WIP: faqat PRODUCE (RECEIVE yo'q) → balans manfiy bo'lishi SHART.
  await pool.query(
    `INSERT INTO wip_movements (line_id, movement_type, product, weight_kg, created_at) VALUES
      (6, 'PRODUCE', $1, 60.5, '2026-08-01T10:00:00Z'),
      (6, 'PRODUCE', $1, 40,   '2026-08-15T10:00:00Z')`,
    [ARQON],
  );

  // Partiyalar: line 9 normal; 3 ta partiya production_line_id=NULL (orphan).
  await pool.query(
    `INSERT INTO batches (product, quantity, weight_kg, production_line_id, archived, created_at) VALUES
      ($1, 50, 25, 9, FALSE, '2026-08-10T09:00:00Z'),
      ('Orphan A', 20, 10,  NULL, FALSE, '2026-08-11T09:00:00Z'),
      ('Orphan A',  5, 2.5, NULL, TRUE,  '2026-08-12T09:00:00Z'),
      ('Orphan B',  7, 3,   NULL, FALSE, '2026-08-13T09:00:00Z')`,
    [QOP],
  );

  await pool.query(
    `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type) VALUES
      ($1, 'Xom Ip Test', 0, 500, 'raw'),
      ($2, $4, 20, 80, 'finished'),
      ($3, $5, 30, 0, 'finished')`,
    [wh["C-T1"], wh["C-T2"], wh["R-1"], ARQON, QOP],
  );

  // items: ARQON faqat apostrof-varianti bilan mavjud (norm-match testi);
  // QOP items katalogida YO'Q → sku=null bo'lishi shart.
  await pool.query(
    `INSERT INTO items (display_name, sku) VALUES ($1, 'TM-TEST-01'), ('Boshqa Item', 'TM-TEST-99')`,
    [ARQON_ITEM],
  );

  const rm = await pool.query(
    `INSERT INTO raw_materials (name, current_stock, currency) VALUES ('Test Xomashyo', 100, 'UZS') RETURNING id`,
  );
  await pool.query(
    `INSERT INTO product_materials (product_name, raw_material_id, quantity_required) VALUES ($1, $2, 0.5)`,
    [ARQON, rm.rows[0].id],
  );

  await pool.query(`
    INSERT INTO salary_payments (worker, amount, paid_at) VALUES
      ('Alice', 100000, '2026-06-15T08:00:00Z'),
      ('Alice',  50000, '2026-06-30T08:00:00Z')
  `);

  await pool.query(
    `INSERT INTO products (name, item_id) VALUES ($1, NULL), ($2, 1)`,
    [ARQON, QOP],
  );

  const { default: omborRouter } = await import("../src/routes/ombor");
  const app = express();
  app.use(express.json());
  app.use(omborRouter);
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

describe("GET /ombor/flow/graph (F2)", () => {
  it("javob sxemasi: F1 kontrakti — nodes/edges/supplyEdges/gaps/meta", async () => {
    const g = await getGraph();
    expect(g.readOnly).toBe(true);
    expect(typeof g.generatedAt).toBe("string");
    for (const key of ["nodes", "edges", "supplyEdges", "gaps", "meta"]) {
      expect(g, `top-level '${key}' bo'lishi shart`).toHaveProperty(key);
    }
    for (const key of [
      "containersRaw",
      "containersFinished",
      "emptyContainers",
      "regionalGroup",
      "departments",
      "inactiveDepartments",
      "wip",
      "products",
    ]) {
      expect(g.nodes, `nodes.${key} bo'lishi shart`).toHaveProperty(key);
    }
    expect(Array.isArray(g.edges)).toBe(true);
    expect(Array.isArray(g.supplyEdges)).toBe(true);
    expect(Array.isArray(g.gaps)).toBe(true);
    expect(g.meta).toHaveProperty("unattributedBatches");
    expect(g.meta).toHaveProperty("dataQuality");
    expect(g.meta).toHaveProperty("counts");
  });

  it("node soni va klassifikatsiya: kontent bo'yicha, purpose bo'yicha EMAS", async () => {
    const g = await getGraph();
    expect(g.nodes.containersRaw.map((c: any) => c.name)).toEqual(["C-T1"]);
    expect(g.nodes.containersFinished.map((c: any) => c.name)).toEqual(["C-T2"]);
    expect(g.nodes.emptyContainers.map((c: any) => c.name)).toEqual(["C-T3"]);
    expect(g.nodes.regionalGroup?.count).toBe(1);
    expect(g.nodes.departments.map((d: any) => d.id)).toEqual([6, 9, 8]);
    expect(g.nodes.inactiveDepartments.map((d: any) => d.id)).toEqual([10]);
    expect(g.nodes.wip).toHaveLength(3);
    expect(g.nodes.products).toHaveLength(2);

    const dept6 = g.nodes.departments.find((d: any) => d.id === 6);
    expect(dept6.workers).toHaveLength(2);
    expect(dept6.roles).toHaveLength(1);
    expect(dept6.salary).toMatchObject({ entries: 2, workers: 1, total: 150000, lastDate: "2026-06-30" });
    expect(dept6.bomInputs).toHaveLength(1);
    expect(dept6.bomInputs[0]).toMatchObject({ material: "Test Xomashyo", perUnit: 0.5, stock: 100 });
  });

  it("edge'lar faqat mavjud nodelarga ishora qiladi", async () => {
    const g = await getGraph();
    const keys = new Set<string>();
    for (const c of [...g.nodes.containersRaw, ...g.nodes.containersFinished, ...g.nodes.emptyContainers]) {
      keys.add(`c-${c.id}`);
    }
    if (g.nodes.regionalGroup) keys.add("regional");
    for (const d of g.nodes.departments) keys.add(`d-${d.id}`);
    for (const w of g.nodes.wip) keys.add(`w-${w.lineId}`);
    for (const p of g.nodes.products) keys.add(p.key);
    for (const e of [...g.edges, ...g.supplyEdges]) {
      expect(keys.has(e.source), `edge ${e.id} source '${e.source}' mavjud node emas`).toBe(true);
      expect(keys.has(e.target), `edge ${e.id} target '${e.target}' mavjud node emas`).toBe(true);
      expect(typeof e.table).toBe("string");
      expect(typeof e.joinBasis).toBe("string");
    }
  });

  it("soxta edge yo'q: RECEIVE=0 bo'lsa container→bo'lim chizilmaydi", async () => {
    const g = await getGraph();
    const allowed = new Set(["dept-wip", "wip-product", "batch-product", "product-container"]);
    for (const e of g.edges) {
      expect(allowed.has(e.kind), `noma'lum edge kind: ${e.kind}`).toBe(true);
      // container→bo'lim faqat supplyEdges'da bo'lishi mumkin, edges'da hech qachon
      expect(e.source.startsWith("c-") && e.target.startsWith("d-")).toBe(false);
    }
    expect(g.supplyEdges).toEqual([]);
    expect(g.gaps.map((x: any) => x.code)).toContain("NO_RECEIVE_DATA");
    // nofaol bo'lim (10) hech qanday edge'da qatnashmaydi
    for (const e of [...g.edges, ...g.supplyEdges]) {
      expect(e.source).not.toBe("d-10");
      expect(e.target).not.toBe("d-10");
    }
    expect(g.edges.map((e: any) => e.kind).sort()).toEqual(
      ["batch-product", "dept-wip", "product-container", "product-container", "wip-product"].sort(),
    );
  });

  it("SKU halolligi: norm-match topilsa items'dan, topilmasa null", async () => {
    const g = await getGraph();
    const arqon = g.nodes.products.find((p: any) => p.name === ARQON);
    const qop = g.nodes.products.find((p: any) => p.name === QOP);
    // ASCII apostrof (DB) vs U+02BC (items) — normalizatsiya bog'lashi shart
    expect(arqon.sku).toBe("TM-TEST-01");
    // items'da yo'q mahsulot — taxmin qilinmaydi
    expect(qop.sku).toBeNull();
    // konteyner ichidagi qator SKU'si ham xuddi shu qoida bilan
    const cT2 = g.nodes.containersFinished.find((c: any) => c.name === "C-T2");
    expect(cT2.items[0].sku).toBe("TM-TEST-01");
    const arqonPlacement = arqon.placements.find((pl: any) => pl.container === "C-T2");
    expect(arqonPlacement).toMatchObject({ kg: 80, qty: 20 });
  });

  it("biriktirilmagan partiyalar: gap sifatida, edge sifatida EMAS", async () => {
    const g = await getGraph();
    const gap = g.gaps.find((x: any) => x.code === "UNATTRIBUTED_BATCHES");
    expect(gap).toBeTruthy();
    expect(gap.title).toContain("3 ta");
    expect(g.meta.unattributedBatches).toMatchObject({ batches: 3, products: 2 });
    // Orphan mahsulotlar graf nodelariga aylanmaydi
    for (const p of g.nodes.products) {
      expect(p.name.startsWith("Orphan")).toBe(false);
    }
    // archived partiya ham hisobda (filtr yo'q)
    expect(g.meta.counts.batches).toBe(4);
    expect(g.meta.counts.batchesArchived).toBe(1);
  });

  it("manfiy WIP yashirilmaydi: real qiymat + NEGATIVE status + gap", async () => {
    const g = await getGraph();
    const w6 = g.nodes.wip.find((w: any) => w.lineId === 6);
    expect(w6.balanceKg).toBe(-100.5);
    expect(w6.status).toBe("NEGATIVE");
    expect(w6.produceKg).toBe(100.5);
    expect(w6.receiveKg).toBe(0);
    expect(w6.first).toBe("2026-08-01");
    expect(w6.last).toBe("2026-08-15");
    const gap = g.gaps.find((x: any) => x.code === "NEGATIVE_WIP");
    expect(gap.title).toContain("Test Arqon Line");
    expect(gap.detail).toContain("-100.5");
    // ledger'siz bo'limlar NO_LEDGER (0 deb ko'rsatilmaydi, halol belgilanadi)
    expect(g.nodes.wip.find((w: any) => w.lineId === 8).status).toBe("NO_LEDGER");
    expect(g.nodes.wip.find((w: any) => w.lineId === 9).status).toBe("NO_LEDGER");
  });

  it("purpose≠kontent: warning qaytadi, DB qiymati o'zgarmaydi", async () => {
    const g = await getGraph();
    const cT1 = g.nodes.containersRaw.find((c: any) => c.name === "C-T1");
    expect(cT1.mismatch).toBe(true);
    expect(cT1.purpose).toBe("finished");
    expect(cT1.dominant).toBe("raw");
    const gap = g.gaps.find((x: any) => x.code === "PURPOSE_MISMATCH");
    expect(gap.title).toContain("C-T1");
    // mos konteyner warning olmaydi
    const cT2 = g.nodes.containersFinished.find((c: any) => c.name === "C-T2");
    expect(cT2.mismatch).toBe(false);
    // DB'dagi purpose o'z joyida
    const db = await pool.query(`SELECT purpose FROM warehouses WHERE id = $1`, [wh["C-T1"]]);
    expect(db.rows[0].purpose).toBe("finished");
  });

  it("read-only kafolati: hech bir jadval o'zgarmaydi + manba tekshiruvi", async () => {
    const before = await tableSnapshot();
    await getGraph();
    await getGraph();
    const after = await tableSnapshot();
    expect(after).toEqual(before);

    // Struktura darajasida: builder READ ONLY tranzaksiya ochadi va
    // manba kodida yozuvchi SQL fe'llari umuman yo'q.
    const libSource = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/flowGraph.ts"),
      "utf8",
    );
    expect(libSource).toMatch(/READ ONLY/);
    expect(libSource).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|CREATE)\b/i);
  });

  // OXIRGI test: RECEIVE yozuvi paydo bo'lsa supplyEdges avtomatik jonlanadi.
  // (Bu yozuv TEST sxemasiga kiritiladi — prod'ga emas.)
  it("RECEIVE paydo bo'lganda supplyEdges real FK'lardan quriladi", async () => {
    await pool.query(
      `INSERT INTO wip_movements (line_id, movement_type, raw_material, weight_kg, from_warehouse_id, created_at)
       VALUES (6, 'RECEIVE', 'Xom Ip Test', 30, $1, '2026-08-16T10:00:00Z')`,
      [wh["C-T1"]],
    );
    const g = await getGraph();
    expect(g.supplyEdges).toHaveLength(1);
    expect(g.supplyEdges[0]).toMatchObject({
      kind: "container-dept",
      source: `c-${wh["C-T1"]}`,
      target: "d-6",
      kg: 30,
      rows: 1,
    });
    expect(g.gaps.map((x: any) => x.code)).not.toContain("NO_RECEIVE_DATA");
    const w6 = g.nodes.wip.find((w: any) => w.lineId === 6);
    expect(w6.receiveKg).toBe(30);
    expect(w6.balanceKg).toBe(-70.5); // 30 − 100.5 — hali ham manfiy, hali ham ko'rinadi
    expect(w6.status).toBe("NEGATIVE");
  });

  // OXIRGI izolyatsiya isboti: location_type='vehicle' ombor (DM-001 mashina
  // ombori) va uning NOL bo'lmagan inventar qatorlari flow grafiga
  // (nodelar VA KPI totallar) HECH QACHON tushmasligi shart. Oddiy /
  // container / viloyat omborlariga ta'siri yo'q.
  it("vehicle ombor (DM-001) grafdan tashqarida: nodelar + KPI totallar o'zgarmaydi", async () => {
    const before = await getGraph();

    // Vehicle ombor + katta hajmli inventar (qasddan nonzero, qty/kg).
    const vh = await pool.query(
      `INSERT INTO warehouses (name, location_type, purpose) VALUES ($1, 'vehicle', 'finished') RETURNING id`,
      ["DM-001 mashina ombori"],
    );
    const vehicleWid = vh.rows[0].id;
    await pool.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type) VALUES
         ($1, 'Vehicle Only Mahsulot', 999, 4321, 'finished'),
         ($1, 'Vehicle Only Xom', 0, 777, 'raw')`,
      [vehicleWid],
    );

    const after = await getGraph();

    // Grafning barcha node ro'yxatlari va KPI totallari o'zgarmadi.
    expect(after.nodes).toEqual(before.nodes);
    expect(after.meta.counts).toEqual(before.meta.counts);
    expect(after.edges).toEqual(before.edges);
    expect(after.supplyEdges).toEqual(before.supplyEdges);

    // Vehicle ombor hech qanday konteyner/viloyat nodesida ko'rinmaydi.
    const allContainers = [
      ...after.nodes.containersRaw,
      ...after.nodes.containersFinished,
      ...after.nodes.emptyContainers,
    ];
    for (const c of allContainers) {
      expect(c.id).not.toBe(vehicleWid);
      expect(c.name).not.toContain("DM-001");
    }
    // Vehicle mahsulotlari mahsulot nodelariga aylanmaydi.
    for (const p of after.nodes.products) {
      expect(p.name).not.toContain("Vehicle Only");
    }
    // KPI totallari vehicle ombor/inventarni sanamaydi (DB'da esa mavjud).
    const rawWh = await pool.query(
      `SELECT COUNT(*)::int AS n FROM warehouses`,
    );
    const rawInv = await pool.query(
      `SELECT COUNT(*)::int AS n FROM inventory`,
    );
    expect(rawWh.rows[0].n).toBeGreaterThan(after.meta.counts.warehouses);
    expect(rawInv.rows[0].n).toBeGreaterThan(after.meta.counts.inventoryRows);
  });
});
