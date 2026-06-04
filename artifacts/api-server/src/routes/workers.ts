import { Router, type IRouter } from "express";
import { getDb } from "../lib/sqlite";
import {
  GetWorkersResponse,
  CreateWorkerBody,
  DeleteWorkerParams,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/workers", (_req, res): void => {
  const db = getDb();
  const rows = db
    .prepare("SELECT name, prefix, phone, role FROM workers_config ORDER BY name")
    .all() as any[];

  res.json(GetWorkersResponse.parse(rows));
});

router.post("/workers", (req, res): void => {
  const parsed = CreateWorkerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, prefix, phone, role } = parsed.data;
  const db = getDb();

  try {
    db.prepare(
      "INSERT OR REPLACE INTO workers_config (name, prefix, phone, role) VALUES (?,?,?,?)"
    ).run(name, prefix.toUpperCase(), phone, role);

    res.status(201).json({ name, prefix: prefix.toUpperCase(), phone, role });
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

router.delete("/workers/:name", (req, res): void => {
  const raw = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
  const params = DeleteWorkerParams.safeParse({ name: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const db = getDb();
  const result = db
    .prepare("DELETE FROM workers_config WHERE name = ?")
    .run(params.data.name);

  if (result.changes === 0) {
    res.status(404).json({ error: "Worker not found" });
    return;
  }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
