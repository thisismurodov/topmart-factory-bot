import { useState, useMemo } from "react";
import { authFetch } from "@/App";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatNumber } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import {
  RefreshCw, Plus, ArrowRight, X, Boxes, Factory, PackageCheck,
  AlertTriangle, Activity, Clock, Settings2, TrendingDown, TrendingUp,
  Truck, Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";

// ── Types ─────────────────────────────────────────────────────────────────────

type RawContainer = {
  id: number;
  name: string;
  capacityKg: number;
  totalKg: number;
  materialCount: number;
  todayIn: number;
  todayOut: number;
  items: { material: string; kg: number }[];
};

type Department = {
  id: number;
  name: string;
  workerCount: number;
  productCount: number;
  wipKg: number;
  todayReceived: number;
  todayProduced: number;
  completionPct: number;
  status: "working" | "idle" | "empty";
};

type FinishedContainer = {
  id: number;
  name: string;
  capacityKg: number;
  totalQty: number;
  totalKg: number;
  skuCount: number;
};

type AllContainer = { id: number; name: string; purpose: "raw" | "finished"; active: boolean };

type FlowHistory = {
  id: number;
  movementType: "RECEIVE" | "PRODUCE";
  rawMaterial: string | null;
  product: string | null;
  weightKg: number;
  lineName: string | null;
  fromWarehouse: string | null;
  note: string;
  createdBy: string;
  createdAt: string;
};

type FlowData = {
  rawContainers: RawContainer[];
  departments: Department[];
  finishedContainers: FinishedContainer[];
  allContainers: AllContainer[];
  history: FlowHistory[];
  kpis: {
    totalRawKg: number;
    totalWipKg: number;
    totalFinishedKg: number;
    todayReceived: number;
    todayProduced: number;
    departmentsWorking: number;
    todayRawConsumption: number;
    efficiency: number;
    rawContainerCount: number;
    departmentCount: number;
    finishedContainerCount: number;
  };
  alerts: { level: "danger" | "warn" | "info"; text: string }[];
};

type RawMaterial = { id: number; name: string; unit: string };

// ── Theme ─────────────────────────────────────────────────────────────────────

const C = {
  raw: "#3B82F6",
  dept: "#F97316",
  finished: "#A855F7",
  green: "#10B981",
  canvas: "#0B1220",
  panel: "#111c33",
  panelSoft: "#172441",
  border: "#23365e",
  text: "#E2E8F0",
  textDim: "#8aa0c6",
};

function kg(n: number): string {
  return `${formatNumber(Math.round(n))} kg`;
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useFlow() {
  return useQuery<FlowData>({
    queryKey: ["ombor-flow"],
    queryFn: () =>
      authFetch("/api/ombor/flow").then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Oqim ma'lumotini olishda xatolik");
        return r.json();
      }),
    refetchInterval: 8_000,
  });
}

