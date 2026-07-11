import { useEffect } from "react";
import { useSyncQueueCount } from "@/hooks/useSyncQueueCount";
import { CloudOff } from "lucide-react";

// MUHIM: bu komponent so'rov (useFieldMe) holatiga qarab early-return
// QILMASLIGI kerak — yuklanish/xato ekranlari AuthGate'da (App.tsx ichida).
// Aks holda AuthGate qayta-qayta unmount/mount bo'lib cheksiz refetch
// sikli paydo bo'ladi.
export function AppLayout({ children }: { children: React.ReactNode }) {
  const queueCount = useSyncQueueCount();

  useEffect(() => {
    if (typeof window !== "undefined" && window.Telegram?.WebApp) {
      window.Telegram.WebApp.ready();
      window.Telegram.WebApp.expand();
      window.Telegram.WebApp.disableVerticalSwipes?.();
    }
  }, []);

  return (
    <div className="h-[100dvh] flex flex-col bg-background relative max-w-md mx-auto shadow-2xl overflow-hidden">
      {queueCount > 0 && (
        <div className="absolute top-0 left-0 right-0 bg-amber-500 text-white text-xs font-medium py-1 px-2 flex items-center justify-center gap-2 z-50">
          <CloudOff className="w-3 h-3" />
          Kutilayotgan ma'lumotlar: {queueCount}
        </div>
      )}
      <div className="flex-1 flex flex-col h-full overflow-y-auto overflow-x-hidden">
        {children}
      </div>
    </div>
  );
}
