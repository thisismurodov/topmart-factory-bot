import { pgTable, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const workersTable = pgTable("workers", {
  name: text("name").primaryKey(),
  prefix: text("prefix").notNull().default(""),
  phone: text("phone").notNull().default(""),
  role: text("role").notNull().default("worker"),
});

export const insertWorkerSchema = createInsertSchema(workersTable);
export type InsertWorker = z.infer<typeof insertWorkerSchema>;
export type Worker = typeof workersTable.$inferSelect;
