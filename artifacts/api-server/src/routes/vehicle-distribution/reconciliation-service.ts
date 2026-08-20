// ─────────────────────────────────────────────────────────────────────────────
// F6 Vehicle Reconciliation — service layer (single TS writer for the domain)
//
// Label-preserving end-of-day variance detection for the single pilot vehicle.
// This is EXPLICITLY NOT inventory adjustment: no path in this module ever
// mutates inventory, stock_movements, vehicle_label_claims, vehicle_unit_events
// or any label/unit state. It only records a snapshot of expected on-vehicle
// stock, the physically counted actuals, and a variance verdict.
//
// Lifecycle:
//   draft → approved  → applied (terminal)
//   draft → disputed  (terminal — any nonzero discrepancy at review)
//   draft → cancelled (terminal)
//
// Invariants (never trust the request body for authority):
//   - the vehicle / vehicle-warehouse / delivery agent are resolved server-side
//     from the single active pilot assignment (exact F2 identity);
//   - the actor (created_by / reviewed_by / applied_by / counted_by) is passed
//     in by the router from the authenticated admin session — never the body;
//   - create snapshots the COMPLETE nonzero pilot vehicle inventory, resolving
//     each product name to exactly one active public.products row (409 on a
//     missing or ambiguous match);
//   - review requires every line counted, then approves iff all discrepancies
//     are zero, otherwise disputes (terminal);
//   - apply re-locks + re-compares the current nonzero rows against the snapshot
//     and rejects (409) if anything was added, removed or changed since;
//   - every response is Zod-validated by the router BEFORE COMMIT.
// ─────────────────────────────────────────────────────────────────────────────

import type { PoolClient } from "pg";
import {
  PILOT_AGENT_NAME,
  PILOT_VEHICLE_PLATE,
  PILOT_VEHICLE_TYPE,
  PILOT_WAREHOUSE_NAME,
  PILOT_WAREHOUSE_LOCATION_TYPE,
  PILOT_WAREHOUSE_PURPOSE,
} from "./service";

/** Actor identity assigned server-side by the auth layer. Never from the body. */
export type ReconciliationActor = {
  /** 'admin' */
  type: string;
  /** admin username. */
  ref: string;
  /** Numeric admin user id used for the BIGINT actor columns. */
  actorId: number;
};

export type ReconciliationItem = {
  id: number;
  publicProductId: number | null;
  mahsulotId: number | null;
  productName: string | null;
  sku: string;
  expectedQuantity: number;
  expectedWeightKg: number | null;
  actualQuantity: number | null;
  discrepancy: number;
  countedBy: number | null;
  countedAt: string | null;
  notes: string | null;
};

export type ReconciliationDetail = {
  id: number;
  vehicleId: number;
  deliveryAgentId: number;
  reconciliationDate: string;
  status: string;
  createdBy: number | null;
  reviewedBy: number | null;
  reviewedAt: string | null;
  appliedBy: number | null;
  appliedAt: string | null;
  notes: string | null;
  createdAt: string;
  items: ReconciliationItem[];
};

export type PatchItemEntry = {
  itemId: number;
  actualQuantity: number;
  notes: string | null;
};

// ── Error taxonomy (mapped to HTTP by the router) ────────────────────────────

/** 404 — the requested reconciliation does not exist for the pilot vehicle. */
export class ReconciliationNotFoundError extends Error {
  constructor(message = "Reconciliation not found") {
    super(message);
    this.name = "ReconciliationNotFoundError";
  }
}

/** 409 — a conflicting state, snapshot staleness, or unresolvable product. */
export class ReconciliationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationConflictError";
  }
}

/** 400 — a validation failure discovered server-side. */
export class ReconciliationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationValidationError";
  }
}

/** Stable advisory-lock namespace, one key per reconciliation id. */
function reconciliationLockKey(id: number): string {
  return `vehicle_distribution:reconciliation:${id}`;
}

/** Advisory key for the create/pilot path — serialized on the vehicle id so
 *  concurrent creates for the same pilot contend for the same active-check. */
function createLockKey(vehicleId: number): string {
  return `vehicle_distribution:reconciliation:create:${vehicleId}`;
}

