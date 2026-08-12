import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Kunlik tashriflar xaritasi — kirilgan do'kon markerlari (natija rangida) +
// agent GPS izi (breadcrumb polyline). MapTab'dagi Leaflet uslubi qayta ishlatiladi.
// selectedAgentId berilsa — o'sha agentning izi ajratiladi, qolganlari xiralashadi
// va xarita tanlangan agent chegaralariga moslashadi.

export type DailyMapStop = {
  dokonId: number;
  dokonName: string | null;
  lat: number | null;
  lng: number | null;
  outcome: "sold" | "nosale" | "payment";
  createdAt: string | null;
};
export type DailyMapAgent = {
  agentId: number;
  agentName: string | null;
  stops: DailyMapStop[];
  trail: { lat: number; lng: number; at: string | null }[];
};

const OUTCOME_META: Record<DailyMapStop["outcome"], { color: string; label: string }> = {
  sold: { color: "#16a34a", label: "Savdo qilindi" },
  nosale: { color: "#dc2626", label: "Olmadi" },
  payment: { color: "#2563eb", label: "To'lov olindi" },
};

const TRAIL_COLORS = ["#6366f1", "#0ea5e9", "#f97316", "#14b8a6", "#a855f7", "#e11d48", "#84cc16", "#f59e0b"];

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function stopIcon(color: string, dimmed: boolean): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.45);opacity:${dimmed ? 0.25 : 1}"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

