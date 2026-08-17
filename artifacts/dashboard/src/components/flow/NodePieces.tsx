// Production Flow Map — maxsus React Flow node komponentlari (F1 vizual tili).
import { Handle, Position } from "@xyflow/react";
import {
  AlertTriangle, Boxes, Factory, Package, Users, Warehouse, Layers, Ban,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  CLASS_BADGE, CLASS_LABEL, fmtInt, fmtKg,
  type ContainerData, type DeptData, type ProductData, type WipData,
} from "./types";

const H = () => (
  <>
    <Handle type="target" position={Position.Left} className="!h-2 !w-2 !opacity-0" />
    <Handle type="source" position={Position.Right} className="!h-2 !w-2 !opacity-0" />
  </>
);

const card =
  "rounded-xl border bg-white shadow-sm px-3.5 py-3 w-[300px] text-left transition-opacity";

export function ContainerNode({ id, data }: any) {
  const c: ContainerData = data.container;
  const dim = data.dimmed ? "opacity-25" : "";
  return (
    <div className={`${card} ${dim} ${c.derived === "empty" ? "border-dashed" : ""}`} data-testid={`flow-node-${id}`}>
      <H />
      <div className="flex items-center gap-2">
        <Warehouse className="h-4 w-4 shrink-0 text-zinc-500" />
        <span className="font-semibold text-[15px] text-zinc-900 truncate">{c.name}</span>
        {c.mismatch && (
          <span title="purpose ≠ kontent">
            <AlertTriangle className="h-4 w-4 shrink-0 text-orange-500" />
          </span>
        )}
      </div>
      {c.loc && <div className="mt-0.5 text-[11px] text-zinc-500 truncate">{c.loc}</div>}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className={`${CLASS_BADGE[c.derived] ?? CLASS_BADGE.unclassified} text-[10px] px-1.5`}>
          {CLASS_LABEL[c.derived] ?? c.derived}
        </Badge>
        {c.mismatch && (
          <Badge variant="outline" className="bg-orange-50 text-orange-700 border-orange-300 text-[10px] px-1.5">
            purpose: {c.purpose}
          </Badge>
        )}
      </div>
      <div className="mt-2 text-[12px] text-zinc-600 tabular-nums">
        {fmtKg(c.kg)} kg · {fmtInt(c.dona)} dona · {c.positionsCount} pozitsiya
      </div>
    </div>
  );
}

export function RegionalNode({ id, data }: any) {
  const g = data.group;
  const dim = data.dimmed ? "opacity-25" : "";
  return (
    <div className={`${card} ${dim} bg-zinc-50`} data-testid={`flow-node-${id}`}>
      <H />
      <div className="flex items-center gap-2">
        <Boxes className="h-4 w-4 text-zinc-500" />
        <span className="font-semibold text-[15px] text-zinc-900">{g.name}</span>
      </div>
      <div className="mt-1.5">
        <Badge variant="outline" className="bg-zinc-100 text-zinc-700 border-zinc-300 text-[10px] px-1.5">
          {g.count} ta ombor · agregat
        </Badge>
      </div>
      <div className="mt-2 text-[12px] text-zinc-600 tabular-nums">
        {fmtKg(g.kg)} kg · {fmtInt(g.dona)} dona
      </div>
    </div>
  );
}

export function DeptNode({ id, data }: any) {
  const d: DeptData = data.dept;
  const dim = data.dimmed ? "opacity-25" : "";
  const workerCount = d.workers.length;
  return (
    <div className={`${card} ${dim} border-indigo-200 bg-indigo-50/60`} data-testid={`flow-node-${id}`}>
      <H />
      <div className="flex items-center gap-2">
        <Factory className="h-4 w-4 shrink-0 text-indigo-600" />
        <span className="font-semibold text-[15px] text-zinc-900 truncate">{d.name}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <Badge variant="outline" className="bg-white text-indigo-700 border-indigo-300 text-[10px] px-1.5">
          <Users className="h-3 w-3 mr-1" /> {workerCount} ishchi
        </Badge>
        <Badge variant="outline" className="bg-white text-indigo-700 border-indigo-300 text-[10px] px-1.5">
          {d.roles.length} rol
        </Badge>
        {workerCount === 0 && (
          <Badge variant="outline" className="bg-zinc-100 text-zinc-500 border-zinc-300 text-[10px] px-1.5">
            ishchi biriktirilmagan
          </Badge>
        )}
      </div>
      <div className="mt-2 text-[12px] text-zinc-600 tabular-nums">
        Oylik yozuvlari: {d.salary.entries} ta{d.salary.lastDate ? ` · oxirgi: ${d.salary.lastDate}` : ""}
      </div>
    </div>
  );
}

