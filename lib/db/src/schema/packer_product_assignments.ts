import { pgTable, serial, text, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const packerProductAssignmentsTable = pgTable("packer_product_assignments", {
  id:          serial("id").primaryKey(),
  packerName:  text("packer_name").notNull(),
  productName: text("product_name").notNull(),
}, (t) => [unique().on(t.packerName, t.productName)]);

export const insertPackerProductAssignmentSchema = createInsertSchema(packerProductAssignmentsTable);
export type InsertPackerProductAssignment = z.infer<typeof insertPackerProductAssignmentSchema>;
export type PackerProductAssignment = typeof packerProductAssignmentsTable.$inferSelect;
