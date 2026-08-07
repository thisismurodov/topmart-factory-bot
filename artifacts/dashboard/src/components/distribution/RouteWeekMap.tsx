import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { authFetch } from "@/App";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { esc } from "@/components/distribution/MapTab";
import RoutePlanDialog from "@/components/distribution/RoutePlanDialog";

// ── Turlar ──────────────────────────────────────────────────────────────────────
type WeekStop = {
  kun: number;
  tartib: number;
  agentId: number;
  agentName: string | null;
  dokonId: number;
  nomi: string | null;
  hudud: string | null;
  lat: number;
  lng: number;
};
type UnassignedShop = {
  id: number;
  nomi: string | null;
  viloyat: string | null;
  hudud: string | null;
  holat: string | null;
  lat: number;
  lng: number;
};
type RouteStat = {
  kun: number;
  agentId: number;
  agentName: string | null;
  shopCount: number;
  totalKm: number;
  driveMinutes: number;
  visitMinutes: number;
  totalMinutes: number;
  crossCount: number;
  backtrackPct: number;
  longJumps: number;
  avgHopKm: number;
  maxHopKm: number;
  efficiency: number;
  score: number;
};
type RouteMapData = {
  kunlar: string[];
  agentId: number | null;
  agents: { id: number; name: string | null; mashinaNomeri: string | null }[];
  allAgents: { id: number; name: string | null; mashinaNomeri: string | null }[];
  stops: WeekStop[];
  noCoord: { kun: number; dokonId: number; nomi: string | null; hudud: string | null }[];
  unassigned: UnassignedShop[];
  unassignedNoCoord: { id: number; nomi: string | null; viloyat: string | null; hudud: string | null; holat: string | null }[];
  routeStats: RouteStat[];
};

// Har hafta kuni uchun o'z rangi (juma=5 — dam kuni, kulrang)
const KUN_COLORS: Record<number, string> = {
  1: "#2563eb", // dushanba — ko'k
  2: "#16a34a", // seshanba — yashil
  3: "#f59e0b", // chorshanba — sariq
  4: "#9333ea", // payshanba — binafsha
  5: "#64748b", // juma — dam kuni
  6: "#dc2626", // shanba — qizil
  7: "#0d9488", // yakshanba — feruza
};
const UNASSIGNED_COLOR = "#94a3b8";

// Daqiqani "2s 15d" ko'rinishiga keltiradi
function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}s ${m}d` : `${m}d`;
}

function stopIcon(
  n: number,
  color: string,
  opt?: { kind?: "start" | "finish"; pulse?: boolean }
): L.DivIcon {
  const size = opt?.kind ? 26 : 22;
  const ring =
    opt?.kind === "start"
      ? "box-shadow:0 0 0 3px rgba(16,185,129,.95),0 1px 4px rgba(0,0,0,.45);"
      : opt?.kind === "finish"
        ? "box-shadow:0 0 0 3px rgba(15,23,42,.8),0 1px 4px rgba(0,0,0,.45);"
        : "";
  const cls = opt?.pulse ? " tm-next-pulse" : "";
  return L.divIcon({
    className: "",
    html: `<div class="tm-marker tm-num${cls}" style="width:${size}px;height:${size}px;background:${color};color:#fff;border-color:#fff;font-size:${opt?.kind ? 12 : 11}px;${ring}"><span class="tm-glyph">${n}</span></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// Segment o'rtasidagi yo'nalish strelkasi (kompas bearing bo'yicha buralgan)
