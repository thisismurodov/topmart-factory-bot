import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  GetProductsResponse,
  CreateProductBody,
  DeleteProductParams,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function toApiRateType(rt: string): string {
  return rt === "kg" ? "per_kg" : "per_piece";
}

function toBotRateType(rt: string): string {
  return rt === "per_kg" ? "kg" : "dona";
}

router.get("/products", async (_req, res): Promise<void> => {
  const result = await pool.query("SELECT name, rate_type, rate FROM products ORDER BY name");
  res.json(
    GetProductsResponse.parse(
      result.rows.map((p) => ({
        name: p.name,
        rateType: toApiRateType(p.rate_type),
        rate: Number(p.rate),
      }))
    )
  );
});

router.post("/products", async (req, res): Promise<void> => {
  const parsed = CreateProductBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, rateType, rate } = parsed.data;
  const botRateType = toBotRateType(rateType);

  try {
    await pool.query(
      `INSERT INTO products (name, rate_type, rate)
       VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET rate_type = $2, rate = $3`,
      [name, botRateType, rate]
    );
    res.status(201).json({ name, rateType, rate });
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

router.delete("/products/:name", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
  const params = DeleteProductParams.safeParse({ name: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const result = await pool.query("DELETE FROM products WHERE name = $1", [params.data.name]);

  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
