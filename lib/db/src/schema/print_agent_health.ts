import {
  boolean,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const printAgentHealthTable = pgTable("print_agent_health", {
  agentId: text("agent_id").primaryKey(),
  printerName: text("printer_name").notNull(),
  printerAvailable: boolean("printer_available").notNull(),
  mediaValid: boolean("media_valid").notNull(),
  printableAreaValid: boolean("printable_area_valid").notNull(),
  physicalWidthMm: numeric("physical_width_mm", { precision: 8, scale: 2 }),
  physicalHeightMm: numeric("physical_height_mm", { precision: 8, scale: 2 }),
  printableWidthMm: numeric("printable_width_mm", { precision: 8, scale: 2 }),
  printableHeightMm: numeric("printable_height_mm", { precision: 8, scale: 2 }),
  healthy: boolean("healthy").notNull(),
  detail: text("detail").notNull().default(""),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  lastTransitionAt: timestamp("last_transition_at", { withTimezone: true }).notNull(),
  lastNotifiedStatus: text("last_notified_status"),
  notifiedChatIds: text("notified_chat_ids").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});