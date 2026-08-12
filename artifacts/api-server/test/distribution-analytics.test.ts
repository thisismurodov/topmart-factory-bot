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
// /distribution/analytics, /distribution/heatmap, /distribution/suggestions
// endpoint'lari uchun integratsion testlar.
//
// Throwaway DB yaratiladi, bot init_db() + router mount — auth devorisiz.
// Fixture: 2 agent, 3 do'kon, bir necha savdo/olmagan yozuvlari.
// ─────────────────────────────────────────────────────────────────────────────

const { Client } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set");

const TMP_DB = `topmart_analytics_${process.pid}_${Date.now()}`;
const ssl = { rejectUnauthorized: false } as const;

function tmpUrl(sslRequire = false): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${TMP_DB}`;
  if (sslRequire) u.searchParams.set("sslmode", "require");
  return u.toString();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const distBotDir = path.resolve(here, "../../distribution-bot");

// Fixture sanalar
const DATE_A = "2026-06-01"; // older sale — takroriy xaridor uchun
const DATE_B = "2026-07-10"; // asosiy davr boshlanishi
const DATE_C = "2026-07-12"; // asosiy davr ichida olmagan
const DATE_D = "2026-07-15"; // asosiy davr ichida savdo

let pool: pg.Pool;
let server: Server;
let apiUrl: string;
// mahsulotId filtri testlari uchun mahsulot id'lari
let prodOlma: number;
let prodNok: number;

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

  execFileSync("python3", ["-c", "import main; main.init_db()"], {
    cwd: distBotDir,
    env: {
      ...process.env,
      RAILWAY_DATABASE_URL: tmpUrl(true),
      DATABASE_URL: tmpUrl(true),
      TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_ANALYTICS_GUARD",
    },
    stdio: "pipe",
  });

  process.env.RAILWAY_DATABASE_URL = tmpUrl(false);
  const db = await import("@workspace/db");
  pool = db.pool as unknown as pg.Pool;

  // ── Fixture ──────────────────────────────────────────────────────────────
  await pool.query(
    `INSERT INTO distribution.users (telegram_id, name, role, viloyat)
     VALUES (8001, 'Agent Alpha', 'agent', 'Toshkent'),
            (8002, 'Agent Beta',  'agent', 'Andijon')`,
  );

  // Do'konlar: A (GPS bor), B (GPS bor), C (GPS yo'q)
  const shopA = await pool.query(
    `INSERT INTO distribution.dokonlar
       (nomi, viloyat, hudud, holat, latitude, longitude, agent_id,
        last_order_date, created_at)
     VALUES ('Shop A', 'Toshkent', 'Chilonzor', 'faol', 41.3, 69.2, 8001,
             $1, $2) RETURNING id`,
    [DATE_D, `${DATE_A} 09:00:00`],
  ).then((r) => r.rows[0].id as number);

  const shopB = await pool.query(
    `INSERT INTO distribution.dokonlar
       (nomi, viloyat, hudud, holat, latitude, longitude, agent_id,
        last_order_date, created_at)
     VALUES ('Shop B', 'Andijon', 'Shahrixon', 'faol', 40.7, 72.6, 8002,
             $1, $2) RETURNING id`,
    [DATE_B, `${DATE_B} 10:00:00`],
  ).then((r) => r.rows[0].id as number);

  const shopC = await pool.query(
    `INSERT INTO distribution.dokonlar
       (nomi, viloyat, hudud, holat, latitude, longitude, agent_id, created_at)
     VALUES ('Shop C (no gps)', 'Toshkent', 'Yakkasaroy', 'faol', NULL, NULL, 8001, $1)
     RETURNING id`,
    [`${DATE_A} 08:00:00`],
  ).then((r) => r.rows[0].id as number);

  // Mahsulotlar — savdo_tafsilot (mahsulotId filtri) uchun
  prodOlma = await pool.query(
    `INSERT INTO distribution.mahsulotlar (nomi, narx, birlik, faol)
     VALUES ('Olma sharbati', 10000, 'dona', 1) RETURNING id`,
  ).then((r) => r.rows[0].id as number);
  prodNok = await pool.query(
    `INSERT INTO distribution.mahsulotlar (nomi, narx, birlik, faol)
     VALUES ('Nok sharbati', 15000, 'dona', 1) RETURNING id`,
  ).then((r) => r.rows[0].id as number);

  // Savdolar
  // Shop A: avvalgi davr savdosi (DATE_A) — takroriy xaridor ifodalash uchun
  const saleA1 = await pool.query(
    `INSERT INTO distribution.savdolar (dokon_id, agent_id, jami_summa, tolov_turi, created_at)
     VALUES ($1, 8001, 100000, 'naqd', $2) RETURNING id`,
    [shopA, `${DATE_A} 09:30:00`],
  ).then((r) => r.rows[0].id as number);
  // Shop A: asosiy davr savdosi (DATE_D) — nasiya
  const saleA2 = await pool.query(
    `INSERT INTO distribution.savdolar (dokon_id, agent_id, jami_summa, tolov_turi, created_at)
     VALUES ($1, 8001, 200000, 'nasiya', $2) RETURNING id`,
    [shopA, `${DATE_D} 10:00:00`],
  ).then((r) => r.rows[0].id as number);
  // Shop B: asosiy davr savdosi — naqd
  const saleB = await pool.query(
    `INSERT INTO distribution.savdolar (dokon_id, agent_id, jami_summa, tolov_turi, created_at)
     VALUES ($1, 8002, 150000, 'naqd', $2) RETURNING id`,
    [shopB, `${DATE_B} 11:00:00`],
  ).then((r) => r.rows[0].id as number);

  // Savdo tafsilotlari: A savdolari — Olma, B savdosi — Nok
  // (mahsulotId=prodOlma → faqat Shop A savdolari; prodNok → faqat Shop B)
  await pool.query(
    `INSERT INTO distribution.savdo_tafsilot (savdo_id, mahsulot_id, miqdor, narx, summa)
     VALUES ($1, $4, 10, 10000, 100000),
            ($2, $4, 20, 10000, 200000),
            ($3, $5, 10, 15000, 150000)`,
    [saleA1, saleA2, saleB, prodOlma, prodNok],
  );

  // Shop D va E: qaytish_sanasi format testlari uchun qo'shimcha do'konlar
  const shopD = await pool.query(
    `INSERT INTO distribution.dokonlar
       (nomi, viloyat, hudud, holat, latitude, longitude, agent_id, created_at)
     VALUES ('Shop D (past DD.MM.YYYY)', 'Toshkent', 'Mirzo-Ulugbek', 'faol', 41.32, 69.25, 8001, $1)
     RETURNING id`,
    [`${DATE_A} 07:00:00`],
  ).then((r) => r.rows[0].id as number);

  const shopE = await pool.query(
    `INSERT INTO distribution.dokonlar
       (nomi, viloyat, hudud, holat, latitude, longitude, agent_id, created_at)
     VALUES ('Shop E (future DD.MM.YYYY)', 'Toshkent', 'Shayxontohur', 'faol', 41.33, 69.26, 8001, $1)
     RETURNING id`,
    [`${DATE_A} 07:30:00`],
  ).then((r) => r.rows[0].id as number);

  // Olmagan tashrif: Shop C — ISO sana format, o'tgan (2026-07-20 < bugun 2026-08-07)
  await pool.query(
    `INSERT INTO distribution.olmagan_dokonlar
       (dokon_id, agent_id, sabab, qaytish_sanasi, created_at)
     VALUES ($1, 8001, 'egasi_yoq', '2026-07-20', $2)`,
    [shopC, `${DATE_C} 09:00:00`],
  );

  // Shop D — DD.MM.YYYY format, o'tgan kun: 01.06.2026 (o'tgan) → qaytish ro'yxatida bo'lishi kerak
  await pool.query(
    `INSERT INTO distribution.olmagan_dokonlar
       (dokon_id, agent_id, sabab, qaytish_sanasi, created_at)
     VALUES ($1, 8001, 'tovari_bor', '01.06.2026', $2)`,
    [shopD, `${DATE_A} 07:00:00`],
  );

  // Shop E — DD.MM.YYYY format, KELAJAKDAGI sana: 01.12.2026 → qaytish ro'yxatida bo'LMASLIGI kerak
  await pool.query(
    `INSERT INTO distribution.olmagan_dokonlar
       (dokon_id, agent_id, sabab, qaytish_sanasi, created_at)
     VALUES ($1, 8001, 'keyin_keling', '01.12.2026', $2)`,
    [shopE, `${DATE_A} 07:30:00`],
  );

  // Shop F — NOTO'G'RI SANA FORMAT: 'garbage-date' → endpoint crash bo'lmasligi, ro'yxatga kirmasligi kerak
  const shopF = await pool.query(
    `INSERT INTO distribution.dokonlar
       (nomi, viloyat, hudud, holat, latitude, longitude, agent_id, created_at)
     VALUES ('Shop F (malformed date)', 'Toshkent', 'Chilonzor', 'faol', 41.34, 69.27, 8001, $1)
     RETURNING id`,
    [`${DATE_A} 08:00:00`],
  ).then((r) => r.rows[0].id as number);

  await pool.query(
    `INSERT INTO distribution.olmagan_dokonlar
       (dokon_id, agent_id, sabab, qaytish_sanasi, created_at)
     VALUES ($1, 8001, 'boshqa', 'garbage-date', $2)`,
    [shopF, `${DATE_C} 10:00:00`],
  );

  // Shop G — ISO-SHAKLLI LEKIN NOTO'G'RI SANA: '2026-99-99' → regex validatsiyadan o'tmaydi
  const shopG = await pool.query(
    `INSERT INTO distribution.dokonlar
       (nomi, viloyat, hudud, holat, latitude, longitude, agent_id, created_at)
     VALUES ('Shop G (bad ISO date)', 'Toshkent', 'Yakkasaroy', 'faol', 41.35, 69.28, 8001, $1)
     RETURNING id`,
    [`${DATE_A} 09:00:00`],
  ).then((r) => r.rows[0].id as number);

  await pool.query(
    `INSERT INTO distribution.olmagan_dokonlar
       (dokon_id, agent_id, sabab, qaytish_sanasi, created_at)
     VALUES ($1, 8001, 'boshqa', '2026-99-99', $2)`,
    [shopG, `${DATE_C} 10:30:00`],
  );

  // Shop H — REGEX TO'G'RI LEKIN TAQVIM NOTO'G'RI: '2026-02-31' (Feb 31 yo'q)
  // → regex/cast/make_date dan o'tmasligi, NULL sifatida qaralishi kerak
  const shopH = await pool.query(
    `INSERT INTO distribution.dokonlar
       (nomi, viloyat, hudud, holat, latitude, longitude, agent_id, created_at)
     VALUES ('Shop H (Feb 31 ISO)', 'Toshkent', 'Mirzo Ulugbek', 'faol', 41.36, 69.29, 8001, $1)
     RETURNING id`,
    [`${DATE_A} 09:30:00`],
  ).then((r) => r.rows[0].id as number);

  await pool.query(
    `INSERT INTO distribution.olmagan_dokonlar
       (dokon_id, agent_id, sabab, qaytish_sanasi, created_at)
     VALUES ($1, 8001, 'boshqa', '2026-02-31', $2)`,
    [shopH, `${DATE_C} 11:00:00`],
  );

  // Shop I — DD.MM.YYYY TAQVIM NOTO'G'RI: '31.02.2026' (Feb 31 yo'q)
  // → calendar check dan o'tmasligi, NULL sifatida qaralishi kerak
  const shopI = await pool.query(
    `INSERT INTO distribution.dokonlar
       (nomi, viloyat, hudud, holat, latitude, longitude, agent_id, created_at)
     VALUES ('Shop I (Feb 31 DDMMYYYY)', 'Toshkent', 'Sergeli', 'faol', 41.37, 69.30, 8001, $1)
     RETURNING id`,
    [`${DATE_A} 10:00:00`],
  ).then((r) => r.rows[0].id as number);

  await pool.query(
    `INSERT INTO distribution.olmagan_dokonlar
       (dokon_id, agent_id, sabab, qaytish_sanasi, created_at)
     VALUES ($1, 8001, 'boshqa', '31.02.2026', $2)`,
    [shopI, `${DATE_C} 11:30:00`],
  );

  // Delivery agent + GPS (bugungi sana o'rniga DATE_D ni ishlatamiz, endpoint
  // `today` ni DB dan oladi — fixture sanasini moslashtirish kerak emas,
  // suggestions/heatmap statik testlar sifatida tekshiriladi)
  const da = await pool.query(
    `INSERT INTO distribution.delivery_agents (name, mashina_nomeri, telegram_id, faol)
     VALUES ('Dlv Alpha', '01 T 999 AA', 8001, 1) RETURNING id`,
  ).then((r) => r.rows[0].id as number);

  // Bu agentning marshrutiga Shop A qo'shiladi (biron-bir kun uchun)
  await pool.query(
    `INSERT INTO distribution.delivery_routes (delivery_agent_id, kun, dokon_id, tartib)
     VALUES ($1, 1, $2, 1)`,
    [da, shopA],
  );

  // ── Express server ────────────────────────────────────────────────────────
  const routerMod = await import("../src/routes/distribution");
  const { default: pinoHttp } = await import("pino-http");
  const { logger } = await import("../src/lib/logger");
  const app: Express = express();
  app.use(pinoHttp({ logger }));
  app.use(express.json());
  app.use(routerMod.default);
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

async function getJson(p: string): Promise<any> {
  const r = await fetch(`${apiUrl}${p}`);
  if (r.status !== 200) {
    const body = await r.text().catch(() => "(unreadable)");
    throw new Error(`GET ${p} returned ${r.status}: ${body.slice(0, 500)}`);
  }
  return r.json();
}

// ── /distribution/analytics ──────────────────────────────────────────────────
describe("GET /distribution/analytics", () => {
  it("filtrsiz — KPI va daily massivlarini qaytaradi", async () => {
    const body = await getJson(
      `/distribution/analytics?from=${DATE_B}&to=${DATE_D}`,
    );
    expect(body.from).toBe(DATE_B);
    expect(body.to).toBe(DATE_D);
    expect(body.kpi).toBeDefined();
    expect(typeof body.kpi.visitedShops).toBe("number");
    expect(typeof body.kpi.soldShops).toBe("number");
    expect(Array.isArray(body.daily)).toBe(true);
    // Davr = DATE_B..DATE_D → 6 kun, shuning uchun daily.length = 6
    expect(body.daily.length).toBe(6);
  });

  it("soldShops filtrlangan davrda to'g'ri hisoblanadi", async () => {
    const body = await getJson(
      `/distribution/analytics?from=${DATE_B}&to=${DATE_D}`,
    );
    // Davr ichida 2 noyob do'kon savdo qildi: Shop A (DATE_D) va Shop B (DATE_B)
    expect(body.kpi.soldShops).toBe(2);
  });

  it("visitedShops savdo + olmagan tashriflarni birga hisoblaydi", async () => {
    const body = await getJson(
      `/distribution/analytics?from=${DATE_B}&to=${DATE_D}`,
    );
    // Shop A (savdo DATE_D), Shop B (savdo DATE_B), Shop C (olmagan DATE_C),
    // Shop F (olmagan DATE_C, garbage-date), Shop G (olmagan DATE_C, bad ISO),
    // Shop H (olmagan DATE_C, 2026-02-31), Shop I (olmagan DATE_C, 31.02.2026) = 7
    expect(body.kpi.visitedShops).toBe(7);
  });

  it("nasiyaCount nasiya+aralash savdolar sonini to'g'ri qaytaradi", async () => {
    const body = await getJson(
      `/distribution/analytics?from=${DATE_B}&to=${DATE_D}`,
    );
    // Davr ichida faqat Shop A nasiya (DATE_D) — 1 ta
    expect(body.kpi.nasiyaCount).toBe(1);
  });

  it("repeatPct: avval ham savdo qilgan do'konlar aniqlangan", async () => {
    const body = await getJson(
      `/distribution/analytics?from=${DATE_B}&to=${DATE_D}`,
    );
    // Shop A davrgacha DATE_A da ham savdo qilgan → repeatShops = 1
    // soldShops = 2, repeatPct = round(1/2*100) = 50
    expect(body.kpi.repeatPct).toBe(50);
  });

  it("agentId filtri bilan faqat shu agent ma'lumotlari qaytadi", async () => {
    const body = await getJson(
      `/distribution/analytics?from=${DATE_B}&to=${DATE_D}&agentId=8002`,
    );
    // Agent Beta faqat Shop B ga savdo qildi
    expect(body.kpi.soldShops).toBe(1);
    expect(body.kpi.salesCount).toBe(1);
    expect(body.kpi.salesTotal).toBe(150000);
  });

  it("viloyat filtri bilan boshqa viloyat do'konlari chiqariladi", async () => {
    const body = await getJson(
      `/distribution/analytics?from=${DATE_B}&to=${DATE_D}&viloyat=Andijon`,
    );
    // Andijon viloyatida faqat Shop B bor
    expect(body.kpi.soldShops).toBe(1);
  });

  it("faqat olmagan tashriflar bo'lgan davrda avgVisitsPerDay null bo'lmasligi kerak", async () => {
    // DATE_C da Shop C va Shop F olmagan tashrifi bor, savdo yo'q
    // avgVisitsPerDay faqat-savdo-kun denominator ishlatsa null kelardi → regression test
    const body = await getJson(
      `/distribution/analytics?from=${DATE_C}&to=${DATE_C}`,
    );
    // visitedShops > 0 (Shop C, Shop F, Shop G olmagan shu kunda)
    expect(body.kpi.visitedShops).toBeGreaterThan(0);
    // avgVisitsPerDay null bo'lmasligi kerak
    expect(body.kpi.avgVisitsPerDay).not.toBeNull();
    expect(typeof body.kpi.avgVisitsPerDay).toBe("number");
  });

  it("daily massivida date, visits, sales, salesTotal maydonlari bor", async () => {
    const body = await getJson(
      `/distribution/analytics?from=${DATE_B}&to=${DATE_D}`,
    );
    for (const day of body.daily) {
      expect(typeof day.date).toBe("string");
      expect(typeof day.visits).toBe("number");
      expect(typeof day.sales).toBe("number");
      expect(typeof day.salesTotal).toBe("number");
    }
    // DATE_B da Shop B savdosi bor
    const dayB = body.daily.find((d: any) => d.date === DATE_B);
    expect(dayB).toBeDefined();
    expect(dayB.sales).toBeGreaterThanOrEqual(1);
  });
});

// ── /distribution/heatmap ────────────────────────────────────────────────────
describe("GET /distribution/heatmap", () => {
  it("shops va hududlar massivlarini qaytaradi", async () => {
    const body = await getJson("/distribution/heatmap");
    expect(Array.isArray(body.shops)).toBe(true);
    expect(Array.isArray(body.hududlar)).toBe(true);
  });

  it("faqat koordinatali do'konlarni qaytaradi", async () => {
    const body = await getJson("/distribution/heatmap");
    // Shop C (GPS yo'q) bo'lmasligi kerak
    const names = body.shops.map((s: any) => s.nomi);
    expect(names).not.toContain("Shop C (no gps)");
    // Shop A va Shop B bo'lishi kerak
    expect(names).toContain("Shop A");
    expect(names).toContain("Shop B");
  });

  it("har bir do'kon uchun cls maydoni bor (green|yellow|red|new)", async () => {
    const body = await getJson("/distribution/heatmap");
    for (const s of body.shops) {
      expect(["green", "yellow", "red", "new"]).toContain(s.cls);
    }
  });

  it("har bir do'kon uchun avgRepeatDays maydoni bor (kadans hisoblangan)", async () => {
    const body = await getJson("/distribution/heatmap");
    for (const s of body.shops) {
      expect(typeof s.avgRepeatDays).toBe("number");
    }
  });

  it("tasnif kadans asosida: avgRepeatDays > 0 bo'lsa nisbiy chegaralar qo'llanadi", async () => {
    // Shop A: DATE_A va DATE_D da ikki savdo bor — avg_repeat_days = 10 kun
    // days_since_last_order ≈ 23 kun (DATE_D = 2026-07-15 dan bugunga qadar)
    // Kadans > 0 bo'lganda: days > cadence*2 → RED
    const body = await getJson("/distribution/heatmap");
    const shopA = body.shops.find((s: any) => s.nomi === "Shop A");
    expect(shopA).toBeDefined();
    expect(shopA.avgRepeatDays).toBeGreaterThan(0);  // tarix bor, kadans hisoblangan
    // Klassifikatsiya formulani tekshirish: kadans asosida to'g'ri hisoblangan bo'lishi kerak
    const { days, avgRepeatDays, cls } = shopA;
    if (avgRepeatDays > 0) {
      const expectedCls = days <= avgRepeatDays ? "green" : days <= avgRepeatDays * 2 ? "yellow" : "red";
      expect(cls).toBe(expectedCls);
    }
  });

  it("tasnif kadans asosida: avgRepeatDays = 0 bo'lsa fixed 14/30 chegaralar qo'llanadi", async () => {
    // Shop B: faqat 1 ta savdo bor — avg_repeat_days = 0 → fallback fixed thresholds
    const body = await getJson("/distribution/heatmap");
    const shopB = body.shops.find((s: any) => s.nomi === "Shop B");
    expect(shopB).toBeDefined();
    expect(shopB.avgRepeatDays).toBe(0);  // bitta savdo, kadans yo'q
    // Fallback formula tekshirish
    const { days, cls } = shopB;
    if (days !== null) {
      const expectedCls = days <= 14 ? "green" : days <= 30 ? "yellow" : "red";
      expect(cls).toBe(expectedCls);
    }
  });

  it("hududlar centroid hisoblanadi", async () => {
    const body = await getJson("/distribution/heatmap");
    for (const h of body.hududlar) {
      // centroid null bo'lmasligi kerak (har bir hududda kamida 1 GPS do'kon bor)
      if (h.shopCount > 0) {
        expect(h.centroid).not.toBeNull();
        expect(typeof h.centroid.lat).toBe("number");
        expect(typeof h.centroid.lng).toBe("number");
      }
    }
  });

  it("agentId filtri bilan faqat o'sha agent do'konlari qaytadi", async () => {
    const body = await getJson("/distribution/heatmap?agentId=8002");
    // Agent Beta faqat Shop B ga birikkan
    const names = body.shops.map((s: any) => s.nomi);
    expect(names).toContain("Shop B");
    expect(names).not.toContain("Shop A");
  });

  it("viloyat filtri ishlaydi", async () => {
    const body = await getJson("/distribution/heatmap?viloyat=Andijon");
    for (const s of body.shops) {
      expect(s.viloyat).toBe("Andijon");
    }
  });
});

// ── /distribution/suggestions ────────────────────────────────────────────────
describe("GET /distribution/suggestions", () => {
  it("date, kun, agents, overdue, qaytish maydonlarini qaytaradi", async () => {
    const body = await getJson("/distribution/suggestions");
    expect(typeof body.date).toBe("string");
    expect(typeof body.kun).toBe("number");
    expect(Array.isArray(body.agents)).toBe(true);
    expect(Array.isArray(body.overdue)).toBe(true);
    expect(Array.isArray(body.qaytish)).toBe(true);
  });

  it("overdue do'konlar yaqinda buyurtma bermaganlar (kadans asosida)", async () => {
    // Overdue mezoni: days > (avgRepeatDays > 0 ? avgRepeatDays : 30)
    // Fixed 30-kun emas — har do'konning kadansiga nisbatan kechikkanlar ko'rsatiladi.
    const body = await getJson("/distribution/suggestions");
    for (const o of body.overdue) {
      expect(typeof o.dokonId).toBe("number");
      expect(typeof o.days).toBe("number");
      expect(typeof o.avgRepeatDays).toBe("number");
      // Kadans mezoni tekshiruvi
      const threshold = o.avgRepeatDays > 0 ? o.avgRepeatDays : 30;
      expect(o.days).toBeGreaterThan(threshold);
    }
  });

  it("overdue ro'yxatidagi har bir do'kon kadans formulasiga mos keladi", async () => {
    // Quyidagi invariant barcha overdue elementlarga taalluqli:
    //   days > (avgRepeatDays > 0 ? avgRepeatDays : 30)
    // Agar avgRepeatDays > 0 bo'lsa va days < 30 (fixed chegarasidan past) bo'lsa ham
    // element ro'yxatda bo'lishi kerak — bu kadans asosida tasniflanayotganini isbotlaydi.
    const body = await getJson("/distribution/suggestions");
    expect(Array.isArray(body.overdue)).toBe(true);
    for (const o of body.overdue) {
      const threshold = o.avgRepeatDays > 0 ? o.avgRepeatDays : 30;
      expect(o.days).toBeGreaterThan(threshold);
    }
    // Eng muhim: avgRepeatDays > 0 bo'lgan element bor bo'lsa, u days < 30 bo'lishi MUMKIN
    // (bu fixed-30-kun logikasidan farqi — shunday element topilsa qo'shimcha tekshirish)
    const shortCadenceOverdue = body.overdue.filter(
      (o: any) => o.avgRepeatDays > 0 && o.days < 30
    );
    // Agar bunday element bo'lsa — fixed-30-kun uni o'tkazib yuborardi (regression to'silgan)
    for (const o of shortCadenceOverdue) {
      expect(o.days).toBeGreaterThan(o.avgRepeatDays);
    }
  });

  it("qaytish massivida to'g'ri strukturali elementlar bor", async () => {
    const body = await getJson("/distribution/suggestions");
    for (const q of body.qaytish) {
      expect(q.dokonId).toBeDefined();
      // qaytish sanasi bo'lishi kerak
      expect(q.qaytishSanasi ?? q.dueIso).toBeDefined();
    }
  });

  it("o'tgan DD.MM.YYYY qaytish sanasi do'koni ro'yxatda ko'rinadi", async () => {
    // Shop D: '01.06.2026' — o'tgan (test 2026-08-07 kuni ishlatiladi)
    // qaytish_sanasi bo'lsa ISO ham DD.MM.YYYY ham qo'llab-quvvatlanishi shart
    const body = await getJson("/distribution/suggestions");
    const names = body.qaytish.map((q: any) => q.nomi as string);
    expect(names).toContain("Shop D (past DD.MM.YYYY)");
  });

  it("kelajakdagi DD.MM.YYYY qaytish sanasi do'koni ro'yxatga tushmasligi kerak", async () => {
    // Shop E: '01.12.2026' — kelajak sana, ko'rinmaslik kerak
    const body = await getJson("/distribution/suggestions");
    const names = body.qaytish.map((q: any) => q.nomi as string);
    expect(names).not.toContain("Shop E (future DD.MM.YYYY)");
  });

  it("noto'g'ri sana formatli qaytish_sanasi endpoint'ni yiqitmasligi va ro'yxatga kirmasligi kerak", async () => {
    // Shop F: 'garbage-date' — noto'g'ri format, NULL sifatida qayta ishlanadi
    // Endpoint 200 qaytarishi va Shop F ro'yxatda bo'lmasligi kerak
    const body = await getJson("/distribution/suggestions");
    expect(Array.isArray(body.qaytish)).toBe(true);
    const names = body.qaytish.map((q: any) => q.nomi as string);
    expect(names).not.toContain("Shop F (malformed date)");
  });

  it("ISO-shaklli lekin noto'g'ri qaytish_sanasi (masalan 2026-99-99) endpoint'ni yiqitmasligi kerak", async () => {
    // Shop G: '2026-99-99' — regex validatsiyasidan o'tmaydi (oy=99 noto'g'ri)
    // NULL sifatida qayta ishlanadi, ro'yxatga kirmasligi kerak
    const body = await getJson("/distribution/suggestions");
    expect(Array.isArray(body.qaytish)).toBe(true);
    const names = body.qaytish.map((q: any) => q.nomi as string);
    expect(names).not.toContain("Shop G (bad ISO date)");
  });

  it("taqvim noto'g'ri ISO sana '2026-02-31' (fevral 31 yo'q) endpoint'ni yiqitmasligi kerak", async () => {
    // Shop H: '2026-02-31' — regex to'g'ri (kun 0[1-9]|[12][0-9]|3[01]) lekin taqvim tekshiruvida
    // 31 > last_day_of_feb → NULL, ro'yxatga kirmasligi kerak
    const body = await getJson("/distribution/suggestions");
    expect(Array.isArray(body.qaytish)).toBe(true);
    const names = body.qaytish.map((q: any) => q.nomi as string);
    expect(names).not.toContain("Shop H (Feb 31 ISO)");
  });

  it("taqvim noto'g'ri DD.MM.YYYY sana '31.02.2026' endpoint'ni yiqitmasligi kerak", async () => {
    // Shop I: '31.02.2026' — regex to'g'ri lekin taqvim tekshiruvida 31 > 28 → NULL
    const body = await getJson("/distribution/suggestions");
    expect(Array.isArray(body.qaytish)).toBe(true);
    const names = body.qaytish.map((q: any) => q.nomi as string);
    expect(names).not.toContain("Shop I (Feb 31 DDMMYYYY)");
  });

  it("agents massivida nearest massivi bor", async () => {
    const body = await getJson("/distribution/suggestions");
    for (const a of body.agents) {
      expect(typeof a.agentId).toBe("string");
      expect(Array.isArray(a.nearest)).toBe(true);
      expect(a.nearest.length).toBeGreaterThan(0);
      expect(a.nearest.length).toBeLessThanOrEqual(3);
      for (const n of a.nearest) {
        expect(typeof n.dokonId).toBe("number");
        expect(typeof n.distKm).toBe("number");
      }
    }
  });

  it("agentId filtri bilan faqat o'sha agent do'konlari qaytadi", async () => {
    const body = await getJson("/distribution/suggestions");
    const bodyFiltered = await getJson("/distribution/suggestions?agentId=8002");
    // Hech qanday xato bo'lmasligi kerak
    expect(Array.isArray(bodyFiltered.overdue)).toBe(true);
    expect(Array.isArray(bodyFiltered.qaytish)).toBe(true);
    // Filtrlangan natija umumiy natijadan ko'p bo'lmasligi kerak
    expect(bodyFiltered.overdue.length).toBeLessThanOrEqual(body.overdue.length);
  });
});

// ── /distribution/analytics/export ↔ /distribution/analytics muvofiqligi ─────
// Export endpoint'i analytics'dagi kunlik/KPI so'rovlarini takrorlaydi — biri
// o'zgartirilib ikkinchisi qolsa, supervisor ekrandagi grafikdан farqli raqam
// yuklab oladi. Bu testlar ikkala javobni bevosita solishtiradi.
describe("GET /distribution/analytics/export — grafiklar bilan muvofiqlik", () => {
  async function getCsv(p: string): Promise<{ raw: string; hasBomBytes: boolean; contentType: string; disposition: string }> {
    const r = await fetch(`${apiUrl}${p}`);
    if (r.status !== 200) {
      const body = await r.text().catch(() => "(unreadable)");
      throw new Error(`GET ${p} returned ${r.status}: ${body.slice(0, 500)}`);
    }
    // Diqqat: fetch().text() UTF-8 BOM'ni dekodlashda olib tashlaydi —
    // BOM'ni xom baytlar (EF BB BF) darajasida tekshiramiz
    const buf = Buffer.from(await r.arrayBuffer());
    const hasBomBytes = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const raw = buf.toString("utf8");
    return {
      raw,
      hasBomBytes,
      contentType: r.headers.get("content-type") ?? "",
      disposition: r.headers.get("content-disposition") ?? "",
    };
  }

  // CSV'ni bo'limlarga ajratish: "Kunlik hisobot" va "Agent KPI"
  function parseCsvSections(raw: string): {
    hasBom: boolean;
    davr: string[];
    dailyHeader: string;
    daily: Array<{ date: string; visits: number; sales: number; salesTotal: number }>;
    agentHeader: string;
    agents: Array<{
      name: string; visited: number; sold: number;
      conv: string; rep: string; nas: string; salesCount: number; salesTotal: number;
    }>;
  } {
    const hasBom = raw.charCodeAt(0) === 0xfeff;
    const text = hasBom ? raw.slice(1) : raw;
    const lines = text.split("\r\n");
    const dailyIdx = lines.indexOf("Kunlik hisobot");
    const agentIdx = lines.indexOf("Agent KPI");
    if (dailyIdx < 0 || agentIdx < 0) throw new Error("CSV bo'limlari topilmadi");
    const daily: Array<{ date: string; visits: number; sales: number; salesTotal: number }> = [];
    for (let i = dailyIdx + 2; i < lines.length && lines[i] !== ""; i++) {
      const [date, visits, sales, salesTotal] = lines[i].split(",");
      daily.push({ date, visits: Number(visits), sales: Number(sales), salesTotal: Number(salesTotal) });
    }
    const agents: Array<{
      name: string; visited: number; sold: number;
      conv: string; rep: string; nas: string; salesCount: number; salesTotal: number;
    }> = [];
    for (let i = agentIdx + 2; i < lines.length && lines[i] !== ""; i++) {
      const cols = lines[i].split(",");
      // Fixture nomlarida vergul yo'q — oddiy split yetarli
      agents.push({
        name: cols[0], visited: Number(cols[1]), sold: Number(cols[2]),
        conv: cols[3], rep: cols[4], nas: cols[5],
        salesCount: Number(cols[6]), salesTotal: Number(cols[7]),
      });
    }
    return {
      hasBom,
      davr: lines[0].split(","),
      dailyHeader: lines[dailyIdx + 1],
      daily,
      agentHeader: lines[agentIdx + 1],
      agents,
    };
  }

  const Q = `from=${DATE_B}&to=${DATE_D}`;

  it("CSV strukturasi: BOM, sarlavhalar, bo'limlar, headerlar", async () => {
    const { raw, hasBomBytes, contentType, disposition } = await getCsv(`/distribution/analytics/export?${Q}`);
    expect(contentType).toContain("text/csv");
    expect(disposition).toContain(`tahlil_${DATE_B}_${DATE_D}.csv`);
    const p = parseCsvSections(raw);
    expect(hasBomBytes || p.hasBom).toBe(true);
    expect(p.davr).toEqual(["Davr", DATE_B, DATE_D]);
    expect(p.dailyHeader).toBe("Sana,Tashriflar (do'kon),Savdo soni,Savdo summasi (so'm)");
    expect(p.agentHeader).toBe(
      "Agent,Kirilgan do'konlar,Sotib olgan do'konlar,Konversiya %,Takroriy %,Nasiya %,Savdo soni,Savdo summasi (so'm)"
    );
    // CRLF va yakuniy qator tugashi
    expect(raw.endsWith("\r\n")).toBe(true);
  });

  it("kunlik bo'lim analytics endpoint'ining daily massiviga aynan teng", async () => {
    const [{ raw }, analytics] = await Promise.all([
      getCsv(`/distribution/analytics/export?${Q}`),
      getJson(`/distribution/analytics?${Q}`),
    ]);
    const p = parseCsvSections(raw);
    // Bir xil sanalar, bir xil tartib, bir xil qiymatlar
    expect(p.daily).toEqual(
      analytics.daily.map((d: any) => ({
        date: d.date, visits: d.visits, sales: d.sales, salesTotal: d.salesTotal,
      }))
    );
    // Muvofiqlik tasodifiy bo'sh massivlar tufayli emasligini tekshiramiz
    expect(p.daily.length).toBe(6);
    expect(p.daily.some((d) => d.sales > 0)).toBe(true);
  });

  it("agentId filtri bilan ham kunlik bo'lim analytics'ga teng", async () => {
    const q = `${Q}&agentId=8001`;
    const [{ raw }, analytics] = await Promise.all([
      getCsv(`/distribution/analytics/export?${q}`),
      getJson(`/distribution/analytics?${q}`),
    ]);
    const p = parseCsvSections(raw);
    expect(p.daily).toEqual(
      analytics.daily.map((d: any) => ({
        date: d.date, visits: d.visits, sales: d.sales, salesTotal: d.salesTotal,
      }))
    );
  });

  // Export va analytics'dagi kunlik so'rovlar bir xil filtrga bo'ysunishi kerak —
  // viloyat/hudud/tolovTuri/mahsulotId/search bo'yicha ikkalasini solishtiramiz.
  async function expectDailyMatches(query: string): Promise<{
    daily: Array<{ date: string; visits: number; sales: number; salesTotal: number }>;
  }> {
    const [{ raw }, analytics] = await Promise.all([
      getCsv(`/distribution/analytics/export?${query}`),
      getJson(`/distribution/analytics?${query}`),
    ]);
    const p = parseCsvSections(raw);
    expect(p.daily).toEqual(
      analytics.daily.map((d: any) => ({
        date: d.date, visits: d.visits, sales: d.sales, salesTotal: d.salesTotal,
      }))
    );
    return { daily: p.daily };
  }

  it("viloyat filtri bilan kunlik bo'lim analytics'ga teng va haqiqatan filtrlaydi", async () => {
    const { daily } = await expectDailyMatches(`${Q}&viloyat=Andijon`);
    // Andijonda faqat Shop B (DATE_B, 150000) — DATE_D savdosi chiqarilgan
    const dayB = daily.find((d) => d.date === DATE_B)!;
    const dayD = daily.find((d) => d.date === DATE_D)!;
    expect(dayB.sales).toBe(1);
    expect(dayB.salesTotal).toBe(150000);
    expect(dayD.sales).toBe(0);
  });

  it("hudud filtri bilan kunlik bo'lim analytics'ga teng va haqiqatan filtrlaydi", async () => {
    const { daily } = await expectDailyMatches(`${Q}&hudud=Shahrixon`);
    // Shahrixonda faqat Shop B bor
    const dayB = daily.find((d) => d.date === DATE_B)!;
    const dayD = daily.find((d) => d.date === DATE_D)!;
    expect(dayB.sales).toBe(1);
    expect(dayD.sales).toBe(0);
    // Olmagan tashriflar ham (barchasi Toshkent hududlarida) chiqarilgan
    const dayC = daily.find((d) => d.date === DATE_C)!;
    expect(dayC.visits).toBe(0);
  });

  it("tolovTuri filtri bilan kunlik bo'lim analytics'ga teng va haqiqatan filtrlaydi", async () => {
    const { daily } = await expectDailyMatches(`${Q}&tolovTuri=nasiya`);
    // Nasiya faqat Shop A (DATE_D, 200000)
    const dayB = daily.find((d) => d.date === DATE_B)!;
    const dayD = daily.find((d) => d.date === DATE_D)!;
    expect(dayD.sales).toBe(1);
    expect(dayD.salesTotal).toBe(200000);
    expect(dayB.sales).toBe(0);
  });

  it("mahsulotId filtri bilan kunlik bo'lim analytics'ga teng va haqiqatan filtrlaydi", async () => {
    // prodOlma faqat Shop A savdolarida bor → DATE_D qoladi, DATE_B chiqadi
    const { daily } = await expectDailyMatches(`${Q}&mahsulotId=${prodOlma}`);
    const dayB = daily.find((d) => d.date === DATE_B)!;
    const dayD = daily.find((d) => d.date === DATE_D)!;
    expect(dayD.sales).toBe(1);
    expect(dayD.salesTotal).toBe(200000);
    expect(dayB.sales).toBe(0);

    // prodNok faqat Shop B savdosida bor → aksincha
    const { daily: daily2 } = await expectDailyMatches(`${Q}&mahsulotId=${prodNok}`);
    const dayB2 = daily2.find((d) => d.date === DATE_B)!;
    const dayD2 = daily2.find((d) => d.date === DATE_D)!;
    expect(dayB2.sales).toBe(1);
    expect(dayB2.salesTotal).toBe(150000);
    expect(dayD2.sales).toBe(0);
  });

  it("search filtri bilan kunlik bo'lim analytics'ga teng va haqiqatan filtrlaydi", async () => {
    const { daily } = await expectDailyMatches(`${Q}&search=Shop B`);
    // Faqat Shop B savdosi (DATE_B) qoladi; DATE_C dagi olmagan tashriflar ham chiqadi
    const dayB = daily.find((d) => d.date === DATE_B)!;
    const dayC = daily.find((d) => d.date === DATE_C)!;
    const dayD = daily.find((d) => d.date === DATE_D)!;
    expect(dayB.sales).toBe(1);
    expect(dayD.sales).toBe(0);
    expect(dayC.visits).toBe(0);
  });

  it("kombinatsiyalangan filtrlar (viloyat+tolovTuri) bilan ham kunlik bo'lim teng", async () => {
    // Toshkent + nasiya → faqat Shop A ning DATE_D savdosi
    const { daily } = await expectDailyMatches(`${Q}&viloyat=Toshkent&tolovTuri=nasiya`);
    const dayD = daily.find((d) => d.date === DATE_D)!;
    expect(dayD.sales).toBe(1);
    expect(dayD.salesTotal).toBe(200000);
    expect(daily.reduce((s, d) => s + d.sales, 0)).toBe(1);
  });

  it("per-agent qatorlar yig'indisi analytics KPI'ga mos (savdo soni/summasi, sold, nasiya)", async () => {
    const [{ raw }, analytics] = await Promise.all([
      getCsv(`/distribution/analytics/export?${Q}`),
      getJson(`/distribution/analytics?${Q}`),
    ]);
    const p = parseCsvSections(raw);
    expect(p.agents.length).toBe(2); // Agent Alpha, Agent Beta
    const sum = (fn: (a: (typeof p.agents)[number]) => number) => p.agents.reduce((s, a) => s + fn(a), 0);
    expect(sum((a) => a.salesCount)).toBe(analytics.kpi.salesCount);
    expect(sum((a) => a.salesTotal)).toBe(analytics.kpi.salesTotal);
    // Fixture'da har do'kon bitta agentga tegishli — sold/visited yig'indisi aggregate bilan teng
    expect(sum((a) => a.sold)).toBe(analytics.kpi.soldShops);
    expect(sum((a) => a.visited)).toBe(analytics.kpi.visitedShops);
  });

  it("per-agent konversiya/takroriy/nasiya foizlari aggregate formulaga mos", async () => {
    // Bitta agentga filtrlangan analytics KPI == shu agentning eksport qatori
    for (const agentId of ["8001", "8002"] as const) {
      const q = `${Q}&agentId=${agentId}`;
      const [{ raw: allCsv }, analytics] = await Promise.all([
        getCsv(`/distribution/analytics/export?${Q}`),
        getJson(`/distribution/analytics?${q}`),
      ]);
      const p = parseCsvSections(allCsv);
      const name = agentId === "8001" ? "Agent Alpha" : "Agent Beta";
      const row = p.agents.find((a) => a.name === name);
      expect(row).toBeDefined();
      // Foizlar: analytics null → CSV bo'sh katak, aks holda bir xil butun son
      const pctEq = (csvVal: string, apiVal: number | null) => {
        if (apiVal === null) expect(csvVal).toBe("");
        else expect(Number(csvVal)).toBe(apiVal);
      };
      pctEq(row!.conv, analytics.kpi.conversionPct);
      pctEq(row!.rep, analytics.kpi.repeatPct);
      pctEq(row!.nas, analytics.kpi.nasiyaPct);
      // Mutlaq qiymatlar ham mos bo'lishi kerak
      expect(row!.visited).toBe(analytics.kpi.visitedShops);
      expect(row!.sold).toBe(analytics.kpi.soldShops);
      expect(row!.salesCount).toBe(analytics.kpi.salesCount);
      expect(row!.salesTotal).toBe(analytics.kpi.salesTotal);
    }
  });

  it("faqat olmagan tashrifi bor agent ham eksportda ko'rinadi (0 savdo, bo'sh foizlar to'g'ri)", async () => {
    // DATE_C..DATE_C oralig'ida faqat olmagan tashriflar bor (agent 8001)
    const q = `from=${DATE_C}&to=${DATE_C}`;
    const [{ raw }, analytics] = await Promise.all([
      getCsv(`/distribution/analytics/export?${q}`),
      getJson(`/distribution/analytics?${q}`),
    ]);
    const p = parseCsvSections(raw);
    const alpha = p.agents.find((a) => a.name === "Agent Alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.sold).toBe(0);
    expect(alpha!.salesCount).toBe(0);
    expect(alpha!.visited).toBe(analytics.kpi.visitedShops);
    // sold=0 → konversiya 0, repeat/nasiya bo'sh (analytics'da null)
    expect(Number(alpha!.conv)).toBe(analytics.kpi.conversionPct);
    expect(alpha!.rep).toBe("");
    expect(analytics.kpi.repeatPct).toBeNull();
    expect(alpha!.nas).toBe("");
    expect(analytics.kpi.nasiyaPct).toBeNull();
    // Kunlik bo'lim ham teng
    expect(p.daily).toEqual(
      analytics.daily.map((d: any) => ({
        date: d.date, visits: d.visits, sales: d.sales, salesTotal: d.salesTotal,
      }))
    );
  });
});

// ── /distribution/suggestions — x-internal-key auth devori ──────────────────
// Prod'da bu router requireAuthOrInternalKey ortida mount qilinadi
// (routes/index.ts). Bot x-internal-key yuboradi; dashboard Bearer session
// bilan kiradi. Quyidagi testlar devorning o'zini tekshiradi: to'g'ri kalit
// 200, kalitsiz/noto'g'ri kalit 401, server kaliti sozlanmagan bo'lsa —
// kalit yuborilsa ham 401 (bo'sh-kalit bypass yo'q).
describe("GET /distribution/suggestions — x-internal-key devori", () => {
  const TEST_KEY = `test-internal-key-${process.pid}-${Date.now()}`;
  let prevKey: string | undefined;
  let wallServer: Server;
  let wallUrl: string;

  beforeAll(async () => {
    prevKey = process.env.AI_INTERNAL_KEY;
    process.env.AI_INTERNAL_KEY = TEST_KEY;
    const routerMod = await import("../src/routes/distribution");
    const { requireAuthOrInternalKey } = await import(
      "../src/middleware/requireAuthOrInternalKey"
    );
    const app: Express = express();
    app.use(express.json());
    // routes/index.ts dagi mount tartibi bilan bir xil
    app.use(requireAuthOrInternalKey, routerMod.distributionSuggestionsRouter);
    await new Promise<void>((resolve) => {
      wallServer = app.listen(0, "127.0.0.1", resolve);
    });
    wallUrl = `http://127.0.0.1:${(wallServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (prevKey === undefined) delete process.env.AI_INTERNAL_KEY;
    else process.env.AI_INTERNAL_KEY = prevKey;
    if (wallServer) await new Promise<void>((r) => wallServer.close(() => r()));
  });

  it("to'g'ri x-internal-key bilan 200 va rule-based maydonlar qaytadi", async () => {
    // ai=1 YUBORILMAYDI — testda LLM chaqiruvi bo'lmasligi kerak; devor uchun
    // rule-based javobning o'zi yetarli.
    const r = await fetch(`${wallUrl}/distribution/suggestions`, {
      headers: { "x-internal-key": TEST_KEY },
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.overdue)).toBe(true);
    expect(Array.isArray(body.qaytish)).toBe(true);
    expect(typeof body.date).toBe("string");
  });

  it("kalitsiz so'rov 401 qaytaradi", async () => {
    const r = await fetch(`${wallUrl}/distribution/suggestions`);
    expect(r.status).toBe(401);
  });

  it("noto'g'ri kalit 401 qaytaradi", async () => {
    const r = await fetch(`${wallUrl}/distribution/suggestions`, {
      headers: { "x-internal-key": `${TEST_KEY}-wrong` },
    });
    expect(r.status).toBe(401);
  });

  it("server kaliti sozlanmagan bo'lsa — kalit yuborilsa ham 401 (bypass yo'q)", async () => {
    delete process.env.AI_INTERNAL_KEY;
    try {
      const empty = await fetch(`${wallUrl}/distribution/suggestions`, {
        headers: { "x-internal-key": "" },
      });
      expect(empty.status).toBe(401);
      const any = await fetch(`${wallUrl}/distribution/suggestions`, {
        headers: { "x-internal-key": "har-qanday-kalit" },
      });
      expect(any.status).toBe(401);
    } finally {
      process.env.AI_INTERNAL_KEY = TEST_KEY;
    }
  });
});
