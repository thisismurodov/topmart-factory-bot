import { Router, type IRouter } from "express";
import { db, batchesTable, salaryPaymentsTable } from "@workspace/db";
import { and, sql, desc } from "drizzle-orm";
import {
  GetDashboardTodayResponse,
  GetDashboardMonthlyQueryParams,
  GetDashboardMonthlyResponse,
  GetTopWorkersResponse,
  GetDailyChartResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/dashboard/today", async (_req, res): Promise<void> => {
  const today = new Date().toISOString().slice(0, 10);

  const [result] = await db
    .select({
      totalBatches: sql<number>`COUNT(*)::int`,
      totalQty: sql<number>`COALESCE(SUM(${batchesTable.quantity}), 0)::int`,
      totalKg: sql<number>`COALESCE(SUM(${batchesTable.weightKg}::numeric), 0)::float`,
      totalEarnings: sql<number>`COALESCE(SUM(${batchesTable.earnings}::numeric), 0)::float`,
      workerCount: sql<number>`COUNT(DISTINCT ${batchesTable.worker})::int`,
    })
    .from(batchesTable)
    .where(sql`DATE(${batchesTable.createdAt}) = ${today}`);

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

router.get("/dashboard/monthly", async (req, res): Promise<void> => {
  const now = new Date();
  const parsed = GetDashboardMonthlyQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const year = parsed.data.year ?? now.getFullYear();
  const month = parsed.data.month ?? now.getMonth() + 1;

  const [production] = await db
    .select({
      totalBatches: sql<number>`COUNT(*)::int`,
      totalQty: sql<number>`COALESCE(SUM(${batchesTable.quantity}), 0)::int`,
      totalKg: sql<number>`COALESCE(SUM(${batchesTable.weightKg}::numeric), 0)::float`,
      totalEarnings: sql<number>`COALESCE(SUM(${batchesTable.earnings}::numeric), 0)::float`,
    })
    .from(batchesTable)
    .where(
      and(
        sql`EXTRACT(YEAR FROM ${batchesTable.createdAt}) = ${year}`,
        sql`EXTRACT(MONTH FROM ${batchesTable.createdAt}) = ${month}`
      )
    );

  const workers = await db
    .select({ worker: batchesTable.worker })
    .from(batchesTable)
    .where(
      and(
        sql`EXTRACT(YEAR FROM ${batchesTable.createdAt}) = ${year}`,
        sql`EXTRACT(MONTH FROM ${batchesTable.createdAt}) = ${month}`
      )
    )
    .groupBy(batchesTable.worker);

  const payments = await db
    .select()
    .from(salaryPaymentsTable)
    .where(
      and(
        sql`${salaryPaymentsTable.year} = ${year}`,
        sql`${salaryPaymentsTable.month} = ${month}`
      )
    );

  const paidWorkers = new Set(payments.map((p) => p.worker));
  const unpaidWorkers = workers.filter((w) => !paidWorkers.has(w.worker));
  const unpaidAmount = 0; // Will be computed from earnings in a full impl

  res.json(
    GetDashboardMonthlyResponse.parse({
      totalBatches: production?.totalBatches ?? 0,
      totalQty: production?.totalQty ?? 0,
      totalKg: Number(production?.totalKg ?? 0),
      totalEarnings: Number(production?.totalEarnings ?? 0),
      paidCount: paidWorkers.size,
      unpaidCount: unpaidWorkers.length,
      unpaidAmount,
    })
  );
});

router.get("/dashboard/top-workers", async (_req, res): Promise<void> => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const results = await db
    .select({
      worker: batchesTable.worker,
      totalQty: sql<number>`COALESCE(SUM(${batchesTable.quantity}), 0)::int`,
      totalKg: sql<number>`COALESCE(SUM(${batchesTable.weightKg}::numeric), 0)::float`,
      totalEarnings: sql<number>`COALESCE(SUM(${batchesTable.earnings}::numeric), 0)::float`,
    })
    .from(batchesTable)
    .where(
      and(
        sql`EXTRACT(YEAR FROM ${batchesTable.createdAt}) = ${year}`,
        sql`EXTRACT(MONTH FROM ${batchesTable.createdAt}) = ${month}`
      )
    )
    .groupBy(batchesTable.worker)
    .orderBy(desc(sql`SUM(${batchesTable.earnings}::numeric)`))
    .limit(10);

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

router.get("/dashboard/daily-chart", async (_req, res): Promise<void> => {
  const results = await db
    .select({
      date: sql<string>`DATE(${batchesTable.createdAt})::text`,
      qty: sql<number>`COALESCE(SUM(${batchesTable.quantity}), 0)::int`,
      kg: sql<number>`COALESCE(SUM(${batchesTable.weightKg}::numeric), 0)::float`,
      earnings: sql<number>`COALESCE(SUM(${batchesTable.earnings}::numeric), 0)::float`,
    })
    .from(batchesTable)
    .where(sql`${batchesTable.createdAt} >= NOW() - INTERVAL '30 days'`)
    .groupBy(sql`DATE(${batchesTable.createdAt})`)
    .orderBy(sql`DATE(${batchesTable.createdAt})`);

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
