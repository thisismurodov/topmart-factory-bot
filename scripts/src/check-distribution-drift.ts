import { execFileSync } from "node:child_process";
import path from "node:path";
import { getTableColumns } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import pg from "pg";
import {
  normalizeDrizzleDefault,
  normalizeRuntimeDefault,
  normalizeType,
  withDatabase,
} from "./drift-utils";
import {
  agentLocationsTable,
  aiSuggestCacheTable,
  agentPlansTable,
  deliveryAgentsTable,
  deliveryRoutesTable,
  distMahsulotlarTable,
  distUsersTable,
  dokonlarTable,
  dokonLocationLogTable,
  fieldOpsTable,
  fieldRouteOrdersTable,
  mijozBalansTable,
  nasiyaTable,
  olmaganDokonlarTable,
  pulOlishTable,
  revisitlarTable,
  savdolarTable,
  savdoTafsilotTable,
  vehiclesTable,
  vehicleAssignmentsTable,
  vehicleHandoffsTable,
  vehicleHandoffItemsTable,
  vehicleUnitEventsTable,
  vehicleSaleAllocationsTable,
  vehicleLabelClaimsTable,
  vehicleLabelPrepareSessionsTable,
  vehicleLabelPrintSessionsTable,
  vehicleStockTargetsTable,
  vehicleReplenishmentRequestsTable,
  vehicleReconciliationsTable,
  vehicleReconciliationItemsTable,
} from "@workspace/db";

// Distribution sxemasi UCH joyda ta'riflangan va qo'lda sinxron saqlanadi:
//
//   1. Bot runtime DDL — artifacts/distribution-bot/database/connection.py
//      (_INIT_DDL, har startupda ishlaydi)
//   2. Mustaqil DDL skript — scripts/src/init-distribution.ts
//   3. Kanonik Drizzle mirror — lib/db/src/schema/distribution.ts
//
// Bu skript driftni ushlaydi:
//
//   1. IKKITA tashlanadigan (throwaway) baza yaratadi
//   2. Bot init_db() ni bittasiga, init-distribution.ts ni ikkinchisiga qarshi
//      ishga tushiradi (bitta bazada IF NOT EXISTS ikkinchi DDLni yashirardi)
//   3. Har ikkala natijani Drizzle mirror bilan solishtiradi: jadval to'plami,
//      ustun nomlari, turlari, nullability va defaultlar
//
// Bir nusxaga ustun/jadval qo'shilsa-yu boshqalariga qo'shilmasa — non-zero exit.
//
// TABLES — Drizzle mirror'dagi har bir distribution jadvali. Yangi jadval
// qo'shsangiz (connection.py _INIT_DDL + init-distribution.ts + Drizzle),
// shu yerga ham qo'shing. Qo'shimcha jadval (Drizzle'da yo'q) ham xato —
// mirror to'liq bo'lishi shart.
// Parallel validation'lar bir-birining bazasini DROP qilmasligi uchun nom
// har bir ishga tushirishda unikal (pid + timestamp).
//
// Vehicle Distribution Pilot: throwaway DBs always set
// VEHICLE_DISTRIBUTION_SCHEMA_APPROVED=1 so all vehicle tables are created and
// validated against the Drizzle mirror. The gate only guards the production/
// Railway databases.
const RUN_ID = `${process.pid}_${Date.now()}`;
const BOT_DB = `dist_drift_bot_${RUN_ID}`;
const TS_DB = `dist_drift_ts_${RUN_ID}`;
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

const TABLES = {
  agent_locations: agentLocationsTable,
  ai_suggest_cache: aiSuggestCacheTable,
  agent_plans: agentPlansTable,
  delivery_agents: deliveryAgentsTable,
  delivery_routes: deliveryRoutesTable,
  dokon_location_log: dokonLocationLogTable,
  dokonlar: dokonlarTable,
  field_ops: fieldOpsTable,
  field_route_orders: fieldRouteOrdersTable,
  mahsulotlar: distMahsulotlarTable,
  mijoz_balans: mijozBalansTable,
  nasiya: nasiyaTable,
  olmagan_dokonlar: olmaganDokonlarTable,
  pul_olish: pulOlishTable,
  revisitlar: revisitlarTable,
  savdo_tafsilot: savdoTafsilotTable,
  savdolar: savdolarTable,
  users: distUsersTable,
  // Vehicle Distribution Pilot tables (always included in throwaway validation)
  vehicles: vehiclesTable,
  vehicle_assignments: vehicleAssignmentsTable,
  vehicle_handoffs: vehicleHandoffsTable,
  vehicle_handoff_items: vehicleHandoffItemsTable,
  vehicle_unit_events: vehicleUnitEventsTable,
  vehicle_sale_allocations: vehicleSaleAllocationsTable,
  vehicle_label_claims: vehicleLabelClaimsTable,
  vehicle_label_prepare_sessions: vehicleLabelPrepareSessionsTable,
  vehicle_label_print_sessions: vehicleLabelPrintSessionsTable,
  vehicle_stock_targets: vehicleStockTargetsTable,
  vehicle_replenishment_requests: vehicleReplenishmentRequestsTable,
  vehicle_reconciliations: vehicleReconciliationsTable,
  vehicle_reconciliation_items: vehicleReconciliationItemsTable,
} as const;

