import { useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import {
  useListVehicleReconciliations,
  useGetVehicleReconciliation,
  useCreateVehicleReconciliation,
  usePatchVehicleReconciliationItems,
  useReviewVehicleReconciliation,
  useApplyVehicleReconciliation,
  useCancelVehicleReconciliation,
  getListVehicleReconciliationsQueryKey,
  getGetVehicleReconciliationQueryKey,
  getGetVehicleDistributionPilotStockQueryKey,
} from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  ClipboardList,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Save,
  Plus,
  RefreshCw,
  Search,
  Check,
  AlertCircle,
  Clock,
  ArrowRight,
  Info,
} from "lucide-react";

// Helper for status badge
function ReconStatusBadge({ status }: { status: string }) {
  if (status === "draft") return <Badge className="bg-blue-100 text-blue-700 border-blue-200">Qoralama</Badge>;
  if (status === "approved") return <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200">Tasdiqlangan</Badge>;
  if (status === "disputed") return <Badge className="bg-red-100 text-red-700 border-red-200">Muammoli</Badge>;
  if (status === "applied") return <Badge className="bg-slate-100 text-slate-700 border-slate-200">Yakunlangan</Badge>;
  if (status === "cancelled") return <Badge variant="outline" className="text-slate-500">Bekor qilingan</Badge>;
  return <Badge variant="secondary">{status}</Badge>;
}

