import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  HandoffConflictError,
  HandoffNotFoundError,
  HandoffValidationError,
  type HandoffActor,
} from "./handoff-service";
import {
  PILOT_AGENT_NAME,
  PILOT_VEHICLE_PLATE,
  PILOT_VEHICLE_TYPE,
  PILOT_WAREHOUSE_LOCATION_TYPE,
  PILOT_WAREHOUSE_NAME,
  PILOT_WAREHOUSE_PURPOSE,
} from "./service";

export class ReturnNotFoundError extends HandoffNotFoundError {}
export class ReturnConflictError extends HandoffConflictError {}
export class ReturnValidationError extends HandoffValidationError {}

type Pilot = {
  vehicleId: number;
  assignmentId: number;
  deliveryAgentId: number;
  vehicleWarehouseId: number;
};

export type ReturnItem = {
  id: number;
  labelClaimId: number;
  productionLabelId: number;
  barcode: string;
  handoffId: number;
  handoffItemId: number;
  mahsulotId: number;
  publicProductId: number;
  productName: string;
  sku: string;
  unitWeightKg: number;
  destinationWarehouseId: number;
  movementReference: string;
};

export type VehicleReturn = {
  id: number;
  vehicleId: number;
  vehicleAssignmentId: number;
  deliveryAgentId: number;
  vehicleWarehouseId: number;
  status: string;
  operationKey: string;
  operationFingerprint: string;
  notes: string | null;
  preparedBy: number;
  preparedAt: string;
  handedBackBy: number | null;
  handedBackAt: string | null;
  transferredBy: number | null;
  transferredAt: string | null;
  cancelledBy: number | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: ReturnItem[];
};

const iso = (v: Date | string | null): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

async function resolvePilot(client: PoolClient): Promise<Pilot> {
  const { rows } = await client.query(
    `SELECT v.id vehicle_id, v.plate_number, v.vehicle_type, v.warehouse_id,
            a.id assignment_id, a.delivery_agent_id, w.name warehouse_name,
            w.active warehouse_active, COALESCE(w.location_type,'general') warehouse_location_type,
            w.purpose warehouse_purpose
       FROM distribution.vehicle_assignments a
       JOIN distribution.vehicles v ON v.id=a.vehicle_id
       JOIN distribution.delivery_agents ag ON ag.id=a.delivery_agent_id
       JOIN public.warehouses w ON w.id=v.warehouse_id
      WHERE a.status='active' AND ag.faol=1
        AND UPPER(TRIM(ag.name))=UPPER(TRIM($1))
      ORDER BY a.id`,
    [PILOT_AGENT_NAME],
  );
  if (rows.length !== 1) throw new ReturnConflictError("Exact pilot assignment is unavailable or ambiguous");
  const r = rows[0];
  if (
    r.plate_number !== PILOT_VEHICLE_PLATE ||
    r.vehicle_type !== PILOT_VEHICLE_TYPE ||
    r.warehouse_name !== PILOT_WAREHOUSE_NAME ||
    r.warehouse_location_type !== PILOT_WAREHOUSE_LOCATION_TYPE ||
    r.warehouse_purpose !== PILOT_WAREHOUSE_PURPOSE ||
    r.warehouse_active !== true
  ) throw new ReturnConflictError("Exact pilot identity does not match");
  return {
    vehicleId: Number(r.vehicle_id),
    assignmentId: Number(r.assignment_id),
    deliveryAgentId: Number(r.delivery_agent_id),
    vehicleWarehouseId: Number(r.warehouse_id),
  };
}

async function lockParents(client: PoolClient, ids: number[]): Promise<void> {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  const { rows } = await client.query(
    `SELECT id FROM public.warehouses WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE`,
    [unique],
  );
  if (rows.length !== unique.length) throw new ReturnConflictError("A return warehouse parent is missing");
}

const HEADER = `id, vehicle_id, vehicle_assignment_id, delivery_agent_id,
 vehicle_warehouse_id, status, operation_key, operation_fingerprint, notes,
 prepared_by, prepared_at, handed_back_by, handed_back_at, transferred_by,
 transferred_at, cancelled_by, cancelled_at, created_at, updated_at`;

