import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  PILOT_AGENT_NAME,
  PILOT_VEHICLE_PLATE,
  PILOT_VEHICLE_TYPE,
  PILOT_WAREHOUSE_LOCATION_TYPE,
  PILOT_WAREHOUSE_NAME,
  PILOT_WAREHOUSE_PURPOSE,
} from "./service";
import {
  cancelHandoffInTx,
  createHandoffInTx,
  HandoffConflictError,
  HandoffValidationError,
  type HandoffActor,
} from "./handoff-service";

export class ReplenishmentNotFoundError extends Error {}
export class ReplenishmentValidationError extends Error {}
export class ReplenishmentConflictError extends Error {}

type Pilot = { vehicleId: number; warehouseId: number; agentId: number };
type Product = {
  mahsulotId: number;
  publicProductId: number;
  productName: string;
  sku: string;
  unitWeight: number;
};

const iso = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);
const dateOnly = (v: unknown): string => (iso(v) ?? "").slice(0, 10);
const numberOrNull = (v: unknown): number | null =>
  v == null ? null : Number(v);
const fingerprint = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function resolvePilot(client: PoolClient): Promise<Pilot> {
  const { rows } = await client.query(
    `SELECT v.id vehicle_id, v.plate_number, v.vehicle_type,
            v.warehouse_id, a.delivery_agent_id, w.name, w.active,
            COALESCE(w.location_type,'general') location_type, w.purpose
       FROM distribution.vehicle_assignments a
       JOIN distribution.vehicles v ON v.id=a.vehicle_id
       JOIN distribution.delivery_agents ag ON ag.id=a.delivery_agent_id
       JOIN public.warehouses w ON w.id=v.warehouse_id
      WHERE a.status='active' AND ag.faol=1
        AND UPPER(TRIM(ag.name))=UPPER(TRIM($1))
      ORDER BY a.id`,
    [PILOT_AGENT_NAME],
  );
  if (
    rows.length !== 1 ||
    String(rows[0].plate_number) !== PILOT_VEHICLE_PLATE ||
    String(rows[0].vehicle_type) !== PILOT_VEHICLE_TYPE ||
    rows[0].active !== true ||
    String(rows[0].location_type) !== PILOT_WAREHOUSE_LOCATION_TYPE ||
    String(rows[0].purpose) !== PILOT_WAREHOUSE_PURPOSE ||
    String(rows[0].name) !== PILOT_WAREHOUSE_NAME
  ) {
    throw new ReplenishmentNotFoundError("Exact pilot not found");
  }
  return {
    vehicleId: Number(rows[0].vehicle_id),
    warehouseId: Number(rows[0].warehouse_id),
    agentId: Number(rows[0].delivery_agent_id),
  };
}

async function resolveProduct(client: PoolClient, mahsulotId: number): Promise<Product> {
  const { rows } = await client.query(
    `SELECT m.id mahsulot_id, m.sku, p.id public_product_id,
            p.name product_name, p.weight unit_weight
       FROM distribution.mahsulotlar m
       JOIN public.products p ON p.sku=m.sku AND p.active=TRUE
      WHERE m.id=$1 AND m.faol=1 AND COALESCE(m.sku,'')<>''
      ORDER BY p.id`,
    [mahsulotId],
  );
  if (rows.length !== 1)
    throw new ReplenishmentValidationError(
      "mahsulotId must map to exactly one active canonical public product",
    );
  const unitWeight = Number(rows[0].unit_weight);
  if (!(unitWeight > 0))
    throw new ReplenishmentValidationError("Canonical product weight must be positive");
  return {
    mahsulotId: Number(rows[0].mahsulot_id),
    publicProductId: Number(rows[0].public_product_id),
    productName: String(rows[0].product_name),
    sku: String(rows[0].sku),
    unitWeight,
  };
}

async function lockParents(client: PoolClient, ids: number[]): Promise<void> {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const { rows } = await client.query(
    `SELECT id FROM public.warehouses WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE`,
    [sorted],
  );
  if (rows.length !== sorted.length)
    throw new ReplenishmentConflictError("Warehouse parent disappeared");
}