type ColSpec = { type: string; notNull: boolean; def: string | null };

// ── Index / unique-constraint comparison ─────────────────────────────────────

type IndexSpec = { tableName: string; unique: boolean; columns: string[] };

/** Stable comparison key: table + ordered columns + uniqueness. */
function indexKey(s: IndexSpec): string {
  return `${s.tableName}:${s.columns.join(",")}:${s.unique}`;
}

/**
 * Extract all non-PK, non-partial indexes from a live throwaway DB via pg_catalog.
 * Partial unique indexes are excluded here — they are
 * validated separately by compareVehicleChecksAndPartialIndexes().
 * Returns a Map<key, IndexSpec> where key = indexKey(spec).
 */
async function readActualIndexes(pool: pg.Pool): Promise<Map<string, IndexSpec>> {
  // array_position requires the indkey to be cast to int[] for 0-based position lookups.
  const { rows } = await pool.query<{
    tablename: string;
    is_unique: boolean;
    columns: string[];
  }>(`
    SELECT
      t.relname                                                        AS tablename,
      ix.indisunique                                                   AS is_unique,
      array_agg(
        a.attname
        ORDER BY array_position(ix.indkey::int[], a.attnum::int)
      )                                                                AS columns
    FROM pg_index     ix
    JOIN pg_class     t  ON t.oid  = ix.indrelid
    JOIN pg_class     i  ON i.oid  = ix.indexrelid
    JOIN pg_namespace n  ON n.oid  = t.relnamespace
    JOIN pg_attribute a  ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
    WHERE n.nspname = 'distribution'
      AND NOT ix.indisprimary
      -- Exclude partial indexes on vehicle tables: they are validated separately
      -- by compareVehicleChecksAndPartialIndexes() which checks predicates too.
      AND ix.indpred IS NULL
    GROUP BY ix.indexrelid, t.relname, ix.indisunique
    ORDER BY t.relname
  `);

  const out = new Map<string, IndexSpec>();
  for (const r of rows) {
    // The pg driver returns PostgreSQL arrays as strings (e.g. "{agent_id,oy}") — parse them.
    const columns: string[] =
      Array.isArray(r.columns)
        ? r.columns
        : String(r.columns)
            .replace(/^\{/, "")
            .replace(/\}$/, "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    const spec: IndexSpec = { tableName: r.tablename, unique: r.is_unique, columns };
    out.set(indexKey(spec), spec);
  }
  return out;
}

/**
 * Derive the expected index set from Drizzle table definitions.
 *
 * Two sources:
 *  - table-config `index()` / `uniqueIndex()` calls  → index.config.{name,columns,unique}
 *  - column-level `.unique()` calls                  → uniqueConstraints[].columns
 *
 * We normalise by (table, columns, isUnique) — not by index name — so that
 * PostgreSQL's auto-generated constraint names (e.g. `users_telegram_id_key`)
 * don't cause spurious mismatches against Drizzle's internal naming.
 */
function drizzleExpectedIndexes(): Map<string, IndexSpec> {
  const out = new Map<string, IndexSpec>();

  for (const [tableName, table] of Object.entries(TABLES)) {
    const cfg = getTableConfig(table as Parameters<typeof getTableConfig>[0]);

    // Named indexes declared in the table extra-config function
    for (const idx of cfg.indexes) {
      // Partial indexes are compared separately with their predicates.
      if (idx.config.where) continue;
      const cols: string[] = [];
      for (const c of idx.config.columns) {
        // IndexedColumn has a `name` property; SQL expressions do not — skip those.
        if (c && typeof c === "object" && "name" in c && typeof (c as { name?: unknown }).name === "string") {
          cols.push((c as { name: string }).name);
        }
      }
      if (cols.length === 0) continue; // expression-only index — can't compare by column name
      const spec: IndexSpec = { tableName, unique: idx.config.unique, columns: cols };
      out.set(indexKey(spec), spec);
    }

    // Column-level unique constraints (.unique() on individual columns).
    // These do NOT appear in cfg.uniqueConstraints — they're stored directly
    // on the column as `column.isUnique = true`.
    for (const col of cfg.columns) {
      if ((col as unknown as { isUnique?: boolean }).isUnique) {
        const spec: IndexSpec = { tableName, unique: true, columns: [col.name] };
        out.set(indexKey(spec), spec);
      }
    }

    // Table-level unique() calls (unique("name").on(col1, col2) syntax)
    for (const uc of cfg.uniqueConstraints) {
      const cols = uc.columns.map((c) => c.name);
      const spec: IndexSpec = { tableName, unique: true, columns: cols };
      out.set(indexKey(spec), spec);
    }
  }

  return out;
}

/**
 * Compare expected (Drizzle) indexes against actual (runtime DDL) indexes.
 * Returns true if drift was found.
 */
function compareIndexes(
  label: string,
  expected: Map<string, IndexSpec>,
  actual: Map<string, IndexSpec>,
): boolean {
  let drift = false;

  for (const [key, spec] of expected) {
    if (!actual.has(key)) {
      const desc = `${spec.tableName}(${spec.columns.join(", ")})${spec.unique ? " UNIQUE" : ""}`;
      console.error(`✗ [${label}] Indeks yo'q: ${desc}`);
      drift = true;
    }
  }

  for (const [key, spec] of actual) {
    if (!expected.has(key)) {
      const desc = `${spec.tableName}(${spec.columns.join(", ")})${spec.unique ? " UNIQUE" : ""}`;
      console.error(`✗ [${label}] Drizzle mirror'da ko'zda tutilmagan indeks: ${desc}`);
      drift = true;
    }
  }

  if (!drift) {
    console.log(`✓ [${label}] ${expected.size} indeks mos (nom + ustunlar + uniqueness)`);
  }

  return drift;
}

function drizzleExpected(): Map<string, Map<string, ColSpec>> {
  const out = new Map<string, Map<string, ColSpec>>();
  for (const [tableName, table] of Object.entries(TABLES)) {
    out.set(
      tableName,
      new Map(
        Object.values(getTableColumns(table)).map((c: Column) => [
          c.name,
          {
            type: normalizeType(c.getSQLType()),
            notNull: c.notNull,
            def: normalizeDrizzleDefault(c),
          },
        ]),
      ),
    );
  }
  return out;
}

async function readActual(pool: pg.Pool): Promise<Map<string, Map<string, ColSpec>>> {
  const { rows } = await pool.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'distribution'`,
  );
  const out = new Map<string, Map<string, ColSpec>>();
  for (const r of rows) {
    if (!out.has(r.table_name)) out.set(r.table_name, new Map());
    out.get(r.table_name)!.set(r.column_name, {
      type: r.data_type.toLowerCase(),
      notNull: r.is_nullable.toUpperCase() === "NO",
      def: normalizeRuntimeDefault(r.column_default),
    });
  }
  return out;
}

// `expected` (Drizzle mirror) ↔ `actual` (runtime DDL natijasi) solishtirish.
// `label` — qaysi runtime manba tekshirilayotgani (xato xabarlari uchun).
function compare(
  label: string,
  expected: Map<string, Map<string, ColSpec>>,
  actual: Map<string, Map<string, ColSpec>>,
): boolean {
  let drift = false;

  for (const tableName of actual.keys()) {
    if (!expected.has(tableName)) {
      console.error(`✗ [${label}] "${tableName}" jadvali Drizzle mirror'da yo'q`);
      drift = true;
    }
  }

  for (const [tableName, expCols] of expected) {
    const actCols = actual.get(tableName);
    if (!actCols) {
      console.error(`✗ [${label}] "${tableName}" jadvali yaratilmagan`);
      drift = true;
      continue;
    }

    const missing = [...expCols.keys()].filter((c) => !actCols.has(c));
    const extra = [...actCols.keys()].filter((c) => !expCols.has(c));
    const typeMismatch = [...expCols.entries()]
      .filter(([name, e]) => actCols.has(name) && actCols.get(name)!.type !== e.type)
      .map(([name, e]) => `${name} (Drizzle: ${e.type}, ${label}: ${actCols.get(name)!.type})`);
    const nullMismatch = [...expCols.entries()]
      .filter(([name, e]) => actCols.has(name) && actCols.get(name)!.notNull !== e.notNull)
      .map(
        ([name, e]) =>
          `${name} (Drizzle: ${e.notNull ? "NOT NULL" : "nullable"}, ${label}: ${
            actCols.get(name)!.notNull ? "NOT NULL" : "nullable"
          })`,
      );
    const defaultMismatch = [...expCols.entries()]
      .filter(([name, e]) => actCols.has(name) && actCols.get(name)!.def !== e.def)
      .map(
        ([name, e]) =>
          `${name} (Drizzle: ${e.def ?? "yo'q"}, ${label}: ${actCols.get(name)!.def ?? "yo'q"})`,
      );

    if (
      missing.length ||
      extra.length ||
      typeMismatch.length ||
      nullMismatch.length ||
      defaultMismatch.length
    ) {
      if (missing.length)
        console.error(`✗ [${label}] ${tableName}: yo'q ustun(lar): ${missing.join(", ")}`);
      if (extra.length)
        console.error(
          `✗ [${label}] ${tableName}: Drizzle mirror'da yo'q ustun(lar): ${extra.join(", ")}`,
        );
      if (typeMismatch.length)
        console.error(`✗ [${label}] ${tableName}: tur mos emas: ${typeMismatch.join("; ")}`);
      if (nullMismatch.length)
        console.error(
          `✗ [${label}] ${tableName}: nullability mos emas: ${nullMismatch.join("; ")}`,
        );
      if (defaultMismatch.length)
        console.error(
          `✗ [${label}] ${tableName}: default mos emas: ${defaultMismatch.join("; ")}`,
        );
      drift = true;
    } else {
      console.log(
        `✓ [${label}] ${tableName}: ${expCols.size} ustun mos (nom + tur + nullability + default)`,
      );
    }
  }

  return drift;
}

