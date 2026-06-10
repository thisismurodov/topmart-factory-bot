import { pgTable, serial, text, integer, numeric, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const productMaterialsTable = pgTable("product_materials", {
  id:               serial("id").primaryKey(),
  productName:      text("product_name").notNull(),
  rawMaterialId:    integer("raw_material_id").notNull(),
  quantityRequired: numeric("quantity_required", { precision: 12, scale: 3 }).notNull(),
}, (t) => [unique().on(t.productName, t.rawMaterialId)]);

export const insertProductMaterialSchema = createInsertSchema(productMaterialsTable);
export type InsertProductMaterial = z.infer<typeof insertProductMaterialSchema>;
export type ProductMaterial = typeof productMaterialsTable.$inferSelect;
