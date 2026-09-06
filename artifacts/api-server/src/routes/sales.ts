import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  DeleteSaleParams,
  HealthCheckResponse,
} from "@workspace/api-zod";
import { resolveProductPrice } from "../lib/pricing";
import { guardGenericInventoryWarehouses } from "../lib/genericInventoryWarehouseGuard";
import { creditTopmartSale } from "../lib/topmartSaleCredit";
import { createHash } from "node:crypto";

const router: IRouter = Router();

// ── DB migrations (idempotent) ────────────────────────────────────────────────
async function ensureSalesSchema() {
  try {
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_type TEXT NOT NULL DEFAULT 'naqd'`);
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS paid_amount  NUMERIC(12,2) NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS debt_amount  NUMERIC(12,2) NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS topmart_warehouse_id INTEGER`);
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS operation_key TEXT`);
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS request_fingerprint TEXT`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_operation_key
        ON sales(operation_key) WHERE operation_key IS NOT NULL
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sale_payments (
        id         SERIAL PRIMARY KEY,
        sale_id    INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        amount     NUMERIC(12,2) NOT NULL,
        currency   TEXT NOT NULL DEFAULT 'USD',
        note       TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);

    // Audit log
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sale_events (
        id          SERIAL PRIMARY KEY,
        sale_id     INTEGER REFERENCES sales(id) ON DELETE SET NULL,
        event_type  TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        amount      NUMERIC(12,2),
        currency    TEXT,
        user_id     INTEGER,
        created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);

    // Back-fill paid sales
    await pool.query(`
      UPDATE sales SET paid_amount = total_amount
      WHERE status = 'paid' AND paid_amount = 0 AND total_amount > 0
    `);
  } catch (_) {}
}
ensureSalesSchema();

// ── Helpers ───────────────────────────────────────────────────────────────────
async function logEvent(
  saleId: number,
  eventType: string,
  description: string,
  userId?: number,
  amount?: number,
  currency?: string,
) {
  try {
    await pool.query(
      `INSERT INTO sale_events (sale_id, event_type, description, user_id, amount, currency)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [saleId, eventType, description, userId ?? null, amount ?? null, currency ?? null],
    );
  } catch (_) {}
}

// ── GET /sales ────────────────────────────────────────────────────────────────
router.get("/sales", async (req, res): Promise<void> => {
  const status     = req.query.status as string | undefined;
  const customerId = req.query.customerId ? parseInt(req.query.customerId as string) : undefined;
  const limit      = Math.min(parseInt((req.query.limit  as string) ?? "50"), 200);
  const offset     = Math.max(parseInt((req.query.offset as string) ?? "0"), 0);

  const conditions: string[] = [];
  const params: unknown[]    = [];

  if (customerId != null && !isNaN(customerId)) {
    params.push(customerId); conditions.push(`s.customer_id=$${params.length}`);
  }
  if (status && ["paid","pending","partial"].includes(status)) {
    params.push(status); conditions.push(`s.status=$${params.length}`);
  }

  const where       = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const filterParams = [...params];

  params.push(limit);  const limitIdx  = params.length;
  params.push(offset); const offsetIdx = params.length;

  const [salesRes, countRes] = await Promise.all([
    pool.query(
      `SELECT s.id, s.customer_id, s.customer_name, s.status, s.note,
              s.total_amount, s.paid_amount, s.debt_amount, s.payment_type,
               s.currency, s.topmart_warehouse_id, s.operation_key, s.created_at
       FROM sales s ${where}
       ORDER BY s.id DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    ),
    pool.query(
      `SELECT COUNT(*) AS cnt FROM sales s ${where}`,
      filterParams,
    ),
  ]);

  const saleIds = salesRes.rows.map((r) => r.id);
  const itemsBySale: Record<number, any[]> = {};

  if (saleIds.length > 0) {
    const itemsRes = await pool.query(
      `SELECT id, sale_id, product_name, sale_type, quantity, unit_price, currency, line_total
       FROM sale_items WHERE sale_id = ANY($1) ORDER BY id`,
      [saleIds],
    );
    for (const row of itemsRes.rows) {
      if (!itemsBySale[row.sale_id]) itemsBySale[row.sale_id] = [];
      itemsBySale[row.sale_id].push({
        id:          row.id,
        productName: row.product_name,
        saleType:    row.sale_type,
        quantity:    Number(row.quantity),
        unitPrice:   Number(row.unit_price),
        currency:    row.currency,
        lineTotal:   Number(row.line_total),
      });
    }
  }

  res.json({
    items: salesRes.rows.map((s) => ({
      id:           s.id,
      customerId:   s.customer_id,
      customerName: s.customer_name,
      status:       s.status,
      note:         s.note ?? "",
      totalAmount:  Number(s.total_amount),
      paidAmount:   Number(s.paid_amount ?? 0),
      debtAmount:   Number(s.debt_amount ?? 0),
      paymentType:  s.payment_type ?? "naqd",
      currency:     s.currency ?? "USD",
      topmartWarehouseId: s.topmart_warehouse_id ?? null,
      operationKey: s.operation_key ?? null,
      createdAt:    s.created_at instanceof Date ? s.created_at.toISOString() : String(s.created_at),
      saleItems:    itemsBySale[s.id] ?? [],
    })),
    total: Number(countRes.rows[0].cnt),
  });
});

