import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  GetSalesQueryParams,
  GetSalesResponse,
  CreateSaleBody,
  DeleteSaleParams,
  UpdateSaleStatusParams,
  UpdateSaleStatusBody,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/sales", async (req, res): Promise<void> => {
  const parsed = GetSalesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { customerId, status, limit = 50, offset = 0 } = parsed.data;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (customerId != null) {
    params.push(customerId);
    conditions.push(`customer_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const filterParams = [...params];

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const [itemsResult, countResult] = await Promise.all([
    pool.query(
      `SELECT id, customer_id, customer_name, product, quantity, weight_kg,
              unit_price, total_amount, status, note, created_at
       FROM sales ${where}
       ORDER BY id DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    ),
    pool.query(`SELECT COUNT(*) AS cnt FROM sales ${where}`, filterParams),
  ]);

  res.json(
    GetSalesResponse.parse({
      items: itemsResult.rows.map((s) => ({
        id: s.id,
        customerId: s.customer_id,
        customerName: s.customer_name,
        product: s.product,
        quantity: s.quantity,
        weightKg: Number(s.weight_kg),
        unitPrice: Number(s.unit_price),
        totalAmount: Number(s.total_amount),
        status: s.status,
        note: s.note ?? "",
        createdAt: s.created_at instanceof Date ? s.created_at.toISOString() : String(s.created_at),
      })),
      total: Number(countResult.rows[0].cnt),
    })
  );
});

router.post("/sales", async (req, res): Promise<void> => {
  const parsed = CreateSaleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { customerId, product, quantity, weightKg = 0, unitPrice, totalAmount, status = "pending", note = "" } =
    parsed.data;

  const customerResult = await pool.query("SELECT name FROM customers WHERE id = $1", [customerId]);
  if (customerResult.rows.length === 0) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  const customerName = customerResult.rows[0].name;
  const result = await pool.query(
    `INSERT INTO sales (customer_id, customer_name, product, quantity, weight_kg,
                        unit_price, total_amount, status, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [customerId, customerName, product, quantity, weightKg, unitPrice, totalAmount ?? unitPrice * quantity, status, note]
  );

  const r = result.rows[0];
  res.status(201).json({
    id: r.id,
    customerId: r.customer_id,
    customerName: r.customer_name,
    product: r.product,
    quantity: r.quantity,
    weightKg: Number(r.weight_kg),
    unitPrice: Number(r.unit_price),
    totalAmount: Number(r.total_amount),
    status: r.status,
    note: r.note,
    createdAt: r.created_at,
  });
});

router.delete("/sales/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = DeleteSaleParams.safeParse({ id: parseInt(raw, 10) });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const result = await pool.query("DELETE FROM sales WHERE id = $1", [parsed.data.id]);

  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Sale not found" });
    return;
  }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

router.patch("/sales/:id/status", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const paramsParsed = UpdateSaleStatusParams.safeParse({ id: parseInt(rawId, 10) });
  const bodyParsed = UpdateSaleStatusBody.safeParse(req.body);

  if (!paramsParsed.success || !bodyParsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  const result = await pool.query(
    "UPDATE sales SET status = $1 WHERE id = $2",
    [bodyParsed.data.status, paramsParsed.data.id]
  );

  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Sale not found" });
    return;
  }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
