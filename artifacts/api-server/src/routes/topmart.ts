import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { createHash } from "node:crypto";

const router: IRouter = Router();
export const topmartExternalPurchaseRouter: IRouter = Router();

type ExternalPurchasePayload = {
  productId: number;
  supplier: string;
  quantity: number;
  totalWeightKg: string;
  totalCost: string;
  receiptReference: string;
};

function parseHistoryDate(value: unknown, endOfDay: boolean): Date | null | string {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return "Date filters must use YYYY-MM-DD";
  }
  const validationDate = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(validationDate.getTime()) || validationDate.toISOString().slice(0, 10) !== value) {
    return "Date filters must be valid calendar dates";
  }
  return new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+05:00`);
}

function parseDecimal(value: unknown, scale: number, positive: boolean, label: string): string | string {
  if ((typeof value !== "string" && typeof value !== "number") ||
      (typeof value === "number" && !Number.isFinite(value))) return `${label} must be a decimal number`;
  const raw = String(value);
  const match = new RegExp(`^(\\d+)(?:\\.(\\d{1,${scale}}))?$`).exec(raw);
  if (!match) return `${label} must have at most ${scale} decimal places`;
  const integer = match[1].replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  const canonical = fraction ? `${integer}.${fraction}` : integer;
  if ((positive && canonical === "0") || (!positive && canonical.startsWith("-"))) {
    return `${label} must be ${positive ? "positive" : "nonnegative"}`;
  }
  // NUMERIC(precision, scale): remaining integral digits are precision - scale.
  if (integer.length > (scale === 3 ? 9 : 12)) return `${label} is too large`;
  return canonical;
}

function parseExternalPurchase(body: any): ExternalPurchasePayload | string {
  const productId = Number(body?.productId);
  const supplier = typeof body?.supplier === "string" ? body.supplier.trim() : "";
  const quantity = Number(body?.quantity);
  const totalWeightKg = parseDecimal(body?.totalWeightKg, 3, true, "Total weight");
  const totalCost = parseDecimal(body?.totalCost, 2, false, "Total cost");
  const receiptReference =
    typeof body?.receiptReference === "string" ? body.receiptReference.trim() : "";
  if (!Number.isSafeInteger(productId) || productId <= 0) return "Valid productId is required";
  if (!supplier || supplier.length > 200) return "Supplier is required (maximum 200 characters)";
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 2_147_483_647) {
    return "Quantity must be a positive integer";
  }
  // parseDecimal returns an error string too; valid canonical values are only
  // decimal-shaped strings, so distinguish them before writes/fingerprints.
  if (!/^\d+(?:\.\d+)?$/.test(totalWeightKg)) return totalWeightKg;
  if (!/^\d+(?:\.\d+)?$/.test(totalCost)) return totalCost;
  if (!receiptReference || receiptReference.length > 200) {
    return "Receipt reference is required (maximum 200 characters)";
  }
  return { productId, supplier, quantity, totalWeightKg, totalCost, receiptReference };
}

async function externalPurchaseActor(req: Request): Promise<string | null> {
  if (req.userId != null) {
    const result = await pool.query(
      "SELECT username FROM admin_users WHERE id=$1 AND role='admin'",
      [req.userId],
    );
    return result.rows[0]?.username ?? null;
  }
  const rawChatId = req.headers["x-telegram-chat-id"];
  if (typeof rawChatId !== "string" || !/^[1-9]\d{0,18}$/.test(rawChatId)) return null;
  const result = await pool.query(
    `SELECT worker_name FROM user_roles
      WHERE chat_id=$1 AND role IN ('admin','omborchi')`,
    [rawChatId],
  );
  return result.rows[0]?.worker_name ?? null;
}

async function requireExternalPurchaseActor(req: Request, res: Response): Promise<string | null> {
  const actor = await externalPurchaseActor(req);
  if (actor == null) {
    res.status(403).json({ error: "Admin session or authorized Telegram warehouse operator required" });
    return null;
  }
  return actor;
}

function purchaseFingerprint(payload: ExternalPurchasePayload): string {
  return createHash("sha256").update(JSON.stringify({
    productId: payload.productId,
    supplier: payload.supplier,
    quantity: payload.quantity,
    totalWeightKg: payload.totalWeightKg,
    totalCost: payload.totalCost,
  })).digest("hex");
}

topmartExternalPurchaseRouter.get(
  "/topmart/external-products",
  async (req, res): Promise<void> => {
    try {
      if (!(await requireExternalPurchaseActor(req, res))) return;
      const result = await pool.query(
        `SELECT p.id, p.name, p.sku, p.unit_type
           FROM products p
          WHERE p.active=TRUE AND p.in_sales=TRUE AND p.in_production=FALSE
            AND btrim(COALESCE(p.sku,'')) <> ''
            AND (SELECT COUNT(*) FROM distribution.mahsulotlar m
                  WHERE m.faol=1 AND m.sku=p.sku)=1
            AND (SELECT COUNT(*) FROM products px
                  WHERE px.active=TRUE AND px.sku=p.sku)=1
          ORDER BY name, id`,
      );
      res.json(result.rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        sku: row.sku,
        unitType: row.unit_type,
      })));
    } catch (error) {
      req.log?.error?.({ err: error }, "external purchase product list failed");
      res.status(500).json({ error: "External purchase product list failed" });
    }
  },
);

topmartExternalPurchaseRouter.get(
  "/topmart/external-purchases",
  async (req, res): Promise<void> => {
    try {
      if (!(await requireExternalPurchaseActor(req, res))) return;
      const from = parseHistoryDate(req.query.from, false);
      const to = parseHistoryDate(req.query.to, true);
      if (typeof from === "string" || typeof to === "string") {
        res.status(400).json({ error: typeof from === "string" ? from : to });
        return;
      }
      if (from && to && from > to) {
        res.status(400).json({ error: "From date must not be after to date" });
        return;
      }
      const supplier = typeof req.query.supplier === "string" ? req.query.supplier.trim() : "";
      const product = typeof req.query.product === "string" ? req.query.product.trim() : "";
      const reference = typeof req.query.reference === "string" ? req.query.reference.trim() : "";
      if (supplier.length > 200 || product.length > 200 || reference.length > 200) {
        res.status(400).json({ error: "Text filters may not exceed 200 characters" });
        return;
      }
      const result = await pool.query(
        `SELECT r.id, r.reference, r.product_id, r.product_name, r.supplier,
                r.quantity, r.total_weight_kg, r.total_cost, r.c03_warehouse_id,
                r.stock_movement_id, r.received_by, r.received_at,
                sm.movement_type, sm.reference AS movement_reference,
                sm.created_at AS movement_created_at
           FROM distribution.topmart_external_purchase_receipts r
           JOIN stock_movements sm ON sm.id=r.stock_movement_id
          WHERE ($1::timestamptz IS NULL OR r.received_at >= $1)
            AND ($2::timestamptz IS NULL OR r.received_at <= $2)
            AND ($3::text = '' OR r.supplier ILIKE '%' || $3 || '%')
            AND ($4::text = '' OR r.product_name ILIKE '%' || $4 || '%')
            AND ($5::text = '' OR r.reference ILIKE '%' || $5 || '%')
          ORDER BY r.received_at DESC, r.id DESC
          LIMIT 500`,
        [from, to, supplier, product, reference],
      );
      res.json(result.rows.map((row) => ({
        id: Number(row.id),
        reference: row.reference,
        productId: Number(row.product_id),
        productName: row.product_name,
        supplier: row.supplier,
        quantity: Number(row.quantity),
        totalWeightKg: String(row.total_weight_kg),
        totalCost: String(row.total_cost),
        warehouseId: Number(row.c03_warehouse_id),
        receivedBy: row.received_by,
        receivedAt: row.received_at,
        stockMovement: {
          id: Number(row.stock_movement_id),
          type: row.movement_type,
          reference: row.movement_reference,
          createdAt: row.movement_created_at,
        },
      })));
    } catch (error) {
      req.log?.error?.({ err: error }, "external purchase receipt history failed");
      res.status(500).json({ error: "External purchase receipt history failed" });
    }
  },
);

topmartExternalPurchaseRouter.post(
  "/topmart/external-purchases",
  async (req, res): Promise<void> => {
    let actor: string | null;
    try {
      actor = await requireExternalPurchaseActor(req, res);
    } catch (error) {
      req.log?.error?.({ err: error }, "external purchase authorization failed");
      res.status(500).json({ error: "External purchase authorization failed" });
      return;
    }
    if (!actor) return;
    const parsed = parseExternalPurchase(req.body);
    if (typeof parsed === "string") {
      res.status(400).json({ error: parsed });
      return;
    }
    const referenceKey = parsed.receiptReference.toLocaleLowerCase("en-US");
    const fingerprint = purchaseFingerprint(parsed);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // One transaction at a time per human receipt reference. Unlike relying
      // only on a unique violation, the loser can deterministically compare the
      // committed payload and return a replay or a conflict.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [referenceKey],
      );
      const existing = await client.query(
        `SELECT id, request_fingerprint, product_id, c03_warehouse_id,
                quantity, total_weight_kg, total_cost, received_at
           FROM distribution.topmart_external_purchase_receipts
          WHERE reference_key=$1
          FOR UPDATE`,
        [referenceKey],
      );
      if (existing.rows.length) {
        if (existing.rows[0].request_fingerprint !== fingerprint) {
          await client.query("ROLLBACK");
          res.status(409).json({ error: "Receipt reference already exists with a different payload" });
          return;
        }
        await client.query("COMMIT");
        const row = existing.rows[0];
        res.json({
          ok: true,
          replayed: true,
          receiptId: Number(row.id),
          productId: Number(row.product_id),
          warehouseId: Number(row.c03_warehouse_id),
          quantity: Number(row.quantity),
          totalWeightKg: String(row.total_weight_kg),
          totalCost: String(row.total_cost),
          receivedAt: row.received_at,
        });
        return;
      }

      const product = await client.query(
        `SELECT p.id, p.name
           FROM products p
          WHERE p.id=$1 AND p.active=TRUE AND p.in_sales=TRUE AND p.in_production=FALSE
            AND btrim(COALESCE(p.sku,'')) <> ''
            AND (SELECT COUNT(*) FROM distribution.mahsulotlar m
                  WHERE m.faol=1 AND m.sku=p.sku)=1
            AND (SELECT COUNT(*) FROM products px
                  WHERE px.active=TRUE AND px.sku=p.sku)=1
          FOR SHARE`,
        [parsed.productId],
      );
      if (!product.rows.length) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Eligible active Top Mart-only external product not found" });
        return;
      }
      // Destination is never accepted from the caller or inferred from config:
      // resolve the canonical active finished-goods C-03 on every receipt.
      const warehouse = await client.query(
        `SELECT id
           FROM warehouses
          WHERE active=TRUE
            AND UPPER(TRIM(name))='C-03'
            AND purpose='finished'
            AND COALESCE(location_type,'general') <> 'vehicle'
          FOR SHARE`,
      );
      if (warehouse.rows.length !== 1) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "Canonical active C-03 finished-goods warehouse is unavailable" });
        return;
      }
      const warehouseId = Number(warehouse.rows[0].id);
      const productName = String(product.rows[0].name);
      await client.query(
        `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type)
         VALUES ($1,$2,$3,$4,'finished')
         ON CONFLICT (warehouse_id, product) DO UPDATE SET
           quantity=inventory.quantity + EXCLUDED.quantity,
           weight_kg=inventory.weight_kg + EXCLUDED.weight_kg,
           updated_at=NOW()`,
        [warehouseId, productName, parsed.quantity, parsed.totalWeightKg],
      );
      const movement = await client.query(
        `INSERT INTO stock_movements
           (product, quantity, movement_type, to_warehouse_id, note, created_by,
            product_type, weight_kg, reference, reason)
         VALUES ($1,$2,'IN',$3,$4,$5,'finished',$6,$7,'external_purchase')
         RETURNING id`,
        [
          productName,
          parsed.quantity,
          warehouseId,
          `Tashqi xarid: ${parsed.supplier}; hujjat: ${parsed.receiptReference}; jami xarajat: ${parsed.totalCost}`,
          actor,
          parsed.totalWeightKg,
          `topmart-external:${referenceKey}`,
        ],
      );
      const receipt = await client.query(
        `INSERT INTO distribution.topmart_external_purchase_receipts
           (reference, reference_key, request_fingerprint, product_id, product_name,
            supplier, quantity, total_weight_kg, total_cost, c03_warehouse_id,
            stock_movement_id, received_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id, received_at`,
        [
          parsed.receiptReference, referenceKey, fingerprint, parsed.productId,
          productName, parsed.supplier, parsed.quantity, parsed.totalWeightKg,
          parsed.totalCost, warehouseId, movement.rows[0].id, actor,
        ],
      );
      // A new lot can cost previously uncovered external sales. Rebuild under
      // the same per-product advisory lock used by all sale-line mutations.
      await client.query(
        `SELECT distribution.rebuild_topmart_external_cost($1)`,
        [parsed.productId],
      );
      await client.query("COMMIT");
      res.status(201).json({
        ok: true,
        replayed: false,
        receiptId: Number(receipt.rows[0].id),
        productId: parsed.productId,
        warehouseId,
        quantity: parsed.quantity,
        totalWeightKg: parsed.totalWeightKg,
        totalCost: parsed.totalCost,
        receivedAt: receipt.rows[0].received_at,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      req.log?.error?.({ err: error }, "external purchase receipt failed");
      res.status(500).json({ error: "External purchase receipt failed" });
    } finally {
      client.release();
    }
  },
);

async function requireAdmin(req: Request, res: Response): Promise<boolean> {
  const result = await pool.query(
    "SELECT role FROM admin_users WHERE id=$1",
    [req.userId ?? null],
  );
  if (result.rows[0]?.role !== "admin") {
    res.status(403).json({ error: "Admin role required" });
    return false;
  }
  return true;
}

router.get("/topmart/config", async (req, res): Promise<void> => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const result = await pool.query(`
      SELECT c.customer_id, customer.name AS customer_name,
             c.central_warehouse_id, warehouse.name AS central_warehouse_name,
             c.updated_by, c.updated_at
        FROM distribution.topmart_config c
        JOIN customers customer ON customer.id=c.customer_id
        JOIN warehouses warehouse ON warehouse.id=c.central_warehouse_id
       WHERE c.id=1
    `);
    if (!result.rows.length) {
      res.json({ configured: false });
      return;
    }
    const row = result.rows[0];
    res.json({
      configured: true,
      customerId: row.customer_id,
      customerName: row.customer_name,
      centralWarehouseId: row.central_warehouse_id,
      centralWarehouseName: row.central_warehouse_name,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    });
  } catch (error) {
    req.log?.error?.({ err: error }, "topmart config read failed");
    res.status(500).json({ error: "Top Mart config read failed" });
  }
});

router.put("/topmart/config", async (req, res): Promise<void> => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const customerId = Number(req.body?.customerId);
    const centralWarehouseId = Number(req.body?.centralWarehouseId);
    if (!Number.isSafeInteger(customerId) || customerId <= 0 ||
        !Number.isSafeInteger(centralWarehouseId) || centralWarehouseId <= 0) {
      res.status(400).json({ error: "Valid customerId and centralWarehouseId are required" });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const customer = await client.query(
        `SELECT id, name FROM customers
          WHERE id=$1
            AND deleted_at IS NULL
            AND UPPER(REPLACE(REPLACE(TRIM(name), ' ', ''), '-', ''))='TOPMART'
          FOR SHARE`,
        [customerId],
      );
      const warehouse = await client.query(
        `SELECT id, name FROM warehouses
          WHERE id=$1 AND active=TRUE
            AND COALESCE(location_type,'general') <> 'vehicle'
            AND purpose='finished'
            AND UPPER(TRIM(name))='C-03'
          FOR SHARE`,
        [centralWarehouseId],
      );
      if (!customer.rows.length) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Active canonical Top Mart customer not found" });
        return;
      }
      if (!warehouse.rows.length) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Active C-03 finished-goods warehouse not found" });
        return;
      }
      await client.query(
        `INSERT INTO distribution.topmart_config
           (id, customer_id, central_warehouse_id, updated_by, updated_at)
         VALUES (1,$1,$2,$3,NOW())
         ON CONFLICT (id) DO UPDATE SET
           customer_id=EXCLUDED.customer_id,
           central_warehouse_id=EXCLUDED.central_warehouse_id,
           updated_by=EXCLUDED.updated_by,
           updated_at=NOW()`,
        [customerId, centralWarehouseId, req.userId],
      );
      await client.query("COMMIT");
      req.log?.info?.({ customerId, centralWarehouseId }, "topmart config updated");
      res.json({
        configured: true,
        customerId,
        customerName: customer.rows[0].name,
        centralWarehouseId,
        centralWarehouseName: warehouse.rows[0].name,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    req.log?.error?.({ err: error }, "topmart config update failed");
    res.status(500).json({ error: "Top Mart config update failed" });
  }
});

router.get("/topmart/overview", async (req, res): Promise<void> => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const config = await pool.query(
      `SELECT c.customer_id, cu.name customer_name, c.central_warehouse_id,
              w.name warehouse_name
         FROM distribution.topmart_config c
         JOIN customers cu ON cu.id=c.customer_id
         JOIN warehouses w ON w.id=c.central_warehouse_id
        WHERE c.id=1`,
    );
    if (!config.rows.length) {
      res.status(409).json({ error: "Top Mart is not configured", configured: false });
      return;
    }
    const c = config.rows[0];
    const [inventory, sales, c3Totals, vehicleTotals, loadableItems, externalProfit] = await Promise.all([
      pool.query(
        `SELECT product, quantity, weight_kg, product_type, updated_at
           FROM inventory WHERE warehouse_id=$1 ORDER BY product`,
        [c.central_warehouse_id],
      ),
      pool.query(
        `SELECT COALESCE(currency,'UZS') currency,
                COUNT(*)::int sale_count,
                COALESCE(SUM(total_amount),0) total_amount,
                COALESCE(SUM(paid_amount),0) paid_amount,
                COALESCE(SUM(debt_amount),0) debt_amount,
                MAX(created_at) last_sale_at
           FROM sales
          WHERE customer_id=$1 AND topmart_warehouse_id=$2
          GROUP BY COALESCE(currency,'UZS')
          ORDER BY COALESCE(currency,'UZS')`,
        [c.customer_id, c.central_warehouse_id],
      ),
      pool.query(
        `SELECT COALESCE(SUM(quantity),0) total_quantity,
                COALESCE(SUM(weight_kg),0) total_weight_kg
           FROM inventory
          WHERE warehouse_id=$1`,
        [c.central_warehouse_id],
      ),
      pool.query(
        `SELECT COALESCE(SUM(i.quantity),0) total_quantity,
                COALESCE(SUM(i.weight_kg),0) total_weight_kg
           FROM inventory i
           JOIN warehouses w ON w.id=i.warehouse_id
          WHERE COALESCE(w.location_type,'general')='vehicle'`,
      ),
      // Machine loading must use an unambiguous catalog identity. Product-name
      // joins are exact and a SKU is usable only when precisely one active
      // distribution catalog entry owns it; missing/duplicate mappings are
      // deliberately excluded rather than guessed.
      pool.query(
        `WITH unique_active_distribution_skus AS (
           SELECT sku
             FROM distribution.mahsulotlar
            WHERE faol=1 AND btrim(COALESCE(sku,'')) <> ''
            GROUP BY sku
           HAVING COUNT(*)=1
         )
         SELECT d.id AS mahsulot_id, p.id AS public_product_id,
                i.product AS product_name, p.sku,
                TRUNC(i.quantity)::integer AS available_quantity,
                i.weight_kg AS available_weight_kg,
                p.pieces_per_box
           FROM inventory i
           JOIN products p
             ON p.name=i.product
            AND p.active=TRUE
            AND btrim(COALESCE(p.sku,'')) <> ''
           JOIN unique_active_distribution_skus u ON u.sku=p.sku
           JOIN distribution.mahsulotlar d
             ON d.sku=u.sku AND d.faol=1
          WHERE i.warehouse_id=$1
            AND (i.quantity > 0 OR i.weight_kg > 0)
          ORDER BY i.product, d.id`,
        [c.central_warehouse_id],
      ),
      pool.query(`
        WITH external_lines AS (
          SELECT st.id, st.miqdor::numeric AS sold_quantity, st.summa::numeric AS revenue,
                 p.id product_id, p.name product_name, m.birlik,
                 COALESCE(SUM(a.allocated_quantity),0) costed_quantity,
                 COALESCE(SUM(a.allocated_cost),0) cogs
            FROM distribution.savdo_tafsilot st
            JOIN distribution.savdolar s ON s.id=st.savdo_id
            JOIN distribution.mahsulotlar m ON m.id=st.mahsulot_id
            JOIN products p ON p.sku=m.sku AND p.active=TRUE
             AND p.in_sales=TRUE AND p.in_production=FALSE
            LEFT JOIN distribution.topmart_external_cost_allocations a
              ON a.savdo_tafsilot_id=st.id
           WHERE COALESCE(s.status,'active') <> 'cancelled'
             AND m.faol=1
             AND (SELECT COUNT(*) FROM products px WHERE px.sku=m.sku AND px.active=TRUE)=1
             AND (SELECT COUNT(*) FROM distribution.mahsulotlar mx
                   WHERE mx.sku=m.sku AND mx.faol=1)=1
           GROUP BY st.id,st.miqdor,st.summa,p.id,p.name,m.birlik
        )
        SELECT product_id,product_name,birlik,
               SUM(sold_quantity) sold_quantity,
               SUM(costed_quantity) costed_quantity,
               SUM(revenue) revenue,
               SUM(CASE WHEN sold_quantity>0
                        THEN revenue*costed_quantity/sold_quantity ELSE 0 END) costed_revenue,
               SUM(cogs) cogs,
               SUM(CASE WHEN sold_quantity>0
                        THEN revenue*costed_quantity/sold_quantity ELSE 0 END)-SUM(cogs) profit
          FROM external_lines
         GROUP BY product_id,product_name,birlik
         ORDER BY product_name,product_id
      `),
    ]);
    const c3StockTotalQty = Number(c3Totals.rows[0].total_quantity);
    const c3StockTotalKg = Number(c3Totals.rows[0].total_weight_kg);
    const vehicleStockTotalQty = Number(vehicleTotals.rows[0].total_quantity);
    const vehicleStockTotalKg = Number(vehicleTotals.rows[0].total_weight_kg);
    const flowStatus =
      c3StockTotalQty > 0 || c3StockTotalKg > 0
        ? `C-3 markaziy omborida zaxira bor; mashinalarda ${vehicleStockTotalQty} dona va ${vehicleStockTotalKg.toFixed(3)} kg.`
        : vehicleStockTotalQty > 0 || vehicleStockTotalKg > 0
          ? "C-3 zaxirasi bo'sh, mahsulot mashinalarda tarqatishda."
          : "C-3 va mashinalarda hozircha zaxira yo'q.";
    const saleRows = sales.rows.map((row) => ({
      currency: String(row.currency).toUpperCase(),
      count: Number(row.sale_count),
      totalAmount: Number(row.total_amount),
      paidAmount: Number(row.paid_amount),
      debtAmount: Number(row.debt_amount),
      lastSaleAt: row.last_sale_at instanceof Date
        ? row.last_sale_at.toISOString()
        : row.last_sale_at == null ? null : String(row.last_sale_at),
    }));
    const saleCount = saleRows.reduce((sum, row) => sum + row.count, 0);
    const lastSaleAt = saleRows.reduce<string | null>(
      (latest, row) => row.lastSaleAt != null && (latest == null || row.lastSaleAt > latest)
        ? row.lastSaleAt
        : latest,
      null,
    );
    const externalProfitRows = externalProfit.rows.map((row) => ({
      productId: Number(row.product_id),
      productName: String(row.product_name),
      unit: String(row.birlik || "dona"),
      soldQuantity: Number(row.sold_quantity),
      costedQuantity: Number(row.costed_quantity),
      uncostedQuantity: Math.max(0, Number(row.sold_quantity) - Number(row.costed_quantity)),
      revenue: Number(row.revenue),
      costedRevenue: Number(row.costed_revenue),
      uncostedRevenue: Math.max(0, Number(row.revenue) - Number(row.costed_revenue)),
      cogs: Number(row.cogs),
      profit: Number(row.profit),
    }));
    res.json({
      configured: true,
      customerId: c.customer_id,
      customerName: c.customer_name,
      centralWarehouseId: c.central_warehouse_id,
      centralWarehouseName: c.warehouse_name,
      c3StockTotalKg,
      c3StockTotalQty,
      vehicleStockTotalKg,
      vehicleStockTotalQty,
      flowStatus,
      loadableItems: loadableItems.rows.map((row) => ({
        mahsulotId: Number(row.mahsulot_id),
        publicProductId: Number(row.public_product_id),
        productName: row.product_name,
        sku: row.sku,
        availableQuantity: Number(row.available_quantity),
        availableWeightKg: Number(row.available_weight_kg),
        piecesPerBox: Number(row.pieces_per_box),
      })),
      inventory: inventory.rows.map((row) => ({
        product: row.product,
        quantity: Number(row.quantity),
        weightKg: Number(row.weight_kg),
        productType: row.product_type,
        updatedAt: row.updated_at,
      })),
      sales: {
        count: saleCount,
        lastSaleAt,
        byCurrency: saleRows.map(({ lastSaleAt: _lastSaleAt, ...row }) => row),
      },
      externalProfit: {
        method: "FIFO",
        currency: "UZS",
        revenue: externalProfitRows.reduce((sum, row) => sum + row.revenue, 0),
        costedRevenue: externalProfitRows.reduce((sum, row) => sum + row.costedRevenue, 0),
        uncostedRevenue: externalProfitRows.reduce((sum, row) => sum + row.uncostedRevenue, 0),
        cogs: externalProfitRows.reduce((sum, row) => sum + row.cogs, 0),
        profit: externalProfitRows.reduce((sum, row) => sum + row.profit, 0),
        products: externalProfitRows,
      },
    });
  } catch (error) {
    req.log?.error?.({ err: error }, "topmart overview failed");
    res.status(500).json({ error: "Top Mart overview failed" });
  }
});

export default router;