// ── Vehicle CHECK + partial-index predicate catalog validation ────────────────
//
// The Drizzle index() API cannot express WHERE predicates, so partial unique
// indexes (vehicle_assignments active-vehicle guard, replenishment open-request
// guard, reconciliation_items adjustment_reference single-apply) and named
// CHECK constraints cannot be validated via drizzleExpectedIndexes(). Instead
// we query pg_catalog directly on each throwaway DB and assert:
//   • Every expected named CHECK constraint exists with the correct expression.
//   • Every expected partial unique index exists with the correct predicate.
//
// Both sources (bot DDL and init-distribution.ts) must materialise identical
// catalog entries. A mismatch → non-zero exit.
// ─────────────────────────────────────────────────────────────────────────────

type CheckSpec = { table: string; name: string; expr: string };
type PartialIdxSpec = { table: string; name: string; predicate: string };

/**
 * Normalize a pg_catalog CHECK expression or index predicate for stable
 * comparison across PostgreSQL's internal rewriting:
 *
 *   col IN ('a','b')  →  stored as col = any (array['a'::text, ...])
 *   x >= 0            →  stored as x >= (0)::numeric
 *   (a is null) or (b >= 0)  →  OR compound, parens per sub-expr
 *   (status = 'active'       →  pg_get_expr partial index predicates lack closing paren
 *
 * Strategy: lower-case, collapse whitespace, strip type casts on numeric/string
 * literals, convert `= any (array[...])` → `in (...)`, remove all
 * parentheses (both balanced and the trailing-paren-missing pg_get_expr case),
 * then re-normalise whitespace around keywords.
 */
