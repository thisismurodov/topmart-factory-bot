// PRODUCTION FLOW graph builder — GET /ombor/flow/graph javobini yig'adi.
//
// FAQAT O'QIYDI: barcha so'rovlar bitta REPEATABLE READ, READ ONLY
// tranzaksiyada bajariladi — tasodifiy yozish urinishi ham DB darajasida
// 25006 xatosi bilan bloklanadi. Hech narsa yozilmaydi, DDL yo'q.
//
// Kontrakt F1 mockup fixture bilan bir xil (mockup-sandbox production-flow):
// { generatedAt, readOnly, source, nodes:{...}, edges, supplyEdges, gaps, meta }
//
// Halollik qoidalari (owner GO):
//  - Container→Bo'lim RECEIVE = 0 bo'lsa, soxta edge chizilmaydi — gap qaytadi.
//    RECEIVE yozuvlari paydo bo'lsa, supplyEdges avtomatik to'ladi.
//  - SKU faqat items katalogidan ehtiyotkor nom-normalizatsiya orqali topiladi;
//    topilmasa sku=null ("SKU biriktirilmagan").
//  - production_line_id NULL partiyalar bo'limga biriktirilmaydi — gap sifatida.
//  - Manfiy WIP real qiymat sifatida qaytadi (yashirilmaydi).
//  - purpose≠kontent faqat warning; DB qiymatiga tegilmaydi.

import type { Pool, PoolClient } from "pg";

// ── Kontrakt turlari ─────────────────────────────────────────────────────────
export interface FlowContainerItem {
  wid: number;
  product: string;
  sku: string | null;
  qty: number;
  kg: number;
  ptype: string | null;
}
export interface FlowContainer {
  id: number;
  name: string;
  purpose: string | null;
  loc: string | null;
  cap: number | null;
  kg: number;
  dona: number;
  positionsCount: number;
  byType: Record<string, { kg: number; dona: number; rows: number }>;
  derived: string;
  dominant: string | null;
  mismatch: boolean;
  items: FlowContainerItem[];
}
export interface FlowRegionalGroup {
  name: string;
  count: number;
  kg: number;
  dona: number;
  list: FlowContainer[];
}
export interface FlowDeptSalary {
  entries: number;
  workers: number;
  total: number;
  lastDate: string | null;
}
export interface FlowBomInput {
  material: string;
  perUnit: number;
  stock: number | null;
  currency: string | null;
  product?: string;
}
export interface FlowDepartment {
  id: number;
  name: string;
  workers: { worker: string; role: string }[];
  roles: { roleKey: string; label: string; rate: number; payMode: string; maxWorkers: number }[];
  wipKg: number;
  wipRows: number;
  salary: FlowDeptSalary;
  salaryByWorker: { worker: string; total: number; entries: number; last: string | null }[];
  produce: { product: string; kg: number; n: number; first: string; last: string }[];
  batches: { product: string; kg: number; dona: number; n: number; last: string }[];
  bomInputs: FlowBomInput[];
}
export interface FlowWipNode {
  lineId: number;
  lineName: string;
  balanceKg: number;
  rows: number;
  produceKg: number;
  receiveKg: number;
  status: "OK" | "NEGATIVE" | "NO_LEDGER";
  first: string | null;
  last: string | null;
}
export interface FlowProductPlacement {
  wid: number;
  container: string;
  kg: number;
  qty: number;
  ptype: string | null;
  skuInContainer: string | null;
}
export interface FlowProduct {
  key: string;
  name: string;
  sku: string | null;
  lineIds: number[];
  producedKg: number;
  batchKg: number;
  batchDona: number;
  placements: FlowProductPlacement[];
  bom: FlowBomInput[];
}
export interface FlowEdge {
  id: string;
  kind: "dept-wip" | "wip-product" | "batch-product" | "product-container";
  source: string;
  target: string;
  table: string;
  joinBasis: string;
  kg?: number;
  dona?: number;
  rows?: number;
  first?: string;
  last?: string;
  note?: string;
}
export interface FlowSupplyEdge {
  id: string;
  kind: "container-dept";
  source: string;
  target: string;
  table: string;
  joinBasis: string;
  kg: number;
  rows: number;
  first: string;
  last: string;
}
export interface FlowGap {
  code: string;
  title: string;
  detail: string;
}
export interface FlowGraphResponse {
  generatedAt: string;
  readOnly: true;
  source: string;
  nodes: {
    containersRaw: FlowContainer[];
    containersFinished: FlowContainer[];
    emptyContainers: FlowContainer[];
    regionalGroup: FlowRegionalGroup | null;
    departments: FlowDepartment[];
    inactiveDepartments: { id: number; name: string }[];
    wip: FlowWipNode[];
    products: FlowProduct[];
  };
  edges: FlowEdge[];
  supplyEdges: FlowSupplyEdge[];
  gaps: FlowGap[];
  meta: {
    unattributedBatches: { products: number; kg: number; dona: number; batches: number };
    dataQuality: {
      wipItemLinked: string;
      batchesItemLinked: string;
      productsItemLinked: string;
      bomItemLinked: string;
    };
    counts: Record<string, number>;
    activeLineIds: number[];
    classificationSource: string;
    pins: string;
  };
}

