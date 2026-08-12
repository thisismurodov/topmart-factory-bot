import { useQuery } from "@tanstack/react-query";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";
import { authFetch } from "@/App";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Store, ShoppingBag, Repeat2, CreditCard, CalendarClock, TrendingUp, Route, Download,
} from "lucide-react";

// ── Turlar ──────────────────────────────────────────────────────────────────────
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
type AnalyticsData = {
  from: string | null;
  to: string | null;
  kpi: {
    visitedShops: number;
    soldShops: number;
    conversionPct: number | null;
    repeatPct: number | null;
    nasiyaPct: number | null;
    avgVisitsPerDay: number | null;
    salesCount: number;
    salesTotal: number;
    nasiyaCount: number;
  };
  daily: { date: string; visits: number; sales: number; salesTotal: number }[];
};

type AgentKmData = {
  from: string | null;
  to: string | null;
  summary: { totalKm: number; avgKmPerDay: number | null; kmPerSale: number | null };
  agents: {
    agentId: string;
    agentName: string | null;
    mashinaNomeri: string | null;
    days: number;
    totalKm: number;
    salesCount: number;
    avgKmPerDay: number | null;
    kmPerSale: number | null;
  }[];
  daily: {
    date: string;
    agentId: string;
    agentName: string | null;
    km: number;
    salesCount: number;
  }[];
};

// Agent chiziqlari uchun ranglar (takrorlansa aylanadi)
const AGENT_COLORS = [
  "#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed",
  "#0891b2", "#db2777", "#65a30d", "#9333ea", "#ea580c",
];

const fmtSom = (n: number) => `${Math.round(n).toLocaleString("uz-UZ")} so'm`;
const fmtKm = (n: number | null) => (n == null ? "—" : `${n.toLocaleString("uz-UZ")} km`);
const fmtPct = (v: number | null) => (v == null ? "—" : `${v}%`);