function useRawMaterials() {
  return useQuery<RawMaterial[]>({
    queryKey: ["ombor-raw-materials"],
    queryFn: () => authFetch("/api/ombor/raw-materials").then((r) => r.json()),
  });
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function IshJarayoni() {
  const { data, isLoading, isError, error, refetch, isFetching } = useFlow();
  const [rawInOpen, setRawInOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  const kpis = data?.kpis;

  return (
    <div className="space-y-6">
      <FlowKeyframes />

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Activity className="w-6 h-6" style={{ color: C.green }} />
            Ish jarayoni
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Xom ashyo → bo'lim → tayyor mahsulot oqimini jonli kuzatish
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mr-1">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60" style={{ background: C.green }} />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5" style={{ background: C.green }} />
            </span>
            Jonli
          </span>
          <Button variant="outline" size="sm" onClick={() => setManageOpen(true)}>
            <Settings2 className="w-4 h-4 mr-1.5" /> Konteynerlar
          </Button>
          <Button variant="outline" size="sm" onClick={() => setReceiveOpen(true)}>
            <Truck className="w-4 h-4 mr-1.5" /> Bo'limga berish
          </Button>
          <Button size="sm" onClick={() => setRawInOpen(true)} style={{ background: C.green }}>
            <Plus className="w-4 h-4 mr-1.5" /> Xom ashyo kirimi
          </Button>
          <Button variant="ghost" size="icon" onClick={() => refetch()} title="Yangilash">
            <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Xom ashyo" value={kg(kpis?.totalRawKg ?? 0)} accent={C.raw} icon={Boxes} sub={`${kpis?.rawContainerCount ?? 0} konteyner`} />
        <KpiCard label="Jarayonda (WIP)" value={kg(kpis?.totalWipKg ?? 0)} accent={C.dept} icon={Factory} sub={`${kpis?.departmentCount ?? 0} bo'lim`} />
        <KpiCard label="Tayyor mahsulot" value={kg(kpis?.totalFinishedKg ?? 0)} accent={C.finished} icon={PackageCheck} sub={`${kpis?.finishedContainerCount ?? 0} konteyner`} />
        <KpiCard label="Faol bo'limlar" value={`${kpis?.departmentsWorking ?? 0}`} accent="#22c55e" icon={Activity} sub={`/ ${kpis?.departmentCount ?? 0} bo'lim`} />
        <KpiCard label="Bugun qabul" value={kg(kpis?.todayReceived ?? 0)} accent={C.green} icon={TrendingUp} sub="bo'limlarga" />
        <KpiCard label="Bugun ishlab chiqarish" value={kg(kpis?.todayProduced ?? 0)} accent="#06b6d4" icon={TrendingDown} sub="tayyor mahsulot" />
        <KpiCard label="Bugun xom sarfi" value={kg(kpis?.todayRawConsumption ?? 0)} accent={C.raw} icon={Truck} sub="konteynerlardan" />
        <KpiCard label="Samaradorlik" value={`${kpis?.efficiency ?? 0}%`} accent="#eab308" icon={Layers} sub="ishlab chiq. / qabul" />
      </div>

      {/* Alerts */}
      {data && data.alerts.length > 0 && (
        <div className="space-y-2">
          {data.alerts.map((a, i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm border"
              style={{
                background: a.level === "danger" ? "#fef2f2" : a.level === "warn" ? "#fffbeb" : "#eff6ff",
                borderColor: a.level === "danger" ? "#fecaca" : a.level === "warn" ? "#fde68a" : "#bfdbfe",
                color: a.level === "danger" ? "#991b1b" : a.level === "warn" ? "#92400e" : "#1e40af",
              }}
            >
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {a.text}
            </div>
          ))}
        </div>
      )}

      {/* Flow canvas */}
      <div
        className="rounded-2xl p-5 relative overflow-hidden"
        style={{ background: C.canvas, border: `1px solid ${C.border}` }}
      >
        <div className="flex items-center justify-between mb-4">
          <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: C.textDim }}>
            Jonli material oqimi
          </span>
          <span className="text-[10px] font-mono" style={{ color: C.textDim }}>
            {data ? `${data.departments.length} bo'lim · ${data.rawContainers.length} xom · ${data.finishedContainers.length} tayyor` : "..."}
          </span>
        </div>

        {isLoading ? (
          <div className="h-64 flex items-center justify-center text-sm" style={{ color: C.textDim }}>
            Yuklanmoqda...
          </div>
        ) : isError || !data ? (
          <div className="h-64 flex flex-col items-center justify-center gap-3 text-sm" style={{ color: C.textDim }}>
            <AlertTriangle className="w-7 h-7" style={{ color: "#ef4444" }} />
            <span>{error instanceof Error ? error.message : "Ma'lumotni yuklab bo'lmadi"}</span>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="w-4 h-4 mr-1.5" /> Qayta urinish
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1.2fr_auto_1fr] gap-3 items-stretch">
            {/* Column 1: raw */}
            <FlowColumn title="Xom ashyo omborlari" color={C.raw} icon={Boxes}>
              {data.rawContainers.length === 0 && <EmptyCol text="Konteyner 'xom ashyo' deb belgilanmagan" />}
              {data.rawContainers.map((rc) => (
                <NodeCard key={rc.id} color={C.raw}>
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-sm truncate" style={{ color: C.text }}>{rc.name}</span>
                    <span className="text-xs font-mono" style={{ color: C.raw }}>{kg(rc.totalKg)}</span>
                  </div>
                  <Bar pct={Math.min(100, (rc.totalKg / (rc.capacityKg || 20000)) * 100)} color={C.raw} />
                  <div className="flex gap-3 text-[11px] mt-1">
                    <span style={{ color: C.green }}>↓ {kg(rc.todayIn)}</span>
                    <span style={{ color: "#f59e0b" }}>↑ {kg(rc.todayOut)}</span>
                    <span className="ml-auto" style={{ color: C.textDim }}>qoldi {kg(rc.totalKg)}</span>
                  </div>
                  <div className="mt-1.5 space-y-0.5">
                    {rc.items.slice(0, 3).map((it) => (
                      <div key={it.material} className="flex justify-between text-[11px]" style={{ color: C.textDim }}>
                        <span className="truncate">{it.material}</span>
                        <span className="font-mono">{kg(it.kg)}</span>
                      </div>
                    ))}
                    {rc.items.length === 0 && <div className="text-[11px]" style={{ color: C.textDim }}>bo'sh</div>}
                    {rc.items.length > 3 && <div className="text-[10px]" style={{ color: C.textDim }}>+{rc.items.length - 3} ko'proq</div>}
                  </div>
                </NodeCard>
              ))}
            </FlowColumn>

            <Connector color={C.raw} />

            {/* Column 2: departments */}
            <FlowColumn title="Bo'limlar (WIP)" color={C.dept} icon={Factory}>
              {data.departments.length === 0 && <EmptyCol text="Bo'lim (liniya) yo'q" />}
              {data.departments.map((d) => (
                <NodeCard key={d.id} color={C.dept} active={d.status === "working"}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-sm truncate" style={{ color: C.text }}>{d.name}</span>
                    <StatusBadge status={d.status} />
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-[11px]" style={{ color: C.textDim }}>WIP</span>
                    <span
                      className="text-xs font-mono font-bold"
                      style={{ color: d.wipKg < 0 ? "#f87171" : C.dept }}
                    >
                      {kg(d.wipKg)}
                    </span>
                  </div>
                  <Bar pct={Math.min(100, Math.abs(d.wipKg) / 500 * 100)} color={d.wipKg < 0 ? "#f87171" : C.dept} />
                  <div className="flex justify-between items-center text-[11px] mt-1.5" style={{ color: C.textDim }}>
                    <span>{d.workerCount} ishchi · {d.productCount} mahsulot</span>
                    <span className="font-mono" style={{ color: C.green }}>{d.completionPct}%</span>
                  </div>
                  <div className="flex gap-3 text-[11px] mt-0.5">
                    <span style={{ color: C.green }}>↓ {kg(d.todayReceived)}</span>
                    <span style={{ color: "#06b6d4" }}>↑ {kg(d.todayProduced)}</span>
                  </div>
                </NodeCard>
              ))}
            </FlowColumn>

            <Connector color={C.finished} />

            {/* Column 3: finished */}
            <FlowColumn title="Tayyor mahsulot ombori" color={C.finished} icon={PackageCheck}>
              {data.finishedContainers.length === 0 && <EmptyCol text="Konteyner 'tayyor' deb belgilanmagan" />}
              {data.finishedContainers.map((fc) => (
                <NodeCard key={fc.id} color={C.finished}>
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-sm truncate" style={{ color: C.text }}>{fc.name}</span>
                    <span className="text-xs font-mono" style={{ color: C.finished }}>{kg(fc.totalKg)}</span>
                  </div>
                  <Bar pct={Math.min(100, (fc.totalKg / (fc.capacityKg || 20000)) * 100)} color={C.finished} />
                  <div className="flex justify-between text-[11px] mt-1.5" style={{ color: C.textDim }}>
                    <span>{fc.skuCount} tur</span>
                    <span className="font-mono">{formatNumber(fc.totalQty)} dona</span>
                  </div>
                </NodeCard>
              ))}
            </FlowColumn>
          </div>
        )}
      </div>

      {/* History timeline */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border">
          <Clock className="w-4 h-4 text-muted-foreground" />
          <span className="font-semibold text-sm text-foreground">So'nggi harakatlar</span>
        </div>
        <div className="divide-y divide-border max-h-96 overflow-y-auto">
          {data?.history.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-muted-foreground">Hozircha harakat yo'q</div>
          )}
          {data?.history.map((h) => (
            <HistoryRow key={h.id} h={h} />
          ))}
        </div>
      </div>

      {rawInOpen && <RawInModal containers={data?.allContainers ?? []} onClose={() => setRawInOpen(false)} />}
      {receiveOpen && <ReceiveModal flow={data} onClose={() => setReceiveOpen(false)} />}
      {manageOpen && <ManageContainersModal containers={data?.allContainers ?? []} onClose={() => setManageOpen(false)} />}
    </div>
  );
}

// ── Presentational ──────────────────────────────────────────────────────────────

function KpiCard({ label, value, accent, icon: Icon, sub }: {
  label: string; value: string; accent: string; icon: React.ElementType; sub: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 relative overflow-hidden">
      <div className="absolute top-0 left-0 w-1 h-full" style={{ background: accent }} />
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Icon className="w-4 h-4" style={{ color: accent }} />
      </div>
      <div className="text-xl font-bold mt-1 text-foreground tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>
    </div>
  );
}

function FlowColumn({ title, color, icon: Icon, children }: {
  title: string; color: string; icon: React.ElementType; children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 mb-2">
        <Icon className="w-4 h-4" style={{ color }} />
        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color }}>{title}</span>
      </div>
      <div className="flex-1 space-y-2.5">{children}</div>
    </div>
  );
}

