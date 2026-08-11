import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import { authFetch } from "@/App";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Route as RouteIcon, Navigation, Lightbulb, AlertTriangle, RotateCcw, MapPinned, Maximize2, Minimize2, ChevronDown, ChevronUp, Home, Truck, Crosshair, Sparkles } from "lucide-react";

// ── Turlar ──────────────────────────────────────────────────────────────────────
type MapShop = {
  id: number;
  nomi: string | null;
  telefon: string | null;
  viloyat: string | null;
  hudud: string | null;
  holat: string | null;
  lat: number;
  lng: number;
  agentName: string | null;
  status: "sold" | "nosale" | "visited" | "planned" | "none";
  sabab: string | null;
  sababText: string | null;
  qaytishSanasi: string | null;
};

// Bot SABAB_MAP kodlari → o'zbekcha yorliq (sabab_text bo'lmasa fallback)
export const SABAB_LABELS: Record<string, string> = {
  narx_qimmat: "💸 Narx qimmat",
  tovari_bor: "📦 Hozir tovari bor",
  boshqa_firma: "🏢 Boshqa firma",
  sifat: "😕 Sifat yoqmadi",
  egasi_yoq: "🚪 Egasi yo'q edi",
  keyin_keling: "🕐 Keyin keling dedi",
  sotilmaydi: "🚫 Sotilmaydi dedi",
  boshqa: "📝 Boshqa sabab",
};

export function sababLabel(sabab: string | null, sababText: string | null): string | null {
  if (sababText) return sababText;
  if (sabab) return SABAB_LABELS[sabab] ?? sabab;
  return null;
}
type MapRouteStop = {
  agentId: number;
  agentName: string | null;
  mashinaNomeri: string | null;
  tartib: number;
  dokonId: number;
  dokonName: string | null;
  lat: number;
  lng: number;
  sold: boolean;
  visited: boolean;
};
type MapData = { date: string; kun: number; shops: MapShop[]; routes: MapRouteStop[] };
type LiveAgent = {
  agentId: number;
  agentName: string | null;
  mashinaNomeri: string | null;
  hudud: string | null;
  planned: number;
  visited: number;
  sold: number;
  remaining: number;
  salesTotal: number;
  salesCount: number;
  lastLocation: { lat: number; lng: number; at: string } | null;
};
type LiveStatusData = { date: string; kun: number; agents: LiveAgent[] };

// Issiqlik xaritasi (heatmap) turlari — bot get_store_status bilan bir xil sinflar
type HeatCls = "green" | "yellow" | "red" | "new";
type HeatShop = {
  id: number;
  nomi: string | null;
  viloyat: string | null;
  hudud: string | null;
  lat: number;
  lng: number;
  agentId: string | null;
  agentName: string | null;
  days: number | null;
  cls: HeatCls;
};
type HeatHudud = {
  viloyat: string | null;
  hudud: string | null;
  shopCount: number;
  green: number;
  yellow: number;
  red: number;
  new: number;
  cls: HeatCls;
  centroid: { lat: number; lng: number } | null;
};
type HeatData = { shops: HeatShop[]; hududlar: HeatHudud[] };

// Tavsiyalar turlari
type SuggestNearest = { dokonId: number; nomi: string | null; hudud: string | null; distKm: number; tartib: number | null };
type SuggestAgent = {
  agentId: string;
  agentName: string | null;
  mashinaNomeri: string | null;
  gps: { lat: number; lng: number; at: string };
  nearest: SuggestNearest[];
};
type SuggestOverdue = {
  dokonId: number;
  nomi: string | null;
  viloyat: string | null;
  hudud: string | null;
  agentName: string | null;
  days: number;
  avgRepeatDays: number;
};
type SuggestQaytish = {
  dokonId: number | string;
  nomi: string | null;
  viloyat: string | null;
  hudud: string | null;
  agentName: string | null;
  sabab: string | null;
  sababText: string | null;
  qaytishSanasi: string | null;
  dueIso: string | null;
};
type SuggestAi = {
  dokonId: number;
  nomi: string | null;
  hudud: string | null;
  agentName: string | null;
  score: number;
  reason: string;
};
type SuggestionsData = {
  date: string;
  kun: number;
  ai?: SuggestAi[] | null;
  agents: SuggestAgent[];
  overdue: SuggestOverdue[];
  qaytish: SuggestQaytish[];
};

type MapMode = "markers" | "heat" | "territory";

// Issiqlik sinflari — rang + izoh (bot bilan bir xil ma'no)
const CLS_META: Record<HeatCls, { color: string; label: string }> = {
  green: { color: "#16a34a", label: "Faol (yaqinda olgan)" },
  yellow: { color: "#eab308", label: "Sovumoqda" },
  red: { color: "#dc2626", label: "Yo'qotish xavfi" },
  new: { color: "#9ca3af", label: "Hali olmagan" },
};
const CLS_ORDER: HeatCls[] = ["green", "yellow", "red", "new"];

// Har 45 soniyada yangilanadi — agentlarning jonli oqimi uchun
const LIVE_REFETCH_MS = 45_000;

function fmtSom(n: number): string {
  return `${Math.round(n).toLocaleString("en-US").replace(/,/g, " ")} so'm`;
}