function arrowIcon(color: string, deg: number): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<div class="tm-route-arrow" style="border-bottom-color:${color};transform:rotate(${deg}deg)"></div>`,
    iconSize: [10, 10],
    iconAnchor: [5, 5],
  });
}

// Ikki nuqta orasidagi kompas yo'nalishi (0° = shimol, soat mili bo'yicha)
function bearingDeg(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const midLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (b.lng - a.lng) * Math.cos(midLat);
  const dy = b.lat - a.lat;
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

// Bugungi hafta kuni (Asia/Tashkent, dushanba=1..yakshanba=7)
function todayKun(): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tashkent", weekday: "short" }).format(new Date());
  return ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[wd] ?? 1;
}

function unassignedIcon(): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<div style="width:12px;height:12px;border-radius:50%;background:${UNASSIGNED_COLOR};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.45)"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
}

// ── Haftalik marshrut xaritasi ─────────────────────────────────────────────────
export default function RouteWeekMap({ active, onShop }: { active: boolean; onShop: (id: number) => void }) {
  // Xarita o'z agent tanloviga ega (delivery_agents.id bilan ishlaydi)
  const [agentSel, setAgentSel] = useState<string>("");
  const [hiddenKuns, setHiddenKuns] = useState<Set<number>>(new Set());
  const [showUnassigned, setShowUnassigned] = useState(true);

  const qs = agentSel ? `?agentId=${agentSel}` : "";
  const { data, isLoading } = useQuery<RouteMapData>({
    queryKey: ["distribution", "route-map", qs],
    queryFn: async () => {
      const r = await authFetch(`/api/distribution/route-map${qs}`);
      if (!r.ok) throw new Error("Marshrut xaritasi yuklanmadi");
      return r.json();
    },
    enabled: active,
  });

  // Bitta agent bo'lsa — avtomatik tanlaymiz
  useEffect(() => {
    if (!agentSel && data && data.agents.length === 1) setAgentSel(String(data.agents[0].id));
  }, [data, agentSel]);

  const kunStats = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of data?.stops ?? []) m.set(s.kun, (m.get(s.kun) ?? 0) + 1);
    return m;
  }, [data]);

  // Har kun uchun jamlangan statistika (bir nechta agent bo'lsa qiymatlar qo'shiladi,
  // ball — o'rtacha olinadi)
  const kunRouteStats = useMemo(() => {
    const m = new Map<
      number,
      {
        km: number;
        min: number;
        driveMin: number;
        visitMin: number;
        scoreSum: number;
        effSum: number;
        crossSum: number;
        backtrackSum: number;
        avgHopSum: number;
        maxHop: number;
        n: number;
      }
    >();
    for (const rs of data?.routeStats ?? []) {
      const cur =
        m.get(rs.kun) ??
        { km: 0, min: 0, driveMin: 0, visitMin: 0, scoreSum: 0, effSum: 0, crossSum: 0, backtrackSum: 0, avgHopSum: 0, maxHop: 0, n: 0 };
      cur.km += rs.totalKm;
      cur.min += rs.totalMinutes;
      cur.driveMin += rs.driveMinutes;
      cur.visitMin += rs.visitMinutes;
      cur.scoreSum += rs.score;
      cur.effSum += rs.efficiency;
      cur.crossSum += rs.crossCount;
      cur.backtrackSum += rs.backtrackPct;
      cur.avgHopSum += rs.avgHopKm;
      cur.maxHop = Math.max(cur.maxHop, rs.maxHopKm);
      cur.n += 1;
      m.set(rs.kun, cur);
    }
    return m;
  }, [data]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const fittedRef = useRef<string | false>(false);
  const onShopRef = useRef(onShop);
  onShopRef.current = onShop;

  // Xaritani bir marta yaratamiz
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { center: [41.0, 71.24], zoom: 10 });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 50);
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  // Tab ko'ringanda o'lchamni yangilash
  useEffect(() => {
    if (active) setTimeout(() => mapRef.current?.invalidateSize(), 100);
  }, [active]);

  // Chiziqlar va markerlar
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !data) return;
    layer.clearLayers();

    const pts: [number, number][] = [];

    // Marshrutsiz do'konlar — kulrang nuqtalar
    if (showUnassigned) {
      for (const u of data.unassigned) {
        const m = L.marker([u.lat, u.lng], { icon: unassignedIcon(), zIndexOffset: -100 });
        m.bindTooltip(`${esc(u.nomi ?? "Do'kon")}${u.hudud ? ` · ${esc(u.hudud)}` : ""} — marshrutsiz`, { direction: "top" });
        m.on("click", () => onShopRef.current(u.id));
        layer.addLayer(m);
        pts.push([u.lat, u.lng]);
      }
    }

    // Har kun (va agent) uchun alohida chiziq + tartib raqamli markerlar.
    // Bir nechta agent ko'rsatilganda har agentning chizig'i alohida bo'ladi.
    const byKunAgent = new Map<string, WeekStop[]>();
    for (const s of data.stops) {
      const key = `${s.kun}|${s.agentId}`;
      if (!byKunAgent.has(key)) byKunAgent.set(key, []);
      byKunAgent.get(key)!.push(s);
    }
    const today = todayKun();
    for (const [key, stops] of byKunAgent) {
      const kun = Number(key.split("|")[0]);
      if (hiddenKuns.has(kun)) continue;
      const color = KUN_COLORS[kun] ?? "#333";
      const latlngs = stops.map((s) => [s.lat, s.lng] as [number, number]);
      if (latlngs.length >= 2) {
        layer.addLayer(L.polyline(latlngs, { color, weight: kun === today ? 4 : 3, opacity: 0.85 }));
        // Yo'nalish strelkalari — har segment o'rtasida (bosib bo'lmaydi)
        for (let i = 1; i < stops.length; i++) {
          const a = stops[i - 1];
          const b = stops[i];
          const mid: [number, number] = [(a.lat + b.lat) / 2, (a.lng + b.lng) / 2];
          layer.addLayer(
            L.marker(mid, { icon: arrowIcon(color, bearingDeg(a, b)), interactive: false, zIndexOffset: -50 })
          );
        }
      }
      const last = stops.length - 1;
      for (let i = 0; i < stops.length; i++) {
        const s = stops[i];
        const kind = i === 0 ? ("start" as const) : i === last && last > 0 ? ("finish" as const) : undefined;
        // Bugungi marshrutning birinchi nuqtasi — "keyingi manzil" sifatida pulsatsiya
        const pulse = kun === today && i === 0;
        const m = L.marker([s.lat, s.lng], {
          icon: stopIcon(s.tartib, color, { kind, pulse }),
          zIndexOffset: kind ? 200 : 0,
        });
        const kindLabel = kind === "start" ? " · 🏁 Boshlanish" : kind === "finish" ? " · 🎯 Tugash" : "";
        m.bindTooltip(
          `${esc(data.kunlar[kun - 1] ?? "")} #${s.tartib} — ${esc(s.nomi ?? "Do'kon")}${s.hudud ? ` · ${esc(s.hudud)}` : ""}${data.agentId ? "" : ` (${esc(s.agentName ?? "—")})`}${kindLabel}`,
          { direction: "top" }
        );
        m.on("click", () => onShopRef.current(s.dokonId));
        layer.addLayer(m);
        pts.push([s.lat, s.lng]);
      }
    }

    // Ma'lumot o'zgarganda bir marta moslashamiz
    const fitKey = `${qs}|${data.stops.length}|${data.unassigned.length}`;
    if (fittedRef.current !== fitKey && pts.length > 0) {
      mapRef.current?.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 14 });
      fittedRef.current = fitKey;
    }
  }, [data, hiddenKuns, showUnassigned, qs]);

  const toggleKun = (kun: number) => {
    setHiddenKuns((prev) => {
      const next = new Set(prev);
      if (next.has(kun)) next.delete(kun);
      else next.add(kun);
      return next;
    });
  };

  return (
    <div className="space-y-2">
      {/* Agent tanlovi + AI marshrut tuzish */}
      <div className="flex flex-wrap items-center gap-2">
        {data && data.agents.length > 1 && (
          <>
            <Button size="sm" variant={agentSel === "" ? "default" : "outline"} className="h-7 text-xs" onClick={() => setAgentSel("")}>
              Hammasi
            </Button>
            {data.agents.map((a) => (
              <Button
                key={a.id}
                size="sm"
                variant={agentSel === String(a.id) ? "default" : "outline"}
                className="h-7 text-xs"
                onClick={() => setAgentSel(String(a.id))}
              >
                🚚 {a.name || "Agent"}
              </Button>
            ))}
          </>
        )}
        <div className="ml-auto">{data && <RoutePlanDialog agents={data.allAgents} />}</div>
      </div>

      {/* Kunlar legendasi — bosib yoqish/o'chirish mumkin */}
      {data && (
        <div className="flex flex-wrap gap-1.5">
          {data.kunlar.map((nomi, i) => {
            const kun = i + 1;
            const count = kunStats.get(kun) ?? 0;
            if (count === 0) return null;
            const off = hiddenKuns.has(kun);
            const st = kunRouteStats.get(kun);
            return (
              <button
                key={kun}
                onClick={() => toggleKun(kun)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium capitalize transition-opacity ${off ? "opacity-40" : ""}`}
                style={{ borderColor: KUN_COLORS[kun], color: KUN_COLORS[kun] }}
                title={
                  st
                    ? `Masofa: ${Math.round(st.km)} km\nHarakat: ~${fmtMin(st.driveMin)} · Tashrif: ~${fmtMin(st.visitMin)}\nSamaradorlik: ${Math.round(st.effSum / st.n)}% · Kesishish: ${st.crossSum}\nOrqaga qaytish: ${Math.round(st.backtrackSum / st.n)}% · O'rtacha hop: ${(st.avgHopSum / st.n).toFixed(2)} km · Eng uzun hop: ${st.maxHop} km\nAI Score: ${Math.round(st.scoreSum / st.n)}/100`
                    : undefined
                }
              >
                <span className="inline-block w-4 h-1 rounded" style={{ background: KUN_COLORS[kun] }} />
                {nomi} · {count}
                {st && (
                  <span className="font-normal opacity-80 normal-case">
                    · {Math.round(st.km)} km · ~{fmtMin(st.min)} · ⭐{Math.round(st.scoreSum / st.n)} · ⚡
                    {Math.round(st.effSum / st.n)}%{st.crossSum > 0 ? ` · ✂️${st.crossSum}` : ""}
                  </span>
                )}
              </button>
            );
          })}
          <button
            onClick={() => setShowUnassigned((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-opacity ${showUnassigned ? "" : "opacity-40"}`}
            style={{ borderColor: UNASSIGNED_COLOR, color: "#475569" }}
          >
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: UNASSIGNED_COLOR }} />
            Marshrutsiz · {data.unassigned.length}
          </button>
        </div>
      )}

      {/* Xarita */}
      {/* z-0 + isolate: Leaflet pane'lari (z-index 200-700) Sheet/dialog (z-50)
          ustiga chiqib ketmasligi uchun alohida stacking context yaratamiz */}
      <div className="relative z-0 isolate rounded-lg overflow-hidden border">
        {isLoading && !data && <Skeleton className="absolute inset-0 z-10" />}
        <div ref={containerRef} className="h-[420px] md:h-[520px] w-full" />
      </div>

      {/* Koordinatasiz do'konlar haqida eslatma */}
      {data && (data.unassignedNoCoord.length > 0 || data.noCoord.length > 0) && (
        <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          {data.unassignedNoCoord.length > 0 && (
            <Badge variant="outline" className="h-5 text-[10px] font-normal">
              📍 {data.unassignedNoCoord.length} ta marshrutsiz do'konning koordinatasi yo'q (xaritada ko'rinmaydi)
            </Badge>
          )}
          {data.noCoord.length > 0 && (
            <Badge variant="outline" className="h-5 text-[10px] font-normal">
              📍 {data.noCoord.length} ta marshrutdagi do'konning koordinatasi yo'q
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}