// ── POST /sales ───────────────────────────────────────────────────────────────
router.post("/sales", async (req, res): Promise<void> => {
  const {
    customerId,
    note = "",
    items,
    paymentType = "naqd",
    paidAmount: rawPaid,
    operationKey,
  } = req.body ?? {};

  // ── Validation ──
  if (!customerId || typeof customerId !== "number") {
    res.status(400).json({ error: "customerId required" }); return;
  }
  if (!["naqd","nasiya","aralash"].includes(paymentType)) {
    res.status(400).json({ error: "paymentType must be naqd|nasiya|aralash" }); return;
  }
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "items array required (min 1)" }); return;
  }
  if (items.length > 200) {
    res.status(400).json({ error: "Max 200 items per sale" }); return;
  }
  for (const it of items) {
    if (!it.productName || typeof it.productName !== "string") {
      res.status(400).json({ error: "Each item needs productName" }); return;
    }
    const qty = Number(it.quantity);
    if (isNaN(qty) || qty <= 0) { res.status(400).json({ error: "quantity must be > 0" }); return; }
  }

  const customerRes = await pool.query(
    "SELECT name FROM customers WHERE id=$1 AND deleted_at IS NULL",
    [customerId],
  );
  if (!customerRes.rows.length) {
    res.status(404).json({ error: "Customer not found" }); return;
  }
  const customerName = customerRes.rows[0].name;

  // Server-authoritative pricing: recompute unit_price + currency from the matching
  // volume tier (inclusive min<=qty<=max) or product default, so clients cannot
  // tamper with tier prices. Resolved values are what get stored on sale_items.
  const resolvedItems: Array<{
    productName: string; saleType: string; quantity: number;
    unitPrice: number; currency: string; lineTotal: number;
  }> = [];
  for (const it of items) {
    const qty = Number(it.quantity);
    const resolved = await resolveProductPrice(String(it.productName), qty);
    if (!resolved.found) {
      res.status(400).json({ error: `Mahsulot topilmadi: ${it.productName}` }); return;
    }
    resolvedItems.push({
      productName: String(it.productName).slice(0, 120),
      saleType:    resolved.saleType,
      quantity:    qty,
      unitPrice:   resolved.unitPrice,
      currency:    String(resolved.currency).toUpperCase(),
      lineTotal:   qty * resolved.unitPrice,
    });
  }

  const allCurrencies      = resolvedItems.map(it => it.currency);
  const distinctCurrencies = [...new Set(allCurrencies)];
  const fractionalPieceItem = resolvedItems.find(
    (it) => String(it.saleType).toLowerCase() !== "kg"
      && !Number.isSafeInteger(it.quantity),
  );
  if (fractionalPieceItem) {
    res.status(400).json({
      error: `Dona mahsulot miqdori butun son bo'lishi kerak: ${fractionalPieceItem.productName}`,
    });
    return;
  }
  // Sotuv darajasidagi jami/qarz bitta valyutada saqlanadi. Aralash valyuta
  // (UZS + USD) jami/qarzni buzadi, shuning uchun bunday sotuvni rad etamiz.
  if (distinctCurrencies.length > 1) {
    res.status(400).json({
      error: "Bitta sotuvda turli valyutadagi mahsulotlar (UZS va USD) bo'lishi mumkin emas. Iltimos, ularni alohida sotuvlarga ajrating.",
    });
    return;
  }
  const primaryCurrency = distinctCurrencies[0] ?? "UZS";
  const totalAmount     = resolvedItems.reduce((sum, it) => sum + it.lineTotal, 0);
  const requestFingerprint = createHash("sha256").update(JSON.stringify({
    customerId,
    note: String(note).slice(0, 500),
    paymentType,
    paidAmount: paymentType === "aralash" ? Number(rawPaid) : null,
    items: items.map((it: any) => ({
      productName: String(it.productName).slice(0, 120),
      quantity: Number(it.quantity),
    })),
  })).digest("hex");

  // ── Payment amounts (server-side, not trusted from client) ──
  let paidAmt: number;
  let debtAmt: number;
  let finalStatus: string;

  if (paymentType === "naqd") {
    paidAmt     = totalAmount;
    debtAmt     = 0;
    finalStatus = "paid";
  } else if (paymentType === "nasiya") {
    paidAmt     = 0;
    debtAmt     = totalAmount;
    finalStatus = "pending";
  } else {
    // aralash: validate paid cannot exceed total
    const raw = Number(rawPaid);
    if (isNaN(raw) || raw < 0) {
      res.status(400).json({ error: "paidAmount must be >= 0" }); return;
    }
    paidAmt     = Math.min(raw, totalAmount);
    debtAmt     = totalAmount - paidAmt;
    finalStatus = debtAmt <= 0.001 ? "paid" : "partial";
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // An operation key is a global sale identity, not an identity scoped to the
    // current Top Mart configuration. Configuration may change after a commit,
    // so always serialize and resolve a supplied key before classifying this
    // request against today's configured customer/warehouse.
    if (typeof operationKey === "string") {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `topmart-sale:${operationKey}`,
      ]);
      const replay = await client.query(
        `SELECT id, request_fingerprint, topmart_warehouse_id
           FROM sales WHERE operation_key=$1`,
        [operationKey],
      );
      if (replay.rows.length) {
        if (String(replay.rows[0].request_fingerprint) !== requestFingerprint) {
          await client.query("ROLLBACK");
          res.status(409).json({ error: "operationKey replay has a different request fingerprint" });
          return;
        }
        const replayWarehouseId = replay.rows[0].topmart_warehouse_id == null
          ? null
          : Number(replay.rows[0].topmart_warehouse_id);
        await client.query("COMMIT");
        res.status(200).json({
          id: Number(replay.rows[0].id),
          ok: true,
          replayed: true,
          topmartCredited: replayWarehouseId != null,
          topmartWarehouseId: replayWarehouseId,
        });
        return;
      }
    }

    // Lock the singleton selection so a concurrent admin reconfiguration cannot
    // split a sale between two destinations. Absence is safe: ordinary factory
    // sale behavior remains unchanged and no warehouse receives stock.
    const topmartConfigRes = await client.query(
      `SELECT customer_id, central_warehouse_id
         FROM distribution.topmart_config
        WHERE id=1
        FOR SHARE`,
    );
    const topmartConfig = topmartConfigRes.rows[0] as
      | { customer_id: number; central_warehouse_id: number }
      | undefined;
    const isTopmartSale = Number(topmartConfig?.customer_id) === customerId;
    let topmartWarehouseId: number | null = null;
    if (isTopmartSale) {
      if (
        typeof operationKey !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationKey)
      ) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "A valid operationKey is required for Top Mart sales" });
        return;
      }
      const warehouse = await client.query(
        `SELECT id FROM warehouses
          WHERE id=$1 AND active=TRUE
            AND COALESCE(location_type,'general') <> 'vehicle'
            AND purpose='finished'
          FOR SHARE`,
        [topmartConfig!.central_warehouse_id],
      );
      if (!warehouse.rows.length) {
        throw new Error("Configured Top Mart central warehouse is unavailable");
      }
      topmartWarehouseId = Number(warehouse.rows[0].id);
    }

    const saleRes = await client.query(
      `INSERT INTO sales (customer_id, customer_name, status, note, total_amount, currency,
                          payment_type, paid_amount, debt_amount, topmart_warehouse_id,
                          operation_key, request_fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [customerId, customerName, finalStatus,
       String(note).slice(0, 500), totalAmount, primaryCurrency,
       paymentType, paidAmt, debtAmt, topmartWarehouseId,
       isTopmartSale ? operationKey : null,
       isTopmartSale ? requestFingerprint : null],
    );
    const saleId = saleRes.rows[0].id;
    const removedItems = resolvedItems.map((it) => ({
      productName: it.productName,
      removedQuantity: 0,
      removedWeightKg: 0,
    }));
    const authoritativeWeights = new Map<string, number>();
    if (isTopmartSale) {
      const weights = await client.query(
        `SELECT name, weight FROM products WHERE name = ANY($1::text[])`,
        [[...new Set(resolvedItems.map((it) => it.productName))]],
      );
      for (const row of weights.rows) {
        authoritativeWeights.set(String(row.name), Number(row.weight) || 0);
      }
    }

    for (const it of resolvedItems) {
      await client.query(
        `INSERT INTO sale_items (sale_id, product_name, sale_type, quantity, unit_price, currency, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [saleId, it.productName, it.saleType,
         it.quantity, it.unitPrice, it.currency, it.lineTotal],
      );
    }

    if (paymentType === "aralash" && paidAmt > 0) {
      await client.query(
        `INSERT INTO sale_payments (sale_id, amount, currency, note)
         VALUES ($1,$2,$3,'Boshlang''ich to''lov')`,
        [saleId, paidAmt, primaryCurrency],
      );
    }

    // ── Tayyor mahsulot omboridan kamaytirish ──────────────────────────────
    // Mahsulot zaxirasi qaysi omborda bo'lsa, o'sha yerdan kamaytiramiz
    // (partiya mahsulotni konteynerga kiritadi — har doim 1-ombor emas).
    try {
      for (let itemIndex = 0; itemIndex < resolvedItems.length; itemIndex += 1) {
        const it = resolvedItems[itemIndex]!;
        const removed = removedItems[itemIndex]!;
        const isKgSale = String(it.saleType || "").toLowerCase() === "kg";

        if (isKgSale) {
          // kg mahsulot: zaxira weight_kg da turadi (quantity=0 bo'lishi normal) —
          // og'irlik bo'yicha kamaytiramiz, dona katakchasiga tegmaymiz.
          let remainingKg = Number(it.quantity);
          if (remainingKg <= 0) continue;

          const { rows: kgWarehouseRows } = await client.query(
            `SELECT i.warehouse_id
               FROM inventory i
               JOIN warehouses w ON w.id = i.warehouse_id
              WHERE i.product = $1
                AND COALESCE(i.weight_kg, 0) > 0
                AND COALESCE(w.location_type,'general') != 'vehicle'
                 AND ($2::int IS NULL OR i.warehouse_id <> $2)
              ORDER BY i.warehouse_id`,
            [it.productName, topmartWarehouseId],
          );
          const kgWarehouseIds = await guardGenericInventoryWarehouses(
            client,
            kgWarehouseRows.map((row) => row.warehouse_id),
          );
          const { rows: kgRows } = kgWarehouseIds.length === 0
            ? { rows: [] }
            : await client.query(
            `SELECT i.warehouse_id, i.weight_kg
               FROM inventory i
               JOIN warehouses w ON w.id = i.warehouse_id
              WHERE i.product = $1
                AND COALESCE(i.weight_kg, 0) > 0
                AND COALESCE(w.location_type,'general') != 'vehicle'
                AND i.warehouse_id = ANY($2::int[])
                 AND ($3::int IS NULL OR i.warehouse_id <> $3)
              ORDER BY weight_kg DESC
              FOR UPDATE OF i`,
            [it.productName, kgWarehouseIds, topmartWarehouseId],
          );
          for (const row of kgRows) {
            if (remainingKg <= 0) break;
            const takeKg = Math.min(Number(row.weight_kg), remainingKg);
            await client.query(
              `UPDATE inventory i
                  SET weight_kg = COALESCE(i.weight_kg,0) - $1, updated_at = NOW()
                WHERE i.product = $2 AND i.warehouse_id = $3
                  AND EXISTS (
                    SELECT 1 FROM warehouses w
                     WHERE w.id = i.warehouse_id
                       AND COALESCE(w.location_type,'general') != 'vehicle'
                  )`,
              [takeKg, it.productName, row.warehouse_id],
            );
            removed.removedWeightKg += takeKg;
            await client.query(
              `INSERT INTO stock_movements
                 (product, quantity, movement_type, from_warehouse_id, note, created_by, product_type, weight_kg)
               VALUES ($1,0,'OUT',$2,$3,'system','finished',$4)`,
              [it.productName, row.warehouse_id, `Savdo #${saleId}: ${takeKg.toFixed(2)} kg`, takeKg],
            );
            remainingKg -= takeKg;
          }

          // Og'irlik yetmadi: qolganini asosiy ombordan manfiy yozamiz
          // (ortiqcha sotilgani ko'rinib turadi).
          if (remainingKg > 0) {
            const { rows: whRows } = await client.query(
              `SELECT id FROM warehouses
                WHERE active=TRUE
                  AND COALESCE(location_type,'general') != 'vehicle'
                 AND ($1::int IS NULL OR id <> $1)
                ORDER BY id LIMIT 1 FOR UPDATE`,
              [topmartWarehouseId],
            );
            const whId = whRows[0]?.id ?? null;
            if (whId) {
              await client.query(
                `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type, updated_at)
                 VALUES ($1,$2,0,$3,'finished',NOW())
                 ON CONFLICT (warehouse_id, product)
                 DO UPDATE SET weight_kg = COALESCE(inventory.weight_kg,0) - $4, updated_at = NOW()`,
                [whId, it.productName, -remainingKg, remainingKg],
              );
              await client.query(
                `INSERT INTO stock_movements
                   (product, quantity, movement_type, from_warehouse_id, note, created_by, product_type, weight_kg)
                 VALUES ($1,0,'OUT',$2,$3,'system','finished',$4)`,
                [it.productName, whId, `Savdo #${saleId}: ${remainingKg.toFixed(2)} kg (zaxira yetmadi)`, remainingKg],
              );
              removed.removedWeightKg += remainingKg;
            } else if (isTopmartSale) {
              throw new Error("No source warehouse is available for Top Mart kg deduction");
            }
          }
          continue;
        }

        let remaining = Math.round(it.quantity);
        if (remaining <= 0) continue;

        // Zaxira bor omborlardan ketma-ket kamaytiramiz (ko'pi birinchi).
        const { rows: stockWarehouseRows } = await client.query(
          `SELECT i.warehouse_id
             FROM inventory i
             JOIN warehouses w ON w.id = i.warehouse_id
            WHERE i.product = $1 AND i.quantity > 0
              AND COALESCE(w.location_type,'general') != 'vehicle'
               AND ($2::int IS NULL OR i.warehouse_id <> $2)
            ORDER BY i.warehouse_id`,
          [it.productName, topmartWarehouseId],
        );
        const stockWarehouseIds = await guardGenericInventoryWarehouses(
          client,
          stockWarehouseRows.map((row) => row.warehouse_id),
        );
        const { rows: stockRows } = stockWarehouseIds.length === 0
          ? { rows: [] }
          : await client.query(
          `SELECT i.warehouse_id, i.quantity, i.weight_kg
             FROM inventory i
             JOIN warehouses w ON w.id = i.warehouse_id
            WHERE i.product = $1 AND i.quantity > 0
              AND COALESCE(w.location_type,'general') != 'vehicle'
              AND i.warehouse_id = ANY($2::int[])
               AND ($3::int IS NULL OR i.warehouse_id <> $3)
            ORDER BY quantity DESC
            FOR UPDATE OF i`,
          [it.productName, stockWarehouseIds, topmartWarehouseId],
        );
        for (const row of stockRows) {
          if (remaining <= 0) break;
          const take = Math.min(Number(row.quantity), remaining);
          const rowW = Number(row.weight_kg) || 0;
          // Og'irlikni dona ulushiga proporsional kamaytiramiz (transfer bilan bir xil qoida).
          const takeW = rowW > 0
            ? (rowW * take) / Number(row.quantity)
            : (isTopmartSale ? (authoritativeWeights.get(it.productName) ?? 0) * take : 0);
          await client.query(
            `UPDATE inventory i SET quantity = i.quantity - $1,
                    weight_kg = COALESCE(i.weight_kg,0) - $2, updated_at = NOW()
              WHERE i.product = $3 AND i.warehouse_id = $4
                AND EXISTS (
                  SELECT 1 FROM warehouses w
                   WHERE w.id = i.warehouse_id
                     AND COALESCE(w.location_type,'general') != 'vehicle'
                )`,
            [take, takeW, it.productName, row.warehouse_id],
          );
          removed.removedQuantity += take;
          removed.removedWeightKg += takeW;
          await client.query(
            `INSERT INTO stock_movements
               (product, quantity, movement_type, from_warehouse_id, note, created_by, product_type, weight_kg)
             VALUES ($1,$2,'OUT',$3,$4,'system','finished',$5)`,
            [it.productName, take, row.warehouse_id, `Savdo #${saleId}`, takeW > 0 ? takeW : null],
          );
          remaining -= take;
        }

        // Zaxira yetmadi (yoki umuman yo'q): qolganini asosiy ombordan yozamiz
        // (ombor manfiyga tushadi — ortiqcha sotilgani ko'rinib turadi).
        if (remaining > 0) {
          const { rows: whRows } = await client.query(
            `SELECT id FROM warehouses
              WHERE active=TRUE
                AND COALESCE(location_type,'general') != 'vehicle'
               AND ($1::int IS NULL OR id <> $1)
              ORDER BY id LIMIT 1 FOR UPDATE`,
            [topmartWarehouseId],
          );
          const whId = whRows[0]?.id ?? null;
          if (whId) {
            const shortageWeight = isTopmartSale
              ? (authoritativeWeights.get(it.productName) ?? 0) * remaining
              : 0;
            await client.query(
              `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type, updated_at)
               VALUES ($1,$2,$3,$5,'finished',NOW())
               ON CONFLICT (warehouse_id, product)
               DO UPDATE SET quantity = inventory.quantity - $4,
                             weight_kg = COALESCE(inventory.weight_kg,0) - $6,
                             updated_at = NOW()`,
              [whId, it.productName, -remaining, remaining, -shortageWeight, shortageWeight],
            );
            await client.query(
              `INSERT INTO stock_movements
                  (product, quantity, movement_type, from_warehouse_id, note, created_by, product_type, weight_kg)
                VALUES ($1,$2,'OUT',$3,$4,'system','finished',$5)`,
              [it.productName, remaining, whId, `Savdo #${saleId}`, shortageWeight || null],
            );
            removed.removedQuantity += remaining;
            removed.removedWeightKg += shortageWeight;
          } else if (isTopmartSale) {
            throw new Error("No source warehouse is available for Top Mart quantity deduction");
          }
        }
      }
    } catch (e: any) {
      // Ombordan kamaytirish savdo bilan birga atomar bo'lishi shart:
      // xatolik bo'lsa, butun savdoni bekor qilamiz (tashqi catch ROLLBACK qiladi).
      req.log?.error?.({ err: e, saleId }, "sale inventory deduction failed");
      throw e;
    }

    // Factory sale OUT movements above remain untouched. Only the configured
    // Top Mart customer receives a corresponding C-3 credit. This deliberately
    // does not create, update, print, or replace production-label rows: physical
    // barcode identities remain exactly as issued.
    if (topmartWarehouseId != null) {
      try {
        // TRANSFER captures business attribution and IN captures destination
        // receipt; the helper mutates inventory once and never touches labels.
        await creditTopmartSale(client, saleId, topmartWarehouseId, removedItems);
      } catch (e: any) {
        req.log?.error?.({ err: e, saleId, topmartWarehouseId }, "topmart sale credit failed");
        throw e;
      }
    }

    await client.query("COMMIT");

    // Audit
    await logEvent(
      saleId, "created",
      `${paymentType} | ${primaryCurrency} ${totalAmount.toFixed(2)}` +
        (paymentType === "aralash" ? ` | naqd: ${paidAmt.toFixed(2)}, nasiya: ${debtAmt.toFixed(2)}` : ""),
      req.userId, totalAmount, primaryCurrency,
    );

    res.status(201).json({
      id: saleId,
      ok: true,
      topmartCredited: topmartWarehouseId != null,
      topmartWarehouseId,
    });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── POST /sales/:id/payments ──────────────────────────────────────────────────
