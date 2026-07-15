import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { performFieldPayment, computeShopRating, daysSinceIso } from "../src/routes/field";

// ─────────────────────────────────────────────────────────────────────────────
// Field Assistant PUL OLISH (payment) PARITY testi.
//
// /api/field/visits/payment — distribution botning pay_nasiya_fifo
// (payments.py) + update_balans_delta (customers.py) tranzaksiyasining
// TypeScript porti. Bot → dokon A, API port → dokon B; bir xil nasiya
// to'plamiga bir xil to'lovlar qo'llanadi va natijalar solishtiriladi:
//   nasiya (tolangan/qoldiq FIFO tartibida), pul_olish, mijoz_balans
//   (ortiqcha to'lov balansga upsert).
// Shuningdek field_ops idempotentligi (takror clientOpId → duplikat yo'q)
// va computeShopRating/daysSinceIso sof funksiyalari tekshiriladi.
//
// Throwaway DB nomi pid+timestamp bilan unikal (parallel validation'lar
// bir-birining bazasini o'chirib yubormasligi uchun).
// ─────────────────────────────────────────────────────────────────────────────

const { Client, Pool } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

const TMP_DB = `topmart_field_payment_${process.pid}_${Date.now()}`;
const ssl = { rejectUnauthorized: false } as const;

function tmpUrl(): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${TMP_DB}`;
  return u.toString();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const botDir = path.resolve(here, "../../distribution-bot");

const botEnv = {
  ...process.env,
  RAILWAY_DATABASE_URL: tmpUrl(),
  DATABASE_URL: tmpUrl(),
};

const AGENT_TG = 777000222;

let client: pg.Client;
let testPool: pg.Pool;
let dokonA = 0; // bot to'laydi
let dokonB = 0; // API port to'laydi

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

/** Bot yadrosidagi pay_nasiya_fifo'ni throwaway bazada ishga tushiradi. */
function botPayNasiya(
  dokonId: number,
  summa: number,
  applyAmount: number | null,
  ortiqcha: number,
): void {
  const py = `
import json, sys
from database.payments import pay_nasiya_fifo
args = json.loads(sys.argv[1])
pay_nasiya_fifo(args["dokon_id"], args["agent_id"], args["summa"],
                apply_amount=args["apply_amount"], ortiqcha=args["ortiqcha"])
