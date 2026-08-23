// ─────────────────────────────────────────────────────────────────────────────
// F3 Vehicle Handoff — service layer (single TS writer for the domain)
//
// Pure DB logic for the prepared-handoff lifecycle. Kept out of the Express
// handlers so it can be driven directly against a throwaway Postgres.
//
// Lifecycle:
//   prepared → labels_printed → handed_over → stock_transferred (terminal)
//   any pre-terminal → cancelled (terminal)
//
// Invariants enforced here (never trust the request body for authority):
//   - agent / vehicle / vehicle-warehouse targets are resolved server-side from
//     the single active pilot assignment;
//   - the actor (type + ref) is passed in by the router (admin or warehouse_bot)
//     and stamped server-side;
//   - creation requires a client operationKey and is idempotent on it (same
//     payload → same handoff; mismatched payload on replay → 409 conflict);
//   - stock is ONLY moved on the handed_over → stock_transferred transition,
//     verifying the exact snapshot quantity + total weight are available with NO
//     GREATEST masking, and writing a stock_movements ledger row per item.
//   - a cross-handoff vehicle_label_claim per physical unit gates label printing
//     and loading (one claim per production_label_id, globally unique).
//
// All mutating operations take a per-handoff advisory lock plus row locks so
// concurrent transitions on the same handoff serialize, and concurrent
// finalizations contending for limited source stock cannot both succeed.
// ─────────────────────────────────────────────────────────────────────────────

import type { PoolClient } from "pg";
import {
  PILOT_AGENT_NAME,
  PILOT_VEHICLE_PLATE,
  PILOT_VEHICLE_TYPE,
  PILOT_WAREHOUSE_NAME,
  PILOT_WAREHOUSE_LOCATION_TYPE,
  PILOT_WAREHOUSE_PURPOSE,
  lockVehicleWarehouseStockMutation,
} from "./service";

/** Actor identity assigned server-side by the auth layer. Never from the body. */
export type HandoffActor = {
  /** 'admin' | 'warehouse_bot' */
  type: string;
  /** admin username, or the fixed bot name. */
  ref: string;
  /** Numeric id used for the vehicle_unit_events.actor_id BIGINT column. */
  actorId: number;
};

export type HandoffItemInput = { mahsulotId: number; quantity: number };
export type CreateHandoffInput = {
  sourceWarehouseId: number;
  items: HandoffItemInput[];
  notes: string | null;
  operationKey: string;
};

export type HandoffItem = {
  id: number;
  mahsulotId: number;
  sku: string;
  productName: string | null;
  quantity: number;
  unitWeightKg: number | null;
  totalWeightKg: number | null;
};

export type HandoffDetail = {
  id: number;
  vehicleId: number;
  deliveryAgentId: number;
  sourceWarehouseId: number;
  vehicleWarehouseId: number;
  handoffDate: string;
  status: string;
  operationKey: string | null;
  movementReference: string | null;
  preparedActorType: string | null;
  preparedActorRef: string | null;
  notes: string | null;
  labelsPrintedAt: string | null;
  handedOverAt: string | null;
  stockTransferredAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  items: HandoffItem[];
};

// ── Error taxonomy (mapped to HTTP by the router) ────────────────────────────

/** 404 — the requested handoff does not exist for the pilot vehicle. */
export class HandoffNotFoundError extends Error {
  constructor(message = "Handoff not found") {
    super(message);
    this.name = "HandoffNotFoundError";
  }
}

/** 409 — a conflicting state, idempotency mismatch, or invariant violation. */
export class HandoffConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffConflictError";
  }
}

/** 400 — a validation failure discovered server-side (bad source/product). */
export class HandoffValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffValidationError";
  }
}

/** Stable advisory-lock namespace, one key per handoff id. */
export function handoffLockKey(handoffId: number): string {
  return `vehicle_distribution:handoff:${handoffId}`;
}

