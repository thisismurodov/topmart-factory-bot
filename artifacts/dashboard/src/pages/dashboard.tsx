import { useQuery } from "@tanstack/react-query";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, CartesianGrid,
} from "recharts";
import { formatCurrency, formatNumber } from "@/lib/format";

/* ─── Types ─── */
type V2Data = {
  todaySalesUzs: number;
  todaySalesUsd: number;
  todaySalesCount: number;
  monthlySalesUzs: number;
  monthlySalesUsd: number;
  monthlySalesCount: number;
  totalCustomers: number;
  todayNewCustomers: number;
  monthlyNewCustomers: number;
  inventorySkuCount: number;
  totalStockQty: number;
  lowStockItems: { product: string; stockQty: number; stockKg: number }[];
  inventoryItems: { product: string; stockQty: number; stockKg: number }[];
  todayBatches: number;
  todayQty: number;
  todayKg: number;
  todayEarnings: number;
  todayWorkerCount: number;
  topWorkers: { worker: string; qty: number; earnings: number; batches: number }[];
  topProducts: { product: string; soldQty: number }[];
  liveFeed: { time: string; type: string; actor: string; description: string }[];
};

/* ─── Hooks ─── */
function useDashboardV2() {
  return useQuery<V2Data>({
    queryKey: ["dashboard-v2"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/v2");
      if (!res.ok) throw new Error("API xatosi");
      return res.json();
    },
    refetchInterval: 30_000,
    staleTime: 20_000,
  });
}

