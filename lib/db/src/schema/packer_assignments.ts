import { pgTable, bigint, text, primaryKey } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const packerAssignmentsTable = pgTable(
  "packer_assignments",
  {
    packerChatId: bigint("packer_chat_id", { mode: "number" }).notNull(),
    workerName: text("worker_name").notNull(),
  },
  (t) => [primaryKey({ columns: [t.packerChatId, t.workerName] })]
);

export const insertPackerAssignmentSchema = createInsertSchema(packerAssignmentsTable);
export type InsertPackerAssignment = z.infer<typeof insertPackerAssignmentSchema>;
export type PackerAssignment = typeof packerAssignmentsTable.$inferSelect;