// Advisory key for the create path — serialized on operationKey so concurrent
// double-clicks of the SAME creation resolve to one handoff.
function createLockKey(operationKey: string): string {
  return `vehicle_distribution:handoff:create:${operationKey}`;
}

const iso = (v: Date | string | null): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

// ── Pilot resolution (server-side authority) ─────────────────────────────────

type PilotTarget = {
  vehicleId: number;
  vehicleWarehouseId: number;
  deliveryAgentId: number;
};

/** Resolve the single active pilot assignment with strict identity checks.
 *
 *  Requirements (all must hold, fail-closed with HandoffConflictError):
 *    • Exactly one active assignment for the NAVRUZBEK agent (case-insensitive).
 *    • The assigned vehicle must be plate_number='DM-001' AND type='DAMAS'.
 *    • The vehicle's mapped warehouse must be:
 *        – active=TRUE
 *        – location_type='vehicle'  (matches PILOT_WAREHOUSE_LOCATION_TYPE)
 *        – purpose='finished'        (matches PILOT_WAREHOUSE_PURPOSE)
 *        – name=PILOT_WAREHOUSE_NAME (exact F2 identity)
 *  Any deviation (reassignment, different plate, different warehouse) throws,
 *  so reads and writes are always scoped to the exact bootstrapped pilot state. */
