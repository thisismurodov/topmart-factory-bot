import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  GetCustomersResponse,
  CreateCustomerBody,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// ── DB migration (idempotent) ─────────────────────────────────────────────────
async function ensureCustomerColumns() {
  try {
    await pool.query(
      `ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE`,
    );
  } catch (_) {}
}
ensureCustomerColumns();

// ── Input limits ──────────────────────────────────────────────────────────────
const MAX = { name: 100, phone: 30, company: 120, address: 250 } as const;

function validateCustomerInput(body: any): string | null {
  const { name, phone = "", company = "", address = "" } = body ?? {};
  if (!name || typeof name !== "string" || !name.trim())
    return "name kiritilishi shart";
  if (name.trim().length > MAX.name)
    return `name ${MAX.name} belgidan oshmasin`;
  if (String(phone).length > MAX.phone)
    return `phone ${MAX.phone} belgidan oshmasin`;
  if (String(company).length > MAX.company)
    return `company ${MAX.company} belgidan oshmasin`;
  if (String(address).length > MAX.address)
    return `address ${MAX.address} belgidan oshmasin`;
  return null;
}

// ── GET /customers ────────────────────────────────────────────────────────────
router.get("/customers", async (_req, res): Promise<void> => {
  const result = await pool.query(
    `SELECT id, name, phone, company, address, created_at
     FROM customers
     WHERE deleted_at IS NULL
     ORDER BY id DESC`,
  );
  res.json(
    GetCustomersResponse.parse(
      result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        phone: r.phone,
        company: r.company,
        address: r.address,
        createdAt:
          r.created_at instanceof Date
            ? r.created_at.toISOString()
            : String(r.created_at),
      })),
    ),
  );
});

// ── POST /customers ───────────────────────────────────────────────────────────
router.post("/customers", async (req, res): Promise<void> => {
  const err = validateCustomerInput(req.body);
  if (err) { res.status(400).json({ error: err }); return; }

  const parsed = CreateCustomerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, phone = "", company = "", address = "" } = parsed.data;
  const result = await pool.query(
    `INSERT INTO customers (name, phone, company, address)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, phone, company, address, created_at`,
    [name.trim(), phone.trim(), company.trim(), address.trim()],
  );
  const r = result.rows[0];
  res.status(201).json({
    id: r.id,
    name: r.name,
    phone: r.phone,
    company: r.company,
    address: r.address,
    createdAt: r.created_at,
  });
});

// ── PATCH /customers/:id ──────────────────────────────────────────────────────
router.patch("/customers/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const err = validateCustomerInput({ name: req.body?.name ?? "placeholder", ...req.body });
  if (err && err !== "name kiritilishi shart") {
    res.status(400).json({ error: err }); return;
  }

  const { name, phone, company, address } = req.body ?? {};
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (name !== undefined)    { vals.push(String(name).trim().slice(0, MAX.name));    sets.push(`name=$${vals.length}`); }
  if (phone !== undefined)   { vals.push(String(phone).trim().slice(0, MAX.phone));   sets.push(`phone=$${vals.length}`); }
  if (company !== undefined) { vals.push(String(company).trim().slice(0, MAX.company)); sets.push(`company=$${vals.length}`); }
  if (address !== undefined) { vals.push(String(address).trim().slice(0, MAX.address)); sets.push(`address=$${vals.length}`); }

  if (sets.length === 0) { res.status(400).json({ error: "No fields to update" }); return; }

  vals.push(id);
  const result = await pool.query(
    `UPDATE customers SET ${sets.join(",")} WHERE id=$${vals.length} AND deleted_at IS NULL
     RETURNING id, name, phone, company, address`,
    vals,
  );
  if (!result.rows.length) { res.status(404).json({ error: "Customer not found" }); return; }
  res.json(result.rows[0]);
});

