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
      -- dona (piece) uchun sotuv narxi og'irlikka ko'paytirilmaydi — 1 dona narxi.
      -- kg uchun: narx/kg × og'irlik. USD narx jonli kursda ($1) UZS'ga aylantiriladi.
      SELECT *,
        (CASE WHEN unit_type='kg' THEN default_sale_price * weight ELSE default_sale_price END
          * CASE WHEN UPPER(currency_type)='USD' THEN $1::numeric ELSE 1 END
          - (CASE WHEN rate_type='kg' THEN rate * weight ELSE rate END)
          - CASE WHEN unit_type='kg' THEN (electricity_cost + other_cost) * weight
                                     ELSE (electricity_cost + other_cost) END
          - raw_material_cost) AS profit,
        CASE WHEN CASE WHEN unit_type='kg' THEN default_sale_price * weight ELSE default_sale_price END
                  * CASE WHEN UPPER(currency_type)='USD' THEN $1::numeric ELSE 1 END > 0
          THEN (CASE WHEN unit_type='kg' THEN default_sale_price * weight ELSE default_sale_price END
                  * CASE WHEN UPPER(currency_type)='USD' THEN $1::numeric ELSE 1 END
                  - (CASE WHEN rate_type='kg' THEN rate * weight ELSE rate END)
                  - CASE WHEN unit_type='kg' THEN (electricity_cost + other_cost) * weight
                                             ELSE (electricity_cost + other_cost) END
                  - raw_material_cost)
               / (CASE WHEN unit_type='kg' THEN default_sale_price * weight ELSE default_sale_price END
                    * CASE WHEN UPPER(currency_type)='USD' THEN $1::numeric ELSE 1 END) * 100
          ELSE 0 END AS margin_pct
      FROM base
    )
    SELECT * FROM enriched ORDER BY ${orderClause}
  `, [rate]);

  res.json(rows.map(r => {
    const w         = Number(r.weight) > 0 ? Number(r.weight) : 1;
    const rawCost   = Number(r.raw_material_cost);
    const isKg            = String(r.unit_type) === "kg";
    const laborCost       = String(r.rate_type) === "kg" ? Number(r.rate) * w : Number(r.rate);
    const electricityCost = isKg ? Number(r.electricity_cost) * w : Number(r.electricity_cost);
    const otherCost       = isKg ? Number(r.other_cost) * w : Number(r.other_cost);
    const saleRate        = String(r.currency_type) === "USD" ? rate : 1;
    const salePrice       = Number(r.default_sale_price) * saleRate * (isKg ? w : 1);
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

// ── GET /reports/sales-export?from=&to=&format=csv|xlsx ───────────────────────
router.get("/reports/sales-export", async (req, res): Promise<void> => {
  const from   = (req.query.from as string) || "";
  const to     = (req.query.to   as string) || "";
  const format = ((req.query.format as string) || "csv").toLowerCase();

  const conditions: string[] = [];
  const vals: unknown[] = [];

  if (from) { vals.push(from); conditions.push(`s.created_at::date >= $${vals.length}`); }
  if (to)   { vals.push(to);   conditions.push(`s.created_at::date <= $${vals.length}`); }
  const where = conditions.length ? `AND ${conditions.join(" AND ")}` : "";

  const { rows } = await pool.query(`
    SELECT
      s.id,
      s.created_at::date                     AS sana,
      s.customer_name                        AS mijoz,
      COALESCE(s.note, '')                   AS izoh,
      s.status                               AS holat,
      s.payment_type                         AS tolov_turi,
      COALESCE(si.product_name, '')          AS mahsulot,
      COALESCE(si.sale_type, '')             AS birlik,
      COALESCE(si.quantity::text, '0')       AS miqdor,
      COALESCE(si.unit_price::text, '0')     AS birlik_narxi,
      COALESCE(si.currency, s.currency, 'UZS') AS valyuta,
      COALESCE(si.line_total::text, '0')     AS jami
    FROM sales s
    LEFT JOIN sale_items si ON si.sale_id = s.id
    WHERE 1=1 ${where}
    ORDER BY s.created_at DESC, s.id, si.id
  `, vals);

  if (format === "xlsx") {
    // Dynamic import — exceljs is a large dep, only load when needed
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Savdolar");

    ws.columns = [
      { header: "ID",        key: "id",          width: 8  },
      { header: "Sana",      key: "sana",         width: 12 },
      { header: "Mijoz",     key: "mijoz",         width: 22 },
      { header: "Mahsulot",  key: "mahsulot",      width: 20 },
      { header: "Birlik",    key: "birlik",         width: 8  },
      { header: "Miqdor",    key: "miqdor",         width: 10 },
      { header: "Narx",      key: "birlik_narxi",   width: 14 },
      { header: "Valyuta",   key: "valyuta",        width: 8  },
      { header: "Jami",      key: "jami",           width: 14 },
      { header: "Holat",     key: "holat",          width: 10 },
      { header: "To'lov",    key: "tolov_turi",     width: 10 },
      { header: "Izoh",      key: "izoh",           width: 20 },
    ];

    ws.getRow(1).font = { bold: true };
    rows.forEach(r => ws.addRow(r));

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="savdolar-${from || "all"}-${to || "all"}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
    return;
  }

  // Default: CSV
  const header = ["ID","Sana","Mijoz","Mahsulot","Birlik","Miqdor","Narx","Valyuta","Jami","Holat","To'lov","Izoh"];
  const escape = (v: unknown) => {
    const s = String(v ?? "").replace(/"/g, '""');
    return /[,"\n]/.test(s) ? `"${s}"` : s;
  };
  const csvLines = [
    header.join(","),
    ...rows.map(r =>
      [r.id, r.sana, r.mijoz, r.mahsulot, r.birlik, r.miqdor, r.birlik_narxi, r.valyuta, r.jami, r.holat, r.tolov_turi, r.izoh]
        .map(escape).join(",")
    ),
  ];

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="savdolar-${from || "all"}-${to || "all"}.csv"`);
  res.send("\uFEFF" + csvLines.join("\n")); // BOM — Excel UTF-8 tanishi uchun
});

