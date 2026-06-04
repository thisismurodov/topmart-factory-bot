import { pgTable, bigint, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const userRolesTable = pgTable("user_roles", {
  chatId: bigint("chat_id", { mode: "number" }).primaryKey(),
  workerName: text("worker_name").notNull(),
  role: text("role").notNull().default("worker"),
});

export const insertUserRoleSchema = createInsertSchema(userRolesTable);
export type InsertUserRole = z.infer<typeof insertUserRoleSchema>;
export type UserRole = typeof userRolesTable.$inferSelect;
