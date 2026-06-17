import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getUsdToUzsRate } from "../lib/exchangeRate";

const router: IRouter = Router();

// ── GET /api/ombor/summary ─────────────────────────────────────────────────────
router.get("/ombor/summary", async (_req, res): Promise<void> => {
  const { rate } = await getUsdToUzsRate();

  const [rawRes, fgRes] = await Promise.all([
    pool.query(`
      SELECT
        COALESCE(SUM(
          CASE WHEN UPPER(currency) = 'USD'
               THEN current_stock * default_cost * $1::numeric
               ELSE current_stock * default_cost
          END
        ), 0)::numeric AS value_uzs,
        COUNT(*)::int AS total_count,
        COUNT(*) FILTER (WHERE minimum_stock > 0 AND current_stock <= minimum_stock)::int AS low_count
      FROM raw_materials
      WHERE active = TRUE
    `, [rate ?? 0]),

    pool.query(`
      SELECT
        COALESCE(SUM(i.quantity * p.default_sale_price), 0)::numeric AS value_uzs,
        COUNT(DISTINCT i.product) FILTER (WHERE i.quantity > 0)::int AS sku_count
      FROM inventory i
      JOIN products p ON p.name = i.product
    `),
  ]);

  const raw = rawRes.rows[0];
  const fg  = fgRes.rows[0];
  const rawVal = Number(raw.value_uzs);
  const fgVal  = Number(fg.value_uzs);

  res.json({
    rawMaterialValueUzs:  rawVal,
    finishedGoodsValueUzs: fgVal,
    totalValueUzs:         rawVal + fgVal,
    rawMaterialCount:      Number(raw.total_count),
    finishedGoodsSkuCount: Number(fg.sku_count),
    lowStockRawCount:      Number(raw.low_count),
    usdRate:               rate ?? 0,
  });
});

// ── GET /api/ombor/raw-materials ───────────────────────────────────────────────
router.get("/ombor/raw-materials", async (_req, res): Promise<void> => {
  const { rate } = await getUsdToUzsRate();

  const { rows } = await pool.query(`
    SELECT
      rm.id,
      rm.name,
      rm.unit,
      rm.unit_type,
      rm.default_cost,
      rm.currency,
      rm.current_stock,
      rm.minimum_stock,
      rm.active,
      COALESCE(
        (SELECT SUM(pm.quantity_required * b.quantity)::numeric
         FROM product_materials pm
         JOIN batches b ON b.product = pm.product_name
         WHERE pm.raw_material_id = rm.id
           AND b.created_at >= NOW() - INTERVAL '30 days') / 30
      , 0) AS avg_daily
    FROM raw_materials rm
    WHERE rm.active = TRUE
    ORDER BY rm.name
  `);

  res.json(rows.map((r) => {
    const isUsd        = String(r.currency).toUpperCase() === "USD";
    const costUzs      = isUsd ? Number(r.default_cost) * (rate ?? 0) : Number(r.default_cost);
    const stock        = Number(r.current_stock);
    const avgDaily     = Number(r.avg_daily);
    const daysRemaining = avgDaily > 0 ? Math.floor(stock / avgDaily) : null;
    return {
      id:             r.id,
      name:           r.name,
      unit:           r.unit_type || r.unit || "kg",
      defaultCost:    Number(r.default_cost),
      currency:       r.currency || "UZS",
      uzsCostPerUnit: costUzs,
      currentStock:   stock,
      minimumStock:   Number(r.minimum_stock),
      totalValueUzs:  stock * costUzs,
      avgDailyConsumption: Number(avgDaily.toFixed(3)),
      daysRemaining,
    };
  }));
});

