// PRODUCTION FLOW — F1 interactive mockup (read-only, real prod snapshot 2026-08-17).
// 5 layers: RAW CONTAINER → DEPARTMENT → WIP → PRODUCT → FINISHED CONTAINER.
// Rules honored: no invented relationships, negative WIP shown, content-based
// container classification, DB untouched.
import { useMemo, useState } from "react";
import {
  Background, Controls, ReactFlow,
  type Edge, type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Search, ShieldCheck, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FIXTURE } from "./_shared/graph-fixture";
import { EDGE_STYLE, nodeTypes } from "./_shared/NodePieces";
import { DetailSheet, type Selection } from "./_shared/Drawers";
import { fmtKg, norm } from "./_shared/types";

// ---------- layout constants ----------
const COL_X = { raw: 0, dept: 480, wip: 940, product: 1360, finished: 1840 };
const NODE_H = { container: 128, dept: 138, wip: 148, product: 138, regional: 128 };
const GAP_Y = 34;

type FilterKey = "container" | "department" | "wip" | "product" | "raw" | "pre-finished" | "finished";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "container", label: "Container" },
  { key: "department", label: "Bo'lim" },
  { key: "wip", label: "WIP" },
  { key: "product", label: "Mahsulot" },
  { key: "raw", label: "Raw" },
  { key: "pre-finished", label: "Pre-finished" },
  { key: "finished", label: "Finished" },
];

interface NodeMeta {
  id: string;
  kindFilter: "container" | "department" | "wip" | "product";
  classes: string[]; // content classes present (for class filters)
  haystack: string;  // normalized searchable text (name + SKUs + product names)
}

