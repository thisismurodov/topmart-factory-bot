// ─────────────────────────────────────────────────────────────────────────────
// F2 Vehicle + Assignment pilot — service layer
//
// Pure DB logic for the vehicle-distribution pilot, kept out of the Express
// handlers so it can be unit-tested directly against a throwaway Postgres
// (see test/vehicle-distribution-pilot.test.ts).
//
// EXACT server constants — never overridable by request body:
//   - agent name      : NAVRUZBEK   (case-insensitive, trimmed match on an
//                        active distribution.delivery_agents row)
//   - vehicle plate   : DM-001      (also the fleet "code")
//   - vehicle type    : DAMAS
//
// Data model spans two schemas:
//   - public.warehouses / public.inventory  (main ERP DB)
//   - distribution.vehicles / distribution.vehicle_assignments /
//     distribution.delivery_agents          (bot-owned schema)
// No cross-schema FKs; the vehicle.warehouse_id is a logical ref to
// public.warehouses.id.
//
// Capacity: DO NOT invent a nonzero capacity. distribution.vehicles.capacity_kg
// defaults to 0 per schema; we insert without specifying it so the schema
// default (0) is preserved. On read we surface it as-is (null | 0 | number).
// ─────────────────────────────────────────────────────────────────────────────

import type { PoolClient } from "pg";

export const PILOT_AGENT_NAME = "NAVRUZBEK";
export const PILOT_VEHICLE_PLATE = "DM-001";
export const PILOT_VEHICLE_TYPE = "DAMAS";

/** Deterministic, stable name of the pilot vehicle's home warehouse. */
export const PILOT_WAREHOUSE_NAME = "DM-001 mashina ombori";
export const PILOT_WAREHOUSE_LOCATION_TYPE = "vehicle";
export const PILOT_WAREHOUSE_PURPOSE = "finished";

// Advisory lock key namespace — a single stable key serializes all pilot
// bootstrap attempts (transaction-scoped, released on COMMIT/ROLLBACK).
export const PILOT_LOCK_KEY = "vehicle_distribution:pilot:bootstrap";

/**
 * Serialize every dedicated mutation of a vehicle warehouse's inventory row
 * set. Locking the parent warehouse row (rather than the inventory rows that
 * happen to exist) also covers concurrent inserts of a brand-new SKU.
 *
 * Callers must already be in a transaction and must take this lock before
 * reading or mutating vehicle inventory.
 */
export async function lockVehicleWarehouseStockMutation(
  client: PoolClient,
  warehouseId: number,
): Promise<void> {
  const { rows } = await client.query(
    `SELECT id
       FROM public.warehouses
      WHERE id = $1
        AND location_type = 'vehicle'
      FOR UPDATE`,
    [warehouseId],
  );
  if (rows.length !== 1) {
    throw new PilotConflictError(
      `Vehicle warehouse ${warehouseId} does not exist or is not location_type=vehicle`,
    );
  }
}

export type PilotAgent = { id: number; name: string };
export type PilotVehicle = {
  id: number;
  plateNumber: string;
  vehicleType: string;
  status: string;
  capacityKg: number | null;
  warehouseId: number;
};
export type PilotWarehouse = {
  id: number;
  name: string;
  locationType: string;
  purpose: string;
  active: boolean;
};
export type PilotBalance = {
  warehouseId: number;
  skuCount: number;
  totalQuantity: number;
  totalWeightKg: number;
};
export type PilotAssignment = {
  id: number;
  vehicleId: number;
  deliveryAgentId: number;
  status: string;
  assignedAt: string | null;
};

export type PilotState = {
  bootstrapped: boolean;
  agent: PilotAgent | null;
  vehicle: PilotVehicle | null;
  warehouse: PilotWarehouse | null;
  balance: PilotBalance | null;
  assignment: PilotAssignment | null;
};

/** Conflict raised when existing pilot data does not match the exact expected
 *  constants (e.g. an active assignment for a different agent/vehicle, or a
 *  vehicle/warehouse row that collides on the pilot identity but is wrong). */
export class PilotConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PilotConflictError";
  }
}

/** Ambiguity raised when the agent lookup does not resolve to exactly one active
 *  delivery_agents row (zero or many). */
export class PilotAgentError extends Error {
  readonly matches: number;
  constructor(message: string, matches: number) {
    super(message);
    this.name = "PilotAgentError";
    this.matches = matches;
  }
}

