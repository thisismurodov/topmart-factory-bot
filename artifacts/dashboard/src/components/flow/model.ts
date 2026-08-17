// Production Flow Map — sof (DOM'siz) graf logikasi.
// API javobini React Flow node/edge strukturasiga aylantiradi, qidiruv/filtr
// hisoblaydi. Birlik testlar shu modulni tekshiradi (vitest, node muhiti).
import type { Edge, Node } from "@xyflow/react";
import {
  norm, fmtKg, fmtInt,
  type FlowEdgeData, type FlowGraphResponse, type Selection,
} from "./types";

// ---------- joylashuv konstantalari (F1 vizual tili) ----------
export const COL_X = { raw: 0, dept: 480, wip: 940, product: 1360, finished: 1840 } as const;
export type ColKey = keyof typeof COL_X;
export const NODE_H = { container: 128, dept: 138, wip: 148, product: 138, regional: 128 } as const;
const GAP_Y = 34;

export type FilterKey = "container" | "department" | "wip" | "product" | "raw" | "pre-finished" | "finished";

export const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "container", label: "Container" },
  { key: "department", label: "Bo'lim" },
  { key: "wip", label: "WIP" },
  { key: "product", label: "Mahsulot" },
  { key: "raw", label: "Raw" },
  { key: "pre-finished", label: "Pre-finished" },
  { key: "finished", label: "Finished" },
];

export interface NodeMeta {
  id: string;
  kindFilter: "container" | "department" | "wip" | "product";
  classes: string[]; // kontent klasslari (klass filtrlari uchun)
  haystack: string;  // normalizatsiya qilingan qidiruv matni
}

export const EDGE_STYLE: Record<string, { stroke: string; dash?: string }> = {
  "dept-wip": { stroke: "#6366f1" },
  "wip-product": { stroke: "#0ea5e9" },
  "batch-product": { stroke: "#14b8a6", dash: "6 3" },
  "product-container": { stroke: "#10b981" },
  "container-dept": { stroke: "#f59e0b" }, // real RECEIVE (supply) oqimi
};

export function edgeLabel(e: FlowEdgeData): string {
  if (e.kind === "product-container")
    return `${fmtKg(e.kg ?? 0)} kg${(e.dona ?? 0) > 0 ? ` / ${fmtInt(e.dona ?? 0)} dona` : ""}`;
  if (e.kind === "wip-product") return `${fmtKg(e.kg ?? 0)} kg`;
  if (e.kind === "batch-product") return `batch: ${fmtKg(e.kg ?? 0)} kg`;
  if (e.kind === "container-dept") return `RECEIVE: ${fmtKg(e.kg ?? 0)} kg · ${e.rows ?? 0} yozuv`;
  return `${e.rows ?? 0} yozuv`;
}

export interface Scaffold {
  nodes: Node[];
  edges: Edge[];
  metaById: Map<string, NodeMeta>;
  adjacency: Map<string, Set<string>>;
}