router.post("/sales/:id/payments", async (req, res): Promise<void> => {
  const saleId = parseInt(req.params.id, 10);
  const { amount, currency, note = "" } = req.body ?? {};

  if (!saleId || isNaN(saleId)) { res.status(400).json({ error: "Invalid sale id" }); return; }

  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) {
    res.status(400).json({ error: "amount must be > 0" }); return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const saleRes = await client.query(
      "SELECT id, total_amount, debt_amount, paid_amount, status, currency FROM sales WHERE id=$1 FOR UPDATE",
      [saleId],
    );
    if (!saleRes.rows.length) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Sale not found" }); return;
    }

    const sale = saleRes.rows[0];
    const saleCurrency = String(sale.currency ?? "").trim().toUpperCase();
    const normalizedCurrency = currency == null
      ? saleCurrency
      : typeof currency === "string" ? currency.trim().toUpperCase() : "";
    if (!normalizedCurrency || normalizedCurrency !== saleCurrency) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Payment currency must match sale currency (${saleCurrency})` });
      return;
    }
    // Bot-created sales have debt_amount=0 but status='pending'; compute effective debt
    const maxPay = Number(sale.debt_amount) > 0
      ? Number(sale.debt_amount)
      : Math.max(0, Number(sale.total_amount) - Number(sale.paid_amount ?? 0));

    if (maxPay <= 0) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Bu savdo allaqachon to'liq to'langan" }); return;
    }

    // Never allow overpayment — clamp to remaining debt
    const effectiveAmt = Math.min(amt, maxPay);
    const newPaid      = Number(sale.paid_amount) + effectiveAmt;
    const newDebt      = Math.max(0, maxPay - effectiveAmt);
    const newStatus    = newDebt <= 0.001 ? "paid" : "partial";

    await client.query(
      `UPDATE sales SET paid_amount=$1, debt_amount=$2, status=$3 WHERE id=$4`,
      [newPaid, newDebt, newStatus, saleId],
    );
    await client.query(
      `INSERT INTO sale_payments (sale_id, amount, currency, note) VALUES ($1,$2,$3,$4)`,
      [saleId, effectiveAmt, normalizedCurrency, String(note).slice(0, 200)],
    );

    await client.query("COMMIT");

    await logEvent(
      saleId, "payment_added",
      `+${effectiveAmt.toFixed(2)} ${normalizedCurrency}${note ? ` — ${note}` : ""}`,
      req.userId, effectiveAmt, normalizedCurrency,
    );

    res.json({ ok: true, paidAmount: newPaid, debtAmount: newDebt, status: newStatus });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── GET /sales/:id/payments ───────────────────────────────────────────────────
router.get("/sales/:id/payments", async (req, res): Promise<void> => {
  const saleId = parseInt(req.params.id, 10);
  if (isNaN(saleId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const r = await pool.query(
    `SELECT id, amount, currency, note, created_at
     FROM sale_payments WHERE sale_id=$1 ORDER BY id`,
    [saleId],
  );
  res.json(
    r.rows.map((p) => ({
      id:        p.id,
      amount:    Number(p.amount),
      currency:  p.currency,
      note:      p.note,
      createdAt: p.created_at instanceof Date ? p.created_at.toISOString() : String(p.created_at),
    })),
  );
});

// ── GET /sales/:id/events  (audit log) ───────────────────────────────────────
router.get("/sales/:id/events", async (req, res): Promise<void> => {
  const saleId = parseInt(req.params.id, 10);
  if (isNaN(saleId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const r = await pool.query(
    `SELECT id, event_type, description, amount, currency, user_id, created_at
     FROM sale_events WHERE sale_id=$1 ORDER BY id DESC LIMIT 50`,
    [saleId],
  );
  res.json(
    r.rows.map((e) => ({
      id:          e.id,
      eventType:   e.event_type,
      description: e.description,
      amount:      e.amount != null ? Number(e.amount) : null,
      currency:    e.currency,
      userId:      e.user_id,
      createdAt:   e.created_at instanceof Date ? e.created_at.toISOString() : String(e.created_at),
    })),
  );
});

// ── DELETE /sales/:id ─────────────────────────────────────────────────────────
router.delete("/sales/:id", async (req, res): Promise<void> => {
  const raw    = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = DeleteSaleParams.safeParse({ id: parseInt(raw, 10) });
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sale = await client.query(
      "SELECT topmart_warehouse_id FROM sales WHERE id=$1 FOR UPDATE",
      [parsed.data.id],
    );
    if (!sale.rows.length) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Sale not found" }); return;
    }
    if (sale.rows[0].topmart_warehouse_id != null) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "Top Mart credited sales cannot be deleted" }); return;
    }
    await client.query(
      `INSERT INTO sale_events (sale_id, event_type, description, user_id)
       VALUES ($1,'deleted','Sale deleted',$2)`,
      [parsed.data.id, req.userId ?? null],
    );
    await client.query("DELETE FROM sales WHERE id=$1", [parsed.data.id]);
    await client.query("COMMIT");
    res.json(HealthCheckResponse.parse({ status: "ok" }));
  } catch (e: any) {
    await client.query("ROLLBACK").catch(() => undefined);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── PATCH /sales/:id/status ───────────────────────────────────────────────────
router.patch("/sales/:id/status", async (req, res): Promise<void> => {
  const saleId = parseInt(req.params.id, 10);
  const { status } = req.body ?? {};

  if (!saleId || isNaN(saleId)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!status || !["paid","pending","partial"].includes(status)) {
    res.status(400).json({ error: "status must be paid|pending|partial" }); return;
  }

  const updateQ =
    status === "paid"
      ? `UPDATE sales SET status=$1, debt_amount=0, paid_amount=total_amount WHERE id=$2`
      : `UPDATE sales SET status=$1 WHERE id=$2`;

  const result = await pool.query(updateQ, [status, saleId]);
  if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: "Sale not found" }); return; }

  await logEvent(saleId, "status_changed", `→ ${status}`, req.userId);

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
