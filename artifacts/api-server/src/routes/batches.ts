import { Router, type IRouter } from "express";
import { db, batchesTable } from "@workspace/db";
import { eq, desc, and, sql } from "drizzle-orm";
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

  const conditions = [];
  if (date) {
    conditions.push(sql`DATE(${batchesTable.createdAt}) = ${date}`);
  }
  if (worker) {
    conditions.push(eq(batchesTable.worker, worker));
  }
  if (product) {
    conditions.push(eq(batchesTable.product, product));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [items, countResult] = await Promise.all([
    db
      .select()
      .from(batchesTable)
      .where(where)
      .orderBy(desc(batchesTable.createdAt))
      .limit(limit ?? 50)
      .offset(offset ?? 0),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(batchesTable)
      .where(where),
  ]);

  const total = countResult[0]?.count ?? 0;

  res.json(
    GetBatchesResponse.parse({
      items: items.map((b) => ({
        ...b,
        weightKg: Number(b.weightKg),
        earnings: Number(b.earnings),
        createdAt: b.createdAt.toISOString(),
      })),
      total,
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

  const [deleted] = await db
    .delete(batchesTable)
    .where(eq(batchesTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Batch not found" });
    return;
  }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
