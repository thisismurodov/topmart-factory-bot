import { pgTable, serial, text, numeric, boolean, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const rawMaterialsTable = pgTable("raw_materials", {
  id:           serial("id").primaryKey(),
  name:         text("name").notNull().unique(),
  unit:         text("unit").notNull().default("kg"),
  unitType:     text("unit_type").notNull().default("kg"),
  defaultCost:  numeric("default_cost", { precision: 12, scale: 2 }).notNull().default("0"),
  currency:     text("currency").notNull().default("UZS"),
  currentStock: numeric("current_stock", { precision: 12, scale: 3 }).notNull().default("0"),
  minimumStock: numeric("minimum_stock", { precision: 12, scale: 3 }).notNull().default("0"),
  active:       boolean("active").notNull().default(true),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Runtime DDL (bot init_db) bilan bir xil CHECK
  check("raw_materials_currency_check", sql`currency IN ('UZS','USD')`),
]);

export const insertRawMaterialSchema = createInsertSchema(rawMaterialsTable);
export type InsertRawMaterial = z.infer<typeof insertRawMaterialSchema>;
export type RawMaterial = typeof rawMaterialsTable.$inferSelect;