export default function DailyVisitsMap({
  agents,
  onShop,
  selectedAgentId = null,
  onSelectAgent,
}: {
  agents: DailyMapAgent[];
  onShop: (id: number) => void;
  selectedAgentId?: number | null;
  // Xaritadan agent tanlash: iz/oxirgi GPS nuqtasi bosilganda id, fon bosilganda null
  onSelectAgent?: (agentId: number | null) => void;
}) {
  const divRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const onShopRef = useRef(onShop);
  onShopRef.current = onShop;
  const onSelectAgentRef = useRef(onSelectAgent);
  onSelectAgentRef.current = onSelectAgent;
  const fittedRef = useRef(false);
  const prevSelectedRef = useRef<number | null>(null);

  // Xarita bir marta yaratiladi
  useEffect(() => {
    if (!divRef.current || mapRef.current) return;
    const map = L.map(divRef.current, { zoomControl: true }).setView([41.3, 69.25], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    // Fon bosilganda tanlovni bekor qilish (marker/iz bosilishi propagatsiyani to'xtatadi)
    map.on("click", () => onSelectAgentRef.current?.(null));
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      fittedRef.current = false;
      prevSelectedRef.current = null;
    };
  }, []);

  // Ma'lumot yoki tanlov o'zgarganda qatlamni yangilash (auto-refresh'da zoom saqlanadi)
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    const bounds = L.latLngBounds([]);
    const selectedBounds = L.latLngBounds([]);
    const hasSelection = selectedAgentId != null && agents.some((a) => a.agentId === selectedAgentId);

    agents.forEach((a, i) => {
      const color = TRAIL_COLORS[i % TRAIL_COLORS.length];
      const isSelected = hasSelection && a.agentId === selectedAgentId;
      const dimmed = hasSelection && !isSelected;
      const extend = (p: L.LatLngExpression) => {
        bounds.extend(p);
        if (isSelected) selectedBounds.extend(p);
      };
      // Iz/oxirgi GPS nuqtasi bosilganda: tanlash yoki (tanlangan bo'lsa) bekor qilish
      const handleSelect = (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        onSelectAgentRef.current?.(isSelected ? null : a.agentId);
      };

      // GPS iz (breadcrumb) — polyline
      if (a.trail.length > 1) {
        const pts = a.trail.map((t) => L.latLng(t.lat, t.lng));
        L.polyline(pts, {
          color,
          weight: isSelected ? 5 : 3,
          opacity: dimmed ? 0.15 : isSelected ? 0.95 : 0.7,
          dashArray: "6 6",
        })
          .bindTooltip(`🚚 ${a.agentName || "Agent"} — GPS izi (${a.trail.length} nuqta)`, { sticky: true })
          .on("click", handleSelect)
          .addTo(layer);
        pts.forEach((p) => extend(p));
        // Oxirgi joy — kichik doira
        const last = a.trail[a.trail.length - 1];
        L.circleMarker([last.lat, last.lng], {
          radius: isSelected ? 7 : 6, color: "#fff", weight: 2, fillColor: color,
          fillOpacity: dimmed ? 0.25 : 1, opacity: dimmed ? 0.25 : 1,
        })
          .bindTooltip(`🚚 ${esc(a.agentName || "Agent")} — oxirgi GPS ${last.at ? last.at.slice(11, 16) : ""}`)
          .on("click", handleSelect)
          .addTo(layer);
      } else if (a.trail.length === 1) {
        const t = a.trail[0];
        L.circleMarker([t.lat, t.lng], {
          radius: isSelected ? 7 : 6, color: "#fff", weight: 2, fillColor: color,
          fillOpacity: dimmed ? 0.25 : 1, opacity: dimmed ? 0.25 : 1,
        })
          .bindTooltip(`🚚 ${esc(a.agentName || "Agent")} — GPS ${t.at ? t.at.slice(11, 16) : ""}`)
          .on("click", handleSelect)
          .addTo(layer);
        extend([t.lat, t.lng]);
      }

      // Kirilgan do'kon markerlari — natija rangida
      for (const s of a.stops) {
        if (s.lat == null || s.lng == null) continue;
        const meta = OUTCOME_META[s.outcome];
        const m = L.marker([s.lat, s.lng], { icon: stopIcon(meta.color, dimmed) })
          .bindTooltip(
            `${esc(s.dokonName || "Do'kon")} — ${meta.label}${s.createdAt ? ` (${s.createdAt.slice(11, 16)})` : ""}`
          )
          .addTo(layer);
        m.on("click", () => onShopRef.current(s.dokonId));
        extend([s.lat, s.lng]);
      }
    });

    // Zoom mantiqi:
    // - Tanlov o'zgarganda: tanlangan agent chegaralariga (yoki umumiy ko'rinishga qaytish)
    // - Birinchi yuklashda: umumiy chegaralar. Auto-refresh'da zoom saqlanadi.
    const selectionChanged = prevSelectedRef.current !== (hasSelection ? selectedAgentId : null);
    prevSelectedRef.current = hasSelection ? selectedAgentId : null;

    if (selectionChanged) {
      if (hasSelection && selectedBounds.isValid()) {
        map.fitBounds(selectedBounds.pad(0.2), { maxZoom: 15 });
        fittedRef.current = true;
      } else if (bounds.isValid()) {
        map.fitBounds(bounds.pad(0.15), { maxZoom: 14 });
        fittedRef.current = true;
      }
    } else if (!fittedRef.current && bounds.isValid()) {
      map.fitBounds(bounds.pad(0.15), { maxZoom: 14 });
      fittedRef.current = true;
    }
  }, [agents, selectedAgentId]);

  const hasAny = agents.some(
    (a) => a.trail.length > 0 || a.stops.some((s) => s.lat != null && s.lng != null)
  );
  const selectedAgent = selectedAgentId != null ? agents.find((a) => a.agentId === selectedAgentId) : undefined;

  return (
    <div className="rounded-md border overflow-hidden">
      <div ref={divRef} className="h-[380px] w-full" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-[11px] text-muted-foreground border-t">
        {(Object.keys(OUTCOME_META) as DailyMapStop["outcome"][]).map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: OUTCOME_META[k].color }} />
            {OUTCOME_META[k].label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="w-5 border-t-2 border-dashed inline-block" style={{ borderColor: "#6366f1" }} />
          Agent GPS izi
        </span>
        {selectedAgent && (
          <span className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-indigo-700 font-medium">
            🎯 {selectedAgent.agentName || "Agent"} ajratildi
          </span>
        )}
        {!hasAny && <span className="ml-auto">Bugun koordinatali tashrif yoki GPS ma'lumoti yo'q</span>}
      </div>
    </div>
  );
}
