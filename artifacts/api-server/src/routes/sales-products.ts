import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const VALID_SALE_TYPES = ["dona", "kg"] as const;
const VALID_CURRENCIES  = ["UZS", "USD"] as const;

const router: IRouter = Router();

// Compatibility shim: sales-products -> products table
// Maps: sale_type -> unit_type, default_price -> default_sale_price, currency -> currency_type

// ── GET all ───────────────────────────────────────────────────────────────────
router.get("/sales-products", async (_req, res): Promise<void> => {
  const { rows } = await pool.query(
    `SELECT id, name, unit_type AS sale_type, default_sale_price AS default_price, currency_type AS currency, active
     FROM products WHERE active = TRUE ORDER BY name`
  );
  res.json(rows.map(r => ({
    id:           r.id,
    name:         r.name,
    saleType:     r.sale_type,
    defaultPrice: Number(r.default_price),
    currency:     r.currency,
    tiers:        [],
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
      `INSERT INTO products (name, unit_type, rate_type, currency_type, default_sale_price, active)
       VALUES ($1,$2,$2,$3,$4,TRUE)
       ON CONFLICT (name) DO UPDATE
         SET unit_type=$2, rate_type=$2, currency_type=$3, default_sale_price=$4, active=TRUE
       RETURNING id, name, unit_type AS sale_type, default_sale_price AS default_price, currency_type AS currency`,
      [name.trim(), saleType, currency, Number(defaultPrice)]
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

// ── PUT update (by numeric id) ────────────────────────────────────────────────
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

  if (name)               { vals.push(name.trim());        sets.push(`name=$${vals.length}`); }
  if (saleType)           { vals.push(saleType);           sets.push(`unit_type=$${vals.length}`, `rate_type=$${vals.length}`); }
  if (defaultPrice !== undefined) { vals.push(Number(defaultPrice)); sets.push(`default_sale_price=$${vals.length}`); }
  if (currency)           { vals.push(currency);           sets.push(`currency_type=$${vals.length}`); }

  if (sets.length === 0) { res.status(400).json({ error: "No fields to update" }); return; }

  vals.push(id);
  try {
    await pool.query(`UPDATE products SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE (soft) ─────────────────────────────────────────────────────────────
router.delete("/sales-products/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await pool.query("UPDATE products SET active=FALSE WHERE id=$1", [id]);
  res.json({ ok: true });
});

// ── Tiers stubs (no-op; kept for backward-compat) ────────────────────────────
router.post("/sales-products/:id/tiers", async (_req, res): Promise<void> => {
  res.status(400).json({ error: "Tiers not supported in unified products model; use /api/products with pricing" });
});
router.delete("/sales-products/:id/tiers/:tierId", async (_req, res): Promise<void> => {
  res.json({ ok: true });
});

// ── GET price for qty ─────────────────────────────────────────────────────────
router.get("/sales-products/:id/price", async (req, res): Promise<void> => {
  const id  = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { rows } = await pool.query(
    "SELECT default_sale_price AS default_price, currency_type AS currency FROM products WHERE id=$1", [id]
  );
  if (!rows.length) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ price: Number(rows[0].default_price), currency: rows[0].currency, fromTier: false });
});

// ── Has sales check ────────────────────────────────────────────────────────────
router.get("/sales-products/:id/has-sales", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const sp = await pool.query("SELECT name FROM products WHERE id=$1", [id]);
  if (!sp.rows.length) { res.status(404).json({ error: "Not found" }); return; }
  const { rows } = await pool.query(
    "SELECT COUNT(*) AS cnt FROM sale_items WHERE product_name=$1", [sp.rows[0].name]
  );
  res.json({ hasSales: Number(rows[0].cnt) > 0, count: Number(rows[0].cnt) });
});

export default router;
