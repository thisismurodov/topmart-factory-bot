import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getUsdToUzsRate } from "../lib/exchangeRate";

const router: IRouter = Router();

const VALID_CURRENCIES = ["UZS", "USD"] as const;

function toRow(r: any, rate: number | null = null) {
  const currency    = r.currency || "UZS";
  const defaultCost = Number(r.default_cost);
  const isUsd       = String(currency).toUpperCase() === "USD";
  return {
    id:                r.id,
    name:              r.name,
    unitType:          r.unit_type || r.unit,
    defaultCost,
    currency,
    // Joriy (current) UZS ekvivalenti — USD bo'lsa jonli kursga ko'paytiriladi.
    calculatedUzsCost: rate != null && isUsd ? defaultCost * rate : defaultCost,
    currentStock:      Number(r.current_stock),
    minimumStock:      Number(r.minimum_stock),
    active:            r.active,
    createdAt:         r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

// ── GET /raw-materials ────────────────────────────────────────────────────────
router.get("/raw-materials", async (_req, res): Promise<void> => {
  const { rate } = await getUsdToUzsRate();
  const { rows } = await pool.query(
    "SELECT * FROM raw_materials ORDER BY name"
  );
  res.json(rows.map(r => toRow(r, rate)));
});

// ── GET /raw-materials/low-stock ──────────────────────────────────────────────
// Minimal zahiradan kam yoki teng bo'lib qolgan faol xom ashyolar.
router.get("/raw-materials/low-stock", async (_req, res): Promise<void> => {
  const { rate } = await getUsdToUzsRate();
  const { rows } = await pool.query(
    `SELECT * FROM raw_materials
     WHERE active = TRUE AND minimum_stock > 0 AND current_stock <= minimum_stock
     ORDER BY name`
  );
  res.json(rows.map(r => toRow(r, rate)));
});

// ── POST /raw-materials ───────────────────────────────────────────────────────
router.post("/raw-materials", async (req, res): Promise<void> => {
  const { name, unitType = "kg", defaultCost = 0, currency = "UZS", currentStock = 0, minimumStock = 0, active = true } = req.body ?? {};

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name is required" }); return;
  }
  const cur = String(currency).toUpperCase();
  if (!VALID_CURRENCIES.includes(cur as any)) {
    res.status(400).json({ error: "currency must be 'UZS' or 'USD'" }); return;
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO raw_materials (name, unit, unit_type, default_cost, currency, current_stock, minimum_stock, active)
       VALUES ($1,$2,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (name) DO UPDATE SET
         unit=$2, unit_type=$2, default_cost=$3, currency=$4, current_stock=$5, minimum_stock=$6, active=$7
       RETURNING *`,
      [name.trim(), unitType, Number(defaultCost), cur, Number(currentStock), Number(minimumStock), Boolean(active)]
    );
    res.status(201).json(toRow(rows[0]));
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

// ── PATCH /raw-materials/:id ─────────────────────────────────────────────────
router.patch("/raw-materials/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const fields: string[] = [];
  const vals: unknown[] = [];

  if (req.body.name !== undefined)         { vals.push(req.body.name);               fields.push(`name=$${vals.length}`); }
  if (req.body.unitType !== undefined)     { vals.push(req.body.unitType);            fields.push(`unit=$${vals.length}`, `unit_type=$${vals.length}`); }
  if (req.body.defaultCost !== undefined)  { vals.push(Number(req.body.defaultCost)); fields.push(`default_cost=$${vals.length}`); }
  if (req.body.currency !== undefined)     {
    const cur = String(req.body.currency).toUpperCase();
    if (!VALID_CURRENCIES.includes(cur as any)) { res.status(400).json({ error: "currency must be 'UZS' or 'USD'" }); return; }
    vals.push(cur); fields.push(`currency=$${vals.length}`);
  }
  if (req.body.currentStock !== undefined) { vals.push(Number(req.body.currentStock));fields.push(`current_stock=$${vals.length}`); }
  if (req.body.minimumStock !== undefined) { vals.push(Number(req.body.minimumStock));fields.push(`minimum_stock=$${vals.length}`); }
  if (req.body.active !== undefined)       { vals.push(Boolean(req.body.active));     fields.push(`active=$${vals.length}`); }

  if (fields.length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
  vals.push(id);
  await pool.query(`UPDATE raw_materials SET ${fields.join(",")} WHERE id=$${vals.length}`, vals);
  res.json({ ok: true });
});

// ── DELETE /raw-materials/:id ─────────────────────────────────────────────────
router.delete("/raw-materials/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const result = await pool.query("DELETE FROM raw_materials WHERE id=$1", [id]);
  if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ok: true });
});

export default router;
