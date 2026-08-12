import { useEffect, useRef } from "react";
import L from "leaflet";

// Qayta ishlatiladigan mini-xarita: sudraladigan pin + bosib joy tanlash.
// ShopLocationEditor va BadCoordPanel ikkalasida ishlatiladi.

const DEFAULT_CENTER: [number, number] = [41.2995, 69.2401]; // Toshkent

const pinIcon = L.divIcon({
  className: "",
  html: `<div style="width:26px;height:26px;border-radius:50% 50% 50% 0;background:#4f46e5;transform:rotate(-45deg);border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center"><div style="width:8px;height:8px;border-radius:50%;background:white;transform:rotate(45deg)"></div></div>`,
  iconSize: [26, 26],
  iconAnchor: [13, 26],
});

export default function LocationMapPicker({
  lat,
  lng,
  onChange,
  className = "h-56 w-full rounded-md overflow-hidden border z-0",
}: {
  /** Joriy latitude matni (input bilan sinxron) */
  lat: string;
  /** Joriy longitude matni (input bilan sinxron) */
  lng: string;
  /** Pin sudralganda yoki xarita bosilganda chaqiriladi */
  onChange: (lat: string, lng: string) => void;
  className?: string;
}) {
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Xarita init — bir marta
  useEffect(() => {
    if (!mapEl.current) return;
    const la = parseFloat(lat), ln = parseFloat(lng);
    const hasCoord =
      Number.isFinite(la) && la >= -90 && la <= 90 &&
      Number.isFinite(ln) && ln >= -180 && ln <= 180;
    const start: [number, number] = hasCoord ? [la, ln] : DEFAULT_CENTER;
    const map = L.map(mapEl.current, { zoomControl: true }).setView(start, hasCoord ? 15 : 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap",
      maxZoom: 19,
    }).addTo(map);

    const placeMarker = (pos: [number, number]) => {
      if (markerRef.current) {
        markerRef.current.setLatLng(pos);
        return;
      }
      const m = L.marker(pos, { draggable: true, icon: pinIcon }).addTo(map);
      m.on("dragend", () => {
        const p = m.getLatLng();
        onChangeRef.current(p.lat.toFixed(6), p.lng.toFixed(6));
      });
      markerRef.current = m;
    };

    if (hasCoord) placeMarker(start);
    // Xaritani bosish ham pinni ko'chiradi (koordinatasi yo'q do'konlar uchun qulay)
    map.on("click", (e: L.LeafletMouseEvent) => {
      placeMarker([e.latlng.lat, e.latlng.lng]);
      onChangeRef.current(e.latlng.lat.toFixed(6), e.latlng.lng.toFixed(6));
    });

    // Panel/sheet animatsiyasidan keyin o'lchamni tuzatish
    const t = setTimeout(() => map.invalidateSize(), 250);
    mapRef.current = map;
    return () => {
      clearTimeout(t);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Inputlardan pinni ko'chirish
  useEffect(() => {
    if (!mapRef.current) return;
    const la = parseFloat(lat), ln = parseFloat(lng);
    if (!Number.isFinite(la) || la < -90 || la > 90) return;
    if (!Number.isFinite(ln) || ln < -180 || ln > 180) return;
    const pos: [number, number] = [la, ln];
    if (markerRef.current) {
      const cur = markerRef.current.getLatLng();
      if (Math.abs(cur.lat - la) > 1e-9 || Math.abs(cur.lng - ln) > 1e-9) {
        markerRef.current.setLatLng(pos);
        mapRef.current.panTo(pos);
      }
    } else {
      const m = L.marker(pos, { draggable: true, icon: pinIcon }).addTo(mapRef.current);
      m.on("dragend", () => {
        const p = m.getLatLng();
        onChangeRef.current(p.lat.toFixed(6), p.lng.toFixed(6));
      });
      markerRef.current = m;
      mapRef.current.setView(pos, 15);
    }
  }, [lat, lng]);

  return <div ref={mapEl} className={className} data-testid="location-map-picker" />;
}
