import { pgSchema, serial, text, integer, bigint, doublePrecision, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Distribution module lives in its own Postgres schema so its Uzbek-named tables
// (dokonlar, savdolar, ...) never collide with the public ERP tables.
export const distribution = pgSchema("distribution");

// Sotuv agentlari (sales agents / users)
export const distUsersTable = distribution.table("users", {
  id: serial("id").primaryKey(),
  telegramId: bigint("telegram_id", { mode: "number" }).unique(),
  name: text("name"),
  role: text("role").default("agent"),
  viloyat: text("viloyat"),
  createdAt: text("created_at"),
});

// Do'konlar (stores / customers of the distributor)
export const dokonlarTable = distribution.table("dokonlar", {
  id: serial("id").primaryKey(),
  nomi: text("nomi"),
  egasi: text("egasi"),
  telefon: text("telefon"),
  viloyat: text("viloyat"),
  hudud: text("hudud"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  foto: text("foto"),
  agentId: bigint("agent_id", { mode: "number" }),
  holat: text("holat").default("faol"),
  createdAt: text("created_at"),
  ownerTelegramId: bigint("owner_telegram_id", { mode: "number" }),
  // Repeat system fields
  firstOrderDate: text("first_order_date"),
  lastOrderDate: text("last_order_date"),
  totalOrders: integer("total_orders").default(0),
  repeatOrders: integer("repeat_orders").default(0),
  totalSales: bigint("total_sales", { mode: "number" }).default(0),
  avgRepeatDays: doublePrecision("avg_repeat_days").default(0),
});

// Mahsulotlar (distributed products)
export const distMahsulotlarTable = distribution.table("mahsulotlar", {
  id: serial("id").primaryKey(),
  nomi: text("nomi"),
  narx: bigint("narx", { mode: "number" }),
  birlik: text("birlik").default("dona"),
  faol: integer("faol").default(1),
});

// Savdolar (sales headers)
export const savdolarTable = distribution.table("savdolar", {
  id: serial("id").primaryKey(),
  dokonId: bigint("dokon_id", { mode: "number" }),
  agentId: bigint("agent_id", { mode: "number" }),
  jamiSumma: bigint("jami_summa", { mode: "number" }),
  tolovTuri: text("tolov_turi"),
  foto: text("foto"),
  createdAt: text("created_at"),
});

// Savdo tafsilot (sale line items)
export const savdoTafsilotTable = distribution.table("savdo_tafsilot", {
  id: serial("id").primaryKey(),
  savdoId: bigint("savdo_id", { mode: "number" }),
  mahsulotId: bigint("mahsulot_id", { mode: "number" }),
  miqdor: integer("miqdor"),
  narx: bigint("narx", { mode: "number" }),
  summa: bigint("summa", { mode: "number" }),
});

// Olmagan do'konlar (visited-but-no-order log)
export const olmaganDokonlarTable = distribution.table("olmagan_dokonlar", {
  id: serial("id").primaryKey(),
  dokonId: bigint("dokon_id", { mode: "number" }),
  agentId: bigint("agent_id", { mode: "number" }),
  sabab: text("sabab"),
  sababText: text("sabab_text"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  qaytishSanasi: text("qaytish_sanasi"),
  bajarildi: integer("bajarildi").default(0),
  createdAt: text("created_at"),
  foto: text("foto"),
});

// Pul olish (cash collection / payments received)
export const pulOlishTable = distribution.table("pul_olish", {
  id: serial("id").primaryKey(),
  dokonId: bigint("dokon_id", { mode: "number" }),
  agentId: bigint("agent_id", { mode: "number" }),
  summa: bigint("summa", { mode: "number" }),
  createdAt: text("created_at"),
});

// Nasiya (credit / debt)
export const nasiyaTable = distribution.table("nasiya", {
  id: serial("id").primaryKey(),
  dokonId: bigint("dokon_id", { mode: "number" }),
  agentId: bigint("agent_id", { mode: "number" }),
  savdoId: bigint("savdo_id", { mode: "number" }),
  jamiSumma: bigint("jami_summa", { mode: "number" }),
  tolangan: bigint("tolangan", { mode: "number" }).default(0),
  qoldiq: bigint("qoldiq", { mode: "number" }),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

// Mijoz balans (store running balance)
export const mijozBalansTable = distribution.table("mijoz_balans", {
  id: serial("id").primaryKey(),
  dokonId: bigint("dokon_id", { mode: "number" }).unique(),
  balans: bigint("balans", { mode: "number" }).default(0),
});

// Revisitlar (scheduled revisits)
export const revisitlarTable = distribution.table(
  "revisitlar",
  {
    id: serial("id").primaryKey(),
    dokonId: bigint("dokon_id", { mode: "number" }),
    agentId: bigint("agent_id", { mode: "number" }),
    lastOrderDate: text("last_order_date"),
    revisitDate: text("revisit_date"),
    status: text("status").default("pending"),
    createdAt: text("created_at"),
  },
  (t) => [index("idx_revisit_pending").on(t.revisitDate, t.status)],
);

// Agent plans (monthly targets)
export const agentPlansTable = distribution.table(
  "agent_plans",
  {
    id: serial("id").primaryKey(),
    agentId: bigint("agent_id", { mode: "number" }),
    oy: text("oy"),
    savdoPlan: bigint("savdo_plan", { mode: "number" }).default(0),
    dokonPlan: integer("dokon_plan").default(0),
    createdAt: text("created_at"),
  },
  (t) => [uniqueIndex("uq_agent_plans_agent_oy").on(t.agentId, t.oy)],
);

// Delivery agents
export const deliveryAgentsTable = distribution.table("delivery_agents", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  telefon: text("telefon"),
  tugilganKun: text("tugilgan_kun"),
  mashinaTuri: text("mashina_turi"),
  mashinaNomeri: text("mashina_nomeri"),
  hudud: text("hudud"),
  telegramId: bigint("telegram_id", { mode: "number" }),
  faol: integer("faol").default(1),
  createdAt: text("created_at"),
});

// Delivery routes
export const deliveryRoutesTable = distribution.table(
  "delivery_routes",
  {
    id: serial("id").primaryKey(),
    deliveryAgentId: bigint("delivery_agent_id", { mode: "number" }).notNull(),
    kun: integer("kun").notNull(),
    dokonId: bigint("dokon_id", { mode: "number" }).notNull(),
    tartib: integer("tartib").default(0),
    createdAt: text("created_at"),
    addedByDlv: integer("added_by_dlv").default(0),
  },
  (t) => [
    uniqueIndex("uq_routes_agent_kun_dokon").on(t.deliveryAgentId, t.kun, t.dokonId),
    index("idx_routes_agent_day").on(t.deliveryAgentId, t.kun),
  ],
);

export const insertDokonSchema = createInsertSchema(dokonlarTable).omit({ id: true });
export type Dokon = typeof dokonlarTable.$inferSelect;
export type DistSavdo = typeof savdolarTable.$inferSelect;
export type DistNasiya = typeof nasiyaTable.$inferSelect;
export type DistAgent = typeof distUsersTable.$inferSelect;
export type DeliveryAgent = typeof deliveryAgentsTable.$inferSelect;
export type _DistInsertDokon = z.infer<typeof insertDokonSchema>;