function normalizeExpr(raw: string): string {
  let s = raw.trim().toLowerCase();
  // Strip CHECK(...) wrapper from pg_get_constraintdef output.
  s = s.replace(/^check\s*\(/, "").replace(/\)\s*$/, "").trim();
  // Collapse whitespace.
  s = s.replace(/\s+/g, " ").trim();
  // Strip type casts on numeric literals: (0)::numeric → 0
  s = s.replace(/\(\s*(-?\d+(?:\.\d+)?)\s*\)::[a-z_]+/g, "$1");
  // Strip bare casts on string literals: 'foo'::text → 'foo'
  s = s.replace(/'([^']*)'::[a-z_ ]+/g, "'$1'");
  // Convert `= any (array['a', 'b'])` → `in ('a','b')`
  s = s.replace(
    /=\s*any\s*\(\s*array\s*\[\s*(.*?)\s*\]\s*\)/g,
    (_m, items: string) => `in (${items.replace(/\s*,\s*/g, ",")})`,
  );
  // Remove all parentheses — PostgreSQL wraps each sub-expression differently
  // across versions and expr types; we compare the token sequence only.
  s = s.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

/** Read named CHECK constraints from the distribution schema's vehicle tables. */
async function readActualChecks(pool: pg.Pool): Promise<Map<string, CheckSpec>> {
  const { rows } = await pool.query<{ table_name: string; conname: string; consrc: string }>(`
    SELECT c.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS consrc
    FROM pg_constraint con
    JOIN pg_class     c   ON c.oid = con.conrelid
    JOIN pg_namespace n   ON n.oid = c.relnamespace
    WHERE n.nspname = 'distribution'
      AND con.contype = 'c'
      AND c.relname LIKE 'vehicle%'
    ORDER BY c.relname, con.conname
  `);
  const out = new Map<string, CheckSpec>();
  for (const r of rows) {
    const spec: CheckSpec = {
      table: r.table_name,
      name: r.conname,
      expr: normalizeExpr(r.consrc),
    };
    out.set(r.conname, spec);
  }
  return out;
}

/** Read partial unique indexes from the distribution schema's vehicle tables. */
async function readActualPartialIndexes(pool: pg.Pool): Promise<Map<string, PartialIdxSpec>> {
  const { rows } = await pool.query<{
    table_name: string;
    index_name: string;
    predicate: string;
  }>(`
    SELECT c.relname AS table_name, i.relname AS index_name,
           pg_get_expr(ix.indpred, ix.indrelid) AS predicate
    FROM pg_index     ix
    JOIN pg_class     c  ON c.oid  = ix.indrelid
    JOIN pg_class     i  ON i.oid  = ix.indexrelid
    JOIN pg_namespace n  ON n.oid  = c.relnamespace
    WHERE n.nspname = 'distribution'
      AND ix.indisunique
      AND ix.indpred IS NOT NULL
      AND (c.relname LIKE 'vehicle%' OR c.relname = 'savdolar')
    ORDER BY c.relname, i.relname
  `);
  const out = new Map<string, PartialIdxSpec>();
  for (const r of rows) {
    const spec: PartialIdxSpec = {
      table: r.table_name,
      name: r.index_name,
      predicate: normalizeExpr(r.predicate),
    };
    out.set(r.index_name, spec);
  }
  return out;
}