function NodeCard({ color, active, children }: { color: string; active?: boolean; children: React.ReactNode }) {
  return (
    <div
      className="rounded-lg p-3 transition-all"
      style={{
        background: C.panel,
        border: `1px solid ${active ? color : C.border}`,
        boxShadow: active ? `0 0 0 1px ${color}40, 0 0 18px ${color}30` : "none",
      }}
    >
      {children}
    </div>
  );
}

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="mt-1.5 h-1.5 rounded-full overflow-hidden" style={{ background: C.panelSoft }}>
      <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(2, pct)}%`, background: color }} />
    </div>
  );
}

function StatusBadge({ status }: { status: "working" | "idle" | "empty" }) {
  const cfg = {
    working: { label: "ishlamoqda", color: "#22c55e" },
    idle: { label: "kutmoqda", color: "#f59e0b" },
    empty: { label: "bo'sh", color: C.textDim },
  }[status];
  return (
    <span
      className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0"
      style={{ background: `${cfg.color}22`, color: cfg.color }}
    >
      {status === "working" && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-70" style={{ background: cfg.color }} />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ background: cfg.color }} />
        </span>
      )}
      {cfg.label}
    </span>
  );
}

function Connector({ color }: { color: string }) {
  return (
    <div className="hidden lg:flex items-center justify-center w-14 relative">
      <div className="w-full h-0.5 relative" style={{ background: `${color}30` }}>
        <span className="flow-dot" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
        <span className="flow-dot flow-dot-2" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
      </div>
      <ArrowRight className="w-4 h-4 absolute -right-0.5" style={{ color }} />
    </div>
  );
}

function EmptyCol({ text }: { text: string }) {
  return (
    <div className="rounded-lg p-4 text-center text-[11px]" style={{ background: C.panel, border: `1px dashed ${C.border}`, color: C.textDim }}>
      {text}
    </div>
  );
}

function HistoryRow({ h }: { h: FlowHistory }) {
  const isReceive = h.movementType === "RECEIVE";
  const color = isReceive ? C.green : "#06b6d4";
  const label = isReceive ? h.rawMaterial : h.product;
  const time = new Date(h.createdAt).toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" });
  const dateStr = new Date(h.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  return (
    <div className="flex items-center gap-3 px-5 py-2.5">
      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${color}1a` }}>
        {isReceive ? <Truck className="w-4 h-4" style={{ color }} /> : <Layers className="w-4 h-4" style={{ color }} />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-foreground truncate">
          <span className="font-medium">{label || "—"}</span>
          <span className="text-muted-foreground"> · {h.lineName || "—"}</span>
        </div>
        <div className="text-[11px] text-muted-foreground truncate">
          {isReceive ? `${h.fromWarehouse || "ombor"} → bo'lim` : "bo'lim → tayyor"} · {h.createdBy}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-sm font-mono font-semibold" style={{ color }}>
          {isReceive ? "+" : "−"}{kg(h.weightKg)}
        </div>
        <div className="text-[10px] text-muted-foreground">{dateStr} {time}</div>
      </div>
    </div>
  );
}

