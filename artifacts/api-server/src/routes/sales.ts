import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  DeleteSaleParams,
  UpdateSaleStatusParams,
  UpdateSaleStatusBody,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// ── GET /sales ───────────────────────────────────────────────────────────────
router.get("/sales", async (req, res): Promise<void> => {
  const status   = req.query.status as string | undefined;
  const customerId = req.query.customerId ? parseInt(req.query.customerId as string) : undefined;
  const limit    = parseInt((req.query.limit  as string) ?? "50");
  const offset   = parseInt((req.query.offset as string) ?? "0");

  const conditions: string[] = [];
  const params: unknown[]    = [];

  if (customerId != null) { params.push(customerId); conditions.push(`s.customer_id=$${params.length}`); }
  if (status)             { params.push(status);     conditions.push(`s.status=$${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const filterParams = [...params];

  params.push(limit);  const limitIdx  = params.length;
  params.push(offset); const offsetIdx = params.length;

  const [salesRes, countRes] = await Promise.all([
    pool.query(
      `SELECT s.id, s.customer_id, s.customer_name, s.status, s.note,
              s.total_amount, s.created_at
       FROM sales s ${where}
       ORDER BY s.id DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    ),
    pool.query(`SELECT COUNT(*) AS cnt FROM sales s ${where}`, filterParams),
  ]);

  const saleIds = salesRes.rows.map(r => r.id);
  let itemsBySale: Record<number, any[]> = {};

  if (saleIds.length > 0) {
    const itemsRes = await pool.query(
      `SELECT id, sale_id, product_name, sale_type, quantity, unit_price, currency, line_total
       FROM sale_items WHERE sale_id = ANY($1) ORDER BY id`,
      [saleIds]
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
    items: salesRes.rows.map(s => ({
      id:           s.id,
      customerId:   s.customer_id,
      customerName: s.customer_name,
      status:       s.status,
      note:         s.note ?? "",
      totalAmount:  Number(s.total_amount),
      createdAt:    s.created_at instanceof Date ? s.created_at.toISOString() : String(s.created_at),
      saleItems:    itemsBySale[s.id] ?? [],
    })),
    total: Number(countRes.rows[0].cnt),
  });
});

// ── POST /sales ──────────────────────────────────────────────────────────────
router.post("/sales", async (req, res): Promise<void> => {
  const { customerId, status = "pending", note = "", items } = req.body ?? {};

  if (!customerId || typeof customerId !== "number") {
    res.status(400).json({ error: "customerId required" }); return;
  }
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "items array required (min 1)" }); return;
  }
  for (const it of items) {
    if (!it.productName || typeof it.quantity !== "number" || typeof it.unitPrice !== "number") {
      res.status(400).json({ error: "Each item needs productName, quantity, unitPrice" }); return;
    }
  }

  const customerRes = await pool.query("SELECT name FROM customers WHERE id=$1", [customerId]);
  if (!customerRes.rows.length) { res.status(404).json({ error: "Customer not found" }); return; }
  const customerName = customerRes.rows[0].name;

  // Compute totals per currency, then a combined total for the field
  const totalAmount = items.reduce((sum: number, it: any) => {
    const lt = Number(it.quantity) * Number(it.unitPrice);
    return sum + lt;
  }, 0);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const saleRes = await client.query(
      `INSERT INTO sales (customer_id, customer_name, status, note, total_amount)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [customerId, customerName, status, note, totalAmount]
    );
    const saleId = saleRes.rows[0].id;

    for (const it of items) {
      const lineTotal = Number(it.quantity) * Number(it.unitPrice);
      await client.query(
        `INSERT INTO sale_items (sale_id, product_name, sale_type, quantity, unit_price, currency, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [saleId, it.productName, it.saleType ?? "dona", Number(it.quantity), Number(it.unitPrice), it.currency ?? "UZS", lineTotal]
      );
    }

    await client.query("COMMIT");
    res.status(201).json({ id: saleId, ok: true });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── DELETE /sales/:id ────────────────────────────────────────────────────────
router.delete("/sales/:id", async (req, res): Promise<void> => {
  const raw    = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = DeleteSaleParams.safeParse({ id: parseInt(raw, 10) });
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const result = await pool.query("DELETE FROM sales WHERE id=$1", [parsed.data.id]);
  if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: "Sale not found" }); return; }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

// ── PATCH /sales/:id/status ──────────────────────────────────────────────────
router.patch("/sales/:id/status", async (req, res): Promise<void> => {
  const rawId       = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const paramsParsed = UpdateSaleStatusParams.safeParse({ id: parseInt(rawId, 10) });
  const bodyParsed   = UpdateSaleStatusBody.safeParse(req.body);

  if (!paramsParsed.success || !bodyParsed.success) {
    res.status(400).json({ error: "Invalid request" }); return;
  }

  const result = await pool.query(
    "UPDATE sales SET status=$1 WHERE id=$2",
    [bodyParsed.data.status, paramsParsed.data.id]
  );
  if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: "Sale not found" }); return; }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
