import { pgTable, serial, text, integer, numeric, date, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const dailyPayrollRunsTable = pgTable(
  "daily_payroll_runs",
  {
    id: serial("id").primaryKey(),
    scope: text("scope").notNull().default("arqon"),
    lineId: integer("line_id"),
    workDate: date("work_date").notNull(),
    totalKg: numeric("total_kg", { precision: 12, scale: 3 }).notNull().default("0"),
    status: text("status").notNull().default("closed"),
    closedBy: text("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("daily_payroll_runs_scope_date_line_uniq").on(t.scope, t.workDate, t.lineId)]
);

export const insertDailyPayrollRunSchema = createInsertSchema(dailyPayrollRunsTable).omit({ id: true, closedAt: true });
export type InsertDailyPayrollRun = z.infer<typeof insertDailyPayrollRunSchema>;
export type DailyPayrollRun = typeof dailyPayrollRunsTable.$inferSelect;