// ── GET /customers/:id/profile ────────────────────────────────────────────────
router.get("/customers/:id/profile", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [custRes, statsRes, salesRes] = await Promise.all([
    pool.query(
      `SELECT id, name, phone, company, address, created_at
       FROM customers WHERE id=$1 AND deleted_at IS NULL`,
      [id],
    ),
    pool.query(
      `SELECT
         COUNT(*)::int                                              AS total_sales,
         COUNT(*) FILTER (WHERE status='paid')::int                AS paid_count,
         COUNT(*) FILTER (WHERE status='pending')::int             AS pending_count,
         COUNT(*) FILTER (WHERE status='partial')::int             AS partial_count,
         -- USD totals
         COALESCE(SUM(total_amount) FILTER (WHERE LOWER(currency)='usd'), 0) AS total_usd,
         COALESCE(SUM(paid_amount)  FILTER (WHERE LOWER(currency)='usd'), 0) AS paid_usd,
         COALESCE(SUM(
           CASE WHEN debt_amount > 0 THEN debt_amount
                WHEN status IN ('pending','partial') THEN GREATEST(0, total_amount - COALESCE(paid_amount,0))
                ELSE 0 END
         ) FILTER (WHERE LOWER(currency)='usd'), 0) AS debt_usd,
         -- UZS totals
         COALESCE(SUM(total_amount) FILTER (WHERE LOWER(currency)='uzs'), 0) AS total_uzs,
         COALESCE(SUM(paid_amount)  FILTER (WHERE LOWER(currency)='uzs'), 0) AS paid_uzs,
         COALESCE(SUM(
           CASE WHEN debt_amount > 0 THEN debt_amount
                WHEN status IN ('pending','partial') THEN GREATEST(0, total_amount - COALESCE(paid_amount,0))
                ELSE 0 END
         ) FILTER (WHERE LOWER(currency)='uzs'), 0) AS debt_uzs
       FROM sales WHERE customer_id=$1`,
      [id],
    ),
    pool.query(
      `SELECT id, status, note, total_amount, paid_amount, debt_amount,
              payment_type, currency, created_at
       FROM sales WHERE customer_id=$1 ORDER BY id DESC LIMIT 50`,
      [id],
    ),
  ]);

  if (!custRes.rows.length) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  const c = custRes.rows[0];
  const st = statsRes.rows[0];

  const saleIds = salesRes.rows.map((r) => r.id);
  const itemsBySale: Record<number, any[]> = {};
  if (saleIds.length > 0) {
    const { rows: items } = await pool.query(
      `SELECT sale_id, product_name, sale_type, quantity, unit_price, currency, line_total
       FROM sale_items WHERE sale_id = ANY($1) ORDER BY id`,
      [saleIds],
    );
    for (const it of items) {
      if (!itemsBySale[it.sale_id]) itemsBySale[it.sale_id] = [];
      itemsBySale[it.sale_id].push({
        productName: it.product_name,
        saleType: it.sale_type,
        quantity: Number(it.quantity),
        unitPrice: Number(it.unit_price),
        currency: it.currency,
        lineTotal: Number(it.line_total),
      });
    }
  }

  res.json({
    customer: {
      id: c.id,
      name: c.name,
      phone: c.phone,
      company: c.company,
      address: c.address,
      createdAt:
        c.created_at instanceof Date
          ? c.created_at.toISOString()
          : String(c.created_at),
    },
    stats: {
      totalSales:   st.total_sales,
      paidCount:    st.paid_count,
      pendingCount: st.pending_count,
      partialCount: st.partial_count,
      usd: {
        total: Number(st.total_usd),
        paid:  Number(st.paid_usd),
        debt:  Number(st.debt_usd),
      },
      uzs: {
        total: Number(st.total_uzs),
        paid:  Number(st.paid_uzs),
        debt:  Number(st.debt_uzs),
      },
    },
    sales: salesRes.rows.map((s) => ({
      id:          s.id,
      status:      s.status,
      note:        s.note ?? "",
      totalAmount: Number(s.total_amount),
      paidAmount:  Number(s.paid_amount ?? 0),
      debtAmount:  Number(s.debt_amount ?? 0),
      paymentType: s.payment_type ?? "naqd",
      currency:    s.currency ?? "USD",
      createdAt:
        s.created_at instanceof Date
          ? s.created_at.toISOString()
          : String(s.created_at),
      items: itemsBySale[s.id] ?? [],
    })),
  });
});

// ── DELETE /customers/:id  (soft delete) ──────────────────────────────────────
router.delete("/customers/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const result = await pool.query(
    `UPDATE customers SET deleted_at = NOW()
     WHERE id=$1 AND deleted_at IS NULL`,
    [id],
  );

  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
