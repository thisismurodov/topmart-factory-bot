import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

// ── GET /debts/summary ────────────────────────────────────────────────────────
// Returns: global totals + per-customer debt breakdown + individual debt sales
router.get("/debts/summary", async (_req, res): Promise<void> => {
  const [totalsRes, customersRes, salesRes] = await Promise.all([
    // Global totals
    pool.query(`
      SELECT
        COALESCE(SUM(
          CASE WHEN debt_amount > 0 THEN debt_amount
               ELSE GREATEST(0, total_amount - COALESCE(paid_amount,0)) END
        ) FILTER (WHERE LOWER(currency) = 'usd'), 0) AS total_usd,
        COALESCE(SUM(
          CASE WHEN debt_amount > 0 THEN debt_amount
               ELSE GREATEST(0, total_amount - COALESCE(paid_amount,0)) END
        ) FILTER (WHERE LOWER(currency) = 'uzs'), 0) AS total_uzs,
        COUNT(DISTINCT customer_id)::int                               AS customer_count,
        COUNT(*)::int                                                  AS sale_count
      FROM sales
      WHERE status IN ('pending', 'partial')
        AND (debt_amount > 0 OR total_amount > COALESCE(paid_amount, 0))
    `),

    // Per-customer breakdown
    pool.query(`
      SELECT
        c.id            AS customer_id,
        c.name          AS customer_name,
        c.phone,
        c.company,
        COALESCE(SUM(
          CASE WHEN s.debt_amount > 0 THEN s.debt_amount
               ELSE GREATEST(0, s.total_amount - COALESCE(s.paid_amount,0)) END
        ) FILTER (WHERE LOWER(s.currency) = 'usd'), 0) AS debt_usd,
        COALESCE(SUM(
          CASE WHEN s.debt_amount > 0 THEN s.debt_amount
               ELSE GREATEST(0, s.total_amount - COALESCE(s.paid_amount,0)) END
        ) FILTER (WHERE LOWER(s.currency) = 'uzs'), 0) AS debt_uzs,
        COUNT(s.id)::int                                                   AS sale_count,
        MIN(s.created_at)                                                  AS oldest_sale
      FROM sales s
      JOIN customers c ON c.id = s.customer_id
      WHERE s.status IN ('pending', 'partial')
        AND (s.debt_amount > 0 OR s.total_amount > COALESCE(s.paid_amount, 0))
        AND c.deleted_at IS NULL
      GROUP BY c.id, c.name, c.phone, c.company
      ORDER BY debt_usd DESC, debt_uzs DESC
    `),

    // Individual debt sales (oldest first — most overdue)
    pool.query(`
      SELECT
        s.id,
        s.customer_id,
        s.customer_name,
        c.phone,
        s.total_amount,
        s.paid_amount,
        s.debt_amount,
        s.payment_type,
        s.currency,
        s.status,
        s.note,
        s.created_at,
        EXTRACT(DAY FROM NOW() - s.created_at)::int AS days_since
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.debt_amount > 0 AND s.status IN ('pending', 'partial')
      ORDER BY s.created_at ASC
      LIMIT 500
    `),
  ]);

  const t = totalsRes.rows[0];

  res.json({
    totals: {
      usd:           Number(t.total_usd),
      uzs:           Number(t.total_uzs),
      customerCount: t.customer_count,
      saleCount:     t.sale_count,
    },
    customers: customersRes.rows.map((r) => ({
      customerId:   r.customer_id,
      customerName: r.customer_name,
      phone:        r.phone ?? "",
      company:      r.company ?? "",
      debtUsd:      Number(r.debt_usd),
      debtUzs:      Number(r.debt_uzs),
      saleCount:    r.sale_count,
      oldestSale:   r.oldest_sale instanceof Date
        ? r.oldest_sale.toISOString()
        : String(r.oldest_sale),
    })),
    sales: salesRes.rows.map((s) => ({
      id:           s.id,
      customerId:   s.customer_id,
      customerName: s.customer_name,
      phone:        s.phone ?? "",
      totalAmount:  Number(s.total_amount),
      paidAmount:   Number(s.paid_amount ?? 0),
      debtAmount:   Number(s.debt_amount),
      paymentType:  s.payment_type ?? "naqd",
      currency:     s.currency ?? "USD",
      status:       s.status,
      note:         s.note ?? "",
      daysSince:    s.days_since ?? 0,
      createdAt:    s.created_at instanceof Date
        ? s.created_at.toISOString()
        : String(s.created_at),
    })),
  });
});

// ── GET /customers/:id/debt-sales ─────────────────────────────────────────────
// Pending/partial sales for one customer (used in quick-pay dialog)
router.get("/customers/:id/debt-sales", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const r = await pool.query(
    `SELECT id, total_amount, paid_amount, debt_amount, currency, status, note, created_at
     FROM sales
     WHERE customer_id = $1
       AND status IN ('pending','partial')
       AND (debt_amount > 0 OR total_amount > COALESCE(paid_amount, 0))
     ORDER BY created_at ASC`,
    [id],
  );

  res.json(
    r.rows.map((s) => ({
      id:          s.id,
      totalAmount: Number(s.total_amount),
      paidAmount:  Number(s.paid_amount ?? 0),
      debtAmount:  Number(s.debt_amount),
      currency:    s.currency ?? "USD",
      status:      s.status,
      note:        s.note ?? "",
      createdAt:   s.created_at instanceof Date
        ? s.created_at.toISOString()
        : String(s.created_at),
    })),
  );
});

export default router;