function mapTarget(r: Record<string, unknown>) {
  const current = Number(r.current_quantity ?? 0);
  const min = Number(r.min_quantity);
  const target = Number(r.target_quantity);
  return {
    id: Number(r.id),
    vehicleId: Number(r.vehicle_id),
    mahsulotId: Number(r.mahsulot_id),
    publicProductId: Number(r.public_product_id),
    productName: String(r.product_name),
    sku: String(r.sku),
    minQuantity: min,
    targetQuantity: target,
    currentQuantity: current,
    deficitQuantity: Math.max(0, target - current),
    low: current <= min && target - current > 0,
    effectiveFrom: dateOnly(r.effective_from),
    effectiveTo: r.effective_to == null ? null : dateOnly(r.effective_to),
    operationKey: r.operation_key == null ? null : String(r.operation_key),
    actorType: r.actor_type == null ? null : String(r.actor_type),
    actorRef: r.actor_ref == null ? null : String(r.actor_ref),
    createdAt: iso(r.created_at)!,
  };
}

export async function listStockTargets(client: PoolClient) {
  const pilot = await resolvePilot(client);
  const { rows } = await client.query(
    `SELECT t.*, COALESCE(i.quantity,0) current_quantity
       FROM distribution.vehicle_stock_targets t
       LEFT JOIN public.inventory i
         ON i.warehouse_id=$2 AND i.product=t.product_name
      WHERE t.vehicle_id=$1
      ORDER BY t.public_product_id,t.effective_from DESC,t.id DESC`,
    [pilot.vehicleId, pilot.warehouseId],
  );
  return { vehicleId: pilot.vehicleId, warehouseId: pilot.warehouseId, targets: rows.map(mapTarget) };
}

