import { pgTable, serial, text, integer, numeric, date, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const salaryEntriesTable = pgTable("salary_entries", {
  id: serial("id").primaryKey(),
  scope: text("scope").notNull().default("arqon"),
  lineId: integer("line_id"),
  worker: text("worker").notNull(),
  role: text("role").notNull(),
  sourceType: text("source_type").notNull(),
  batchId: integer("batch_id"),
  workDate: date("work_date").notNull(),
  kg: numeric("kg", { precision: 12, scale: 3 }).notNull().default("0"),
  rate: numeric("rate", { precision: 12, scale: 2 }).notNull().default("0"),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Kunlik ulush yozuvi (scope, worker, role, work_date) bo'yicha yagona —
  // runtime DDL (bot init_db) dagi partial unique index bilan bir xil
  uniqueIndex("salary_entries_daily_shared_uniq")
    .on(t.scope, t.worker, t.role, t.workDate)
    .where(sql`source_type = 'daily_shared'`),
]);

export const insertSalaryEntrySchema = createInsertSchema(salaryEntriesTable).omit({ id: true, createdAt: true });
export type InsertSalaryEntry = z.infer<typeof insertSalaryEntrySchema>;
export type SalaryEntry = typeof salaryEntriesTable.$inferSelect;
