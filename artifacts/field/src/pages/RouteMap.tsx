import { useEffect, useState, useMemo } from "react";
import { useLocation } from "wouter";
import { MapContainer, Marker, Polyline, useMap } from "react-leaflet";
import L from "leaflet";
import { useFieldRouteToday, useFieldMe, RouteShop } from "@/lib/fieldApi";
import { useGps } from "@/hooks/useGps";
import {
  calculateDistance,
  estimateEtaMinutes,
  estimateFinishTime,
  formatCurrency,
  consumeVisitSaved,
} from "@/lib/utils";
import { Button } from "@/components/ui/button";
import NavButtons from "@/components/NavButtons";
import RatingStars from "@/components/RatingStars";
import ShopSheet from "@/components/ShopSheet";
import { OfflineTileLayer } from "@/components/OfflineTileLayer";
import { prefetchRouteTiles } from "@/lib/tileCache";
import { Navigation2, Car, Store, Check, Clock, Info, Shuffle, ListOrdered } from "lucide-react";

/** Nearest-neighbour sort for pending shops, starting from `startLat/Lon`. */
function nearestNeighborSort(
  pending: RouteShop[],
  startLat: number,
  startLon: number
): RouteShop[] {
  const withCoords = pending.filter(s => s.latitude != null && s.longitude != null);
  const noCoords = pending.filter(s => s.latitude == null || s.longitude == null);

  const remaining = [...withCoords];
  const sorted: RouteShop[] = [];
  let curLat = startLat;
  let curLon = startLon;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = calculateDistance(curLat, curLon, remaining[i].latitude!, remaining[i].longitude!);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const chosen = remaining.splice(bestIdx, 1)[0];
    sorted.push(chosen);
    curLat = chosen.latitude!;
    curLon = chosen.longitude!;
  }

  return [...sorted, ...noCoords];
}

const OPTIMAL_ORDER_PREFIX = "field_optimal_order:";

/** Umumiy yo'l uzunligi (metr): startdan boshlab do'konlar ketma-ketligi bo'ylab. */
function totalRouteDistance(
  shops: RouteShop[],
  startLat: number,
  startLon: number
): number {
  let total = 0;
  let curLat = startLat;
  let curLon = startLon;
  for (const s of shops) {
    if (s.latitude == null || s.longitude == null) continue;
    total += calculateDistance(curLat, curLon, s.latitude, s.longitude);
    curLat = s.latitude;
    curLon = s.longitude;
  }
  return total;
}

// Fix for leaflet markers in react — ikonkalar LOKAL bundle'dan (unpkg CDN
// ba'zi provayderlarda bloklangan, xuddi telegram.org kabi)
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

// ── Ustuvorlik (biznes signallari) ────────────────────────────────────────────
// Umumiy komponentga ko'chirildi — ShopSheet ham ishlatadi.
import UrgencyBadges, { isUrgentShop } from "@/components/UrgencyBadges";
export { isUrgentShop };

