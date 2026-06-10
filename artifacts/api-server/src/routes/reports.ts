import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

// ── GET /reports/summary?months=6 ─────────────────────────────────────────────
router.get("/reports/summary", async (req, res): Promise<void> => {
  const months = Math.min(Math.max(parseInt((req.query.months as string) ?? "6"), 1), 24);
  const interval = `${months - 1} months`;

  const [salesRes, productionRes, salaryRes, topCustomersRes, topWorkersRes, topProductsRes] =
    await Promise.all([

      // Sales by month — totals from sale_items (accurate per-currency), stats from sales
      pool.query(`
        WITH item_totals AS (
          SELECT
            DATE_TRUNC('month', s.created_at) AS month,
            COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='usd'), 0) AS sales_usd,
            COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='uzs'), 0) AS sales_uzs
          FROM sales s
          JOIN sale_items si ON si.sale_id = s.id
          WHERE s.created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '${interval}'
          GROUP BY 1
        ),
        sale_stats AS (
          SELECT
            DATE_TRUNC('month', created_at) AS month,
            COALESCE(SUM(paid_amount)  FILTER (WHERE LOWER(currency)='usd'), 0) AS paid_usd,
            COALESCE(SUM(paid_amount)  FILTER (WHERE LOWER(currency)='uzs'), 0) AS paid_uzs,
            COALESCE(SUM(
              CASE WHEN debt_amount > 0 THEN debt_amount
                   WHEN status IN ('pending','partial') THEN GREATEST(0, total_amount - COALESCE(paid_amount,0))
                   ELSE 0 END
            ) FILTER (WHERE LOWER(currency)='usd'), 0) AS debt_usd,
            COALESCE(SUM(
              CASE WHEN debt_amount > 0 THEN debt_amount
                   WHEN status IN ('pending','partial') THEN GREATEST(0, total_amount - COALESCE(paid_amount,0))
                   ELSE 0 END
            ) FILTER (WHERE LOWER(currency)='uzs'), 0) AS debt_uzs,
            COUNT(*)::int                                    AS sale_count,
            COUNT(*) FILTER (WHERE status='paid')::int      AS paid_count,
            COUNT(*) FILTER (WHERE status='pending')::int   AS pending_count
          FROM sales
          WHERE created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '${interval}'
          GROUP BY 1
        )
        SELECT
          TO_CHAR(ss.month, 'YYYY-MM')      AS month,
          COALESCE(it.sales_usd, 0)         AS sales_usd,
          COALESCE(it.sales_uzs, 0)         AS sales_uzs,
          ss.paid_usd, ss.paid_uzs,
          ss.debt_usd, ss.debt_uzs,
          ss.sale_count, ss.paid_count, ss.pending_count
        FROM sale_stats ss
        LEFT JOIN item_totals it USING (month)
        ORDER BY ss.month
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

      // Top customers — use sale_items for accurate per-currency totals
      pool.query(`
        SELECT
          s.customer_name,
          COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='usd'), 0) AS total_usd,
          COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='uzs'), 0) AS total_uzs,
          COUNT(DISTINCT s.id)::int AS sale_count
        FROM sales s
        JOIN sale_items si ON si.sale_id = s.id
        WHERE s.created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '${interval}'
        GROUP BY s.customer_name
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