// Canonical expected CHECKs for vehicle tables — kept in sync with VEHICLE_DDL.
const EXPECTED_CHECKS: CheckSpec[] = [
  { table: "vehicles", name: "vehicles_type_check",     expr: normalizeExpr("vehicle_type IN ('DAMAS','LABO','NEXIA','SPARK','COBALT','OTHER')") },
  { table: "vehicles", name: "vehicles_status_check",   expr: normalizeExpr("status IN ('active','inactive','in_warehouse','on_route','maintenance')") },
  { table: "vehicles", name: "vehicles_capacity_check", expr: normalizeExpr("capacity_kg >= 0") },
  { table: "vehicle_assignments", name: "vehicle_assignments_status_check", expr: normalizeExpr("status IN ('active','ended')") },
  { table: "vehicle_handoffs", name: "vehicle_handoffs_status_check", expr: normalizeExpr("status IN ('prepared','labels_printed','handed_over','stock_transferred','cancelled')") },
  { table: "vehicle_handoff_items", name: "vehicle_handoff_items_qty_check",  expr: normalizeExpr("quantity_dispatched > 0") },
  { table: "vehicle_handoff_items", name: "vehicle_handoff_items_cost_check", expr: normalizeExpr("unit_cost >= 0") },
  { table: "vehicle_handoff_items", name: "vehicle_handoff_items_unit_weight_check",  expr: normalizeExpr("unit_weight_kg IS NULL OR unit_weight_kg >= 0") },
  { table: "vehicle_handoff_items", name: "vehicle_handoff_items_total_weight_check", expr: normalizeExpr("total_weight_kg IS NULL OR total_weight_kg >= 0") },
  { table: "vehicle_unit_events", name: "vehicle_unit_events_type_check", expr: normalizeExpr("event_type IN ('load','unload','return','adjustment','sale','label_prepared','label_printed')") },
  { table: "vehicle_unit_events", name: "vehicle_unit_events_qty_check",  expr: normalizeExpr("quantity <> 0") },
  { table: "vehicle_sale_allocations", name: "vehicle_sale_allocations_qty_check",    expr: normalizeExpr("allocated_quantity > 0") },
  { table: "vehicle_sale_allocations", name: "vehicle_sale_allocations_concrete_qty_check", expr: normalizeExpr("label_claim_id IS NULL OR allocated_quantity = 1") },
  { table: "vehicle_sale_allocations", name: "vehicle_sale_allocations_weight_check", expr: normalizeExpr("allocated_weight_kg > 0") },
  { table: "vehicle_label_claims", name: "vehicle_label_claims_status_check", expr: normalizeExpr("status IN ('prepared','printed','loaded','sold','returned')") },
  { table: "vehicle_label_claims", name: "vehicle_label_claims_weight_check", expr: normalizeExpr("unit_weight_kg > 0") },
  { table: "vehicle_label_prepare_sessions", name: "vehicle_label_prepare_sessions_count_check", expr: normalizeExpr("label_count > 0") },
  { table: "vehicle_label_print_sessions", name: "vehicle_label_print_sessions_count_check", expr: normalizeExpr("label_count > 0") },
  { table: "vehicle_stock_targets", name: "vehicle_stock_targets_qty_check", expr: normalizeExpr("target_quantity > 0") },
  { table: "vehicle_stock_targets", name: "vehicle_stock_targets_min_check", expr: normalizeExpr("min_quantity >= 0") },
  { table: "vehicle_stock_targets", name: "vehicle_stock_targets_range_check", expr: normalizeExpr("min_quantity <= target_quantity") },
  { table: "vehicle_stock_targets", name: "vehicle_stock_targets_whole_units_check", expr: normalizeExpr("public_product_id IS NULL OR target_quantity = trunc(target_quantity) AND min_quantity = trunc(min_quantity)") },
  { table: "vehicle_stock_targets", name: "vehicle_stock_targets_identity_check", expr: normalizeExpr("public_product_id IS NULL OR (product_name IS NOT NULL AND btrim(product_name) <> '' AND btrim(sku) <> '')") },
  { table: "vehicle_replenishment_requests", name: "vehicle_replenishment_status_check",   expr: normalizeExpr("status IN ('pending','approved','fulfilled','rejected','cancelled')") },
  { table: "vehicle_replenishment_requests", name: "vehicle_replenishment_qty_check",      expr: normalizeExpr("requested_quantity > 0") },
  { table: "vehicle_replenishment_requests", name: "vehicle_replenishment_approved_check", expr: normalizeExpr("approved_quantity IS NULL OR approved_quantity > 0") },
  { table: "vehicle_replenishment_requests", name: "vehicle_replenishment_whole_units_check", expr: normalizeExpr("public_product_id IS NULL OR requested_quantity = trunc(requested_quantity) AND (approved_quantity IS NULL OR approved_quantity = trunc(approved_quantity))") },
  { table: "vehicle_replenishment_requests", name: "vehicle_replenishment_identity_check", expr: normalizeExpr("public_product_id IS NULL OR (product_name IS NOT NULL AND btrim(product_name) <> '' AND btrim(sku) <> '')") },
  { table: "vehicle_replenishment_requests", name: "vehicle_replenishment_snapshot_check", expr: normalizeExpr("public_product_id IS NULL OR (target_quantity_snapshot > 0 AND current_quantity_snapshot >= 0 AND requested_quantity = target_quantity_snapshot - current_quantity_snapshot)") },
  { table: "vehicle_replenishment_requests", name: "vehicle_replenishment_full_approval_check", expr: normalizeExpr("status <> ALL (ARRAY['approved', 'fulfilled']) OR (approved_quantity IS NOT NULL AND approved_quantity = requested_quantity)") },
  { table: "vehicle_replenishment_requests", name: "vehicle_replenishment_linkage_check", expr: normalizeExpr(`
    public_product_id IS NULL OR
    (status = 'pending' AND approved_quantity IS NULL AND approved_by IS NULL
     AND approved_at IS NULL AND handoff_id IS NULL AND source_warehouse_id IS NULL
     AND cancelled_by IS NULL AND cancelled_at IS NULL AND fulfilled_at IS NULL)
    OR (status = 'approved' AND approved_quantity = requested_quantity
     AND approved_by IS NOT NULL AND approved_at IS NOT NULL
     AND handoff_id IS NOT NULL AND source_warehouse_id IS NOT NULL
     AND cancelled_by IS NULL AND cancelled_at IS NULL AND fulfilled_at IS NULL)
    OR (status = 'fulfilled' AND approved_quantity = requested_quantity
     AND approved_by IS NOT NULL AND approved_at IS NOT NULL
     AND handoff_id IS NOT NULL AND source_warehouse_id IS NOT NULL
     AND cancelled_by IS NULL AND cancelled_at IS NULL AND fulfilled_at IS NOT NULL)
    OR (status = 'cancelled' AND cancelled_by IS NOT NULL
     AND cancelled_at IS NOT NULL AND fulfilled_at IS NULL)
    OR (status = 'rejected' AND handoff_id IS NULL AND fulfilled_at IS NULL)
  `) },
  { table: "vehicle_reconciliations", name: "vehicle_reconciliations_status_check", expr: normalizeExpr("status IN ('draft','approved','applied','disputed','cancelled')") },
  { table: "vehicle_reconciliation_items", name: "vehicle_reconciliation_items_expected_check", expr: normalizeExpr("expected_quantity >= 0") },
  { table: "vehicle_reconciliation_items", name: "vehicle_reconciliation_items_expected_weight_check", expr: normalizeExpr("expected_weight_kg IS NULL OR expected_weight_kg >= 0") },
  { table: "vehicle_reconciliation_items", name: "vehicle_reconciliation_items_actual_check",   expr: normalizeExpr("actual_quantity IS NULL OR actual_quantity >= 0") },
  { table: "vehicle_reconciliation_items", name: "vehicle_reconciliation_items_erp_line_check", expr: normalizeExpr("public_product_id IS NULL OR (product_name IS NOT NULL AND sku IS NOT NULL)") },
];

