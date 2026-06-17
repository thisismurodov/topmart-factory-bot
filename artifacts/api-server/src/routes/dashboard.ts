import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getUsdToUzsRate } from "../lib/exchangeRate";
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
       COUNT(DISTINCT batch_code)::int AS "totalBatches",
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
         COUNT(DISTINCT batch_code)::int AS "totalBatches",
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

router.get("/dashboard/v2", async (_req, res): Promise<void> => {
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const { rate } = await getUsdToUzsRate();

  const [
    todaySalesRes,
    monthlySalesRes,
    customersRes,
    inventoryRes,
    todayProdRes,
    topWorkersRes,
    topProductsRes,
    feedBatchRes,
    feedSaleRes,
    feedCustomerRes,
    profitabilityRes,
  ] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(DISTINCT s.id)::int AS count,
         COALESCE(SUM(CASE WHEN LOWER(si.currency)='uzs' THEN si.line_total ELSE 0 END),0) AS total_uzs,
         COALESCE(SUM(CASE WHEN LOWER(si.currency)='usd' THEN si.line_total ELSE 0 END),0) AS total_usd
       FROM sales s
       LEFT JOIN sale_items si ON si.sale_id = s.id
       WHERE s.created_at::date = CURRENT_DATE`
    ),
    pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN LOWER(si.currency)='uzs' THEN si.line_total ELSE 0 END),0) AS total_uzs,
         COALESCE(SUM(CASE WHEN LOWER(si.currency)='usd' THEN si.line_total ELSE 0 END),0) AS total_usd,
         COUNT(DISTINCT s.id)::int AS count
       FROM sales s
       LEFT JOIN sale_items si ON si.sale_id = s.id
       WHERE TO_CHAR(s.created_at,'YYYY-MM') = $1`,
      [period]
    ),
    pool.query(
      `SELECT
         COUNT(*)::int                                                         AS total,
         COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE)::int         AS today,
         COUNT(*) FILTER (WHERE TO_CHAR(created_at,'YYYY-MM') = $1)::int      AS monthly
       FROM customers`,
      [period]
    ),
    pool.query(
      `SELECT
         product,
         COALESCE(SUM(quantity),0)::int      AS produced_qty,
         COALESCE(SUM(weight_kg),0.0)        AS produced_kg,
         COALESCE(
           (SELECT SUM(s.quantity) FROM sales s WHERE s.product = b.product),0
         )::int                             AS sold_qty,
         COALESCE(
           (SELECT SUM(s.weight_kg) FROM sales s WHERE s.product = b.product),0
         )                                  AS sold_kg
       FROM batches b
       GROUP BY product
       UNION
       SELECT
         product,
         0,0,
         COALESCE(SUM(quantity),0)::int,
         COALESCE(SUM(weight_kg),0.0)
       FROM sales
       WHERE product NOT IN (SELECT DISTINCT product FROM batches)
       GROUP BY product`
    ),
    pool.query(
      `SELECT
         COUNT(DISTINCT batch_code)::int     AS batches,
         COALESCE(SUM(quantity),0)::int      AS qty,
         COALESCE(SUM(weight_kg),0.0)        AS kg,
         COALESCE(SUM(earnings),0.0)         AS earnings,
         COUNT(DISTINCT worker)::int         AS worker_count
       FROM batches WHERE created_at::date = CURRENT_DATE`
    ),
    pool.query(
      `SELECT worker,
         COALESCE(SUM(quantity),0)::int   AS qty,
         COALESCE(SUM(earnings),0.0)      AS earnings,
         COUNT(DISTINCT batch_code)::int  AS batches
       FROM batches WHERE TO_CHAR(created_at,'YYYY-MM')=$1
       GROUP BY worker ORDER BY SUM(earnings) DESC LIMIT 5`,
      [period]
    ),
    pool.query(
      `SELECT product_name AS product, COALESCE(SUM(quantity),0)::int AS sold_qty
       FROM sale_items GROUP BY product_name ORDER BY SUM(quantity) DESC LIMIT 5`
    ),
    pool.query(
      `SELECT worker AS actor, product, quantity, created_at
       FROM batches ORDER BY id DESC LIMIT 6`
    ),
    pool.query(
      `SELECT s.customer_name AS actor,
              COALESCE((SELECT string_agg(si.product_name,', ') FROM sale_items si WHERE si.sale_id=s.id LIMIT 3), s.product, 'Savdo') AS product,
              s.total_amount, s.currency, s.created_at
       FROM sales s ORDER BY s.id DESC LIMIT 6`
    ),
    pool.query(
      `SELECT name AS actor, created_at
       FROM customers ORDER BY id DESC LIMIT 4`
    ),
    pool.query(`
      WITH enriched AS (
        -- narx/xarajatlar 1 birlik uchun → og'irlikka ko'paytiramiz; xom ashyo (BOM) mutlaq.
        -- USD narx/xom ashyo jonli kursda ($1) UZS'ga aylantiriladi — foyda/margin UZS'da izchil.
        SELECT
          p.name,
          CASE WHEN p.unit_type='kg'
            THEN p.default_sale_price * COALESCE(NULLIF(p.weight, 0), 1)
            ELSE p.default_sale_price END
            * CASE WHEN UPPER(p.currency_type)='USD' THEN $1::numeric ELSE 1 END AS sale_price,
          ((CASE WHEN p.rate_type='kg' THEN p.rate * COALESCE(NULLIF(p.weight, 0), 1) ELSE p.rate END)
            + CASE WHEN p.unit_type='kg'
                THEN (p.electricity_cost + p.other_cost) * COALESCE(NULLIF(p.weight, 0), 1)
                ELSE (p.electricity_cost + p.other_cost) END) +
            COALESCE((
              SELECT SUM(rm.default_cost * pm.quantity_required * CASE WHEN UPPER(rm.currency)='USD' THEN $1::numeric ELSE 1 END)
              FROM product_materials pm
              JOIN raw_materials rm ON rm.id = pm.raw_material_id
              WHERE pm.product_name = p.name
            ), 0) AS total_cost,
          COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='uzs'), 0) AS revenue_uzs,
          COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='usd'), 0) AS revenue_usd
        FROM products p
        LEFT JOIN sale_items si ON si.product_name = p.name
        WHERE p.active = TRUE AND p.default_sale_price > 0
        GROUP BY p.name, p.unit_type, p.default_sale_price, p.weight, p.rate, p.rate_type, p.electricity_cost, p.other_cost, p.currency_type
      )
      SELECT name, sale_price, total_cost,
             (sale_price - total_cost) AS profit,
             CASE WHEN sale_price > 0
               THEN ROUND((sale_price - total_cost) / sale_price * 100, 2)
               ELSE 0 END AS margin_pct,
             revenue_uzs, revenue_usd
      FROM enriched
      ORDER BY profit DESC
    `, [rate]),
  ]);

  // Inventory: merge produced vs sold
  const invMap: Record<string, { product: string; stockQty: number; stockKg: number }> = {};
  for (const r of inventoryRes.rows) {
    const key = r.product;
    if (!invMap[key]) invMap[key] = { product: key, stockQty: 0, stockKg: 0 };
    invMap[key].stockQty += Number(r.produced_qty) - Number(r.sold_qty);
    invMap[key].stockKg  += Number(r.produced_kg)  - Number(r.sold_kg);
  }
  const inventoryItems = Object.values(invMap);
  const lowStockItems  = inventoryItems.filter((i) => i.stockQty < 50 && i.stockQty >= 0).sort((a, b) => a.stockQty - b.stockQty);

  // Live feed: merge and sort
  type FeedItem = { time: string; type: string; actor: string; description: string };
  const feed: FeedItem[] = [
    ...feedBatchRes.rows.map((r) => ({
      time: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at)).toISOString(),
      type: "batch",
      actor: r.actor,
      description: `${r.quantity} dona ${r.product} partiya yaratdi`,
    })),
    ...feedSaleRes.rows.map((r) => ({
      time: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at)).toISOString(),
      type: "sale",
      actor: r.actor,
      description: `${r.currency === "usd" ? "$" : ""}${Number(r.total_amount).toLocaleString("en-US")} ${r.currency === "usd" ? "" : "so'm"} savdo`,
    })),
    ...feedCustomerRes.rows.map((r) => ({
      time: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at)).toISOString(),
      type: "customer",
      actor: r.actor,
      description: "yangi mijoz qo'shildi",
    })),
  ];
  feed.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  const ts = todaySalesRes.rows[0];
  const ms = monthlySalesRes.rows[0];
  const cu = customersRes.rows[0];
  const tp = todayProdRes.rows[0];

  res.json({
    todaySalesUzs:        Number(ts.total_uzs),
    todaySalesUsd:        Number(ts.total_usd),
    todaySalesCount:      Number(ts.count),
    monthlySalesUzs:      Number(ms.total_uzs),
    monthlySalesUsd:      Number(ms.total_usd),
    monthlySalesCount:    Number(ms.count),
    totalCustomers:       Number(cu.total),
    todayNewCustomers:    Number(cu.today),
    monthlyNewCustomers:  Number(cu.monthly),
    inventorySkuCount:    inventoryItems.length,
    totalStockQty:        inventoryItems.reduce((s, i) => s + i.stockQty, 0),
    lowStockItems:        lowStockItems.slice(0, 5),
    inventoryItems:       inventoryItems,
    todayBatches:         Number(tp.batches),
    todayQty:             Number(tp.qty),
    todayKg:              Number(tp.kg),
    todayEarnings:        Number(tp.earnings),
    todayWorkerCount:     Number(tp.worker_count),
    topWorkers:           topWorkersRes.rows.map((r) => ({ worker: r.worker, qty: Number(r.qty), earnings: Number(r.earnings), batches: Number(r.batches) })),
    topProducts:          topProductsRes.rows.map((r) => ({ product: r.product, soldQty: Number(r.sold_qty) })),
    liveFeed:             feed.slice(0, 10),
    mostProfitableProduct: profitabilityRes.rows.length > 0
      ? { name: profitabilityRes.rows[0].name, profit: Number(profitabilityRes.rows[0].profit), marginPct: Number(profitabilityRes.rows[0].margin_pct) }
      : null,
    highestRevenueProduct: profitabilityRes.rows.length > 0
      ? (() => { const sorted = [...profitabilityRes.rows].sort((a,b) => Number(b.revenue_uzs) - Number(a.revenue_uzs)); return { name: sorted[0].name, revenueUzs: Number(sorted[0].revenue_uzs), revenueUsd: Number(sorted[0].revenue_usd) }; })()
      : null,
    highestMarginProduct: profitabilityRes.rows.length > 0
      ? (() => { const sorted = [...profitabilityRes.rows].sort((a,b) => Number(b.margin_pct) - Number(a.margin_pct)); return { name: sorted[0].name, marginPct: Number(sorted[0].margin_pct) }; })()
      : null,
    lowestMarginProduct: profitabilityRes.rows.length > 0
      ? (() => { const sorted = [...profitabilityRes.rows].sort((a,b) => Number(a.margin_pct) - Number(b.margin_pct)); return { name: sorted[0].name, marginPct: Number(sorted[0].margin_pct) }; })()
      : null,
  });
});

