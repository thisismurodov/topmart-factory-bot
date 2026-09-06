import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "@/App";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2, Warehouse, Activity, Save, AlertCircle, Truck, Info, ReceiptText } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useState, useEffect, useRef } from "react";
import {
  useGetCustomers,
  useCreateVehicleHandoff,
  useClaimExistingVehicleHandoffLabels,
  useRegisterTopmartLabelReceipt,
  getListVehicleHandoffsQueryKey,
  getListVehicleReplenishmentRequestsQueryKey,
  getGetVehicleDistributionPilotStockQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

// --- Types ---
export type TopMartConfigResponse = {
  configured: boolean;
  customerId: number | null;
  customerName: string | null;
  centralWarehouseId: number | null;
  centralWarehouseName: string | null;
};

export type WarehouseSimple = {
  id: number;
  name: string;
  active: boolean;
  locationType?: string;
};

export type TopMartOverviewResponse = {
  configured: boolean;
  customerId: number;
  customerName: string;
  centralWarehouseId: number;
  centralWarehouseName: string;
  c3StockTotalKg: number;
  c3StockTotalQty: number;
  vehicleStockTotalKg: number;
  vehicleStockTotalQty: number;
  flowStatus: string;
  loadableItems?: {
    mahsulotId: number;
    publicProductId: number;
    productName: string;
    sku: string;
    availableQuantity: number;
    availableWeightKg: number;
    piecesPerBox: number;
  }[];
  inventory: any[];
  sales: {
    count: number;
    lastSaleAt: string | null;
    byCurrency: {
      currency: string;
      count: number;
      totalAmount: number;
      paidAmount: number;
      debtAmount: number;
    }[];
  };
};

function newOperationKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `topmart-load-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatAmount(value: number, currency: string): string {
  return `${value.toLocaleString("uz-UZ", { maximumFractionDigits: 2 })} ${currency}`;
}

// --- Local Hooks ---

function useGetTopMartConfig() {
  return useQuery<TopMartConfigResponse>({
    queryKey: ["topmart-config"],
    queryFn: async () => {
      const r = await authFetch("/api/topmart/config");
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || "Konfiguratsiyani yuklashda xatolik yuz berdi");
      }
      return r.json();
    },
  });
}

function useSaveTopMartConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { customerId: number; centralWarehouseId: number }) => {
      const r = await authFetch("/api/topmart/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || "Konfiguratsiyani saqlashda xatolik yuz berdi");
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["topmart-config"] });
      qc.invalidateQueries({ queryKey: ["topmart-overview"] });
    },
  });
}

function useGetWarehousesList() {
  return useQuery<WarehouseSimple[]>({
    queryKey: ["warehouses-list"],
    queryFn: async () => {
      const r = await authFetch("/api/warehouses");
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || "Omborlarni yuklashda xatolik yuz berdi");
      }
      return r.json();
    },
  });
}

function useGetTopMartOverview(isReady: boolean) {
  return useQuery<TopMartOverviewResponse>({
    queryKey: ["topmart-overview"],
    enabled: isReady,
    queryFn: async () => {
      const r = await authFetch("/api/topmart/overview");
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || "Umumiy holatni yuklashda xatolik yuz berdi");
      }
      return r.json();
    },
  });
}

// --- Component ---

export default function TopMartOverviewTab({ active }: { active: boolean }) {
  const { data: config, isLoading: isLoadingConfig, error: configError } = useGetTopMartConfig();
  const { data: customers } = useGetCustomers();
  const { data: warehouses } = useGetWarehousesList();
  const saveConfig = useSaveTopMartConfig();
  const { toast } = useToast();

  const [draftCustomer, setDraftCustomer] = useState<string>("");
  const [draftWarehouse, setDraftWarehouse] = useState<string>("");

  useEffect(() => {
    if (config?.configured) {
      if (config.customerId) setDraftCustomer(String(config.customerId));
      if (config.centralWarehouseId) setDraftWarehouse(String(config.centralWarehouseId));
    }
  }, [config]);

  const isConfigured = !!config?.configured;
  const { data: overview, isLoading: isLoadingOverview, error: overviewError } = useGetTopMartOverview(isConfigured);

  const createHandoff = useCreateVehicleHandoff();
  const qc = useQueryClient();
  const [loadQuantities, setLoadQuantities] = useState<Record<number, string>>({});
  const [loadNote, setLoadNote] = useState("");
  const [loadBarcodes, setLoadBarcodes] = useState("");
  const loadOperationKey = useRef(newOperationKey());
  const claimOperationKey = useRef(newOperationKey());
  const claimExisting = useClaimExistingVehicleHandoffLabels();
  const registerReceipt = useRegisterTopmartLabelReceipt();
  const [receiptSaleId, setReceiptSaleId] = useState("");
  const [receiptBarcodes, setReceiptBarcodes] = useState("");

  if (!active) return null;

  const isDirty = (draftCustomer !== String(config?.customerId || "")) || (draftWarehouse !== String(config?.centralWarehouseId || ""));
  const canSave = !!draftCustomer && !!draftWarehouse && isDirty;

  const handleSave = () => {
    if (!draftCustomer || !draftWarehouse) return;
    saveConfig.mutate({
      customerId: Number(draftCustomer),
      centralWarehouseId: Number(draftWarehouse),
    }, {
      onSuccess: () => {
        toast({ title: "Konfiguratsiya muvaffaqiyatli saqlandi" });
      },
      onError: (err) => {
        toast({ title: "Xatolik yuz berdi", description: err.message, variant: "destructive" });
      }
    });
  };

  const handleLoadSubmit = () => {
    if (!overview?.centralWarehouseId) return;
    const loadableById = new Map(
      (overview.loadableItems ?? []).map((item) => [item.mahsulotId, item]),
    );
    const items = Object.entries(loadQuantities)
      .map(([id, qty]) => ({ mahsulotId: Number(id), quantity: Number(qty) }))
      .filter(item => item.quantity > 0);

    if (items.length === 0) {
      toast({ title: "Kamida bitta mahsulot kiritilishi kerak", variant: "destructive" });
      return;
    }
    const barcodes = loadBarcodes
      .split(/[\s,;]+/)
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean);
    if (barcodes.length === 0) {
      toast({
        title: "Mavjud stiker shtrix-kodlarini kiriting",
        description: "C-3 dan mashinaga yangi stiker chiqarilmaydi.",
        variant: "destructive",
      });
      return;
    }
    const invalidItem = items.find((item) => {
      const available = loadableById.get(item.mahsulotId)?.availableQuantity ?? 0;
      return !Number.isSafeInteger(item.quantity) || item.quantity > available;
    });
    if (invalidItem) {
      toast({
        title: "Miqdor noto‘g‘ri",
        description: "Yuklash miqdori butun dona bo‘lishi va C-3 qoldig‘idan oshmasligi kerak.",
        variant: "destructive",
      });
      return;
    }

    createHandoff.mutate(
      {
        data: {
          sourceWarehouseId: overview.centralWarehouseId,
          items,
          operationKey: loadOperationKey.current,
          notes: loadNote || null,
        }
      },
      {
        onSuccess: (res) => {
          claimExisting.mutate(
            {
              handoffId: res.id,
              data: {
                operationKey: claimOperationKey.current,
                barcodes,
              },
            },
            {
              onSuccess: () => {
                toast({ title: `Yuklash va mavjud stikerlar tayyor (ID: ${res.id})` });
                setLoadQuantities({});
                setLoadNote("");
                setLoadBarcodes("");
                loadOperationKey.current = newOperationKey();
                claimOperationKey.current = newOperationKey();
                qc.invalidateQueries({ queryKey: ["topmart-overview"] });
                qc.invalidateQueries({ queryKey: getListVehicleHandoffsQueryKey() });
                qc.invalidateQueries({ queryKey: getListVehicleReplenishmentRequestsQueryKey() });
                qc.invalidateQueries({ queryKey: getGetVehicleDistributionPilotStockQueryKey() });
              },
              onError: (err: any) => {
                toast({
                  title: `Yuklash yaratildi (ID: ${res.id}), stikerlar biriktirilmadi`,
                  description: err?.error || err?.message || "Noma'lum xatolik",
                  variant: "destructive",
                });
              },
            },
          );
        },
        onError: (err: any) => {
          toast({
            title: "Yuklashda xatolik",
            description: err?.error || err?.message || "Noma'lum xatolik",
            variant: "destructive"
          });
        }
      }
    );
  };

  const handleReceiptSubmit = () => {
    const saleId = Number(receiptSaleId);
    const barcodes = receiptBarcodes
      .split(/[\s,;]+/)
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean);
    if (!Number.isSafeInteger(saleId) || saleId <= 0 || barcodes.length === 0) {
      toast({
        title: "Savdo ID va stikerlar talab qilinadi",
        variant: "destructive",
      });
      return;
    }
    registerReceipt.mutate(
      { data: { saleId, barcodes } },
      {
        onSuccess: (result) => {
          toast({
            title: result.replayed
              ? "Stikerlar kirimi avval qayd etilgan"
              : "C-3 stiker kirimi qayd etildi",
          });
          setReceiptSaleId("");
          setReceiptBarcodes("");
        },
        onError: (err: any) => {
          toast({
            title: "Stiker kirimini qayd etib bo‘lmadi",
            description: err?.error || err?.message || "Noma'lum xatolik",
            variant: "destructive",
          });
        },
      },
    );
  };

  // Exclude vehicle warehouses from the dropdown if metadata is present
  const availableWarehouses = warehouses?.filter(w => !w.locationType || w.locationType !== 'vehicle') || [];

  return (
    <div className="p-4 space-y-6">
      {/* Config Section */}
      <Card className="border-sidebar-primary-border/20 bg-sidebar-primary/5">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg font-semibold flex items-center gap-2 text-sidebar-primary">
            <Building2 className="w-5 h-5" />
            Top Mart Operatsion Modeli
          </CardTitle>
        </CardHeader>
        <CardContent>
          {configError ? (
            <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-md text-sm">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{(configError as Error).message}</span>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 gap-4 items-end">
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Top Mart sifatida mijoz</label>
                <Select value={draftCustomer} onValueChange={setDraftCustomer} disabled={isLoadingConfig}>
                  <SelectTrigger className="bg-background">
                    <SelectValue placeholder={isLoadingConfig ? "Yuklanmoqda..." : "Mijoz tanlang"} />
                  </SelectTrigger>
                  <SelectContent>
                    {customers?.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.name} {c.company ? `(${c.company})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Markaziy Konteyner (C-3) ombori</label>
                <Select value={draftWarehouse} onValueChange={setDraftWarehouse} disabled={isLoadingConfig}>
                  <SelectTrigger className="bg-background">
                    <SelectValue placeholder={isLoadingConfig ? "Yuklanmoqda..." : "Ombor tanlang"} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableWarehouses.map((w) => (
                      <SelectItem key={w.id} value={String(w.id)}>
                        {w.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="md:col-span-2 flex justify-end">
                <Button
                  onClick={handleSave}
                  disabled={!canSave || saveConfig.isPending}
                  className="gap-2 bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90"
                >
                  {saveConfig.isPending ? <Activity className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Saqlash
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Overview Section */}
      {isConfigured && (
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Oqim Holati (Zanjir)</h3>

          {overviewError ? (
            <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-md text-sm">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{(overviewError as Error).message}</span>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
              <Card>
                <CardContent className="p-5 flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                    <Warehouse className="w-6 h-6 text-blue-700" />
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground">C-3 Markaziy Zaxira</div>
                    {isLoadingOverview ? <Skeleton className="h-6 w-24 mt-1" /> : (
                      <div className="text-xl font-bold mt-1">
                        {overview?.c3StockTotalKg.toLocaleString()} kg
                        <span className="text-sm font-normal text-muted-foreground ml-1">({overview?.c3StockTotalQty} dona)</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-5 flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                    <Warehouse className="w-6 h-6 text-indigo-700" />
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground">Avto Zaxiralar (Jami)</div>
                    {isLoadingOverview ? <Skeleton className="h-6 w-24 mt-1" /> : (
                      <div className="text-xl font-bold mt-1">
                        {overview?.vehicleStockTotalKg.toLocaleString()} kg
                        <span className="text-sm font-normal text-muted-foreground ml-1">({overview?.vehicleStockTotalQty} dona)</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-5 flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
                    <Activity className="w-6 h-6 text-emerald-700" />
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground">Operatsion Holat</div>
                    {isLoadingOverview ? <Skeleton className="h-6 w-24 mt-1" /> : (
                      <div className="text-sm font-semibold mt-1 text-emerald-700 leading-tight">
                        {overview?.flowStatus}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-5 flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                    <ReceiptText className="w-6 h-6 text-amber-700" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm text-muted-foreground">Korxonadan xarid hisobi</div>
                    {isLoadingOverview ? <Skeleton className="h-6 w-28 mt-1" /> : (
                      <div className="mt-1 space-y-0.5">
                        <div className="font-semibold">{overview?.sales.count ?? 0} ta savdo</div>
                        {overview?.sales.byCurrency.map((row) => (
                          <div key={row.currency} className="text-xs text-muted-foreground">
                            Jami {formatAmount(row.totalAmount, row.currency)} · qarz{" "}
                            <span className={row.debtAmount > 0 ? "font-medium text-red-600" : ""}>
                              {formatAmount(row.debtAmount, row.currency)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {overview && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">C-3 mahsulot qoldig‘i</CardTitle>
                <CardDescription>
                  Korxonadan Top Martga sotilgan va markaziy omborga kirim qilingan mahsulotlar
                </CardDescription>
              </CardHeader>
              <CardContent>
                {overview.inventory.length === 0 ? (
                  <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                    C-3 markaziy omborida hozircha mahsulot yo‘q.
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">Mahsulot</th>
                          <th className="px-3 py-2 text-right font-medium">Dona</th>
                          <th className="px-3 py-2 text-right font-medium">Vazn</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {overview.inventory.map((item) => (
                          <tr key={item.product}>
                            <td className="px-3 py-2 font-medium">{item.product}</td>
                            <td className="px-3 py-2 text-right">{Number(item.quantity).toLocaleString("uz-UZ")}</td>
                            <td className="px-3 py-2 text-right">{Number(item.weightKg).toLocaleString("uz-UZ")} kg</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {overview && (
            <Card className="border-emerald-200">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">C-3 stiker kirimini qayd etish</CardTitle>
                <CardDescription>
                  Kredit qilingan Top Mart savdo ID sini va shu savdo bilan C-3 ga kelgan mavjud stikerlarni kiriting.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Input
                  type="number"
                  min="1"
                  step="1"
                  placeholder="Kredit qilingan savdo ID"
                  value={receiptSaleId}
                  onChange={(event) => setReceiptSaleId(event.target.value)}
                  disabled={registerReceipt.isPending}
                />
                <Textarea
                  placeholder="Qabul qilingan stiker shtrix-kodlari (har biri yangi qatorda)..."
                  value={receiptBarcodes}
                  onChange={(event) => setReceiptBarcodes(event.target.value)}
                  disabled={registerReceipt.isPending}
                  className="min-h-[100px] font-mono text-sm"
                />
                <div className="flex justify-end">
                  <Button
                    onClick={handleReceiptSubmit}
                    disabled={registerReceipt.isPending || !receiptSaleId || !receiptBarcodes.trim()}
                  >
                    {registerReceipt.isPending && <Activity className="mr-2 h-4 w-4 animate-spin" />}
                    Kirimni qayd etish
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Load to Vehicle Form */}
          {overview && (
            <Card className="mt-8 border-sidebar-primary-border/20">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg font-semibold flex items-center gap-2 text-sidebar-primary">
                  <Truck className="w-5 h-5" />
                  C-3 dan mashinaga yuklash
                </CardTitle>
                <CardDescription>
                  Markaziy ombordan mavjud mahsulotlarni ajratib yuklashni boshlash
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {(overview.loadableItems ?? []).map((item) => (
                    <div key={item.mahsulotId} className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-3 border rounded-md">
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-sm truncate">{item.productName}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          SKU: {item.sku} • Mavjud: {item.availableQuantity} dona ({item.availableWeightKg.toFixed(2)} kg)
                          {item.piecesPerBox > 1 && ` • Qutida: ${item.piecesPerBox} dona`}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Input
                          type="number"
                          min="0"
                          max={item.availableQuantity}
                           step="1"
                          placeholder="Dona..."
                          className="w-24 h-9 text-sm text-right"
                          value={loadQuantities[item.mahsulotId] || ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val === "" || (Number(val) >= 0 && Number(val) <= item.availableQuantity)) {
                              setLoadQuantities(prev => ({ ...prev, [item.mahsulotId]: val }));
                            }
                          }}
                        />
                      </div>
                    </div>
                  ))}

                  {(overview.loadableItems ?? []).length === 0 && (
                    <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                      Mashinaga yuklash uchun SKU bilan bog‘langan dona mahsulot mavjud emas.
                    </div>
                  )}

                  <div className="pt-2">
                    <Textarea
                      placeholder="Mavjud stiker shtrix-kodlari (har biri yangi qatorda)..."
                      value={loadBarcodes}
                      onChange={(e) => {
                        setLoadBarcodes(e.target.value);
                        claimOperationKey.current = newOperationKey();
                      }}
                      disabled={createHandoff.isPending || claimExisting.isPending}
                      className="min-h-[100px] font-mono text-sm"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Faqat avval chop etilgan ishlab chiqarish stikerlarini skanerlang yoki kiriting.
                    </p>
                  </div>

                  <div className="pt-2">
                    <Textarea
                      placeholder="Qo'shimcha eslatma (ixtiyoriy)..."
                      value={loadNote}
                      onChange={(e) => setLoadNote(e.target.value)}
                      className="min-h-[80px] text-sm"
                    />
                  </div>

                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-2">
                    <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 p-2 rounded-md border border-amber-200">
                      <Info className="w-4 h-4 shrink-0" />
                      <span>
                        Eslatma: Yuklash tayyorlangach, ombordan fizik jihatdan mashinaga o'tkazilmaguncha (tasdiqlanmaguncha) zaxira o'zgarmaydi.
                      </span>
                    </div>
                    <Button
                      onClick={handleLoadSubmit}
                      disabled={createHandoff.isPending || claimExisting.isPending || !loadBarcodes.trim() || !Object.values(loadQuantities).some(q => Number(q) > 0)}
                      className="shrink-0 bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90 gap-2 w-full sm:w-auto"
                    >
                      {(createHandoff.isPending || claimExisting.isPending) ? <Activity className="w-4 h-4 animate-spin" /> : <Truck className="w-4 h-4" />}
                      Yuklashni boshlash
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
