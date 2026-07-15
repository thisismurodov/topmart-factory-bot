// T010 — Agent statistikasi: bugungi ko'rsatkichlar + haftalik progress.
// Ma'lumot: /api/field/stats/today va /api/field/stats/week.

import { useMemo } from "react";
import { useLocation } from "wouter";
import { useFieldRouteToday, useFieldStatsToday, useFieldStatsWeek } from "@/lib/fieldApi";
import { formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  TrendingUp,
  TrendingDown,
  MapPin,
  CheckCircle2,
  XCircle,
  Wallet,
  CreditCard,
  RotateCcw,
  Target,
} from "lucide-react";

const KUN_QISQA = ["Du", "Se", "Ch", "Pa", "Ju", "Sh", "Ya"];

function kunLabel(sana: string): string {
  // sana: YYYY-MM-DD → hafta kuni qisqartmasi
  const d = new Date(`${sana}T12:00:00`);
  const idx = (d.getDay() + 6) % 7; // Dushanba=0
  return KUN_QISQA[idx] ?? "";
}

export default function StatsScreen() {
  const [, setLocation] = useLocation();
  const { data: stats, isLoading } = useFieldStatsToday();
  const { data: week } = useFieldStatsWeek();
  const { data: route } = useFieldRouteToday();

  const maxWeekSumma = useMemo(() => {
    if (!week) return 0;
    return Math.max(...week.days.map((d) => d.summa), 1);
  }, [week]);

  if (isLoading || !stats) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-4 border-primary border-r-4 border-r-transparent"></div>
      </div>
    );
  }

  const done = route?.stats.done ?? 0;
  const total = route?.stats.total ?? 0;
  const conversion =
    stats.savdolar + stats.olinmadi > 0
      ? Math.round((stats.savdolar / (stats.savdolar + stats.olinmadi)) * 100)
      : null;
  const efficiency = total > 0 ? Math.round((done / total) * 100) : null;

  const pct = stats.pctVsYesterday;

  return (
    <div className="flex-1 flex flex-col bg-background h-full overflow-y-auto">
      <div className="p-4 border-b bg-card sticky top-0 z-10 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => setLocation("/")}>
          <ArrowLeft />
        </Button>
        <h2 className="font-bold text-lg flex-1">Mening statistikam</h2>
      </div>

      <div className="p-5 pb-10">
        {/* Bugungi savdo — asosiy karta */}
        <div className="bg-primary/5 border border-primary/20 rounded-2xl p-5 mb-4">
          <div className="text-sm font-medium text-primary uppercase tracking-wider mb-1">
            Bugungi savdo
          </div>
          <div className="text-4xl font-black text-primary mb-2">
            {formatCurrency(stats.savdoSumma)} <span className="text-lg font-bold">so'm</span>
          </div>
          {pct !== null && (
            <div
              className={`inline-flex items-center gap-1.5 text-sm font-bold rounded-full px-3 py-1 ${
                pct >= 0 ? "bg-green-500/15 text-green-600" : "bg-red-500/15 text-red-600"
              }`}
            >
              {pct >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
              {pct >= 0 ? "+" : ""}
              {pct}% kechaga nisbatan
            </div>
          )}
        </div>

        {/* Ko'rsatkichlar to'ri */}
        <div className="grid grid-cols-2 gap-3 mb-6">
          <div className="bg-card border rounded-xl p-4">
            <CheckCircle2 className="w-5 h-5 text-green-500 mb-2" />
            <div className="text-2xl font-bold text-green-600">{stats.savdolar}</div>
            <div className="text-xs text-muted-foreground font-medium">Savdolar</div>
          </div>
          <div className="bg-card border rounded-xl p-4">
            <XCircle className="w-5 h-5 text-red-500 mb-2" />
            <div className="text-2xl font-bold text-red-600">{stats.olinmadi}</div>
            <div className="text-xs text-muted-foreground font-medium">Olinmadi</div>
          </div>
          <div className="bg-card border rounded-xl p-4">
            <MapPin className="w-5 h-5 text-blue-500 mb-2" />
            <div className="text-2xl font-bold">{stats.km} km</div>
            <div className="text-xs text-muted-foreground font-medium">Bugungi masofa</div>
          </div>
          <div className="bg-card border rounded-xl p-4">
            <Target className="w-5 h-5 text-primary mb-2" />
            <div className="text-2xl font-bold">
              {efficiency !== null ? `${efficiency}%` : "—"}
            </div>
            <div className="text-xs text-muted-foreground font-medium">
              Bajarildi ({done}/{total})
            </div>
          </div>
          <div className="bg-card border rounded-xl p-4">
            <Wallet className="w-5 h-5 text-emerald-500 mb-2" />
            <div className="text-2xl font-bold text-emerald-600">
              {formatCurrency(stats.yigilganPul)}
            </div>
            <div className="text-xs text-muted-foreground font-medium">Yig'ilgan pul (so'm)</div>
          </div>
          <div className="bg-card border rounded-xl p-4">
            <CreditCard className="w-5 h-5 text-amber-500 mb-2" />
            <div className="text-2xl font-bold text-amber-600">
              {formatCurrency(stats.nasiyaQoldiq)}
            </div>
            <div className="text-xs text-muted-foreground font-medium">
              Nasiya qoldiq ({stats.nasiyaSoni} ta)
            </div>
          </div>
          <div className="bg-card border rounded-xl p-4">
            <RotateCcw className="w-5 h-5 text-violet-500 mb-2" />
            <div className="text-2xl font-bold text-violet-600">{stats.qaytishTashriflar}</div>
            <div className="text-xs text-muted-foreground font-medium">Qaytish tashriflari</div>
          </div>
          <div className="bg-card border rounded-xl p-4">
            <TrendingUp className="w-5 h-5 text-sky-500 mb-2" />
            <div className="text-2xl font-bold">{conversion !== null ? `${conversion}%` : "—"}</div>
            <div className="text-xs text-muted-foreground font-medium">Konversiya</div>
          </div>
        </div>

        {/* Haftalik progress */}
        <h3 className="font-bold mb-3">Haftalik progress</h3>
        {week && (
          <div className="bg-card border rounded-2xl p-4">
            <div className="flex items-end justify-between gap-2 h-36 mb-2">
              {week.days.map((d) => {
                const h = Math.max(4, Math.round((d.summa / maxWeekSumma) * 100));
                const isToday = d.sana === stats.sana;
                return (
                  <div key={d.sana} className="flex-1 flex flex-col items-center justify-end h-full gap-1">
                    <span className="text-[10px] text-muted-foreground font-medium">
                      {d.summa > 0 ? formatCurrency(Math.round(d.summa / 1000)) + "k" : ""}
                    </span>
                    <div
                      className={`w-full rounded-t-md transition-all ${
                        isToday ? "bg-primary" : "bg-primary/30"
                      }`}
                      style={{ height: `${h}%` }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between gap-2">
              {week.days.map((d) => (
                <div
                  key={d.sana}
                  className={`flex-1 text-center text-xs font-medium ${
                    d.sana === stats.sana ? "text-primary font-bold" : "text-muted-foreground"
                  }`}
                >
                  {kunLabel(d.sana)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
