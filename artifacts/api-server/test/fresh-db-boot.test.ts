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
// Brand-new-database boot test (Task #21 follow-up).
//
// Spins up a genuinely EMPTY PostgreSQL database (a throwaway DB created on the
// same Railway server), then brings it up to a working state using ONLY the
// real startup init code:
//   1. the Python bot `init_db()`  (base tables)
//   2. the API  `initDb()`         (cold-start columns/tables)
// …in the same order they run in production. It then asserts every table/column
// the warehouse (Ombor) routes query actually exists, and exercises a full
// Ombor material-flow end-to-end (seed warehouse → record a transfer → read it
// back) against the fresh DB.
//
// Why a separate DATABASE (not a schema): the bot `init_db` hardcodes a few
// `public.<table>` references, so search_path schema-isolation would leak onto
// real data. A throwaway database has its own empty `public` schema and is
// dropped in afterAll, so the test never touches production tables.
//
// This is the loud guard the task asks for: if a future feature queries a
// table/column that neither init step creates, either initDb() throws here or
// one of the mounted GET endpoints returns a Postgres "does not exist" 500.
// ─────────────────────────────────────────────────────────────────────────────

const { Client, Pool } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

// Unique throwaway DB name (lowercase, no special chars — valid identifier).
const TMP_DB = `topmart_freshboot_test_${process.pid}_${Date.now()}`;
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
let initDbThrew: unknown = null;
const originalProductionLabelsApproval = process.env.PRODUCTION_LABELS_SCHEMA_APPROVED;

// Where the Python bot lives (…/artifacts/telegram-bot).
const here = path.dirname(fileURLToPath(import.meta.url));
const botDir = path.resolve(here, "../../telegram-bot");

async function dropTmpDb(): Promise<void> {
  const admin = new Client({ connectionString: adminUrl, ssl });
  await admin.connect();
  // Terminate any lingering connections before dropping.
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [TMP_DB],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${TMP_DB}`);
  await admin.end();
}

beforeAll(async () => {
  // Throwaway baza bu migrationni ataylab sinaydi; oddiy runtime startupda
  // gate yoqilmagan bo'ladi.
  process.env.PRODUCTION_LABELS_SCHEMA_APPROVED = "1";

  // 1. Create a brand-new empty database on the same server.
  await dropTmpDb();
  {
    const admin = new Client({ connectionString: adminUrl, ssl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${TMP_DB}`);
    await admin.end();
  }

  // 2. Run the Python bot init_db() against the empty DB (psycopg2 needs SSL).
  execFileSync("python3", ["-c", "from bot.database import init_db; init_db()"], {
    cwd: botDir,
    env: {
      ...process.env,
      DATABASE_URL: tmpUrl(true),
      PRODUCTION_LABELS_SCHEMA_APPROVED: "1",
    },
    stdio: "pipe",
  });

  // 3. Point @workspace/db (and therefore the API initDb + routers) at the
  //    fresh DB. Must be set BEFORE the dynamic import below, because the pool
  //    binds its connection string at import time.
  process.env.RAILWAY_DATABASE_URL = tmpUrl(false);

  const { initDb } = await import("../src/init-db");
  try {
    await initDb();
  } catch (e) {
    // Capture instead of throwing so the dedicated assertion below reports a
    // clear "API initDb failed on a fresh DB" message.
    initDbThrew = e;
  }

  const db = await import("@workspace/db");
  pool = db.pool as unknown as pg.Pool;

  // Mount EVERY route group (bypassing auth middleware — we test schema, not
  // auth). pino-http provides req.log, which several routes use in catch paths.
  const routeModules = [
    "ombor", "inventory-v2", "warehouses", "inventory",
    "dashboard", "batches", "production-labels", "workers", "products", "salary", "payroll",
    "customers", "sales", "sales-products", "debts", "reports",
    "exchange-rate", "raw-materials", "product-materials",
    "packer-product-assignments", "audit", "ai", "health", "auth",
  ];
  const routers = await Promise.all(routeModules.map((m) => import(`../src/routes/${m}`)));

  const { default: pinoHttp } = await import("pino-http");
  const app: Express = express();
  app.use(pinoHttp({ logger: (await import("../src/lib/logger")).logger }));
  app.use(express.json());
  for (const r of routers) app.use(r.default);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) await pool.end();
  // Restore env so other suites/files see the original connection.
  process.env.RAILWAY_DATABASE_URL = adminUrl;
  if (originalProductionLabelsApproval === undefined) {
    delete process.env.PRODUCTION_LABELS_SCHEMA_APPROVED;
  } else {
    process.env.PRODUCTION_LABELS_SCHEMA_APPROVED = originalProductionLabelsApproval;
  }
  await dropTmpDb();
}, 60_000);

