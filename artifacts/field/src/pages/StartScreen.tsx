// T001/T002 — Bosh sahifa: progress halqa, bugungi daromad kartasi
// (kechaga nisbatan %), kichik kartalar va aqlli boshlash tugmasi.

import { useFieldMe, useFieldRouteToday, useFieldStatsToday } from "@/lib/fieldApi";
import { formatCurrency, estimateFinishTime } from "@/lib/utils";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import ProgressRing from "@/components/ProgressRing";
import {
  CheckCircle,
  Play,
  TrendingUp,
  TrendingDown,
  MapPin,
  Clock,
  XCircle,
  RotateCcw,
  CheckCircle2,
  BarChart3,
} from "lucide-react";

export default function StartScreen() {
  const { data: me } = useFieldMe();
  const { data: route, isLoading } = useFieldRouteToday();
  // Statistika ixtiyoriy bezak — bu so'rov holatiga qarab early-return QILMAYMIZ
  // (bitta gate qoidasi), yo'q bo'lsa shunchaki ko'rsatilmaydi.
  const { data: stats } = useFieldStatsToday();
  const [, setLocation] = useLocation();

  if (isLoading || !me || !route) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-pulse flex flex-col items-center gap-4">
          <div className="w-16 h-16 bg-muted rounded-full"></div>
          <div className="w-32 h-4 bg-muted rounded"></div>
        </div>
      </div>
    );
  }

  if (route.dam) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <div className="w-24 h-24 bg-green-100 text-green-600 rounded-full flex items-center justify-center mb-6">
          <CheckCircle className="w-12 h-12" />
        </div>
        <h1 className="text-3xl font-bold mb-2">Dam olish kuni</h1>
        <p className="text-muted-foreground text-lg">
          Bugun ({route.sana}) dam olish kuni. Yaxshi dam oling, {me.agent.name}!
        </p>
        <Button
          variant="outline"
          className="mt-8 h-12 px-6"
          onClick={() => setLocation("/stats")}
        >
          <BarChart3 className="mr-2 w-5 h-5" /> Statistika
        </Button>
      </div>
    );
  }

  const { stats: rs } = route;
  const progress = rs.total > 0 ? rs.done / rs.total : 0;
  const started = rs.done > 0;
  const finished = rs.total > 0 && rs.pending === 0;
  const pct = stats?.pctVsYesterday ?? null;

  return (
    <div className="flex-1 flex flex-col p-5 overflow-y-auto">
      {/* Salomlashish */}
      <div className="mt-4 mb-5 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight leading-snug">
            Assalomu alaykum,
            <br />
            <span className="text-primary">{me.agent.name}</span> 👋
          </h1>
          <p className="text-muted-foreground mt-1">
            {finished ? "Bugungi marshrut yakunlandi!" : "Bugungi marshrutingiz tayyor."}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="shrink-0" onClick={() => setLocation("/stats")}>
          <BarChart3 className="w-6 h-6 text-muted-foreground" />
        </Button>
      </div>

      {/* Progress halqa */}
      <div className="flex items-center gap-5 bg-card border rounded-2xl p-4 mb-4">
        <ProgressRing progress={progress} size={120} stroke={11}>
          <div className="text-3xl font-black text-primary">{Math.round(progress * 100)}%</div>
          <div className="text-[10px] text-muted-foreground font-medium uppercase">bajarildi</div>
        </ProgressRing>
        <div className="flex-1 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Jami</span>
            <span className="font-bold text-lg">{rs.total}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Bajarildi</span>
            <span className="font-bold text-lg text-green-600">{rs.done}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Qoldi</span>
            <span className="font-bold text-lg text-amber-600">{rs.pending}</span>
          </div>
        </div>
      </div>

      {/* Bugungi daromad */}
      <div className="bg-primary/5 border border-primary/20 rounded-2xl p-5 mb-4">
        <div className="text-xs font-semibold text-primary uppercase tracking-wider mb-1">
          Bugungi savdo
        </div>
        <div className="text-4xl font-black text-primary">
          {formatCurrency(rs.savdoSumma)} <span className="text-lg font-bold">so'm</span>
        </div>
        {pct !== null && (
          <div
            className={`mt-2 inline-flex items-center gap-1.5 text-sm font-bold rounded-full px-3 py-1 ${
              pct >= 0 ? "bg-green-500/15 text-green-600" : "bg-red-500/15 text-red-600"
            }`}
          >
            {pct >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
            {pct >= 0 ? "+" : ""}
            {pct}% <span className="font-medium opacity-80">kechaga nisbatan</span>
          </div>
        )}
      </div>

      {/* Kichik kartalar */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="bg-card border rounded-xl p-3.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium mb-1">
            <MapPin className="w-4 h-4 text-blue-500" /> Masofa
          </div>
          <div className="text-xl font-bold">{stats ? `${stats.km} km` : "—"}</div>
        </div>
        <div className="bg-card border rounded-xl p-3.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium mb-1">
            <Clock className="w-4 h-4 text-amber-500" /> Taxminiy tugash
          </div>
          <div className="text-xl font-bold">
            {finished ? "Tugadi" : estimateFinishTime(rs.pending, null)}
          </div>
        </div>
        <div className="bg-card border rounded-xl p-3.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium mb-1">
            <CheckCircle2 className="w-4 h-4 text-green-500" /> Savdo
          </div>
          <div className="text-xl font-bold text-green-600">{rs.sold}</div>
        </div>
        <div className="bg-card border rounded-xl p-3.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium mb-1">
            <XCircle className="w-4 h-4 text-red-500" /> Olinmadi
          </div>
          <div className="text-xl font-bold text-red-600">{rs.nosale}</div>
        </div>
        <div className="col-span-2 bg-card border rounded-xl p-3.5 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
            <RotateCcw className="w-4 h-4 text-violet-500" /> Qaytish tashriflari
          </div>
          <div className="text-xl font-bold text-violet-600">{stats?.qaytishTashriflar ?? 0}</div>
        </div>
      </div>

      {/* Aqlli boshlash tugmasi (T002) */}
      <div className="mt-auto pb-2">
        {finished ? (
          <Button
            size="lg"
            variant="outline"
            className="w-full text-lg h-16 rounded-2xl border-green-500/40 bg-green-500/5 text-green-700 hover:bg-green-500/10"
            onClick={() => setLocation("/summary")}
          >
            <CheckCircle className="mr-2 w-6 h-6" /> Bugungi ish tugadi
          </Button>
        ) : (
          <Button
            size="lg"
            className="w-full text-xl h-16 rounded-2xl shadow-lg font-bold"
            onClick={() => setLocation("/map")}
          >
            <Play className="mr-2 w-6 h-6 fill-current" />
            {started ? "Davom etish" : "Marshrutni boshlash"}
          </Button>
        )}
      </div>
    </div>
  );
}
