import { Router, type IRouter } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";

const router: IRouter = Router();

const DailyQuerySchema = z.object({ refresh: z.string().optional() });

const PackerTipSchema = z.object({
  worker: z.string().trim().min(1),
  items: z
    .array(
      z.object({
        product: z.string().trim().min(1),
        quantity: z.coerce.number().default(0),
        weightKg: z.coerce.number().default(0),
      }),
    )
    .min(1),
});

const DAILY_MODEL = "gpt-5.4";
const TIP_MODEL = "gpt-5-mini";

// ── Snapshot types ────────────────────────────────────────────────────────────
type ProductRow = {
  name: string;
  rateType: string;
  unitType: string;
  unit: string; // "kg" | "dona" — the unit minimum/velocity/stock are expressed in
  minimumStock: number;
  stock: number; // unit-appropriate stock (kg for kg products, pieces otherwise)
  stockQty: number;
  stockKg: number;
  producedTodayQty: number;
  producedTodayKg: number;
  soldTodayQty: number;
  velocityPerDay: number; // unit/day over last 7 days, consistent with `unit`
  daysOfStock: number | null; // stock / velocity, null if no velocity
  below: boolean; // unit-consistent stock below minimum
};

type Snapshot = {
  date: string;
  products: ProductRow[];
  lowRawMaterials: {
    name: string;
    unit: string;
    currentStock: number;
    minimumStock: number;
    pct: number;
  }[];
  overdueDebts: {
    customer: string;
    amount: number;
    currency: string;
    daysSince: number;
  }[];
  production: { todayKg: number; avg7Kg: number; todayBatches: number };
  sales: { todayCount: number; avg7Count: number };
  producersToday: { worker: string; todayKg: number; batches: number }[];
};

const num = (v: unknown): number => Number(v ?? 0);

