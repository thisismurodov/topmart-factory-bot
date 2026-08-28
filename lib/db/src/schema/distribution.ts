import { pgSchema, serial, text, integer, bigint, boolean, doublePrecision, timestamp, uniqueIndex, index, check, numeric, date } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
  sku: text("sku").default(""),
});

// Savdolar (sales headers)
export const savdolarTable = distribution.table(
  "savdolar",
  {
    id: serial("id").primaryKey(),
    dokonId: bigint("dokon_id", { mode: "number" }),
    agentId: bigint("agent_id", { mode: "number" }),
    jamiSumma: bigint("jami_summa", { mode: "number" }),
    tolovTuri: text("tolov_turi"),
    foto: text("foto"),
    createdAt: text("created_at"),
    operationKey: text("operation_key"),
    operationFingerprint: text("operation_fingerprint"),
    status: text("status").default("active"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_savdolar_agent").on(t.agentId),
    uniqueIndex("uq_savdolar_operation_key")
      .on(t.operationKey)
      .where(sql`${t.operationKey} IS NOT NULL`),
  ],
);

// Savdo tafsilot (sale line items)
export const savdoTafsilotTable = distribution.table("savdo_tafsilot", {
  id: serial("id").primaryKey(),
  savdoId: bigint("savdo_id", { mode: "number" }),
  mahsulotId: bigint("mahsulot_id", { mode: "number" }),
  miqdor: doublePrecision("miqdor"),
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
    // 1 — marshrut crossing ogohlantirishiga qaramay force=true bilan saqlangan (audit)
    forceSaved: integer("force_saved").default(0),
    // Biznes ustuvorlik signallari — reja saqlanganda routePlanner'dan ko'chiriladi
    bizScore: integer("biz_score"),
    bizReasons: text("biz_reasons"), // JSON massiv, masalan ["VIP","35 kun bormagan"]
  },
  (t) => [
    uniqueIndex("uq_routes_agent_kun_dokon").on(t.deliveryAgentId, t.kun, t.dokonId),
    index("idx_routes_agent_day").on(t.deliveryAgentId, t.kun),
  ],
);

// Agent GPS nuqtalari (jonli oqim — Task "Agent jonli oqimi")
export const agentLocationsTable = distribution.table(
  "agent_locations",
  {
    id: serial("id").primaryKey(),
    agentId: bigint("agent_id", { mode: "number" }).notNull(),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    source: text("source").default("manual"),
    createdAt: text("created_at"),
  },
  (t) => [index("idx_agent_locations_agent_time").on(t.agentId, t.createdAt)],
);

// Field Assistant (Mini App) offline-sync idempotency jurnali:
// har bir tashrif natijasi klient UUID (client_op_id) bilan yoziladi — takror
// yuborilsa UNIQUE constraint duplikat savdo/olmadi yozuvining oldini oladi.
export const fieldOpsTable = distribution.table(
  "field_ops",
  {
    id: serial("id").primaryKey(),
    clientOpId: text("client_op_id").notNull(),
    agentId: bigint("agent_id", { mode: "number" }).notNull(),
    opType: text("op_type").notNull(),
    dokonId: bigint("dokon_id", { mode: "number" }),
    resultId: bigint("result_id", { mode: "number" }),
    createdAt: text("created_at"),
  },
  (t) => [uniqueIndex("uq_field_ops_client_op").on(t.clientOpId)],
);

export const fieldRouteOrdersTable = distribution.table(
  "field_route_orders",
  {
    id: serial("id").primaryKey(),
    deliveryAgentId: bigint("delivery_agent_id", { mode: "number" }).notNull(),
    sana: text("sana").notNull(),
    dokonIds: text("dokon_ids").notNull(),
    // Klientdan kelgan monoton o'suvchi operatsiya belgisi (Date.now() asosida).
    // Kechikkan eski PUT yangi holatni ustidan yozmasligi uchun — upsert faqat
    // op_seq kattaroq bo'lsa qo'llanadi. Reset ham tombstone ('[]') sifatida
    // shu mexanizm orqali yoziladi.
    opSeq: bigint("op_seq", { mode: "number" }).notNull().default(0),
    updatedAt: text("updated_at"),
  },
  (t) => [uniqueIndex("uq_field_route_orders_agent_sana").on(t.deliveryAgentId, t.sana)],
);

// Do'kon GPS pin ko'chirish audit jurnali: kim, qachon, qayerdan qayerga.
// Faqat API PATCH /distribution/shops/:id yozadi (dashboard pin drag/edit).
export const dokonLocationLogTable = distribution.table(
  "dokon_location_log",
  {
    id: serial("id").primaryKey(),
    dokonId: bigint("dokon_id", { mode: "number" }).notNull(),
    oldLatitude: doublePrecision("old_latitude"),
    oldLongitude: doublePrecision("old_longitude"),
    newLatitude: doublePrecision("new_latitude"),
    newLongitude: doublePrecision("new_longitude"),
    changedBy: text("changed_by").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_dokon_location_log_dokon").on(t.dokonId, t.createdAt)],
);

// AI tavsiya reytingi keshi — server restartidan keyin ham LLM chaqirmaslik uchun.
// cache_key = sana + filtrlar; items — AiSuggestion[] JSON matni; TTL kod tarafda
// (created_at bo'yicha) tekshiriladi.
export const aiSuggestCacheTable = distribution.table("ai_suggest_cache", {
  cacheKey: text("cache_key").primaryKey(),
  items: text("items").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertDokonSchema = createInsertSchema(dokonlarTable).omit({ id: true });
export type Dokon = typeof dokonlarTable.$inferSelect;
export type DistSavdo = typeof savdolarTable.$inferSelect;
export type DistNasiya = typeof nasiyaTable.$inferSelect;
export type DistAgent = typeof distUsersTable.$inferSelect;
export type DeliveryAgent = typeof deliveryAgentsTable.$inferSelect;
export type _DistInsertDokon = z.infer<typeof insertDokonSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Vehicle Distribution Pilot — F1 schema
//
// Gate: these tables are only created at runtime when
//   VEHICLE_DISTRIBUTION_SCHEMA_APPROVED=1
// is set in the environment. The Drizzle mirror is always present here for
// type-safety; runtime DDL is gated in all three DDL sources.
//
// Cross-schema references: warehouse_id and production_label_id/barcode are
// LOGICAL references to public.warehouses and public.production_labels; no FK
// constraints cross schema boundaries.
//
// Partial unique indexes (replenishment open-request guard, reconciliation
// adjustment_reference single-apply) cannot be expressed in Drizzle's index()
// API without WHERE support. They are enforced in the runtime DDL and validated
// by the dedicated catalog check in check-distribution-drift.ts
// (compareVehicleChecksAndPartialIndexes).
// ─────────────────────────────────────────────────────────────────────────────

/** Vehicle master registry.
 *
 *  warehouse_id: UNIQUE logical ref to public.warehouses — each vehicle has
 *  exactly one home warehouse at a time. No cross-schema FK.
 *
 *  vehicle_type: canonical fleet types used by this pilot.
 *  status:       lifecycle state of the physical vehicle.
 */
export const vehiclesTable = distribution.table(
  "vehicles",
  {
    id: serial("id").primaryKey(),
    /** Human-readable plate or fleet number — must be unique. */
    plateNumber: text("plate_number").notNull(),
    vehicleType: text("vehicle_type").notNull().default("DAMAS"),
    /** Free-form description / make+model. */
    description: text("description"),
    capacityKg: numeric("capacity_kg", { precision: 12, scale: 3 }).notNull().default("0"),
    /** Lifecycle state. */
    status: text("status").notNull().default("active"),
    /** Logical ref to public.warehouses.id — UNIQUE (one vehicle ↔ one home warehouse). */
    warehouseId: integer("warehouse_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_vehicles_plate").on(t.plateNumber),
    uniqueIndex("uq_vehicles_warehouse").on(t.warehouseId),
    index("idx_vehicles_status").on(t.status),
    check(
      "vehicles_type_check",
      sql`${t.vehicleType} IN ('DAMAS','LABO','NEXIA','SPARK','COBALT','OTHER')`,
    ),
    check(
      "vehicles_status_check",
      sql`${t.status} IN ('active','inactive','in_warehouse','on_route','maintenance')`,
    ),
    check("vehicles_capacity_check", sql`${t.capacityKg} >= 0`),
  ],
);

/** Active assignment: which delivery agent drives which vehicle.
 *  Only one active assignment per vehicle at a time, AND only one active
 *  assignment per delivery agent at a time. Both are partial unique indexes
 *  (vehicle_id WHERE status='active'; delivery_agent_id WHERE status='active')
 *  enforced in runtime DDL and validated via pg_catalog — WHERE predicates are
 *  not expressible in Drizzle's index() API. */
export const vehicleAssignmentsTable = distribution.table(
  "vehicle_assignments",
  {
    id: serial("id").primaryKey(),
    vehicleId: integer("vehicle_id").notNull(),
    /** References distribution.delivery_agents.id (logical, no cross-schema FK). */
    deliveryAgentId: integer("delivery_agent_id").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    unassignedAt: timestamp("unassigned_at", { withTimezone: true }),
    /** 'active' | 'ended' */
    status: text("status").notNull().default("active"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_vehicle_assignments_vehicle").on(t.vehicleId, t.status),
    index("idx_vehicle_assignments_agent").on(t.deliveryAgentId, t.status),
    check("vehicle_assignments_status_check", sql`${t.status} IN ('active','ended')`),
  ],
);

/** Handoff session: warehouse prepares and physically transfers goods to a vehicle.
 *
 *  Lifecycle: prepared → labels_printed → handed_over → stock_transferred | cancelled
 *
 *  source_warehouse_id:   snapshot of the issuing warehouse at creation time.
 *  vehicle_warehouse_id:  snapshot of the vehicle's home warehouse at creation time.
 *  movement_reference:    opaque reference to the stock-movement record created
 *                         when status transitions to stock_transferred.
 */
export const vehicleHandoffsTable = distribution.table(
  "vehicle_handoffs",
  {
    id: serial("id").primaryKey(),
    vehicleId: integer("vehicle_id").notNull(),
    deliveryAgentId: integer("delivery_agent_id").notNull(),
    /** Logical ref to public.warehouses.id (issuing warehouse). */
    sourceWarehouseId: integer("source_warehouse_id").notNull(),
    /** Snapshot of vehicle's home warehouse at handoff creation. */
    vehicleWarehouseId: integer("vehicle_warehouse_id").notNull(),
    /** ISO date the handoff was initiated. */
    handoffDate: date("handoff_date").notNull(),
    status: text("status").notNull().default("prepared"),
    labelsPrintedAt: timestamp("labels_printed_at", { withTimezone: true }),
    labelsPrintedBy: integer("labels_printed_by"),
    handedOverAt: timestamp("handed_over_at", { withTimezone: true }),
    handedOverBy: integer("handed_over_by"),
    stockTransferredAt: timestamp("stock_transferred_at", { withTimezone: true }),
    stockTransferredBy: integer("stock_transferred_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: integer("cancelled_by"),
    /** Opaque ref to the stock-movement record created on stock_transferred. */
    movementReference: text("movement_reference"),
    /** F3: client idempotency token for prepared-handoff creation (nullable;
     *  partial-unique on non-null values, enforced in runtime DDL only). */
    operationKey: text("operation_key"),
    /** F3: server-assigned actor that prepared the handoff (admin|warehouse_bot). */
    preparedActorType: text("prepared_actor_type"),
    /** F3: server-assigned actor ref (admin username or bot name). */
    preparedActorRef: text("prepared_actor_ref"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_vehicle_handoffs_vehicle_date").on(t.vehicleId, t.handoffDate),
    index("idx_vehicle_handoffs_status").on(t.status, t.handoffDate),
    check(
      "vehicle_handoffs_status_check",
      sql`${t.status} IN ('prepared','labels_printed','handed_over','stock_transferred','cancelled')`,
    ),
  ],
);

/** Line items of a handoff: AGGREGATE product quantities dispatched.
 *
 *  This is an aggregate (one row per handoff+product), so it deliberately holds
 *  NO single production_label_id/barcode — a dispatched product line can cover
 *  many individual units. Per-unit label/barcode identity lives on
 *  vehicle_unit_events (event_type='load') instead. */
export const vehicleHandoffItemsTable = distribution.table(
  "vehicle_handoff_items",
  {
    id: serial("id").primaryKey(),
    handoffId: integer("handoff_id").notNull(),
    /** Logical reference to distribution.mahsulotlar.id. */
    mahsulotId: integer("mahsulot_id").notNull(),
    /** SKU string for cross-referencing public.products (logical, no FK). */
    sku: text("sku").notNull().default(""),
    quantityDispatched: numeric("quantity_dispatched", { precision: 12, scale: 3 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 12, scale: 2 }).notNull().default("0"),
    /** F3: snapshot of public.products name at prepare time (nullable). */
    productName: text("product_name"),
    /** Number of pieces in each source box at prepare time. */
    piecesPerBox: integer("pieces_per_box").notNull().default(1),
    /** F3: snapshot per-unit weight (kg) at prepare time (nullable, >=0 if set). */
    unitWeightKg: numeric("unit_weight_kg", { precision: 12, scale: 3 }),
    /** F3: snapshot total weight (kg) = unit_weight_kg * quantity (nullable, >=0). */
    totalWeightKg: numeric("total_weight_kg", { precision: 12, scale: 3 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_vehicle_handoff_items_handoff").on(t.handoffId),
    index("idx_vehicle_handoff_items_mahsulot").on(t.mahsulotId),
    uniqueIndex("uq_vehicle_handoff_items_handoff_mahsulot").on(t.handoffId, t.mahsulotId),
    check("vehicle_handoff_items_qty_check", sql`${t.quantityDispatched} > 0`),
    check("vehicle_handoff_items_cost_check", sql`${t.unitCost} >= 0`),
    check("vehicle_handoff_items_pieces_per_box_check", sql`${t.piecesPerBox} > 0`),
    check("vehicle_handoff_items_unit_weight_check", sql`${t.unitWeightKg} IS NULL OR ${t.unitWeightKg} >= 0`),
    check("vehicle_handoff_items_total_weight_check", sql`${t.totalWeightKg} IS NULL OR ${t.totalWeightKg} >= 0`),
  ],
);

/** Per-unit lifecycle events on a vehicle (load, unload, return, adjustment, sale).
 *
 *  This is where individual-unit identity lives (production_label_id / barcode),
 *  as opposed to the aggregate vehicle_handoff_items. A 'load' event links a
 *  specific unit to a handoff via handoff_item_id, and the two partial unique
 *  load-identity indexes (production_label_id, barcode — both WHERE
 *  event_type='load') prevent the same non-null unit from being loaded twice in
 *  the same handoff. Those WHERE predicates live in runtime DDL only. */
export const vehicleUnitEventsTable = distribution.table(
  "vehicle_unit_events",
  {
    id: serial("id").primaryKey(),
    vehicleId: integer("vehicle_id").notNull(),
    handoffId: integer("handoff_id"),
    /** Logical ref to distribution.vehicle_handoff_items.id (nullable). */
    handoffItemId: integer("handoff_item_id"),
    mahsulotId: integer("mahsulot_id").notNull(),
    sku: text("sku").notNull().default(""),
    eventType: text("event_type").notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull(),
    /** Actor (delivery agent telegram_id or user id) who recorded the event. */
    actorId: bigint("actor_id", { mode: "number" }).notNull(),
    /** Logical ref to public.production_labels.id (nullable). */
    productionLabelId: integer("production_label_id"),
    /** Snapshot of public.production_labels.barcode_value (nullable). */
    barcode: text("barcode"),
    /** F3: client idempotency token for label_printed/load events (nullable;
     *  partial-unique on non-null, enforced in runtime DDL only). */
    operationKey: text("operation_key"),
    /** F3: logical ref to distribution.vehicle_label_claims.id (nullable). */
    labelClaimId: integer("label_claim_id"),
    eventAt: timestamp("event_at", { withTimezone: true }).notNull().defaultNow(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_vehicle_unit_events_vehicle_at").on(t.vehicleId, t.eventAt),
    index("idx_vehicle_unit_events_mahsulot").on(t.mahsulotId, t.eventType),
    index("idx_vehicle_unit_events_handoff").on(t.handoffId),
    index("idx_vehicle_unit_events_handoff_item").on(t.handoffItemId),
    index("idx_vehicle_unit_events_label_claim").on(t.labelClaimId),
    uniqueIndex("uq_vehicle_unit_events_return_label_claim")
      .on(t.labelClaimId)
      .where(sql`${t.eventType} = 'return' AND ${t.labelClaimId} IS NOT NULL`),
    check(
      "vehicle_unit_events_type_check",
      sql`${t.eventType} IN ('load','unload','return','adjustment','sale','label_prepared','label_printed')`,
    ),
    check("vehicle_unit_events_qty_check", sql`${t.quantity} <> 0`),
  ],
);

/** Links a sale line item to the handoff that supplied its goods.
 *
 *  Append-only. Each row is identified by operation_key (UNIQUE) — a
 *  client-generated idempotency token — so retried writes are safe.
 *  savdo_id + savdo_tafsilot_id together identify the exact sale line;
 *  product_name/product_sku are snapshots for audit durability.
 *  allocated_quantity and allocated_weight_kg must both be positive.
 *  production_label_id/barcode are optional logical refs to public.production_labels.
 */
export const vehicleSaleAllocationsTable = distribution.table(
  "vehicle_sale_allocations",
  {
    id: serial("id").primaryKey(),
    handoffId: integer("handoff_id").notNull(),
    /** References distribution.savdolar.id (logical). */
    savdoId: bigint("savdo_id", { mode: "number" }).notNull(),
    /** References distribution.savdo_tafsilot.id — identifies the exact line. */
    savdoTafsilotId: bigint("savdo_tafsilot_id", { mode: "number" }).notNull(),
    /** References distribution.mahsulotlar.id (logical). */
    mahsulotId: integer("mahsulot_id").notNull(),
    /** Snapshot of product name at allocation time (audit durability). */
    productName: text("product_name").notNull(),
    /** Snapshot of product SKU at allocation time. */
    productSku: text("product_sku").notNull().default(""),
    vehicleId: integer("vehicle_id").notNull(),
    allocatedQuantity: numeric("allocated_quantity", { precision: 12, scale: 3 }).notNull(),
    allocatedWeightKg: numeric("allocated_weight_kg", { precision: 12, scale: 3 }).notNull(),
    /** Logical ref to public.production_labels.id (nullable). */
    productionLabelId: integer("production_label_id"),
    /** Logical ref to public.production_labels.barcode_value (nullable). */
    barcode: text("barcode"),
    /** Logical ref to distribution.vehicle_unit_events.id that supplied this
     *  allocation (nullable). Multiple partial allocations may share an event. */
    sourceUnitEventId: integer("source_unit_event_id"),
    /** Concrete physical-label claim; multiple partial allocations may share it. */
    labelClaimId: integer("label_claim_id"),
    /** Client-generated idempotency token — UNIQUE, prevents duplicate allocation. */
    operationKey: text("operation_key").notNull(),
    allocatedAt: timestamp("allocated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_vehicle_sale_allocations_op_key").on(t.operationKey),
    index("idx_vehicle_sale_allocations_handoff").on(t.handoffId),
    index("idx_vehicle_sale_allocations_savdo").on(t.savdoId),
    index("idx_vehicle_sale_allocations_vehicle").on(t.vehicleId),
    index("idx_vehicle_sale_allocations_source_unit_event").on(t.sourceUnitEventId),
    index("idx_vehicle_sale_allocations_label_claim").on(t.labelClaimId),
    check("vehicle_sale_allocations_qty_check", sql`${t.allocatedQuantity} > 0`),
    check("vehicle_sale_allocations_weight_check", sql`${t.allocatedWeightKg} > 0`),
  ],
);

/** F3: cross-handoff physical-package label claim.
 *
 *  One row per physical labelled package (production_label_id), globally unique
 *  across ALL handoffs — the cross-handoff invariant that a physical unit can
 *  only ever be claimed by one handoff item. barcode/sku/unit_weight_kg are
 *  self-describing snapshots. Partial unique on non-null operation_key is
 *  enforced in runtime DDL only (predicate not expressible in Drizzle). */
export const vehicleLabelClaimsTable = distribution.table(
  "vehicle_label_claims",
  {
    id: serial("id").primaryKey(),
    vehicleId: integer("vehicle_id").notNull(),
    handoffId: integer("handoff_id").notNull(),
    handoffItemId: integer("handoff_item_id").notNull(),
    /** Logical ref to public.production_labels.id — globally unique. */
    productionLabelId: integer("production_label_id").notNull(),
    /** Snapshot of public.production_labels.barcode_value — globally unique. */
    barcode: text("barcode").notNull(),
    /** Logical ref to distribution.mahsulotlar.id. */
    mahsulotId: integer("mahsulot_id").notNull(),
    sku: text("sku").notNull().default(""),
    /** Original quantity represented by the physical label. */
    piecesInLabel: integer("pieces_in_label").notNull().default(1),
    /** Unsold/unreturned quantity currently represented by this claim. */
    remainingQuantity: integer("remaining_quantity").notNull().default(1),
    unitWeightKg: numeric("unit_weight_kg", { precision: 12, scale: 3 }).notNull(),
    status: text("status").notNull().default("prepared"),
    /** Client idempotency token (nullable; partial-unique in runtime DDL). */
    operationKey: text("operation_key"),
    /** F9: owning open/completed return; populated only while reserved/returned. */
    returnId: integer("return_id"),
    returnedAt: timestamp("returned_at", { withTimezone: true }),
    returnedBy: bigint("returned_by", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_vehicle_label_claims_production_label").on(t.productionLabelId),
    uniqueIndex("uq_vehicle_label_claims_barcode").on(t.barcode),
    index("idx_vehicle_label_claims_handoff").on(t.handoffId),
    index("idx_vehicle_label_claims_handoff_item").on(t.handoffItemId),
    index("idx_vehicle_label_claims_vehicle").on(t.vehicleId, t.status),
    index("idx_vehicle_label_claims_mahsulot").on(t.mahsulotId, t.status),
    index("idx_vehicle_label_claims_return").on(t.returnId),
    check(
      "vehicle_label_claims_status_check",
      sql`${t.status} IN ('prepared','printed','loaded','return_reserved','sold','returned')`,
    ),
    check("vehicle_label_claims_weight_check", sql`${t.unitWeightKg} > 0`),
    check("vehicle_label_claims_pieces_in_label_check", sql`${t.piecesInLabel} > 0`),
    check("vehicle_label_claims_remaining_quantity_check", sql`${t.remainingQuantity} >= 0 AND ${t.remainingQuantity} <= ${t.piecesInLabel}`),
    check(
      "vehicle_label_claims_status_remaining_check",
      sql`(${t.status} IN ('sold','returned') AND ${t.remainingQuantity} = 0)
           OR (${t.status} IN ('prepared','printed','loaded','return_reserved') AND ${t.remainingQuantity} > 0)`,
    ),
    check(
      "vehicle_label_claims_return_linkage_check",
      sql`(${t.status} = 'return_reserved' AND ${t.returnId} IS NOT NULL
           AND ${t.returnedAt} IS NULL AND ${t.returnedBy} IS NULL)
        OR (${t.status} = 'returned' AND
           ((${t.returnId} IS NOT NULL AND ${t.returnedAt} IS NOT NULL AND ${t.returnedBy} IS NOT NULL)
            OR (${t.returnId} IS NULL AND ${t.returnedAt} IS NULL AND ${t.returnedBy} IS NULL)))
        OR (${t.status} NOT IN ('return_reserved','returned') AND ${t.returnId} IS NULL
            AND ${t.returnedAt} IS NULL AND ${t.returnedBy} IS NULL)`,
    ),
  ],
);

/** F4: label PREPARE session. Exactly one per handoff (handoff_id UNIQUE);
 *  operation_key globally unique for idempotency; request_fingerprint is a
 *  canonical SHA256 over the handoff+items snapshot so a replay with the same
 *  key but a mutated payload is rejected. */
export const vehicleLabelPrepareSessionsTable = distribution.table(
  "vehicle_label_prepare_sessions",
  {
    id: serial("id").primaryKey(),
    handoffId: integer("handoff_id").notNull(),
    operationKey: text("operation_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    labelCount: integer("label_count").notNull(),
    actorType: text("actor_type").notNull(),
    actorRef: text("actor_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_vehicle_label_prepare_sessions_handoff").on(t.handoffId),
    uniqueIndex("uq_vehicle_label_prepare_sessions_operation_key").on(t.operationKey),
    check("vehicle_label_prepare_sessions_count_check", sql`${t.labelCount} > 0`),
  ],
);

/** F4: label PRINT/confirm session. Many per handoff (first print + reprints);
 *  operation_key globally unique for confirm idempotency; is_reprint marks a
 *  reprint confirm. */
export const vehicleLabelPrintSessionsTable = distribution.table(
  "vehicle_label_print_sessions",
  {
    id: serial("id").primaryKey(),
    handoffId: integer("handoff_id").notNull(),
    operationKey: text("operation_key").notNull(),
    labelCount: integer("label_count").notNull(),
    isReprint: boolean("is_reprint").notNull().default(false),
    actorType: text("actor_type").notNull(),
    actorRef: text("actor_ref").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_vehicle_label_print_sessions_operation_key").on(t.operationKey),
    index("idx_vehicle_label_print_sessions_handoff").on(t.handoffId),
    check("vehicle_label_print_sessions_count_check", sql`${t.labelCount} > 0`),
  ],
);

/** Target stock levels per vehicle and product. */
export const vehicleStockTargetsTable = distribution.table(
  "vehicle_stock_targets",
  {
    id: serial("id").primaryKey(),
    vehicleId: integer("vehicle_id").notNull(),
    mahsulotId: integer("mahsulot_id").notNull(),
    publicProductId: bigint("public_product_id", { mode: "number" }),
    productName: text("product_name"),
    sku: text("sku").notNull().default(""),
    targetQuantity: numeric("target_quantity", { precision: 12, scale: 3 }).notNull(),
    minQuantity: numeric("min_quantity", { precision: 12, scale: 3 }).notNull().default("0"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    operationKey: text("operation_key"),
    actorType: text("actor_type"),
    actorRef: text("actor_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_vehicle_stock_targets_vehicle").on(t.vehicleId, t.publicProductId),
    uniqueIndex("uq_vehicle_stock_targets_current")
      .on(t.vehicleId, t.publicProductId)
      .where(sql`${t.effectiveTo} IS NULL`),
    uniqueIndex("uq_vehicle_stock_targets_operation_key")
      .on(t.operationKey)
      .where(sql`${t.operationKey} IS NOT NULL`),
    check("vehicle_stock_targets_qty_check", sql`${t.targetQuantity} > 0`),
    check("vehicle_stock_targets_min_check", sql`${t.minQuantity} >= 0`),
    check("vehicle_stock_targets_range_check", sql`${t.minQuantity} <= ${t.targetQuantity}`),
    check(
      "vehicle_stock_targets_whole_units_check",
      sql`${t.publicProductId} IS NULL OR (${t.targetQuantity} = trunc(${t.targetQuantity}) AND ${t.minQuantity} = trunc(${t.minQuantity}))`,
    ),
    check(
      "vehicle_stock_targets_identity_check",
      sql`${t.publicProductId} IS NULL OR (${t.productName} IS NOT NULL AND btrim(${t.productName}) <> '' AND btrim(${t.sku}) <> '')`,
    ),
  ],
);

/** Replenishment request raised by a delivery agent for a vehicle.
 *
 *  Partial unique index in runtime DDL prevents two open (pending/approved)
 *  requests for the same vehicle+product simultaneously. Enforced via
 *  pg_catalog in check-distribution-drift.ts — not expressible in Drizzle.
 */
export const vehicleReplenishmentRequestsTable = distribution.table(
  "vehicle_replenishment_requests",
  {
    id: serial("id").primaryKey(),
    vehicleId: integer("vehicle_id").notNull(),
    requestedBy: bigint("requested_by", { mode: "number" }).notNull(),
    mahsulotId: integer("mahsulot_id").notNull(),
    publicProductId: bigint("public_product_id", { mode: "number" }),
    productName: text("product_name"),
    sku: text("sku").notNull().default(""),
    requestedQuantity: numeric("requested_quantity", { precision: 12, scale: 3 }).notNull(),
    approvedQuantity: numeric("approved_quantity", { precision: 12, scale: 3 }),
    targetQuantitySnapshot: numeric("target_quantity_snapshot", { precision: 12, scale: 3 }),
    currentQuantitySnapshot: numeric("current_quantity_snapshot", { precision: 12, scale: 3 }),
    sourceWarehouseId: integer("source_warehouse_id"),
    handoffId: integer("handoff_id").references(() => vehicleHandoffsTable.id),
    operationKey: text("operation_key"),
    requestFingerprint: text("request_fingerprint"),
    status: text("status").notNull().default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    approvedBy: bigint("approved_by", { mode: "number" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    cancelledBy: bigint("cancelled_by", { mode: "number" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_vehicle_replenishment_vehicle_status").on(t.vehicleId, t.status),
    index("idx_vehicle_replenishment_product").on(t.publicProductId, t.status),
    uniqueIndex("uq_vehicle_replenishment_open")
      .on(t.vehicleId, t.publicProductId)
      .where(sql`${t.status} IN ('pending','approved')`),
    uniqueIndex("uq_vehicle_replenishment_operation_key")
      .on(t.operationKey)
      .where(sql`${t.operationKey} IS NOT NULL`),
    uniqueIndex("uq_vehicle_replenishment_fingerprint")
      .on(t.requestFingerprint)
      .where(sql`${t.requestFingerprint} IS NOT NULL`),
    uniqueIndex("uq_vehicle_replenishment_handoff")
      .on(t.handoffId)
      .where(sql`${t.handoffId} IS NOT NULL`),
    check(
      "vehicle_replenishment_status_check",
      sql`${t.status} IN ('pending','approved','fulfilled','rejected','cancelled')`,
    ),
    check("vehicle_replenishment_qty_check", sql`${t.requestedQuantity} > 0`),
    check(
      "vehicle_replenishment_approved_check",
      sql`${t.approvedQuantity} IS NULL OR ${t.approvedQuantity} > 0`,
    ),
    check(
      "vehicle_replenishment_whole_units_check",
      sql`${t.publicProductId} IS NULL OR (${t.requestedQuantity} = trunc(${t.requestedQuantity}) AND (${t.approvedQuantity} IS NULL OR ${t.approvedQuantity} = trunc(${t.approvedQuantity})))`,
    ),
    check(
      "vehicle_replenishment_identity_check",
      sql`${t.publicProductId} IS NULL OR (${t.productName} IS NOT NULL AND btrim(${t.productName}) <> '' AND btrim(${t.sku}) <> '')`,
    ),
    check(
      "vehicle_replenishment_snapshot_check",
      sql`${t.publicProductId} IS NULL OR (${t.targetQuantitySnapshot} > 0 AND ${t.currentQuantitySnapshot} >= 0 AND ${t.requestedQuantity} = ${t.targetQuantitySnapshot} - ${t.currentQuantitySnapshot})`,
    ),
    check(
      "vehicle_replenishment_full_approval_check",
      sql`${t.status} NOT IN ('approved','fulfilled') OR (${t.approvedQuantity} IS NOT NULL AND ${t.approvedQuantity} = ${t.requestedQuantity})`,
    ),
    check(
      "vehicle_replenishment_linkage_check",
      sql`${t.publicProductId} IS NULL OR
        (${t.status} = 'pending' AND ${t.approvedQuantity} IS NULL AND ${t.approvedBy} IS NULL
         AND ${t.approvedAt} IS NULL AND ${t.handoffId} IS NULL AND ${t.sourceWarehouseId} IS NULL
         AND ${t.cancelledBy} IS NULL AND ${t.cancelledAt} IS NULL AND ${t.fulfilledAt} IS NULL)
        OR (${t.status} = 'approved' AND ${t.approvedQuantity} = ${t.requestedQuantity}
         AND ${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL
         AND ${t.handoffId} IS NOT NULL AND ${t.sourceWarehouseId} IS NOT NULL
         AND ${t.cancelledBy} IS NULL AND ${t.cancelledAt} IS NULL AND ${t.fulfilledAt} IS NULL)
        OR (${t.status} = 'fulfilled' AND ${t.approvedQuantity} = ${t.requestedQuantity}
         AND ${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL
         AND ${t.handoffId} IS NOT NULL AND ${t.sourceWarehouseId} IS NOT NULL
         AND ${t.cancelledBy} IS NULL AND ${t.cancelledAt} IS NULL AND ${t.fulfilledAt} IS NOT NULL)
        OR (${t.status} = 'cancelled' AND ${t.cancelledBy} IS NOT NULL
         AND ${t.cancelledAt} IS NOT NULL AND ${t.fulfilledAt} IS NULL)
        OR (${t.status} = 'rejected' AND ${t.handoffId} IS NULL AND ${t.fulfilledAt} IS NULL)`,
    ),
  ],
);

/** Durable Telegram delivery state for low-stock replenishment requests. */
export const vehicleReplenishmentOutboxTable = distribution.table(
  "vehicle_replenishment_outbox",
  {
    id: serial("id").primaryKey(),
    requestId: integer("request_id")
      .notNull()
      .references(() => vehicleReplenishmentRequestsTable.id, { onDelete: "cascade" }),
    recipientChatId: bigint("recipient_chat_id", { mode: "number" }).notNull(),
    status: text("status").notNull().default("PENDING"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimToken: text("claim_token"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_vehicle_replenishment_outbox_request_recipient").on(
      t.requestId,
      t.recipientChatId,
    ),
    index("idx_vehicle_replenishment_outbox_retry").on(
      t.status,
      t.nextAttemptAt,
      t.claimedAt,
    ),
    check(
      "vehicle_replenishment_outbox_status_check",
      sql`${t.status} IN ('PENDING','SENT','FAILED','ACKNOWLEDGED')`,
    ),
    check("vehicle_replenishment_outbox_attempt_check", sql`${t.attemptCount} >= 0`),
  ],
);

/** Reconciliation session header: end-of-day vehicle stock reconciliation.
 *
 *  Lifecycle: draft → approved → applied | disputed | cancelled
 *  approved_by/at: who signed off on the counts.
 *  applied_by/at:  who pushed the adjustments into stock movements.
 */
export const vehicleReconciliationsTable = distribution.table(
  "vehicle_reconciliations",
  {
    id: serial("id").primaryKey(),
    vehicleId: integer("vehicle_id").notNull(),
    deliveryAgentId: integer("delivery_agent_id").notNull(),
    reconciliationDate: date("reconciliation_date").notNull(),
    status: text("status").notNull().default("draft"),
    /** F6: server actor that created the reconciliation (admin user id). */
    createdBy: bigint("created_by", { mode: "number" }),
    /** F6: server actor that reviewed (approved/disputed) the counts. */
    reviewedBy: bigint("reviewed_by", { mode: "number" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    approvedBy: integer("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    appliedBy: integer("applied_by"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_vehicle_reconciliations_vehicle_date").on(t.vehicleId, t.reconciliationDate),
    index("idx_vehicle_reconciliations_status_date").on(t.status, t.reconciliationDate),
    index("idx_vehicle_reconciliations_agent").on(t.deliveryAgentId, t.reconciliationDate),
    check(
      "vehicle_reconciliations_status_check",
      sql`${t.status} IN ('draft','approved','applied','disputed','cancelled')`,
    ),
  ],
);

/** Line items of a reconciliation: expected vs actual per product.
 *
 *  Two coexisting shapes:
 *    • Legacy/distribution rows keyed on `mahsulot_id` (nullable now).
 *    • F6 ERP inventory rows keyed on `public_product_id` (a public.products id)
 *      with `mahsulot_id = NULL`; they snapshot the public product name and the
 *      expected quantity/weight at create time and leave `actual_quantity` NULL
 *      until physically counted.
 *
 *  adjustment_reference: opaque token written when a discrepancy is pushed into
 *  stock movements (legacy path). Partial unique (WHERE NOT NULL) in runtime
 *  DDL prevents double-apply. Both partial uniques
 *  (rec_id, mahsulot_id) WHERE mahsulot_id IS NOT NULL and
 *  (rec_id, public_product_id) WHERE public_product_id IS NOT NULL and the
 *  named CHECKs with WHERE/OR predicates are validated via pg_catalog in
 *  check-distribution-drift.ts — not expressible in Drizzle.
 */
export const vehicleReconciliationItemsTable = distribution.table(
  "vehicle_reconciliation_items",
  {
    id: serial("id").primaryKey(),
    reconciliationId: integer("reconciliation_id").notNull(),
    /** Legacy/distribution product id. NULL for F6 ERP inventory lines. */
    mahsulotId: integer("mahsulot_id"),
    /** F6: public.products id this line reconciles. NULL for legacy lines. */
    publicProductId: bigint("public_product_id", { mode: "number" }),
    /** F6: snapshot of the public product name at create time. */
    productName: text("product_name"),
    sku: text("sku").notNull().default(""),
    expectedQuantity: numeric("expected_quantity", { precision: 12, scale: 3 }).notNull(),
    /** F6: snapshot of the expected on-vehicle weight. NULL for legacy lines. */
    expectedWeightKg: numeric("expected_weight_kg", { precision: 12, scale: 3 }),
    /** NULL until the line is physically counted (F6 patch). */
    actualQuantity: numeric("actual_quantity", { precision: 12, scale: 3 }),
    discrepancy: numeric("discrepancy", { precision: 12, scale: 3 }).notNull().default("0"),
    /** F6: server actor + timestamp that entered the physical count. */
    countedBy: bigint("counted_by", { mode: "number" }),
    countedAt: timestamp("counted_at", { withTimezone: true }),
    /** Written when the discrepancy is applied to stock movements. UNIQUE WHERE NOT NULL. */
    adjustmentReference: text("adjustment_reference"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NOTE: the two partial unique indexes
    //   uq_vehicle_reconciliation_items_rec_mahsulot        WHERE mahsulot_id IS NOT NULL
    //   uq_vehicle_reconciliation_items_rec_public_product  WHERE public_product_id IS NOT NULL
    // live only in the runtime DDL and are validated (predicate + all) via
    // pg_catalog in check-distribution-drift.ts (EXPECTED_PARTIAL_INDEXES),
    // exactly like uq_vehicle_reconciliation_items_adj_ref — partial WHERE
    // predicates are not expressible in Drizzle.
    index("idx_vehicle_reconciliation_items_reconciliation").on(t.reconciliationId),
    check("vehicle_reconciliation_items_expected_check", sql`${t.expectedQuantity} >= 0`),
  ],
);

/** F9 return header. All identity columns are immutable server-side snapshots. */
export const vehicleReturnsTable = distribution.table(
  "vehicle_returns",
  {
    id: serial("id").primaryKey(),
    vehicleId: integer("vehicle_id").notNull(),
    vehicleAssignmentId: integer("vehicle_assignment_id").notNull(),
    deliveryAgentId: integer("delivery_agent_id").notNull(),
    vehicleWarehouseId: integer("vehicle_warehouse_id").notNull(),
    status: text("status").notNull().default("prepared"),
    operationKey: text("operation_key").notNull(),
    operationFingerprint: text("operation_fingerprint").notNull(),
    notes: text("notes"),
    preparedBy: bigint("prepared_by", { mode: "number" }).notNull(),
    preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull().defaultNow(),
    handedBackBy: bigint("handed_back_by", { mode: "number" }),
    handedBackAt: timestamp("handed_back_at", { withTimezone: true }),
    transferredBy: bigint("transferred_by", { mode: "number" }),
    transferredAt: timestamp("transferred_at", { withTimezone: true }),
    cancelledBy: bigint("cancelled_by", { mode: "number" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_vehicle_returns_operation_key").on(t.operationKey),
    uniqueIndex("uq_vehicle_returns_open_vehicle")
      .on(t.vehicleId)
      .where(sql`${t.status} IN ('prepared','handed_back')`),
    index("idx_vehicle_returns_vehicle_created").on(t.vehicleId, t.createdAt),
    check(
      "vehicle_returns_status_check",
      sql`${t.status} IN ('prepared','handed_back','stock_transferred','cancelled')`,
    ),
    check(
      "vehicle_returns_lifecycle_check",
      sql`(${t.status}='prepared' AND ${t.handedBackBy} IS NULL AND ${t.handedBackAt} IS NULL
           AND ${t.transferredBy} IS NULL AND ${t.transferredAt} IS NULL
           AND ${t.cancelledBy} IS NULL AND ${t.cancelledAt} IS NULL)
        OR (${t.status}='handed_back' AND ${t.handedBackBy} IS NOT NULL AND ${t.handedBackAt} IS NOT NULL
           AND ${t.transferredBy} IS NULL AND ${t.transferredAt} IS NULL
           AND ${t.cancelledBy} IS NULL AND ${t.cancelledAt} IS NULL)
        OR (${t.status}='stock_transferred' AND ${t.handedBackBy} IS NOT NULL AND ${t.handedBackAt} IS NOT NULL
           AND ${t.transferredBy} IS NOT NULL AND ${t.transferredAt} IS NOT NULL
           AND ${t.cancelledBy} IS NULL AND ${t.cancelledAt} IS NULL)
        OR (${t.status}='cancelled' AND ${t.handedBackBy} IS NULL AND ${t.handedBackAt} IS NULL
           AND ${t.transferredBy} IS NULL AND ${t.transferredAt} IS NULL
           AND ${t.cancelledBy} IS NOT NULL AND ${t.cancelledAt} IS NOT NULL)`,
    ),
  ],
);

/** F9 concrete physical unit returned to its original handoff source. */
export const vehicleReturnItemsTable = distribution.table(
  "vehicle_return_items",
  {
    id: serial("id").primaryKey(),
    returnId: integer("return_id").notNull(),
    labelClaimId: integer("label_claim_id").notNull(),
    productionLabelId: integer("production_label_id").notNull(),
    barcode: text("barcode").notNull(),
    handoffId: integer("handoff_id").notNull(),
    handoffItemId: integer("handoff_item_id").notNull(),
    mahsulotId: integer("mahsulot_id").notNull(),
    publicProductId: bigint("public_product_id", { mode: "number" }).notNull(),
    productName: text("product_name").notNull(),
    sku: text("sku").notNull(),
    unitWeightKg: numeric("unit_weight_kg", { precision: 12, scale: 3 }).notNull(),
    returnQuantity: integer("return_quantity").notNull().default(1),
    returnWeightKg: numeric("return_weight_kg", { precision: 12, scale: 3 }).notNull().default("1"),
    destinationWarehouseId: integer("destination_warehouse_id").notNull(),
    movementReference: text("movement_reference").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("vehicle_return_items_label_claim_id_key").on(t.labelClaimId),
    uniqueIndex("vehicle_return_items_movement_reference_key").on(t.movementReference),
    uniqueIndex("uq_vehicle_return_items_return_barcode").on(t.returnId, t.barcode),
    index("idx_vehicle_return_items_return").on(t.returnId),
    index("idx_vehicle_return_items_destination").on(t.destinationWarehouseId),
    check("vehicle_return_items_weight_check", sql`${t.unitWeightKg} > 0`),
    check("vehicle_return_items_return_quantity_check", sql`${t.returnQuantity} > 0`),
    check("vehicle_return_items_return_weight_check", sql`${t.returnWeightKg} > 0`),
    check(
      "vehicle_return_items_identity_check",
      sql`btrim(${t.barcode}) <> '' AND btrim(${t.productName}) <> '' AND btrim(${t.sku}) <> ''`,
    ),
  ],
);
