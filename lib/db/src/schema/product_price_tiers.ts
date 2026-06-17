import { pgTable, serial, integer, numeric, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { productsTable } from "./products";

export const productPriceTiersTable = pgTable("product_price_tiers", {
  id:          serial("id").primaryKey(),
  productId:   integer("product_id")
    .notNull()
    .references(() => productsTable.id, { onDelete: "cascade" }),
  minQuantity: numeric("min_quantity", { precision: 12, scale: 3 }).notNull().default("0"),
  maxQuantity: numeric("max_quantity", { precision: 12, scale: 3 }).notNull().default("0"),
  price:       numeric("price", { precision: 12, scale: 2 }).notNull().default("0"),
  currency:    text("currency").notNull().default("UZS"),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertProductPriceTierSchema = createInsertSchema(productPriceTiersTable);
export type InsertProductPriceTier = z.infer<typeof insertProductPriceTierSchema>;
export type ProductPriceTier = typeof productPriceTiersTable.$inferSelect;
