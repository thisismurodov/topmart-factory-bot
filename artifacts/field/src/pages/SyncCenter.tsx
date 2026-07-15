import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { useSyncStatus } from "@/hooks/useSyncStatus";
import { getAllEvents, discardEvent, QUEUE_UPDATED_EVENT } from "@/lib/eventQueue";
import { triggerSync, retryFailedAndSync } from "@/lib/syncEngine";
import { clearOfflineCache, type FieldEvent, type FieldOperation } from "@/lib/idb";
import {
  ArrowLeft,
  RefreshCw,
  RotateCcw,
  Trash2,
  CloudOff,
  CheckCircle2,
  AlertTriangle,
  Clock,
} from "lucide-react";

// T008 — Sinxronizatsiya markazi

const OP_LABEL: Record<FieldOperation, string> = {
  SALE: "Savdo",
  NO_SALE: "Olinmadi",
  PAYMENT: "Pul olish",
  NEW_SHOP: "Yangi do'kon",
};

function fmtTime(ts: number | string | null): string {
  if (!ts) return "—";
  const d = typeof ts === "string" ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("uz-UZ", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function networkLabel(): string {
  if (typeof navigator === "undefined") return "—";
  if (!navigator.onLine) return "Yo'q";
  const conn = (navigator as unknown as { connection?: { effectiveType?: string } }).connection;
  return conn?.effectiveType ? conn.effectiveType.toUpperCase() : "Bor";
}

export default function SyncCenter() {
  const [, setLocation] = useLocation();
  const status = useSyncStatus();
  const [events, setEvents] = useState<FieldEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [cacheCleared, setCacheCleared] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void getAllEvents().then((list) => {
        if (alive) setEvents(list);
      });
    };
    load();
    window.addEventListener(QUEUE_UPDATED_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(QUEUE_UPDATED_EVENT, load);
    };
  }, []);

  const pending = events.filter((e) => e.syncStatus !== "failed");
  const failed = events.filter((e) => e.syncStatus === "failed");

  const handleSyncNow = async () => {
    setBusy(true);
    try {
      await triggerSync({ manual: true });
    } finally {
      setBusy(false);
    }
  };

  const handleRetryFailed = async () => {
    setBusy(true);
    try {
      await retryFailedAndSync();
    } finally {
      setBusy(false);
    }
  };

  const handleClearCache = async () => {
    if (!window.confirm("Kesh tozalansinmi? (Navbatdagi ma'lumotlar O'CHMAYDI)")) return;
    setBusy(true);
    try {
      await clearOfflineCache();
      setCacheCleared(true);
      window.setTimeout(() => setCacheCleared(false), 3000);
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async (e: FieldEvent) => {
    if (
      !window.confirm(
        `"${OP_LABEL[e.operation]}" hodisasi butunlay o'chirilsinmi? Bu ma'lumot ERP'ga YUBORILMAYDI.`,
      )
    )
      return;
    await discardEvent(e.eventId);
  };

  return (
    <div className="flex-1 flex flex-col bg-background h-full overflow-y-auto">
      <div className="p-4 border-b bg-card sticky top-0 z-10 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => setLocation("/")}>
          <ArrowLeft />
        </Button>
        <div className="flex-1">
          <h2 className="font-bold text-lg leading-tight">Sinxronizatsiya markazi</h2>
          <p className="text-xs text-muted-foreground">Offline navbat va holat</p>
        </div>
        {status.connection === "offline" ? (
          <CloudOff className="w-6 h-6 text-red-500" />
        ) : (
          <CheckCircle2 className="w-6 h-6 text-emerald-500" />
        )}
      </div>

      <div className="p-4 space-y-4 pb-24">
        {/* Holat kartasi */}
        <div className="rounded-2xl border bg-card p-4 grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">Holat</div>
            <div className="font-semibold">
              {status.connection === "offline"
                ? "🔴 Offline"
                : status.connection === "syncing"
                  ? "🟡 Sinxronlash"
                  : "🟢 Online"}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Oxirgi sinxron</div>
            <div className="font-semibold">{fmtTime(status.lastSyncAt)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Kutilayotgan</div>
            <div className="font-semibold">{pending.length} ta</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Xatolik</div>
            <div className={`font-semibold ${failed.length > 0 ? "text-red-600" : ""}`}>
              {failed.length} ta
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Navbat hajmi</div>
            <div className="font-semibold">{events.length} ta</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Tarmoq</div>
            <div className="font-semibold">{networkLabel()}</div>
          </div>
        </div>

        {/* Tugmalar */}
        <div className="grid grid-cols-2 gap-2">
          <Button
            className="rounded-xl h-12"
            onClick={handleSyncNow}
            disabled={busy || status.connection === "offline"}
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${status.syncing ? "animate-spin" : ""}`} />
            Hozir sinxronlash
          </Button>
          <Button
            variant="secondary"
            className="rounded-xl h-12"
            onClick={handleRetryFailed}
            disabled={busy || failed.length === 0}
          >
            <RotateCcw className="w-4 h-4 mr-2" />
            Xatolarni qayta yuborish
          </Button>
        </div>
        <Button
          variant="outline"
          className="rounded-xl w-full text-muted-foreground"
          onClick={handleClearCache}
          disabled={busy}
        >
          <Trash2 className="w-4 h-4 mr-2" />
          {cacheCleared ? "Kesh tozalandi ✓" : "Keshni tozalash (Admin)"}
        </Button>

        {/* Xato hodisalar */}
        {failed.length > 0 && (
          <div>
            <h3 className="font-semibold text-sm mb-2 flex items-center gap-1.5 text-red-600">
              <AlertTriangle className="w-4 h-4" /> Xatolik bilan tugagan
            </h3>
            <div className="space-y-2">
              {failed.map((e) => (
                <div key={e.eventId} className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{OP_LABEL[e.operation]}</span>
                    <span className="text-xs text-muted-foreground">{fmtTime(e.createdAt)}</span>
                  </div>
                  <div className="text-xs text-red-700 mt-1">
                    {e.lastErrorStatus ? `[${e.lastErrorStatus}] ` : ""}
                    {e.lastErrorMessage || "Noma'lum xato"}
                  </div>
                  <div className="flex justify-end mt-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-red-600"
                      onClick={() => handleDiscard(e)}
                    >
                      <Trash2 className="w-3 h-3 mr-1" /> O'chirish
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Kutilayotgan hodisalar */}
        <div>
          <h3 className="font-semibold text-sm mb-2 flex items-center gap-1.5">
            <Clock className="w-4 h-4" /> Kutilayotgan hodisalar
          </h3>
          {pending.length === 0 ? (
            <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground text-center">
              Navbat bo'sh — barcha ma'lumotlar yuborilgan ✅
            </div>
          ) : (
            <div className="space-y-2">
              {pending.map((e) => (
                <div key={e.eventId} className="rounded-xl border bg-card p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{OP_LABEL[e.operation]}</span>
                    <span className="text-xs text-muted-foreground">{fmtTime(e.createdAt)}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {e.syncStatus === "syncing" ? "Yuborilmoqda…" : "Navbatda"}
                    {e.retryCount > 0 ? ` · ${e.retryCount} urinish` : ""}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