// ── GET /reports/sales-summary?from=&to= ─────────────────────────────────────
router.get("/reports/sales-summary", async (req, res): Promise<void> => {
  const from = (req.query.from as string) || "";
  const to   = (req.query.to   as string) || "";

  const conditions: string[] = [];
  const vals: unknown[] = [];
  if (from) { vals.push(from); conditions.push(`s.created_at::date >= $${vals.length}`); }
  if (to)   { vals.push(to);   conditions.push(`s.created_at::date <= $${vals.length}`); }
  const where = conditions.length ? `AND ${conditions.join(" AND ")}` : "";

  const [statsRes, productsRes, customersRes] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(DISTINCT s.id)::int AS sale_count,
        COUNT(DISTINCT s.id) FILTER (WHERE s.status='paid')::int AS paid_count,
        COUNT(DISTINCT s.id) FILTER (WHERE s.status IN ('pending','partial'))::int AS pending_count,
        COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='usd'), 0) AS total_usd,
        COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='uzs'), 0) AS total_uzs
      FROM sales s
      LEFT JOIN sale_items si ON si.sale_id = s.id
      WHERE 1=1 ${where}
    `, vals),
    pool.query(`
      SELECT si.product_name,
             COALESCE(SUM(si.quantity), 0)::numeric AS total_qty,
             COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='usd'), 0) AS rev_usd,
             COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='uzs'), 0) AS rev_uzs
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      WHERE 1=1 ${where}
      GROUP BY si.product_name
      ORDER BY rev_usd DESC, rev_uzs DESC
      LIMIT 10
    `, vals),
    pool.query(`
      SELECT s.customer_name,
             COUNT(DISTINCT s.id)::int AS sale_count,
             COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='usd'), 0) AS total_usd,
             COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='uzs'), 0) AS total_uzs
      FROM sales s
      LEFT JOIN sale_items si ON si.sale_id = s.id
      WHERE 1=1 ${where}
      GROUP BY s.customer_name
      ORDER BY total_usd DESC, total_uzs DESC
      LIMIT 10
    `, vals),
  ]);

  const s = statsRes.rows[0];
  res.json({
    from: from || null,
    to:   to   || null,
    stats: {
      saleCount:    s.sale_count,
      paidCount:    s.paid_count,
      pendingCount: s.pending_count,
      totalUsd:     Number(s.total_usd),
      totalUzs:     Number(s.total_uzs),
    },
    topProducts: productsRes.rows.map((r) => ({
      name:     r.product_name,
      totalQty: Number(r.total_qty),
      revUsd:   Number(r.rev_usd),
      revUzs:   Number(r.rev_uzs),
    })),
    topCustomers: customersRes.rows.map((r) => ({
      name:      r.customer_name,
      saleCount: r.sale_count,
      totalUsd:  Number(r.total_usd),
      totalUzs:  Number(r.total_uzs),
    })),
  });
});

// ── GET /reports/sales-pdf?from=&to= — printable HTML (browser → PDF) ────────
router.get("/reports/sales-pdf", async (req, res): Promise<void> => {
  const from = (req.query.from as string) || "";
  const to   = (req.query.to   as string) || "";

  const conditions: string[] = [];
  const vals: unknown[] = [];
  if (from) { vals.push(from); conditions.push(`s.created_at::date >= $${vals.length}`); }
  if (to)   { vals.push(to);   conditions.push(`s.created_at::date <= $${vals.length}`); }
  const where = conditions.length ? `AND ${conditions.join(" AND ")}` : "";

  const [statsRes, productsRes, customersRes, itemsRes] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(DISTINCT s.id)::int AS sale_count,
        COUNT(DISTINCT s.id) FILTER (WHERE s.status='paid')::int AS paid_count,
        COUNT(DISTINCT s.id) FILTER (WHERE s.status IN ('pending','partial'))::int AS pending_count,
        COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='usd'), 0) AS total_usd,
        COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='uzs'), 0) AS total_uzs
      FROM sales s
      LEFT JOIN sale_items si ON si.sale_id = s.id
      WHERE 1=1 ${where}
    `, vals),
    pool.query(`
      SELECT si.product_name,
             ROUND(SUM(si.quantity)::numeric, 2) AS total_qty,
             COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='usd'), 0) AS rev_usd,
             COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='uzs'), 0) AS rev_uzs
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      WHERE 1=1 ${where}
      GROUP BY si.product_name
      ORDER BY rev_usd DESC, rev_uzs DESC
      LIMIT 15
    `, vals),
    pool.query(`
      SELECT s.customer_name,
             COUNT(DISTINCT s.id)::int AS sale_count,
             COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='usd'), 0) AS total_usd,
             COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='uzs'), 0) AS total_uzs
      FROM sales s
      LEFT JOIN sale_items si ON si.sale_id = s.id
      WHERE 1=1 ${where}
      GROUP BY s.customer_name
      ORDER BY total_usd DESC, total_uzs DESC
      LIMIT 15
    `, vals),
    pool.query(`
      SELECT s.id, s.created_at::date AS date, s.customer_name, s.status,
             si.product_name, si.quantity, si.sale_type, si.unit_price, si.currency, si.line_total
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      WHERE 1=1 ${where}
      ORDER BY s.created_at DESC, s.id, si.id
      LIMIT 300
    `, vals),
  ]);

  const st = statsRes.rows[0];
  const genDate = new Date().toLocaleDateString("uz-UZ");
  const periodLabel = from && to ? `${from} — ${to}` : from ? `${from} dan` : to ? `${to} gacha` : "Barcha vaqt";

  function fmtUsd(v: number) { return v > 0 ? `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 0 })}` : "—"; }
  function fmtUzs(v: number) { return v > 0 ? `${Number(v).toLocaleString("uz-UZ")} so'm` : "—"; }
  function statusBadge(s: string) {
    const map: Record<string, string> = { paid: "To'langan", pending: "Kutilmoqda", partial: "Qisman" };
    const color: Record<string, string> = { paid: "#16a34a", pending: "#d97706", partial: "#2563eb" };
    return `<span style="color:${color[s] ?? "#64748b"};font-weight:600">${map[s] ?? s}</span>`;
  }

  const productRows = productsRes.rows.map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${r.product_name}</td>
      <td style="text-align:center">${Number(r.total_qty).toLocaleString("en-US")}</td>
      <td>${fmtUsd(Number(r.rev_usd))}</td>
      <td>${fmtUzs(Number(r.rev_uzs))}</td>
    </tr>`).join("");

  const customerRows = customersRes.rows.map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${r.customer_name}</td>
      <td style="text-align:center">${r.sale_count}</td>
      <td>${fmtUsd(Number(r.total_usd))}</td>
      <td>${fmtUzs(Number(r.total_uzs))}</td>
    </tr>`).join("");

  const itemRows = itemsRes.rows.map((r) => `
    <tr>
      <td>#${r.id}</td>
      <td>${r.date}</td>
      <td>${r.customer_name}</td>
      <td>${r.product_name}</td>
      <td style="text-align:center">${Number(r.quantity).toLocaleString("en-US")} ${r.sale_type ?? ""}</td>
      <td>${Number(r.unit_price).toLocaleString("en-US")} ${r.currency ?? ""}</td>
      <td>${r.currency?.toLowerCase() === "usd" ? fmtUsd(Number(r.line_total)) : fmtUzs(Number(r.line_total))}</td>
      <td>${statusBadge(r.status)}</td>
    </tr>`).join("");

  const html = `<!DOCTYPE html>
<html lang="uz">
<head>
<meta charset="UTF-8"/>
<title>TopMart Savdo Hisoboti</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#1e293b;background:#fff;padding:24px}
  h1{font-size:22px;font-weight:700;color:#0B5D2A;margin-bottom:2px}
  .sub{color:#64748b;font-size:12px;margin-bottom:20px}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
  .card{border:1px solid #e2e8f0;border-radius:8px;padding:12px}
  .card .lbl{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#64748b;margin-bottom:4px}
  .card .val{font-size:18px;font-weight:700;color:#0B5D2A}
  .card .val.amber{color:#d97706}
  section{margin-bottom:24px}
  h2{font-size:14px;font-weight:700;color:#1e293b;margin-bottom:8px;border-bottom:2px solid #0B5D2A;padding-bottom:4px}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{background:#0B5D2A;color:#fff;padding:7px 10px;text-align:left;font-weight:600;font-size:11px}
  td{padding:6px 10px;border-bottom:1px solid #f1f5f9}
  tr:nth-child(even) td{background:#f8fafc}
  .footer{margin-top:24px;font-size:10px;color:#94a3b8;text-align:center}
  @media print{
    body{padding:12px}
    .no-print{display:none}
    @page{margin:1cm;size:A4}
  }
  .print-btn{position:fixed;bottom:20px;right:20px;background:#0B5D2A;color:#fff;border:none;
    border-radius:8px;padding:10px 20px;font-size:14px;font-weight:600;cursor:pointer;z-index:999}
  .print-btn:hover{background:#16a34a}
</style>
</head>
<body>
<button class="print-btn no-print" onclick="window.print()">🖨️ Chop etish / PDF</button>

<h1>🏭 TopMart — Savdo Hisoboti</h1>
<p class="sub">Davr: <strong>${periodLabel}</strong> &nbsp;|&nbsp; Yaratildi: ${genDate}</p>

<div class="grid">
  <div class="card"><div class="lbl">Jami savdolar</div><div class="val">${st.sale_count}</div></div>
  <div class="card"><div class="lbl">To'langan</div><div class="val">${st.paid_count}</div></div>
  <div class="card"><div class="lbl">Kutilmoqda</div><div class="val amber">${st.pending_count}</div></div>
  <div class="card"><div class="lbl">Jami (USD)</div><div class="val">${fmtUsd(Number(st.total_usd))}</div></div>
</div>
${Number(st.total_uzs) > 0 ? `
<div class="grid" style="grid-template-columns:1fr;margin-bottom:24px">
  <div class="card"><div class="lbl">Jami (UZS)</div><div class="val">${fmtUzs(Number(st.total_uzs))}</div></div>