// ── Build the deterministic factory snapshot from SQL ─────────────────────────
async function buildSnapshot(): Promise<Snapshot> {
  const [dRow] = (
    await pool.query(
      `SELECT to_char((NOW() AT TIME ZONE 'Asia/Tashkent')::date, 'YYYY-MM-DD') AS today`,
    )
  ).rows;
  const today: string = dRow.today;

  const [productsRes, rawRes, debtRes, prodRes, salesRes, workersRes] =
    await Promise.all([
      pool.query(
        // Real warehouse stock comes from the inventory table (the Ombor), the
        // same source the bot and dashboard show. Only positive rows count, so
        // phantom negative balances in general warehouses are ignored — exactly
        // what the user sees. kg-unit products convert qty→kg via the batch
        // weight ratio (SUM(weight_kg)/SUM(quantity)); when no ratio exists the
        // inventory qty is already in kg.
        `WITH weight_ratio AS (
           SELECT product,
                  CASE WHEN SUM(quantity) > 0
                       THEN SUM(weight_kg)::numeric / SUM(quantity) ELSE 0 END AS kg_per_unit
           FROM batches GROUP BY product
         ),
         inv AS (
           SELECT product, COALESCE(SUM(quantity),0) qty
           FROM inventory WHERE quantity > 0 GROUP BY product
         ),
         produced_today AS (
           SELECT product, COALESCE(SUM(quantity),0) qty, COALESCE(SUM(weight_kg),0) kg
           FROM batches
           WHERE (created_at AT TIME ZONE 'Asia/Tashkent')::date = $1
           GROUP BY product
         ),
         sold_today AS (
           SELECT product, COALESCE(SUM(quantity),0) qty
           FROM sales
           WHERE (created_at AT TIME ZONE 'Asia/Tashkent')::date = $1
           GROUP BY product
         ),
         sold_7d AS (
           SELECT product, COALESCE(SUM(quantity),0) qty, COALESCE(SUM(weight_kg),0) kg
           FROM sales
           WHERE created_at >= NOW() - INTERVAL '7 days'
           GROUP BY product
         )
         SELECT p.name, p.rate_type, p.unit_type, p.minimum_stock,
                COALESCE(iv.qty,0) inv_qty, COALESCE(wr.kg_per_unit,0) kg_per_unit,
                COALESCE(pt.qty,0) today_qty,    COALESCE(pt.kg,0) today_kg,
                COALESCE(st.qty,0) sold_today_qty,
                COALESCE(s7.qty,0) sold7_qty, COALESCE(s7.kg,0) sold7_kg
         FROM products p
         LEFT JOIN inv            iv ON iv.product = p.name
         LEFT JOIN weight_ratio   wr ON wr.product = p.name
         LEFT JOIN produced_today pt ON pt.product = p.name
         LEFT JOIN sold_today     st ON st.product = p.name
         LEFT JOIN sold_7d        s7 ON s7.product = p.name
         WHERE p.active = TRUE
         ORDER BY p.name`,
        [today],
      ),
      pool.query(
        `SELECT name, unit_type, current_stock, minimum_stock
         FROM raw_materials
         WHERE active = TRUE AND minimum_stock > 0 AND current_stock <= minimum_stock
         ORDER BY (current_stock / NULLIF(minimum_stock, 0)) ASC
         LIMIT 25`,
      ),
      pool.query(
        `SELECT customer_name, debt_amount, currency,
                EXTRACT(DAY FROM NOW() - created_at)::int AS days_since
         FROM sales
         WHERE debt_amount > 0 AND status IN ('pending','partial')
         ORDER BY created_at ASC
         LIMIT 15`,
      ),
      pool.query(
        `SELECT
           (SELECT COALESCE(SUM(weight_kg),0) FROM batches
              WHERE (created_at AT TIME ZONE 'Asia/Tashkent')::date = $1) AS today_kg,
           (SELECT COALESCE(SUM(weight_kg),0) FROM batches
              WHERE created_at >= NOW() - INTERVAL '7 days') AS week_kg,
           (SELECT COUNT(*) FROM batches
              WHERE (created_at AT TIME ZONE 'Asia/Tashkent')::date = $1)::int AS today_batches`,
        [today],
      ),
      pool.query(
        `SELECT
           (SELECT COUNT(*) FROM sales
              WHERE (created_at AT TIME ZONE 'Asia/Tashkent')::date = $1)::int AS today_count,
           (SELECT COUNT(*) FROM sales
              WHERE created_at >= NOW() - INTERVAL '7 days')::int AS week_count`,
        [today],
      ),
      pool.query(
        `SELECT worker, COALESCE(SUM(weight_kg),0) AS today_kg, COUNT(*)::int AS batches
         FROM batches
         WHERE (created_at AT TIME ZONE 'Asia/Tashkent')::date = $1
         GROUP BY worker ORDER BY today_kg DESC LIMIT 20`,
        [today],
      ),
    ]);

  const products: ProductRow[] = productsRes.rows.map((r) => {
    const isKg = r.rate_type === "kg" || r.unit_type === "kg";
    const invQty = num(r.inv_qty);
    const kgPerUnit = num(r.kg_per_unit);
    const stockQty = invQty;
    const stockKg = kgPerUnit > 0 ? invQty * kgPerUnit : invQty;
    const minimumStock = num(r.minimum_stock);
    // Compare and forecast in the product's own unit: kg products use weight
    // (stock/min/velocity all in kg); piece products use quantity. Never mix.
    const stock = isKg ? stockKg : stockQty;
    const sold7 = isKg ? num(r.sold7_kg) : num(r.sold7_qty);
    const velocityPerDay = sold7 / 7;
    const daysOfStock =
      velocityPerDay > 0 ? Math.round((stock / velocityPerDay) * 10) / 10 : null;
    return {
      name: r.name,
      rateType: r.rate_type,
      unitType: r.unit_type,
      unit: isKg ? "kg" : "dona",
      minimumStock,
      stock: Math.round(stock * 1000) / 1000,
      stockQty: Math.round(stockQty * 1000) / 1000,
      stockKg: Math.round(stockKg * 1000) / 1000,
      producedTodayQty: num(r.today_qty),
      producedTodayKg: Math.round(num(r.today_kg) * 1000) / 1000,
      soldTodayQty: num(r.sold_today_qty),
      velocityPerDay: Math.round(velocityPerDay * 100) / 100,
      daysOfStock,
      below: minimumStock > 0 && stock < minimumStock,
    };
  });

  const prod = prodRes.rows[0];
  const sales = salesRes.rows[0];

  return {
    date: today,
    products,
    lowRawMaterials: rawRes.rows.map((r) => {
      const cur = num(r.current_stock);
      const mn = num(r.minimum_stock);
      return {
        name: r.name,
        unit: r.unit_type,
        currentStock: cur,
        minimumStock: mn,
        pct: mn > 0 ? Math.round((cur / mn) * 100) : 0,
      };
    }),
    overdueDebts: debtRes.rows.map((r) => ({
      customer: r.customer_name || "—",
      amount: num(r.debt_amount),
      currency: (r.currency || "UZS").toUpperCase(),
      daysSince: num(r.days_since),
    })),
    production: {
      todayKg: Math.round(num(prod.today_kg) * 10) / 10,
      avg7Kg: Math.round((num(prod.week_kg) / 7) * 10) / 10,
      todayBatches: num(prod.today_batches),
    },
    sales: {
      todayCount: num(sales.today_count),
      avg7Count: Math.round((num(sales.week_count) / 7) * 10) / 10,
    },
    producersToday: workersRes.rows.map((r) => ({
      worker: r.worker,
      todayKg: Math.round(num(r.today_kg) * 10) / 10,
      batches: num(r.batches),
    })),
  };
}

