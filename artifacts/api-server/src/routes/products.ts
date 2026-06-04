import { Router, type IRouter } from "express";
import { getDb, toApiRateType, toBotRateType } from "../lib/sqlite";
import {
  GetProductsResponse,
  CreateProductBody,
  DeleteProductParams,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/products", (_req, res): void => {
  const db = getDb();
  const rows = db
    .prepare("SELECT name, rate_type, rate FROM products_config ORDER BY name")
    .all() as any[];

  res.json(
    GetProductsResponse.parse(
      rows.map((p) => ({
        name: p.name,
        rateType: toApiRateType(p.rate_type),
        rate: Number(p.rate),
      }))
    )
  );
});

router.post("/products", (req, res): void => {
  const parsed = CreateProductBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, rateType, rate } = parsed.data;
  const botRateType = toBotRateType(rateType);
  const db = getDb();

  try {
    db.prepare(
      "INSERT OR REPLACE INTO products_config (name, rate_type, rate) VALUES (?,?,?)"
    ).run(name, botRateType, rate);

    res.status(201).json({ name, rateType, rate });
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

router.delete("/products/:name", (req, res): void => {
  const raw = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
  const params = DeleteProductParams.safeParse({ name: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const db = getDb();
  const result = db
    .prepare("DELETE FROM products_config WHERE name = ?")
    .run(params.data.name);

  if (result.changes === 0) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
