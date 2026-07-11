import { useState, useEffect, useRef } from "react";
import { submitGps } from "@/lib/fieldApi";

interface Location {
  lat: number;
  lon: number;
  accuracy: number;
}

export function useGps() {
  const [location, setLocation] = useState<Location | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastPingTime = useRef<number>(0);

  useEffect(() => {
    if (!navigator.geolocation) {
      setError("GPS qo'llab quvvatlanmaydi");
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        const newLoc = { lat: latitude, lon: longitude, accuracy };
        setLocation(newLoc);
        setError(null);

        // Ping server at most once every 60 seconds
        const now = Date.now();
        if (navigator.onLine && now - lastPingTime.current >= 60000) {
          lastPingTime.current = now;
          submitGps({ lat: latitude, lon: longitude }).catch(() => {
            // ignore network errors for GPS pings
          });
        }
      },
      (err) => {
        setError(err.message);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 10000,
        timeout: 10000,
      }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  return { location, error };
}
