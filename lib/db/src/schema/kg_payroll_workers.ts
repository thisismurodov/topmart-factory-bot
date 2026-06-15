import { pgTable, serial, text, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const kgPayrollWorkersTable = pgTable(
  "kg_payroll_workers",
  {
    id: serial("id").primaryKey(),
    scope: text("scope").notNull().default("arqon"),
    workerName: text("worker_name").notNull(),
    role: text("role").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("kg_payroll_workers_scope_worker_role_uniq").on(t.scope, t.workerName, t.role)]
);

export const insertKgPayrollWorkerSchema = createInsertSchema(kgPayrollWorkersTable).omit({ id: true, createdAt: true });
export type InsertKgPayrollWorker = z.infer<typeof insertKgPayrollWorkerSchema>;
export type KgPayrollWorker = typeof kgPayrollWorkersTable.$inferSelect;