router.get("/dashboard/product-highlights", async (_req, res): Promise<void> => {
  const { rate } = await getUsdToUzsRate();
  // USD narx/xom ashyo jonli kursda ($1) UZS'ga aylantiriladi — foyda/margin UZS'da izchil.
  const { rows } = await pool.query(`
    SELECT
      p.name,
      CASE WHEN p.unit_type='kg'
        THEN p.default_sale_price * COALESCE(NULLIF(p.weight, 0), 1)
        ELSE p.default_sale_price END
        * CASE WHEN UPPER(p.currency_type)='USD' THEN $1::numeric ELSE 1 END AS sale_price,
      ((CASE WHEN p.rate_type='kg' THEN p.rate * COALESCE(NULLIF(p.weight, 0), 1) ELSE p.rate END)
        + CASE WHEN p.unit_type='kg'
            THEN (p.electricity_cost + p.other_cost) * COALESCE(NULLIF(p.weight, 0), 1)
            ELSE (p.electricity_cost + p.other_cost) END) +
        COALESCE((
          SELECT SUM(rm.default_cost * pm.quantity_required * CASE WHEN UPPER(rm.currency)='USD' THEN $1::numeric ELSE 1 END)
          FROM product_materials pm
          JOIN raw_materials rm ON rm.id = pm.raw_material_id
          WHERE pm.product_name = p.name
        ), 0) AS total_cost,
      COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='uzs'), 0) AS revenue_uzs,
      COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='usd'), 0) AS revenue_usd,
      COALESCE(SUM(si.quantity), 0) AS units_sold
    FROM products p
    LEFT JOIN sale_items si ON si.product_name = p.name
    WHERE p.active = TRUE AND p.default_sale_price > 0
    GROUP BY p.name, p.unit_type, p.default_sale_price, p.weight,
             p.rate, p.rate_type, p.electricity_cost, p.other_cost, p.currency_type
  `, [rate]);

  if (!rows.length) {
    res.json({ mostProfitable: null, highestRevenue: null, highestMargin: null, lowestMargin: null });
    return;
  }

  const enriched = rows.map(r => {
    const cost   = Number(r.total_cost);
    const price  = Number(r.sale_price);
    const profit = price - cost;
    const margin = price > 0 ? (profit / price) * 100 : 0;
    return { name: r.name, profit, margin, revenueUzs: Number(r.revenue_uzs), revenueUsd: Number(r.revenue_usd) };
  });

  const byProfit  = [...enriched].sort((a, b) => b.profit  - a.profit);
  const byRevenue = [...enriched].sort((a, b) => b.revenueUzs - a.revenueUzs);
  const byMargin  = [...enriched].sort((a, b) => b.margin  - a.margin);

  res.json({
    mostProfitable: byProfit[0]  ?? null,
    highestRevenue: byRevenue[0] ?? null,
    highestMargin:  byMargin[0]  ?? null,
    lowestMargin:   byMargin[byMargin.length - 1] ?? null,
  });
});

