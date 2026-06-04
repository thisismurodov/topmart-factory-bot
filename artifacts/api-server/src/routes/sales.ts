import { Router, type IRouter } from "express";
import { getDb } from "../lib/sqlite";
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

router.get("/sales", (req, res): void => {
  const parsed = GetSalesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { customerId, status, limit = 50, offset = 0 } = parsed.data;
  const db = getDb();

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (customerId != null) {
    conditions.push("customer_id = ?");
    params.push(customerId);
  }
  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const items = db
    .prepare(
      `SELECT id, customer_id, customer_name, product, quantity, weight_kg,
              unit_price, total_amount, status, note, created_at
       FROM sales ${where}
       ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as any[];

  const total = (
    db.prepare(`SELECT COUNT(*) AS cnt FROM sales ${where}`).get(...params) as any
  ).cnt;

  res.json(
    GetSalesResponse.parse({
      items: items.map((s) => ({
        id: s.id,
        customerId: s.customer_id,
        customerName: s.customer_name,
        product: s.product,
        quantity: s.quantity,
        weightKg: Number(s.weight_kg),
        unitPrice: Number(s.unit_price),
        totalAmount: Number(s.total_amount),
        status: s.status,
        note: s.note,
        createdAt: s.created_at,
      })),
      total,
    })
  );
});

router.post("/sales", (req, res): void => {
  const parsed = CreateSaleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { customerId, product, quantity, weightKg, unitPrice, totalAmount, status, note } =
    parsed.data;
  const db = getDb();

  const customer = db
    .prepare("SELECT name FROM customers WHERE id = ?")
    .get(customerId) as any;

  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  const result = db
    .prepare(
      `INSERT INTO sales (customer_id, customer_name, product, quantity, weight_kg,
                          unit_price, total_amount, status, note)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      customerId,
      customer.name,
      product,
      quantity,
      weightKg,
      unitPrice,
      totalAmount,
      status,
      note
    );

  const row = db
    .prepare("SELECT * FROM sales WHERE id = ?")
    .get(result.lastInsertRowid) as any;

  res.status(201).json({
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    product: row.product,
    quantity: row.quantity,
    weightKg: Number(row.weight_kg),
    unitPrice: Number(row.unit_price),
    totalAmount: Number(row.total_amount),
    status: row.status,
    note: row.note,
    createdAt: row.created_at,
  });
});

router.delete("/sales/:id", (req, res): void => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = DeleteSaleParams.safeParse({ id: parseInt(raw, 10) });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const db = getDb();
  const result = db.prepare("DELETE FROM sales WHERE id = ?").run(parsed.data.id);

  if (result.changes === 0) {
    res.status(404).json({ error: "Sale not found" });
    return;
  }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

router.patch("/sales/:id/status", (req, res): void => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const paramsParsed = UpdateSaleStatusParams.safeParse({ id: parseInt(rawId, 10) });
  const bodyParsed = UpdateSaleStatusBody.safeParse(req.body);

  if (!paramsParsed.success || !bodyParsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  const db = getDb();
  const result = db
    .prepare("UPDATE sales SET status = ? WHERE id = ?")
    .run(bodyParsed.data.status, paramsParsed.data.id);

  if (result.changes === 0) {
    res.status(404).json({ error: "Sale not found" });
    return;
  }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
