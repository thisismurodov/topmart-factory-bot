import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { performFieldSale, performFieldPayment, performFieldNoSale } from "../src/routes/field";

// ─────────────────────────────────────────────────────────────────────────────
// POST /field/ops — idempotentlik testi (field_ops.client_op_id UNIQUE)
//
// Bir xil clientOpId ikki marta yuborilsa:
//   performFieldSale   → { kind: 'duplicate' }
//   performFieldPayment → { kind: 'duplicate' }
// Yangi qator yozilmaydi, stats ham o'zgarmaydi.
//
// Throwaway DB nomi pid+timestamp bilan unikal.
// ─────────────────────────────────────────────────────────────────────────────

const { Client, Pool } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

const TMP_DB = `topmart_field_idem_${process.pid}_${Date.now()}`;
const ssl = { rejectUnauthorized: false } as const;

function tmpUrl(): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${TMP_DB}`;
  return u.toString();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const botDir = path.resolve(here, "../../distribution-bot");
const botEnv = { ...process.env, RAILWAY_DATABASE_URL: tmpUrl(), DATABASE_URL: tmpUrl() };

const AGENT_TG = 777_555_111;

let client: pg.Client;
let testPool: pg.Pool;
let dokonId = 0;
let prodId = 0;

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
  execFileSync("python3", ["-c", "from database.connection import init_db; init_db()"], {
    cwd: botDir,
    env: botEnv,
    stdio: "pipe",
  });

  client = new Client({ connectionString: tmpUrl(), ssl });
  await client.connect();
  await client.query(`SET search_path TO distribution, public`);

  testPool = new Pool({ connectionString: tmpUrl(), ssl, max: 2 });

  // Minimal seed: 1 mahsulot, 1 dokon, 1 agent
  const prod = await client.query(
    `INSERT INTO mahsulotlar (nomi, narx, birlik, faol) VALUES ('Idem arqon', 5000, 'dona', 1) RETURNING id`,
  );
  prodId = Number(prod.rows[0].id);

  const dokon = await client.query(
    `INSERT INTO dokonlar (nomi, egasi, telefon, viloyat, hudud, agent_id, holat, created_at)
     VALUES ('IDEM DOKON', 'Test', '', 'Namangan', 'Test tuman', $1, 'faol', '2026-01-01T09:00:00') RETURNING id`,
    [AGENT_TG],
  );
  dokonId = Number(dokon.rows[0].id);

  await client.query(
    `INSERT INTO delivery_agents (name, telefon, hudud, telegram_id, faol, created_at)
     VALUES ('Idem Agent', '+998900000001', 'Test tuman', $1, 1, '2026-01-01T09:00:00')`,
    [AGENT_TG],
  );
}, 120_000);

afterAll(async () => {
  if (testPool) await testPool.end();
  if (client) await client.end();
  await dropTmpDb();
}, 60_000);

async function sale(clientOpId: string, tolovTuri: "naqd" | "nasiya" = "naqd") {
  const c = await testPool.connect();
  try {
    return await performFieldSale(c, AGENT_TG, {
      clientOpId,
      dokonId,
      tolovTuri,
      items: [{ mahsulotId: prodId, miqdor: 1 }],
    });
  } finally {
    c.release();
  }
}

async function payment(clientOpId: string, summa: number) {
  const c = await testPool.connect();
  try {
    return await performFieldPayment(c, AGENT_TG, {
      clientOpId,
      dokonId,
      summa,
      nasiyagaHisoblash: false,
    });
  } finally {
    c.release();
  }
}

describe("field_ops idempotentlik — bir xil clientOpId ikki marta", () => {
  const OP_SALE = "idem-sale-op-1";

  it("birinchi savdo muvaffaqiyatli saqlandi", async () => {
    const r = await sale(OP_SALE);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.jami).toBe(5000);
    }
  });

  it("takror savdo → duplicate:true, yangi savdo qatori yo'q", async () => {
    const beforeCount = await client.query(`SELECT COUNT(*)::int AS n FROM savdolar`);
    const r = await sale(OP_SALE);
    expect(r.kind).toBe("duplicate");
    const afterCount = await client.query(`SELECT COUNT(*)::int AS n FROM savdolar`);
    expect(Number(afterCount.rows[0].n)).toBe(Number(beforeCount.rows[0].n));
  });

  it("takror savdo → dokon stats o'zgarmaydi", async () => {
    // Birinchi savdo: total_orders=1. Takror keyin ham 1 bo'lishi kerak.
    const { rows } = await client.query(`SELECT total_orders FROM dokonlar WHERE id = $1`, [dokonId]);
    expect(Number(rows[0].total_orders)).toBe(1);
  });

  it("field_ops jadvali faqat bitta qator saqlagan", async () => {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM field_ops WHERE client_op_id = $1`,
      [OP_SALE],
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});

