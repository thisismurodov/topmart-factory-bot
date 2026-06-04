import { useGetInventory, getGetInventoryQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Warehouse, TrendingUp, TrendingDown, Package } from "lucide-react";

function StockBadge({ qty, kg }: { qty: number; kg: number }) {
  const value = kg > 0 ? kg : qty;
  if (value <= 0) {
    return <Badge variant="destructive" className="text-xs">Tugagan</Badge>;
  }
  if (value < 50) {
    return <Badge variant="outline" className="text-amber-600 border-amber-300 text-xs">Kam qoldi</Badge>;
  }
  return <Badge className="bg-green-100 text-green-700 border-green-200 text-xs">Yetarli</Badge>;
}

export default function Inventory() {
  const { data: items, isLoading } = useGetInventory({
    query: { queryKey: getGetInventoryQueryKey() },
  });

  const totalProducedKg = items?.reduce((s, i) => s + i.producedKg, 0) ?? 0;
  const totalSoldKg     = items?.reduce((s, i) => s + i.soldKg, 0) ?? 0;
  const totalStockKg    = items?.reduce((s, i) => s + i.stockKg, 0) ?? 0;
  const totalProducedQty = items?.reduce((s, i) => s + i.producedQty, 0) ?? 0;
  const totalSoldQty     = items?.reduce((s, i) => s + i.soldQty, 0) ?? 0;
  const totalStockQty    = items?.reduce((s, i) => s + i.stockQty, 0) ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Ombor holati</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Ishlab chiqarilgan − Sotilgan = Qoldiq
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card className="border-border">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-primary" />
            </div>
            <div>
              <div className="text-xl font-bold">
                {totalProducedKg > 0
                  ? `${totalProducedKg.toFixed(1)} kg`
                  : `${totalProducedQty} dona`}
              </div>
              <div className="text-xs text-muted-foreground">Jami ishlab chiqarilgan</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-red-100 flex items-center justify-center">
              <TrendingDown className="w-5 h-5 text-red-500" />
            </div>
            <div>
              <div className="text-xl font-bold">
                {totalSoldKg > 0
                  ? `${totalSoldKg.toFixed(1)} kg`
                  : `${totalSoldQty} dona`}
              </div>
              <div className="text-xs text-muted-foreground">Jami sotilgan</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-100 flex items-center justify-center">
              <Warehouse className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <div className="text-xl font-bold">
                {totalStockKg > 0
                  ? `${totalStockKg.toFixed(1)} kg`
                  : `${totalStockQty} dona`}
              </div>
              <div className="text-xs text-muted-foreground">Omborda qolgan</div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border-border">
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Mahsulot</TableHead>
                <TableHead className="text-right">Ishlab chiqarilgan</TableHead>
                <TableHead className="text-right">Sotilgan</TableHead>
                <TableHead className="text-right">Omborda</TableHead>
                <TableHead>Holat</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 5 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-5 w-20" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : items?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                    <Package className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    Mahsulot yo'q. Avval mahsulot qo'shing.
                  </TableCell>
                </TableRow>
              ) : (
                items?.map((item) => {
                  const isKg = item.producedKg > 0 || item.soldKg > 0;
                  return (
                    <TableRow key={item.product}>
                      <TableCell className="font-medium">{item.product}</TableCell>
                      <TableCell className="text-right text-sm">
                        {isKg
                          ? `${item.producedKg.toFixed(1)} kg`
                          : `${item.producedQty} dona`}
                      </TableCell>
                      <TableCell className="text-right text-sm text-red-500">
                        {isKg
                          ? `${item.soldKg.toFixed(1)} kg`
                          : `${item.soldQty} dona`}
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        {isKg
                          ? `${item.stockKg.toFixed(1)} kg`
                          : `${item.stockQty} dona`}
                      </TableCell>
                      <TableCell>
                        <StockBadge qty={item.stockQty} kg={item.stockKg} />
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
