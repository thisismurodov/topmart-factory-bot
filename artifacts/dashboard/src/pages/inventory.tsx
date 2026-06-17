import { useState } from "react";
import { authFetch } from "@/App";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatNumber, formatCurrency } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Package, Boxes, TrendingUp, AlertTriangle, Plus, ArrowDownToLine, ArrowUpFromLine, RefreshCw } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type Summary = {
  rawMaterialValueUzs: number;
  finishedGoodsValueUzs: number;
  totalValueUzs: number;
  rawMaterialCount: number;
  finishedGoodsSkuCount: number;
  lowStockRawCount: number;
  usdRate: number;
};

type RawMaterial = {
  id: number;
  name: string;
  unit: string;
  defaultCost: number;
  currency: string;
  uzsCostPerUnit: number;
  currentStock: number;
  minimumStock: number;
  totalValueUzs: number;
  avgDailyConsumption: number;
  daysRemaining: number | null;
};

type FinishedGood = {
  product: string;
  stockQty: number;
  unitType: string;
  salePrice: number;
  currency: string;
  priceUzs: number;
  totalValueUzs: number;
};

type Movement = {
  id: number;
  product: string;
  quantity: number;
  movementType: "IN" | "OUT" | "TRANSFER";
  productType: "raw" | "finished";
  fromWarehouse: string | null;
  toWarehouse: string | null;
  note: string;
  createdBy: string;
  createdAt: string;
};

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useSummary() {
  return useQuery<Summary>({
    queryKey: ["ombor-summary"],
    queryFn: () => authFetch("/api/ombor/summary").then((r) => r.json()),
    refetchInterval: 30_000,
  });
}
function useRawMaterials() {
  return useQuery<RawMaterial[]>({
    queryKey: ["ombor-raw-materials"],
    queryFn: () => authFetch("/api/ombor/raw-materials").then((r) => r.json()),
    refetchInterval: 60_000,
  });
}
function useFinishedGoods() {
  return useQuery<FinishedGood[]>({
    queryKey: ["ombor-finished-goods"],
    queryFn: () => authFetch("/api/ombor/finished-goods").then((r) => r.json()),
    refetchInterval: 30_000,
  });
}
function useMovements(type?: "raw" | "finished") {
  return useQuery<Movement[]>({
    queryKey: ["ombor-movements", type],
    queryFn: () => authFetch(`/api/ombor/movements?limit=40${type ? `&type=${type}` : ""}`).then((r) => r.json()),
    refetchInterval: 30_000,
  });
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Inventory() {
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<"raw" | "finished" | "movements">("raw");
  const [showRawIn, setShowRawIn] = useState(false);

  const { data: summary, isLoading: loadSummary } = useSummary();

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ["ombor-summary"] });
    qc.invalidateQueries({ queryKey: ["ombor-raw-materials"] });
    qc.invalidateQueries({ queryKey: ["ombor-finished-goods"] });
    qc.invalidateQueries({ queryKey: ["ombor-movements"] });
  };

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Ombor</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Xom ashyo · Tayyor mahsulot · Harakatlar
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={refreshAll}>
            <RefreshCw className="w-4 h-4 mr-1.5" /> Yangilash
          </Button>
          <Button size="sm" onClick={() => setShowRawIn(true)}>
            <Plus className="w-4 h-4 mr-1.5" /> Xom ashyo kirimi
          </Button>
        </div>
      </div>

      {/* ── KPI Row ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiCard
          icon={<Package className="w-5 h-5" />}
          label="Xom ashyo qiymati"
          value={loadSummary ? undefined : formatCurrency(summary?.rawMaterialValueUzs ?? 0)}
          sub={loadSummary ? undefined : `${summary?.rawMaterialCount ?? 0} ta material`}
          warn={(summary?.lowStockRawCount ?? 0) > 0}
          warnText={`${summary?.lowStockRawCount} ta kam qolgan`}
          loading={loadSummary}
        />
        <KpiCard
          icon={<Boxes className="w-5 h-5" />}
          label="Tayyor mahsulot qiymati"
          value={loadSummary ? undefined : formatCurrency(summary?.finishedGoodsValueUzs ?? 0)}
          sub={loadSummary ? undefined : `${summary?.finishedGoodsSkuCount ?? 0} ta SKU`}
          loading={loadSummary}
        />
        <KpiCard
          icon={<TrendingUp className="w-5 h-5" />}
          label="Jami aktiv"
          value={loadSummary ? undefined : formatCurrency(summary?.totalValueUzs ?? 0)}
          sub={loadSummary ? undefined : summary?.usdRate ? `1 USD = ${formatNumber(summary.usdRate)} so'm` : undefined}
          highlight
          loading={loadSummary}
        />
      </div>

      {/* ── Raw Material Receipt Modal ── */}
      {showRawIn && (
        <RawInForm onClose={() => { setShowRawIn(false); refreshAll(); }} />
      )}

      {/* ── Tabs ── */}
      <div className="flex gap-1 border-b">
        {(["raw", "finished", "movements"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === t
                ? "border-[#0B5D2A] text-[#0B5D2A]"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "raw" ? "Xom ashyo" : t === "finished" ? "Tayyor mahsulot" : "Harakatlar"}
          </button>
        ))}
      </div>

      {activeTab === "raw"      && <RawMaterialsTab />}
      {activeTab === "finished" && <FinishedGoodsTab />}
      {activeTab === "movements" && <MovementsTab />}
    </div>
  );
}

