import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  GetBatchesQueryParams,
  GetBatchesResponse,
  DeleteBatchParams,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/batches", async (req, res): Promise<void> => {
  const parsed = GetBatchesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { date, worker, product, limit = 50, offset = 0 } = parsed.data;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (date) {
    params.push(date);
    conditions.push(`created_at::date = $${params.length}`);
  }
  if (worker) {
    params.push(worker);
    conditions.push(`worker = $${params.length}`);
  }
  if (product) {
    params.push(product);
    conditions.push(`product = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const filterParams = [...params];

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const [itemsResult, countResult] = await Promise.all([
    pool.query(
      `SELECT id, batch_code, worker, product, quantity, weight_kg, earnings, created_at
       FROM batches ${where}
       ORDER BY id DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    ),
    pool.query(`SELECT COUNT(*) AS cnt FROM batches ${where}`, filterParams),
  ]);

  res.json(
    GetBatchesResponse.parse({
      items: itemsResult.rows.map((b) => ({
        id: b.id,
        batchCode: b.batch_code,
        worker: b.worker,
        product: b.product,
        quantity: b.quantity,
        weightKg: Number(b.weight_kg),
        earnings: Number(b.earnings),
        createdAt: b.created_at,
      })),
      total: Number(countResult.rows[0].cnt),
    })
  );
});

router.delete("/batches/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteBatchParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const result = await pool.query("DELETE FROM batches WHERE id = $1", [params.data.id]);

  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Batch not found" });
    return;
  }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
