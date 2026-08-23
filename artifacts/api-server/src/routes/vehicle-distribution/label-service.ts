// ─────────────────────────────────────────────────────────────────────────────
// F4 Vehicle Handoff Labels — service layer (single TS writer for label state)
//
// Owns the production-label passport lifecycle for a prepared handoff:
//   prepare  → materialise one public.production_labels row + one
//              distribution.vehicle_label_claim + one label_prepared unit event
//              per physical unit, idempotent on a client operationKey and a
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
         VALUES ($1, NULL, $2, 'unit', $3, $4, 1, $5, $6, $7, $8, $9, $10, $11,
                 $12, $13, $14, 'created')
         RETURNING id, barcode_value`,
        [
          barcode,
          row.batchCode,
          row.labelNumber,
          row.totalLabels,
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
function computeFingerprint(handoff: HandoffDetail): string {
  const items = [...handoff.items]
    .map((i) => ({
      mahsulotId: i.mahsulotId,
      sku: i.sku,
      productName: i.productName,
      quantity: i.quantity,
      unitWeightKg: i.unitWeightKg,
    }))
    .sort((a, b) => a.mahsulotId - b.mahsulotId);
  const canonical = JSON.stringify({
    handoffId: handoff.id,
    vehicleId: handoff.vehicleId,
    sourceWarehouseId: handoff.sourceWarehouseId,
    vehicleWarehouseId: handoff.vehicleWarehouseId,
    items,
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
            c.status AS claim_status
       FROM production_labels pl
       JOIN distribution.vehicle_label_claims c
         ON c.production_label_id = pl.id
      WHERE c.handoff_id = $1
      ORDER BY pl.label_number`,
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
): Promise<{ piecesPerBox: number; lengthM: number | null }> {
  // Snapshot pieces_per_box + roll_length_m from the current public product,
  // when available. Some deployments (and test harnesses) carry a slimmer
  // products table, so we probe the columns first and fail-open on absence:
  // pieces_per_box defaults to 1, length null.
  const cols = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products'
        AND column_name IN ('pieces_per_box','roll_length_m')`,
  );
  const have = new Set(cols.rows.map((r) => String(r.column_name)));
  const ppbCol = have.has("pieces_per_box") ? "pieces_per_box" : "1";
  const lenCol = have.has("roll_length_m") ? "roll_length_m" : "NULL";
  const { rows } = await client.query(
    `SELECT ${ppbCol} AS pieces_per_box, ${lenCol} AS roll_length_m
       FROM products WHERE sku = $1 AND active = TRUE`,
    [sku],
  );
  if (!rows.length) return { piecesPerBox: 1, lengthM: null };
  const ppb = rows[0].pieces_per_box == null ? 1 : Number(rows[0].pieces_per_box);
  const lenRaw = rows[0].roll_length_m;
  // roll_length_m defaults to 0 in the real schema; treat 0 as "no length".
  const lengthM = lenRaw == null || Number(lenRaw) === 0 ? null : Number(lenRaw);
  return { piecesPerBox: ppb > 0 ? ppb : 1, lengthM };
}

export async function prepareLabelsInTx(
  client: PoolClient,
  handoffId: number,
  operationKey: string,
  actor: HandoffActor,
): Promise<LabelsPayload> {
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

  if (handoff.status !== "prepared") {
    throw new HandoffConflictError(
      `Cannot prepare labels from status '${handoff.status}'`,
    );
  }
  if (!handoff.items.length) {
    throw new HandoffConflictError("Handoff has no items to prepare labels for");
  }

  // Total physical units across all items = total labels.
  const totalLabels = handoff.items.reduce((n, it) => n + it.quantity, 0);
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

  // Globally ordered label_number 1..totalLabels across all items.
  let labelNumber = 0;
  for (const it of handoff.items) {
    if (it.unitWeightKg == null || !(it.unitWeightKg > 0)) {
      throw new HandoffConflictError(
        `Item ${it.id} has no positive unit weight snapshot`,
      );
    }
    const snap = await pilotProductSnapshot(client, it.sku);
    for (let u = 0; u < it.quantity; u++) {
      labelNumber += 1;
      const { id: productionLabelId, barcode } = await insertProductionLabel(
        client,
        {
          batchCode,
          labelNumber,
          totalLabels,
          piecesPerBox: snap.piecesPerBox,
          quantityTotal: it.quantity,
          weightKg: it.unitWeightKg,
          lengthM: snap.lengthM,
          productName: it.productName ?? "",
          productSku: it.sku,
          producedAt,
          warehouseId,
          warehouseName,
        },
      );

      // One cross-handoff claim per physical unit.
      await client.query(
        `INSERT INTO distribution.vehicle_label_claims
           (vehicle_id, handoff_id, handoff_item_id, production_label_id, barcode,
            mahsulot_id, sku, unit_weight_kg, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'prepared')`,
        [
          handoff.vehicleId,
          handoffId,
          it.id,
          productionLabelId,
          barcode,
          it.mahsulotId,
          it.sku,
          it.unitWeightKg,
        ],
      );

      // Idempotent label_prepared unit event, one per physical unit.
      const opKey = `label_prepared:${handoffId}:${productionLabelId}`;
      await client.query(
        `INSERT INTO distribution.vehicle_unit_events
           (vehicle_id, handoff_id, handoff_item_id, mahsulot_id, sku, event_type,
            quantity, actor_id, production_label_id, barcode, operation_key)
         VALUES ($1, $2, $3, $4, $5, 'label_prepared', 1, $6, $7, $8, $9)
         ON CONFLICT (operation_key) WHERE operation_key IS NOT NULL DO NOTHING`,
        [
          handoff.vehicleId,
          handoffId,
          it.id,
          it.mahsulotId,
          it.sku,
          actor.actorId,
          productionLabelId,
          barcode,
          opKey,
        ],
      );
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
    `SELECT id, production_label_id, status
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
                1, $2, c.production_label_id, c.id, $3
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
