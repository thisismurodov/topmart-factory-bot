import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetMeQueryKey,
  getGetVehicleDistributionPilotStockQueryKey,
  getListVehicleReconciliationsQueryKey,
  getListVehicleReplenishmentRequestsQueryKey,
  getListVehicleReturnableLabelsQueryKey,
  getListVehicleReturnsQueryKey,
  getListVehicleStockTargetsQueryKey,
  useCancelVehicleReturn,
  useCreateVehicleReturn,
  useGetMe,
  useListVehicleReturnableLabels,
  useListVehicleReturns,
  useMarkVehicleReturnHandedBack,
  useTransferVehicleReturnStock,
  type VehicleReturn,
  type VehicleReturnableLabel,
} from "@workspace/api-client-react";
import { AlertCircle, ArrowDownToLine, CheckCircle2, History, PackageCheck, RefreshCw, Search, Undo2, XCircle } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

type ApiFailure = { status?: number; data?: { error?: string }; message?: string; response?: { status?: number; data?: { error?: string } } };
type Confirmation = { action: "cancel" | "handed_back" | "transfer"; value: VehicleReturn } | null;

function operationKey() {
  const id = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `vehicle-return-${id}`;
}

function statusOf(error: unknown) {
  const failure = error as ApiFailure;
  return failure.status ?? failure.response?.status;
}

function failureMessage(error: unknown) {
  const failure = error as ApiFailure;
  const status = statusOf(error);
  if (status === 409) return "Ro‘yxat eskirgan yoki yorliq holati o‘zgargan. Ma’lumotni yangilang va qayta tanlang.";
  if (status === 400) return failure.data?.error || failure.response?.data?.error || "Tanlangan yorliqlar yoki izohni tekshiring.";
  if (status === 403) return "Bu F9 amali faqat administrator uchun. Ruxsatni tekshiring.";
  if (status === 404) return "Qaytarish yoki yorliq topilmadi. Ro‘yxatni yangilang.";
  return failure.data?.error || failure.response?.data?.error || failure.message || "Amal bajarilmadi. Qayta urinib ko‘ring.";
}

function formatWeight(value: number) {
  return `${value.toLocaleString("uz-UZ", { maximumFractionDigits: 3 })} kg`;
}

function formatDate(value?: string | null) {
  return value ? value.slice(0, 16).replace("T", " ") : "—";
}

function ReturnStatus({ status }: { status: string }) {
  const labels: Record<string, string> = {
    prepared: "Tayyorlangan",
    handed_back: "Qabul qilindi",
    stock_transferred: "Omborga o‘tkazildi",
    cancelled: "Bekor qilingan",
  };
  const color = status === "prepared"
    ? "border-amber-200 bg-amber-50 text-amber-700"
    : status === "handed_back"
      ? "border-blue-200 bg-blue-50 text-blue-700"
      : status === "stock_transferred"
        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
        : "border-slate-200 bg-slate-50 text-slate-600";
  return <Badge data-testid={`status-return-${status}`} variant="outline" className={color}>{labels[status] || status}</Badge>;
}

function LabelCard({ label, checked, onCheckedChange }: {
  label: VehicleReturnableLabel;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label data-testid={`card-returnable-label-${label.productionLabelId}`} className="flex min-w-0 cursor-pointer items-start gap-3 rounded-md border bg-white p-3 hover:bg-slate-50">
      <Checkbox
        aria-label={`${label.barcode} yorlig‘ini tanlash`}
        data-testid={`checkbox-return-label-${label.productionLabelId}`}
        className="mt-1 h-5 w-5"
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <span className="min-w-0 flex-1">
        <span className="block break-all font-mono text-sm font-semibold text-slate-800">{label.barcode}</span>
        <span className="mt-1 block break-words text-sm">{label.productName} <span className="font-mono text-xs text-slate-500">· {label.sku}</span></span>
        <span className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
          <span>Qolgan: {label.remainingQuantity.toLocaleString("uz-UZ")} dona</span>
          <span>Qolgan vazn: {formatWeight(label.remainingWeightKg)}</span>
          <span>Yorliq sig‘imi: {label.piecesInLabel.toLocaleString("uz-UZ")} dona</span>
          <span>Asl manba: Ombor #{label.destinationWarehouseId}</span>
        </span>
      </span>
    </label>
  );
}