export function WipNode({ id, data }: any) {
  const w: WipData = data.wip;
  const dim = data.dimmed ? "opacity-25" : "";
  const neg = w.status === "NEGATIVE";
  const noLedger = w.status === "NO_LEDGER";
  return (
    <div
      className={`${card} ${dim} w-[260px] ${
        neg ? "border-red-400 bg-red-50" : noLedger ? "border-dashed border-zinc-300 bg-zinc-50" : "border-emerald-300 bg-emerald-50"
      }`}
      data-testid={`flow-node-${id}`}
    >
      <H />
      <div className="flex items-center gap-2">
        <Layers className={`h-4 w-4 ${neg ? "text-red-600" : "text-zinc-500"}`} />
        <span className="font-semibold text-[14px] text-zinc-900">WIP · {w.lineName}</span>
      </div>
      {noLedger ? (
        <div className="mt-2 flex items-center gap-1.5 text-[12px] text-zinc-500">
          <Ban className="h-3.5 w-3.5" /> Ledger yozuvi yo'q (0 ta)
        </div>
      ) : (
        <>
          <div className={`mt-1.5 text-[19px] font-bold tabular-nums ${neg ? "text-red-600" : "text-emerald-700"}`}>
            {fmtKg(w.balanceKg)} kg
          </div>
          {neg && (
            <div className="mt-0.5 flex items-center gap-1 text-[11px] font-semibold text-red-600">
              <AlertTriangle className="h-3.5 w-3.5" /> MANFIY — kirim yozilmagan
            </div>
          )}
          <div className="mt-1.5 text-[11px] text-zinc-600 tabular-nums">
            RECEIVE: {fmtKg(w.receiveKg)} kg · PRODUCE: {fmtKg(w.produceKg)} kg · {w.rows} yozuv
          </div>
        </>
      )}
    </div>
  );
}

export function ProductNode({ id, data }: any) {
  const p: ProductData = data.product;
  const dim = data.dimmed ? "opacity-25" : "";
  const stockKg = p.placements.reduce((s, x) => s + x.kg, 0);
  const stockDona = p.placements.reduce((s, x) => s + x.qty, 0);
  return (
    <div className={`${card} ${dim}`} data-testid={`flow-node-${id}`}>
      <H />
      <div className="flex items-center gap-2">
        <Package className="h-4 w-4 shrink-0 text-teal-600" />
        <span className="font-semibold text-[14px] text-zinc-900 truncate">{p.name}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {p.sku ? (
          <Badge variant="outline" className="bg-teal-50 text-teal-700 border-teal-300 text-[10px] px-1.5 font-mono">
            {p.sku}
          </Badge>
        ) : (
          <Badge variant="outline" className="bg-zinc-100 text-zinc-500 border-zinc-300 text-[10px] px-1.5">
            SKU biriktirilmagan
          </Badge>
        )}
      </div>
      <div className="mt-2 text-[12px] text-zinc-600 tabular-nums">
        {p.producedKg > 0 && <>WIP chiqim: {fmtKg(p.producedKg)} kg<br /></>}
        {p.batchKg > 0 || p.batchDona > 0 ? <>Partiyalar: {fmtKg(p.batchKg)} kg / {fmtInt(p.batchDona)} dona<br /></> : null}
        Omborda: {fmtKg(stockKg)} kg / {fmtInt(stockDona)} dona
        {p.placements.length === 0 && <span className="text-orange-600"> — joylashuv topilmadi</span>}
      </div>
    </div>
  );
}

export function ColLabelNode({ data }: any) {
  return (
    <div className="w-[300px] select-none text-center">
      <div className="text-[13px] font-bold uppercase tracking-widest text-zinc-500">{data.label}</div>
      <div className="text-[11px] text-zinc-400">{data.sub}</div>
    </div>
  );
}

export function GapNode({ data }: any) {
  return (
    <div className="w-[150px] rounded-lg border-2 border-dashed border-orange-300 bg-orange-50/90 px-2.5 py-2 text-center" data-testid="flow-node-gap-receive">
      <H />
      <AlertTriangle className="mx-auto h-4 w-4 text-orange-500" />
      <div className="mt-1 text-[11px] font-semibold leading-tight text-orange-700">{data.title}</div>
      <div className="mt-0.5 text-[10px] leading-tight text-orange-600">{data.sub}</div>
    </div>
  );
}

export const nodeTypes = {
  container: ContainerNode,
  regional: RegionalNode,
  dept: DeptNode,
  wip: WipNode,
  product: ProductNode,
  colLabel: ColLabelNode,
  gap: GapNode,
};
