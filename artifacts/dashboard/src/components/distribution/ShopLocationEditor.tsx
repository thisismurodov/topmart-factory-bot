import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { authFetch } from "@/App";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MapPin, Loader2, CheckCircle, X, Edit2 } from "lucide-react";
import LocationMapPicker from "@/components/distribution/LocationMapPicker";

// Do'kon GPS joylashuvini tahrirlash: mini-xarita + sudraladigan pin + lat/lon kiritish.
// Saqlash PATCH /api/distribution/shops/:id orqali darhol bazaga yoziladi.

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

  // Tahrirlash ochilganda joriy koordinatani inputlarga yozamiz
  const startEdit = () => {
    setLat(latitude !== null ? String(latitude) : "");
    setLng(longitude !== null ? String(longitude) : "");
    setErr(null);
    setSaved(false);
    setEditing(true);
  };

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
          <LocationMapPicker lat={lat} lng={lng} onChange={(la, ln) => { setLat(la); setLng(ln); }} />
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
