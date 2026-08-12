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
// "Savdo markazi" KPI kartalari guard'i — GET /distribution/summary.
//
// Endpoint 4 ta ALOHIDA parametr massivini ($n raqamlari qo'lda sanaladi) quradi:
// savdolar (sp), pul_olish (pp), nasiya joriy qoldiq (np) va davr ichidagi
// nasiya (ncp). Xuddi shu sinf binding xatosi Tashriflar tabini jimgina
// bo'shatib qo'ygan edi. Bu test endpoint'ni 4 rejimda qo'riqlaydi: filtrsiz,
// agentId bilan, viloyat/hudud bilan va from/to sanalar bilan — hammasi 200
// bo'lishi va KPI summalari fixture bilan AYNAN mos kelishi SHART.
//
// Fixture (ikkita agent, ikkita do'kon):
//   Agent A (9001) — Andijon/Markaz do'koni:
//     2026-06-01: savdo 5 000 (davr filtri chegarasini tekshirish uchun)
//     2026-07-06: savdo 100 000, pul_olish 30 000,
//                 nasiya jami 50 000 / qoldiq 20 000
//   Agent B (9002) — Toshkent/Chilonzor do'koni:
//     2026-07-10: savdo 200 000, pul_olish 40 000,
//                 nasiya jami 80 000 / qoldiq 80 000
//
// Throwaway DB nomi pid+timestamp bilan unikal — parallel validation'lar
// bir-birining bazasini o'chirmaydi.
// ─────────────────────────────────────────────────────────────────────────────

const { Client } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

const TMP_DB = `topmart_summary_${process.pid}_${Date.now()}`;
const ssl = { rejectUnauthorized: false } as const;

function tmpUrl(sslRequire = false): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${TMP_DB}`;
  if (sslRequire) u.searchParams.set("sslmode", "require");
  return u.toString();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const distBotDir = path.resolve(here, "../../distribution-bot");

const AGENT_A = 9001;
const AGENT_B = 9002;
const TS_OLD = "2026-06-01 10:00:00"; // davrdan tashqarida
const TS_A = "2026-07-06 09:30:00";
const TS_B = "2026-07-10 11:00:00";

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

beforeAll(async () => {
  await dropTmpDb();
  {
    const admin = new Client({ connectionString: adminUrl, ssl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${TMP_DB}`);
    await admin.end();
  }

  // Distribution sxemasini FAQAT haqiqiy bot init kodi bilan ko'taramiz.
  execFileSync("python3", ["-c", "import main; main.init_db()"], {
    cwd: distBotDir,
    env: {
      ...process.env,
      RAILWAY_DATABASE_URL: tmpUrl(true),
      DATABASE_URL: tmpUrl(true),
      TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_SUMMARY_GUARD",
    },
    stdio: "pipe",
  });

  // @workspace/db pool'ini throwaway DB'ga yo'naltiramiz (import'dan OLDIN).
  process.env.RAILWAY_DATABASE_URL = tmpUrl(false);

  const db = await import("@workspace/db");
  pool = db.pool as unknown as pg.Pool;

  // ── Fixture ────────────────────────────────────────────────────────────────
  await pool.query(
    `INSERT INTO distribution.users (telegram_id, name, role, viloyat)
     VALUES ($1, 'Agent A', 'agent', 'Andijon'), ($2, 'Agent B', 'agent', 'Toshkent')`,
    [AGENT_A, AGENT_B],
  );

  const mkShop = async (
    nomi: string, viloyat: string, hudud: string, agent: number, createdAt: string,
  ): Promise<number> => {
    const r = await pool.query(
      `INSERT INTO distribution.dokonlar (nomi, viloyat, hudud, holat, agent_id, created_at)
       VALUES ($1, $2, $3, 'faol', $4, $5) RETURNING id`,
      [nomi, viloyat, hudud, agent, createdAt],
    );
    return r.rows[0].id as number;
  };

  const shopA = await mkShop("A dokon", "Andijon", "Markaz", AGENT_A, TS_A);
  const shopB = await mkShop("B dokon", "Toshkent", "Chilonzor", AGENT_B, TS_B);

  // Savdolar
  const mkSale = (shop: number, agent: number, summa: number, ts: string) =>
    pool.query(
      `INSERT INTO distribution.savdolar (dokon_id, agent_id, jami_summa, tolov_turi, created_at)
       VALUES ($1, $2, $3, 'naqd', $4)`,
      [shop, agent, summa, ts],
    );
  await mkSale(shopA, AGENT_A, 5000, TS_OLD);
  await mkSale(shopA, AGENT_A, 100000, TS_A);
  await mkSale(shopB, AGENT_B, 200000, TS_B);

  // Pul olish
  await pool.query(
    `INSERT INTO distribution.pul_olish (dokon_id, agent_id, summa, created_at)
     VALUES ($1, $2, 30000, $3), ($4, $5, 40000, $6)`,
    [shopA, AGENT_A, TS_A, shopB, AGENT_B, TS_B],
  );

  // Nasiya (kredit) — jami_summa davr KPI'si, qoldiq joriy holat KPI'si
  await pool.query(
    `INSERT INTO distribution.nasiya (dokon_id, agent_id, jami_summa, qoldiq, created_at)
     VALUES ($1, $2, 50000, 20000, $3), ($4, $5, 80000, 80000, $6)`,
    [shopA, AGENT_A, TS_A, shopB, AGENT_B, TS_B],
  );

  // ── Distribution router'ni mount qilamiz (auth devorisiz — sxema/mantiq testi)
  const routerMod = await import("../src/routes/distribution");
  const { default: pinoHttp } = await import("pino-http");
  const { logger } = await import("../src/lib/logger");
  const app: Express = express();
  app.use(pinoHttp({ logger }));
  app.use(express.json());
  app.use(routerMod.default);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (pool) await pool.end();
  process.env.RAILWAY_DATABASE_URL = adminUrl;
  await dropTmpDb();
}, 60_000);

