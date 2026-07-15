import { useEffect } from "react";
import { useFieldMe } from "@/lib/fieldApi";
import { rememberAgentId } from "@/lib/eventQueue";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Send } from "lucide-react";

// Barcha sahifalar uchun YAGONA auth darvozasi. Yuklanish, xato va
// muvaffaqiyat holatlari faqat shu yerda boshqariladi. AppLayout so'rov
// holatiga aralashmaydi — aks holda ikki komponent bir-birini navbatma-navbat
// unmount/mount qilib, cheksiz refetch sikli paydo bo'ladi (har mount
// refetchOnMount tufayli yangi so'rov yuboradi).
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { data, error, refetch, isError, isPending } = useFieldMe();

  // Offline hodisalar konvertidagi agentId metadatasi uchun (T002)
  useEffect(() => {
    if (data?.agent?.id != null) rememberAgentId(data.agent.id);
  }, [data?.agent?.id]);

  if (isPending) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-4 border-primary border-r-4 border-r-transparent"></div>
      </div>
    );
  }

  if (!isError) return <>{children}</>;

  const status = error?.status ?? 0;
  const isAuthError = status === 401 || status === 403;

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
      <div className="w-24 h-24 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mb-6">
        {isAuthError ? <Send className="w-12 h-12" /> : <AlertTriangle className="w-12 h-12" />}
      </div>
      {isAuthError ? (
        <>
          <h1 className="text-2xl font-bold mb-3">Telegram orqali oching</h1>
          <p className="text-muted-foreground text-lg mb-2">
            Bu ilova Telegram Mini App sifatida ishlaydi.
          </p>
          <p className="text-muted-foreground text-lg">
            Botga kirib <span className="font-semibold text-foreground">«🗺 BOSHLASH»</span>{" "}
            tugmasini bosing.
          </p>
          {error?.message ? (
            <p className="text-sm text-muted-foreground/70 mt-6">{error.message}</p>
          ) : null}
          {/* Diagnostika qatori — auth ishlamay qolganda muammoni masofadan
              aniqlash uchun (Telegram obyekti bormi, initData uzunligi,
              platforma/versiya). Maxfiy ma'lumot ko'rsatilmaydi. */}
          <p className="text-xs text-muted-foreground/50 mt-3 break-all">
            {(() => {
              const wa = window.Telegram?.WebApp;
              const hash = window.location.hash || "";
              return [
                `TG: ${window.Telegram ? "bor" : "yo'q"}`,
                `initData: ${wa?.initData?.length ?? 0}`,
                `plat: ${wa?.platform ?? "-"}`,
                `ver: ${wa?.version ?? "-"}`,
                `hash: ${
                  hash.length > 1
                    ? hash
                        .slice(1)
                        .split("&")
                        .map((p) => p.split("=")[0])
                        .join(",")
                    : "bo'sh"
                }`,
              ].join(" | ");
            })()}
          </p>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-bold mb-3">Xatolik yuz berdi</h1>
          <p className="text-muted-foreground text-lg mb-6">
            {error?.message || "Server bilan bog'lanib bo'lmadi"}
          </p>
          <Button size="lg" className="rounded-xl" onClick={() => refetch()}>
            Qayta urinish
          </Button>
        </>
      )}
    </div>
  );
}