// Grafikda summani qisqa ko'rsatish (1.2 mln, 350 ming)
function shortSom(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} mln`;
  if (Math.abs(n) >= 1_000) return `${Math.round(n / 1_000)} ming`;
  return String(n);
}

// 2026-07-11 → 11.07
function shortDay(d: string): string {
  return d.length === 10 ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : d;
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: typeof Store;
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon className="w-3.5 h-3.5" />
          {label}
        </div>
        <div className={`text-xl font-bold mt-1 ${tone ?? ""}`}>{value}</div>
        {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}

export default function AnalyticsTab({ qs, active }: { qs: string; active: boolean }) {
  const [exporting, setExporting] = useState(false);

  // Joriy filtr tanlovi bilan XLSX (2 varaq) yoki CSV yuklab olish
  async function handleExport(format: "xlsx" | "csv") {
    setExporting(true);
    try {
      const sep = qs ? "&" : "?";
      const fq = format === "xlsx" ? `${qs}${sep}format=xlsx` : qs;
      const r = await authFetch(`/api/distribution/analytics/export${fq}`);
      if (!r.ok) throw new Error("Eksport muvaffaqiyatsiz");
      const cd = r.headers.get("Content-Disposition") ?? "";
      const m = cd.match(/filename="([^"]+)"/);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = m?.[1] ?? `tahlil.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      alert("Eksport qilishda xatolik yuz berdi. Qayta urinib ko'ring.");
    } finally {
      setExporting(false);
    }
  }

  const { data, isLoading } = useQuery<AnalyticsData>({
    queryKey: ["distribution", "analytics", qs],
    queryFn: async () => {
      const r = await authFetch(`/api/distribution/analytics${qs}`);
      if (!r.ok) throw new Error("Analitika yuklanmadi");
      return r.json();
    },
    enabled: active,
  });

  const { data: kmData, isLoading: kmLoading } = useQuery<AgentKmData>({
    queryKey: ["distribution", "agent-km", qs],
    queryFn: async () => {
      const r = await authFetch(`/api/distribution/agent-km${qs}`);
      if (!r.ok) throw new Error("Agent km ma'lumoti yuklanmadi");
      return r.json();
    },
    enabled: active,
  });

  if (isLoading || !data) {
    return (
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  const k = data.kpi;
  const chart = data.daily.map((d) => ({ ...d, kun: shortDay(d.date) }));

  // km trend: kunlar bo'yicha pivot — har agent alohida chiziq
  const kmAgents = (kmData?.agents ?? []).map((a) => ({
    id: a.agentId,
    name: a.agentName ?? `ID ${a.agentId}`,
  }));
  const kmTrend = (() => {
    if (!kmData?.daily?.length) return [] as Record<string, unknown>[];
    const byDate = new Map<string, Record<string, unknown>>();
    for (const d of kmData.daily) {
      let row = byDate.get(d.date);
      if (!row) {
        row = { date: d.date, kun: shortDay(d.date) };
        byDate.set(d.date, row);
      }
      row[`a${d.agentId}`] = d.km;
    }
    return [...byDate.values()].sort((x, y) =>
      String(x.date).localeCompare(String(y.date))
    );
  })();

  return (
    <div className="p-4 space-y-4">
      {/* Eksport */}
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={exporting}>
              <Download className="w-4 h-4 mr-1.5" />
              {exporting ? "Yuklanmoqda…" : "Yuklab olish"}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => handleExport("xlsx")}>
              Excel (.xlsx) — 2 varaq
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleExport("csv")}>
              CSV (.csv)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* KPI kartalar */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard
          icon={Store}
          label="Kirilgan do'konlar"
          value={String(k.visitedShops)}
          sub="savdo yoki tashrif qayd etilgan"
        />
        <StatCard
          icon={ShoppingBag}
          label="Konversiya"
          value={fmtPct(k.conversionPct)}
          sub={`${k.soldShops} ta do'kon sotib oldi`}
          tone="text-green-700"
        />
        <StatCard
          icon={Repeat2}
          label="Takroriy xaridorlar"
          value={fmtPct(k.repeatPct)}
          sub="davrgacha ham olgan do'konlar"
          tone="text-indigo-700"
        />
        <StatCard
          icon={CreditCard}
          label="Nasiya ulushi"
          value={fmtPct(k.nasiyaPct)}
          sub={`${k.nasiyaCount} ta nasiya/aralash savdo`}
          tone="text-amber-700"
        />
        <StatCard
          icon={CalendarClock}
          label="O'rtacha tashrif/kun"
          value={k.avgVisitsPerDay == null ? "—" : String(k.avgVisitsPerDay)}
          sub="do'konlar bo'yicha"
        />
        <StatCard
          icon={TrendingUp}
          label="Savdo"
          value={String(k.salesCount)}
          sub={fmtSom(k.salesTotal)}
          tone="text-green-700"
        />
      </div>

      {/* Kunlik grafik */}
      <div>
        <div className="text-sm font-semibold mb-2">Kunlik tashrif, savdo va tushum</div>
        {chart.length === 0 ? (
          <div className="text-sm text-muted-foreground border rounded-md py-8 text-center">
            Tanlangan davr uchun ma'lumot yo'q
          </div>
        ) : (
          <div className="h-72 border rounded-md p-2">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="kun" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="left" tick={{ fontSize: 11 }} allowDecimals={false} />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fontSize: 11 }}
                  tickFormatter={shortSom}
                  width={70}
                />
                <Tooltip
                  formatter={(value: number | string, name: string) =>
                    name === "Tushum" ? [fmtSom(Number(value)), name] : [value, name]
                  }
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar yAxisId="left" dataKey="visits" name="Tashrif (do'kon)" fill="#93c5fd" radius={[3, 3, 0, 0]} />
                <Bar yAxisId="left" dataKey="sales" name="Savdo (soni)" fill="#16a34a" radius={[3, 3, 0, 0]} />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="salesTotal"
                  name="Tushum"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Agent samaradorligi — GPS bo'yicha bosilgan km va km/savdo */}
      <div>
        <div className="text-sm font-semibold mb-2 flex items-center gap-1.5">
          <Route className="w-4 h-4" />
          Agent samaradorligi (bosilgan km)
        </div>
        {kmLoading ? (
          <Skeleton className="h-40" />
        ) : !kmData || kmData.agents.length === 0 ? (
          <div className="text-sm text-muted-foreground border rounded-md py-8 text-center">
            Tanlangan davr uchun GPS ma'lumoti yo'q
          </div>
        ) : (
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <div className="text-xs text-muted-foreground">Jami bosilgan</div>
                  <div className="text-lg font-bold">{fmtKm(kmData.summary.totalKm)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">O'rtacha km/kun</div>
                  <div className="text-lg font-bold">{fmtKm(kmData.summary.avgKmPerDay)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">km / savdo</div>
                  <div className="text-lg font-bold">{fmtKm(kmData.summary.kmPerSale)}</div>
                </div>
              </div>
              {kmTrend.length > 0 && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1.5">
                    Kunlik km dinamikasi (agent bo'yicha)
                  </div>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={kmTrend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                        <XAxis dataKey="kun" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} unit=" km" width={60} />
                        <Tooltip
                          formatter={(value: number | string, name: string) => [
                            `${Number(value).toLocaleString("uz-UZ")} km`,
                            name,
                          ]}
                        />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        {kmAgents.map((a, i) => (
                          <Line
                            key={a.id}
                            type="monotone"
                            dataKey={`a${a.id}`}
                            name={a.name}
                            stroke={AGENT_COLORS[i % AGENT_COLORS.length]}
                            strokeWidth={2}
                            dot={{ r: 2.5 }}
                            connectNulls
                          />
                        ))}
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b">
                      <th className="text-left py-1.5 pr-2 font-medium">Agent</th>
                      <th className="text-right py-1.5 px-2 font-medium">GPS kunlar</th>
                      <th className="text-right py-1.5 px-2 font-medium">Jami km</th>
                      <th className="text-right py-1.5 px-2 font-medium">km/kun</th>
                      <th className="text-right py-1.5 px-2 font-medium">Savdo</th>
                      <th className="text-right py-1.5 pl-2 font-medium">km/savdo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kmData.agents.map((a) => (
                      <tr key={a.agentId} className="border-b last:border-0">
                        <td className="py-1.5 pr-2">
                          {a.agentName ?? `ID ${a.agentId}`}
                          {a.mashinaNomeri && (
                            <span className="text-xs text-muted-foreground ml-1">
                              ({a.mashinaNomeri})
                            </span>
                          )}
                        </td>
                        <td className="text-right py-1.5 px-2">{a.days}</td>
                        <td className="text-right py-1.5 px-2">{fmtKm(a.totalKm)}</td>
                        <td className="text-right py-1.5 px-2">{fmtKm(a.avgKmPerDay)}</td>
                        <td className="text-right py-1.5 px-2">{a.salesCount}</td>
                        <td className="text-right py-1.5 pl-2">{fmtKm(a.kmPerSale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="text-[11px] text-muted-foreground">
                GPS nuqtalari orasidagi masofalar yig'indisi. 20 km dan katta sakrashlar
                (GPS xatosi) hisobga olinmaydi.
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