// ── Modals ──────────────────────────────────────────────────────────────────────

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-card rounded-xl border border-border w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <h3 className="font-semibold text-foreground">{title}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 space-y-4">{children}</div>
      </div>
    </div>
  );
}

const fieldCls = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const labelCls = "block text-sm font-medium text-foreground mb-1";

function RawInModal({ containers, onClose }: { containers: AllContainer[]; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: materials } = useRawMaterials();
  const rawContainers = containers.filter((c) => c.purpose === "raw" && c.active);
  const [warehouseId, setWarehouseId] = useState<number | "">("");
  const [materialName, setMaterialName] = useState("");
  const [kgVal, setKgVal] = useState("");
  const [note, setNote] = useState("");

  const mut = useMutation({
    mutationFn: () =>
      authFetch("/api/ombor/flow/raw-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ warehouseId, materialName, kg: Number(kgVal), note }),
      }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error || "Xatolik"); return r.json(); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ombor-flow"] });
      toast({ title: "Xom ashyo kiritildi" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Xatolik", description: e.message, variant: "destructive" }),
  });

  const valid = warehouseId !== "" && materialName && Number(kgVal) > 0;

  return (
    <ModalShell title="Xom ashyo kirimi (konteynerga)" onClose={onClose}>
      {rawContainers.length === 0 && (
        <p className="text-sm text-amber-600">
          Avval bir konteynerni "xom ashyo" deb belgilang (Konteynerlar menyusi).
        </p>
      )}
      <div>
        <label className={labelCls}>Konteyner</label>
        <select className={fieldCls} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value ? Number(e.target.value) : "")}>
          <option value="">Tanlang...</option>
          {rawContainers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div>
        <label className={labelCls}>Xom ashyo</label>
        <select className={fieldCls} value={materialName} onChange={(e) => setMaterialName(e.target.value)}>
          <option value="">Tanlang...</option>
          {materials?.map((m) => <option key={m.id} value={m.name}>{m.name}</option>)}
        </select>
      </div>
      <div>
        <label className={labelCls}>Miqdor (kg)</label>
        <input className={fieldCls} type="number" min="0" step="any" value={kgVal} onChange={(e) => setKgVal(e.target.value)} placeholder="0" />
      </div>
      <div>
        <label className={labelCls}>Izoh (ixtiyoriy)</label>
        <input className={fieldCls} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <Button className="w-full" disabled={!valid || mut.isPending} onClick={() => mut.mutate()} style={{ background: C.green }}>
        {mut.isPending ? "Saqlanmoqda..." : "Kiritish"}
      </Button>
    </ModalShell>
  );
}

