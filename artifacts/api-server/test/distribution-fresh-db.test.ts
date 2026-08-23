import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import {
  requireVehicleTestAdminUrl,
  childDbUrl,
  sslFor,
  botDbEnv,
} from "./helpers/vehicle-test-db";

// ─────────────────────────────────────────────────────────────────────────────
// Distribution-bot fresh-database boot guard.
//
// The distribution (savdo/agent) bot runs on its own `distribution` Postgres
// schema through a native psycopg2 pool (`database/` package). This test
// mirrors the factory fresh-db-boot guard: it creates a genuinely EMPTY
// throwaway database on the same server, brings the `distribution` schema up
// using ONLY the real bot init code (`main.init_db()` — exactly what runs at
// bot startup), and then:
//
//   1. asserts every table the bot's SQL references (auto-extracted from
//      main.py source) actually exists after init,
//   2. asserts every column the bot's queries depend on exists,
//   3. asserts the `users` column ORDER (the bot does `SELECT * FROM users`
//      and indexes rows positionally — u[3] must be `role`),
//   4. exercises a full sale flow end-to-end THROUGH the real database layer
//      (pooled get_db / native %s params / RETURNING id / update_balans_delta),
//      so a schema or db-layer regression fails loudly here instead of in prod.
//
// Why a throwaway DATABASE (not just a schema): mirrors the factory guard and
// guarantees zero leakage onto real `distribution` data; the DB is dropped in
// afterAll.
// ─────────────────────────────────────────────────────────────────────────────

const { Client } = pg;

// Admin/provisioning URL comes ONLY from the dedicated isolated variable — never
// from the runtime RAILWAY_DATABASE_URL / DATABASE_URL. Fails closed if absent.
const adminUrl = requireVehicleTestAdminUrl();

const TMP_DB = `topmart_dist_freshboot_${process.pid}_${Date.now()}`;
const ssl = sslFor(adminUrl);

