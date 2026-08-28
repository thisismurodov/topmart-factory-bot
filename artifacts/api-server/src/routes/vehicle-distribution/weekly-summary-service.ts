import type { PoolClient } from "pg";
import {
  PILOT_AGENT_NAME,
  PILOT_VEHICLE_PLATE,
  PILOT_VEHICLE_TYPE,
  PILOT_WAREHOUSE_LOCATION_TYPE,
  PILOT_WAREHOUSE_NAME,
  PILOT_WAREHOUSE_PURPOSE,
} from "./service";

export const WEEKLY_QTY_TOLERANCE = 0.001;
export const WEEKLY_WEIGHT_TOLERANCE_KG = 0.001;
export const WEEKLY_BLOCKER_DETAIL_LIMIT = 25;

export class WeeklySummaryValidationError extends Error {}
export class WeeklySummaryPilotNotFoundError extends Error {}

type Pilot = { vehicleId: number; warehouseId: number };
type Metric = { quantity: number; weightKg: number };
type ProductAcc = {
  publicProductId: number;
  productName: string;
  sku: string;
  inventory: Metric;
  claims: Metric;
  handedBack: Metric;
  events: Metric;
  movements: Metric;
  physicalLabels: number;
  identityBlocked: boolean;
};
type Blocker = {
  type: string;
  totalCount: number;
  details: Array<{ id: string; status: string; message: string }>;
  truncated: boolean;
};

const zero = (): Metric => ({ quantity: 0, weightKg: 0 });
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const add = (a: Metric, quantity: number, weightKg: number): void => {
  a.quantity = round3(a.quantity + quantity);
  a.weightKg = round3(a.weightKg + weightKg);
};
const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : String(v);

