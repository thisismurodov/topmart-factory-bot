import { Router, type IRouter } from "express";
import { getDb } from "../lib/sqlite";
import {
  GetBatchesQueryParams,
  GetBatchesResponse,
  DeleteBatchParams,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/batches", (req, res): void => {
  const parsed = GetBatchesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { date, worker, product, limit = 50, offset = 0 } = parsed.data;
  const db = getDb();

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (date) {
    conditions.push("DATE(created_at) = ?");
    params.push(date);
  }
  if (worker) {
    conditions.push("worker = ?");
    params.push(worker);
  }
  if (product) {
    conditions.push("product = ?");
    params.push(product);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const items = db
    .prepare(
      `SELECT id, batch_code, worker, product, quantity, weight_kg, earnings, created_at
       FROM batches ${where}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as any[];

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS cnt FROM batches ${where}`)
      .get(...params) as any
  ).cnt;

  res.json(
    GetBatchesResponse.parse({
      items: items.map((b) => ({
        id: b.id,
        batchCode: b.batch_code,
        worker: b.worker,
        product: b.product,
        quantity: b.quantity,
        weightKg: Number(b.weight_kg),
        earnings: Number(b.earnings),
        createdAt: b.created_at,
      })),
      total,
    })
  );
});

router.delete("/batches/:id", (req, res): void => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteBatchParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const db = getDb();
  const result = db.prepare("DELETE FROM batches WHERE id = ?").run(params.data.id);

  if (result.changes === 0) {
    res.status(404).json({ error: "Batch not found" });
    return;
  }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
