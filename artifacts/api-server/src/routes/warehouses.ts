import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

router.get("/warehouses", async (_req, res): Promise<void> => {
  const result = await pool.query(
    "SELECT id, name, active FROM warehouses WHERE active = TRUE ORDER BY id"
  );
  res.json(result.rows);
});

router.post("/warehouses", async (req, res): Promise<void> => {
  const { name } = req.body ?? {};
  if (!name?.trim()) {
    res.status(400).json({ error: "name majburiy" });
    return;
  }
  const result = await pool.query(
    "INSERT INTO warehouses (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET active=TRUE RETURNING id, name",
    [name.trim()]
  );
  res.json(result.rows[0]);
});

router.delete("/warehouses/:id", async (req, res): Promise<void> => {
  await pool.query("UPDATE warehouses SET active=FALSE WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

export default router;