function civilFromInstant(now: Date): string {
  return new Date(now.getTime() + 5 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function addCivilDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function currentMonday(today: string): string {
  const day = new Date(`${today}T00:00:00.000Z`).getUTCDay();
  return addCivilDays(today, -(day === 0 ? 6 : day - 1));
}

export function resolveWeeklyWindow(
  requestedWeekStart: string | undefined,
  now = new Date(),
): {
  weekStart: string;
  weekEndExclusive: string;
  utcStart: string;
  utcEndExclusive: string;
  today: string;
  currentWeek: boolean;
  requiredDates: string[];
  defaulted: boolean;
} {
  const today = civilFromInstant(now);
  const thisMonday = currentMonday(today);
  const weekStart = requestedWeekStart ?? thisMonday;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    throw new WeeklySummaryValidationError("weekStart must be YYYY-MM-DD");
  }
  const parsed = new Date(`${weekStart}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== weekStart
  ) {
    throw new WeeklySummaryValidationError("weekStart must be a valid civil date");
  }
  if (parsed.getUTCDay() !== 1) {
    throw new WeeklySummaryValidationError("weekStart must be a Monday");
  }
  if (weekStart > thisMonday) {
    throw new WeeklySummaryValidationError("Future weeks are not allowed");
  }
  const currentWeek = weekStart === thisMonday;
  const requiredCount = currentWeek
    ? Math.floor(
        (new Date(`${today}T00:00:00Z`).getTime() - parsed.getTime()) /
          86_400_000,
      ) + 1
    : 7;
  return {
    weekStart,
    weekEndExclusive: addCivilDays(weekStart, 7),
    utcStart: `${addCivilDays(weekStart, -1)}T19:00:00.000Z`,
    utcEndExclusive: `${addCivilDays(weekStart, 6)}T19:00:00.000Z`,
    today,
    currentWeek,
    requiredDates: Array.from({ length: requiredCount }, (_, i) =>
      addCivilDays(weekStart, i),
    ),
    defaulted: requestedWeekStart == null,
  };
}

async function resolvePilot(client: PoolClient): Promise<Pilot> {
  const { rows } = await client.query(
    `SELECT v.id vehicle_id,v.plate_number,v.vehicle_type,v.warehouse_id,
            w.name,w.active,COALESCE(w.location_type,'general') location_type,w.purpose
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
    throw new WeeklySummaryPilotNotFoundError("Exact pilot not found");
  }
  return {
    vehicleId: Number(rows[0].vehicle_id),
    warehouseId: Number(rows[0].warehouse_id),
  };
}

function pushBlocker(
  all: Map<string, Array<{ id: string; status: string; message: string }>>,
  type: string,
  id: unknown,
  status: unknown,
  message: string,
): void {
  const list = all.get(type) ?? [];
  if (list.some((entry) => entry.id === String(id))) return;
  list.push({ id: String(id), status: String(status), message });
  all.set(type, list);
}

function getProduct(
  products: Map<number, ProductAcc>,
  row: Record<string, unknown>,
): ProductAcc {
  const id = Number(row.public_product_id);
  let p = products.get(id);
  if (!p) {
    p = {
      publicProductId: id,
      productName: String(row.product_name),
      sku: String(row.sku),
      inventory: zero(),
      claims: zero(),
      handedBack: zero(),
      events: zero(),
      movements: zero(),
      physicalLabels: 0,
      identityBlocked: false,
    };
    products.set(id, p);
  }
  return p;
}

/** Read-only exact-pilot weekly operational reconciliation. */
export async function readPilotWeeklySummary(
  client: PoolClient,
  requestedWeekStart?: string,
  now = new Date(),
) {
  const window = resolveWeeklyWindow(requestedWeekStart, now);
  const pilot = await resolvePilot(client);
  const products = new Map<number, ProductAcc>();
  const blockers = new Map<
    string,
    Array<{ id: string; status: string; message: string }>
  >();

  const inventory = await client.query(
    `SELECT i.id,i.product,i.quantity,COALESCE(i.weight_kg,0) weight_kg,
            p.id public_product_id,p.name product_name,p.sku,p.active,
            count(p.id) OVER (PARTITION BY i.id) mapping_count
       FROM public.inventory i
       LEFT JOIN public.products p ON p.name=i.product
      WHERE i.warehouse_id=$1`,
    [pilot.warehouseId],
  );
  for (const r of inventory.rows) {
    if (
      Number(r.mapping_count) !== 1 ||
      r.active !== true ||
      !String(r.sku ?? "").trim()
    ) {
      pushBlocker(
        blockers,
        "identity_mapping",
        `inventory:${r.id}`,
        "unresolved",
        `Inventory product '${r.product}' lacks one active canonical product with SKU`,
      );
      continue;
    }
    add(getProduct(products, r).inventory, Number(r.quantity), Number(r.weight_kg));
  }

  const claims = await client.query(
    `SELECT c.id,c.status,c.sku,c.unit_weight_kg,c.remaining_quantity,
             r.status return_status,
            p.id public_product_id,p.name product_name,p.sku canonical_sku,p.active,
            m.faol mahsulot_active,m.sku mahsulot_sku,
            count(p.id) OVER (PARTITION BY c.id) mapping_count
       FROM distribution.vehicle_label_claims c
       LEFT JOIN distribution.vehicle_returns r ON r.id=c.return_id
       LEFT JOIN distribution.mahsulotlar m ON m.id=c.mahsulot_id
       LEFT JOIN public.products p ON p.sku=c.sku
      WHERE c.vehicle_id=$1
        AND c.status IN ('loaded','return_reserved')`,
    [pilot.vehicleId],
  );
  for (const r of claims.rows) {
    const valid =
      Number(r.mapping_count) === 1 &&
      r.active === true &&
      String(r.canonical_sku ?? "").trim() !== "" &&
      Number(r.mahsulot_active) === 1 &&
      String(r.mahsulot_sku) === String(r.sku);
    if (!valid) {
      pushBlocker(
        blockers,
        "identity_mapping",
        `claim:${r.id}`,
        "unresolved",
        `Claim SKU '${r.sku}' lacks one active canonical product`,
      );
      continue;
    }
    const p = getProduct(products, r);
    const remainingQuantity = Number(r.remaining_quantity);
    const remainingWeight = remainingQuantity * Number(r.unit_weight_kg);
    if (r.status === "loaded" || r.return_status === "prepared") {
      p.physicalLabels += 1;
      add(p.claims, remainingQuantity, remainingWeight);
    } else if (r.status === "return_reserved" && r.return_status === "handed_back") {
      p.physicalLabels += 1;
      add(p.handedBack, remainingQuantity, remainingWeight);
      pushBlocker(
        blockers,
        "handed_back_reservations",
        r.id,
        "handed_back",
        "Reserved label was handed back; current physical location is indeterminate",
      );
    } else {
      pushBlocker(
        blockers,
        "identity_mapping",
        `claim:${r.id}`,
        "invalid_linkage",
        "Return-reserved claim is not linked to a prepared or handed-back return",
      );
    }
  }

  const events = await client.query(
    `SELECT e.id,e.event_type,e.quantity,e.sku,e.mahsulot_id,
            COALESCE(c.unit_weight_kg,hi.unit_weight_kg) unit_weight_kg,
            p.id public_product_id,p.name product_name,p.sku canonical_sku,p.active,
            m.faol mahsulot_active,m.sku mahsulot_sku,
            count(p.id) OVER (PARTITION BY e.id) mapping_count
       FROM distribution.vehicle_unit_events e
       LEFT JOIN distribution.vehicle_label_claims c ON c.id=e.label_claim_id
       LEFT JOIN distribution.vehicle_handoff_items hi ON hi.id=e.handoff_item_id
       LEFT JOIN distribution.mahsulotlar m ON m.id=e.mahsulot_id
       LEFT JOIN public.products p ON p.sku=e.sku
      WHERE e.vehicle_id=$1 AND e.event_type IN ('load','sale','return')
        AND e.event_at >= $2::timestamptz AND e.event_at < $3::timestamptz`,
    [pilot.vehicleId, window.utcStart, window.utcEndExclusive],
  );
  for (const r of events.rows) {
    const valid =
      Number(r.mapping_count) === 1 &&
      r.active === true &&
      Number(r.mahsulot_active) === 1 &&
      String(r.sku).trim() !== "" &&
      String(r.sku) === String(r.mahsulot_sku) &&
      r.unit_weight_kg != null;
    if (!valid) {
      pushBlocker(
        blockers,
        "identity_mapping",
        `event:${r.id}`,
        "unresolved",
        `Event ${r.id} lacks unique active SKU identity or immutable weight snapshot`,
      );
      continue;
    }
    const sign = r.event_type === "load" ? 1 : -1;
    const q = Math.abs(Number(r.quantity)) * sign;
    add(getProduct(products, r).events, q, Math.abs(q) * Number(r.unit_weight_kg) * sign);
  }

  const movements = await client.query(
    `SELECT sm.id,sm.product,sm.quantity,sm.weight_kg,
            sm.from_warehouse_id,sm.to_warehouse_id,
            p.id public_product_id,p.name product_name,p.sku,p.active,
            count(p.id) OVER (PARTITION BY sm.id) mapping_count
       FROM public.stock_movements sm
       LEFT JOIN public.products p ON p.name=sm.product
      WHERE (sm.from_warehouse_id=$1 OR sm.to_warehouse_id=$1)
        AND sm.created_at >= $2::timestamptz AND sm.created_at < $3::timestamptz`,
    [pilot.warehouseId, window.utcStart, window.utcEndExclusive],
  );
  for (const r of movements.rows) {
    if (
      Number(r.mapping_count) !== 1 ||
      r.active !== true ||
      !String(r.sku ?? "").trim() ||
      r.weight_kg == null
    ) {
      pushBlocker(
        blockers,
        "identity_mapping",
        `movement:${r.id}`,
        "unresolved",
        `Movement ${r.id} lacks unique active canonical identity or weight snapshot`,
      );
      continue;
    }
    const sign = Number(r.to_warehouse_id) === pilot.warehouseId ? 1 : -1;
    add(
      getProduct(products, r).movements,
      Math.abs(Number(r.quantity)) * sign,
      Math.abs(Number(r.weight_kg)) * sign,
    );
  }

  const recs = await client.query(
    `SELECT r.id,r.reconciliation_date,r.status,
            count(i.id)::int item_count,
            count(i.id) FILTER (WHERE i.actual_quantity IS NOT NULL)::int counted_count,
            count(i.id) FILTER (WHERE i.discrepancy<>0)::int discrepancy_count,
            COALESCE(sum(ABS(i.discrepancy)) FILTER (WHERE i.discrepancy<>0),0) discrepancy_quantity
       FROM distribution.vehicle_reconciliations r
       LEFT JOIN distribution.vehicle_reconciliation_items i ON i.reconciliation_id=r.id
      WHERE r.vehicle_id=$1 AND r.reconciliation_date >= $2::date
        AND r.reconciliation_date < $3::date
      GROUP BY r.id,r.reconciliation_date,r.status
      ORDER BY r.reconciliation_date`,
    [pilot.vehicleId, window.weekStart, window.weekEndExclusive],
  );
  const byDate = new Map(recs.rows.map((r) => [iso(r.reconciliation_date).slice(0, 10), r]));
  const days = window.requiredDates.map((date) => {
    const r = byDate.get(date);
    const missing = !r;
    const itemCount = r ? Number(r.item_count) : 0;
    const allCounted = !!r && itemCount === Number(r.counted_count);
    const discrepancyCount = r ? Number(r.discrepancy_count) : 0;
    const status = r ? String(r.status) : "missing";
    if (missing)
      pushBlocker(blockers, "coverage", date, status, "Required daily reconciliation is missing");
    else if (status !== "applied" || !allCounted || discrepancyCount > 0)
      pushBlocker(
        blockers,
        "coverage",
        date,
        status,
        "Required reconciliation must be applied, fully counted, and undisputed",
      );
    return {
      date,
      reconciliationId: r ? Number(r.id) : null,
      status,
      allCounted,
      discrepancyCount,
      discrepancyQuantity: r ? Number(r.discrepancy_quantity) : 0,
      missing,
    };
  });

  const lifecycleQueries: Array<[string, Promise<{ rows: Record<string, unknown>[] }>, string]> = [
    ["handoffs", client.query(`SELECT id,status FROM distribution.vehicle_handoffs WHERE vehicle_id=$1 AND status IN ('prepared','labels_printed','handed_over') ORDER BY id`, [pilot.vehicleId]), "Open handoff"],
    ["replenishments", client.query(`SELECT id,status FROM distribution.vehicle_replenishment_requests WHERE vehicle_id=$1 AND status IN ('pending','approved') ORDER BY id`, [pilot.vehicleId]), "Open replenishment"],
    ["returns", client.query(`SELECT id,status FROM distribution.vehicle_returns WHERE vehicle_id=$1 AND status IN ('prepared','handed_back') ORDER BY id`, [pilot.vehicleId]), "Open return"],
    ["labels", client.query(`SELECT id,status FROM distribution.vehicle_label_claims WHERE vehicle_id=$1 AND status IN ('prepared','printed') ORDER BY id`, [pilot.vehicleId]), "Open label"],
  ];
  for (const [type, result, label] of lifecycleQueries) {
    for (const r of (await result).rows)
      pushBlocker(blockers, type, r.id, r.status, `${label} is not terminal`);
  }

  const productRows = [...products.values()]
    .sort((a, b) => a.sku.localeCompare(b.sku))
    .map((p) => {
      const indeterminate = p.handedBack.quantity !== 0;
      const claimVariance = {
        quantity: round3(p.inventory.quantity - p.claims.quantity),
        weightKg: round3(p.inventory.weightKg - p.claims.weightKg),
      };
      const flowVariance = {
        quantity: round3(p.movements.quantity - p.events.quantity),
        weightKg: round3(p.movements.weightKg - p.events.weightKg),
      };
      if (
        !indeterminate &&
        (Math.abs(claimVariance.quantity) > WEEKLY_QTY_TOLERANCE ||
          Math.abs(claimVariance.weightKg) > WEEKLY_WEIGHT_TOLERANCE_KG)
      )
        pushBlocker(blockers, "current_variance", p.sku, "variance", "Claim and inventory current balances differ");
      if (
        Math.abs(flowVariance.quantity) > WEEKLY_QTY_TOLERANCE ||
        Math.abs(flowVariance.weightKg) > WEEKLY_WEIGHT_TOLERANCE_KG
      )
        pushBlocker(blockers, "event_movement_variance", p.sku, "variance", "Weekly event and movement flows differ");
      return {
        publicProductId: p.publicProductId,
        productName: p.productName,
        sku: p.sku,
        physicalLabelCount: p.physicalLabels,
        inventoryCurrent: p.inventory,
        expectedCurrent: p.claims,
        handedBackReserved: p.handedBack,
        indeterminate,
        eventNet: p.events,
        movementNet: p.movements,
        expectedOpening: {
          quantity: round3(p.claims.quantity - p.events.quantity),
          weightKg: round3(p.claims.weightKg - p.events.weightKg),
        },
        inventoryOpening: {
          quantity: round3(p.inventory.quantity - p.movements.quantity),
          weightKg: round3(p.inventory.weightKg - p.movements.weightKg),
        },
        claimInventoryVariance: indeterminate ? null : claimVariance,
        movementEventVariance: flowVariance,
      };
    });

  const bounded: Blocker[] = [...blockers.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, details]) => ({
      type,
      totalCount: details.length,
      details: details.slice(0, WEEKLY_BLOCKER_DETAIL_LIMIT),
      truncated: details.length > WEEKLY_BLOCKER_DETAIL_LIMIT,
    }));
  const totals = (key: "inventoryCurrent" | "expectedCurrent" | "eventNet" | "movementNet") =>
    productRows.reduce(
      (a, p) => {
        add(a, p[key].quantity, p[key].weightKg);
        return a;
      },
      zero(),
    );
  return {
    readiness: bounded.length === 0,
    reasons: bounded.map((b) => b.type),
    week: {
      weekStart: window.weekStart,
      weekEndExclusive: window.weekEndExclusive,
      utcStart: window.utcStart,
      utcEndExclusive: window.utcEndExclusive,
      timezone: "+05:00",
      currentWeek: window.currentWeek,
      defaultedWeekStart: window.defaulted,
      requiredThroughDate: window.requiredDates.at(-1)!,
      requiredDayCount: window.requiredDates.length,
    },
    tolerances: {
      quantity: WEEKLY_QTY_TOLERANCE,
      weightKg: WEEKLY_WEIGHT_TOLERANCE_KG,
    },
    kpis: {
      productCount: productRows.length,
      physicalLabelCount: productRows.reduce(
        (sum, product) => sum + product.physicalLabelCount,
        0,
      ),
      inventoryCurrent: totals("inventoryCurrent"),
      expectedCurrent: totals("expectedCurrent"),
      eventNet: totals("eventNet"),
      movementNet: totals("movementNet"),
      requiredDays: days.length,
      appliedDays: days.filter((d) => d.status === "applied").length,
      blockerCount: bounded.reduce((n, b) => n + b.totalCount, 0),
    },
    products: productRows,
    days,
    blockers: bounded,
  };
}