// ── LLM: full daily analysis ──────────────────────────────────────────────────
const DAILY_SYSTEM = `Sen Arqon ishlab chiqarish zavodi (TopMart) uchun aqlli yordamchisan.
Senga zavodning bugungi holati JSON ko'rinishida beriladi. Vazifang — egasiga (admin)
qisqa, aniq va AMALIY kunlik tahlil tayyorlash. FAQAT o'zbek tilida yoz.

Tahlil quyidagi bo'limlarni o'z ichiga olsin (faqat ma'lumot bo'lsa):
1. 🏭 Nima ishlab chiqarish kerak — qaysi mahsulot omborida minimumdan kam yoki tez tugayapti
   (stock, minimumStock, velocityPerDay, daysOfStock asosida). Eng shoshilinchini birinchi qo'y.
2. ⚠️ Xom ashyo — kam qolgan xom ashyolar (lowRawMaterials).
3. 💳 Qarzlar — eng eski/katta nasiyalar (overdueDebts).
4. 📉 Ishlab chiqarish — bugungi hajm (production.todayKg) 7 kunlik o'rtachadan (avg7Kg) sezilarli kam bo'lsa ogohlantir.
5. 📊 Savdo — bugungi savdo soni odatdagidan keskin farq qilsa eslat.
6. 👷 Hodimlar — agar e'tiborga loyiq bo'lsa (juda kam ishlab chiqargan yoki ajralib turgan).

Qoidalar:
- Raqamlarni o'zgartirma, faqat berilgan ma'lumotdan foydalan.
- Har bir tavsiya aniq bo'lsin: "X mahsulotdan ~N dona/kg ishlab chiqaring".
- Qisqa yoz. Telegram uchun oddiy Markdown ishlat (*qalin* va • belgilar). Sarlavhalarni # bilan yozma.
- Hammasi joyida bo'lsa — qisqa qilib "Hammasi nazoratda" deb yoz.`;

async function generateDailyAnalysis(snapshot: Snapshot): Promise<string> {
  const completion = await openai.chat.completions.create({
    model: DAILY_MODEL,
    max_completion_tokens: 2000,
    messages: [
      { role: "system", content: DAILY_SYSTEM },
      { role: "user", content: JSON.stringify(snapshot) },
    ],
  });
  return completion.choices[0]?.message?.content?.trim() || "Tahlil tayyorlab bo'lmadi.";
}

// Compact summary persisted alongside the analysis (for dashboard history)
function summarize(s: Snapshot) {
  return {
    date: s.date,
    belowMinCount: s.products.filter((p) => p.below).length,
    lowRawCount: s.lowRawMaterials.length,
    overdueCount: s.overdueDebts.length,
    todayKg: s.production.todayKg,
    avg7Kg: s.production.avg7Kg,
  };
}

