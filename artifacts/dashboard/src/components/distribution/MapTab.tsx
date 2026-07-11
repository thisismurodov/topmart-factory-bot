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
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Route as RouteIcon, Navigation } from "lucide-react";

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

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function dotIcon(color: string): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.45)"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function truckIcon(): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<div style="width:30px;height:30px;border-radius:50%;background:#fff;border:2px solid #4f46e5;display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 1px 4px rgba(0,0,0,.45)">🚚</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function numIcon(n: number, color: string, visited: boolean): L.DivIcon {
  const bg = visited ? color : "#fff";
  const fg = visited ? "#fff" : color;
  return L.divIcon({
    className: "",
    html: `<div style="width:22px;height:22px;border-radius:50%;background:${bg};color:${fg};border:2px solid ${color};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;box-shadow:0 1px 3px rgba(0,0,0,.4)">${n}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 22], // nuqta markerining tepasida turadi
  });
}

// ── Navigatsiya havolalari (Google / Yandex / Apple) ────────────────────────────
export function GeoNavLinks({ lat, lng }: { lat: number; lng: number }) {
  const links = [
    { label: "Google Maps", href: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` },
    { label: "Yandex", href: `https://yandex.com/maps/?rtext=~${lat},${lng}&rtt=auto` },
    { label: "Apple", href: `https://maps.apple.com/?daddr=${lat},${lng}` },
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
  const fittedRef = useRef(false);
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
    clusterRef.current = L.markerClusterGroup({ maxClusterRadius: 45, disableClusteringAtZoom: 14 }).addTo(map);
    routeLayerRef.current = L.layerGroup().addTo(map);
    liveLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    // Tab endi ko'ringanda o'lchamni to'g'rilash
    setTimeout(() => map.invalidateSize(), 50);
    return () => {
      map.remove();
      mapRef.current = null;
      clusterRef.current = null;
      routeLayerRef.current = null;
      liveLayerRef.current = null;
    };
  }, []);

  // Do'kon markerlari
  useEffect(() => {
    const cluster = clusterRef.current;
    if (!cluster || !data) return;
    cluster.clearLayers();
    for (const s of data.shops) {
      const meta = STATUS_META[s.status];
      const m = L.marker([s.lat, s.lng], { icon: dotIcon(meta.color) });
      let tip = `<b>${esc(s.nomi ?? "Do'kon")}</b><br/>${esc(meta.label)}`;
      const sbl = sababLabel(s.sabab, s.sababText);
      if (sbl) tip += `<br/>❌ ${esc(sbl)}`;
      if (s.qaytishSanasi) tip += `<br/>🔁 Qaytish: ${esc(s.qaytishSanasi)}`;
      if (s.agentName) tip += `<br/>👤 ${esc(s.agentName)}`;
      m.bindTooltip(tip);
      m.on("click", () => onShopRef.current(s.id));
      cluster.addLayer(m);
    }
    if (!fittedRef.current && data.shops.length > 0) {
      mapRef.current?.fitBounds(L.latLngBounds(data.shops.map((s) => [s.lat, s.lng] as [number, number])), {
        padding: [30, 30],
      });
      fittedRef.current = true;
    }
  }, [data]);

  // Marshrut chiziqlari + tartib raqamli to'xtashlar
  useEffect(() => {
    const layer = routeLayerRef.current;
    if (!layer || !data) return;
    layer.clearLayers();
    if (routeSel === "none") return;
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
      if (stops.length > 1) {
        L.polyline(stops.map((s) => [s.lat, s.lng] as [number, number]), {
          color,
          weight: 3,
          opacity: 0.7,
          dashArray: "6 6",
        }).addTo(layer);
      }
      for (const s of stops) {
        const m = L.marker([s.lat, s.lng], { icon: numIcon(s.tartib, color, s.visited), zIndexOffset: 1000 });
        m.bindTooltip(
          `<b>${esc(s.dokonName ?? "Do'kon")}</b><br/>${esc(s.agentName ?? "")} marshruti — ${s.tartib}-to'xtash<br/>${s.visited ? "✅ Kirildi" : "🕐 Kutilmoqda"}`
        );
        m.on("click", () => onShopRef.current(s.dokonId));
        m.addTo(layer);
      }
    }
  }, [data, routeSel]);

  // Agentlarning jonli GPS markerlari (🚚)
  useEffect(() => {
    const layer = liveLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    for (const a of live?.agents ?? []) {
      if (!a.lastLocation) continue;
      const m = L.marker([a.lastLocation.lat, a.lastLocation.lng], { icon: truckIcon(), zIndexOffset: 2000 });
      m.bindTooltip(
        `<b>🚚 ${esc(a.agentName ?? "Agent")}</b><br/>📍 Oxirgi GPS: ${esc(locTime(a.lastLocation.at))}<br/>` +
          `Reja: ${a.planned} | Kirildi: ${a.visited} | Savdo: ${a.sold}<br/>💰 ${esc(fmtSom(a.salesTotal))}`
      );
      m.addTo(layer);
    }
  }, [live]);

  return (
    <div className="p-4 space-y-4">
      {/* Legenda + marshrut tanlovi */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {STATUS_ORDER.map((st) => (
          <span key={st} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="w-3 h-3 rounded-full inline-block border border-white shadow" style={{ background: STATUS_META[st].color }} />
            {STATUS_META[st].label}
            {data && <b className="text-foreground">({statusCounts[st]})</b>}
          </span>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {data && (
            <span className="text-[11px] text-muted-foreground">
              {data.date} • {KUN_NOMLARI[data.kun - 1]} • {data.shops.length} ta do'kon
            </span>
          )}
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
        </div>
      </div>

      {/* Xarita */}
      <div className="relative rounded-md border overflow-hidden" style={{ zIndex: 0 }}>
        <div ref={containerRef} className="h-[560px] w-full" />
        {isLoading && (
          <div className="absolute inset-0 z-[500] flex items-center justify-center bg-background/60">
            <span className="text-sm text-muted-foreground">Xarita yuklanmoqda…</span>
          </div>
        )}
        {!isLoading && data && data.shops.length === 0 && (
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
    </div>
  );
}