// ── POST /api/ombor/raw-in ─────────────────────────────────────────────────────
router.post("/ombor/raw-in", async (req, res): Promise<void> => {
  const { materialId, qty, cost, currency, note = "" } = req.body ?? {};

  if (!materialId || typeof materialId !== "number") {
    res.status(400).json({ error: "materialId required" }); return;
  }
  const amount = Number(qty);
  if (isNaN(amount) || amount <= 0) {
    res.status(400).json({ error: "qty must be > 0" }); return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const matRes = await client.query(
      "SELECT id, name, unit FROM raw_materials WHERE id = $1",
      [materialId],
    );
    if (!matRes.rows.length) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Xom ashyo topilmadi" }); return;
    }
    const mat = matRes.rows[0];

    // stock ni yangilaymiz
    const updRes = await client.query(
      `UPDATE raw_materials
       SET current_stock = current_stock + $1,
           default_cost  = COALESCE(NULLIF($2::text,'')::numeric, default_cost),
           currency      = COALESCE(NULLIF($3::text,''), currency)
       WHERE id = $4
       RETURNING current_stock`,
      [amount, cost != null ? String(cost) : "", currency || "", materialId],
    );

    // movement logga yozamiz
    await client.query(
      `INSERT INTO stock_movements
         (product, quantity, movement_type, to_warehouse_id, note, created_by, product_type)
       VALUES ($1,$2,'IN',NULL,$3,'admin','raw')`,
      [mat.name, amount, note || `Kirdi: ${amount} ${mat.unit}`],
    );

    await client.query("COMMIT");
    res.json({
      ok: true,
      name: mat.name,
      newStock: Number(updRes.rows[0].current_stock),
    });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── GET /api/ombor/finished-goods ─────────────────────────────────────────────
router.get("/ombor/finished-goods", async (_req, res): Promise<void> => {
  const { rate } = await getUsdToUzsRate();

  const { rows } = await pool.query(`
    SELECT
      i.product,
      SUM(i.quantity)::numeric AS stock_qty,
      p.default_sale_price,
      p.currency_type,
      p.unit_type
    FROM inventory i
    JOIN products p ON p.name = i.product
    GROUP BY i.product, p.default_sale_price, p.currency_type, p.unit_type
    HAVING SUM(i.quantity) > 0
    ORDER BY i.product
  `);

  res.json(rows.map((r) => {
    const isUsd      = String(r.currency_type).toUpperCase() === "USD";
    const priceUzs   = isUsd ? Number(r.default_sale_price) * (rate ?? 0) : Number(r.default_sale_price);
    const stockQty   = Number(r.stock_qty);
    return {
      product:       r.product,
      stockQty,
      unitType:      r.unit_type || "dona",
      salePrice:     Number(r.default_sale_price),
      currency:      r.currency_type || "UZS",
      priceUzs,
      totalValueUzs: stockQty * priceUzs,
    };
  }));
});

// ── GET /api/ombor/movements ───────────────────────────────────────────────────
router.get("/ombor/movements", async (req, res): Promise<void> => {
  const limit     = Math.min(Number(req.query.limit ?? 80), 200);
  const typeFilter = req.query.type ? String(req.query.type) : null;

  const params: unknown[] = [limit];
  const where = typeFilter ? `WHERE sm.product_type = $2` : "";
  if (typeFilter) params.push(typeFilter);

  const { rows } = await pool.query(
    `SELECT
       sm.id,
       sm.product,
       sm.quantity,
       sm.movement_type,
       sm.product_type,
       fw.name AS from_warehouse,
       tw.name AS to_warehouse,
       sm.note,
       sm.created_by,
       sm.created_at
     FROM stock_movements sm
     LEFT JOIN warehouses fw ON fw.id = sm.from_warehouse_id
     LEFT JOIN warehouses tw ON tw.id = sm.to_warehouse_id
     ${where}
     ORDER BY sm.id DESC
     LIMIT $1`,
    params,
  );

  res.json(rows.map((r) => ({
    id:            r.id,
    product:       r.product,
    quantity:      Number(r.quantity),
    movementType:  r.movement_type,
    productType:   r.product_type || "finished",
    fromWarehouse: r.from_warehouse ?? null,
    toWarehouse:   r.to_warehouse ?? null,
    note:          r.note || "",
    createdBy:     r.created_by || "",
    createdAt:     r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  })));
});

export default router;
