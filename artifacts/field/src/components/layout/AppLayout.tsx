import { useEffect } from "react";
import { SyncStatusBar } from "@/components/SyncStatusBar";

// MUHIM: bu komponent so'rov (useFieldMe) holatiga qarab early-return
// QILMASLIGI kerak — yuklanish/xato ekranlari AuthGate'da (App.tsx ichida).
// Aks holda AuthGate qayta-qayta unmount/mount bo'lib cheksiz refetch
// sikli paydo bo'ladi.
export function AppLayout({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (typeof window !== "undefined" && window.Telegram?.WebApp) {
      window.Telegram.WebApp.ready();
      window.Telegram.WebApp.expand();
      window.Telegram.WebApp.disableVerticalSwipes?.();
    }
  }, []);

  return (
    <div className="h-[100dvh] flex flex-col bg-background relative max-w-md mx-auto shadow-2xl overflow-hidden">
      <SyncStatusBar />
      <div className="flex-1 flex flex-col h-full overflow-y-auto overflow-x-hidden">
        {children}
      </div>
    </div>
  );
}
