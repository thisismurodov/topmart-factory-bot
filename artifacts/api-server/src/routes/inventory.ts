import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { GetInventoryResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/inventory", async (_req, res): Promise<void> => {
  const [productsResult, producedResult, soldResult] = await Promise.all([
    pool.query("SELECT name FROM products ORDER BY name"),
    pool.query(
      `SELECT product, COALESCE(SUM(quantity), 0) AS qty, COALESCE(SUM(weight_kg), 0) AS kg
       FROM batches GROUP BY product`
    ),
    pool.query(
      `SELECT product, COALESCE(SUM(quantity), 0) AS qty, COALESCE(SUM(weight_kg), 0) AS kg
       FROM sales GROUP BY product`
    ),
  ]);

  const producedMap = new Map(
    producedResult.rows.map((r) => [r.product, { qty: Number(r.qty), kg: Number(r.kg) }])
  );
  const soldMap = new Map(
    soldResult.rows.map((r) => [r.product, { qty: Number(r.qty), kg: Number(r.kg) }])
  );

  const items = productsResult.rows.map((p) => {
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
