import { useQuery } from "@tanstack/react-query";
import {
  useGetDashboardToday, getGetDashboardTodayQueryKey,
  useGetDashboardMonthly, getGetDashboardMonthlyQueryKey,
  useGetTopWorkers, getGetTopWorkersQueryKey,
  useGetDailyChart, getGetDailyChartQueryKey
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { formatCurrency, formatNumber } from "@/lib/format";
import { ShoppingCart, Package, Users, TrendingUp, DollarSign, Factory, Award } from "lucide-react";

const BASE = import.meta.env.BASE_URL ?? "/dashboard/";

type TodayExtended = {
  todaySales: {
    count: number;
    totalUzs: number;
    totalUsd: number;
    items: {
      id: number;
      customerName: string;
      product: string;
      quantity: number;
      weightKg: number;
      totalAmount: number;
      currency: string;
      status: string;
      createdAt: string;
    }[];
  };
  todayBatches: {
    items: {
      worker: string;
      qty: number;
      kg: number;
      earnings: number;
      batches: number;
    }[];
  };
};

function useTodayExtended() {
  return useQuery<TodayExtended>({
    queryKey: ["dashboard", "today-extended"],
    queryFn: async () => {
      const res = await fetch(`${BASE}api/dashboard/today-extended`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    refetchInterval: 30_000,
  });
}

export default function Dashboard() {
  const { data: today, isLoading: isLoadingToday } = useGetDashboardToday({
    query: { queryKey: getGetDashboardTodayQueryKey() }
  });
  const { data: monthly, isLoading: isLoadingMonthly } = useGetDashboardMonthly(undefined, {
    query: { queryKey: getGetDashboardMonthlyQueryKey() }
  });
  const { data: chartData, isLoading: isLoadingChart } = useGetDailyChart({
    query: { queryKey: getGetDailyChartQueryKey() }
  });
  const { data: topWorkers, isLoading: isLoadingWorkers } = useGetTopWorkers({
    query: { queryKey: getGetTopWorkersQueryKey() }
  });
  const { data: extended, isLoading: isLoadingExtended } = useTodayExtended();

  const todaySales = extended?.todaySales;
  const todayBatches = extended?.todayBatches;

  return (
    <div className="space-y-8">

      {/* ── BUGUNGI ISHLAB CHIQARISH ── */}
      <section>
        <SectionTitle icon={<Factory className="w-4 h-4" />} label="BUGUNGI ISHLAB CHIQARISH" live />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard icon={<Package className="w-4 h-4" />} title="Partiyalar" value={today?.totalBatches} loading={isLoadingToday} formatter={formatNumber} testId="today-batches" />
          <MetricCard icon={<Package className="w-4 h-4" />} title="Miqdor (dona)" value={today?.totalQty} loading={isLoadingToday} formatter={formatNumber} testId="today-qty" />
          <MetricCard icon={<Package className="w-4 h-4" />} title="Og'irlik (kg)" value={today?.totalKg} loading={isLoadingToday} formatter={(v) => `${formatNumber(v)} kg`} testId="today-kg" />
          <MetricCard icon={<Users className="w-4 h-4" />} title="Faol ishchilar" value={today?.workerCount} loading={isLoadingToday} formatter={formatNumber} testId="today-workers" />
        </div>
      </section>

      {/* ── BUGUNGI SAVDOLAR + ISHCHILAR ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Savdolar */}
        <section>
          <SectionTitle icon={<ShoppingCart className="w-4 h-4" />} label="BUGUNGI SAVDOLAR" />
          <div className="grid grid-cols-3 gap-3 mb-4">
            <MetricCard icon={<ShoppingCart className="w-4 h-4" />} title="Savdolar" value={todaySales?.count} loading={isLoadingExtended} formatter={formatNumber} small />
            <MetricCard icon={<DollarSign className="w-4 h-4" />} title="Jami (so'm)" value={todaySales?.totalUzs} loading={isLoadingExtended} formatter={formatCurrency} small highlight />
            <MetricCard icon={<DollarSign className="w-4 h-4" />} title="Jami ($)" value={todaySales?.totalUsd} loading={isLoadingExtended} formatter={(v) => `$${formatNumber(v)}`} small />
          </div>

          <Card className="border-border">
            <CardContent className="p-0">
              {isLoadingExtended ? (
                <div className="p-4 space-y-3">
                  {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
                </div>
              ) : !todaySales?.items.length ? (
                <div className="text-center py-10 text-muted-foreground text-sm">
                  <ShoppingCart className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  Bugun savdo amalga oshirilmagan
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {todaySales.items.map((s) => (
                    <div key={s.id} className="flex items-center justify-between px-4 py-3 hover:bg-muted/40 transition-colors">
                      <div className="min-w-0">
                        <div className="font-medium text-sm truncate">{s.customerName}</div>
                        <div className="text-xs text-muted-foreground truncate">{s.product} · {formatNumber(s.quantity)} dona</div>
                      </div>
                      <div className="text-right ml-3 shrink-0">
                        <div className="font-mono text-sm font-semibold">
                          {s.currency === "usd" ? `$${formatNumber(s.totalAmount)}` : formatCurrency(s.totalAmount)}
                        </div>
                        <StatusBadge status={s.status} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Ishchilar bugungi natijasi */}
        <section>
          <SectionTitle icon={<Users className="w-4 h-4" />} label="BUGUNGI ISHCHILAR" />
          <Card className="border-border">
            <CardContent className="p-0">
              {isLoadingExtended ? (
                <div className="p-4 space-y-3">
                  {[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full" />)}
                </div>
              ) : !todayBatches?.items.length ? (
                <div className="text-center py-10 text-muted-foreground text-sm">
                  <Users className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  Bugun partiya kiritilmagan
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {todayBatches.items.map((w, idx) => (
                    <div key={w.worker} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
                      <div className="w-7 h-7 rounded bg-primary/10 flex items-center justify-center text-xs font-bold text-primary shrink-0">
                        {idx + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm">{w.worker}</div>
                        <div className="text-xs text-muted-foreground">
                          {w.batches} partiya · {formatNumber(w.qty)} dona
                          {w.kg > 0 && ` · ${formatNumber(w.kg)} kg`}
                        </div>
                      </div>
                      <div className="text-right font-mono text-sm font-semibold text-primary shrink-0">
                        {formatCurrency(w.earnings)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      </div>

      {/* ── GRAFIK + TOP ISHCHILAR ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card className="border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">30 Kunlik Ishlab Chiqarish</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoadingChart ? (
                <Skeleton className="w-full h-[260px]" />
              ) : (
                <div className="h-[260px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData || []} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="date" tickFormatter={(v) => v.slice(5)} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} dy={8} />
                      <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v / 1000}k`} />
                      <Tooltip cursor={{ fill: "hsl(var(--muted))" }} contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", borderRadius: 6, fontSize: 12 }} formatter={(v: number) => [formatNumber(v), "Miqdor"]} labelFormatter={(l) => `Sana: ${l}`} />
                      <Bar dataKey="qty" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Oylik */}
          <div>
            <SectionTitle icon={<TrendingUp className="w-4 h-4" />} label="OYLIK KO'RSATKICHLAR" />
            <div className="grid grid-cols-3 gap-4">
              <MetricCard icon={<Package className="w-4 h-4" />} title="Oylik miqdor" value={monthly?.totalQty} loading={isLoadingMonthly} formatter={formatNumber} testId="monthly-qty" />
              <MetricCard icon={<Package className="w-4 h-4" />} title="Oylik og'irlik" value={monthly?.totalKg} loading={isLoadingMonthly} formatter={(v) => `${formatNumber(v)} kg`} testId="monthly-kg" />
              <MetricCard icon={<DollarSign className="w-4 h-4" />} title="Jami maosh" value={monthly?.totalEarnings} loading={isLoadingMonthly} formatter={formatCurrency} testId="monthly-earnings" highlight />
            </div>
          </div>
        </div>

        {/* Top ishchilar (oy) */}
        <Card className="border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Award className="w-3.5 h-3.5" /> Eng Yaxshi (bu oy)
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3">
            {isLoadingWorkers ? (
              <div className="space-y-3">
                {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : topWorkers?.length ? (
              <div className="space-y-1">
                {topWorkers.map((w, idx) => (
                  <div key={w.worker} className="flex items-center gap-3 px-2 py-2.5 rounded-md hover:bg-muted/50 transition-colors">
                    <div className={`w-6 h-6 rounded flex items-center justify-center text-xs font-bold shrink-0
                      ${idx === 0 ? "bg-yellow-100 text-yellow-700" : idx === 1 ? "bg-slate-100 text-slate-600" : idx === 2 ? "bg-orange-100 text-orange-700" : "bg-muted text-muted-foreground"}`}>
                      {idx + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">{w.worker}</div>
                      <div className="text-xs text-muted-foreground">{formatNumber(w.totalQty)} dona</div>
                    </div>
                    <div className="font-mono text-xs font-semibold text-right shrink-0">
                      {formatCurrency(w.totalEarnings)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground text-sm">Bu oyda ma'lumot yo'q</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SectionTitle({ icon, label, live = false }: { icon: React.ReactNode; label: string; live?: boolean }) {
  return (
    <h2 className="text-xs font-bold uppercase tracking-wider mb-3 text-muted-foreground flex items-center gap-2">
      {icon}
      {label}
      {live && <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />}
    </h2>
  );
}

function MetricCard({ icon, title, value, loading, formatter = (v: any) => v, highlight = false, small = false, testId }: {
  icon?: React.ReactNode;
  title: string;
  value?: number;
  loading?: boolean;
  formatter?: (v: number) => string;
  highlight?: boolean;
  small?: boolean;
  testId?: string;
}) {
  return (
    <Card className={`border-border ${highlight ? "bg-sidebar text-sidebar-foreground border-sidebar-border" : ""}`} data-testid={testId}>
      <CardContent className={small ? "p-3" : "p-5"}>
        <div className={`flex items-center gap-1.5 mb-1.5 ${highlight ? "text-sidebar-foreground/60" : "text-muted-foreground"}`}>
          {icon && <span className="opacity-70">{icon}</span>}
          <span className={`font-bold uppercase tracking-wider ${small ? "text-[10px]" : "text-xs"}`}>{title}</span>
        </div>
        {loading ? (
          <Skeleton className={`${small ? "h-6 w-16" : "h-8 w-24"} ${highlight ? "bg-sidebar-accent" : ""}`} />
        ) : (
          <div className={`font-semibold tracking-tight ${small ? "text-lg" : "text-2xl"}`}>
            {value !== undefined ? formatter(value) : "—"}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    pending:  { label: "Kutilmoqda", className: "bg-yellow-100 text-yellow-800 border-yellow-200" },
    paid:     { label: "To'langan",  className: "bg-green-100 text-green-800 border-green-200" },
    cancelled:{ label: "Bekor",      className: "bg-red-100 text-red-800 border-red-200" },
  };
  const s = map[status] ?? { label: status, className: "bg-muted text-muted-foreground" };
  return (
    <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded border font-medium ${s.className}`}>
      {s.label}
    </span>
  );
}
