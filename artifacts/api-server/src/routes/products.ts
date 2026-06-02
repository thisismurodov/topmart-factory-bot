import { Router, type IRouter } from "express";
import { db, productsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GetProductsResponse,
  CreateProductBody,
  DeleteProductParams,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/products", async (_req, res): Promise<void> => {
  const products = await db.select().from(productsTable);
  res.json(
    GetProductsResponse.parse(
      products.map((p) => ({ ...p, rate: Number(p.rate) }))
    )
  );
});

router.post("/products", async (req, res): Promise<void> => {
  const parsed = CreateProductBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [product] = await db
    .insert(productsTable)
    .values({ ...parsed.data, rate: String(parsed.data.rate) })
    .onConflictDoUpdate({
      target: productsTable.name,
      set: { rateType: parsed.data.rateType, rate: String(parsed.data.rate) },
    })
    .returning();

  res.status(201).json({ ...product, rate: Number(product.rate) });
});

router.delete("/products/:name", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
  const params = DeleteProductParams.safeParse({ name: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(productsTable)
    .where(eq(productsTable.name, params.data.name))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
