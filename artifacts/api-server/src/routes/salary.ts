import { Router, type IRouter } from "express";
import { getDb } from "../lib/sqlite";
import {
  GetSalaryReportQueryParams,
  GetSalaryReportResponse,
  MarkSalaryPaidBody,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/salary/report", (req, res): void => {
  const now = new Date();
  const parsed = GetSalaryReportQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const year = parsed.data.year ?? now.getFullYear();
  const month = parsed.data.month ?? now.getMonth() + 1;
  const period = `${year}-${String(month).padStart(2, "0")}`;

  const db = getDb();

  // Earnings per worker this month from batches
  const earnings = db
    .prepare(
      `SELECT worker, COALESCE(SUM(earnings), 0.0) AS totalEarnings
       FROM batches
       WHERE strftime('%Y-%m', created_at) = ?
       GROUP BY worker
       ORDER BY worker`
    )
    .all(period) as any[];

  // Payment records for this month
  const payments = db
    .prepare(
      `SELECT worker_name, paid_at FROM salary_payments WHERE year = ? AND month = ?`
    )
    .all(year, month) as any[];

  const paidMap = new Map(payments.map((p: any) => [p.worker_name, p.paid_at]));

  const rows = earnings.map((e) => ({
    worker: e.worker,
    totalEarnings: Number(e.totalEarnings),
    isPaid: paidMap.has(e.worker),
    paidAt: paidMap.get(e.worker) ?? null,
  }));

  res.json(GetSalaryReportResponse.parse(rows));
});

router.post("/salary/pay", (req, res): void => {
  const parsed = MarkSalaryPaidBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { worker, year, month, amount } = parsed.data;
  const db = getDb();

  db.prepare(
    `INSERT OR REPLACE INTO salary_payments (worker_name, year, month, amount)
     VALUES (?, ?, ?, ?)`
  ).run(worker, year, month, amount);

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