function ReturnActions({ value, isAdmin, onConfirm }: {
  value: VehicleReturn;
  isAdmin: boolean;
  onConfirm: (action: Confirmation) => void;
}) {
  if (!isAdmin || value.status === "cancelled" || value.status === "stock_transferred") return null;
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
      {value.status === "prepared" && (
        <>
          <Button data-testid={`button-cancel-return-${value.id}`} variant="outline" className="min-h-11 text-red-600" onClick={() => onConfirm({ action: "cancel", value })}>
            <XCircle className="mr-2 h-4 w-4" /> Bekor qilish
          </Button>
          <Button data-testid={`button-handback-return-${value.id}`} className="min-h-11 bg-blue-600 hover:bg-blue-700" onClick={() => onConfirm({ action: "handed_back", value })}>
            <CheckCircle2 className="mr-2 h-4 w-4" /> Qabul qilindi
          </Button>
        </>
      )}
      {value.status === "handed_back" && (
        <Button data-testid={`button-transfer-return-${value.id}`} className="min-h-11 bg-emerald-600 hover:bg-emerald-700" onClick={() => onConfirm({ action: "transfer", value })}>
          <ArrowDownToLine className="mr-2 h-4 w-4" /> Omborga o‘tkazish
        </Button>
      )}
    </div>
  );
}

