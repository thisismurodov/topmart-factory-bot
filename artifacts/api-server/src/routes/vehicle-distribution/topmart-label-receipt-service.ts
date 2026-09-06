import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  HandoffConflictError,
  HandoffNotFoundError,
  type HandoffActor,
} from "./handoff-service";

export type TopmartLabelReceiptResult = {
  saleId: number;
  centralWarehouseId: number;
  barcodes: string[];
  receivedAt: string;
  replayed: boolean;
};

const fingerprintFor = (
  saleId: number,
  warehouseId: number,
  barcodes: readonly string[],
): string =>
  createHash("sha256")
    .update(JSON.stringify({ saleId, warehouseId, barcodes: [...barcodes].sort() }))
    .digest("hex");

export async function registerTopmartLabelReceiptInTx(
  client: PoolClient,
  saleId: number,
  scannedBarcodes: string[],
  actor: HandoffActor,
): Promise<TopmartLabelReceiptResult> {
  if (actor.type !== "admin") {
    throw new HandoffConflictError("Admin role required");
  }
  if (!scannedBarcodes.length || new Set(scannedBarcodes).size !== scannedBarcodes.length) {
    throw new HandoffConflictError(
      "Receipt barcode list must be non-empty and contain no duplicates",
    );
  }

  const saleResult = await client.query(
    `SELECT id, topmart_warehouse_id
       FROM public.sales WHERE id=$1 FOR UPDATE`,
    [saleId],
  );
  if (!saleResult.rows.length) {
    throw new HandoffNotFoundError("Credited Top Mart sale not found");
  }
  if (saleResult.rows[0].topmart_warehouse_id == null) {
    throw new HandoffConflictError(
      "Sale is not a credited Top Mart sale",
    );
  }
  // The destination captured atomically on the credited sale is immutable
  // receipt authority. Today's singleton configuration may have moved on.
  const warehouseId = Number(saleResult.rows[0].topmart_warehouse_id);

  const fingerprint = fingerprintFor(saleId, warehouseId, scannedBarcodes);
  const existing = await client.query(
    `SELECT barcode, receipt_fingerprint, received_at
       FROM distribution.topmart_label_receipts
      WHERE sale_id=$1 ORDER BY barcode FOR SHARE`,
    [saleId],
  );
  if (existing.rows.length) {
    const existingBarcodes = existing.rows.map((row) => String(row.barcode));
    const requested = [...scannedBarcodes].sort();
    if (
      existing.rows.every((row) => String(row.receipt_fingerprint) === fingerprint)
      && existingBarcodes.length === requested.length
      && existingBarcodes.every((barcode, index) => barcode === requested[index])
    ) {
      return {
        saleId,
        centralWarehouseId: warehouseId,
        barcodes: requested,
        receivedAt: new Date(existing.rows[0].received_at).toISOString(),
        replayed: true,
      };
    }
    throw new HandoffConflictError(
      "This Top Mart sale already has a different immutable barcode receipt set",
    );
  }

  const saleItems = await client.query(
    `SELECT id, product_name, sale_type, quantity
       FROM public.sale_items
      WHERE sale_id=$1
      ORDER BY id`,
    [saleId],
  );
  if (
    !saleItems.rows.some(
      (item) => String(item.sale_type).trim().toLowerCase() === "dona",
    )
  ) {
    throw new HandoffConflictError("Sale has no dona items to receive");
  }

  const expected = new Map<string, { pieces: number; weightKg: number }>();
  for (let index = 0; index < saleItems.rows.length; index += 1) {
    const item = saleItems.rows[index]!;
    if (String(item.sale_type).trim().toLowerCase() !== "dona") continue;
    const products = await client.query(
      `SELECT sku FROM public.products
        WHERE name=$1 AND active=TRUE ORDER BY id FOR SHARE`,
      [String(item.product_name)],
    );
    if (products.rows.length !== 1 || !String(products.rows[0].sku).trim()) {
      throw new HandoffConflictError(
        `Sale item ${item.id} does not resolve to exactly one authoritative product SKU`,
      );
    }
    const sku = String(products.rows[0].sku);
    const credit = await client.query(
      `SELECT quantity, weight_kg
         FROM public.stock_movements
        WHERE reference=$1
          AND movement_type='IN'
          AND to_warehouse_id=$2
          AND product=$3
        FOR SHARE`,
      [`topmart-sale:${saleId}:${index + 1}:in`, warehouseId, String(item.product_name)],
    );
    if (credit.rows.length !== 1) {
      throw new HandoffConflictError(
        `Sale item ${item.id} has no exact immutable Top Mart credit movement`,
      );
    }
    const quantity = Number(credit.rows[0].quantity);
    const creditedWeightKg = Number(credit.rows[0].weight_kg);
    if (
      !Number.isSafeInteger(quantity)
      || quantity <= 0
      || quantity !== Number(item.quantity)
      || !(creditedWeightKg > 0)
    ) {
      throw new HandoffConflictError(
        `Sale item ${item.id} has invalid credited dona quantity or weight`,
      );
    }
    const aggregate = expected.get(sku) ?? { pieces: 0, weightKg: 0 };
    aggregate.pieces += quantity;
    aggregate.weightKg += creditedWeightKg;
    expected.set(sku, aggregate);
  }

  const labelsResult = await client.query(
    `SELECT id, barcode_value, batch_id, status, print_count,
            product_sku, pieces_in_label, weight_kg
       FROM public.production_labels
      WHERE barcode_value=ANY($1::text[])
      ORDER BY id FOR UPDATE`,
    [scannedBarcodes],
  );
  if (labelsResult.rows.length !== scannedBarcodes.length) {
    throw new HandoffConflictError(
      "Every received barcode must identify an existing production label",
    );
  }
  const labelsByBarcode = new Map(
    labelsResult.rows.map((row) => [String(row.barcode_value), row]),
  );
  const labels = scannedBarcodes.map((barcode) => labelsByBarcode.get(barcode)!);
  for (const label of labels) {
    if (
      label.batch_id == null
      || String(label.status) !== "printed"
      || Number(label.print_count) <= 0
      || !Number.isSafeInteger(Number(label.pieces_in_label))
      || Number(label.pieces_in_label) <= 0
      || !(Number(label.weight_kg) > 0)
    ) {
      throw new HandoffConflictError(
        `Production label ${label.barcode_value} must be a printed, non-void batch label with positive pieces and weight`,
      );
    }
  }

  const prior = await client.query(
    `SELECT barcode FROM distribution.topmart_label_receipts
      WHERE production_label_id=ANY($1::int[]) OR barcode=ANY($2::text[])
      ORDER BY id FOR SHARE`,
    [labels.map((label) => Number(label.id)), scannedBarcodes],
  );
  if (prior.rows.length) {
    throw new HandoffConflictError(
      `Production label ${prior.rows[0].barcode} already has immutable receipt provenance`,
    );
  }

  const actual = new Map<string, { pieces: number; weightKg: number }>();
  for (const label of labels) {
    const sku = String(label.product_sku);
    const aggregate = actual.get(sku) ?? { pieces: 0, weightKg: 0 };
    aggregate.pieces += Number(label.pieces_in_label);
    aggregate.weightKg += Number(label.weight_kg);
    actual.set(sku, aggregate);
  }
  if (actual.size !== expected.size) {
    throw new HandoffConflictError("Received labels do not exactly cover sale SKUs");
  }
  for (const [sku, needed] of expected) {
    const got = actual.get(sku);
    if (
      !got
      || got.pieces !== needed.pieces
      || Math.abs(got.weightKg - needed.weightKg) > 0.001
    ) {
      throw new HandoffConflictError(
        `Received labels do not exactly cover sale SKU ${sku} pieces and weight`,
      );
    }
  }

  let receivedAt = "";
  for (const label of labels) {
    const inserted = await client.query(
      `INSERT INTO distribution.topmart_label_receipts
         (production_label_id, barcode, sale_id, central_warehouse_id,
          product_sku, pieces_in_label, weight_kg, receipt_fingerprint, received_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING received_at`,
      [
        Number(label.id),
        String(label.barcode_value),
        saleId,
        warehouseId,
        String(label.product_sku),
        Number(label.pieces_in_label),
        Number(label.weight_kg),
        fingerprint,
        actor.actorId,
      ],
    );
    receivedAt ||= new Date(inserted.rows[0].received_at).toISOString();
  }
  return {
    saleId,
    centralWarehouseId: warehouseId,
    barcodes: [...scannedBarcodes].sort(),
    receivedAt,
    replayed: false,
  };
}