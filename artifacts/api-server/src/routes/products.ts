import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getUsdToUzsRate } from "../lib/exchangeRate";

const router: IRouter = Router();

// ── GET /products — list all ──────────────────────────────────────────────────
router.get("/products", async (_req, res): Promise<void> => {
  const { rate } = await getUsdToUzsRate();
  const { rows } = await pool.query(`
    SELECT
      p.id, p.name, p.sku, p.unit_type, p.currency_type,
      p.default_sale_price, p.weight, p.rate, p.rate_type,
      p.salary_cost, p.electricity_cost, p.other_cost,
      p.minimum_stock, p.active, p.created_at, p.payroll_method,
      p.line_id,
      pl.name AS line_name,
      COALESCE(p.pieces_per_box, 1) AS pieces_per_box,
      COALESCE(
        (SELECT SUM(rm.default_cost * pm.quantity_required * CASE WHEN UPPER(rm.currency)='USD' THEN $1::numeric ELSE 1 END)
         FROM product_materials pm
         JOIN raw_materials rm ON rm.id = pm.raw_material_id
         WHERE pm.product_name = p.name), 0
      ) AS raw_material_cost
    FROM products p
    LEFT JOIN production_lines pl ON pl.id = p.line_id
    ORDER BY p.name
  `, [rate]);

  res.json(rows.map(row => {
    // weight (og'irlik) — narx va xarajatlar 1 birlik (kg/dona) uchun kiritiladi,
    // jami = og'irlik × narx. Xom ashyo (BOM) allaqachon mutlaq miqdor bo'yicha.
    const w               = Number(row.weight) > 0 ? Number(row.weight) : 1;
    const salePriceBase   = Number(row.default_sale_price);
    // USD narxli mahsulot sotuv narxini jonli kursda UZS'ga aylantiramiz — barcha
    // xarajatlar (maosh/elektr/xom ashyo) UZS'da, shuning uchun foyda izchil UZS'da chiqadi.
    const saleRate        = String(row.currency_type) === "USD" ? rate : 1;
    // mehnat (maosh) stavkadan hisoblanadi (yagona manba): kg → rate×og'irlik, dona → rate
    const laborCost       = String(row.rate_type) === "kg" ? Number(row.rate) * w : Number(row.rate);
    const elecBase        = Number(row.electricity_cost);
    const otherBase       = Number(row.other_cost);
    const rawCost         = Number(row.raw_material_cost);
    // dona (piece) uchun sotuv narxi 1 dona narxi — og'irlikka ko'paytirish noto'g'ri.
    // kg uchun: narx/kg × og'irlik = 1 birlik narxi. Elektr/boshqa hali ham × og'irlik.
    const isKg            = String(row.unit_type) === "kg";
    const effectiveSale   = salePriceBase * saleRate * (isKg ? w : 1);
    // dona: elektr/boshqa = sabit (og'irlikka ko'paytirilmaydi); kg: ×og'irlik
    const totalCost       = rawCost + laborCost + (isKg ? (elecBase + otherBase) * w : (elecBase + otherBase));
    const profit          = effectiveSale - totalCost;
    const marginPct       = effectiveSale > 0
      ? Math.round((profit / effectiveSale) * 10000) / 100
      : 0;
    return {
      id:                 row.id,
      name:               row.name,
      sku:                row.sku,
      unitType:           row.unit_type,
      currencyType:       row.currency_type,
      defaultSalePrice:   salePriceBase,   // 1 birlik narxi (tahrirlash uchun)
      weight:             w,
      effectiveSalePrice: effectiveSale,    // jami sotuv narxi = narx × og'irlik
      rate:               Number(row.rate),
      rateType:           row.rate_type,
      payrollMethod:      row.payroll_method ?? "PRODUCT_RATE",
      lineId:             row.line_id ?? null,
      lineName:           row.line_name ?? null,
      salaryCost:         laborCost,        // jami mehnat (stavkadan)
      electricityCost:    elecBase,
      otherCost:          otherBase,
      rawMaterialCost:    rawCost,
      totalCost,
      profit,
      marginPct,
      minimumStock:       row.minimum_stock,
      piecesPerBox:       Number(row.pieces_per_box) || 1,
      active:             row.active,
      createdAt:          row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
  }));
});

// ── POST /products — create ───────────────────────────────────────────────────
router.post("/products", async (req, res): Promise<void> => {
  const {
    name, sku = "", unitType = "dona", currencyType = "UZS",
    defaultSalePrice = 0, weight = 1, rate = 0, rateType,
    salaryCost = 0, electricityCost = 0, otherCost = 0,
    minimumStock = 0, active = true, piecesPerBox = 1,
    lineId = null,
  } = req.body ?? {};

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name is required" }); return;
  }

  const finalRateType = rateType || unitType;
  const finalWeight   = Number(weight) > 0 ? Number(weight) : 1;

  try {
    const finalLineId = lineId != null && !isNaN(Number(lineId)) ? Number(lineId) : null;
    const { rows } = await pool.query(
      `INSERT INTO products
         (name, sku, unit_type, currency_type, default_sale_price, weight, rate, rate_type,
          salary_cost, electricity_cost, other_cost, minimum_stock, active, pieces_per_box, line_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (name) DO UPDATE SET
         sku=$2, unit_type=$3, currency_type=$4, default_sale_price=$5, weight=$6, rate=$7, rate_type=$8,
         salary_cost=$9, electricity_cost=$10, other_cost=$11, minimum_stock=$12, active=$13,
         pieces_per_box=$14, line_id=$15
       RETURNING id, name, sku, unit_type, currency_type, default_sale_price, weight, rate, rate_type,
                 salary_cost, electricity_cost, other_cost, minimum_stock, active, pieces_per_box, line_id`,
      [name.trim(), sku, unitType, currencyType, Number(defaultSalePrice), finalWeight, Number(rate),
       finalRateType, Number(salaryCost), Number(electricityCost), Number(otherCost),
       Number(minimumStock), Boolean(active), Math.max(1, Number(piecesPerBox) || 1), finalLineId]
    );
    const p = rows[0];
    res.status(201).json({
      id: p.id, name: p.name, sku: p.sku,
      unitType: p.unit_type, currencyType: p.currency_type,
      defaultSalePrice: Number(p.default_sale_price), weight: Number(p.weight),
      rate: Number(p.rate), rateType: p.rate_type,
      salaryCost: Number(p.salary_cost), electricityCost: Number(p.electricity_cost),
      otherCost: Number(p.other_cost), minimumStock: p.minimum_stock,
      piecesPerBox: Number(p.pieces_per_box) || 1, active: p.active,
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
    ["default_sale_price", "defaultSalePrice"], ["weight", "weight"], ["rate", "rate"], ["rate_type", "rateType"],
    ["salary_cost", "salaryCost"], ["electricity_cost", "electricityCost"],
    ["other_cost", "otherCost"], ["minimum_stock", "minimumStock"], ["active", "active"],
    ["payroll_method", "payrollMethod"], ["pieces_per_box", "piecesPerBox"], ["line_id", "lineId"],
  ];

  for (const [col, key] of allowed) {
    if (req.body[key] !== undefined) {
      // og'irlik 0 yoki manfiy bo'lsa 1 ga tenglaymiz (manfiy narx oldini olish)
      const value = col === "weight"
        ? (Number(req.body[key]) > 0 ? Number(req.body[key]) : 1)
        : req.body[key];
      vals.push(value);
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
  const { rate } = await getUsdToUzsRate();

  const [prodRes, salesRes] = await Promise.all([
    pool.query(
      `SELECT p.*,
        COALESCE((
          SELECT SUM(rm.default_cost * pm.quantity_required * CASE WHEN UPPER(rm.currency)='USD' THEN $2::numeric ELSE 1 END)
          FROM product_materials pm
          JOIN raw_materials rm ON rm.id = pm.raw_material_id
          WHERE pm.product_name = p.name
        ), 0) AS raw_material_cost
       FROM products p WHERE p.name=$1`, [productName, rate]
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
  const w         = Number(p.weight) > 0 ? Number(p.weight) : 1;
  const rawCost   = Number(p.raw_material_cost);
  const isKg            = String(p.unit_type) === "kg";
  // mehnat: kg → rate×og'irlik, dona → rate; elektr/boshqa: kg → ×og'irlik, dona → sabit
  const laborCost       = String(p.rate_type) === "kg" ? Number(p.rate) * w : Number(p.rate);
  const electricityCost = isKg ? Number(p.electricity_cost) * w : Number(p.electricity_cost);
  const otherCost       = isKg ? Number(p.other_cost) * w : Number(p.other_cost);
  // USD narx jonli kursda UZS'ga aylantiriladi (xarajatlar UZS'da — izchillik uchun).
  const saleRate        = String(p.currency_type) === "USD" ? rate : 1;
  const salePrice       = Number(p.default_sale_price) * saleRate * (isKg ? w : 1);
  const totalCost       = rawCost + laborCost + electricityCost + otherCost;
  const profit          = salePrice - totalCost;
  const marginPct       = salePrice > 0 ? (profit / salePrice) * 100 : 0;

  res.json({
    name:            p.name,
    weight:          w,
    salePrice,
    rawMaterialCost: rawCost,
    salaryCost:      laborCost,
    electricityCost,
    otherCost,
    totalCost,
    profit,
    marginPct:       Math.round(marginPct * 100) / 100,
    revenueUzs:      Number(s.revenue_uzs),
    revenueUsd:      Number(s.revenue_usd),
    unitsSold:       Number(s.units_sold),
  });
});

export default router;