</div>` : ""}

${productsRes.rows.length > 0 ? `
<section>
<h2>📦 Mahsulotlar bo'yicha</h2>
<table>
  <thead><tr><th>#</th><th>Mahsulot</th><th style="text-align:center">Miqdor</th><th>Summa (USD)</th><th>Summa (UZS)</th></tr></thead>
  <tbody>${productRows}</tbody>
</table>
</section>` : ""}

${customersRes.rows.length > 0 ? `
<section>
<h2>👤 Mijozlar bo'yicha</h2>
<table>
  <thead><tr><th>#</th><th>Mijoz</th><th style="text-align:center">Savdolar</th><th>Jami (USD)</th><th>Jami (UZS)</th></tr></thead>
  <tbody>${customerRows}</tbody>
</table>
</section>` : ""}

${itemsRes.rows.length > 0 ? `
<section>
<h2>📋 Batafsil savdolar</h2>
<table>
  <thead><tr><th>ID</th><th>Sana</th><th>Mijoz</th><th>Mahsulot</th><th>Miqdor</th><th>Narx</th><th>Jami</th><th>Holat</th></tr></thead>
  <tbody>${itemRows}</tbody>
</table>
</section>` : ""}

<div class="footer">TopMart Factory ERP &nbsp;·&nbsp; ${genDate}</div>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

export default router;
