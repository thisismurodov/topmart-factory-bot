// F4 — DEPARTMENT DETAIL builder: GET /ombor/flow/department/:id javobini yig'adi.
//
// FAQAT O'QIYDI: barcha so'rovlar bitta REPEATABLE READ, READ ONLY
// tranzaksiyada bajariladi — tasodifiy yozish urinishi ham DB darajasida
// 25006 xatosi bilan bloklanadi. Hech narsa yozilmaydi, DDL yo'q.
//
// Halollik qoidalari (owner F4 GO):
//  - DATABASE'DA BOR NARSA = KO'RSATISH. YO'Q NARSA = "MA'LUMOT MAVJUD EMAS".
//  - RECEIVE = 0 bo'lsa, input bo'limi bo'sh holat qaytaradi — taxmin yo'q.
//    RECEIVE yozuvlari paydo bo'lsa, receives ro'yxati avtomatik to'ladi.
//  - salary_payments ishchi darajasida (line_id yo'q) — liniyaga TAQSIMLANMAYDI,
//    faqat shu liniyaga biriktirilgan ishchilarning to'lovlari sifatida ko'rsatiladi.
//  - kg_payroll_workers.scope matnli ('arqon') — line_id bilan bog'lanmagan,
//    nom-taxmin bo'lgani uchun ishlatilmaydi.
//  - Manfiy WIP real qiymat sifatida qaytadi (yashirilmaydi, 0 ga aylantirilmaydi).
//  - SKU faqat items katalogidan ehtiyotkor nom-normalizatsiya orqali; yo'q = null.
//  - Nofaol liniyalar ham ma'lumot sifatida ochiladi (inFlowScope=false),
//    fake faol departmentga aylantirilmaydi.

import type { Pool, PoolClient } from "pg";
import { norm, ACTIVE_LINE_IDS } from "./flowGraph";