// API javobidan statik graf skeleti. Hech qanday bog'lanish o'ylab topilmaydi:
// edge'lar faqat graph.edges + graph.supplyEdges dan olinadi.
export function buildScaffold(graph: FlowGraphResponse, showEmpty: boolean): Scaffold {
  const N = graph.nodes;
  const nodes: Node[] = [];
  const meta: NodeMeta[] = [];

  const count = {
    raw: N.containersRaw.length,
    dept: N.departments.length,
    wip: N.wip.length,
    product: N.products.length,
    finished: N.containersFinished.length + (N.regionalGroup ? 1 : 0) + (showEmpty ? N.emptyContainers.length : 0),
  };
  const colHeights: Record<ColKey, number> = {
    raw: count.raw * (NODE_H.container + GAP_Y),
    dept: count.dept * (NODE_H.dept + GAP_Y),
    wip: count.wip * (NODE_H.wip + GAP_Y),
    product: count.product * (NODE_H.product + GAP_Y),
    finished: count.finished * (NODE_H.container + GAP_Y),
  };
  const maxH = Math.max(...Object.values(colHeights));
  const offset = (col: ColKey) => (maxH - colHeights[col]) / 2;

  // ustun yorliqlari
  const LABELS: [ColKey, string, string][] = [
    ["raw", "RAW CONTAINER", `${count.raw} ta (kontent bo'yicha)`],
    ["dept", "DEPARTMENT", `${count.dept} ta production line`],
    ["wip", "WIP", "wip_movements ledgeri"],
    ["product", "PRODUCT", `${count.product} ta (real chiqim)`],
    ["finished", "FINISHED CONTAINER", `${count.finished} ta joylashuv`],
  ];
  for (const [col, label, sub] of LABELS) {
    nodes.push({
      id: `label-${col}`, type: "colLabel", position: { x: COL_X[col], y: -84 },
      data: { label, sub }, draggable: false, selectable: false,
    });
  }

  const push = (
    id: string, type: string, col: ColKey, idx: number, h: number,
    data: Record<string, unknown>, m: Omit<NodeMeta, "id">,
  ) => {
    nodes.push({ id, type, position: { x: COL_X[col], y: offset(col) + idx * (h + GAP_Y) }, data });
    meta.push({ id, ...m });
  };

  N.containersRaw.forEach((c, i) =>
    push(`c-${c.id}`, "container", "raw", i, NODE_H.container, { container: c }, {
      kindFilter: "container",
      classes: Object.keys(c.byType),
      haystack: norm(c.name + " " + c.items.map((x) => `${x.product} ${x.sku ?? ""}`).join(" ")),
    }));

  N.departments.forEach((d, i) =>
    push(`d-${d.id}`, "dept", "dept", i, NODE_H.dept, { dept: d }, {
      kindFilter: "department", classes: [],
      haystack: norm(d.name + " " + d.workers.map((w) => w.worker).join(" ")),
    }));

  N.wip.forEach((w, i) =>
    push(`w-${w.lineId}`, "wip", "wip", i, NODE_H.wip, { wip: w }, {
      kindFilter: "wip", classes: [], haystack: norm(`wip ${w.lineName}`),
    }));

  N.products.forEach((p, i) =>
    push(p.key, "product", "product", i, NODE_H.product, { product: p }, {
      kindFilter: "product", classes: ["finished"],
      haystack: norm(`${p.name} ${p.sku ?? ""}`),
    }));

  let fi = 0;
  N.containersFinished.forEach((c) =>
    push(`c-${c.id}`, "container", "finished", fi++, NODE_H.container, { container: c }, {
      kindFilter: "container",
      classes: Object.keys(c.byType),
      haystack: norm(c.name + " " + c.items.map((x) => `${x.product} ${x.sku ?? ""}`).join(" ")),
    }));
  if (N.regionalGroup) {
    push("regional", "regional", "finished", fi++, NODE_H.regional, { group: N.regionalGroup }, {
      kindFilter: "container", classes: [],
      haystack: norm(N.regionalGroup.name + " " + N.regionalGroup.list.map((c) => c.name + " " + c.items.map((x) => `${x.product} ${x.sku ?? ""}`).join(" ")).join(" ")),
    });
  }
  if (showEmpty) {
    N.emptyContainers.forEach((c) =>
      push(`c-${c.id}`, "container", "finished", fi++, NODE_H.container, { container: c }, {
        kindFilter: "container", classes: ["empty"], haystack: norm(c.name),
      }));
  }

  // RAW→DEPT bo'shlig'i — faqat API halol gap qaytarganda chiziladi
  if (graph.gaps.some((g) => g.code === "NO_RECEIVE_DATA")) {
    nodes.push({
      id: "gap-receive", type: "gap",
      position: { x: COL_X.raw + 312, y: offset("dept") + Math.max(0, (colHeights.dept - 96) / 2) },
      data: { title: "RECEIVE: 0 yozuv", sub: "Flow data mavjud emas" },
      draggable: false,
    });
  }

  // edge'lar: real bog'lanishlar + real RECEIVE (supply) yozuvlari
  const allEdges: FlowEdgeData[] = [...graph.edges, ...graph.supplyEdges];
  const edges: Edge[] = allEdges.map((e) => {
    const st = EDGE_STYLE[e.kind] ?? { stroke: "#94a3b8" };
    return {
      id: e.id, source: e.source, target: e.target, type: "smoothstep",
      label: edgeLabel(e),
      labelStyle: { fontSize: 10, fill: "#475569" },
      labelBgStyle: { fill: "#ffffff", fillOpacity: 0.85 },
      style: { stroke: st.stroke, strokeWidth: 1.8, strokeDasharray: st.dash },
      interactionWidth: 32,
    };
  });

  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a)!.add(b);
  };
  for (const e of allEdges) { link(e.source, e.target); link(e.target, e.source); }

  const metaById = new Map(meta.map((m) => [m.id, m]));
  return { nodes, edges, metaById, adjacency };
}

