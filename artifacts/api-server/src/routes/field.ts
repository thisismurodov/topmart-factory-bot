import { Router, type IRouter, type Response } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import type { PoolClient } from "pg";
import { fieldAuth, type FieldRequest, type FieldAgent } from "../middleware/telegramInitData";

// ── TopMart Field Assistant API ────────────────────────────────────────────────
// Delivery agent Telegram Mini App (/field) uchun endpointlar. Auth: Telegram
// WebApp initData (X-Telegram-Init-Data header) — telegramInitData middleware.
//
// MUHIM: savdo yozish mantiqi distribution botning `database/sales.py`
// create_sale + `customers.py` update_dokon_repeat tranzaksiyasining PORTI.
// Bot semantikasi bilan farq chiqarmang — parity test (field-sale-parity.test.ts)
// aynan shu muvofiqlikni tekshiradi:
//   savdolar → dokonlar stats (incremental avg) → revisitlar supersede+new →
//   savdo_tafsilot → nasiya (agar > 0).
// Sanalar TEXT local-ISO (Asia/Tashkent) — dashboard substr(created_at,1,10)
// filtrlari shu formatga bog'liq.
//
// Idempotentlik: klient har tashrif uchun UUID (clientOpId) yuboradi;
// field_ops.client_op_id UNIQUE — takror yuborilsa duplikat yozuv yaratilmaydi.

const router: IRouter = Router();

router.use("/field", fieldAuth);

const TK = "Asia/Tashkent";

function tkToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TK }).format(new Date());
}

function tkNowIso(): string {
  const d = new Date();
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: TK }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: TK,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
  return `${date}T${time}`;
}

const WEEKDAY_NUM: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

function tkIsoWeekday(): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: TK, weekday: "short" }).format(
    new Date(),
  );
  return WEEKDAY_NUM[wd] ?? 1;
}

function agentOf(req: FieldRequest): FieldAgent {
  // fieldAuth middleware'dan keyin har doim mavjud
  return req.fieldAgent!;
}

// ── GET /field/me — agent profili + bugungi kun ───────────────────────────────
router.get("/field/me", async (req, res) => {
  const agent = agentOf(req as FieldRequest);
  res.json({
    agent: { id: agent.id, name: agent.name, hudud: agent.hudud },
    today: tkToday(),
    kun: tkIsoWeekday(),
  });
});

// ── GET /field/route/today — bugungi marshrut + tashrif holati ────────────────
router.get("/field/route/today", async (req, res) => {
  const agent = agentOf(req as FieldRequest);
  let kun = tkIsoWeekday();
  // Dev-only kun override (?kun=1..7) — faqat FIELD_DEV_BYPASS yoqilganda,
  // dam kunida ham marshrut ko'rinishini test qilish uchun.
  const devBypassEnabled =
    process.env.NODE_ENV !== "production" && process.env.FIELD_DEV_BYPASS === "1";
  if (
    devBypassEnabled &&
    typeof req.query.kun === "string" &&
    /^[1-7]$/.test(req.query.kun)
  ) {
    kun = Number(req.query.kun);
  }
  const today = tkToday();
  try {
    if (kun === 7) {
      res.json({ kun, sana: today, dam: true, shops: [], stats: emptyStats() });
      return;
    }
    const { rows } = await pool.query(
      `SELECT r.dokon_id, r.tartib, d.nomi, d.egasi, d.telefon, d.hudud,
              d.latitude, d.longitude, d.last_order_date, d.total_orders,
              (SELECT s.id FROM distribution.savdolar s
                WHERE s.dokon_id = r.dokon_id AND s.agent_id = $3
                  AND substr(s.created_at,1,10) = $4
                ORDER BY s.id DESC LIMIT 1) AS sale_id,
              (SELECT COALESCE(SUM(s.jami_summa),0) FROM distribution.savdolar s
                WHERE s.dokon_id = r.dokon_id AND s.agent_id = $3
                  AND substr(s.created_at,1,10) = $4) AS sale_summa,
              (SELECT o.id FROM distribution.olmagan_dokonlar o
                WHERE o.dokon_id = r.dokon_id AND o.agent_id = $3
                  AND substr(o.created_at,1,10) = $4
                ORDER BY o.id DESC LIMIT 1) AS nosale_id
         FROM distribution.delivery_routes r
         JOIN distribution.dokonlar d ON d.id = r.dokon_id
        WHERE r.delivery_agent_id = $1 AND r.kun = $2
        ORDER BY r.tartib, r.id`,
      [agent.id, kun, agent.telegramId, today],
    );
    let sold = 0;
    let nosale = 0;
    let savdoSumma = 0;
    const shops = rows.map((r) => {
      const saleId = r.sale_id != null ? Number(r.sale_id) : null;
      const nosaleId = r.nosale_id != null ? Number(r.nosale_id) : null;
      const status: "sold" | "nosale" | "pending" = saleId
        ? "sold"
        : nosaleId
          ? "nosale"
          : "pending";
      if (status === "sold") {
        sold += 1;
        savdoSumma += Number(r.sale_summa) || 0;
      } else if (status === "nosale") {
        nosale += 1;
      }
      return {
        dokonId: Number(r.dokon_id),
        tartib: Number(r.tartib) || 0,
        nomi: r.nomi as string,
        egasi: (r.egasi as string) || "",
        telefon: (r.telefon as string) || "",
        hudud: (r.hudud as string) || "",
        latitude: r.latitude != null ? Number(r.latitude) : null,
        longitude: r.longitude != null ? Number(r.longitude) : null,
        lastOrderDate: (r.last_order_date as string) || null,
        totalOrders: Number(r.total_orders) || 0,
        status,
      };
    });
    res.json({
      kun,
      sana: today,
      dam: false,
      shops,
      stats: {
        total: shops.length,
        done: sold + nosale,
        sold,
        nosale,
        pending: shops.length - sold - nosale,
        savdoSumma,
      },
    });
  } catch (err) {
    req.log.error({ err }, "field route/today xatosi");
    res.status(500).json({ error: "Marshrutni olishda xato" });
  }
});