function mapVehicle(row: {
  id: number;
  plate_number: string;
  vehicle_type: string;
  status: string;
  capacity_kg: string | number | null;
  warehouse_id: number;
}): PilotVehicle {
  return {
    id: Number(row.id),
    plateNumber: row.plate_number,
    vehicleType: row.vehicle_type,
    status: row.status,
    // Preserve unknown/null/zero per schema conventions — never fabricate.
    capacityKg: row.capacity_kg == null ? null : Number(row.capacity_kg),
    warehouseId: Number(row.warehouse_id),
  };
}

function mapWarehouse(row: {
  id: number;
  name: string;
  location_type: string;
  purpose: string;
  active: boolean;
}): PilotWarehouse {
  return {
    id: Number(row.id),
    name: row.name,
    locationType: row.location_type,
    purpose: row.purpose,
    active: row.active,
  };
}

function mapAssignment(row: {
  id: number;
  vehicle_id: number;
  delivery_agent_id: number;
  status: string;
  assigned_at: Date | string | null;
}): PilotAssignment {
  return {
    id: Number(row.id),
    vehicleId: Number(row.vehicle_id),
    deliveryAgentId: Number(row.delivery_agent_id),
    status: row.status,
    assignedAt:
      row.assigned_at == null
        ? null
        : row.assigned_at instanceof Date
          ? row.assigned_at.toISOString()
          : String(row.assigned_at),
  };
}

