import { Router, type IRouter } from "express";
import { db, batchesTable, salaryPaymentsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
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

  // Earnings per worker this month
  const earnings = await db
    .select({
      worker: batchesTable.worker,
      totalEarnings: sql<number>`COALESCE(SUM(${batchesTable.earnings}::numeric), 0)::float`,
    })
    .from(batchesTable)
    .where(
      and(
        sql`EXTRACT(YEAR FROM ${batchesTable.createdAt}) = ${year}`,
        sql`EXTRACT(MONTH FROM ${batchesTable.createdAt}) = ${month}`
      )
    )
    .groupBy(batchesTable.worker);

  // Which workers are paid this month
  const payments = await db
    .select()
    .from(salaryPaymentsTable)
    .where(
      and(
        eq(salaryPaymentsTable.year, year),
        eq(salaryPaymentsTable.month, month)
      )
    );

  const paidMap = new Map(payments.map((p) => [p.worker, p]));

  const rows = earnings.map((e) => {
    const payment = paidMap.get(e.worker);
    return {
      worker: e.worker,
      totalEarnings: Number(e.totalEarnings),
      isPaid: !!payment,
      paidAt: payment?.paidAt?.toISOString() ?? null,
    };
  });

  res.json(GetSalaryReportResponse.parse(rows));
});

router.post("/salary/pay", async (req, res): Promise<void> => {
  const parsed = MarkSalaryPaidBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { worker, year, month, amount } = parsed.data;

  // Upsert — delete existing then insert
  await db
    .delete(salaryPaymentsTable)
    .where(
      and(
        eq(salaryPaymentsTable.worker, worker),
        eq(salaryPaymentsTable.year, year),
        eq(salaryPaymentsTable.month, month)
      )
    );

  await db.insert(salaryPaymentsTable).values({
    worker,
    year,
    month,
    amount: String(amount),
  });

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
