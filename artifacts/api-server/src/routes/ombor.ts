import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getUsdToUzsRate } from "../lib/exchangeRate";

const router: IRouter = Router();

// Stock movements log WHO performed an action. Dashboard requests carry an
// authenticated session (req.username); the Telegram bot calls in via the
// shared internal key with no session user. For bot calls we trust an
// `operator` field in the body (the mapped worker name / Telegram identity)
// so corrections record the real operator instead of the generic "bot".
// A session user (req.username) always wins, so the body field cannot be used
// to spoof an authenticated dashboard actor.
function actingUser(req: { username?: string; body?: { operator?: unknown } }): string {
  if (req.username) return req.username;
  const op = req.body?.operator;
  if (typeof op === "string" && op.trim().length > 0) return op.trim();
  return "bot";
}

// ── GET /api/ombor/summary ─────────────────────────────────────────────────────
router.get("/ombor/summary", async (_req, res): Promise<void> => {
  const { rate } = await getUsdToUzsRate();

  const [rawRes, fgRes, cntRes] = await Promise.all([
    pool.query(`
      SELECT
        COALESCE(SUM(
          CASE WHEN UPPER(currency) = 'USD'
               THEN current_stock * default_cost * $1::numeric
               ELSE current_stock * default_cost
          END
        ), 0)::numeric AS value_uzs,
        COUNT(*)::int AS total_count,
        COUNT(*) FILTER (WHERE minimum_stock > 0 AND current_stock <= minimum_stock)::int AS low_count
      FROM raw_materials
      WHERE active = TRUE
    `, [rate ?? 0]),

    pool.query(`
      SELECT
        COALESCE(SUM(
          (CASE WHEN LOWER(p.unit_type) = 'kg' AND COALESCE(i.weight_kg, 0) > 0
                THEN i.weight_kg
                ELSE i.quantity
           END)
          * p.default_sale_price
          * CASE WHEN p.currency_type = 'USD' THEN $1::numeric ELSE 1 END
        ), 0)::numeric AS value_uzs,
        COUNT(DISTINCT i.product) FILTER (WHERE i.quantity > 0)::int AS sku_count
      FROM inventory i
      JOIN products p ON p.name = i.product
    `, [rate ?? 0]),

    pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE id IN (SELECT DISTINCT warehouse_id FROM inventory WHERE quantity > 0)
        )::int AS occupied
      FROM warehouses
      WHERE location_type = 'container'
    `),
  ]);

  const raw   = rawRes.rows[0];
  const fg    = fgRes.rows[0];
  const cnt   = cntRes.rows[0];
  const rawVal = Number(raw.value_uzs);
  const fgVal  = Number(fg.value_uzs);

  res.json({
    rawMaterialValueUzs:   rawVal,
    finishedGoodsValueUzs: fgVal,
    totalValueUzs:         rawVal + fgVal,
    rawMaterialCount:      Number(raw.total_count),
    finishedGoodsSkuCount: Number(fg.sku_count),
    lowStockRawCount:      Number(raw.low_count),
    usdRate:               rate ?? 0,
    totalContainers:       Number(cnt.total),
    occupiedContainers:    Number(cnt.occupied),
    emptyContainers:       Number(cnt.total) - Number(cnt.occupied),
  });
});

// ── GET /api/ombor/containers ──────────────────────────────────────────────────
router.get("/ombor/containers", async (_req, res): Promise<void> => {
  const { rate } = await getUsdToUzsRate();

  const { rows } = await pool.query(`
    SELECT
      w.id,
      w.name,
      w.capacity_kg,
      w.active,
      COUNT(DISTINCT i.product) FILTER (WHERE i.quantity > 0)::int        AS sku_count,
      COALESCE(SUM(i.quantity) FILTER (WHERE i.quantity > 0), 0)::numeric AS total_qty,
      COALESCE(SUM(
        (CASE WHEN LOWER(p.unit_type) = 'kg' AND COALESCE(i.weight_kg, 0) > 0
              THEN i.weight_kg
              ELSE i.quantity
         END)
        * p.default_sale_price
        * CASE WHEN p.currency_type = 'USD' THEN $1::numeric ELSE 1 END
      ) FILTER (WHERE i.quantity > 0), 0)::numeric AS total_value_uzs
    FROM warehouses w
    LEFT JOIN inventory i ON i.warehouse_id = w.id
    LEFT JOIN products p  ON p.name = i.product
    WHERE w.location_type = 'container'
    GROUP BY w.id, w.name, w.capacity_kg, w.active
    ORDER BY w.name
  `, [rate ?? 0]);

  res.json(rows.map((r) => {
    const cap = Number(r.capacity_kg) || 20000;
    const qty = Number(r.total_qty);
    return {
      id:            r.id,
      name:          r.name,
      capacityKg:    cap,
      active:        r.active,
      skuCount:      Number(r.sku_count),
      totalQty:      qty,
      totalValueUzs: Number(r.total_value_uzs),
      occupancyPct:  Math.min(100, Math.round((qty / cap) * 100)),
    };
  }));
});

// ── GET /api/ombor/containers/:id/items ───────────────────────────────────────
router.get("/ombor/containers/:id/items", async (req, res): Promise<void> => {
  const { rate } = await getUsdToUzsRate();
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "bad id" }); return; }

  const [itemsRes, wRes] = await Promise.all([
    pool.query(`
      SELECT i.id, i.product, i.quantity, i.product_type, i.updated_at,
             p.unit_type, p.default_sale_price, p.currency_type,
             COALESCE(i.weight_kg, 0)::numeric AS weight_kg
      FROM inventory i
      LEFT JOIN products p ON p.name = i.product
      WHERE i.warehouse_id = $1 AND i.quantity > 0
      ORDER BY i.product
    `, [id]),
    pool.query("SELECT id, name, capacity_kg FROM warehouses WHERE id=$1", [id]),
  ]);

  if (!wRes.rows.length) { res.status(404).json({ error: "Konteyner topilmadi" }); return; }

  const w = wRes.rows[0];
  res.json({
    warehouse: {
      id:         w.id,
      name:       w.name,
      capacityKg: Number(w.capacity_kg) || 20000,
    },
    items: itemsRes.rows.map((r) => {
      const isUsd   = String(r.currency_type ?? "UZS").toUpperCase() === "USD";
      const priceUzs = isUsd ? Number(r.default_sale_price) * (rate ?? 0) : Number(r.default_sale_price);
      const qty     = Number(r.quantity);
      const isKg     = String(r.unit_type ?? "dona").toLowerCase() === "kg";
      const storedWeight = Number(r.weight_kg) || 0;
      // Inventoryda saqlangan aniq og'irlikni ishlatamiz (kg-mahsulotlar uchun).
      const weightKg = isKg && storedWeight > 0 ? storedWeight : null;
      // kg-mahsulotlar uchun narx kg uchun — qiymatni og'irlikka ko'paytiramiz.
      const valueQty = weightKg != null ? weightKg : qty;
      return {
        id:            r.id,
        product:       r.product,
        quantity:      qty,
        weightKg,
        productType:   r.product_type || "finished",
        unit:          r.unit_type || "dona",
        salePrice:     Number(r.default_sale_price),
        currency:      r.currency_type || "UZS",
        priceUzs,
        totalValueUzs: valueQty * priceUzs,
        updatedAt:     r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      };
    }),
  });
});

// ── POST /api/ombor/transfer ───────────────────────────────────────────────────
router.post("/ombor/transfer", async (req, res): Promise<void> => {
  const { fromId, toId, product, qty, note = "" } = req.body ?? {};
  if (!fromId || !toId || !product || !qty) {
    res.status(400).json({ error: "fromId, toId, product, qty required" }); return;
  }
  const amount = Number(qty);
  if (isNaN(amount) || amount <= 0) {
    res.status(400).json({ error: "qty must be > 0" }); return;
  }
  if (Number(fromId) === Number(toId)) {
    res.status(400).json({ error: "from va to bir xil bo'lmasin" }); return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const srcRes = await client.query(
      "SELECT quantity, weight_kg, product_type FROM inventory WHERE warehouse_id=$1 AND product=$2",
      [fromId, product],
    );
    if (!srcRes.rows.length || Number(srcRes.rows[0].quantity) < amount) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Yetarli mahsulot yo'q" }); return;
    }
    const productType = srcRes.rows[0].product_type as string;
    // Og'irlikni proporsional ko'chiramiz (saqlangan aniq og'irlikdan).
    const srcQty    = Number(srcRes.rows[0].quantity) || 0;
    const srcWeight = Number(srcRes.rows[0].weight_kg) || 0;
    const moveWeight = srcQty > 0 && srcWeight > 0
      ? Math.min(srcWeight, (srcWeight * amount) / srcQty)
      : 0;

    await client.query(
      "UPDATE inventory SET quantity = GREATEST(0, quantity - $1), weight_kg = GREATEST(0, weight_kg - $2), updated_at=NOW() WHERE warehouse_id=$3 AND product=$4",
      [amount, moveWeight, fromId, product],
    );
    await client.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (warehouse_id, product)
       DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity,
                     weight_kg = inventory.weight_kg + EXCLUDED.weight_kg, updated_at=NOW()`,
      [toId, product, amount, moveWeight, productType],
    );
    await client.query(
      `INSERT INTO stock_movements
         (product, quantity, movement_type, from_warehouse_id, to_warehouse_id, note, created_by, product_type)
       VALUES ($1,$2,'TRANSFER',$3,$4,$5,$6,$7)`,
      [product, amount, fromId, toId, note || `Transfer: ${amount}`, actingUser(req), productType],
    );

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── POST /api/ombor/finished-in ────────────────────────────────────────────────
router.post("/ombor/finished-in", async (req, res): Promise<void> => {
  const { warehouseId, product, qty, weightKg, note = "" } = req.body ?? {};
  if (!warehouseId || !product || !qty) {
    res.status(400).json({ error: "warehouseId, product, qty required" }); return;
  }
  const amount = Number(qty);
  if (isNaN(amount) || amount <= 0) {
    res.status(400).json({ error: "qty must be > 0" }); return;
  }
  const explicitWeight = weightKg != null && weightKg !== "" ? Number(weightKg) : null;
  if (explicitWeight != null && (isNaN(explicitWeight) || explicitWeight < 0)) {
    res.status(400).json({ error: "weightKg invalid" }); return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Og'irlik: aniq kiritilgan bo'lsa o'shani, aks holda kg-mahsulot uchun
    // partiya nisbati bo'yicha hisoblaymiz (dona uchun 0).
    let addWeight = explicitWeight ?? 0;
    if (explicitWeight == null) {
      const wr = await client.query(
        `SELECT CASE WHEN LOWER(p.unit_type) = 'kg' AND COALESCE(SUM(b.quantity),0) > 0
                     THEN SUM(b.weight_kg)::numeric / SUM(b.quantity)
                     ELSE 0 END AS kg_per_unit
         FROM products p
         LEFT JOIN batches b ON b.product = p.name
         WHERE p.name = $1
         GROUP BY p.unit_type`,
        [product],
      );
      const kgPerUnit = wr.rows.length ? Number(wr.rows[0].kg_per_unit) || 0 : 0;
      addWeight = kgPerUnit > 0 ? amount * kgPerUnit : 0;
    }
    await client.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type)
       VALUES ($1,$2,$3,$4,'finished')
       ON CONFLICT (warehouse_id, product)
       DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity,
                     weight_kg = inventory.weight_kg + EXCLUDED.weight_kg, updated_at=NOW()`,
      [warehouseId, product, amount, addWeight],
    );
    await client.query(
      `INSERT INTO stock_movements
         (product, quantity, movement_type, to_warehouse_id, note, created_by, product_type)
       VALUES ($1,$2,'IN',$3,$4,$5,'finished')`,
      [product, amount, warehouseId, note || `Kirim: ${amount}`, actingUser(req)],
    );
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── POST /api/ombor/adjust ─────────────────────────────────────────────────────
// Konteyner liniyasining miqdori VA og'irligini bir amalda to'g'rilash
// (qayta sanash / to'kilish tuzatishi). Yangi qiymatlar absolyut (ustiga emas).
router.post("/ombor/adjust", async (req, res): Promise<void> => {
  const { warehouseId, product, qty, weightKg, note = "" } = req.body ?? {};
  if (!warehouseId || !product) {
    res.status(400).json({ error: "warehouseId, product required" }); return;
  }
  const newQty = Number(qty);
  if (isNaN(newQty) || newQty < 0) {
    res.status(400).json({ error: "qty must be >= 0" }); return;
  }
  const explicitWeight = weightKg != null && weightKg !== "" ? Number(weightKg) : null;
  if (explicitWeight != null && (isNaN(explicitWeight) || explicitWeight < 0)) {
    res.status(400).json({ error: "weightKg invalid" }); return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const curRes = await client.query(
      `SELECT i.quantity, i.weight_kg, i.product_type, LOWER(p.unit_type) AS unit_type
       FROM inventory i
       LEFT JOIN products p ON p.name = i.product
       WHERE i.warehouse_id=$1 AND i.product=$2`,
      [warehouseId, product],
    );
    if (!curRes.rows.length) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Mahsulot bu konteynerda topilmadi" }); return;
    }

    const oldQty       = Number(curRes.rows[0].quantity) || 0;
    const oldWeight    = Number(curRes.rows[0].weight_kg) || 0;
    const productType  = curRes.rows[0].product_type as string;
    const isKg         = String(curRes.rows[0].unit_type ?? "dona") === "kg";
    // kg-mahsulotlar uchun og'irlik majburiy — aks holda miqdor to'g'rilanib
    // og'irlik eskirib qoladi (zahirani halol saqlash talabi).
    if (isKg && explicitWeight == null) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "kg-mahsulot uchun og'irlik (kg) majburiy" }); return;
    }
    // dona-mahsulotlar uchun og'irlik doimo 0.
    const newWeight = isKg ? (explicitWeight as number) : 0;

    const qtyChanged    = newQty !== oldQty;
    const weightChanged = newWeight !== oldWeight;
    if (!qtyChanged && !weightChanged) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "O'zgartirish yo'q" }); return;
    }

    await client.query(
      "UPDATE inventory SET quantity=$1, weight_kg=$2, updated_at=NOW() WHERE warehouse_id=$3 AND product=$4",
      [newQty, newWeight, warehouseId, product],
    );

    // Harakatni to'g'rilangan miqdorlar bilan log qilamiz.
    const delta = newQty - oldQty;
    const movementType = delta > 0 ? "IN" : delta < 0 ? "OUT" : "IN";
    let auto = `Tuzatish: ${oldQty} → ${newQty}`;
    if (isKg) auto += `, ${oldWeight} → ${newWeight} kg`;
    const noteText = note ? `${note} (${auto})` : auto;
    if (movementType === "IN") {
      await client.query(
        `INSERT INTO stock_movements
           (product, quantity, movement_type, to_warehouse_id, note, created_by, product_type)
         VALUES ($1,$2,'IN',$3,$4,$5,$6)`,
        [product, Math.abs(delta), warehouseId, noteText, actingUser(req), productType],
      );
    } else {
      await client.query(
        `INSERT INTO stock_movements
           (product, quantity, movement_type, from_warehouse_id, note, created_by, product_type)
         VALUES ($1,$2,'OUT',$3,$4,$5,$6)`,
        [product, Math.abs(delta), warehouseId, noteText, actingUser(req), productType],
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── GET /api/ombor/search ──────────────────────────────────────────────────────
router.get("/ombor/search", async (req, res): Promise<void> => {
  const q = String(req.query.q ?? "").trim();
  if (!q || q.length < 1) { res.json([]); return; }

  const { rows } = await pool.query(`
    SELECT
      i.product, i.quantity, i.product_type,
      w.id AS warehouse_id, w.name AS warehouse_name, w.location_type,
      p.unit_type
    FROM inventory i
    JOIN warehouses w ON w.id = i.warehouse_id
    LEFT JOIN products p ON p.name = i.product
    WHERE i.quantity > 0 AND (i.product ILIKE $1 OR w.name ILIKE $1)
    ORDER BY i.product, w.name
    LIMIT 60
  `, [`%${q}%`]);

  res.json(rows.map((r) => ({
    product:       r.product,
    quantity:      Number(r.quantity),
    productType:   r.product_type,
    warehouseId:   r.warehouse_id,
    warehouseName: r.warehouse_name,
    locationType:  r.location_type,
    unit:          r.unit_type || "dona",
  })));
});

// ── GET /api/ombor/raw-materials ───────────────────────────────────────────────
router.get("/ombor/raw-materials", async (_req, res): Promise<void> => {
  const { rate } = await getUsdToUzsRate();

  const { rows } = await pool.query(`
    SELECT
      rm.id, rm.name, rm.unit, rm.unit_type, rm.default_cost, rm.currency,
      rm.current_stock, rm.minimum_stock, rm.active,
      COALESCE(
        (SELECT SUM(pm.quantity_required * b.quantity)::numeric
         FROM product_materials pm
         JOIN batches b ON b.product = pm.product_name
         WHERE pm.raw_material_id = rm.id
           AND b.created_at >= NOW() - INTERVAL '30 days') / 30
      , 0) AS avg_daily
    FROM raw_materials rm
    WHERE rm.active = TRUE
    ORDER BY rm.name
  `);

  res.json(rows.map((r) => {
    const isUsd         = String(r.currency).toUpperCase() === "USD";
    const costUzs       = isUsd ? Number(r.default_cost) * (rate ?? 0) : Number(r.default_cost);
    const stock         = Number(r.current_stock);
    const avgDaily      = Number(r.avg_daily);
    const daysRemaining = avgDaily > 0 ? Math.floor(stock / avgDaily) : null;
    return {
      id:             r.id,
      name:           r.name,
      unit:           r.unit_type || r.unit || "kg",
      defaultCost:    Number(r.default_cost),
      currency:       r.currency || "UZS",
      uzsCostPerUnit: costUzs,
      currentStock:   stock,
      minimumStock:   Number(r.minimum_stock),
      totalValueUzs:  stock * costUzs,
      avgDailyConsumption: Number(avgDaily.toFixed(3)),
      daysRemaining,
    };
  }));
});

// ── POST /api/ombor/raw-in ─────────────────────────────────────────────────────
router.post("/ombor/raw-in", async (req, res): Promise<void> => {
  const { materialId, qty, cost, currency, note = "" } = req.body ?? {};
  if (!materialId || typeof materialId !== "number") {
    res.status(400).json({ error: "materialId required" }); return;
  }
  const amount = Number(qty);
  if (isNaN(amount) || amount <= 0) {
    res.status(400).json({ error: "qty must be > 0" }); return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const matRes = await client.query(
      "SELECT id, name, unit FROM raw_materials WHERE id = $1", [materialId],
    );
    if (!matRes.rows.length) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Xom ashyo topilmadi" }); return;
    }
    const mat = matRes.rows[0];
    const updRes = await client.query(
      `UPDATE raw_materials
       SET current_stock = current_stock + $1,
           default_cost  = COALESCE(NULLIF($2::text,'')::numeric, default_cost),
           currency      = COALESCE(NULLIF($3::text,''), currency)
       WHERE id = $4
       RETURNING current_stock`,
      [amount, cost != null ? String(cost) : "", currency || "", materialId],
    );
    await client.query(
      `INSERT INTO stock_movements
         (product, quantity, movement_type, to_warehouse_id, note, created_by, product_type)
       VALUES ($1,$2,'IN',NULL,$3,'admin','raw')`,
      [mat.name, amount, note || `Kirdi: ${amount} ${mat.unit}`],
    );
    await client.query("COMMIT");
    res.json({ ok: true, name: mat.name, newStock: Number(updRes.rows[0].current_stock) });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── POST /api/ombor/raw-adjust ─────────────────────────────────────────────────
// Xom ashyo zahirasini absolyut qiymatga to'g'rilash (qayta sanash / to'kilish).
// /ombor/adjust kabi yangi qiymat ABSOLYUT (ustiga emas) va delta IN/OUT log qilinadi.
router.post("/ombor/raw-adjust", async (req, res): Promise<void> => {
  const { materialId, stock, note = "" } = req.body ?? {};
  if (!materialId || typeof materialId !== "number") {
    res.status(400).json({ error: "materialId required" }); return;
  }
  const newStock = Number(stock);
  // isFinite NaN VA Infinity (masalan "1e999") ni rad etadi — aks holda
  // current_stock buzilib, harakat delta'si noto'g'ri yoziladi.
  if (!isFinite(newStock) || newStock < 0) {
    res.status(400).json({ error: "stock must be a finite number >= 0" }); return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // FOR UPDATE — qatorni tranzaksiya davomida qulflaydi. Bu bir vaqtda
    // kelgan ikkita to'g'rilash o'qish→yozishini ketma-ket qiladi, shunda
    // eski→yangi delta har doim haqiqiy bo'ladi (jimgina yo'qolgan yangilanish yo'q).
    const matRes = await client.query(
      "SELECT id, name, unit, current_stock FROM raw_materials WHERE id = $1 FOR UPDATE", [materialId],
    );
    if (!matRes.rows.length) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Xom ashyo topilmadi" }); return;
    }
    const mat = matRes.rows[0];
    const oldStock = Number(mat.current_stock) || 0;
    const delta = newStock - oldStock;
    if (delta === 0) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "O'zgartirish yo'q" }); return;
    }

    await client.query(
      "UPDATE raw_materials SET current_stock = $1 WHERE id = $2",
      [newStock, materialId],
    );

    const movementType = delta > 0 ? "IN" : "OUT";
    const auto = `Tuzatish: ${oldStock} → ${newStock} ${mat.unit}`;
    const noteText = note ? `${note} (${auto})` : auto;
    await client.query(
      `INSERT INTO stock_movements
         (product, quantity, movement_type, to_warehouse_id, from_warehouse_id, note, created_by, product_type)
       VALUES ($1,$2,$3,NULL,NULL,$4,$5,'raw')`,
      [mat.name, Math.abs(delta), movementType, noteText, actingUser(req)],
    );

    await client.query("COMMIT");
    res.json({ ok: true, name: mat.name, newStock });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── GET /api/ombor/finished-goods ─────────────────────────────────────────────
router.get("/ombor/finished-goods", async (_req, res): Promise<void> => {
  const { rate } = await getUsdToUzsRate();
  const { rows } = await pool.query(`
    SELECT i.product, SUM(i.quantity)::numeric AS stock_qty,
           p.default_sale_price, p.currency_type, p.unit_type, p.minimum_stock,
           COALESCE(SUM(
             (CASE WHEN LOWER(p.unit_type) = 'kg' AND COALESCE(i.weight_kg, 0) > 0
                   THEN i.weight_kg
                   ELSE i.quantity
              END)
             * p.default_sale_price
             * CASE WHEN p.currency_type = 'USD' THEN $1::numeric ELSE 1 END
           ), 0)::numeric AS total_value_uzs
    FROM inventory i
    JOIN products p ON p.name = i.product
    GROUP BY i.product, p.default_sale_price, p.currency_type, p.unit_type, p.minimum_stock
    HAVING SUM(i.quantity) > 0
    ORDER BY i.product
  `, [rate ?? 0]);
  res.json(rows.map((r) => {
    const isUsd    = String(r.currency_type).toUpperCase() === "USD";
    const priceUzs = isUsd ? Number(r.default_sale_price) * (rate ?? 0) : Number(r.default_sale_price);
    const stockQty = Number(r.stock_qty);
    const minimumStock = Number(r.minimum_stock) || 0;
    return {
      product:       r.product,
      stockQty,
      unitType:      r.unit_type || "dona",
      salePrice:     Number(r.default_sale_price),
      currency:      r.currency_type || "UZS",
      priceUzs,
      totalValueUzs: Number(r.total_value_uzs),
      minimumStock,
      low:           minimumStock > 0 && stockQty <= minimumStock,
    };
  }));
});

// ── GET /api/ombor/movements ───────────────────────────────────────────────────
router.get("/ombor/movements", async (req, res): Promise<void> => {
  const typeFilter = req.query.type ? String(req.query.type) : null;
  const whFilter   = req.query.warehouse ? Number(req.query.warehouse) : null;
  const opFilter   = req.query.operator ? String(req.query.operator).trim() : null;
  const prodFilter = req.query.product ? String(req.query.product).trim() : null;
  // Sana oralig'i (Asia/Tashkent kun chegaralari, YYYY-MM-DD). Oraliq tanlanganda
  // eski yozuvlar 60-lik oynadan kesilib qolmasligi uchun cheklovni kengaytiramiz.
  const dateRe     = /^\d{4}-\d{2}-\d{2}$/;
  const fromFilter = req.query.from && dateRe.test(String(req.query.from)) ? String(req.query.from) : null;
  const toFilter   = req.query.to   && dateRe.test(String(req.query.to))   ? String(req.query.to)   : null;
  const rangeChosen = Boolean(fromFilter || toFilter);
  const limit      = Math.min(Number(req.query.limit ?? (rangeChosen ? 1000 : 80)), rangeChosen ? 5000 : 200);
  const params: unknown[] = [limit];
  const conds: string[] = [];
  if (typeFilter) { params.push(typeFilter); conds.push(`sm.product_type = $${params.length}`); }
  if (whFilter)   { params.push(whFilter);   conds.push(`(sm.from_warehouse_id = $${params.length} OR sm.to_warehouse_id = $${params.length})`); }
  if (opFilter)   { params.push(opFilter);   conds.push(`sm.created_by = $${params.length}`); }
  if (prodFilter) { params.push(prodFilter); conds.push(`sm.product = $${params.length}`); }
  if (fromFilter) { params.push(fromFilter); conds.push(`(sm.created_at AT TIME ZONE 'Asia/Tashkent')::date >= $${params.length}::date`); }
  if (toFilter)   { params.push(toFilter);   conds.push(`(sm.created_at AT TIME ZONE 'Asia/Tashkent')::date <= $${params.length}::date`); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const { rows } = await pool.query(
    `SELECT sm.id, sm.product, sm.quantity, sm.movement_type, sm.product_type,
            sm.from_warehouse_id, fw.name AS from_warehouse, tw.name AS to_warehouse,
            sm.note, sm.created_by, sm.created_at
     FROM stock_movements sm
     LEFT JOIN warehouses fw ON fw.id = sm.from_warehouse_id
     LEFT JOIN warehouses tw ON tw.id = sm.to_warehouse_id
     ${where}
     ORDER BY sm.created_at DESC, sm.id DESC
     LIMIT $1`,
    params,
  );

  // Running stock balance per raw material. For a single-material raw history
  // we anchor the newest movement to the material's live current_stock, then
  // walk backward subtracting each movement's signed delta. This guarantees the
  // most recent row matches current stock even if legacy rows are missing
  // (older batches deducted BOM without writing a movement row; new batches
  // write an OUT row in the same transaction). Only computed for a specific raw
  // material whose newest movement is guaranteed present (no upper date bound
  // excluding it).
  //
  // Not every raw movement touches global raw_materials.current_stock:
  //  - OUT with from_warehouse_id (konteynerdan bo'limga berish) faqat
  //    konteyner inventory'sini kamaytiradi — global zahira o'zgarmaydi
  //    (BOM partiya paytida kamayadi).
  //  - TRANSFER konteynerlar orasida — global zahira o'zgarmaydi.
  // Bunday qatorlar uchun delta 0 va balanceAfter ko'rsatilmaydi (null),
  // aks holda balans noto'g'ri siljiydi.
  let balances: Record<number, number | null> | null = null;
  if (typeFilter === "raw" && prodFilter && !toFilter && rows.length) {
    const stockRes = await pool.query(
      "SELECT current_stock FROM raw_materials WHERE name = $1 LIMIT 1",
      [prodFilter],
    );
    if (stockRes.rows.length) {
      balances = {};
      // rows are newest-first; walk from the top anchoring at current_stock.
      let running = Number(stockRes.rows[0].current_stock) || 0;
      for (const r of rows) {
        const qty = Number(r.quantity) || 0;
        const containerOnly =
          r.movement_type === "TRANSFER" ||
          (r.movement_type === "OUT" && r.from_warehouse_id != null);
        if (containerOnly) {
          balances[r.id] = null;
          continue;
        }
        balances[r.id] = running;
        const signed = r.movement_type === "OUT" ? -qty : qty;
        running -= signed;
      }
    }
  }

  res.json(rows.map((r) => ({
    id:            r.id,
    product:       r.product,
    quantity:      Number(r.quantity),
    movementType:  r.movement_type,
    productType:   r.product_type || "finished",
    fromWarehouse: r.from_warehouse ?? null,
    toWarehouse:   r.to_warehouse ?? null,
    note:          r.note || "",
    createdBy:     r.created_by || "",
    createdAt:     r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    balanceAfter:  balances ? balances[r.id] ?? null : null,
  })));
});

// ── GET /api/ombor/operators ───────────────────────────────────────────────────
// Harakatlar tarixini operator bo'yicha filtrlash uchun mavjud operatorlar ro'yxati.
// Ixtiyoriy `warehouse` param berilsa — faqat shu konteynerda harakati bor operatorlar.
router.get("/ombor/operators", async (req, res): Promise<void> => {
  const whFilter = req.query.warehouse ? Number(req.query.warehouse) : null;
  const params: unknown[] = [];
  let where = "created_by IS NOT NULL AND created_by <> ''";
  if (whFilter) {
    params.push(whFilter);
    where += ` AND (from_warehouse_id = $${params.length} OR to_warehouse_id = $${params.length})`;
  }
  const { rows } = await pool.query(
    `SELECT DISTINCT created_by
       FROM stock_movements
      WHERE ${where}
      ORDER BY created_by`,
    params,
  );
  res.json(rows.map((r) => r.created_by as string));
});

// ════════════════════════════════════════════════════════════════════════════
//  ISH JARAYONI (Material Flow / WIP) — ikki bosqichli oqim:
//    1) Xom ashyo konteynerga kiritiladi (purpose='raw' ombor, inventory raw)
//    2) Xom ashyo konteynerdan BO'LIMGA beriladi → WIP RECEIVE (+kg)
//    3) Bo'lim partiya chiqaradi (bot) → WIP PRODUCE (-kg) + tayyor ombor
//  Bo'lim WIP = SUM(RECEIVE) − SUM(PRODUCE).
//
//  XOM ASHYO IZCHILLIGI QOIDASI (double-counting'dan saqlanish):
//   - Xom ashyo kirimi UCHUN YAGONA kirish nuqtasi = /ombor/flow/raw-in. U bir
//     vaqtning o'zida (a) konteyner inventory'siga (product_type='raw') va
//     (b) global raw_materials.current_stock'ga qo'shadi — ikkalasi sinxron.
//   - Bo'limga berish (receive) faqat konteyner inventory'sini kamaytiradi;
//     raw_materials'ga TEGMAYDI (xom ashyo hali zavodda, WIP sifatida). Global
//     raw zahira faqat partiya yaratilganda BOM hisobida kamayadi (mavjud oqim).
// ════════════════════════════════════════════════════════════════════════════

// ── POST /api/ombor/flow/raw-in ────────────────────────────────────────────────
// Xom ashyoni TANLANGAN konteynerga (kg) kiritadi. inventory product_type='raw'.
router.post("/ombor/flow/raw-in", async (req, res): Promise<void> => {
  const { warehouseId, materialName, kg, note = "" } = req.body ?? {};
  if (!warehouseId || !materialName) {
    res.status(400).json({ error: "warehouseId, materialName required" }); return;
  }
  const amount = Number(kg);
  if (isNaN(amount) || amount <= 0) {
    res.status(400).json({ error: "kg must be > 0" }); return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const whRes = await client.query(
      "SELECT id FROM warehouses WHERE id=$1 AND location_type='container' AND purpose='raw'", [warehouseId],
    );
    if (!whRes.rows.length) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Xom ashyo konteyneri topilmadi (purpose='raw' bo'lishi kerak)" }); return;
    }
    // YAGONA kirish nuqtasi qoidasi: global raw_materials.current_stock'ni shu
    // yerda sinxron yangilaymiz. Nomi mavjud raw_material'ga mos kelishi SHART —
    // aks holda konteyner zahira global zahiradan ajralib ketadi (drift). Mos
    // kelmasa kirim rad etiladi (canonical nomni tanlang). Aniq bitta qatorni
    // yangilash uchun avval id'ni topamiz (katta/kichik harf dublikatlari bo'lsa
    // ham faqat bitta qator o'zgaradi — drift bo'lmaydi).
    const matchRes = await client.query(
      `SELECT id, name FROM raw_materials WHERE LOWER(name) = LOWER($1) ORDER BY id LIMIT 1`,
      [materialName],
    );
    if (!matchRes.rows.length) {
      await client.query("ROLLBACK");
      res.status(400).json({
        error: `"${materialName}" ro'yxatdagi xom ashyoga mos kelmadi. Mavjud xom ashyo nomini tanlang.`,
      });
      return;
    }
    const canonicalName: string = matchRes.rows[0].name;
    await client.query(
      `UPDATE raw_materials SET current_stock = current_stock + $1 WHERE id = $2`,
      [amount, matchRes.rows[0].id],
    );
    await client.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type)
       VALUES ($1,$2,$3,$3,'raw')
       ON CONFLICT (warehouse_id, product)
       DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity,
                     weight_kg = inventory.weight_kg + EXCLUDED.weight_kg,
                     product_type = 'raw', updated_at=NOW()`,
      [warehouseId, canonicalName, amount],
    );
    await client.query(
      `INSERT INTO stock_movements
         (product, quantity, movement_type, to_warehouse_id, note, created_by, product_type)
       VALUES ($1,$2,'IN',$3,$4,$5,'raw')`,
      [canonicalName, amount, warehouseId, note || `Xom ashyo kirimi: ${amount} kg`, actingUser(req)],
    );
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── POST /api/ombor/flow/receive ───────────────────────────────────────────────
// Xom ashyoni konteynerdan BO'LIMGA beradi: konteyner zahirasidan ayiriladi,
// bo'lim WIP'iga RECEIVE (+kg) yoziladi.
router.post("/ombor/flow/receive", async (req, res): Promise<void> => {
  const { warehouseId, lineId, materialName, kg, note = "" } = req.body ?? {};
  if (!warehouseId || !lineId || !materialName) {
    res.status(400).json({ error: "warehouseId, lineId, materialName required" }); return;
  }
  const amount = Number(kg);
  if (isNaN(amount) || amount <= 0) {
    res.status(400).json({ error: "kg must be > 0" }); return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lineRes = await client.query("SELECT id, name FROM production_lines WHERE id=$1", [lineId]);
    if (!lineRes.rows.length) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Bo'lim topilmadi" }); return;
    }
    // Manba konteyner xom ashyo ombori bo'lishi shart.
    const whRes = await client.query(
      "SELECT id FROM warehouses WHERE id=$1 AND location_type='container' AND purpose='raw'", [warehouseId],
    );
    if (!whRes.rows.length) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Xom ashyo konteyneri topilmadi (purpose='raw' bo'lishi kerak)" }); return;
    }
    // Atomik ayirish: faqat yetarli zahira bo'lsagina yangilanadi (race-safe).
    // Konteynerda quantity = weight_kg = kg bo'lib yuritiladi.
    const decRes = await client.query(
      `UPDATE inventory
         SET quantity = quantity - $1, weight_kg = weight_kg - $1, updated_at=NOW()
       WHERE warehouse_id=$2 AND product=$3 AND product_type='raw' AND weight_kg >= $1
       RETURNING weight_kg`,
      [amount, warehouseId, materialName],
    );
    if (!decRes.rows.length) {
      const cur = await client.query(
        "SELECT weight_kg FROM inventory WHERE warehouse_id=$1 AND product=$2 AND product_type='raw'",
        [warehouseId, materialName],
      );
      const have = cur.rows.length ? Number(cur.rows[0].weight_kg) || 0 : 0;
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Konteynerda yetarli xom ashyo yo'q (mavjud: ${have} kg)` }); return;
    }
    await client.query(
      `INSERT INTO wip_movements
         (line_id, movement_type, raw_material, weight_kg, from_warehouse_id, note, created_by)
       VALUES ($1,'RECEIVE',$2,$3,$4,$5,$6)`,
      [lineId, materialName, amount, warehouseId, note || `Bo'limga berildi: ${amount} kg`, actingUser(req)],
    );
    await client.query(
      `INSERT INTO stock_movements
         (product, quantity, movement_type, from_warehouse_id, note, created_by, product_type)
       VALUES ($1,$2,'OUT',$3,$4,$5,'raw')`,
      [materialName, amount, warehouseId, `Bo'limga (${lineRes.rows[0].name}): ${amount} kg`, actingUser(req)],
    );
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── POST /api/ombor/flow/container-purpose ─────────────────────────────────────
// Konteynerni xom ashyo ('raw') yoki tayyor ('finished') ombor sifatida belgilash.
router.post("/ombor/flow/container-purpose", async (req, res): Promise<void> => {
  const { warehouseId, purpose } = req.body ?? {};
  if (!warehouseId || (purpose !== "raw" && purpose !== "finished")) {
    res.status(400).json({ error: "warehouseId va purpose ('raw'|'finished') required" }); return;
  }
  const upd = await pool.query(
    "UPDATE warehouses SET purpose=$1 WHERE id=$2 AND location_type='container' RETURNING id",
    [purpose, warehouseId],
  );
  if (!upd.rows.length) { res.status(404).json({ error: "Konteyner topilmadi" }); return; }
  res.json({ ok: true });
});