`;
  execFileSync(
    "python3",
    [
      "-c",
      py,
      JSON.stringify({
        dokon_id: dokonId,
        agent_id: AGENT_TG,
        summa,
        apply_amount: applyAmount,
        ortiqcha,
      }),
    ],
    { cwd: botDir, env: botEnv, stdio: "pipe" },
  );
}

async function apiPayment(
  clientOpId: string,
  dokonId: number,
  summa: number,
  nasiyagaHisoblash = true,
) {
  const c = await testPool.connect();
  try {
    return await performFieldPayment(c, AGENT_TG, {
      clientOpId,
      dokonId,
      summa,
      nasiyagaHisoblash,
    });
  } finally {
    c.release();
  }
}

// Har dokon uchun bir xil nasiya to'plami: 30k (eski) + 50k (yangi) = 80k qarz
async function seedNasiya(did: number): Promise<void> {
  await client.query(
    `INSERT INTO nasiya (dokon_id, agent_id, savdo_id, jami_summa, tolangan, qoldiq, created_at, updated_at)
     VALUES ($1,$2,NULL,30000,0,30000,'2026-07-01T10:00:00','2026-07-01T10:00:00')`,
    [did, AGENT_TG],
  );
  await client.query(
    `INSERT INTO nasiya (dokon_id, agent_id, savdo_id, jami_summa, tolangan, qoldiq, created_at, updated_at)
     VALUES ($1,$2,NULL,50000,0,50000,'2026-07-05T10:00:00','2026-07-05T10:00:00')`,
    [did, AGENT_TG],
  );
}

type NasiyaRow = { jami: number; tolangan: number; qoldiq: number };

async function nasiyaRows(did: number): Promise<NasiyaRow[]> {
  const { rows } = await client.query(
    `SELECT jami_summa, tolangan, qoldiq FROM nasiya WHERE dokon_id = $1 ORDER BY created_at`,
    [did],
  );
  return rows.map((r) => ({
    jami: Number(r.jami_summa),
    tolangan: Number(r.tolangan),
    qoldiq: Number(r.qoldiq),
  }));
}

async function pulOlishSummalar(did: number): Promise<number[]> {
  const { rows } = await client.query(
    `SELECT summa FROM pul_olish WHERE dokon_id = $1 ORDER BY id`,
    [did],
  );
  return rows.map((r) => Number(r.summa));
}

async function balansOf(did: number): Promise<number> {
  const { rows } = await client.query(
    `SELECT balans FROM mijoz_balans WHERE dokon_id = $1`,
    [did],
  );
  return rows.length > 0 ? Number(rows[0].balans) : 0;
}

beforeAll(async () => {
  await dropTmpDb();
  {
    const admin = new Client({ connectionString: adminUrl, ssl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${TMP_DB}`);
    await admin.end();
  }
  // Sxemani faqat botning haqiqiy init kodi bilan ko'taramiz
  execFileSync("python3", ["-c", "from database.connection import init_db; init_db()"], {
    cwd: botDir,
    env: botEnv,
    stdio: "pipe",
  });

  client = new Client({ connectionString: tmpUrl(), ssl });
  await client.connect();
  await client.query(`SET search_path TO distribution, public`);

  testPool = new Pool({ connectionString: tmpUrl(), ssl, max: 2 });

  const dA = await client.query(
    `INSERT INTO dokonlar (nomi, egasi, telefon, viloyat, hudud, agent_id, holat, created_at)
     VALUES ('PAYMENT DOKON A', 'Test', '', 'Namangan', 'Test tuman', $1, 'faol', '2026-01-01T09:00:00') RETURNING id`,
    [AGENT_TG],
  );
  const dB = await client.query(
    `INSERT INTO dokonlar (nomi, egasi, telefon, viloyat, hudud, agent_id, holat, created_at)
     VALUES ('PAYMENT DOKON B', 'Test', '', 'Namangan', 'Test tuman', $1, 'faol', '2026-01-01T09:00:00') RETURNING id`,
    [AGENT_TG],
  );
  dokonA = Number(dA.rows[0].id);
  dokonB = Number(dB.rows[0].id);
  await seedNasiya(dokonA);
  await seedNasiya(dokonB);
}, 120_000);

afterAll(async () => {
  if (testPool) await testPool.end();
  if (client) await client.end();
  await dropTmpDb();
}, 60_000);

describe("Qisman to'lov: FIFO eng eski nasiyadan yopiladi", () => {
  beforeAll(async () => {
    // 45k to'lov: 30k (eski, to'liq) + 15k (yangi, qisman)
    botPayNasiya(dokonA, 45000, null, 0);
    const r = await apiPayment("payment-op-partial-1", dokonB, 45000);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.nasiyagaHisoblandi).toBe(45000);
      expect(r.ortiqcha).toBe(0);
      expect(r.yangiQoldiq).toBe(35000);
    }
  }, 60_000);

  it("nasiya qatorlari bot bilan bir xil (FIFO tartibi)", async () => {
    const a = await nasiyaRows(dokonA);
    const b = await nasiyaRows(dokonB);
    expect(a).toEqual([
      { jami: 30000, tolangan: 30000, qoldiq: 0 },
      { jami: 50000, tolangan: 15000, qoldiq: 35000 },
    ]);
    expect(b).toEqual(a);
  });

  it("pul_olish yozuvi bir xil (to'liq olingan summa)", async () => {
    expect(await pulOlishSummalar(dokonA)).toEqual([45000]);
    expect(await pulOlishSummalar(dokonB)).toEqual([45000]);
  });

  it("ortiqcha yo'q — mijoz_balans yaratilmaydi", async () => {
    expect(await balansOf(dokonA)).toBe(0);
    expect(await balansOf(dokonB)).toBe(0);
  });
});