async function resolveActivePilot(client: PoolClient): Promise<PilotTarget> {
  const { rows } = await client.query(
    `SELECT v.id          AS vehicle_id,
            v.plate_number,
            v.vehicle_type,
            v.warehouse_id AS vehicle_warehouse_id,
            a.delivery_agent_id,
            w.name          AS warehouse_name,
            w.active        AS warehouse_active,
            COALESCE(w.location_type,'general') AS warehouse_location_type,
            w.purpose       AS warehouse_purpose
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

  if (rows.length === 0) {
    throw new HandoffConflictError(
      "No active pilot assignment — bootstrap the pilot first",
    );
  }
  if (rows.length > 1) {
    throw new HandoffConflictError(
      `Ambiguous active pilot assignment: ${rows.length} active assignments for agent ${PILOT_AGENT_NAME}`,
    );
  }

  const r = rows[0];

  // Strict vehicle identity: must be the exact F2 pilot vehicle.
  if (String(r.plate_number) !== PILOT_VEHICLE_PLATE) {
    throw new HandoffConflictError(
      `Pilot agent is assigned to wrong vehicle plate '${r.plate_number}' (expected '${PILOT_VEHICLE_PLATE}')`,
    );
  }
  if (String(r.vehicle_type) !== PILOT_VEHICLE_TYPE) {
    throw new HandoffConflictError(
      `Pilot vehicle has wrong type '${r.vehicle_type}' (expected '${PILOT_VEHICLE_TYPE}')`,
    );
  }

  // Strict warehouse identity: must match every F2 warehouse constant.
  if (!r.warehouse_active) {
    throw new HandoffConflictError(
      "Pilot vehicle's mapped warehouse is inactive",
    );
  }
  if (String(r.warehouse_location_type) !== PILOT_WAREHOUSE_LOCATION_TYPE) {
    throw new HandoffConflictError(
      `Pilot warehouse has wrong location_type '${r.warehouse_location_type}' (expected '${PILOT_WAREHOUSE_LOCATION_TYPE}')`,
    );
  }
  if (String(r.warehouse_purpose) !== PILOT_WAREHOUSE_PURPOSE) {
    throw new HandoffConflictError(
      `Pilot warehouse has wrong purpose '${r.warehouse_purpose}' (expected '${PILOT_WAREHOUSE_PURPOSE}')`,
    );
  }
  if (String(r.warehouse_name) !== PILOT_WAREHOUSE_NAME) {
    throw new HandoffConflictError(
      `Pilot warehouse has wrong name '${r.warehouse_name}' (expected '${PILOT_WAREHOUSE_NAME}')`,
    );
  }

  return {
    vehicleId: Number(r.vehicle_id),
    vehicleWarehouseId: Number(r.vehicle_warehouse_id),
    deliveryAgentId: Number(r.delivery_agent_id),
  };
}

// ── Read helpers ─────────────────────────────────────────────────────────────

async function readItems(
  client: PoolClient,
  handoffId: number,
): Promise<HandoffItem[]> {
  const { rows } = await client.query(
    `SELECT id, mahsulot_id, sku, product_name, quantity_dispatched,
            unit_weight_kg, total_weight_kg
       FROM distribution.vehicle_handoff_items
      WHERE handoff_id = $1
      ORDER BY id`,
    [handoffId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    mahsulotId: Number(r.mahsulot_id),
    sku: r.sku ?? "",
    productName: r.product_name ?? null,
    quantity: Number(r.quantity_dispatched),
    unitWeightKg: r.unit_weight_kg == null ? null : Number(r.unit_weight_kg),
    totalWeightKg: r.total_weight_kg == null ? null : Number(r.total_weight_kg),
  }));
}

function mapHandoffRow(row: Record<string, unknown>): Omit<HandoffDetail, "items"> {
  return {
    id: Number(row.id),
    vehicleId: Number(row.vehicle_id),
    deliveryAgentId: Number(row.delivery_agent_id),
    sourceWarehouseId: Number(row.source_warehouse_id),
    vehicleWarehouseId: Number(row.vehicle_warehouse_id),
    handoffDate: iso(row.handoff_date as Date | string) ?? String(row.handoff_date),
    status: String(row.status),
    operationKey: (row.operation_key as string | null) ?? null,
    movementReference: (row.movement_reference as string | null) ?? null,
    preparedActorType: (row.prepared_actor_type as string | null) ?? null,
    preparedActorRef: (row.prepared_actor_ref as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    labelsPrintedAt: iso(row.labels_printed_at as Date | string | null),
    handedOverAt: iso(row.handed_over_at as Date | string | null),
    stockTransferredAt: iso(row.stock_transferred_at as Date | string | null),
    cancelledAt: iso(row.cancelled_at as Date | string | null),
    createdAt: iso(row.created_at as Date | string) ?? String(row.created_at),
  };
}

const HANDOFF_COLUMNS = `id, vehicle_id, delivery_agent_id, source_warehouse_id,
  vehicle_warehouse_id, handoff_date, status, operation_key, movement_reference,
  prepared_actor_type, prepared_actor_ref, notes, labels_printed_at,
  handed_over_at, stock_transferred_at, cancelled_at, created_at`;

/** Load a single handoff and scope it to the exact active pilot vehicle.
 *
 *  NEVER suppresses pilot resolution failure: if the pilot is in a bad state
 *  (reassigned, wrong vehicle/warehouse) the resolution error propagates so
 *  callers get a 409 rather than a spurious 404. Only returns null when the
 *  handoff row itself doesn't exist or belongs to a different vehicle. */
async function loadHandoffDetail(
  client: PoolClient,
  handoffId: number,
): Promise<HandoffDetail | null> {
  // resolveActivePilot throws HandoffConflictError on any identity mismatch;
  // that propagates out — we never swallow it.
  const pilot = await resolveActivePilot(client);
  const { rows } = await client.query(
    `SELECT ${HANDOFF_COLUMNS} FROM distribution.vehicle_handoffs
      WHERE id = $1 AND vehicle_id = $2`,
    [handoffId, pilot.vehicleId],
  );
  if (!rows.length) return null;
  const items = await readItems(client, handoffId);
  return { ...mapHandoffRow(rows[0]), items };
}

/** Public read: single handoff for the pilot vehicle. */
export async function getHandoff(
  client: PoolClient,
  handoffId: number,
): Promise<HandoffDetail> {
  const detail = await loadHandoffDetail(client, handoffId);
  if (!detail) throw new HandoffNotFoundError();
  return detail;
}

/** Public read: all handoffs for the pilot vehicle (newest first). */
export async function listHandoffs(
  client: PoolClient,
): Promise<{ vehicleId: number; handoffs: HandoffDetail[] }> {
  const pilot = await resolveActivePilot(client);
  const { rows } = await client.query(
    `SELECT ${HANDOFF_COLUMNS} FROM distribution.vehicle_handoffs
      WHERE vehicle_id = $1
      ORDER BY id DESC`,
    [pilot.vehicleId],
  );
  const handoffs: HandoffDetail[] = [];
  for (const row of rows) {
    const items = await readItems(client, Number(row.id));
    handoffs.push({ ...mapHandoffRow(row), items });
  }
  return { vehicleId: pilot.vehicleId, handoffs };
}

// ── Create prepared handoff ──────────────────────────────────────────────────

type ResolvedItem = {
  mahsulotId: number;
  sku: string;
  productName: string;
  unitWeightKg: number;
  quantity: number;
  totalWeightKg: number;
};

/** Resolve one distribution product + its unique public.products SKU mapping.
 *  Snapshots the public product name, sku and positive per-unit weight. */
async function resolveItem(
  client: PoolClient,
  input: HandoffItemInput,
): Promise<ResolvedItem> {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new HandoffValidationError(
      `Item quantity must be a positive integer (mahsulotId=${input.mahsulotId})`,
    );
  }
  // Exactly one active distribution product with a nonempty SKU.
  const dp = await client.query(
    `SELECT id, sku FROM distribution.mahsulotlar
      WHERE id = $1 AND faol = 1 AND COALESCE(sku, '') <> ''`,
    [input.mahsulotId],
  );
  if (dp.rows.length !== 1) {
    throw new HandoffValidationError(
      `Distribution product ${input.mahsulotId} is not active or has no SKU`,
    );
  }
  const sku = String(dp.rows[0].sku);
  // Exactly one active public product mapped by that SKU.
  const pp = await client.query(
    `SELECT name, sku, weight FROM products
      WHERE sku = $1 AND active = TRUE`,
    [sku],
  );
  if (pp.rows.length !== 1) {
    throw new HandoffValidationError(
      `SKU ${sku} does not map to exactly one active public product`,
    );
  }
  const productName = String(pp.rows[0].name);
  const unitWeightKg = Number(pp.rows[0].weight);
  if (!(unitWeightKg > 0)) {
    throw new HandoffValidationError(
      `Public product ${productName} has a non-positive weight`,
    );
  }
  const totalWeightKg =
    Math.round(unitWeightKg * input.quantity * 1000) / 1000;
  return {
    mahsulotId: input.mahsulotId,
    sku,
    productName,
    unitWeightKg,
    quantity: input.quantity,
    totalWeightKg,
  };
}

/** Compare a prior handoff (idempotent replay) against the requested payload. */
function replayMatches(
  existing: HandoffDetail,
  input: CreateHandoffInput,
  pilot: PilotTarget,
): boolean {
  if (existing.sourceWarehouseId !== input.sourceWarehouseId) return false;
  if (existing.vehicleId !== pilot.vehicleId) return false;
  if ((existing.notes ?? null) !== (input.notes ?? null)) return false;
  if (existing.items.length !== input.items.length) return false;
  const want = new Map<number, number>();
  for (const it of input.items) want.set(it.mahsulotId, it.quantity);
  for (const it of existing.items) {
    if (want.get(it.mahsulotId) !== it.quantity) return false;
  }
  return true;
}

/**
 * Create a prepared handoff idempotently on operationKey.
 *
 * Caller must have opened a transaction. This function takes an advisory lock
 * on the operationKey so concurrent double-clicks serialize, resolves the pilot
 * target + all items server-side, and inserts the handoff + aggregate items. No
 * inventory is mutated. Replaying the same operationKey returns the existing
 * handoff; a payload mismatch on replay throws HandoffConflictError (409).
 */
export async function createHandoffInTx(
  client: PoolClient,
  input: CreateHandoffInput,
  actor: HandoffActor,
): Promise<HandoffDetail> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    createLockKey(input.operationKey),
  ]);

  // Idempotency: existing handoff for this operationKey?
  const existingRes = await client.query(
    `SELECT id FROM distribution.vehicle_handoffs WHERE operation_key = $1`,
    [input.operationKey],
  );
  if (existingRes.rows.length) {
    const existing = await loadHandoffDetail(
      client,
      Number(existingRes.rows[0].id),
    );
    if (!existing) {
      // Belongs to a different vehicle — treat as a hard conflict.
      throw new HandoffConflictError(
        "operationKey already used by another vehicle's handoff",
      );
    }
    const pilot = await resolveActivePilot(client);
    if (!replayMatches(existing, input, pilot)) {
      throw new HandoffConflictError(
        "operationKey replay with a different payload",
      );
    }
    return existing;
  }

  const pilot = await resolveActivePilot(client);

  // Source warehouse must be active, non-vehicle, purpose='finished'.
  const srcRes = await client.query(
    `SELECT id, active, COALESCE(location_type,'general') AS location_type, purpose
       FROM warehouses WHERE id = $1`,
    [input.sourceWarehouseId],
  );
  if (!srcRes.rows.length) {
    throw new HandoffValidationError("Source warehouse not found");
  }
  const src = srcRes.rows[0];
  if (
    src.active !== true ||
    src.location_type === "vehicle" ||
    src.purpose !== "finished"
  ) {
    throw new HandoffValidationError(
      "Source warehouse must be active, non-vehicle and purpose=finished",
    );
  }

  // Reject duplicate product ids up front.
  const seen = new Set<number>();
  for (const it of input.items) {
    if (seen.has(it.mahsulotId)) {
      throw new HandoffValidationError(
        `Duplicate product id ${it.mahsulotId} in items`,
      );
    }
    seen.add(it.mahsulotId);
  }

  const resolved: ResolvedItem[] = [];
  for (const it of input.items) {
    resolved.push(await resolveItem(client, it));
  }

  const ins = await client.query(
    `INSERT INTO distribution.vehicle_handoffs
       (vehicle_id, delivery_agent_id, source_warehouse_id, vehicle_warehouse_id,
        handoff_date, status, operation_key, prepared_actor_type, prepared_actor_ref, notes)
     VALUES ($1, $2, $3, $4, CURRENT_DATE, 'prepared', $5, $6, $7, $8)
     RETURNING ${HANDOFF_COLUMNS}`,
    [
      pilot.vehicleId,
      pilot.deliveryAgentId,
      input.sourceWarehouseId,
      pilot.vehicleWarehouseId,
      input.operationKey,
      actor.type,
      actor.ref,
      input.notes,
    ],
  );
  const handoffId = Number(ins.rows[0].id);

  for (const r of resolved) {
    await client.query(
      `INSERT INTO distribution.vehicle_handoff_items
         (handoff_id, mahsulot_id, sku, quantity_dispatched, product_name,
          unit_weight_kg, total_weight_kg)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        handoffId,
        r.mahsulotId,
        r.sku,
        r.quantity,
        r.productName,
        r.unitWeightKg,
        r.totalWeightKg,
      ],
    );
  }

  const items = await readItems(client, handoffId);
  return { ...mapHandoffRow(ins.rows[0]), items };
}