export function FlowMap() {
  const [sel, setSel] = useState<Selection>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<Set<FilterKey>>(new Set());
  const [showEmpty, setShowEmpty] = useState(false);

  // ---------- static graph built once from fixture ----------
  const { baseNodes, baseEdges, metaById, adjacency } = useMemo(() => {
    const nodes: Node[] = [];
    const meta: NodeMeta[] = [];

    const colHeights: Record<string, number> = {};
    const count = {
      raw: FIXTURE.containersRaw.length,
      dept: FIXTURE.departments.length,
      wip: FIXTURE.wip.length,
      product: FIXTURE.products.length,
      finished: FIXTURE.containersFinished.length + (FIXTURE.regionalGroup ? 1 : 0) + (showEmpty ? FIXTURE.emptyContainers.length : 0),
    };
    colHeights.raw = count.raw * (NODE_H.container + GAP_Y);
    colHeights.dept = count.dept * (NODE_H.dept + GAP_Y);
    colHeights.wip = count.wip * (NODE_H.wip + GAP_Y);
    colHeights.product = count.product * (NODE_H.product + GAP_Y);
    colHeights.finished = count.finished * (NODE_H.container + GAP_Y);
    const maxH = Math.max(...Object.values(colHeights));
    const offset = (col: string) => (maxH - colHeights[col]) / 2;

    // column labels
    const LABELS: [keyof typeof COL_X, string, string][] = [
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

    const push = (id: string, type: string, col: keyof typeof COL_X, idx: number, h: number, data: any, m: Omit<NodeMeta, "id">) => {
      nodes.push({ id, type, position: { x: COL_X[col], y: offset(col) + idx * (h + GAP_Y) }, data });
      meta.push({ id, ...m });
    };

    FIXTURE.containersRaw.forEach((c, i) =>
      push(`c-${c.id}`, "container", "raw", i, NODE_H.container, { container: c }, {
        kindFilter: "container",
        classes: Object.keys(c.byType),
        haystack: norm(c.name + " " + c.items.map((x) => `${x.product} ${x.sku ?? ""}`).join(" ")),
      }));

    FIXTURE.departments.forEach((d, i) =>
      push(`d-${d.id}`, "dept", "dept", i, NODE_H.dept, { dept: d }, {
        kindFilter: "department", classes: [],
        haystack: norm(d.name + " " + d.workers.map((w) => w.worker).join(" ")),
      }));

    FIXTURE.wip.forEach((w, i) =>
      push(`w-${w.lineId}`, "wip", "wip", i, NODE_H.wip, { wip: w }, {
        kindFilter: "wip", classes: [], haystack: norm(`wip ${w.lineName}`),
      }));

    FIXTURE.products.forEach((p, i) =>
      push(p.key, "product", "product", i, NODE_H.product, { product: p }, {
        kindFilter: "product", classes: ["finished"],
        haystack: norm(`${p.name} ${p.sku ?? ""}`),
      }));

    let fi = 0;
    FIXTURE.containersFinished.forEach((c) =>
      push(`c-${c.id}`, "container", "finished", fi++, NODE_H.container, { container: c }, {
        kindFilter: "container",
        classes: Object.keys(c.byType),
        haystack: norm(c.name + " " + c.items.map((x) => `${x.product} ${x.sku ?? ""}`).join(" ")),
      }));
    if (FIXTURE.regionalGroup) {
      push("regional", "regional", "finished", fi++, NODE_H.regional, { group: FIXTURE.regionalGroup }, {
        kindFilter: "container", classes: [],
        haystack: norm(FIXTURE.regionalGroup.name + " " + FIXTURE.regionalGroup.list.map((c) => c.name + " " + c.items.map((x) => `${x.product} ${x.sku ?? ""}`).join(" ")).join(" ")),
      });
    }
    if (showEmpty) {
      FIXTURE.emptyContainers.forEach((c) =>
        push(`c-${c.id}`, "container", "finished", fi++, NODE_H.container, { container: c }, {
          kindFilter: "container", classes: ["empty"], haystack: norm(c.name),
        }));
    }

    // gap note between RAW and DEPT (honest: no RECEIVE data)
    nodes.push({
      id: "gap-receive", type: "gap",
      position: { x: COL_X.raw + 312, y: offset("dept") + Math.max(0, (colHeights.dept - 96) / 2) },
      data: { title: "RECEIVE: 0 yozuv", sub: "Flow data mavjud emas" },
      draggable: false,
    });

    const edges: Edge[] = FIXTURE.edges.map((e) => {
      const st = EDGE_STYLE[e.kind] ?? { stroke: "#94a3b8" };
      const label = e.kind === "product-container"
        ? `${fmtKg(e.kg ?? 0)} kg${(e.dona ?? 0) > 0 ? ` / ${e.dona} dona` : ""}`
        : e.kind === "wip-product"
          ? `${fmtKg(e.kg ?? 0)} kg`
          : e.kind === "batch-product"
            ? `batch: ${fmtKg(e.kg ?? 0)} kg`
            : `${e.rows ?? 0} yozuv`;
      return {
        id: e.id, source: e.source, target: e.target, type: "smoothstep",
        label, labelStyle: { fontSize: 10, fill: "#475569" },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.85 },
        style: { stroke: st.stroke, strokeWidth: 1.8, strokeDasharray: st.dash },
        interactionWidth: 24,
      };
    });

    const adj = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      if (!adj.has(a)) adj.set(a, new Set());
      adj.get(a)!.add(b);
    };
    for (const e of FIXTURE.edges) { link(e.source, e.target); link(e.target, e.source); }

    const metaMap = new Map(meta.map((m) => [m.id, m]));
    return { baseNodes: nodes, baseEdges: edges, metaById: metaMap, adjacency: adj };
  }, [showEmpty]);

  // ---------- search / filter → highlight set ----------
  const visible = useMemo(() => {
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
    return result; // null = everything visible
  }, [query, active, metaById, adjacency]);

  const nodes = useMemo(() => baseNodes.map((n) => {
    if (n.type === "colLabel" || n.type === "gap") return n;
    const dimmed = visible != null && !visible.has(n.id);
    return { ...n, data: { ...n.data, dimmed } };
  }), [baseNodes, visible]);

  const edges = useMemo(() => baseEdges.map((e) => {
    const dim = visible != null && !(visible.has(e.source) && visible.has(e.target));
    return { ...e, style: { ...e.style, opacity: dim ? 0.12 : 1 }, labelStyle: { ...(e.labelStyle as object), opacity: dim ? 0.15 : 1 } as any };
  }), [baseEdges, visible]);

  const toggle = (k: FilterKey) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

  const onNodeClick = (_: any, node: Node) => {
    if (node.id.startsWith("c-")) setSel({ kind: "container", id: Number(node.id.slice(2)) });
    else if (node.id === "regional") setSel({ kind: "regional" });
    else if (node.id.startsWith("d-")) setSel({ kind: "dept", id: Number(node.id.slice(2)) });
    else if (node.id.startsWith("w-")) setSel({ kind: "wip", id: Number(node.id.slice(2)) });
    else if (node.id.startsWith("p-")) setSel({ kind: "product", key: node.id });
    else if (node.id === "gap-receive") setSel({ kind: "gap", code: "NO_RECEIVE_DATA" });
  };

  const negWip = FIXTURE.wip.find((w) => w.status === "NEGATIVE");

  return (
    <div className="flex h-screen w-full flex-col bg-zinc-100">
      {/* toolbar */}
      <div className="border-b bg-white px-4 py-2.5 shadow-sm">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-bold text-zinc-900">Production Flow</span>
            <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-700 text-[10px]">
              <ShieldCheck className="mr-1 h-3 w-3" /> READ-ONLY · {FIXTURE.generatedAt}
            </Badge>
          </div>
          <div className="relative min-w-[220px] flex-1 max-w-[340px]">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Qidiruv: nom, SKU, konteyner, bo'lim…"
              className="h-10 pl-8 pr-8 text-[13px]"
            />
            {query && (
              <button className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:text-zinc-600" onClick={() => setQuery("")}>
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => toggle(f.key)}
                className={`h-9 rounded-full border px-3 text-[12px] font-medium transition-colors ${
                  active.has(f.key)
                    ? "border-indigo-400 bg-indigo-600 text-white"
                    : "border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <label className="flex h-9 items-center gap-2 rounded-full border border-zinc-300 bg-white px-3 text-[12px] text-zinc-600">
            <Switch checked={showEmpty} onCheckedChange={setShowEmpty} />
            Bo'sh konteynerlar ({FIXTURE.emptyContainers.length})
          </label>
        </div>
        {/* honest gap chips */}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {FIXTURE.gaps.map((g) => (
            <button
              key={g.code}
              onClick={() => setSel({ kind: "gap", code: g.code })}
              className={`rounded-md border px-2 py-1 text-left text-[11px] leading-tight transition-colors ${
                g.code === "NEGATIVE_WIP"
                  ? "border-red-300 bg-red-50 text-red-700 hover:bg-red-100"
                  : "border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100"
              }`}
            >
              ⚠ {g.title}
            </button>
          ))}
          {negWip && (
            <span className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] text-zinc-500">
              Nofaol bo'limlar: {FIXTURE.inactiveDepartments.map((d) => d.name).join(", ") || "—"} (ko'rsatilmaydi)
            </span>
          )}
        </div>
      </div>

      {/* graph */}
      <div className="min-h-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes as any}
          onNodeClick={onNodeClick}
          onEdgeClick={(_, edge) => setSel({ kind: "edge", id: edge.id })}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          minZoom={0.25}
          maxZoom={1.8}
          nodesConnectable={false}
          proOptions={{ hideAttribution: false }}
        >
          <Background gap={24} color="#d4d4d8" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      <DetailSheet sel={sel} onClose={() => setSel(null)} />
    </div>
  );
}