/* ─── Main Component ─── */
export default function Dashboard() {
  const { data: d, isLoading, error } = useDashboardV2();

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center text-red-500">
          <div className="text-lg font-semibold mb-1">Ma'lumot yuklanmadi</div>
          <div className="text-sm text-muted-foreground">{String(error)}</div>
        </div>
      </div>
    );
  }

  const topProductsData = d?.topProducts.map((p) => ({ name: p.product.length > 12 ? p.product.slice(0, 12) + "…" : p.product, qty: p.soldQty })) ?? [];

  return (
    <div className="space-y-6">

      {/* ══ SECTION 1: CEO KPI ══ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          icon="💰"
          label="Bugungi savdo"
          loading={isLoading}
          value={d?.todaySalesUsd ? `$${formatNumber(d.todaySalesUsd)}` : d?.todaySalesUzs ? formatCurrency(d.todaySalesUzs) : "—"}
          sub={`${d?.todaySalesCount ?? 0} ta chek`}
          accent
        />
        <KpiCard
          icon="🏪"
          label="Jami mijozlar"
          loading={isLoading}
          value={formatNumber(d?.totalCustomers)}
          sub={d?.todayNewCustomers ? `+${d.todayNewCustomers} bugun` : "Faol do'konlar"}
        />
        <KpiCard
          icon="📦"
          label="Ombordagi SKU"
          loading={isLoading}
          value={formatNumber(d?.inventorySkuCount)}
          sub={`Jami: ${formatNumber(d?.totalStockQty)} dona`}
          warn={(d?.lowStockItems.length ?? 0) > 0}
        />
        <KpiCard
          icon="🏭"
          label="Bugungi ishlab chiqarish"
          loading={isLoading}
          value={formatNumber(d?.todayQty)}
          sub={`${d?.todayBatches ?? 0} partiya · ${d?.todayWorkerCount ?? 0} ishchi`}
        />
      </div>

      {/* ══ SECTION 2: Savdo + Mijozlar KPI ══ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Panel title="💵 Savdo Ko'rsatkichlari">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Bugungi (so'm)" value={formatCurrency(d?.todaySalesUzs)} loading={isLoading} />
            <Stat label="Bugungi ($)" value={`$${formatNumber(d?.todaySalesUsd)}`} loading={isLoading} highlight />
            <Stat label="Oylik (so'm)" value={formatCurrency(d?.monthlySalesUzs)} loading={isLoading} />
            <Stat label="Oylik ($)" value={`$${formatNumber(d?.monthlySalesUsd)}`} loading={isLoading} />
            <Stat label="Cheklar soni" value={formatNumber(d?.monthlySalesCount)} loading={isLoading} />
            <Stat
              label="O'rtacha chek ($)"
              value={d?.monthlySalesCount && d.monthlySalesCount > 0
                ? `$${formatNumber(Math.round(d.monthlySalesUsd / d.monthlySalesCount))}`
                : "—"}
              loading={isLoading}
            />
          </div>
        </Panel>

        <Panel title="👥 Mijozlar Ko'rsatkichlari">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Jami do'konlar" value={formatNumber(d?.totalCustomers)} loading={isLoading} />
            <Stat label="Bugun qo'shildi" value={`+${d?.todayNewCustomers ?? 0}`} loading={isLoading} />
            <Stat label="Bu oy qo'shildi" value={`+${d?.monthlyNewCustomers ?? 0}`} loading={isLoading} />
          </div>
        </Panel>
      </div>

      {/* ══ SECTION 3: Ishlab chiqarish + Top ishchilar ══ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-4">
          <Panel title="🏭 Bugungi Ishlab Chiqarish">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Partiyalar" value={formatNumber(d?.todayBatches)} loading={isLoading} />
              <Stat label="Miqdor (dona)" value={formatNumber(d?.todayQty)} loading={isLoading} />
              <Stat label="Og'irlik (kg)" value={`${formatNumber(d?.todayKg)} kg`} loading={isLoading} />
              <Stat label="Bugungi maosh" value={formatCurrency(d?.todayEarnings)} loading={isLoading} highlight />
            </div>
          </Panel>
        </div>

        <Panel title="🏆 Top Ishchilar (bu oy)">
          {isLoading ? (
            <LoadingRows n={5} />
          ) : !d?.topWorkers.length ? (
            <Empty text="Ma'lumot yo'q" />
          ) : (
            <div className="space-y-2">
              {d.topWorkers.map((w, i) => (
                <div key={w.worker} className="flex items-center gap-2">
                  <RankBadge rank={i + 1} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{w.worker}</div>
                    <div className="text-xs text-muted-foreground">{formatNumber(w.qty)} dona · {w.batches} partiya</div>
                  </div>
                  <div className="text-xs font-mono font-semibold text-[#0B5D2A] shrink-0">
                    {formatCurrency(w.earnings)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* ══ SECTION 4: Ombor holati ══ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Panel title="🏬 Ombor Holati">
          {isLoading ? (
            <LoadingRows n={4} />
          ) : !d?.inventoryItems.length ? (
            <Empty text="Ombor ma'lumoti yo'q" />
          ) : (
            <div className="space-y-2">
              {d.inventoryItems.map((item) => {
                const pct = d.totalStockQty > 0 ? Math.max(0, Math.min(100, (item.stockQty / d.totalStockQty) * 100)) : 0;
                const low = item.stockQty < 50;
                return (
                  <div key={item.product} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className={`font-medium ${low ? "text-red-600" : ""}`}>{item.product}</span>
                      <span className={`font-mono text-xs ${low ? "text-red-600 font-bold" : "text-muted-foreground"}`}>
                        {formatNumber(item.stockQty)} dona{item.stockKg > 0 ? ` · ${formatNumber(item.stockKg)} kg` : ""}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${low ? "bg-red-500" : "bg-[#0B5D2A]"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        {/* Low stock warning */}
        <Panel title="⚠️ Kam Qolgan Mahsulotlar" warn={!!d?.lowStockItems.length}>
          {isLoading ? (
            <LoadingRows n={3} />
          ) : !d?.lowStockItems.length ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="text-2xl mb-2">✅</div>
              <div className="text-sm font-medium text-green-700">Ombor holati yaxshi</div>
              <div className="text-xs text-muted-foreground mt-1">Kam qolgan mahsulot yo'q</div>
            </div>
          ) : (
            <div className="space-y-2">
              {d.lowStockItems.map((item) => (
                <div key={item.product} className="flex items-center gap-3 p-2 rounded-lg bg-red-50 border border-red-100">
                  <div className="text-red-500 text-lg">⚠️</div>
                  <div className="flex-1">
                    <div className="text-sm font-semibold text-red-700">{item.product}</div>
                    <div className="text-xs text-red-500">Qoldiq: {formatNumber(item.stockQty)} dona</div>
                  </div>
                  <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-bold border border-red-200">
                    KAMLIGI PAST
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* ══ SECTION 5: Top mahsulotlar (grafik) ══ */}
      {topProductsData.length > 0 && (
        <Panel title="📊 Eng Ko'p Sotilgan Mahsulotlar">
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topProductsData} layout="vertical" margin={{ top: 0, right: 40, left: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                <XAxis type="number" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} tickFormatter={(v) => formatNumber(v)} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: "hsl(var(--foreground))" }} axisLine={false} tickLine={false} width={110} />
                <Tooltip
                  contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", borderRadius: 6, fontSize: 12 }}
                  formatter={(v: number) => [formatNumber(v) + " dona", "Sotilgan"]}
                />
                <Bar dataKey="qty" fill="#0B5D2A" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      )}

      {/* ══ SECTION 6: Live Feed ══ */}
      <Panel title="⚡ TopMart Live Feed">
        {isLoading ? (
          <LoadingRows n={5} />
        ) : !d?.liveFeed.length ? (
          <Empty text="Hali faoliyat yo'q" />
        ) : (
          <div className="space-y-0 divide-y divide-border">
            {d.liveFeed.map((item, i) => {
              const t = new Date(item.time);
              const timeStr = t.toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" });
              const icons: Record<string, string> = { batch: "🏭", sale: "💵", customer: "🏪" };
              return (
                <div key={i} className="flex items-start gap-3 py-2.5 hover:bg-muted/30 transition-colors px-1 rounded">
                  <div className="w-10 text-xs text-muted-foreground font-mono pt-0.5 shrink-0">{timeStr}</div>
                  <div className="w-6 text-base shrink-0 mt-0.5">{icons[item.type] ?? "📋"}</div>
                  <div className="flex-1 min-w-0">
                    <span className="font-semibold text-sm">{item.actor}</span>
                    {" "}
                    <span className="text-sm text-muted-foreground">{item.description}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

    </div>
  );
}

/* ─── Sub-components ─── */

function KpiCard({ icon, label, value, sub, loading, accent, warn }: {
  icon: string; label: string; value?: string; sub?: string;
  loading?: boolean; accent?: boolean; warn?: boolean;
}) {
  return (
    <div className={`rounded-xl p-5 shadow-sm border transition-all
      ${accent ? "bg-[#0B5D2A] text-white border-[#0B5D2A]" : warn ? "bg-amber-50 border-amber-200" : "bg-white border-border"}`}>
      <div className={`text-xs font-bold uppercase tracking-wider mb-3 flex items-center gap-1.5
        ${accent ? "text-white/70" : warn ? "text-amber-600" : "text-muted-foreground"}`}>
        <span className="text-base">{icon}</span> {label}
      </div>
      {loading ? (
        <div className={`h-8 w-28 rounded animate-pulse ${accent ? "bg-white/20" : "bg-muted"}`} />
      ) : (
        <div className={`text-2xl font-bold tracking-tight ${accent ? "text-[#FFD54A]" : warn ? "text-amber-700" : "text-foreground"}`}>
          {value ?? "—"}
        </div>
      )}
      {sub && (
        <div className={`text-xs mt-1 ${accent ? "text-white/60" : warn ? "text-amber-500" : "text-muted-foreground"}`}>
          {sub}
        </div>
      )}
    </div>
  );
}

function Panel({ title, children, warn }: { title: string; children: React.ReactNode; warn?: boolean }) {
  return (
    <div className={`rounded-xl border shadow-sm bg-white p-5 ${warn ? "border-amber-200" : "border-border"}`}>
      <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-4">{title}</h3>
      {children}
    </div>
  );
}

function Stat({ label, value, loading, highlight }: {
  label: string; value?: string; loading?: boolean; highlight?: boolean;
}) {
  return (
    <div className={`rounded-lg p-3 ${highlight ? "bg-[#0B5D2A]/5 border border-[#0B5D2A]/20" : "bg-muted/40"}`}>
      <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
      {loading ? (
        <div className="h-5 w-20 rounded animate-pulse bg-muted" />
      ) : (
        <div className={`text-base font-semibold ${highlight ? "text-[#0B5D2A]" : ""}`}>{value ?? "—"}</div>
      )}
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  const cls = rank === 1 ? "bg-yellow-100 text-yellow-700" : rank === 2 ? "bg-slate-100 text-slate-500" : rank === 3 ? "bg-orange-100 text-orange-600" : "bg-muted text-muted-foreground";
  return <div className={`w-6 h-6 rounded text-xs font-bold flex items-center justify-center shrink-0 ${cls}`}>{rank}</div>;
}

function LoadingRows({ n }: { n: number }) {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="h-9 rounded animate-pulse bg-muted" />
      ))}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="text-center py-8 text-sm text-muted-foreground">{text}</div>;
}