// ── GET /ai/daily-analysis ────────────────────────────────────────────────────
// Returns today's cached run unless ?refresh=1. Persists every generated run.
router.get("/ai/daily-analysis", async (req, res): Promise<void> => {
  const q = DailyQuerySchema.safeParse(req.query);
  const refreshVal = q.success ? q.data.refresh : undefined;
  const refresh = refreshVal === "1" || refreshVal === "true";

  if (!refresh) {
    const cached = await pool.query(
      `SELECT id, analysis, summary, created_at FROM ai_analysis_runs
       WHERE kind = 'daily'
         AND (created_at AT TIME ZONE 'Asia/Tashkent')::date = (NOW() AT TIME ZONE 'Asia/Tashkent')::date
       ORDER BY created_at DESC LIMIT 1`,
    );
    if (cached.rows.length > 0) {
      const r = cached.rows[0];
      res.json({
        id: r.id,
        analysis: r.analysis,
        summary: r.summary,
        generatedAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        cached: true,
      });
      return;
    }
  }

  try {
    const snapshot = await buildSnapshot();
    const analysis = await generateDailyAnalysis(snapshot);
    const summary = summarize(snapshot);
    const { rows } = await pool.query(
      `INSERT INTO ai_analysis_runs (kind, summary, analysis)
       VALUES ('daily', $1, $2)
       RETURNING id, created_at`,
      [JSON.stringify(summary), analysis],
    );
    res.json({
      id: rows[0].id,
      analysis,
      summary,
      generatedAt:
        rows[0].created_at instanceof Date
          ? rows[0].created_at.toISOString()
          : String(rows[0].created_at),
      cached: false,
    });
  } catch (err) {
    req.log.error({ err }, "AI daily-analysis failed");
    res.status(502).json({ error: "AI tahlil hozircha mavjud emas." });
  }
});

// ── GET /ai/runs — recent daily analyses (dashboard history) ──────────────────
router.get("/ai/runs", async (_req, res): Promise<void> => {
  const { rows } = await pool.query(
    `SELECT id, summary, analysis, created_at FROM ai_analysis_runs
     WHERE kind = 'daily' ORDER BY created_at DESC LIMIT 30`,
  );
  res.json(
    rows.map((r) => ({
      id: r.id,
      summary: r.summary,
      analysis: r.analysis,
      generatedAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    })),
  );
});

// ── POST /ai/packer-tip — short per-batch tip for a packer ────────────────────
const TIP_SYSTEM = `Sen TopMart zavodi uchun yordamchisan. Bir ishchi hozirgina partiya kiritdi.
Senga shu ishchi bugun ishlab chiqargan mahsulotlar va ularning ombor holati beriladi.
Vazifang — 1-2 ta juda qisqa, do'stona jumlada o'zbek tilida maslahat berish:
qaysi mahsulot omborida kam va keyingi galda nima ishlab chiqarish foydali.
Misol uslub: "Bugun qora 50g chiqarding 👍. Omborda oq 100g kam qoldi — keyingisini shundan chiqarsang yaxshi bo'ladi."
Qoidalar: raqamlarni o'zgartirma, qisqa yoz, Markdown ishlatma, do'stona ohangda.`;

router.post("/ai/packer-tip", async (req, res): Promise<void> => {
  const parsed = PackerTipSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "worker va items talab qilinadi" });
    return;
  }
  const { worker, items } = parsed.data;

  try {
    const snapshot = await buildSnapshot();
    const justMade = items.map((it) => it.product);
    const byName = new Map(snapshot.products.map((p) => [p.name, p]));

    // Stock status for what they just made
    const madeStatus = items.map((it) => {
      const p = byName.get(it.product);
      return {
        product: it.product,
        madeQty: it.quantity,
        madeKg: it.weightKg,
        unit: p?.unit ?? null,
        stock: p?.stock ?? null,
        minimumStock: p?.minimumStock ?? null,
        below: p?.below ?? false,
      };
    });

    // Most-needed products overall (below minimum, soonest to run out), excluding what they just made
    const needed = snapshot.products
      .filter((p) => p.below && !justMade.includes(p.name))
      .sort((a, b) => (a.daysOfStock ?? 999) - (b.daysOfStock ?? 999))
      .slice(0, 4)
      .map((p) => ({
        product: p.name,
        unit: p.unit,
        stock: p.stock,
        minimumStock: p.minimumStock,
        velocityPerDay: p.velocityPerDay,
      }));

    const payload = { worker, made: madeStatus, needed };
    const completion = await openai.chat.completions.create({
      model: TIP_MODEL,
      max_completion_tokens: 600,
      reasoning_effort: "minimal",
      messages: [
        { role: "system", content: TIP_SYSTEM },
        { role: "user", content: JSON.stringify(payload) },
      ],
    });
    const tip = completion.choices[0]?.message?.content?.trim() || "";
    res.json({ tip });
  } catch (err) {
    req.log.error({ err }, "AI packer-tip failed");
    res.status(502).json({ error: "AI maslahat mavjud emas." });
  }
});

export default router;
