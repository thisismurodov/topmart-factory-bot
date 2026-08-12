import { authFetch } from "@/App";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import {
  TrendingUp, Package, Banknote, Users, ShoppingBag, Award, BarChart2,
  DollarSign, TrendingDown, Download,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ── Types ─────────────────────────────────────────────────────────────────────
type SalesMonth = {
  month: string; salesUsd: number; salesUzs: number;
  paidUsd: number; paidUzs: number; debtUsd: number; debtUzs: number;
  saleCount: number; paidCount: number; pendingCount: number;
};
type ProdMonth = { month: string; batchCount: number; totalWeight: number; totalEarnings: number; workerCount: number };
type SalaryMonth = { month: string; totalPaid: number; workerCount: number };
type TopCustomer = { customerName: string; totalUsd: number; totalUzs: number; saleCount: number };
type TopWorker = { worker: string; totalEarnings: number; batchCount: number; totalWeight: number };
type TopProduct = { product: string; batchCount: number; totalWeight: number; totalEarnings: number };
type ProductProfitRow = {
  name: string; sku: string; unitType: string; currencyType: string;
  salePrice: number; rawMaterialCost: number; salaryCost: number;
  electricityCost: number; otherCost: number; totalCost: number;
  profit: number; marginPct: number; revenueUzs: number; revenueUsd: number; unitsSold: number;
};
type ReportData = {
  months: number;
  salesByMonth: SalesMonth[];
  productionByMonth: ProdMonth[];
  salaryByMonth: SalaryMonth[];
  topCustomers: TopCustomer[];
  topWorkers: TopWorker[];
  topProducts: TopProduct[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const UZ_MONTHS: Record<string, string> = {
  "01": "Yan", "02": "Fev", "03": "Mar", "04": "Apr",
  "05": "May", "06": "Iyn", "07": "Iyl", "08": "Avg",
  "09": "Sen", "10": "Okt", "11": "Noy", "12": "Dek",
};
function shortMonth(ym: string) {
  const [, m] = ym.split("-");
  return UZ_MONTHS[m] ?? ym;
}
function fmtUsd(v: number) {
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
function fmtUzs(v: number) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M so'm`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(0)}K so'm`;
  return `${v} so'm`;
}
function fmtKg(v: number) {
  return v >= 1000 ? `${(v / 1000).toFixed(1)} t` : `${v} kg`;
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color = "default" }: {
  label: string; value: string; sub?: string; color?: "green" | "amber" | "blue" | "default";
}) {
  const bg = { green: "bg-green-50 border-green-200", amber: "bg-amber-50 border-amber-200", blue: "bg-blue-50 border-blue-200", default: "bg-muted/40" }[color];
  const txt = { green: "text-green-800", amber: "text-amber-800", blue: "text-blue-800", default: "" }[color];
  return (
    <div className={`rounded-xl border p-4 ${bg}`}>
      <p className={`text-xs font-medium text-muted-foreground mb-1`}>{label}</p>
      <p className={`text-xl font-bold ${txt}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Custom tooltip ────────────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label, formatter }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-card shadow-md px-3 py-2 text-xs space-y-1">
      <p className="font-semibold">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span style={{ color: p.color }}>●</span>
          <span>{p.name}: <strong>{formatter ? formatter(p.value) : p.value}</strong></span>
        </div>
      ))}
    </div>
  );
}

// ── Period selector ───────────────────────────────────────────────────────────
function PeriodBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
        active ? "bg-primary text-primary-foreground" : "bg-muted/50 text-muted-foreground hover:bg-muted"
      }`}
    >
      {label}
    </button>
  );
}

// ── Export helpers ────────────────────────────────────────────────────────────
function ExportSection() {
  const { toast } = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo]     = useState(today);
  const [loading, setLoading] = useState(false);

  async function doExport(fmt: "csv" | "xlsx") {
    setLoading(true);
    try {
      const params = new URLSearchParams({ from, to, format: fmt });
      const res = await authFetch(`/api/reports/sales-export?${params}`);
      if (!res.ok) throw new Error("Serverdan xato keldi");
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `savdolar-${from}-${to}.${fmt}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      toast({ variant: "destructive", description: (e as Error).message ?? "Xato" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border bg-card p-5 flex flex-wrap items-end gap-4">
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide">Savdo eksporti</p>
        <div className="flex gap-3 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Dan</label>
            <input
              type="date" value={from} onChange={e => setFrom(e.target.value)}
              className="h-9 px-3 rounded-md border bg-background text-sm w-36"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Gacha</label>
            <input
              type="date" value={to} onChange={e => setTo(e.target.value)}
              className="h-9 px-3 rounded-md border bg-background text-sm w-36"
            />
          </div>
        </div>
      </div>
      <div className="flex gap-2 pb-0.5">
        <button
          disabled={loading}
          onClick={() => doExport("csv")}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-md border bg-muted text-sm font-medium hover:bg-muted/80 disabled:opacity-50"
        >
          <Download className="w-4 h-4" /> CSV
        </button>
        <button
          disabled={loading}
          onClick={() => doExport("xlsx")}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          <Download className="w-4 h-4" /> Excel
        </button>
        <button
          onClick={() => {
            const params = new URLSearchParams({ from, to });
            window.open(`/api/reports/sales-pdf?${params}`, "_blank");
          }}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-md border border-red-200 bg-red-50 text-red-700 text-sm font-medium hover:bg-red-100"
        >
          <Download className="w-4 h-4" /> PDF
        </button>
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function Reports() {
  const [months, setMonths] = useState(6);
  const [sortBy, setSortBy] = useState<"profit" | "margin" | "low_margin" | "sold" | "revenue">("profit");
  const [pieProduct, setPieProduct] = useState<string>("__avg__");

  const { data: profitRows = [], isLoading: profitLoading } = useQuery<ProductProfitRow[]>({
    queryKey: ["product-profitability", sortBy],
    queryFn: async () => {
      const res = await authFetch(`/api/reports/product-profitability?sortBy=${sortBy}`);
      if (!res.ok) throw new Error("Yuklashda xato");
      return res.json();
    },
  });

  const { data: profitTrend = [] } = useQuery<{ month: string; profitUzs: number; saleCount: number }[]>({
    queryKey: ["profit-trend", months],
    queryFn: async () => {
      const res = await authFetch(`/api/reports/profit-trend?months=${months}`);
      if (!res.ok) throw new Error("Yuklashda xato");
      return res.json();
    },
  });

  const { data, isLoading } = useQuery<ReportData>({
    queryKey: ["reports", months],
    queryFn: () => customFetch(`/api/reports/summary?months=${months}`),
  });

  const { data: rateData } = useQuery<{ rate: number; date: string; source: string }>({
    queryKey: ["exchange-rate"],
    queryFn: async () => {
      const r = await authFetch("/api/exchange-rate");
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    staleTime: 30 * 60 * 1000,
  });

  // Derived: fill missing months with zeros
  const allMonths: string[] = [];
  {
    const now = new Date();
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      allMonths.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
  }

  function fillMonths<T extends { month: string }>(rows: T[], empty: Omit<T, "month">): (T & { label: string })[] {
    const map = new Map(rows.map((r) => [r.month, r]));
    return allMonths.map((m) => ({ month: m, label: shortMonth(m), ...empty, ...map.get(m) } as T & { label: string }));
  }

  const salesData = fillMonths(data?.salesByMonth ?? [], {
    salesUsd: 0, salesUzs: 0, paidUsd: 0, paidUzs: 0, debtUsd: 0, debtUzs: 0,
    saleCount: 0, paidCount: 0, pendingCount: 0,
  });
  const prodData = fillMonths(data?.productionByMonth ?? [], {
    batchCount: 0, totalWeight: 0, totalEarnings: 0, workerCount: 0,
  });

  // Salary: match by YYYY-MM key
  const salaryFilled = fillMonths(data?.salaryByMonth ?? [], { totalPaid: 0, workerCount: 0 });

  // Totals
  const totalSalesUsd  = salesData.reduce((s, r) => s + r.salesUsd, 0);
  const totalSalesUzs  = salesData.reduce((s, r) => s + r.salesUzs, 0);
  const totalBatches   = prodData.reduce((s, r) => s + r.batchCount, 0);
  const totalWeight    = prodData.reduce((s, r) => s + r.totalWeight, 0);
  const totalEarnings  = prodData.reduce((s, r) => s + r.totalEarnings, 0);
  const totalSalary    = salaryFilled.reduce((s, r) => s + r.totalPaid, 0);

  // ── Product profitability charts (#8) ──────────────────────────────────────
  // Cost structure pie: per-product breakdown (selected via dropdown), or the
  // average share across products. Per-product shows real UZS values; average
  // uses per-product shares to stay currency-agnostic (USD/UZS mix).
  const costStructure = (() => {
    const mk = (raw: number, salary: number, elec: number, other: number) => {
      const total = raw + salary + elec + other;
      if (total <= 0) return [] as { name: string; value: number; amount?: number; fill: string }[];
      return [
        { name: "Xom ashyo", value: Math.round((raw    / total) * 1000) / 10, amount: raw,    fill: "#0B5D2A" },
        { name: "Ish haqi",  value: Math.round((salary / total) * 1000) / 10, amount: salary, fill: "#22c55e" },
        { name: "Elektr",    value: Math.round((elec   / total) * 1000) / 10, amount: elec,   fill: "#f59e0b" },
        { name: "Boshqa",    value: Math.round((other  / total) * 1000) / 10, amount: other,  fill: "#94a3b8" },
      ].filter((d) => d.value > 0);
    };
    if (pieProduct !== "__avg__") {
      const r = profitRows.find((p) => p.name === pieProduct);
      if (!r) return [];
      return mk(r.rawMaterialCost, r.salaryCost, r.electricityCost, r.otherCost);
    }
    let raw = 0, salary = 0, elec = 0, other = 0, n = 0;
    for (const r of profitRows) {
      if (r.totalCost <= 0) continue;
      raw    += r.rawMaterialCost / r.totalCost;
      salary += r.salaryCost      / r.totalCost;
      elec   += r.electricityCost / r.totalCost;
      other  += r.otherCost       / r.totalCost;
      n++;
    }
    if (n === 0) return [];
    return mk(raw / n, salary / n, elec / n, other / n).map((d) => ({ ...d, amount: undefined }));
  })();

  // Margin% across products (eng past → eng yuqori), color-coded by health.
  const marginData = [...profitRows]
    .sort((a, b) => a.marginPct - b.marginPct)
    .slice(0, 12)
    .map((r) => ({
      name: r.name,
      marginPct: r.marginPct,
      fill: r.marginPct >= 20 ? "#22c55e" : r.marginPct >= 0 ? "#f59e0b" : "#ef4444",
    }));

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <BarChart2 className="w-6 h-6 text-primary" /> Hisobotlar
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Savdo, ishlab chiqarish va maosh statistikasi</p>
        </div>
        <div className="flex gap-1.5">
          {[3, 6, 12].map((m) => (
            <PeriodBtn key={m} active={months === m} onClick={() => setMonths(m)} label={`${m} oy`} />
          ))}
        </div>
      </div>

      {/* Export section */}
      <ExportSection />

      {/* Tabs */}
      <Tabs defaultValue="sales">
        <TabsList className="grid w-full grid-cols-4 max-w-xl">
          <TabsTrigger value="sales"      className="gap-1.5"><TrendingUp className="w-3.5 h-3.5" /> Savdo</TabsTrigger>
          <TabsTrigger value="production" className="gap-1.5"><Package className="w-3.5 h-3.5" /> Ishlab chiqarish</TabsTrigger>
          <TabsTrigger value="salary"     className="gap-1.5"><Banknote className="w-3.5 h-3.5" /> Maosh</TabsTrigger>
          <TabsTrigger value="product"    className="gap-1.5"><DollarSign className="w-3.5 h-3.5" /> Mahsulot</TabsTrigger>
        </TabsList>

        {/* ═══════════════════════ SAVDO ═══════════════════════ */}
        <TabsContent value="sales" className="mt-5 space-y-6">
          {/* Combined totals with exchange rate */}
          {(totalSalesUsd > 0 || totalSalesUzs > 0) && (
            <div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
                  <p className="text-xs text-blue-500 mb-1 font-medium uppercase tracking-wide">Jami savdo so'mda</p>
                  <p className="text-xl font-bold text-blue-800 leading-tight">
                    {rateData
                      ? fmtUzs(totalSalesUzs + totalSalesUsd * rateData.rate)
                      : fmtUzs(totalSalesUzs)}
                  </p>
                  {rateData && totalSalesUsd > 0 && totalSalesUzs > 0 && (
                    <p className="text-[10px] text-blue-400 mt-0.5">
                      {fmtUzs(totalSalesUzs)} + {fmtUsd(totalSalesUsd)} × {rateData.rate.toLocaleString("uz-UZ")}
                    </p>
                  )}
                </div>
                <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4">
                  <p className="text-xs text-indigo-500 mb-1 font-medium uppercase tracking-wide">Jami savdo dollarda</p>
                  <p className="text-xl font-bold text-indigo-800 leading-tight">
                    {rateData
                      ? fmtUsd(totalSalesUsd + (rateData.rate > 0 ? totalSalesUzs / rateData.rate : 0))
                      : fmtUsd(totalSalesUsd)}
                  </p>
                  {rateData && totalSalesUsd > 0 && totalSalesUzs > 0 && (
                    <p className="text-[10px] text-indigo-400 mt-0.5">
                      {fmtUsd(totalSalesUsd)} + {fmtUzs(totalSalesUzs)} ÷ {rateData.rate.toLocaleString("uz-UZ")}
                    </p>
                  )}
                </div>
              </div>
              {rateData && (
                <p className="text-[10px] text-muted-foreground text-right mt-1">
                  1 USD = {rateData.rate.toLocaleString("uz-UZ")} so'm • {rateData.source} • {rateData.date}
                </p>
              )}
            </div>
          )}

          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard label="Jami savdo (USD)" value={fmtUsd(totalSalesUsd)} sub={`${months} oy`} color="blue" />
            <StatCard label="Jami savdo (UZS)" value={fmtUzs(totalSalesUzs)} sub={`${months} oy`} color="blue" />
            <StatCard label="O'rtacha / oy (USD)"
              value={fmtUsd(months > 0 ? totalSalesUsd / months : 0)} color="default" />
            <StatCard label="Jami savdolar soni"
              value={salesData.reduce((s, r) => s + r.saleCount, 0).toString()}
              sub={`${salesData.reduce((s, r) => s + r.paidCount, 0)} ta to'liq to'langan`} />
          </div>

          {/* USD chart */}
          <div className="rounded-xl border bg-card p-5">
            <p className="text-sm font-semibold mb-4 flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-blue-500" /> Oylik savdo — USD ($)
            </p>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={salesData} barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={(v) => `$${(v/1000).toFixed(0)}k`} tick={{ fontSize: 11 }} width={52} />
                <Tooltip content={<ChartTooltip formatter={fmtUsd} />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="salesUsd" name="Savdo" fill="#3b82f6" radius={[4,4,0,0]} />
                <Bar dataKey="paidUsd"  name="To'langan" fill="#22c55e" radius={[4,4,0,0]} />
                <Bar dataKey="debtUsd"  name="Nasiya" fill="#f59e0b" radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* UZS chart */}
          {totalSalesUzs > 0 && (
            <div className="rounded-xl border bg-card p-5">
              <p className="text-sm font-semibold mb-4 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-orange-500" /> Oylik savdo — UZS (so'm)
              </p>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={salesData} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                  <YAxis tickFormatter={(v) => `${(v/1_000_000).toFixed(1)}M`} tick={{ fontSize: 11 }} width={52} />
                  <Tooltip content={<ChartTooltip formatter={fmtUzs} />} />
                  <Bar dataKey="salesUzs" name="Savdo" fill="#f97316" radius={[4,4,0,0]} />
                  <Bar dataKey="paidUzs"  name="To'langan" fill="#22c55e" radius={[4,4,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Top customers */}
          {(data?.topCustomers ?? []).length > 0 && (
            <div className="rounded-xl border bg-card p-5">
              <p className="text-sm font-semibold mb-4 flex items-center gap-2">
                <Award className="w-4 h-4 text-yellow-500" /> Top mijozlar
              </p>
              <div className="space-y-2">
                {(data?.topCustomers ?? []).map((c, i) => (
                  <div key={c.customerName} className="flex items-center gap-3">
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                      i === 0 ? "bg-yellow-100 text-yellow-700" :
                      i === 1 ? "bg-slate-100 text-slate-600" :
                      i === 2 ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground"
                    }`}>{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium truncate">{c.customerName}</p>
                        <div className="flex items-center gap-2 shrink-0">
                          {c.totalUsd > 0 && <Badge variant="outline" className="text-xs">{fmtUsd(c.totalUsd)}</Badge>}
                          {c.totalUzs > 0 && <Badge variant="outline" className="text-xs">{fmtUzs(c.totalUzs)}</Badge>}
                          <span className="text-xs text-muted-foreground">{c.saleCount} ta</span>
                        </div>
                      </div>
                      <div className="w-full bg-muted rounded-full h-1.5 mt-1">
                        <div
                          className="bg-blue-500 h-1.5 rounded-full"
                          style={{ width: `${Math.min(100, (c.totalUsd / ((data?.topCustomers[0]?.totalUsd ?? 1) || 1)) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </TabsContent>

        {/* ═══════════════════ ISHLAB CHIQARISH ═══════════════════ */}
        <TabsContent value="production" className="mt-5 space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard label="Jami partiyalar" value={totalBatches.toString()} sub={`${months} oy`} color="green" />
            <StatCard label="Jami og'irlik"   value={fmtKg(totalWeight)} sub={`${months} oy`} color="green" />
            <StatCard label="Jami hisob-kitob" value={fmtUzs(totalEarnings)} color="default" />
            <StatCard label="O'rtacha / oy" value={Math.round(totalBatches / months).toString() + " ta"} color="default" />
          </div>

          {/* Batch count chart */}
          <div className="rounded-xl border bg-card p-5">
            <p className="text-sm font-semibold mb-4 flex items-center gap-2">
              <Package className="w-4 h-4 text-green-500" /> Oylik partiyalar soni
            </p>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={prodData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 11 }} width={36} />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="batchCount" name="Partiyalar" fill="#22c55e" radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Weight chart */}
          <div className="rounded-xl border bg-card p-5">
            <p className="text-sm font-semibold mb-4 flex items-center gap-2">
              <Package className="w-4 h-4 text-emerald-600" /> Oylik og'irlik (kg)
            </p>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={prodData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={(v) => fmtKg(v)} tick={{ fontSize: 11 }} width={52} />
                <Tooltip content={<ChartTooltip formatter={fmtKg} />} />
                <Line dataKey="totalWeight" name="Og'irlik" stroke="#10b981" strokeWidth={2} dot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Top workers */}
          {(data?.topWorkers ?? []).length > 0 && (
            <div className="rounded-xl border bg-card p-5">
              <p className="text-sm font-semibold mb-4 flex items-center gap-2">
                <Users className="w-4 h-4 text-green-500" /> Eng faol ishchilar
              </p>
              <div className="space-y-2">
                {(data?.topWorkers ?? []).map((w, i) => (
                  <div key={w.worker} className="flex items-center gap-3">
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                      i === 0 ? "bg-yellow-100 text-yellow-700" :
                      i === 1 ? "bg-slate-100 text-slate-600" :
                      i === 2 ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground"
                    }`}>{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">{w.worker}</p>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge variant="outline" className="text-xs">{fmtUzs(w.totalEarnings)}</Badge>
                          <span className="text-xs text-muted-foreground">{w.batchCount} ta · {fmtKg(w.totalWeight)}</span>
                        </div>
                      </div>
                      <div className="w-full bg-muted rounded-full h-1.5 mt-1">
                        <div
                          className="bg-green-500 h-1.5 rounded-full"
                          style={{ width: `${Math.min(100, (w.totalEarnings / ((data?.topWorkers[0]?.totalEarnings ?? 1) || 1)) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top products */}
          {(data?.topProducts ?? []).length > 0 && (
            <div className="rounded-xl border bg-card p-5">
              <p className="text-sm font-semibold mb-4 flex items-center gap-2">
                <ShoppingBag className="w-4 h-4 text-emerald-600" /> Eng ko'p ishlab chiqarilgan mahsulotlar
              </p>
              <div className="space-y-2">
                {(data?.topProducts ?? []).map((p, i) => (
                  <div key={p.product} className="flex items-center gap-3">
                    <span className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground shrink-0">{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium truncate">{p.product}</p>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-xs text-muted-foreground">{p.batchCount} ta partiya · {fmtKg(p.totalWeight)}</span>
                        </div>
                      </div>
                      <div className="w-full bg-muted rounded-full h-1.5 mt-1">
                        <div
                          className="bg-emerald-500 h-1.5 rounded-full"
                          style={{ width: `${Math.min(100, (p.batchCount / ((data?.topProducts[0]?.batchCount ?? 1) || 1)) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </TabsContent>

        {/* ═══════════════════════ MAOSH ═══════════════════════ */}
        <TabsContent value="salary" className="mt-5 space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <StatCard label="Jami to'langan maosh" value={fmtUzs(totalSalary)} sub={`${months} oy`} color="amber" />
            <StatCard label="O'rtacha / oy" value={fmtUzs(months > 0 ? totalSalary / months : 0)} color="default" />
            <StatCard label="Hisob-kitob (partiyalar)" value={fmtUzs(totalEarnings)} sub="Zarplata hisoblanmagan" color="default" />
          </div>

          <div className="rounded-xl border bg-card p-5">
            <p className="text-sm font-semibold mb-4 flex items-center gap-2">
              <Banknote className="w-4 h-4 text-amber-500" /> Oylik maosh to'lovlari
            </p>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={salaryFilled}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={(v) => `${(v/1_000_000).toFixed(1)}M`} tick={{ fontSize: 11 }} width={52} />
                <Tooltip content={<ChartTooltip formatter={fmtUzs} />} />
                <Bar dataKey="totalPaid" name="To'langan maosh" fill="#f59e0b" radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Earnings vs salary comparison */}
          <div className="rounded-xl border bg-card p-5">
            <p className="text-sm font-semibold mb-4 flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-purple-500" /> Hisoblangan vs To'langan (so'm)
            </p>
            <div className="space-y-0">
              {prodData.filter(r => r.totalEarnings > 0 || salaryFilled.find(s => s.month === r.month)?.totalPaid).map((p) => {
                const sal = salaryFilled.find(s => s.month === p.month);
                const earned = p.totalEarnings;
                const paid   = sal?.totalPaid ?? 0;
                const diff   = earned - paid;
                return (
                  <div key={p.month} className="flex items-center gap-3 py-2 border-b last:border-0">
                    <span className="text-sm font-medium w-10 shrink-0">{shortMonth(p.month)}</span>
                    <div className="flex-1 text-xs space-y-0.5">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Hisoblangan:</span>
                        <span className="font-medium">{fmtUzs(earned)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">To'langan:</span>
                        <span className="font-medium text-green-700">{fmtUzs(paid)}</span>
                      </div>
                    </div>
                    {diff !== 0 && (
                      <Badge variant={diff > 0 ? "destructive" : "secondary"} className="text-xs shrink-0">
                        {diff > 0 ? `-${fmtUzs(diff)}` : `+${fmtUzs(Math.abs(diff))}`}
                      </Badge>
                    )}
                  </div>
                );
              })}
              {prodData.every(r => r.totalEarnings === 0) && (
                <p className="text-sm text-muted-foreground text-center py-6">Ma'lumot yo'q</p>
              )}
            </div>
          </div>
        </TabsContent>

        {/* ═══════════════════════ MAHSULOT ═══════════════════════ */}
        <TabsContent value="product" className="mt-5 space-y-5">
          {/* Sort controls */}
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-xs text-muted-foreground font-medium">Saralash:</span>
            {(
              [
                { key: "profit",     label: "Yuqori foyda" },
                { key: "margin",     label: "Yuqori margin" },
                { key: "low_margin", label: "Past margin" },
                { key: "revenue",    label: "Yuqori daromad" },
                { key: "sold",       label: "Ko'p sotilgan" },
              ] as const
            ).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setSortBy(key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  sortBy === key
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted/50 text-muted-foreground hover:bg-muted"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Profitability charts (#8) */}
          {profitRows.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* Cost structure pie — per-product or average */}
              <div className="rounded-xl border bg-card p-5">
                <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
                  <p className="text-sm font-semibold flex items-center gap-2">
                    <DollarSign className="w-4 h-4 text-primary" /> Xarajat tarkibi
                  </p>
                  <select
                    value={pieProduct}
                    onChange={(e) => setPieProduct(e.target.value)}
                    className="h-8 px-2 rounded-md border bg-background text-xs max-w-[180px]"
                  >
                    <option value="__avg__">O'rtacha (barcha mahsulotlar)</option>
                    {profitRows.map((r) => (
                      <option key={r.name} value={r.name}>{r.name}</option>
                    ))}
                  </select>
                </div>
                {costStructure.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-10">Ma'lumot yo'q</p>
                ) : (
                  <>
                    <ResponsiveContainer width="100%" height={220}>
                      <PieChart>
                        <Pie
                          data={costStructure}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          innerRadius={45}
                          outerRadius={82}
                          paddingAngle={2}
                        >
                          {costStructure.map((d) => <Cell key={d.name} fill={d.fill} />)}
                        </Pie>
                        <Tooltip formatter={(v: any) => `${v}%`} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 mt-2">
                      {costStructure.map((d) => (
                        <div key={d.name} className="flex items-center gap-1.5 text-xs">
                          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: d.fill }} />
                          <span className="text-muted-foreground">{d.name}</span>
                          <span className="font-semibold">{d.value}%</span>
                          {d.amount !== undefined && (
                            <span className="text-muted-foreground">({fmtUzs(Math.round(d.amount))})</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* Margin% horizontal bar */}
              <div className="rounded-xl border bg-card p-5">
                <p className="text-sm font-semibold mb-4 flex items-center gap-2">
                  <BarChart2 className="w-4 h-4 text-primary" /> Mahsulotlar margin% (eng past → eng yuqori)
                </p>
                <ResponsiveContainer width="100%" height={Math.max(220, marginData.length * 34)}>
                  <BarChart data={marginData} layout="vertical" margin={{ left: 8, right: 24 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}%`} />
                    <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v: any) => `${v}%`} cursor={{ fill: "rgba(0,0,0,0.04)" }} />
                    <Bar dataKey="marginPct" name="Margin" radius={[0, 4, 4, 0]}>
                      {marginData.map((d) => <Cell key={d.name} fill={d.fill} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Profit trend by month (#8) */}
          {profitTrend.length > 0 && (
            <div className="rounded-xl border bg-card p-5">
              <p className="text-sm font-semibold mb-4 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-green-600" /> Foyda trendi (oylar bo'yicha, so'm)
              </p>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={profitTrend.map((r) => ({ ...r, label: shortMonth(r.month) }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                  <YAxis tickFormatter={(v) => `${(v / 1_000_000).toFixed(1)}M`} tick={{ fontSize: 11 }} width={52} />
                  <Tooltip content={<ChartTooltip formatter={fmtUzs} />} />
                  <Line dataKey="profitUzs" name="Foyda" stroke="#16a34a" strokeWidth={2} dot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
              <p className="text-[10px] text-muted-foreground mt-1">
                Foyda = haqiqiy sotuv tushumi (sotuv paytidagi narx) − joriy birlik xarajat × miqdor (USD jonli kursda so'mga o'tkazilgan)
              </p>
            </div>
          )}

          {/* Table */}
          <div className="rounded-xl border bg-card overflow-x-auto">
            {profitLoading ? (
              <div className="p-6 space-y-3">
                {[1, 2, 3, 4, 5].map(i => (
                  <div key={i} className="h-10 bg-muted/40 rounded animate-pulse" />
                ))}
              </div>
            ) : profitRows.length === 0 ? (
              <div className="text-center py-12 text-sm text-muted-foreground">
                Ma'lumot yo'q
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="text-left px-4 py-3 font-medium">Mahsulot</th>
                    <th className="text-right px-4 py-3 font-medium">Daromad</th>
                    <th className="text-right px-4 py-3 font-medium">Xarajat</th>
                    <th className="text-right px-4 py-3 font-medium">Foyda</th>
                    <th className="text-right px-4 py-3 font-medium">Margin%</th>
                    <th className="text-right px-4 py-3 font-medium">Sotilgan</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {profitRows.map((row, i) => {
                    // Xarajat/foyda API'da UZS'ga normallashtirilgan (USD jonli kursda) — UZS'da ko'rsatamiz.
                    const fmtVal = (v: number) => fmtUzs(v);
                    const revenueDisplay = row.revenueUsd > 0
                      ? fmtUsd(row.revenueUsd)
                      : fmtUzs(row.revenueUzs);
                    const profitColor =
                      row.profit >= 0 ? "text-green-700" : "text-red-600";
                    const marginColor =
                      row.marginPct >= 20
                        ? "text-green-700"
                        : row.marginPct >= 0
                          ? "text-amber-600"
                          : "text-red-600";
                    return (
                      <tr
                        key={row.name}
                        className="hover:bg-muted/30 transition-colors"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="w-5 h-5 rounded text-xs font-bold flex items-center justify-center bg-muted text-muted-foreground shrink-0">
                              {i + 1}
                            </span>
                            <div>
                              <div className="font-medium">{row.name}</div>
                              {row.sku && (
                                <div className="text-xs text-muted-foreground font-mono">
                                  {row.sku}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs">
                          {revenueDisplay}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                          {fmtVal(row.totalCost)}
                        </td>
                        <td className={`px-4 py-3 text-right font-mono text-xs font-semibold ${profitColor}`}>
                          {fmtVal(row.profit)}
                        </td>
                        <td className={`px-4 py-3 text-right font-semibold text-sm ${marginColor}`}>
                          {row.marginPct.toFixed(1)}%
                        </td>
                        <td className="px-4 py-3 text-right text-xs text-muted-foreground">
                          {row.unitsSold > 0 ? `${row.unitsSold} ${row.unitType}` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Summary cards */}
          {profitRows.length > 0 && (() => {
            const topProfit = profitRows.reduce((a, b) => a.profit > b.profit ? a : b);
            const topMargin = profitRows.reduce((a, b) => a.marginPct > b.marginPct ? a : b);
            const botMargin = profitRows.reduce((a, b) => a.marginPct < b.marginPct ? a : b);
            return (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <StatCard
                  label="Eng foydali mahsulot"
                  value={topProfit.name}
                  sub={`Foyda: ${fmtUzs(topProfit.profit)}`}
                  color="green"
                />
                <StatCard
                  label="Eng yuqori margin"
                  value={topMargin.name}
                  sub={`${topMargin.marginPct.toFixed(1)}%`}
                  color="green"
                />
                <StatCard
                  label="Eng past margin"
                  value={botMargin.name}
                  sub={`${botMargin.marginPct.toFixed(1)}%`}
                  color="amber"
                />
              </div>
            );
          })()}
        </TabsContent>
      </Tabs>

      {isLoading && (
        <div className="fixed inset-0 bg-background/50 flex items-center justify-center">
          <div className="text-sm text-muted-foreground animate-pulse">Yuklanmoqda…</div>
        </div>
      )}
    </div>
  );
}
