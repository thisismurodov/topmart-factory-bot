// Production Flow Map tiplari — GET /api/ombor/flow/graph (F2) javob shakli.
// F1 mockup tiplaridan ko'chirilgan; API node guruhlarni `nodes.*` ichida qaytaradi.
// Qoida: mavjud bo'lmagan ma'lumot o'ylab topilmaydi — tiplar real kontraktni aks ettiradi.

export type ContentClass = "raw" | "pre-finished" | "finished" | "unclassified";
export type DerivedClass = ContentClass | "mixed" | "empty";

export interface PositionRow {
  wid: number;
  product: string;
  sku: string | null;
  qty: number;
  kg: number;
  ptype: string | null;
}

export interface ContainerData {
  id: number;
  name: string;
  purpose: string | null;
  loc: string | null;
  cap: number | null;
  kg: number;
  dona: number;
  positionsCount: number;
  byType: Record<string, { kg: number; dona: number; rows: number }>;
  derived: DerivedClass;
  dominant: string | null;
  mismatch: boolean;
  items: PositionRow[];
}

export interface RoleCfg {
  roleKey: string;
  label: string;
  rate: number;
  payMode: string;
  maxWorkers: number | null;
}

export interface DeptData {
  id: number;
  name: string;
  workers: { worker: string; role: string }[];
  roles: RoleCfg[];
  wipKg: number;
  wipRows: number;
  salary: { entries: number; workers: number; total: number; lastDate: string | null };
  salaryByWorker: { worker: string; total: number; entries: number; last: string }[];
  produce: { product: string; kg: number; n: number; first: string; last: string }[];
  batches: { product: string; kg: number; dona: number; n: number; last: string }[];
  bomInputs: { material: string; perUnit: number; product: string; stock: number | null; currency: string | null }[];
}

export interface WipData {
  lineId: number;
  lineName: string;
  balanceKg: number;
  rows: number;
  produceKg: number;
  receiveKg: number;
  status: "NEGATIVE" | "NO_LEDGER" | "OK";
  first: string | null;
  last: string | null;
}

export interface ProductData {
  key: string;
  name: string;
  sku: string | null;
  lineIds: number[];
  producedKg: number;
  batchKg: number;
  batchDona: number;
  placements: {
    wid: number;
    container: string;
    kg: number;
    qty: number;
    ptype: string | null;
    skuInContainer: string | null;
  }[];
  bom: { material: string; perUnit: number; stock: number | null; currency: string | null }[];
}

export interface FlowEdgeData {
  id: string;
  kind: "dept-wip" | "wip-product" | "batch-product" | "product-container" | "container-dept";
  source: string;
  target: string;
  table: string;
  joinBasis: string;
  kg?: number;
  dona?: number;
  rows?: number;
  first?: string | null;
  last?: string | null;
  note?: string;
}

export interface GapItem {
  code: string;
  title: string;
  detail: string;
}

export interface RegionalGroup {
  name: string;
  count: number;
  kg: number;
  dona: number;
  list: ContainerData[];
}

export interface FlowGraphNodes {
  containersRaw: ContainerData[];
  containersFinished: ContainerData[];
  emptyContainers: ContainerData[];
  regionalGroup: RegionalGroup | null;
  departments: DeptData[];
  inactiveDepartments: { id: number; name: string }[];
  wip: WipData[];
  products: ProductData[];
}

export interface FlowMeta {
  unattributedBatches: { products: number; kg: number; dona: number; batches: number };
  dataQuality: Record<string, string>;
  counts?: Record<string, number>;
  activeLineIds?: number[];
  classificationSource?: string;
  pins?: string;
}

export interface FlowGraphResponse {
  generatedAt: string;
  readOnly: boolean;
  source: string;
  nodes: FlowGraphNodes;
  edges: FlowEdgeData[];
  supplyEdges: FlowEdgeData[];
  gaps: GapItem[];
  meta: FlowMeta;
}

// Detal panel (drawer) tanlovi
export type Selection =
  | { kind: "container"; id: number }
  | { kind: "regional" }
  | { kind: "dept"; id: number }
  | { kind: "wip"; id: number }
  | { kind: "product"; key: string }
  | { kind: "edge"; id: string }
  | { kind: "gap"; code: string }
  | null;

// ---------- umumiy yordamchilar ----------

export const fmtKg = (n: number): string =>
  n.toLocaleString("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export const fmtInt = (n: number): string =>
  Math.round(n).toLocaleString("ru-RU");

export const fmtMoney = (n: number): string =>
  n.toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + " so'm";

export const norm = (s: string): string =>
  (s || "")
    .toLowerCase()
    .replace(/[\u2019\u2018\u02BC'`´]/g, "")
    .replace(/[^a-z0-9\u0400-\u04FF]+/gi, "");

export const CLASS_LABEL: Record<string, string> = {
  raw: "RAW",
  "pre-finished": "PRE-FINISHED",
  finished: "FINISHED",
  mixed: "MIXED",
  unclassified: "TURI BELGILANMAGAN",
  empty: "BO'SH",
};

export const CLASS_BADGE: Record<string, string> = {
  raw: "bg-amber-100 text-amber-800 border-amber-300",
  "pre-finished": "bg-sky-100 text-sky-800 border-sky-300",
  finished: "bg-emerald-100 text-emerald-800 border-emerald-300",
  mixed: "bg-violet-100 text-violet-800 border-violet-300",
  unclassified: "bg-zinc-100 text-zinc-600 border-zinc-300",
  empty: "bg-zinc-50 text-zinc-400 border-zinc-200 border-dashed",
};

export const PTYPE_BADGE: Record<string, string> = {
  raw: "bg-amber-100 text-amber-800",
  "pre-finished": "bg-sky-100 text-sky-800",
  finished: "bg-emerald-100 text-emerald-800",
};
