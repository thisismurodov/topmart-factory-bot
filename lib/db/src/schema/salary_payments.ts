import { pgTable, serial, text, integer, numeric, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const salaryPaymentsTable = pgTable(
  "salary_payments",
  {
    id: serial("id").primaryKey(),
    worker: text("worker").notNull(),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("salary_payments_worker_year_month_uniq").on(t.worker, t.year, t.month)]
);

export const insertSalaryPaymentSchema = createInsertSchema(salaryPaymentsTable).omit({ id: true, paidAt: true });
export type InsertSalaryPayment = z.infer<typeof insertSalaryPaymentSchema>;
export type SalaryPayment = typeof salaryPaymentsTable.$inferSelect;