function createNumberedIcon(number: number, status: string, isNext = false, urgent = false) {
  let bgColor = "#f59e0b"; // amber (pending)
  let glyph = String(number);
  if (status === "sold") { bgColor = "#10b981"; glyph = "✓"; } // green
  else if (status === "nosale") { bgColor = "#ef4444"; glyph = "✕"; } // red
  if (isNext) bgColor = "#7c3aed"; // violet — keyingi do'kon

  const size = isNext ? 40 : 30;
  const ring = isNext ? `<span class="tm-ring" style="border-color:${bgColor}"></span>` : "";
  // Ustuvor do'kon (pending) — kichik qizil "!" nishoni burchakda
  const urgentDot =
    urgent && status === "pending"
      ? `<span style="position:absolute;top:-5px;right:-5px;z-index:2;background:#dc2626;color:white;width:16px;height:16px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:bold;border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,0.4)">!</span>`
      : "";
  return L.divIcon({
    className: "custom-div-icon",
    html: `<div class="tm-pop" style="position:relative;background-color: ${bgColor}; width: ${size}px; height: ${size}px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; border: 3px solid white; box-shadow: 0 2px 6px rgba(0,0,0,0.35); font-size: ${isNext ? 18 : 14}px;">${ring}${urgentDot}<span style="position:relative;z-index:1">${isNext ? number : glyph}</span></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function MapUpdater({ center }: { center: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    map.flyTo(center, Math.max(map.getZoom(), 14), { duration: 0.8 });
  }, [center, map]);
  return null;
}

export default function RouteMap() {
  const [, setLocation] = useLocation();
  const { data: route, isLoading } = useFieldRouteToday();
  const { data: me } = useFieldMe();
  const { location } = useGps();
  const [promptedShop, setPromptedShop] = useState<number | null>(null);
  // T008 — do'kon bo'yicha bottom sheet (marker yoki karta bosilganda)
  const [sheetShop, setSheetShop] = useState<number | null>(null);
  // T007 — forma saqlagach bir martalik "✓ Saqlandi" animatsiyasi
  const [showSaved, setShowSaved] = useState(() => consumeVisitSaved());
  // Optimal tartib rejimi — saqlangan tartib (dokonId ro'yxati) yoki null
  const [savedOrder, setSavedOrder] = useState<number[] | null>(null);
  const optimalMode = savedOrder !== null;

  const storageKey =
    me && route && !route.dam ? optimalOrderKey(me.agent.id, route.sana) : null;

  // Sahifa ochilganda saqlangan tartibni tiklash + eski kunlarni tozalash
  useEffect(() => {
    if (!storageKey) return;
    cleanupStaleOrders(storageKey);
    const saved = loadSavedOrder(storageKey);
    if (saved) setSavedOrder(saved);
  }, [storageKey]);

  // Boshlang'ich nuqta: agent GPS → oxirgi bajarilgan do'kon → Toshkent
  const startPoint = useMemo(() => {
    if (location) return { lat: location.lat, lon: location.lon };
    const lastCompleted = route?.shops
      .filter(s => s.status !== "pending")
      .sort((a, b) => b.tartib - a.tartib)
      .find(s => s.latitude != null && s.longitude != null);
    if (lastCompleted) return { lat: lastCompleted.latitude!, lon: lastCompleted.longitude! };
    return { lat: 41.2995, lon: 69.2401 };
  }, [route, location]);

  const toggleOptimal = () => {
    if (!route) return;
    if (optimalMode) {
      // Asl tartibga qaytish — saqlangan tartibni o'chirish
      setSavedOrder(null);
      if (storageKey) clearOrder(storageKey);
      return;
    }
    // NN tartibni bir marta hisoblab, saqlab qo'yamiz
    const pending = route.shops.filter(s => s.status === "pending");
    const ids = nearestNeighborSort(pending, startPoint.lat, startPoint.lon).map(s => s.dokonId);
    setSavedOrder(ids);
    if (storageKey) saveOrder(storageKey, ids);
  };

  useEffect(() => {
    if (!showSaved) return;
    const t = setTimeout(() => setShowSaved(false), 1500);
    return () => clearTimeout(t);
  }, [showSaved]);

  const pendingShops = useMemo(() => {
    if (!route) return [];
    const pending = route.shops.filter(s => s.status === "pending");
    if (!savedOrder) {
      return pending.sort((a, b) => a.tartib - b.tartib);
    }
    // Saqlangan tartib bo'yicha: ro'yxatda bo'lmagan (yangi) do'konlar oxiriga
    const pos = new Map(savedOrder.map((id, i) => [id, i]));
    return [...pending].sort((a, b) => {
      const ia = pos.get(a.dokonId);
      const ib = pos.get(b.dokonId);
      if (ia != null && ib != null) return ia - ib;
      if (ia != null) return -1;
      if (ib != null) return 1;
      return a.tartib - b.tartib;
    });
  }, [route, savedOrder]);

  // Optimal rejimda tejaladigan masofa (km): asl tartib vs joriy (saqlangan) tartib
  const savedKm = useMemo(() => {
    if (!route || !savedOrder) return null;
    const pending = route.shops.filter(s => s.status === "pending");
    const withCoords = pending.filter(s => s.latitude != null && s.longitude != null);
    if (withCoords.length < 2) return null;
    const original = [...pending].sort((a, b) => a.tartib - b.tartib);
    const dOrig = totalRouteDistance(original, startPoint.lat, startPoint.lon);
    const dOpt = totalRouteDistance(pendingShops, startPoint.lat, startPoint.lon);
    const savedMeters = dOrig - dOpt;
    if (savedMeters < 100) return null; // arzimas farq — ko'rsatmaymiz
    return { km: savedMeters / 1000, min: estimateEtaMinutes(savedMeters) };
  }, [route, savedOrder, pendingShops, startPoint]);

  // T006 — marshrut hududi plitkalarini fonda oldindan yuklab qo'yamiz
  // (kuniga bir marta): internet yo'q joyda ham xarita ochiladi.
  useEffect(() => {
    if (!route || route.shops.length === 0) return;
    const points = route.shops
      .filter(s => s.latitude != null && s.longitude != null)
      .map(s => ({ lat: s.latitude!, lon: s.longitude! }));
    void prefetchRouteTiles(points);
  }, [route]);

  const nextShop = pendingShops[0];

  const distance = useMemo(() => {
    if (!nextShop || !nextShop.latitude || !nextShop.longitude || !location) return null;
    return calculateDistance(location.lat, location.lon, nextShop.latitude, nextShop.longitude);
  }, [nextShop, location]);

  // Proximity prompt
  useEffect(() => {
    if (distance !== null && distance <= 100 && nextShop && promptedShop !== nextShop.dokonId) {
      if (window.Telegram?.WebApp?.HapticFeedback) {
        window.Telegram.WebApp.HapticFeedback.notificationOccurred("success");
      }
      setPromptedShop(nextShop.dokonId);
    }
  }, [distance, nextShop, promptedShop]);

  if (isLoading || !route) {
    return <div className="flex-1 bg-muted flex items-center justify-center">Loading map...</div>;
  }

  if (route.dam || route.stats.total === 0) {
    // Dam kuni yoki bugungi marshrut bo'sh — xarita o'rniga xabar
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <h1 className="text-2xl font-bold mb-2">
          {route.dam ? "Bugun dam olish kuni" : "Bugun marshrut yo'q"}
        </h1>
        <p className="text-muted-foreground mb-6">{route.sana}</p>
        <Button size="lg" variant="outline" className="w-full h-14" onClick={() => setLocation("/")}>
          Bosh sahifa
        </Button>
      </div>
    );
  }

  if (route.stats.pending === 0) {
    // All done!
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <div className="w-24 h-24 bg-green-100 text-green-600 rounded-full flex items-center justify-center mb-6">
          <Check className="w-12 h-12" />
        </div>
        <h1 className="text-2xl font-bold mb-4">Marshrut yakunlandi!</h1>
        <Button size="lg" className="w-full h-14" onClick={() => setLocation("/summary")}>
          Kunlik hisobot
        </Button>
      </div>
    );
  }

  const mapCenter: [number, number] = nextShop?.latitude && nextShop?.longitude
    ? [nextShop.latitude, nextShop.longitude]
    : [41.2995, 69.2401]; // Tashkent fallback

  // Segmentli marshrut uchun tartib.
  // Normal rejim: barcha koordinatali do'konlar tartib bo'yicha (avvalgi xulq saqlanadi).
  // Optimal rejim: bajarilganlar tartib bo'yicha, so'ng pending NN tartibda.
  const orderedShops = optimalMode
    ? [
        ...route.shops
          .filter(s => s.status !== "pending" && s.latitude && s.longitude)
          .sort((a, b) => a.tartib - b.tartib),
        ...pendingShops.filter(s => s.latitude && s.longitude),
      ]
    : route.shops
        .filter(s => s.latitude && s.longitude)
        .sort((a, b) => a.tartib - b.tartib);

  // Display number for each shop marker (position in the visit sequence)
  const displayTartib = new Map<number, number>(
    orderedShops.map((s, i) => [s.dokonId, i + 1])
  );

  const firstPendingIdx = orderedShops.findIndex(s => s.status === "pending");
  // Segmentlar: bajarilgan=yashil, keyingisiga yo'l=ko'k, qolgani=kulrang shtrix
  const segments = orderedShops.slice(0, -1).map((a, i) => {
    const b = orderedShops[i + 1];
    return {
      pts: [[a.latitude!, a.longitude!], [b.latitude!, b.longitude!]] as [number, number][],
      done: a.status !== "pending" && b.status !== "pending",
      isNextSeg: firstPendingIdx > 0 && i === firstPendingIdx - 1,
    };
  });

  return (
    <div className="flex-1 flex flex-col relative h-full">
      {/* T003 — Jonli marshrut sarlavhasi */}
      <div className="absolute top-4 left-4 right-4 z-[400] bg-background/95 backdrop-blur shadow-md rounded-lg p-3 border">
        <div className="flex justify-between items-end mb-2">
          <span className="text-sm font-semibold text-muted-foreground">
            {nextShop ? `Keyingi: #${displayTartib.get(nextShop.dokonId) ?? nextShop.tartib}` : "Jarayon"}
          </span>
          <span className="font-bold">{route.stats.done} / {route.stats.total}</span>
        </div>
        <div className="h-3 w-full bg-muted rounded-full overflow-hidden mb-2">
          <div 
            className="h-full bg-primary transition-all duration-500" 
            style={{ width: `${(route.stats.done / route.stats.total) * 100}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-muted-foreground font-medium">
          <span>Qoldi: <b className="text-foreground">{route.stats.pending}</b></span>
          <span className="inline-flex items-center gap-1">
            <Clock className="w-3.5 h-3.5" />
            Tugash: <b className="text-foreground">{estimateFinishTime(route.stats.pending, distance)}</b>
          </span>
        </div>
      </div>

      {/* Optimal tartib toggle — header paneldan pastda, xarita ustida suzuvchi tugma */}
      <button
        type="button"
        onClick={toggleOptimal}
        className={[
          "absolute top-[8.5rem] right-4 z-[410]",
          "flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-semibold",
          "shadow-md border transition-colors backdrop-blur",
          optimalMode
            ? "bg-violet-600 text-white border-violet-700"
            : "bg-background/90 text-foreground border-border",
        ].join(" ")}
      >
        {optimalMode
          ? <><ListOrdered className="w-3.5 h-3.5" /> Asl tartib</>
          : <><Shuffle className="w-3.5 h-3.5" /> Optimal tartib</>
        }
      </button>

      {/* Optimal rejimda tejalgan masofa belgisi */}
      {optimalMode && savedKm !== null && (
        <div className="absolute top-[11.25rem] right-4 z-[410] bg-green-600 text-white text-xs font-bold px-3 py-1.5 rounded-full shadow-md animate-in fade-in slide-in-from-top-1 duration-300">
          ~{savedKm.km < 10 ? savedKm.km.toFixed(1) : Math.round(savedKm.km)} km / ~{savedKm.min} min tejaysiz
        </div>
      )}

      <div className="flex-1 z-0 relative">
        <MapContainer center={mapCenter} zoom={13} className="w-full h-full" zoomControl={false}>
          {/* T006 — IndexedDB keshli plitkalar: offline'da ham xarita ishlaydi */}
          <OfflineTileLayer />
          <MapUpdater center={mapCenter} />
          
          {segments.map((seg, i) => (
            <Polyline
              key={i}
              positions={seg.pts}
              pathOptions={
                seg.done
                  ? { color: "#16a34a", weight: 5, opacity: 0.85 }
                  : seg.isNextSeg
                    ? { color: "#2563eb", weight: 6, opacity: 0.9 }
                    : { color: "#9ca3af", weight: 4, opacity: 0.6, dashArray: "8, 8" }
              }
            />
          ))}

          {orderedShops.map((shop) => (
            <Marker 
              key={shop.dokonId}
              position={[shop.latitude!, shop.longitude!]}
              icon={createNumberedIcon(
                displayTartib.get(shop.dokonId) ?? shop.tartib,
                shop.status,
                shop.dokonId === nextShop?.dokonId,
                isUrgentShop(shop)
              )}
              zIndexOffset={shop.dokonId === nextShop?.dokonId ? 1000 : 0}
              eventHandlers={{ click: () => setSheetShop(shop.dokonId) }}
            />
          ))}

          {location && (
             <Marker 
              position={[location.lat, location.lon]}
              icon={L.divIcon({
                className: "user-location",
                html: `<div style="position:relative;width:16px;height:16px"><span class="tm-halo"></span><div style="position:relative;z-index:1;background-color: #3b82f6; width: 16px; height: 16px; border-radius: 50%; border: 3px solid white; box-shadow: 0 0 10px rgba(59,130,246,0.8);"></div></div>`,
                iconSize: [16, 16],
                iconAnchor: [8, 8],
              })}
            />
          )}
        </MapContainer>
      </div>

      {/* Proximity prompt overlay */}
      {promptedShop === nextShop?.dokonId && (
        <div className="absolute inset-0 z-[500] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="bg-card w-full p-6 rounded-2xl shadow-2xl flex flex-col items-center text-center animate-in zoom-in-95 duration-300">
            <div className="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center mb-4">
              <Store className="w-10 h-10 text-primary" />
            </div>
            <h2 className="text-xl font-medium mb-1">Siz yetib keldingiz:</h2>
            <h1 className="text-3xl font-bold mb-6 text-primary">{nextShop.nomi}</h1>
            <p className="text-muted-foreground mb-8">Tashrifni boshlaysizmi?</p>
            <div className="w-full flex gap-3">
              <Button 
                variant="outline" 
                className="flex-1 h-14 text-lg"
                onClick={() => setPromptedShop(null)}
              >
                Yopish
              </Button>
              <Button 
                className="flex-1 h-14 text-lg font-bold"
                onClick={() => setLocation(`/visit/${nextShop.dokonId}`)}
              >
                HA
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom Panel */}
      {nextShop && (
        <div className="bg-card border-t rounded-t-3xl shadow-[0_-10px_40px_rgba(0,0,0,0.1)] p-5 pb-8 z-[400] relative">
          <div className="flex items-center justify-between mb-3">
            <button
              type="button"
              className="text-left min-w-0"
              onClick={() => setSheetShop(nextShop.dokonId)}
            >
              <p className="text-sm font-medium text-muted-foreground mb-1 uppercase tracking-wider flex items-center gap-1.5">
                Keyingi do'kon <Info className="w-3.5 h-3.5" />
              </p>
              <h2 className="text-2xl font-bold line-clamp-1">{nextShop.nomi}</h2>
            </button>
            <Button 
              variant="secondary" 
              size="icon" 
              className="rounded-full w-12 h-12 shrink-0"
              onClick={() => setLocation("/drive")}
            >
              <Car className="w-6 h-6" />
            </Button>
          </div>

          {/* Ustuvorlik sabablari — reja saqlanganda planner'dan kelgan signallar */}
          <UrgencyBadges shop={nextShop} className="mb-3" />

          {/* T004 — boyitilgan ma'lumot: reyting, oxirgi tashrif, oxirgi xarid */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-3 text-sm">
            <RatingStars rating={nextShop.rating} className="text-base" />
            {nextShop.daysSinceVisit !== null && (
              <span className="text-muted-foreground">{nextShop.daysSinceVisit} kun oldin</span>
            )}
            {nextShop.lastPurchase !== null && nextShop.lastPurchase > 0 && (
              <span className="text-muted-foreground">
                Oxirgi xarid: <b className="text-foreground">{formatCurrency(nextShop.lastPurchase)}</b>
              </span>
            )}
          </div>

          <div className="flex gap-4 mb-5">
            <div className="flex items-center gap-2 text-lg">
              <Navigation2 className="w-5 h-5 text-blue-500" />
              <span className="font-semibold">{distance !== null ? `${distance} m` : "Hisoblanmoqda..."}</span>
            </div>
            {distance !== null && (
              <div className="flex items-center gap-2 text-lg">
                <Clock className="w-5 h-5 text-amber-500" />
                <span className="font-semibold">{estimateEtaMinutes(distance)} min</span>
              </div>
            )}
          </div>

          <div className="space-y-3">
            {nextShop.latitude != null && nextShop.longitude != null && (
              <NavButtons lat={nextShop.latitude} lng={nextShop.longitude} />
            )}
            <Button 
              className="h-14 font-bold text-lg w-full shadow-lg"
              onClick={() => setLocation(`/visit/${nextShop.dokonId}`)}
            >
              TASHRIF
            </Button>
          </div>
        </div>
      )}

      {/* T008 — do'kon bottom sheet */}
      <ShopSheet dokonId={sheetShop} onClose={() => setSheetShop(null)} />

      {/* T007 — "Saqlandi" animatsiyasi */}
      {showSaved && (
        <div className="absolute inset-0 z-[700] bg-black/50 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="bg-card rounded-3xl shadow-2xl px-10 py-8 flex flex-col items-center animate-in zoom-in-90 fade-in duration-300">
            <div className="w-20 h-20 bg-green-500 text-white rounded-full flex items-center justify-center mb-4 animate-in zoom-in-50 duration-500">
              <Check className="w-11 h-11" strokeWidth={3} />
            </div>
            <div className="text-xl font-bold mb-1">Saqlandi!</div>
            <div className="text-sm text-muted-foreground">Keyingi do'kon...</div>
          </div>
        </div>
      )}
    </div>
  );
}

function optimalOrderKey(agentId: number, sana: string): string {
  return `${OPTIMAL_ORDER_PREFIX}${agentId}:${sana}`;
}

function clearOrder(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

/** Eski kunlarning saqlangan tartiblarini tozalash (localStorage to'lib ketmasin). */
function cleanupStaleOrders(currentKey: string) {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(OPTIMAL_ORDER_PREFIX) && k !== currentKey) stale.push(k);
    }
    stale.forEach(k => localStorage.removeItem(k));
  } catch {}
}

function loadSavedOrder(key: string): number[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.every(x => typeof x === "number")) return arr;
  } catch {}
  return null;
}

function saveOrder(key: string, ids: number[]) {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {}
}