function ReceiveModal({ flow, onClose }: { flow: FlowData | undefined; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const rawContainers = flow?.rawContainers ?? [];
  const departments = flow?.departments ?? [];
  const [warehouseId, setWarehouseId] = useState<number | "">("");
  const [lineId, setLineId] = useState<number | "">("");
  const [materialName, setMaterialName] = useState("");
  const [kgVal, setKgVal] = useState("");
  const [note, setNote] = useState("");

  const selected = useMemo(() => rawContainers.find((c) => c.id === warehouseId), [rawContainers, warehouseId]);
  const available = selected?.items.find((it) => it.material === materialName)?.kg ?? 0;

  const mut = useMutation({
    mutationFn: () =>
      authFetch("/api/ombor/flow/receive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ warehouseId, lineId, materialName, kg: Number(kgVal), note }),
      }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error || "Xatolik"); return r.json(); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ombor-flow"] });
      toast({ title: "Bo'limga berildi" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Xatolik", description: e.message, variant: "destructive" }),
  });

  const valid = warehouseId !== "" && lineId !== "" && materialName && Number(kgVal) > 0 && Number(kgVal) <= available;

  return (
    <ModalShell title="Xom ashyoni bo'limga berish" onClose={onClose}>
      <div>
        <label className={labelCls}>Xom ashyo konteyneri</label>
        <select className={fieldCls} value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value ? Number(e.target.value) : ""); setMaterialName(""); }}>
          <option value="">Tanlang...</option>
          {rawContainers.map((c) => <option key={c.id} value={c.id}>{c.name} ({kg(c.totalKg)})</option>)}
        </select>
      </div>
      <div>
        <label className={labelCls}>Xom ashyo</label>
        <select className={fieldCls} value={materialName} onChange={(e) => setMaterialName(e.target.value)} disabled={!selected}>
          <option value="">Tanlang...</option>
          {selected?.items.map((it) => <option key={it.material} value={it.material}>{it.material} ({kg(it.kg)})</option>)}
        </select>
      </div>
      <div>
        <label className={labelCls}>Bo'lim (liniya)</label>
        <select className={fieldCls} value={lineId} onChange={(e) => setLineId(e.target.value ? Number(e.target.value) : "")}>
          <option value="">Tanlang...</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>
      <div>
        <label className={labelCls}>Miqdor (kg)</label>
        <input className={fieldCls} type="number" min="0" step="any" value={kgVal} onChange={(e) => setKgVal(e.target.value)} placeholder="0" />
        {materialName && <p className="text-[11px] text-muted-foreground mt-1">Mavjud: {kg(available)}</p>}
      </div>
      <div>
        <label className={labelCls}>Izoh (ixtiyoriy)</label>
        <input className={fieldCls} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <Button className="w-full" disabled={!valid || mut.isPending} onClick={() => mut.mutate()} style={{ background: C.dept }}>
        {mut.isPending ? "Saqlanmoqda..." : "Bo'limga berish"}
      </Button>
    </ModalShell>
  );
}