async function get(path: string): Promise<{ status: number; text: string; json: any }> {
  const r = await fetch(`${apiUrl}${path}`);
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: r.status, text, json };
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// Tables + the historically-fragile columns ALL route groups depend on
// (ombor/inventory/warehouses, sales, customers, batches, workers, salary,
// payroll, dashboard, reports, audit, ai, auth). If a column here is missing,
// those routes 500 in prod after a fresh install/restore.
const REQUIRED: Record<string, string[]> = {
  warehouses: ["id", "name", "active", "location_type", "capacity_kg", "purpose"],
  inventory: ["id", "warehouse_id", "product", "quantity", "weight_kg", "product_type", "updated_at"],
  stock_movements: [
    "id", "product", "quantity", "movement_type", "from_warehouse_id",
    "to_warehouse_id", "note", "created_by", "product_type", "created_at",
  ],
  wip_movements: [
    "id", "line_id", "movement_type", "raw_material", "product", "weight_kg",
    "from_warehouse_id", "batch_id", "note", "created_by", "created_at",
  ],
  raw_materials: ["id", "name", "current_stock"],
  products: ["name", "line_id", "active", "weight", "unit_type", "default_sale_price", "payroll_method", "pieces_per_box", "roll_length_m"],
  production_lines: ["id", "name"],
  production_line_workers: ["line_id", "worker_name", "role"],
  product_materials: ["product_name", "raw_material_id", "quantity_required"],
  // ── Sales / customers / debts / reports ────────────────────────────────────
  sales: [
    "id", "customer_id", "customer_name", "product", "quantity", "weight_kg",
    "unit_price", "total_amount", "status", "note", "created_at",
    "currency", "payment_type", "paid_amount", "debt_amount",
  ],
  sale_items: ["id", "sale_id", "product_name", "sale_type", "quantity", "unit_price", "currency", "line_total"],
  sale_payments: ["id", "sale_id", "amount", "currency", "note", "created_at"],
  sale_events: ["id", "sale_id", "event_type", "description", "amount", "currency", "user_id", "created_at"],
  sales_products: ["id", "name", "unit", "price", "active", "sale_type", "default_price", "currency"],
  sales_product_tiers: ["id", "product_id", "min_qty", "price", "currency"],
  customers: ["id", "name", "phone", "company", "address", "created_at", "deleted_at"],
  product_price_tiers: ["id", "product_id", "min_quantity", "max_quantity", "price", "currency"],
  // ── Batches / workers / packers ─────────────────────────────────────────────
  batches: [
    "id", "batch_code", "worker", "product", "quantity", "weight_kg",
    "earnings", "payroll_method", "created_at", "archived", "production_line_id",
  ],
  production_labels: [
    "id", "barcode_value", "batch_id", "batch_code", "label_type",
    "label_number", "total_labels", "pieces_in_label", "pieces_per_box", "quantity_total",
    "weight_kg", "length_m", "product_name", "product_sku", "worker_name",
    "produced_at", "warehouse_id", "warehouse_name", "status", "print_count",
    "last_printed_at", "created_at",
  ],
  workers: ["name", "prefix", "phone", "role"],
  user_roles: ["chat_id", "worker_name", "role"],
  packer_assignments: ["packer_chat_id", "worker_name"],
  packer_product_assignments: ["id", "packer_name", "product_name"],
  // ── Salary / payroll ────────────────────────────────────────────────────────
  salary_payments: ["id", "worker", "year", "month", "amount", "paid_at"],
  salary_entries: ["id", "scope", "worker", "role", "source_type", "batch_id", "work_date", "kg", "rate", "amount", "line_id"],
  daily_payroll_runs: ["id", "scope", "line_id", "work_date", "total_kg", "status", "closed_by", "closed_at"],
  payroll_role_rates: ["id", "scope", "role", "rate", "updated_at"],
  kg_payroll_workers: ["id", "scope", "worker_name", "role", "active"],
  line_role_config: ["id", "line_id", "role_key", "label", "rate", "max_workers", "pay_mode"],
  // ── Audit / AI / auth ───────────────────────────────────────────────────────
  audit_logs: ["id", "table_name", "action", "record_id", "changed_by", "old_data", "new_data", "created_at"],
  ai_analysis_runs: ["id", "kind", "summary", "analysis", "created_at"],
  admin_users: ["id", "username", "password_hash", "role"],
  admin_sessions: ["id", "token", "user_id", "created_at"],
};

