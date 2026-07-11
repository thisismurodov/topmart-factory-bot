import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { performFieldSale } from "../src/routes/field";

// ─────────────────────────────────────────────────────────────────────────────
// Field Assistant savdo tranzaksiyasi PARITY testi.
//
// /api/field/visits/sale — distribution botning create_sale (sales.py) +
// update_dokon_repeat (customers.py) tranzaksiyasining TypeScript porti.
// Bu test ikkala implementatsiyani BIR XIL throwaway bazada, BIR XIL
// ma'lumotlar bilan yuritadi (bot → dokon A, API port → dokon B) va natijaviy
// qatorlarni solishtiradi:
//   savdolar, savdo_tafsilot, revisitlar (supersede + yangi pending),
//   nasiya, dokonlar stats (total/repeat_orders, avg_repeat_days incremental
//   average, first/last_order_date, total_sales).
// Shuningdek field_ops idempotentligini tekshiradi (takror clientOpId →
// duplikat yozuv YO'Q).
//
// Throwaway DB nomi pid+timestamp bilan unikal (parallel validation'lar
// bir-birining bazasini o'chirib yubormasligi uchun).
// ─────────────────────────────────────────────────────────────────────────────

const { Client, Pool } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

const TMP_DB = `topmart_field_parity_${process.pid}_${Date.now()}`;
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

const AGENT_TG = 777000111;

let client: pg.Client;
let testPool: pg.Pool;
let dokonA = 0; // bot savdo qiladi
let dokonB = 0; // API port savdo qiladi
let p1 = 0;
let p2 = 0;

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

/** Bot yadrosidagi create_sale'ni throwaway bazada ishga tushiradi (telebot importsiz). */
function botCreateSale(
  dokonId: number,
  items: [number, number, number][],
  jami: number,
  tolov: string,
  nasiyaSumma: number,
): void {
  const py = `
import json, sys
from database.sales import create_sale
args = json.loads(sys.argv[1])
create_sale(args["dokon_id"], args["agent_id"], [tuple(i) for i in args["items"]],
            args["jami"], args["tolov"], None, args["nasiya"])
`;
  execFileSync(
    "python3",
    ["-c", py, JSON.stringify({ dokon_id: dokonId, agent_id: AGENT_TG, items, jami, tolov, nasiya: nasiyaSumma })],
    { cwd: botDir, env: botEnv, stdio: "pipe" },
  );
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

  // performFieldSale schema-qualified SQL ishlatadi — pool search_path shart emas
  testPool = new Pool({ connectionString: tmpUrl(), ssl, max: 2 });

  // Seed: 2 mahsulot, 2 bir xil dokon, 1 delivery agent
  const prod1 = await client.query(
    `INSERT INTO mahsulotlar (nomi, narx, birlik, faol) VALUES ('Parity arqon 5mm', 12000, 'dona', 1) RETURNING id`,
  );
  const prod2 = await client.query(
    `INSERT INTO mahsulotlar (nomi, narx, birlik, faol) VALUES ('Parity arqon 8mm', 8500, 'dona', 1) RETURNING id`,
  );
  p1 = Number(prod1.rows[0].id);
  p2 = Number(prod2.rows[0].id);
  const dA = await client.query(
    `INSERT INTO dokonlar (nomi, egasi, telefon, viloyat, hudud, agent_id, holat, created_at)
     VALUES ('PARITY DOKON A', 'Test', '', 'Namangan', 'Test tuman', $1, 'faol', '2026-01-01T09:00:00') RETURNING id`,
    [AGENT_TG],
  );
  const dB = await client.query(
    `INSERT INTO dokonlar (nomi, egasi, telefon, viloyat, hudud, agent_id, holat, created_at)
     VALUES ('PARITY DOKON B', 'Test', '', 'Namangan', 'Test tuman', $1, 'faol', '2026-01-01T09:00:00') RETURNING id`,
    [AGENT_TG],
  );
  dokonA = Number(dA.rows[0].id);
  dokonB = Number(dB.rows[0].id);
  await client.query(
    `INSERT INTO delivery_agents (name, telefon, hudud, telegram_id, faol, created_at)
     VALUES ('Parity Agent', '+998900000000', 'Test tuman', $1, 1, '2026-01-01T09:00:00')`,
    [AGENT_TG],
  );
  // Har ikkala dokonga oldindan pending revisit — supersede yo'lini ham tekshiramiz
  for (const did of [dokonA, dokonB]) {
    await client.query(
      `INSERT INTO revisitlar (dokon_id, agent_id, last_order_date, revisit_date, status, created_at)
       VALUES ($1,$2,'2026-06-30','2026-07-07','pending','2026-06-30T10:00:00')`,
      [did, AGENT_TG],
    );
  }
}, 120_000);

afterAll(async () => {
  if (testPool) await testPool.end();
  if (client) await client.end();
  await dropTmpDb();
}, 60_000);