const iso = (v: Date | string | null): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

/** Numeric rounding to 3 decimals (matches NUMERIC(12,3) storage). */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── Pilot resolution (server-side authority) ─────────────────────────────────

type PilotTarget = {
  vehicleId: number;
  vehicleWarehouseId: number;
  deliveryAgentId: number;
};

/** Resolve the single active pilot assignment with strict identity checks.
 *  Any deviation throws ReconciliationConflictError (→ 409). */
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
    throw new ReconciliationConflictError(
      "No active pilot assignment — bootstrap the pilot first",
    );
  }
  if (rows.length > 1) {
    throw new ReconciliationConflictError(
      `Ambiguous active pilot assignment: ${rows.length} active assignments for agent ${PILOT_AGENT_NAME}`,
    );
  }

  const r = rows[0];

  if (String(r.plate_number) !== PILOT_VEHICLE_PLATE) {
    throw new ReconciliationConflictError(
      `Pilot agent is assigned to wrong vehicle plate '${r.plate_number}' (expected '${PILOT_VEHICLE_PLATE}')`,
    );
  }
  if (String(r.vehicle_type) !== PILOT_VEHICLE_TYPE) {
    throw new ReconciliationConflictError(
      `Pilot vehicle has wrong type '${r.vehicle_type}' (expected '${PILOT_VEHICLE_TYPE}')`,
    );
  }
  if (!r.warehouse_active) {
    throw new ReconciliationConflictError(
      "Pilot vehicle's mapped warehouse is inactive",
    );
  }
  if (String(r.warehouse_location_type) !== PILOT_WAREHOUSE_LOCATION_TYPE) {
    throw new ReconciliationConflictError(
      `Pilot warehouse has wrong location_type '${r.warehouse_location_type}' (expected '${PILOT_WAREHOUSE_LOCATION_TYPE}')`,
    );
  }
  if (String(r.warehouse_purpose) !== PILOT_WAREHOUSE_PURPOSE) {
    throw new ReconciliationConflictError(
      `Pilot warehouse has wrong purpose '${r.warehouse_purpose}' (expected '${PILOT_WAREHOUSE_PURPOSE}')`,
    );
  }
  if (String(r.warehouse_name) !== PILOT_WAREHOUSE_NAME) {
    throw new ReconciliationConflictError(
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

const HEADER_COLUMNS = `id, vehicle_id, delivery_agent_id, reconciliation_date,
  status, created_by, reviewed_by, reviewed_at, applied_by, applied_at, notes,
  created_at`;

async function readItems(
  client: PoolClient,
  reconciliationId: number,
): Promise<ReconciliationItem[]> {
  const { rows } = await client.query(
    `SELECT id, public_product_id, mahsulot_id, product_name, sku,
            expected_quantity, expected_weight_kg, actual_quantity, discrepancy,
            counted_by, counted_at, notes
       FROM distribution.vehicle_reconciliation_items
      WHERE reconciliation_id = $1
      ORDER BY id`,
    [reconciliationId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    publicProductId: r.public_product_id == null ? null : Number(r.public_product_id),
    mahsulotId: r.mahsulot_id == null ? null : Number(r.mahsulot_id),
    productName: r.product_name ?? null,
    sku: r.sku ?? "",
    expectedQuantity: Number(r.expected_quantity),
    expectedWeightKg: r.expected_weight_kg == null ? null : Number(r.expected_weight_kg),
    actualQuantity: r.actual_quantity == null ? null : Number(r.actual_quantity),
    discrepancy: Number(r.discrepancy),
    countedBy: r.counted_by == null ? null : Number(r.counted_by),
    countedAt: iso(r.counted_at as Date | string | null),
    notes: r.notes ?? null,
  }));
}

function mapHeaderRow(
  row: Record<string, unknown>,
): Omit<ReconciliationDetail, "items"> {
  return {
    id: Number(row.id),
    vehicleId: Number(row.vehicle_id),
    deliveryAgentId: Number(row.delivery_agent_id),
    reconciliationDate:
      iso(row.reconciliation_date as Date | string) ?? String(row.reconciliation_date),
    status: String(row.status),
    createdBy: row.created_by == null ? null : Number(row.created_by),
    reviewedBy: row.reviewed_by == null ? null : Number(row.reviewed_by),
    reviewedAt: iso(row.reviewed_at as Date | string | null),
    appliedBy: row.applied_by == null ? null : Number(row.applied_by),
    appliedAt: iso(row.applied_at as Date | string | null),
    notes: (row.notes as string | null) ?? null,
    createdAt: iso(row.created_at as Date | string) ?? String(row.created_at),
  };
}

/** Load a single reconciliation scoped to the exact active pilot vehicle.
 *  Never swallows a pilot-resolution failure (that propagates as a 409). Only
 *  returns null when the row itself doesn't exist / belongs to another vehicle. */
async function loadDetail(
  client: PoolClient,
  reconciliationId: number,
): Promise<ReconciliationDetail | null> {
  const pilot = await resolveActivePilot(client);
  const { rows } = await client.query(
    `SELECT ${HEADER_COLUMNS} FROM distribution.vehicle_reconciliations
      WHERE id = $1 AND vehicle_id = $2`,
    [reconciliationId, pilot.vehicleId],
  );
  if (!rows.length) return null;
  const items = await readItems(client, reconciliationId);
  return { ...mapHeaderRow(rows[0]), items };
}

/** Public read: single reconciliation for the pilot vehicle. */
export async function getReconciliation(
  client: PoolClient,
  reconciliationId: number,
): Promise<ReconciliationDetail> {
  const detail = await loadDetail(client, reconciliationId);
  if (!detail) throw new ReconciliationNotFoundError();
  return detail;
}

/** Public read: reconciliation history for the pilot vehicle (newest first). */
export async function listReconciliations(
  client: PoolClient,
  limit: number,
): Promise<{ vehicleId: number; reconciliations: ReconciliationDetail[] }> {
  const pilot = await resolveActivePilot(client);
  const { rows } = await client.query(
    `SELECT ${HEADER_COLUMNS} FROM distribution.vehicle_reconciliations
      WHERE vehicle_id = $1
      ORDER BY id DESC
      LIMIT $2`,
    [pilot.vehicleId, limit],
  );
  const reconciliations: ReconciliationDetail[] = [];
  for (const row of rows) {
    const items = await readItems(client, Number(row.id));
    reconciliations.push({ ...mapHeaderRow(row), items });
  }
  return { vehicleId: pilot.vehicleId, reconciliations };
}

// ── Snapshot the pilot vehicle inventory ─────────────────────────────────────

type SnapshotRow = {
  publicProductId: number;
  productName: string;
  sku: string;
  expectedQuantity: number;
  expectedWeightKg: number;
};

/** Read the COMPLETE nonzero pilot vehicle inventory and resolve every product
 *  name to exactly one active public.products row. Throws (→ 409) on a missing
 *  or ambiguous product resolution. Ordered deterministically by product name. */
async function snapshotVehicleInventory(
  client: PoolClient,
  vehicleWarehouseId: number,
): Promise<SnapshotRow[]> {
  const { rows } = await client.query(
    `SELECT product AS product, quantity AS quantity,
            COALESCE(weight_kg, 0) AS weight_kg
       FROM inventory
      WHERE warehouse_id = $1
        AND quantity <> 0
      ORDER BY product`,
    [vehicleWarehouseId],
  );

  const out: SnapshotRow[] = [];
  for (const r of rows) {
    const productName = String(r.product);
    // Resolve to EXACTLY one active public product by name (name is the PK).
    const pp = await client.query(
      `SELECT id, sku FROM products WHERE name = $1 AND active = TRUE`,
      [productName],
    );
    if (pp.rows.length === 0) {
      throw new ReconciliationConflictError(
        `Vehicle stock product '${productName}' does not map to any active public product`,
      );
    }
    if (pp.rows.length > 1) {
      throw new ReconciliationConflictError(
        `Vehicle stock product '${productName}' maps to ${pp.rows.length} active public products (ambiguous)`,
      );
    }
    out.push({
      publicProductId: Number(pp.rows[0].id),
      productName,
      sku: String(pp.rows[0].sku ?? ""),
      expectedQuantity: round3(Number(r.quantity)),
      expectedWeightKg: round3(Number(r.weight_kg)),
    });
  }
  return out;
}

// ── Create a draft reconciliation ────────────────────────────────────────────

const NON_TERMINAL = new Set(["draft", "approved", "disputed"]);

export async function createReconciliationInTx(
  client: PoolClient,
  reconciliationDate: string,
  notes: string | null,
  actor: ReconciliationActor,
): Promise<{ created: boolean; reconciliation: ReconciliationDetail }> {
  const pilot = await resolveActivePilot(client);

  // Serialize concurrent creates for the same pilot vehicle.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    createLockKey(pilot.vehicleId),
  ]);

  // Any non-terminal reconciliation blocks opening a new one — EXCEPT that a
  // same-date draft retry returns the existing draft (created=false).
  const { rows: active } = await client.query(
    `SELECT id, status, reconciliation_date
       FROM distribution.vehicle_reconciliations
      WHERE vehicle_id = $1 AND status IN ('draft','approved','disputed')
      ORDER BY id`,
    [pilot.vehicleId],
  );
  for (const a of active) {
    const status = String(a.status);
    const existingDate =
      iso(a.reconciliation_date as Date | string) ?? String(a.reconciliation_date);
    const sameDate = existingDate.slice(0, 10) === reconciliationDate.slice(0, 10);
    if (status === "draft" && sameDate) {
      const existing = await loadDetail(client, Number(a.id));
      if (!existing) throw new ReconciliationNotFoundError();
      return { created: false, reconciliation: existing };
    }
    if (NON_TERMINAL.has(status)) {
      throw new ReconciliationConflictError(
        `An active reconciliation (id=${a.id}, status=${status}) already exists for the pilot vehicle`,
      );
    }
  }

  const snapshot = await snapshotVehicleInventory(
    client,
    pilot.vehicleWarehouseId,
  );

  const ins = await client.query(
    `INSERT INTO distribution.vehicle_reconciliations
       (vehicle_id, delivery_agent_id, reconciliation_date, status, created_by, notes)
     VALUES ($1, $2, $3, 'draft', $4, $5)
     RETURNING ${HEADER_COLUMNS}`,
    [
      pilot.vehicleId,
      pilot.deliveryAgentId,
      reconciliationDate,
      actor.actorId,
      notes,
    ],
  );
  const reconciliationId = Number(ins.rows[0].id);

  for (const s of snapshot) {
    await client.query(
      `INSERT INTO distribution.vehicle_reconciliation_items
         (reconciliation_id, mahsulot_id, public_product_id, product_name, sku,
          expected_quantity, expected_weight_kg, actual_quantity, discrepancy)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, NULL, 0)`,
      [
        reconciliationId,
        s.publicProductId,
        s.productName,
        s.sku,
        s.expectedQuantity,
        s.expectedWeightKg,
      ],
    );
  }

  const items = await readItems(client, reconciliationId);
  return {
    created: true,
    reconciliation: { ...mapHeaderRow(ins.rows[0]), items },
  };
}

