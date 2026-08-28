import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetVehicleDistributionPilotStockQueryKey,
  getGetMeQueryKey,
  getListVehicleReplenishmentRequestsQueryKey,
  getListVehicleStockTargetsQueryKey,
  useApproveVehicleReplenishmentRequest,
  useCancelVehicleReplenishmentRequest,
  useCreateVehicleReplenishmentRequest,
  useGetMe,
  useListVehicleReplenishmentRequests,
  useListVehicleStockTargets,
  useReplaceVehicleStockTarget,
  type VehicleReplenishmentRequest,
  type VehicleStockTarget,
} from "@workspace/api-client-react";
import { AlertCircle, CheckCircle2, Clock3, PackagePlus, Pencil, RefreshCw, XCircle } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";

type ApiFailure = { status?: number; data?: { error?: string }; message?: string };

function operationKey(prefix: string) {
  const id = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
}

function failureMessage(error: unknown) {
  const failure = error as ApiFailure;
  if (failure.status === 409) return "Ma’lumot eskirgan yoki holat o‘zgargan. Ro‘yxatni yangilang va qayta urinib ko‘ring.";
  if (failure.status === 400) return failure.data?.error || "Kiritilgan ma’lumotni tekshiring.";
  if (failure.status === 401 || failure.status === 403) return "Bu amal uchun ruxsat yetarli emas. Qayta kiring yoki administratorga murojaat qiling.";
  if (failure.status === 404) return "So‘ralgan yozuv topilmadi. Ro‘yxatni yangilang.";
  return failure.data?.error || failure.message || "Amal bajarilmadi. Qayta urinib ko‘ring.";
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return value.slice(0, 16).replace("T", " ");
}

function RequestStatus({ status }: { status: string }) {
  const labels: Record<string, string> = {
    pending: "Kutilmoqda", approved: "Tasdiqlangan", fulfilled: "Bajarilgan",
    rejected: "Rad etilgan", cancelled: "Bekor qilingan",
  };
  const color = status === "pending" ? "bg-amber-50 text-amber-700 border-amber-200"
    : status === "approved" ? "bg-blue-50 text-blue-700 border-blue-200"
      : status === "fulfilled" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
        : "bg-slate-50 text-slate-600 border-slate-200";
  return <Badge variant="outline" className={color}>{labels[status] || status}</Badge>;
}