describe("Fresh DB boots via init code alone", () => {
  it("API initDb() completes without error on a brand-new database", () => {
    expect(initDbThrew, initDbThrew ? `initDb threw: ${(initDbThrew as Error).message}` : undefined)
      .toBeNull();
  });

  it("every table/column the Ombor routes query exists after init", async () => {
    const { rows } = await pool.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'`,
    );
    const have = new Map<string, Set<string>>();
    for (const r of rows) {
      const t = r.table_name as string;
      if (!have.has(t)) have.set(t, new Set());
      have.get(t)!.add(r.column_name as string);
    }

    const missing: string[] = [];
    for (const [table, cols] of Object.entries(REQUIRED)) {
      const present = have.get(table);
      if (!present) { missing.push(`table "${table}" (entire table)`); continue; }
      for (const c of cols) if (!present.has(c)) missing.push(`${table}.${c}`);
    }
    expect(missing, `Missing schema after init: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps a physical label passport immutable and queryable after batch deletion", async () => {
    const warehouse = await pool.query(
      `INSERT INTO warehouses (name, active) VALUES ('Test konteyner', TRUE) RETURNING id`,
    );
    const batch = await pool.query(
      `INSERT INTO batches
         (batch_code, worker, product, quantity, weight_kg, earnings, payroll_method)
       VALUES ('TS-260819-01', 'Test ishchi', 'Test mahsulot', 25, 12.5, 0, 'PRODUCT_RATE')
       RETURNING id`,
    );
    await pool.query(
      `INSERT INTO production_labels
         (barcode_value, batch_id, batch_code, label_type, label_number,
          total_labels, pieces_in_label, pieces_per_box, quantity_total,
          weight_kg, length_m, product_name, product_sku, worker_name,
          produced_at, warehouse_id, warehouse_name, status, print_count,
          last_printed_at)
       VALUES
         ('TMAAAAAAAAAAAAAAAA', $1, 'TS-260819-01', 'box', 1,
          1, 25, 25, 25, 12.5, 80, 'Test mahsulot', 'SKU-TEST-01',
          'Test ishchi', '2026-08-19T08:30:00Z', $2, 'Test konteyner',
          'printed', 2, '2026-08-19T08:35:00Z')`,
      [batch.rows[0].id, warehouse.rows[0].id],
    );

    const response = await get("/production-labels/TMAAAAAAAAAAAAAAAA");
    expect(response.status, response.text).toBe(200);
    expect(response.json).toMatchObject({
      barcode: "TMAAAAAAAAAAAAAAAA",
      batchCode: "TS-260819-01",
      labelType: "box",
      piecesInLabel: 25,
      piecesPerBox: 25,
      weightKg: 12.5,
      lengthM: 80,
      productName: "Test mahsulot",
      productSku: "SKU-TEST-01",
      workerName: "Test ishchi",
      warehouseName: "Test konteyner",
      status: "printed",
      printCount: 2,
    });

    await expect(
      pool.query(
        `UPDATE production_labels
            SET product_name = 'O''zgartirilgan mahsulot'
          WHERE barcode_value = 'TMAAAAAAAAAAAAAAAA'`,
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await pool.query(
      `UPDATE production_labels
          SET print_count = print_count + 1,
              last_printed_at = '2026-08-19T08:40:00Z'
        WHERE barcode_value = 'TMAAAAAAAAAAAAAAAA'`,
    );
    await pool.query(`DELETE FROM batches WHERE id = $1`, [batch.rows[0].id]);

    const afterDelete = await get("/production-labels/TMAAAAAAAAAAAAAAAA");
    expect(afterDelete.status, afterDelete.text).toBe(200);
    expect(afterDelete.json).toMatchObject({
      barcode: "TMAAAAAAAAAAAAAAAA",
      batchId: null,
      batchCode: "TS-260819-01",
      productName: "Test mahsulot",
      productSku: "SKU-TEST-01",
      warehouseName: "Test konteyner",
      printCount: 3,
    });
  });

  // Shared Railway DB yuk ostida har bir so'rov 5-8s ga cho'zilishi mumkin —
  // bu testda o'nlab endpoint bor, shuning uchun timeout kattaroq (flake emas, latency).
  it("GET endpoints across ALL route groups don't 500 on a fresh (empty) DB", { timeout: 180_000 }, async () => {
    const paths = [
      // Ombor / inventory / warehouses
      "/ombor/summary",
      "/ombor/containers",
      "/ombor/raw-materials",
      "/ombor/finished-goods",
      "/ombor/movements",
      "/ombor/flow",
      "/inventory/stock",
      "/inventory/summary",
      "/inventory/movements",
      "/inventory",
      "/warehouses",
      // Dashboard
      "/dashboard/today",
      "/dashboard/monthly",
      "/dashboard/top-workers",
      "/dashboard/daily-chart",
      "/dashboard/v2",
      "/dashboard/product-highlights",
      "/dashboard/today-extended",
      // Batches / workers / products
      "/batches",
      "/production-labels/TMAAAAAAAAAAAAAAAA",
      "/workers",
      "/products",
      // Salary / payroll
      "/salary/report",
      "/payroll/role-rates",
      "/payroll/workers",
      "/payroll/lines",
      "/payroll/worker-earnings",
      "/payroll/day-status",
      "/payroll/line-configs",
      // Customers / sales / debts / reports
      "/customers",
      "/sales",
      "/sales-products",
      "/debts/summary",
      "/reports/summary",
      "/reports/product-profitability",
      "/reports/sales-summary",
      // Raw materials / product materials / packers
      "/raw-materials",
      "/raw-materials/low-stock",
      "/product-materials",
      "/packer-assignments",
      "/packer-worker-assignments",
      // Exchange rate (has internal fallback — never 500s)
      "/exchange-rate",
      // Audit / AI (cached-runs listing only — no LLM call)
      "/audit-logs",
      "/ai/runs",
      // Auth (no token → expects 401, never 500) / health
      "/auth/me",
      "/healthz",
    ];
    const failures: string[] = [];
    for (const p of paths) {
      const r = await get(p);
      if (r.status >= 500) failures.push(`${p} → ${r.status}: ${r.text.slice(0, 200)}`);
    }
    expect(failures, `Endpoints errored on fresh DB:\n${failures.join("\n")}`).toEqual([]);
  });
});

describe("Ombor material flow end-to-end on a fresh DB", () => {
  const MATERIAL = "Test Polipropilen";
  const RAW_CONTAINER = "Fresh Raw Konteyner";
  let containerId: number;
  let lineId: number;

  beforeAll(async () => {
    // Seed the minimum config the flow needs, using the same shapes the app uses.
    // raw-in REJECTS any material name with no matching raw_materials row, so a
    // material definition must exist first.
    await pool.query(
      `INSERT INTO raw_materials (name, unit, unit_type, default_cost, currency, current_stock)
       VALUES ($1, 'kg', 'kg', 0, 'UZS', 0)
       ON CONFLICT (name) DO NOTHING`,
      [MATERIAL],
    );
    // A container warehouse (only containers can hold raw/finished flow stock).
    const wh = await pool.query(
      `INSERT INTO warehouses (name, location_type, purpose, active)
       VALUES ($1, 'container', 'finished', TRUE)
       ON CONFLICT (name) DO UPDATE SET location_type='container'
       RETURNING id`,
      [RAW_CONTAINER],
    );
    containerId = wh.rows[0].id;
    // A production line to receive material into (bot init also seeds one).
    const line = await pool.query(
      `INSERT INTO production_lines (name) VALUES ('Fresh Test Liniya')
       ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
    );
    lineId = line.rows[0].id;
  });

  it("marks a container as a raw warehouse via the route", async () => {
    const res = await post("/ombor/flow/container-purpose", {
      warehouseId: containerId, purpose: "raw",
    });
    expect(res.status).toBe(200);
  });

  it("records raw intake (raw-in) and reflects it in container + global stock", async () => {
    const res = await post("/ombor/flow/raw-in", {
      warehouseId: containerId, materialName: MATERIAL, kg: 500,
    });
    expect(res.status).toBe(200);

    // Global raw stock incremented (single entry point invariant).
    const { rows } = await pool.query(
      `SELECT current_stock FROM raw_materials WHERE name = $1`, [MATERIAL],
    );
    expect(Number(rows[0].current_stock)).toBeCloseTo(500, 3);

    // Container inventory holds the raw line (quantity = weight_kg = kg).
    const flow = await get("/ombor/flow");
    expect(flow.status).toBe(200);
    const container = flow.json.rawContainers.find((c: any) => c.id === containerId);
    expect(container).toBeTruthy();
    expect(container.totalKg).toBeCloseTo(500, 3);
  });

  it("hands material to a department (receive) and exposes it as WIP", async () => {
    const res = await post("/ombor/flow/receive", {
      warehouseId: containerId, lineId, materialName: MATERIAL, kg: 200,
    });
    expect(res.status).toBe(200);

    const flow = await get("/ombor/flow");
    expect(flow.status).toBe(200);

    // Container drained by 200 → 300 left.
    const container = flow.json.rawContainers.find((c: any) => c.id === containerId);
    expect(container.totalKg).toBeCloseTo(300, 3);

    // Department now shows 200 kg WIP (SUM(RECEIVE) − SUM(PRODUCE)).
    const dept = flow.json.departments.find((d: any) => d.id === lineId);
    expect(dept).toBeTruthy();
    expect(dept.wipKg).toBeCloseTo(200, 3);

    // The movement history records the RECEIVE entry, read back from the ledger.
    const receive = flow.json.history.find(
      (h: any) => h.movementType === "RECEIVE" && h.rawMaterial === MATERIAL,
    );
    expect(receive).toBeTruthy();
    expect(receive.weightKg).toBeCloseTo(200, 3);
  });
});
