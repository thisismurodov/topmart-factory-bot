import { pgTable, bigint, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const pendingUsersTable = pgTable("pending_users", {
  chatId: bigint("chat_id", { mode: "number" }).primaryKey(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPendingUserSchema = createInsertSchema(pendingUsersTable).omit({ createdAt: true });
export type InsertPendingUser = z.infer<typeof insertPendingUserSchema>;
export type PendingUser = typeof pendingUsersTable.$inferSelect;
