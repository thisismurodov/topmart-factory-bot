import { pgTable, serial, text, integer, numeric, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { warehousesTable } from "./warehouses";

// Ombor zahirasi (per-warehouse stock line). The runtime table is created
// idempotently in the bot init_db / API initDb (Railway DB is bot-owned, not
// drizzle-push managed); this schema exists only to give the API typed access —
// never relied on for migrations.
export const inventoryTable = pgTable(
  "inventory",
  {
    id: serial("id").primaryKey(),
    warehouseId: integer("warehouse_id").notNull().references(() => warehousesTable.id),
    product: text("product").notNull(),
    quantity: numeric("quantity").notNull().default("0"),
    weightKg: numeric("weight_kg").notNull().default("0"),
    productType: text("product_type").notNull().default("finished"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.warehouseId, t.product)],
);

export const insertInventorySchema = createInsertSchema(inventoryTable).omit({ id: true, updatedAt: true });
export type InsertInventory = z.infer<typeof insertInventorySchema>;
export type Inventory = typeof inventoryTable.$inferSelect;
