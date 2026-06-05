import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const VALID_SALE_TYPES = ["dona", "kg"] as const;
const VALID_CURRENCIES  = ["UZS", "USD"] as const;

const router: IRouter = Router();

// ── GET all (with tiers) ───────────────────────────────────────────────────────
router.get("/sales-products", async (_req, res): Promise<void> => {
  const { rows: prods } = await pool.query(
    `SELECT id, name, sale_type, default_price, currency
     FROM sales_products WHERE active = TRUE ORDER BY name`
  );
  const ids = prods.map(r => r.id);
  let tiersByProd: Record<number, any[]> = {};
  if (ids.length > 0) {
    const { rows: tierRows } = await pool.query(
      `SELECT id, product_id, min_qty, price, currency
       FROM sales_product_tiers WHERE product_id = ANY($1)
       ORDER BY product_id, min_qty DESC`,
      [ids]
    );
    for (const t of tierRows) {
      if (!tiersByProd[t.product_id]) tiersByProd[t.product_id] = [];
      tiersByProd[t.product_id].push({ id: t.id, minQty: Number(t.min_qty), price: Number(t.price), currency: t.currency });
    }
  }
  res.json(prods.map(r => ({
    id:           r.id,
    name:         r.name,
    saleType:     r.sale_type,
    defaultPrice: Number(r.default_price),
    currency:     r.currency,
    tiers:        tiersByProd[r.id] ?? [],
  })));
});

// ── POST create ───────────────────────────────────────────────────────────────
router.post("/sales-products", async (req, res): Promise<void> => {
  const { name, saleType = "dona", defaultPrice = 0, currency = "UZS", tiers = [] } = req.body ?? {};

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name is required" }); return;
  }
  if (!VALID_SALE_TYPES.includes(saleType)) {
    res.status(400).json({ error: "saleType must be 'dona' or 'kg'" }); return;
  }
  if (!VALID_CURRENCIES.includes(currency)) {
    res.status(400).json({ error: "currency must be 'UZS' or 'USD'" }); return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO sales_products (name, sale_type, default_price, currency, unit)
       VALUES ($1,$2,$3,$4,$2)
       ON CONFLICT (name) DO UPDATE
         SET sale_type=$2, default_price=$3, currency=$4, unit=$2, active=TRUE
       RETURNING id, name, sale_type, default_price, currency`,
      [name.trim(), saleType, Number(defaultPrice), currency]
    );
    const prodId = rows[0].id;
    // insert tiers if provided
    for (const t of tiers) {
      if (t.minQty != null && t.price != null) {
        await client.query(
          `INSERT INTO sales_product_tiers (product_id, min_qty, price, currency) VALUES ($1,$2,$3,$4)`,
          [prodId, Number(t.minQty), Number(t.price), t.currency || currency]
        );
      }
    }
    await client.query("COMMIT");
    const r = rows[0];
    res.status(201).json({
      id: r.id, name: r.name,
      saleType: r.sale_type, defaultPrice: Number(r.default_price), currency: r.currency,
    });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
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

// ── POST add tier ─────────────────────────────────────────────────────────────
router.post("/sales-products/:id/tiers", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { minQty, price, currency } = req.body ?? {};
  if (minQty == null || price == null) {
    res.status(400).json({ error: "minQty and price are required" }); return;
  }
  const prod = await pool.query("SELECT currency FROM sales_products WHERE id=$1", [id]);
  if (!prod.rows.length) { res.status(404).json({ error: "Product not found" }); return; }
  const cur = currency || prod.rows[0].currency;
  const { rows } = await pool.query(
    `INSERT INTO sales_product_tiers (product_id, min_qty, price, currency)
     VALUES ($1,$2,$3,$4) RETURNING id, min_qty, price, currency`,
    [id, Number(minQty), Number(price), cur]
  );
  const t = rows[0];
  res.status(201).json({ id: t.id, minQty: Number(t.min_qty), price: Number(t.price), currency: t.currency });
});

// ── DELETE tier ───────────────────────────────────────────────────────────────
router.delete("/sales-products/:id/tiers/:tierId", async (req, res): Promise<void> => {
  const tierId = parseInt(req.params.tierId);
  if (isNaN(tierId)) { res.status(400).json({ error: "Invalid tierId" }); return; }
  await pool.query("DELETE FROM sales_product_tiers WHERE id=$1", [tierId]);
  res.json({ ok: true });
});

// ── GET price for qty (used by bot / sales form) ──────────────────────────────
router.get("/sales-products/:id/price", async (req, res): Promise<void> => {
  const id  = parseInt(req.params.id);
  const qty = parseFloat(req.query.qty as string ?? "0");
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const prod = await pool.query(
    "SELECT default_price, currency FROM sales_products WHERE id=$1", [id]
  );
  if (!prod.rows.length) { res.status(404).json({ error: "Not found" }); return; }

  const { rows: tiers } = await pool.query(
    `SELECT price, currency FROM sales_product_tiers
     WHERE product_id=$1 AND min_qty <= $2
     ORDER BY min_qty DESC LIMIT 1`,
    [id, qty]
  );

  if (tiers.length > 0) {
    res.json({ price: Number(tiers[0].price), currency: tiers[0].currency, fromTier: true });
  } else {
    res.json({ price: Number(prod.rows[0].default_price), currency: prod.rows[0].currency, fromTier: false });
  }
});

// ── Has sales check (warning before sale_type change) ────────────────────────
router.get("/sales-products/:id/has-sales", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const sp = await pool.query("SELECT name FROM sales_products WHERE id=$1", [id]);
  if (!sp.rows.length) { res.status(404).json({ error: "Not found" }); return; }
  const { rows } = await pool.query(
    "SELECT COUNT(*) AS cnt FROM sale_items WHERE product_name=$1", [sp.rows[0].name]
  );
  res.json({ hasSales: Number(rows[0].cnt) > 0, count: Number(rows[0].cnt) });
});

export default router;