// ── GET /api/ombor/flow ────────────────────────────────────────────────────────
// Butun oqim holati: xom konteynerlar (+itemlar), bo'limlar (+WIP), tayyor
// konteynerlar, KPI'lar, ogohlantirishlar, va so'nggi harakatlar tarixi.
router.get("/ombor/flow", async (_req, res): Promise<void> => {
  const [rawRes, rawItemsRes, deptRes, finRes, allRes, histRes] = await Promise.all([
    pool.query(`
      SELECT w.id, w.name, w.capacity_kg,
             COALESCE(SUM(i.weight_kg) FILTER (WHERE i.product_type='raw' AND i.quantity > 0), 0)::numeric AS total_kg,
             COUNT(*) FILTER (WHERE i.product_type='raw' AND i.quantity > 0)::int AS material_count,
             COALESCE((
               SELECT SUM(sm.quantity) FROM stock_movements sm
               WHERE sm.to_warehouse_id = w.id AND sm.movement_type='IN' AND sm.product_type='raw'
                 AND (sm.created_at AT TIME ZONE 'Asia/Tashkent')::date = (NOW() AT TIME ZONE 'Asia/Tashkent')::date
             ), 0)::numeric AS today_in,
             COALESCE((
               SELECT SUM(sm.quantity) FROM stock_movements sm
               WHERE sm.from_warehouse_id = w.id AND sm.movement_type='OUT' AND sm.product_type='raw'
                 AND (sm.created_at AT TIME ZONE 'Asia/Tashkent')::date = (NOW() AT TIME ZONE 'Asia/Tashkent')::date
             ), 0)::numeric AS today_out
      FROM warehouses w
      LEFT JOIN inventory i ON i.warehouse_id = w.id
      WHERE w.location_type='container' AND w.purpose='raw' AND w.active = TRUE
      GROUP BY w.id, w.name, w.capacity_kg
      ORDER BY w.name
    `),
    pool.query(`
      SELECT i.warehouse_id, i.product AS material, i.weight_kg, i.quantity
      FROM inventory i
      JOIN warehouses w ON w.id = i.warehouse_id
      WHERE w.purpose='raw' AND i.product_type='raw' AND i.quantity > 0
      ORDER BY i.product
    `),
    pool.query(`
      SELECT pl.id, pl.name,
        (SELECT COUNT(*) FROM production_line_workers plw WHERE plw.line_id = pl.id)::int AS worker_count,
        (SELECT COUNT(*) FROM products p WHERE p.line_id = pl.id AND p.active = TRUE)::int AS product_count,
        COALESCE(SUM(CASE WHEN wm.movement_type='RECEIVE' THEN wm.weight_kg
                          WHEN wm.movement_type='PRODUCE' THEN -wm.weight_kg ELSE 0 END), 0)::numeric AS wip_kg,
        COALESCE(SUM(CASE WHEN wm.movement_type='RECEIVE'
                            AND (wm.created_at AT TIME ZONE 'Asia/Tashkent')::date = (NOW() AT TIME ZONE 'Asia/Tashkent')::date
                          THEN wm.weight_kg ELSE 0 END), 0)::numeric AS today_received,
        COALESCE(SUM(CASE WHEN wm.movement_type='PRODUCE'
                            AND (wm.created_at AT TIME ZONE 'Asia/Tashkent')::date = (NOW() AT TIME ZONE 'Asia/Tashkent')::date
                          THEN wm.weight_kg ELSE 0 END), 0)::numeric AS today_produced
      FROM production_lines pl
      LEFT JOIN wip_movements wm ON wm.line_id = pl.id
      GROUP BY pl.id, pl.name
      ORDER BY pl.id
    `),
    pool.query(`
      SELECT w.id, w.name, w.capacity_kg,
             COALESCE(SUM(i.quantity) FILTER (WHERE i.quantity > 0), 0)::numeric AS total_qty,
             COALESCE(SUM(i.weight_kg) FILTER (WHERE i.quantity > 0), 0)::numeric AS total_kg,
             COUNT(DISTINCT i.product) FILTER (WHERE i.quantity > 0)::int AS sku_count
      FROM warehouses w
      LEFT JOIN inventory i ON i.warehouse_id = w.id AND i.product_type='finished'
      WHERE w.location_type='container' AND w.purpose='finished' AND w.active = TRUE
      GROUP BY w.id, w.name, w.capacity_kg
      ORDER BY w.name
    `),
    pool.query(`
      SELECT id, name, purpose, active FROM warehouses
      WHERE location_type='container'
      ORDER BY name
    `),
    pool.query(`
      SELECT wm.id, wm.movement_type, wm.raw_material, wm.product, wm.weight_kg,
             wm.note, wm.created_by, wm.created_at,
             pl.name AS line_name, fw.name AS from_warehouse
      FROM wip_movements wm
      LEFT JOIN production_lines pl ON pl.id = wm.line_id
      LEFT JOIN warehouses fw ON fw.id = wm.from_warehouse_id
      ORDER BY wm.id DESC
      LIMIT 40
    `),
  ]);

  const itemsByWh = new Map<number, { material: string; kg: number }[]>();
  for (const r of rawItemsRes.rows) {
    const arr = itemsByWh.get(r.warehouse_id) ?? [];
    arr.push({ material: r.material, kg: Number(r.weight_kg) || Number(r.quantity) || 0 });
    itemsByWh.set(r.warehouse_id, arr);
  }

  const rawContainers = rawRes.rows.map((r) => ({
    id: r.id,
    name: r.name,
    capacityKg: Number(r.capacity_kg) || 20000,
    totalKg: Number(r.total_kg),
    materialCount: Number(r.material_count),
    todayIn: Number(r.today_in),
    todayOut: Number(r.today_out),
    items: itemsByWh.get(r.id) ?? [],
  }));

  const departments = deptRes.rows.map((r) => {
    const wipKg = Number(r.wip_kg);
    const todayReceived = Number(r.today_received);
    const todayProduced = Number(r.today_produced);
    // Bajarilish %: bugun ishlab chiqarilgan / (bugun ishlab chiqarilgan + qolgan WIP).
    const denom = todayProduced + Math.max(0, wipKg);
    const completionPct = denom > 0 ? Math.round((todayProduced / denom) * 100) : 0;
    // Holat: faol (bugun harakat bor) · kutmoqda (WIP bor, harakat yo'q) · bo'sh.
    const status =
      todayProduced > 0 || todayReceived > 0 ? "working" : wipKg > 0 ? "idle" : "empty";
    return {
      id: r.id,
      name: r.name,
      workerCount: Number(r.worker_count),
      productCount: Number(r.product_count),
      wipKg,
      todayReceived,
      todayProduced,
      completionPct,
      status,
    };
  });

  const finishedContainers = finRes.rows.map((r) => ({
    id: r.id,
    name: r.name,
    capacityKg: Number(r.capacity_kg) || 20000,
    totalQty: Number(r.total_qty),
    totalKg: Number(r.total_kg),
    skuCount: Number(r.sku_count),
  }));

  const allContainers = allRes.rows.map((r) => ({
    id: r.id,
    name: r.name,
    purpose: r.purpose || "finished",
    active: r.active,
  }));

  const history = histRes.rows.map((r) => ({
    id: r.id,
    movementType: r.movement_type,
    rawMaterial: r.raw_material ?? null,
    product: r.product ?? null,
    weightKg: Number(r.weight_kg),
    lineName: r.line_name ?? null,
    fromWarehouse: r.from_warehouse ?? null,
    note: r.note || "",
    createdBy: r.created_by || "",
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));

  const totalRawKg = rawContainers.reduce((s, c) => s + c.totalKg, 0);
  const totalWipKg = departments.reduce((s, d) => s + d.wipKg, 0);
  const totalFinishedKg = finishedContainers.reduce((s, c) => s + c.totalKg, 0);
  const todayReceived = departments.reduce((s, d) => s + d.todayReceived, 0);
  const todayProduced = departments.reduce((s, d) => s + d.todayProduced, 0);
  const departmentsWorking = departments.filter((d) => d.status === "working").length;
  // Bugungi xom sarfi = konteynerlardan bugun chiqarilgan xom ashyo (kg).
  const todayRawConsumption = rawContainers.reduce((s, c) => s + c.todayOut, 0);
  // Samaradorlik % = bugun ishlab chiqarilgan / bugun bo'limlarga berilgan.
  const efficiency = todayReceived > 0 ? Math.round((todayProduced / todayReceived) * 100) : 0;

  const alerts: { level: string; text: string }[] = [];
  for (const d of departments) {
    if (d.wipKg < 0) {
      alerts.push({ level: "danger", text: `${d.name}: WIP manfiy (${d.wipKg.toFixed(0)} kg) — qabul qilinganidan ko'p ishlab chiqarilgan` });
    } else if (d.wipKg > 0 && d.todayProduced === 0) {
      alerts.push({ level: "warn", text: `${d.name}: ${d.wipKg.toFixed(0)} kg jarayonda, lekin bugun ishlab chiqarish yo'q` });
    }
  }
  if (rawContainers.length === 0) {
    alerts.push({ level: "warn", text: "Xom ashyo konteyneri belgilanmagan — konteynerni 'xom ashyo' deb belgilang" });
  } else {
    const empty = rawContainers.filter((c) => c.totalKg <= 0).length;
    if (empty > 0) alerts.push({ level: "info", text: `${empty} ta xom ashyo konteyneri bo'sh` });
  }

  res.json({
    rawContainers,
    departments,
    finishedContainers,
    allContainers,
    history,
    kpis: {
      totalRawKg,
      totalWipKg,
      totalFinishedKg,
      todayReceived,
      todayProduced,
      departmentsWorking,
      todayRawConsumption,
      efficiency,
      rawContainerCount: rawContainers.length,
      departmentCount: departments.length,
      finishedContainerCount: finishedContainers.length,
    },
    alerts,
  });
});

// ── POST /api/ombor/flow/produce ───────────────────────────────────────────────
// Bo'lim tayyor mahsulot chiqaradi: WIP'ga PRODUCE (-kg ledger) yoziladi va
// tanlangan tayyor konteynerga (inventory product_type='finished') qo'shiladi.
// /flow/receive bilan bir xil xavfsizlik: tranzaksiya, purpose='finished' tekshiruvi,
// kanonik mahsulot nomi mosligi va actingUser attributsiyasi.
router.post("/ombor/flow/produce", async (req, res): Promise<void> => {
  const { lineId, warehouseId, product, quantity, kg, note = "" } = req.body ?? {};
  if (!lineId || !warehouseId || !product) {
    res.status(400).json({ error: "lineId, warehouseId, product required" }); return;
  }
  const qty = Number(quantity);
  if (isNaN(qty) || qty <= 0) {
    res.status(400).json({ error: "quantity must be > 0" }); return;
  }
  const kgInput = kg === undefined || kg === null || kg === "" ? 0 : Number(kg);
  if (isNaN(kgInput) || kgInput < 0) {
    res.status(400).json({ error: "kg must be >= 0" }); return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lineRes = await client.query("SELECT id, name FROM production_lines WHERE id=$1", [lineId]);
    if (!lineRes.rows.length) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Bo'lim topilmadi" }); return;
    }
    // Maqsad konteyner tayyor mahsulot ombori bo'lishi shart.
    const whRes = await client.query(
      "SELECT id FROM warehouses WHERE id=$1 AND location_type='container' AND purpose='finished'", [warehouseId],
    );
    if (!whRes.rows.length) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Tayyor mahsulot konteyneri topilmadi (purpose='finished' bo'lishi kerak)" }); return;
    }
    // Mahsulot mavjud bo'lishi shart — og'irligi kg fallback uchun olinadi.
    const prodRes = await client.query(
      "SELECT name, weight FROM products WHERE LOWER(name)=LOWER($1) ORDER BY id LIMIT 1", [product],
    );
    if (!prodRes.rows.length) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `"${product}" ro'yxatdagi mahsulotga mos kelmadi. Mavjud mahsulotni tanlang.` }); return;
    }
    const canonicalProduct: string = prodRes.rows[0].name;
    const unitWeight = Number(prodRes.rows[0].weight) > 0 ? Number(prodRes.rows[0].weight) : 0;
    // PRODUCE kg = kiritilgan kg, aks holda quantity × birlik og'irligi (bot bilan bir xil).
    const produceKg = kgInput > 0 ? kgInput : qty * unitWeight;

    await client.query(
      `INSERT INTO wip_movements
         (line_id, movement_type, product, weight_kg, note, created_by)
       VALUES ($1,'PRODUCE',$2,$3,$4,$5)`,
      [lineId, canonicalProduct, produceKg, note || `Tayyor chiqarildi: ${qty}`, actingUser(req)],
    );
    await client.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type)
       VALUES ($1,$2,$3,$4,'finished')
       ON CONFLICT (warehouse_id, product)
       DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity,
                     weight_kg = inventory.weight_kg + EXCLUDED.weight_kg,
                     product_type = 'finished', updated_at=NOW()`,
      [warehouseId, canonicalProduct, qty, produceKg],
    );
    await client.query(
      `INSERT INTO stock_movements
         (product, quantity, movement_type, to_warehouse_id, note, created_by, product_type)
       VALUES ($1,$2,'IN',$3,$4,$5,'finished')`,
      [canonicalProduct, qty, warehouseId, note || `Tayyor mahsulot chiqarildi: ${qty}`, actingUser(req)],
    );
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

export default router;
