import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetMeQueryKey,
  getGetVehicleDistributionPilotWeeklySummaryQueryKey,
  useGetMe,
  useGetVehicleDistributionPilotWeeklySummary,
  type VehicleWeeklyMetric,
  type VehicleWeeklyProduct,
} from "@workspace/api-client-react";
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ClipboardCheck,
  RefreshCw,
  Scale,
  ShieldAlert,
  Tags,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  addCivilDays,
  buildWeeklyCoverage,
  currentTashkentMonday,
  formatCivilDate,
  formatCivilWeekRange,
  isCivilMonday,
} from "./vehicle-weekly-civil";

type ApiFailure = {
  status?: number;
  data?: { error?: string };
  message?: string;
  response?: { status?: number; data?: { error?: string } };
};

function number(value: number) {
  return value.toLocaleString("uz-UZ", { maximumFractionDigits: 3 });
}

function metric(value: VehicleWeeklyMetric) {
  return `${number(value.quantity)} ta · ${number(value.weightKg)} kg`;
}

function statusOf(error: unknown) {
  const failure = error as ApiFailure;
  return failure.status ?? failure.response?.status;
}

function failureMessage(error: unknown) {
  const failure = error as ApiFailure;
  const status = statusOf(error);
  if (status === 401) return "Sessiya tugagan. Qayta kiring va ma’lumotni yangilang.";
  if (status === 403) return "Haftalik tayyorlik faqat administrator uchun.";
  if (status === 404) return "Pilot avto yoki uning haftalik ma’lumoti topilmadi.";
  if (status === 400) return failure.data?.error || failure.response?.data?.error || "Hafta dushanba sanasi bo‘lishi va kelajakda bo‘lmasligi kerak.";
  return failure.data?.error || failure.response?.data?.error || failure.message || "Haftalik ma’lumot yuklanmadi.";
}

function MetricPair({ title, value, testId }: { title: string; value: VehicleWeeklyMetric; testId: string }) {
  return (
    <div className="min-w-0 rounded-md bg-slate-50 p-2.5">
      <span className="block text-[11px] font-medium text-slate-500">{title}</span>
      <strong data-testid={testId} className="mt-0.5 block break-words text-sm text-slate-800">{metric(value)}</strong>
    </div>
  );
}

function Variance({ value, indeterminate, testId }: {
  value: VehicleWeeklyMetric | null;
  indeterminate?: boolean;
  testId: string;
}) {
  if (indeterminate || !value) {
    return (
      <Badge data-testid={testId} variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
        <AlertCircle className="mr-1 h-3.5 w-3.5" /> Aniqlanmagan
      </Badge>
    );
  }
  const clean = value.quantity === 0 && value.weightKg === 0;
  return (
    <Badge
      data-testid={testId}
      variant="outline"
      className={clean
        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
        : "border-red-200 bg-red-50 text-red-700"}
    >
      {metric(value)}
    </Badge>
  );
}

