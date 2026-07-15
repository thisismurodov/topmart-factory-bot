import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useSyncStatus } from "@/hooks/useSyncStatus";
import { CloudOff, RefreshCw, CheckCircle2, AlertTriangle } from "lucide-react";

// T007 — ulanish monitori (header chip): 🟢 Online / 🟡 Syncing / 🔴 Offline
// T009 — offline banner (o'zbekcha matnlar spec bo'yicha)

export function SyncStatusBar() {
  const status = useSyncStatus();
  const [, setLocation] = useLocation();

  // "✅ sinxronlashtirildi" bannerini qisqa muddat ko'rsatish uchun:
  // navbat bo'shagan (pending>0 -> 0) paytni kuzatamiz.
  const prevPendingRef = useRef(status.pendingCount);
  const [showSynced, setShowSynced] = useState(false);
  useEffect(() => {
    const prev = prevPendingRef.current;
    prevPendingRef.current = status.pendingCount;
    if (prev > 0 && status.pendingCount === 0 && status.online) {
      setShowSynced(true);
      const t = window.setTimeout(() => setShowSynced(false), 4000);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [status.pendingCount, status.online]);

  const chip =
    status.connection === "offline" ? (
      <span className="flex items-center gap-1.5 text-red-600 font-semibold">
        <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
        Offline
      </span>
    ) : status.connection === "syncing" ? (
      <span className="flex items-center gap-1.5 text-amber-600 font-semibold">
        <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse shrink-0" />
        Sinxronlash…
      </span>
    ) : (
      <span className="flex items-center gap-1.5 text-emerald-600 font-semibold">
        <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
        Online
      </span>
    );

  return (
    <>
      <button
        type="button"
        onClick={() => setLocation("/sync")}
        className="w-full flex items-center justify-between px-3 py-1 bg-card border-b text-xs select-none"
        aria-label="Sinxronizatsiya markazi"
      >
        {chip}
        <span className="flex items-center gap-2 text-muted-foreground">
          {status.failedCount > 0 && (
            <span className="flex items-center gap-1 text-red-600 font-medium">
              <AlertTriangle className="w-3 h-3" />
              {status.failedCount} xato
            </span>
          )}
          {status.pendingCount > 0 && (
            <span className="flex items-center gap-1">
              <RefreshCw className="w-3 h-3" />
              {status.pendingCount} kutmoqda
            </span>
          )}
          <span className="underline underline-offset-2">Sync</span>
        </span>
      </button>

      {status.connection === "offline" && (
        <div className="bg-red-600 text-white text-xs py-1.5 px-3 flex items-start gap-2">
          <CloudOff className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="text-left leading-snug">
            <div className="font-semibold">⚠ Internet mavjud emas.</div>
            <div>TopMart offline rejimda ishlayapti.</div>
            <div>Ma'lumotlar internet qaytganda avtomatik yuboriladi.</div>
          </div>
        </div>
      )}

      {status.online && status.lastError === "auth" && status.pendingCount > 0 && (
        <div className="bg-amber-500 text-white text-xs py-1.5 px-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Sessiya eskirgan — Mini App'ni botdan qayta oching, ma'lumotlar shunda yuboriladi.
        </div>
      )}

      {showSynced && status.connection !== "offline" && (
        <div className="bg-emerald-600 text-white text-xs py-1.5 px-3 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          ✅ Barcha ma'lumotlar ERP bilan sinxronlashtirildi.
        </div>
      )}
    </>
  );
}
