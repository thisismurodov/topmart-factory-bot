import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getUsdToUzsRate } from "../lib/exchangeRate";

const router: IRouter = Router();

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
       VALUES ($1,$2,'TRANSFER',$3,$4,$5,'admin',$6)`,
      [product, amount, fromId, toId, note || `Transfer: ${amount}`, productType],
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
       VALUES ($1,$2,'IN',$3,$4,'admin','finished')`,
      [product, amount, warehouseId, note || `Kirim: ${amount}`],
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
         VALUES ($1,$2,'IN',$3,$4,'admin',$5)`,
        [product, Math.abs(delta), warehouseId, noteText, productType],
      );
    } else {
      await client.query(
        `INSERT INTO stock_movements
           (product, quantity, movement_type, from_warehouse_id, note, created_by, product_type)
         VALUES ($1,$2,'OUT',$3,$4,'admin',$5)`,
        [product, Math.abs(delta), warehouseId, noteText, productType],
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

// ── GET /api/ombor/finished-goods ─────────────────────────────────────────────
router.get("/ombor/finished-goods", async (_req, res): Promise<void> => {
  const { rate } = await getUsdToUzsRate();
  const { rows } = await pool.query(`
    SELECT i.product, SUM(i.quantity)::numeric AS stock_qty,
           p.default_sale_price, p.currency_type, p.unit_type,
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
    GROUP BY i.product, p.default_sale_price, p.currency_type, p.unit_type
    HAVING SUM(i.quantity) > 0
    ORDER BY i.product
  `, [rate ?? 0]);
  res.json(rows.map((r) => {
    const isUsd    = String(r.currency_type).toUpperCase() === "USD";
    const priceUzs = isUsd ? Number(r.default_sale_price) * (rate ?? 0) : Number(r.default_sale_price);
    const stockQty = Number(r.stock_qty);
    return {
      product:       r.product,
      stockQty,
      unitType:      r.unit_type || "dona",
      salePrice:     Number(r.default_sale_price),
      currency:      r.currency_type || "UZS",
      priceUzs,
      totalValueUzs: Number(r.total_value_uzs),
    };
  }));
});

// ── GET /api/ombor/movements ───────────────────────────────────────────────────
router.get("/ombor/movements", async (req, res): Promise<void> => {
  const limit      = Math.min(Number(req.query.limit ?? 80), 200);
  const typeFilter = req.query.type ? String(req.query.type) : null;
  const whFilter   = req.query.warehouse ? Number(req.query.warehouse) : null;
  const params: unknown[] = [limit];
  const conds: string[] = [];
  if (typeFilter) { params.push(typeFilter); conds.push(`sm.product_type = $${params.length}`); }
  if (whFilter)   { params.push(whFilter);   conds.push(`(sm.from_warehouse_id = $${params.length} OR sm.to_warehouse_id = $${params.length})`); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const { rows } = await pool.query(
    `SELECT sm.id, sm.product, sm.quantity, sm.movement_type, sm.product_type,
            fw.name AS from_warehouse, tw.name AS to_warehouse,
            sm.note, sm.created_by, sm.created_at
     FROM stock_movements sm
     LEFT JOIN warehouses fw ON fw.id = sm.from_warehouse_id
     LEFT JOIN warehouses tw ON tw.id = sm.to_warehouse_id
     ${where}
     ORDER BY sm.id DESC
     LIMIT $1`,
    params,
  );

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
  })));
});

export default router;
