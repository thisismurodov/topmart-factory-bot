import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getUsdToUzsRate } from "../lib/exchangeRate";

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
          COUNT(DISTINCT batch_code)::int                      AS batch_count,
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
          COUNT(DISTINCT batch_code)::int AS batch_count,
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

// ── GET /reports/product-profitability ───────────────────────────────────────
router.get("/reports/product-profitability", async (req, res): Promise<void> => {
  const sortBy = (req.query.sortBy as string) ?? "profit";

  const orderMap: Record<string, string> = {
    profit:    "profit DESC",
    margin:    "margin_pct DESC",
    low_margin:"margin_pct ASC",
    sold:      "units_sold DESC",
    revenue:   "revenue_uzs DESC",
  };
  const orderClause = orderMap[sortBy] ?? "profit DESC";
  const { rate } = await getUsdToUzsRate();

  const { rows } = await pool.query(`
    WITH base AS (
      SELECT
        p.name,
        p.sku,
        p.unit_type,
        p.currency_type,
        p.default_sale_price,
        COALESCE(NULLIF(p.weight, 0), 1) AS weight,
        p.rate,
        p.rate_type,
        p.electricity_cost,
        p.other_cost,
        COALESCE((
          SELECT SUM(rm.default_cost * pm.quantity_required * CASE WHEN UPPER(rm.currency)='USD' THEN $1::numeric ELSE 1 END)
          FROM product_materials pm
          JOIN raw_materials rm ON rm.id = pm.raw_material_id
          WHERE pm.product_name = p.name
        ), 0) AS raw_material_cost,
        COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='uzs'), 0) AS revenue_uzs,
        COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='usd'), 0) AS revenue_usd,
        COALESCE(SUM(si.quantity), 0) AS units_sold
      FROM products p
      LEFT JOIN sale_items si ON si.product_name = p.name
      WHERE p.active = TRUE
      GROUP BY p.name, p.sku, p.unit_type, p.currency_type,
               p.default_sale_price, p.weight, p.rate, p.rate_type, p.electricity_cost, p.other_cost
    ),
    enriched AS (
      -- mehnat stavkadan (kg → rate×og'irlik, dona → rate); elektr/boshqa × og'irlik; xom ashyo mutlaq
      -- USD narxli mahsulot sotuv narxi jonli kursda ($1) UZS'ga aylantiriladi;
      -- barcha xarajatlar UZS'da, foyda/margin izchil UZS'da hisoblanadi.
      SELECT *,
        (default_sale_price * weight * CASE WHEN UPPER(currency_type)='USD' THEN $1::numeric ELSE 1 END
          - (CASE WHEN rate_type='kg' THEN rate * weight ELSE rate END)
          - (electricity_cost + other_cost) * weight
          - raw_material_cost) AS profit,
        CASE WHEN default_sale_price * weight * CASE WHEN UPPER(currency_type)='USD' THEN $1::numeric ELSE 1 END > 0
          THEN (default_sale_price * weight * CASE WHEN UPPER(currency_type)='USD' THEN $1::numeric ELSE 1 END
                - (CASE WHEN rate_type='kg' THEN rate * weight ELSE rate END)
                - (electricity_cost + other_cost) * weight
                - raw_material_cost)
               / (default_sale_price * weight * CASE WHEN UPPER(currency_type)='USD' THEN $1::numeric ELSE 1 END) * 100
          ELSE 0 END AS margin_pct
      FROM base
    )
    SELECT * FROM enriched ORDER BY ${orderClause}
  `, [rate]);

  res.json(rows.map(r => {
    const w         = Number(r.weight) > 0 ? Number(r.weight) : 1;
    const rawCost   = Number(r.raw_material_cost);
    const laborCost       = String(r.rate_type) === "kg" ? Number(r.rate) * w : Number(r.rate);
    const electricityCost = Number(r.electricity_cost) * w;
    const otherCost       = Number(r.other_cost) * w;
    const saleRate        = String(r.currency_type) === "USD" ? rate : 1;
    const salePrice       = Number(r.default_sale_price) * saleRate * w;
    const totalCost = rawCost + laborCost + electricityCost + otherCost;
    const profit    = salePrice - totalCost;
    const marginPct = salePrice > 0 ? Math.round((profit / salePrice) * 10000) / 100 : 0;
    return {
      name:            r.name,
      sku:             r.sku,
      unitType:        r.unit_type,
      currencyType:    r.currency_type,
      weight:          w,
      salePrice,
      rawMaterialCost: rawCost,
      salaryCost:      laborCost,
      electricityCost,
      otherCost,
      totalCost,
      profit,
      marginPct,
      revenueUzs:      Number(r.revenue_uzs),
      revenueUsd:      Number(r.revenue_usd),
      unitsSold:       Number(r.units_sold),
    };
  }));
});

export default router;
