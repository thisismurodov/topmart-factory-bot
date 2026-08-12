import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import L from "leaflet";
import { authFetch } from "@/App";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MapPin, Loader2, CheckCircle, X, Edit2 } from "lucide-react";

// Do'kon GPS joylashuvini tahrirlash: mini-xarita + sudraladigan pin + lat/lon kiritish.
// Saqlash PATCH /api/distribution/shops/:id orqali darhol bazaga yoziladi.

const DEFAULT_CENTER: [number, number] = [41.2995, 69.2401]; // Toshkent

const pinIcon = L.divIcon({
  className: "",
  html: `<div style="width:26px;height:26px;border-radius:50% 50% 50% 0;background:#4f46e5;transform:rotate(-45deg);border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center"><div style="width:8px;height:8px;border-radius:50%;background:white;transform:rotate(45deg)"></div></div>`,
  iconSize: [26, 26],
  iconAnchor: [13, 26],
});

export default function ShopLocationEditor({
  shopId,
  latitude,
  longitude,
}: {
  shopId: number;
  latitude: number | null;
  longitude: number | null;
}) {
  const qc = useQueryClient();
  const hasCoord = latitude !== null && longitude !== null;
  const [editing, setEditing] = useState(false);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  // Tahrirlash ochilganda joriy koordinatani inputlarga yozamiz
  const startEdit = () => {
    setLat(latitude !== null ? String(latitude) : "");
    setLng(longitude !== null ? String(longitude) : "");
    setErr(null);
    setSaved(false);
    setEditing(true);
  };

  // Xarita init — faqat tahrirlash rejimida
  useEffect(() => {
    if (!editing || !mapEl.current) return;
    const start: [number, number] = hasCoord ? [latitude as number, longitude as number] : DEFAULT_CENTER;
    const map = L.map(mapEl.current, { zoomControl: true }).setView(start, hasCoord ? 15 : 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; OpenStreetMap',
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
        setLat(p.lat.toFixed(6));
        setLng(p.lng.toFixed(6));
      });
      markerRef.current = m;
    };

    if (hasCoord) placeMarker(start);
    // Xaritani bosish ham pinni ko'chiradi (koordinatasi yo'q do'konlar uchun qulay)
    map.on("click", (e: L.LeafletMouseEvent) => {
      placeMarker([e.latlng.lat, e.latlng.lng]);
      setLat(e.latlng.lat.toFixed(6));
      setLng(e.latlng.lng.toFixed(6));
    });

    // Sheet animatsiyasidan keyin o'lchamni tuzatish
    const t = setTimeout(() => map.invalidateSize(), 250);
    mapRef.current = map;
    return () => {
      clearTimeout(t);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Inputlardan pinni ko'chirish
  useEffect(() => {
    if (!editing || !mapRef.current) return;
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
        setLat(p.lat.toFixed(6));
        setLng(p.lng.toFixed(6));
      });
      markerRef.current = m;
      mapRef.current.setView(pos, 15);
    }
  }, [lat, lng, editing]);

  const save = async () => {
    const la = parseFloat(lat), ln = parseFloat(lng);
    if (!Number.isFinite(la) || la < -90 || la > 90) {
      setErr("Latitude noto'g'ri (masalan: 41.2995)");
      return;
    }
    if (!Number.isFinite(ln) || ln < -180 || ln > 180) {
      setErr("Longitude noto'g'ri (masalan: 69.2401)");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const r = await authFetch(`/api/distribution/shops/${shopId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latitude: la, longitude: ln }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setErr(j.error || "Xatolik yuz berdi");
        return;
      }
      setSaved(true);
      setEditing(false);
      // Drawer, xarita, marshrut va bad-coord ro'yxatlarini yangilash
      void qc.invalidateQueries({ queryKey: ["distribution"] });
    } catch {
      setErr("Server bilan bog'lanib bo'lmadi");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold flex items-center gap-1.5">
          <MapPin className="w-3.5 h-3.5 text-indigo-600" /> GPS joylashuv
        </div>
        {!editing ? (
          <button
            type="button"
            onClick={startEdit}
            className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800"
          >
            <Edit2 className="w-3 h-3" /> {hasCoord ? "Tahrirlash" : "Belgilash"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => { setEditing(false); setErr(null); }}
            className="text-muted-foreground hover:text-foreground"
            title="Bekor qilish"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {!editing && (
        <div className="text-xs text-muted-foreground font-mono">
          {saved && <CheckCircle className="inline w-3.5 h-3.5 text-green-600 mr-1 -mt-0.5" />}
          {hasCoord ? `${(latitude as number).toFixed(6)}, ${(longitude as number).toFixed(6)}` : "Koordinata kiritilmagan"}
        </div>
      )}

      {editing && (
        <div className="space-y-2">
          <div ref={mapEl} className="h-56 w-full rounded-md overflow-hidden border z-0" />
          <p className="text-[11px] text-muted-foreground">
            Pinni sudrab yoki xaritani bosib joyni belgilang — yoki aniq koordinatani kiriting
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-muted-foreground">Latitude</label>
              <Input
                className="h-8 w-36 text-xs font-mono"
                placeholder="41.2995"
                value={lat}
                onChange={(e) => setLat(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-muted-foreground">Longitude</label>
              <Input
                className="h-8 w-36 text-xs font-mono"
                placeholder="69.2401"
                value={lng}
                onChange={(e) => setLng(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
              />
            </div>
            <Button
              size="sm"
              className="h-8 text-xs bg-indigo-600 hover:bg-indigo-700 text-white"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Saqlash"}
            </Button>
          </div>
          {err && <div className="text-xs text-red-600">{err}</div>}
        </div>
      )}
    </div>
  );
}
