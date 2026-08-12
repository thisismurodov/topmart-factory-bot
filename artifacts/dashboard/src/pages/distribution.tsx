import { authFetch } from "@/App";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Users, Store, ShoppingBag, CreditCard, Banknote, Wallet,
  MapPin, Phone, Search, X, Route as RouteIcon, CheckCircle2, XCircle, Truck, User,
  RefreshCw, ChevronDown, ChevronRight, TrendingUp, AlertCircle, Clock, Download,
} from "lucide-react";
import MapTab, { GeoNavLinks, sababLabel } from "@/components/distribution/MapTab";
import RouteWeekMap from "@/components/distribution/RouteWeekMap";
import AnalyticsTab from "@/components/distribution/AnalyticsTab";
import BadCoordPanel from "@/components/distribution/BadCoordPanel";
import ShopLocationEditor from "@/components/distribution/ShopLocationEditor";
import { downloadCsv, toCsv } from "@/lib/csv";

// ── Helpers ─────────────────────────────────────────────────────────────────────
import DailyVisitsMap from "@/components/distribution/DailyVisitsMap";
const fmtSom = (n: number) => `${Math.round(n).toLocaleString("uz-UZ")} so'm`;
const fmtDate = (s: string | null) => (s ? s.slice(0, 10) : "—");
const fmtDateTime = (s: string | null) => (s ? `${s.slice(0, 10)} ${s.slice(11, 16)}` : "—");

function PaymentBadge({ type }: { type: string | null }) {
  if (type === "naqd")
    return <Badge className="bg-green-100 text-green-700 border-green-200 gap-1 h-5 text-[10px]"><Banknote className="w-2.5 h-2.5" /> Naqd</Badge>;
  if (type === "nasiya")
    return <Badge variant="outline" className="text-amber-600 border-amber-300 gap-1 h-5 text-[10px]"><CreditCard className="w-2.5 h-2.5" /> Nasiya</Badge>;
  if (type === "aralash")
    return <Badge variant="outline" className="text-blue-600 border-blue-300 gap-1 h-5 text-[10px]"><Wallet className="w-2.5 h-2.5" /> Aralash</Badge>;
  return <Badge variant="secondary" className="h-5 text-[10px]">{type || "—"}</Badge>;
}

// Sana yordamchilari — barcha hisoblar Asia/Tashkent kalendarida
function isoDay(d: Date): string {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function tashkentToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent" }).format(new Date());
}
function presetRange(preset: string, from?: string, to?: string): { from?: string; to?: string } {
  const today = tashkentToday();
  // Toshkent sanasidan mahalliy Date yasab arifmetika qilamiz (vaqt zonasi ta'sir qilmaydi)
  const base = new Date(`${today}T12:00:00`);
  if (preset === "today") return { from: today, to: today };
  if (preset === "yesterday") {
    const y = new Date(base); y.setDate(y.getDate() - 1);
    const s = isoDay(y); return { from: s, to: s };
  }
  if (preset === "week") {
    const w = new Date(base); const dow = (w.getDay() + 6) % 7; w.setDate(w.getDate() - dow);
    return { from: isoDay(w), to: today };
  }
  if (preset === "month") return { from: today.slice(0, 8) + "01", to: today };
  if (preset === "custom") return { from, to };
  return {}; // all
}

// ── URL filter state ───────────────────────────────────────────────────────────
type Filters = {
  tab: string;
  preset: string;
  from?: string;
  to?: string;
  agentId?: string;
  viloyat?: string;
  hudud?: string;
  tolovTuri?: string;
  mahsulotId?: string;
  search?: string;
  kun?: string;
};

function useFilters(): [Filters, (patch: Partial<Filters>) => void] {
  const search = useSearch();
  const [, setLocation] = useLocation();
  const filters = useMemo<Filters>(() => {
    const p = new URLSearchParams(search);
    return {
      tab: p.get("tab") || "visits",
      preset: p.get("d") || "today",
      from: p.get("from") || undefined,
      to: p.get("to") || undefined,
      agentId: p.get("agent") || undefined,
      viloyat: p.get("viloyat") || undefined,
      hudud: p.get("hudud") || undefined,
      tolovTuri: p.get("tolov") || undefined,
      mahsulotId: p.get("mahsulot") || undefined,
      search: p.get("q") || undefined,
      kun: p.get("kun") || undefined,
    };
  }, [search]);

  const update = (patch: Partial<Filters>) => {
    const next = { ...filters, ...patch };
    const p = new URLSearchParams();
    if (next.tab !== "visits") p.set("tab", next.tab);
    if (next.preset !== "today") p.set("d", next.preset);
    if (next.preset === "custom") {
      if (next.from) p.set("from", next.from);
      if (next.to) p.set("to", next.to);
    }
    if (next.agentId) p.set("agent", next.agentId);
    if (next.viloyat) p.set("viloyat", next.viloyat);
    if (next.hudud) p.set("hudud", next.hudud);
    if (next.tolovTuri) p.set("tolov", next.tolovTuri);
    if (next.mahsulotId) p.set("mahsulot", next.mahsulotId);
    if (next.search) p.set("q", next.search);
    if (next.kun) p.set("kun", next.kun);
    const qs = p.toString();
    setLocation(`/distribution${qs ? `?${qs}` : ""}`, { replace: true });
  };
  return [filters, update];
}

