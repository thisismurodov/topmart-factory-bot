import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  DeleteSaleParams,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// ── DB migrations (idempotent) ────────────────────────────────────────────────
async function ensureSalesSchema() {
  try {
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_type TEXT NOT NULL DEFAULT 'naqd'`);
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS paid_amount  NUMERIC(12,2) NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS debt_amount  NUMERIC(12,2) NOT NULL DEFAULT 0`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sale_payments (
        id         SERIAL PRIMARY KEY,
        sale_id    INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        amount     NUMERIC(12,2) NOT NULL,
        currency   TEXT NOT NULL DEFAULT 'USD',
        note       TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);

    // Audit log
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sale_events (
        id          SERIAL PRIMARY KEY,
        sale_id     INTEGER REFERENCES sales(id) ON DELETE SET NULL,
        event_type  TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        amount      NUMERIC(12,2),
        currency    TEXT,
        user_id     INTEGER,
        created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);

    // Back-fill paid sales
    await pool.query(`
      UPDATE sales SET paid_amount = total_amount
      WHERE status = 'paid' AND paid_amount = 0 AND total_amount > 0
    `);
  } catch (_) {}
}
ensureSalesSchema();

// ── Helpers ───────────────────────────────────────────────────────────────────
async function logEvent(
  saleId: number,
  eventType: string,
  description: string,
  userId?: number,
  amount?: number,
  currency?: string,
) {
  try {
    await pool.query(
      `INSERT INTO sale_events (sale_id, event_type, description, user_id, amount, currency)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [saleId, eventType, description, userId ?? null, amount ?? null, currency ?? null],
    );
  } catch (_) {}
}

// ── GET /sales ────────────────────────────────────────────────────────────────
router.get("/sales", async (req, res): Promise<void> => {
  const status     = req.query.status as string | undefined;
  const customerId = req.query.customerId ? parseInt(req.query.customerId as string) : undefined;
  const limit      = Math.min(parseInt((req.query.limit  as string) ?? "50"), 200);
  const offset     = Math.max(parseInt((req.query.offset as string) ?? "0"), 0);

  const conditions: string[] = [];
  const params: unknown[]    = [];

  if (customerId != null && !isNaN(customerId)) {
    params.push(customerId); conditions.push(`s.customer_id=$${params.length}`);
  }
  if (status && ["paid","pending","partial"].includes(status)) {
    params.push(status); conditions.push(`s.status=$${params.length}`);
  }

  const where       = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const filterParams = [...params];

  params.push(limit);  const limitIdx  = params.length;
  params.push(offset); const offsetIdx = params.length;

  const [salesRes, countRes] = await Promise.all([
    pool.query(
      `SELECT s.id, s.customer_id, s.customer_name, s.status, s.note,
              s.total_amount, s.paid_amount, s.debt_amount, s.payment_type,
              s.currency, s.created_at
       FROM sales s ${where}
       ORDER BY s.id DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    ),
    pool.query(
      `SELECT COUNT(*) AS cnt FROM sales s ${where}`,
      filterParams,
    ),
  ]);

  const saleIds = salesRes.rows.map((r) => r.id);
  const itemsBySale: Record<number, any[]> = {};

  if (saleIds.length > 0) {
    const itemsRes = await pool.query(
      `SELECT id, sale_id, product_name, sale_type, quantity, unit_price, currency, line_total
       FROM sale_items WHERE sale_id = ANY($1) ORDER BY id`,
      [saleIds],
    );
    for (const row of itemsRes.rows) {
      if (!itemsBySale[row.sale_id]) itemsBySale[row.sale_id] = [];
      itemsBySale[row.sale_id].push({
        id:          row.id,
        productName: row.product_name,
        saleType:    row.sale_type,
        quantity:    Number(row.quantity),
        unitPrice:   Number(row.unit_price),
        currency:    row.currency,
        lineTotal:   Number(row.line_total),
      });
    }
  }

  res.json({
    items: salesRes.rows.map((s) => ({
      id:           s.id,
      customerId:   s.customer_id,
      customerName: s.customer_name,
      status:       s.status,
      note:         s.note ?? "",
      totalAmount:  Number(s.total_amount),
      paidAmount:   Number(s.paid_amount ?? 0),
      debtAmount:   Number(s.debt_amount ?? 0),
      paymentType:  s.payment_type ?? "naqd",
      currency:     s.currency ?? "USD",
      createdAt:    s.created_at instanceof Date ? s.created_at.toISOString() : String(s.created_at),
      saleItems:    itemsBySale[s.id] ?? [],
    })),
    total: Number(countRes.rows[0].cnt),
  });
});

