import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { actingUser } from "./ombor";

const router: IRouter = Router();

/* ── GET /inventory/stock  — per-warehouse stock ── */
router.get("/inventory/stock", async (req, res): Promise<void> => {
  const warehouseId = req.query.warehouse_id ? Number(req.query.warehouse_id) : null;

  const whereClause = warehouseId ? "WHERE i.warehouse_id = $1" : "";
  const params = warehouseId ? [warehouseId] : [];

  const result = await pool.query(
    `SELECT
       w.id   AS warehouse_id,
       w.name AS warehouse_name,
       i.product,
       i.quantity,
       i.updated_at
     FROM inventory i
     JOIN warehouses w ON w.id = i.warehouse_id
     ${whereClause}
     ORDER BY w.id, i.product`,
    params
  );

  // Group by warehouse
  const map: Record<number, { id: number; name: string; items: { product: string; quantity: number }[] }> = {};
  for (const r of result.rows) {
    if (!map[r.warehouse_id]) map[r.warehouse_id] = { id: r.warehouse_id, name: r.warehouse_name, items: [] };
    map[r.warehouse_id].items.push({ product: r.product, quantity: Number(r.quantity) });
  }

  res.json(Object.values(map));
});

/* ── GET /inventory/summary  — overall summary ── */
router.get("/inventory/summary", async (_req, res): Promise<void> => {
  const [skuRes, stockRes, warehouseRes, lowRes] = await Promise.all([
    pool.query("SELECT COUNT(DISTINCT product)::int AS sku_count FROM inventory WHERE quantity > 0"),
    pool.query("SELECT COALESCE(SUM(quantity),0) AS total FROM inventory"),
    pool.query("SELECT COUNT(*)::int AS cnt FROM warehouses WHERE active=TRUE"),
    pool.query(
      `SELECT product, SUM(quantity) AS qty
       FROM inventory GROUP BY product
       HAVING SUM(quantity) < 50 AND SUM(quantity) >= 0
       ORDER BY SUM(quantity) ASC LIMIT 10`
    ),
  ]);
  res.json({
    skuCount:       Number(skuRes.rows[0].sku_count),
    totalStock:     Number(stockRes.rows[0].total),
    warehouseCount: Number(warehouseRes.rows[0].cnt),
    lowStock:       lowRes.rows.map((r) => ({ product: r.product, qty: Number(r.qty) })),
  });
});