async function items(client: PoolClient, id: number): Promise<ReturnItem[]> {
  const { rows } = await client.query(
    `SELECT id,label_claim_id,production_label_id,barcode,handoff_id,handoff_item_id,
            mahsulot_id,public_product_id,product_name,sku,unit_weight_kg,
            destination_warehouse_id,movement_reference
       FROM distribution.vehicle_return_items WHERE return_id=$1 ORDER BY id`,
    [id],
  );
  return rows.map((r) => ({
    id: Number(r.id), labelClaimId: Number(r.label_claim_id),
    productionLabelId: Number(r.production_label_id), barcode: String(r.barcode),
    handoffId: Number(r.handoff_id), handoffItemId: Number(r.handoff_item_id),
    mahsulotId: Number(r.mahsulot_id), publicProductId: Number(r.public_product_id),
    productName: String(r.product_name), sku: String(r.sku),
    unitWeightKg: Number(r.unit_weight_kg),
    destinationWarehouseId: Number(r.destination_warehouse_id),
    movementReference: String(r.movement_reference),
  }));
}

async function mapReturn(client: PoolClient, r: Record<string, unknown>): Promise<VehicleReturn> {
  return {
    id: Number(r.id), vehicleId: Number(r.vehicle_id),
    vehicleAssignmentId: Number(r.vehicle_assignment_id),
    deliveryAgentId: Number(r.delivery_agent_id),
    vehicleWarehouseId: Number(r.vehicle_warehouse_id), status: String(r.status),
    operationKey: String(r.operation_key), operationFingerprint: String(r.operation_fingerprint),
    notes: (r.notes as string | null) ?? null, preparedBy: Number(r.prepared_by),
    preparedAt: iso(r.prepared_at as Date | string)!, handedBackBy: r.handed_back_by == null ? null : Number(r.handed_back_by),
    handedBackAt: iso(r.handed_back_at as Date | string | null),
    transferredBy: r.transferred_by == null ? null : Number(r.transferred_by),
    transferredAt: iso(r.transferred_at as Date | string | null),
    cancelledBy: r.cancelled_by == null ? null : Number(r.cancelled_by),
    cancelledAt: iso(r.cancelled_at as Date | string | null),
    createdAt: iso(r.created_at as Date | string)!, updatedAt: iso(r.updated_at as Date | string)!,
    items: await items(client, Number(r.id)),
  };
}

export async function getReturn(client: PoolClient, id: number): Promise<VehicleReturn> {
  const pilot = await resolvePilot(client);
  const { rows } = await client.query(
    `SELECT ${HEADER} FROM distribution.vehicle_returns WHERE id=$1 AND vehicle_id=$2`,
    [id, pilot.vehicleId],
  );
  if (!rows.length) throw new ReturnNotFoundError("Vehicle return not found");
  return mapReturn(client, rows[0]);
}

export async function listReturns(client: PoolClient): Promise<{ vehicleId: number; returns: VehicleReturn[] }> {
  const pilot = await resolvePilot(client);
  const { rows } = await client.query(
    `SELECT ${HEADER} FROM distribution.vehicle_returns WHERE vehicle_id=$1 ORDER BY id DESC`,
    [pilot.vehicleId],
  );
  return { vehicleId: pilot.vehicleId, returns: await Promise.all(rows.map((r) => mapReturn(client, r))) };
}

export async function listReturnableLabels(client: PoolClient, search?: string) {
  const pilot = await resolvePilot(client);
  const q = search?.trim() || null;
  const { rows } = await client.query(
    `SELECT c.id label_claim_id,c.production_label_id,c.barcode,c.handoff_id,c.handoff_item_id,
            c.mahsulot_id,c.sku,c.unit_weight_kg,h.source_warehouse_id destination_warehouse_id,
            p.id public_product_id,p.name product_name
       FROM distribution.vehicle_label_claims c
       JOIN distribution.vehicle_handoffs h ON h.id=c.handoff_id
       JOIN distribution.mahsulotlar d ON d.id=c.mahsulot_id AND d.faol=1 AND d.sku=c.sku
       JOIN public.warehouses w ON w.id=h.source_warehouse_id
       JOIN public.products p ON p.sku=c.sku AND p.active=TRUE
      WHERE c.vehicle_id=$1 AND c.status='loaded'
        AND h.status='stock_transferred' AND h.vehicle_id=$1
        AND w.active=TRUE AND COALESCE(w.location_type,'general')<>'vehicle' AND w.purpose='finished'
        AND (SELECT count(*) FROM public.products px WHERE px.sku=c.sku AND px.active=TRUE)=1
        AND ($2::text IS NULL OR c.barcode ILIKE '%'||$2||'%' OR p.name ILIKE '%'||$2||'%' OR c.sku ILIKE '%'||$2||'%')
      ORDER BY c.barcode`,
    [pilot.vehicleId, q],
  );
  return { vehicleId: pilot.vehicleId, labels: rows.map((r) => ({
    labelClaimId: Number(r.label_claim_id), productionLabelId: Number(r.production_label_id),
    barcode: String(r.barcode), handoffId: Number(r.handoff_id),
    handoffItemId: Number(r.handoff_item_id), mahsulotId: Number(r.mahsulot_id),
    sku: String(r.sku), unitWeightKg: Number(r.unit_weight_kg),
    destinationWarehouseId: Number(r.destination_warehouse_id),
    publicProductId: Number(r.public_product_id), productName: String(r.product_name),
  })) };
}

