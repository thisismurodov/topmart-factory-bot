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

  const newStock = Number(currentStock);
  if (!isFinite(newStock) || newStock < 0) {
    res.status(400).json({ error: "currentStock must be a finite number >= 0" }); return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Mavjud nom bo'lsa — zahirani JIMGINA almashtirmaymiz: PATCH'dagi kabi
    // delta hisoblanib stock_movements'ga IN/OUT yozuvi qo'shiladi, aks holda
    // raw-reconcile darhol farq topadi. FOR UPDATE — parallel o'zgarishlarda
    // delta har doim haqiqiy bo'lishi uchun.
    const existing = await client.query(
      "SELECT id, name, unit, current_stock FROM raw_materials WHERE name = $1 FOR UPDATE",
      [name.trim()],
    );

    let row;
    if (existing.rows.length === 0) {
      const ins = await client.query(
        `INSERT INTO raw_materials (name, unit, unit_type, default_cost, currency, current_stock, minimum_stock, active)
         VALUES ($1,$2,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [name.trim(), unitType, Number(defaultCost), cur, newStock, Number(minimumStock), Boolean(active)]
      );
      row = ins.rows[0];
    } else {
      const mat = existing.rows[0];
      const upd = await client.query(
        `UPDATE raw_materials SET
           unit=$1, unit_type=$1, default_cost=$2, currency=$3, current_stock=$4, minimum_stock=$5, active=$6
         WHERE id=$7
         RETURNING *`,
        [unitType, Number(defaultCost), cur, newStock, Number(minimumStock), Boolean(active), mat.id]
      );
      row = upd.rows[0];

      const oldStock = Number(mat.current_stock) || 0;
      const delta = newStock - oldStock;
      if (delta !== 0) {
        const movementType = delta > 0 ? "IN" : "OUT";
        const noteText = `Qayta qo'shish (POST) orqali o'zgartirildi: ${oldStock} → ${newStock} ${mat.unit}`;
        await client.query(
          `INSERT INTO stock_movements
             (product, quantity, movement_type, to_warehouse_id, from_warehouse_id, note, created_by, product_type)
           VALUES ($1,$2,$3,NULL,NULL,$4,$5,'raw')`,
          [mat.name, Math.abs(delta), movementType, noteText, req.username || "admin"],
        );
      }
    }

    await client.query("COMMIT");
    res.status(201).json(toRow(row));
  } catch (err: any) {
    await client.query("ROLLBACK");
    res.status(409).json({ error: err.message });
  } finally {
    client.release();
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
  if (req.body.minimumStock !== undefined) { vals.push(Number(req.body.minimumStock));fields.push(`minimum_stock=$${vals.length}`); }
  if (req.body.active !== undefined)       { vals.push(Boolean(req.body.active));     fields.push(`active=$${vals.length}`); }

  // currentStock tahrirlash — ledger yaxlitligi uchun ALOHIDA yo'l:
  // to'g'ridan-to'g'ri UPDATE o'rniga delta hisoblanib stock_movements'ga
  // IN/OUT yozuvi qo'shiladi (aks holda raw-reconcile darhol farq topadi).
  const hasStockChange = req.body.currentStock !== undefined;
  let newStock: number | null = null;
  if (hasStockChange) {
    newStock = Number(req.body.currentStock);
    if (!isFinite(newStock) || newStock < 0) {
      res.status(400).json({ error: "currentStock must be a finite number >= 0" }); return;
    }
  }

  if (fields.length === 0 && !hasStockChange) { res.status(400).json({ error: "No fields to update" }); return; }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // FOR UPDATE — parallel tahrir/to'g'rilashlarda eski→yangi delta har doim
    // haqiqiy bo'lishi uchun qatorni qulflaymiz (raw-adjust bilan bir xil).
    const matRes = await client.query(
      "SELECT id, name, unit, current_stock FROM raw_materials WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!matRes.rows.length) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Not found" }); return;
    }
    const mat = matRes.rows[0];

    if (fields.length > 0) {
      const updVals = [...vals, id];
      await client.query(`UPDATE raw_materials SET ${fields.join(",")} WHERE id=$${updVals.length}`, updVals);
    }

    // Nom o'zgarsa TARIXIY ledger yozuvlarini ham yangi nomga ko'chiramiz —
    // raw-reconcile sm.product = rm.name bo'yicha bog'laydi, aks holda eski
    // nomdagi barcha harakatlar "yo'qolib" darhol farq chiqadi.
    const newName = req.body.name !== undefined ? String(req.body.name) : null;
    if (newName !== null && newName !== mat.name) {
      await client.query(
        "UPDATE stock_movements SET product = $1 WHERE product = $2 AND product_type = 'raw'",
        [newName, mat.name],
      );
    }

    if (hasStockChange) {
      const oldStock = Number(mat.current_stock) || 0;
      const delta = (newStock as number) - oldStock;
      if (delta !== 0) {
        await client.query(
          "UPDATE raw_materials SET current_stock = $1 WHERE id = $2",
          [newStock, id],
        );
        const movementType = delta > 0 ? "IN" : "OUT";
        // Yangi nom kiritilgan bo'lsa ham ledger yozuvi ESKI nom bilan emas,
        // yangilangan nom bilan mos bo'lishi kerak — reconcile sm.product =
        // rm.name bo'yicha bog'laydi.
        const ledgerName = req.body.name !== undefined ? String(req.body.name) : mat.name;
        const noteText = `Tahrirlash orqali o'zgartirildi: ${oldStock} → ${newStock} ${mat.unit}`;
        await client.query(
          `INSERT INTO stock_movements
             (product, quantity, movement_type, to_warehouse_id, from_warehouse_id, note, created_by, product_type)
           VALUES ($1,$2,$3,NULL,NULL,$4,$5,'raw')`,
          [ledgerName, Math.abs(delta), movementType, noteText, req.username || "admin"],
        );
      }
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

// ── DELETE /raw-materials/:id ─────────────────────────────────────────────────
router.delete("/raw-materials/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const result = await pool.query("DELETE FROM raw_materials WHERE id=$1", [id]);
  if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ok: true });
});

export default router;
