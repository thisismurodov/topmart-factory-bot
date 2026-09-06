// ─────────────────────────────────────────────────────────────────────────────
// F4 Vehicle Handoff Labels — service layer (single TS writer for label state)
//
// Owns the production-label passport lifecycle for a prepared handoff:
//   prepare  → materialise one public.production_labels row + one
//              distribution.vehicle_label_claim + one label_prepared unit event
//              per physical package, idempotent on a client operationKey and a
//              canonical request fingerprint. Barcodes are generated ONLY here
//              (Node randomBytes → RFC4648 Base32, TM prefix, 16 chars).
//   confirm  → first print (prepared → labels_printed) OR reprint; owns the
//              print-session replay, passport print metadata, claim/handoff
//              transitions, and idempotent label_printed events, all in ONE tx.
//   read     → deterministic, immutable, ordered printable payload.
//
// A per-request gate (PRODUCTION_LABELS_SCHEMA_APPROVED) is enforced at the
// router BEFORE any DB work; this module assumes the schema exists.
// ─────────────────────────────────────────────────────────────────────────────

import type { PoolClient } from "pg";
import { createHash, randomBytes } from "node:crypto";
import {
  HandoffConflictError,
  HandoffNotFoundError,
  handoffLockKey,
  getHandoff,
  allocatePackageWeightsKg,
  type HandoffActor,
  type HandoffDetail,
} from "./handoff-service";

const PILOT_WORKER_NAME = "TopMart Ombor";

// ── Barcode generation (TS-only identity) ────────────────────────────────────

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC4648, uppercase

/** RFC4648 Base32 encode without padding. */
function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/** TM + exactly 16 Base32 chars. randomBytes(10) → 80 bits → 16 Base32 chars. */
export function generateBarcode(): string {
  const raw = base32Encode(randomBytes(10)).slice(0, 16);
  return `TM${raw}`;
}

// Regex mirror of the production_labels_barcode_check DB constraint.
const BARCODE_RE = /^TM[A-Z2-7]{16}$/;

/** Insert one production_labels row, retrying on a (very rare) barcode
 *  collision. Returns the persisted barcode + label id. */
async function insertProductionLabel(
  client: PoolClient,
  row: {
    batchCode: string;
    labelNumber: number;
    totalLabels: number;
    piecesPerBox: number;
    piecesInLabel: number;
    quantityTotal: number;
    weightKg: number;
    lengthM: number | null;
    productName: string;
    productSku: string;
    producedAt: string;
    warehouseId: number | null;
    warehouseName: string;
  },
): Promise<{ id: number; barcode: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const barcode = generateBarcode();
    if (!BARCODE_RE.test(barcode)) continue; // defensive; never expected
    try {
      const res = await client.query(
        `INSERT INTO production_labels
           (barcode_value, batch_id, batch_code, label_type, label_number,
             total_labels, pieces_in_label, pieces_per_box, quantity_total,
            weight_kg, length_m, product_name, product_sku, worker_name,
            produced_at, warehouse_id, warehouse_name, status)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                  $14, $15, $16, 'created')
         RETURNING id, barcode_value`,
        [
          barcode,
          row.batchCode,
          row.piecesPerBox > 1 ? "box" : "unit",
          row.labelNumber,
          row.totalLabels,
          row.piecesInLabel,
          row.piecesPerBox,
          row.quantityTotal,
          row.weightKg,
          row.lengthM,
          row.productName,
          row.productSku,
          PILOT_WORKER_NAME,
          row.producedAt,
          row.warehouseId,
          row.warehouseName,
        ],
      );
      return { id: Number(res.rows[0].id), barcode: String(res.rows[0].barcode_value) };
    } catch (e) {
      // Unique violation on barcode → retry with a fresh barcode. Any other
      // constraint (e.g. VH batch label_number) is a real error → propagate.
      const code = (e as { code?: string }).code;
      const constraint = (e as { constraint?: string }).constraint;
      if (
        code === "23505" &&
        (constraint === "uq_production_labels_barcode" ||
          constraint === "production_labels_barcode_value_key")
      ) {
        continue;
      }
      throw e;
    }
  }
  throw new HandoffConflictError("Unable to allocate a unique barcode after retries");
}

// ── Payload types ────────────────────────────────────────────────────────────

export type LabelPassport = {
  productionLabelId: number;
  handoffItemId: number;
  mahsulotId: number;
  barcodeValue: string;
  batchCode: string;
  labelType: string;
  labelNumber: number;
  totalLabels: number;
  piecesInLabel: number;
  remainingQuantity: number;
  piecesPerBox: number;
  quantityTotal: number;
  weightKg: number;
  lengthM: number | null;
  productName: string;
  productSku: string;
  workerName: string;
  producedAt: string;
  warehouseId: number | null;
  warehouseName: string;
  status: string;
  printCount: number;
  lastPrintedAt: string | null;
};

