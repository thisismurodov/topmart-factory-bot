import { Router, type IRouter } from "express";
import { db, workersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GetWorkersResponse,
  CreateWorkerBody,
  DeleteWorkerParams,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/workers", async (_req, res): Promise<void> => {
  const workers = await db.select().from(workersTable);
  res.json(GetWorkersResponse.parse(workers));
});

router.post("/workers", async (req, res): Promise<void> => {
  const parsed = CreateWorkerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [worker] = await db
    .insert(workersTable)
    .values(parsed.data)
    .onConflictDoUpdate({ target: workersTable.name, set: parsed.data })
    .returning();

  res.status(201).json(worker);
});

router.delete("/workers/:name", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
  const params = DeleteWorkerParams.safeParse({ name: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(workersTable)
    .where(eq(workersTable.name, params.data.name))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Worker not found" });
    return;
  }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
