import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import {
  getFieldRouteOrder,
  upsertFieldRouteOrder,
  deleteFieldRouteOrder,
} from "../src/routes/field";

// ─────────────────────────────────────────────────────────────────────────────
// GET/PUT/DELETE /field/route/order — optimal tartib server nusxasi testi.
//
// field_route_orders jadvali: bir agent + bir sana = bitta yozuv (UNIQUE).
//   - upsert: birinchi PUT insert, ikkinchi PUT o'sha qatorni yangilaydi
//   - agentlar/sanalar bir-biridan izolyatsiyalangan
//   - delete: "Asl tartib" reset server nusxasini o'chiradi
//   - buzilgan JSON (qo'lda yozilgan) → null (crash yo'q)
//
// Throwaway DB nomi pid+timestamp bilan unikal (parallel validation'lar
// bir-birining bazasini o'chirib yubormasligi uchun).
// ─────────────────────────────────────────────────────────────────────────────

const { Client } = pg;

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

const TMP_DB = `topmart_field_order_${process.pid}_${Date.now()}`;
const ssl = { rejectUnauthorized: false } as const;

function tmpUrl(): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${TMP_DB}`;
  return u.toString();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const botDir = path.resolve(here, "../../distribution-bot");
const botEnv = { ...process.env, RAILWAY_DATABASE_URL: tmpUrl(), DATABASE_URL: tmpUrl() };

let client: pg.Client;

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
}, 120_000);

afterAll(async () => {
  if (client) await client.end();
  await dropTmpDb();
}, 60_000);

const SANA = "2026-08-12";
const NOW = "2026-08-12T09:00:00";
let seq = 1000;
const nextSeq = () => ++seq;

describe("field_route_orders saqlash/olish/o'chirish", () => {
  it("bo'sh holatda null qaytaradi", async () => {
    expect(await getFieldRouteOrder(client, 1, SANA)).toBeNull();
  });

  it("upsert: insert keyin update — bitta qator qoladi", async () => {
    expect(await upsertFieldRouteOrder(client, 1, SANA, [3, 1, 2], nextSeq(), NOW)).toBe(true);
    expect(await getFieldRouteOrder(client, 1, SANA)).toEqual([3, 1, 2]);

    expect(
      await upsertFieldRouteOrder(client, 1, SANA, [2, 3, 1], nextSeq(), "2026-08-12T10:00:00"),
    ).toBe(true);
    expect(await getFieldRouteOrder(client, 1, SANA)).toEqual([2, 3, 1]);

    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM distribution.field_route_orders
        WHERE delivery_agent_id = 1 AND sana = $1`,
      [SANA],
    );
    expect(rows[0].n).toBe(1);
  });

  it("agent va sana bo'yicha izolyatsiya", async () => {
    await upsertFieldRouteOrder(client, 2, SANA, [9, 8], nextSeq(), NOW);
    await upsertFieldRouteOrder(client, 1, "2026-08-13", [7], nextSeq(), NOW);

    expect(await getFieldRouteOrder(client, 1, SANA)).toEqual([2, 3, 1]);
    expect(await getFieldRouteOrder(client, 2, SANA)).toEqual([9, 8]);
    expect(await getFieldRouteOrder(client, 1, "2026-08-13")).toEqual([7]);
  });

  it("delete (tombstone) faqat o'sha agent+sana yozuviga ta'sir qiladi", async () => {
    expect(await deleteFieldRouteOrder(client, 1, SANA, nextSeq(), NOW)).toBe(true);
    expect(await getFieldRouteOrder(client, 1, SANA)).toBeNull();
    // Boshqa agent/sana yozuvlari joyida
    expect(await getFieldRouteOrder(client, 2, SANA)).toEqual([9, 8]);
    expect(await getFieldRouteOrder(client, 1, "2026-08-13")).toEqual([7]);
    // Takror reset xato emas (yangi opSeq bilan qo'llanadi)
    expect(await deleteFieldRouteOrder(client, 1, SANA, nextSeq(), NOW)).toBe(true);
  });

  it("kechikkan eski PUT yangi reset'ni qayta tiriltirmaydi (server tomonda)", async () => {
    const oldSeq = nextSeq(); // PUT ketdi, lekin tarmoqda kechikdi
    const newSeq = nextSeq(); // reset undan keyin bosildi
    // Reset (tombstone) avval yetib keladi
    expect(await deleteFieldRouteOrder(client, 3, SANA, newSeq, NOW)).toBe(true);
    // Eski PUT kech yetib keladi — RAD ETILADI
    expect(await upsertFieldRouteOrder(client, 3, SANA, [1, 2, 3], oldSeq, NOW)).toBe(false);
    expect(await getFieldRouteOrder(client, 3, SANA)).toBeNull(); // tombstone qoladi
  });

  it("kechikkan eski PUT yangiroq saqlashni ham ustidan yozmaydi", async () => {
    const oldSeq = nextSeq();
    const newSeq = nextSeq();
    expect(await upsertFieldRouteOrder(client, 4, SANA, [9, 9, 9].map((_, i) => i + 10), newSeq, NOW)).toBe(true);
    expect(await upsertFieldRouteOrder(client, 4, SANA, [1, 2], oldSeq, NOW)).toBe(false);
    expect(await getFieldRouteOrder(client, 4, SANA)).toEqual([10, 11, 12]);
    // Teng opSeq ham rad etiladi (qat'iy katta bo'lishi shart)
    expect(await upsertFieldRouteOrder(client, 4, SANA, [5], newSeq, NOW)).toBe(false);
  });

  it("kechikkan eski DELETE yangiroq saqlashni o'chirmaydi", async () => {
    const oldSeq = nextSeq();
    const newSeq = nextSeq();
    expect(await upsertFieldRouteOrder(client, 6, SANA, [4, 5], newSeq, NOW)).toBe(true);
    expect(await deleteFieldRouteOrder(client, 6, SANA, oldSeq, NOW)).toBe(false);
    expect(await getFieldRouteOrder(client, 6, SANA)).toEqual([4, 5]);
  });

  it("buzilgan JSON → null (crash yo'q)", async () => {
    await client.query(
      `INSERT INTO distribution.field_route_orders (delivery_agent_id, sana, dokon_ids, updated_at)
       VALUES (5, $1, 'oops-not-json', $2)`,
      [SANA, NOW],
    );
    expect(await getFieldRouteOrder(client, 5, SANA)).toBeNull();
  });
});