// Canonical expected partial unique indexes for vehicle tables.
const EXPECTED_PARTIAL_INDEXES: PartialIdxSpec[] = [
  {
    table: "savdolar",
    name: "uq_savdolar_operation_key",
    predicate: normalizeExpr("operation_key IS NOT NULL"),
  },
  {
    table: "vehicle_assignments",
    name: "uq_vehicle_assignments_active_vehicle",
    predicate: normalizeExpr("status = 'active'"),
  },
  {
    table: "vehicle_assignments",
    name: "uq_vehicle_assignments_active_agent",
    predicate: normalizeExpr("status = 'active'"),
  },
  {
    table: "vehicle_handoffs",
    name: "uq_vehicle_handoffs_operation_key",
    predicate: normalizeExpr("operation_key IS NOT NULL"),
  },
  {
    table: "vehicle_handoffs",
    name: "uq_vehicle_handoffs_movement_reference",
    predicate: normalizeExpr("movement_reference IS NOT NULL"),
  },
  {
    table: "vehicle_unit_events",
    name: "uq_vehicle_unit_events_operation_key",
    predicate: normalizeExpr("operation_key IS NOT NULL"),
  },
  {
    table: "vehicle_label_claims",
    name: "uq_vehicle_label_claims_operation_key",
    predicate: normalizeExpr("operation_key IS NOT NULL"),
  },
  {
    table: "vehicle_unit_events",
    name: "uq_vehicle_unit_events_load_label",
    predicate: normalizeExpr("event_type = 'load' AND production_label_id IS NOT NULL"),
  },
  {
    table: "vehicle_unit_events",
    name: "uq_vehicle_unit_events_load_barcode",
    predicate: normalizeExpr("event_type = 'load' AND barcode IS NOT NULL"),
  },
  {
    table: "vehicle_sale_allocations",
    name: "uq_vehicle_sale_allocations_source_unit_event",
    predicate: normalizeExpr("source_unit_event_id IS NOT NULL"),
  },
  {
    table: "vehicle_sale_allocations",
    name: "uq_vehicle_sale_allocations_label_claim",
    predicate: normalizeExpr("label_claim_id IS NOT NULL"),
  },
  {
    table: "vehicle_stock_targets",
    name: "uq_vehicle_stock_targets_current",
    predicate: normalizeExpr("effective_to IS NULL"),
  },
  {
    table: "vehicle_stock_targets",
    name: "uq_vehicle_stock_targets_operation_key",
    predicate: normalizeExpr("operation_key IS NOT NULL"),
  },
  {
    table: "vehicle_replenishment_requests",
    name: "uq_vehicle_replenishment_open",
    predicate: normalizeExpr("status IN ('pending','approved')"),
  },
  {
    table: "vehicle_replenishment_requests",
    name: "uq_vehicle_replenishment_operation_key",
    predicate: normalizeExpr("operation_key IS NOT NULL"),
  },
  {
    table: "vehicle_replenishment_requests",
    name: "uq_vehicle_replenishment_fingerprint",
    predicate: normalizeExpr("request_fingerprint IS NOT NULL"),
  },
  {
    table: "vehicle_replenishment_requests",
    name: "uq_vehicle_replenishment_handoff",
    predicate: normalizeExpr("handoff_id IS NOT NULL"),
  },
  {
    table: "vehicle_reconciliation_items",
    name: "uq_vehicle_reconciliation_items_adj_ref",
    predicate: normalizeExpr("adjustment_reference IS NOT NULL"),
  },
  {
    table: "vehicle_reconciliation_items",
    name: "uq_vehicle_reconciliation_items_rec_mahsulot",
    predicate: normalizeExpr("mahsulot_id IS NOT NULL"),
  },
  {
    table: "vehicle_reconciliation_items",
    name: "uq_vehicle_reconciliation_items_rec_public_product",
    predicate: normalizeExpr("public_product_id IS NOT NULL"),
  },
];