async function getJson(p: string): Promise<any> {
  const r = await fetch(`${apiUrl}${p}`);
  expect(r.status).toBe(200);
  return r.json();
}

describe("GET /distribution/summary — Savdo markazi KPI kartalar guard'i", () => {
  it("filtrsiz 200 va barcha KPI'lar fixture bilan mos", async () => {
    const b = await getJson(`/distribution/summary`);
    expect(b.salesCount).toBe(3);
    expect(b.salesTotal).toBe(305000);
    expect(b.activeAgents).toBe(2);
    expect(b.shopsCount).toBe(2);
    expect(b.collectedTotal).toBe(70000);
    expect(b.outstandingTotal).toBe(100000);
    expect(b.nasiyaSalesCount).toBe(2);
    expect(b.nasiyaSalesTotal).toBe(130000);
    expect(b.newShops).toBe(2);
    expect(b.visitedShops).toBe(2);
    expect(typeof b.lastSaleAt === "string" || b.lastSaleAt === null).toBe(true);
    for (const k of ["stale7", "stale14", "stale30"]) expect(typeof b[k]).toBe("number");
  });

  it("agentId filtri bilan faqat shu agent KPI'lari", async () => {
    const b = await getJson(`/distribution/summary?agentId=${AGENT_A}`);
    expect(b.salesCount).toBe(2); // eski + iyul savdolari
    expect(b.salesTotal).toBe(105000);
    expect(b.activeAgents).toBe(1);
    expect(b.shopsCount).toBe(1);
    expect(b.collectedTotal).toBe(30000);
    expect(b.outstandingTotal).toBe(20000);
    expect(b.nasiyaSalesCount).toBe(1);
    expect(b.nasiyaSalesTotal).toBe(50000);
    expect(b.visitedShops).toBe(1);

    // Mavjud bo'lmagan agent — 200 va nol KPI'lar (500 emas)
    const empty = await getJson(`/distribution/summary?agentId=777777`);
    expect(empty.salesCount).toBe(0);
    expect(empty.salesTotal).toBe(0);
    expect(empty.collectedTotal).toBe(0);
    expect(empty.outstandingTotal).toBe(0);
    expect(empty.nasiyaSalesTotal).toBe(0);
  });

  it("viloyat/hudud filtrlari bilan to'g'ri toraytiradi", async () => {
    const b = await getJson(`/distribution/summary?viloyat=Toshkent&hudud=Chilonzor`);
    expect(b.salesCount).toBe(1);
    expect(b.salesTotal).toBe(200000);
    expect(b.shopsCount).toBe(1);
    expect(b.collectedTotal).toBe(40000);
    expect(b.outstandingTotal).toBe(80000);
    expect(b.nasiyaSalesTotal).toBe(80000);

    // Faqat viloyat bilan ham ishlaydi
    const v = await getJson(`/distribution/summary?viloyat=Andijon`);
    expect(v.salesTotal).toBe(105000);
    expect(v.collectedTotal).toBe(30000);
    expect(v.outstandingTotal).toBe(20000);

    // Boshqa viloyat — nol KPI'lar, lekin 200
    const other = await getJson(`/distribution/summary?viloyat=Navoiy`);
    expect(other.salesCount).toBe(0);
    expect(other.outstandingTotal).toBe(0);
  });

  it("from/to sanalar davrni cheklaydi, nasiya qoldiq esa joriy holatligicha qoladi", async () => {
    const b = await getJson(`/distribution/summary?from=2026-07-01&to=2026-07-31`);
    expect(b.salesCount).toBe(2); // 2026-06-01 savdosi chiqib ketadi
    expect(b.salesTotal).toBe(300000);
    expect(b.collectedTotal).toBe(70000);
    expect(b.nasiyaSalesCount).toBe(2);
    expect(b.nasiyaSalesTotal).toBe(130000);
    expect(b.outstandingTotal).toBe(100000); // joriy qoldiq — sana filtriga bog'lanmaydi
    expect(b.newShops).toBe(2);
    expect(b.visitedShops).toBe(2);

    // Faqat iyun
    const jun = await getJson(`/distribution/summary?from=2026-06-01&to=2026-06-30`);
    expect(jun.salesCount).toBe(1);
    expect(jun.salesTotal).toBe(5000);
    expect(jun.collectedTotal).toBe(0);
    expect(jun.nasiyaSalesTotal).toBe(0);
    expect(jun.newShops).toBe(0);

    // Sana + agent + hudud kombinatsiyasi — barcha 4 params massivi birga
    const combo = await getJson(
      `/distribution/summary?from=2026-07-01&to=2026-07-31&agentId=${AGENT_A}&viloyat=Andijon&hudud=Markaz`,
    );
    expect(combo.salesCount).toBe(1);
    expect(combo.salesTotal).toBe(100000);
    expect(combo.collectedTotal).toBe(30000);
    expect(combo.outstandingTotal).toBe(20000);
    expect(combo.nasiyaSalesTotal).toBe(50000);
  });
});