// ── POST /sales ───────────────────────────────────────────────────────────────
router.post("/sales", async (req, res): Promise<void> => {
  const {
    customerId,
    note = "",
    items,
    paymentType = "naqd",
    paidAmount: rawPaid,
  } = req.body ?? {};

  // ── Validation ──
  if (!customerId || typeof customerId !== "number") {
    res.status(400).json({ error: "customerId required" }); return;
  }
  if (!["naqd","nasiya","aralash"].includes(paymentType)) {
    res.status(400).json({ error: "paymentType must be naqd|nasiya|aralash" }); return;
  }
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "items array required (min 1)" }); return;
  }
  if (items.length > 200) {
    res.status(400).json({ error: "Max 200 items per sale" }); return;
  }
  for (const it of items) {
    if (!it.productName || typeof it.productName !== "string") {
      res.status(400).json({ error: "Each item needs productName" }); return;
    }
    const qty   = Number(it.quantity);
    const price = Number(it.unitPrice);
    if (isNaN(qty) || qty <= 0)    { res.status(400).json({ error: "quantity must be > 0" }); return; }
    if (isNaN(price) || price < 0) { res.status(400).json({ error: "unitPrice must be >= 0" }); return; }
  }

  const customerRes = await pool.query(
    "SELECT name FROM customers WHERE id=$1 AND deleted_at IS NULL",
    [customerId],
  );
  if (!customerRes.rows.length) {
    res.status(404).json({ error: "Customer not found" }); return;
  }
  const customerName = customerRes.rows[0].name;

  const allCurrencies = items.map((it: any) => ((it.currency ?? "USD") as string).toUpperCase());
  const primaryCurrency = allCurrencies.every((c: string) => c === "UZS") ? "UZS" : "USD";
  const totalAmount = items.reduce(
    (sum: number, it: any) => sum + Number(it.quantity) * Number(it.unitPrice),
    0,
  );

  // ── Payment amounts (server-side, not trusted from client) ──
  let paidAmt: number;
  let debtAmt: number;
  let finalStatus: string;

  if (paymentType === "naqd") {
    paidAmt     = totalAmount;
    debtAmt     = 0;
    finalStatus = "paid";
  } else if (paymentType === "nasiya") {
    paidAmt     = 0;
    debtAmt     = totalAmount;
    finalStatus = "pending";
  } else {
    // aralash: validate paid cannot exceed total
    const raw = Number(rawPaid);
    if (isNaN(raw) || raw < 0) {
      res.status(400).json({ error: "paidAmount must be >= 0" }); return;
    }
    paidAmt     = Math.min(raw, totalAmount);
    debtAmt     = totalAmount - paidAmt;
    finalStatus = debtAmt <= 0.001 ? "paid" : "partial";
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const saleRes = await client.query(
      `INSERT INTO sales (customer_id, customer_name, status, note, total_amount, currency,
                          payment_type, paid_amount, debt_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [customerId, customerName, finalStatus,
       String(note).slice(0, 500), totalAmount, primaryCurrency,
       paymentType, paidAmt, debtAmt],
    );
    const saleId = saleRes.rows[0].id;

    for (const it of items) {
      const lineTotal = Number(it.quantity) * Number(it.unitPrice);
      await client.query(
        `INSERT INTO sale_items (sale_id, product_name, sale_type, quantity, unit_price, currency, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [saleId, String(it.productName).slice(0, 120),
         it.saleType ?? "dona",
         Number(it.quantity), Number(it.unitPrice),
         it.currency ?? "USD", lineTotal],
      );
    }

    if (paymentType === "aralash" && paidAmt > 0) {
      await client.query(
        `INSERT INTO sale_payments (sale_id, amount, currency, note)
         VALUES ($1,$2,$3,'Boshlang''ich to''lov')`,
        [saleId, paidAmt, primaryCurrency],
      );
    }

    await client.query("COMMIT");

    // Audit
    await logEvent(
      saleId, "created",
      `${paymentType} | ${primaryCurrency} ${totalAmount.toFixed(2)}` +
        (paymentType === "aralash" ? ` | naqd: ${paidAmt.toFixed(2)}, nasiya: ${debtAmt.toFixed(2)}` : ""),
      req.userId, totalAmount, primaryCurrency,
    );

    res.status(201).json({ id: saleId, ok: true });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── POST /sales/:id/payments ──────────────────────────────────────────────────
router.post("/sales/:id/payments", async (req, res): Promise<void> => {
  const saleId = parseInt(req.params.id, 10);
  const { amount, currency = "USD", note = "" } = req.body ?? {};

  if (!saleId || isNaN(saleId)) { res.status(400).json({ error: "Invalid sale id" }); return; }

  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) {
    res.status(400).json({ error: "amount must be > 0" }); return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const saleRes = await client.query(
      "SELECT id, total_amount, debt_amount, paid_amount, status, currency FROM sales WHERE id=$1 FOR UPDATE",
      [saleId],
    );
    if (!saleRes.rows.length) {
      res.status(404).json({ error: "Sale not found" }); return;
    }

    const sale = saleRes.rows[0];
    // Bot-created sales have debt_amount=0 but status='pending'; compute effective debt
    const maxPay = Number(sale.debt_amount) > 0
      ? Number(sale.debt_amount)
      : Math.max(0, Number(sale.total_amount) - Number(sale.paid_amount ?? 0));

    if (maxPay <= 0) {
      res.status(400).json({ error: "Bu savdo allaqachon to'liq to'langan" }); return;
    }

    // Never allow overpayment — clamp to remaining debt
    const effectiveAmt = Math.min(amt, maxPay);
    const newPaid      = Number(sale.paid_amount) + effectiveAmt;
    const newDebt      = Math.max(0, maxPay - effectiveAmt);
    const newStatus    = newDebt <= 0.001 ? "paid" : "partial";

    await client.query(
      `UPDATE sales SET paid_amount=$1, debt_amount=$2, status=$3 WHERE id=$4`,
      [newPaid, newDebt, newStatus, saleId],
    );
    await client.query(
      `INSERT INTO sale_payments (sale_id, amount, currency, note) VALUES ($1,$2,$3,$4)`,
      [saleId, effectiveAmt, currency, String(note).slice(0, 200)],
    );

    await client.query("COMMIT");

    await logEvent(
      saleId, "payment_added",
      `+${effectiveAmt.toFixed(2)} ${currency}${note ? ` — ${note}` : ""}`,
      req.userId, effectiveAmt, currency,
    );

    res.json({ ok: true, paidAmount: newPaid, debtAmount: newDebt, status: newStatus });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── GET /sales/:id/payments ───────────────────────────────────────────────────
router.get("/sales/:id/payments", async (req, res): Promise<void> => {
  const saleId = parseInt(req.params.id, 10);
  if (isNaN(saleId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const r = await pool.query(
    `SELECT id, amount, currency, note, created_at
     FROM sale_payments WHERE sale_id=$1 ORDER BY id`,
    [saleId],
  );
  res.json(
    r.rows.map((p) => ({
      id:        p.id,
      amount:    Number(p.amount),
      currency:  p.currency,
      note:      p.note,
      createdAt: p.created_at instanceof Date ? p.created_at.toISOString() : String(p.created_at),
    })),
  );
});

// ── GET /sales/:id/events  (audit log) ───────────────────────────────────────
router.get("/sales/:id/events", async (req, res): Promise<void> => {
  const saleId = parseInt(req.params.id, 10);
  if (isNaN(saleId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const r = await pool.query(
    `SELECT id, event_type, description, amount, currency, user_id, created_at
     FROM sale_events WHERE sale_id=$1 ORDER BY id DESC LIMIT 50`,
    [saleId],
  );
  res.json(
    r.rows.map((e) => ({
      id:          e.id,
      eventType:   e.event_type,
      description: e.description,
      amount:      e.amount != null ? Number(e.amount) : null,
      currency:    e.currency,
      userId:      e.user_id,
      createdAt:   e.created_at instanceof Date ? e.created_at.toISOString() : String(e.created_at),
    })),
  );
});

// ── DELETE /sales/:id ─────────────────────────────────────────────────────────
router.delete("/sales/:id", async (req, res): Promise<void> => {
  const raw    = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = DeleteSaleParams.safeParse({ id: parseInt(raw, 10) });
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // Log before delete (ON DELETE SET NULL would wipe sale_id)
  await logEvent(parsed.data.id, "deleted", "Sale deleted", req.userId);

  const result = await pool.query("DELETE FROM sales WHERE id=$1", [parsed.data.id]);
  if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: "Sale not found" }); return; }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

// ── PATCH /sales/:id/status ───────────────────────────────────────────────────
router.patch("/sales/:id/status", async (req, res): Promise<void> => {
  const saleId = parseInt(req.params.id, 10);
  const { status } = req.body ?? {};

  if (!saleId || isNaN(saleId)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!status || !["paid","pending","partial"].includes(status)) {
    res.status(400).json({ error: "status must be paid|pending|partial" }); return;
  }

  const updateQ =
    status === "paid"
      ? `UPDATE sales SET status=$1, debt_amount=0, paid_amount=total_amount WHERE id=$2`
      : `UPDATE sales SET status=$1 WHERE id=$2`;

  const result = await pool.query(updateQ, [status, saleId]);
  if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: "Sale not found" }); return; }

  await logEvent(saleId, "status_changed", `→ ${status}`, req.userId);

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