// ── Lock + fetch a reconciliation row FOR UPDATE ─────────────────────────────

async function lockReconciliation(
  client: PoolClient,
  reconciliationId: number,
): Promise<Record<string, unknown>> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    reconciliationLockKey(reconciliationId),
  ]);
  const { rows } = await client.query(
    `SELECT ${HEADER_COLUMNS} FROM distribution.vehicle_reconciliations
      WHERE id = $1 FOR UPDATE`,
    [reconciliationId],
  );
  if (!rows.length) throw new ReconciliationNotFoundError();
  return rows[0];
}

/** Ensure a locked reconciliation belongs to the exact active pilot vehicle. */
async function assertPilotOwnership(
  client: PoolClient,
  row: Record<string, unknown>,
): Promise<PilotTarget> {
  const pilot = await resolveActivePilot(client);
  if (Number(row.vehicle_id) !== pilot.vehicleId) {
    throw new ReconciliationNotFoundError();
  }
  return pilot;
}

// ── Patch items: enter physical counts on a draft ────────────────────────────

export async function patchReconciliationItemsInTx(
  client: PoolClient,
  reconciliationId: number,
  entries: PatchItemEntry[],
  actor: ReconciliationActor,
): Promise<ReconciliationDetail> {
  const row = await lockReconciliation(client, reconciliationId);
  await assertPilotOwnership(client, row);
  const status = String(row.status);
  if (status !== "draft") {
    throw new ReconciliationConflictError(
      `Cannot enter counts on a reconciliation in status '${status}'`,
    );
  }

  // Reject duplicate item ids in the batch up front.
  const seen = new Set<number>();
  for (const e of entries) {
    if (seen.has(e.itemId)) {
      throw new ReconciliationValidationError(
        `Duplicate itemId ${e.itemId} in batch`,
      );
    }
    seen.add(e.itemId);
  }

  for (const e of entries) {
    if (!Number.isFinite(e.actualQuantity) || e.actualQuantity < 0) {
      throw new ReconciliationValidationError(
        `actualQuantity for item ${e.itemId} must be a finite nonnegative number`,
      );
    }
    // Item must belong to this reconciliation.
    const { rows: itemRows } = await client.query(
      `SELECT id, expected_quantity FROM distribution.vehicle_reconciliation_items
        WHERE id = $1 AND reconciliation_id = $2 FOR UPDATE`,
      [e.itemId, reconciliationId],
    );
    if (!itemRows.length) {
      throw new ReconciliationNotFoundError(
        `Item ${e.itemId} not found on reconciliation ${reconciliationId}`,
      );
    }
    const expected = Number(itemRows[0].expected_quantity);
    const actual = round3(e.actualQuantity);
    const discrepancy = round3(actual - expected);
    await client.query(
      `UPDATE distribution.vehicle_reconciliation_items
          SET actual_quantity = $2,
              discrepancy = $3,
              counted_by = $4,
              counted_at = NOW(),
              notes = COALESCE($5, notes)
        WHERE id = $1`,
      [e.itemId, actual, discrepancy, actor.actorId, e.notes],
    );
  }

  return (await loadDetail(client, reconciliationId))!;
}

