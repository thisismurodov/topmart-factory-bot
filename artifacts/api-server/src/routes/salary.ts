import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  GetSalaryReportQueryParams,
  GetSalaryReportResponse,
  MarkSalaryPaidBody,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/salary/report", async (req, res): Promise<void> => {
  const now = new Date();
  const parsed = GetSalaryReportQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const year = parsed.data.year ?? now.getFullYear();
  const month = parsed.data.month ?? now.getMonth() + 1;
  const period = `${year}-${String(month).padStart(2, "0")}`;

  const [earningsResult, paymentsResult] = await Promise.all([
    pool.query(
      `SELECT worker, COALESCE(SUM(earnings), 0.0) AS "totalEarnings"
       FROM batches
       WHERE TO_CHAR(created_at, 'YYYY-MM') = $1
       GROUP BY worker
       ORDER BY worker`,
      [period]
    ),
    pool.query(
      `SELECT worker, paid_at FROM salary_payments WHERE year = $1 AND month = $2`,
      [year, month]
    ),
  ]);

  const paidMap = new Map(paymentsResult.rows.map((p) => [p.worker, p.paid_at]));

  const rows = earningsResult.rows.map((e) => ({
    worker: e.worker,
    totalEarnings: Number(e.totalEarnings),
    isPaid: paidMap.has(e.worker),
    paidAt: paidMap.get(e.worker) ?? null,
  }));

  res.json(GetSalaryReportResponse.parse(rows));
});

router.post("/salary/pay", async (req, res): Promise<void> => {
  const parsed = MarkSalaryPaidBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { worker, year, month, amount } = parsed.data;

  await pool.query(
    `INSERT INTO salary_payments (worker, year, month, amount)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (worker, year, month) DO UPDATE SET amount = $4, paid_at = NOW()`,
    [worker, year, month, amount]
  );

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
