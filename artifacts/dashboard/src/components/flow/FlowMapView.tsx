// Production Flow Map — asosiy ko'rinish (F1 vizual tili, real API ma'lumoti).
// 5 qatlam: RAW CONTAINER → DEPARTMENT → WIP → PRODUCT → FINISHED CONTAINER.
// Qoidalar: bog'lanishlar o'ylab topilmaydi, manfiy WIP yashirilmaydi,
// konteynerlar kontent bo'yicha klassifikatsiya qilinadi, DB'ga tegilmaydi.
import { useMemo, useState } from "react";
import {
  Background, Controls, ReactFlow,
  type Edge, type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { nodeTypes } from "./NodePieces";
import { DetailSheet } from "./Drawers";
import { FILTERS, buildScaffold, computeVisible, selectionForNodeId, type FilterKey } from "./model";
import type { FlowGraphResponse, Selection } from "./types";

interface Props {
  graph: FlowGraphResponse;
  onRefresh: () => void;
  refreshing: boolean;
}

export function FlowMapView({ graph, onRefresh, refreshing }: Props) {
  const [sel, setSel] = useState<Selection>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<Set<FilterKey>>(new Set());
  const [showEmpty, setShowEmpty] = useState(false);

  // statik skelet — API javobi yoki bo'sh-konteyner rejimi o'zgargandagina qayta quriladi
  const { baseNodes, baseEdges, metaById, adjacency } = useMemo(() => {
    const s = buildScaffold(graph, showEmpty);
    return { baseNodes: s.nodes, baseEdges: s.edges, metaById: s.metaById, adjacency: s.adjacency };
  }, [graph, showEmpty]);

  const visible = useMemo(
    () => computeVisible(query, active, metaById, adjacency),
    [query, active, metaById, adjacency],
  );

  const nodes = useMemo(() => baseNodes.map((n) => {
    if (n.type === "colLabel" || n.type === "gap") return n;
    const dimmed = visible != null && !visible.has(n.id);
    return { ...n, data: { ...n.data, dimmed } };
  }), [baseNodes, visible]);

  const edges = useMemo(() => baseEdges.map((e) => {
    const dim = visible != null && !(visible.has(e.source) && visible.has(e.target));
    return { ...e, style: { ...e.style, opacity: dim ? 0.12 : 1 }, labelStyle: { ...(e.labelStyle as object), opacity: dim ? 0.15 : 1 } as any };
  }), [baseEdges, visible]);

  // filtr/qidiruv hech narsa qoldirmadi (§18)
  const noMatch = visible != null && visible.size === 0;

  const toggle = (k: FilterKey) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

  const onNodeClick = (_: unknown, node: Node) => {
    const s = selectionForNodeId(node.id);
    if (s) setSel(s);
  };

  const N = graph.nodes;

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-zinc-100">
      {/* toolbar */}
      <div className="border-b bg-white px-4 py-2.5 shadow-sm">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-bold text-zinc-900">Production Flow</span>
            <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-700 text-[10px]">
              <ShieldCheck className="mr-1 h-3 w-3" /> READ-ONLY · {graph.generatedAt}
            </Badge>
          </div>
          <div className="relative min-w-[220px] flex-1 max-w-[340px]">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Qidiruv: nom, SKU, konteyner, bo'lim…"
              className="h-10 pl-8 pr-8 text-[13px]"
              data-testid="flow-search"
            />
            {query && (
              <button className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:text-zinc-600" onClick={() => setQuery("")} data-testid="flow-search-clear">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => toggle(f.key)}
                data-testid={`flow-filter-${f.key}`}
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
            <Switch checked={showEmpty} onCheckedChange={setShowEmpty} data-testid="flow-show-empty" />
            Bo'sh konteynerlar ({N.emptyContainers.length})
          </label>
          <button
            onClick={onRefresh}
            disabled={refreshing}
            data-testid="flow-refresh"
            className="flex h-9 items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3 text-[12px] font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Yangilash
          </button>
        </div>
        {/* halol bo'shliq chiplari */}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {graph.gaps.map((g) => (
            <button
              key={g.code}
              onClick={() => setSel({ kind: "gap", code: g.code })}
              data-testid={`flow-gap-${g.code}`}
              className={`rounded-md border px-2 py-1 text-left text-[11px] leading-tight transition-colors ${
                g.code === "NEGATIVE_WIP"
                  ? "border-red-300 bg-red-50 text-red-700 hover:bg-red-100"
                  : "border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100"
              }`}
            >
              ⚠ {g.title}
            </button>
          ))}
          {N.inactiveDepartments.length > 0 && (
            <span className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] text-zinc-500">
              Nofaol bo'limlar: {N.inactiveDepartments.map((d) => d.name).join(", ")} (ko'rsatilmaydi)
            </span>
          )}
        </div>
      </div>

      {/* graf */}
      <div className="relative flex-1 min-h-[360px] md:min-h-0" data-testid="flow-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes as any}
          onNodeClick={onNodeClick}
          onEdgeClick={(_, edge: Edge) => setSel({ kind: "edge", id: edge.id })}
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
        {noMatch && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center" data-testid="flow-no-match">
            <div className="rounded-lg border bg-white/95 px-4 py-3 text-[13px] text-zinc-600 shadow-md">
              Hech qanday ma'lumot topilmadi.
            </div>
          </div>
        )}
      </div>

      <DetailSheet graph={graph} sel={sel} onClose={() => setSel(null)} />
    </div>
  );
}
