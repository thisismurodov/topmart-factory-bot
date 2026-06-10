import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

// ── GET /products/:name/materials ─────────────────────────────────────────────
router.get("/products/:name/materials", async (req, res): Promise<void> => {
  const productName = decodeURIComponent(req.params.name);
  const { rows } = await pool.query(
    `SELECT pm.id, pm.raw_material_id, pm.quantity_required,
            rm.name AS raw_material_name, rm.unit_type, rm.default_cost
     FROM product_materials pm
     JOIN raw_materials rm ON rm.id = pm.raw_material_id
     WHERE pm.product_name = $1
     ORDER BY rm.name`,
    [productName]
  );
  res.json(rows.map(r => ({
    id:              r.id,
    rawMaterialId:   r.raw_material_id,
    rawMaterialName: r.raw_material_name,
    unitType:        r.unit_type,
    defaultCost:     Number(r.default_cost),
    quantityRequired:Number(r.quantity_required),
    lineCost:        Number(r.default_cost) * Number(r.quantity_required),
  })));
});

// ── POST /products/:name/materials ────────────────────────────────────────────
router.post("/products/:name/materials", async (req, res): Promise<void> => {
  const productName = decodeURIComponent(req.params.name);
  const { rawMaterialId, quantityRequired } = req.body ?? {};

  if (!rawMaterialId || quantityRequired == null) {
    res.status(400).json({ error: "rawMaterialId and quantityRequired are required" }); return;
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO product_materials (product_name, raw_material_id, quantity_required)
       VALUES ($1,$2,$3)
       ON CONFLICT (product_name, raw_material_id)
         DO UPDATE SET quantity_required=$3
       RETURNING id, product_name, raw_material_id, quantity_required`,
      [productName, Number(rawMaterialId), Number(quantityRequired)]
    );
    res.status(201).json({
      id: rows[0].id,
      productName: rows[0].product_name,
      rawMaterialId: rows[0].raw_material_id,
      quantityRequired: Number(rows[0].quantity_required),
    });
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

// ── DELETE /products/:name/materials/:id ──────────────────────────────────────
router.delete("/products/:name/materials/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await pool.query("DELETE FROM product_materials WHERE id=$1", [id]);
  res.json({ ok: true });
});

export default router;