/* ── POST /inventory/movement  — IN / OUT / TRANSFER ── */
router.post("/inventory/movement", async (req, res): Promise<void> => {
  const { product, quantity, movement_type, from_warehouse_id, to_warehouse_id, note } = req.body ?? {};

  if (!product || !quantity || !movement_type) {
    res.status(400).json({ error: "product, quantity, movement_type majburiy" });
    return;
  }
  if (!["IN", "OUT", "TRANSFER"].includes(movement_type)) {
    res.status(400).json({ error: "movement_type: IN | OUT | TRANSFER" });
    return;
  }
  const qty = Number(quantity);
  if (isNaN(qty) || qty <= 0) {
    res.status(400).json({ error: "quantity musbat son bo'lishi kerak" });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Og'irlik sinxroni (ombor.ts bilan bir xil qoida):
    // - OUT/TRANSFER: mavjud qatordagi og'irlikdan proporsional ayiramiz.
    // - IN: partiya nisbati (SUM(weight_kg)/SUM(quantity)) bo'yicha hisoblaymiz.
    // Chiqadigan qatorning turi ko'chadi; yangi kirimda 'finished' deb olamiz.

    // Manba qatori (OUT / TRANSFER uchun)
    const srcWarehouseId = movement_type === "IN" ? null : from_warehouse_id ?? null;
    let srcQty = 0, srcWeight = 0;
    let productType = "finished";
    if (srcWarehouseId) {
      const srcRes = await client.query(
        "SELECT quantity, weight_kg, product_type FROM inventory WHERE warehouse_id=$1 AND product=$2",
        [srcWarehouseId, product]
      );
      if (srcRes.rows.length) {
        srcQty      = Number(srcRes.rows[0].quantity) || 0;
        srcWeight   = Number(srcRes.rows[0].weight_kg) || 0;
        productType = (srcRes.rows[0].product_type as string) || "finished";
      }
    }
    // Proporsional ko'chiriladigan og'irlik (OUT/TRANSFER)
    const moveWeight = srcQty > 0 && srcWeight > 0
      ? Math.min(srcWeight, (srcWeight * qty) / srcQty)
      : 0;

    // IN uchun: kg-mahsulot og'irligini partiya nisbatidan hisoblaymiz
    let inWeight = 0;
    if (movement_type === "IN" && to_warehouse_id) {
      const wr = await client.query(
        `SELECT CASE WHEN LOWER(p.unit_type) = 'kg' AND COALESCE(SUM(b.quantity),0) > 0
                     THEN SUM(b.weight_kg)::numeric / SUM(b.quantity)
                     ELSE 0 END AS kg_per_unit
         FROM products p
         LEFT JOIN batches b ON b.product = p.name
         WHERE p.name = $1
         GROUP BY p.unit_type`,
        [product]
      );
      const kgPerUnit = wr.rows.length ? Number(wr.rows[0].kg_per_unit) || 0 : 0;
      inWeight = kgPerUnit > 0 ? qty * kgPerUnit : 0;
    }

    // Record movement
    await client.query(
      `INSERT INTO stock_movements (product, quantity, movement_type, from_warehouse_id, to_warehouse_id, note, created_by, product_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [product, qty, movement_type,
        from_warehouse_id ?? null, to_warehouse_id ?? null,
        note ?? "", actingUser(req), productType]
    );

    // Update inventory
    if (movement_type === "IN" && to_warehouse_id) {
      await client.query(
        `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (warehouse_id, product)
         DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity,
                       weight_kg = inventory.weight_kg + EXCLUDED.weight_kg,
                       updated_at=NOW()`,
        [to_warehouse_id, product, qty, inWeight, productType]
      );
    } else if (movement_type === "OUT" && from_warehouse_id) {
      await client.query(
        `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type, updated_at)
         VALUES ($1,$2,0,0,$3,NOW())
         ON CONFLICT (warehouse_id, product)
         DO UPDATE SET quantity = GREATEST(0, inventory.quantity - $4),
                       weight_kg = GREATEST(0, inventory.weight_kg - $5),
                       updated_at=NOW()`,
        [from_warehouse_id, product, productType, qty, moveWeight]
      );
    } else if (movement_type === "TRANSFER" && from_warehouse_id && to_warehouse_id) {
      await client.query(
        `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type, updated_at)
         VALUES ($1,$2,0,0,$3,NOW())
         ON CONFLICT (warehouse_id, product)
         DO UPDATE SET quantity = GREATEST(0, inventory.quantity - $4),
                       weight_kg = GREATEST(0, inventory.weight_kg - $5),
                       updated_at=NOW()`,
        [from_warehouse_id, product, productType, qty, moveWeight]
      );
      await client.query(
        `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (warehouse_id, product)
         DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity,
                       weight_kg = inventory.weight_kg + EXCLUDED.weight_kg,
                       updated_at=NOW()`,
        [to_warehouse_id, product, qty, moveWeight, productType]
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

/* ── GET /inventory/movements  — audit history ── */
router.get("/inventory/movements", async (req, res): Promise<void> => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const result = await pool.query(
    `SELECT
       m.id, m.product, m.quantity, m.movement_type,
       fw.name AS from_warehouse,
       tw.name AS to_warehouse,
       m.note, m.created_by,
       m.created_at
     FROM stock_movements m
     LEFT JOIN warehouses fw ON fw.id = m.from_warehouse_id
     LEFT JOIN warehouses tw ON tw.id = m.to_warehouse_id
     ORDER BY m.id DESC
     LIMIT $1`,
    [limit]
  );
  res.json(result.rows.map((r) => ({
    id: r.id,
    product: r.product,
    quantity: Number(r.quantity),
    movementType: r.movement_type,
    fromWarehouse: r.from_warehouse ?? null,
    toWarehouse: r.to_warehouse ?? null,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  })));
});

export default router;
