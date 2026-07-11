import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

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

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

const TMP_DB = `topmart_dist_freshboot_${process.pid}_${Date.now()}`;
const ssl = { rejectUnauthorized: false } as const;

function tmpUrl(): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${TMP_DB}`;
  return u.toString();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const botDir = path.resolve(here, "../../distribution-bot");
const mainPySource = readFileSync(path.join(botDir, "main.py"), "utf8");

// Env the bot subprocess needs: it prefers RAILWAY_DATABASE_URL (and enables
// sslmode=require when it is set — the throwaway DB lives on the same server,
// so SSL behavior matches production). The token is never used for network
// calls here; TeleBot() construction and handler registration are offline.
const botEnv = {
  ...process.env,
  RAILWAY_DATABASE_URL: tmpUrl(),
  DATABASE_URL: tmpUrl(),
  TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_FRESH_DB_GUARD",
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
    const re = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:distribution\.)?([a-z_][a-z0-9_]*)/g;
    for (const m of mainPySource.matchAll(re)) {
      const t = m[1].toLowerCase();
      if (!NOT_TABLES.has(t)) referenced.add(t);
    }
    expect(referenced.size).toBeGreaterThanOrEqual(13); // sanity: extraction worked

    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'distribution'`,
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