describe("Ortiqcha to'lov: qoldiq yopiladi, farq balansga yoziladi", () => {
  beforeAll(async () => {
    // Qoldiq 35k, to'lov 50k → 35k nasiyaga, 15k balansga
    botPayNasiya(dokonA, 50000, 35000, 15000);
    const r = await apiPayment("payment-op-over-1", dokonB, 50000);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.nasiyagaHisoblandi).toBe(35000);
      expect(r.ortiqcha).toBe(15000);
      expect(r.yangiQoldiq).toBe(0);
    }
  }, 60_000);

  it("barcha nasiya yopilgan (bot bilan bir xil)", async () => {
    const a = await nasiyaRows(dokonA);
    const b = await nasiyaRows(dokonB);
    expect(a).toEqual([
      { jami: 30000, tolangan: 30000, qoldiq: 0 },
      { jami: 50000, tolangan: 50000, qoldiq: 0 },
    ]);
    expect(b).toEqual(a);
  });

  it("pul_olish'da to'liq summa, balansda ortiqcha", async () => {
    expect(await pulOlishSummalar(dokonA)).toEqual([45000, 50000]);
    expect(await pulOlishSummalar(dokonB)).toEqual([45000, 50000]);
    expect(await balansOf(dokonA)).toBe(15000);
    expect(await balansOf(dokonB)).toBe(15000);
  });
});

describe("Oddiy pul olish (nasiyaga hisoblanmaydi) va idempotentlik", () => {
  it("nasiyagaHisoblash=false — faqat pul_olish yoziladi", async () => {
    const r = await apiPayment("payment-op-plain-1", dokonB, 20000, false);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.nasiyagaHisoblandi).toBe(0);
      expect(r.ortiqcha).toBe(0);
    }
    expect(await pulOlishSummalar(dokonB)).toEqual([45000, 50000, 20000]);
    // Nasiya va balans o'zgarmagan
    expect(await balansOf(dokonB)).toBe(15000);
  });

  it("takror clientOpId → duplikat, yangi yozuv YO'Q", async () => {
    const r = await apiPayment("payment-op-plain-1", dokonB, 20000, false);
    expect(r.kind).toBe("duplicate");
    expect(await pulOlishSummalar(dokonB)).toEqual([45000, 50000, 20000]);
  });

  it("mavjud bo'lmagan do'kon → not_found", async () => {
    const r = await apiPayment("payment-op-missing-1", 99999999, 1000);
    expect(r.kind).toBe("not_found");
  });
});

describe("computeShopRating / daysSinceIso (sof funksiyalar)", () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent" }).format(
    new Date(),
  );

  it("yangi do'kon (0 buyurtma) → 1 yulduz", () => {
    expect(computeShopRating(0, 0, 0, null)).toBe(1);
  });

  it("3+ buyurtma → 2, 10+ → 3, 1M+ savdo → 4", () => {
    expect(computeShopRating(3, 0, 0, null)).toBe(2);
    expect(computeShopRating(10, 0, 0, null)).toBe(3);
    expect(computeShopRating(10, 1_000_000, 0, null)).toBe(4);
  });

  it("faol tsikl (oxirgi xarid ≤1.5×avg) → +1, maksimum 5", () => {
    expect(computeShopRating(10, 1_000_000, 7, `${today}T09:00:00`)).toBe(5);
  });

  it("tsikldan chiqib ketgan do'kon bonus olmaydi", () => {
    expect(computeShopRating(10, 1_000_000, 3, "2026-01-01T09:00:00")).toBe(4);
  });

  it("daysSinceIso: bugun → 0, buzuq sana → null", () => {
    expect(daysSinceIso(`${today}T12:00:00`)).toBe(0);
    expect(daysSinceIso("15.07.2026")).toBeNull();
    expect(daysSinceIso(null)).toBeNull();
    expect(daysSinceIso("")).toBeNull();
  });
});