router.get("/dashboard/today-extended", async (_req, res): Promise<void> => {
  const [salesResult, batchesResult] = await Promise.all([
    pool.query(
      `SELECT s.id, s.customer_name, s.status, s.created_at,
              COALESCE(SUM(CASE WHEN LOWER(si.currency)='uzs' THEN si.line_total ELSE 0 END),0) AS total_uzs,
              COALESCE(SUM(CASE WHEN LOWER(si.currency)='usd' THEN si.line_total ELSE 0 END),0) AS total_usd
       FROM sales s
       LEFT JOIN sale_items si ON si.sale_id = s.id
       WHERE s.created_at::date = CURRENT_DATE
       GROUP BY s.id, s.customer_name, s.status, s.created_at
       ORDER BY s.id DESC
       LIMIT 10`
    ),
    pool.query(
      `SELECT
         worker,
         COALESCE(SUM(quantity), 0)::int   AS qty,
         COALESCE(SUM(weight_kg), 0.0)     AS kg,
         COALESCE(SUM(earnings), 0.0)      AS earnings,
         COUNT(DISTINCT batch_code)::int   AS batches
       FROM batches
       WHERE created_at::date = CURRENT_DATE
       GROUP BY worker
       ORDER BY SUM(earnings) DESC`
    ),
  ]);

  const salesItems = salesResult.rows;
  const totalUzs = salesItems.reduce((acc, s) => acc + Number(s.total_uzs), 0);
  const totalUsd = salesItems.reduce((acc, s) => acc + Number(s.total_usd), 0);

  res.json({
    todaySales: {
      count: salesItems.length,
      totalUzs,
      totalUsd,
      items: salesItems.map((s) => ({
        id: s.id,
        customerName: s.customer_name,
        totalUzs: Number(s.total_uzs),
        totalUsd: Number(s.total_usd),
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
