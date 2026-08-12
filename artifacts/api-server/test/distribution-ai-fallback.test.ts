import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import express from "express";
import type { Express } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

// ─────────────────────────────────────────────────────────────────────────────
// AI tavsiyalar jimgina rule-based'ga qaytishi guard'i (?ai=1 kontrakti).
//
// GET /distribution/suggestions?ai=1 hech qachon panelni buzmasligi SHART:
//   1) LLM chaqiruvi xato bersa (tarmoq/limit/5xx) → 200 + ai:null, overdue/
//      qaytish/agents massivlari BUZILMAGAN holda qaytadi;
//   2) LLM buzuq JSON matn qaytarsa (parse bo'lmaydi) → xuddi shunday ai:null;
//   3) items massiv bo'lmasa → ai:null;
//   4) items ichidagi buzuq elementlar sanitizatsiya qilinadi:
//      - noma'lum dokonId tashlanadi,
//      - reason yo'q/bo'sh element tashlanadi,
//      - score 0..100 oralig'iga qisqartiriladi (clamp), NaN → 0,
//      - ko'pi bilan 10 ta element qoladi.
//
// LLM openai klienti vi.mock bilan almashtiriladi — tarmoq yo'q. Har bir test
// alohida filtr kombinatsiyasini ishlatadi (cacheKey = sana+filtrlar), shunda
// 10 daqiqalik AI kesh testlar orasida to'qnashmaydi.
//
// Throwaway DB nomi pid+timestamp bilan unikal — parallel validation'lar
// bir-birining bazasini o'chirmaydi.
// ─────────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: mocks.create } } },
}));

const { Client } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

const TMP_DB = `topmart_aifallback_${process.pid}_${Date.now()}`;
const ssl = { rejectUnauthorized: false } as const;