function TargetDialog({ target, open, onOpenChange }: {
  target: VehicleStockTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const key = useRef("");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const mutation = useReplaceVehicleStockTarget();

  useEffect(() => {
    if (!open || !target) return;
    setMin(String(target.minQuantity));
    setMax(String(target.targetQuantity));
    if (!key.current) key.current = operationKey("stock-target");
  }, [open, target]);

  const changeOpen = (next: boolean) => {
    if (!next) key.current = "";
    onOpenChange(next);
  };
  const minNumber = Number(min);
  const maxNumber = Number(max);
  const valid = min !== "" && max !== "" && Number.isInteger(minNumber) && Number.isInteger(maxNumber)
    && minNumber >= 0 && maxNumber > 0 && minNumber <= maxNumber;

  const save = () => {
    if (!target || !valid) return;
    mutation.mutate({ data: {
      mahsulotId: target.mahsulotId,
      minQuantity: minNumber,
      targetQuantity: maxNumber,
      operationKey: key.current,
    } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListVehicleStockTargetsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListVehicleReplenishmentRequestsQueryKey() });
        toast({ title: "Me’yor saqlandi", description: `${target.productName} uchun yangi me’yor kuchga kirdi.` });
        key.current = "";
        onOpenChange(false);
      },
      onError: (error) => toast({ title: "Saqlanmadi", description: failureMessage(error), variant: "destructive" }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="w-[calc(100%-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>To‘ldirish me’yorini o‘zgartirish</DialogTitle>
          <DialogDescription>
            {target?.productName}. Maqsad — zaxira to‘ldiriladigan yakuniy daraja, buyurtma miqdori emas.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="replenishment-min">Minimum (dona)</Label>
            <Input id="replenishment-min" inputMode="numeric" type="number" min={0} step={1} value={min} onChange={(e) => setMin(e.target.value)} className="min-h-11" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="replenishment-target">Maqsad / maksimum (dona)</Label>
            <Input id="replenishment-target" inputMode="numeric" type="number" min={1} step={1} value={max} onChange={(e) => setMax(e.target.value)} className="min-h-11" />
          </div>
          {!valid && (min !== "" || max !== "") && (
            <p role="alert" className="text-sm text-red-600">Butun son kiriting: minimum 0 yoki katta, maqsad 1 yoki katta va minimumdan kam bo‘lmasin.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" className="min-h-11" onClick={() => onOpenChange(false)}>Yopish</Button>
          <Button className="min-h-11" disabled={!valid || mutation.isPending} onClick={save}>
            {mutation.isPending ? "Saqlanmoqda…" : "Me’yorni saqlash"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RequestActions({ request, isAdmin, onRefresh }: {
  request: VehicleReplenishmentRequest;
  isAdmin: boolean;
  onRefresh: () => void;
}) {
  const [confirm, setConfirm] = useState<"approve" | "cancel" | null>(null);
  const { toast } = useToast();
  const approve = useApproveVehicleReplenishmentRequest();
  const cancel = useCancelVehicleReplenishmentRequest();
  const cancellable = request.status === "pending" || (request.status === "approved" && !["handed_over", "stock_transferred", "fulfilled", "cancelled"].includes(request.handoffStatus || ""));

  const submit = () => {
    const mutation = confirm === "approve" ? approve : cancel;
    mutation.mutate({ requestId: request.id, data: {} }, {
      onSuccess: (updated) => {
        toast({
          title: confirm === "approve" ? "To‘liq tasdiqlandi" : "Bekor qilindi",
          description: confirm === "approve"
            ? `Tayyor handoff #${updated.handoffId ?? "—"} yaratildi.`
            : "So‘rov bekor qilindi.",
        });
        setConfirm(null);
        onRefresh();
      },
      onError: (error) => {
        toast({ title: "Amal bajarilmadi", description: failureMessage(error), variant: "destructive" });
        if ((error as ApiFailure).status === 409) onRefresh();
      },
    });
  };

  return (
    <>
      <div className="flex flex-wrap justify-end gap-2">
        {isAdmin && request.status === "pending" && (
          <Button size="sm" className="min-h-11 sm:min-h-9 bg-emerald-600 hover:bg-emerald-700" onClick={() => setConfirm("approve")}>
            <CheckCircle2 className="mr-1.5 h-4 w-4" /> To‘liq tasdiqlash
          </Button>
        )}
        {cancellable && (
          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9 text-red-600" onClick={() => setConfirm("cancel")}>
            <XCircle className="mr-1.5 h-4 w-4" /> Bekor qilish
          </Button>
        )}
      </div>
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent className="w-[calc(100%-2rem)]">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "approve" ? "So‘rovni to‘liq tasdiqlaysizmi?" : "So‘rovni bekor qilasizmi?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "approve"
                ? "Miqdor serverdagi so‘rov bo‘yicha to‘liq tasdiqlanadi va tayyor handoff yaratiladi. Yorliqni chiqarish hamda jismoniy topshirish pilot yorliq oqimida davom etadi. Avto zaxira faqat yakuniy transferda o‘zgaradi."
                : "Pending yoki xavfsiz approved so‘rov bekor qilinadi. Bu amalni davom ettirishni tasdiqlang."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">Ortga</AlertDialogCancel>
            <AlertDialogAction disabled={approve.isPending || cancel.isPending} className={`min-h-11 ${confirm === "cancel" ? "bg-red-600 hover:bg-red-700" : "bg-emerald-600 hover:bg-emerald-700"}`} onClick={(e) => { e.preventDefault(); submit(); }}>
              {approve.isPending || cancel.isPending ? "Bajarilmoqda…" : confirm === "approve" ? "To‘liq tasdiqlash" : "Bekor qilish"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function VehicleReplenishment({ active }: { active: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: me } = useGetMe({ query: {
    queryKey: getGetMeQueryKey(),
    enabled: active,
  } });
  const targets = useListVehicleStockTargets({ query: {
    queryKey: getListVehicleStockTargetsQueryKey(),
    enabled: active,
    retry: false,
  } });
  const requests = useListVehicleReplenishmentRequests({ query: {
    queryKey: getListVehicleReplenishmentRequestsQueryKey(),
    enabled: active,
    retry: false,
  } });
  const create = useCreateVehicleReplenishmentRequest();
  const requestKeys = useRef<Record<number, string>>({});
  const [editing, setEditing] = useState<VehicleStockTarget | null>(null);
  const isAdmin = me?.role === "admin";

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListVehicleStockTargetsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListVehicleReplenishmentRequestsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetVehicleDistributionPilotStockQueryKey() });
  };
  const openProductIds = new Set((requests.data?.requests || [])
    .filter((request) => request.status === "pending" || request.status === "approved")
    .map((request) => request.mahsulotId));
  const currentTargets = (targets.data?.targets || []).filter((target) => target.effectiveTo === null);

  const requestRefill = (target: VehicleStockTarget) => {
    requestKeys.current[target.mahsulotId] ||= operationKey("replenishment");
    create.mutate({ data: { mahsulotId: target.mahsulotId, operationKey: requestKeys.current[target.mahsulotId] } }, {
      onSuccess: () => {
        delete requestKeys.current[target.mahsulotId];
        toast({ title: "So‘rov yaratildi", description: "To‘ldirish miqdorini server joriy zaxira va maqsaddan hisoblab chiqdi." });
        refresh();
      },
      onError: (error) => {
        toast({ title: "So‘rov yaratilmadi", description: failureMessage(error), variant: "destructive" });
        if ((error as ApiFailure).status === 409) refresh();
      },
    });
  };

  if (!active) return null;
  const loading = (targets.isLoading && !targets.data) || (requests.isLoading && !requests.data);
  const error = targets.error || requests.error;

  return (
    <div className="min-w-0">
      <div className="flex flex-col gap-3 border-b bg-white p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
        <div>
          <h3 className="flex items-center gap-2 font-semibold text-slate-800"><PackagePlus className="h-5 w-5 text-indigo-600" /> Avto zaxirani to‘ldirish</h3>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">Minimum past zaxirani bildiradi. Maqsad (maksimum) — mahsulot yetkazilgach zaxira to‘ldiriladigan daraja.</p>
        </div>
        <Button variant="outline" className="min-h-11 shrink-0 self-start" onClick={refresh} disabled={targets.isFetching || requests.isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${targets.isFetching || requests.isFetching ? "animate-spin" : ""}`} /> Yangilash
        </Button>
      </div>

      {loading ? (
        <div aria-label="To‘ldirish ma’lumotlari yuklanmoqda" className="space-y-3 p-4">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : error ? (
        <div role="alert" className="m-4 flex flex-col items-center rounded-md border border-red-200 bg-red-50 p-8 text-center">
          <AlertCircle className="mb-2 h-8 w-8 text-red-500" />
          <p className="font-medium text-red-800">To‘ldirish ma’lumotlari yuklanmadi</p>
          <p className="mt-1 text-sm text-red-700">{failureMessage(error)}</p>
          <Button variant="outline" className="mt-4 min-h-11" onClick={refresh}>Qayta yuklash</Button>
        </div>
      ) : (
        <div className="space-y-6 p-4 sm:p-5">
          <section aria-labelledby="targets-title">
            <h4 id="targets-title" className="mb-3 font-semibold text-slate-700">Joriy me’yorlar</h4>
            {!currentTargets.length ? (
              <div className="rounded-md border border-dashed p-8 text-center text-sm text-slate-500">To‘ldirish me’yorlari hali o‘rnatilmagan.</div>
            ) : (
              <>
                <div className="grid gap-3 md:hidden">
                  {currentTargets.map((target) => (
                    <Card key={target.id} className={target.low ? "border-amber-200" : ""}>
                      <CardContent className="space-y-3 p-4">
                        <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-medium">{target.productName}</p><p className="font-mono text-xs text-slate-500">{target.sku}</p></div><Badge variant="outline" className={target.low ? "border-amber-200 bg-amber-50 text-amber-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}>{target.low ? "Kam" : "Yetarli"}</Badge></div>
                        <div className="grid grid-cols-3 gap-2 text-center text-sm"><div className="rounded bg-slate-50 p-2"><span className="block text-xs text-slate-500">Joriy (dona)</span><b>{target.currentQuantity} dona</b></div><div className="rounded bg-slate-50 p-2"><span className="block text-xs text-slate-500">Min (dona)</span><b>{target.minQuantity} dona</b></div><div className="rounded bg-slate-50 p-2"><span className="block text-xs text-slate-500">Maqsad (dona)</span><b>{target.targetQuantity} dona</b></div></div>
                        <div className="flex flex-wrap gap-2">
                          {isAdmin && <Button variant="outline" className="min-h-11 flex-1" onClick={() => setEditing(target)}><Pencil className="mr-2 h-4 w-4" /> Me’yor</Button>}
                          <Button className="min-h-11 flex-1" disabled={!target.low || openProductIds.has(target.mahsulotId) || create.isPending} onClick={() => requestRefill(target)}>
                            {openProductIds.has(target.mahsulotId) ? "Ochiq so‘rov bor" : target.low ? "To‘ldirish so‘rovi" : "Zaxira yetarli"}
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
                <div className="hidden overflow-x-auto rounded-md border md:block">
                  <Table>
                    <TableHeader className="bg-slate-50"><TableRow><TableHead>Mahsulot / SKU</TableHead><TableHead className="text-right">Joriy (dona)</TableHead><TableHead className="text-right">Min (dona)</TableHead><TableHead className="text-right">Maqsad (dona)</TableHead><TableHead>Holat</TableHead><TableHead className="text-right">Amallar</TableHead></TableRow></TableHeader>
                    <TableBody>{currentTargets.map((target) => <TableRow key={target.id}><TableCell><p className="font-medium">{target.productName}</p><p className="font-mono text-xs text-slate-500">{target.sku}</p></TableCell><TableCell className="text-right font-semibold">{target.currentQuantity} dona</TableCell><TableCell className="text-right">{target.minQuantity} dona</TableCell><TableCell className="text-right">{target.targetQuantity} dona</TableCell><TableCell><Badge variant="outline" className={target.low ? "border-amber-200 bg-amber-50 text-amber-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}>{target.low ? "Kam" : "Yetarli"}</Badge></TableCell><TableCell><div className="flex justify-end gap-2">{isAdmin && <Button size="sm" variant="outline" onClick={() => setEditing(target)}><Pencil className="mr-1 h-4 w-4" /> Me’yor</Button>}<Button size="sm" disabled={!target.low || openProductIds.has(target.mahsulotId) || create.isPending} onClick={() => requestRefill(target)}>{openProductIds.has(target.mahsulotId) ? "Ochiq so‘rov bor" : target.low ? "So‘rov yaratish" : "Zaxira yetarli"}</Button></div></TableCell></TableRow>)}</TableBody>
                  </Table>
                </div>
              </>
            )}
          </section>

          <section aria-labelledby="requests-title">
            <h4 id="requests-title" className="mb-1 font-semibold text-slate-700">So‘rovlar tarixi</h4>
            <p className="mb-3 text-sm text-slate-500">Tasdiqlash faqat to‘liq miqdor uchun: tayyor handoff yaratiladi, yorliq va jismoniy topshirish pilot yorliq oqimida davom etadi. Zaxira yakuniy transfergacha o‘zgarmaydi.</p>
            {!requests.data?.requests.length ? (
              <div className="rounded-md border border-dashed p-8 text-center text-sm text-slate-500"><Clock3 className="mx-auto mb-2 h-7 w-7 opacity-40" /> To‘ldirish so‘rovlari yo‘q.</div>
            ) : (
              <div className="grid gap-3">
                {requests.data.requests.map((request) => (
                  <Card key={request.id}>
                    <CardContent className="p-4">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0 space-y-2">
                          <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{request.productName}</span><span className="font-mono text-xs text-slate-500">{request.sku}</span><RequestStatus status={request.status} /></div>
                          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                            <span><span className="text-slate-500">So‘ralgan (dona):</span> <b>{request.requestedQuantity} dona</b></span>
                            <span><span className="text-slate-500">Joriy surat (dona):</span> {request.currentQuantitySnapshot} dona</span>
                            <span><span className="text-slate-500">Maqsad surat (dona):</span> {request.targetQuantitySnapshot} dona</span>
                            <span><span className="text-slate-500">Manba:</span> {request.sourceWarehouseId ? `Ombor #${request.sourceWarehouseId}` : "—"}</span>
                          </div>
                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500"><span>So‘raldi: {formatDate(request.requestedAt)}</span><span>Tasdiqlandi: {formatDate(request.approvedAt)}</span><span>Topshirildi: {formatDate(request.fulfilledAt)}</span><span>Bekor qilindi: {formatDate(request.cancelledAt)}</span></div>
                          {request.handoffId && <p className="text-sm text-indigo-700">Bog‘langan handoff: <b>#{request.handoffId}</b> · {request.handoffStatus || "holat noma’lum"}</p>}
                        </div>
                        <RequestActions request={request} isAdmin={isAdmin} onRefresh={refresh} />
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
      <TargetDialog target={editing} open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} />
    </div>
  );
}