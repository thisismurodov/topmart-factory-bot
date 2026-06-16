import { pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const productionLinesTable = pgTable(
  "production_lines",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("production_lines_name_uniq").on(t.name)]
);

export const insertProductionLineSchema = createInsertSchema(productionLinesTable).omit({ id: true, createdAt: true });
export type InsertProductionLine = z.infer<typeof insertProductionLineSchema>;
export type ProductionLine = typeof productionLinesTable.$inferSelect;
