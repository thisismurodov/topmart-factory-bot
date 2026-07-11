import { useEffect, useState, useMemo } from "react";
import { useLocation } from "wouter";
import { MapContainer, TileLayer, Marker, Polyline, useMap } from "react-leaflet";
import L from "leaflet";
import { useFieldRouteToday } from "@/lib/fieldApi";
import { useGps } from "@/hooks/useGps";
import { calculateDistance, estimateEtaMinutes } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Navigation2, Car, Store, Check, Target, Clock, MapPin } from "lucide-react";

// Fix for leaflet markers in react
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

function createNumberedIcon(number: number, status: string) {
  let bgColor = "#f59e0b"; // amber (pending)
  if (status === "sold") bgColor = "#10b981"; // green
  else if (status === "nosale") bgColor = "#ef4444"; // red

  return L.divIcon({
    className: "custom-div-icon",
    html: `<div style="background-color: ${bgColor}; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; border: 2px solid white; box-shadow: 0 2px 5px rgba(0,0,0,0.3); font-size: 14px;">${number}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function MapUpdater({ center }: { center: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, map.getZoom());
  }, [center, map]);
  return null;
}

export default function RouteMap() {
  const [, setLocation] = useLocation();
  const { data: route, isLoading } = useFieldRouteToday();
  const { location } = useGps();
  const [promptedShop, setPromptedShop] = useState<number | null>(null);

  const pendingShops = useMemo(() => {
    if (!route) return [];
    return route.shops.filter(s => s.status === "pending").sort((a, b) => a.tartib - b.tartib);
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

  const routePositions: [number, number][] = route.shops
    .filter(s => s.latitude && s.longitude)
    .map(s => [s.latitude!, s.longitude!]);

  return (
    <div className="flex-1 flex flex-col relative h-full">
      {/* Top progress bar */}
      <div className="absolute top-4 left-4 right-4 z-[400] bg-background/95 backdrop-blur shadow-md rounded-lg p-3 border">
        <div className="flex justify-between items-end mb-2">
          <span className="text-sm font-semibold text-muted-foreground">Jarayon</span>
          <span className="font-bold">{route.stats.done} / {route.stats.total}</span>
        </div>
        <div className="h-3 w-full bg-muted rounded-full overflow-hidden">
          <div 
            className="h-full bg-primary transition-all duration-500" 
            style={{ width: `${(route.stats.done / route.stats.total) * 100}%` }}
          />
        </div>
      </div>

      <div className="flex-1 z-0 relative">
        <MapContainer center={mapCenter} zoom={13} className="w-full h-full" zoomControl={false}>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <MapUpdater center={mapCenter} />
          
          <Polyline positions={routePositions} color="#3b82f6" weight={4} opacity={0.6} dashArray="8, 8" />

          {route.shops.filter(s => s.latitude && s.longitude).map((shop) => (
            <Marker 
              key={shop.dokonId}
              position={[shop.latitude!, shop.longitude!]}
              icon={createNumberedIcon(shop.tartib, shop.status)}
            />
          ))}

          {location && (
             <Marker 
              position={[location.lat, location.lon]}
              icon={L.divIcon({
                className: "user-location",
                html: `<div style="background-color: #3b82f6; width: 16px; height: 16px; border-radius: 50%; border: 3px solid white; box-shadow: 0 0 10px rgba(59,130,246,0.8);"></div>`,
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
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm font-medium text-muted-foreground mb-1 uppercase tracking-wider">Keyingi do'kon</p>
              <h2 className="text-2xl font-bold line-clamp-1">{nextShop.nomi}</h2>
            </div>
            <Button 
              variant="secondary" 
              size="icon" 
              className="rounded-full w-12 h-12"
              onClick={() => setLocation("/drive")}
            >
              <Car className="w-6 h-6" />
            </Button>
          </div>

          <div className="flex gap-4 mb-6">
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

          <div className="grid grid-cols-3 gap-3">
            {nextShop.latitude && nextShop.longitude ? (
               <Button 
                variant="outline" 
                className="h-14 font-semibold col-span-1"
                onClick={() => {
                  window.open(`https://www.google.com/maps/dir/?api=1&destination=${nextShop.latitude},${nextShop.longitude}`, '_blank');
                }}
              >
                <MapPin className="mr-2 w-5 h-5" />
                Xarita
              </Button>
            ) : (
              <div className="col-span-1"></div>
            )}
            
            <Button 
              className="h-14 font-bold text-lg col-span-2 shadow-lg"
              onClick={() => setLocation(`/visit/${nextShop.dokonId}`)}
            >
              TASHRIF
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