// ── Raw Materials Tab ─────────────────────────────────────────────────────────

function RawMaterialsTab() {
  const { data, isLoading } = useRawMaterials();
  const [search, setSearch] = useState("");

  const filtered = (data ?? []).filter((r) =>
    r.name.toLowerCase().includes(search.toLowerCase()),
  );

  const lowStock = (data ?? []).filter(
    (r) => r.minimumStock > 0 && r.currentStock <= r.minimumStock,
  );
  const criticalDays = (data ?? []).filter(
    (r) => r.daysRemaining !== null && r.daysRemaining <= 3,
  );
  const warnings = [...new Map([...lowStock, ...criticalDays].map((r) => [r.id, r])).values()];

  return (
    <div className="space-y-4">
      {/* ── Low stock alerts ── */}
      {warnings.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4">
          <div className="flex items-center gap-2 mb-3 text-red-700 font-semibold text-sm">
            <AlertTriangle className="w-4 h-4" /> Kam qolgan xom ashyolar
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {warnings.map((r) => (
              <div key={r.id} className="flex items-center justify-between bg-white rounded-lg border border-red-100 px-3 py-2">
                <span className="text-sm font-medium text-red-800 truncate mr-2">{r.name}</span>
                <div className="flex flex-col items-end shrink-0">
                  <span className="text-xs font-bold text-red-600">
                    {formatNumber(r.currentStock)} {r.unit}
                  </span>
                  {r.daysRemaining !== null && (
                    <span className="text-xs text-red-500">{r.daysRemaining} kun</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Search ── */}
      <div className="relative">
        <Input
          placeholder="Xom ashyo qidirish..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pr-4"
        />
      </div>

      {/* ── Table ── */}
      <Card className="border-border">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Nomi</th>
                  <th className="text-right px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Qoldiq</th>
                  <th className="text-right px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Minimal</th>
                  <th className="text-right px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Narx/birlik</th>
                  <th className="text-right px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Jami qiymat</th>
                  <th className="text-right px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Kunlar</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoading ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 6 }).map((__, j) => (
                        <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                      ))}
                    </tr>
                  ))
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-10 text-muted-foreground text-sm">
                      {search ? "Topilmadi" : "Xom ashyo yo'q"}
                    </td>
                  </tr>
                ) : (
                  filtered.map((r) => {
                    const isLow = r.minimumStock > 0 && r.currentStock <= r.minimumStock;
                    const isCritical = r.daysRemaining !== null && r.daysRemaining <= 3;
                    const isWarn = r.daysRemaining !== null && r.daysRemaining <= 7 && !isCritical;
                    return (
                      <tr key={r.id} className={`hover:bg-muted/30 transition-colors ${isLow || isCritical ? "bg-red-50/50" : ""}`}>
                        <td className="px-4 py-3 font-medium">{r.name}</td>
                        <td className="px-4 py-3 text-right font-mono">
                          <span className={isLow ? "text-red-600 font-bold" : ""}>
                            {formatNumber(r.currentStock)} {r.unit}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-muted-foreground text-xs">
                          {r.minimumStock > 0 ? `${formatNumber(r.minimumStock)} ${r.unit}` : "—"}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs">
                          {r.currency === "USD"
                            ? `$${r.defaultCost.toFixed(2)} (${formatCurrency(r.uzsCostPerUnit)})`
                            : formatCurrency(r.uzsCostPerUnit)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-semibold text-xs">
                          {formatCurrency(r.totalValueUzs)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {r.daysRemaining === null ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : (
                            <Badge
                              variant="outline"
                              className={`text-xs font-bold ${
                                isCritical
                                  ? "border-red-300 bg-red-100 text-red-700"
                                  : isWarn
                                  ? "border-yellow-300 bg-yellow-100 text-yellow-700"
                                  : "border-green-300 bg-green-100 text-green-700"
                              }`}
                            >
                              {r.daysRemaining} kun
                            </Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
              {!isLoading && filtered.length > 0 && (
                <tfoot>
                  <tr className="border-t bg-muted/30">
                    <td className="px-4 py-2.5 text-xs font-bold text-muted-foreground" colSpan={4}>Jami</td>
                    <td className="px-4 py-2.5 text-right font-mono font-bold text-xs">
                      {formatCurrency(filtered.reduce((s, r) => s + r.totalValueUzs, 0))}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Finished Goods Tab ────────────────────────────────────────────────────────

function FinishedGoodsTab() {
  const { data, isLoading } = useFinishedGoods();
  const [search, setSearch] = useState("");

  const filtered = (data ?? []).filter((r) =>
    r.product.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-4">
      <div className="relative">
        <Input
          placeholder="Mahsulot qidirish..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <Card className="border-border">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Mahsulot</th>
                  <th className="text-right px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Qoldiq</th>
                  <th className="text-right px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Narx/dona</th>
                  <th className="text-right px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Jami qiymat</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 4 }).map((__, j) => (
                        <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                      ))}
                    </tr>
                  ))
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-center py-10 text-muted-foreground text-sm">
                      {search ? "Topilmadi" : "Tayyor mahsulot ombori bo'sh"}
                    </td>
                  </tr>
                ) : (
                  filtered.map((r) => (
                    <tr key={r.product} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 font-medium">{r.product}</td>
                      <td className="px-4 py-3 text-right font-mono font-semibold">
                        {formatNumber(r.stockQty)} {r.unitType}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                        {r.currency === "USD"
                          ? `$${r.salePrice.toFixed(2)}`
                          : formatCurrency(r.salePrice)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-semibold text-xs">
                        {formatCurrency(r.totalValueUzs)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {!isLoading && filtered.length > 0 && (
                <tfoot>
                  <tr className="border-t bg-muted/30">
                    <td className="px-4 py-2.5 text-xs font-bold text-muted-foreground" colSpan={3}>Jami</td>
                    <td className="px-4 py-2.5 text-right font-mono font-bold text-xs">
                      {formatCurrency(filtered.reduce((s, r) => s + r.totalValueUzs, 0))}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Movements Tab ─────────────────────────────────────────────────────────────

function MovementsTab() {
  const { data, isLoading } = useMovements();

  return (
    <Card className="border-border">
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Tur</th>
                <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Tovar</th>
                <th className="text-right px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Miqdor</th>
                <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Yo'nalish</th>
                <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Izoh</th>
                <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Vaqt</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 6 }).map((__, j) => (
                      <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                    ))}
                  </tr>
                ))
              ) : !data?.length ? (
                <tr>
                  <td colSpan={6} className="text-center py-10 text-muted-foreground text-sm">
                    Hali harakat yo'q
                  </td>
                </tr>
              ) : (
                data.map((m) => <MovementRow key={m.id} m={m} />)
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Raw In Form ───────────────────────────────────────────────────────────────

function RawInForm({ onClose }: { onClose: () => void }) {
  const { data: materials } = useRawMaterials();
  const [materialId, setMaterialId] = useState<number | "">("");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const sel = materials?.find((m) => m.id === materialId);

  const mutation = useMutation({
    mutationFn: () =>
      authFetch("/api/ombor/raw-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          materialId: Number(materialId),
          qty: Number(qty),
          note,
        }),
      }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error);
        return r.json();
      }),
    onSuccess: () => onClose(),
    onError: (e: any) => setError(e.message),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <ArrowDownToLine className="w-4 h-4 text-[#0B5D2A]" /> Xom ashyo kirimi
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Xom ashyo
            </label>
            <select
              className="w-full border border-input rounded-md px-3 py-2 text-sm bg-background"
              value={materialId}
              onChange={(e) => setMaterialId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">Tanlang...</option>
              {(materials ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({formatNumber(m.currentStock)} {m.unit} bor)
                </option>
              ))}
            </select>
          </div>

          {sel && (
            <div className="text-xs text-muted-foreground bg-muted/40 rounded-lg px-3 py-2">
              Hozirgi zahira: <span className="font-semibold">{formatNumber(sel.currentStock)} {sel.unit}</span>
              {" · "}Narx: <span className="font-semibold">
                {sel.currency === "USD" ? `$${sel.defaultCost.toFixed(2)}` : formatCurrency(sel.uzsCostPerUnit)}/{sel.unit}
              </span>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Miqdor ({sel?.unit ?? "birlik"})
            </label>
            <Input
              type="number"
              min={0.001}
              step="any"
              placeholder="masalan: 5000"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Izoh (ixtiyoriy)
            </label>
            <Input
              placeholder="masalan: Konteyner №3"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          <div className="flex gap-2 pt-2">
            <Button
              className="flex-1"
              disabled={!materialId || !qty || Number(qty) <= 0 || mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? "Saqlanmoqda..." : "Qabul qilish"}
            </Button>
            <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
              Bekor
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function KpiCard({
  icon, label, value, sub, warn, warnText, highlight, loading,
}: {
  icon: React.ReactNode;
  label: string;
  value?: string;
  sub?: string;
  warn?: boolean;
  warnText?: string;
  highlight?: boolean;
  loading?: boolean;
}) {
  return (
    <Card className={`border-border ${highlight ? "bg-[#0B5D2A]/5 border-[#0B5D2A]/20" : warn ? "bg-red-50 border-red-200" : ""}`}>
      <CardContent className="p-5">
        <div className={`flex items-center gap-2 text-xs font-bold uppercase tracking-wider mb-2 ${highlight ? "text-[#0B5D2A]" : warn ? "text-red-600" : "text-muted-foreground"}`}>
          {icon} {label}
        </div>
        {loading ? (
          <Skeleton className="h-7 w-32 mb-1" />
        ) : (
          <div className={`text-2xl font-bold ${highlight ? "text-[#0B5D2A]" : warn ? "text-red-600" : ""}`}>
            {value ?? "—"}
          </div>
        )}
        {!loading && (sub || warnText) && (
          <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
            {warnText && <span className="text-red-500 font-semibold">⚠ {warnText}</span>}
            {sub && <span>{sub}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MovementRow({ m }: { m: Movement }) {
  const typeConfig = {
    IN: { label: "Kirim", bg: "bg-green-100 text-green-700", icon: <ArrowDownToLine className="w-3 h-3" /> },
    OUT: { label: "Chiqim", bg: "bg-red-100 text-red-700", icon: <ArrowUpFromLine className="w-3 h-3" /> },
    TRANSFER: { label: "O'tkazma", bg: "bg-blue-100 text-blue-700", icon: <RefreshCw className="w-3 h-3" /> },
  }[m.movementType] ?? { label: m.movementType, bg: "bg-muted text-muted-foreground", icon: null };

  const direction =
    m.movementType === "IN"
      ? `→ ${m.toWarehouse ?? "Ombor"}`
      : m.movementType === "OUT"
      ? `← ${m.fromWarehouse ?? "Ombor"}`
      : `${m.fromWarehouse ?? "?"} → ${m.toWarehouse ?? "?"}`;

  const date = new Date(m.createdAt);
  const timeStr =
    date.toLocaleDateString("uz-UZ", { day: "2-digit", month: "2-digit" }) +
    " " +
    date.toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" });

  const isRaw = m.productType === "raw";

  return (
    <tr className="hover:bg-muted/30 transition-colors">
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${typeConfig.bg}`}>
            {typeConfig.icon} {typeConfig.label}
          </span>
          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${isRaw ? "bg-orange-100 text-orange-700" : "bg-blue-100 text-blue-700"}`}>
            {isRaw ? "Xom" : "Tayyor"}
          </span>
        </div>
      </td>
      <td className="px-4 py-2.5 font-medium text-sm max-w-[180px] truncate">{m.product}</td>
      <td className="px-4 py-2.5 text-right font-mono font-semibold">{formatNumber(m.quantity)}</td>
      <td className="px-4 py-2.5 text-muted-foreground text-xs">{direction}</td>
      <td className="px-4 py-2.5 text-muted-foreground text-xs max-w-[160px] truncate">{m.note || "—"}</td>
      <td className="px-4 py-2.5 text-muted-foreground text-xs font-mono">{timeStr}</td>
    </tr>
  );
}
