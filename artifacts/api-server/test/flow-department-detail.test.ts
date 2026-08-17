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
const SCHEMA = `topmart_deptdetail_test_${process.pid}_${Date.now()}`;

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

// Apostrof-normalizatsiya: DB'da ASCII apostrof, items katalogida U+02BC.
const ARQON = "Test Arqon' 4 kg";
const ARQON_ITEM = "Test Arqon\u02BC 4 kg";
const QOP = "Qop Mahsulot Test";

// departmentDetail.ts tegishi mumkin bo'lgan jadvallar — read-only isbot ro'yxati.
const TABLES = [
  "warehouses",
  "inventory",
  "items",
  "production_lines",
  "production_line_workers",
  "workers",
  "line_role_config",
  "wip_movements",
  "batches",
  "product_materials",
  "raw_materials",
  "salary_payments",
  "salary_entries",
  "daily_payroll_runs",
];

async function getDept(id: number | string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}/ombor/flow/department/${id}`);
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function dept(id: number): Promise<any> {
  const { status, json } = await getDept(id);
  expect(status).toBe(200);
  return json;
}

async function tableSnapshot(): Promise<Record<string, { n: number; maxId: string }>> {
  const out: Record<string, { n: number; maxId: string }> = {};
  for (const t of TABLES) {
    const idExpr = t === "workers" ? "'0'" : "COALESCE(MAX(id), 0)::bigint::text";
    const r = await pool.query(`SELECT COUNT(*)::int AS n, ${idExpr} AS max_id FROM ${t}`);
    out[t] = { n: r.rows[0].n, maxId: r.rows[0].max_id };
  }
  return out;
}

beforeAll(async () => {
  const db = await import("@workspace/db");
  pool = db.pool as unknown as Pool;

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);

  // departmentDetail so'rovlari tegadigan jadvallarning minimal nusxalari
  // (prod ustun nomlari bilan bir xil).
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
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      product_type TEXT NOT NULL DEFAULT 'finished',
      weight_kg NUMERIC NOT NULL DEFAULT 0,
      item_id INTEGER
    );
    CREATE TABLE items (
      id SERIAL PRIMARY KEY,
      display_name TEXT NOT NULL,
      sku TEXT
    );
    CREATE TABLE production_lines (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE production_line_workers (
      id SERIAL PRIMARY KEY,
      line_id INTEGER NOT NULL,
      worker_name TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE workers (
      name TEXT PRIMARY KEY,
      prefix TEXT,
      phone TEXT,
      role TEXT
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
      batch_id INTEGER,
      note TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      product_item_id INTEGER,
      raw_material_item_id INTEGER
    );
    CREATE TABLE batches (
      id SERIAL PRIMARY KEY,
      batch_code TEXT NOT NULL,
      worker TEXT NOT NULL,
      product TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      weight_kg NUMERIC NOT NULL DEFAULT 0,
      earnings NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payroll_method TEXT NOT NULL DEFAULT 'PRODUCT_RATE',
      production_line_id INTEGER,
      archived BOOLEAN NOT NULL DEFAULT FALSE,
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
      year INTEGER NOT NULL DEFAULT 2026,
      month INTEGER NOT NULL DEFAULT 1,
      amount NUMERIC NOT NULL DEFAULT 0,
      paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE salary_entries (
      id SERIAL PRIMARY KEY,
      scope TEXT,
      worker TEXT NOT NULL,
      role TEXT,
      source_type TEXT,
      batch_id INTEGER,
      work_date DATE,
      kg NUMERIC,
      rate NUMERIC,
      amount NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      line_id INTEGER
    );
    CREATE TABLE daily_payroll_runs (
      id SERIAL PRIMARY KEY,
      scope TEXT,
      work_date DATE NOT NULL,
      total_kg NUMERIC NOT NULL DEFAULT 0,
      status TEXT,
      closed_by TEXT,
      closed_at TIMESTAMPTZ,
      line_id INTEGER
    );
  `);

  // ── Seed: prod semantikasini aks ettiruvchi stsenariy ──────────────────────
  // Liniyalar: 6 = to'liq (manfiy WIP, ishchilar, oylik), 9 = faqat partiyalar,
  // 8 = butunlay bo'sh, 10 = nofaol (active=FALSE) — ma'lumot sifatida ochiladi.
  for (const [name, loc, purpose] of [
    ["C-T1", "container", "raw"],
    ["C-T2", "container", "finished"],
    ["R-1", "general", "finished"],
  ] as const) {
    const { rows } = await pool.query(
      `INSERT INTO warehouses (name, location_type, purpose) VALUES ($1,$2,$3) RETURNING id`,
      [name, loc, purpose],
    );
    wh[name] = rows[0].id;
  }

  // production_lines'da 'active' ustuni YO'Q (prod bilan bir xil) — faollik
  // ACTIVE_LINE_IDS=[6,9,8] orqali: 10 avtomatik nofaol hisoblanadi.
  await pool.query(`
    INSERT INTO production_lines (id, name, created_at) VALUES
      (6, 'Test Arqon Line',  '2026-06-17T07:00:00Z'),
      (8, 'Test Lenta Line',  '2026-06-22T14:00:00Z'),
      (9, 'Test Qop Line',    '2026-06-22T15:00:00Z'),
      (10, 'Test Inactive Line', '2026-06-23T09:00:00Z')
  `);
  // Alice ikkala liniyada (6 va 9) — to'lov taqsimlanmasligi testi uchun.
  await pool.query(`
    INSERT INTO production_line_workers (line_id, worker_name, role, created_at) VALUES
      (6, 'Alice', 'producer', '2026-07-01T08:00:00Z'),
      (6, 'Bob',   'pock',     '2026-07-02T08:00:00Z'),
      (9, 'Alice', 'producer', '2026-07-03T08:00:00Z')
  `);
  await pool.query(`
    INSERT INTO workers (name, prefix, phone, role) VALUES
      ('Alice', 'AL', '+998901234567', 'ishchi'),
      ('Bob', NULL, NULL, 'ishchi')
  `);
  await pool.query(`
    INSERT INTO line_role_config (line_id, role_key, label, rate, max_workers, pay_mode)
    VALUES (6, 'producer', 'Chiqaruvchi', 1000, 5, 'individual'),
           (6, 'pock', 'Qadoqlovchi', 500, 3, 'shared')
  `);

  // WIP: liniya 6 faqat PRODUCE (RECEIVE yo'q) → balans manfiy bo'lishi SHART.
  await pool.query(
    `INSERT INTO wip_movements (line_id, movement_type, product, weight_kg, created_by, note, created_at) VALUES
      (6, 'PRODUCE', $1, 60.5, 'operator1', 'birinchi partiya', '2026-08-01T10:00:00Z'),
      (6, 'PRODUCE', $1, 40,   'operator2', NULL,               '2026-08-15T10:00:00Z')`,
    [ARQON],
  );

  // Partiyalar: liniya 9 normal (worker bog'i bilan); liniya 6 da 1 ta;
  // 2 ta partiya production_line_id=NULL (orphan) — hech bir bo'limga chiqmasligi shart.
  await pool.query(
    `INSERT INTO batches (batch_code, worker, product, quantity, weight_kg, payroll_method, production_line_id, archived, created_at) VALUES
      ('B-001', 'Alice', $1, 50, 25, 'kg', 9, FALSE, '2026-08-10T09:00:00Z'),
      ('B-002', 'Alice', $2, 10,  5, 'kg', 6, FALSE, '2026-08-12T09:00:00Z'),
      ('B-ORF1', 'Orphan Worker', 'Orphan A', 20, 10, 'PRODUCT_RATE', NULL, FALSE, '2026-08-11T09:00:00Z'),
      ('B-ORF2', 'Orphan Worker', 'Orphan B',  7,  3, 'PRODUCT_RATE', NULL, TRUE,  '2026-08-13T09:00:00Z')`,
    [QOP, ARQON],
  );

  // Inventory: ARQON C-T2 da (destination bor); QOP hech qayerda yo'q
  // (destination aniqlanmagan keysi).
  await pool.query(
    `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type) VALUES
      ($1, 'Xom Ip Test', 0, 500, 'raw'),
      ($2, $3, 20, 80, 'finished')`,
    [wh["C-T1"], wh["C-T2"], ARQON],
  );

  // items: ARQON faqat apostrof-varianti bilan (norm-match); QOP YO'Q → sku=null.
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

  // Oylik: salary_entries line_id bilan TO'G'RIDAN-TO'G'RI bog'langan.
  // Liniya 9 yozuvi liniya 6 javobiga KIRMASLIGI shart (izolyatsiya).
  await pool.query(`
    INSERT INTO salary_entries (scope, worker, role, source_type, work_date, kg, rate, amount, line_id) VALUES
      ('arqon', 'Alice', 'producer', 'daily_shared', '2026-08-01', 60.5, 1000, 100000, 6),
      ('arqon', 'Bob',   'pock',     'daily_shared', '2026-08-01', 60.5,  500,  50000, 6),
      ('qop',   'Alice', 'producer', 'daily_shared', '2026-08-10', 25,   1000,  40000, 9)
  `);
  await pool.query(`
    INSERT INTO daily_payroll_runs (scope, work_date, total_kg, status, closed_by, closed_at, line_id) VALUES
      ('arqon', '2026-08-01', 60.5, 'closed', 'admin', '2026-08-01T18:00:00Z', 6)
  `);
  // salary_payments: line_id YO'Q (ishchi darajasida) — Alice'ga 2 ta to'lov.
  await pool.query(`
    INSERT INTO salary_payments (worker, year, month, amount, paid_at) VALUES
      ('Alice', 2026, 6, 100000, '2026-06-15T08:00:00Z'),
      ('Alice', 2026, 7,  50000, '2026-07-15T08:00:00Z')
  `);

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

