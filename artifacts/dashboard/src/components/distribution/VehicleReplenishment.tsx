import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "@/App";
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
import { AlertCircle, Check, CheckCircle2, ChevronsUpDown, Clock3, PackagePlus, Pencil, Plus, RefreshCw, XCircle } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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

// Qidiruv uchun normalizatsiya: kichik harf + o'zbek apostrof variantlarini tenglashtirish.
function searchNorm(value: string) {
  return value.toLowerCase().replace(/[ʼ‘’`´]/g, "'");
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

type AddProductOption = { id: number; nomi: string; sku: string };

function TargetDialog({ target, addOptions, open, onOpenChange }: {
  target: VehicleStockTarget | null; // null → yangi me'yor qo'shish rejimi
  addOptions: AddProductOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [productId, setProductId] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const key = useRef("");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const mutation = useReplaceVehicleStockTarget();

  useEffect(() => {
    if (!open) return;
    setProductId(target ? String(target.mahsulotId) : "");
    setMin(target ? String(target.minQuantity) : "");
    setMax(target ? String(target.targetQuantity) : "");
    if (!key.current) key.current = operationKey("stock-target");
  }, [open, target]);

  const changeOpen = (next: boolean) => {
    if (!next) {
      key.current = "";
      setPickerOpen(false);
    }
    onOpenChange(next);
  };
  const selected = target ? null : addOptions.find((p) => String(p.id) === productId) ?? null;
  const mahsulotId = target ? target.mahsulotId : selected?.id ?? null;
  const productName = target ? target.productName : selected?.nomi ?? "";
  const minNumber = Number(min);
  const maxNumber = Number(max);
  const numbersValid = min !== "" && max !== "" && Number.isInteger(minNumber) && Number.isInteger(maxNumber)
    && minNumber >= 0 && maxNumber > 0 && minNumber <= maxNumber;
  const valid = numbersValid && mahsulotId !== null;

  const save = () => {
    if (!valid || mahsulotId === null) return;
    mutation.mutate({ data: {
      mahsulotId,
      minQuantity: minNumber,
      targetQuantity: maxNumber,
      operationKey: key.current,
    } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListVehicleStockTargetsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListVehicleReplenishmentRequestsQueryKey() });
        toast({ title: "Me’yor saqlandi", description: `${productName} uchun yangi me’yor kuchga kirdi.` });
        key.current = "";
        changeOpen(false);
      },
      onError: (error) => toast({ title: "Saqlanmadi", description: failureMessage(error), variant: "destructive" }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="w-[calc(100%-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{target ? "To‘ldirish me’yorini o‘zgartirish" : "Yangi to‘ldirish me’yori"}</DialogTitle>
          <DialogDescription>
            {target ? `${target.productName}. ` : ""}Maqsad — zaxira to‘ldiriladigan daraja va ayni paytda yuklash limiti: mashinadagi + yo‘ldagi + yangi yuklash undan oshmaydi.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          {!target && (
            <div className="grid gap-2">
              <Label htmlFor="replenishment-product">Mahsulot</Label>
              {addOptions.length ? (
                <Popover modal open={pickerOpen} onOpenChange={setPickerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      id="replenishment-product"
                      variant="outline"
                      role="combobox"
                      aria-expanded={pickerOpen}
                      className="min-h-11 w-full justify-between font-normal"
                    >
                      <span className="truncate">
                        {selected ? `${selected.nomi} · ${selected.sku}` : "Mahsulotni tanlang"}
                      </span>
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                    <Command filter={(value, search) => (searchNorm(value).includes(searchNorm(search)) ? 1 : 0)}>
                      {/* 16px shrift — iOS/iPad fokusda zoom qilmasligi uchun. */}
                      <CommandInput placeholder="Nomi yoki SKU bo‘yicha qidiring…" className="text-base" />
                      {/* Radix Select ro‘yxati iPad’da barmoq bilan surilmasdi — cmdk
                          ro‘yxati oddiy overflow scroll, touch-pan-y bilan suriladi. */}
                      <CommandList className="max-h-[45vh] overflow-y-auto overscroll-contain touch-pan-y">
                        <CommandEmpty>Hech narsa topilmadi.</CommandEmpty>
                        <CommandGroup>
                          {addOptions.map((p) => (
                            <CommandItem
                              key={p.id}
                              value={`${p.nomi} ${p.sku}`}
                              className="min-h-11"
                              onSelect={() => {
                                setProductId(String(p.id));
                                setPickerOpen(false);
                              }}
                            >
                              <Check className={`mr-2 h-4 w-4 shrink-0 ${String(p.id) === productId ? "opacity-100" : "opacity-0"}`} />
                              <span className="truncate">{p.nomi} · {p.sku}</span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              ) : (
                <p className="text-sm text-slate-500">
                  Mos mahsulot qolmadi: savdo katalogidagi SKU orqali ERP bilan bog‘langan barcha mahsulotlar uchun me’yor allaqachon o‘rnatilgan.
                </p>
              )}
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="replenishment-min">Minimum (dona)</Label>
            <Input id="replenishment-min" inputMode="numeric" type="number" min={0} step={1} value={min} onChange={(e) => setMin(e.target.value)} className="min-h-11" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="replenishment-target">Maqsad / maksimum (dona)</Label>
            <Input id="replenishment-target" inputMode="numeric" type="number" min={1} step={1} value={max} onChange={(e) => setMax(e.target.value)} className="min-h-11" />
          </div>
          {!numbersValid && (min !== "" || max !== "") && (
            <p role="alert" className="text-sm text-red-600">Butun son kiriting: minimum 0 yoki katta, maqsad 1 yoki katta va minimumdan kam bo‘lmasin.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" className="min-h-11" onClick={() => changeOpen(false)}>Yopish</Button>
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
  const [adding, setAdding] = useState(false);
  const isAdmin = me?.role === "admin";
  // Savdo katalogi (distribution.mahsulotlar) — yangi me'yor uchun mahsulot
  // tanlash. SalesBotProductsSection bilan bir xil query kalit: kesh umumiy.
  const products = useQuery<{ id: number; nomi: string; sku: string; faol: boolean; erpBor: boolean }[]>({
    queryKey: ["savdo-bot-products"],
    queryFn: async () => {
      const res = await authFetch("/api/distribution/products");
      if (!res.ok) throw new Error("Savdo katalogi yuklanmadi");
      return res.json();
    },
    enabled: active && isAdmin,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListVehicleStockTargetsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListVehicleReplenishmentRequestsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetVehicleDistributionPilotStockQueryKey() });
  };
  const openProductIds = new Set((requests.data?.requests || [])
    .filter((request) => request.status === "pending" || request.status === "approved")
    .map((request) => request.mahsulotId));
  const currentTargets = (targets.data?.targets || []).filter((target) => target.effectiveTo === null);
  const targetProductIds = new Set(currentTargets.map((target) => target.mahsulotId));
  // Server PUT'da mappingni qat'iy tekshiradi — bu filtr faqat qulay tanlov uchun.
  const addOptions = (products.data || [])
    .filter((p) => p.faol && p.sku && p.erpBor && !targetProductIds.has(p.id))
    .map((p) => ({ id: p.id, nomi: p.nomi, sku: p.sku }))
    .sort((a, b) => a.nomi.localeCompare(b.nomi, "uz"));

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
          <p className="mt-1 max-w-2xl text-sm text-slate-500">Minimum past zaxirani bildiradi. Maqsad (maksimum) — to‘ldiriladigan daraja va ayni paytda yuklash limiti: me’yorli mahsulot mashinaga maqsaddan ortiq yuklanmaydi.</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 self-start">
          {isAdmin && (
            <Button className="min-h-11" onClick={() => setAdding(true)}>
              <Plus className="mr-2 h-4 w-4" /> Yangi me’yor
            </Button>
          )}
          <Button variant="outline" className="min-h-11" onClick={refresh} disabled={targets.isFetching || requests.isFetching}>
            <RefreshCw className={`mr-2 h-4 w-4 ${targets.isFetching || requests.isFetching ? "animate-spin" : ""}`} /> Yangilash
          </Button>
        </div>
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
              <div className="rounded-md border border-dashed p-8 text-center text-sm text-slate-500">
                To‘ldirish me’yorlari hali o‘rnatilmagan.
                {isAdmin && (
                  <div className="mt-3">
                    <Button variant="outline" className="min-h-11" onClick={() => setAdding(true)}>
                      <Plus className="mr-2 h-4 w-4" /> Birinchi me’yorni qo‘shish
                    </Button>
                  </div>
                )}
              </div>
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
      <TargetDialog
        target={editing}
        addOptions={addOptions}
        open={editing !== null || adding}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
            setAdding(false);
          }
        }}
      />
    </div>
  );
}