import { pgTable, serial, text, boolean, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Ombor (warehouse / container) registry. The runtime table is created
// idempotently in the bot init_db / API initDb (Railway DB is bot-owned, not
// drizzle-push managed); this schema exists only to give the API typed access —
// never relied on for migrations.
export const warehousesTable = pgTable("warehouses", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  active: boolean("active").notNull().default(true),
  locationType: text("location_type").notNull().default("general"),
  capacityKg: numeric("capacity_kg").default("20000"),
  purpose: text("purpose").notNull().default("finished"),
});

export const insertWarehouseSchema = createInsertSchema(warehousesTable).omit({ id: true });
export type InsertWarehouse = z.infer<typeof insertWarehouseSchema>;
export type Warehouse = typeof warehousesTable.$inferSelect;