function emptyStats() {
  return { total: 0, done: 0, sold: 0, nosale: 0, pending: 0, savdoSumma: 0 };
}

// ── GET /field/products — faol mahsulotlar ────────────────────────────────────
router.get("/field/products", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nomi, narx, birlik FROM distribution.mahsulotlar
        WHERE faol = 1 ORDER BY nomi`,
    );
    res.json(
      rows.map((r) => ({
        id: Number(r.id),
        nomi: r.nomi as string,
        narx: Number(r.narx) || 0,
        birlik: (r.birlik as string) || "dona",
      })),
    );
  } catch (err) {
    req.log.error({ err }, "field products xatosi");
    res.status(500).json({ error: "Mahsulotlarni olishda xato" });
  }
});

// ── POST /field/visits/sale — savdo (bot create_sale porti, bitta tranzaksiya) ─
const saleSchema = z.object({
  clientOpId: z.string().min(8).max(64),
  dokonId: z.number().int().positive(),
  tolovTuri: z.enum(["naqd", "karta", "nasiya", "aralash"]),
  items: z
    .array(
      z.object({
        mahsulotId: z.number().int().positive(),
        miqdor: z.number().positive().max(100000),
      }),
    )
    .min(1)
    .max(100),
  // aralash to'lovda nasiya qismi (so'mda)
  nasiyaQism: z.number().int().nonnegative().optional(),
});

async function findExistingOp(
  client: PoolClient,
  clientOpId: string,
): Promise<{ opType: string; resultId: number | null } | null> {
  const { rows } = await client.query(
    `SELECT op_type, result_id FROM distribution.field_ops WHERE client_op_id = $1`,
    [clientOpId],
  );
  if (rows.length === 0) return null;
  return {
    opType: rows[0].op_type as string,
    resultId: rows[0].result_id != null ? Number(rows[0].result_id) : null,
  };
}

// customers.py update_dokon_repeat porti (tranzaksiya ichida chaqiriladi)
async function updateDokonRepeat(
  client: PoolClient,
  dokonId: number,
  jamiSumma: number,
  nowIso: string,
): Promise<void> {
  const { rows } = await client.query(
    `SELECT total_orders, repeat_orders, avg_repeat_days, last_order_date, first_order_date
       FROM distribution.dokonlar WHERE id = $1 FOR UPDATE`,
    [dokonId],
  );
  if (rows.length === 0) return;
  const r = rows[0];
  let total = Number(r.total_orders) || 0;
  let repeatN = Number(r.repeat_orders) || 0;
  let avg = Number(r.avg_repeat_days) || 0;
  let firstD: string | null = (r.first_order_date as string) || null;
  const lastD: string | null = (r.last_order_date as string) || null;
  if (total === 0) {
    firstD = nowIso;
  } else if (lastD) {
    const ld = Date.parse(lastD);
    if (!Number.isNaN(ld)) {
      const days = Math.floor((Date.now() - ld) / 86400000);
      const totalRepeatTime = avg * repeatN;
      repeatN += 1;
      avg = (totalRepeatTime + days) / repeatN;
    }
  }
  total += 1;
  await client.query(
    `UPDATE distribution.dokonlar
        SET first_order_date = COALESCE(first_order_date, $1),
            last_order_date = $2, total_orders = $3, repeat_orders = $4,
            avg_repeat_days = $5, total_sales = COALESCE(total_sales,0) + $6
      WHERE id = $7`,
    [firstD, nowIso, total, repeatN, avg, jamiSumma || 0, dokonId],
  );
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { code?: string }).code === "23505"
  );
}

export type FieldSaleInput = z.infer<typeof saleSchema>;

export type FieldSaleResult =
  | { kind: "duplicate"; savdoId: number | null }
  | { kind: "not_found"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "ok"; savdoId: number; jami: number; nasiyaSumma: number };

// Bot create_sale (sales.py) + update_dokon_repeat (customers.py) porti —
// BITTA tranzaksiya. Testdan to'g'ridan-to'g'ri chaqiriladi (parity test).
// Xato bo'lsa ROLLBACK qilib qayta uloqtiradi (unique violation'ni handler ushlaydi).
export async function performFieldSale(
  client: PoolClient,
  agentTelegramId: number,
  input: FieldSaleInput,
): Promise<FieldSaleResult> {
  const { clientOpId, dokonId, tolovTuri, items, nasiyaQism } = input;
  await client.query("BEGIN");
  try {
    const existing = await findExistingOp(client, clientOpId);
    if (existing) {
      await client.query("ROLLBACK");
      return { kind: "duplicate", savdoId: existing.resultId };
    }

    const dokonQ = await client.query(
      `SELECT id FROM distribution.dokonlar WHERE id = $1`,
      [dokonId],
    );
    if (dokonQ.rows.length === 0) {
      await client.query("ROLLBACK");
      return { kind: "not_found", message: "Do'kon topilmadi" };
    }

    // Narxlar serverda mahsulotlar jadvalidan olinadi (klient narx yubormaydi)
    const ids = items.map((i) => i.mahsulotId);
    const prodQ = await client.query(
      `SELECT id, narx FROM distribution.mahsulotlar WHERE id = ANY($1) AND faol = 1`,
      [ids],
    );
    const priceMap = new Map<number, number>(
      prodQ.rows.map((r) => [Number(r.id), Number(r.narx) || 0]),
    );
    for (const it of items) {
      if (!priceMap.has(it.mahsulotId)) {
        await client.query("ROLLBACK");
        return {
          kind: "invalid",
          message: `Mahsulot topilmadi yoki faol emas: ${it.mahsulotId}`,
        };
      }
    }
    let jami = 0;
    const lines = items.map((it) => {
      const narx = priceMap.get(it.mahsulotId)!;
      const summa = Math.round(narx * it.miqdor);
      jami += summa;
      return { mahsulotId: it.mahsulotId, miqdor: it.miqdor, narx, summa };
    });
    if (jami <= 0) {
      await client.query("ROLLBACK");
      return { kind: "invalid", message: "Savdo summasi 0 bo'lishi mumkin emas" };
    }

    let nasiyaSumma = 0;
    if (tolovTuri === "nasiya") nasiyaSumma = jami;
    else if (tolovTuri === "aralash") {
      nasiyaSumma = nasiyaQism ?? 0;
      if (nasiyaSumma <= 0 || nasiyaSumma >= jami) {
        await client.query("ROLLBACK");
        return {
          kind: "invalid",
          message:
            "Aralash to'lovda nasiya qismi 0 dan katta va jami summadan kichik bo'lishi kerak",
        };
      }
    }

    const nowIso = tkNowIso();
    const today = tkToday();
    const rdaysRaw = Number(process.env.REVISIT_DAYS);
    const rdays = Number.isInteger(rdaysRaw) && rdaysRaw > 0 ? rdaysRaw : 7;
    const revisitDate = new Intl.DateTimeFormat("en-CA", { timeZone: TK }).format(
      new Date(Date.now() + rdays * 86400000),
    );

    const saleIns = await client.query(
      `INSERT INTO distribution.savdolar (dokon_id, agent_id, jami_summa, tolov_turi, foto, created_at)
       VALUES ($1,$2,$3,$4,NULL,$5) RETURNING id`,
      [dokonId, agentTelegramId, jami, tolovTuri, nowIso],
    );
    const sid = Number(saleIns.rows[0].id);

    await updateDokonRepeat(client, dokonId, jami, nowIso);

    await client.query(
      `UPDATE distribution.revisitlar SET status='superseded'
        WHERE dokon_id = $1 AND status = 'pending'`,
      [dokonId],
    );
    await client.query(
      `INSERT INTO distribution.revisitlar (dokon_id, agent_id, last_order_date, revisit_date, status, created_at)
       VALUES ($1,$2,$3,$4,'pending',$5)`,
      [dokonId, agentTelegramId, today, revisitDate, nowIso],
    );

    for (const l of lines) {
      await client.query(
        `INSERT INTO distribution.savdo_tafsilot (savdo_id, mahsulot_id, miqdor, narx, summa)
         VALUES ($1,$2,$3,$4,$5)`,
        [sid, l.mahsulotId, l.miqdor, l.narx, l.summa],
      );
    }

    if (nasiyaSumma > 0) {
      await client.query(
        `INSERT INTO distribution.nasiya (dokon_id, agent_id, savdo_id, jami_summa, tolangan, qoldiq, created_at, updated_at)
         VALUES ($1,$2,$3,$4,0,$4,$5,$5)`,
        [dokonId, agentTelegramId, sid, nasiyaSumma, nowIso],
      );
    }

    await client.query(
      `INSERT INTO distribution.field_ops (client_op_id, agent_id, op_type, dokon_id, result_id, created_at)
       VALUES ($1,$2,'sale',$3,$4,$5)`,
      [clientOpId, agentTelegramId, dokonId, sid, nowIso],
    );

    await client.query("COMMIT");
    return { kind: "ok", savdoId: sid, jami, nasiyaSumma };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

router.post("/field/visits/sale", async (req, res) => {
  const agent = agentOf(req as FieldRequest);
  const parsed = saleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Noto'g'ri ma'lumot", details: parsed.error.issues });
    return;
  }
  const client = await pool.connect();
  try {
    const result = await performFieldSale(client, agent.telegramId, parsed.data);
    switch (result.kind) {
      case "duplicate":
        res.json({ ok: true, duplicate: true, savdoId: result.savdoId });
        return;
      case "not_found":
        res.status(404).json({ error: result.message });
        return;
      case "invalid":
        res.status(400).json({ error: result.message });
        return;
      case "ok":
        res.json({
          ok: true,
          duplicate: false,
          savdoId: result.savdoId,
          jami: result.jami,
          nasiyaSumma: result.nasiyaSumma,
        });
        return;
    }
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Parallel takror yuborish — birinchi tranzaksiya yutdi
      res.json({ ok: true, duplicate: true, savdoId: null });
      return;
    }
    req.log.error({ err }, "field visits/sale xatosi");
    res.status(500).json({ error: "Savdoni saqlashda xato" });
  } finally {
    client.release();
  }
});

// ── POST /field/visits/no-sale — olinmadi (bot _save_olmadi porti) ───────────
const SABAB_LABELS: Record<string, string> = {
  narx_qimmat: "💸 Narx qimmat",
  tovari_bor: "📦 Hozir tovari bor",
  boshqa_firma: "🏢 Boshqa firma",
  sifat: "😕 Sifat yoqmadi",
  egasi_yoq: "🚪 Egasi yo'q edi",
  keyin_keling: "🕐 Keyin keling dedi",
  sotilmaydi: "🚫 Sotilmaydi dedi",
  boshqa: "📝 Boshqa sabab",
};

const noSaleSchema = z.object({
  clientOpId: z.string().min(8).max(64),
  dokonId: z.number().int().positive(),
  sabab: z.enum([
    "narx_qimmat",
    "tovari_bor",
    "boshqa_firma",
    "sifat",
    "egasi_yoq",
    "keyin_keling",
    "sotilmaydi",
    "boshqa",
  ]),
  sababText: z.string().max(300).optional(),
  qaytishSanasi: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
});

router.post("/field/visits/no-sale", async (req, res) => {
  const agent = agentOf(req as FieldRequest);
  const parsed = noSaleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Noto'g'ri ma'lumot", details: parsed.error.issues });
    return;
  }
  const { clientOpId, dokonId, sabab, sababText, qaytishSanasi, lat, lon } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await findExistingOp(client, clientOpId);
    if (existing) {
      await client.query("ROLLBACK");
      res.json({ ok: true, duplicate: true, id: existing.resultId });
      return;
    }

    const dokonQ = await client.query(
      `SELECT id FROM distribution.dokonlar WHERE id = $1`,
      [dokonId],
    );
    if (dokonQ.rows.length === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Do'kon topilmadi" });
      return;
    }

    const nowIso = tkNowIso();
    const text = sababText && sababText.trim() !== "" ? sababText.trim() : SABAB_LABELS[sabab];
    const ins = await client.query(
      `INSERT INTO distribution.olmagan_dokonlar
         (dokon_id, agent_id, sabab, sabab_text, latitude, longitude, qaytish_sanasi, foto, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8) RETURNING id`,
      [dokonId, agent.telegramId, sabab, text, lat ?? null, lon ?? null, qaytishSanasi ?? null, nowIso],
    );
    const oid = Number(ins.rows[0].id);

    await client.query(
      `INSERT INTO distribution.field_ops (client_op_id, agent_id, op_type, dokon_id, result_id, created_at)
       VALUES ($1,$2,'nosale',$3,$4,$5)`,
      [clientOpId, agent.telegramId, dokonId, oid, nowIso],
    );

    await client.query("COMMIT");
    res.json({ ok: true, duplicate: false, id: oid });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (isUniqueViolation(err)) {
      res.json({ ok: true, duplicate: true, id: null });
      return;
    }
    req.log.error({ err }, "field visits/no-sale xatosi");
    res.status(500).json({ error: "Natijani saqlashda xato" });
  } finally {
    client.release();
  }
});

// ── POST /field/gps — GPS nuqtasi (klient ≥30s oraliqda yuboradi) ────────────
const gpsSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

router.post("/field/gps", async (req, res) => {
  const agent = agentOf(req as FieldRequest);
  const parsed = gpsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Noto'g'ri koordinata" });
    return;
  }
  try {
    await pool.query(
      `INSERT INTO distribution.agent_locations (agent_id, latitude, longitude, source, created_at)
       VALUES ($1,$2,$3,'field_app',$4)`,
      [agent.telegramId, parsed.data.lat, parsed.data.lon, tkNowIso()],
    );
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "field gps xatosi");
    res.status(500).json({ error: "GPS yozishda xato" });
  }
});

// ── GET /field/summary/today — kun oxiri natijalari ──────────────────────────
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

router.get("/field/summary/today", async (req, res) => {
  const agent = agentOf(req as FieldRequest);
  const today = tkToday();
  try {
    const [salesQ, nosaleQ, gpsQ] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(jami_summa),0) AS summa
           FROM distribution.savdolar
          WHERE agent_id = $1 AND substr(created_at,1,10) = $2`,
        [agent.telegramId, today],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM distribution.olmagan_dokonlar
          WHERE agent_id = $1 AND substr(created_at,1,10) = $2`,
        [agent.telegramId, today],
      ),
      pool.query(
        `SELECT latitude, longitude, created_at FROM distribution.agent_locations
          WHERE agent_id = $1 AND substr(created_at,1,10) = $2
          ORDER BY created_at`,
        [agent.telegramId, today],
      ),
    ]);
    let km = 0;
    const pts = gpsQ.rows;
    for (let i = 1; i < pts.length; i++) {
      const seg = haversineKm(
        Number(pts[i - 1].latitude),
        Number(pts[i - 1].longitude),
        Number(pts[i].latitude),
        Number(pts[i].longitude),
      );
      // GPS sakrashlarini (noto'g'ri nuqta) hisobga olmaymiz
      if (seg < 10) km += seg;
    }
    let minutes = 0;
    if (pts.length >= 2) {
      const t0 = Date.parse(pts[0].created_at as string);
      const t1 = Date.parse(pts[pts.length - 1].created_at as string);
      if (!Number.isNaN(t0) && !Number.isNaN(t1) && t1 > t0) {
        minutes = Math.round((t1 - t0) / 60000);
      }
    }
    res.json({
      sana: today,
      savdolar: Number(salesQ.rows[0].n),
      savdoSumma: Number(salesQ.rows[0].summa) || 0,
      olinmadi: Number(nosaleQ.rows[0].n),
      km: Math.round(km * 10) / 10,
      daqiqa: minutes,
    });
  } catch (err) {
    req.log.error({ err }, "field summary xatosi");
    res.status(500).json({ error: "Natijalarni olishda xato" });
  }
});

export default router;
