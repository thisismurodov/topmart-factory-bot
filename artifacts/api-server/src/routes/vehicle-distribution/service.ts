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
