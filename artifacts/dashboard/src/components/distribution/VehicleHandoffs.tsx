import { useQueryClient } from "@tanstack/react-query";
import {
  getListVehicleHandoffsQueryKey,
  useListVehicleHandoffs,
  type VehicleHandoffDetail,
} from "@workspace/api-client-react";
import { AlertCircle, PackageCheck, RefreshCw, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type ApiFailure = { status?: number; response?: { status?: number }; data?: { error?: string }; message?: string };

const STATUS_META: Record<string, { label: string; className: string }> = {
  prepared: { label: "Tayyorlandi", className: "border-amber-200 bg-amber-50 text-amber-700" },
  labels_printed: { label: "Chop etildi", className: "border-blue-200 bg-blue-50 text-blue-700" },
  handed_over: { label: "Topshirildi", className: "border-violet-200 bg-violet-50 text-violet-700" },
  stock_transferred: { label: "Zaxiraga o‘tkazildi", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  cancelled: { label: "Bekor qilingan", className: "border-slate-200 bg-slate-50 text-slate-600" },
};

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] || { label: status, className: "border-slate-200 bg-slate-50 text-slate-600" };
  return <Badge variant="outline" className={meta.className}>{meta.label}</Badge>;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return value.slice(0, 16).replace("T", " ");
}

function formatKg(value: number | null) {
  if (value == null) return "—";
  return `${value.toLocaleString("uz-UZ", { maximumFractionDigits: 2 })} kg`;
}