// Qidiruv + filtr natijasi: ko'rinadigan node id'lari.
// null = hamma narsa ko'rinadi (hech qanday cheklov yo'q).
// Qidiruv topilmalarni va ular bilan bog'langan zanjirni yoritadi (path highlight).
export function computeVisible(
  query: string,
  active: Set<FilterKey>,
  metaById: Map<string, NodeMeta>,
  adjacency: Map<string, Set<string>>,
): Set<string> | null {
  const q = norm(query);
  const kindFilters = new Set([...active].filter((f) => ["container", "department", "wip", "product"].includes(f)));
  const classFilters = new Set([...active].filter((f) => ["raw", "pre-finished", "finished"].includes(f)));

  const passesFilters = (m: NodeMeta) => {
    if (kindFilters.size && !kindFilters.has(m.kindFilter)) return false;
    if (classFilters.size) {
      if (m.kindFilter === "department" || m.kindFilter === "wip") return false;
      if (!m.classes.some((c) => classFilters.has(c as FilterKey))) return false;
    }
    return true;
  };

  const all = [...metaById.values()];
  let result: Set<string> | null = null;

  if (q) {
    const matched = all.filter((m) => m.haystack.includes(q)).map((m) => m.id);
    const reach = new Set<string>(matched);
    const stack = [...matched];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const nb of adjacency.get(cur) ?? []) {
        if (!reach.has(nb)) { reach.add(nb); stack.push(nb); }
      }
    }
    result = reach;
  }
  if (kindFilters.size || classFilters.size) {
    const pass = new Set(all.filter(passesFilters).map((m) => m.id));
    result = result ? new Set([...result].filter((id) => pass.has(id))) : pass;
  }
  return result;
}

// Node id → drawer tanlovi (F1 id sxemasi: c-/d-/w-/p-/regional/gap-receive)
export function selectionForNodeId(id: string): Selection {
  if (id.startsWith("c-")) return { kind: "container", id: Number(id.slice(2)) };
  if (id === "regional") return { kind: "regional" };
  if (id.startsWith("d-")) return { kind: "dept", id: Number(id.slice(2)) };
  if (id.startsWith("w-")) return { kind: "wip", id: Number(id.slice(2)) };
  if (id.startsWith("p-")) return { kind: "product", key: id };
  if (id === "gap-receive") return { kind: "gap", code: "NO_RECEIVE_DATA" };
  return null;
}

// Graf butunlay bo'shmi (§18 — "Hech qanday ma'lumot topilmadi.")
export function isEmptyGraph(g: FlowGraphResponse): boolean {
  const n = g.nodes;
  return (
    n.containersRaw.length === 0 &&
    n.containersFinished.length === 0 &&
    n.emptyContainers.length === 0 &&
    !n.regionalGroup &&
    n.departments.length === 0 &&
    n.wip.length === 0 &&
    n.products.length === 0
  );
}
