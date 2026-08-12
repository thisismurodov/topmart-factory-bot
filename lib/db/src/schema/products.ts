import { pgTable, text, numeric, serial, boolean, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const productsTable = pgTable("products", {
  id:                serial("id").unique().notNull(),
  name:              text("name").primaryKey(),
  rateType:          text("rate_type").notNull().default("dona"),
  rate:              numeric("rate", { precision: 12, scale: 2 }).notNull().default("100"),
  sku:               text("sku").notNull().default(""),
  unitType:          text("unit_type").notNull().default("dona"),
  currencyType:      text("currency_type").notNull().default("UZS"),
  defaultSalePrice:  numeric("default_sale_price", { precision: 12, scale: 2 }).notNull().default("0"),
  weight:            numeric("weight", { precision: 12, scale: 3 }).notNull().default("1"),
  salaryCost:        numeric("salary_cost", { precision: 12, scale: 2 }).notNull().default("0"),
  electricityCost:   numeric("electricity_cost", { precision: 12, scale: 2 }).notNull().default("0"),
  otherCost:         numeric("other_cost", { precision: 12, scale: 2 }).notNull().default("0"),
  minimumStock:      integer("minimum_stock").notNull().default(0),
  piecesPerBox:      integer("pieces_per_box").notNull().default(1),
  payrollMethod:     text("payroll_method").notNull().default("PRODUCT_RATE"),
  // Bitta mahsulot bazasi (master katalog) modullari: savdo / ishlab chiqarish
  inSales:           boolean("in_sales").notNull().default(false),
  inProduction:      boolean("in_production").notNull().default(true),
  active:            boolean("active").notNull().default(true),
  lineId:            integer("line_id"),
  createdAt:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Bo'sh bo'lmagan SKU'lar unikal — yagona katalog invarianti
  uniqueIndex("idx_products_sku_unique").on(t.sku).where(sql`sku <> ''`),
]);

export const insertProductSchema = createInsertSchema(productsTable);
export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Product = typeof productsTable.$inferSelect;
