import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  GetCustomersResponse,
  CreateCustomerBody,
  DeleteCustomerParams,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

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

router.post("/customers", async (req, res): Promise<void> => {
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
    [name, phone, company, address]
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

router.delete("/customers/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = DeleteCustomerParams.safeParse({ id: parseInt(raw, 10) });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const result = await pool.query("DELETE FROM customers WHERE id = $1", [parsed.data.id]);

  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
