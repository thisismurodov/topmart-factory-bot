import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { syncSalesCatalog } from "./products";
import { uniqueProductSku } from "../lib/sku";

const VALID_SALE_TYPES = ["dona", "kg"] as const;
const VALID_CURRENCIES  = ["UZS", "USD"] as const;

const router: IRouter = Router();

// Compatibility shim: sales-products -> products table
// Maps: sale_type -> unit_type, default_price -> default_sale_price, currency -> currency_type

// ── GET all ───────────────────────────────────────────────────────────────────
router.get("/sales-products", async (_req, res): Promise<void> => {
  const { rows } = await pool.query(
    `SELECT id, name, unit_type AS sale_type, default_sale_price AS default_price, currency_type AS currency, active
     FROM products WHERE active = TRUE AND in_sales = TRUE ORDER BY name`
  );

  const ids = rows.map(r => r.id);
  const tiersByProduct: Record<number, Array<{ id: number; minQty: number; maxQty: number; price: number; currency: string }>> = {};
  if (ids.length) {
    const t = await pool.query(
      `SELECT id, product_id, min_quantity, max_quantity, price, currency
       FROM product_price_tiers WHERE product_id = ANY($1) ORDER BY min_quantity`,
      [ids]
    );
    for (const row of t.rows) {
      (tiersByProduct[row.product_id] ??= []).push({
        id:       row.id,
        minQty:   Number(row.min_quantity),
        maxQty:   Number(row.max_quantity),
        price:    Number(row.price),
        currency: row.currency,
      });
    }
  }

  res.json(rows.map(r => ({
    id:           r.id,
    name:         r.name,
    saleType:     r.sale_type,
    defaultPrice: Number(r.default_price),
    currency:     r.currency,
    tiers:        tiersByProduct[r.id] ?? [],
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
    // Master yozuvda SKU bo'lishi shart — savdo katalogi SKU orqali bog'lanadi.
    const autoSku = await uniqueProductSku(name.trim());
    const { rows } = await pool.query(
      `INSERT INTO products (name, sku, unit_type, rate_type, currency_type, default_sale_price, active, in_sales)
       VALUES ($1,$5,$2,$2,$3,$4,TRUE,TRUE)
       ON CONFLICT (name) DO UPDATE
         SET unit_type=$2, rate_type=$2, currency_type=$3, default_sale_price=$4, active=TRUE, in_sales=TRUE,
             sku = CASE WHEN products.sku <> '' THEN products.sku ELSE EXCLUDED.sku END
       RETURNING id, name, unit_type AS sale_type, default_sale_price AS default_price, currency_type AS currency`,
      [name.trim(), saleType, currency, Number(defaultPrice), autoSku]
    );
    const r = rows[0];
    await syncSalesCatalog(r.name);
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
    const upd = await pool.query(
      `UPDATE products SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING name`, vals,
    );
    // Master o'zgardi — savdo katalogi proyeksiyasini darhol sinxronlaymiz.
    if (upd.rows.length) await syncSalesCatalog(upd.rows[0].name);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE (soft) ─────────────────────────────────────────────────────────────
// Savdo modulidan chiqaradi (in_sales=FALSE) — master 'active' TEGILMAYDI,
// aks holda ishlab chiqarish mahsuloti butunlay yashirinib qolar edi.
router.delete("/sales-products/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const upd = await pool.query(
    "UPDATE products SET in_sales=FALSE WHERE id=$1 RETURNING name", [id],
  );
  if (upd.rows.length) await syncSalesCatalog(upd.rows[0].name); // faol=0 proyeksiyada
  res.json({ ok: true });
});

// ── Tiers CRUD ────────────────────────────────────────────────────────────────
router.get("/sales-products/:id/tiers", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { rows } = await pool.query(
    `SELECT id, min_quantity, max_quantity, price, currency
     FROM product_price_tiers WHERE product_id=$1 ORDER BY min_quantity`, [id]
  );
  res.json(rows.map(r => ({
    id:       r.id,
    minQty:   Number(r.min_quantity),
    maxQty:   Number(r.max_quantity),
    price:    Number(r.price),
    currency: r.currency,
  })));
});

router.post("/sales-products/:id/tiers", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { minQuantity, maxQuantity, price, currency = "UZS" } = req.body ?? {};
  const minQ = Number(minQuantity), maxQ = Number(maxQuantity), pr = Number(price);

  if (!VALID_CURRENCIES.includes(currency)) { res.status(400).json({ error: "currency must be 'UZS' or 'USD'" }); return; }
  if (isNaN(minQ) || minQ < 0)    { res.status(400).json({ error: "minQuantity must be >= 0" }); return; }
  if (isNaN(maxQ) || maxQ < minQ) { res.status(400).json({ error: "maxQuantity must be >= minQuantity" }); return; }
  if (isNaN(pr) || pr < 0)        { res.status(400).json({ error: "price must be >= 0" }); return; }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const prod = await client.query("SELECT id FROM products WHERE id=$1 AND in_sales=TRUE", [id]);
    if (!prod.rows.length) { await client.query("ROLLBACK"); res.status(404).json({ error: "Product not found" }); return; }

    // Serialize concurrent tier writes per product to keep overlap-check atomic.
    await client.query("SELECT pg_advisory_xact_lock($1)", [id]);

    // Two ranges [a,b] and [c,d] overlap iff a <= d AND c <= b.
    const overlap = await client.query(
      `SELECT id FROM product_price_tiers
       WHERE product_id=$1 AND min_quantity <= $3 AND max_quantity >= $2 LIMIT 1`,
      [id, minQ, maxQ]
    );
    if (overlap.rows.length) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "Bu oraliq mavjud bosqich bilan kesishadi" }); return;
    }

    const ins = await client.query(
      `INSERT INTO product_price_tiers (product_id, min_quantity, max_quantity, price, currency)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, min_quantity, max_quantity, price, currency`,
      [id, minQ, maxQ, pr, currency]
    );
    await client.query("COMMIT");
    const t = ins.rows[0];
    res.status(201).json({
      id:       t.id,
      minQty:   Number(t.min_quantity),
      maxQty:   Number(t.max_quantity),
      price:    Number(t.price),
      currency: t.currency,
    });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.delete("/sales-products/:id/tiers/:tierId", async (req, res): Promise<void> => {
  const id     = parseInt(req.params.id);
  const tierId = parseInt(req.params.tierId);
  if (isNaN(id) || isNaN(tierId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const result = await pool.query(
    "DELETE FROM product_price_tiers WHERE id=$1 AND product_id=$2", [tierId, id]
  );
  if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: "Tier not found" }); return; }
  res.json({ ok: true });
});

// ── GET price for qty (auto-selects tier) ─────────────────────────────────────
router.get("/sales-products/:id/price", async (req, res): Promise<void> => {
  const id  = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const qty = Number(req.query.qty) || 0;

  const { rows } = await pool.query(
    "SELECT default_sale_price AS default_price, currency_type AS currency FROM products WHERE id=$1 AND active = TRUE AND in_sales = TRUE", [id]
  );
  if (!rows.length) { res.status(404).json({ error: "Not found" }); return; }

  if (qty > 0) {
    const t = await pool.query(
      `SELECT price, currency FROM product_price_tiers
       WHERE product_id=$1 AND min_quantity <= $2 AND max_quantity >= $2
       ORDER BY min_quantity LIMIT 1`, [id, qty]
    );
    if (t.rows.length) {
      res.json({ price: Number(t.rows[0].price), currency: t.rows[0].currency, fromTier: true }); return;
    }
  }
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