function filterQuery(f: Filters, extra?: Record<string, string>): string {
  const { from, to } = presetRange(f.preset, f.from, f.to);
  const p = new URLSearchParams();
  if (from) p.set("from", from);
  if (to) p.set("to", to);
  if (f.agentId) p.set("agentId", f.agentId);
  if (f.viloyat) p.set("viloyat", f.viloyat);
  if (f.hudud) p.set("hudud", f.hudud);
  if (f.tolovTuri) p.set("tolovTuri", f.tolovTuri);
  if (f.mahsulotId) p.set("mahsulotId", f.mahsulotId);
  if (f.search) p.set("search", f.search);
  if (extra) for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

// ── Types ─────────────────────────────────────────────────────────────────────
type Summary = {
  activeAgents: number; shopsCount: number;
  salesCount: number; salesTotal: number;
  collectedTotal: number; outstandingTotal: number;
  nasiyaSalesTotal: number; nasiyaSalesCount: number;
  lastSaleAt: string | null;
  newShops: number; visitedShops: number;
  stale7: number; stale14: number; stale30: number;
};
type TodayActivity = {
  today: string;
  addedToday: number; visitedToday: number; soldToday: number;
  visitedNoSale: number; routePlanned: number; routeNotVisited: number;
};
type FilterDict = {
  agents: { id: number; name: string }[];
  viloyatlar: string[];
  hududlar: { viloyat: string | null; hudud: string }[];
  mahsulotlar: { id: number; nomi: string }[];
};
type Agent = {
  telegramId: number | null; name: string | null; viloyat: string | null; role: string | null;
  shops: number; salesCount: number; salesTotal: number; collected: number;
  noOrderVisits: number; visits: number; outstanding: number;
};
type Shop = {
  id: number; nomi: string | null; egasi: string | null; telefon: string | null;
  viloyat: string | null; hudud: string | null; holat: string | null;
  totalOrders: number; totalSales: number; lastOrderDate: string | null;
  agentName: string | null; outstanding: number;
};
type ShopIntel = Shop & {
  hasLocation: boolean; repeatOrders: number;
  lastVisit: string | null; status: "faol" | "risk" | "muammo";
};
type ShopsPage = { page: number; pageSize: number; total: number; rows: ShopIntel[] };
type Sale = {
  id: number; createdAt: string | null; total: number; tolovTuri: string | null;
  agentName: string | null; dokonId: number | null; dokonName: string | null;
  viloyat: string | null; hudud: string | null; items: string | null;
};
type Debt = {
  dokonId: number; dokonName: string | null; telefon: string | null; viloyat: string | null;
  hudud: string | null; agentName: string | null; outstanding: number; entries: number;
  lastUpdate: string | null; lastPayment: string | null;
};
type ShopDetail = Shop & {
  createdAt: string | null; balans: number;
  latitude: number | null; longitude: number | null;
  recentSales: { id: number; createdAt: string | null; total: number; tolovTuri: string | null; agentName: string | null; items: string | null }[];
  recentPayments: { id: number; createdAt: string | null; summa: number; agentName: string | null }[];
  openDebts: { id: number; total: number; paid: number; remaining: number; updatedAt: string | null }[];
  recentVisits: { id: number; createdAt: string | null; sabab: string | null; sababText: string | null; qaytishSanasi: string | null; bajarildi: number | null; agentName: string | null }[];
  locationChanges: {
    id: number; oldLatitude: number | null; oldLongitude: number | null;
    newLatitude: number | null; newLongitude: number | null;
    changedBy: string | null; createdAt: string | null;
  }[];
};
type RoutesData = {
  kun: number; kunlar: string[];
  routes: {
    agentId: number; agentName: string | null; mashinaNomeri: string | null; tartib: number;
    dokonId: number; dokonName: string | null; telefon: string | null;
    viloyat: string | null; hudud: string | null; visited: boolean;
    forceSaved: boolean; // crossing ogohlantirishlariga qaramay majburiy saqlangan
  }[];
};

function useDist<T>(key: unknown[], path: string, enabled = true) {
  return useQuery<T>({
    queryKey: ["distribution", ...key],
    queryFn: async () => {
      const r = await authFetch(`/api/distribution/${path}`);
      if (!r.ok) throw new Error("Ma'lumot yuklanmadi");
      return r.json();
    },
    enabled,
  });
}

// ── KPI kartalar ────────────────────────────────────────────────────────────────
function KpiCards({ f, update }: { f: Filters; update: (p: Partial<Filters>) => void }) {
  const qs = filterQuery(f);
  const { data, isLoading } = useDist<Summary>(["summary", qs], `summary${qs}`);
  const periodLabel =
    f.preset === "today" ? "Bugungi" :
    f.preset === "yesterday" ? "Kechagi" :
    f.preset === "week" ? "Haftalik" :
    f.preset === "month" ? "Oylik" :
    f.preset === "custom" ? "Davrdagi" : "Jami";

  const cards = [
    { label: "Faol agentlar", value: data?.activeAgents?.toString(), icon: Users, tone: "text-blue-600" },
    { label: "Faol do'konlar", value: data?.shopsCount?.toString(), icon: Store, tone: "text-emerald-600" },
    { label: `${periodLabel} savdo`, value: data ? fmtSom(data.salesTotal) : undefined, icon: ShoppingBag, tone: "text-primary" },
    { label: `${periodLabel} buyurtma`, value: data ? `${data.salesCount} ta` : undefined, icon: Truck, tone: "text-indigo-600" },
    { label: "Yig'ilgan pul", value: data ? fmtSom(data.collectedTotal) : undefined, icon: Wallet, tone: "text-green-600" },
    { label: `${periodLabel} nasiya`, value: data ? fmtSom(data.nasiyaSalesTotal) : undefined, icon: CreditCard, tone: "text-orange-600" },
    { label: "Nasiya qoldiq", value: data ? fmtSom(data.outstandingTotal) : undefined, icon: CreditCard, tone: "text-red-600" },
    { label: "Kirilgan do'konlar", value: data ? `${data.visitedShops} ta` : undefined, icon: CheckCircle2, tone: "text-teal-600" },
    { label: "Yangi do'konlar", value: data ? `${data.newShops} ta` : undefined, icon: MapPin, tone: "text-purple-600" },
  ];

  const showEmptyHint = !!data && data.salesCount === 0 && f.preset !== "all";

  const staleChips = data ? [
    { label: "7+ kun buyurtma yo'q", value: data.stale7, cls: "border-amber-300 bg-amber-50 text-amber-800", status: "risk" },
    { label: "14+ kun buyurtma yo'q", value: data.stale14, cls: "border-orange-300 bg-orange-50 text-orange-800", status: "risk" },
    { label: "30+ kun buyurtma yo'q", value: data.stale30, cls: "border-red-300 bg-red-50 text-red-800", status: "muammo" },
  ] : [];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9 gap-3">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <c.icon className={`w-4 h-4 ${c.tone}`} />
                <span className="text-xs text-muted-foreground">{c.label}</span>
              </div>
              {isLoading || c.value === undefined
                ? <Skeleton className="h-6 w-20" />
                : <div className="text-lg font-bold leading-tight">{c.value}</div>}
            </CardContent>
          </Card>
        ))}
      </div>
      {staleChips.some((s) => s.value > 0) && (
        <div className="flex flex-wrap gap-2">
          {staleChips.filter((s) => s.value > 0).map((s) => (
            <button
              key={s.label}
              type="button"
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ${s.cls}`}
              onClick={() => update({ tab: "shops" })}
              title="Do'konlar tabida ko'rish"
            >
              ⚠️ {s.label}: <b>{s.value} ta</b>
            </button>
          ))}
        </div>
      )}
      {showEmptyHint && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span>
            Tanlangan davr va filtrlar bo'yicha savdolar topilmadi.
            {data.lastSaleAt && <> Oxirgi savdo: <b>{fmtDate(data.lastSaleAt)}</b>.</>}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 border-amber-300 text-amber-800 hover:bg-amber-100"
            onClick={() => update({ preset: "all", from: undefined, to: undefined, agentId: undefined, viloyat: undefined, hudud: undefined, tolovTuri: undefined, mahsulotId: undefined, search: undefined })}
          >
            Hammasini ko'rish
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Bugungi do'kon faolligi vidjeti (har doim bugungi kun) ─────────────────────
function TodayActivityWidget({ f }: { f: Filters }) {
  // Faqat geo/agent filtrlarini uzatamiz — sana har doim bugun
  const p = new URLSearchParams();
  if (f.agentId) p.set("agentId", f.agentId);
  if (f.viloyat) p.set("viloyat", f.viloyat);
  if (f.hudud) p.set("hudud", f.hudud);
  const qs = p.toString() ? `?${p.toString()}` : "";
  const { data, isLoading } = useDist<TodayActivity>(["today-activity", qs], `today-activity${qs}`);

  const items = [
    { label: "Qo'shildi", value: data?.addedToday, tone: "text-purple-700" },
    { label: "Kirildi", value: data?.visitedToday, tone: "text-blue-700" },
    { label: "Savdo qilindi", value: data?.soldToday, tone: "text-green-700" },
    { label: "Kirildi, savdo yo'q", value: data?.visitedNoSale, tone: "text-amber-700" },
    { label: "Marshrutda, kirilmadi", value: data?.routeNotVisited, tone: "text-red-700" },
  ];

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <Store className="w-4 h-4 text-emerald-600" />
            Bugungi do'kon faolligi
            {data && <span className="text-[11px] font-normal text-muted-foreground">({data.today})</span>}
          </div>
          {items.map((it) => (
            <div key={it.label} className="flex items-baseline gap-1.5">
              {isLoading || it.value === undefined
                ? <Skeleton className="h-5 w-8" />
                : <span className={`text-base font-bold ${it.tone}`}>{it.value}</span>}
              <span className="text-xs text-muted-foreground">{it.label}</span>
            </div>
          ))}
          {data && data.routePlanned > 0 && (
            <span className="text-[11px] text-muted-foreground ml-auto">
              Bugungi marshrutda {data.routePlanned} ta do'kon
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Filtr paneli ────────────────────────────────────────────────────────────────
const PRESETS = [
  { v: "today", label: "Bugun" },
  { v: "yesterday", label: "Kecha" },
  { v: "week", label: "Shu hafta" },
  { v: "month", label: "Shu oy" },
  { v: "all", label: "Hammasi" },
  { v: "custom", label: "Maxsus" },
];

function FilterPanel({ f, update }: { f: Filters; update: (p: Partial<Filters>) => void }) {
  const { data: dict } = useDist<FilterDict>(["filters"], "filters");
  const [searchDraft, setSearchDraft] = useState(f.search ?? "");

  // URL tashqaridan o'zgarsa (orqaga/oldinga, deep-link) inputni sinxronlash
  useEffect(() => {
    setSearchDraft(f.search ?? "");
  }, [f.search]);

  const hududOptions = useMemo(() => {
    if (!dict) return [];
    const seen = new Set<string>();
    return dict.hududlar
      .filter((h) => !f.viloyat || h.viloyat === f.viloyat)
      .filter((h) => (seen.has(h.hudud) ? false : (seen.add(h.hudud), true)));
  }, [dict, f.viloyat]);

  const hasActive = !!(f.agentId || f.viloyat || f.hudud || f.tolovTuri || f.mahsulotId || f.search || f.preset !== "today");

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        {/* Sana presetlari */}
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => (
            <Button
              key={p.v}
              size="sm"
              variant={f.preset === p.v ? "default" : "outline"}
              className="h-8"
              onClick={() => update({ preset: p.v })}
            >
              {p.label}
            </Button>
          ))}
          {f.preset === "custom" && (
            <div className="flex items-center gap-2">
              <Input type="date" className="h-8 w-36" value={f.from ?? ""} onChange={(e) => update({ from: e.target.value })} />
              <span className="text-muted-foreground text-sm">—</span>
              <Input type="date" className="h-8 w-36" value={f.to ?? ""} onChange={(e) => update({ to: e.target.value })} />
            </div>
          )}
          {hasActive && (
            <Button size="sm" variant="ghost" className="h-8 text-muted-foreground" onClick={() => { setSearchDraft(""); update({ preset: "today", from: undefined, to: undefined, agentId: undefined, viloyat: undefined, hudud: undefined, tolovTuri: undefined, mahsulotId: undefined, search: undefined }); }}>
              <X className="w-3.5 h-3.5 mr-1" /> Tozalash
            </Button>
          )}
        </div>

        {/* Tanlov filtrlari */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
          <Select value={f.agentId ?? "all"} onValueChange={(v) => update({ agentId: v === "all" ? undefined : v })}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Agent" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Barcha agentlar</SelectItem>
              {dict?.agents.map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}
            </SelectContent>
          </Select>

          <Select value={f.viloyat ?? "all"} onValueChange={(v) => update({ viloyat: v === "all" ? undefined : v, hudud: undefined })}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Viloyat" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Barcha viloyatlar</SelectItem>
              {dict?.viloyatlar.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
            </SelectContent>
          </Select>

          <Select value={f.hudud ?? "all"} onValueChange={(v) => update({ hudud: v === "all" ? undefined : v })}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Tuman" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Barcha tumanlar</SelectItem>
              {hududOptions.map((h) => <SelectItem key={h.hudud} value={h.hudud}>{h.hudud}</SelectItem>)}
            </SelectContent>
          </Select>

          <Select value={f.tolovTuri ?? "all"} onValueChange={(v) => update({ tolovTuri: v === "all" ? undefined : v })}>
            <SelectTrigger className="h-9"><SelectValue placeholder="To'lov turi" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Barcha to'lovlar</SelectItem>
              <SelectItem value="naqd">Naqd</SelectItem>
              <SelectItem value="nasiya">Nasiya</SelectItem>
              <SelectItem value="aralash">Aralash</SelectItem>
            </SelectContent>
          </Select>

          <Select value={f.mahsulotId ?? "all"} onValueChange={(v) => update({ mahsulotId: v === "all" ? undefined : v })}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Mahsulot" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Barcha mahsulotlar</SelectItem>
              {dict?.mahsulotlar.map((m) => <SelectItem key={m.id} value={String(m.id)}>{m.nomi}</SelectItem>)}
            </SelectContent>
          </Select>

          <form
            className="relative"
            onSubmit={(e) => { e.preventDefault(); update({ search: searchDraft || undefined }); }}
          >
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              className="h-9 pl-8"
              placeholder="Do'kon qidirish…"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              onBlur={() => { if ((f.search ?? "") !== searchDraft) update({ search: searchDraft || undefined }); }}
            />
          </form>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Loading skeleton ────────────────────────────────────────────────────────────
function TableSkeleton({ cols }: { cols: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex gap-3">
          {Array.from({ length: cols }).map((_, j) => <Skeleton key={j} className="h-6 flex-1" />)}
        </div>
      ))}
    </div>
  );
}

function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="text-center text-muted-foreground py-10">{text}</TableCell>
    </TableRow>
  );
}

// ── Do'kon drawer (drill-down) ──────────────────────────────────────────────────
function ShopDrawer({ shopId, onClose }: { shopId: number | null; onClose: () => void }) {
  const { data, isLoading } = useDist<ShopDetail>(["shop", shopId], `shops/${shopId}`, shopId !== null);

  // Tashriflar tarixi (timeline): savdolar (yashil) + olmagan tashriflar (qizil) birga, sana bo'yicha
  type TimelineEv = {
    key: string; at: string | null; kind: "sale" | "visit";
    total?: number; tolovTuri?: string | null; items?: string | null;
    sabab?: string | null; sababText?: string | null; qaytishSanasi?: string | null; bajarildi?: number | null;
    agentName: string | null;
  };
  const timeline: TimelineEv[] = data
    ? [
        ...data.recentSales.map<TimelineEv>((s) => ({
          key: `s${s.id}`, at: s.createdAt, kind: "sale",
          total: s.total, tolovTuri: s.tolovTuri, items: s.items, agentName: s.agentName,
        })),
        ...(data.recentVisits ?? []).map<TimelineEv>((v) => ({
          key: `v${v.id}`, at: v.createdAt, kind: "visit",
          sabab: v.sabab, sababText: v.sababText, qaytishSanasi: v.qaytishSanasi, bajarildi: v.bajarildi, agentName: v.agentName,
        })),
      ].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    : [];

  return (
    <Sheet open={shopId !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center shrink-0">
              <Store className="w-4 h-4 text-emerald-700" />
            </span>
            {isLoading ? <Skeleton className="h-5 w-40" /> : data?.nomi || "Do'kon"}
          </SheetTitle>
        </SheetHeader>
        {isLoading || !data ? (
          <div className="space-y-3 mt-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : (
          <div className="space-y-5 mt-4 pb-8">
            {/* Holat + asosiy ma'lumot */}
            <div className="flex items-center gap-2">
              {data.holat === "faol"
                ? <Badge className="bg-green-100 text-green-700 border-green-200 h-6 px-2.5">✓ Faol do'kon</Badge>
                : <Badge variant="outline" className="h-6 px-2.5">{data.holat || "Holat noma'lum"}</Badge>}
              {data.outstanding > 0 && <Badge className="bg-red-100 text-red-700 border-red-200 h-6 px-2.5">Nasiya bor</Badge>}
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><div className="text-xs text-muted-foreground flex items-center gap-1"><User className="w-3 h-3" /> Egasi</div><div className="font-medium">{data.egasi || "—"}</div></div>
              <div>
                <div className="text-xs text-muted-foreground flex items-center gap-1"><Phone className="w-3 h-3" /> Telefon</div>
                <div className="font-medium">{data.telefon ? <a href={`tel:${data.telefon}`} className="hover:underline text-blue-700">{data.telefon}</a> : "—"}</div>
              </div>
              <div><div className="text-xs text-muted-foreground flex items-center gap-1"><MapPin className="w-3 h-3" /> Manzil</div><div className="font-medium">{[data.viloyat, data.hudud].filter(Boolean).join(", ") || "—"}</div></div>
              <div><div className="text-xs text-muted-foreground flex items-center gap-1"><Truck className="w-3 h-3" /> Agent</div><div className="font-medium">{data.agentName || "—"}</div></div>
              <div><div className="text-xs text-muted-foreground flex items-center gap-1"><ShoppingBag className="w-3 h-3" /> Oxirgi buyurtma</div><div className="font-medium">{fmtDate(data.lastOrderDate)}</div></div>
            </div>

            {/* GPS joylashuv — ko'rish va tahrirlash */}
            <ShopLocationEditor shopId={data.id} latitude={data.latitude} longitude={data.longitude} />

            {/* Joylashuv o'zgarishlari tarixi (kim pinni ko'chirdi) */}
            {(data.locationChanges ?? []).length > 0 && (
              <div>
                <div className="text-sm font-semibold mb-2 flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5" /> Joylashuv o'zgarishlari</div>
                <div className="space-y-1.5">
                  {data.locationChanges.map((c) => (
                    <div key={c.id} className="border rounded-md p-2.5 text-xs space-y-0.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">{fmtDateTime(c.createdAt)}</span>
                        <span className="font-medium">{c.changedBy || "—"}</span>
                      </div>
                      <div className="text-muted-foreground">
                        {c.oldLatitude !== null && c.oldLongitude !== null
                          ? `${c.oldLatitude.toFixed(6)}, ${c.oldLongitude.toFixed(6)}`
                          : "(koordinata yo'q)"}
                        {" → "}
                        <span className="text-foreground font-medium">
                          {c.newLatitude !== null && c.newLongitude !== null
                            ? `${c.newLatitude.toFixed(6)}, ${c.newLongitude.toFixed(6)}`
                            : "(o'chirildi)"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Yo'l ko'rsatish (navigatsiya) */}
            {data.latitude !== null && data.longitude !== null && (
              <GeoNavLinks lat={data.latitude} lng={data.longitude} />
            )}

            {/* Moliyaviy xulosalar — teng balandlikdagi kartalar */}
            <div className="grid grid-cols-3 gap-2 items-stretch">
              <div className="rounded-md border p-3 flex flex-col justify-between">
                <div className="text-[11px] text-muted-foreground">Jami savdo</div>
                <div className="text-sm font-bold">{fmtSom(data.totalSales)}</div>
                <div className="text-[11px] text-muted-foreground">{data.totalOrders} buyurtma</div>
              </div>
              <div className="rounded-md border p-3 flex flex-col justify-between">
                <div className="text-[11px] text-muted-foreground">Nasiya qoldiq</div>
                <div className={`text-sm font-bold ${data.outstanding > 0 ? "text-red-600" : ""}`}>{data.outstanding > 0 ? fmtSom(data.outstanding) : "—"}</div>
                <div className="text-[11px] text-transparent select-none">.</div>
              </div>
              <div className="rounded-md border p-3 flex flex-col justify-between">
                <div className="text-[11px] text-muted-foreground">Balans</div>
                <div className={`text-sm font-bold ${data.balans > 0 ? "text-green-700" : ""}`}>{data.balans !== 0 ? fmtSom(data.balans) : "—"}</div>
                <div className="text-[11px] text-transparent select-none">.</div>
              </div>
            </div>

            {/* Tashriflar tarixi — timeline (savdo=yashil, olmagan=qizil) */}
            <div>
              <div className="text-sm font-semibold mb-2 flex items-center gap-1.5"><ShoppingBag className="w-3.5 h-3.5" /> Tashriflar tarixi</div>
              {timeline.length === 0 ? (
                <div className="text-sm text-muted-foreground py-3 text-center border rounded-md">Hozircha tarix yo'q</div>
              ) : (
                <div className="relative pl-4 space-y-3">
                  <span className="absolute left-[5px] top-2 bottom-2 w-px bg-border" aria-hidden />
                  {timeline.map((ev) => (
                    <div key={ev.key} className="relative">
                      <span
                        className="absolute -left-4 top-1.5 w-3 h-3 rounded-full border-2 border-background shadow"
                        style={{ background: ev.kind === "sale" ? "#16a34a" : "#dc2626" }}
                        aria-hidden
                      />
                      <div className="border rounded-md p-2.5 text-sm ml-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs text-muted-foreground">{fmtDateTime(ev.at ?? null)}</span>
                          {ev.kind === "sale" ? (
                            <div className="flex items-center gap-2">
                              <PaymentBadge type={ev.tolovTuri ?? null} />
                              <span className="font-semibold whitespace-nowrap text-green-700">{fmtSom(ev.total ?? 0)}</span>
                            </div>
                          ) : (
                            <span className="text-xs font-medium text-red-600">{sababLabel(ev.sabab ?? null, ev.sababText ?? null) || "Olmadi"}</span>
                          )}
                        </div>
                        {ev.kind === "sale" && ev.items && <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{ev.items}</div>}
                        <div className="flex items-center justify-between gap-2 mt-0.5 text-[11px] text-muted-foreground">
                          <span>{ev.agentName ? `Agent: ${ev.agentName}` : ""}</span>
                          {ev.kind === "visit" && ev.qaytishSanasi && <span>🔁 Qaytish: {ev.qaytishSanasi}{ev.bajarildi ? " ✅" : ""}</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Ochiq nasiyalar */}
            {data.openDebts.length > 0 && (
              <div>
                <div className="text-sm font-semibold mb-2 flex items-center gap-1.5 text-red-600"><CreditCard className="w-3.5 h-3.5" /> Ochiq nasiyalar</div>
                <div className="space-y-1.5">
                  {data.openDebts.map((n) => (
                    <div key={n.id} className="flex items-center justify-between border rounded-md p-2.5 text-sm">
                      <span className="text-xs text-muted-foreground">{fmtDate(n.updatedAt)} • to'langan {fmtSom(n.paid)}</span>
                      <span className="font-bold text-red-600">{fmtSom(n.remaining)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Oxirgi to'lovlar */}
            {data.recentPayments.length > 0 && (
              <div>
                <div className="text-sm font-semibold mb-2 flex items-center gap-1.5 text-green-700"><Wallet className="w-3.5 h-3.5" /> Oxirgi to'lovlar</div>
                <div className="space-y-1.5">
                  {data.recentPayments.map((p) => (
                    <div key={p.id} className="flex items-center justify-between border rounded-md p-2.5 text-sm">
                      <span className="text-xs text-muted-foreground">{fmtDateTime(p.createdAt)}{p.agentName ? ` • ${p.agentName}` : ""}</span>
                      <span className="font-semibold text-green-700">{fmtSom(p.summa)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ── Savdolar tab ─────────────────────────────────────────────────────────────────
function SalesTab({ f, active, onShop }: { f: Filters; active: boolean; onShop: (id: number) => void }) {
  const qs = filterQuery(f);
  const { data, isLoading } = useDist<Sale[]>(["sales", qs], `sales${qs}`, active);
  if (isLoading) return <TableSkeleton cols={6} />;
  const total = data?.reduce((s, x) => s + x.total, 0) ?? 0;
  return (
    <div>
      {data && data.length > 0 && (
        <div className="px-4 py-2.5 border-b bg-muted/40 flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{data.length} ta savdo{data.length === 200 ? " (oxirgi 200)" : ""}</span>
          <span className="font-bold">{fmtSom(total)}</span>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Sana</TableHead>
            <TableHead>Do'kon</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Mahsulotlar</TableHead>
            <TableHead>To'lov</TableHead>
            <TableHead className="text-right">Summa</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!data || data.length === 0 ? <EmptyRow colSpan={6} text="Tanlangan filtrlar bo'yicha savdolar yo'q" /> : data.map((s) => (
            <TableRow
              key={s.id}
              className={s.dokonId ? "cursor-pointer" : undefined}
              onClick={() => { if (s.dokonId) onShop(s.dokonId); }}
            >
              <TableCell className="text-muted-foreground whitespace-nowrap">{fmtDateTime(s.createdAt)}</TableCell>
              <TableCell className="font-medium">{s.dokonName || "—"}{(s.viloyat || s.hudud) && <span className="block text-[11px] text-muted-foreground">{[s.viloyat, s.hudud].filter(Boolean).join(", ")}</span>}</TableCell>
              <TableCell>{s.agentName || "—"}</TableCell>
              <TableCell className="max-w-xs truncate text-xs text-muted-foreground">{s.items || "—"}</TableCell>
              <TableCell><PaymentBadge type={s.tolovTuri} /></TableCell>
              <TableCell className="text-right font-semibold whitespace-nowrap">{fmtSom(s.total)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Agentlar tab (kartochkalar) ──────────────────────────────────────────────────
function AgentsTab({ f, active }: { f: Filters; active: boolean }) {
  const qs = filterQuery(f);
  const { data, isLoading } = useDist<Agent[]>(["agents", qs], `agents${qs}`, active);
  if (isLoading) return <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3 p-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-44" />)}</div>;
  if (!data || data.length === 0) return <div className="text-center text-muted-foreground py-10">Agentlar yo'q</div>;
  const periodLabel = f.preset === "today" ? "Bugun" : f.preset === "yesterday" ? "Kecha" : f.preset === "week" ? "Shu hafta" : f.preset === "month" ? "Shu oy" : "Davr";
  return (
    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3 p-4">
      {data.map((a) => (
        <Card key={a.telegramId ?? a.name ?? "x"}>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-sm">
                  {(a.name || "?").slice(0, 1).toUpperCase()}
                </div>
                <div>
                  <div className="font-semibold text-sm">{a.name || "—"}</div>
                  <div className="text-[11px] text-muted-foreground">{a.viloyat || "—"}{a.role === "supervisor" ? " • supervisor" : ""}</div>
                </div>
              </div>
              <Badge variant="secondary" className="h-5 text-[10px]">{a.shops} do'kon</Badge>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-md bg-muted/50 p-2">
                <div className="text-[11px] text-muted-foreground">{periodLabel}: tashrif</div>
                <div className="font-bold">{a.visits} ta</div>
              </div>
              <div className="rounded-md bg-muted/50 p-2">
                <div className="text-[11px] text-muted-foreground">Savdo</div>
                <div className="font-bold">{a.salesCount} ta</div>
              </div>
              <div className="rounded-md bg-muted/50 p-2 col-span-2">
                <div className="text-[11px] text-muted-foreground">Savdo summasi</div>
                <div className="font-bold">{fmtSom(a.salesTotal)}</div>
              </div>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-green-700">Yig'ildi: {a.collected > 0 ? fmtSom(a.collected) : "—"}</span>
              <span className={a.outstanding > 0 ? "text-red-600 font-medium" : "text-muted-foreground"}>
                Nasiya: {a.outstanding > 0 ? fmtSom(a.outstanding) : "—"}
              </span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ── Do'konlar tab (Stores Intelligence jadvali) ──────────────────────────────────
function ShopStatusBadge({ status }: { status: ShopIntel["status"] }) {
  if (status === "faol")
    return <Badge className="bg-green-100 text-green-700 border-green-200 h-5 text-[10px]">🟢 Faol</Badge>;
  if (status === "risk")
    return <Badge className="bg-amber-100 text-amber-700 border-amber-200 h-5 text-[10px]">🟡 Risk</Badge>;
  return <Badge className="bg-red-100 text-red-700 border-red-200 h-5 text-[10px]">🔴 Muammo</Badge>;
}

const SHOP_STATUSES = [
  { v: "all", label: "Barchasi" },
  { v: "faol", label: "🟢 Faol" },
  { v: "risk", label: "🟡 Risk" },
  { v: "muammo", label: "🔴 Muammo" },
];

function ShopsTab({ f, active, onShop }: { f: Filters; active: boolean; onShop: (id: number) => void }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("all");
  const baseQs = filterQuery(f);

  // Filtr o'zgarsa birinchi sahifaga qaytamiz
  useEffect(() => { setPage(1); }, [baseQs, status]);

  const qs = filterQuery(f, {
    page: String(page),
    pageSize: "25",
    ...(status !== "all" ? { status } : {}),
  });
  const { data, isLoading } = useDist<ShopsPage>(["shops-intel", qs], `shops${qs}`, active);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div>
      <div className="px-4 py-2.5 border-b bg-muted/40 flex flex-wrap items-center gap-2">
        {SHOP_STATUSES.map((s) => (
          <Button
            key={s.v}
            size="sm"
            variant={status === s.v ? "default" : "outline"}
            className="h-7 text-xs"
            onClick={() => setStatus(s.v)}
          >
            {s.label}
          </Button>
        ))}
        {data && (
          <span className="text-xs text-muted-foreground ml-auto">{data.total} ta do'kon</span>
        )}
      </div>
      {isLoading ? (
        <TableSkeleton cols={8} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Do'kon</TableHead>
              <TableHead>Hudud</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Oxirgi tashrif</TableHead>
              <TableHead>Oxirgi savdo</TableHead>
              <TableHead className="text-right">Buyurtma</TableHead>
              <TableHead className="text-right">Nasiya</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!data || data.rows.length === 0 ? (
              <EmptyRow colSpan={8} text="Tanlangan filtrlar bo'yicha do'konlar yo'q" />
            ) : (
              data.rows.map((d) => (
                <TableRow key={d.id} className="cursor-pointer" onClick={() => onShop(d.id)}>
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-1.5">
                      {d.nomi || "—"}
                      {d.hasLocation && <MapPin className="w-3 h-3 text-emerald-600 shrink-0" />}
                    </span>
                    {d.telefon && <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Phone className="w-2.5 h-2.5" />{d.telefon}</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{[d.viloyat, d.hudud].filter(Boolean).join(", ") || "—"}</TableCell>
                  <TableCell className="text-xs">{d.agentName || "—"}</TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap">{fmtDate(d.lastVisit)}</TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap">{fmtDate(d.lastOrderDate)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {d.totalOrders} ta
                    {d.repeatOrders > 0 && <span className="text-[11px] text-muted-foreground"> ({d.repeatOrders} repeat)</span>}
                  </TableCell>
                  <TableCell className={`text-right whitespace-nowrap ${d.outstanding > 0 ? "text-red-600 font-semibold" : "text-muted-foreground"}`}>
                    {d.outstanding > 0 ? fmtSom(d.outstanding) : "—"}
                  </TableCell>
                  <TableCell><ShopStatusBadge status={d.status} /></TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}
      {data && data.total > data.pageSize && (
        <div className="flex items-center justify-between px-4 py-2.5 border-t text-sm">
          <span className="text-xs text-muted-foreground">
            {(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} / {data.total}
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-7" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Oldingi
            </Button>
            <span className="text-xs text-muted-foreground">{data.page} / {totalPages}</span>
            <Button size="sm" variant="outline" className="h-7" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Keyingi
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Nasiya tab ───────────────────────────────────────────────────────────────────
function DebtsTab({ f, active, onShop }: { f: Filters; active: boolean; onShop: (id: number) => void }) {
  const qs = filterQuery(f);
  const { data, isLoading } = useDist<Debt[]>(["debts", qs], `debts${qs}`, active);
  if (isLoading) return <TableSkeleton cols={5} />;
  const total = data?.reduce((s, d) => s + d.outstanding, 0) ?? 0;
  return (
    <div>
      {data && data.length > 0 && (
        <div className="px-4 py-3 border-b bg-red-50/50 flex items-center gap-2 text-sm">
          <CreditCard className="w-4 h-4 text-red-500" />
          <span className="text-muted-foreground">Umumiy nasiya qoldiq:</span>
          <span className="font-bold text-red-700">{fmtSom(total)}</span>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Do'kon</TableHead>
            <TableHead>Hudud</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead className="text-right">Yozuvlar</TableHead>
            <TableHead>Oxirgi to'lov</TableHead>
            <TableHead className="text-right">Qoldiq</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!data || data.length === 0 ? <EmptyRow colSpan={6} text="Nasiya yo'q" /> : data.map((d) => (
            <TableRow key={d.dokonId} className="cursor-pointer" onClick={() => onShop(d.dokonId)}>
              <TableCell className="font-medium">
                {d.dokonName || "—"}
                {d.telefon && <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Phone className="w-2.5 h-2.5" />{d.telefon}</span>}
              </TableCell>
              <TableCell className="text-muted-foreground">{[d.viloyat, d.hudud].filter(Boolean).join(", ") || "—"}</TableCell>
              <TableCell>{d.agentName || "—"}</TableCell>
              <TableCell className="text-right">{d.entries}</TableCell>
              <TableCell className="text-muted-foreground whitespace-nowrap">{fmtDate(d.lastPayment)}</TableCell>
              <TableCell className="text-right font-bold text-red-600 whitespace-nowrap">{fmtSom(d.outstanding)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Kunlik tashriflar tab ────────────────────────────────────────────────────────
type DailyStop = {
  dokonId: number; dokonName: string | null; viloyat: string | null; hudud: string | null;
  telefon: string | null; lat: number | null; lng: number | null;
  outcome: "sold" | "nosale" | "payment";
  sabab: string | null; sababText: string | null; qaytishSanasi: string | null;
  saleTotal: number | null; tolovTuri: string | null;
  createdAt: string | null; onRoute: boolean;
};
type DailyAgent = {
  agentId: number; agentName: string | null; mashinaNomeri: string | null; hudud: string | null;
  planned: number; visited: number; sold: number; noSale: number;
  salesTotal: number; salesCount: number; remaining: number;
  reasons: { sabab: string; cnt: number }[];
  trail: { lat: number; lng: number; at: string | null }[];
  stops: DailyStop[];
};
type DailyVisits = { date: string; kun: number; agents: DailyAgent[] };

const SABAB_LABELS: Record<string, string> = {
  yopiq: "🔒 Do'kon yopiq",
  budjet_yoq: "💸 Budjet yo'q",
  tovar_yetarli: "📦 Tovar yetarli",
  boshqa: "❓ Boshqa sabab",
  qaytib_kelaman: "🔁 Qaytib kelaman",
  rad_etdi: "🚫 Rad etdi",
};
function dailySababLabel(sabab: string | null, text: string | null): string {
  if (!sabab) return text || "Sabab ko'rsatilmadi";
  return SABAB_LABELS[sabab] ?? (text || sabab);
}

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function DailyAgentCard({ agent, onShop, open, onToggle }: { agent: DailyAgent; onShop: (id: number) => void; open: boolean; onToggle: () => void }) {
  const visitPct = agent.planned > 0 ? Math.round((agent.visited / agent.planned) * 100) : 0;
  const soldPct = agent.visited > 0 ? Math.round((agent.sold / agent.visited) * 100) : 0;

  const outcomeColor: Record<DailyStop["outcome"], string> = {
    sold: "bg-green-100 border-green-200 text-green-700",
    nosale: "bg-red-50 border-red-200 text-red-700",
    payment: "bg-blue-50 border-blue-200 text-blue-700",
  };
  const outcomeLabel: Record<DailyStop["outcome"], string> = {
    sold: "✅ Savdo",
    nosale: "❌ Olmadi",
    payment: "💳 To'lov",
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-sm shrink-0">
              {(agent.agentName || "?").slice(0, 1).toUpperCase()}
            </div>
            <div>
              <div className="font-semibold text-sm">{agent.agentName || "—"}</div>
              <div className="text-[11px] text-muted-foreground">
                {[agent.hudud, agent.mashinaNomeri].filter(Boolean).join(" • ") || "—"}
              </div>
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-base font-bold text-green-700">{fmtSom(agent.salesTotal)}</div>
            <div className="text-[11px] text-muted-foreground">{agent.salesCount} savdo</div>
          </div>
        </div>

        {/* Progress bars */}
        <div className="space-y-2">
          <div>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-muted-foreground">Tashrif</span>
              <span className="font-medium">{agent.visited} / {agent.planned} ta ({visitPct}%)</span>
            </div>
            <ProgressBar value={agent.visited} max={agent.planned} color="bg-indigo-500" />
          </div>
          {agent.visited > 0 && (
            <div>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-muted-foreground">Konversiya</span>
                <span className="font-medium">{agent.sold} savdo / {agent.visited} tashrif ({soldPct}%)</span>
              </div>
              <ProgressBar value={agent.sold} max={agent.visited} color="bg-green-500" />
            </div>
          )}
        </div>

        {/* Stats chips */}
        <div className="flex flex-wrap gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs bg-green-50 border-green-200 text-green-700">
            <CheckCircle2 className="w-3 h-3" /> {agent.sold} savdo
          </span>
          <span className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs bg-red-50 border-red-200 text-red-700">
            <XCircle className="w-3 h-3" /> {agent.noSale} olmadi
          </span>
          {agent.remaining > 0 && (
            <span className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs bg-amber-50 border-amber-200 text-amber-700">
              <Clock className="w-3 h-3" /> {agent.remaining} qoldi
            </span>
          )}
        </div>

        {/* Reasons breakdown */}
        {agent.reasons.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {agent.reasons.map((r) => (
              <span key={r.sabab} className="text-[11px] rounded-full border px-2 py-0.5 bg-muted/50 text-muted-foreground">
                {dailySababLabel(r.sabab, null)}: <b>{r.cnt}</b>
              </span>
            ))}
          </div>
        )}

        {/* Expand/collapse stops */}
        {agent.stops.length > 0 && (
          <div>
            <button
              type="button"
              onClick={onToggle}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              {agent.stops.length} ta tashrif tafsiloti
            </button>
            {open && (
              <div className="mt-2 space-y-1.5 max-h-80 overflow-y-auto pr-1">
                {agent.stops.map((s) => (
                  <div
                    key={`${s.dokonId}-${s.outcome}`}
                    className={`flex items-start justify-between gap-2 rounded-md border px-2.5 py-2 text-xs cursor-pointer hover:opacity-90 transition-opacity ${outcomeColor[s.outcome]}`}
                    onClick={() => onShop(s.dokonId)}
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate">{s.dokonName || "—"}</div>
                      {s.hudud && <div className="text-[11px] opacity-70">{[s.viloyat, s.hudud].filter(Boolean).join(", ")}</div>}
                      {s.outcome === "nosale" && s.sabab && (
                        <div className="text-[11px] mt-0.5 opacity-80">{dailySababLabel(s.sabab, s.sababText)}</div>
                      )}
                      {s.outcome === "nosale" && s.qaytishSanasi && (
                        <div className="text-[11px] mt-0.5 opacity-70">🔁 Qaytish: {s.qaytishSanasi}</div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-semibold">{outcomeLabel[s.outcome]}</div>
                      {s.saleTotal != null && s.saleTotal > 0 && (
                        <div className="text-[11px]">{fmtSom(s.saleTotal)}</div>
                      )}
                      <div className="text-[10px] opacity-60">{s.createdAt ? s.createdAt.slice(11, 16) : ""}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// CSV export — expanded stop ro'yxatidagi ma'lumotlarning aynan o'zi
const OUTCOME_CSV: Record<DailyStop["outcome"], string> = {
  sold: "Savdo",
  nosale: "Olmadi",
  payment: "To'lov",
};
function exportDailyVisitsCsv(data: DailyVisits) {
  const header = ["Agent", "Do'kon", "Natija", "Sabab", "Vaqt", "Summa"];
  const rows: string[][] = [];
  for (const a of data.agents) {
    for (const s of a.stops) {
      rows.push([
        a.agentName || "—",
        s.dokonName || "—",
        OUTCOME_CSV[s.outcome] ?? s.outcome,
        s.outcome === "nosale" ? dailySababLabel(s.sabab, s.sababText) : "",
        s.createdAt ? `${s.createdAt.slice(0, 10)} ${s.createdAt.slice(11, 16)}` : "",
        s.saleTotal != null && s.saleTotal > 0 ? String(Math.round(s.saleTotal)) : "",
      ]);
    }
  }
  // Agent bo'yicha jamlanma — ekrandagi agent kartalari bilan bir xil qiymatlar
  const summaryHeader = ["Agent", "Rejalashtirilgan", "Kirildi", "Savdo", "Olmadi", "Savdo jami", "Konversiya %"];
  const summaryRows: string[][] = data.agents.map((a) => [
    a.agentName || "—",
    String(a.planned),
    String(a.visited),
    String(a.sold),
    String(a.noSale),
    String(Math.round(a.salesTotal)),
    a.visited > 0 ? String(Math.round((a.sold / a.visited) * 100)) : "",
  ]);

  const all: string[][] = [
    ["Tashriflar"],
    header,
    ...rows,
    [""],
    ["Agentlar jamlanmasi"],
    summaryHeader,
    ...summaryRows,
  ];
  downloadCsv(toCsv(all), `kunlik-tashriflar-${data.date}.csv`);
}

function DailyVisitsTab({ f, active, onShop }: { f: Filters; active: boolean; onShop: (id: number) => void }) {
  // Ochilgan kartalar holati parent darajasida saqlanadi — refetch paytida yo'qolmaydi
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  // Xaritada ajratilgan agent — oxirgi ochilgan karta; yopilganda ochiq qolgan boshqa karta (bo'lsa)
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);
  const toggleExpanded = (agentId: number) =>
    setExpanded((prev) => {
      const willOpen = !prev[agentId];
      const next = { ...prev, [agentId]: willOpen };
      if (willOpen) {
        setSelectedAgentId(agentId);
      } else {
        setSelectedAgentId((cur) => {
          if (cur !== agentId) return cur;
          const other = Object.entries(next).find(([, v]) => v);
          return other ? Number(other[0]) : null;
        });
      }
      return next;
    });
  const p = new URLSearchParams();
  if (f.agentId) p.set("agentId", f.agentId);
  if (f.viloyat) p.set("viloyat", f.viloyat);
  if (f.hudud) p.set("hudud", f.hudud);
  // date: if preset is "today" or "yesterday" pass the specific date; else omit (defaults to today)
  const { from } = presetRange(f.preset, f.from, f.to);
  const isSingleDay = f.preset === "today" || f.preset === "yesterday" || (f.preset === "custom" && f.from === f.to);
  if (isSingleDay && from) p.set("date", from);
  const qs = p.toString() ? `?${p.toString()}` : "";

  const { data, isLoading, dataUpdatedAt, refetch, isFetching } = useQuery<DailyVisits>({
    queryKey: ["distribution", "daily-visits", qs],
    queryFn: async () => {
      const r = await authFetch(`/api/distribution/daily-visits${qs}`);
      if (!r.ok) throw new Error("Ma'lumot yuklanmadi");
      return r.json();
    },
    enabled: active,
    refetchInterval: active ? 30_000 : false, // 30 soniyada yangilanadi
  });

  const lastUpdated = dataUpdatedAt
    ? new Intl.DateTimeFormat("uz-UZ", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Tashkent" }).format(new Date(dataUpdatedAt))
    : null;

  if (!active) return null;

  // Summary totals
  const totals = data?.agents.reduce(
    (acc, a) => ({
      planned: acc.planned + a.planned,
      visited: acc.visited + a.visited,
      sold: acc.sold + a.sold,
      noSale: acc.noSale + a.noSale,
      salesTotal: acc.salesTotal + a.salesTotal,
    }),
    { planned: 0, visited: 0, sold: 0, noSale: 0, salesTotal: 0 }
  );

  return (
    <div className="p-4 space-y-4">
      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-indigo-600" />
          <span className="font-semibold text-sm">
            Kunlik tashriflar — {data?.date ?? "…"}
          </span>
          {!isSingleDay && (
            <span className="text-xs text-muted-foreground">(bugungi kun ko'rsatilmoqda)</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="w-3 h-3" /> {lastUpdated}
            </span>
          )}
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
            Yangilash
          </button>
          <button
            type="button"
            onClick={() => data && exportDailyVisitsCsv(data)}
            disabled={!data || data.agents.every((a) => a.stops.length === 0)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
            title="Kunlik tashriflarni CSV sifatida yuklab olish"
          >
            <Download className="w-3.5 h-3.5" />
            Export
          </button>
        </div>
      </div>

      {/* Summary strip */}
      {totals && !isLoading && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {[
            { label: "Rejalashtirilgan", value: `${totals.planned} ta`, tone: "text-indigo-700" },
            { label: "Kirildi", value: `${totals.visited} ta`, tone: "text-blue-700" },
            { label: "Savdo", value: `${totals.sold} ta`, tone: "text-green-700" },
            { label: "Olmadi", value: `${totals.noSale} ta`, tone: "text-red-600" },
            { label: "Savdo jami", value: fmtSom(totals.salesTotal), tone: "text-green-700 font-bold" },
          ].map((item) => (
            <div key={item.label} className="rounded-md border p-2.5 text-center">
              <div className="text-[11px] text-muted-foreground mb-0.5">{item.label}</div>
              <div className={`text-sm font-semibold ${item.tone}`}>{item.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Xarita: kirilgan do'konlar + agent GPS izi */}
      {data && data.agents.length > 0 && (
        <DailyVisitsMap agents={data.agents} onShop={onShop} selectedAgentId={selectedAgentId} />
      )}

      {/* Agent cards */}
      {isLoading ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-56" />)}
        </div>
      ) : !data || data.agents.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
          <AlertCircle className="w-8 h-8 opacity-40" />
          <div className="text-sm">Bugun hech bir agent tashrif amalga oshirmagan</div>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.agents.map((a) => (
            <DailyAgentCard
              key={a.agentId}
              agent={a}
              onShop={onShop}
              open={!!expanded[a.agentId]}
              onToggle={() => toggleExpanded(a.agentId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Marshrut tab ─────────────────────────────────────────────────────────────────
function RoutesTab({ f, update, active, onShop }: { f: Filters; update: (p: Partial<Filters>) => void; active: boolean; onShop: (id: number) => void }) {
  const kun = f.kun ?? "";
  const { data, isLoading } = useDist<RoutesData>(["routes", kun], `routes${kun ? `?kun=${kun}` : ""}`, active);

  const grouped = useMemo(() => {
    if (!data) return [];
    const m = new Map<number, { agentName: string | null; mashinaNomeri: string | null; stops: RoutesData["routes"] }>();
    for (const r of data.routes) {
      if (!m.has(r.agentId)) m.set(r.agentId, { agentName: r.agentName, mashinaNomeri: r.mashinaNomeri, stops: [] });
      m.get(r.agentId)!.stops.push(r);
    }
    return Array.from(m.values());
  }, [data]);

  return (
    <div className="p-4 space-y-4">
      {/* Haftalik marshrut xaritasi — har kun o'z rangida, marshrutsiz do'konlar kulrang */}
      <RouteWeekMap active={active} onShop={onShop} />

      {/* Koordinatasi yo'q yoki shubhali do'konlar — GPS tahrirlash */}
      <BadCoordPanel />

      <div className="flex flex-wrap gap-2">
        {(data?.kunlar ?? ["dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba", "yakshanba"]).map((k, i) => (
          <Button
            key={k}
            size="sm"
            variant={(data ? data.kun === i + 1 : false) ? "default" : "outline"}
            className="h-8 capitalize"
            onClick={() => update({ kun: String(i + 1) })}
          >
            {k}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <div className="grid md:grid-cols-2 gap-3">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-48" />)}</div>
      ) : grouped.length === 0 ? (
        <div className="text-center text-muted-foreground py-10">Bu kun uchun marshrut yo'q</div>
      ) : (
        <div className="grid md:grid-cols-2 gap-3">
          {grouped.map((g, gi) => {
            const done = g.stops.filter((s) => s.visited).length;
            return (
              <Card key={gi}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <RouteIcon className="w-4 h-4 text-indigo-600" />
                      <div>
                        <div className="font-semibold text-sm">{g.agentName || "—"}</div>
                        {g.mashinaNomeri && <div className="text-[11px] text-muted-foreground">{g.mashinaNomeri}</div>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {/* Audit belgisi: marshrut kesishish ogohlantirishiga qaramay majburiy saqlangan */}
                      {g.stops.some((s) => s.forceSaved) && (
                        <Badge
                          variant="outline"
                          className="h-5 text-[10px] border-amber-500 text-amber-700 dark:text-amber-400"
                          title="Bu marshrut kesishish ogohlantirishiga qaramay majburiy (force) saqlangan"
                        >
                          ⚠️ Majburiy saqlangan
                        </Badge>
                      )}
                      <Badge variant="secondary" className="h-5 text-[10px]">
                        {done}/{g.stops.length} do'kon
                      </Badge>
                    </div>
                  </div>
                  <div className="space-y-1">
                    {g.stops.map((s) => (
                      <div
                        key={`${s.dokonId}-${s.tartib}`}
                        className="flex items-center gap-2 text-sm py-1 px-1.5 rounded hover:bg-muted/50 cursor-pointer"
                        onClick={() => onShop(s.dokonId)}
                      >
                        {s.visited
                          ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" />
                          : <XCircle className="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />}
                        <span className="text-xs text-muted-foreground w-5 shrink-0">{s.tartib}.</span>
                        <span className="truncate">{s.dokonName || "—"}</span>
                        <span className="text-[11px] text-muted-foreground ml-auto shrink-0">{s.hudud || s.viloyat || ""}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Distribution() {
  const [f, update] = useFilters();
  const [shopId, setShopId] = useState<number | null>(null);

  // Xarita bitta sana bilan ishlaydi: davr bir kun bo'lsa — o'sha kun,
  // aks holda davr oxiri (yoki bugun — backend standarti)
  const mapDate = useMemo(() => {
    const { from, to } = presetRange(f.preset, f.from, f.to);
    return from && from === to ? from : to;
  }, [f.preset, f.from, f.to]);

  return (
    <div className="space-y-4">
      <KpiCards f={f} update={update} />
      <TodayActivityWidget f={f} />
      <FilterPanel f={f} update={update} />
      <Card>
        <CardContent className="pt-4">
          <Tabs value={f.tab} onValueChange={(t) => update({ tab: t })}>
            <TabsList className="flex-wrap h-auto">
              <TabsTrigger value="visits">🟢 Tashriflar</TabsTrigger>
              <TabsTrigger value="sales">Savdolar</TabsTrigger>
              <TabsTrigger value="agents">Agentlar</TabsTrigger>
              <TabsTrigger value="shops">Do'konlar</TabsTrigger>
              <TabsTrigger value="debts">Nasiya</TabsTrigger>
              <TabsTrigger value="routes">Marshrut</TabsTrigger>
              <TabsTrigger value="map">Xarita</TabsTrigger>
              <TabsTrigger value="analytics">Tahlil</TabsTrigger>
            </TabsList>
            <TabsContent value="visits" className="border rounded-md mt-4">
              <DailyVisitsTab f={f} active={f.tab === "visits"} onShop={setShopId} />
            </TabsContent>
            <TabsContent value="sales" className="border rounded-md mt-4 overflow-x-auto">
              <SalesTab f={f} active={f.tab === "sales"} onShop={setShopId} />
            </TabsContent>
            <TabsContent value="agents" className="border rounded-md mt-4">
              <AgentsTab f={f} active={f.tab === "agents"} />
            </TabsContent>
            <TabsContent value="shops" className="border rounded-md mt-4">
              <ShopsTab f={f} active={f.tab === "shops"} onShop={setShopId} />
            </TabsContent>
            <TabsContent value="debts" className="border rounded-md mt-4 overflow-x-auto">
              <DebtsTab f={f} active={f.tab === "debts"} onShop={setShopId} />
            </TabsContent>
            <TabsContent value="routes" className="border rounded-md mt-4">
              <RoutesTab f={f} update={update} active={f.tab === "routes"} onShop={setShopId} />
            </TabsContent>
            <TabsContent value="map" className="border rounded-md mt-4">
              <MapTab
                date={mapDate}
                agentId={f.agentId}
                viloyat={f.viloyat}
                hudud={f.hudud}
                search={f.search}
                active={f.tab === "map"}
                onShop={setShopId}
              />
            </TabsContent>
            <TabsContent value="analytics" className="border rounded-md mt-4">
              <AnalyticsTab qs={filterQuery(f)} active={f.tab === "analytics"} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
      <ShopDrawer shopId={shopId} onClose={() => setShopId(null)} />
    </div>
  );
}