// ── Kontrakt turlari ─────────────────────────────────────────────────────────
export interface DeptEmployee {
  worker: string;
  role: string;
  roleLabel: string | null;
  phone: string | null;
  prefix: string | null;
  joinedAt: string | null;
  otherLines: { id: number; name: string }[];
}
export interface DeptRole {
  roleKey: string;
  label: string;
  rate: number;
  payMode: string;
  maxWorkers: number;
  workersNow: number;
}
export interface DeptWipMovement {
  id: number;
  type: string;
  rawMaterial: string | null;
  product: string | null;
  kg: number;
  fromWid: number | null;
  fromName: string | null;
  batchId: number | null;
  note: string | null;
  by: string | null;
  at: string | null;
  itemLinked: boolean;
}
export interface DeptSalaryEntry {
  worker: string;
  role: string | null;
  sourceType: string | null;
  batchId: number | null;
  workDate: string | null;
  kg: number | null;
  rate: number | null;
  amount: number;
}
export interface DeptPayrollRun {
  workDate: string;
  totalKg: number;
  status: string | null;
  closedBy: string | null;
  closedAt: string | null;
}
export interface DeptWorkerPayment {
  worker: string;
  year: number;
  month: number;
  amount: number;
  paidAt: string | null;
}
export interface DeptProduceAgg {
  product: string;
  kg: number;
  n: number;
  first: string;
  last: string;
}
export interface DeptBatchAgg {
  product: string;
  kg: number;
  dona: number;
  n: number;
  last: string;
  archivedN: number;
}
export interface DeptBatchRow {
  id: number;
  code: string | null;
  worker: string | null;
  product: string;
  qty: number;
  kg: number;
  at: string | null;
  payrollMethod: string | null;
  archived: boolean;
  itemLinked: boolean;
}
export interface DeptReceiveAgg {
  fromWid: number | null;
  fromName: string | null;
  kg: number;
  rows: number;
  first: string | null;
  last: string | null;
}
export interface DeptBomInput {
  product: string;
  material: string;
  perUnit: number;
  stock: number | null;
  currency: string | null;
}
export interface DeptPlacement {
  wid: number;
  container: string;
  loc: string | null;
  kg: number;
  qty: number;
  ptype: string | null;
}
export interface DeptProduct {
  name: string;
  sku: string | null;
  producedKg: number;
  produceN: number;
  batchKg: number;
  batchDona: number;
  batchN: number;
  placements: DeptPlacement[];
  bom: { material: string; perUnit: number; stock: number | null; currency: string | null }[];
}
export interface DeptDestination {
  wid: number;
  container: string;
  loc: string | null;
  kg: number;
  dona: number;
  products: number;
}
export interface DeptWarning {
  code: string;
  title: string;
  detail: string;
}
export interface DepartmentDetailResponse {
  generatedAt: string;
  readOnly: true;
  source: string;
  department: {
    id: number;
    name: string;
    active: boolean;
    createdAt: string | null;
    inFlowScope: boolean;
  };
  header: {
    employees: number;
    roles: number;
    wipKg: number;
    wipStatus: "OK" | "NEGATIVE" | "NO_LEDGER";
    warnings: number;
  };
  employees: DeptEmployee[];
  roles: DeptRole[];
  salary: {
    lineEntries: {
      rows: DeptSalaryEntry[];
      total: number;
      count: number;
      workers: number;
      first: string | null;
      last: string | null;
    };
    payrollRuns: { rows: DeptPayrollRun[]; count: number; totalKg: number };
    workerPayments: { rows: DeptWorkerPayment[]; total: number; count: number };
  };
  wip: {
    balanceKg: number;
    receiveKg: number;
    produceKg: number;
    rows: number;
    status: "OK" | "NEGATIVE" | "NO_LEDGER";
    first: string | null;
    last: string | null;
    movements: DeptWipMovement[];
    movementsTotal: number;
  };
  inputs: { receives: DeptReceiveAgg[]; receiveRows: number; bom: DeptBomInput[] };
  outputs: {
    produce: DeptProduceAgg[];
    produceKg: number;
    batchesByProduct: DeptBatchAgg[];
    batchRows: DeptBatchRow[];
    batchesTotal: number;
    batchKg: number;
    batchDona: number;
  };
  products: DeptProduct[];
  destinations: DeptDestination[];
  warnings: DeptWarning[];
  meta: {
    itemLinks: { wip: string; batches: string };
    limits: { wipMovements: number; salaryEntries: number; batchRows: number; payrollRuns: number; workerPayments: number };
  };
}

const r2 = (x: number): number => +(x || 0).toFixed(2);
const iso = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
};

// Ro'yxat limitlari — javob hajmini jilovlash uchun (jami sonlar alohida qaytadi).
const LIM = { wipMovements: 120, salaryEntries: 120, batchRows: 60, payrollRuns: 90, workerPayments: 120 };