export function VehicleReturns({ active }: { active: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [view, setView] = useState("labels");
  const [search, setSearch] = useState("");
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const createKey = useRef("");
  const me = useGetMe({ query: { enabled: active, queryKey: getGetMeQueryKey() } });
  const isAdmin = me.data?.role === "admin";
  const labels = useListVehicleReturnableLabels(undefined, { query: {
    enabled: active && isAdmin,
    queryKey: getListVehicleReturnableLabelsQueryKey(),
    retry: false,
  } });
  const returns = useListVehicleReturns({ query: {
    enabled: active && isAdmin,
    queryKey: getListVehicleReturnsQueryKey(),
    retry: false,
  } });
  const create = useCreateVehicleReturn();
  const cancel = useCancelVehicleReturn();
  const handBack = useMarkVehicleReturnHandedBack();
  const transfer = useTransferVehicleReturnStock();

  const filteredLabels = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("uz");
    if (!term) return labels.data?.labels || [];
    return (labels.data?.labels || []).filter((label) =>
      [label.barcode, label.productName, label.sku, String(label.destinationWarehouseId), `ombor #${label.destinationWarehouseId}`]
        .some((value) => value.toLocaleLowerCase("uz").includes(term)));
  }, [labels.data, search]);
  const selectedLabels = useMemo(
    () => (labels.data?.labels || []).filter((label) => selected.has(label.barcode)),
    [labels.data, selected],
  );
  const totalPieces = selectedLabels.reduce((total, label) => total + label.remainingQuantity, 0);
  const totalWeight = selectedLabels.reduce((total, label) => total + label.remainingWeightKg, 0);

  useEffect(() => {
    if (!labels.data) return;
    const available = new Set(labels.data.labels.map((label) => label.barcode));
    setSelected((current) => new Set([...current].filter((barcode) => available.has(barcode))));
  }, [labels.data]);

  const refreshReturns = () => {
    queryClient.invalidateQueries({ queryKey: getListVehicleReturnableLabelsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListVehicleReturnsQueryKey() });
  };
  const refreshTransfer = () => {
    refreshReturns();
    queryClient.invalidateQueries({ queryKey: getGetVehicleDistributionPilotStockQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListVehicleStockTargetsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListVehicleReplenishmentRequestsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListVehicleReconciliationsQueryKey() });
  };

  const createReturn = () => {
    if (!selectedLabels.length) {
      toast({ title: "Yorliq tanlanmagan", description: "Kamida bitta qaytariladigan yorliqni belgilang.", variant: "destructive" });
      return;
    }
    createKey.current ||= operationKey();
    create.mutate({ data: {
      barcodes: selectedLabels.map((label) => label.barcode),
      operationKey: createKey.current,
      notes: notes.trim() || null,
    } }, {
      onSuccess: (value) => {
        createKey.current = "";
        setSelected(new Set());
        setNotes("");
        setView("history");
        toast({ title: `Qaytarish #${value.id} tayyorlandi`, description: "Zaxira hozircha o‘zgarmadi. Yorliqlar asl manba omborlariga qaytariladi." });
        refreshReturns();
      },
      onError: (error) => {
        toast({ title: "Qaytarish yaratilmadi", description: failureMessage(error), variant: "destructive" });
        if ([404, 409].includes(statusOf(error) || 0)) refreshReturns();
      },
    });
  };

  const submitTransition = () => {
    if (!confirmation) return;
    const { action, value } = confirmation;
    const mutation = action === "cancel" ? cancel : action === "handed_back" ? handBack : transfer;
    mutation.mutate({ returnId: value.id, data: {} }, {
      onSuccess: () => {
        setConfirmation(null);
        toast({
          title: action === "cancel" ? "Qaytarish bekor qilindi" : action === "handed_back" ? "Jismoniy qabul tasdiqlandi" : "Zaxira omborga o‘tkazildi",
          description: action === "handed_back" ? "Avto zaxira hali o‘zgarmadi." : undefined,
        });
        if (action === "transfer") refreshTransfer(); else refreshReturns();
      },
      onError: (error) => {
        toast({ title: "Amal bajarilmadi", description: failureMessage(error), variant: "destructive" });
        if ([404, 409].includes(statusOf(error) || 0)) refreshReturns();
      },
    });
  };

  if (!active) return null;
  if (me.isLoading) return <div aria-label="Ruxsat tekshirilmoqda" className="space-y-3 p-4"><Skeleton className="h-12 w-full" /><Skeleton className="h-24 w-full" /></div>;
  if (!isAdmin) {
    return (
      <div data-testid="status-returns-admin-only" role="status" className="m-4 rounded-md border border-amber-200 bg-amber-50 p-6 text-center text-amber-800">
        <AlertCircle className="mx-auto mb-2 h-8 w-8" />
        <p className="font-semibold">Qaytarish faqat administrator uchun</p>
        <p className="mt-1 text-sm">Sizga F9 amallari ko‘rsatilmaydi.</p>
      </div>
    );
  }

  const loading = (labels.isLoading && !labels.data) || (returns.isLoading && !returns.data);
  const error = labels.error || returns.error;
  const transitionPending = cancel.isPending || handBack.isPending || transfer.isPending;

  return (
    <div className="min-w-0">
      <div className="flex flex-col gap-3 border-b bg-white p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 font-semibold text-slate-800"><Undo2 className="h-5 w-5 text-violet-600" /> Avtodan qaytarish (F9)</h3>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">Har bir aniq yorliq o‘zi kelgan asl manba omboriga qaytariladi. Manba, avto va mahsulotni qo‘lda o‘zgartirib bo‘lmaydi.</p>
        </div>
        <Button data-testid="button-refresh-returns" variant="outline" className="min-h-11 shrink-0 self-start" onClick={refreshReturns} disabled={labels.isFetching || returns.isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${labels.isFetching || returns.isFetching ? "animate-spin" : ""}`} /> Yangilash
        </Button>
      </div>

      {loading ? (
        <div aria-label="Qaytarish ma’lumotlari yuklanmoqda" className="space-y-3 p-4">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : error ? (
        <div data-testid="status-returns-error" role="alert" className="m-4 rounded-md border border-red-200 bg-red-50 p-8 text-center text-red-800">
          <AlertCircle className="mx-auto mb-2 h-8 w-8 text-red-500" />
          <p className="font-medium">Qaytarish ma’lumotlari yuklanmadi</p>
          <p className="mt-1 text-sm">{failureMessage(error)}</p>
          <Button data-testid="button-retry-returns" variant="outline" className="mt-4 min-h-11" onClick={refreshReturns}>Qayta yuklash</Button>
        </div>
      ) : (
        <Tabs value={view} onValueChange={setView}>
          <TabsList className="mx-4 mt-4 grid h-auto grid-cols-2 sm:mx-5 sm:w-[420px]">
            <TabsTrigger data-testid="tab-returnable-labels" value="labels" className="min-h-11"><PackageCheck className="mr-2 h-4 w-4" /> Yorliqlar ({labels.data?.labels.length || 0})</TabsTrigger>
            <TabsTrigger data-testid="tab-return-history" value="history" className="min-h-11"><History className="mr-2 h-4 w-4" /> Tarix ({returns.data?.returns.length || 0})</TabsTrigger>
          </TabsList>

          <TabsContent value="labels" className="m-0 p-4 sm:p-5">
            <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
              <section aria-labelledby="returnable-title" className="min-w-0 space-y-3">
                <div>
                  <h4 id="returnable-title" className="font-semibold text-slate-700">Qaytarilishi mumkin bo‘lgan yuklangan yorliqlar</h4>
                  <p className="text-sm text-slate-500">Sotilgan, band qilingan yoki avval qaytarilgan yorliqlar server tomonidan chiqarib tashlanadi.</p>
                </div>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
                  <Input data-testid="input-search-return-labels" aria-label="Yorliqlarni qidirish" className="min-h-11 pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Shtrix-kod, mahsulot, SKU yoki asl ombor…" />
                </div>
                {!filteredLabels.length ? (
                  <div data-testid="status-no-returnable-labels" className="rounded-md border border-dashed p-8 text-center text-sm text-slate-500">
                    {search ? "Qidiruvga mos qaytariladigan yorliq topilmadi." : "Qaytarilishi mumkin bo‘lgan yuklangan yorliqlar yo‘q."}
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p data-testid="text-filtered-label-count" className="text-sm text-slate-500">{filteredLabels.length} ta yorliq</p>
                      <Button
                        data-testid="button-toggle-visible-labels"
                        variant="ghost"
                        className="min-h-11"
                        onClick={() => {
                          const allChecked = filteredLabels.every((label) => selected.has(label.barcode));
                          setSelected((current) => {
                            const next = new Set(current);
                            filteredLabels.forEach((label) => allChecked ? next.delete(label.barcode) : next.add(label.barcode));
                            return next;
                          });
                        }}
                      >
                        {filteredLabels.every((label) => selected.has(label.barcode)) ? "Ko‘rinadiganlarni yechish" : "Ko‘rinadiganlarni tanlash"}
                      </Button>
                    </div>
                    <div className="grid gap-2 xl:grid-cols-2">
                      {filteredLabels.map((label) => <LabelCard key={label.productionLabelId} label={label} checked={selected.has(label.barcode)} onCheckedChange={(checked) => setSelected((current) => {
                        const next = new Set(current);
                        if (checked) next.add(label.barcode); else next.delete(label.barcode);
                        return next;
                      })} />)}
                    </div>
                  </>
                )}
              </section>

              <aside aria-labelledby="manifest-title" className="min-w-0">
                <Card className="lg:sticky lg:top-4">
                  <CardContent className="space-y-4 p-4">
                    <div>
                      <h4 id="manifest-title" className="font-semibold text-slate-800">Tayyor qaytarish manifesti</h4>
                      <p className="mt-1 text-xs text-slate-500">Faqat tanlangan shtrix-kodlar yuboriladi. Yaratish va qabul qilishda zaxira o‘zgarmaydi.</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-md bg-slate-50 p-3 text-center"><span className="block text-xs text-slate-500">Jismoniy yorliqlar</span><strong data-testid="text-selected-return-count" className="text-lg">{selectedLabels.length} ta</strong></div>
                      <div className="rounded-md bg-slate-50 p-3 text-center"><span className="block text-xs text-slate-500">Qaytariladigan dona</span><strong data-testid="text-selected-return-pieces" className="text-lg">{totalPieces.toLocaleString("uz-UZ")} dona</strong></div>
                      <div className="col-span-2 rounded-md bg-slate-50 p-3 text-center"><span className="block text-xs text-slate-500">Aniq jami vazn</span><strong data-testid="text-selected-return-weight" className="text-lg">{formatWeight(totalWeight)}</strong></div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="return-notes">Izoh (ixtiyoriy)</Label>
                      <Textarea id="return-notes" data-testid="input-return-notes" maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Qaytarish haqida izoh…" className="min-h-24 resize-y" />
                    </div>
                    {!selectedLabels.length && <p data-testid="status-empty-return-selection" role="status" className="text-sm text-amber-700">Manifest yaratish uchun kamida bitta yorliq tanlang.</p>}
                    <Button data-testid="button-create-return" className="min-h-11 w-full bg-violet-600 hover:bg-violet-700" disabled={create.isPending} onClick={createReturn}>
                      <Undo2 className="mr-2 h-4 w-4" /> {create.isPending ? "Yaratilmoqda…" : "Tayyor qaytarish yaratish"}
                    </Button>
                  </CardContent>
                </Card>
              </aside>
            </div>
          </TabsContent>

          <TabsContent value="history" className="m-0 space-y-3 p-4 sm:p-5">
            {!returns.data?.returns.length ? (
              <div data-testid="status-no-return-history" className="rounded-md border border-dashed p-8 text-center text-sm text-slate-500"><History className="mx-auto mb-2 h-7 w-7 opacity-40" /> Qaytarish tarixi yo‘q.</div>
            ) : returns.data.returns.map((value) => {
              const quantity = value.items.reduce((sum, item) => sum + item.returnQuantity, 0);
              const weight = value.items.reduce((sum, item) => sum + item.returnWeightKg, 0);
              return (
                <Card key={value.id} data-testid={`card-return-${value.id}`}>
                  <CardContent className="space-y-4 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div><span className="font-semibold text-slate-800">Qaytarish #{value.id}</span><p className="text-xs text-slate-500">Tayyorlandi: {formatDate(value.preparedAt)} · Admin #{value.preparedBy}</p></div>
                      <ReturnStatus status={value.status} />
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-sm sm:max-w-sm">
                      <div className="rounded bg-slate-50 p-2"><span className="block text-xs text-slate-500">Qaytarilgan miqdor</span><b>{quantity.toLocaleString("uz-UZ")} dona</b><span className="block text-xs text-slate-500">{value.items.length} ta yorliq</span></div>
                      <div className="rounded bg-slate-50 p-2"><span className="block text-xs text-slate-500">Jami vazn</span><b>{formatWeight(weight)}</b></div>
                    </div>
                    <div className="overflow-x-auto rounded-md border">
                      <table className="w-full min-w-[580px] text-left text-sm">
                        <caption className="sr-only">Qaytarish #{value.id} yorliqlari</caption>
                        <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="p-2 font-medium">Shtrix-kod</th><th className="p-2 font-medium">Mahsulot / SKU</th><th className="p-2 font-medium">Asl manba</th><th className="p-2 text-right font-medium">Miqdor</th><th className="p-2 text-right font-medium">Vazn</th></tr></thead>
                        <tbody>{value.items.map((item) => <tr key={item.id} className="border-t"><td className="break-all p-2 font-mono text-xs">{item.barcode}</td><td className="p-2">{item.productName}<span className="block font-mono text-xs text-slate-500">{item.sku}</span></td><td className="p-2">Ombor #{item.destinationWarehouseId}</td><td className="p-2 text-right">{item.returnQuantity.toLocaleString("uz-UZ")} dona</td><td className="p-2 text-right">{formatWeight(item.returnWeightKg)}</td></tr>)}</tbody>
                      </table>
                    </div>
                    {value.notes && <p className="break-words text-sm"><span className="text-slate-500">Izoh:</span> {value.notes}</p>}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                      <span>Qabul: {formatDate(value.handedBackAt)} {value.handedBackBy ? `· Admin #${value.handedBackBy}` : ""}</span>
                      <span>Transfer: {formatDate(value.transferredAt)} {value.transferredBy ? `· Admin #${value.transferredBy}` : ""}</span>
                      <span>Bekor: {formatDate(value.cancelledAt)} {value.cancelledBy ? `· Admin #${value.cancelledBy}` : ""}</span>
                    </div>
                    {value.status === "handed_back" && <p className="rounded-md bg-blue-50 p-3 text-sm text-blue-800">Jismoniy qabul qayd etilgan. Endi bekor qilib bo‘lmaydi; zaxira yakuniy transfergacha o‘zgarmaydi.</p>}
                    <ReturnActions value={value} isAdmin={isAdmin} onConfirm={setConfirmation} />
                  </CardContent>
                </Card>
              );
            })}
          </TabsContent>
        </Tabs>
      )}

      <AlertDialog open={confirmation !== null} onOpenChange={(open) => !open && setConfirmation(null)}>
        <AlertDialogContent className="w-[calc(100%-2rem)]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmation?.action === "cancel" ? "Qaytarishni bekor qilasizmi?" : confirmation?.action === "handed_back" ? "Jismoniy qabul qilindimi?" : "Omborga o‘tkazilsinmi?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation?.action === "cancel"
                ? "Band qilingan yorliqlar bo‘shatiladi. Bu amal faqat tayyorlangan holatda mumkin."
                : confirmation?.action === "handed_back"
                  ? "“Qabul qilindi” yorliqlar jismonan topshirilganini qayd etadi. Avto zaxira hali o‘zgarmaydi va bundan keyin qaytarishni bekor qilib bo‘lmaydi."
                  : "Bu yakuniy amal atomar bajariladi: avto zaxirasi kamayadi va har bir yorliqning asl manba ombori zaxirasi ko‘payadi."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-close-return-confirmation" className="min-h-11">Ortga</AlertDialogCancel>
            <AlertDialogAction data-testid="button-confirm-return-transition" disabled={transitionPending} className={`min-h-11 ${confirmation?.action === "cancel" ? "bg-red-600 hover:bg-red-700" : confirmation?.action === "transfer" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-blue-600 hover:bg-blue-700"}`} onClick={(event) => { event.preventDefault(); submitTransition(); }}>
              {transitionPending ? "Bajarilmoqda…" : confirmation?.action === "cancel" ? "Bekor qilish" : confirmation?.action === "handed_back" ? "Ha, qabul qilindi" : "Ha, omborga o‘tkazish"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}