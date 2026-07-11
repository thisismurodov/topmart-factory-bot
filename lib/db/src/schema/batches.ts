import { pgTable, serial, text, integer, numeric, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const batchesTable = pgTable("batches", {
  id: serial("id").primaryKey(),
  batchCode: text("batch_code").notNull(),
  worker: text("worker").notNull(),
  product: text("product").notNull(),
  quantity: integer("quantity").notNull(),
  weightKg: numeric("weight_kg", { precision: 10, scale: 3 }).notNull().default("0"),
  earnings: numeric("earnings", { precision: 12, scale: 2 }).notNull().default("0"),
  payrollMethod: text("payroll_method").notNull().default("PRODUCT_RATE"),
  productionLineId: integer("production_line_id"),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertBatchSchema = createInsertSchema(batchesTable).omit({ id: true, createdAt: true });
export type InsertBatch = z.infer<typeof insertBatchSchema>;
export type Batch = typeof batchesTable.$inferSelect;