/**
 * Compare expected vehicle CHECK constraints and partial-index predicates
 * against a live throwaway DB. Returns true if drift was found.
 */
async function compareVehicleChecksAndPartialIndexes(
  label: string,
  pool: pg.Pool,
): Promise<boolean> {
  const [actualChecks, actualPartial] = await Promise.all([
    readActualChecks(pool),
    readActualPartialIndexes(pool),
  ]);
  let drift = false;

  for (const exp of EXPECTED_CHECKS) {
    const act = actualChecks.get(exp.name);
    if (!act) {
      console.error(`✗ [${label}] CHECK yo'q: ${exp.table}.${exp.name}`);
      drift = true;
      continue;
    }
    // pg wraps the expression in CHECK (...) — strip it before comparing.
    const actExpr = normalizeExpr(act.expr.replace(/^check\s*/i, ""));
    if (actExpr !== exp.expr) {
      console.error(
        `✗ [${label}] CHECK ifoda mos emas: ${exp.name}\n` +
          `    kutilgan: ${exp.expr}\n` +
          `    haqiqiy:  ${actExpr}`,
      );
      drift = true;
    }
  }
  for (const name of actualChecks.keys()) {
    if (!EXPECTED_CHECKS.find((e) => e.name === name)) {
      console.error(`✗ [${label}] Kutilmagan CHECK: ${name}`);
      drift = true;
    }
  }

  for (const exp of EXPECTED_PARTIAL_INDEXES) {
    const act = actualPartial.get(exp.name);
    if (!act) {
      console.error(`✗ [${label}] Partial unique index yo'q: ${exp.table}.${exp.name}`);
      drift = true;
      continue;
    }
    if (normalizeExpr(act.predicate) !== exp.predicate) {
      console.error(
        `✗ [${label}] Partial index predikati mos emas: ${exp.name}\n` +
          `    kutilgan: ${exp.predicate}\n` +
          `    haqiqiy:  ${normalizeExpr(act.predicate)}`,
      );
      drift = true;
    }
  }
  for (const name of actualPartial.keys()) {
    if (!EXPECTED_PARTIAL_INDEXES.find((e) => e.name === name)) {
      console.error(`✗ [${label}] Kutilmagan partial unique index: ${name}`);
      drift = true;
    }
  }

  if (!drift) {
    console.log(
      `✓ [${label}] ${EXPECTED_CHECKS.length} vehicle CHECK + ` +
        `${EXPECTED_PARTIAL_INDEXES.length} partial unique index mos`,
    );
  }
  return drift;
}