export async function replaceStockTargetInTx(
  client: PoolClient,
  input: {
    mahsulotId: number;
    minQuantity: number;
    targetQuantity: number;
    operationKey: string;
    effectiveFrom?: string;
  },
  actor: HandoffActor,
) {
  if (
    !Number.isInteger(input.minQuantity) ||
    input.minQuantity < 0 ||
    !Number.isInteger(input.targetQuantity) ||
    input.targetQuantity <= 0 ||
    input.minQuantity > input.targetQuantity
  )
    throw new ReplenishmentValidationError(
      "Require whole units with 0 <= minQuantity <= targetQuantity and targetQuantity > 0",
    );
  const pilot = await resolvePilot(client);
  await lockParents(client, [pilot.warehouseId]);
  const product = await resolveProduct(client, input.mahsulotId);
  const inventory = await client.query(
    `SELECT quantity FROM public.inventory
      WHERE warehouse_id=$1 AND product=$2`,
    [pilot.warehouseId, product.productName],
  );
  const currentQuantity = inventory.rows.length
    ? Number(inventory.rows[0].quantity)
    : 0;
  const effectiveFrom = input.effectiveFrom ?? new Date().toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  if (effectiveFrom < today)
    throw new ReplenishmentValidationError("effectiveFrom cannot be backdated");

  const replay = await client.query(
    `SELECT * FROM distribution.vehicle_stock_targets WHERE operation_key=$1`,
    [input.operationKey],
  );
  if (replay.rows.length) {
    const r = replay.rows[0];
    if (
      Number(r.vehicle_id) !== pilot.vehicleId ||
      Number(r.public_product_id) !== product.publicProductId ||
      Number(r.min_quantity) !== input.minQuantity ||
      Number(r.target_quantity) !== input.targetQuantity ||
      dateOnly(r.effective_from) !== effectiveFrom
    )
      throw new ReplenishmentConflictError("operationKey replay with different target payload");
    return mapTarget({ ...r, current_quantity: currentQuantity });
  }
  const openRequest = await client.query(
    `SELECT id FROM distribution.vehicle_replenishment_requests
      WHERE vehicle_id=$1 AND public_product_id=$2
        AND status IN ('pending','approved') FOR UPDATE`,
    [pilot.vehicleId, product.publicProductId],
  );
  if (openRequest.rows.length)
    throw new ReplenishmentConflictError(
      "Cannot change target while a pending or approved request exists",
    );
  const current = await client.query(
    `SELECT * FROM distribution.vehicle_stock_targets
      WHERE vehicle_id=$1 AND public_product_id=$2 AND effective_to IS NULL
      FOR UPDATE`,
    [pilot.vehicleId, product.publicProductId],
  );
  if (current.rows.length && dateOnly(current.rows[0].effective_from) >= effectiveFrom)
    throw new ReplenishmentConflictError("New target effective date overlaps current history");
  if (current.rows.length) {
    await client.query(
      `UPDATE distribution.vehicle_stock_targets
          SET effective_to=$2::date-1
        WHERE id=$1`,
      [current.rows[0].id, effectiveFrom],
    );
  }
  const { rows } = await client.query(
    `INSERT INTO distribution.vehicle_stock_targets
      (vehicle_id,mahsulot_id,public_product_id,product_name,sku,target_quantity,
       min_quantity,effective_from,operation_key,actor_type,actor_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      pilot.vehicleId, product.mahsulotId, product.publicProductId,
      product.productName, product.sku, input.targetQuantity, input.minQuantity,
      effectiveFrom, input.operationKey, actor.type, actor.ref,
    ],
  );
  return mapTarget({ ...rows[0], current_quantity: currentQuantity });
}

function mapRequest(r: Record<string, unknown>) {
  return {
    id: Number(r.id),
    vehicleId: Number(r.vehicle_id),
    requestedBy: Number(r.requested_by),
    mahsulotId: Number(r.mahsulot_id),
    publicProductId: Number(r.public_product_id),
    productName: String(r.product_name),
    sku: String(r.sku),
    requestedQuantity: Number(r.requested_quantity),
    approvedQuantity: numberOrNull(r.approved_quantity),
    targetQuantitySnapshot: Number(r.target_quantity_snapshot),
    currentQuantitySnapshot: Number(r.current_quantity_snapshot),
    sourceWarehouseId: numberOrNull(r.source_warehouse_id),
    handoffId: numberOrNull(r.handoff_id),
    handoffStatus: r.handoff_status == null ? null : String(r.handoff_status),
    operationKey: r.operation_key == null ? null : String(r.operation_key),
    status: String(r.status),
    requestedAt: iso(r.requested_at)!,
    resolvedAt: iso(r.resolved_at),
    approvedBy: numberOrNull(r.approved_by),
    approvedAt: iso(r.approved_at),
    cancelledBy: numberOrNull(r.cancelled_by),
    cancelledAt: iso(r.cancelled_at),
    fulfilledAt: iso(r.fulfilled_at),
    notes: r.notes == null ? null : String(r.notes),
    createdAt: iso(r.created_at)!,
  };
}

const REQUEST_SELECT = `r.*, h.status handoff_status`;
async function loadRequest(client: PoolClient, id: number, vehicleId: number) {
  const { rows } = await client.query(
    `SELECT ${REQUEST_SELECT}
       FROM distribution.vehicle_replenishment_requests r
       LEFT JOIN distribution.vehicle_handoffs h ON h.id=r.handoff_id
      WHERE r.id=$1 AND r.vehicle_id=$2`,
    [id, vehicleId],
  );
  if (!rows.length) throw new ReplenishmentNotFoundError("Replenishment request not found");
  return mapRequest(rows[0]);
}

export async function listReplenishmentRequests(client: PoolClient) {
  const pilot = await resolvePilot(client);
  const { rows } = await client.query(
    `SELECT ${REQUEST_SELECT}
       FROM distribution.vehicle_replenishment_requests r
       LEFT JOIN distribution.vehicle_handoffs h ON h.id=r.handoff_id
      WHERE r.vehicle_id=$1 ORDER BY r.id DESC`,
    [pilot.vehicleId],
  );
  return { vehicleId: pilot.vehicleId, requests: rows.map(mapRequest) };
}

export async function getReplenishmentRequest(client: PoolClient, id: number) {
  const pilot = await resolvePilot(client);
  return loadRequest(client, id, pilot.vehicleId);
}

export async function createManualRequestInTx(
  client: PoolClient,
  input: { mahsulotId: number; operationKey: string },
  actor: HandoffActor,
) {
  const pilot = await resolvePilot(client);
  await lockParents(client, [pilot.warehouseId]);
  const product = await resolveProduct(client, input.mahsulotId);
  const targetRes = await client.query(
    `SELECT * FROM distribution.vehicle_stock_targets
      WHERE vehicle_id=$1 AND public_product_id=$2
        AND effective_from<=CURRENT_DATE
        AND (effective_to IS NULL OR effective_to>=CURRENT_DATE)
      ORDER BY effective_from DESC,id DESC LIMIT 1 FOR UPDATE`,
    [pilot.vehicleId, product.publicProductId],
  );
  if (!targetRes.rows.length)
    throw new ReplenishmentConflictError("No effective stock target for product");
  const inventory = await client.query(
    `SELECT quantity FROM public.inventory
      WHERE warehouse_id=$1 AND product=$2 FOR UPDATE`,
    [pilot.warehouseId, product.productName],
  );
  const current = inventory.rows.length ? Number(inventory.rows[0].quantity) : 0;
  const target = Number(targetRes.rows[0].target_quantity);
  const min = Number(targetRes.rows[0].min_quantity);
  const deficit = target - current;
  if (
    !Number.isInteger(target) ||
    !Number.isInteger(min) ||
    !Number.isInteger(current) ||
    !Number.isInteger(deficit)
  )
    throw new ReplenishmentConflictError(
      "Pilot label stock, target, and replenishment deficit must be whole units",
    );
  const fp = fingerprint({
    vehicleId: pilot.vehicleId,
    publicProductId: product.publicProductId,
    mahsulotId: product.mahsulotId,
    targetId: Number(targetRes.rows[0].id),
    target,
    current,
    deficit,
  });
  const replay = await client.query(
    `SELECT id,request_fingerprint FROM distribution.vehicle_replenishment_requests
      WHERE operation_key=$1`,
    [input.operationKey],
  );
  if (replay.rows.length) {
    if (String(replay.rows[0].request_fingerprint) !== fp)
      throw new ReplenishmentConflictError("operationKey replay with different snapshot");
    return loadRequest(client, Number(replay.rows[0].id), pilot.vehicleId);
  }
  if (current > min || deficit <= 0)
    throw new ReplenishmentConflictError("Vehicle stock is not below the replenishment threshold");
  const existing = await client.query(
    `SELECT id,request_fingerprint FROM distribution.vehicle_replenishment_requests
      WHERE vehicle_id=$1 AND public_product_id=$2
        AND status IN ('pending','approved') FOR UPDATE`,
    [pilot.vehicleId, product.publicProductId],
  );
  if (existing.rows.length) {
    if (String(existing.rows[0].request_fingerprint) === fp)
      return loadRequest(client, Number(existing.rows[0].id), pilot.vehicleId);
    throw new ReplenishmentConflictError("A different open request already exists");
  }
  const { rows } = await client.query(
    `INSERT INTO distribution.vehicle_replenishment_requests
      (vehicle_id,requested_by,mahsulot_id,public_product_id,product_name,sku,
       requested_quantity,target_quantity_snapshot,current_quantity_snapshot,
       operation_key,request_fingerprint,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending') RETURNING id`,
    [
      pilot.vehicleId, actor.actorId, product.mahsulotId, product.publicProductId,
      product.productName, product.sku, deficit, target, current,
      input.operationKey, fp,
    ],
  );
  return loadRequest(client, Number(rows[0].id), pilot.vehicleId);
}

async function preReadRequest(client: PoolClient, id: number) {
  const pilot = await resolvePilot(client);
  const { rows } = await client.query(
    `SELECT r.*,p.weight unit_weight
       FROM distribution.vehicle_replenishment_requests r
       JOIN public.products p ON p.id=r.public_product_id AND p.active=TRUE
      WHERE r.id=$1 AND r.vehicle_id=$2`,
    [id, pilot.vehicleId],
  );
  if (!rows.length) throw new ReplenishmentNotFoundError("Replenishment request not found");
  return { pilot, row: rows[0] };
}

export async function approveRequestInTx(
  client: PoolClient,
  id: number,
  actor: HandoffActor,
) {
  const pre = await preReadRequest(client, id);
  if (String(pre.row.status) === "approved")
    return loadRequest(client, id, pre.pilot.vehicleId);
  const qty = Number(pre.row.requested_quantity);
  const weight = qty * Number(pre.row.unit_weight);
  const candidates = await client.query(
    `SELECT w.id
       FROM public.warehouses w
       JOIN public.inventory i ON i.warehouse_id=w.id AND i.product=$1
      WHERE w.active=TRUE AND COALESCE(w.location_type,'general')<>'vehicle'
        AND w.purpose='finished' AND i.quantity >= $2 AND i.weight_kg >= $3
      ORDER BY w.id`,
    [String(pre.row.product_name), qty, weight],
  );
  if (!candidates.rows.length)
    throw new ReplenishmentConflictError("No eligible source warehouse has enough stock");
  const sourceId = Number(candidates.rows[0].id);
  await lockParents(client, [pre.pilot.warehouseId, sourceId]);
  const pilot = await resolvePilot(client);
  const source = await client.query(
    `SELECT w.id
       FROM public.warehouses w
       JOIN public.inventory i ON i.warehouse_id=w.id AND i.product=$2
      WHERE w.id=$1 AND w.active=TRUE
        AND COALESCE(w.location_type,'general')<>'vehicle'
        AND w.purpose='finished' AND i.quantity >= $3 AND i.weight_kg >= $4`,
    [sourceId, String(pre.row.product_name), qty, weight],
  );
  if (!source.rows.length)
    throw new ReplenishmentConflictError("Selected source no longer has enough stock");
  const locked = await client.query(
    `SELECT * FROM distribution.vehicle_replenishment_requests
      WHERE id=$1 AND vehicle_id=$2 FOR UPDATE`,
    [id, pilot.vehicleId],
  );
  if (!locked.rows.length) throw new ReplenishmentNotFoundError("Replenishment request not found");
  if (String(locked.rows[0].status) === "approved")
    return loadRequest(client, id, pilot.vehicleId);
  if (String(locked.rows[0].status) !== "pending")
    throw new ReplenishmentConflictError("Only pending requests can be approved");
  if (
    Number(locked.rows[0].requested_quantity) !== qty ||
    Number(locked.rows[0].public_product_id) !== Number(pre.row.public_product_id)
  )
    throw new ReplenishmentConflictError("Request changed while approval was pending");
  let handoff;
  try {
    handoff = await createHandoffInTx(
      client,
      {
        sourceWarehouseId: sourceId,
        items: [{ mahsulotId: Number(locked.rows[0].mahsulot_id), quantity: qty }],
        notes: `Replenishment request ${id}`,
        operationKey: `replenishment:${id}`,
      },
      actor,
    );
  } catch (error) {
    if (error instanceof HandoffConflictError || error instanceof HandoffValidationError) {
      throw new ReplenishmentConflictError(error.message);
    }
    throw error;
  }
  await client.query(
    `UPDATE distribution.vehicle_replenishment_requests
        SET status='approved',approved_quantity=requested_quantity,
            source_warehouse_id=$2,handoff_id=$3,approved_by=$4,
            approved_at=NOW(),resolved_at=NOW()
      WHERE id=$1`,
    [id, sourceId, handoff.id, actor.actorId],
  );
  return loadRequest(client, id, pilot.vehicleId);
}

export async function cancelRequestInTx(
  client: PoolClient,
  id: number,
  actor: HandoffActor,
) {
  const pre = await preReadRequest(client, id);
  const sourceId =
    pre.row.source_warehouse_id == null ? null : Number(pre.row.source_warehouse_id);
  await lockParents(
    client,
    sourceId == null ? [pre.pilot.warehouseId] : [pre.pilot.warehouseId, sourceId],
  );
  const pilot = await resolvePilot(client);
  const { rows } = await client.query(
    `SELECT r.*,h.status handoff_status
       FROM distribution.vehicle_replenishment_requests r
       LEFT JOIN distribution.vehicle_handoffs h ON h.id=r.handoff_id
      WHERE r.id=$1 AND r.vehicle_id=$2 FOR UPDATE OF r`,
    [id, pilot.vehicleId],
  );
  if (!rows.length) throw new ReplenishmentNotFoundError("Replenishment request not found");
  const r = rows[0];
  if (String(r.status) === "cancelled") return loadRequest(client, id, pilot.vehicleId);
  if (String(r.status) === "pending") {
    await client.query(
      `UPDATE distribution.vehicle_replenishment_requests
          SET status='cancelled',cancelled_by=$2,cancelled_at=NOW(),resolved_at=NOW()
        WHERE id=$1`,
      [id, actor.actorId],
    );
  } else if (String(r.status) === "approved") {
    if (!["prepared", "labels_printed"].includes(String(r.handoff_status)))
      throw new ReplenishmentConflictError(
        `Cannot cancel approved request with handoff status '${r.handoff_status}'`,
      );
    try {
      await cancelHandoffInTx(client, Number(r.handoff_id), actor);
    } catch (error) {
      if (error instanceof HandoffConflictError || error instanceof HandoffValidationError) {
        throw new ReplenishmentConflictError(error.message);
      }
      throw error;
    }
    await client.query(
      `UPDATE distribution.vehicle_replenishment_requests
          SET status='cancelled',cancelled_by=$2,cancelled_at=NOW(),resolved_at=NOW()
        WHERE id=$1`,
      [id, actor.actorId],
    );
  } else {
    throw new ReplenishmentConflictError(`Cannot cancel request in status '${r.status}'`);
  }
  return loadRequest(client, id, pilot.vehicleId);
}