function tmpUrl(sslRequire = false): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${TMP_DB}`;
  if (sslRequire) u.searchParams.set("sslmode", "require");
  return u.toString();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const distBotDir = path.resolve(here, "../../distribution-bot");

const AGENT_TG = 9013;
const SHOP_COUNT = 14; // valid nomzodlar 10 tadan ko'p — max-10 cheklovini tekshirish uchun

let pool: pg.Pool;
let server: Server;
let apiUrl: string;
let shopIds: number[] = [];

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
      TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_AI_FALLBACK_GUARD",
    },
    stdio: "pipe",
  });

  // @workspace/db pool'ini throwaway DB'ga yo'naltiramiz (import'dan OLDIN).
  process.env.RAILWAY_DATABASE_URL = tmpUrl(false);

  const db = await import("@workspace/db");
  pool = db.pool as unknown as pg.Pool;

  await pool.query(
    `INSERT INTO distribution.users (telegram_id, name, role, viloyat) VALUES ($1, 'AI Test Agent', 'agent', 'Andijon')`,
    [AGENT_TG],
  );

  // 12 ta "kechikkan" do'kon — last_order_date juda eski, savdo tarixi yo'q
  // (avg_repeat_days=0 → fallback 30 kun chegarasidan ancha o'tgan).
  for (let i = 1; i <= SHOP_COUNT; i++) {
    const r = await pool.query(
      `INSERT INTO distribution.dokonlar (nomi, viloyat, hudud, holat, agent_id, last_order_date, created_at)
       VALUES ($1, 'Andijon', 'Markaz', 'faol', $2, '2020-01-01', '2020-01-01 09:00:00') RETURNING id`,
      [`Alif Overdue ${String(i).padStart(2, "0")}`, AGENT_TG],
    );
    shopIds.push(r.rows[0].id as number);
  }

  // Distribution suggestions router'ni mount qilamiz (auth devorisiz — mantiq testi)
  const routerMod = await import("../src/routes/distribution");
  const { default: pinoHttp } = await import("pino-http");
  const { logger } = await import("../src/lib/logger");
  const app: Express = express();
  app.use(pinoHttp({ logger }));
  app.use(express.json());
  app.use(routerMod.distributionSuggestionsRouter);
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

async function getSuggestions(qs: string): Promise<any> {
  const r = await fetch(`${apiUrl}/distribution/suggestions?${qs}`);
  expect(r.status).toBe(200);
  return r.json();
}

function expectRuleBasedIntact(body: any): void {
  expect(Array.isArray(body.overdue)).toBe(true);
  expect(Array.isArray(body.qaytish)).toBe(true);
  expect(Array.isArray(body.agents)).toBe(true);
  // Rule-based kechikkanlar ro'yxati to'liq keladi (LIMIT 20 → 12 tasi ham ichida)
  expect(body.overdue.length).toBe(SHOP_COUNT);
}

function llmResponse(content: string | null): any {
  return { choices: [{ message: { content } }] };
}

describe("GET /distribution/suggestions?ai=1 — jimgina rule-based fallback", () => {
  it("LLM chaqiruvi xato bersa → 200 + ai:null, rule-based massivlar buziq emas", async () => {
    mocks.create.mockRejectedValueOnce(new Error("service unavailable"));
    const body = await getSuggestions("ai=1");
    expect(body.ai).toBeNull();
    expectRuleBasedIntact(body);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("LLM parse bo'lmaydigan matn qaytarsa → ai:null, 200", async () => {
    mocks.create.mockResolvedValueOnce(llmResponse("kechirasiz, JSON emas {"));
    const body = await getSuggestions("ai=1&viloyat=Andijon");
    expect(body.ai).toBeNull();
    expectRuleBasedIntact(body);
  });

  it("items massiv bo'lmasa → ai:null", async () => {
    mocks.create.mockResolvedValueOnce(llmResponse(JSON.stringify({ items: { oops: true } })));
    const body = await getSuggestions("ai=1&hudud=Markaz");
    expect(body.ai).toBeNull();
    expectRuleBasedIntact(body);
  });

  it("buzuq elementlar sanitizatsiya: noma'lum id/bo'sh reason tashlanadi, score clamp, max 10", async () => {
    const items: any[] = [
      { dokonId: 99999999, score: 55, reason: "noma'lum do'kon" }, // candidates ichida yo'q → tashlanadi
      { dokonId: shopIds[0], score: 250, reason: "  juda muhim  " }, // clamp 100 + trim
      { dokonId: shopIds[1], score: 40 },                            // reason yo'q → tashlanadi
      { dokonId: shopIds[2], score: -5, reason: "manfiy" },          // clamp 0
      { dokonId: shopIds[3], score: "abc", reason: "NaN score" },    // NaN → 0
      { dokonId: shopIds[4], score: 90, reason: "   " },             // bo'sh reason → tashlanadi
    ];
    // Qolgan do'konlarga valid elementlar — jami valid 12 ta (10 tadan ko'p)
    for (let i = 5; i < SHOP_COUNT; i++) {
      items.push({ dokonId: shopIds[i], score: 80 - i, reason: `do'kon ${i}` });
    }
    mocks.create.mockResolvedValueOnce(llmResponse(JSON.stringify({ items })));

    const body = await getSuggestions("ai=1&search=Alif");
    expectRuleBasedIntact(body);
    expect(Array.isArray(body.ai)).toBe(true);
    const ai = body.ai as any[];

    // Valid nomzodlar: shopIds[0,2,3] + shopIds[5..13] = 12 ta, lekin FAQAT
    // birinchi 10 tasi qoladi (max-10 cap) — 11- va 12- valid (shopIds[12],
    // shopIds[13]) kesilib ketadi. Noma'lum id, reason'siz va bo'sh-reason
    // elementlar YO'Q.
    expect(ai.length).toBe(10);
    const ids = ai.map((it) => it.dokonId);
    expect(ids).not.toContain(99999999);
    expect(ids).not.toContain(shopIds[1]);
    expect(ids).not.toContain(shopIds[4]);
    // Cap: 10 tadan keyingi valid elementlar tashlanadi
    expect(ids).not.toContain(shopIds[12]);
    expect(ids).not.toContain(shopIds[13]);
    // Birinchi 10 valid element o'z tartibida saqlanadi
    expect(ids).toEqual([0, 2, 3, 5, 6, 7, 8, 9, 10, 11].map((i) => shopIds[i]));

    const byId = new Map(ai.map((it) => [it.dokonId, it]));
    expect(byId.get(shopIds[0])!.score).toBe(100);
    expect(byId.get(shopIds[0])!.reason).toBe("juda muhim");
    expect(byId.get(shopIds[2])!.score).toBe(0);
    expect(byId.get(shopIds[3])!.score).toBe(0);
    // Har bir element to'liq shaklda (dashboard karta kontrakti)
    for (const it of ai) {
      expect(typeof it.dokonId).toBe("number");
      expect(typeof it.reason).toBe("string");
      expect(it.score).toBeGreaterThanOrEqual(0);
      expect(it.score).toBeLessThanOrEqual(100);
      expect(it.nomi).toBeTruthy();
    }
  });

  it("ai so'ralmaganda LLM umuman chaqirilmaydi va ai:null", async () => {
    const calls = mocks.create.mock.calls.length;
    const body = await getSuggestions("search=Alif%20Overdue%2001");
    expect(body.ai).toBeNull();
    expect(mocks.create.mock.calls.length).toBe(calls);
  });
});
