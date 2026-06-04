import { Router, type IRouter } from "express";
import { getDb } from "../lib/sqlite";
import { GetInventoryResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/inventory", (_req, res): void => {
  const db = getDb();

  const products = db
    .prepare("SELECT name, rate_type FROM products_config ORDER BY name")
    .all() as any[];

  const produced = db
    .prepare(
      `SELECT product,
              SUM(quantity) AS qty,
              SUM(weight_kg) AS kg
       FROM batches
       GROUP BY product`
    )
    .all() as any[];

  const sold = db
    .prepare(
      `SELECT product,
              SUM(quantity) AS qty,
              SUM(weight_kg) AS kg
       FROM sales
       GROUP BY product`
    )
    .all() as any[];

  const producedMap = new Map(
    produced.map((r) => [r.product, { qty: Number(r.qty), kg: Number(r.kg) }])
  );
  const soldMap = new Map(
    sold.map((r) => [r.product, { qty: Number(r.qty), kg: Number(r.kg) }])
  );

  const items = products.map((p) => {
    const pr = producedMap.get(p.name) ?? { qty: 0, kg: 0 };
    const sl = soldMap.get(p.name) ?? { qty: 0, kg: 0 };
    return {
      product: p.name,
      producedQty: pr.qty,
      producedKg: pr.kg,
      soldQty: sl.qty,
      soldKg: sl.kg,
      stockQty: pr.qty - sl.qty,
      stockKg: Math.max(0, pr.kg - sl.kg),
    };
  });

  res.json(GetInventoryResponse.parse(items));
});

export default router;