// ── Review: approved (all zero) or disputed (any nonzero) ─────────────────────

export async function reviewReconciliationInTx(
  client: PoolClient,
  reconciliationId: number,
  actor: ReconciliationActor,
): Promise<ReconciliationDetail> {
  const row = await lockReconciliation(client, reconciliationId);
  await assertPilotOwnership(client, row);
  const status = String(row.status);

  // Idempotent replay: already reviewed → return as-is.
  if (status === "approved" || status === "disputed") {
    return (await loadDetail(client, reconciliationId))!;
  }
  if (status !== "draft") {
    throw new ReconciliationConflictError(
      `Cannot review a reconciliation in status '${status}'`,
    );
  }

  const items = await readItems(client, reconciliationId);
  const uncounted = items.filter((it) => it.actualQuantity == null);
  if (uncounted.length > 0) {
    throw new ReconciliationConflictError(
      `Cannot review: ${uncounted.length} line(s) not yet counted`,
    );
  }

  const anyDiscrepancy = items.some((it) => Math.abs(it.discrepancy) > 1e-9);
  const newStatus = anyDiscrepancy ? "disputed" : "approved";

  // Label-preserving verdict only — NO inventory / stock / claim / label / event
  // mutation happens here.
  await client.query(
    `UPDATE distribution.vehicle_reconciliations
        SET status = $2,
            reviewed_by = $3::bigint,
            reviewed_at = NOW(),
            approved_by = CASE WHEN $2 = 'approved' THEN $3::integer ELSE approved_by END,
            approved_at = CASE WHEN $2 = 'approved' THEN NOW() ELSE approved_at END
      WHERE id = $1`,
    [reconciliationId, newStatus, actor.actorId],
  );

  return (await loadDetail(client, reconciliationId))!;
}