function tmpUrl(): string {
  return childDbUrl(adminUrl, TMP_DB);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const botDir = path.resolve(here, "../../distribution-bot");
const mainPySource = readFileSync(path.join(botDir, "main.py"), "utf8");

// Env the bot subprocess needs: it prefers RAILWAY_DATABASE_URL (and enables
// sslmode=require when it is set — the throwaway DB lives on the same server,
// so SSL behavior matches production). The token is never used for network
// calls here; TeleBot() construction and handler registration are offline.
// Vehicle pilot: always enabled on throwaway DBs so fresh-DB validation
// covers all vehicle tables (the gate only guards production databases).
const {
  RAILWAY_DATABASE_URL: _ignoredRailwayDatabaseUrl,
  DATABASE_URL: _ignoredRuntimeDatabaseUrl,
  ...isolatedBotBaseEnv
} = process.env;
const botEnv = {
  ...isolatedBotBaseEnv,
  ...botDbEnv(tmpUrl()),
  TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_FRESH_DB_GUARD",
  VEHICLE_DISTRIBUTION_SCHEMA_APPROVED: "1",
};

let client: pg.Client;
let initDbError: unknown = null;

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

beforeAll(async () => {
  await dropTmpDb();
  {
    const admin = new Client({ connectionString: adminUrl, ssl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${TMP_DB}`);
    await admin.end();
  }

  // Bring the schema up using ONLY the real bot init code, exactly as the bot
  // does at startup (`if __name__ == "__main__": init_db()`).
  try {
    execFileSync("python3", ["-c", "import main; main.init_db()"], {
      cwd: botDir,
      env: botEnv,
      stdio: "pipe",
    });
  } catch (e) {
    initDbError = e;
  }

  client = new Client({ connectionString: tmpUrl(), ssl });
  await client.connect();
}, 120_000);

afterAll(async () => {
  if (client) await client.end();
  await dropTmpDb();
}, 60_000);

// Every column the distribution bot's queries depend on. If a column here is
// missing after init_db(), the bot 500s (well — crashes the handler) on a
// brand-new database or restore.
const REQUIRED: Record<string, string[]> = {
  users: ["id", "telegram_id", "name", "role", "viloyat", "created_at"],
  dokonlar: [
    "id", "nomi", "egasi", "telefon", "viloyat", "hudud", "latitude", "longitude",
    "foto", "agent_id", "holat", "created_at", "owner_telegram_id",
    "first_order_date", "last_order_date", "total_orders", "repeat_orders",
    "total_sales", "avg_repeat_days",
  ],
  mahsulotlar: ["id", "nomi", "narx", "birlik", "faol"],
  savdolar: ["id", "dokon_id", "agent_id", "jami_summa", "tolov_turi", "foto", "created_at"],
  savdo_tafsilot: ["id", "savdo_id", "mahsulot_id", "miqdor", "narx", "summa"],
  olmagan_dokonlar: [
    "id", "dokon_id", "agent_id", "sabab", "sabab_text", "latitude", "longitude",
    "qaytish_sanasi", "bajarildi", "created_at", "foto",
  ],
  pul_olish: ["id", "dokon_id", "agent_id", "summa", "created_at"],
  nasiya: ["id", "dokon_id", "agent_id", "savdo_id", "jami_summa", "tolangan", "qoldiq", "created_at", "updated_at"],
  mijoz_balans: ["id", "dokon_id", "balans"],
  revisitlar: ["id", "dokon_id", "agent_id", "last_order_date", "revisit_date", "status", "created_at"],
  agent_plans: ["id", "agent_id", "oy", "savdo_plan", "dokon_plan", "created_at"],
  delivery_agents: [
    "id", "name", "telefon", "tugilgan_kun", "mashina_turi", "mashina_nomeri",
    "hudud", "telegram_id", "faol", "created_at",
  ],
  delivery_routes: ["id", "delivery_agent_id", "kun", "dokon_id", "tartib", "created_at", "added_by_dlv"],
  // Field Assistant Mini App idempotency jurnali — API yozadi, lekin bot
  // init_db() yaratishi shart (uch nusxa DDL sinxron bo'lishi kerak).
  field_ops: ["id", "client_op_id", "agent_id", "op_type", "dokon_id", "result_id", "created_at"],
  // Vehicle Distribution Pilot — F1 schema (always created on throwaway DBs)
  vehicles: ["id", "plate_number", "vehicle_type", "description", "capacity_kg", "status", "warehouse_id", "created_at"],
  vehicle_assignments: ["id", "vehicle_id", "delivery_agent_id", "assigned_at", "unassigned_at", "status", "notes", "created_at"],
  vehicle_handoffs: ["id", "vehicle_id", "delivery_agent_id", "source_warehouse_id", "vehicle_warehouse_id", "handoff_date", "status", "labels_printed_at", "labels_printed_by", "handed_over_at", "handed_over_by", "stock_transferred_at", "stock_transferred_by", "cancelled_at", "cancelled_by", "movement_reference", "operation_key", "prepared_actor_type", "prepared_actor_ref", "notes", "created_at"],
  vehicle_handoff_items: ["id", "handoff_id", "mahsulot_id", "sku", "quantity_dispatched", "unit_cost", "product_name", "unit_weight_kg", "total_weight_kg", "created_at"],
  vehicle_unit_events: ["id", "vehicle_id", "handoff_id", "handoff_item_id", "mahsulot_id", "sku", "event_type", "quantity", "actor_id", "production_label_id", "barcode", "operation_key", "label_claim_id", "event_at", "notes", "created_at"],
  vehicle_sale_allocations: ["id", "handoff_id", "savdo_id", "savdo_tafsilot_id", "mahsulot_id", "product_name", "product_sku", "vehicle_id", "allocated_quantity", "allocated_weight_kg", "production_label_id", "barcode", "source_unit_event_id", "label_claim_id", "operation_key", "allocated_at", "created_at"],
  vehicle_label_claims: ["id", "vehicle_id", "handoff_id", "handoff_item_id", "production_label_id", "barcode", "mahsulot_id", "sku", "unit_weight_kg", "status", "operation_key", "created_at", "updated_at", "return_id", "returned_at", "returned_by"],
  vehicle_stock_targets: ["id", "vehicle_id", "mahsulot_id", "public_product_id", "product_name", "sku", "target_quantity", "min_quantity", "effective_from", "effective_to", "operation_key", "actor_type", "actor_ref", "created_at"],
  vehicle_replenishment_requests: ["id", "vehicle_id", "requested_by", "mahsulot_id", "public_product_id", "product_name", "sku", "requested_quantity", "approved_quantity", "target_quantity_snapshot", "current_quantity_snapshot", "source_warehouse_id", "handoff_id", "operation_key", "request_fingerprint", "status", "requested_at", "resolved_at", "approved_by", "approved_at", "cancelled_by", "cancelled_at", "fulfilled_at", "notes", "created_at"],
  vehicle_reconciliations: ["id", "vehicle_id", "delivery_agent_id", "reconciliation_date", "status", "created_by", "reviewed_by", "reviewed_at", "approved_by", "approved_at", "applied_by", "applied_at", "notes", "created_at"],
  vehicle_reconciliation_items: ["id", "reconciliation_id", "mahsulot_id", "public_product_id", "product_name", "sku", "expected_quantity", "expected_weight_kg", "actual_quantity", "discrepancy", "counted_by", "counted_at", "adjustment_reference", "notes", "created_at"],
  vehicle_returns: ["id", "vehicle_id", "vehicle_assignment_id", "delivery_agent_id", "vehicle_warehouse_id", "status", "operation_key", "operation_fingerprint", "notes", "prepared_by", "prepared_at", "handed_back_by", "handed_back_at", "transferred_by", "transferred_at", "cancelled_by", "cancelled_at", "created_at", "updated_at"],
  vehicle_return_items: ["id", "return_id", "label_claim_id", "production_label_id", "barcode", "handoff_id", "handoff_item_id", "mahsulot_id", "public_product_id", "product_name", "sku", "unit_weight_kg", "destination_warehouse_id", "movement_reference", "created_at"],
};

// Words the table-name regex can catch that are not distribution tables.
const NOT_TABLES = new Set([
  "information_schema", // introspection queries
  "set",                // "… DO UPDATE SET …"
]);

describe("Distribution bot: no SQLite-isms remain in the PostgreSQL layer", () => {
  it("no '?' placeholders in execute() literals, no .lastrowid, anywhere in bot code", () => {
    // AST-based guard (regex would false-positive on Uzbek '?' in messages).
    // Scans main.py AND every database/*.py module.
    const py = `
import ast, glob, json, sys
bad = []
for path in ["main.py"] + sorted(glob.glob("database/*.py")):
    src = open(path).read()
    if ".lastrowid" in src:
        bad.append(f"{path}: uses .lastrowid (use RETURNING id)")
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr in ("execute", "executemany") and node.args):
            a = node.args[0]
            if isinstance(a, ast.Constant) and isinstance(a.value, str) and "?" in a.value:
                bad.append(f"{path}:{a.lineno}: '?' placeholder in SQL literal")
    # dynamic SQL fragments assembled outside execute()
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            v = node.value
            if ("=?" in v and "%s" not in v) or "IN (?" in v.upper():
                bad.append(f"{path}:{getattr(node,'lineno','?')}: suspicious '?' SQL fragment: {v[:60]!r}")
print(json.dumps(bad))
`;
    const out = execFileSync("python3", ["-c", py], { cwd: botDir, stdio: "pipe" }).toString().trim();
    const bad = JSON.parse(out.split("\n").pop()!) as string[];
    expect(bad, `SQLite-era SQL found:\n${bad.join("\n")}`).toEqual([]);
  });
});

describe("Yagona katalog (SKU) siyosati: bot mahsulot yozuvini yarata olmasligi", () => {
  // Task: bot orqali qo'shilgan mahsulotlar sku='' (bog'lanmagan) qatorlar hosil
  // qilar edi. Yangi mahsulot FAQAT dashboard/POST /products orqali yaratiladi.
  // Bu guard bot manbalarida mahsulotlarga INSERT qaytib kelmasligini AST orqali
  // tekshiradi (execute() literallari + f-string fragmentlari).
  it("bot sources contain no INSERT into mahsulotlar", () => {
    const py = `
import ast, glob, json
bad = []
for path in ["main.py"] + sorted(glob.glob("database/*.py")):
    tree = ast.parse(open(path).read())
    for node in ast.walk(tree):
        vals = []
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            vals.append((node.value, getattr(node, "lineno", "?")))
        if isinstance(node, ast.JoinedStr):
            for part in node.values:
                if isinstance(part, ast.Constant) and isinstance(part.value, str):
                    vals.append((part.value, getattr(node, "lineno", "?")))
        for v, ln in vals:
            u = " ".join(v.upper().split())
            if "INSERT INTO" in u and "MAHSULOTLAR" in u and "SAVDO_TAFSILOT" not in u:
                bad.append(f"{path}:{ln}: {v[:80]!r}")
print(json.dumps(bad))
`;
    const out = execFileSync("python3", ["-c", py], { cwd: botDir, stdio: "pipe" }).toString().trim();
    const bad = JSON.parse(out.split("\n").pop()!) as string[];
    expect(bad, `Bot mahsulot yaratmasligi kerak (dashboard'dan yaratiladi):\n${bad.join("\n")}`).toEqual([]);
  });
});

describe("Distribution bot: every SQL statement plans on PostgreSQL (dialect sweep)", () => {
  // SQLite-era dialect errors (bare non-aggregated GROUP BY columns,
  // GROUP_CONCAT, strftime, unqualified columns in ON CONFLICT ... DO UPDATE)
  // parse fine as strings and only fail at PLAN time in Postgres. This test
  // AST-extracts every execute() SQL literal from the bot sources and runs
  // EXPLAIN on each against the fresh throwaway DB, so ANY new query with a
  // dialect trap fails here instead of in production. (Verified: EXPLAIN
  // catches all four trap classes above.)
  it("EXPLAIN succeeds for every execute() SQL literal in bot sources", () => {
    const py = `
import ast, glob, json, main

TABLES = ["users","dokonlar","mahsulotlar","savdolar","savdo_tafsilot","nasiya",
          "pul_olish","mijoz_balans","olmagan_dokonlar","revisitlar","agent_plans",
          "delivery_agents","delivery_routes"]
# Known f-string fragments assembled at runtime; substituted with
# representative, syntactically-equivalent SQL so the statement still plans.
KNOWN_SUBS = {
    "extra": "",  # optional scope clause appended after a WHERE condition
    "vil_clause": "(viloyat=NULL OR (viloyat IS NULL AND NULL='x') OR (viloyat='' AND NULL='x'))",
    "hud_clause": "(hudud=NULL OR (hudud IS NULL AND NULL='x') OR (hudud='' AND NULL='x'))",
    "ph": "NULL",  # expanded IN (...) placeholder list
    # _dokon_page_kb universal picker (owner's 04-avg pagination/search work):
    # where = "1=1" [+ " AND holat='faol'"] [+ " AND agent_id=%s"] — maximal form
    "where": "1=1 AND holat='faol' AND agent_id=NULL",
}

def sql_from_node(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        parts = []
        for v in node.values:
            if isinstance(v, ast.Constant):
                parts.append(v.value)
            else:
                name = ast.unparse(v.value)
                if name == "t":
                    parts.append("{t}")  # expanded per-table below
                elif name in KNOWN_SUBS:
                    parts.append(KNOWN_SUBS[name])
                else:
                    return None  # unknown dynamic fragment -> reported as skipped
        return "".join(parts)
    return None

stmts, skipped = [], []
for path in ["main.py"] + sorted(glob.glob("database/*.py")):
    tree = ast.parse(open(path).read())
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "execute" and node.args):
            sql = sql_from_node(node.args[0])
            loc = f"{path}:{node.args[0].lineno}"
            if sql is None:
                skipped.append(loc)
                continue
            if "{t}" in sql:
                for t in TABLES:
                    stmts.append((loc, sql.replace("{t}", t)))
            else:
                stmts.append((loc, sql))

conn = main.get_db(); c = conn.cursor()
failures = []
checked = 0
for loc, raw in stmts:
    sql = raw.replace("%%", "\\x00").replace("%s", "NULL").replace("\\x00", "%").strip()
    if not sql:
        continue
    head = sql.split(None, 1)[0].upper()
    if head in ("SET", "CREATE", "BEGIN", "COMMIT", "ROLLBACK"):
        continue
    try:
        c.execute("EXPLAIN " + sql)
        checked += 1
    except Exception as ex:
        failures.append(f"{loc}: {str(ex).strip().splitlines()[0]}")
        conn.rollback()
        c = conn.cursor()
conn.rollback()
conn.close()
print(json.dumps({"checked": checked, "failures": failures, "skipped": skipped}))
`;
    const out = execFileSync("python3", ["-c", py], { cwd: botDir, env: botEnv, stdio: "pipe" })
      .toString()
      .trim();
    const r = JSON.parse(out.split("\n").pop()!) as {
      checked: number;
      failures: string[];
      skipped: string[];
    };
    expect(r.failures, `SQL fails to plan on PostgreSQL:\n${r.failures.join("\n")}`).toEqual([]);
    expect(r.checked).toBeGreaterThanOrEqual(200); // sanity: extraction worked
    // Statements assembled from fragments we cannot resolve statically. Keep
    // this list tiny and known — a growing list means new dynamic SQL is
    // escaping the sweep.
    // The vehicle pilot added one extra: cur.execute(_VEHICLE_DDL) in
    // database/connection.py is a variable reference, not a string literal.
    // Together with _INIT_DDL and two main.py dynamic f-strings, the total is 4.
    expect(r.skipped.length).toBeLessThanOrEqual(4);
  }, 120_000);
});

describe("Distribution bot: fresh DB boots via init_db() alone", () => {
  it("bot init_db() completes without error on a brand-new database", () => {
    const detail =
      initDbError instanceof Error
        ? `${initDbError.message}\n${(initDbError as { stderr?: Buffer }).stderr?.toString() ?? ""}`
        : undefined;
    expect(initDbError, detail).toBeNull();
  });

  it("every table referenced by main.py SQL exists in the distribution schema", async () => {
    // Auto-extract table names from the bot source so NEW queries are guarded
    // automatically — a query against a table init_db() doesn't create fails
    // here without anyone having to update this test.
    const referenced = new Set<string>();
    // Case-SENSITIVE: SQL keywords are uppercase in the bot source, while
    // Python's own `from x import y` is lowercase and must not match.
    // public. — bot ERP master katalogini (public.products, init_db yaratadi)
    // in_sales flagi uchun o'qiydi; bu jadvallar public sxemada tekshiriladi.
    const re = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:distribution\.|public\.)?([a-z_][a-z0-9_]*)/g;
    for (const m of mainPySource.matchAll(re)) {
      const t = m[1].toLowerCase();
      if (!NOT_TABLES.has(t)) referenced.add(t);
    }
    expect(referenced.size).toBeGreaterThanOrEqual(13); // sanity: extraction worked

    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema IN ('distribution','public')`,
    );
    const have = new Set(rows.map((r) => r.table_name as string));
    const missing = [...referenced].filter((t) => !have.has(t));
    expect(missing, `Tables referenced by bot SQL but missing after init_db(): ${missing.join(", ")}`).toEqual([]);
  });

  it("every column the bot's queries depend on exists after init", async () => {
    const { rows } = await client.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'distribution'`,
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
    expect(missing, `Missing distribution schema after init: ${missing.join(", ")}`).toEqual([]);
  });

  it("users column ORDER is stable (bot indexes SELECT * rows positionally)", async () => {
    // get_user() does `SELECT * FROM users …` and callers read u[3] as role,
    // u[4] as viloyat. A reordered/inserted column silently breaks auth.
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'distribution' AND table_name = 'users'
        ORDER BY ordinal_position`,
    );
    const order = rows.map((r) => r.column_name as string);
    expect(order.slice(0, 6)).toEqual(["id", "telegram_id", "name", "role", "viloyat", "created_at"]);
  });
});

describe("Distribution sale flow end-to-end through the real db layer on a fresh DB", () => {
  it("insert agent → dokon → sale (+items, nasiya, balans) via bot code and read back", async () => {
    // Runs INSIDE the bot's own runtime: pooled main.get_db() (search_path set
    // per connection), native %s params, RETURNING id, update_balans_delta's
    // ON CONFLICT upsert, and get_balans/get_user helpers.
    const py = `
import json, main
conn = main.get_db(); c = conn.cursor()
c.execute("INSERT INTO users (telegram_id,name,role,viloyat,created_at) VALUES (%s,%s,%s,%s,%s)",
          (111, "Fresh Test Agent", "agent", "Toshkent", "2026-07-11 10:00:00"))
c.execute("INSERT INTO dokonlar (nomi,egasi,telefon,viloyat,hudud,agent_id,holat,created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
          ("Fresh Test Dokon", "Egasi", "+998900000000", "Toshkent", "Chilonzor", 111, "faol", "2026-07-11 10:01:00"))
dokon_id = c.fetchone()[0]
c.execute("INSERT INTO mahsulotlar (nomi,narx,birlik,faol) VALUES (%s,%s,%s,%s) RETURNING id", ("Arqon 5mm", 12000, "dona", 1))
mid = c.fetchone()[0]
c.execute("INSERT INTO savdolar (dokon_id,agent_id,jami_summa,tolov_turi,created_at) VALUES (%s,%s,%s,%s,%s) RETURNING id",
          (dokon_id, 111, 24000, "nasiya", "2026-07-11 10:05:00"))
sid = c.fetchone()[0]
c.execute("INSERT INTO savdo_tafsilot (savdo_id,mahsulot_id,miqdor,narx,summa) VALUES (%s,%s,%s,%s,%s)",
          (sid, mid, 2, 12000, 24000))
c.execute("INSERT INTO nasiya (dokon_id,agent_id,savdo_id,jami_summa,tolangan,qoldiq,created_at) VALUES (%s,%s,%s,%s,%s,%s,%s)",
          (dokon_id, 111, sid, 24000, 0, 24000, "2026-07-11 10:05:00"))
main.update_balans_delta(c, dokon_id, -24000)
conn.commit()
c.execute("SELECT jami_summa FROM savdolar WHERE id=%s", (sid,))
jami = c.fetchone()[0]
c.execute("SELECT COUNT(*), COALESCE(SUM(st.summa),0) FROM savdo_tafsilot st JOIN savdolar s ON st.savdo_id=s.id WHERE s.dokon_id=%s", (dokon_id,))
cnt, total = c.fetchone()
c.execute("SELECT COALESCE(SUM(qoldiq),0) FROM nasiya WHERE dokon_id=%s", (dokon_id,))
qoldiq = c.fetchone()[0]
conn.close()
u = main.get_user(111)
bal = main.get_balans(dokon_id)
print(json.dumps({
    "sid": sid, "dokon_id": dokon_id, "jami": int(jami), "items": int(cnt),
    "items_total": int(total), "qoldiq": int(qoldiq), "balans": int(bal),
    "user_role": u[3],
}))
`;
    const out = execFileSync("python3", ["-c", py], { cwd: botDir, env: botEnv, stdio: "pipe" })
      .toString()
      .trim();
    const r = JSON.parse(out.split("\n").pop()!);

    expect(r.sid).toBeGreaterThan(0);       // native RETURNING id
    expect(r.dokon_id).toBeGreaterThan(0);
    expect(r.jami).toBe(24000);
    expect(r.items).toBe(1);
    expect(r.items_total).toBe(24000);
    expect(r.qoldiq).toBe(24000);
    expect(r.balans).toBe(-24000);          // ON CONFLICT upsert path
    expect(r.user_role).toBe("agent");      // SELECT * positional access

    // Cross-check via a plain pg connection that the data really landed in the
    // isolated `distribution` schema (not public).
    const { rows } = await client.query(
      `SELECT jami_summa FROM distribution.savdolar WHERE id = $1`, [r.sid],
    );
    expect(Number(rows[0].jami_summa)).toBe(24000);
  }, 60_000);
});

describe("Distribution summary API: period nasiya (davr) vs nasiya qoldiq (outstanding)", () => {
  // Guard for the "bugungi/davr nasiya" KPI: /distribution/summary must expose
  // BOTH the credit issued in the selected period (nasiyaSalesTotal/Count from
  // `nasiya.jami_summa` filtered by created_at) AND the current outstanding
  // balance (outstandingTotal from `nasiya.qoldiq`, date-independent). A partial
  // payment makes the two values differ, so a regression that conflates them
  // fails loudly here.
  let server: import("node:http").Server;
  let apiUrl: string;
  let apiPool: pg.Pool | undefined;

  beforeAll(async () => {
    // The sale-flow test above inserted one nasiya row:
    // jami_summa=24000, qoldiq=24000, created_at 2026-07-11. Record a partial
    // payment so period-nasiya (24000) and outstanding (20000) diverge.
    await client.query(
      `UPDATE distribution.nasiya SET tolangan = 4000, qoldiq = 20000, updated_at = '2026-07-12 09:00:00'`,
    );

    // Point @workspace/db at the throwaway CHILD DB BEFORE importing the router
    // — the pool binds its connection string at import time. Only a URL derived
    // from the isolated admin URL is ever assigned here; any inherited runtime
    // URL is removed. @workspace/db enables SSL iff RAILWAY_DATABASE_URL is set,
    // so for a local (loopback) cluster we set only DATABASE_URL.
    const childEnv = botDbEnv(tmpUrl());
    if ("RAILWAY_DATABASE_URL" in childEnv) {
      process.env.RAILWAY_DATABASE_URL = childEnv.RAILWAY_DATABASE_URL;
    } else {
      delete process.env.RAILWAY_DATABASE_URL;
    }
    process.env.DATABASE_URL = childEnv.DATABASE_URL;

    const [{ default: distributionRouter }, expressMod, pinoHttpMod, loggerMod, dbMod] =
      await Promise.all([
        import("../src/routes/distribution"),
        import("express"),
        import("pino-http"),
        import("../src/lib/logger"),
        import("@workspace/db"),
      ]);
    apiPool = dbMod.pool as unknown as pg.Pool;

    const express = expressMod.default;
    const app = express();
    app.use(pinoHttpMod.default({ logger: loggerMod.logger }));
    app.use(express.json());
    // Auth wall lives in routes/index.ts (router-level requireAuth); here we
    // test schema/metrics, not auth, so the router is mounted directly.
    app.use(distributionRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address() as import("node:net").AddressInfo;
    apiUrl = `http://127.0.0.1:${addr.port}`;
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (apiPool) await apiPool.end();
  });

  it("unfiltered summary: nasiyaSalesTotal is credit ISSUED, outstandingTotal is current qoldiq", async () => {
    const r = await fetch(`${apiUrl}/distribution/summary`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.nasiyaSalesTotal).toBe(24000); // jami_summa of the period's nasiya
    expect(j.nasiyaSalesCount).toBe(1);
    expect(j.outstandingTotal).toBe(20000); // qoldiq after the partial payment
    expect(j.nasiyaSalesTotal).not.toBe(j.outstandingTotal); // must stay distinct metrics
  });

  it("date filter scopes nasiyaSalesTotal but NOT outstandingTotal", async () => {
    // Period covering the sale day.
    const rIn = await fetch(`${apiUrl}/distribution/summary?from=2026-07-11&to=2026-07-11`);
    expect(rIn.status).toBe(200);
    const jIn = await rIn.json();
    expect(jIn.nasiyaSalesTotal).toBe(24000);
    expect(jIn.nasiyaSalesCount).toBe(1);
    expect(jIn.outstandingTotal).toBe(20000);

    // Period with no nasiya sales — period metric drops to 0, outstanding stays.
    const rOut = await fetch(`${apiUrl}/distribution/summary?from=2020-01-01&to=2020-01-02`);
    expect(rOut.status).toBe(200);
    const jOut = await rOut.json();
    expect(jOut.nasiyaSalesTotal).toBe(0);
    expect(jOut.nasiyaSalesCount).toBe(0);
    expect(jOut.outstandingTotal).toBe(20000);
  });

  it("shops lastVisit is null-safe: sales-only, visit-only, both, neither", async () => {
    // PostgreSQL GREATEST ignores NULL args (unlike Oracle) — lastVisit must be
    // correct when a shop has activity in only ONE source (savdolar OR
    // olmagan_dokonlar), in both, or in neither.
    const ins = async (nomi: string): Promise<number> => {
      const r = await client.query(
        `INSERT INTO distribution.dokonlar (nomi, agent_id, holat, created_at)
         VALUES ($1, 111, 'faol', '2026-07-10 08:00:00') RETURNING id`,
        [nomi],
      );
      return r.rows[0].id as number;
    };
    const visitOnly = await ins("LV Visit Only");
    const both = await ins("LV Both");
    await ins("LV Neither");
    await client.query(
      `INSERT INTO distribution.olmagan_dokonlar (dokon_id, agent_id, sabab, created_at)
       VALUES ($1, 111, 'yopiq', '2026-07-09 12:00:00')`,
      [visitOnly],
    );
    // Sale in a PREVIOUS month (2026-06) so the monthly-rating test below is
    // unaffected; the later "olmagan" visit (2026-07-10) must win via GREATEST.
    await client.query(
      `INSERT INTO distribution.savdolar (dokon_id, agent_id, jami_summa, tolov_turi, created_at)
       VALUES ($1, 111, 5000, 'naqd', '2026-06-08 10:00:00')`,
      [both],
    );
    await client.query(
      `INSERT INTO distribution.olmagan_dokonlar (dokon_id, agent_id, sabab, created_at)
       VALUES ($1, 111, 'yopiq', '2026-07-10 12:00:00')`,
      [both],
    );

    const r = await fetch(`${apiUrl}/distribution/shops?pageSize=100`);
    expect(r.status).toBe(200);
    const j = await r.json();
    const by = (n: string) => j.rows.find((x: { nomi: string | null }) => x.nomi === n);

    expect(by("Fresh Test Dokon").lastVisit).toBe("2026-07-11"); // sales only, no olmagan
    expect(by("LV Visit Only").lastVisit).toBe("2026-07-09");    // olmagan only, no sales
    expect(by("LV Both").lastVisit).toBe("2026-07-10");          // max across both sources
    expect(by("LV Neither").lastVisit).toBeNull();               // no activity at all
  });
});

describe("Distribution reporting & route flows execute with real typed params", () => {
  // The EXPLAIN sweep proves every statement PLANS; these run the riskiest
  // read flows end-to-end with real parameter types (aggregate joins over
  // substr(created_at,...), LIKE-month filters, delivery-route listing) using
  // the data inserted by the sale-flow test above.
  it("monthly rating, old-nasiya report, sales report aggregates, route listing", () => {
    const py = `
import json, main

# Monthly rating: three LEFT JOIN aggregations grouped per agent.
rating = main._build_monthly_rating("2026-07")

# Old-nasiya aging report (JOIN + scope variants).
all_text, all_cnt, all_sum = main._build_old_nasiya_report()
own_text, own_cnt, own_sum = main._build_old_nasiya_report(scope_agent_id=111)

conn = main.get_db(); c = conn.cursor()

# Sales-report style aggregation (CASE WHEN ... LIKE month/day buckets).
c.execute("""SELECT u.telegram_id,
                    COALESCE(SUM(CASE WHEN s.created_at LIKE %s THEN s.jami_summa ELSE 0 END),0) as oy_savdo,
                    COUNT(DISTINCT CASE WHEN s.created_at LIKE %s THEN s.id END) as oy_n
             FROM users u
             LEFT JOIN savdolar s ON s.agent_id=u.telegram_id
             WHERE u.role IN ('agent','supervisor')
             GROUP BY u.telegram_id ORDER BY oy_savdo DESC""", ("2026-07%", "2026-07%"))
oy_savdo_row = c.fetchone()

# Delivery-route flow: create agent + routes, then count and list.
c.execute("INSERT INTO delivery_agents (telegram_id,name,telefon,created_at) VALUES (%s,%s,%s,%s) RETURNING id",
          (222, "Fresh Dlv Agent", "+998911111111", "2026-07-11 09:00:00"))
dlv_id = c.fetchone()[0]
c.execute("SELECT id FROM dokonlar ORDER BY id LIMIT 1")
dokon_id = c.fetchone()[0]
c.execute("INSERT INTO delivery_routes (delivery_agent_id,dokon_id,kun,tartib) VALUES (%s,%s,%s,%s)",
          (dlv_id, dokon_id, 1, 1))
conn.commit()
route_count = main._route_count(dlv_id, 1)
c.execute("""SELECT r.tartib,d.nomi,d.egasi,d.telefon,d.hudud,d.latitude,d.longitude
             FROM delivery_routes r
             JOIN dokonlar d ON d.id=r.dokon_id
             WHERE r.delivery_agent_id=%s AND r.kun=%s
             ORDER BY r.tartib""", (dlv_id, 1))
route_rows = c.fetchall()
conn.close()

print(json.dumps({
    "rating_has_agent": "Fresh Test Agent" in rating,
    "old_nasiya_ok": isinstance(all_text, str) and isinstance(own_text, str),
    "oy_savdo": int(oy_savdo_row[1]), "oy_n": int(oy_savdo_row[2]),
    "route_count": route_count, "route_rows": len(route_rows),
    "route_first_tartib": route_rows[0][0],
}))
`;
    const out = execFileSync("python3", ["-c", py], { cwd: botDir, env: botEnv, stdio: "pipe" })
      .toString()
      .trim();
    const r = JSON.parse(out.split("\n").pop()!);

    expect(r.rating_has_agent).toBe(true);  // agent from sale-flow test surfaced with sales
    expect(r.old_nasiya_ok).toBe(true);
    expect(r.oy_savdo).toBe(24000);         // month-bucket aggregation over TEXT dates
    expect(r.oy_n).toBe(1);
    expect(r.route_count).toBe(1);
    expect(r.route_rows).toBe(1);
    expect(r.route_first_tartib).toBe(1);
  }, 60_000);
});

describe("Distribution WRITE flows execute with real typed params", () => {
  // The EXPLAIN sweep substitutes NULL for every %s placeholder, so it can
  // never catch a *parameter type* mismatch (e.g. a Python int bound into a
  // TEXT column — PostgreSQL rejects `text = integer`, while SQLite silently
  // coerced). These are the write flows that until now only ran in
  // production: agent-plan upsert (ON CONFLICT DO UPDATE), pul olish + FIFO
  // nasiya payment, revisit scheduling (inside create_sale), and
  // olmagan-dokon logging. Each runs here with EXACTLY the parameter types
  // the handlers pass at runtime, then results are read back and asserted.
  // NOTE: this describe must stay LAST in the file — it inserts July-2026
  // sales for a new agent, which would change the monthly-rating and summary
  // assertions above if it ran before them.
  it("plan upsert (insert + DO UPDATE), FIFO nasiya payment, revisit, olmagan insert", () => {
    const py = `
import json, main
from datetime import datetime
from database import create_sale, record_pul_olish, pay_nasiya_fifo

AGENT = 333  # msg.from_user.id is an int at runtime

conn = main.get_db(); c = conn.cursor()
c.execute("INSERT INTO users (telegram_id,name,role,viloyat,created_at) VALUES (%s,%s,%s,%s,%s)",
          (AGENT, "Typed Write Agent", "agent", "Toshkent", datetime.now().isoformat()))
c.execute("INSERT INTO dokonlar (nomi,egasi,telefon,viloyat,hudud,agent_id,holat,created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
          ("Typed Write Dokon", "Egasi", "+998900000001", "Toshkent", "Yunusobod", AGENT, "faol", datetime.now().isoformat()))
dokon_id = c.fetchone()[0]
c.execute("INSERT INTO mahsulotlar (nomi,narx,birlik,faol) VALUES (%s,%s,%s,%s) RETURNING id",
          ("Arqon 8mm", 15000, "dona", 1))
mid = c.fetchone()[0]
conn.commit(); conn.close()

# ── Two nasiya sales through create_sale (also exercises revisit scheduling:
#    the 2nd sale must supersede the 1st sale's pending revisit).
#    foto is None or a Telegram file-id str at runtime — cover both.
sid1, owner1, q1 = create_sale(dokon_id, AGENT, [(mid, 2, 15000)], 30000, "nasiya", None, 30000)
sid2, owner2, q2 = create_sale(dokon_id, AGENT, [(mid, 1, 15000)], 15000, "nasiya", "AgACAgTESTFOTO", 15000)

conn = main.get_db(); c = conn.cursor()
c.execute("SELECT status, COUNT(*) FROM revisitlar WHERE dokon_id=%s GROUP BY status", (dokon_id,))
revisits = {row[0]: int(row[1]) for row in c.fetchall()}

# ── Partial FIFO payment across the two nasiya rows: 40000 vs 45000 owed.
pay_nasiya_fifo(dokon_id, AGENT, 40000)
c.execute("SELECT savdo_id, tolangan, qoldiq FROM nasiya WHERE dokon_id=%s ORDER BY created_at", (dokon_id,))
after_fifo = [(int(r[0]), int(r[1]), int(r[2])) for r in c.fetchall()]

# ── Plain cash pickup with no debt applied.
record_pul_olish(dokon_id, AGENT, 7000)

# ── Overpayment branch: apply 5000 to debt, credit 2000 to customer balance.
owner_tg = pay_nasiya_fifo(dokon_id, AGENT, 7000, apply_amount=5000, ortiqcha=2000)
c.execute("SELECT COALESCE(SUM(qoldiq),0) FROM nasiya WHERE dokon_id=%s", (dokon_id,))
final_qoldiq = int(c.fetchone()[0])
c.execute("SELECT COUNT(*), COALESCE(SUM(summa),0) FROM pul_olish WHERE dokon_id=%s", (dokon_id,))
pul_cnt, pul_sum = c.fetchone()
balans = int(main.get_balans(dokon_id))

# ── Agent-plan upsert — same statement + param types as the admin handler
#    (main.py plan flow). Second execute hits the DO UPDATE branch.
plan_sql = """INSERT INTO agent_plans (agent_id,oy,savdo_plan,dokon_plan,created_at)
             VALUES (%s,%s,%s,%s,%s)
             ON CONFLICT(agent_id,oy) DO UPDATE SET savdo_plan=%s, dokon_plan=%s"""
oy = "2026-07"
c.execute(plan_sql, (AGENT, oy, 5000000, 10, datetime.now().isoformat(), 5000000, 10))
conn.commit()
c.execute(plan_sql, (AGENT, oy, 8000000, 15, datetime.now().isoformat(), 8000000, 15))
conn.commit()
sp, dp = main.get_agent_plan(AGENT, oy)
c.execute("SELECT COUNT(*) FROM agent_plans WHERE agent_id=%s AND oy=%s", (AGENT, oy))
plan_rows = int(c.fetchone()[0])

# ── Olmagan-dokon logging — same statement + param types as the handler:
#    lat/lon are floats from msg.location, qaytish_sanasi a date str, foto None.
c.execute("INSERT INTO olmagan_dokonlar (dokon_id,agent_id,sabab,sabab_text,latitude,longitude,qaytish_sanasi,foto,created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
          (dokon_id, AGENT, "tovari_bor", "Tovari bor", 41.311081, 69.240562, "2026-07-18", None, datetime.now().isoformat()))
conn.commit()
c.execute("SELECT sabab, qaytish_sanasi, latitude FROM olmagan_dokonlar WHERE dokon_id=%s", (dokon_id,))
olm = c.fetchone()
conn.close()

print(json.dumps({
    "sids_distinct": sid1 != sid2,
    "q2": int(q2),                          # qoldiq right after 2nd sale
    "revisits": revisits,
    "after_fifo": after_fifo,
    "final_qoldiq": final_qoldiq,
    "pul_cnt": int(pul_cnt), "pul_sum": int(pul_sum),
    "balans": balans,
    "owner_tg_is_none": owner_tg is None,
    "plan": [int(sp), int(dp)], "plan_rows": plan_rows,
    "olmagan_sabab": olm[0], "olmagan_qaytish": olm[1], "olmagan_lat": float(olm[2]),
    "sid1": sid1, "sid2": sid2,
}))
`;
    const out = execFileSync("python3", ["-c", py], { cwd: botDir, env: botEnv, stdio: "pipe" })
      .toString()
      .trim();
    const r = JSON.parse(out.split("\n").pop()!);

    expect(r.sids_distinct).toBe(true);
    expect(r.q2).toBe(45000);                       // 30000 + 15000 owed after both sales
    expect(r.revisits).toEqual({ superseded: 1, pending: 1 }); // 2nd sale superseded the 1st
    // FIFO: oldest row fully paid, remainder applied to the newer row.
    expect(r.after_fifo).toEqual([
      [r.sid1, 30000, 0],
      [r.sid2, 10000, 5000],
    ]);
    expect(r.final_qoldiq).toBe(0);                 // 5000 applied by the overpay call
    expect(r.pul_cnt).toBe(3);                      // fifo + plain + overpay pickups
    expect(r.pul_sum).toBe(54000);                  // 40000 + 7000 + 7000
    expect(r.balans).toBe(2000);                    // ortiqcha credited to balance
    expect(r.owner_tg_is_none).toBe(true);          // dokon has no owner_telegram_id
    expect(r.plan).toEqual([8000000, 15]);          // DO UPDATE branch won
    expect(r.plan_rows).toBe(1);                    // upsert, not a duplicate row
    expect(r.olmagan_sabab).toBe("tovari_bor");
    expect(r.olmagan_qaytish).toBe("2026-07-18");
    expect(r.olmagan_lat).toBeCloseTo(41.311081, 5);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Vehicle F1 schema — behavioral assertions
//
// These tests run against the same throwaway DB created in beforeAll and prove
// that the constraints, partial unique indexes, and CHECK values enforced by
// the runtime DDL actually fire correctly. They cover the six architect-required
// scenarios: warehouse uniqueness, exact status sets, allocation replay
// idempotency, open-replenishment conflict, and reconciliation
// adjustment_reference single-apply.
// ─────────────────────────────────────────────────────────────────────────────
describe("Vehicle F1 schema: constraint and partial-index behavioral assertions", () => {
  it("vehicles.warehouse_id is UNIQUE — second vehicle with same warehouse_id is rejected", async () => {
    await client.query(`
      INSERT INTO distribution.vehicles
        (plate_number, vehicle_type, status, warehouse_id, capacity_kg)
      VALUES ('01A001AA', 'DAMAS', 'active', 9901, 500)
    `);
    await expect(
      client.query(`
        INSERT INTO distribution.vehicles
          (plate_number, vehicle_type, status, warehouse_id, capacity_kg)
        VALUES ('01A002AA', 'LABO', 'active', 9901, 800)
      `),
    ).rejects.toThrow(/unique/i);
  });

  it("vehicles CHECK: only canonical vehicle_type values accepted", async () => {
    await expect(
      client.query(`
        INSERT INTO distribution.vehicles
          (plate_number, vehicle_type, status, warehouse_id, capacity_kg)
        VALUES ('01B001BB', 'truck', 'active', 9902, 500)
      `),
    ).rejects.toThrow(/vehicles_type_check/i);
  });

  it("vehicles CHECK: only canonical status values accepted", async () => {
    await expect(
      client.query(`
        INSERT INTO distribution.vehicles
          (plate_number, vehicle_type, status, warehouse_id, capacity_kg)
        VALUES ('01B002BB', 'DAMAS', 'available', 9903, 500)
      `),
    ).rejects.toThrow(/vehicles_status_check/i);
  });

  it("vehicle_handoffs: only exact status values accepted (prepared/labels_printed/handed_over/stock_transferred/cancelled)", async () => {
    // Insert a valid vehicle to reference
    await client.query(`
      INSERT INTO distribution.vehicles
        (plate_number, vehicle_type, status, warehouse_id, capacity_kg)
      VALUES ('01C001CC', 'DAMAS', 'active', 9904, 500)
    `);
    const vRes = await client.query(
      `SELECT id FROM distribution.vehicles WHERE plate_number = '01C001CC'`
    );
    const vId = vRes.rows[0].id;

    // Old rejected status 'pending' should fail
    await expect(
      client.query(`
        INSERT INTO distribution.vehicle_handoffs
          (vehicle_id, delivery_agent_id, source_warehouse_id, vehicle_warehouse_id,
           handoff_date, status)
        VALUES ($1, 1, 9904, 9904, '2026-08-01', 'pending')
      `, [vId]),
    ).rejects.toThrow(/vehicle_handoffs_status_check/i);

    // Old rejected status 'confirmed' should fail
    await expect(
      client.query(`
        INSERT INTO distribution.vehicle_handoffs
          (vehicle_id, delivery_agent_id, source_warehouse_id, vehicle_warehouse_id,
           handoff_date, status)
        VALUES ($1, 1, 9904, 9904, '2026-08-01', 'confirmed')
      `, [vId]),
    ).rejects.toThrow(/vehicle_handoffs_status_check/i);

    // Valid status 'prepared' succeeds
    await client.query(`
      INSERT INTO distribution.vehicle_handoffs
        (vehicle_id, delivery_agent_id, source_warehouse_id, vehicle_warehouse_id,
         handoff_date, status)
      VALUES ($1, 1, 9904, 9904, '2026-08-01', 'prepared')
    `, [vId]);

    // Valid status 'stock_transferred' succeeds
    await client.query(`
      INSERT INTO distribution.vehicle_handoffs
        (vehicle_id, delivery_agent_id, source_warehouse_id, vehicle_warehouse_id,
         handoff_date, status)
      VALUES ($1, 1, 9904, 9904, '2026-08-02', 'stock_transferred')
    `, [vId]);
  });

  it("vehicle_sale_allocations: operation_key is UNIQUE — replay with same key is rejected", async () => {
    await client.query(`
      INSERT INTO distribution.vehicle_sale_allocations
        (handoff_id, savdo_id, savdo_tafsilot_id, mahsulot_id,
         product_name, product_sku, vehicle_id,
         allocated_quantity, allocated_weight_kg, operation_key)
      VALUES (1, 1, 1, 1, 'Arqon', 'SKU-1', 1, 2, 1.5, 'op-key-replay-test-001')
    `);
    await expect(
      client.query(`
        INSERT INTO distribution.vehicle_sale_allocations
          (handoff_id, savdo_id, savdo_tafsilot_id, mahsulot_id,
           product_name, product_sku, vehicle_id,
           allocated_quantity, allocated_weight_kg, operation_key)
        VALUES (1, 2, 2, 1, 'Arqon', 'SKU-1', 1, 3, 2.0, 'op-key-replay-test-001')
      `),
    ).rejects.toThrow(/unique/i);
  });

  it("vehicle_sale_allocations CHECK: allocated_quantity and allocated_weight_kg must be positive", async () => {
    await expect(
      client.query(`
        INSERT INTO distribution.vehicle_sale_allocations
          (handoff_id, savdo_id, savdo_tafsilot_id, mahsulot_id,
           product_name, product_sku, vehicle_id,
           allocated_quantity, allocated_weight_kg, operation_key)
        VALUES (1, 3, 3, 1, 'Arqon', 'SKU-1', 1, 0, 1.0, 'op-key-qty-zero')
      `),
    ).rejects.toThrow(/vehicle_sale_allocations_qty_check/i);

    await expect(
      client.query(`
        INSERT INTO distribution.vehicle_sale_allocations
          (handoff_id, savdo_id, savdo_tafsilot_id, mahsulot_id,
           product_name, product_sku, vehicle_id,
           allocated_quantity, allocated_weight_kg, operation_key)
        VALUES (1, 4, 4, 1, 'Arqon', 'SKU-1', 1, 1, 0, 'op-key-weight-zero')
      `),
    ).rejects.toThrow(/vehicle_sale_allocations_weight_check/i);
  });

  it("vehicle_sale_allocations: partial unique on source_unit_event_id — one load event supplies at most one allocation", async () => {
    // First unit-tracked allocation referencing load event 42001 succeeds
    await client.query(`
      INSERT INTO distribution.vehicle_sale_allocations
        (handoff_id, savdo_id, savdo_tafsilot_id, mahsulot_id,
         product_name, product_sku, vehicle_id,
         allocated_quantity, allocated_weight_kg, source_unit_event_id, operation_key)
      VALUES (1, 10, 10, 1, 'Arqon', 'SKU-1', 1, 1, 0.5, 42001, 'op-key-src-unit-a')
    `);

    // Second allocation with a DIFFERENT operation_key but the SAME
    // source_unit_event_id is rejected by the partial unique index.
    await expect(
      client.query(`
        INSERT INTO distribution.vehicle_sale_allocations
          (handoff_id, savdo_id, savdo_tafsilot_id, mahsulot_id,
           product_name, product_sku, vehicle_id,
           allocated_quantity, allocated_weight_kg, source_unit_event_id, operation_key)
        VALUES (1, 11, 11, 1, 'Arqon', 'SKU-1', 1, 1, 0.5, 42001, 'op-key-src-unit-b')
      `),
    ).rejects.toThrow(/unique/i);

    // Aggregate allocations (NULL source_unit_event_id) remain allowed and may
    // coexist multiple times — the partial predicate excludes NULLs.
    await client.query(`
      INSERT INTO distribution.vehicle_sale_allocations
        (handoff_id, savdo_id, savdo_tafsilot_id, mahsulot_id,
         product_name, product_sku, vehicle_id,
         allocated_quantity, allocated_weight_kg, operation_key)
      VALUES (1, 12, 12, 1, 'Arqon', 'SKU-1', 1, 2, 1.0, 'op-key-src-unit-null-1')
    `);
    await client.query(`
      INSERT INTO distribution.vehicle_sale_allocations
        (handoff_id, savdo_id, savdo_tafsilot_id, mahsulot_id,
         product_name, product_sku, vehicle_id,
         allocated_quantity, allocated_weight_kg, operation_key)
      VALUES (1, 13, 13, 1, 'Arqon', 'SKU-1', 1, 3, 1.5, 'op-key-src-unit-null-2')
    `);
  });

  it("vehicle_replenishment_requests: canonical product partial unique prevents two open requests", async () => {
    // First open request succeeds
    await client.query(`
      INSERT INTO distribution.vehicle_replenishment_requests
        (vehicle_id, requested_by, mahsulot_id, public_product_id, product_name, sku,
         requested_quantity, target_quantity_snapshot, current_quantity_snapshot, status)
      VALUES (1, 111, 1, 9001, 'Arqon', 'SKU-1', 10, 15, 5, 'pending')
    `);
    // Second open request for same vehicle+canonical product rejected
    await expect(
      client.query(`
        INSERT INTO distribution.vehicle_replenishment_requests
          (vehicle_id, requested_by, mahsulot_id, public_product_id, product_name, sku,
           requested_quantity, target_quantity_snapshot, current_quantity_snapshot, status)
        VALUES (1, 111, 2, 9001, 'Arqon', 'SKU-1', 5, 15, 10, 'pending')
      `),
    ).rejects.toThrow(/unique/i);
    // Closed request for the same canonical product is allowed.
    await client.query(`
      INSERT INTO distribution.vehicle_replenishment_requests
        (vehicle_id, requested_by, mahsulot_id, public_product_id, product_name, sku,
         requested_quantity, target_quantity_snapshot, current_quantity_snapshot, status)
      VALUES (1, 111, 1, 9001, 'Arqon', 'SKU-1', 3, 8, 5, 'rejected')
    `);
  });

  it("F8 canonical target/request quantities are whole units while nullable legacy identities remain accepted", async () => {
    await expect(
      client.query(`
        INSERT INTO distribution.vehicle_stock_targets
          (vehicle_id,mahsulot_id,public_product_id,product_name,sku,
           target_quantity,min_quantity,effective_from)
        VALUES (77,1,77001,'Whole product','WHOLE-1',10.5,2,CURRENT_DATE)
      `),
    ).rejects.toThrow(/vehicle_stock_targets_whole_units_check/i);
    await expect(
      client.query(`
        INSERT INTO distribution.vehicle_stock_targets
          (vehicle_id,mahsulot_id,public_product_id,product_name,sku,
           target_quantity,min_quantity,effective_from)
        VALUES (77,1,77002,'Whole product 2','WHOLE-2',10,2.5,CURRENT_DATE)
      `),
    ).rejects.toThrow(/vehicle_stock_targets_whole_units_check/i);
    await expect(
      client.query(`
        INSERT INTO distribution.vehicle_replenishment_requests
          (vehicle_id,requested_by,mahsulot_id,public_product_id,product_name,sku,
           requested_quantity,target_quantity_snapshot,current_quantity_snapshot,status)
        VALUES (77,1,1,77003,'Whole product 3','WHOLE-3',2.5,5,2.5,'pending')
      `),
    ).rejects.toThrow(/vehicle_replenishment_whole_units_check/i);

    // Legacy rows have no canonical public identity and remain loadable.
    await client.query(`
      INSERT INTO distribution.vehicle_stock_targets
        (vehicle_id,mahsulot_id,public_product_id,sku,target_quantity,min_quantity,effective_from)
      VALUES (78,1,NULL,'',10.5,2.5,CURRENT_DATE)
    `);
    await client.query(`
      INSERT INTO distribution.vehicle_replenishment_requests
        (vehicle_id,requested_by,mahsulot_id,public_product_id,sku,
         requested_quantity,approved_quantity,status)
      VALUES (78,1,1,NULL,'',2.5,2.5,'rejected')
    `);
  });

  it("vehicle_reconciliations: only exact status values accepted (draft/approved/applied/disputed/cancelled)", async () => {
    await expect(
      client.query(`
        INSERT INTO distribution.vehicle_reconciliations
          (vehicle_id, delivery_agent_id, reconciliation_date, status)
        VALUES (1, 1, '2026-08-10', 'confirmed')
      `),
    ).rejects.toThrow(/vehicle_reconciliations_status_check/i);

    // Valid statuses
    await client.query(`
      INSERT INTO distribution.vehicle_reconciliations
        (vehicle_id, delivery_agent_id, reconciliation_date, status)
      VALUES (1, 1, '2026-08-10', 'draft')
    `);
  });

  it("vehicle_reconciliation_items: adjustment_reference partial unique prevents double-apply", async () => {
    // Insert a reconciliation to reference
    const rRes = await client.query(`
      SELECT id FROM distribution.vehicle_reconciliations
      WHERE vehicle_id = 1 AND reconciliation_date = '2026-08-10'
    `);
    const recId = rRes.rows[0].id;

    // First apply — succeeds
    await client.query(`
      INSERT INTO distribution.vehicle_reconciliation_items
        (reconciliation_id, mahsulot_id, expected_quantity, actual_quantity,
         discrepancy, adjustment_reference)
      VALUES ($1, 1, 10, 8, -2, 'adj-ref-single-apply-001')
    `, [recId]);

    // Second apply of same adjustment_reference — rejected by partial unique
    await expect(
      client.query(`
        INSERT INTO distribution.vehicle_reconciliation_items
          (reconciliation_id, mahsulot_id, expected_quantity, actual_quantity,
           discrepancy, adjustment_reference)
        VALUES ($1, 2, 5, 5, 0, 'adj-ref-single-apply-001')
      `, [recId]),
    ).rejects.toThrow(/unique/i);

    // NULL adjustment_reference (not yet applied) can appear multiple times
    await client.query(`
      INSERT INTO distribution.vehicle_reconciliation_items
        (reconciliation_id, mahsulot_id, expected_quantity, actual_quantity, discrepancy)
      VALUES ($1, 3, 6, 6, 0)
    `, [recId]);
    await client.query(`
      INSERT INTO distribution.vehicle_reconciliation_items
        (reconciliation_id, mahsulot_id, expected_quantity, actual_quantity, discrepancy)
      VALUES ($1, 4, 7, 7, 0)
    `, [recId]);
  });

  it("vehicle_assignments: partial unique prevents two active assignments for the same agent", async () => {
    // Insert two distinct vehicles to assign
    await client.query(`
      INSERT INTO distribution.vehicles
        (plate_number, vehicle_type, status, warehouse_id, capacity_kg)
      VALUES ('01D001DD', 'DAMAS', 'active', 9910, 500),
             ('01D002DD', 'LABO',  'active', 9911, 800)
    `);
    const vRes = await client.query(
      `SELECT id FROM distribution.vehicles WHERE plate_number IN ('01D001DD','01D002DD') ORDER BY plate_number`
    );
    const [v1, v2] = vRes.rows.map((r: { id: number }) => r.id);

    // First active assignment for agent 7001 succeeds
    await client.query(`
      INSERT INTO distribution.vehicle_assignments (vehicle_id, delivery_agent_id, status)
      VALUES ($1, 7001, 'active')
    `, [v1]);

    // Second active assignment for the SAME agent (different vehicle) rejected
    await expect(
      client.query(`
        INSERT INTO distribution.vehicle_assignments (vehicle_id, delivery_agent_id, status)
        VALUES ($1, 7001, 'active')
      `, [v2]),
    ).rejects.toThrow(/unique/i);

    // An ENDED assignment for the same agent is allowed (partial predicate excludes it)
    await client.query(`
      INSERT INTO distribution.vehicle_assignments (vehicle_id, delivery_agent_id, status)
      VALUES ($1, 7001, 'ended')
    `, [v2]);
  });

  it("vehicle_unit_events: multiple DISTINCT labels attach to one handoff item; duplicate label/barcode load rejected", async () => {
    // Set up a vehicle + handoff + aggregate handoff item to reference
    await client.query(`
      INSERT INTO distribution.vehicles
        (plate_number, vehicle_type, status, warehouse_id, capacity_kg)
      VALUES ('01E001EE', 'DAMAS', 'active', 9920, 500)
    `);
    const vRes = await client.query(
      `SELECT id FROM distribution.vehicles WHERE plate_number = '01E001EE'`
    );
    const vId = vRes.rows[0].id;

    await client.query(`
      INSERT INTO distribution.vehicle_handoffs
        (vehicle_id, delivery_agent_id, source_warehouse_id, vehicle_warehouse_id,
         handoff_date, status)
      VALUES ($1, 1, 9920, 9920, '2026-09-01', 'prepared')
    `, [vId]);
    const hRes = await client.query(`
      SELECT id FROM distribution.vehicle_handoffs
      WHERE vehicle_id = $1 AND handoff_date = '2026-09-01'
    `, [vId]);
    const hId = hRes.rows[0].id;

    // Aggregate handoff item — one row for the whole product line, no label/barcode
    await client.query(`
      INSERT INTO distribution.vehicle_handoff_items
        (handoff_id, mahsulot_id, sku, quantity_dispatched, unit_cost)
      VALUES ($1, 1, 'SKU-AGG', 3, 100)
    `, [hId]);
    const hiRes = await client.query(`
      SELECT id FROM distribution.vehicle_handoff_items
      WHERE handoff_id = $1 AND mahsulot_id = 1
    `, [hId]);
    const hiId = hiRes.rows[0].id;

    // Three DISTINCT units (labels + barcodes) all attach to the SAME handoff item
    // via load events — proving unit cardinality lives on vehicle_unit_events.
    for (let i = 1; i <= 3; i++) {
      await client.query(`
        INSERT INTO distribution.vehicle_unit_events
          (vehicle_id, handoff_id, handoff_item_id, mahsulot_id, sku,
           event_type, quantity, actor_id, production_label_id, barcode)
        VALUES ($1, $2, $3, 1, 'SKU-AGG', 'load', 1, 555, $4, $5)
      `, [vId, hId, hiId, 1000 + i, `BC-${i}`]);
    }
    const cnt = await client.query(`
      SELECT COUNT(*)::int AS n FROM distribution.vehicle_unit_events
      WHERE handoff_item_id = $1 AND event_type = 'load'
    `, [hiId]);
    expect(cnt.rows[0].n).toBe(3);

    // Duplicate production_label_id load in the SAME handoff is rejected
    await expect(
      client.query(`
        INSERT INTO distribution.vehicle_unit_events
          (vehicle_id, handoff_id, handoff_item_id, mahsulot_id, sku,
           event_type, quantity, actor_id, production_label_id, barcode)
        VALUES ($1, $2, $3, 1, 'SKU-AGG', 'load', 1, 555, 1001, 'BC-NEW')
      `, [vId, hId, hiId]),
    ).rejects.toThrow(/unique/i);

    // Duplicate barcode load in the SAME handoff is rejected
    await expect(
      client.query(`
        INSERT INTO distribution.vehicle_unit_events
          (vehicle_id, handoff_id, handoff_item_id, mahsulot_id, sku,
           event_type, quantity, actor_id, production_label_id, barcode)
        VALUES ($1, $2, $3, 1, 'SKU-AGG', 'load', 1, 555, 9999, 'BC-1')
      `, [vId, hId, hiId]),
    ).rejects.toThrow(/unique/i);

    // A NON-load event with the same label/barcode is allowed (partial predicate
    // only guards event_type='load').
    await client.query(`
      INSERT INTO distribution.vehicle_unit_events
        (vehicle_id, handoff_id, handoff_item_id, mahsulot_id, sku,
         event_type, quantity, actor_id, production_label_id, barcode)
      VALUES ($1, $2, $3, 1, 'SKU-AGG', 'sale', -1, 555, 1001, 'BC-1')
    `, [vId, hId, hiId]);
  });
});
