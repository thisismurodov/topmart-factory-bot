import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const VALID_UNITS = ["dona", "kg", "metr", "qop"] as const;

const router: IRouter = Router();

router.get("/sales-products", async (_req, res): Promise<void> => {
  const result = await pool.query(
    "SELECT id, name, unit, price FROM sales_products WHERE active = TRUE ORDER BY name"
  );
  res.json(result.rows.map(r => ({
    id: r.id,
    name: r.name,
    unit: r.unit,
    price: Number(r.price),
  })));
});

router.post("/sales-products", async (req, res): Promise<void> => {
  const { name, unit = "dona", price = 0 } = req.body ?? {};
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!VALID_UNITS.includes(unit)) {
    res.status(400).json({ error: "invalid unit" });
    return;
  }
  try {
    const r = await pool.query(
      `INSERT INTO sales_products (name, unit, price)
       VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET unit=$2, price=$3, active=TRUE
       RETURNING id, name, unit, price`,
      [name, unit, price]
    );
    res.status(201).json({ id: r.rows[0].id, name: r.rows[0].name, unit: r.rows[0].unit, price: Number(r.rows[0].price) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/sales-products/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await pool.query("UPDATE sales_products SET active=FALSE WHERE id=$1", [id]);
  res.json({ ok: true });
});

export default router;