// ── Apply: finalize an approved reconciliation after a staleness re-check ─────

export async function applyReconciliationInTx(
  client: PoolClient,
  reconciliationId: number,
  actor: ReconciliationActor,
): Promise<ReconciliationDetail> {
  const row = await lockReconciliation(client, reconciliationId);
  const pilot = await assertPilotOwnership(client, row);
  const status = String(row.status);

  // Idempotent replay: already applied → return as-is.
  if (status === "applied") {
    return (await loadDetail(client, reconciliationId))!;
  }
  if (status !== "approved") {
    throw new ReconciliationConflictError(
      `Cannot apply a reconciliation in status '${status}' (must be approved)`,
    );
  }

  // Re-lock the pilot vehicle inventory rows deterministically, then re-snapshot
  // and compare against the persisted snapshot. Any added / removed / changed
  // product means the world moved since the counts — reject as stale.
  await client.query(
    `SELECT id FROM inventory
      WHERE warehouse_id = $1 AND quantity <> 0
      ORDER BY product
      FOR UPDATE`,
    [pilot.vehicleWarehouseId],
  );

  const current = await snapshotVehicleInventory(
    client,
    pilot.vehicleWarehouseId,
  );
  const snapshotItems = (await readItems(client, reconciliationId)).filter(
    (it) => it.publicProductId != null,
  );

  const curByProduct = new Map<number, SnapshotRow>();
  for (const c of current) curByProduct.set(c.publicProductId, c);
  const snapByProduct = new Map<number, ReconciliationItem>();
  for (const s of snapshotItems) snapByProduct.set(s.publicProductId!, s);

  if (curByProduct.size !== snapByProduct.size) {
    throw new ReconciliationConflictError(
      "Vehicle inventory changed since the snapshot — reconciliation is stale",
    );
  }
  for (const [pid, cur] of curByProduct) {
    const snap = snapByProduct.get(pid);
    if (!snap) {
      throw new ReconciliationConflictError(
        `Product ${pid} was added to vehicle inventory since the snapshot — reconciliation is stale`,
      );
    }
    if (Math.abs(cur.expectedQuantity - snap.expectedQuantity) > 1e-9) {
      throw new ReconciliationConflictError(
        `Vehicle quantity for product ${pid} changed since the snapshot — reconciliation is stale`,
      );
    }
    const snapWeight = snap.expectedWeightKg ?? 0;
    if (Math.abs(cur.expectedWeightKg - snapWeight) > 1e-9) {
      throw new ReconciliationConflictError(
        `Vehicle weight for product ${pid} changed since the snapshot — reconciliation is stale`,
      );
    }
  }
  for (const pid of snapByProduct.keys()) {
    if (!curByProduct.has(pid)) {
      throw new ReconciliationConflictError(
        `Product ${pid} was removed from vehicle inventory since the snapshot — reconciliation is stale`,
      );
    }
  }

  // Label-preserving finalize only — NO stock_movements / inventory / claim /
  // label / unit-event mutation happens here.
  await client.query(
    `UPDATE distribution.vehicle_reconciliations
        SET status = 'applied',
            applied_by = $2,
            applied_at = NOW()
      WHERE id = $1`,
    [reconciliationId, actor.actorId],
  );

  return (await loadDetail(client, reconciliationId))!;
}

// ── Cancel: draft-only ───────────────────────────────────────────────────────

export async function cancelReconciliationInTx(
  client: PoolClient,
  reconciliationId: number,
  actor: ReconciliationActor,
): Promise<ReconciliationDetail> {
  const row = await lockReconciliation(client, reconciliationId);
  await assertPilotOwnership(client, row);
  const status = String(row.status);

  // Idempotent replay: already cancelled → return as-is.
  if (status === "cancelled") {
    return (await loadDetail(client, reconciliationId))!;
  }
  if (status !== "draft") {
    throw new ReconciliationConflictError(
      `Cannot cancel a reconciliation in status '${status}' (only drafts are cancellable)`,
    );
  }

  await client.query(
    `UPDATE distribution.vehicle_reconciliations
        SET status = 'cancelled'
      WHERE id = $1`,
    [reconciliationId],
  );
  void actor;

  return (await loadDetail(client, reconciliationId))!;
}
