import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getUsdToUzsRate } from "../lib/exchangeRate";

const router: IRouter = Router();

function toRow(r: any, rate: number | null = null) {
  const currency    = r.currency || "UZS";
  const defaultCost = Number(r.default_cost);
  const qty         = Number(r.quantity_required);
  const isUsd       = String(currency).toUpperCase() === "USD";
  const uzsUnitCost = rate != null && isUsd ? defaultCost * rate : defaultCost;
  return {
    id:              r.id,
    productName:     r.product_name,
    rawMaterialId:   r.raw_material_id,
    rawMaterialName: r.raw_material_name,
    unitType:        r.unit_type,
    defaultCost,
    currency,
    quantityRequired:qty,
    lineCost:        defaultCost * qty,
    // Joriy UZS ekvivalenti (USD xom ashyo jonli kursga aylantiriladi).
    calculatedUzsLineCost: uzsUnitCost * qty,
  };
}

// ── GET /product-materials?productName=X — flat list ──────────────────────────
router.get("/product-materials", async (req, res): Promise<void> => {
  const { rate } = await getUsdToUzsRate();
  const where = req.query.productName ? "WHERE pm.product_name = $1" : "";
  const params = req.query.productName ? [req.query.productName as string] : [];
  const { rows } = await pool.query(
    `SELECT pm.id, pm.product_name, pm.raw_material_id, pm.quantity_required,
            rm.name AS raw_material_name, rm.unit_type, rm.default_cost, rm.currency
     FROM product_materials pm
     JOIN raw_materials rm ON rm.id = pm.raw_material_id
     ${where}
     ORDER BY pm.product_name, rm.name`,
    params
  );
  res.json(rows.map(r => toRow(r, rate)));
});

// ── POST /product-materials — create ─────────────────────────────────────────
router.post("/product-materials", async (req, res): Promise<void> => {
  const { productName, rawMaterialId, quantityRequired } = req.body ?? {};
  if (!productName || !rawMaterialId || quantityRequired == null) {
    res.status(400).json({ error: "productName, rawMaterialId and quantityRequired are required" }); return;
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
    const rm = await pool.query(
      "SELECT name, unit_type, default_cost, currency FROM raw_materials WHERE id=$1", [Number(rawMaterialId)]
    );
    const r = { ...rows[0], raw_material_name: rm.rows[0]?.name ?? "", unit_type: rm.rows[0]?.unit_type ?? "", default_cost: rm.rows[0]?.default_cost ?? 0, currency: rm.rows[0]?.currency ?? "UZS" };
    res.status(201).json(toRow(r));
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

// ── PATCH /product-materials/:id — update quantity ───────────────────────────
router.patch("/product-materials/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { quantityRequired } = req.body ?? {};
  if (quantityRequired == null) { res.status(400).json({ error: "quantityRequired is required" }); return; }
  await pool.query("UPDATE product_materials SET quantity_required=$1 WHERE id=$2", [Number(quantityRequired), id]);
  res.json({ ok: true });
});

// ── DELETE /product-materials/:id ─────────────────────────────────────────────
router.delete("/product-materials/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await pool.query("DELETE FROM product_materials WHERE id=$1", [id]);
  res.json({ ok: true });
});

// ── GET /products/:name/materials ─────────────────────────────────────────────
router.get("/products/:name/materials", async (req, res): Promise<void> => {
  const productName = decodeURIComponent(req.params.name);
  const { rate } = await getUsdToUzsRate();
  const { rows } = await pool.query(
    `SELECT pm.id, pm.raw_material_id, pm.quantity_required,
            rm.name AS raw_material_name, rm.unit_type, rm.default_cost, rm.currency
     FROM product_materials pm
     JOIN raw_materials rm ON rm.id = pm.raw_material_id
     WHERE pm.product_name = $1
     ORDER BY rm.name`,
    [productName]
  );
  res.json(rows.map(r => {
    const currency    = r.currency || "UZS";
    const defaultCost = Number(r.default_cost);
    const qty         = Number(r.quantity_required);
    const uzsUnitCost = String(currency).toUpperCase() === "USD" ? defaultCost * rate : defaultCost;
    return {
      id:              r.id,
      rawMaterialId:   r.raw_material_id,
      rawMaterialName: r.raw_material_name,
      unitType:        r.unit_type,
      defaultCost,
      currency,
      quantityRequired:qty,
      lineCost:        defaultCost * qty,
      calculatedUzsLineCost: uzsUnitCost * qty,
    };
  }));
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
