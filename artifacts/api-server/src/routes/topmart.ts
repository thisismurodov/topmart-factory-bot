import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

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
        "SELECT id, name FROM customers WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
        [customerId],
      );
      const warehouse = await client.query(
        `SELECT id, name FROM warehouses
          WHERE id=$1 AND active=TRUE
            AND COALESCE(location_type,'general') <> 'vehicle'
            AND purpose='finished'
          FOR SHARE`,
        [centralWarehouseId],
      );
      if (!customer.rows.length) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Customer not found" });
        return;
      }
      if (!warehouse.rows.length) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Active non-vehicle finished-goods warehouse not found" });
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
    const [inventory, sales, c3Totals, vehicleTotals, loadableItems] = await Promise.all([
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
    });
  } catch (error) {
    req.log?.error?.({ err: error }, "topmart overview failed");
    res.status(500).json({ error: "Top Mart overview failed" });
  }
});

export default router;