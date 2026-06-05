import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const VALID_SALE_TYPES = ["dona", "kg"] as const;
const VALID_CURRENCIES  = ["UZS", "USD"] as const;

const router: IRouter = Router();

// ── GET all ───────────────────────────────────────────────────────────────────
router.get("/sales-products", async (_req, res): Promise<void> => {
  const { rows } = await pool.query(
    `SELECT id, name, sale_type, default_price, currency
     FROM sales_products WHERE active = TRUE ORDER BY name`
  );
  res.json(rows.map(r => ({
    id:           r.id,
    name:         r.name,
    saleType:     r.sale_type,
    defaultPrice: Number(r.default_price),
    currency:     r.currency,
  })));
});

// ── POST create ───────────────────────────────────────────────────────────────
router.post("/sales-products", async (req, res): Promise<void> => {
  const { name, saleType = "dona", defaultPrice = 0, currency = "UZS" } = req.body ?? {};

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name is required" }); return;
  }
  if (!VALID_SALE_TYPES.includes(saleType)) {
    res.status(400).json({ error: "saleType must be 'dona' or 'kg'" }); return;
  }
  if (!VALID_CURRENCIES.includes(currency)) {
    res.status(400).json({ error: "currency must be 'UZS' or 'USD'" }); return;
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO sales_products (name, sale_type, default_price, currency, unit)
       VALUES ($1,$2,$3,$4,$2)
       ON CONFLICT (name) DO UPDATE
         SET sale_type=$2, default_price=$3, currency=$4, unit=$2, active=TRUE
       RETURNING id, name, sale_type, default_price, currency`,
      [name.trim(), saleType, Number(defaultPrice), currency]
    );
    const r = rows[0];
    res.status(201).json({
      id: r.id, name: r.name,
      saleType: r.sale_type, defaultPrice: Number(r.default_price), currency: r.currency,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT update ────────────────────────────────────────────────────────────────
router.put("/sales-products/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { name, saleType, defaultPrice, currency } = req.body ?? {};

  if (saleType && !VALID_SALE_TYPES.includes(saleType)) {
    res.status(400).json({ error: "invalid saleType" }); return;
  }
  if (currency && !VALID_CURRENCIES.includes(currency)) {
    res.status(400).json({ error: "invalid currency" }); return;
  }

  const sets: string[] = [];
  const vals: unknown[] = [];

  if (name) {
    vals.push(name.trim());
    sets.push(`name=$${vals.length}`);
  }
  if (saleType) {
    vals.push(saleType);
    const idx = vals.length;
    sets.push(`sale_type=$${idx}`, `unit=$${idx}`);
  }
  if (defaultPrice !== undefined) {
    vals.push(Number(defaultPrice));
    sets.push(`default_price=$${vals.length}`);
  }
  if (currency) {
    vals.push(currency);
    sets.push(`currency=$${vals.length}`);
  }

  if (sets.length === 0) { res.status(400).json({ error: "No fields to update" }); return; }

  vals.push(id);
  try {
    await pool.query(
      `UPDATE sales_products SET ${sets.join(",")} WHERE id=$${vals.length}`,
      vals
    );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE (soft) ─────────────────────────────────────────────────────────────
router.delete("/sales-products/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await pool.query("UPDATE sales_products SET active=FALSE WHERE id=$1", [id]);
  res.json({ ok: true });
});

// ── Has sales check (warning before sale_type change) ────────────────────────
router.get("/sales-products/:id/has-sales", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const sp = await pool.query("SELECT name FROM sales_products WHERE id=$1", [id]);
  if (!sp.rows.length) { res.status(404).json({ error: "Not found" }); return; }
  const { rows } = await pool.query(
    "SELECT COUNT(*) AS cnt FROM sales WHERE product=$1", [sp.rows[0].name]
  );
  res.json({ hasSales: Number(rows[0].cnt) > 0, count: Number(rows[0].cnt) });
});

export default router;
