import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  GetWorkersResponse,
  CreateWorkerBody,
  DeleteWorkerParams,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/workers", async (_req, res): Promise<void> => {
  const result = await pool.query(
    "SELECT name, prefix, phone, role FROM workers ORDER BY name"
  );
  res.json(GetWorkersResponse.parse(result.rows));
});

router.post("/workers", async (req, res): Promise<void> => {
  const parsed = CreateWorkerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, prefix, phone, role } = parsed.data;
  const upperPrefix = prefix.toUpperCase();

  try {
    await pool.query(
      `INSERT INTO workers (name, prefix, phone, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE SET prefix = $2, phone = $3, role = $4`,
      [name, upperPrefix, phone, role]
    );
    res.status(201).json({ name, prefix: upperPrefix, phone, role });
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

router.delete("/workers/:name", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
  const params = DeleteWorkerParams.safeParse({ name: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const result = await pool.query("DELETE FROM workers WHERE name = $1", [params.data.name]);

  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Worker not found" });
    return;
  }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
