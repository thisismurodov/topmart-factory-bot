import { pgTable, serial, text, integer, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const productionLineWorkersTable = pgTable(
  "production_line_workers",
  {
    id: serial("id").primaryKey(),
    lineId: integer("line_id").notNull(),
    workerName: text("worker_name").notNull(),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("production_line_workers_line_worker_role_uniq").on(t.lineId, t.workerName, t.role),
    uniqueIndex("production_line_workers_one_producer_line_uniq")
      .on(t.workerName)
      .where(sql`role = 'producer'`),
    // A worker can hold a given role in exactly one line — keeps the
    // (scope, worker, role, work_date) salary uniqueness line-consistent.
    uniqueIndex("production_line_workers_worker_role_uniq").on(t.workerName, t.role),
  ]
);

export const insertProductionLineWorkerSchema = createInsertSchema(productionLineWorkersTable).omit({ id: true, createdAt: true });
export type InsertProductionLineWorker = z.infer<typeof insertProductionLineWorkerSchema>;
export type ProductionLineWorker = typeof productionLineWorkersTable.$inferSelect;