// ── Transition: lock + fetch the handoff row FOR UPDATE ──────────────────────

async function lockHandoff(
  client: PoolClient,
  handoffId: number,
): Promise<Record<string, unknown>> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    handoffLockKey(handoffId),
  ]);
  const { rows } = await client.query(
    `SELECT ${HANDOFF_COLUMNS} FROM distribution.vehicle_handoffs
      WHERE id = $1 FOR UPDATE`,
    [handoffId],
  );
  if (!rows.length) throw new HandoffNotFoundError();
  return rows[0];
}

/** Ensure a locked handoff belongs to the exact active pilot vehicle. */
async function assertPilotOwnership(
  client: PoolClient,
  row: Record<string, unknown>,
): Promise<PilotTarget> {
  const pilot = await resolveActivePilot(client);
  if (Number(row.vehicle_id) !== pilot.vehicleId) {
    throw new HandoffNotFoundError();
  }
  return pilot;
}

// NOTE: F4 owns the prepared→labels_printed transition through the label
// service (confirmLabelsPrintedInTx in ./label-service). The old F3 confirm
// path that required pre-seeded claims has been removed; there is exactly one
// confirmation path now.

// ── handed-over: labels_printed → handed_over ────────────────────────────────

export async function markHandedOverInTx(
  client: PoolClient,
  handoffId: number,
  actor: HandoffActor,
): Promise<HandoffDetail> {
  const row = await lockHandoff(client, handoffId);
  await assertPilotOwnership(client, row);
  const status = String(row.status);

  if (status === "handed_over") {
    return (await loadHandoffDetail(client, handoffId))!;
  }
  if (status !== "labels_printed") {
    throw new HandoffConflictError(
      `Cannot hand over from status '${status}'`,
    );
  }

  await client.query(
    `UPDATE distribution.vehicle_handoffs
        SET status = 'handed_over',
            handed_over_at = NOW(),
            handed_over_by = $2
      WHERE id = $1`,
    [handoffId, actor.actorId],
  );
  return (await loadHandoffDetail(client, handoffId))!;
}

