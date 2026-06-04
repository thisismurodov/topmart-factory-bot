import { Router, type IRouter } from "express";
import { getDb } from "../lib/sqlite";
import {
  GetDashboardTodayResponse,
  GetDashboardMonthlyQueryParams,
  GetDashboardMonthlyResponse,
  GetTopWorkersResponse,
  GetDailyChartResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/dashboard/today", (_req, res): void => {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const result = db
    .prepare(
      `SELECT
         COUNT(*) AS totalBatches,
         COALESCE(SUM(quantity), 0) AS totalQty,
         COALESCE(SUM(weight_kg), 0.0) AS totalKg,
         COALESCE(SUM(earnings), 0.0) AS totalEarnings,
         COUNT(DISTINCT worker) AS workerCount
       FROM batches
       WHERE DATE(created_at) = ?`
    )
    .get(today) as any;

  res.json(
    GetDashboardTodayResponse.parse({
      totalBatches: result?.totalBatches ?? 0,
      totalQty: result?.totalQty ?? 0,
      totalKg: Number(result?.totalKg ?? 0),
      totalEarnings: Number(result?.totalEarnings ?? 0),
      workerCount: result?.workerCount ?? 0,
    })
  );
});

router.get("/dashboard/monthly", (req, res): void => {
  const now = new Date();
  const parsed = GetDashboardMonthlyQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const year = parsed.data.year ?? now.getFullYear();
  const month = parsed.data.month ?? now.getMonth() + 1;
  const period = `${year}-${String(month).padStart(2, "0")}`;

  const db = getDb();

  const production = db
    .prepare(
      `SELECT
         COUNT(*) AS totalBatches,
         COALESCE(SUM(quantity), 0) AS totalQty,
         COALESCE(SUM(weight_kg), 0.0) AS totalKg,
         COALESCE(SUM(earnings), 0.0) AS totalEarnings
       FROM batches
       WHERE strftime('%Y-%m', created_at) = ?`
    )
    .get(period) as any;

  const workers = db
    .prepare(
      `SELECT DISTINCT worker FROM batches WHERE strftime('%Y-%m', created_at) = ?`
    )
    .all(period) as any[];

  const payments = db
    .prepare(
      `SELECT worker_name FROM salary_payments WHERE year = ? AND month = ?`
    )
    .all(year, month) as any[];

  const paidSet = new Set(payments.map((p: any) => p.worker_name));
  const unpaidWorkers = workers.filter((w) => !paidSet.has(w.worker));

  const unpaidEarnings = db
    .prepare(
      `SELECT COALESCE(SUM(earnings), 0.0) AS total
       FROM batches
       WHERE strftime('%Y-%m', created_at) = ?
         AND worker NOT IN (
           SELECT worker_name FROM salary_payments WHERE year = ? AND month = ?
         )`
    )
    .get(period, year, month) as any;

  res.json(
    GetDashboardMonthlyResponse.parse({
      totalBatches: production?.totalBatches ?? 0,
      totalQty: production?.totalQty ?? 0,
      totalKg: Number(production?.totalKg ?? 0),
      totalEarnings: Number(production?.totalEarnings ?? 0),
      paidCount: paidSet.size,
      unpaidCount: unpaidWorkers.length,
      unpaidAmount: Number(unpaidEarnings?.total ?? 0),
    })
  );
});

router.get("/dashboard/top-workers", (_req, res): void => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const period = `${year}-${String(month).padStart(2, "0")}`;

  const db = getDb();
  const results = db
    .prepare(
      `SELECT
         worker,
         COALESCE(SUM(quantity), 0) AS totalQty,
         COALESCE(SUM(weight_kg), 0.0) AS totalKg,
         COALESCE(SUM(earnings), 0.0) AS totalEarnings
       FROM batches
       WHERE strftime('%Y-%m', created_at) = ?
       GROUP BY worker
       ORDER BY SUM(earnings) DESC
       LIMIT 10`
    )
    .all(period) as any[];

  res.json(
    GetTopWorkersResponse.parse(
      results.map((r) => ({
        worker: r.worker,
        totalQty: r.totalQty,
        totalKg: Number(r.totalKg),
        totalEarnings: Number(r.totalEarnings),
      }))
    )
  );
});

router.get("/dashboard/daily-chart", (_req, res): void => {
  const db = getDb();
  const results = db
    .prepare(
      `SELECT
         DATE(created_at) AS date,
         COALESCE(SUM(quantity), 0) AS qty,
         COALESCE(SUM(weight_kg), 0.0) AS kg,
         COALESCE(SUM(earnings), 0.0) AS earnings
       FROM batches
       WHERE created_at >= datetime('now', '-30 days')
       GROUP BY DATE(created_at)
       ORDER BY DATE(created_at) ASC`
    )
    .all() as any[];

  res.json(
    GetDailyChartResponse.parse(
      results.map((r) => ({
        date: r.date,
        qty: r.qty,
        kg: Number(r.kg),
        earnings: Number(r.earnings),
      }))
    )
  );
});

export default router;