// created_at TEXT ISO — vaqt qismini (HH:MM) ko'rsatamiz
function locTime(at: string): string {
  return at.length >= 16 ? at.slice(11, 16) : at;
}

export type MapTabProps = {
  date?: string;
  agentId?: string;
  viloyat?: string;
  hudud?: string;
  search?: string;
  active: boolean;
  onShop: (id: number) => void;
};

// ── Marker holatlari (rang + izoh) ──────────────────────────────────────────────
const STATUS_META: Record<MapShop["status"], { color: string; label: string }> = {
  sold: { color: "#16a34a", label: "Savdo qilindi" },
  nosale: { color: "#dc2626", label: "Olmadi (sabab bor)" },
  visited: { color: "#2563eb", label: "Kirildi, savdo yo'q" },
  planned: { color: "#eab308", label: "Marshrutda, kutilmoqda" },
  none: { color: "#9ca3af", label: "Faoliyat yo'q" },
};
const STATUS_ORDER: MapShop["status"][] = ["sold", "nosale", "visited", "planned", "none"];

const ROUTE_COLORS = ["#6366f1", "#0ea5e9", "#f97316", "#14b8a6", "#a855f7", "#e11d48", "#84cc16", "#f59e0b"];

const KUN_NOMLARI = ["dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba", "yakshanba"];

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Holat markerlari: sold=✓ + yumshoq pulsatsiya, nosale=✕, visited/planned rangli, none kichik kulrang
function shopIcon(status: MapShop["status"]): L.DivIcon {
  const meta = STATUS_META[status];
  const size = status === "none" ? 14 : 20;
  const glyph = status === "sold" ? "✓" : status === "nosale" ? "✕" : "";
  const ring = status === "sold" ? `<span class="tm-ring" style="border-color:${meta.color}"></span>` : "";
  return L.divIcon({
    className: "",
    html: `<div class="tm-marker tm-pop" style="width:${size}px;height:${size}px;background:${meta.color}">${ring}<span class="tm-glyph">${glyph}</span></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function dotIcon(color: string, glow = false): L.DivIcon {
  const shadow = glow ? `box-shadow:0 0 0 6px ${color}33,0 1px 3px rgba(0,0,0,.45)` : "box-shadow:0 1px 3px rgba(0,0,0,.45)";
  return L.divIcon({
    className: "",
    html: `<div class="tm-pop" style="width:16px;height:16px;border-radius:50%;background:${color};border:2px solid #fff;${shadow}"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

// Agent jonli markeri — ko'k halo + pulsatsiya. `tm-live-marker` klassi
// setLatLng chaqirilganda markerni silliq siljitadi (CSS transition).
function truckIcon(): L.DivIcon {
  return L.divIcon({
    className: "tm-live-marker",
    html: `<div class="tm-truck"><span class="tm-halo"></span><div class="tm-truck-body">🚚</div></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function numIcon(n: number, color: string, visited: boolean, isNext = false): L.DivIcon {
  const size = isNext ? 32 : 22;
  const bg = visited || isNext ? color : "#fff";
  const fg = visited || isNext ? "#fff" : color;
  const ring = isNext ? `<span class="tm-ring tm-ring-fast" style="border-color:${color}"></span>` : "";
  return L.divIcon({
    className: "",
    html: `<div class="tm-marker tm-pop tm-num" style="width:${size}px;height:${size}px;background:${bg};color:${fg};border-color:${color};font-size:${isNext ? 14 : 11}px">${ring}<span class="tm-glyph">${n}</span></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size + 2], // nuqta markerining tepasida turadi
  });
}

// Cluster ikonkasi — soniga qarab o'lcham, rangi ichidagi markerlarning
// ustun (dominant) status rangiga moslashadi
function clusterIcon(cluster: { getChildCount(): number; getAllChildMarkers?: () => L.Marker[] }): L.DivIcon {
  const n = cluster.getChildCount();
  const size = n >= 100 ? 46 : n >= 25 ? 40 : 34;
  let color = "#4f46e5";
  const children = cluster.getAllChildMarkers?.() ?? [];
  if (children.length > 0) {
    const tally = new Map<string, number>();
    for (const m of children) {
      const c = (m.options as { tmColor?: string }).tmColor;
      if (c) tally.set(c, (tally.get(c) ?? 0) + 1);
    }
    let best = 0;
    for (const [c, cnt] of tally) if (cnt > best) { best = cnt; color = c; }
  }
  return L.divIcon({
    className: "",
    html: `<div class="tm-cluster" style="width:${size}px;height:${size}px;background:radial-gradient(circle at 30% 30%, color-mix(in srgb, ${color} 55%, white), ${color})">${n}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// ── Navigatsiya havolalari (Google / Yandex / Apple) ────────────────────────────
export function GeoNavLinks({ lat, lng }: { lat: number; lng: number }) {
  const links = [
    { label: "📍 Google Maps", href: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` },
    { label: "🟡 Yandex", href: `https://yandex.com/maps/?rtext=~${lat},${lng}&rtt=auto` },
    { label: "🍎 Apple", href: `https://maps.apple.com/?daddr=${lat},${lng}` },
    { label: "🌍 Waze", href: `https://waze.com/ul?ll=${lat},${lng}&navigate=yes` },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Navigation className="w-3.5 h-3.5 text-indigo-600" />
      {links.map((l) => (
        <a
          key={l.label}
          href={l.href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted"
        >
          {l.label}
        </a>
      ))}
    </div>
  );
}

// ── Jonli holat paneli (progress + oxirgi GPS + bugungi savdo) ─────────────────
function LiveStatusPanel({ data, isLoading }: { data?: LiveStatusData; isLoading: boolean }) {
  if (isLoading)
    return (
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
        {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
      </div>
    );
  if (!data || data.agents.length === 0)
    return (
      <div className="text-sm text-muted-foreground border rounded-md py-4 text-center">
        Bugun ({KUN_NOMLARI[data ? data.kun - 1 : 0]}) uchun marshrut ham, faoliyat ham yo'q
      </div>
    );
  return (
    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
      {data.agents.map((a) => {
        const pct = a.planned > 0 ? Math.round((a.visited / a.planned) * 100) : 0;
        return (
          <Card key={a.agentId}>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <RouteIcon className="w-4 h-4 text-indigo-600" />
                  <div>
                    <div className="font-semibold text-sm">{a.agentName || "—"}</div>
                    {a.mashinaNomeri && <div className="text-[11px] text-muted-foreground">{a.mashinaNomeri}</div>}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {a.lastLocation ? (
                    <Badge className="h-5 text-[10px] bg-emerald-600 hover:bg-emerald-600">📍 {locTime(a.lastLocation.at)}</Badge>
                  ) : (
                    <Badge variant="outline" className="h-5 text-[10px] text-muted-foreground">GPS yo'q</Badge>
                  )}
                  <Badge variant="secondary" className="h-5 text-[10px]">{pct}%</Badge>
                </div>
              </div>
              <Progress value={pct} className="h-2" />
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>Reja: <b className="text-foreground">{a.planned}</b></span>
                <span>Kirildi: <b className="text-blue-700">{a.visited}</b></span>
                <span>Savdo: <b className="text-green-700">{a.sold}</b></span>
                <span>Qoldi: <b className={a.remaining > 0 ? "text-amber-700" : "text-foreground"}>{a.remaining}</b></span>
              </div>
              <div className="text-xs text-muted-foreground">
                💰 Bugungi savdo: <b className="text-foreground">{fmtSom(a.salesTotal)}</b>
                {a.salesCount > 0 && <span className="ml-1">({a.salesCount} ta)</span>}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ── Tavsiyalar paneli ──────────────────────────────────────────────────────────
function SuggestionsPanel({
  data,
  isLoading,
  onShop,
}: {
  data?: SuggestionsData;
  isLoading: boolean;
  onShop: (id: number) => void;
}) {
  if (isLoading)
    return (
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-32" />)}
      </div>
    );
  if (!data) return null;
  const empty = data.agents.length === 0 && data.overdue.length === 0 && data.qaytish.length === 0 && !(data.ai && data.ai.length > 0);
  if (empty)
    return (
      <div className="text-sm text-muted-foreground border rounded-md py-4 text-center">
        Hozircha tavsiyalar yo'q — hammasi rejadagidek 👍
      </div>
    );
  return (
    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3 items-start">
      {/* AI tavsiyalar — LLM reytingi va izohi (faqat AI rejimi yoqilganda keladi) */}
      {data.ai && data.ai.length > 0 && (
        <Card className="md:col-span-2 lg:col-span-3 border-violet-200">
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <Sparkles className="w-4 h-4 text-violet-600" />
              AI tavsiyalari — bugun birinchi navbatda
            </div>
            <div className="text-[11px] text-muted-foreground -mt-1">
              Kechikish, nasiya, qaytish va'dasi, masofa va marshrut asosida AI ustuvorlik bergan do'konlar
            </div>
            <div className="grid md:grid-cols-2 gap-2">
              {data.ai.map((s, i) => (
                <button
                  key={s.dokonId}
                  onClick={() => onShop(s.dokonId)}
                  className="w-full flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs hover:bg-muted text-left"
                >
                  <span className="shrink-0 mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-violet-100 text-violet-700 font-semibold text-[10px]">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium block truncate">
                      {s.nomi || "Do'kon"}
                      {s.hudud && <span className="text-muted-foreground font-normal"> · {s.hudud}</span>}
                      {s.agentName && <span className="text-muted-foreground font-normal"> · 👤 {s.agentName}</span>}
                    </span>
                    <span className="text-muted-foreground block">{s.reason}</span>
                  </span>
                  <Badge variant="outline" className="shrink-0 h-5 text-[10px] text-violet-700 border-violet-300">
                    {s.score}
                  </Badge>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Agentga eng yaqin do'konlar (bugungi GPS bo'yicha) */}
      {data.agents.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <MapPinned className="w-4 h-4 text-indigo-600" />
              Yaqin-atrofdagi do'konlar
            </div>
            <div className="text-[11px] text-muted-foreground -mt-1">
              Agent GPS joyiga eng yaqin, bugun hali kirilmagan do'konlar
            </div>
            {data.agents.map((a) => (
              <div key={a.agentId} className="space-y-1">
                <div className="text-xs font-medium">
                  🚚 {a.agentName || "Agent"}
                  {a.mashinaNomeri && <span className="text-muted-foreground"> ({a.mashinaNomeri})</span>}
                  <span className="text-muted-foreground font-normal"> — GPS {locTime(a.gps.at)}</span>
                </div>
                {a.nearest.map((n) => (
                  <button
                    key={n.dokonId}
                    onClick={() => onShop(n.dokonId)}
                    className="w-full flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted text-left"
                  >
                    <span className="truncate">
                      {n.nomi || "Do'kon"}
                      {n.hudud && <span className="text-muted-foreground"> · {n.hudud}</span>}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {n.distKm} km{n.tartib != null && <span> · {n.tartib}-to'xtash</span>}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Kechikkan do'konlar — odatdagidan uzoq olmayapti */}
      {data.overdue.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <AlertTriangle className="w-4 h-4 text-red-600" />
              Kechikkan do'konlar
            </div>
            <div className="text-[11px] text-muted-foreground -mt-1">
              Oxirgi xariddan beri odatdagidan ko'p vaqt o'tgan
            </div>
            {data.overdue.map((o) => (
              <button
                key={o.dokonId}
                onClick={() => onShop(o.dokonId)}
                className="w-full flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted text-left"
              >
                <span className="truncate">
                  {o.nomi || "Do'kon"}
                  {o.hudud && <span className="text-muted-foreground"> · {o.hudud}</span>}
                  {o.agentName && <span className="text-muted-foreground"> · 👤 {o.agentName}</span>}
                </span>
                <Badge variant="outline" className="shrink-0 h-5 text-[10px] text-red-600 border-red-300">
                  {o.days} kun
                </Badge>
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Qaytish vaqti kelganlar */}
      {data.qaytish.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <RotateCcw className="w-4 h-4 text-amber-600" />
              Qaytish vaqti keldi
            </div>
            <div className="text-[11px] text-muted-foreground -mt-1">
              "Keyin keling" degan do'konlarga va'da qilingan sana yetdi
            </div>
            {data.qaytish.map((q) => (
              <button
                key={String(q.dokonId)}
                onClick={() => onShop(Number(q.dokonId))}
                className="w-full flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted text-left"
              >
                <span className="truncate">
                  {q.nomi || "Do'kon"}
                  {q.hudud && <span className="text-muted-foreground"> · {q.hudud}</span>}
                  {sababLabel(q.sabab, q.sababText) && (
                    <span className="text-muted-foreground"> · {sababLabel(q.sabab, q.sababText)}</span>
                  )}
                </span>
                <Badge variant="outline" className="shrink-0 h-5 text-[10px] text-amber-700 border-amber-300">
                  {q.qaytishSanasi || q.dueIso}
                </Badge>
              </button>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Xarita tab ─────────────────────────────────────────────────────────────────
export default function MapTab({ date, agentId, viloyat, hudud, search, active, onShop }: MapTabProps) {
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (date) p.set("date", date);
    if (agentId) p.set("agentId", agentId);
    if (viloyat) p.set("viloyat", viloyat);
    if (hudud) p.set("hudud", hudud);
    if (search) p.set("search", search);
    const s = p.toString();
    return s ? `?${s}` : "";
  }, [date, agentId, viloyat, hudud, search]);

  const { data, isLoading } = useQuery<MapData>({
    queryKey: ["distribution", "map", qs],
    queryFn: async () => {
      const r = await authFetch(`/api/distribution/map${qs}`);
      if (!r.ok) throw new Error("Xarita ma'lumoti yuklanmadi");
      return r.json();
    },
    enabled: active,
    refetchInterval: LIVE_REFETCH_MS,
  });

  const { data: live, isLoading: liveLoading } = useQuery<LiveStatusData>({
    queryKey: ["distribution", "live-status", qs],
    queryFn: async () => {
      const r = await authFetch(`/api/distribution/live-status${qs}`);
      if (!r.ok) throw new Error("Jonli holat yuklanmadi");
      return r.json();
    },
    enabled: active,
    refetchInterval: LIVE_REFETCH_MS,
  });

  // Marshrut tanlovi: all — hammasi, none — yashirish, aks holda agent id
  const [routeSel, setRouteSel] = useState<string>("all");

  // Xarita rejimi: markers — bugungi holat, heat — issiqlik, territory — agent hududlari
  const [mode, setMode] = useState<MapMode>("markers");

  // To'liq ekran (CSS asosida — barcha brauzer/iframe'larda ishlaydi) va legenda holati
  const [fs, setFs] = useState(false);
  const [legendOpen, setLegendOpen] = useState(true);

  // Heatmap sanaga bog'liq emas — faqat hudud/agent/qidiruv filtrlari
  const hqs = useMemo(() => {
    const p = new URLSearchParams();
    if (agentId) p.set("agentId", agentId);
    if (viloyat) p.set("viloyat", viloyat);
    if (hudud) p.set("hudud", hudud);
    if (search) p.set("search", search);
    const s = p.toString();
    return s ? `?${s}` : "";
  }, [agentId, viloyat, hudud, search]);

  const { data: heat, isLoading: heatLoading } = useQuery<HeatData>({
    queryKey: ["distribution", "heatmap", hqs],
    queryFn: async () => {
      const r = await authFetch(`/api/distribution/heatmap${hqs}`);
      if (!r.ok) throw new Error("Issiqlik xaritasi yuklanmadi");
      return r.json();
    },
    enabled: active && mode !== "markers",
  });

  // AI rejimi — LLM reytingi bilan (server 10 daqiqa keshda saqlaydi, xato bo'lsa
  // jimgina rule-based tavsiyalar ko'rsatiladi)
  const [aiMode, setAiMode] = useState(false);
  const sqs = useMemo(() => {
    if (!aiMode) return hqs;
    return hqs ? `${hqs}&ai=1` : "?ai=1";
  }, [hqs, aiMode]);

  const { data: sugg, isLoading: suggLoading } = useQuery<SuggestionsData>({
    queryKey: ["distribution", "suggestions", sqs],
    queryFn: async () => {
      const r = await authFetch(`/api/distribution/suggestions${sqs}`);
      if (!r.ok) throw new Error("Tavsiyalar yuklanmadi");
      return r.json();
    },
    enabled: active,
    refetchInterval: LIVE_REFETCH_MS * 2,
  });

  // Territory rejimida agentlarga barqaror rang beramiz
  const agentColors = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of heat?.shops ?? []) {
      const key = s.agentId ?? "—";
      if (!m.has(key)) m.set(key, ROUTE_COLORS[m.size % ROUTE_COLORS.length]);
    }
    return m;
  }, [heat]);

  const clsCounts = useMemo(() => {
    const c: Record<HeatCls, number> = { green: 0, yellow: 0, red: 0, new: 0 };
    for (const s of heat?.shops ?? []) c[s.cls]++;
    return c;
  }, [heat]);

  const routeAgents = useMemo(() => {
    if (!data) return [];
    const m = new Map<number, { name: string | null; mashina: string | null }>();
    for (const r of data.routes) if (!m.has(r.agentId)) m.set(r.agentId, { name: r.agentName, mashina: r.mashinaNomeri });
    return Array.from(m.entries()).map(([id, v]) => ({ id, ...v }));
  }, [data]);

  const statusCounts = useMemo(() => {
    const c: Record<MapShop["status"], number> = { sold: 0, nosale: 0, visited: 0, planned: 0, none: 0 };
    for (const s of data?.shops ?? []) c[s.status]++;
    return c;
  }, [data]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const liveLayerRef = useRef<L.LayerGroup | null>(null);
  const hududLayerRef = useRef<L.LayerGroup | null>(null);
  const fittedRef = useRef<string | false>(false);
  const onShopRef = useRef(onShop);
  onShopRef.current = onShop;

  // Xaritani bir marta yaratamiz
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { center: [41.311, 69.28], zoom: 11 });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);
    clusterRef.current = L.markerClusterGroup({
      maxClusterRadius: 45,
      disableClusteringAtZoom: 14,
      chunkedLoading: true, // 5000+ marker uchun bloklamay yuklaydi
      iconCreateFunction: clusterIcon,
    }).addTo(map);
    routeLayerRef.current = L.layerGroup().addTo(map);
    liveLayerRef.current = L.layerGroup().addTo(map);
    hududLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    // Tab endi ko'ringanda o'lchamni to'g'rilash
    setTimeout(() => map.invalidateSize(), 50);
    return () => {
      map.remove();
      mapRef.current = null;
      clusterRef.current = null;
      routeLayerRef.current = null;
      liveLayerRef.current = null;
      hududLayerRef.current = null;
    };
  }, []);

  // Do'kon markerlari — rejimga qarab: bugungi holat / issiqlik / agent hududlari
  useEffect(() => {
    const cluster = clusterRef.current;
    if (!cluster) return;

    // Filtr yoki rejim o'zgarganda xarita avtomatik shu markerlarga moslashadi
    const fitKey = `${mode}|${qs}|${hqs}`;
    const fitIfNeeded = (pts: [number, number][]) => {
      if (fittedRef.current === fitKey || pts.length === 0) return;
      mapRef.current?.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 15 });
      fittedRef.current = fitKey;
    };

    if (mode === "markers") {
      if (!data) return;
      cluster.clearLayers();
      const markers: L.Marker[] = [];
      for (const s of data.shops) {
        const meta = STATUS_META[s.status];
        const m = L.marker([s.lat, s.lng], { icon: shopIcon(s.status), tmColor: meta.color } as L.MarkerOptions);
        let tip = `<b>${esc(s.nomi ?? "Do'kon")}</b><br/>${esc(meta.label)}`;
        const sbl = sababLabel(s.sabab, s.sababText);
        if (sbl) tip += `<br/>❌ ${esc(sbl)}`;
        if (s.qaytishSanasi) tip += `<br/>🔁 Qaytish: ${esc(s.qaytishSanasi)}`;
        if (s.agentName) tip += `<br/>👤 ${esc(s.agentName)}`;
        if (s.hudud) tip += `<br/>📍 ${esc(s.hudud)}`;
        m.bindTooltip(tip, { direction: "top", offset: [0, -10] });
        m.on("click", () => onShopRef.current(s.id));
        markers.push(m);
      }
      cluster.addLayers(markers);
      fitIfNeeded(data.shops.map((s) => [s.lat, s.lng] as [number, number]));
      return;
    }

    // heat / territory — heatmap ma'lumotidan chizamiz
    if (!heat) return;
    cluster.clearLayers();
    const markers: L.Marker[] = [];
    for (const s of heat.shops) {
      const color =
        mode === "heat"
          ? CLS_META[s.cls].color
          : agentColors.get(s.agentId ?? "—") ?? "#9ca3af";
      const m = L.marker([s.lat, s.lng], { icon: dotIcon(color, mode === "heat"), tmColor: color } as L.MarkerOptions);
      let tip = `<b>${esc(s.nomi ?? "Do'kon")}</b>`;
      if (mode === "heat") {
        tip += `<br/>${esc(CLS_META[s.cls].label)}`;
        if (s.days != null) tip += `<br/>🗓 Oxirgi xariddan: ${s.days} kun`;
      }
      if (s.agentName) tip += `<br/>👤 ${esc(s.agentName)}`;
      if (s.hudud) tip += `<br/>📍 ${esc(s.hudud)}`;
      m.bindTooltip(tip, { direction: "top", offset: [0, -10] });
      m.on("click", () => onShopRef.current(s.id));
      markers.push(m);
    }
    cluster.addLayers(markers);
    fitIfNeeded(heat.shops.map((s) => [s.lat, s.lng] as [number, number]));
  }, [data, heat, mode, agentColors, qs, hqs]);

  // Hudud doiralari — faqat issiqlik rejimida (o'lcham = do'konlar soni)
  useEffect(() => {
    const layer = hududLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (mode !== "heat" || !heat) return;
    for (const h of heat.hududlar) {
      if (!h.centroid) continue;
      const c = L.circleMarker([h.centroid.lat, h.centroid.lng], {
        radius: 10 + Math.sqrt(h.shopCount) * 4,
        color: CLS_META[h.cls].color,
        weight: 2,
        fillColor: CLS_META[h.cls].color,
        fillOpacity: 0.15,
      });
      c.bindTooltip(
        `<b>${esc(h.hudud ?? "Hudud")}</b>${h.viloyat ? ` (${esc(h.viloyat)})` : ""}<br/>` +
          `Jami: ${h.shopCount} ta do'kon<br/>` +
          `🟢 ${h.green} · 🟡 ${h.yellow} · 🔴 ${h.red} · ⚪ ${h.new}`
      );
      c.addTo(layer);
    }
  }, [heat, mode]);

  // Marshrut chiziqlari + tartib raqamli to'xtashlar
  useEffect(() => {
    const layer = routeLayerRef.current;
    if (!layer || !data) return;
    layer.clearLayers();
    // Marshrutlar faqat "Bugungi holat" rejimida ko'rsatiladi
    if (routeSel === "none" || mode !== "markers") return;
    const groups = new Map<number, MapRouteStop[]>();
    for (const r of data.routes) {
      if (routeSel !== "all" && String(r.agentId) !== routeSel) continue;
      if (!groups.has(r.agentId)) groups.set(r.agentId, []);
      groups.get(r.agentId)!.push(r);
    }
    let idx = 0;
    for (const [, stops] of groups) {
      const color = ROUTE_COLORS[idx % ROUTE_COLORS.length];
      idx++;
      stops.sort((a, b) => a.tartib - b.tartib);
      // Keyingi to'xtash — birinchi kirilmagan do'kon
      const nextIdx = stops.findIndex((s) => !s.visited);
      // Segmentlarga bo'lib chizamiz: bajarilgan=yashil, keyingi=ko'k, reja=kulrang
      for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i];
        const b = stops[i + 1];
        const done = a.visited && b.visited;
        const isNextSeg = nextIdx > 0 && i === nextIdx - 1;
        L.polyline(
          [[a.lat, a.lng], [b.lat, b.lng]],
          done
            ? { color: "#16a34a", weight: 4, opacity: 0.85 }
            : isNextSeg
              ? { color: "#2563eb", weight: 5, opacity: 0.9 }
              : { color: "#9ca3af", weight: 3, opacity: 0.6, dashArray: "6 6" },
        ).addTo(layer);
      }
      for (let i = 0; i < stops.length; i++) {
        const s = stops[i];
        const isNext = i === nextIdx;
        const m = L.marker([s.lat, s.lng], {
          icon: numIcon(s.tartib, isNext ? "#7c3aed" : color, s.visited, isNext),
          zIndexOffset: isNext ? 1500 : 1000,
        });
        m.bindTooltip(
          `<b>${esc(s.dokonName ?? "Do'kon")}</b><br/>${esc(s.agentName ?? "")} marshruti — ${s.tartib}-to'xtash<br/>${s.visited ? "✅ Kirildi" : isNext ? "🎯 Keyingi do'kon" : "🕐 Kutilmoqda"}`,
          { direction: "top", offset: [0, -14] },
        );
        m.on("click", () => onShopRef.current(s.dokonId));
        m.addTo(layer);
      }
    }
  }, [data, routeSel, mode]);

  // Agentlarning jonli GPS markerlari (🚚) — har yangilanishda o'chirib qayta
  // yaratmaymiz: mavjud marker setLatLng bilan siljiydi (CSS transition orqali
  // silliq harakat), yo'qolgan agentlar olib tashlanadi
  const liveMarkersRef = useRef(new Map<number, L.Marker>());
  useEffect(() => {
    const layer = liveLayerRef.current;
    if (!layer) return;
    const markers = liveMarkersRef.current;
    const seen = new Set<number>();
    for (const a of live?.agents ?? []) {
      if (!a.lastLocation) continue;
      seen.add(a.agentId);
      const tip =
        `<b>🚚 ${esc(a.agentName ?? "Agent")}</b><br/>📍 Oxirgi GPS: ${esc(locTime(a.lastLocation.at))}<br/>` +
        `Reja: ${a.planned} | Kirildi: ${a.visited} | Savdo: ${a.sold}<br/>💰 ${esc(fmtSom(a.salesTotal))}`;
      const existing = markers.get(a.agentId);
      if (existing) {
        existing.setLatLng([a.lastLocation.lat, a.lastLocation.lng]);
        existing.setTooltipContent(tip);
      } else {
        const m = L.marker([a.lastLocation.lat, a.lastLocation.lng], { icon: truckIcon(), zIndexOffset: 2000 });
        m.bindTooltip(tip);
        m.addTo(layer);
        markers.set(a.agentId, m);
      }
    }
    for (const [id, m] of markers) {
      if (!seen.has(id)) {
        layer.removeLayer(m);
        markers.delete(id);
      }
    }
  }, [live]);

  // To'liq ekran almashganda xarita o'lchamini qayta hisoblaymiz; Escape bilan chiqish
  useEffect(() => {
    const t = setTimeout(() => mapRef.current?.invalidateSize(), 80);
    if (!fs) return () => clearTimeout(t);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFs(false); };
    window.addEventListener("keydown", onKey);
    return () => { clearTimeout(t); window.removeEventListener("keydown", onKey); };
  }, [fs]);

  const busy = mode === "markers" ? isLoading : heatLoading;
  const shownCount = mode === "markers" ? data?.shops.length : heat?.shops.length;

  // Tez zoom tugmalari: barcha do'konlar / jonli agentlar / bugungi marshrut
  const liveAgentCount = live?.agents.filter((a) => a.lastLocation).length ?? 0;
  const fitPts = (pts: [number, number][]) => {
    if (pts.length === 0) return;
    mapRef.current?.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 15 });
  };
  const zoomAll = () => {
    const pts =
      mode === "markers"
        ? (data?.shops ?? []).map((s) => [s.lat, s.lng] as [number, number])
        : (heat?.shops ?? []).map((s) => [s.lat, s.lng] as [number, number]);
    fitPts(pts);
  };
  const zoomLive = () => {
    const pts = (live?.agents ?? [])
      .filter((a) => a.lastLocation)
      .map((a) => [a.lastLocation!.lat, a.lastLocation!.lng] as [number, number]);
    fitPts(pts);
  };
  const zoomRoute = () => {
    const pts = (data?.routes ?? [])
      .filter((r) => routeSel === "all" || routeSel === "none" || String(r.agentId) === routeSel)
      .map((r) => [r.lat, r.lng] as [number, number]);
    fitPts(pts);
  };

  // Legenda tarkibi — rejimga mos (floating panel ichida)
  const legendItems: { color: string; label: string; count?: number }[] =
    mode === "markers"
      ? [
          ...STATUS_ORDER.map((st) => ({ color: STATUS_META[st].color, label: STATUS_META[st].label, count: data ? statusCounts[st] : undefined })),
          { color: "#7c3aed", label: "Keyingi do'kon" },
        ]
      : mode === "heat"
        ? CLS_ORDER.map((cl) => ({ color: CLS_META[cl].color, label: CLS_META[cl].label, count: heat ? clsCounts[cl] : undefined }))
        : Array.from(agentColors.entries()).map(([aid, color]) => ({
            color,
            label: heat?.shops.find((s) => (s.agentId ?? "—") === aid)?.agentName || (aid === "—" ? "Biriktirilmagan" : aid),
            count: heat?.shops.filter((s) => (s.agentId ?? "—") === aid).length ?? 0,
          }));

  return (
    <div className="p-4 space-y-4">
      {/* Rejim tanlovi */}
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["markers", "Bugungi holat"],
            ["heat", "Issiqlik xaritasi"],
            ["territory", "Agent hududlari"],
          ] as [MapMode, string][]
        ).map(([m, label]) => (
          <Button
            key={m}
            size="sm"
            variant={mode === m ? "default" : "outline"}
            className="h-8 text-xs"
            onClick={() => setMode(m)}
          >
            {label}
          </Button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {mode === "markers" && data && (
            <span className="text-[11px] text-muted-foreground">
              {data.date} • {KUN_NOMLARI[data.kun - 1]} • {data.shops.length} ta do'kon
            </span>
          )}
          {mode !== "markers" && heat && (
            <span className="text-[11px] text-muted-foreground">
              {heat.shops.length} ta do'kon • {heat.hududlar.length} ta hudud
            </span>
          )}
          {mode === "markers" && (
            <Select value={routeSel} onValueChange={setRouteSel}>
              <SelectTrigger className="h-8 w-52 text-xs"><SelectValue placeholder="Marshrut" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Barcha marshrutlar</SelectItem>
                <SelectItem value="none">Marshrutlarni yashirish</SelectItem>
                {routeAgents.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name || "—"}{a.mashina ? ` (${a.mashina})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {/* Xarita */}
      <div
        className={
          fs
            ? "fixed inset-0 z-40 bg-background"
            : "relative rounded-md border overflow-hidden"
        }
        style={fs ? undefined : { zIndex: 0 }}
      >
        <div ref={containerRef} className={fs ? "h-full w-full" : "h-[560px] w-full"} />

        {/* LIVE indikator — GPS yuborayotgan agentlar soni */}
        {liveAgentCount > 0 && (
          <div className="absolute top-3 left-3 z-[600] flex items-center gap-1.5 rounded-full border bg-background/95 backdrop-blur px-2.5 py-1 shadow text-[11px] font-semibold text-emerald-700">
            <span className="tm-live-dot" />
            LIVE · {liveAgentCount} agent
          </div>
        )}

        {/* To'liq ekran + tez zoom tugmalari */}
        <div className="absolute top-3 right-3 z-[600] flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => setFs((v) => !v)}
            title={fs ? "To'liq ekrandan chiqish (Esc)" : "To'liq ekran"}
            className="rounded-md border bg-background/95 backdrop-blur p-2 shadow hover:bg-muted"
          >
            {fs ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={zoomAll}
            title="Barcha do'konlarga moslash"
            className="rounded-md border bg-background/95 backdrop-blur p-2 shadow hover:bg-muted"
          >
            <Home className="w-4 h-4" />
          </button>
          {liveAgentCount > 0 && (
            <button
              type="button"
              onClick={zoomLive}
              title="Jonli agentlarga o'tish"
              className="rounded-md border bg-background/95 backdrop-blur p-2 shadow hover:bg-muted text-emerald-700"
            >
              <Truck className="w-4 h-4" />
            </button>
          )}
          {mode === "markers" && routeSel !== "none" && (data?.routes.length ?? 0) > 0 && (
            <button
              type="button"
              onClick={zoomRoute}
              title="Bugungi marshrutga moslash"
              className="rounded-md border bg-background/95 backdrop-blur p-2 shadow hover:bg-muted text-indigo-700"
            >
              <Crosshair className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Floating legenda — yig'iladigan */}
        <div className="absolute bottom-3 left-3 z-[600] rounded-md border bg-background/95 backdrop-blur shadow max-w-[240px]">
          <button
            type="button"
            onClick={() => setLegendOpen((v) => !v)}
            className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs font-semibold"
          >
            Legenda
            {legendOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          </button>
          {legendOpen && (
            <div className="px-2.5 pb-2 space-y-1">
              {legendItems.map((it) => (
                <div key={it.label} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="w-2.5 h-2.5 rounded-full inline-block border border-white shadow shrink-0" style={{ background: it.color }} />
                  <span className="truncate">{it.label}</span>
                  {it.count !== undefined && <b className="text-foreground ml-auto">{it.count}</b>}
                </div>
              ))}
            </div>
          )}
        </div>

        {busy && (
          <div className="absolute inset-0 z-[500] flex items-center justify-center bg-background/60">
            <span className="text-sm text-muted-foreground">Xarita yuklanmoqda…</span>
          </div>
        )}
        {!busy && shownCount === 0 && (
          <div className="absolute inset-0 z-[500] flex items-center justify-center bg-background/60">
            <span className="text-sm text-muted-foreground">Tanlangan filtrlar bo'yicha koordinatali do'konlar topilmadi</span>
          </div>
        )}
      </div>

      {/* Jonli holat: progress + GPS + savdolar */}
      <div className="space-y-2">
        <div className="text-sm font-semibold flex items-center gap-1.5">
          <RouteIcon className="w-4 h-4 text-indigo-600" />
          Agentlar jonli holati {live && <span className="text-[11px] font-normal text-muted-foreground">({live.date}, {KUN_NOMLARI[live.kun - 1]} • har 45 soniyada yangilanadi)</span>}
        </div>
        <LiveStatusPanel data={live} isLoading={liveLoading} />
      </div>

      {/* Tavsiyalar: yaqin do'konlar, kechikkanlar, qaytish vaqti kelganlar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold flex items-center gap-1.5">
            <Lightbulb className="w-4 h-4 text-amber-500" />
            Tavsiyalar
          </div>
          <Button
            size="sm"
            variant={aiMode ? "default" : "outline"}
            className={aiMode ? "h-7 text-xs bg-violet-600 hover:bg-violet-700" : "h-7 text-xs"}
            onClick={() => setAiMode((v) => !v)}
          >
            <Sparkles className="w-3.5 h-3.5 mr-1" />
            AI tavsiyalar
          </Button>
        </div>
        {aiMode && suggLoading && (
          <div className="text-[11px] text-muted-foreground">AI tahlil qilmoqda…</div>
        )}
        {aiMode && !suggLoading && sugg && (!sugg.ai || sugg.ai.length === 0) && (
          <div className="text-[11px] text-muted-foreground">
            AI tavsiyasi hozircha mavjud emas — quyida oddiy tavsiyalar ko'rsatilmoqda
          </div>
        )}
        <SuggestionsPanel data={sugg} isLoading={suggLoading} onShop={onShop} />
      </div>
    </div>
  );
}