describe("field_ops idempotentlik — to'lov (performFieldPayment)", () => {
  const OP_NASIYA_SALE = "idem-nasiya-sale-1";
  const OP_PAYMENT = "idem-payment-op-1";

  beforeAll(async () => {
    // Nasiya savdo — to'lov test uchun qoldiq yaratamiz
    const r = await sale(OP_NASIYA_SALE, "nasiya");
    expect(r.kind).toBe("ok");
  });

  it("birinchi to'lov muvaffaqiyatli amalga oshdi", async () => {
    const r = await payment(OP_PAYMENT, 2000);
    expect(r.kind).toBe("ok");
  });

  it("takror to'lov → duplicate:true, yangi pul_olish qatori yo'q", async () => {
    const beforeCount = await client.query(`SELECT COUNT(*)::int AS n FROM pul_olish`);
    const r = await payment(OP_PAYMENT, 2000);
    expect(r.kind).toBe("duplicate");
    const afterCount = await client.query(`SELECT COUNT(*)::int AS n FROM pul_olish`);
    expect(Number(afterCount.rows[0].n)).toBe(Number(beforeCount.rows[0].n));
  });

  it("to'lov field_ops jadvali faqat bitta qator saqlagan", async () => {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM field_ops WHERE client_op_id = $1`,
      [OP_PAYMENT],
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});

async function noSale(clientOpId: string) {
  const c = await testPool.connect();
  try {
    return await performFieldNoSale(c, AGENT_TG, {
      clientOpId,
      dokonId,
      sabab: "egasi_yoq",
    });
  } finally {
    c.release();
  }
}

describe("field_ops idempotentlik — olinmadi (performFieldNoSale)", () => {
  const OP_NOSALE = "idem-nosale-op-1";

  it("birinchi olinmadi yozuvi muvaffaqiyatli saqlandi", async () => {
    const r = await noSale(OP_NOSALE);
    expect(r.kind).toBe("ok");
  });

  it("takror olinmadi → duplicate, olmagan_dokonlar soni 1 da qoladi", async () => {
    const r = await noSale(OP_NOSALE);
    expect(r.kind).toBe("duplicate");
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM olmagan_dokonlar WHERE dokon_id = $1 AND agent_id = $2`,
      [dokonId, AGENT_TG],
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it("duplicate javob birinchi yozuv id'sini qaytaradi", async () => {
    const first = await client.query(
      `SELECT result_id FROM field_ops WHERE client_op_id = $1`,
      [OP_NOSALE],
    );
    const r = await noSale(OP_NOSALE);
    expect(r.kind).toBe("duplicate");
    if (r.kind === "duplicate") {
      expect(r.id).toBe(Number(first.rows[0].result_id));
    }
  });

  it("olinmadi field_ops jadvali faqat bitta qator saqlagan", async () => {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM field_ops WHERE client_op_id = $1`,
      [OP_NOSALE],
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});

describe("turli clientOpId'lar mustaqil operatsiyalar", () => {
  it("ikkita boshqa clientOpId — ikkita alohida savdo yoziladi", async () => {
    const r1 = await sale("idem-uniq-a");
    const r2 = await sale("idem-uniq-b");
    expect(r1.kind).toBe("ok");
    expect(r2.kind).toBe("ok");
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM field_ops WHERE client_op_id = ANY($1)`,
      [["idem-uniq-a", "idem-uniq-b"]],
    );
    expect(Number(rows[0].n)).toBe(2);
  });
});
