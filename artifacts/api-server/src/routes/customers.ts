import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  GetCustomersResponse,
  CreateCustomerBody,
  DeleteCustomerParams,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// ── GET /customers ────────────────────────────────────────────────────────────
router.get("/customers", async (_req, res): Promise<void> => {
  const result = await pool.query(
    "SELECT id, name, phone, company, address, created_at FROM customers ORDER BY id DESC"
  );
  res.json(
    GetCustomersResponse.parse(
      result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        phone: r.phone,
        company: r.company,
        address: r.address,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      }))
    )
  );
});

// ── POST /customers ───────────────────────────────────────────────────────────
router.post("/customers", async (req, res): Promise<void> => {
  const parsed = CreateCustomerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message }); return;
  }
  const { name, phone = "", company = "", address = "" } = parsed.data;
  const result = await pool.query(
    `INSERT INTO customers (name, phone, company, address)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, phone, company, address, created_at`,
    [name, phone, company, address]
  );
  const r = result.rows[0];
  res.status(201).json({
    id: r.id, name: r.name, phone: r.phone,
    company: r.company, address: r.address,
    createdAt: r.created_at,
  });
});

// ── PATCH /customers/:id ──────────────────────────────────────────────────────
router.patch("/customers/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { name, phone, company, address } = req.body ?? {};
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (name !== undefined)    { vals.push(name);    sets.push(`name=$${vals.length}`); }
  if (phone !== undefined)   { vals.push(phone);   sets.push(`phone=$${vals.length}`); }
  if (company !== undefined) { vals.push(company); sets.push(`company=$${vals.length}`); }
  if (address !== undefined) { vals.push(address); sets.push(`address=$${vals.length}`); }

  if (sets.length === 0) { res.status(400).json({ error: "No fields" }); return; }

  vals.push(id);
  const result = await pool.query(
    `UPDATE customers SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING id, name, phone, company, address`,
    vals
  );
  if (!result.rows.length) { res.status(404).json({ error: "Not found" }); return; }
  res.json(result.rows[0]);
});

// ── GET /customers/:id/profile ────────────────────────────────────────────────
router.get("/customers/:id/profile", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [custRes, statsRes, salesRes] = await Promise.all([
    pool.query("SELECT id, name, phone, company, address, created_at FROM customers WHERE id=$1", [id]),
    pool.query(
      `SELECT
         COUNT(*)::int                        AS total_sales,
         COALESCE(SUM(total_amount), 0)       AS total_amount,
         COALESCE(SUM(paid_amount), 0)        AS total_paid,
         COALESCE(SUM(debt_amount), 0)        AS total_debt,
         COUNT(*) FILTER (WHERE status='paid')::int    AS paid_count,
         COUNT(*) FILTER (WHERE status='pending')::int AS pending_count,
         COUNT(*) FILTER (WHERE status='partial')::int AS partial_count
       FROM sales WHERE customer_id=$1`,
      [id]
    ),
    pool.query(
      `SELECT s.id, s.status, s.note, s.total_amount, s.paid_amount, s.debt_amount,
              s.payment_type, s.currency, s.created_at
       FROM sales s WHERE s.customer_id=$1 ORDER BY s.id DESC LIMIT 30`,
      [id]
    ),
  ]);

  if (!custRes.rows.length) { res.status(404).json({ error: "Customer not found" }); return; }

  const c = custRes.rows[0];
  const st = statsRes.rows[0];

  // Fetch items for these sales
  const saleIds = salesRes.rows.map(r => r.id);
  let itemsBySale: Record<number, any[]> = {};
  if (saleIds.length > 0) {
    const { rows: items } = await pool.query(
      `SELECT sale_id, product_name, sale_type, quantity, unit_price, currency, line_total
       FROM sale_items WHERE sale_id = ANY($1) ORDER BY id`,
      [saleIds]
    );
    for (const it of items) {
      if (!itemsBySale[it.sale_id]) itemsBySale[it.sale_id] = [];
      itemsBySale[it.sale_id].push({
        productName: it.product_name, saleType: it.sale_type,
        quantity: Number(it.quantity), unitPrice: Number(it.unit_price),
        currency: it.currency, lineTotal: Number(it.line_total),
      });
    }
  }

  res.json({
    customer: {
      id: c.id, name: c.name, phone: c.phone, company: c.company,
      address: c.address,
      createdAt: c.created_at instanceof Date ? c.created_at.toISOString() : String(c.created_at),
    },
    stats: {
      totalSales:   st.total_sales,
      totalAmount:  Number(st.total_amount),
      totalPaid:    Number(st.total_paid),
      totalDebt:    Number(st.total_debt),
      paidCount:    st.paid_count,
      pendingCount: st.pending_count,
      partialCount: st.partial_count,
    },
    sales: salesRes.rows.map(s => ({
      id:          s.id,
      status:      s.status,
      note:        s.note ?? "",
      totalAmount: Number(s.total_amount),
      paidAmount:  Number(s.paid_amount ?? 0),
      debtAmount:  Number(s.debt_amount ?? 0),
      paymentType: s.payment_type ?? "naqd",
      currency:    s.currency ?? "USD",
      createdAt:   s.created_at instanceof Date ? s.created_at.toISOString() : String(s.created_at),
      items:       itemsBySale[s.id] ?? [],
    })),
  });
});

// ── DELETE /customers/:id ─────────────────────────────────────────────────────
router.delete("/customers/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = DeleteCustomerParams.safeParse({ id: parseInt(raw, 10) });
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const result = await pool.query("DELETE FROM customers WHERE id = $1", [parsed.data.id]);
  if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: "Customer not found" }); return; }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