function ProductCard({ product }: { product: VehicleWeeklyProduct }) {
  return (
    <Card data-testid={`card-weekly-product-${product.publicProductId}`} className="min-w-0">
      <CardContent className="space-y-3 p-4">
        <div className="min-w-0">
          <p className="break-words font-semibold text-slate-800">{product.productName}</p>
          <p className="break-all font-mono text-xs text-slate-500">{product.sku}</p>
        </div>
        {product.indeterminate && (
          <div data-testid={`status-indeterminate-${product.publicProductId}`} role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-2.5 text-sm text-amber-900">
            <strong>Aniqlanmagan:</strong> qabul qilingan, ammo omborga hali o‘tkazilmagan qaytarish bandi {metric(product.handedBackReserved)}.
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <MetricPair title="Ochilish: inventar" value={product.inventoryOpening} testId={`text-inventory-opening-${product.publicProductId}`} />
          <MetricPair title="Ochilish: aniq yorliq" value={product.expectedOpening} testId={`text-label-opening-${product.publicProductId}`} />
          <MetricPair title="Yuk / savdo / qaytarish (sof)" value={product.eventNet} testId={`text-event-net-${product.publicProductId}`} />
          <MetricPair title="Ombor harakati (sof)" value={product.movementNet} testId={`text-movement-net-${product.publicProductId}`} />
          <MetricPair title="Joriy inventar" value={product.inventoryCurrent} testId={`text-inventory-current-${product.publicProductId}`} />
          <MetricPair title="Joriy aniq yorliqlar" value={product.expectedCurrent} testId={`text-label-current-${product.publicProductId}`} />
        </div>
        <div className="grid gap-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-slate-500">Inventar ↔ yorliq farqi</span>
            <Variance value={product.claimInventoryVariance} indeterminate={product.indeterminate} testId={`status-claim-variance-${product.publicProductId}`} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-slate-500">Hodisa ↔ harakat farqi</span>
            <Variance value={product.movementEventVariance} testId={`status-flow-variance-${product.publicProductId}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const blockerLabels: Record<string, string> = {
  coverage: "F6 kunlik qamrov",
  identity_mapping: "Mahsulot identifikatsiyasi",
  current_variance: "Joriy inventar farqi",
  event_movement_variance: "Hodisa va ombor harakati farqi",
  handoffs: "Ochiq topshirishlar",
  replenishments: "Ochiq to‘ldirishlar",
  returns: "Ochiq qaytarishlar",
  labels: "Ochiq yorliqlar",
};

function blockerSeverity(type: string) {
  return ["identity_mapping", "current_variance", "event_movement_variance", "coverage"].includes(type)
    ? { label: "Jiddiy", className: "border-red-200 bg-red-50 text-red-700" }
    : { label: "Ogohlantirish", className: "border-amber-200 bg-amber-50 text-amber-700" };
}

export function VehicleWeeklyReadiness({ active }: { active: boolean }) {
  const queryClient = useQueryClient();
  const monday = useMemo(currentTashkentMonday, []);
  const [weekStart, setWeekStart] = useState(monday);
  const [selectorError, setSelectorError] = useState("");
  const me = useGetMe({ query: { enabled: active, queryKey: getGetMeQueryKey(), retry: false } });
  const isAdmin = me.data?.role === "admin";
  const params = { weekStart };
  const summary = useGetVehicleDistributionPilotWeeklySummary(params, { query: {
    enabled: active && isAdmin && isCivilMonday(weekStart) && weekStart <= monday,
    queryKey: getGetVehicleDistributionPilotWeeklySummaryQueryKey(params),
    retry: false,
  } });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetVehicleDistributionPilotWeeklySummaryQueryKey(params) });
  };
  const chooseWeek = (value: string) => {
    if (!isCivilMonday(value) || value > monday) {
      setSelectorError(value > monday ? "Kelajak haftasini tanlab bo‘lmaydi." : "Faqat dushanba sanasini tanlang.");
      return;
    }
    setSelectorError("");
    setWeekStart(value);
  };

  if (!active) return null;
  if (me.isLoading) {
    return <div aria-label="Haftalik ruxsat tekshirilmoqda" className="space-y-3 p-4"><Skeleton className="h-20 w-full" /><Skeleton className="h-32 w-full" /></div>;
  }
  if (me.error) {
    return (
      <div data-testid="status-weekly-auth-error" role="alert" className="m-4 rounded-md border border-red-200 bg-red-50 p-6 text-center text-red-800">
        <AlertCircle className="mx-auto mb-2 h-8 w-8" />
        <p className="font-semibold">Ruxsat tekshirilmadi</p>
        <p className="mt-1 text-sm">{failureMessage(me.error)}</p>
        <Button data-testid="button-retry-weekly-auth" variant="outline" className="mt-4 min-h-11" onClick={refresh}>Qayta yuklash</Button>
      </div>
    );
  }
  if (!isAdmin) {
    return (
      <div data-testid="status-weekly-admin-only" role="status" className="m-4 rounded-md border border-amber-200 bg-amber-50 p-6 text-center text-amber-900">
        <ShieldAlert className="mx-auto mb-2 h-8 w-8" />
        <p className="font-semibold">Haftalik tayyorlik faqat administrator uchun</p>
        <p className="mt-1 text-sm">F10 diagnostika ma’lumotlari sizga ko‘rsatilmaydi.</p>
      </div>
    );
  }

  const data = summary.data;
  const coverage = data
    ? buildWeeklyCoverage(
        weekStart,
        data.week.requiredThroughDate,
        data.days,
      )
    : [];

  return (
    <div className="min-w-0">
      <div className="space-y-4 border-b bg-white p-4 sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 font-semibold text-slate-800"><ClipboardCheck className="h-5 w-5 text-cyan-700" /> Haftalik tayyorlik (F10)</h3>
            <p className="mt-1 text-sm text-slate-500">Pilot avto bo‘yicha operatsion solishtirish va yopishga tayyorlik nazorati.</p>
          </div>
          <Button data-testid="button-refresh-weekly" variant="outline" className="min-h-11 shrink-0 self-start" onClick={refresh} disabled={summary.isFetching}>
            <RefreshCw className={`mr-2 h-4 w-4 ${summary.isFetching ? "animate-spin" : ""}`} /> Yangilash
          </Button>
        </div>
        <div data-testid="status-weekly-diagnostic-warning" role="note" className="flex gap-3 rounded-md border-2 border-amber-300 bg-amber-50 p-3 text-amber-950">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
          <p className="text-sm"><strong>Diagnostik pilot tayyorligi — buxgalteriya tasdig‘i emas.</strong> “Tayyor” holati ham hisobni yopish, moliyaviy tasdiq yoki joriy zaxirani sertifikatlash vakolatini bermaydi.</p>
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 sm:max-w-xs">
            <Label htmlFor="weekly-start">Hafta dushanbasi</Label>
            <Input
              id="weekly-start"
              data-testid="input-weekly-start"
              type="date"
              max={monday}
              value={weekStart}
              className="mt-1 min-h-11"
              onChange={(event) => chooseWeek(event.target.value)}
              aria-describedby={selectorError ? "weekly-selector-error" : undefined}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button data-testid="button-previous-week" variant="outline" className="min-h-11" onClick={() => chooseWeek(addCivilDays(weekStart, -7))}>
              <ChevronLeft className="mr-1 h-4 w-4" /> Oldingi
            </Button>
            <Button data-testid="button-current-week" variant="outline" className="min-h-11" disabled={weekStart === monday} onClick={() => chooseWeek(monday)}>
              <CalendarDays className="mr-1 h-4 w-4" /> Joriy
            </Button>
          </div>
        </div>
        {selectorError && <p id="weekly-selector-error" data-testid="status-weekly-selector-error" role="alert" className="text-sm text-red-600">{selectorError}</p>}
      </div>

      {summary.isLoading && !data ? (
        <div aria-label="Haftalik ma’lumot yuklanmoqda" className="space-y-3 p-4 sm:p-5">{[1, 2, 3, 4].map((item) => <Skeleton key={item} className="h-24 w-full" />)}</div>
      ) : summary.error ? (
        <div data-testid="status-weekly-error" role="alert" className="m-4 rounded-md border border-red-200 bg-red-50 p-7 text-center text-red-800">
          <AlertCircle className="mx-auto mb-2 h-8 w-8" />
          <p className="font-semibold">Haftalik ma’lumot yuklanmadi</p>
          <p className="mt-1 text-sm">{failureMessage(summary.error)}</p>
          <Button data-testid="button-retry-weekly" variant="outline" className="mt-4 min-h-11" onClick={refresh}>Qayta yuklash</Button>
        </div>
      ) : data && (
        <div className="min-w-0 space-y-6 p-4 sm:p-5">
          <section
            data-testid="status-weekly-readiness"
            role="status"
            className={`flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between ${data.readiness ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"}`}
          >
            <div className="flex items-start gap-3">
              {data.readiness ? <CheckCircle2 className="h-7 w-7 shrink-0 text-emerald-600" /> : <XCircle className="h-7 w-7 shrink-0 text-red-600" />}
              <div>
                <p className={`text-lg font-bold ${data.readiness ? "text-emerald-800" : "text-red-800"}`}>{data.readiness ? "Yopishga tayyor" : "Yopishga tayyor emas"}</p>
                <p className="text-sm text-slate-600">{formatCivilWeekRange(data.week.weekStart, data.week.weekEndExclusive)}</p>
              </div>
            </div>
            <Badge data-testid="text-weekly-reason-count" variant="outline" className="w-fit bg-white text-sm">{data.reasons.length} sabab · {data.kpis.blockerCount} to‘siq</Badge>
          </section>

          <section aria-label="Haftalik asosiy ko‘rsatkichlar" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card><CardContent className="p-3 sm:p-4"><Scale className="mb-2 h-5 w-5 text-indigo-600" /><span className="text-xs text-slate-500">Joriy avto zaxirasi</span><strong data-testid="text-weekly-current-stock" className="mt-1 block break-words">{metric(data.kpis.inventoryCurrent)}</strong></CardContent></Card>
            <Card><CardContent className="p-3 sm:p-4"><Tags className="mb-2 h-5 w-5 text-cyan-700" /><span className="text-xs text-slate-500">Hafta: yuk / savdo / qaytarish</span><strong data-testid="text-weekly-event-net" className="mt-1 block break-words">{metric(data.kpis.eventNet)} sof</strong></CardContent></Card>
            <Card><CardContent className="p-3 sm:p-4"><ShieldAlert className="mb-2 h-5 w-5 text-red-600" /><span className="text-xs text-slate-500">To‘siqlar</span><strong data-testid="text-weekly-blockers" className="mt-1 block text-xl">{data.kpis.blockerCount}</strong></CardContent></Card>
            <Card><CardContent className="p-3 sm:p-4"><ClipboardCheck className="mb-2 h-5 w-5 text-emerald-600" /><span className="text-xs text-slate-500">F6 qamrovi</span><strong data-testid="text-weekly-f6-coverage" className="mt-1 block text-xl">{data.kpis.appliedDays}/{data.kpis.requiredDays}</strong></CardContent></Card>
          </section>

          <section aria-labelledby="weekly-products-title">
            <h4 id="weekly-products-title" className="font-semibold text-slate-800">Mahsulotlar solishtiruvi</h4>
            <p className="mb-3 mt-1 text-sm text-slate-500">Yuk, savdo va qaytarish hodisalari kontraktda sof hodisa oqimi sifatida beriladi. Farqlar miqdor va vaznni birga ko‘rsatadi.</p>
            {!data.products.length ? (
              <div data-testid="status-weekly-no-products" className="rounded-md border border-dashed p-8 text-center text-sm text-slate-500">Ushbu haftada solishtiriladigan mahsulot yo‘q.</div>
            ) : (
              <>
                <div className="grid min-w-0 gap-3 md:hidden">{data.products.map((product) => <ProductCard key={product.publicProductId} product={product} />)}</div>
                <div className="hidden overflow-x-auto rounded-md border md:block">
                  <Table className="min-w-[1100px]">
                    <TableHeader className="bg-slate-50"><TableRow><TableHead>Mahsulot</TableHead><TableHead>Ochilish inventar / yorliq</TableHead><TableHead>Yuk / savdo / qaytarish / harakat (sof)</TableHead><TableHead>Joriy inventar / aniq yorliq</TableHead><TableHead>Inventar ↔ yorliq farqi</TableHead><TableHead>Hodisa ↔ harakat farqi</TableHead></TableRow></TableHeader>
                    <TableBody>{data.products.map((product) => (
                      <TableRow key={product.publicProductId} data-testid={`row-weekly-product-${product.publicProductId}`}>
                        <TableCell><p className="font-medium">{product.productName}</p><p className="font-mono text-xs text-slate-500">{product.sku}</p>{product.indeterminate && <Badge variant="outline" className="mt-2 border-amber-300 bg-amber-50 text-amber-800">Aniqlanmagan · band {metric(product.handedBackReserved)}</Badge>}</TableCell>
                        <TableCell className="text-xs"><p>{metric(product.inventoryOpening)}</p><p className="mt-1 text-slate-500">{metric(product.expectedOpening)}</p></TableCell>
                        <TableCell className="text-xs"><p>{metric(product.eventNet)}</p><p className="mt-1 text-slate-500">{metric(product.movementNet)}</p></TableCell>
                        <TableCell className="text-xs"><p>{metric(product.inventoryCurrent)}</p><p className="mt-1 text-slate-500">{metric(product.expectedCurrent)}</p></TableCell>
                        <TableCell><Variance value={product.claimInventoryVariance} indeterminate={product.indeterminate} testId={`status-table-claim-variance-${product.publicProductId}`} /></TableCell>
                        <TableCell><Variance value={product.movementEventVariance} testId={`status-table-flow-variance-${product.publicProductId}`} /></TableCell>
                      </TableRow>
                    ))}</TableBody>
                  </Table>
                </div>
              </>
            )}
          </section>

          <section aria-labelledby="weekly-coverage-title">
            <h4 id="weekly-coverage-title" className="font-semibold text-slate-800">7 kunlik F6 qamrovi</h4>
            <p className="mb-3 mt-1 text-sm text-slate-500">Kelajak kunlari talab qilinmaydi. “Qo‘llangan” holat joriy zaxira to‘g‘riligini sertifikatlamaydi.</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {coverage.map(({ date, day, futureNotRequired }) => {
                const good = day?.status === "applied" && day.allCounted && day.discrepancyCount === 0;
                const label = futureNotRequired ? "Talab qilinmaydi" : good ? "Qo‘llangan" : day?.missing ? "Yo‘q" : day?.status || "Yo‘q";
                return (
                  <Card key={date} data-testid={`card-weekly-day-${date}`} className={good ? "border-emerald-200" : futureNotRequired ? "border-slate-200 bg-slate-50" : "border-red-200"}>
                    <CardContent className="p-3">
                      <span className="block text-xs text-slate-500">{formatCivilDate(date)}</span>
                      <Badge variant="outline" className={`mt-2 max-w-full ${good ? "border-emerald-200 bg-emerald-50 text-emerald-700" : futureNotRequired ? "border-slate-200 bg-white text-slate-600" : "border-red-200 bg-red-50 text-red-700"}`}>{label}</Badge>
                      {day && <span className="mt-2 block text-xs text-slate-500">{day.allCounted ? "To‘liq sanalgan" : "To‘liq sanalmagan"} · {day.discrepancyCount} farq</span>}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>

          <section aria-labelledby="weekly-blockers-title">
            <h4 id="weekly-blockers-title" className="font-semibold text-slate-800">To‘siqlar</h4>
            {!data.blockers.length ? (
              <div data-testid="status-weekly-no-blockers" className="mt-3 flex items-center gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-emerald-800">
                <CheckCircle2 className="h-5 w-5 shrink-0" /><span className="font-medium">Ochiq to‘siqlar yo‘q — diagnostik tayyorlik toza.</span>
              </div>
            ) : (
              <div className="mt-3 grid gap-3">
                {data.blockers.map((blocker) => {
                  const severity = blockerSeverity(blocker.type);
                  return (
                    <Card key={blocker.type} data-testid={`card-weekly-blocker-${blocker.type}`}>
                      <CardContent className="p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-semibold text-slate-800">{blockerLabels[blocker.type] || blocker.type}</p>
                          <div className="flex gap-2"><Badge variant="outline" className={severity.className}>{severity.label}</Badge><Badge variant="secondary">{blocker.totalCount} ta</Badge></div>
                        </div>
                        <ul className="mt-3 space-y-2 text-sm">{blocker.details.map((detail) => (
                          <li key={detail.id} className="min-w-0 rounded-md bg-slate-50 p-3">
                            <div className="flex flex-wrap gap-x-2"><span className="break-all font-mono text-xs font-semibold">{detail.id}</span><Badge variant="outline" className="h-5 text-[10px]">{detail.status}</Badge></div>
                            <p className="mt-1 break-words text-slate-600">{detail.message}</p>
                          </li>
                        ))}</ul>
                        {blocker.truncated && <p className="mt-2 text-xs text-amber-700">Faqat dastlabki {blocker.details.length} tafsilot ko‘rsatildi.</p>}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}