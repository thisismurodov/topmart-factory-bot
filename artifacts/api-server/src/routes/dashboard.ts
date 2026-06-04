import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  GetDashboardTodayResponse,
  GetDashboardMonthlyQueryParams,
  GetDashboardMonthlyResponse,
  GetTopWorkersResponse,
  GetDailyChartResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/dashboard/today", async (_req, res): Promise<void> => {
  const result = await pool.query(
    `SELECT
       COUNT(*)::int AS "totalBatches",
       COALESCE(SUM(quantity), 0)::int AS "totalQty",
       COALESCE(SUM(weight_kg), 0.0) AS "totalKg",
       COALESCE(SUM(earnings), 0.0) AS "totalEarnings",
       COUNT(DISTINCT worker)::int AS "workerCount"
     FROM batches
     WHERE created_at::date = CURRENT_DATE`
  );

  const r = result.rows[0];
  res.json(
    GetDashboardTodayResponse.parse({
      totalBatches: Number(r.totalBatches),
      totalQty: Number(r.totalQty),
      totalKg: Number(r.totalKg),
      totalEarnings: Number(r.totalEarnings),
      workerCount: Number(r.workerCount),
    })
  );
});

router.get("/dashboard/monthly", async (req, res): Promise<void> => {
  const now = new Date();
  const parsed = GetDashboardMonthlyQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const year = parsed.data.year ?? now.getFullYear();
  const month = parsed.data.month ?? now.getMonth() + 1;
  const period = `${year}-${String(month).padStart(2, "0")}`;

  const [productionResult, paidResult, unpaidResult] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int AS "totalBatches",
         COALESCE(SUM(quantity), 0)::int AS "totalQty",
         COALESCE(SUM(weight_kg), 0.0) AS "totalKg",
         COALESCE(SUM(earnings), 0.0) AS "totalEarnings",
         COUNT(DISTINCT worker)::int AS "workerCount"
       FROM batches
       WHERE TO_CHAR(created_at, 'YYYY-MM') = $1`,
      [period]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS cnt FROM salary_payments WHERE year = $1 AND month = $2`,
      [year, month]
    ),
    pool.query(
      `SELECT COALESCE(SUM(earnings), 0.0) AS total
       FROM batches
       WHERE TO_CHAR(created_at, 'YYYY-MM') = $1
         AND worker NOT IN (
           SELECT worker FROM salary_payments WHERE year = $2 AND month = $3
         )`,
      [period, year, month]
    ),
  ]);

  const p = productionResult.rows[0];
  const paidCount = Number(paidResult.rows[0].cnt);
  const workerCount = Number(p.workerCount);

  res.json(
    GetDashboardMonthlyResponse.parse({
      totalBatches: Number(p.totalBatches),
      totalQty: Number(p.totalQty),
      totalKg: Number(p.totalKg),
      totalEarnings: Number(p.totalEarnings),
      paidCount,
      unpaidCount: Math.max(0, workerCount - paidCount),
      unpaidAmount: Number(unpaidResult.rows[0].total),
    })
  );
});

router.get("/dashboard/top-workers", async (_req, res): Promise<void> => {
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const result = await pool.query(
    `SELECT
       worker,
       COALESCE(SUM(quantity), 0)::int AS "totalQty",
       COALESCE(SUM(weight_kg), 0.0) AS "totalKg",
       COALESCE(SUM(earnings), 0.0) AS "totalEarnings"
     FROM batches
     WHERE TO_CHAR(created_at, 'YYYY-MM') = $1
     GROUP BY worker
     ORDER BY SUM(earnings) DESC
     LIMIT 10`,
    [period]
  );

  res.json(
    GetTopWorkersResponse.parse(
      result.rows.map((r) => ({
        worker: r.worker,
        totalQty: Number(r.totalQty),
        totalKg: Number(r.totalKg),
        totalEarnings: Number(r.totalEarnings),
      }))
    )
  );
});

router.get("/dashboard/daily-chart", async (_req, res): Promise<void> => {
  const result = await pool.query(
    `SELECT
       created_at::date AS date,
       COALESCE(SUM(quantity), 0)::int AS qty,
       COALESCE(SUM(weight_kg), 0.0) AS kg,
       COALESCE(SUM(earnings), 0.0) AS earnings
     FROM batches
     WHERE created_at >= NOW() - INTERVAL '30 days'
     GROUP BY created_at::date
     ORDER BY created_at::date ASC`
  );

  res.json(
    GetDailyChartResponse.parse(
      result.rows.map((r) => ({
        date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date),
        qty: Number(r.qty),
        kg: Number(r.kg),
        earnings: Number(r.earnings),
      }))
    )
  );
});

router.get("/dashboard/today-extended", async (_req, res): Promise<void> => {
  const [salesResult, batchesResult] = await Promise.all([
    pool.query(
      `SELECT id, customer_name, product, quantity, weight_kg,
              total_amount, currency, status, created_at
       FROM sales
       WHERE created_at::date = CURRENT_DATE
       ORDER BY id DESC
       LIMIT 10`
    ),
    pool.query(
      `SELECT
         worker,
         COALESCE(SUM(quantity), 0)::int   AS qty,
         COALESCE(SUM(weight_kg), 0.0)     AS kg,
         COALESCE(SUM(earnings), 0.0)      AS earnings,
         COUNT(*)::int                     AS batches
       FROM batches
       WHERE created_at::date = CURRENT_DATE
       GROUP BY worker
       ORDER BY SUM(earnings) DESC`
    ),
  ]);

  const salesItems = salesResult.rows;
  const totalUzs = salesItems
    .filter((s) => s.currency === "uzs" || !s.currency)
    .reduce((acc, s) => acc + Number(s.total_amount), 0);
  const totalUsd = salesItems
    .filter((s) => s.currency === "usd")
    .reduce((acc, s) => acc + Number(s.total_amount), 0);

  res.json({
    todaySales: {
      count: salesItems.length,
      totalUzs,
      totalUsd,
      items: salesItems.map((s) => ({
        id: s.id,
        customerName: s.customer_name,
        product: s.product,
        quantity: s.quantity,
        weightKg: Number(s.weight_kg),
        totalAmount: Number(s.total_amount),
        currency: s.currency ?? "uzs",
        status: s.status,
        createdAt: s.created_at instanceof Date ? s.created_at.toISOString() : String(s.created_at),
      })),
    },
    todayBatches: {
      items: batchesResult.rows.map((r) => ({
        worker: r.worker,
        qty: Number(r.qty),
        kg: Number(r.kg),
        earnings: Number(r.earnings),
        batches: Number(r.batches),
      })),
    },
  });
});

export default router;