function HandoffSteps({ handoff }: { handoff: VehicleHandoffDetail }) {
  if (handoff.status === "cancelled") {
    return <p className="text-xs text-slate-500">Bekor qilindi: {formatDate(handoff.cancelledAt)}</p>;
  }
  const steps = [
    { label: "Tayyorlandi", at: handoff.createdAt },
    { label: "Chop etildi", at: handoff.labelsPrintedAt },
    { label: "Topshirildi", at: handoff.handedOverAt },
    { label: "Zaxiraga o‘tkazildi", at: handoff.stockTransferredAt },
  ];
  return (
    <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
      {steps.map((step, index) => (
        <li key={step.label} className="flex items-center gap-1.5">
          {index > 0 && <span aria-hidden className="text-slate-300">→</span>}
          <span className={step.at ? "font-medium text-emerald-700" : "text-slate-400"}>
            {step.label}
            {step.at && <span className="ml-1 font-normal text-slate-500">{formatDate(step.at)}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function HandoffCard({ handoff }: { handoff: VehicleHandoffDetail }) {
  const totalPieces = handoff.items.reduce((sum, item) => sum + item.quantity, 0);
  const totalKg = handoff.items.reduce((sum, item) => sum + (item.totalWeightKg ?? 0), 0);
  const labelCount = handoff.items.reduce((sum, item) => sum + Math.ceil(item.quantity / Math.max(item.piecesPerBox, 1)), 0);

  return (
    <Card data-testid={`card-handoff-${handoff.id}`}>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-slate-800">Topshirish #{handoff.id}</span>
          <StatusBadge status={handoff.status} />
          <span className="text-xs text-slate-500">{formatDate(handoff.createdAt)}</span>
        </div>

        <div className="divide-y rounded-md border">
          {handoff.items.map((item) => (
            <div key={item.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 p-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium text-slate-800">{item.productName || item.sku}</p>
                <p className="font-mono text-xs text-slate-500">{item.sku} · {item.piecesPerBox} dona/quti</p>
              </div>
              <div className="text-right">
                <p className="font-semibold">{item.quantity.toLocaleString("uz-UZ")} dona</p>
                <p className="text-xs text-slate-500">{formatKg(item.totalWeightKg)}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span><span className="text-slate-500">Jami:</span> <b>{totalPieces.toLocaleString("uz-UZ")} dona</b> · <b>{formatKg(totalKg)}</b></span>
          <span className="text-slate-500">Yorliqlar: {labelCount} ta</span>
          <span className="text-slate-500">Manba: {handoff.sourceWarehouseName ?? `Ombor #${handoff.sourceWarehouseId}`}</span>
        </div>

        <HandoffSteps handoff={handoff} />

        {handoff.notes && (
          <p className="truncate text-xs text-slate-400" title={handoff.notes}>Izoh: {handoff.notes}</p>
        )}
      </CardContent>
    </Card>
  );
}

export function VehicleHandoffs({ active }: { active: boolean }) {
  const queryClient = useQueryClient();
  const list = useListVehicleHandoffs({ query: {
    queryKey: getListVehicleHandoffsQueryKey(),
    enabled: active,
    retry: false,
  } });

  if (!active) return null;

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListVehicleHandoffsQueryKey() });
  const failure = list.error as ApiFailure | null;
  const failureStatus = failure?.status ?? failure?.response?.status;
  const handoffs = [...(list.data?.handoffs || [])].sort((a, b) => b.id - a.id);
  const activeCount = handoffs.filter((handoff) => handoff.status !== "stock_transferred" && handoff.status !== "cancelled").length;

  return (
    <div className="min-w-0">
      <div className="flex flex-col gap-3 border-b bg-white p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
        <div>
          <h3 className="flex items-center gap-2 font-semibold text-slate-800">
            <PackageCheck className="h-5 w-5 text-blue-600" /> Mashinaga topshirishlar
            {activeCount > 0 && (
              <Badge className="border-transparent bg-amber-100 text-amber-700 hover:bg-amber-100">{activeCount} faol</Badge>
            )}
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            Top Mart bo‘limida C-3 markaziy omboridan yaratiladi. Avto zaxira faqat yakuniy «Zaxiraga o‘tkazish» bosqichida o‘zgaradi.
          </p>
        </div>
        <Button variant="outline" className="min-h-11 shrink-0 self-start" onClick={refresh} disabled={list.isFetching} data-testid="button-refresh-handoffs">
          <RefreshCw className={`mr-2 h-4 w-4 ${list.isFetching ? "animate-spin" : ""}`} /> Yangilash
        </Button>
      </div>

      {list.isLoading && !list.data ? (
        <div aria-label="Topshirishlar yuklanmoqda" className="space-y-3 p-4">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-28 w-full" />)}</div>
      ) : list.error ? (
        failureStatus === 404 ? (
          <div className="m-4 flex flex-col items-center rounded-md border bg-slate-50 p-8 text-center text-slate-500">
            <Truck className="mb-2 h-8 w-8 opacity-40" />
            <p className="font-medium text-slate-700">Topshirishlar funksiyasi bu muhitda yoqilmagan</p>
          </div>
        ) : (
          <div role="alert" className="m-4 flex flex-col items-center rounded-md border border-red-200 bg-red-50 p-8 text-center">
            <AlertCircle className="mb-2 h-8 w-8 text-red-500" />
            <p className="font-medium text-red-800">Topshirishlar yuklanmadi</p>
            <p className="mt-1 text-sm text-red-700">
              {failureStatus === 503
                ? "Tizim yangilanmoqda — ma’lumotlar bazasi sxemasi kutilmoqda."
                : failure?.data?.error || failure?.message || "Qayta urinib ko‘ring."}
            </p>
            <Button variant="outline" className="mt-4 min-h-11" onClick={refresh}>Qayta yuklash</Button>
          </div>
        )
      ) : !handoffs.length ? (
        <div className="m-4 rounded-md border border-dashed p-8 text-center text-sm text-slate-500">
          <Truck className="mx-auto mb-2 h-7 w-7 opacity-40" />
            Topshirishlar hali yo‘q. Top Mart bosh sahifasida C-3 dan mashinaga yuklashni boshlang.
        </div>
      ) : (
        <div className="grid gap-3 p-4 sm:p-5" data-testid="list-vehicle-handoffs">
          {handoffs.map((handoff) => <HandoffCard key={handoff.id} handoff={handoff} />)}
        </div>
      )}
    </div>
  );
}
