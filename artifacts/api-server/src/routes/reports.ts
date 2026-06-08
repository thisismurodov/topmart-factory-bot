import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

// ── GET /reports/summary?months=6 ─────────────────────────────────────────────
router.get("/reports/summary", async (req, res): Promise<void> => {
  const months = Math.min(Math.max(parseInt((req.query.months as string) ?? "6"), 1), 24);
  const interval = `${months - 1} months`;

  const [salesRes, productionRes, salaryRes, topCustomersRes, topWorkersRes, topProductsRes] =
    await Promise.all([

      // Sales by month
      pool.query(`
        SELECT
          TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM')      AS month,
          COALESCE(SUM(total_amount) FILTER (WHERE UPPER(currency)='USD'), 0) AS sales_usd,
          COALESCE(SUM(total_amount) FILTER (WHERE UPPER(currency)='UZS'), 0) AS sales_uzs,
          COALESCE(SUM(paid_amount)  FILTER (WHERE UPPER(currency)='USD'), 0) AS paid_usd,
          COALESCE(SUM(paid_amount)  FILTER (WHERE UPPER(currency)='UZS'), 0) AS paid_uzs,
          COALESCE(SUM(debt_amount)  FILTER (WHERE UPPER(currency)='USD'), 0) AS debt_usd,
          COALESCE(SUM(debt_amount)  FILTER (WHERE UPPER(currency)='UZS'), 0) AS debt_uzs,
          COUNT(*)::int                                              AS sale_count,
          COUNT(*) FILTER (WHERE status='paid')::int                AS paid_count,
          COUNT(*) FILTER (WHERE status='pending')::int             AS pending_count
        FROM sales
        WHERE created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '${interval}'
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY DATE_TRUNC('month', created_at)
      `),

      // Production (batches) by month
      pool.query(`
        SELECT
          TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
          COUNT(*)::int                                        AS batch_count,
          COALESCE(SUM(weight_kg),  0)                        AS total_weight,
          COALESCE(SUM(earnings),   0)                        AS total_earnings,
          COUNT(DISTINCT worker)::int                         AS worker_count
        FROM batches
        WHERE created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '${interval}'
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY DATE_TRUNC('month', created_at)
      `),

      // Salary payments by month
      pool.query(`
        SELECT
          year,
          month,
          COALESCE(SUM(amount), 0)       AS total_paid,
          COUNT(DISTINCT worker)::int    AS worker_count
        FROM salary_payments
        GROUP BY year, month
        ORDER BY year, month
      `),

      // Top customers (by period)
      pool.query(`
        SELECT
          customer_name,
          COALESCE(SUM(total_amount) FILTER (WHERE UPPER(currency)='USD'), 0) AS total_usd,
          COALESCE(SUM(total_amount) FILTER (WHERE UPPER(currency)='UZS'), 0) AS total_uzs,
          COUNT(*)::int AS sale_count
        FROM sales
        WHERE created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '${interval}'
        GROUP BY customer_name
        ORDER BY total_usd DESC, total_uzs DESC
        LIMIT 8
      `),

      // Top workers by earnings
      pool.query(`
        SELECT
          worker,
          COALESCE(SUM(earnings), 0) AS total_earnings,
          COUNT(*)::int              AS batch_count,
          COALESCE(SUM(weight_kg), 0) AS total_weight
        FROM batches
        WHERE created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '${interval}'
        GROUP BY worker
        ORDER BY total_earnings DESC
        LIMIT 8
      `),

      // Top products by batch count
      pool.query(`
        SELECT
          product,
          COUNT(*)::int               AS batch_count,
          COALESCE(SUM(weight_kg), 0) AS total_weight,
          COALESCE(SUM(earnings), 0)  AS total_earnings
        FROM batches
        WHERE created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '${interval}'
        GROUP BY product
        ORDER BY batch_count DESC
        LIMIT 8
      `),
    ]);

  res.json({
    months,
    salesByMonth: salesRes.rows.map((r) => ({
      month:        r.month,
      salesUsd:     Number(r.sales_usd),
      salesUzs:     Number(r.sales_uzs),
      paidUsd:      Number(r.paid_usd),
      paidUzs:      Number(r.paid_uzs),
      debtUsd:      Number(r.debt_usd),
      debtUzs:      Number(r.debt_uzs),
      saleCount:    r.sale_count,
      paidCount:    r.paid_count,
      pendingCount: r.pending_count,
    })),
    productionByMonth: productionRes.rows.map((r) => ({
      month:          r.month,
      batchCount:     r.batch_count,
      totalWeight:    Number(r.total_weight),
      totalEarnings:  Number(r.total_earnings),
      workerCount:    r.worker_count,
    })),
    salaryByMonth: salaryRes.rows.map((r) => ({
      month:       `${r.year}-${String(r.month).padStart(2, "0")}`,
      totalPaid:   Number(r.total_paid),
      workerCount: r.worker_count,
    })),
    topCustomers: topCustomersRes.rows.map((r) => ({
      customerName: r.customer_name,
      totalUsd:     Number(r.total_usd),
      totalUzs:     Number(r.total_uzs),
      saleCount:    r.sale_count,
    })),
    topWorkers: topWorkersRes.rows.map((r) => ({
      worker:         r.worker,
      totalEarnings:  Number(r.total_earnings),
      batchCount:     r.batch_count,
      totalWeight:    Number(r.total_weight),
    })),
    topProducts: topProductsRes.rows.map((r) => ({
      product:        r.product,
      batchCount:     r.batch_count,
      totalWeight:    Number(r.total_weight),
      totalEarnings:  Number(r.total_earnings),
    })),
  });
});

export default router;
