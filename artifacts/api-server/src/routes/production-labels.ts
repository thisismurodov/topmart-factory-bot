import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  GetProductionLabelParams,
  GetProductionLabelResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

router.get("/production-labels/:barcode", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.barcode)
    ? req.params.barcode[0]
    : req.params.barcode;
  const parsed = GetProductionLabelParams.safeParse({
    barcode: String(raw ?? "").trim().toUpperCase(),
  });
  if (!parsed.success) {
    res.status(400).json({ error: "Barcode formati noto'g'ri" });
    return;
  }

  const result = await pool.query(
    `SELECT barcode_value, batch_id, batch_code, label_type,
            label_number, total_labels, pieces_in_label, pieces_per_box,
            quantity_total, weight_kg, length_m, product_name, product_sku,
            worker_name, produced_at, warehouse_id, warehouse_name, status,
            print_count, last_printed_at
       FROM production_labels
      WHERE barcode_value=$1`,
    [parsed.data.barcode],
  );
  const row = result.rows[0];
  if (!row) {
    res.status(404).json({ error: "Etiketka topilmadi" });
    return;
  }

  res.json(GetProductionLabelResponse.parse({
    barcode: row.barcode_value,
    batchId: row.batch_id === null ? null : Number(row.batch_id),
    batchCode: row.batch_code,
    labelType: row.label_type,
    labelNumber: Number(row.label_number),
    totalLabels: Number(row.total_labels),
    piecesInLabel: Number(row.pieces_in_label),
    piecesPerBox: Number(row.pieces_per_box),
    quantityTotal: Number(row.quantity_total),
    weightKg: Number(row.weight_kg),
    lengthM: row.length_m === null ? null : Number(row.length_m),
    productName: row.product_name,
    productSku: row.product_sku,
    workerName: row.worker_name,
    producedAt: iso(row.produced_at),
    warehouseId: row.warehouse_id === null ? null : Number(row.warehouse_id),
    warehouseName: row.warehouse_name,
    status: row.status,
    printCount: Number(row.print_count),
    lastPrintedAt: row.last_printed_at === null ? null : iso(row.last_printed_at),
  }));
});

export default router;