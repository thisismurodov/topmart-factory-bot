import { useQuery } from "@tanstack/react-query";
import { authFetch } from "@/App";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Warehouse, Activity, AlertCircle, ReceiptText } from "lucide-react";

// --- Types ---
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
  externalProfit: {
    method: "FIFO";
    currency: "UZS";
    revenue: number;
    costedRevenue: number;
    uncostedRevenue: number;
    cogs: number;
    profit: number;
    products: {
      productId: number;
      productName: string;
      unit: string;
      soldQuantity: number;
      costedQuantity: number;
      uncostedQuantity: number;
      revenue: number;
      costedRevenue: number;
      uncostedRevenue: number;
      cogs: number;
      profit: number;
    }[];
  };
};

function formatAmount(value: number, currency: string): string {
  return `${value.toLocaleString("uz-UZ", { maximumFractionDigits: 2 })} ${currency}`;
}

// --- Local Hooks ---
function useGetTopMartOverview() {
  return useQuery<TopMartOverviewResponse>({
    queryKey: ["topmart-overview"],
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
  const { data: overview, isLoading: isLoadingOverview, error: overviewError } = useGetTopMartOverview();

  if (!active) return null;

  return (
    <div className="p-4 space-y-6">
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
                  <div className="text-sm text-muted-foreground">Diyor Mahsulotlari Xarid Hisobi</div>
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
              <CardTitle className="text-lg">Tashqi mahsulotlar foydasi</CardTitle>
              <CardDescription>
                Yetkazib beruvchi kirimlari FIFO usulida savdolarga biriktiriladi. Faqat Top Mart tashqi mahsulotlari; Diyor zavod hisobi o‘zgarmaydi.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-3 mb-4">
                <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">Savdo</div><div className="font-semibold">{formatAmount(overview.externalProfit.revenue, "UZS")}</div></div>
                <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">Tannarx</div><div className="font-semibold">{formatAmount(overview.externalProfit.cogs, "UZS")}</div></div>
                <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">Hisoblangan foyda</div><div className={overview.externalProfit.profit >= 0 ? "font-semibold text-emerald-700" : "font-semibold text-red-600"}>{formatAmount(overview.externalProfit.profit, "UZS")}</div>{overview.externalProfit.uncostedRevenue > 0 && <div className="text-xs text-amber-700 mt-1">{formatAmount(overview.externalProfit.uncostedRevenue, "UZS")} savdo tannarxi hali noma’lum</div>}</div>
              </div>
              {overview.externalProfit.products.length === 0 ? (
                <div className="rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">Tashqi mahsulot savdosi hali yo‘q.</div>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-muted-foreground"><tr><th className="px-3 py-2 text-left">Mahsulot</th><th className="px-3 py-2 text-right">Sotildi</th><th className="px-3 py-2 text-right">Tannarx</th><th className="px-3 py-2 text-right">Foyda</th></tr></thead>
                    <tbody className="divide-y">{overview.externalProfit.products.map((item) => (
                      <tr key={item.productId}>
                        <td className="px-3 py-2"><div className="font-medium">{item.productName}</div>{item.uncostedQuantity > 0 && <div className="text-xs text-amber-700">{item.uncostedQuantity.toLocaleString("uz-UZ")} {item.unit} uchun kirim tannarxi yetishmaydi</div>}</td>
                        <td className="px-3 py-2 text-right">{item.soldQuantity.toLocaleString("uz-UZ")} {item.unit}</td>
                        <td className="px-3 py-2 text-right">{formatAmount(item.cogs, "UZS")}</td>
                        <td className={item.profit >= 0 ? "px-3 py-2 text-right font-medium text-emerald-700" : "px-3 py-2 text-right font-medium text-red-600"}>{formatAmount(item.profit, "UZS")}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {overview && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">C-3 mahsulot qoldig‘i</CardTitle>
              <CardDescription>
                Diyor Mahsulotlari zavodidan Top Mart distributsiyasiga o'tgan markaziy zaxira
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
      </div>
    </div>
  );
}
