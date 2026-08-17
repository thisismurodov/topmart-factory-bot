// /flow-map sahifasi — Production Flow Map (F3).
// Real API: GET /api/ombor/flow/graph (sessiya auth, read-only).
// Yagona gate qoidasi: bu query'ning pending/error holatiga FAQAT shu komponent
// qaraydi (react-query refetch bo'ronining oldini olish uchun).
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { authFetch } from "@/App";
import { Button } from "@/components/ui/button";
import { FlowMapView } from "@/components/flow/FlowMapView";
import { isEmptyGraph } from "@/components/flow/model";
import type { FlowGraphResponse } from "@/components/flow/types";

async function fetchFlowGraph(): Promise<FlowGraphResponse> {
  let res: Response;
  try {
    // Katta hisobot ~6s; 60s dan keyin timeout — cheksiz kutish yo'q
    res = await authFetch("/api/ombor/flow/graph", { signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new Error("So'rov vaqti tugadi — server javob bermadi (60s).");
    }
    throw new Error("Tarmoq xatosi — serverga ulanib bo'lmadi.");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as { error?: string }));
    throw new Error(body.error || `Server xatosi (HTTP ${res.status})`);
  }
  return res.json();
}

export default function FlowMapPage() {
  const q = useQuery<FlowGraphResponse>({
    queryKey: ["flow-graph"],
    queryFn: fetchFlowGraph,
    staleTime: 5 * 60_000,       // og'ir so'rov — 5 daqiqa yangi hisoblanadi
    refetchOnWindowFocus: false, // faqat kerak bo'lganda fetch (§19)
    retry: 1,
  });

  if (q.isPending) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center" data-testid="flow-loading">
        <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
        <div className="font-medium text-foreground">Production Flow yuklanmoqda...</div>
        <div className="text-sm text-muted-foreground">
          Katta hisobot tayyorlanmoqda — odatda 5–10 soniya davom etadi.
        </div>
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="flow-error">
        <div className="max-w-md rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <AlertTriangle className="mx-auto h-8 w-8 text-red-500" />
          <div className="mt-3 font-semibold text-red-800">
            Production Flow ma'lumotlarini yuklab bo'lmadi.
          </div>
          <div className="mt-1 text-sm text-red-700">{(q.error as Error).message}</div>
          <Button className="mt-4" variant="outline" onClick={() => q.refetch()} data-testid="flow-retry">
            Qayta urinish
          </Button>
        </div>
      </div>
    );
  }

  if (isEmptyGraph(q.data)) {
    return (
      <div className="flex h-full items-center justify-center" data-testid="flow-empty">
        <div className="text-muted-foreground">Hech qanday ma'lumot topilmadi.</div>
      </div>
    );
  }

  return <FlowMapView graph={q.data} onRefresh={() => q.refetch()} refreshing={q.isRefetching} />;
}
