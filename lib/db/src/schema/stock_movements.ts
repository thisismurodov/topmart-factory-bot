import { pgTable, serial, text, integer, numeric, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { warehousesTable } from "./warehouses";

// Ombor harakatlari (stock movement ledger). The runtime table is created
// idempotently in the bot init_db / API initDb (Railway DB is bot-owned, not
// drizzle-push managed); this schema exists only to give the API typed access —
// never relied on for migrations.
export const stockMovementsTable = pgTable("stock_movements", {
  id: serial("id").primaryKey(),
  product: text("product").notNull(),
  quantity: numeric("quantity").notNull().default("0"),
  movementType: text("movement_type").notNull(),
  fromWarehouseId: integer("from_warehouse_id").references(() => warehousesTable.id),
  toWarehouseId: integer("to_warehouse_id").references(() => warehousesTable.id),
  note: text("note").notNull().default(""),
  createdBy: text("created_by").notNull().default(""),
  productType: text("product_type").notNull().default("finished"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Drift-tuzatish (2026-08-15, egasi buyrug'i): jonli bazadagi
  // stock_movements_movement_type_check azaldan bor edi, lekin kanonik
  // manbalar (bot init_db / API initDb / ushbu sxema) uni yaratmasdi.
  // Endi UCHALA manba bir xil CHECK'ni e'lon qiladi — schema-drift buni qo'riqlaydi.
  check("stock_movements_movement_type_check", sql`${table.movementType} IN ('IN', 'OUT', 'TRANSFER')`),
]);

export const insertStockMovementSchema = createInsertSchema(stockMovementsTable).omit({ id: true, createdAt: true });
export type InsertStockMovement = z.infer<typeof insertStockMovementSchema>;
export type StockMovement = typeof stockMovementsTable.$inferSelect;
