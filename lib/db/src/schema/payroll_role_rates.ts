import { pgTable, serial, text, numeric, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const payrollRoleRatesTable = pgTable(
  "payroll_role_rates",
  {
    id: serial("id").primaryKey(),
    scope: text("scope").notNull().default("arqon"),
    role: text("role").notNull(),
    rate: numeric("rate", { precision: 12, scale: 2 }).notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("payroll_role_rates_scope_role_uniq").on(t.scope, t.role)]
);

export const insertPayrollRoleRateSchema = createInsertSchema(payrollRoleRatesTable).omit({ id: true, updatedAt: true });
export type InsertPayrollRoleRate = z.infer<typeof insertPayrollRoleRateSchema>;
export type PayrollRoleRate = typeof payrollRoleRatesTable.$inferSelect;
