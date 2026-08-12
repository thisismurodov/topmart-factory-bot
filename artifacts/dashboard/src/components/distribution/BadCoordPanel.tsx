import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "@/App";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MapPin, AlertTriangle, CheckCircle, ChevronDown, ChevronRight, Loader2, Edit2, X } from "lucide-react";
import RoutePlanDialog from "@/components/distribution/RoutePlanDialog";

// Koordinatasi yo'q yoki shubhali do'konlar ro'yxati + GPS tahrirlash.
// "Qayta rejalash" tugmasi RoutePlanDialog'ni ochadi.

type BadCoordShop = {
  id: number;
  nomi: string | null;
  viloyat: string | null;
  hudud: string | null;
  lat: number;
  lng: number;
};

type NoCoordShop = {
  id: number;
  nomi: string | null;
  viloyat: string | null;
  hudud: string | null;
};

type BadCoordData = {
  noCoord: NoCoordShop[];
  badCoord: BadCoordShop[];
};

type PlanAgent = { id: number; name: string | null; mashinaNomeri: string | null };

// ── GPS tahrirlash qatori ──────────────────────────────────────────────────────
function EditRow({
  id,
  nomi,
  viloyat,
  hudud,
  currentLat,
  currentLng,
  onSaved,
}: {
  id: number;
  nomi: string | null;
  viloyat: string | null;
  hudud: string | null;
  currentLat?: number;
  currentLng?: number;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [lat, setLat] = useState(currentLat != null ? String(currentLat) : "");
  const [lng, setLng] = useState(currentLng != null ? String(currentLng) : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // 409 gps_outlier: yangi koordinata viloyat medianidan >60 km — menejer
  // aniq tasdiqlasa (confirmOutlier: true) qayta yuboriladi.
  const [outlierKm, setOutlierKm] = useState<number | null>(null);

  const save = async (confirmOutlier = false) => {
    const latN = parseFloat(lat);
    const lngN = parseFloat(lng);
    if (!Number.isFinite(latN) || latN < -90 || latN > 90) {
      setErr("Latitude noto'g'ri (masalan: 41.2995)");
      return;
    }
    if (!Number.isFinite(lngN) || lngN < -180 || lngN > 180) {
      setErr("Longitude noto'g'ri (masalan: 69.2401)");
      return;
    }
    setSaving(true);
    setErr(null);
    if (!confirmOutlier) setOutlierKm(null);
    try {
      const r = await authFetch(`/api/distribution/shops/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latitude: latN, longitude: lngN, ...(confirmOutlier ? { confirmOutlier: true } : {}) }),
      });
      if (!r.ok) {
        const j = (await r.json()) as { error?: string; distanceKm?: number };
        if (r.status === 409 && j.error === "gps_outlier") {
          setOutlierKm(j.distanceKm ?? 0);
          return;
        }
        setErr(j.error || "Xatolik yuz berdi");
        return;
      }
      setOutlierKm(null);
      setSaved(true);
      setEditing(false);
      onSaved();
    } catch {
      setErr("Server bilan bog'lanib bo'lmadi");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="py-1.5 px-2 rounded-md hover:bg-muted/40 transition-colors">
      <div className="flex items-center gap-2 min-w-0">
        {saved ? (
          <CheckCircle className="w-3.5 h-3.5 text-green-600 shrink-0" />
        ) : (
          <MapPin className="w-3.5 h-3.5 text-amber-500 shrink-0" />
        )}
        <span className="text-sm font-medium truncate flex-1 min-w-0">{nomi || `#${id}`}</span>
        {(viloyat || hudud) && (
          <span className="text-[11px] text-muted-foreground shrink-0">
            {[viloyat, hudud].filter(Boolean).join(", ")}
          </span>
        )}
        {currentLat != null && currentLng != null && !editing && !saved && (
          <span className="text-[11px] text-muted-foreground font-mono shrink-0">
            {currentLat.toFixed(4)}, {currentLng.toFixed(4)}
          </span>
        )}
        {saved && (
          <span className="text-[11px] text-green-600 shrink-0">✓ Saqlandi</span>
        )}
        {!saved && !editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="ml-auto flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 shrink-0"
            title="GPS ni tahrirlash"
          >
            <Edit2 className="w-3 h-3" /> Tahrirlash
          </button>
        )}
        {editing && (
          <button
            type="button"
            onClick={() => { setEditing(false); setErr(null); }}
            className="ml-auto text-muted-foreground hover:text-foreground shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-1.5 flex flex-wrap items-start gap-2 pl-5">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-muted-foreground">Latitude</label>
            <Input
              className="h-7 w-32 text-xs font-mono"
              placeholder="41.2995"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-muted-foreground">Longitude</label>
            <Input
              className="h-7 w-32 text-xs font-mono"
              placeholder="69.2401"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-transparent select-none">.</label>
            <Button
              size="sm"
              className="h-7 text-xs bg-indigo-600 hover:bg-indigo-700 text-white"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : "Saqlash"}
            </Button>
          </div>
          {err && (
            <div className="w-full text-xs text-red-600 pl-0">{err}</div>
          )}
          {outlierKm != null && (
            <div className="w-full rounded-md border border-red-300 bg-red-50 dark:bg-red-950/20 dark:border-red-800 p-2 text-xs" data-testid="gps-outlier-confirm">
              <div className="text-red-700 dark:text-red-400 mb-1.5">
                ⚠️ Yangi koordinata viloyat dokonlaridan ~{outlierKm} km uzoqda — xato bo'lishi mumkin.
                Do'kon haqiqatan shu yerda bo'lsa, tasdiqlab saqlang.
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="h-7 text-xs bg-red-600 hover:bg-red-700 text-white"
                  disabled={saving}
                  onClick={() => void save(true)}
                  data-testid="button-confirm-outlier"
                >
                  {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : "Baribir saqlash"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={saving}
                  onClick={() => setOutlierKm(null)}
                >
                  Bekor qilish
                </Button>
              </div>
            </div>
          )}
          <div className="w-full text-[10px] text-muted-foreground">
            Google Maps'da do'kon pinini o'ng bosing → "Bu yerning koordinatlari" → nusxalang
          </div>
        </div>
      )}
    </div>
  );
}

type RouteMapData = {
  allAgents: PlanAgent[];
};

// ── Asosiy panel ───────────────────────────────────────────────────────────────
export default function BadCoordPanel() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data, isLoading, refetch } = useQuery<BadCoordData>({
    queryKey: ["distribution", "shops-bad-coord"],
    queryFn: async () => {
      const r = await authFetch("/api/distribution/shops/bad-coord");
      if (!r.ok) throw new Error("Ma'lumot yuklanmadi");
      return r.json();
    },
    staleTime: 60_000,
  });

  // Agentlar ro'yxati — RouteWeekMap bilan bitta queryKey, kesh umumiy
  const { data: mapData } = useQuery<RouteMapData>({
    queryKey: ["distribution", "route-map", ""],
    queryFn: async () => {
      const r = await authFetch("/api/distribution/route-map");
      if (!r.ok) throw new Error("Marshrut xaritasi yuklanmadi");
      return r.json();
    },
    staleTime: 60_000,
  });
  const allAgents: PlanAgent[] = mapData?.allAgents ?? [];

  const total = (data?.noCoord.length ?? 0) + (data?.badCoord.length ?? 0);
  if (!isLoading && total === 0) return null;

  const onSaved = () => {
    // Ro'yxatni yangilash
    void refetch();
    // Xarita va marshrut ma'lumotlarini ham yangilash
    qc.invalidateQueries({ queryKey: ["distribution", "route-map"] });
  };

  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800">
      {/* Header */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left"
      >
        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
        <span className="text-sm font-medium text-amber-800 dark:text-amber-300 flex-1">
          {isLoading ? "Koordinata muammolari tekshirilmoqda…" : (
            total > 0
              ? `${total} ta do'kon marshrutsiz — koordinata muammosi`
              : "Koordinata muammolari yo'q"
          )}
        </span>
        {!isLoading && total > 0 && (
          <Badge variant="outline" className="border-amber-400 text-amber-700 dark:text-amber-400 shrink-0 text-[10px]">
            {total} ta
          </Badge>
        )}
        {open ? (
          <ChevronDown className="w-4 h-4 text-amber-600 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-amber-600 shrink-0" />
        )}
      </button>

      {open && data && (
        <div className="px-3 pb-3 space-y-3 border-t border-amber-200 dark:border-amber-800 pt-2.5">
          {/* Koordinatasi yo'q */}
          {data.noCoord.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-1.5 flex items-center gap-1.5">
                <MapPin className="w-3 h-3" /> Koordinatasi yo'q ({data.noCoord.length} ta)
              </div>
              <div className="space-y-0.5">
                {data.noCoord.map((s) => (
                  <EditRow
                    key={s.id}
                    id={s.id}
                    nomi={s.nomi}
                    viloyat={s.viloyat}
                    hudud={s.hudud}
                    onSaved={onSaved}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Shubhali koordinatalar */}
          {data.badCoord.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-1.5 flex items-center gap-1.5">
                <AlertTriangle className="w-3 h-3" /> Koordinatasi shubhali — viloyat medianidan 60 km+ uzoq ({data.badCoord.length} ta)
              </div>
              <div className="space-y-0.5">
                {data.badCoord.map((s) => (
                  <EditRow
                    key={s.id}
                    id={s.id}
                    nomi={s.nomi}
                    viloyat={s.viloyat}
                    hudud={s.hudud}
                    currentLat={s.lat}
                    currentLng={s.lng}
                    onSaved={onSaved}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Footer: re-plan tugmasi */}
          <div className="flex items-center justify-between gap-2 pt-1 border-t border-amber-200 dark:border-amber-800">
            <p className="text-[11px] text-amber-700 dark:text-amber-400">
              GPS ni to'g'rilangach, agentga yangi marshrut rejalashtiring
            </p>
            <RoutePlanDialog agents={allAgents} />
          </div>
        </div>
      )}
    </div>
  );
}