function ManageContainersModal({ containers, onClose }: { containers: AllContainer[]; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const mut = useMutation({
    mutationFn: (v: { warehouseId: number; purpose: "raw" | "finished" }) =>
      authFetch("/api/ombor/flow/container-purpose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(v),
      }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error || "Xatolik"); return r.json(); }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ombor-flow"] }),
    onError: (e: Error) => toast({ title: "Xatolik", description: e.message, variant: "destructive" }),
  });

  return (
    <ModalShell title="Konteynerlarni boshqarish" onClose={onClose}>
      <p className="text-sm text-muted-foreground">
        Har bir konteyner xom ashyo yoki tayyor mahsulot ombori bo'lishi mumkin.
      </p>
      <div className="space-y-2 max-h-80 overflow-y-auto">
        {containers.length === 0 && <p className="text-sm text-muted-foreground">Konteyner yo'q</p>}
        {containers.map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
            <span className="text-sm font-medium text-foreground truncate">{c.name}</span>
            <div className="flex rounded-md overflow-hidden border border-border shrink-0">
              {(["raw", "finished"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => c.purpose !== p && mut.mutate({ warehouseId: c.id, purpose: p })}
                  disabled={mut.isPending}
                  className="px-2.5 py-1 text-xs font-medium transition-colors"
                  style={{
                    background: c.purpose === p ? (p === "raw" ? C.raw : C.finished) : "transparent",
                    color: c.purpose === p ? "#fff" : "var(--muted-foreground)",
                  }}
                >
                  {p === "raw" ? "Xom ashyo" : "Tayyor"}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </ModalShell>
  );
}

// ── Animations ──────────────────────────────────────────────────────────────────

function FlowKeyframes() {
  return (
    <style>{`
      .flow-dot {
        position: absolute; top: 50%; left: 0;
        width: 6px; height: 6px; border-radius: 9999px;
        transform: translateY(-50%);
        animation: flowMove 2.2s linear infinite;
      }
      .flow-dot-2 { animation-delay: 1.1s; }
      @keyframes flowMove {
        0% { left: 0; opacity: 0; }
        15% { opacity: 1; }
        85% { opacity: 1; }
        100% { left: 100%; opacity: 0; }
      }
    `}</style>
  );
}
