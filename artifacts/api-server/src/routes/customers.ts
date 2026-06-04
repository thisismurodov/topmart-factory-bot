import { Router, type IRouter } from "express";
import { getDb } from "../lib/sqlite";
import {
  GetCustomersResponse,
  CreateCustomerBody,
  DeleteCustomerParams,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/customers", (_req, res): void => {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, name, phone, company, address, created_at FROM customers ORDER BY id DESC")
    .all() as any[];

  res.json(
    GetCustomersResponse.parse(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        phone: r.phone,
        company: r.company,
        address: r.address,
        createdAt: r.created_at,
      }))
    )
  );
});

router.post("/customers", (req, res): void => {
  const parsed = CreateCustomerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, phone, company, address } = parsed.data;
  const db = getDb();

  const result = db
    .prepare("INSERT INTO customers (name, phone, company, address) VALUES (?,?,?,?)")
    .run(name, phone, company, address);

  const row = db
    .prepare("SELECT id, name, phone, company, address, created_at FROM customers WHERE id = ?")
    .get(result.lastInsertRowid) as any;

  res.status(201).json({
    id: row.id,
    name: row.name,
    phone: row.phone,
    company: row.company,
    address: row.address,
    createdAt: row.created_at,
  });
});

router.delete("/customers/:id", (req, res): void => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = DeleteCustomerParams.safeParse({ id: parseInt(raw, 10) });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const db = getDb();
  const result = db.prepare("DELETE FROM customers WHERE id = ?").run(parsed.data.id);

  if (result.changes === 0) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
