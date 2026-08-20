import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { batchesTable } from "./batches";
import { warehousesTable } from "./warehouses";

export const productionLabelsTable = pgTable("production_labels", {
  id: serial("id").primaryKey(),
  barcodeValue: text("barcode_value").notNull(),
  batchId: integer("batch_id")
    .references(() => batchesTable.id, { onDelete: "set null" }),
  batchCode: text("batch_code").notNull(),
  labelType: text("label_type").notNull().default("unit"),
  labelNumber: integer("label_number").notNull(),
  totalLabels: integer("total_labels").notNull(),
  piecesInLabel: integer("pieces_in_label").notNull().default(1),
  piecesPerBox: integer("pieces_per_box").notNull().default(1),
  quantityTotal: integer("quantity_total").notNull(),
  weightKg: numeric("weight_kg", { precision: 12, scale: 3 }).notNull().default("0"),
  lengthM: numeric("length_m", { precision: 12, scale: 2 }),
  productName: text("product_name").notNull(),
  productSku: text("product_sku").notNull().default(""),
  workerName: text("worker_name").notNull(),
  producedAt: timestamp("produced_at", { withTimezone: true }).notNull(),
  warehouseId: integer("warehouse_id")
    .references(() => warehousesTable.id, { onDelete: "set null" }),
  warehouseName: text("warehouse_name").notNull().default(""),
  status: text("status").notNull().default("created"),
  printCount: integer("print_count").notNull().default(0),
  lastPrintedAt: timestamp("last_printed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_production_labels_barcode").on(t.barcodeValue),
  uniqueIndex("uq_production_labels_batch_number").on(t.batchId, t.labelNumber),
  index("idx_production_labels_batch_code").on(t.batchCode),
  index("idx_production_labels_product").on(t.productName),
  // F4: one label_number per VH-<handoffId> batch when batch_id is NULL.
  uniqueIndex("uq_production_labels_vh_batch_number")
    .on(t.batchCode, t.labelNumber)
    .where(sql`${t.batchId} IS NULL AND ${t.batchCode} LIKE 'VH-%'`),
  check("production_labels_barcode_check", sql`${t.barcodeValue} ~ '^TM[A-Z2-7]{16}$'`),
  check(
    "production_labels_number_check",
    sql`${t.labelNumber} > 0 AND ${t.totalLabels} >= ${t.labelNumber}`,
  ),
  check("production_labels_pieces_check", sql`${t.piecesInLabel} > 0`),
  check("production_labels_box_capacity_check", sql`${t.piecesPerBox} > 0`),
  check("production_labels_quantity_check", sql`${t.quantityTotal} > 0`),
  check("production_labels_weight_check", sql`${t.weightKg} >= 0`),
  check(
    "production_labels_length_check",
    sql`${t.lengthM} IS NULL OR ${t.lengthM} >= 0`,
  ),
  check("production_labels_type_check", sql`${t.labelType} IN ('unit','box')`),
  check(
    "production_labels_status_check",
    sql`${t.status} IN ('created','printed','void')`,
  ),
  check("production_labels_print_count_check", sql`${t.printCount} >= 0`),
]);

export const insertProductionLabelSchema = createInsertSchema(productionLabelsTable)
  .omit({ id: true, createdAt: true });
export type InsertProductionLabel = z.infer<typeof insertProductionLabelSchema>;
export type ProductionLabel = typeof productionLabelsTable.$inferSelect;