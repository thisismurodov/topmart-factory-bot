import { useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import {
  useGetVehicleDistributionPilotStock,
  useGetVehicleDistributionPilotMovements,
  getGetVehicleDistributionPilotStockQueryKey,
  getGetVehicleDistributionPilotMovementsQueryKey,
  GetVehicleDistributionPilotStockQueryError
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RefreshCw, Truck, Box, MapPin, Package, AlertCircle, ArrowRightLeft, Database, ClipboardList, PackagePlus, Undo2, CalendarCheck2 } from "lucide-react";
import { VehicleReconciliations } from "./VehicleReconciliations";
import { VehicleReplenishment } from "./VehicleReplenishment";
import { VehicleReturns } from "./VehicleReturns";
import { VehicleWeeklyReadiness } from "./VehicleWeeklyReadiness";

// --- Subcomponents ---

function MovementTypeBadge({ type }: { type: string }) {
  if (!type) return <Badge variant="outline">—</Badge>;
  const lower = type.toLowerCase();
  if (lower.includes("load") || lower.includes("in")) 
    return <Badge className="bg-indigo-100 text-indigo-700 hover:bg-indigo-200 border-indigo-200 uppercase text-[10px] tracking-wider px-1.5 h-5">{type}</Badge>;
  if (lower.includes("unload") || lower.includes("out") || lower.includes("sale") || lower.includes("disp")) 
    return <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-200 border-amber-200 uppercase text-[10px] tracking-wider px-1.5 h-5">{type}</Badge>;
  
  return <Badge variant="secondary" className="uppercase text-[10px] tracking-wider text-slate-600 px-1.5 h-5">{type}</Badge>;
}

function MovementsPage({ 
  cursor, active, isLast, onLoadMore 
}: { 
  cursor?: number; active: boolean; isLast: boolean; onLoadMore: (n: number) => void;
}) {
  const { data, isLoading } = useGetVehicleDistributionPilotMovements(
    { beforeId: cursor, limit: 50 },
    { query: { enabled: active, queryKey: getGetVehicleDistributionPilotMovementsQueryKey({ beforeId: cursor, limit: 50 }) } }
  );

  if (isLoading) {
     return (
       <>
         {Array.from({length: 3}).map((_, i) => (
           <TableRow key={i}>
             <TableCell colSpan={7}><Skeleton className="h-6 w-full" /></TableCell>
           </TableRow>
         ))}
       </>
     );
  }

  if (!data || !data.items.length) {
     return isLast && cursor === undefined ? (
       <TableRow>
         <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
           Harakatlar topilmadi
         </TableCell>
       </TableRow>
     ) : null;
  }

  return (
    <>
      {data.items.map(m => (
        <TableRow key={m.id}>
           <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
             {m.createdAt.slice(0, 16).replace('T', ' ')}
           </TableCell>
           <TableCell>
             <MovementTypeBadge type={m.movementType} />
           </TableCell>
           <TableCell className="font-medium text-sm">
             {m.product}
           </TableCell>
           <TableCell className="text-right font-semibold text-sm">
              {m.quantity.toLocaleString("uz-UZ")} dona
           </TableCell>
           <TableCell className="text-right text-muted-foreground text-sm">
             {m.weightKg ? `${m.weightKg.toLocaleString("uz-UZ")} kg` : "—"}
           </TableCell>
           <TableCell>
             <div className="flex flex-col text-[11px] leading-tight max-w-[180px]">
               {m.fromWarehouseName && <span className="text-muted-foreground truncate">Dan: {m.fromWarehouseName}</span>}
               {m.toWarehouseName && <span className="text-indigo-600 truncate">Ga: {m.toWarehouseName}</span>}
             </div>
           </TableCell>
           <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate" title={m.note || ""}>
             {m.note || "—"}
             {m.reference && <div className="text-[10px] text-slate-400 mt-0.5">Ref: {m.reference}</div>}
           </TableCell>
        </TableRow>
      ))}
      {isLast && data.nextBeforeId !== null && (
        <TableRow>
          <TableCell colSpan={7} className="p-0">
            <Button 
               variant="ghost" 
               className="w-full h-12 rounded-none text-slate-600 hover:text-slate-900 hover:bg-slate-50 border-t"
               onClick={() => onLoadMore(data.nextBeforeId!)}
            >
               Ko'proq yuklash
            </Button>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// --- Main Tab Component ---

export default function VehicleStockTab({ active }: { active: boolean }) {
  const queryClient = useQueryClient();
  const [subTab, setSubTab] = useState("stock");
  const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);

  const { 
    data: stockData, 
    isFetching: isStockFetching, 
    error: stockError 
  } = useGetVehicleDistributionPilotStock({ 
    query: { 
      enabled: active, 
      queryKey: getGetVehicleDistributionPilotStockQueryKey(),
      retry: (failureCount, error) => {
        const status = (error as any)?.status ?? (error as any)?.response?.status;
        if (status === 404 || status === 503) return false;
        return failureCount < 3;
      }
    } 
  });

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getGetVehicleDistributionPilotStockQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetVehicleDistributionPilotMovementsQueryKey() });
    // Reset movements pagination on refresh
    setCursors([undefined]);
  }, [queryClient]);

  const handleLoadMore = useCallback((nextBeforeId: number) => {
    setCursors(prev => [...prev, nextBeforeId]);
  }, []);

  if (!active) return null;

  const err = stockError as GetVehicleDistributionPilotStockQueryError | null;
  const is404 = err?.status === 404 || (err as any)?.response?.status === 404;
  const is503 = err?.status === 503 || (err as any)?.response?.status === 503;

  if (is404) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-slate-500 border rounded-md bg-slate-50 mt-4">
        <Package className="w-10 h-10 mb-3 opacity-40" />
        <h3 className="text-base font-semibold text-slate-700">Avto zaxira mavjud emas</h3>
        <p className="text-sm mt-1">Ushbu funksiya hozircha ishga tushirilmagan.</p>
      </div>
    );
  }

  if (is503) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-slate-500 border rounded-md bg-slate-50 mt-4">
        <Database className="w-10 h-10 mb-3 opacity-40 text-amber-500" />
        <h3 className="text-base font-semibold text-slate-700">Tizim yangilanmoqda</h3>
        <p className="text-sm mt-1">Yangi ma'lumotlar bazasi sxemasi kutilmoqda.</p>
      </div>
    );
  }

  const isBootstrapped = stockData?.bootstrapped;

  return (
    <div className="space-y-4 pt-4">
      {/* Header Info Card */}
      <Card className="bg-slate-50 border-slate-200 shadow-sm">
        <CardContent className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Truck className="w-5 h-5 text-indigo-600" />
              <h2 className="text-lg font-bold text-slate-800 tracking-tight">
                {isBootstrapped ? stockData?.vehicle?.plateNumber : "Avto ombor"}
              </h2>
              {isBootstrapped && stockData?.vehicle?.status && (
                <Badge variant="outline" className="bg-white text-indigo-700 border-indigo-200">
                  {stockData.vehicle.status}
                </Badge>
              )}
            </div>
            
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
              {isBootstrapped && stockData?.warehouse && (
                <span className="flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5 opacity-70" />
                  {stockData.warehouse.name}
                </span>
              )}
              {!isBootstrapped && (
                <span className="text-amber-600 flex items-center gap-1.5">
                  <AlertCircle className="w-4 h-4" /> Boshlang'ich holat o'rnatilmagan
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 self-start sm:self-center">
            {isBootstrapped && (
              <div className="flex items-center gap-3 bg-white px-3 py-1.5 rounded-md border border-slate-200 shadow-sm text-sm">
                <div className="flex flex-col">
                  <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">Jami mahsulot (dona)</span>
                  <span className="font-bold text-slate-700">{stockData?.totalQuantity?.toLocaleString("uz-UZ") ?? 0} dona</span>
                </div>
                <div className="w-px h-6 bg-slate-200 mx-1"></div>
                <div className="flex flex-col">
                  <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">Umumiy Vazn</span>
                  <span className="font-bold text-slate-700">{stockData?.totalWeightKg?.toLocaleString("uz-UZ") ?? 0} kg</span>
                </div>
              </div>
            )}
            
            <Button 
              variant="outline" 
              size="icon" 
              className="h-9 w-9 bg-white text-slate-600 border-slate-200 hover:bg-slate-100" 
              onClick={handleRefresh}
              disabled={isStockFetching}
              title="Yangilash"
            >
              <RefreshCw className={`w-4 h-4 ${isStockFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Tabs for Stock & Movements */}
      <Tabs value={subTab} onValueChange={setSubTab}>
        <TabsList className="bg-slate-100 border-b border-slate-200 rounded-none w-full justify-start h-auto p-0 pb-px gap-2 sm:gap-6 px-2 sm:px-4 overflow-x-auto">
          <TabsTrigger
            value="stock"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-indigo-600 data-[state=active]:bg-transparent data-[state=active]:shadow-none py-2.5 px-1 font-medium text-slate-600 data-[state=active]:text-indigo-700 transition-none"
          >
            <Box className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Zaxira Qoldig'i</span>
            <span className="sr-only sm:hidden">Zaxira Qoldig'i</span>
            {isBootstrapped && stockData?.skuCount > 0 && (
              <Badge className="ml-2 bg-indigo-100 text-indigo-700 border-transparent hover:bg-indigo-100 px-1.5 py-0 text-[10px]">
                {stockData.skuCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger
            value="replenishment"
            className="rounded-none shrink-0 border-b-2 border-transparent data-[state=active]:border-indigo-600 data-[state=active]:bg-transparent data-[state=active]:shadow-none py-2.5 px-1 font-medium text-slate-600 data-[state=active]:text-indigo-700 transition-none"
          >
            <PackagePlus className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">To‘ldirish</span>
            <span className="sr-only sm:hidden">To‘ldirish</span>
          </TabsTrigger>
          <TabsTrigger
            value="movements"
            className="rounded-none shrink-0 border-b-2 border-transparent data-[state=active]:border-amber-500 data-[state=active]:bg-transparent data-[state=active]:shadow-none py-2.5 px-1 font-medium text-slate-600 data-[state=active]:text-amber-700 transition-none"
          >
            <ArrowRightLeft className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Harakatlar Tarixi</span>
            <span className="sr-only sm:hidden">Harakatlar Tarixi</span>
          </TabsTrigger>
          <TabsTrigger
            value="reconciliations"
            className="rounded-none shrink-0 border-b-2 border-transparent data-[state=active]:border-emerald-500 data-[state=active]:bg-transparent data-[state=active]:shadow-none py-2.5 px-1 font-medium text-slate-600 data-[state=active]:text-emerald-700 transition-none"
          >
            <ClipboardList className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Fizik Sanoq</span>
            <span className="sr-only sm:hidden">Fizik Sanoq</span>
          </TabsTrigger>
          <TabsTrigger
            value="returns"
            data-testid="tab-vehicle-returns"
            className="rounded-none shrink-0 border-b-2 border-transparent data-[state=active]:border-violet-500 data-[state=active]:bg-transparent data-[state=active]:shadow-none py-2.5 px-1 font-medium text-slate-600 data-[state=active]:text-violet-700 transition-none"
          >
            <Undo2 className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Qaytarish</span>
            <span className="sr-only sm:hidden">Qaytarish</span>
          </TabsTrigger>
          <TabsTrigger
            value="weekly"
            data-testid="tab-vehicle-weekly"
            className="rounded-none shrink-0 border-b-2 border-transparent data-[state=active]:border-cyan-600 data-[state=active]:bg-transparent data-[state=active]:shadow-none py-2.5 px-1 font-medium text-slate-600 data-[state=active]:text-cyan-700 transition-none"
          >
            <CalendarCheck2 className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Haftalik</span>
            <span className="sr-only sm:hidden">Haftalik tayyorlik</span>
          </TabsTrigger>
        </TabsList>

        <div className="bg-white border border-t-0 rounded-b-md shadow-sm overflow-hidden">
          <TabsContent value="stock" className="m-0 border-none p-0 outline-none">
            {isStockFetching && !stockData ? (
              <div className="p-4 space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : !isBootstrapped || !stockData?.items.length ? (
              <div className="py-12 flex flex-col items-center justify-center text-slate-400">
                <Box className="w-8 h-8 mb-2 opacity-30" />
                <p>Avto omborda mahsulotlar yo'q</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-slate-50">
                    <TableRow className="hover:bg-slate-50">
                      <TableHead className="w-[120px]">Kodu</TableHead>
                      <TableHead>Nomi</TableHead>
                       <TableHead className="text-right">Miqdor (dona)</TableHead>
                      <TableHead className="text-right">Vazn (kg)</TableHead>
                      <TableHead className="w-[150px]">Oxirgi yangilanish</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stockData.items.map((item, idx) => (
                      <TableRow key={`${item.product}-${idx}`} className="group">
                        <TableCell className="font-mono text-xs text-slate-500">
                          {item.productSku || item.product}
                        </TableCell>
                        <TableCell className="font-medium text-slate-800">
                          {item.productName || item.product}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="inline-flex items-center justify-center min-w-[3rem] px-2 py-0.5 rounded-md bg-slate-100 font-semibold text-slate-700 text-sm">
                             {item.quantity.toLocaleString("uz-UZ")} dona
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-slate-600 text-sm">
                          {item.weightKg.toLocaleString("uz-UZ")}
                        </TableCell>
                        <TableCell className="text-xs text-slate-400 whitespace-nowrap">
                          {item.updatedAt ? item.updatedAt.slice(0, 16).replace('T', ' ') : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          <TabsContent value="movements" className="m-0 border-none p-0 outline-none">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-slate-50">
                  <TableRow className="hover:bg-slate-50">
                    <TableHead className="w-[130px]">Sana</TableHead>
                    <TableHead className="w-[100px]">Turi</TableHead>
                    <TableHead>Mahsulot</TableHead>
                     <TableHead className="text-right w-[110px]">Miqdor (dona)</TableHead>
                    <TableHead className="text-right w-[100px]">Vazn</TableHead>
                    <TableHead>Yo'nalish</TableHead>
                    <TableHead className="w-[200px]">Izoh</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cursors.map((c, i) => (
                    <MovementsPage 
                      key={c || 'first'} 
                      cursor={c} 
                      active={active && subTab === "movements"} 
                      isLast={i === cursors.length - 1}
                      onLoadMore={handleLoadMore} 
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          <TabsContent value="replenishment" className="m-0 border-none p-0 outline-none">
            <VehicleReplenishment active={active && subTab === "replenishment"} />
          </TabsContent>

          <TabsContent value="reconciliations" className="m-0 border-none p-0 outline-none">
            <VehicleReconciliations active={active && subTab === "reconciliations"} />
          </TabsContent>

          <TabsContent value="returns" className="m-0 border-none p-0 outline-none">
            <VehicleReturns active={active && subTab === "returns"} />
          </TabsContent>

          <TabsContent value="weekly" className="m-0 border-none p-0 outline-none">
            <VehicleWeeklyReadiness active={active && subTab === "weekly"} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
