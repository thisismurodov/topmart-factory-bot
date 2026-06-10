import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

// ── GET /products — list all ──────────────────────────────────────────────────
router.get("/products", async (_req, res): Promise<void> => {
  const { rows } = await pool.query(`
    SELECT
      p.id, p.name, p.sku, p.unit_type, p.currency_type,
      p.default_sale_price, p.rate, p.rate_type,
      p.salary_cost, p.electricity_cost, p.other_cost,
      p.minimum_stock, p.active, p.created_at,
      COALESCE(
        (SELECT SUM(rm.default_cost * pm.quantity_required)
         FROM product_materials pm
         JOIN raw_materials rm ON rm.id = pm.raw_material_id
         WHERE pm.product_name = p.name), 0
      ) AS raw_material_cost
    FROM products p
    ORDER BY p.name
  `);

  res.json(rows.map(row => ({
    id:               row.id,
    name:             row.name,
    sku:              row.sku,
    unitType:         row.unit_type,
    currencyType:     row.currency_type,
    defaultSalePrice: Number(row.default_sale_price),
    rate:             Number(row.rate),
    rateType:         row.rate_type,
    salaryCost:       Number(row.salary_cost),
    electricityCost:  Number(row.electricity_cost),
    otherCost:        Number(row.other_cost),
    rawMaterialCost:  Number(row.raw_material_cost),
    totalCost:        Number(row.salary_cost) + Number(row.electricity_cost) + Number(row.other_cost) + Number(row.raw_material_cost),
    profit:           Number(row.default_sale_price) - Number(row.salary_cost) - Number(row.electricity_cost) - Number(row.other_cost) - Number(row.raw_material_cost),
    minimumStock:     row.minimum_stock,
    active:           row.active,
    createdAt:        row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  })));
});

// ── POST /products — create ───────────────────────────────────────────────────
router.post("/products", async (req, res): Promise<void> => {
  const {
    name, sku = "", unitType = "dona", currencyType = "UZS",
    defaultSalePrice = 0, rate = 0, rateType,
    salaryCost = 0, electricityCost = 0, otherCost = 0,
    minimumStock = 0, active = true,
  } = req.body ?? {};

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name is required" }); return;
  }

  const finalRateType = rateType || unitType;

  try {
    const { rows } = await pool.query(
      `INSERT INTO products
         (name, sku, unit_type, currency_type, default_sale_price, rate, rate_type,
          salary_cost, electricity_cost, other_cost, minimum_stock, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (name) DO UPDATE SET
         sku=$2, unit_type=$3, currency_type=$4, default_sale_price=$5, rate=$6, rate_type=$7,
         salary_cost=$8, electricity_cost=$9, other_cost=$10, minimum_stock=$11, active=$12
       RETURNING id, name, sku, unit_type, currency_type, default_sale_price, rate, rate_type,
                 salary_cost, electricity_cost, other_cost, minimum_stock, active`,
      [name.trim(), sku, unitType, currencyType, Number(defaultSalePrice), Number(rate),
       finalRateType, Number(salaryCost), Number(electricityCost), Number(otherCost),
       Number(minimumStock), Boolean(active)]
    );
    const p = rows[0];
    res.status(201).json({
      id: p.id, name: p.name, sku: p.sku,
      unitType: p.unit_type, currencyType: p.currency_type,
      defaultSalePrice: Number(p.default_sale_price),
      rate: Number(p.rate), rateType: p.rate_type,
      salaryCost: Number(p.salary_cost), electricityCost: Number(p.electricity_cost),
      otherCost: Number(p.other_cost), minimumStock: p.minimum_stock, active: p.active,
    });
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

// ── PATCH /products/:name — update ────────────────────────────────────────────
router.patch("/products/:name", async (req, res): Promise<void> => {
  const productName = decodeURIComponent(req.params.name);
  const fields: string[] = [];
  const vals: unknown[] = [];

  const allowed = [
    ["sku", "sku"], ["unit_type", "unitType"], ["currency_type", "currencyType"],
    ["default_sale_price", "defaultSalePrice"], ["rate", "rate"], ["rate_type", "rateType"],
    ["salary_cost", "salaryCost"], ["electricity_cost", "electricityCost"],
    ["other_cost", "otherCost"], ["minimum_stock", "minimumStock"], ["active", "active"],
  ];

  for (const [col, key] of allowed) {
    if (req.body[key] !== undefined) {
      vals.push(req.body[key]);
      fields.push(`${col}=$${vals.length}`);
    }
  }

  if (fields.length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
  vals.push(productName);

  await pool.query(`UPDATE products SET ${fields.join(",")} WHERE name=$${vals.length}`, vals);
  res.json({ ok: true });
});

// ── DELETE /products/:name ─────────────────────────────────────────────────────
router.delete("/products/:name", async (req, res): Promise<void> => {
  const productName = decodeURIComponent(req.params.name);
  const result = await pool.query("DELETE FROM products WHERE name=$1", [productName]);
  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Product not found" }); return;
  }
  res.json({ ok: true });
});

// ── GET /products/:name/profitability ─────────────────────────────────────────
router.get("/products/:name/profitability", async (req, res): Promise<void> => {
  const productName = decodeURIComponent(req.params.name);

  const [prodRes, salesRes] = await Promise.all([
    pool.query(
      `SELECT p.*,
        COALESCE((
          SELECT SUM(rm.default_cost * pm.quantity_required)
          FROM product_materials pm
          JOIN raw_materials rm ON rm.id = pm.raw_material_id
          WHERE pm.product_name = p.name
        ), 0) AS raw_material_cost
       FROM products p WHERE p.name=$1`, [productName]
    ),
    pool.query(
      `SELECT
         COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='uzs'), 0) AS revenue_uzs,
         COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='usd'), 0) AS revenue_usd,
         COALESCE(SUM(si.quantity), 0) AS units_sold
       FROM sale_items si
       WHERE si.product_name = $1`, [productName]
    ),
  ]);

  if (!prodRes.rows.length) { res.status(404).json({ error: "Product not found" }); return; }

  const p = prodRes.rows[0];
  const s = salesRes.rows[0];
  const rawCost = Number(p.raw_material_cost);
  const totalCost = rawCost + Number(p.salary_cost) + Number(p.electricity_cost) + Number(p.other_cost);
  const salePrice = Number(p.default_sale_price);
  const profit = salePrice - totalCost;
  const marginPct = salePrice > 0 ? (profit / salePrice) * 100 : 0;

  res.json({
    name:            p.name,
    salePrice,
    rawMaterialCost: rawCost,
    salaryCost:      Number(p.salary_cost),
    electricityCost: Number(p.electricity_cost),
    otherCost:       Number(p.other_cost),
    totalCost,
    profit,
    marginPct:       Math.round(marginPct * 100) / 100,
    revenueUzs:      Number(s.revenue_uzs),
    revenueUsd:      Number(s.revenue_usd),
    unitsSold:       Number(s.units_sold),
  });
});

export default router;