// Drawer Component
function ReconciliationDrawer({ 
  id, 
  onClose 
}: { 
  id: number | null; 
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useGetVehicleReconciliation(id as number, { 
    query: { enabled: id !== null, queryKey: getGetVehicleReconciliationQueryKey(id as number) } 
  });

  const patchMutation = usePatchVehicleReconciliationItems();
  const reviewMutation = useReviewVehicleReconciliation();
  const applyMutation = useApplyVehicleReconciliation();
  const cancelMutation = useCancelVehicleReconciliation();

  // Local state for counts
  const [counts, setCounts] = useState<Record<number, string>>({});
  
  // Sync local state when data loads
  useEffect(() => {
    if (data && data.status === "draft") {
      const initial: Record<number, string> = {};
      data.items.forEach(item => {
        if (item.actualQuantity !== null) {
          initial[item.id] = item.actualQuantity.toString();
        }
      });
      setCounts(initial);
    }
  }, [data]);

  const handleSave = () => {
    if (!data || !id) return;
    const itemsToPatch = Object.entries(counts)
      .filter(([_, val]) => val.trim() !== "")
      .map(([itemId, val]) => ({
        itemId: Number(itemId),
        actualQuantity: Number(val),
      }))
      .filter(x => !isNaN(x.actualQuantity) && x.actualQuantity >= 0);

    if (itemsToPatch.length === 0) return;

    patchMutation.mutate({ reconciliationId: id, data: { items: itemsToPatch } }, {
      onSuccess: () => {
        toast({ title: "Saqlandi", description: "Sanoq natijalari saqlandi." });
        queryClient.invalidateQueries({ queryKey: getGetVehicleReconciliationQueryKey(id) });
      },
      onError: (err: any) => {
        toast({ title: "Xatolik", description: err?.response?.data?.error || "Saqlashda xatolik", variant: "destructive" });
      }
    });
  };

  const handleReview = () => {
    if (!id) return;
    reviewMutation.mutate({ reconciliationId: id, data: {} }, {
      onSuccess: () => {
        toast({ title: "Tekshirildi", description: "Sanoq tekshiruvdan o'tdi." });
        queryClient.invalidateQueries({ queryKey: getGetVehicleReconciliationQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getListVehicleReconciliationsQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: "Xatolik", description: err?.response?.data?.error || "Tekshirishda xatolik", variant: "destructive" });
      }
    });
  };

  const handleApply = () => {
    if (!id) return;
    applyMutation.mutate({ reconciliationId: id, data: {} }, {
      onSuccess: () => {
        toast({ title: "Yakunlandi", description: "Sanoq muvaffaqiyatli yakunlandi." });
        queryClient.invalidateQueries({ queryKey: getGetVehicleReconciliationQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getListVehicleReconciliationsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetVehicleDistributionPilotStockQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: "Xatolik", description: err?.response?.data?.error || "Yakunlashda xatolik. Sanoq eskirgan bo'lishi mumkin. Iltimos, yangilang.", variant: "destructive" });
        queryClient.invalidateQueries({ queryKey: getGetVehicleReconciliationQueryKey(id) });
      }
    });
  };

  const handleCancel = () => {
    if (!id) return;
    if (!confirm("Sanoqni bekor qilmoqchimisiz?")) return;
    cancelMutation.mutate({ reconciliationId: id, data: {} }, {
      onSuccess: () => {
        toast({ title: "Bekor qilindi" });
        queryClient.invalidateQueries({ queryKey: getGetVehicleReconciliationQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getListVehicleReconciliationsQueryKey() });
      }
    });
  };

  const allLinesCounted = data?.items.every(item => counts[item.id] !== undefined && counts[item.id].trim() !== "") ?? false;
  const hasUnsavedChanges = data?.items.some(item => {
    const current = counts[item.id];
    const saved = item.actualQuantity !== null ? item.actualQuantity.toString() : undefined;
    
    if ((current === undefined || current.trim() === "") && saved === undefined) return false;
    if ((current === undefined || current.trim() === "") && saved !== undefined) return true;
    if (current !== undefined && current.trim() !== "" && saved === undefined) return true;
    
    return Number(current) !== Number(saved);
  }) ?? false;

  return (
    <Sheet open={id !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto p-0 flex flex-col">
        <SheetHeader className="p-6 border-b bg-slate-50 shrink-0">
          <div className="flex items-center justify-between">
            <SheetTitle className="flex items-center gap-2">
              <ClipboardList className="w-5 h-5 text-emerald-600" />
              Sanoq tafsilotlari
            </SheetTitle>
            {data && <ReconStatusBadge status={data.status} />}
          </div>
          <SheetDescription className="sr-only">
            Avto omboridagi mahsulotlarni jismoniy sanash tafsilotlari va ularni tahrirlash oynasi.
          </SheetDescription>
          {data && (
            <div className="text-sm text-slate-500 mt-1 flex items-center gap-4">
              <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5"/> {data.reconciliationDate}</span>
              <span>#{data.id}</span>
            </div>
          )}
        </SheetHeader>
        
        <div className="p-6 flex-1 overflow-y-auto">
          {isLoading || !data ? (
            <div className="space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : (
            <div className="space-y-6">
              
              {/* Terminal / Status Messages */}
              {data.status === "disputed" && (
                <div className="bg-red-50 border border-red-200 rounded-md p-4 flex gap-3 text-red-800 text-sm">
                  <AlertTriangle className="w-5 h-5 shrink-0 text-red-600 mt-0.5" />
                  <div>
                    <strong className="font-semibold text-red-900 block mb-1">Farq aniqlandi</strong>
                    Kutilgan va haqiqiy qoldiq o'rtasida farq mavjud. Ushbu sanoq yopildi va zaxiraga yoki ledgerga hech qanday o'zgartirish kiritilmadi. Zarurat bo'lsa yangi sanoq o'tkazing.
                  </div>
                </div>
              )}

              {data.status === "approved" && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-md p-4 flex gap-3 text-emerald-800 text-sm">
                  <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-600 mt-0.5" />
                  <div>
                    <strong className="font-semibold text-emerald-900 block mb-1">Sanoq tasdiqlandi</strong>
                    Barcha mahsulotlar qoldig'i kutilganidek. Sanoqni yakunlash (Apply) mumkin. Bu faqat audit tarixiga yoziladi, zaxira harakatlantirilmaydi.
                  </div>
                </div>
              )}

              {data.status === "draft" && (
                <div className="bg-blue-50 border border-blue-200 rounded-md p-4 flex gap-3 text-blue-800 text-sm">
                  <Info className="w-5 h-5 shrink-0 text-blue-600 mt-0.5" />
                  <div>
                    <strong className="font-semibold text-blue-900 block mb-1">Sanoqni to'ldiring</strong>
                    Haqiqiy miqdorlarni kiriting. Barcha qatorlar to'ldirilgandan so'ng "Tekshirishga yuborish" mumkin bo'ladi. Diqqat: Agar tekshiruvda farq aniqlansa, sanoq avtomatik yopiladi va zaxiraga hech qanday o'zgartirish kiritilmaydi.
                  </div>
                </div>
              )}

              <div className="border rounded-md shadow-sm overflow-hidden">
                <Table>
                  <TableHeader className="bg-slate-50">
                    <TableRow>
                      <TableHead className="w-[120px]">Kodu</TableHead>
                      <TableHead>Mahsulot</TableHead>
                      <TableHead className="text-right w-[120px]">Kutilgan</TableHead>
                      <TableHead className="text-right w-[140px]">Haqiqiy (Fizik)</TableHead>
                      {data.status !== "draft" && <TableHead className="text-right w-[100px]">Farq</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.items.map(item => (
                      <TableRow key={item.id}>
                        <TableCell className="py-2 font-mono text-xs text-slate-500">{item.sku}</TableCell>
                        <TableCell className="py-2 font-medium text-sm">{item.productName || "Noma'lum"}</TableCell>
                        <TableCell className="py-2 text-right text-slate-600 font-semibold">{item.expectedQuantity.toLocaleString("uz-UZ")}</TableCell>
                        <TableCell className="py-2 text-right">
                          {data.status === "draft" ? (
                            <Input 
                              type="number" 
                              className="h-8 text-right font-semibold max-w-[120px] ml-auto"
                              value={counts[item.id] ?? ""}
                              onChange={e => setCounts(prev => ({...prev, [item.id]: e.target.value}))}
                              placeholder="0"
                            />
                          ) : (
                            <span className="font-semibold">
                              {item.actualQuantity !== null ? item.actualQuantity.toLocaleString("uz-UZ") : "—"}
                            </span>
                          )}
                        </TableCell>
                        {data.status !== "draft" && (
                          <TableCell className="py-2 text-right">
                            {item.discrepancy !== 0 ? (
                              <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">
                                {item.discrepancy > 0 ? "+" : ""}{item.discrepancy.toLocaleString("uz-UZ")}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                                0
                              </Badge>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

            </div>
          )}
        </div>

        {/* Footer Actions */}
        {data && data.status !== "cancelled" && data.status !== "applied" && data.status !== "disputed" && (
          <div className="p-4 border-t bg-slate-50 shrink-0 flex items-center justify-between gap-3">
            {data.status === "draft" && (
              <>
                <Button variant="outline" className="text-red-600 hover:text-red-700 hover:bg-red-50" onClick={handleCancel} disabled={cancelMutation.isPending}>
                  <XCircle className="w-4 h-4 mr-2" />
                  Bekor qilish
                </Button>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={handleSave} disabled={!hasUnsavedChanges || patchMutation.isPending}>
                    <Save className="w-4 h-4 mr-2" />
                    Saqlash
                  </Button>
                  <Button 
                    onClick={handleReview} 
                    disabled={!allLinesCounted || hasUnsavedChanges || reviewMutation.isPending} 
                    className="bg-emerald-600 hover:bg-emerald-700"
                    title={hasUnsavedChanges ? "Oldin saqlang" : !allLinesCounted ? "Barcha qatorlarni to'ldiring" : ""}
                  >
                    <CheckCircle2 className="w-4 h-4 mr-2" />
                    Tekshirishga yuborish
                  </Button>
                </div>
              </>
            )}

            {data.status === "approved" && (
              <Button onClick={handleApply} disabled={applyMutation.isPending} className="w-full bg-emerald-600 hover:bg-emerald-700 text-white">
                <Check className="w-4 h-4 mr-2" />
                Yakunlash (Tasdiqlash)
              </Button>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function VehicleReconciliations({ active }: { active: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { data, isLoading } = useListVehicleReconciliations(
    { limit: 50 },
    { query: { enabled: active, queryKey: getListVehicleReconciliationsQueryKey({ limit: 50 }) } }
  );

  const createMutation = useCreateVehicleReconciliation();

  const handleCreate = () => {
    // TASHKENT DATE
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent" }).format(new Date());
    
    createMutation.mutate({ data: { reconciliationDate: today } }, {
      onSuccess: (res) => {
        if (res.created) {
          toast({ title: "Yaratildi", description: "Yangi sanoq qoralama holatida yaratildi." });
        } else {
          toast({ title: "Mavjud", description: "Bugun uchun yaratilgan qoralama ochilmoqda." });
        }
        queryClient.invalidateQueries({ queryKey: getListVehicleReconciliationsQueryKey({ limit: 50 }) });
        setSelectedId(res.reconciliation.id);
      },
      onError: (err: any) => {
        toast({ title: "Xatolik", description: err?.response?.data?.error || "Yaratishda xatolik", variant: "destructive" });
      }
    });
  };

  if (!active) return null;

  return (
    <div className="p-0">
      <div className="flex items-center justify-between p-4 sm:p-5 bg-white">
        <h3 className="text-base font-semibold text-slate-800 flex items-center gap-2">
          <ClipboardList className="w-5 h-5 text-emerald-600" />
          Avto ombor fizik sanog'i
        </h3>
        <Button onClick={handleCreate} disabled={createMutation.isPending} className="bg-emerald-600 hover:bg-emerald-700 text-white">
          <Plus className="w-4 h-4 mr-2" />
          Sanoq boshlash
        </Button>
      </div>

      <div className="border-t border-slate-200">
        {isLoading ? (
          <div className="p-4 space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : !data || data.reconciliations.length === 0 ? (
          <div className="py-12 flex flex-col items-center justify-center text-slate-400 bg-slate-50/50">
            <ClipboardList className="w-10 h-10 mb-3 opacity-30 text-emerald-600" />
            <p className="text-slate-500 font-medium">Sanoq tarixi yo'q</p>
            <p className="text-sm text-slate-400 mt-1">Ushbu avto omborda fizik sanoq o'tkazilmagan.</p>
          </div>
        ) : (
          <Table>
            <TableHeader className="bg-slate-50">
              <TableRow className="hover:bg-slate-50">
                <TableHead className="w-[120px]">ID</TableHead>
                <TableHead className="w-[150px]">Sana</TableHead>
                <TableHead>Holat</TableHead>
                <TableHead className="text-right">Amallar</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.reconciliations.map(r => (
                <TableRow key={r.id} className="cursor-pointer hover:bg-slate-50 transition-colors" onClick={() => setSelectedId(r.id)}>
                  <TableCell className="py-3 font-medium text-slate-700">#{r.id}</TableCell>
                  <TableCell className="py-3 text-slate-600 flex items-center gap-1.5"><Clock className="w-3.5 h-3.5 opacity-60"/> {r.reconciliationDate}</TableCell>
                  <TableCell className="py-3">
                    <ReconStatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="py-3 text-right">
                    <Button variant="ghost" size="sm" className="text-slate-500 hover:text-emerald-700">
                      Ochish <ArrowRight className="w-4 h-4 ml-1" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <ReconciliationDrawer id={selectedId} onClose={() => setSelectedId(null)} />
    </div>
  );
}