async function main(): Promise<void> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error("DATABASE_URL must be set");
  const adminHost = new URL(adminUrl).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(adminHost)) {
    throw new Error("Distribution drift admin DATABASE_URL must use a loopback host");
  }

  // 1. Ikkita throwaway baza yaratish
  const adminPool = new pg.Pool({ connectionString: adminUrl });
  for (const db of [BOT_DB, TS_DB]) {
    await adminPool.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE ${db}`);
  }
  await adminPool.end();

  const botUrl = withDatabase(adminUrl, BOT_DB);
  const tsUrl = withDatabase(adminUrl, TS_DB);

  // Bola jarayonlar throwaway bazaga ulanishi shart; lib/db va bot
  // RAILWAY_DATABASE_URL ni birinchi o'ringa qo'yadi — olib tashlaymiz.
  // Vehicle pilot: throwaway DBs always enable vehicle tables so drift
  // validation covers all 28 distribution tables including vehicle ones.
  const botEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: botUrl,
    VEHICLE_DISTRIBUTION_SCHEMA_APPROVED: "1",
  };
  delete botEnv["RAILWAY_DATABASE_URL"];
  const tsEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: tsUrl,
    VEHICLE_DISTRIBUTION_SCHEMA_APPROVED: "1",
  };
  delete tsEnv["RAILWAY_DATABASE_URL"];

  // 2a. Distribution bot runtime DDL (python _INIT_DDL)
  console.log("→ distribution bot init_db() ishlamoqda (throwaway baza)...");
  execFileSync("python3", ["-c", "from database.connection import init_db; init_db()"], {
    cwd: path.join(REPO_ROOT, "artifacts", "distribution-bot"),
    env: botEnv,
    stdio: ["ignore", "inherit", "inherit"],
  });

  // 2b. Mustaqil DDL skript (init-distribution.ts)
  console.log("→ init-distribution.ts ishlamoqda (throwaway baza)...");
  execFileSync("pnpm", ["--filter", "@workspace/scripts", "run", "init-distribution"], {
    cwd: REPO_ROOT,
    env: tsEnv,
    stdio: ["ignore", "inherit", "inherit"],
  });

  // TEST-ONLY hook: sun'iy drift kiritish uchun. Faqat drift-checkning o'zini
  // sinovdan o'tkazadigan test ishlatadi (masalan bitta nusxaga ortiqcha
  // indeks qo'shib, skript non-zero bilan chiqishini tasdiqlash uchun).
  // Oddiy ishga tushirishlarda bu env var hech qachon o'rnatilmaydi.
  const testExtraDdl = process.env["DIST_DRIFT_TEST_EXTRA_DDL"];
  if (testExtraDdl) {
    console.log("→ [TEST] DIST_DRIFT_TEST_EXTRA_DDL qo'llanmoqda (sun'iy drift)...");
    const hookPool = new pg.Pool({ connectionString: tsUrl });
    await hookPool.query(testExtraDdl);
    await hookPool.end();
  }

  // 3. Har ikkala natijani Drizzle mirror bilan solishtirish
  const expected = drizzleExpected();
  const expectedIndexes = drizzleExpectedIndexes();

  const botPool = new pg.Pool({ connectionString: botUrl });
  const [botActual, botActualIndexes] = await Promise.all([
    readActual(botPool),
    readActualIndexes(botPool),
  ]);
  const botCheckDrift = await compareVehicleChecksAndPartialIndexes("bot _INIT_DDL", botPool);
  await botPool.end();

  const tsPool = new pg.Pool({ connectionString: tsUrl });
  const [tsActual, tsActualIndexes] = await Promise.all([
    readActual(tsPool),
    readActualIndexes(tsPool),
  ]);
  const tsCheckDrift = await compareVehicleChecksAndPartialIndexes("init-distribution.ts", tsPool);
  await tsPool.end();

  const botDrift = compare("bot _INIT_DDL", expected, botActual);
  const tsDrift = compare("init-distribution.ts", expected, tsActual);
  const botIndexDrift = compareIndexes("bot _INIT_DDL", expectedIndexes, botActualIndexes);
  const tsIndexDrift = compareIndexes("init-distribution.ts", expectedIndexes, tsActualIndexes);

  // Toza bo'lishi uchun throwaway bazalarni o'chirish
  const cleanupPool = new pg.Pool({ connectionString: adminUrl });
  for (const db of [BOT_DB, TS_DB]) {
    await cleanupPool.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
  }
  await cleanupPool.end();

  if (botDrift || tsDrift || botIndexDrift || tsIndexDrift || botCheckDrift || tsCheckDrift) {
    console.error(
      "\nDistribution sxema drifti aniqlandi. UCHALA nusxani ham yangilang: " +
        "artifacts/distribution-bot/database/connection.py (_INIT_DDL), " +
        "scripts/src/init-distribution.ts va lib/db/src/schema/distribution.ts.",
    );
    process.exit(1);
  }

  console.log(
    "\nDistribution sxema mos — drift yo'q (bot DDL ↔ init skript ↔ Drizzle mirror; ustunlar + indekslar + vehicle CHECK + partial-index predicates).",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
