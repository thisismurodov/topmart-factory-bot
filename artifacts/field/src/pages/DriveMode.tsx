import { useLocation } from "wouter";
import { useFieldRouteToday } from "@/lib/fieldApi";
import { useGps } from "@/hooks/useGps";
import { calculateDistance, estimateEtaMinutes } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import NavButtons from "@/components/NavButtons";
import { useMemo } from "react";
import { Map, Navigation2 } from "lucide-react";

export default function DriveMode() {
  const [, setLocation] = useLocation();
  const { data: route } = useFieldRouteToday();
  const { location } = useGps();

  const nextShop = useMemo(() => {
    if (!route) return null;
    return route.shops.filter(s => s.status === "pending").sort((a, b) => a.tartib - b.tartib)[0];
  }, [route]);

  const distance = useMemo(() => {
    if (!nextShop || !nextShop.latitude || !nextShop.longitude || !location) return null;
    return calculateDistance(location.lat, location.lon, nextShop.latitude, nextShop.longitude);
  }, [nextShop, location]);

  if (!nextShop) {
    setLocation("/map");
    return null;
  }

  return (
    <div className="flex-1 bg-black text-white flex flex-col items-center justify-center p-6 text-center">
      <div className="flex-1 flex flex-col justify-center items-center w-full">
        <Navigation2 className="w-24 h-24 text-blue-500 mb-8 animate-pulse" />
        
        <h3 className="text-xl text-gray-400 font-medium mb-2 tracking-widest uppercase">Keyingi manzil</h3>
        <h1 className="text-5xl font-bold mb-12 leading-tight">{nextShop.nomi}</h1>

        {distance !== null ? (
          <div className="flex flex-col items-center gap-4 mb-16">
            <div className="text-7xl font-black text-blue-400">{distance > 1000 ? (distance/1000).toFixed(1) + ' km' : distance + ' m'}</div>
            <div className="text-3xl font-medium text-amber-400">{estimateEtaMinutes(distance)} daqiqa</div>
          </div>
        ) : (
          <div className="text-2xl text-gray-500 mb-16">GPS kutilmoqda...</div>
        )}
      </div>

      <div className="w-full gap-4 flex flex-col pb-8">
        {nextShop.latitude != null && nextShop.longitude != null && (
          <NavButtons lat={nextShop.latitude} lng={nextShop.longitude} dark />
        )}
        <Button 
          className="w-full h-24 text-3xl font-black bg-primary hover:bg-primary/90 text-primary-foreground rounded-2xl"
          onClick={() => setLocation(`/visit/${nextShop.dokonId}`)}
        >
          YETIB KELDIM
        </Button>
        <Button 
          variant="outline" 
          className="w-full h-16 text-xl border-gray-700 text-gray-300 hover:bg-gray-800 rounded-2xl"
          onClick={() => setLocation("/map")}
        >
          <Map className="mr-2" /> Xaritaga qaytish
        </Button>
      </div>
    </div>
  );
}