describe("GET /ombor/flow/department/:id (F4)", () => {
  it("javob sxemasi: barcha F4 bo'limlari mavjud + readOnly", async () => {
    const d = await dept(6);
    expect(d.readOnly).toBe(true);
    expect(typeof d.generatedAt).toBe("string");
    for (const key of [
      "department", "header", "employees", "roles", "salary",
      "wip", "inputs", "outputs", "products", "destinations", "warnings", "meta",
    ]) {
      expect(d, `top-level '${key}' bo'lishi shart`).toHaveProperty(key);
    }
    expect(d.source).toContain("READ ONLY");
  });

  it("validatsiya: butun bo'lmagan id → 400", async () => {
    expect((await getDept("abc")).status).toBe(400);
    expect((await getDept("1.5")).status).toBe(400);
    expect((await getDept("1;SELECT")).status).toBe(400);
    expect((await getDept("-3")).status).toBe(400);
  });

  it("mavjud bo'lmagan liniya → 404", async () => {
    const { status, json } = await getDept(99999);
    expect(status).toBe(404);
    expect(json.error).toContain("topilmadi");
  });

  it("header (§4): ishchilar, rollar, WIP, warning soni", async () => {
    const d = await dept(6);
    expect(d.department).toMatchObject({ id: 6, name: "Test Arqon Line", active: true, inFlowScope: true });
    expect(d.header.employees).toBe(2);
    expect(d.header.roles).toBe(2);
    expect(d.header.wipKg).toBe(-100.5);
    expect(d.header.wipStatus).toBe("NEGATIVE");
    expect(d.header.warnings).toBe(d.warnings.length);
    expect(d.header.warnings).toBeGreaterThan(0);
  });

  it("ishchilar (§5): real ro'yxat, telefon bor/yo'q, boshqa liniya belgisi", async () => {
    const d = await dept(6);
    expect(d.employees).toHaveLength(2);
    const alice = d.employees.find((e: any) => e.worker === "Alice");
    const bob = d.employees.find((e: any) => e.worker === "Bob");
    expect(alice).toMatchObject({ role: "producer", roleLabel: "Chiqaruvchi", phone: "+998901234567", prefix: "AL" });
    expect(alice.otherLines).toEqual([{ id: 9, name: "Test Qop Line" }]);
    // Bob: telefon DB'da yo'q → null (UI "Ma'lumot mavjud emas" ko'rsatadi)
    expect(bob.phone).toBeNull();
    expect(bob.otherLines).toEqual([]);
    expect(bob.roleLabel).toBe("Qadoqlovchi");
  });

  it("rollar: stavka, payMode, hozirgi ishchilar soni", async () => {
    const d = await dept(6);
    const prod = d.roles.find((r: any) => r.roleKey === "producer");
    expect(prod).toMatchObject({ label: "Chiqaruvchi", rate: 1000, payMode: "individual", maxWorkers: 5, workersNow: 1 });
  });

  it("oylik (§6): salary_entries faqat shu liniya (line_id izolyatsiya)", async () => {
    const d = await dept(6);
    expect(d.salary.lineEntries.count).toBe(2);
    expect(d.salary.lineEntries.total).toBe(150000);
    expect(d.salary.lineEntries.workers).toBe(2);
    const workers = d.salary.lineEntries.rows.map((r: any) => r.worker).sort();
    expect(workers).toEqual(["Alice", "Bob"]);
    // liniya 9 yozuvi (40000) bu javobda YO'Q
    expect(d.salary.lineEntries.rows.some((r: any) => r.amount === 40000)).toBe(false);
    const row = d.salary.lineEntries.rows.find((r: any) => r.worker === "Alice");
    expect(row).toMatchObject({ role: "producer", sourceType: "daily_shared", workDate: "2026-08-01", kg: 60.5, rate: 1000, amount: 100000 });
  });

  it("oylik (§6): yopilgan kunlar (daily_payroll_runs)", async () => {
    const d = await dept(6);
    expect(d.salary.payrollRuns.count).toBe(1);
    expect(d.salary.payrollRuns.totalKg).toBe(60.5);
    expect(d.salary.payrollRuns.rows[0]).toMatchObject({
      workDate: "2026-08-01", totalKg: 60.5, status: "closed", closedBy: "admin",
    });
  });

  it("oylik (§6): salary_payments ishchi darajasida — taqsimlanmaydi", async () => {
    const d6 = await dept(6);
    expect(d6.salary.workerPayments.count).toBe(2);
    expect(d6.salary.workerPayments.total).toBe(150000);
    expect(d6.salary.workerPayments.rows.every((p: any) => p.worker === "Alice")).toBe(true);
    // Alice liniya 9 da ham bor — to'lovlar u yerda ham xuddi shu ishchi
    // to'lovi sifatida ko'rinadi (bo'lib tashlanmaydi, ikkiga taqsimlanmaydi).
    const d9 = await dept(9);
    expect(d9.salary.workerPayments.count).toBe(2);
    expect(d9.salary.workerPayments.total).toBe(150000);
    // Ishchining boshqa liniyada ham borligi employees'da ochiq belgilangan.
    expect(d9.employees[0].otherLines).toEqual([{ id: 6, name: "Test Arqon Line" }]);
  });

  it("WIP (§7): balans, harakatlar ro'yxati (desc), operator va izoh", async () => {
    const d = await dept(6);
    expect(d.wip.balanceKg).toBe(-100.5);
    expect(d.wip.produceKg).toBe(100.5);
    expect(d.wip.receiveKg).toBe(0);
    expect(d.wip.rows).toBe(2);
    expect(d.wip.movementsTotal).toBe(2);
    expect(d.wip.movements).toHaveLength(2);
    // Tartib: eng yangi birinchi
    expect(d.wip.movements[0]).toMatchObject({ type: "PRODUCE", product: ARQON, kg: 40, by: "operator2" });
    expect(d.wip.movements[1]).toMatchObject({ kg: 60.5, by: "operator1", note: "birinchi partiya" });
    expect(d.wip.movements[0].at).toContain("2026-08-15");
    expect(d.wip.first).toContain("2026-08-01");
    expect(d.wip.last).toContain("2026-08-15");
  });

  it("manfiy WIP (§7): QIZIL warning, qiymat 0 ga aylantirilmaydi", async () => {
    const d = await dept(6);
    expect(d.wip.status).toBe("NEGATIVE");
    const w = d.warnings.find((x: any) => x.code === "NEGATIVE_WIP");
    expect(w).toBeTruthy();
    expect(w.title).toContain("-100.5");
    expect(w.detail).toContain("yashirilmagan");
  });

  it("kirim (§8): RECEIVE=0 → bo'sh holat + NO_RECEIVE_DATA, taxmin yo'q", async () => {
    const d = await dept(6);
    expect(d.inputs.receives).toEqual([]);
    expect(d.inputs.receiveRows).toBe(0);
    expect(d.warnings.map((x: any) => x.code)).toContain("NO_RECEIVE_DATA");
    // BOM retsept sifatida alohida (real oqim emas)
    expect(d.inputs.bom).toHaveLength(1);
    expect(d.inputs.bom[0]).toMatchObject({ material: "Test Xomashyo", perUnit: 0.5, stock: 100 });
  });

  it("chiqim (§9): PRODUCE agregati + partiyalar worker bog'i bilan", async () => {
    const d6 = await dept(6);
    expect(d6.outputs.produce).toHaveLength(1);
    expect(d6.outputs.produce[0]).toMatchObject({ product: ARQON, kg: 100.5, n: 2, first: "2026-08-01", last: "2026-08-15" });
    expect(d6.outputs.batchesTotal).toBe(1);
    expect(d6.outputs.batchRows[0]).toMatchObject({ code: "B-002", worker: "Alice", product: ARQON, qty: 10, kg: 5 });

    const d9 = await dept(9);
    expect(d9.outputs.produce).toEqual([]);
    expect(d9.outputs.batchesByProduct).toHaveLength(1);
    expect(d9.outputs.batchesByProduct[0]).toMatchObject({ product: QOP, kg: 25, dona: 50, n: 1 });
    // §13: xodim → production faqat real DB bog'i (batches.worker) orqali
    expect(d9.outputs.batchRows[0]).toMatchObject({ code: "B-001", worker: "Alice", payrollMethod: "kg" });
  });

  it("mahsulotlar (§10): SKU norm-match yoki null (nomga qarab yaratilmaydi)", async () => {
    const d6 = await dept(6);
    const arqon = d6.products.find((p: any) => p.name === ARQON);
    expect(arqon.sku).toBe("TM-TEST-01"); // U+02BC vs ASCII apostrof norm-match
    expect(arqon.producedKg).toBe(100.5);
    expect(arqon.batchKg).toBe(5);

    const d9 = await dept(9);
    const qop = d9.products.find((p: any) => p.name === QOP);
    expect(qop.sku).toBeNull(); // items'da yo'q — taxmin qilinmaydi
    expect(d9.warnings.map((x: any) => x.code)).toContain("SKU_MISSING");
  });

  it("destination (§12): inventory orqali bor — ko'rsatiladi; yo'q — bo'sh", async () => {
    const d6 = await dept(6);
    expect(d6.destinations).toHaveLength(1);
    expect(d6.destinations[0]).toMatchObject({ container: "C-T2", kg: 80, dona: 20, products: 1 });
    const arqon = d6.products.find((p: any) => p.name === ARQON);
    expect(arqon.placements).toHaveLength(1);
    expect(arqon.placements[0]).toMatchObject({ container: "C-T2", kg: 80, qty: 20 });

    // QOP inventarda yo'q → placements bo'sh, destination aniqlanmagan
    const d9 = await dept(9);
    const qop = d9.products.find((p: any) => p.name === QOP);
    expect(qop.placements).toEqual([]);
    expect(d9.destinations).toEqual([]);
  });

  it("soxta bog'lanish himoyasi (§16): orphan partiyalar hech bir bo'limda yo'q", async () => {
    for (const id of [6, 8, 9, 10]) {
      const d = await dept(id);
      for (const p of d.products) expect(p.name.startsWith("Orphan")).toBe(false);
      for (const b of d.outputs.batchRows) expect(String(b.product).startsWith("Orphan")).toBe(false);
      expect(d.outputs.batchRows.some((b: any) => b.code?.startsWith("B-ORF"))).toBe(false);
    }
  });

  it("nofaol liniya (§2): ma'lumot sifatida ochiladi, fake faol emas", async () => {
    const d = await dept(10);
    expect(d.department).toMatchObject({ id: 10, active: false, inFlowScope: false });
    expect(d.employees).toEqual([]);
    expect(d.wip.status).toBe("NO_LEDGER");
    expect(d.outputs.produce).toEqual([]);
    expect(d.products).toEqual([]);
  });

  it("bo'sh bo'lim (§21.20): barcha bo'limlar halol bo'sh holatda", async () => {
    const d = await dept(8);
    expect(d.header).toMatchObject({ employees: 0, roles: 0, wipKg: 0, wipStatus: "NO_LEDGER" });
    expect(d.employees).toEqual([]);
    expect(d.salary.lineEntries.count).toBe(0);
    expect(d.salary.payrollRuns.count).toBe(0);
    expect(d.salary.workerPayments.count).toBe(0);
    expect(d.wip.movements).toEqual([]);
    expect(d.inputs.receives).toEqual([]);
    expect(d.destinations).toEqual([]);
    const codes = d.warnings.map((x: any) => x.code);
    expect(codes).toContain("NO_WORKERS");
    expect(codes).toContain("NO_SALARY_DATA");
    expect(codes).toContain("NO_LEDGER");
  });

  it("data quality (§15): faqat shu bo'limga tegishli warninglar", async () => {
    const d6 = await dept(6);
    const codes6 = d6.warnings.map((x: any) => x.code);
    // item_id bo'sh → text-nom bog'lanish warningi (liniya kesimida)
    expect(codes6).toContain("ITEM_LINKS_EMPTY");
    expect(d6.meta.itemLinks.wip).toBe("0/2");
    expect(d6.meta.itemLinks.batches).toBe("0/1");
    // Global UNATTRIBUTED_BATCHES bu panelda YO'Q (bo'limga tegishli emas)
    expect(codes6).not.toContain("UNATTRIBUTED_BATCHES");
    // Liniya 6 da ishchilar bor → NO_WORKERS chiqmaydi
    expect(codes6).not.toContain("NO_WORKERS");
  });

  // Railway masofaviy DB: 4 ta to'liq dept + 2×14 snapshot so'rovi 30s dan
  // oshishi mumkin — shu testga kengroq timeout.
  it("read-only kafolati (§1/§22): jadval o'zgarmaydi + manba tekshiruvi", { timeout: 120_000 }, async () => {
    const before = await tableSnapshot();
    await dept(6);
    await dept(8);
    await dept(9);
    await dept(10);
    const after = await tableSnapshot();
    expect(after).toEqual(before);

    const libSource = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/departmentDetail.ts"),
      "utf8",
    );
    expect(libSource).toMatch(/READ ONLY/);
    expect(libSource).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|CREATE)\b/i);
  });

  it("meta: limitlar oshkor, movementsTotal = jami yozuvlar", async () => {
    const d = await dept(6);
    expect(d.meta.limits).toMatchObject({ wipMovements: 120, salaryEntries: 120, batchRows: 60 });
    expect(d.wip.movementsTotal).toBe(d.wip.rows);
  });

  // OXIRGI test: RECEIVE yozuvi paydo bo'lsa input avtomatik to'ladi (§8).
  // (Bu yozuv TEST sxemasiga kiritiladi — prod'ga emas.)
  it("RECEIVE paydo bo'lganda inputs avtomatik to'ladi", async () => {
    await pool.query(
      `INSERT INTO wip_movements (line_id, movement_type, raw_material, weight_kg, from_warehouse_id, created_at)
       VALUES (6, 'RECEIVE', 'Xom Ip Test', 30, $1, '2026-08-16T10:00:00Z')`,
      [wh["C-T1"]],
    );
    const d = await dept(6);
    expect(d.inputs.receives).toHaveLength(1);
    expect(d.inputs.receives[0]).toMatchObject({ fromName: "C-T1", kg: 30, rows: 1 });
    expect(d.inputs.receiveRows).toBe(1);
    expect(d.warnings.map((x: any) => x.code)).not.toContain("NO_RECEIVE_DATA");
    // Balans hali ham manfiy — halol ko'rsatiladi
    expect(d.wip.balanceKg).toBe(-70.5);
    expect(d.wip.status).toBe("NEGATIVE");
    const recv = d.wip.movements.find((m: any) => m.type === "RECEIVE");
    expect(recv).toMatchObject({ rawMaterial: "Xom Ip Test", kg: 30, fromName: "C-T1" });
  });
});