type DokonStats = {
  total_orders: number;
  repeat_orders: number;
  avg_repeat_days: number;
  total_sales: number;
  first_order_date: string | null;
  last_order_date: string | null;
};

async function dokonStats(id: number): Promise<DokonStats> {
  const { rows } = await client.query(
    `SELECT total_orders, repeat_orders, avg_repeat_days, total_sales, first_order_date, last_order_date
       FROM dokonlar WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  return {
    total_orders: Number(r.total_orders),
    repeat_orders: Number(r.repeat_orders),
    avg_repeat_days: Number(r.avg_repeat_days),
    total_sales: Number(r.total_sales),
    first_order_date: r.first_order_date,
    last_order_date: r.last_order_date,
  };
}

async function apiSale(
  clientOpId: string,
  dokonId: number,
  items: { mahsulotId: number; miqdor: number }[],
  tolovTuri: "naqd" | "karta" | "nasiya" | "aralash",
  nasiyaQism?: number,
) {
  const c = await testPool.connect();
  try {
    return await performFieldSale(c, AGENT_TG, { clientOpId, dokonId, items, tolovTuri, nasiyaQism });
  } finally {
    c.release();
  }
}

const JAMI_1 = 3 * 12000 + 2 * 8500; // 53000
const OP_1 = "parity-op-sale-1";

describe("Field sale port ↔ bot create_sale parity (birinchi savdo, nasiya)", () => {
  beforeAll(async () => {
    botCreateSale(dokonA, [[p1, 3, 12000], [p2, 2, 8500]], JAMI_1, "nasiya", JAMI_1);
    const r = await apiSale(OP_1, dokonB, [{ mahsulotId: p1, miqdor: 3 }, { mahsulotId: p2, miqdor: 2 }], "nasiya");
    expect(r.kind).toBe("ok");
  }, 60_000);

  it("savdolar qatori bir xil (jami_summa, tolov_turi, agent)", async () => {
    const { rows } = await client.query(
      `SELECT dokon_id, agent_id, jami_summa, tolov_turi, created_at FROM savdolar ORDER BY id`,
    );
    expect(rows.length).toBe(2);
    const [a, b] = rows;
    expect(Number(a.jami_summa)).toBe(JAMI_1);
    expect(Number(b.jami_summa)).toBe(JAMI_1);
    expect(a.tolov_turi).toBe("nasiya");
    expect(b.tolov_turi).toBe("nasiya");
    expect(Number(a.agent_id)).toBe(AGENT_TG);
    expect(Number(b.agent_id)).toBe(AGENT_TG);
    // API yozgan created_at — TEXT local-ISO (substr filtrlariga mos)
    expect(String(b.created_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("savdo_tafsilot qatorlari bir xil (miqdor, narx, summa)", async () => {
    const linesOf = async (did: number) => {
      const { rows } = await client.query(
        `SELECT st.mahsulot_id, st.miqdor, st.narx, st.summa
           FROM savdo_tafsilot st JOIN savdolar s ON s.id = st.savdo_id
          WHERE s.dokon_id = $1 ORDER BY st.mahsulot_id`,
        [did],
      );
      return rows.map((r) => [Number(r.mahsulot_id), Number(r.miqdor), Number(r.narx), Number(r.summa)]);
    };
    const a = await linesOf(dokonA);
    const b = await linesOf(dokonB);
    expect(a.length).toBe(2);
    // mahsulot_id'lar boshqa dokonda ham bir xil — to'g'ridan-to'g'ri solishtiramiz
    expect(b).toEqual(a);
  });

  it("revisitlar: eski pending superseded, bitta yangi pending (~7 kun)", async () => {
    for (const did of [dokonA, dokonB]) {
      const { rows } = await client.query(
        `SELECT status, revisit_date FROM revisitlar WHERE dokon_id = $1 ORDER BY id`,
        [did],
      );
      expect(rows.map((r) => r.status)).toEqual(["superseded", "pending"]);
      const rd = Date.parse(rows[1].revisit_date);
      const diffDays = (rd - Date.now()) / 86400000;
      // bot: server-lokal sana+7; API: Tashkent sana+7 — 1 kun ichida farq normal
      expect(diffDays).toBeGreaterThan(5.5);
      expect(diffDays).toBeLessThan(8.5);
    }
  });

  it("nasiya qatori bir xil (jami, tolangan=0, qoldiq)", async () => {
    for (const did of [dokonA, dokonB]) {
      const { rows } = await client.query(
        `SELECT jami_summa, tolangan, qoldiq FROM nasiya WHERE dokon_id = $1`,
        [did],
      );
      expect(rows.length).toBe(1);
      expect(Number(rows[0].jami_summa)).toBe(JAMI_1);
      expect(Number(rows[0].tolangan)).toBe(0);
      expect(Number(rows[0].qoldiq)).toBe(JAMI_1);
    }
  });

  it("dokonlar stats birinchi savdodan keyin bir xil", async () => {
    const a = await dokonStats(dokonA);
    const b = await dokonStats(dokonB);
    for (const s of [a, b]) {
      expect(s.total_orders).toBe(1);
      expect(s.repeat_orders).toBe(0);
      expect(s.avg_repeat_days).toBe(0);
      expect(s.total_sales).toBe(JAMI_1);
      expect(s.first_order_date).toBeTruthy();
      expect(s.last_order_date).toBeTruthy();
    }
  });
});

const JAMI_2 = 2 * 12000; // 24000
const OP_2 = "parity-op-sale-2";

describe("Ikkinchi savdo: incremental average parity", () => {
  beforeAll(async () => {
    // Ikkala dokonning last_order_date'ini AYNAN bir xil 3 kun oldingi
    // local-ISO qiymatga qo'yamiz — days hisobi deterministik bo'ladi.
    const back = new Date(Date.now() - 3 * 86400000 - 60000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const iso = `${back.getFullYear()}-${pad(back.getMonth() + 1)}-${pad(back.getDate())}T${pad(back.getHours())}:${pad(back.getMinutes())}:${pad(back.getSeconds())}`;
    await client.query(`UPDATE dokonlar SET last_order_date = $1 WHERE id = ANY($2)`, [
      iso,
      [dokonA, dokonB],
    ]);
    botCreateSale(dokonA, [[p1, 2, 12000]], JAMI_2, "naqd", 0);
    const r = await apiSale(OP_2, dokonB, [{ mahsulotId: p1, miqdor: 2 }], "naqd");
    expect(r.kind).toBe("ok");
  }, 60_000);

  it("repeat stats bir xil: total=2, repeat=1, avg=3 kun", async () => {
    const a = await dokonStats(dokonA);
    const b = await dokonStats(dokonB);
    expect(a.total_orders).toBe(2);
    expect(b.total_orders).toBe(2);
    expect(a.repeat_orders).toBe(1);
    expect(b.repeat_orders).toBe(1);
    expect(a.avg_repeat_days).toBe(3);
    expect(b.avg_repeat_days).toBe(3);
    expect(a.total_sales).toBe(JAMI_1 + JAMI_2);
    expect(b.total_sales).toBe(JAMI_1 + JAMI_2);
  });

  it("naqd savdoda yangi nasiya qatori YO'Q", async () => {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM nasiya WHERE dokon_id = ANY($1)`,
      [[dokonA, dokonB]],
    );
    expect(Number(rows[0].n)).toBe(2); // faqat 1-savdodagi ikkitasi
  });

  it("revisit supersede ketma-ketligi ikkinchi savdoda ham ishlaydi", async () => {
    for (const did of [dokonA, dokonB]) {
      const { rows } = await client.query(
        `SELECT status FROM revisitlar WHERE dokon_id = $1 ORDER BY id`,
        [did],
      );
      expect(rows.map((r) => r.status)).toEqual(["superseded", "superseded", "pending"]);
    }
  });
});