export type LabelsPayload = {
  handoffId: number;
  vehicleId: number;
  batchCode: string;
  totalLabels: number;
  totalPieces: number;
  remainingPieces: number;
  preparedActorType: string | null;
  preparedActorRef: string | null;
  labels: LabelPassport[];
};

export type ConfirmLabelsResult = {
  handoff: HandoffDetail;
  labels: LabelsPayload;
  isReprint: boolean;
  atLeastOnce: boolean;
};

const iso = (v: Date | string | null): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

function batchCodeFor(handoffId: number): string {
  return `VH-${handoffId}`;
}

// ── Canonical request fingerprint ────────────────────────────────────────────

/** Deterministic SHA256 over the handoff + item snapshot, so a same-key replay
 *  with a mutated payload can be rejected. Order-independent on items. */
function computeFingerprint(
  handoff: HandoffDetail,
  barcodes?: readonly string[],
): string {
  const items = [...handoff.items]
    .map((i) => ({
      mahsulotId: i.mahsulotId,
      sku: i.sku,
      productName: i.productName,
      quantity: i.quantity,
      unitWeightKg: i.unitWeightKg,
      totalWeightKg: i.totalWeightKg,
      piecesPerBox: i.piecesPerBox,
    }))
    .sort((a, b) => a.mahsulotId - b.mahsulotId);
  const canonical = JSON.stringify({
    handoffId: handoff.id,
    vehicleId: handoff.vehicleId,
    sourceWarehouseId: handoff.sourceWarehouseId,
    vehicleWarehouseId: handoff.vehicleWarehouseId,
    items,
    ...(barcodes ? { barcodes } : {}),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// ── Read the persisted printable payload ─────────────────────────────────────

async function readLabelsPayloadInTx(
  client: PoolClient,
  handoff: HandoffDetail,
): Promise<LabelsPayload> {
  const batchCode = batchCodeFor(handoff.id);
  const { rows } = await client.query(
    `SELECT pl.id, pl.barcode_value, pl.batch_code, pl.label_type,
            pl.label_number, pl.total_labels, pl.pieces_in_label,
            pl.pieces_per_box, pl.quantity_total, pl.weight_kg, pl.length_m,
            pl.product_name, pl.product_sku, pl.worker_name, pl.produced_at,
            pl.warehouse_id, pl.warehouse_name, pl.status, pl.print_count,
            pl.last_printed_at, c.handoff_item_id, c.mahsulot_id,
            c.status AS claim_status, c.remaining_quantity
       FROM production_labels pl
       JOIN distribution.vehicle_label_claims c
         ON c.production_label_id = pl.id
      WHERE c.handoff_id = $1
       ORDER BY c.id`,
    [handoff.id],
  );
  const unavailable = rows.find(
    (r) => r.claim_status === "return_reserved" || r.claim_status === "returned",
  );
  if (unavailable) {
    throw new HandoffConflictError(
      `Label claim for production label ${unavailable.id} is ${unavailable.claim_status} and cannot be prepared, reloaded or reprinted`,
    );
  }
  const labels: LabelPassport[] = rows.map((r) => ({
    productionLabelId: Number(r.id),
    handoffItemId: Number(r.handoff_item_id),
    mahsulotId: Number(r.mahsulot_id),
    barcodeValue: String(r.barcode_value),
    batchCode: String(r.batch_code),
    labelType: String(r.label_type),
    labelNumber: Number(r.label_number),
    totalLabels: Number(r.total_labels),
    piecesInLabel: Number(r.pieces_in_label),
    remainingQuantity: Number(r.remaining_quantity),
    piecesPerBox: Number(r.pieces_per_box),
    quantityTotal: Number(r.quantity_total),
    weightKg: Number(r.weight_kg),
    lengthM: r.length_m == null ? null : Number(r.length_m),
    productName: String(r.product_name),
    productSku: String(r.product_sku),
    workerName: String(r.worker_name),
    producedAt: iso(r.produced_at as Date | string)!,
    warehouseId: r.warehouse_id == null ? null : Number(r.warehouse_id),
    warehouseName: String(r.warehouse_name),
    status: String(r.status),
    printCount: Number(r.print_count),
    lastPrintedAt: iso(r.last_printed_at as Date | string | null),
  }));
  return {
    handoffId: handoff.id,
    vehicleId: handoff.vehicleId,
    batchCode,
    totalLabels: labels.length,
    totalPieces: labels.reduce((sum, label) => sum + label.piecesInLabel, 0),
    remainingPieces: labels.reduce(
      (sum, label) => sum + label.remainingQuantity,
      0,
    ),
    preparedActorType: handoff.preparedActorType,
    preparedActorRef: handoff.preparedActorRef,
    labels,
  };
}

/** Public read used by GET /labels. 404 when not prepared. */
export async function getLabelsPayload(
  client: PoolClient,
  handoffId: number,
): Promise<LabelsPayload> {
  const handoff = await getHandoff(client, handoffId);
  const { rows } = await client.query(
    `SELECT 1 FROM distribution.vehicle_label_prepare_sessions WHERE handoff_id = $1`,
    [handoffId],
  );
  if (!rows.length) {
    throw new HandoffNotFoundError("Labels have not been prepared for this handoff");
  }
  return readLabelsPayloadInTx(client, handoff);
}

// ── Prepare: materialise passports + claims + events ─────────────────────────

async function pilotProductSnapshot(
  client: PoolClient,
  sku: string,
): Promise<{ lengthM: number | null }> {
  // Package capacity is immutable on the handoff item. Only optional roll
  // length is read here for the production-label passport.
  const cols = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products'
        AND column_name = 'roll_length_m'`,
  );
  const have = new Set(cols.rows.map((r) => String(r.column_name)));
  const lenCol = have.has("roll_length_m") ? "roll_length_m" : "NULL";
  const { rows } = await client.query(
    `SELECT ${lenCol} AS roll_length_m
       FROM products WHERE sku = $1 AND active = TRUE`,
    [sku],
  );
  if (!rows.length) return { lengthM: null };
  const lenRaw = rows[0].roll_length_m;
  // roll_length_m defaults to 0 in the real schema; treat 0 as "no length".
  const lengthM = lenRaw == null || Number(lenRaw) === 0 ? null : Number(lenRaw);
  return { lengthM };
}

export async function prepareLabelsInTx(
  client: PoolClient,
  handoffId: number,
  operationKey: string,
  actor: HandoffActor,
): Promise<LabelsPayload> {
  // F7 sale-gate serialization: the savdo-bot sale path decides plain-vs-strict
  // per dona product by probing distribution.vehicle_label_claims while holding
  // the vehicle-warehouse parent row lock. Creating the FIRST claims for a
  // product must therefore take that same parent lock, and in the same global
  // order as F6 stock transfer (warehouse row BEFORE the per-handoff advisory
  // lock) so prepare/transfer cannot deadlock. Without this, a concurrent sale
  // could probe "no trace", the first claims could commit, and the sale would
  // still commit as a plain row. vehicle_warehouse_id is immutable on the
  // handoff row, so reading it before the advisory lock is safe.
  const lockTarget = await client.query(
    `SELECT vehicle_warehouse_id FROM distribution.vehicle_handoffs
      WHERE id = $1`,
    [handoffId],
  );
  if (lockTarget.rows.length) {
    await client.query(
      `SELECT id FROM public.warehouses WHERE id = $1 FOR UPDATE`,
      [Number(lockTarget.rows[0].vehicle_warehouse_id)],
    );
  }
  // Per-handoff advisory lock so concurrent prepares serialize.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    handoffLockKey(handoffId),
  ]);

  const handoff = await getHandoff(client, handoffId); // scopes to pilot, 404s
  const fingerprint = computeFingerprint(handoff);

  // Idempotency + conflict resolution against the prepare session.
  const bySession = await client.query(
    `SELECT handoff_id, operation_key, request_fingerprint
       FROM distribution.vehicle_label_prepare_sessions
      WHERE handoff_id = $1 OR operation_key = $2
      FOR UPDATE`,
    [handoffId, operationKey],
  );
  for (const s of bySession.rows) {
    const sameHandoff = Number(s.handoff_id) === handoffId;
    const sameKey = String(s.operation_key) === operationKey;
    if (sameHandoff && sameKey) {
      if (String(s.request_fingerprint) !== fingerprint) {
        throw new HandoffConflictError(
          "operationKey replay with a different handoff fingerprint",
        );
      }
      // Exact replay → return the existing payload.
      return readLabelsPayloadInTx(client, handoff);
    }
    if (sameHandoff && !sameKey) {
      throw new HandoffConflictError(
        "Labels already prepared for this handoff with a different operationKey",
      );
    }
    if (!sameHandoff && sameKey) {
      throw new HandoffConflictError(
        "operationKey already used by another handoff's label preparation",
      );
    }
  }

  if (handoff.labelMode !== "generated") {
    throw new HandoffConflictError(
      "Configured Top Mart C-3 handoffs must claim already-printed production labels; creating new labels is forbidden",
    );
  }

  if (handoff.status !== "prepared") {
    throw new HandoffConflictError(
      `Cannot prepare labels from status '${handoff.status}'`,
    );
  }
  if (!handoff.items.length) {
    throw new HandoffConflictError("Handoff has no items to prepare labels for");
  }

  // Inventory quantities stay in pieces. Physical labels are package-counts.
  const totalLabels = handoff.items.reduce(
    (n, it) => n + Math.ceil(it.quantity / it.piecesPerBox),
    0,
  );
  if (!(totalLabels > 0)) {
    throw new HandoffConflictError("Handoff has no physical units");
  }

  const batchCode = batchCodeFor(handoffId);
  const producedAt = handoff.createdAt;
  const warehouseId = handoff.sourceWarehouseId;
  // Source warehouse name snapshot.
  const whRes = await client.query(
    `SELECT name FROM warehouses WHERE id = $1`,
    [warehouseId],
  );
  const warehouseName = whRes.rows.length ? String(whRes.rows[0].name) : "";

  // Globally ordered label_number 1..totalLabels across all package labels.
  let labelNumber = 0;
  for (const it of handoff.items) {
    if (it.unitWeightKg == null || !(it.unitWeightKg > 0)) {
      throw new HandoffConflictError(
        `Item ${it.id} has no positive unit weight snapshot`,
      );
    }
    if (it.totalWeightKg == null || !(it.totalWeightKg > 0)) {
      throw new HandoffConflictError(
        `Item ${it.id} has no positive total weight snapshot`,
      );
    }
    if (!Number.isInteger(it.piecesPerBox) || it.piecesPerBox <= 0) {
      throw new HandoffConflictError(
        `Item ${it.id} has an invalid pieces_per_box snapshot`,
      );
    }
    const snap = await pilotProductSnapshot(client, it.sku);
    let remaining = it.quantity;
    const packageWeightsKg = allocatePackageWeightsKg(
      it.totalWeightKg,
      it.quantity,
      it.piecesPerBox,
    );
    let packageIndex = 0;
    while (remaining > 0) {
      const piecesInLabel = Math.min(it.piecesPerBox, remaining);
      const packageWeightKg = packageWeightsKg[packageIndex++];
      labelNumber += 1;
      const { id: productionLabelId, barcode } = await insertProductionLabel(
        client,
        {
          batchCode,
          labelNumber,
          totalLabels,
          piecesPerBox: it.piecesPerBox,
          piecesInLabel,
          quantityTotal: it.quantity,
          weightKg: packageWeightKg,
          lengthM: snap.lengthM,
          productName: it.productName ?? "",
          productSku: it.sku,
          producedAt,
          warehouseId,
          warehouseName,
        },
      );

      // One cross-handoff claim per physical package. The per-piece weight and
      // remaining piece quantity make partial sales exact.
      await client.query(
        `INSERT INTO distribution.vehicle_label_claims
           (vehicle_id, handoff_id, handoff_item_id, production_label_id, barcode,
             mahsulot_id, sku, unit_weight_kg, pieces_in_label,
             remaining_quantity, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, 'prepared')`,
        [
          handoff.vehicleId,
          handoffId,
          it.id,
          productionLabelId,
          barcode,
          it.mahsulotId,
          it.sku,
          it.unitWeightKg,
          piecesInLabel,
        ],
      );

      // Idempotent label_prepared event, measured in pieces.
      const opKey = `label_prepared:${handoffId}:${productionLabelId}`;
      await client.query(
        `INSERT INTO distribution.vehicle_unit_events
           (vehicle_id, handoff_id, handoff_item_id, mahsulot_id, sku, event_type,
            quantity, actor_id, production_label_id, barcode, operation_key)
          VALUES ($1, $2, $3, $4, $5, 'label_prepared', $6, $7, $8, $9, $10)
         ON CONFLICT (operation_key) WHERE operation_key IS NOT NULL DO NOTHING`,
        [
          handoff.vehicleId,
          handoffId,
          it.id,
          it.mahsulotId,
          it.sku,
          piecesInLabel,
          actor.actorId,
          productionLabelId,
          barcode,
          opKey,
        ],
      );
      remaining -= piecesInLabel;
    }
  }

  // Exactly one prepare session per handoff.
  await client.query(
    `INSERT INTO distribution.vehicle_label_prepare_sessions
       (handoff_id, operation_key, request_fingerprint, label_count,
        actor_type, actor_ref)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [handoffId, operationKey, fingerprint, totalLabels, actor.type, actor.ref],
  );

  return readLabelsPayloadInTx(client, handoff);
}

// ── Claim existing C-3 passports (no production_labels writes) ───────────────

export async function claimExistingLabelsInTx(
  client: PoolClient,
  handoffId: number,
  operationKey: string,
  scannedBarcodes: string[],
  actor: HandoffActor,
): Promise<LabelsPayload> {
  if (new Set(scannedBarcodes).size !== scannedBarcodes.length) {
    throw new HandoffConflictError("Scanned barcode list contains duplicates");
  }

  // Keep the established sale/transfer lock order: vehicle warehouse parent,
  // handoff advisory lock, then label rows in global production-label id order.
  const lockTarget = await client.query(
    `SELECT vehicle_warehouse_id FROM distribution.vehicle_handoffs WHERE id=$1`,
    [handoffId],
  );
  if (lockTarget.rows.length) {
    await client.query(
      `SELECT id FROM public.warehouses WHERE id=$1 FOR UPDATE`,
      [Number(lockTarget.rows[0].vehicle_warehouse_id)],
    );
  }
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    handoffLockKey(handoffId),
  ]);

  const handoff = await getHandoff(client, handoffId);
  if (handoff.labelMode !== "existing") {
    throw new HandoffConflictError(
      "Existing production labels may only be claimed for an existing-label handoff",
    );
  }
  let fingerprint = computeFingerprint(handoff, scannedBarcodes);

  const sessions = await client.query(
    `SELECT handoff_id, operation_key, request_fingerprint
       FROM distribution.vehicle_label_prepare_sessions
      WHERE handoff_id=$1 OR operation_key=$2
      FOR UPDATE`,
    [handoffId, operationKey],
  );
  for (const session of sessions.rows) {
    const sameHandoff = Number(session.handoff_id) === handoffId;
    const sameKey = String(session.operation_key) === operationKey;
    if (sameHandoff && sameKey) {
      if (String(session.request_fingerprint) !== fingerprint) {
        throw new HandoffConflictError(
          "operationKey replay with a different barcode payload or handoff fingerprint",
        );
      }
      return readLabelsPayloadInTx(client, handoff);
    }
    if (sameHandoff) {
      throw new HandoffConflictError(
        "Labels already claimed for this handoff with a different operationKey",
      );
    }
    throw new HandoffConflictError(
      "operationKey already used by another handoff's label claim",
    );
  }

  if (handoff.status !== "prepared") {
    throw new HandoffConflictError(
      `Cannot claim labels from status '${handoff.status}'`,
    );
  }
  if (!handoff.items.length || !scannedBarcodes.length) {
    throw new HandoffConflictError(
      "Handoff items and scanned barcode list must not be empty",
    );
  }

  // Lock by immutable global id, independent of scanner order, to avoid
  // deadlocks between overlapping concurrent claims.
  const labelsResult = await client.query(
    `SELECT id, barcode_value, batch_id, status, print_count,
            pieces_in_label, weight_kg, product_sku
       FROM public.production_labels
      WHERE barcode_value=ANY($1::text[])
      ORDER BY id
      FOR UPDATE`,
    [scannedBarcodes],
  );
  if (labelsResult.rows.length !== scannedBarcodes.length) {
    throw new HandoffConflictError(
      "Every scanned barcode must identify an existing production label",
    );
  }
  const byBarcode = new Map(
    labelsResult.rows.map((row) => [String(row.barcode_value), row]),
  );
  const labels = scannedBarcodes.map((barcode) => byBarcode.get(barcode)!);
  for (const label of labels) {
    if (
      label.batch_id == null ||
      String(label.status) !== "printed" ||
      Number(label.print_count) <= 0
    ) {
      throw new HandoffConflictError(
        `Production label ${label.barcode_value} must be an already-printed, non-void batch label`,
      );
    }
    if (
      !Number.isSafeInteger(Number(label.pieces_in_label)) ||
      Number(label.pieces_in_label) <= 0 ||
      !(Number(label.weight_kg) > 0)
    ) {
      throw new HandoffConflictError(
        `Production label ${label.barcode_value} must have positive package pieces and weight`,
      );
    }
  }

  const received = await client.query(
    `SELECT production_label_id, barcode, product_sku, pieces_in_label, weight_kg
       FROM distribution.topmart_label_receipts
      WHERE production_label_id=ANY($1::int[])
        AND central_warehouse_id=$2
      ORDER BY production_label_id
      FOR SHARE`,
    [labels.map((label) => Number(label.id)), handoff.sourceWarehouseId],
  );
  if (received.rows.length !== labels.length) {
    throw new HandoffConflictError(
      "Every claimed label must have immutable receipt provenance at the handoff source warehouse",
    );
  }
  const receiptByLabelId = new Map(
    received.rows.map((receipt) => [Number(receipt.production_label_id), receipt]),
  );
  for (const label of labels) {
    const receipt = receiptByLabelId.get(Number(label.id));
    if (
      !receipt
      || String(receipt.barcode) !== String(label.barcode_value)
      || String(receipt.product_sku) !== String(label.product_sku)
      || Number(receipt.pieces_in_label) !== Number(label.pieces_in_label)
      || Math.abs(Number(receipt.weight_kg) - Number(label.weight_kg)) > 0.001
    ) {
      throw new HandoffConflictError(
        `Immutable receipt provenance does not match production label ${label.barcode_value}`,
      );
    }
  }

  const claimed = await client.query(
    `SELECT production_label_id, barcode
       FROM distribution.vehicle_label_claims
      WHERE production_label_id=ANY($1::int[]) OR barcode=ANY($2::text[])
      ORDER BY production_label_id
      FOR UPDATE`,
    [labels.map((label) => Number(label.id)), scannedBarcodes],
  );
  if (claimed.rows.length) {
    throw new HandoffConflictError(
      `Production label ${claimed.rows[0].barcode} is already vehicle-claimed`,
    );
  }

  // Match by exact SKU, while assigning same-SKU packages in scanner order to
  // same-SKU handoff items in immutable item order. A package is never split.
  const labelsBySku = new Map<string, Array<Record<string, unknown>>>();
  for (const label of labels) {
    const sku = String(label.product_sku);
    const skuLabels = labelsBySku.get(sku) ?? [];
    skuLabels.push(label);
    labelsBySku.set(sku, skuLabels);
  }
  const assignments: Array<{
    item: HandoffDetail["items"][number];
    label: Record<string, unknown>;
  }> = [];
  for (const item of handoff.items) {
    const skuLabels = labelsBySku.get(item.sku) ?? [];
    let covered = 0;
    let coveredWeightKg = 0;
    while (covered < item.quantity && skuLabels.length) {
      const label = skuLabels.shift()!;
      covered += Number(label.pieces_in_label);
      coveredWeightKg += Number(label.weight_kg);
      if (covered > item.quantity) {
        throw new HandoffConflictError(
          `Barcode ${label.barcode_value} exceeds exact piece coverage for handoff item ${item.id}`,
        );
      }
      assignments.push({ item, label });
    }
    labelsBySku.set(item.sku, skuLabels);
    if (covered !== item.quantity) {
      throw new HandoffConflictError(
        `Scanned labels with exact SKU ${item.sku} do not exactly cover handoff item ${item.id}`,
      );
    }
  }
  const extraLabel = [...labelsBySku.values()].find(
    (skuLabels) => skuLabels.length > 0,
  )?.[0];
  if (extraLabel) {
    throw new HandoffConflictError(
      `Barcode ${extraLabel.barcode_value} has no exact SKU/piece coverage in the handoff`,
    );
  }

  // Label packages (already tied to an immutable C-3 receipt) are the weight
  // authority. Lock inventory and check the complete selected quantity/weight
  // before freezing each item snapshot. Stock itself is not mutated here.
  const requiredByProduct = new Map<
    string,
    { quantity: number; weightKg: number }
  >();
  const authorityByItem = new Map<number, number>();
  for (const { item, label } of assignments) {
    const packageWeight = Number(label.weight_kg);
    authorityByItem.set(
      item.id,
      (authorityByItem.get(item.id) ?? 0) + packageWeight,
    );
  }
  for (const item of handoff.items) {
    const totalWeightKg = authorityByItem.get(item.id) ?? 0;
    const productName = item.productName!;
    const current = requiredByProduct.get(productName) ?? {
      quantity: 0,
      weightKg: 0,
    };
    current.quantity += item.quantity;
    current.weightKg += totalWeightKg;
    requiredByProduct.set(productName, current);
  }
  for (const productName of [...requiredByProduct.keys()].sort()) {
    const need = requiredByProduct.get(productName)!;
    const inventory = await client.query(
      `SELECT quantity, weight_kg
         FROM public.inventory
        WHERE warehouse_id=$1 AND product=$2
        FOR UPDATE`,
      [handoff.sourceWarehouseId, productName],
    );
    const haveQuantity = inventory.rows.length
      ? Number(inventory.rows[0].quantity)
      : 0;
    const haveWeightKg = inventory.rows.length
      ? Number(inventory.rows[0].weight_kg)
      : 0;
    if (
      haveQuantity < need.quantity
      || haveWeightKg + 1e-9 < need.weightKg
    ) {
      throw new HandoffConflictError(
        `C-3 inventory cannot cover selected ${productName}: need ${need.quantity} pieces / ${need.weightKg.toFixed(3)} kg, have ${haveQuantity} / ${haveWeightKg.toFixed(3)} kg`,
      );
    }
  }
  for (const item of handoff.items) {
    const totalWeightKg = authorityByItem.get(item.id)!;
    await client.query(
      `UPDATE distribution.vehicle_handoff_items
          SET total_weight_kg=$2, unit_weight_kg=$3
        WHERE id=$1`,
      [item.id, totalWeightKg, totalWeightKg / item.quantity],
    );
    item.totalWeightKg = totalWeightKg;
    item.unitWeightKg = totalWeightKg / item.quantity;
  }
  fingerprint = computeFingerprint(handoff, scannedBarcodes);

  for (const { item, label } of assignments) {
    const productionLabelId = Number(label.id);
    const barcode = String(label.barcode_value);
    const pieces = Number(label.pieces_in_label);
    const insertedClaim = await client.query(
      `INSERT INTO distribution.vehicle_label_claims
         (vehicle_id, handoff_id, handoff_item_id, production_label_id, barcode,
          mahsulot_id, sku, unit_weight_kg, pieces_in_label,
          remaining_quantity, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,'printed')
       RETURNING id`,
      [
        handoff.vehicleId,
        handoffId,
        item.id,
        productionLabelId,
        barcode,
        item.mahsulotId,
        item.sku,
        Number(label.weight_kg) / pieces,
        pieces,
      ],
    );
    const claimId = Number(insertedClaim.rows[0].id);
    for (const eventType of ["label_prepared", "label_printed"] as const) {
      await client.query(
        `INSERT INTO distribution.vehicle_unit_events
           (vehicle_id, handoff_id, handoff_item_id, mahsulot_id, sku,
            event_type, quantity, actor_id, production_label_id, barcode,
            label_claim_id, operation_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (operation_key) WHERE operation_key IS NOT NULL DO NOTHING`,
        [
          handoff.vehicleId,
          handoffId,
          item.id,
          item.mahsulotId,
          item.sku,
          eventType,
          pieces,
          actor.actorId,
          productionLabelId,
          barcode,
          claimId,
          `${eventType}:${handoffId}:${productionLabelId}`,
        ],
      );
    }
  }

  await client.query(
    `INSERT INTO distribution.vehicle_label_prepare_sessions
       (handoff_id, operation_key, request_fingerprint, label_count,
        actor_type, actor_ref)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      handoffId,
      operationKey,
      fingerprint,
      assignments.length,
      actor.type,
      actor.ref,
    ],
  );
  await client.query(
    `UPDATE distribution.vehicle_handoffs
        SET status='labels_printed', labels_printed_at=NOW(),
            labels_printed_by=$2
      WHERE id=$1`,
    [handoffId, actor.actorId],
  );
  return readLabelsPayloadInTx(client, await getHandoff(client, handoffId));
}

// ── Confirm: first print + reprint, print-session owned ──────────────────────

// Terminal-ish states in which a reprint (but not a first print) is allowed.
const REPRINT_STATES = new Set([
  "labels_printed",
  "handed_over",
  "stock_transferred",
]);

export async function confirmLabelsPrintedInTx(
  client: PoolClient,
  handoffId: number,
  operationKey: string,
  actor: HandoffActor,
): Promise<ConfirmLabelsResult> {
  // Per-handoff advisory lock — serialize all confirms on this handoff.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    handoffLockKey(handoffId),
  ]);

  // Lock the handoff row.
  const { rows: hRows } = await client.query(
    `SELECT id, status FROM distribution.vehicle_handoffs WHERE id = $1 FOR UPDATE`,
    [handoffId],
  );
  if (!hRows.length) throw new HandoffNotFoundError();

  const handoff = await getHandoff(client, handoffId); // scopes to pilot
  const status = handoff.status;
  if (handoff.labelMode !== "generated") {
    throw new HandoffConflictError(
      "Top Mart C-3 handoffs use existing production labels and cannot be confirmed or reprinted",
    );
  }

  // A prepare session MUST exist before any confirm.
  const prep = await client.query(
    `SELECT id FROM distribution.vehicle_label_prepare_sessions
      WHERE handoff_id = $1 FOR UPDATE`,
    [handoffId],
  );
  if (!prep.rows.length) {
    throw new HandoffConflictError("Labels have not been prepared for this handoff");
  }

  if (status === "cancelled") {
    throw new HandoffConflictError("Cannot confirm labels for a cancelled handoff");
  }

  // Idempotency: a print session for THIS operationKey.
  const existingSession = await client.query(
    `SELECT handoff_id, is_reprint FROM distribution.vehicle_label_print_sessions
      WHERE operation_key = $1 FOR UPDATE`,
    [operationKey],
  );
  if (existingSession.rows.length) {
    const s = existingSession.rows[0];
    if (Number(s.handoff_id) !== handoffId) {
      throw new HandoffConflictError(
        "operationKey already used by another handoff's confirm",
      );
    }
    // Same-key retry → no increment, return current state.
    const labels = await readLabelsPayloadInTx(client, handoff);
    return {
      handoff,
      labels,
      isReprint: Boolean(s.is_reprint),
      atLeastOnce: true,
    };
  }

  // Lock all claims for this handoff.
  const { rows: claims } = await client.query(
    `SELECT id, production_label_id, status, pieces_in_label
       FROM distribution.vehicle_label_claims
      WHERE handoff_id = $1 ORDER BY id FOR UPDATE`,
    [handoffId],
  );
  if (!claims.length) {
    throw new HandoffConflictError("Handoff has no label claims to confirm");
  }
  const unavailableClaim = claims.find(
    (c) => c.status === "return_reserved" || c.status === "returned",
  );
  if (unavailableClaim) {
    throw new HandoffConflictError(
      `Label claim ${unavailableClaim.id} is ${unavailableClaim.status} and cannot be reprinted`,
    );
  }

  // Reject void production labels (a void passport cannot be printed).
  const labelIds = claims.map((c) => Number(c.production_label_id));
  const { rows: plRows } = await client.query(
    `SELECT id, status FROM production_labels WHERE id = ANY($1::int[]) FOR UPDATE`,
    [labelIds],
  );
  for (const pl of plRows) {
    if (String(pl.status) === "void") {
      throw new HandoffConflictError(
        `Production label ${pl.id} is void and cannot be printed`,
      );
    }
  }

  const isFirstPrint = status === "prepared";
  const isReprint = !isFirstPrint && REPRINT_STATES.has(status);
  if (!isFirstPrint && !isReprint) {
    throw new HandoffConflictError(
      `Cannot confirm labels printed from status '${status}'`,
    );
  }

  // Increment each passport once per NEW print session (created/printed only).
  await client.query(
    `UPDATE production_labels
        SET status = 'printed',
            print_count = print_count + 1,
            last_printed_at = NOW()
      WHERE id = ANY($1::int[]) AND status IN ('created','printed')`,
    [labelIds],
  );

  if (isFirstPrint) {
    // Advance claims prepared → printed (leave any other state untouched).
    await client.query(
      `UPDATE distribution.vehicle_label_claims
          SET status = 'printed', updated_at = NOW()
        WHERE handoff_id = $1 AND status = 'prepared'`,
      [handoffId],
    );
    // Idempotent label_printed events, one per claim.
    for (const c of claims) {
      const opKey = `label_printed:${handoffId}:${c.id}`;
      await client.query(
        `INSERT INTO distribution.vehicle_unit_events
           (vehicle_id, handoff_id, mahsulot_id, sku, event_type, quantity,
            actor_id, production_label_id, label_claim_id, operation_key)
         SELECT c.vehicle_id, c.handoff_id, c.mahsulot_id, c.sku, 'label_printed',
                 c.pieces_in_label, $2, c.production_label_id, c.id, $3
           FROM distribution.vehicle_label_claims c WHERE c.id = $1
         ON CONFLICT (operation_key) WHERE operation_key IS NOT NULL DO NOTHING`,
        [c.id, actor.actorId, opKey],
      );
    }
    // Advance the handoff.
    await client.query(
      `UPDATE distribution.vehicle_handoffs
          SET status = 'labels_printed',
              labels_printed_at = NOW(),
              labels_printed_by = $2
        WHERE id = $1`,
      [handoffId, actor.actorId],
    );
  }
  // On reprint we DO NOT touch claim loaded/sold states or the handoff status.

  const labelCount = claims.length;
  await client.query(
    `INSERT INTO distribution.vehicle_label_print_sessions
       (handoff_id, operation_key, label_count, is_reprint, actor_type, actor_ref)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [handoffId, operationKey, labelCount, isReprint, actor.type, actor.ref],
  );

  const freshHandoff = await getHandoff(client, handoffId);
  const labels = await readLabelsPayloadInTx(client, freshHandoff);
  return { handoff: freshHandoff, labels, isReprint, atLeastOnce: true };
}