/** Aggregate the public warehouse balance summary for one warehouse. Read-only. */
async function readBalance(
  client: PoolClient,
  warehouseId: number,
): Promise<PilotBalance> {
  const { rows } = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE quantity <> 0)::int      AS sku_count,
       COALESCE(SUM(quantity), 0)::float8              AS total_quantity,
       COALESCE(SUM(weight_kg), 0)::float8             AS total_weight_kg
     FROM inventory
     WHERE warehouse_id = $1`,
    [warehouseId],
  );
  const r = rows[0] ?? {};
  return {
    warehouseId,
    skuCount: Number(r.sku_count ?? 0),
    totalQuantity: Number(r.total_quantity ?? 0),
    totalWeightKg: Number(r.total_weight_kg ?? 0),
  };
}

/** Locate the pilot vehicle (by exact plate) and its warehouse + active
 *  assignment. Read-only; no writes even when nothing is found. */
export async function readPilotState(client: PoolClient): Promise<PilotState> {
  const vehRes = await client.query(
    `SELECT id, plate_number, vehicle_type, status, capacity_kg, warehouse_id
       FROM distribution.vehicles
      WHERE plate_number = $1`,
    [PILOT_VEHICLE_PLATE],
  );

  if (vehRes.rows.length === 0) {
    return {
      bootstrapped: false,
      agent: null,
      vehicle: null,
      warehouse: null,
      balance: null,
      assignment: null,
    };
  }

  const vehicle = mapVehicle(vehRes.rows[0]);

  const whRes = await client.query(
    `SELECT id, name, location_type, purpose, active
       FROM warehouses WHERE id = $1`,
    [vehicle.warehouseId],
  );
  const warehouse = whRes.rows.length ? mapWarehouse(whRes.rows[0]) : null;
  const balance = warehouse ? await readBalance(client, warehouse.id) : null;

  const asgRes = await client.query(
    `SELECT id, vehicle_id, delivery_agent_id, status, assigned_at
       FROM distribution.vehicle_assignments
      WHERE vehicle_id = $1 AND status = 'active'
      ORDER BY id
      LIMIT 1`,
    [vehicle.id],
  );
  const assignment = asgRes.rows.length ? mapAssignment(asgRes.rows[0]) : null;

  let agent: PilotAgent | null = null;
  if (assignment) {
    const agRes = await client.query(
      `SELECT id, name FROM distribution.delivery_agents WHERE id = $1`,
      [assignment.deliveryAgentId],
    );
    if (agRes.rows.length) {
      agent = { id: Number(agRes.rows[0].id), name: agRes.rows[0].name };
    }
  }

  return {
    bootstrapped: true,
    agent,
    vehicle,
    warehouse,
    balance,
    assignment,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// F5 read models — pilot vehicle warehouse stock cards + stock movements.
//
// Both endpoints resolve the EXACT pilot server-side (agent NAVRUZBEK, vehicle
// DM-001 / DAMAS, and the vehicle warehouse whose identity matches every F2
// constant) with NO vehicle/warehouse input from the request. Unlike the F3/F4
// handoff paths, resolution here is SOFT: when the pilot is not bootstrapped (or
// any identity constant does not line up), we return a deterministic
// not-bootstrapped payload rather than throwing — and we NEVER fall back to a
// generic warehouse.
//
// Documented inventory-inclusion choice: stock cards surface ONLY nonzero
// inventory rows (quantity <> 0). This matches stock-card display semantics
// used elsewhere in the ERP (the balance summary counts SKUs with quantity<>0);
// there is no audit requirement here to show empty (zeroed-out) rows.
// ─────────────────────────────────────────────────────────────────────────────

export type PilotStockItem = {
  product: string;
  productName: string;
  productSku: string | null;
  quantity: number;
  weightKg: number;
  updatedAt: string | null;
};

export type PilotStockState = {
  bootstrapped: boolean;
  vehicle: PilotVehicle | null;
  warehouse: PilotWarehouse | null;
  items: PilotStockItem[];
  skuCount: number;
  totalQuantity: number;
  totalWeightKg: number;
};

export type PilotMovement = {
  id: number;
  product: string;
  quantity: number;
  weightKg: number | null;
  movementType: string;
  fromWarehouseId: number | null;
  fromWarehouseName: string | null;
  toWarehouseId: number | null;
  toWarehouseName: string | null;
  note: string | null;
  createdBy: string | null;
  reference: string | null;
  createdAt: string;
};

export type PilotMovementsState = {
  bootstrapped: boolean;
  vehicleWarehouseId: number | null;
  items: PilotMovement[];
  nextBeforeId: number | null;
};

const iso = (v: Date | string | null): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

/**
 * Soft-resolve the exact pilot vehicle + its expected vehicle warehouse.
 *
 * Returns null (never throws, never falls back) when the pilot is not
 * bootstrapped or any identity constant is off: no active NAVRUZBEK assignment,
 * wrong plate/type, or a warehouse that does not match every F2 constant
 * (active, location_type='vehicle', purpose='finished', exact name). This mirrors
 * the strict F3/F4 identity checks but degrades to not-bootstrapped instead of
 * raising a conflict, because F5 is a read model.
 */
async function resolvePilotSoft(
  client: PoolClient,
): Promise<{ vehicle: PilotVehicle; warehouse: PilotWarehouse } | null> {
  const { rows } = await client.query(
    `SELECT v.id            AS vehicle_id,
            v.plate_number,
            v.vehicle_type,
            v.status        AS vehicle_status,
            v.capacity_kg,
            v.warehouse_id,
            w.id            AS wh_id,
            w.name          AS wh_name,
            COALESCE(w.location_type,'general') AS wh_location_type,
            w.purpose       AS wh_purpose,
            w.active        AS wh_active
       FROM distribution.vehicle_assignments a
       JOIN distribution.vehicles v ON v.id = a.vehicle_id
       JOIN distribution.delivery_agents ag ON ag.id = a.delivery_agent_id
       JOIN warehouses w ON w.id = v.warehouse_id
      WHERE a.status = 'active'
        AND ag.faol = 1
        AND UPPER(TRIM(ag.name)) = UPPER(TRIM($1))
      ORDER BY a.id`,
    [PILOT_AGENT_NAME],
  );

  // Exactly one active pilot assignment with the exact identity; anything else
  // (zero, ambiguous, or a mismatch) degrades to not-bootstrapped.
  if (rows.length !== 1) return null;
  const r = rows[0];

  if (String(r.plate_number) !== PILOT_VEHICLE_PLATE) return null;
  if (String(r.vehicle_type) !== PILOT_VEHICLE_TYPE) return null;
  if (!r.wh_active) return null;
  if (String(r.wh_location_type) !== PILOT_WAREHOUSE_LOCATION_TYPE) return null;
  if (String(r.wh_purpose) !== PILOT_WAREHOUSE_PURPOSE) return null;
  if (String(r.wh_name) !== PILOT_WAREHOUSE_NAME) return null;

  const vehicle = mapVehicle({
    id: r.vehicle_id,
    plate_number: r.plate_number,
    vehicle_type: r.vehicle_type,
    status: r.vehicle_status,
    capacity_kg: r.capacity_kg,
    warehouse_id: r.warehouse_id,
  });
  const warehouse = mapWarehouse({
    id: r.wh_id,
    name: r.wh_name,
    location_type: r.wh_location_type,
    purpose: r.wh_purpose,
    active: r.wh_active,
  });
  return { vehicle, warehouse };
}

/**
 * Read the pilot vehicle warehouse stock cards. Read-only.
 *
 * Includes only nonzero-quantity inventory rows (documented choice), sorted by
 * product name, each enriched with the catalog product SKU when a matching
 * products row exists (productSku is null otherwise; it may also be an empty
 * string when the catalog row carries an empty SKU). Totals are computed from
 * the same nonzero row set so skuCount/totalQuantity/totalWeightKg agree with
 * the returned items exactly. When the pilot is not bootstrapped, returns a
 * deterministic empty payload with zeroed totals and null vehicle/warehouse.
 */
export async function readPilotStock(
  client: PoolClient,
): Promise<PilotStockState> {
  const resolved = await resolvePilotSoft(client);
  if (!resolved) {
    return {
      bootstrapped: false,
      vehicle: null,
      warehouse: null,
      items: [],
      skuCount: 0,
      totalQuantity: 0,
      totalWeightKg: 0,
    };
  }

  const { vehicle, warehouse } = resolved;

  // Only nonzero-quantity rows (stock-card semantics). LEFT JOIN products so a
  // raw inventory row without a catalog match still appears (productSku null).
  const { rows } = await client.query(
    `SELECT i.product           AS product,
            i.quantity          AS quantity,
            COALESCE(i.weight_kg, 0) AS weight_kg,
            i.updated_at        AS updated_at,
            p.sku               AS sku
       FROM inventory i
       LEFT JOIN products p ON p.name = i.product
      WHERE i.warehouse_id = $1
        AND i.quantity <> 0
      ORDER BY i.product`,
    [warehouse.id],
  );

  const items: PilotStockItem[] = rows.map((row) => ({
    product: String(row.product),
    productName: String(row.product),
    productSku: row.sku == null ? null : String(row.sku),
    quantity: Number(row.quantity),
    weightKg: Number(row.weight_kg),
    updatedAt: iso(row.updated_at),
  }));

  const skuCount = items.length;
  const totalQuantity = items.reduce((s, it) => s + it.quantity, 0);
  const totalWeightKg = items.reduce((s, it) => s + it.weightKg, 0);

  return {
    bootstrapped: true,
    vehicle,
    warehouse,
    items,
    skuCount,
    totalQuantity,
    totalWeightKg,
  };
}

/**
 * Read the pilot vehicle warehouse stock movements (audit history). Read-only.
 *
 * Returns only rows where the pilot vehicle warehouse is the from OR to
 * warehouse (never global movements or other-warehouse-only rows), ordered
 * deterministically by id DESC. Keyset-paginated: with an optional positive
 * `beforeId`, only movements with a strictly smaller id are returned; up to
 * `limit` rows come back plus `nextBeforeId` (the smallest returned id) when a
 * further page may exist, else null. When the pilot is not bootstrapped, returns
 * a deterministic empty payload.
 */
export async function readPilotMovements(
  client: PoolClient,
  opts: { limit: number; beforeId?: number },
): Promise<PilotMovementsState> {
  const resolved = await resolvePilotSoft(client);
  if (!resolved) {
    return {
      bootstrapped: false,
      vehicleWarehouseId: null,
      items: [],
      nextBeforeId: null,
    };
  }

  const whId = resolved.warehouse.id;
  const params: (number | undefined)[] = [whId];
  let cursorClause = "";
  if (opts.beforeId != null) {
    params.push(opts.beforeId);
    cursorClause = `AND m.id < $${params.length}`;
  }
  params.push(opts.limit);
  const limitParamIndex = params.length;

  const { rows } = await client.query(
    `SELECT m.id                AS id,
            m.product           AS product,
            m.quantity          AS quantity,
            m.weight_kg         AS weight_kg,
            m.movement_type     AS movement_type,
            m.from_warehouse_id AS from_warehouse_id,
            fw.name             AS from_warehouse_name,
            m.to_warehouse_id   AS to_warehouse_id,
            tw.name             AS to_warehouse_name,
            m.note              AS note,
            m.created_by        AS created_by,
            m.reference         AS reference,
            m.created_at        AS created_at
       FROM stock_movements m
       LEFT JOIN warehouses fw ON fw.id = m.from_warehouse_id
       LEFT JOIN warehouses tw ON tw.id = m.to_warehouse_id
      WHERE (m.from_warehouse_id = $1 OR m.to_warehouse_id = $1)
        ${cursorClause}
      ORDER BY m.id DESC
      LIMIT $${limitParamIndex}`,
    params,
  );

  const items: PilotMovement[] = rows.map((row) => ({
    id: Number(row.id),
    product: String(row.product),
    quantity: Number(row.quantity),
    weightKg: row.weight_kg == null ? null : Number(row.weight_kg),
    movementType: String(row.movement_type),
    fromWarehouseId:
      row.from_warehouse_id == null ? null : Number(row.from_warehouse_id),
    fromWarehouseName:
      row.from_warehouse_name == null ? null : String(row.from_warehouse_name),
    toWarehouseId:
      row.to_warehouse_id == null ? null : Number(row.to_warehouse_id),
    toWarehouseName:
      row.to_warehouse_name == null ? null : String(row.to_warehouse_name),
    note: row.note == null ? null : String(row.note),
    createdBy: row.created_by == null ? null : String(row.created_by),
    reference: row.reference == null ? null : String(row.reference),
    createdAt: iso(row.created_at) as string,
  }));

  // A further page may exist only when we filled the page exactly.
  const nextBeforeId =
    items.length === opts.limit && items.length > 0
      ? items[items.length - 1].id
      : null;

  return {
    bootstrapped: true,
    vehicleWarehouseId: whId,
    items,
    nextBeforeId,
  };
}

/** Find exactly one active delivery_agents row matching NAVRUZBEK
 *  (case-insensitive, trimmed). Throws PilotAgentError on zero/many. */
async function findPilotAgent(client: PoolClient): Promise<PilotAgent> {
  const { rows } = await client.query(
    `SELECT id, name
       FROM distribution.delivery_agents
      WHERE UPPER(TRIM(name)) = UPPER(TRIM($1))
        AND faol = 1
      ORDER BY id`,
    [PILOT_AGENT_NAME],
  );
  if (rows.length === 0) {
    throw new PilotAgentError(
      `No active delivery agent named ${PILOT_AGENT_NAME}`,
      0,
    );
  }
  if (rows.length > 1) {
    throw new PilotAgentError(
      `Ambiguous active delivery agents named ${PILOT_AGENT_NAME}`,
      rows.length,
    );
  }
  return { id: Number(rows[0].id), name: rows[0].name };
}

/**
 * Idempotently bootstrap the pilot inside a caller-managed transaction.
 *
 * The caller MUST have already:
 *   1. checked out a single client,
 *   2. issued BEGIN,
 *   3. taken pg_advisory_xact_lock(hashtext(PILOT_LOCK_KEY)).
 *
 * This function only performs the find/create/reuse logic and returns the
 * resulting state; the caller COMMITs (or ROLLBACKs on throw). Splitting it
 * this way keeps the advisory-lock + transaction lifecycle explicit in the
 * route and lets the test drive concurrency deterministically.
 *
 * Idempotency: every create is a "SELECT existing → INSERT if missing" guarded
 * by unique constraints (uq_vehicles_plate, uq_warehouses name, the partial
 * unique active-assignment indexes). Re-running returns the same rows.
 *
 * Never modifies the delivery_agents row.
 */
export async function bootstrapPilotInTx(client: PoolClient): Promise<PilotState> {
  const agent = await findPilotAgent(client);

  // ── 1. Warehouse (public.warehouses) — create or reuse by stable name ──────
  const existingWh = await client.query(
    `SELECT id, name, location_type, purpose, active
       FROM warehouses WHERE name = $1`,
    [PILOT_WAREHOUSE_NAME],
  );
  let warehouse: PilotWarehouse;
  if (existingWh.rows.length) {
    warehouse = mapWarehouse(existingWh.rows[0]);
    if (
      warehouse.locationType !== PILOT_WAREHOUSE_LOCATION_TYPE ||
      warehouse.purpose !== PILOT_WAREHOUSE_PURPOSE
    ) {
      throw new PilotConflictError(
        `Warehouse ${PILOT_WAREHOUSE_NAME} exists with conflicting location_type/purpose`,
      );
    }
  } else {
    const ins = await client.query(
      `INSERT INTO warehouses (name, active, location_type, purpose)
       VALUES ($1, TRUE, $2, $3)
       RETURNING id, name, location_type, purpose, active`,
      [PILOT_WAREHOUSE_NAME, PILOT_WAREHOUSE_LOCATION_TYPE, PILOT_WAREHOUSE_PURPOSE],
    );
    warehouse = mapWarehouse(ins.rows[0]);
  }

  // ── 2. Vehicle (distribution.vehicles) — create or reuse by plate ──────────
  const existingVeh = await client.query(
    `SELECT id, plate_number, vehicle_type, status, capacity_kg, warehouse_id
       FROM distribution.vehicles WHERE plate_number = $1`,
    [PILOT_VEHICLE_PLATE],
  );
  let vehicle: PilotVehicle;
  if (existingVeh.rows.length) {
    vehicle = mapVehicle(existingVeh.rows[0]);
    if (vehicle.vehicleType !== PILOT_VEHICLE_TYPE) {
      throw new PilotConflictError(
        `Vehicle ${PILOT_VEHICLE_PLATE} exists with conflicting type ${vehicle.vehicleType}`,
      );
    }
    if (vehicle.warehouseId !== warehouse.id) {
      throw new PilotConflictError(
        `Vehicle ${PILOT_VEHICLE_PLATE} is mapped to a different warehouse`,
      );
    }
  } else {
    // Do NOT specify capacity_kg — preserve the schema default (0). We never
    // fabricate a nonzero capacity for the pilot.
    const ins = await client.query(
      `INSERT INTO distribution.vehicles (plate_number, vehicle_type, warehouse_id)
       VALUES ($1, $2, $3)
       RETURNING id, plate_number, vehicle_type, status, capacity_kg, warehouse_id`,
      [PILOT_VEHICLE_PLATE, PILOT_VEHICLE_TYPE, warehouse.id],
    );
    vehicle = mapVehicle(ins.rows[0]);
  }

  // ── 3. Active assignment — create or reuse the exact one ───────────────────
  // Conflict cases:
  //   - vehicle already has an active assignment to a DIFFERENT agent
  //   - agent already has an active assignment on a DIFFERENT vehicle
  const activeForVehicle = await client.query(
    `SELECT id, vehicle_id, delivery_agent_id, status, assigned_at
       FROM distribution.vehicle_assignments
      WHERE vehicle_id = $1 AND status = 'active'
      ORDER BY id`,
    [vehicle.id],
  );
  if (activeForVehicle.rows.length) {
    const existing = mapAssignment(activeForVehicle.rows[0]);
    if (existing.deliveryAgentId !== agent.id) {
      throw new PilotConflictError(
        `Vehicle ${PILOT_VEHICLE_PLATE} already actively assigned to a different agent`,
      );
    }
    return {
      bootstrapped: true,
      agent,
      vehicle,
      warehouse,
      balance: await readBalance(client, warehouse.id),
      assignment: existing,
    };
  }

  const activeForAgent = await client.query(
    `SELECT id, vehicle_id, delivery_agent_id, status, assigned_at
       FROM distribution.vehicle_assignments
      WHERE delivery_agent_id = $1 AND status = 'active'
      ORDER BY id`,
    [agent.id],
  );
  if (activeForAgent.rows.length) {
    // Agent has an active assignment, but not on our vehicle (checked above).
    throw new PilotConflictError(
      `Agent ${PILOT_AGENT_NAME} already actively assigned to a different vehicle`,
    );
  }

  const insAsg = await client.query(
    `INSERT INTO distribution.vehicle_assignments
        (vehicle_id, delivery_agent_id, status)
     VALUES ($1, $2, 'active')
     RETURNING id, vehicle_id, delivery_agent_id, status, assigned_at`,
    [vehicle.id, agent.id],
  );
  const assignment = mapAssignment(insAsg.rows[0]);

  return {
    bootstrapped: true,
    agent,
    vehicle,
    warehouse,
    balance: await readBalance(client, warehouse.id),
    assignment,
  };
}
