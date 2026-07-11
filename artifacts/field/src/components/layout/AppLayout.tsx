import { useEffect } from "react";
import { useFieldMe } from "@/lib/fieldApi";
import { useSyncQueueCount } from "@/hooks/useSyncQueueCount";
import { CloudOff } from "lucide-react";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { data, error, isLoading } = useFieldMe();
  const queueCount = useSyncQueueCount();

  useEffect(() => {
    if (typeof window !== "undefined" && window.Telegram?.WebApp) {
      window.Telegram.WebApp.ready();
      window.Telegram.WebApp.expand();
      window.Telegram.WebApp.disableVerticalSwipes?.();
    }
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-12 w-12 border-t-4 border-primary border-r-4 border-r-transparent"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center bg-background">
        <h1 className="text-2xl font-bold text-destructive mb-2">Xatolik</h1>
        <p className="text-muted-foreground">{error.message}</p>
      </div>
    );
  }

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
