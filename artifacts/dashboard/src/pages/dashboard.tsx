import { 
  useGetDashboardToday, getGetDashboardTodayQueryKey,
  useGetDashboardMonthly, getGetDashboardMonthlyQueryKey,
  useGetTopWorkers, getGetTopWorkersQueryKey,
  useGetDailyChart, getGetDailyChartQueryKey
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { formatCurrency, formatNumber } from "@/lib/format";

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

  return (
    <div className="space-y-8">
      {/* Bugungi */}
      <div>
        <h2 className="text-lg font-medium tracking-tight mb-4 flex items-center">
          <span className="w-2 h-2 rounded-full bg-primary mr-2 animate-pulse" />
          BUGUNGI ISHLAB CHIQARISH
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard 
            title="Jami partiyalar" 
            value={today?.totalBatches} 
            loading={isLoadingToday} 
            formatter={formatNumber}
            testId="today-batches"
          />
          <MetricCard 
            title="Jami miqdor (dona)" 
            value={today?.totalQty} 
            loading={isLoadingToday} 
            formatter={formatNumber}
            testId="today-qty"
          />
          <MetricCard 
            title="Jami og'irlik (kg)" 
            value={today?.totalKg} 
            loading={isLoadingToday} 
            formatter={(v) => `${formatNumber(v)} kg`}
            testId="today-kg"
          />
          <MetricCard 
            title="Faol ishchilar" 
            value={today?.workerCount} 
            loading={isLoadingToday} 
            formatter={formatNumber}
            testId="today-workers"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          {/* Grafik */}
          <Card className="border-border">
            <CardHeader>
              <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">30 Kunlik grafik</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoadingChart ? (
                <Skeleton className="w-full h-[300px]" />
              ) : (
                <div className="h-[300px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData || []} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis 
                        dataKey="date" 
                        tickFormatter={(val) => val.split("-").slice(1).join("/")} 
                        tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                        axisLine={false}
                        tickLine={false}
                        dy={10}
                      />
                      <YAxis 
                        tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                        axisLine={false}
                        tickLine={false}
                        tickFormatter={(val) => `${val / 1000}k`}
                      />
                      <Tooltip 
                        cursor={{ fill: 'hsl(var(--muted))' }}
                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '4px' }}
                        formatter={(val: number) => [formatNumber(val), "Miqdor"]}
                        labelFormatter={(label) => `Sana: ${label}`}
                      />
                      <Bar dataKey="qty" fill="hsl(var(--primary))" radius={[2, 2, 0, 0]} name="Miqdor" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Oylik */}
          <div>
            <h2 className="text-xs font-bold uppercase tracking-wider mb-4 text-muted-foreground">Oylik Ko'rsatkichlar</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <MetricCard 
                title="Oylik miqdor" 
                value={monthly?.totalQty} 
                loading={isLoadingMonthly} 
                formatter={formatNumber}
                testId="monthly-qty"
              />
              <MetricCard 
                title="Oylik og'irlik" 
                value={monthly?.totalKg} 
                loading={isLoadingMonthly} 
                formatter={(v) => `${formatNumber(v)} kg`}
                testId="monthly-kg"
              />
              <MetricCard 
                title="Jami maosh" 
                value={monthly?.totalEarnings} 
                loading={isLoadingMonthly} 
                formatter={formatCurrency}
                testId="monthly-earnings"
                highlight
              />
            </div>
          </div>
        </div>

        {/* Top ishchilar */}
        <Card className="border-border">
          <CardHeader>
            <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">Eng Yaxshi Ishchilar (bu oy)</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoadingWorkers ? (
              <div className="space-y-4">
                {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : topWorkers?.length ? (
              <div className="space-y-4">
                {topWorkers.map((worker, idx) => (
                  <div key={worker.worker} className="flex items-center justify-between group" data-testid={`top-worker-${idx}`}>
                    <div className="flex items-center gap-3">
                      <div className="w-6 h-6 rounded bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground">
                        {idx + 1}
                      </div>
                      <div>
                        <div className="font-medium">{worker.worker}</div>
                        <div className="text-xs text-muted-foreground">{formatNumber(worker.totalQty)} dona</div>
                      </div>
                    </div>
                    <div className="text-right font-mono text-sm">
                      {formatCurrency(worker.totalEarnings)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground text-sm">
                Bu oyda ma'lumot yo'q
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function MetricCard({ title, value, loading, formatter = (v: any) => v, highlight = false, testId }: any) {
  return (
    <Card className={`border-border ${highlight ? 'bg-sidebar text-sidebar-foreground border-sidebar-border' : ''}`} data-testid={testId}>
      <CardContent className="p-5">
        <div className={`text-xs font-bold uppercase tracking-wider mb-2 ${highlight ? 'text-sidebar-foreground/70' : 'text-muted-foreground'}`}>
          {title}
        </div>
        {loading ? (
          <Skeleton className={`h-8 w-24 ${highlight ? 'bg-sidebar-accent' : ''}`} />
        ) : (
          <div className="text-2xl font-semibold tracking-tight">
            {value !== undefined ? formatter(value) : "—"}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