// ── stock-transferred: handed_over → stock_transferred (moves inventory) ─────

export async function markStockTransferredInTx(
  client: PoolClient,
  handoffId: number,
  actor: HandoffActor,
): Promise<HandoffDetail> {
  // PRE-READ only identifies the warehouse parents. Parent locks must precede
  // the handoff/request row locks so F8 approval/cancellation and F7 auto-create
  // use the same global lock order.
  const pre = await client.query(
    `SELECT source_warehouse_id, vehicle_warehouse_id
       FROM distribution.vehicle_handoffs WHERE id=$1`,
    [handoffId],
  );
  if (!pre.rows.length) throw new HandoffNotFoundError();
  const parentIds = [
    Number(pre.rows[0].source_warehouse_id),
    Number(pre.rows[0].vehicle_warehouse_id),
  ].sort((a, b) => a - b);
  const lockedParents = await client.query(
    `SELECT id FROM public.warehouses
      WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE`,
    [parentIds],
  );
  if (lockedParents.rows.length !== new Set(parentIds).size) {
    throw new HandoffConflictError("Handoff warehouse parent is missing");
  }
  const row = await lockHandoff(client, handoffId);
  const pilot = await assertPilotOwnership(client, row);
  const status = String(row.status);

  if (status === "stock_transferred") {
    return (await loadHandoffDetail(client, handoffId))!;
  }
  if (status !== "handed_over") {
    throw new HandoffConflictError(
      `Cannot transfer stock from status '${status}'`,
    );
  }

  const sourceWarehouseId = Number(row.source_warehouse_id);
  const vehicleWarehouseId = Number(row.vehicle_warehouse_id);
  const vehicleId = Number(row.vehicle_id);

  const items = await readItems(client, handoffId);
  if (!items.length) {
    throw new HandoffConflictError("Handoff has no items to transfer");
  }

  // Shared parent-row lock serializes the complete vehicle inventory row set,
  // including inserts for SKUs which do not have an inventory row yet.
  await lockVehicleWarehouseStockMutation(client, vehicleWarehouseId);

  // Revalidate: every claim for every item must be in 'printed' status.
  for (const it of items) {
    const { rows: claims } = await client.query(
      `SELECT id, status FROM distribution.vehicle_label_claims
        WHERE handoff_item_id = $1 ORDER BY id FOR UPDATE`,
      [it.id],
    );
    if (claims.length !== it.quantity) {
      throw new HandoffConflictError(
        `Item ${it.id} requires ${it.quantity} printed claim(s) but found ${claims.length}`,
      );
    }
    for (const c of claims) {
      if (String(c.status) !== "printed") {
        throw new HandoffConflictError(
          `Label claim ${c.id} is not in 'printed' status`,
        );
      }
    }
  }

  // Fully deterministic movement reference — no timestamps or random components
  // so the reference is stable across retries and can be asserted in tests.
  const movementReference = `vehicle-handoff:${handoffId}:stock-transferred`;

  // Lock the source + vehicle inventory rows for every product in a
  // deterministic order (sorted by product name) to avoid deadlocks between
  // concurrent finalizations.
  const products = items.map((i) => i.productName!).sort();
  for (const product of products) {
    // Lock both warehouse rows for this product (source first, then vehicle),
    // deterministically ordered by warehouse id at the same product.
    await client.query(
      `SELECT id FROM inventory
        WHERE product = $1 AND warehouse_id IN ($2, $3)
        ORDER BY warehouse_id
        FOR UPDATE`,
      [product, Math.min(sourceWarehouseId, vehicleWarehouseId), Math.max(sourceWarehouseId, vehicleWarehouseId)],
    );
  }

  for (const it of items) {
    const product = it.productName!;
    const qty = it.quantity;
    const totalWeight = it.totalWeightKg ?? 0;

    // Verify EXACT snapshot quantity + total weight are available. No GREATEST.
    const { rows: srcRows } = await client.query(
      `SELECT quantity, weight_kg FROM inventory
        WHERE warehouse_id = $1 AND product = $2 FOR UPDATE`,
      [sourceWarehouseId, product],
    );
    const haveQty = srcRows.length ? Number(srcRows[0].quantity) : 0;
    const haveWeight = srcRows.length ? Number(srcRows[0].weight_kg) : 0;
    if (haveQty < qty) {
      throw new HandoffConflictError(
        `Insufficient quantity for ${product}: need ${qty}, have ${haveQty}`,
      );
    }
    if (haveWeight + 1e-9 < totalWeight) {
      throw new HandoffConflictError(
        `Insufficient weight for ${product}: need ${totalWeight}, have ${haveWeight}`,
      );
    }

    // Subtract from source (exact, no masking) …
    await client.query(
      `UPDATE inventory
          SET quantity = quantity - $3,
              weight_kg = weight_kg - $4,
              updated_at = NOW()
        WHERE warehouse_id = $1 AND product = $2`,
      [sourceWarehouseId, product, qty, totalWeight],
    );

    // … and add to the vehicle warehouse (upsert).
    await client.query(
      `INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type)
       VALUES ($1, $2, $3, $4, 'finished')
       ON CONFLICT (warehouse_id, product)
       DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity,
                     weight_kg = inventory.weight_kg + EXCLUDED.weight_kg,
                     updated_at = NOW()`,
      [vehicleWarehouseId, product, qty, totalWeight],
    );

    // One ledger row per item.
    // reference: deterministic stable key for this exact item transfer
    //   vehicle-handoff:<handoffId>:item:<itemId>
    // note: human-readable audit trail
    const itemRef = `vehicle-handoff:${handoffId}:item:${it.id}`;
    const itemNote = `Vehicle handoff ${handoffId} — ${product} (${qty} units, ${totalWeight} kg) from warehouse ${sourceWarehouseId} to vehicle warehouse ${vehicleWarehouseId}`;
    await client.query(
      `INSERT INTO stock_movements
         (product, quantity, movement_type, from_warehouse_id, to_warehouse_id,
          note, created_by, product_type, weight_kg, reference)
       VALUES ($1, $2, 'TRANSFER', $3, $4, $5, $6, 'finished', $7, $8)`,
      [
        product,
        qty,
        sourceWarehouseId,
        vehicleWarehouseId,
        itemNote,
        actor.ref,
        totalWeight,
        itemRef,
      ],
    );

    // Mark this item's claims loaded + insert idempotent load unit events.
    const { rows: claims } = await client.query(
      `SELECT id, production_label_id, barcode FROM distribution.vehicle_label_claims
        WHERE handoff_item_id = $1 ORDER BY id`,
      [it.id],
    );
    for (const c of claims) {
      await client.query(
        `UPDATE distribution.vehicle_label_claims
            SET status = 'loaded', updated_at = NOW()
          WHERE id = $1`,
        [c.id],
      );
      const opKey = `load:${handoffId}:${c.id}`;
      await client.query(
        `INSERT INTO distribution.vehicle_unit_events
           (vehicle_id, handoff_id, handoff_item_id, mahsulot_id, sku, event_type,
            quantity, actor_id, production_label_id, barcode, label_claim_id, operation_key)
         VALUES ($1, $2, $3, $4, $5, 'load', 1, $6, $7, $8, $9, $10)
         ON CONFLICT (operation_key) WHERE operation_key IS NOT NULL DO NOTHING`,
        [
          vehicleId,
          handoffId,
          it.id,
          it.mahsulotId,
          it.sku,
          actor.actorId,
          c.production_label_id,
          c.barcode,
          c.id,
          opKey,
        ],
      );
    }
  }

  await client.query(
    `UPDATE distribution.vehicle_handoffs
        SET status = 'stock_transferred',
            stock_transferred_at = NOW(),
            stock_transferred_by = $2,
            movement_reference = $3
      WHERE id = $1`,
    [handoffId, actor.actorId, movementReference],
  );

  // F8 lifecycle hook. A linked request is optional for ordinary F3 handoffs,
  // but when present it must be the unique approved request and exactly match
  // this one-item handoff. Any malformed linkage aborts the entire stock move.
  const linked = await client.query(
    `SELECT r.id,r.status,r.requested_quantity,r.mahsulot_id,
            (SELECT COUNT(*)::int FROM distribution.vehicle_handoff_items hi
              WHERE hi.handoff_id=r.handoff_id) item_count,
            (SELECT MIN(hi.mahsulot_id)::int FROM distribution.vehicle_handoff_items hi
              WHERE hi.handoff_id=r.handoff_id) item_mahsulot_id,
            (SELECT MIN(hi.quantity_dispatched) FROM distribution.vehicle_handoff_items hi
              WHERE hi.handoff_id=r.handoff_id) item_quantity
       FROM distribution.vehicle_replenishment_requests r
      WHERE r.handoff_id=$1
      FOR UPDATE OF r`,
    [handoffId],
  );
  if (linked.rows.length > 1) {
    throw new HandoffConflictError("Multiple replenishment requests link this handoff");
  }
  if (linked.rows.length === 1) {
    const request = linked.rows[0];
    if (
      String(request.status) !== "approved" ||
      Number(request.item_count) !== 1 ||
      Number(request.item_mahsulot_id) !== Number(request.mahsulot_id) ||
      Number(request.item_quantity) !== Number(request.requested_quantity)
    ) {
      throw new HandoffConflictError(
        "Linked replenishment request is not a valid approved full-quantity linkage",
      );
    }
    await client.query(
      `UPDATE distribution.vehicle_replenishment_requests
          SET status='fulfilled',fulfilled_at=NOW(),resolved_at=NOW()
        WHERE id=$1 AND status='approved'`,
      [request.id],
    );
  }

  return (await loadHandoffDetail(client, handoffId))!;
}

// ── cancel: any pre-terminal → cancelled ─────────────────────────────────────

export async function cancelHandoffInTx(
  client: PoolClient,
  handoffId: number,
  actor: HandoffActor,
): Promise<HandoffDetail> {
  const row = await lockHandoff(client, handoffId);
  await assertPilotOwnership(client, row);
  const status = String(row.status);

  if (status === "cancelled") {
    return (await loadHandoffDetail(client, handoffId))!;
  }
  if (status === "stock_transferred") {
    throw new HandoffConflictError(
      "Cannot cancel a handoff after stock has been transferred",
    );
  }
  // prepared | labels_printed | handed_over → cancelled. No stock mutation.
  await client.query(
    `UPDATE distribution.vehicle_handoffs
        SET status = 'cancelled',
            cancelled_at = NOW(),
            cancelled_by = $2
      WHERE id = $1`,
    [handoffId, actor.actorId],
  );
  return (await loadHandoffDetail(client, handoffId))!;
}