function fingerprint(barcodes: string[], notes: string | null): string {
  return createHash("sha256").update(JSON.stringify({ barcodes: [...barcodes].sort(), notes })).digest("hex");
}

export async function createReturnInTx(
  client: PoolClient,
  input: { barcodes: string[]; operationKey: string; notes: string | null },
  actor: HandoffActor,
): Promise<VehicleReturn> {
  if (!input.barcodes.length || new Set(input.barcodes).size !== input.barcodes.length)
    throw new ReturnValidationError("barcodes must be nonempty and unique");
  const prePilot = await resolvePilot(client);
  const pre = await client.query(
    `SELECT DISTINCT h.source_warehouse_id
       FROM distribution.vehicle_label_claims c
       JOIN distribution.vehicle_handoffs h ON h.id=c.handoff_id
      WHERE c.barcode=ANY($1::text[])`,
    [input.barcodes],
  );
  await lockParents(client, [prePilot.vehicleWarehouseId, ...pre.rows.map((r) => Number(r.source_warehouse_id))]);
  const pilot = await resolvePilot(client);
  if (pilot.vehicleWarehouseId !== prePilot.vehicleWarehouseId) throw new ReturnConflictError("Pilot warehouse changed");
  const fp = fingerprint(input.barcodes, input.notes);
  const replay = await client.query(
    `SELECT ${HEADER} FROM distribution.vehicle_returns WHERE operation_key=$1`,
    [input.operationKey],
  );
  if (replay.rows.length) {
    if (replay.rows[0].operation_fingerprint !== fp || Number(replay.rows[0].vehicle_id) !== pilot.vehicleId)
      throw new ReturnConflictError("operationKey replay with a different payload");
    return mapReturn(client, replay.rows[0]);
  }
  const { rows: claims } = await client.query(
    `SELECT c.id,c.vehicle_id,c.production_label_id,c.barcode,c.handoff_id,c.handoff_item_id,
            c.mahsulot_id,c.sku,c.unit_weight_kg,c.status,h.source_warehouse_id,
            h.status handoff_status,w.active,w.purpose,COALESCE(w.location_type,'general') location_type
       FROM distribution.vehicle_label_claims c
       JOIN distribution.vehicle_handoffs h ON h.id=c.handoff_id
       JOIN distribution.mahsulotlar d ON d.id=c.mahsulot_id AND d.faol=1 AND d.sku=c.sku
       JOIN public.warehouses w ON w.id=h.source_warehouse_id
      WHERE c.barcode=ANY($1::text[]) ORDER BY c.id FOR UPDATE OF c`,
    [input.barcodes],
  );
  if (claims.length !== input.barcodes.length) throw new ReturnConflictError("A label is missing or unavailable");
  for (const c of claims) {
    if (Number(c.vehicle_id) !== pilot.vehicleId || c.status !== "loaded" ||
        c.handoff_status !== "stock_transferred" || !c.active ||
        c.location_type === "vehicle" || c.purpose !== "finished")
      throw new ReturnConflictError(`Label ${c.barcode} is not returnable`);
  }
  const open = await client.query(
    `SELECT id FROM distribution.vehicle_returns WHERE vehicle_id=$1 AND status IN ('prepared','handed_back')`,
    [pilot.vehicleId],
  );
  if (open.rows.length) throw new ReturnConflictError("An open vehicle return already exists");
  const resolved = [];
  for (const c of claims) {
    const pp = await client.query(`SELECT id,name,sku FROM public.products WHERE sku=$1 AND active=TRUE`, [c.sku]);
    if (pp.rows.length !== 1) throw new ReturnConflictError(`SKU ${c.sku} does not map uniquely`);
    resolved.push({ c, p: pp.rows[0] });
  }
  const ins = await client.query(
    `INSERT INTO distribution.vehicle_returns
      (vehicle_id,vehicle_assignment_id,delivery_agent_id,vehicle_warehouse_id,status,
       operation_key,operation_fingerprint,notes,prepared_by)
     VALUES ($1,$2,$3,$4,'prepared',$5,$6,$7,$8) RETURNING ${HEADER}`,
    [pilot.vehicleId,pilot.assignmentId,pilot.deliveryAgentId,pilot.vehicleWarehouseId,
     input.operationKey,fp,input.notes,actor.actorId],
  );
  const returnId = Number(ins.rows[0].id);
  for (const { c, p } of resolved) {
    const movementReference = `vehicle-return:${returnId}:claim:${c.id}`;
    const it = await client.query(
      `INSERT INTO distribution.vehicle_return_items
       (return_id,label_claim_id,production_label_id,barcode,handoff_id,handoff_item_id,
        mahsulot_id,public_product_id,product_name,sku,unit_weight_kg,
        destination_warehouse_id,movement_reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [returnId,c.id,c.production_label_id,c.barcode,c.handoff_id,c.handoff_item_id,
       c.mahsulot_id,p.id,p.name,p.sku,c.unit_weight_kg,c.source_warehouse_id,movementReference],
    );
    await client.query(
      `UPDATE distribution.vehicle_return_items SET movement_reference=$2 WHERE id=$1`,
      [it.rows[0].id, `vehicle-return:${returnId}:item:${it.rows[0].id}`],
    );
    const changed = await client.query(
      `UPDATE distribution.vehicle_label_claims
          SET status='return_reserved',return_id=$2,updated_at=NOW()
        WHERE id=$1 AND status='loaded' AND return_id IS NULL`,
      [c.id, returnId],
    );
    if (changed.rowCount !== 1) throw new ReturnConflictError(`Label ${c.barcode} was concurrently claimed`);
  }
  return mapReturn(client, ins.rows[0]);
}

async function prelockReturn(client: PoolClient, id: number): Promise<{ pilot: Pilot; row: Record<string, unknown> }> {
  const pre = await client.query(
    `SELECT r.vehicle_warehouse_id, array_agg(DISTINCT i.destination_warehouse_id) destinations
       FROM distribution.vehicle_returns r
       LEFT JOIN distribution.vehicle_return_items i ON i.return_id=r.id
      WHERE r.id=$1 GROUP BY r.vehicle_warehouse_id`,
    [id],
  );
  if (!pre.rows.length) throw new ReturnNotFoundError("Vehicle return not found");
  await lockParents(client, [Number(pre.rows[0].vehicle_warehouse_id), ...(pre.rows[0].destinations ?? []).map(Number)]);
  const pilot = await resolvePilot(client);
  const locked = await client.query(`SELECT ${HEADER} FROM distribution.vehicle_returns WHERE id=$1 FOR UPDATE`, [id]);
  if (!locked.rows.length || Number(locked.rows[0].vehicle_id) !== pilot.vehicleId) throw new ReturnNotFoundError("Vehicle return not found");
  return { pilot, row: locked.rows[0] };
}

export async function markReturnHandedBackInTx(client: PoolClient, id: number, actor: HandoffActor) {
  const { row } = await prelockReturn(client, id);
  if (row.status === "handed_back" || row.status === "stock_transferred") return mapReturn(client, row);
  if (row.status !== "prepared") throw new ReturnConflictError(`Cannot hand back from status '${row.status}'`);
  const its = await items(client, id);
  const claimIds = its.map((i) => i.labelClaimId);
  const claims = await client.query(
    `SELECT id,status,return_id FROM distribution.vehicle_label_claims
      WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE`,
    [claimIds],
  );
  if (
    !its.length ||
    claims.rows.length !== its.length ||
    claims.rows.some((c) => c.status !== "return_reserved" || Number(c.return_id) !== id)
  ) {
    throw new ReturnConflictError("Return claims are no longer reserved");
  }
  const { rows } = await client.query(
    `UPDATE distribution.vehicle_returns SET status='handed_back',handed_back_by=$2,
      handed_back_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING ${HEADER}`, [id, actor.actorId],
  );
  return mapReturn(client, rows[0]);
}

export async function cancelReturnInTx(client: PoolClient, id: number, actor: HandoffActor) {
  const { row } = await prelockReturn(client, id);
  if (row.status === "cancelled") return mapReturn(client, row);
  if (row.status !== "prepared") throw new ReturnConflictError(`Cannot cancel from status '${row.status}'`);
  const its = await items(client, id);
  const claimIds = its.map((i) => i.labelClaimId);
  await client.query(`SELECT id FROM distribution.vehicle_label_claims WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE`, [claimIds]);
  const released = await client.query(
    `UPDATE distribution.vehicle_label_claims SET status='loaded',return_id=NULL,updated_at=NOW()
      WHERE id=ANY($1::int[]) AND status='return_reserved' AND return_id=$2`, [claimIds, id],
  );
  if (released.rowCount !== claimIds.length) throw new ReturnConflictError("Return claims changed concurrently");
  const { rows } = await client.query(
    `UPDATE distribution.vehicle_returns SET status='cancelled',cancelled_by=$2,
      cancelled_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING ${HEADER}`, [id, actor.actorId],
  );
  return mapReturn(client, rows[0]);
}

export async function transferReturnStockInTx(client: PoolClient, id: number, actor: HandoffActor) {
  const { pilot, row } = await prelockReturn(client, id);
  if (row.status === "stock_transferred") return mapReturn(client, row);
  if (row.status !== "handed_back") throw new ReturnConflictError(`Cannot transfer from status '${row.status}'`);
  const its = await items(client, id);
  if (!its.length) throw new ReturnConflictError("Return has no items");
  const claimIds = its.map((i) => i.labelClaimId);
  const claims = await client.query(
    `SELECT id,status,return_id FROM distribution.vehicle_label_claims
      WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE`, [claimIds],
  );
  if (claims.rows.length !== its.length || claims.rows.some((c) => c.status !== "return_reserved" || Number(c.return_id) !== id))
    throw new ReturnConflictError("Return claims are no longer reserved");
  for (const it of [...its].sort((a, b) => a.productName.localeCompare(b.productName) || a.destinationWarehouseId - b.destinationWarehouseId)) {
    await client.query(
      `SELECT id FROM public.inventory WHERE product=$1 AND warehouse_id IN ($2,$3)
       ORDER BY warehouse_id FOR UPDATE`,
      [it.productName, Math.min(pilot.vehicleWarehouseId,it.destinationWarehouseId), Math.max(pilot.vehicleWarehouseId,it.destinationWarehouseId)],
    );
    const dec = await client.query(
      `UPDATE public.inventory SET quantity=quantity-1,weight_kg=weight_kg-$3,updated_at=NOW()
        WHERE warehouse_id=$1 AND product=$2 AND quantity>=1 AND COALESCE(weight_kg,0)>=$3`,
      [pilot.vehicleWarehouseId,it.productName,it.unitWeightKg],
    );
    if (dec.rowCount !== 1) throw new ReturnConflictError(`Insufficient vehicle inventory for ${it.productName}`);
    await client.query(
      `INSERT INTO public.inventory (warehouse_id,product,quantity,weight_kg,product_type)
       VALUES ($1,$2,1,$3,'finished')
       ON CONFLICT (warehouse_id,product) DO UPDATE SET
         quantity=inventory.quantity+1,weight_kg=COALESCE(inventory.weight_kg,0)+EXCLUDED.weight_kg,updated_at=NOW()`,
      [it.destinationWarehouseId,it.productName,it.unitWeightKg],
    );
    await client.query(
      `INSERT INTO public.stock_movements
       (product,quantity,movement_type,from_warehouse_id,to_warehouse_id,note,created_by,product_type,weight_kg,reference)
       VALUES ($1,1,'TRANSFER',$2,$3,$4,$5,'finished',$6,$7)`,
      [it.productName,pilot.vehicleWarehouseId,it.destinationWarehouseId,
       `Vehicle return ${id}, label ${it.barcode}`,actor.ref,it.unitWeightKg,it.movementReference],
    );
    await client.query(
      `INSERT INTO distribution.vehicle_unit_events
       (vehicle_id,handoff_id,handoff_item_id,mahsulot_id,sku,event_type,quantity,
        actor_id,production_label_id,barcode,label_claim_id,operation_key)
       VALUES ($1,$2,$3,$4,$5,'return',-1,$6,$7,$8,$9,$10)`,
      [pilot.vehicleId,it.handoffId,it.handoffItemId,it.mahsulotId,it.sku,actor.actorId,
       it.productionLabelId,it.barcode,it.labelClaimId,`vehicle-return:${id}:item:${it.id}`],
    );
    const done = await client.query(
      `UPDATE distribution.vehicle_label_claims SET status='returned',returned_at=NOW(),
        returned_by=$2,updated_at=NOW() WHERE id=$1 AND status='return_reserved' AND return_id=$3`,
      [it.labelClaimId,actor.actorId,id],
    );
    if (done.rowCount !== 1) throw new ReturnConflictError(`Claim ${it.labelClaimId} changed concurrently`);
  }
  const { rows } = await client.query(
    `UPDATE distribution.vehicle_returns SET status='stock_transferred',transferred_by=$2,
      transferred_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING ${HEADER}`, [id,actor.actorId],
  );
  return mapReturn(client, rows[0]);
}