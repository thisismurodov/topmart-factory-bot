import { useState } from "react";
import {
  useGetBatches,
  getGetBatchesQueryKey,
  useDeleteBatch,
  useGetProductionLabel,
  getGetProductionLabelQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency, formatNumber, formatDate } from "@/lib/format";
import { Trash2, Search, X, Archive, ArchiveRestore, ScanBarcode, AlertCircle, Printer, Box, Package, Barcode } from "lucide-react";
import { authFetch } from "@/App";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Batches() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [page, setPage] = useState(0);
  const limit = 50;
  const [showArchived, setShowArchived] = useState(false);
  
  const [filters, setFilters] = useState({ date: "", worker: "", product: "" });
  const [activeFilters, setActiveFilters] = useState({ date: "", worker: "", product: "" });

  const [scannedValue, setScannedValue] = useState("");
  const [submittedBarcode, setSubmittedBarcode] = useState("");
  const normalizedBarcode = submittedBarcode.trim().toUpperCase();
  const barcodeIsValid = /^TM[A-Z2-7]{16}$/.test(normalizedBarcode);

  const { data: passport, isLoading: isLoadingPassport, error: passportError } = useGetProductionLabel(
    normalizedBarcode,
    { 
      query: { 
        queryKey: getGetProductionLabelQueryKey(normalizedBarcode),
        enabled: barcodeIsValid,
        retry: false 
      } 
    }
  );

  const { data, isLoading } = useGetBatches(
    { 
      limit, 
      offset: page * limit,
      ...(activeFilters.date ? { date: activeFilters.date } : {}),
      ...(activeFilters.worker ? { worker: activeFilters.worker } : {}),
      ...(activeFilters.product ? { product: activeFilters.product } : {}),
    },
    { query: { queryKey: [...getGetBatchesQueryKey({ limit, offset: page * limit, ...activeFilters }), showArchived] } }
  );

  const deleteBatch = useDeleteBatch({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBatchesQueryKey() });
      }
    }
  });

  async function toggleArchive(id: number, currentlyArchived: boolean) {
    try {
      await authFetch(`/api/batches/${id}/archive`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: !currentlyArchived }),
      });
      queryClient.invalidateQueries({ queryKey: getGetBatchesQueryKey() });
      toast({ description: currentlyArchived ? "Partiya tiklandi" : "Partiya arxivlandi" });
    } catch {
      toast({ variant: "destructive", description: "Amal bajarilmadi" });
    }
  }

  const applyFilters = () => {
    setPage(0);
    setActiveFilters(filters);
  };

  const clearFilters = () => {
    setFilters({ date: "", worker: "", product: "" });
    setActiveFilters({ date: "", worker: "", product: "" });
    setPage(0);
  };

  const handleScanSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (scannedValue.trim()) {
      const normalized = scannedValue.trim().toUpperCase();
      setScannedValue(normalized);
      setSubmittedBarcode(normalized);
    } else {
      setSubmittedBarcode("");
    }
  };

  const handleClearScanner = () => {
    setScannedValue("");
    setSubmittedBarcode("");
  };

  return (
    <div className="space-y-6">
      <Card className="border-border border-t-4 border-t-primary shadow-sm">
        <CardHeader className="pb-4 bg-muted/20">
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-primary flex items-center gap-2">
            <ScanBarcode className="w-4 h-4" />
            Etiketka passportini tekshirish
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <form onSubmit={handleScanSubmit} className="flex flex-col sm:flex-row gap-2 max-w-2xl">
            <Input
              value={scannedValue}
              onChange={(e) => setScannedValue(e.target.value)}
              placeholder="Barcode skanerlang yoki TM… kodini kiriting"
              className="font-mono text-base sm:text-lg h-12 min-w-0 flex-1 border-primary/20 focus-visible:ring-primary"
              autoFocus
              data-testid="input-barcode-scanner"
            />
            <Button type="submit" className="h-12 px-6 shadow-sm font-medium" data-testid="btn-scan-submit">
              Tekshirish
            </Button>
            {submittedBarcode && (
              <Button type="button" variant="outline" className="h-12 px-4" onClick={handleClearScanner} data-testid="btn-scan-clear" title="Skan maydonini tozalash">
                <X className="w-4 h-4" />
              </Button>
            )}
          </form>

          {submittedBarcode && (
            <div className="mt-6 animate-in fade-in slide-in-from-top-2 duration-200">
              {!barcodeIsValid ? (
                <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-md flex items-start gap-3 text-destructive shadow-sm">
                  <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
                  <div>
                    <h4 className="font-semibold text-sm">Barcode formati noto‘g‘ri</h4>
                    <p className="text-sm opacity-90 mt-1">
                      Fizik etiketka kodi <span className="font-mono font-semibold">TM</span> bilan boshlanadigan 18 belgili passport bo‘lishi kerak.
                    </p>
                  </div>
                </div>
              ) : isLoadingPassport ? (
                <div className="space-y-3 rounded-lg border border-border p-4">
                  <Skeleton className="h-6 w-1/3" />
                  <Skeleton className="h-20 w-full" />
                </div>
              ) : passportError ? (
                <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-md flex items-start gap-3 text-destructive shadow-sm">
                   <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
                   <div>
                     <h4 className="font-semibold text-sm">Etiketka topilmadi</h4>
                     <p className="text-sm opacity-90 mt-1">
                       <span className="font-mono font-semibold">{normalizedBarcode}</span> passporti mavjud emas. Skan natijasini tekshirib, qayta urinib ko‘ring.
                     </p>
                   </div>
                </div>
              ) : passport ? (
                <div className="rounded-lg border border-border overflow-hidden bg-card shadow-sm">
                   <div className="bg-muted/50 px-4 py-3 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-border">
                    <div className="flex items-center gap-3">
                      <Barcode className="w-5 h-5 text-muted-foreground" />
                      <span className="font-mono font-semibold text-base" data-testid="text-passport-barcode">{passport.barcode}</span>
                    </div>
                    <div className={`px-2.5 py-1 text-xs font-bold uppercase tracking-wider rounded-sm shadow-sm ${
                      passport.status === 'printed' ? 'bg-primary text-primary-foreground' :
                      passport.status === 'void' ? 'bg-destructive text-destructive-foreground' :
                      'bg-secondary text-secondary-foreground border border-border'
                    }`} data-testid="badge-passport-status">
                      {passport.status === "printed" ? "Chop etilgan" :
                       passport.status === "void" ? "Bekor qilingan" : "Yaratilgan"}
                    </div>
                  </div>
                  
                  <div className="p-0">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 divide-y md:divide-y-0 lg:divide-x divide-border">
                      
                      <div className="p-4 space-y-4 lg:col-span-2">
                        <div>
                           <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">Mahsulot</div>
                          <div className="font-medium text-sm" data-testid="text-passport-product">{passport.productName}</div>
                          <div className="text-xs text-muted-foreground font-mono mt-0.5">SKU: {passport.productSku}</div>
                        </div>
                        
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                             <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">Partiya kodi</div>
                             <div className="font-mono text-sm font-medium">{passport.batchCode || '—'}</div>
                          </div>
                          <div>
                             <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">Ishchi</div>
                            <div className="text-sm font-medium">{passport.workerName}</div>
                          </div>
                        </div>
                        
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                             <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">Ishlab chiqarilgan vaqt</div>
                            <div className="text-sm font-medium">{formatDate(passport.producedAt)}</div>
                          </div>
                          <div>
                             <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">Boshlang‘ich ombor</div>
                             <div className="text-sm font-medium">{passport.warehouseName || 'Belgilanmagan'}</div>
                          </div>
                        </div>
                      </div>
                      
                      <div className="p-4 space-y-4">
                        <div>
                           <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">Etiketka</div>
                          <div className="flex items-center gap-2 mb-2">
                             {passport.labelType === 'box' ? <Package className="w-4 h-4 text-primary" /> : <Box className="w-4 h-4 text-primary" />}
                              <span className="text-sm font-medium">{passport.labelType === "box" ? "Quti etiketkasi" : "Dona etiketkasi"}</span>
                          </div>
                          <div className="text-sm">
                             Tartib: <span className="font-mono font-medium">{passport.labelNumber}</span> / <span className="font-mono text-muted-foreground">{passport.totalLabels}</span>
                          </div>
                        </div>
                        
                        <div>
                           <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">Tarkib</div>
                           <div className="text-sm">Etiketkadagi dona: <span className="font-mono font-medium">{passport.piecesInLabel}</span></div>
                          {passport.labelType === 'box' && (
                             <div className="text-sm mt-1">Quti sig‘imi: <span className="font-mono font-medium">{passport.piecesPerBox}</span></div>
                          )}
                        </div>
                      </div>
                      
                      <div className="p-4 space-y-4">
                        <div>
                           <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">O‘lchovlar</div>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                               <div className="text-xs text-muted-foreground">Partiya donasi</div>
                              <div className="font-mono text-sm font-medium">{formatNumber(passport.quantityTotal)}</div>
                            </div>
                            <div>
                               <div className="text-xs text-muted-foreground">Etiketka KG</div>
                              <div className="font-mono text-sm font-medium">{formatNumber(passport.weightKg)} kg</div>
                            </div>
                            {passport.lengthM != null && (
                               <div className="col-span-2 mt-1">
                                 <div className="text-xs text-muted-foreground">Metr</div>
                                 <div className="font-mono text-sm font-medium">{formatNumber(passport.lengthM)} m</div>
                               </div>
                            )}
                          </div>
                        </div>
                        
                        <div>
                            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">Chop tarixi</div>
                           <div className="text-sm flex items-center gap-2">
                             <Printer className="w-3.5 h-3.5 text-muted-foreground" />
                              <span className="font-medium">{passport.printCount} marta chop etilgan</span>
                           </div>
                           {passport.lastPrintedAt && (
                             <div className="text-xs text-muted-foreground mt-1">
                                Oxirgi chop: {formatDate(passport.lastPrintedAt)}
                             </div>
                           )}
                        </div>
                      </div>
                      
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">Partiyalarni Qidirish</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4 items-end">
            <div className="space-y-2 flex-1 min-w-[200px]">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Sana (YYYY-MM-DD)</label>
              <Input 
                placeholder="masalan: 2024-06-01" 
                value={filters.date} 
                onChange={e => setFilters(f => ({...f, date: e.target.value}))}
                data-testid="filter-date"
              />
            </div>
            <div className="space-y-2 flex-1 min-w-[200px]">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Ishchi nomi</label>
              <Input 
                placeholder="masalan: Aziz" 
                value={filters.worker} 
                onChange={e => setFilters(f => ({...f, worker: e.target.value}))}
                data-testid="filter-worker"
              />
            </div>
            <div className="space-y-2 flex-1 min-w-[200px]">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Mahsulot</label>
              <Input 
                placeholder="masalan: Arqon 6mm" 
                value={filters.product} 
                onChange={e => setFilters(f => ({...f, product: e.target.value}))}
                data-testid="filter-product"
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={applyFilters} data-testid="btn-apply-filters">
                <Search className="w-4 h-4 mr-2" /> Qidirish
              </Button>
              <Button variant="outline" onClick={clearFilters} data-testid="btn-clear-filters">
                <X className="w-4 h-4 mr-2" /> Tozalash
              </Button>
              <Button
                variant={showArchived ? "default" : "outline"}
                onClick={() => { setShowArchived(s => !s); setPage(0); }}
                data-testid="btn-toggle-archived"
              >
                <Archive className="w-4 h-4 mr-2" />
                {showArchived ? "Faollarni ko'rsatish" : "Arxivlanganlar"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border shadow-sm">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="w-[180px]">Partiya kodi</TableHead>
                <TableHead>Sana va vaqt</TableHead>
                <TableHead>Ishchi</TableHead>
                <TableHead>Mahsulot</TableHead>
                <TableHead className="text-right">Miqdor</TableHead>
                <TableHead className="text-right">Og'irlik</TableHead>
                <TableHead className="text-right">Maosh</TableHead>
                <TableHead className="text-right w-[100px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-5 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-32" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-24" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-5 w-12 ml-auto" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-5 w-16 ml-auto" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-5 w-20 ml-auto" /></TableCell>
                    <TableCell></TableCell>
                  </TableRow>
                ))
              ) : data?.items?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    Partiyalar topilmadi.
                  </TableCell>
                </TableRow>
              ) : (
                data?.items.map(batch => (
                  <TableRow key={batch.id} data-testid={`batch-row-${batch.id}`}>
                    <TableCell className="font-mono text-xs font-medium">{batch.batchCode}</TableCell>
                    <TableCell className="text-sm">{formatDate(batch.createdAt)}</TableCell>
                    <TableCell className="font-medium">{batch.worker}</TableCell>
                    <TableCell>{batch.product}</TableCell>
                    <TableCell className="text-right font-mono">{formatNumber(batch.quantity)}</TableCell>
                    <TableCell className="text-right font-mono">{formatNumber(batch.weightKg)} kg</TableCell>
                    <TableCell className="text-right font-mono font-medium">{formatCurrency(batch.earnings)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost" size="icon"
                          className="h-8 w-8 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                          title={(batch as unknown as { archived?: boolean }).archived ? "Tiklash" : "Arxivlash"}
                          onClick={() => toggleArchive(batch.id, !!(batch as unknown as { archived?: boolean }).archived)}
                          data-testid={`btn-archive-${batch.id}`}
                        >
                          {(batch as unknown as { archived?: boolean }).archived
                            ? <ArchiveRestore className="w-4 h-4" />
                            : <Archive className="w-4 h-4" />}
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10" data-testid={`btn-delete-${batch.id}`}>
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Partiyani o'chirish?</AlertDialogTitle>
                              <AlertDialogDescription>
                                Bu amalni qaytarib bo'lmaydi. {batch.batchCode} partiyasi va unga tegishli maosh ma'lumotlari o'chiriladi.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
                              <AlertDialogAction 
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                onClick={() => deleteBatch.mutate({ id: batch.id })}
                                data-testid="btn-confirm-delete"
                              >
                                {deleteBatch.isPending ? "O'chirilmoqda..." : "O'chirish"}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          </div>
        </CardContent>
      </Card>
      
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground font-medium">
          {data?.items.length || 0} ta / {data?.total || 0} ta yozuv
        </div>
        <div className="flex gap-2">
          <Button 
            variant="outline" 
            size="sm" 
            disabled={page === 0 || isLoading} 
            onClick={() => setPage(p => Math.max(0, p - 1))}
            data-testid="btn-prev-page"
          >
            Oldingi
          </Button>
          <Button 
            variant="outline" 
            size="sm" 
            disabled={!data || data.items.length < limit || isLoading} 
            onClick={() => setPage(p => p + 1)}
            data-testid="btn-next-page"
          >
            Keyingi
          </Button>
        </div>
      </div>
    </div>
  );
}
