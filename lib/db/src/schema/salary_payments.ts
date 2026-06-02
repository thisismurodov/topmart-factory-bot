import { pgTable, serial, text, integer, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const salaryPaymentsTable = pgTable("salary_payments", {
  id: serial("id").primaryKey(),
  worker: text("worker").notNull(),
  year: integer("year").notNull(),
  month: integer("month").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSalaryPaymentSchema = createInsertSchema(salaryPaymentsTable).omit({ id: true, paidAt: true });
export type InsertSalaryPayment = z.infer<typeof insertSalaryPaymentSchema>;
export type SalaryPayment = typeof salaryPaymentsTable.$inferSelect;
