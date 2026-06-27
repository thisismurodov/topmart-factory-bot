import { pgTable, serial, text, integer, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// "Ish jarayoni" (Material Flow / WIP) ledger. Department WIP balance =
// SUM(RECEIVE) − SUM(PRODUCE). The runtime table is created idempotently in the
// bot init_db / API initDb (Railway DB is bot-owned, not drizzle-push managed);
// this schema exists only to give the API typed access — never relied on for
// migrations.
export const wipMovementsTable = pgTable("wip_movements", {
  id: serial("id").primaryKey(),
  lineId: integer("line_id"),
  movementType: text("movement_type").notNull(), // 'RECEIVE' | 'PRODUCE'
  rawMaterial: text("raw_material"),
  product: text("product"),
  weightKg: numeric("weight_kg", { precision: 12, scale: 3 }).notNull().default("0"),
  fromWarehouseId: integer("from_warehouse_id"),
  batchId: integer("batch_id"),
  note: text("note"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertWipMovementSchema = createInsertSchema(wipMovementsTable).omit({ id: true, createdAt: true });
export type InsertWipMovement = z.infer<typeof insertWipMovementSchema>;
export type WipMovement = typeof wipMovementsTable.$inferSelect;