// Liniya topilmasa null qaytadi — route 404 beradi.
export async function buildDepartmentDetail(
  pool: Pool,
  lineId: number,
): Promise<DepartmentDetailResponse | null> {
  const client: PoolClient = await pool.connect();
  try {
    // Yagona izchil snapshot + yozishdan DB darajasida himoya.
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");

    const lineQ = await client.query(
      `SELECT id, name, created_at FROM production_lines WHERE id = $1`,
      [lineId],
    );
    if (!lineQ.rows.length) {
      await client.query("COMMIT");
      return null;
    }

    const workersQ = await client.query(
      `SELECT plw.worker_name AS worker, plw.role, plw.created_at AS joined_at,
              w.phone, w.prefix
       FROM production_line_workers plw
       LEFT JOIN workers w ON w.name = plw.worker_name
       WHERE plw.line_id = $1
       ORDER BY plw.id`,
      [lineId],
    );
    const otherLinesQ = await client.query(
      `SELECT plw.worker_name AS worker, pl.id, pl.name
       FROM production_line_workers plw
       JOIN production_lines pl ON pl.id = plw.line_id
       WHERE plw.line_id <> $1
         AND plw.worker_name IN (SELECT worker_name FROM production_line_workers WHERE line_id = $1)
       ORDER BY plw.worker_name, pl.id`,
      [lineId],
    );
    const rolesQ = await client.query(
      `SELECT role_key AS "roleKey", label, rate::float8 AS rate,
              pay_mode AS "payMode", max_workers::int AS "maxWorkers"
       FROM line_role_config WHERE line_id = $1 ORDER BY id`,
      [lineId],
    );
    const wipAggQ = await client.query(
      `SELECT COUNT(*)::int AS rows,
              COALESCE(SUM(CASE WHEN movement_type = 'RECEIVE' THEN weight_kg
                                WHEN movement_type = 'PRODUCE' THEN -weight_kg
                                ELSE 0 END), 0)::float8 AS balance_kg,
              COALESCE(SUM(weight_kg) FILTER (WHERE movement_type = 'RECEIVE'), 0)::float8 AS receive_kg,
              COALESCE(SUM(weight_kg) FILTER (WHERE movement_type = 'PRODUCE'), 0)::float8 AS produce_kg,
              COUNT(*) FILTER (WHERE movement_type = 'RECEIVE')::int AS receive_rows,
              COUNT(*) FILTER (WHERE product_item_id IS NOT NULL OR raw_material_item_id IS NOT NULL)::int AS linked,
              MIN(created_at) AS first, MAX(created_at) AS last
       FROM wip_movements WHERE line_id = $1`,
      [lineId],
    );
    const wipMovQ = await client.query(
      `SELECT m.id, m.movement_type AS type, m.raw_material, m.product,
              m.weight_kg::float8 AS kg, m.from_warehouse_id AS from_wid,
              wh.name AS from_name, m.batch_id, m.note, m.created_by AS by,
              m.created_at AS at,
              (m.product_item_id IS NOT NULL OR m.raw_material_item_id IS NOT NULL) AS item_linked
       FROM wip_movements m
       LEFT JOIN warehouses wh ON wh.id = m.from_warehouse_id
       WHERE m.line_id = $1
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ${LIM.wipMovements}`,
      [lineId],
    );
    const receivesQ = await client.query(
      `SELECT m.from_warehouse_id AS from_wid, wh.name AS from_name,
              COALESCE(SUM(m.weight_kg), 0)::float8 AS kg, COUNT(*)::int AS rows,
              MIN(m.created_at) AS first, MAX(m.created_at) AS last
       FROM wip_movements m
       LEFT JOIN warehouses wh ON wh.id = m.from_warehouse_id
       WHERE m.line_id = $1 AND m.movement_type = 'RECEIVE'
       GROUP BY m.from_warehouse_id, wh.name
       ORDER BY kg DESC`,
      [lineId],
    );
    const produceQ = await client.query(
      `SELECT product, SUM(weight_kg)::float8 AS kg, COUNT(*)::int AS n,
              MIN(created_at)::date::text AS first, MAX(created_at)::date::text AS last
       FROM wip_movements
       WHERE line_id = $1 AND movement_type = 'PRODUCE'
       GROUP BY product ORDER BY kg DESC`,
      [lineId],
    );
    const batchAggQ = await client.query(
      `SELECT product, COALESCE(SUM(weight_kg), 0)::float8 AS kg,
              COALESCE(SUM(quantity), 0)::float8 AS dona, COUNT(*)::int AS n,
              MAX(created_at)::date::text AS last,
              COUNT(*) FILTER (WHERE archived)::int AS archived_n,
              COUNT(*) FILTER (WHERE item_id IS NOT NULL)::int AS linked
       FROM batches WHERE production_line_id = $1
       GROUP BY product ORDER BY kg DESC, dona DESC`,
      [lineId],
    );
    const batchRowsQ = await client.query(
      `SELECT id, batch_code AS code, worker, product, quantity::float8 AS qty,
              weight_kg::float8 AS kg, created_at AS at, payroll_method,
              archived, (item_id IS NOT NULL) AS item_linked
       FROM batches WHERE production_line_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT ${LIM.batchRows}`,
      [lineId],
    );
    const batchCountQ = await client.query(
      `SELECT COUNT(*)::int AS n FROM batches WHERE production_line_id = $1`,
      [lineId],
    );
    const salaryEntriesQ = await client.query(
      `SELECT worker, role, source_type, batch_id, work_date::text AS work_date,
              kg::float8 AS kg, rate::float8 AS rate, amount::float8 AS amount
       FROM salary_entries WHERE line_id = $1
       ORDER BY work_date DESC, id DESC
       LIMIT ${LIM.salaryEntries}`,
      [lineId],
    );
    const salaryAggQ = await client.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::float8 AS total,
              COUNT(DISTINCT worker)::int AS workers,
              MIN(work_date)::text AS first, MAX(work_date)::text AS last
       FROM salary_entries WHERE line_id = $1`,
      [lineId],
    );
    const runsQ = await client.query(
      `SELECT work_date::text AS work_date, total_kg::float8 AS total_kg, status,
              closed_by, closed_at
       FROM daily_payroll_runs WHERE line_id = $1
       ORDER BY work_date DESC LIMIT ${LIM.payrollRuns}`,
      [lineId],
    );
    const runsAggQ = await client.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_kg), 0)::float8 AS total_kg
       FROM daily_payroll_runs WHERE line_id = $1`,
      [lineId],
    );
    // salary_payments'da line_id YO'Q — faqat shu liniyaga biriktirilgan
    // ishchilarning to'lovlari (ishchi darajasida, taqsimlanmaydi).
    const paymentsQ = await client.query(
      `SELECT sp.worker, sp.year::int AS year, sp.month::int AS month,
              sp.amount::float8 AS amount, sp.paid_at
       FROM salary_payments sp
       WHERE sp.worker IN (SELECT worker_name FROM production_line_workers WHERE line_id = $1)
       ORDER BY sp.year DESC, sp.month DESC, sp.id DESC
       LIMIT ${LIM.workerPayments}`,
      [lineId],
    );
    const paymentsAggQ = await client.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::float8 AS total
       FROM salary_payments
       WHERE worker IN (SELECT worker_name FROM production_line_workers WHERE line_id = $1)`,
      [lineId],
    );
    // ONGLI QAROR (F2 bilan bir xil pattern): inventory/items/BOM katalog
    // jadvallari to'liq o'qiladi va moslashtirish ilova xotirasida bajariladi.
    // Sabab: (1) bu jadvallar katalog o'lchamida (~100-150 qator, sekin o'sadi);
    // (2) nom moslashtirish norm() ga tayanadi — Unicode apostrof variantlarini
    // (ʼ vs ' vs `) SQL'da ishonchli takrorlab bo'lmaydi; (3) flow/graph endpoint
    // (F2, tasdiqlangan) aynan shu hajmdagi o'qishlarni allaqachon bajaradi —
    // bu drawer undan yengilroq. receives/produce/batchesByProduct aggregatlari
    // esa line_id bo'yicha filtrlangan GROUP BY — natija liniyadagi distinct
    // mahsulot/xomashyo soni bilan chegaralangan (kichik).
    const positionsQ = await client.query(
      `SELECT i.warehouse_id AS wid, w.name AS container, w.location_type AS loc,
              i.product, i.quantity::float8 AS qty, i.weight_kg::float8 AS kg,
              i.product_type AS ptype
       FROM inventory i
       JOIN warehouses w ON w.id = i.warehouse_id
       WHERE i.quantity > 0 OR i.weight_kg > 0
       ORDER BY i.warehouse_id, i.product`,
    );
    const itemsQ = await client.query(`SELECT display_name AS name, sku FROM items ORDER BY id`);
    const bomQ = await client.query(
      `SELECT pm.product_name, pm.quantity_required::float8 AS per_unit,
              rm.name AS material_name, rm.current_stock::float8 AS stock, rm.currency
       FROM product_materials pm
       LEFT JOIN raw_materials rm ON rm.id = pm.raw_material_id
       ORDER BY pm.id`,
    );

    await client.query("COMMIT");

    return assemble(lineId, {
      line: lineQ.rows[0],
      workers: workersQ.rows,
      otherLines: otherLinesQ.rows,
      roles: rolesQ.rows,
      wipAgg: wipAggQ.rows[0],
      wipMov: wipMovQ.rows,
      receives: receivesQ.rows,
      produce: produceQ.rows,
      batchAgg: batchAggQ.rows,
      batchRows: batchRowsQ.rows,
      batchesTotal: batchCountQ.rows[0].n,
      salaryEntries: salaryEntriesQ.rows,
      salaryAgg: salaryAggQ.rows[0],
      runs: runsQ.rows,
      runsAgg: runsAggQ.rows[0],
      payments: paymentsQ.rows,
      paymentsAgg: paymentsAggQ.rows[0],
      positions: positionsQ.rows,
      items: itemsQ.rows,
      bom: bomQ.rows,
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* txn allaqachon yopilgan bo'lishi mumkin */
    }
    throw e;
  } finally {
    client.release();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

function assemble(
  lineId: number,
  src: {
    line: Row;
    workers: Row[];
    otherLines: Row[];
    roles: Row[];
    wipAgg: Row;
    wipMov: Row[];
    receives: Row[];
    produce: Row[];
    batchAgg: Row[];
    batchRows: Row[];
    batchesTotal: number;
    salaryEntries: Row[];
    salaryAgg: Row;
    runs: Row[];
    runsAgg: Row;
    payments: Row[];
    paymentsAgg: Row;
    positions: Row[];
    items: Row[];
    bom: Row[];
  },
): DepartmentDetailResponse {
  // SKU: faqat items katalogidan norm-nom orqali (TM- prefiksli afzal).
  const itemsByNorm = new Map<string, Row[]>();
  for (const it of src.items) {
    const k = norm(it.name);
    if (!itemsByNorm.has(k)) itemsByNorm.set(k, []);
    itemsByNorm.get(k)!.push(it);
  }
  const skuFor = (name: string): string | null => {
    const matches = itemsByNorm.get(norm(name)) || [];
    const tm = matches.find((m) => (m.sku || "").startsWith("TM-")) || matches[0] || null;
    return tm ? (tm.sku ?? null) : null;
  };

  // Ishchilar + boshqa liniyalarda ham borligi belgisi (to'lov taqsimlanmasligi uchun muhim).
  const otherByWorker = new Map<string, { id: number; name: string }[]>();
  for (const o of src.otherLines) {
    if (!otherByWorker.has(o.worker)) otherByWorker.set(o.worker, []);
    otherByWorker.get(o.worker)!.push({ id: o.id, name: o.name });
  }
  const roleLabelByKey = new Map<string, string>(src.roles.map((r: Row) => [r.roleKey, r.label]));
  const employees: DeptEmployee[] = src.workers.map((w) => ({
    worker: w.worker,
    role: w.role,
    roleLabel: roleLabelByKey.get(w.role) ?? null,
    phone: w.phone ?? null,
    prefix: w.prefix ?? null,
    joinedAt: iso(w.joined_at),
    otherLines: otherByWorker.get(w.worker) || [],
  }));
  const workersNowByRole = new Map<string, number>();
  for (const w of src.workers) {
    workersNowByRole.set(w.role, (workersNowByRole.get(w.role) || 0) + 1);
  }
  const roles: DeptRole[] = src.roles.map((r) => ({
    roleKey: r.roleKey,
    label: r.label,
    rate: +(r.rate || 0),
    payMode: r.payMode,
    maxWorkers: +(r.maxWorkers || 0),
    workersNow: workersNowByRole.get(r.roleKey) || 0,
  }));

  // WIP
  const wa = src.wipAgg;
  const wipRows = +wa.rows;
  const balanceKg = r2(+wa.balance_kg);
  const wipStatus: "OK" | "NEGATIVE" | "NO_LEDGER" =
    wipRows === 0 ? "NO_LEDGER" : balanceKg < 0 ? "NEGATIVE" : "OK";
  const movements: DeptWipMovement[] = src.wipMov.map((m) => ({
    id: +m.id,
    type: m.type,
    rawMaterial: m.raw_material ?? null,
    product: m.product ?? null,
    kg: r2(+m.kg),
    fromWid: m.from_wid ?? null,
    fromName: m.from_name ?? null,
    batchId: m.batch_id ?? null,
    note: m.note ?? null,
    by: m.by ?? null,
    at: iso(m.at),
    itemLinked: !!m.item_linked,
  }));

  // Kirim (input) — faqat real RECEIVE yozuvlari.
  const receives: DeptReceiveAgg[] = src.receives.map((r) => ({
    fromWid: r.from_wid ?? null,
    fromName: r.from_name ?? null,
    kg: r2(+r.kg),
    rows: +r.rows,
    first: iso(r.first),
    last: iso(r.last),
  }));
  const receiveRows = +wa.receive_rows;

  // Chiqim (output)
  const produce: DeptProduceAgg[] = src.produce.map((p) => ({
    product: p.product,
    kg: r2(+p.kg),
    n: +p.n,
    first: p.first,
    last: p.last,
  }));
  const batchesByProduct: DeptBatchAgg[] = src.batchAgg.map((b) => ({
    product: b.product,
    kg: r2(+b.kg),
    dona: +(b.dona || 0),
    n: +b.n,
    last: b.last,
    archivedN: +(b.archived_n || 0),
  }));
  const batchRows: DeptBatchRow[] = src.batchRows.map((b) => ({
    id: +b.id,
    code: b.code ?? null,
    worker: b.worker ?? null,
    product: b.product,
    qty: +(b.qty || 0),
    kg: r2(+(b.kg || 0)),
    at: iso(b.at),
    payrollMethod: b.payroll_method ?? null,
    archived: !!b.archived,
    itemLinked: !!b.item_linked,
  }));

  // Mahsulotlar: PRODUCE ∪ batches nomlari. Joylashuv — inventory'dan norm-nom
  // orqali (item_id bo'sh bo'lgani uchun ehtiyotkor text-bog'lanish, flowGraph bilan bir xil).
  const productNames = new Map<string, string>(); // norm → asl nom
  for (const p of produce) if (!productNames.has(norm(p.product))) productNames.set(norm(p.product), p.product);
  for (const b of batchesByProduct) if (!productNames.has(norm(b.product))) productNames.set(norm(b.product), b.product);

  const bomByProduct = new Map<string, DeptProduct["bom"]>();
  for (const r of src.bom) {
    const k = norm(r.product_name);
    if (!productNames.has(k)) continue;
    if (!bomByProduct.has(k)) bomByProduct.set(k, []);
    bomByProduct.get(k)!.push({
      material: r.material_name ?? "(nomaʼlum material)",
      perUnit: +(r.per_unit || 0),
      stock: r.stock != null ? +r.stock : null,
      currency: r.currency ?? null,
    });
  }

  const produceByNorm = new Map<string, DeptProduceAgg>(produce.map((p) => [norm(p.product), p]));
  const batchByNorm = new Map<string, DeptBatchAgg>(batchesByProduct.map((b) => [norm(b.product), b]));
  const products: DeptProduct[] = [...productNames.entries()].map(([k, name]) => {
    const placements: DeptPlacement[] = src.positions
      .filter((pos: Row) => norm(pos.product) === k)
      .map((pos: Row) => ({
        wid: +pos.wid,
        container: pos.container,
        loc: pos.loc ?? null,
        kg: r2(+(pos.kg || 0)),
        qty: +(pos.qty || 0),
        ptype: pos.ptype ?? null,
      }));
    const pr = produceByNorm.get(k);
    const ba = batchByNorm.get(k);
    return {
      name,
      sku: skuFor(name),
      producedKg: pr ? pr.kg : 0,
      produceN: pr ? pr.n : 0,
      batchKg: ba ? ba.kg : 0,
      batchDona: ba ? ba.dona : 0,
      batchN: ba ? ba.n : 0,
      placements,
      bom: bomByProduct.get(k) || [],
    };
  });
  products.sort((a, b) => b.producedKg + b.batchKg - (a.producedKg + a.batchKg));

  // Destination'lar: liniya mahsulotlarining inventory joylashuvlari agregati.
  const destMap = new Map<number, DeptDestination & { prodSet: Set<string> }>();
  for (const p of products) {
    for (const pl of p.placements) {
      const d = destMap.get(pl.wid) || {
        wid: pl.wid,
        container: pl.container,
        loc: pl.loc,
        kg: 0,
        dona: 0,
        products: 0,
        prodSet: new Set<string>(),
      };
      d.kg = r2(d.kg + pl.kg);
      d.dona += pl.qty;
      d.prodSet.add(p.name);
      destMap.set(pl.wid, d);
    }
  }
  const destinations: DeptDestination[] = [...destMap.values()]
    .map(({ prodSet, ...d }) => ({ ...d, products: prodSet.size }))
    .sort((a, b) => b.kg - a.kg || b.dona - a.dona);

  // Ogohlantirishlar — FAQAT shu bo'limga tegishli (global gaplar bu yerga kirmaydi).
  const lineName: string = src.line.name;
  const warnings: DeptWarning[] = [];
  if (wipStatus === "NEGATIVE") {
    warnings.push({
      code: "NEGATIVE_WIP",
      title: `WIP manfiy: ${balanceKg} kg`,
      detail:
        `Kirim (RECEIVE) ${r2(+wa.receive_kg)} kg, chiqim (PRODUCE) ${r2(+wa.produce_kg)} kg — balans ${balanceKg} kg. ` +
        "Bu real database holati — qiymat 0 ga aylantirilmagan, yashirilmagan.",
    });
  }
  if (wipStatus === "NO_LEDGER") {
    warnings.push({
      code: "NO_LEDGER",
      title: "WIP ledger bo'sh",
      detail: `${lineName} uchun wip_movements jadvalida yozuv yo'q. Ish jarayoni ledgerda qayd etilmagan.`,
    });
  }
  if (receiveRows === 0) {
    warnings.push({
      code: "NO_RECEIVE_DATA",
      title: "Kirim (RECEIVE) yozuvlari yo'q",
      detail:
        `${lineName} uchun konteyner → bo'lim RECEIVE yozuvi 0 ta. Xomashyo kirimi hech qachon ro'yxatga olinmagan — ` +
        "shuning uchun input bo'limi bo'sh. Kirim yozila boshlagach avtomatik to'ladi.",
    });
  }
  const skuMissing = products.filter((p) => !p.sku);
  if (skuMissing.length) {
    warnings.push({
      code: "SKU_MISSING",
      title: `SKU biriktirilmagan: ${skuMissing.length} ta mahsulot`,
      detail:
        skuMissing.map((p) => p.name).join(", ") +
        " — items katalogida norm-nom bo'yicha mos SKU topilmadi. Nomga qarab SKU o'ylab topilmaydi.",
    });
  }
  const wipLinked = +(wa.linked || 0);
  const batchesLinkedTotal = src.batchAgg.reduce((s, b) => s + +(b.linked || 0), 0);
  if ((wipRows > 0 && wipLinked < wipRows) || (src.batchesTotal > 0 && batchesLinkedTotal < src.batchesTotal)) {
    warnings.push({
      code: "ITEM_LINKS_EMPTY",
      title: "item_id bog'lari to'liq emas — text-nom bog'lanish",
      detail:
        `Shu liniyada: wip_movements ${wipLinked}/${wipRows}, batches ${batchesLinkedTotal}/${src.batchesTotal} item_id bilan bog'langan. ` +
        "Panel ehtiyotkor nom-normalizatsiya orqali bog'laydi; ma'lumot o'zgartirilmaydi.",
    });
  }
  if (employees.length === 0) {
    warnings.push({
      code: "NO_WORKERS",
      title: "Ishchi biriktirilmagan",
      detail: `${lineName} liniyasiga production_line_workers jadvalida hech kim biriktirilmagan.`,
    });
  }
  const salaryCount = +src.salaryAgg.count;
  const paymentsCount = +src.paymentsAgg.count;
  if (salaryCount === 0 && paymentsCount === 0 && +src.runsAgg.count === 0) {
    warnings.push({
      code: "NO_SALARY_DATA",
      title: "Oylik ma'lumotlari yo'q",
      detail: `${lineName} uchun salary_entries, daily_payroll_runs va ishchi to'lovlari (salary_payments) bo'sh.`,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    source: "GET /ombor/flow/department/:id — live, READ ONLY tranzaksiya (REPEATABLE READ)",
    department: {
      id: +src.line.id,
      name: lineName,
      // production_lines jadvalida 'active' ustuni YO'Q — faollik F2 bilan bir
      // xil konvensiyada aniqlanadi: oqim doirasidagi liniyalar ro'yxati.
      active: ACTIVE_LINE_IDS.includes(lineId),
      createdAt: iso(src.line.created_at),
      inFlowScope: ACTIVE_LINE_IDS.includes(lineId),
    },
    header: {
      employees: employees.length,
      roles: roles.length,
      wipKg: balanceKg,
      wipStatus,
      warnings: warnings.length,
    },
    employees,
    roles,
    salary: {
      lineEntries: {
        rows: src.salaryEntries.map((s) => ({
          worker: s.worker,
          role: s.role ?? null,
          sourceType: s.source_type ?? null,
          batchId: s.batch_id ?? null,
          workDate: s.work_date ?? null,
          kg: s.kg != null ? r2(+s.kg) : null,
          rate: s.rate != null ? +s.rate : null,
          amount: r2(+s.amount),
        })),
        total: r2(+src.salaryAgg.total),
        count: salaryCount,
        workers: +src.salaryAgg.workers,
        first: src.salaryAgg.first ?? null,
        last: src.salaryAgg.last ?? null,
      },
      payrollRuns: {
        rows: src.runs.map((r) => ({
          workDate: r.work_date,
          totalKg: r2(+(r.total_kg || 0)),
          status: r.status ?? null,
          closedBy: r.closed_by ?? null,
          closedAt: iso(r.closed_at),
        })),
        count: +src.runsAgg.count,
        totalKg: r2(+src.runsAgg.total_kg),
      },
      workerPayments: {
        rows: src.payments.map((p) => ({
          worker: p.worker,
          year: +p.year,
          month: +p.month,
          amount: r2(+p.amount),
          paidAt: iso(p.paid_at),
        })),
        total: r2(+src.paymentsAgg.total),
        count: paymentsCount,
      },
    },
    wip: {
      balanceKg,
      receiveKg: r2(+wa.receive_kg),
      produceKg: r2(+wa.produce_kg),
      rows: wipRows,
      status: wipStatus,
      first: iso(wa.first),
      last: iso(wa.last),
      movements,
      movementsTotal: wipRows,
    },
    inputs: {
      receives,
      receiveRows,
      bom: [...productNames.entries()].flatMap(([k, name]) =>
        (bomByProduct.get(k) || []).map((b) => ({ product: name, ...b })),
      ),
    },
    outputs: {
      produce,
      produceKg: r2(+wa.produce_kg),
      batchesByProduct,
      batchRows,
      batchesTotal: src.batchesTotal,
      batchKg: r2(batchesByProduct.reduce((s, b) => s + b.kg, 0)),
      batchDona: batchesByProduct.reduce((s, b) => s + b.dona, 0),
    },
    products,
    destinations,
    warnings,
    meta: {
      itemLinks: {
        wip: `${wipLinked}/${wipRows}`,
        batches: `${batchesLinkedTotal}/${src.batchesTotal}`,
      },
      limits: { ...LIM },
    },
  };
}