// Owner GO §27: real bo'limlar — 6=Arqon Bo'lim 3, 9=Qop Ip, 8=Lenta 1.
// Qolganlari (10=Arqon Bo'limi, 97=Naycha) nofaol deb belgilangan — ular
// inactiveDepartments ro'yxatida qaytadi, node sifatida chizilmaydi.
export const ACTIVE_LINE_IDS = [6, 9, 8];

// Matching UCHUNGINA ishlatiladigan agressiv normalizatsiya (apostrof
// variantlari va boshqa belgilar). Ko'rsatishda asl nomlar saqlanadi,
// ma'lumot o'zgartirilmaydi.
export function norm(s: string | null | undefined): string {
  return (s || "")
    .toLowerCase()
    .replace(/[\u2019\u2018\u02BC'`´]/g, "")
    .replace(/[^a-z0-9\u0400-\u04FF]+/gi, "");
}

const KNOWN = ["raw", "pre-finished", "finished"];
const r2 = (x: number): number => +(x || 0).toFixed(2);

export async function buildFlowGraph(pool: Pool): Promise<FlowGraphResponse> {
  const client: PoolClient = await pool.connect();
  try {
    // Yagona izchil snapshot + yozishdan DB darajasida himoya.
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");

    // Vehicle warehouses (location_type='vehicle') belong to the vehicle-
    // distribution pilot; their stock is NOT part of the production flow graph.
    // Exclude them (and their inventory) from every generic warehouse/inventory
    // loader below so nodes and KPI totals never surface DM-001. Ordinary /
    // container / ayvon warehouses are unaffected.
    const containersQ = await client.query(`
      SELECT w.id, w.name, w.purpose, w.location_type AS loc, w.capacity_kg::float8 AS cap,
             COALESCE(SUM(i.weight_kg), 0)::float8 AS kg,
             COALESCE(SUM(i.quantity), 0)::float8 AS dona
      FROM warehouses w
      LEFT JOIN inventory i ON i.warehouse_id = w.id
      WHERE COALESCE(w.location_type,'general') != 'vehicle'
      GROUP BY w.id, w.name, w.purpose, w.location_type, w.capacity_kg
      ORDER BY w.name
    `);
    const positionsQ = await client.query(`
      SELECT i.warehouse_id AS wid, i.product, i.quantity::float8 AS qty,
             i.weight_kg::float8 AS kg, i.product_type AS ptype
      FROM inventory i
      JOIN warehouses w ON w.id = i.warehouse_id
      WHERE (i.quantity > 0 OR i.weight_kg > 0)
        AND COALESCE(w.location_type,'general') != 'vehicle'
      ORDER BY i.warehouse_id, i.product
    `);
    const linesQ = await client.query(`SELECT id, name FROM production_lines ORDER BY id`);
    const lineWorkersQ = await client.query(`
      SELECT line_id, worker_name AS worker, role
      FROM production_line_workers ORDER BY line_id, id
    `);
    const rolesQ = await client.query(`
      SELECT line_id, role_key AS "roleKey", label, rate::float8 AS rate,
             pay_mode AS "payMode", max_workers::int AS "maxWorkers"
      FROM line_role_config ORDER BY line_id, id
    `);
    const wipAggQ = await client.query(`
      SELECT line_id,
             COUNT(*)::int AS rows,
             COALESCE(SUM(CASE WHEN movement_type = 'RECEIVE' THEN weight_kg
                               WHEN movement_type = 'PRODUCE' THEN -weight_kg
                               ELSE 0 END), 0)::float8 AS balance_kg,
             COUNT(*) FILTER (WHERE movement_type = 'RECEIVE')::int AS receive_rows,
             COALESCE(SUM(weight_kg) FILTER (WHERE movement_type = 'RECEIVE'), 0)::float8 AS receive_kg
      FROM wip_movements
      GROUP BY line_id
    `);
    const produceQ = await client.query(`
      SELECT line_id, product, SUM(weight_kg)::float8 AS kg, COUNT(*)::int AS n,
             MIN(created_at)::date::text AS first, MAX(created_at)::date::text AS last
      FROM wip_movements
      WHERE movement_type = 'PRODUCE'
      GROUP BY line_id, product
      ORDER BY line_id, product
    `);
    const receiveQ = await client.query(`
      SELECT from_warehouse_id AS wid, line_id, SUM(weight_kg)::float8 AS kg,
             COUNT(*)::int AS rows,
             MIN(created_at)::date::text AS first, MAX(created_at)::date::text AS last
      FROM wip_movements
      WHERE movement_type = 'RECEIVE'
      GROUP BY from_warehouse_id, line_id
    `);
    const batchQ = await client.query(`
      SELECT production_line_id AS line_id, product,
             COALESCE(SUM(weight_kg), 0)::float8 AS kg,
             COALESCE(SUM(quantity), 0)::float8 AS dona,
             COUNT(*)::int AS n, MAX(created_at)::date::text AS last
      FROM batches
      GROUP BY production_line_id, product
      ORDER BY product
    `);
    const bomQ = await client.query(`
      SELECT pm.id, pm.product_name, pm.quantity_required::float8 AS quantity_required,
             pm.product_item_id, pm.material_item_id,
             rm.name AS material_name
      FROM product_materials pm
      LEFT JOIN raw_materials rm ON rm.id = pm.raw_material_id
      ORDER BY pm.id
    `);
    const itemsQ = await client.query(`SELECT display_name AS name, sku FROM items ORDER BY id`);
    const rawmatQ = await client.query(`
      SELECT id, name, current_stock::float8 AS stock, currency
      FROM raw_materials ORDER BY id
    `);
    const salaryByWorkerQ = await client.query(`
      SELECT lw.line_id, sp.worker, SUM(sp.amount)::float8 AS total,
             COUNT(*)::int AS entries, MAX(sp.paid_at)::date::text AS last
      FROM (SELECT DISTINCT line_id, worker_name FROM production_line_workers) lw
      JOIN salary_payments sp ON sp.worker = lw.worker_name
      GROUP BY lw.line_id, sp.worker
      ORDER BY total DESC
    `);
    // KPI counts also exclude vehicle warehouses / vehicle inventory rows so
    // the flow graph totals stay consistent with the loaders above.
    const countsQ = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM inventory i
           JOIN warehouses w ON w.id = i.warehouse_id
          WHERE COALESCE(w.location_type,'general') != 'vehicle')::int AS inventory_rows,
        (SELECT COUNT(*) FROM inventory i
           JOIN warehouses w ON w.id = i.warehouse_id
          WHERE (i.quantity > 0 OR i.weight_kg > 0)
            AND COALESCE(w.location_type,'general') != 'vehicle')::int AS inventory_nonzero,
        (SELECT COUNT(*) FROM wip_movements)::int AS wip_total,
        (SELECT COUNT(*) FROM wip_movements
          WHERE product_item_id IS NOT NULL OR raw_material_item_id IS NOT NULL)::int AS wip_linked,
        (SELECT COUNT(*) FROM batches)::int AS batches_total,
        (SELECT COUNT(*) FROM batches WHERE item_id IS NOT NULL)::int AS batches_linked,
        (SELECT COUNT(*) FROM batches WHERE archived)::int AS batches_archived,
        (SELECT COUNT(*) FROM batches WHERE production_line_id IS NULL)::int AS batches_unattributed,
        (SELECT COUNT(*) FROM products)::int AS products_total,
        (SELECT COUNT(*) FROM products WHERE item_id IS NOT NULL)::int AS products_linked,
        (SELECT COUNT(*) FROM items)::int AS items_total,
        (SELECT COUNT(*) FROM warehouses WHERE COALESCE(location_type,'general') != 'vehicle')::int AS warehouses_total,
        (SELECT COUNT(*) FROM warehouses WHERE location_type = 'container')::int AS containers_total
    `);

    await client.query("COMMIT");

    return assemble({
      containers: containersQ.rows,
      positions: positionsQ.rows,
      lines: linesQ.rows,
      lineWorkers: lineWorkersQ.rows,
      roles: rolesQ.rows,
      wipAgg: wipAggQ.rows,
      produce: produceQ.rows,
      receive: receiveQ.rows,
      batchRows: batchQ.rows,
      bom: bomQ.rows,
      items: itemsQ.rows,
      rawmat: rawmatQ.rows,
      salaryByWorker: salaryByWorkerQ.rows,
      counts: countsQ.rows[0],
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

function assemble(src: {
  containers: Row[];
  positions: Row[];
  lines: Row[];
  lineWorkers: Row[];
  roles: Row[];
  wipAgg: Row[];
  produce: Row[];
  receive: Row[];
  batchRows: Row[];
  bom: Row[];
  items: Row[];
  rawmat: Row[];
  salaryByWorker: Row[];
  counts: Row;
}): FlowGraphResponse {
  const { positions, counts } = src;

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

  const rmByNorm = new Map<string, Row>(src.rawmat.map((r) => [norm(r.name), r]));

  const posByWid = new Map<number, Row[]>();
  for (const p of positions) {
    if (!posByWid.has(p.wid)) posByWid.set(p.wid, []);
    posByWid.get(p.wid)!.push(p);
  }

  // ── Konteynerlar: kontent asosida klassifikatsiya (purpose EMAS) ───────────
  const contAll: FlowContainer[] = src.containers.map((c) => {
    const rows = posByWid.get(c.id) || [];
    const byType: Record<string, { kg: number; dona: number; rows: number }> = {};
    for (const r of rows) {
      const raw = String(r.ptype ?? "").toLowerCase().trim();
      const t = KNOWN.includes(raw) ? raw : "unclassified";
      byType[t] = byType[t] || { kg: 0, dona: 0, rows: 0 };
      byType[t].kg += r.kg || 0;
      byType[t].dona += r.qty || 0;
      byType[t].rows += 1;
    }
    const present = Object.keys(byType);
    let dominant: string | null = null;
    let best = -1;
    for (const t of present) {
      const score = byType[t].kg > 0 ? byType[t].kg : byType[t].dona * 0.001;
      if (score > best) {
        best = score;
        dominant = t;
      }
    }
    const knownPresent = present.filter((t) => KNOWN.includes(t));
    let derived: string;
    if (!present.length) derived = "empty";
    else if (present.length === 1) derived = present[0];
    else if (knownPresent.length === 1 && present.includes("unclassified")) derived = knownPresent[0];
    else derived = "mixed";
    const purpose = String(c.purpose || "").toLowerCase();
    const mismatch =
      derived !== "empty" &&
      !!purpose &&
      KNOWN.includes(purpose) &&
      !!dominant &&
      dominant !== "unclassified" &&
      purpose !== dominant;
    return {
      id: c.id,
      name: c.name,
      purpose: c.purpose ?? null,
      loc: c.loc ?? null,
      cap: c.cap ?? null,
      kg: r2(c.kg),
      dona: +(c.dona || 0),
      positionsCount: rows.length,
      byType,
      derived,
      dominant,
      mismatch: !!mismatch,
      items: rows.map((r) => ({
        wid: r.wid,
        product: r.product,
        sku: skuFor(r.product),
        qty: +(r.qty || 0),
        kg: r2(r.kg),
        ptype: r.ptype ?? null,
      })),
    };
  });

  const isContainer = (c: FlowContainer): boolean => ["container", "ayvon"].includes((c.loc || "").toLowerCase());
  const regionalList = contAll.filter((c) => !isContainer(c));
  const contOnly = contAll.filter(isContainer);
  const emptyContainers = contOnly.filter((c) => c.derived === "empty");
  const nonEmpty = contOnly.filter((c) => c.derived !== "empty");
  const containersRaw = nonEmpty.filter((c) => c.dominant === "raw");
  const containersFinished = nonEmpty.filter((c) => c.dominant !== "raw");
  const regionalGroup: FlowRegionalGroup | null = regionalList.length
    ? {
        name: "Viloyat / boshqa omborlar",
        count: regionalList.length,
        kg: r2(regionalList.reduce((s, c) => s + c.kg, 0)),
        dona: +regionalList.reduce((s, c) => s + c.dona, 0),
        list: regionalList,
      }
    : null;

  // ── Bo'limlar ──────────────────────────────────────────────────────────────
  const produceByLine = new Map<number, Row[]>();
  for (const p of src.produce) {
    if (!produceByLine.has(p.line_id)) produceByLine.set(p.line_id, []);
    produceByLine.get(p.line_id)!.push(p);
  }
  const batchByLine = new Map<number, Row[]>();
  const unattributed = { products: new Set<string>(), kg: 0, dona: 0, n: 0 };
  for (const b of src.batchRows) {
    if (b.line_id == null) {
      unattributed.products.add(b.product);
      unattributed.kg += b.kg || 0;
      unattributed.dona += b.dona || 0;
      unattributed.n += b.n || 0;
      continue;
    }
    if (!batchByLine.has(b.line_id)) batchByLine.set(b.line_id, []);
    batchByLine.get(b.line_id)!.push(b);
  }
  const workersByLine = new Map<number, { worker: string; role: string }[]>();
  for (const w of src.lineWorkers) {
    if (!workersByLine.has(w.line_id)) workersByLine.set(w.line_id, []);
    workersByLine.get(w.line_id)!.push({ worker: w.worker, role: w.role });
  }
  const rolesByLine = new Map<number, FlowDepartment["roles"]>();
  for (const r of src.roles) {
    if (!rolesByLine.has(r.line_id)) rolesByLine.set(r.line_id, []);
    rolesByLine.get(r.line_id)!.push({
      roleKey: r.roleKey,
      label: r.label,
      rate: +(r.rate || 0),
      payMode: r.payMode,
      maxWorkers: +(r.maxWorkers || 0),
    });
  }
  const wipAggByLine = new Map<number, Row>(src.wipAgg.map((w) => [w.line_id, w]));
  const swByLine = new Map<number, FlowDepartment["salaryByWorker"]>();
  const salaryAgg = new Map<number, FlowDeptSalary>();
  for (const s of src.salaryByWorker) {
    if (!swByLine.has(s.line_id)) swByLine.set(s.line_id, []);
    swByLine.get(s.line_id)!.push({ worker: s.worker, total: +(s.total || 0), entries: +(s.entries || 0), last: s.last ?? null });
    const agg = salaryAgg.get(s.line_id) || { entries: 0, workers: 0, total: 0, lastDate: null as string | null };
    agg.entries += +(s.entries || 0);
    agg.workers += 1;
    agg.total = r2(agg.total + +(s.total || 0));
    if (!agg.lastDate || (s.last && s.last > agg.lastDate)) agg.lastDate = s.last ?? agg.lastDate;
    salaryAgg.set(s.line_id, agg);
  }
  const bomByProduct = new Map<string, FlowBomInput[]>();
  for (const r of src.bom) {
    const k = norm(r.product_name);
    if (!bomByProduct.has(k)) bomByProduct.set(k, []);
    const rm = r.material_name ? rmByNorm.get(norm(r.material_name)) : null;
    bomByProduct.get(k)!.push({
      material: r.material_name ?? "(nomaʼlum material)",
      perUnit: +(r.quantity_required || 0),
      stock: rm ? +(rm.stock || 0) : null,
      currency: rm ? (rm.currency ?? null) : null,
    });
  }

  const departments: FlowDepartment[] = [];
  const inactiveDepartments: { id: number; name: string }[] = [];
  for (const l of src.lines) {
    if (!ACTIVE_LINE_IDS.includes(l.id)) {
      inactiveDepartments.push({ id: l.id, name: l.name });
      continue;
    }
    const prod = produceByLine.get(l.id) || [];
    const bat = batchByLine.get(l.id) || [];
    const wa = wipAggByLine.get(l.id);
    const productNames = [...new Set([...prod.map((p) => p.product), ...bat.map((b) => b.product)])];
    const bomInputs: FlowBomInput[] = [];
    for (const pn of productNames) {
      for (const bi of bomByProduct.get(norm(pn)) || []) bomInputs.push({ ...bi, product: pn });
    }
    departments.push({
      id: l.id,
      name: l.name,
      workers: workersByLine.get(l.id) || [],
      roles: rolesByLine.get(l.id) || [],
      wipKg: r2(wa ? wa.balance_kg : 0),
      wipRows: wa ? +wa.rows : 0,
      salary: salaryAgg.get(l.id) || { entries: 0, workers: 0, total: 0, lastDate: null },
      salaryByWorker: swByLine.get(l.id) || [],
      produce: prod.map((p) => ({ product: p.product, kg: r2(p.kg), n: +p.n, first: p.first, last: p.last })),
      batches: bat.map((b) => ({ product: b.product, kg: r2(b.kg), dona: +(b.dona || 0), n: +b.n, last: b.last })),
      bomInputs,
    });
  }
  departments.sort((a, b) => ACTIVE_LINE_IDS.indexOf(a.id) - ACTIVE_LINE_IDS.indexOf(b.id));

  // ── WIP nodelari ───────────────────────────────────────────────────────────
  const wip: FlowWipNode[] = departments.map((d) => {
    const wa = wipAggByLine.get(d.id);
    const receiveKg = r2(wa ? wa.receive_kg : 0);
    const first = d.produce.length ? d.produce.map((p) => p.first).sort()[0] : null;
    const last = d.produce.length ? d.produce.map((p) => p.last).sort().slice(-1)[0] : null;
    return {
      lineId: d.id,
      lineName: d.name,
      balanceKg: d.wipKg,
      rows: d.wipRows,
      produceKg: r2(d.produce.reduce((s, p) => s + p.kg, 0)),
      receiveKg,
      status: d.wipRows === 0 ? "NO_LEDGER" : d.wipKg < 0 ? "NEGATIVE" : "OK",
      first,
      last,
    };
  });

  // ── Mahsulotlar + edge'lar ─────────────────────────────────────────────────
  const contNameById = new Map<number, string>(contAll.map((c) => [c.id, c.name]));
  const slug = (s: string): string => norm(s).slice(0, 40) || "p";
  const productMap = new Map<string, FlowProduct>();
  const touchProduct = (name: string, lineId: number | null): FlowProduct => {
    const k = norm(name);
    if (!productMap.has(k)) {
      const placements = positions.filter((p: Row) => norm(p.product) === k);
      productMap.set(k, {
        key: `p-${slug(name)}`,
        name,
        sku: skuFor(name),
        lineIds: [],
        producedKg: 0,
        batchKg: 0,
        batchDona: 0,
        placements: placements.map((p: Row) => ({
          wid: p.wid,
          container: contNameById.get(p.wid) || `#${p.wid}`,
          kg: +(p.kg || 0),
          qty: +(p.qty || 0),
          ptype: p.ptype ?? null,
          skuInContainer: skuFor(p.product),
        })),
        bom: bomByProduct.get(k) || [],
      });
    }
    const P = productMap.get(k)!;
    if (lineId != null && !P.lineIds.includes(lineId)) P.lineIds.push(lineId);
    return P;
  };

  const edges: FlowEdge[] = [];
  let ei = 0;
  const pushEdge = (e: Omit<FlowEdge, "id">): void => {
    edges.push({ id: `e-${ei++}`, ...e });
  };

  for (const d of departments) {
    const wa = wipAggByLine.get(d.id);
    const receiveRows = wa ? +wa.receive_rows : 0;
    const hasProduce = d.produce.length > 0;
    if (hasProduce) {
      pushEdge({
        kind: "dept-wip",
        source: `d-${d.id}`,
        target: `w-${d.id}`,
        table: "wip_movements",
        joinBasis: "line_id (FK)",
        rows: d.wipRows,
        kg: r2(d.produce.reduce((s, p) => s + p.kg, 0)),
        note: receiveRows > 0 ? "PRODUCE + RECEIVE yozuvlari" : "PRODUCE yozuvlari; RECEIVE tomoni 0",
      });
      for (const p of d.produce) {
        const P = touchProduct(p.product, d.id);
        P.producedKg = r2(P.producedKg + p.kg);
        pushEdge({
          kind: "wip-product",
          source: `w-${d.id}`,
          target: P.key,
          table: "wip_movements (PRODUCE)",
          joinBasis: "line_id + product (text)",
          kg: p.kg,
          rows: p.n,
          first: p.first,
          last: p.last,
        });
      }
      for (const b of d.batches) {
        const P = touchProduct(b.product, d.id);
        P.batchKg = r2(P.batchKg + b.kg);
        P.batchDona += b.dona;
      }
    } else {
      for (const b of d.batches) {
        const P = touchProduct(b.product, d.id);
        P.batchKg = r2(P.batchKg + b.kg);
        P.batchDona += b.dona;
        pushEdge({
          kind: "batch-product",
          source: `d-${d.id}`,
          target: P.key,
          table: "batches",
          joinBasis: "production_line_id (FK) + product (text)",
          kg: b.kg,
          dona: b.dona,
          rows: b.n,
          last: b.last,
          note: "WIP ledger yozuvi yo\u2018q \u2014 partiya (batch) ma\u2019lumoti",
        });
      }
    }
  }

  // Mahsulot → konteyner joylashuvlari (chizilgan nodelarga agregatlangan)
  const renderedWid = new Map<number, string>();
  for (const c of containersRaw) renderedWid.set(c.id, `c-${c.id}`);
  for (const c of containersFinished) renderedWid.set(c.id, `c-${c.id}`);
  for (const c of emptyContainers) renderedWid.set(c.id, `c-${c.id}`);
  if (regionalGroup) for (const c of regionalGroup.list) renderedWid.set(c.id, "regional");
  for (const P of productMap.values()) {
    const agg = new Map<string, { kg: number; dona: number; rows: number; wids: Set<number> }>();
    for (const pl of P.placements) {
      const target = renderedWid.get(pl.wid);
      if (!target) continue;
      const a = agg.get(target) || { kg: 0, dona: 0, rows: 0, wids: new Set<number>() };
      a.kg += pl.kg;
      a.dona += pl.qty;
      a.rows += 1;
      a.wids.add(pl.wid);
      agg.set(target, a);
    }
    for (const [target, a] of agg) {
      pushEdge({
        kind: "product-container",
        source: P.key,
        target,
        table: "inventory",
        joinBasis: "product nomi (text, normalizatsiya) \u2014 item_id bo\u2018sh",
        kg: r2(a.kg),
        dona: +a.dona,
        rows: a.rows,
        note: target === "regional" ? `${a.wids.size} ta omborga taqsimlangan` : undefined,
      });
    }
  }
  const products = [...productMap.values()];

  // ── Supply edge'lar: FAQAT real RECEIVE yozuvlaridan ───────────────────────
  const supplyEdges: FlowSupplyEdge[] = [];
  let si = 0;
  for (const r of src.receive) {
    if (!ACTIVE_LINE_IDS.includes(r.line_id)) continue; // nofaol bo'lim node emas
    const sourceKey = r.wid != null ? (renderedWid.get(r.wid) ?? null) : null;
    if (!sourceKey) continue; // manba ombor chizilmagan bo'lsa, taxmin qilinmaydi
    supplyEdges.push({
      id: `s-${si++}`,
      kind: "container-dept",
      source: sourceKey,
      target: `d-${r.line_id}`,
      table: "wip_movements (RECEIVE)",
      joinBasis: "from_warehouse_id + line_id (FK)",
      kg: r2(r.kg),
      rows: +r.rows,
      first: r.first,
      last: r.last,
    });
  }

  // ── Gaplar: yo'q ma'lumot halol ko'rsatiladi ───────────────────────────────
  const gaps: FlowGap[] = [];
  const receiveTotal = src.receive.reduce((s, r) => s + +r.rows, 0);
  if (receiveTotal === 0) {
    gaps.push({
      code: "NO_RECEIVE_DATA",
      title: "Container \u2192 Bo\u2018lim oqimi: ma\u2019lumot yo\u2018q",
      detail:
        `wip_movements jadvalida RECEIVE turidagi yozuv 0 ta (jami ${counts.wip_total} ta yozuv). ` +
        "Xomashyo konteynerdan bo\u2018limga kirim hech qachon ro\u2018yxatga olinmagan, shuning uchun bu chiziqlar chizilmaydi. " +
        "Kirim yozila boshlagach oqim avtomatik paydo bo\u2018ladi.",
    });
  }
  for (const w of wip) {
    if (w.status === "NEGATIVE") {
      gaps.push({
        code: "NEGATIVE_WIP",
        title: `${w.lineName}: WIP manfiy`,
        detail: `Kirim ${w.receiveKg} kg, chiqim ${w.produceKg} kg \u2014 balans ${w.balanceKg} kg. Bu real database holati, yashirilmagan.`,
      });
    }
  }
  const bomLinked = src.bom.filter((r) => r.product_item_id != null || r.material_item_id != null).length;
  if (
    counts.wip_linked < counts.wip_total ||
    counts.batches_linked < counts.batches_total ||
    counts.products_linked < counts.products_total ||
    bomLinked < src.bom.length
  ) {
    gaps.push({
      code: "ITEM_LINKS_EMPTY",
      title: "item_id bog\u2018lari bo\u2018sh \u2014 text-nom bog\u2018lanish",
      detail:
        `wip_movements ${counts.wip_linked}/${counts.wip_total}, batches ${counts.batches_linked}/${counts.batches_total}, ` +
        `products ${counts.products_linked}/${counts.products_total}, BOM ${bomLinked}/${src.bom.length} item_id bilan bog\u2018langan. ` +
        "Graf ehtiyotkor nom-normalizatsiya (apostrof variantlari) orqali bog\u2019laydi; ma\u2019lumot o\u2018zgartirilmaydi.",
    });
  }
  const mismatches = contAll.filter((c) => c.mismatch);
  if (mismatches.length) {
    gaps.push({
      code: "PURPOSE_MISMATCH",
      title: "purpose \u2260 kontent: " + mismatches.map((c) => c.name).join(", "),
      detail: mismatches
        .map(
          (c) =>
            `${c.name}: DB purpose='${c.purpose}', kontent=${c.dominant} (${c.kg} kg). Grafda kontent bo\u2018yicha ko\u2018rsatiladi, DB qiymati O\u2018ZGARTIRILMAYDI.`,
        )
        .join(" "),
    });
  }
  if (unattributed.n > 0) {
    gaps.push({
      code: "UNATTRIBUTED_BATCHES",
      title: `Bo\u2018limga biriktirilmagan partiyalar: ${unattributed.n} ta`,
      detail:
        `${unattributed.products.size} xil mahsulot, ${unattributed.kg.toFixed(2)} kg / ${unattributed.dona} dona partiya production_line_id=NULL. ` +
        "Grafda chizilmaydi (taxmin qilinmaydi), faqat shu yerda qayd etiladi.",
    });
  }

  return {
    generatedAt: new Date().toISOString().slice(0, 10),
    readOnly: true,
    source: "GET /ombor/flow/graph \u2014 live, READ ONLY tranzaksiya (REPEATABLE READ)",
    nodes: {
      containersRaw,
      containersFinished,
      emptyContainers,
      regionalGroup,
      departments,
      inactiveDepartments,
      wip,
      products,
    },
    edges,
    supplyEdges,
    gaps,
    meta: {
      unattributedBatches: {
        products: unattributed.products.size,
        kg: r2(unattributed.kg),
        dona: +unattributed.dona,
        batches: unattributed.n,
      },
      dataQuality: {
        wipItemLinked: `${counts.wip_linked}/${counts.wip_total}`,
        batchesItemLinked: `${counts.batches_linked}/${counts.batches_total}`,
        productsItemLinked: `${counts.products_linked}/${counts.products_total}`,
        bomItemLinked: `${bomLinked}/${src.bom.length}`,
      },
      counts: {
        warehouses: +counts.warehouses_total,
        containers: +counts.containers_total,
        inventoryRows: +counts.inventory_rows,
        inventoryNonzero: +counts.inventory_nonzero,
        items: +counts.items_total,
        wipMovements: +counts.wip_total,
        wipReceiveRows: receiveTotal,
        batches: +counts.batches_total,
        batchesArchived: +counts.batches_archived,
        batchesUnattributed: +counts.batches_unattributed,
        bomRows: src.bom.length,
        products: +counts.products_total,
      },
      activeLineIds: [...ACTIVE_LINE_IDS],
      classificationSource: "inventory.product_type (kontent-based) \u2014 warehouses.purpose EMAS",
      pins: `inv=${counts.inventory_rows} \u00b7 pos=${counts.inventory_nonzero} \u00b7 items=${counts.items_total} \u00b7 wipmov=${counts.wip_total} \u00b7 batches=${counts.batches_total} \u00b7 bom=${src.bom.length} \u00b7 products=${counts.products_total}`,
    },
  };
}