describe("Idempotentlik (field_ops)", () => {
  it("takror clientOpId → duplicate, yangi qator yozilmaydi", async () => {
    const before = await client.query(`SELECT COUNT(*)::int AS n FROM savdolar`);
    const r = await apiSale(OP_2, dokonB, [{ mahsulotId: p1, miqdor: 2 }], "naqd");
    expect(r.kind).toBe("duplicate");
    const after = await client.query(`SELECT COUNT(*)::int AS n FROM savdolar`);
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n));
    const stats = await dokonStats(dokonB);
    expect(stats.total_orders).toBe(2); // stats ham o'zgarmagan
  });

  it("field_ops jadvali bot init_db()'dan keyin mavjud va UNIQUE ishlaydi", async () => {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='distribution' AND table_name='field_ops' ORDER BY ordinal_position`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "id", "client_op_id", "agent_id", "op_type", "dokon_id", "result_id", "created_at",
    ]);
    await expect(
      client.query(
        `INSERT INTO field_ops (client_op_id, agent_id, op_type, dokon_id, result_id, created_at)
         VALUES ($1,$2,'sale',$3,NULL,'2026-07-11T10:00:00')`,
        [OP_2, AGENT_TG, dokonB],
      ),
    ).rejects.toThrow();
  });

  it("aralash to'lovda nasiya qismi validatsiyasi", async () => {
    const bad = await apiSale("parity-op-bad-mix", dokonB, [{ mahsulotId: p1, miqdor: 1 }], "aralash", 0);
    expect(bad.kind).toBe("invalid");
    const ok = await apiSale("parity-op-mix-1", dokonB, [{ mahsulotId: p1, miqdor: 1 }], "aralash", 5000);
    expect(ok.kind).toBe("ok");
    if (ok.kind === "ok") {
      expect(ok.nasiyaSumma).toBe(5000);
      const { rows } = await client.query(
        `SELECT qoldiq FROM nasiya WHERE savdo_id = $1`,
        [ok.savdoId],
      );
      expect(Number(rows[0].qoldiq)).toBe(5000);
    }
  });
});
