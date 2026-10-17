import { useEffect, useId, useRef, useState } from "react";
import {
  useGetVehicleDistributionPilotMovements,
  getGetVehicleDistributionPilotMovementsQueryKey,
  type VehicleDistributionPilotStock,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { AlertCircle, ChevronLeft, Info, MapPin, Package, RefreshCw, ShoppingCart, X } from "lucide-react";
import { DamasIllustration } from "./DamasIllustration";
import { formatDateTime, formatQty, isSaleMovement, formatStockPrimary, formatLoadedPackages, formatMoney, sumByCurrency, type StockItemValueFields } from "./vehicle-stock-helpers";

function CurrencyTotals({ items, field, testId }: { items: StockItemValueFields[]; field: "costValue" | "retailValue"; testId: string }) {
  const { totals, unknown } = sumByCurrency(items, field);
  const entries = Object.entries(totals);
  if (entries.length === 0) return <Unavailable reason={MONEY_UNAVAILABLE} testId={testId} />;
  return (
    <span className="inline-flex flex-col" data-testid={testId}>
      {entries.map(([cur, v]) => <span key={cur}>{v.toLocaleString("uz-UZ", { maximumFractionDigits: 2 })} <span className="text-xs font-medium text-slate-500">{cur}</span></span>)}
      {unknown > 0 && <span className="text-[10px] font-normal leading-tight text-slate-400">{unknown} ta mahsulot noma’lum</span>}
    </span>
  );
}

const MONEY_UNAVAILABLE = "Summa ma’lumoti mavjud emas";
const LOADED_UNAVAILABLE = "Jami yuklangan miqdor mavjud emas";
const SOLD_UNAVAILABLE = "Jami sotuv ma’lumoti mavjud emas";

function Unavailable({ reason, testId }: { reason: string; testId: string }) {
  return (
    <span className="inline-flex flex-col" data-testid={testId}>
      <span className="font-semibold text-slate-400" aria-hidden="true">—</span>
      <span className="text-[10px] leading-tight text-slate-400">{reason}</span>
    </span>
  );
}

function SummaryTile({ label, children, testId }: { label: string; children: React.ReactNode; testId: string }) {
  return (
    <div className="rounded-xl border border-[#dfe7e1] bg-white px-3 py-2.5" data-testid={testId}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#5b7266]">{label}</div>
      <div className="mt-1 text-base font-bold text-[#0f2a1e] tabular-nums">{children}</div>
    </div>
  );
}

function RecentSales({ enabled }: { enabled: boolean }) {
  const params = { limit: 50 };
  const { data, isLoading, isError } = useGetVehicleDistributionPilotMovements(params, {
    query: { enabled, queryKey: getGetVehicleDistributionPilotMovementsQueryKey(params) },
  });
  const sales = (data?.items ?? []).filter((m) => isSaleMovement(m.movementType));

  return (
    <section aria-labelledby="sold-heading" className="rounded-xl border border-rose-200 bg-rose-50/50 p-3">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-rose-600 text-white">
          <ShoppingCart className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <h4 id="sold-heading" className="text-xs font-bold uppercase tracking-[0.14em] text-rose-800">Sotilgan tovarlar</h4>
      </div>
      <p className="mt-1.5 text-[11px] text-rose-900/70">
        Oxirgi 50 ta harakat ichidagi sotuv yozuvlari. Bu jami sotuv emas — {SOLD_UNAVAILABLE.toLowerCase()}.
      </p>
      <div className="mt-2 space-y-1.5">
        {isLoading ? (
          <Skeleton className="h-8 w-full" />
        ) : isError ? (
          <p className="text-xs text-rose-700">Harakatlarni yuklab bo'lmadi.</p>
        ) : sales.length === 0 ? (
          <p className="text-xs text-slate-500" data-testid="text-no-sales">So'nggi harakatlarda sotuv yozuvi topilmadi.</p>
        ) : (
          sales.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 text-xs" data-testid={`row-sale-${m.id}`}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-rose-500" aria-hidden="true" />
                <span className="truncate font-medium text-slate-800">{m.product}</span>
              </span>
              <span className="shrink-0 tabular-nums text-slate-600">
                {formatQty(m.quantity)} dona · <span className="text-slate-400">{formatDateTime(m.createdAt)}</span>
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export function VehicleWarehouseHero({
  stock, isLoading, isFetching, onRefresh, active,
}: {
  stock: VehicleDistributionPilotStock | undefined;
  isLoading: boolean;
  isFetching: boolean;
  onRefresh: () => void;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) closeRef.current?.focus({ preventScroll: true });
    else if (wasOpen.current) triggerRef.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const boot = !!stock?.bootstrapped;
  const plate = boot ? stock?.vehicle?.plateNumber ?? "—" : "—";
  const items = boot ? stock?.items ?? [] : [];
  const valueItems = items as Array<(typeof items)[number] & StockItemValueFields>;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-[#d6e2da] bg-[#f4f7f3] shadow-[0_1px_2px_rgba(15,42,30,0.06),0_8px_24px_-12px_rgba(15,42,30,0.18)]">
      {/* subtle floor grid */}
      <div className="pointer-events-none absolute inset-0 opacity-[0.5] [background-image:linear-gradient(#e3ebe5_1px,transparent_1px),linear-gradient(90deg,#e3ebe5_1px,transparent_1px)] [background-size:32px_32px] [mask-image:linear-gradient(to_bottom,transparent,black_60%)]" aria-hidden="true" />

      <div className="absolute right-3 top-3 z-20 flex items-center gap-2">
        <Button
          variant="outline" size="icon"
          className="h-8 w-8 rounded-full border-[#cfdcd3] bg-white/90 text-[#14532d] hover:bg-white"
          onClick={onRefresh} disabled={isFetching} title="Yangilash" aria-label="Yangilash"
          data-testid="button-refresh-vehicle-stock"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin motion-reduce:animate-none" : ""}`} />
        </Button>
      </div>

      <div className="relative flex flex-col lg:block lg:h-[480px]">
        {/* Vehicle stage */}
        <div
          className={`relative z-10 w-full lg:absolute lg:inset-y-0 lg:left-0 lg:w-[40%] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
            open ? "lg:translate-x-0" : "lg:translate-x-[75%]"
          }`}
        >
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={panelId}
            data-testid="button-toggle-vehicle-panel"
            className="group flex h-full w-full flex-col items-center justify-center gap-2 px-6 pb-6 pt-10 text-center outline-none focus-visible:ring-2 focus-visible:ring-[#facc15] focus-visible:ring-offset-2 focus-visible:ring-offset-[#f4f7f3] rounded-2xl"
          >
            <span className="text-[11px] font-bold uppercase tracking-[0.28em] text-[#3f6b55]">Chevrolet Damas</span>
            <span className="text-2xl font-black tracking-tight text-[#0f2a1e] sm:text-3xl" data-testid="text-vehicle-plate">{plate}</span>
            <span className="text-sm text-[#4d6a5b]">Mashina ombori</span>
            <DamasIllustration
              plate={boot ? plate : undefined}
              className="mt-3 w-full max-w-[220px] sm:max-w-[300px] lg:max-w-[340px] transition-transform duration-300 group-hover:-translate-y-1 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0"
            />
            <span className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-[#4d6a5b]">
              {boot && stock?.warehouse && (
                <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" aria-hidden="true" />{stock.warehouse.name}</span>
              )}
              {boot && stock?.vehicle?.status && (
                <span className="rounded-full border border-[#cfdcd3] bg-white px-2 py-0.5 font-medium text-[#14532d]">{stock.vehicle.status}</span>
              )}
              {!boot && !isLoading && (
                <span className="inline-flex items-center gap-1 text-amber-700"><AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />Boshlang'ich holat o'rnatilmagan</span>
              )}
            </span>
            <span className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${open ? "bg-white text-[#14532d] border border-[#cfdcd3]" : "bg-[#14532d] text-white group-hover:bg-[#0f3f22]"}`}>
              {open ? <><ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />Panelni yopish</> : <>Ichini ko'rish <span className="h-1.5 w-1.5 rounded-full bg-[#facc15]" aria-hidden="true" /></>}
            </span>
          </button>
        </div>

        {/* Stock panel */}
        <section
          id={panelId}
          aria-label={`${plate} — Mashina ombori`}
          aria-hidden={!open}
          inert={!open ? true : undefined}
          className={`relative z-10 px-3 pb-3 lg:absolute lg:inset-y-0 lg:right-0 lg:w-[60%] lg:py-3 lg:pl-0 transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
            open ? "opacity-100 translate-x-0" : "hidden lg:block opacity-0 lg:translate-x-8 pointer-events-none"
          }`}
          data-testid="panel-vehicle-stock"
        >
          <div className="flex h-full flex-col rounded-xl border border-[#dfe7e1] bg-[#fbfcfa] shadow-sm">
            <header className="flex items-start justify-between gap-3 border-b border-[#e6ede8] px-4 py-3">
              <div>
                <h3 className="text-base font-bold text-[#0f2a1e]">{plate} — Mashina ombori</h3>
                <p className="text-xs text-[#5b7266]">Joriy qoldiq · oxirgi yuklangan ma’lumotlar</p>
              </div>
              <Button ref={closeRef} variant="ghost" size="icon" className="h-8 w-8 rounded-full text-[#14532d]" onClick={() => setOpen(false)} aria-label="Panelni yopish" data-testid="button-close-vehicle-panel">
                <X className="h-4 w-4" />
              </Button>
            </header>

            <div className="flex-1 space-y-3 overflow-y-auto p-4 lg:min-h-0">
              {isLoading ? (
                <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                    <SummaryTile label="Jami mahsulotlar" testId="stat-sku-count">{formatQty(boot ? stock?.skuCount : 0)}</SummaryTile>
                    <SummaryTile label="Jami dona" testId="stat-total-qty">{formatQty(boot ? stock?.totalQuantity : 0)}</SummaryTile>
                    <SummaryTile label="Jami kg" testId="stat-total-kg">{formatQty(boot ? stock?.totalWeightKg : 0)}</SummaryTile>
                    <SummaryTile label="Tannarx" testId="stat-total-cost"><CurrencyTotals items={valueItems} field="costValue" testId="text-total-cost" /></SummaryTile>
                    <SummaryTile label="Sotuv qiymati" testId="stat-total-retail"><CurrencyTotals items={valueItems} field="retailValue" testId="text-total-retail" /></SummaryTile>
                  </div>

                  <div className="grid grid-cols-3 overflow-hidden rounded-xl border border-[#dfe7e1] bg-white text-center" data-testid="flow-loaded-sold-remaining">
                    <div className="px-2 py-2.5">
                      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Berilgan</div>
                      <div className="mt-1 flex justify-center"><Unavailable reason={LOADED_UNAVAILABLE} testId="text-loaded-unavailable" /></div>
                    </div>
                    <div className="border-x border-[#e6ede8] bg-rose-50/40 px-2 py-2.5">
                      <div className="flex items-center justify-center gap-1 text-[10px] font-bold uppercase tracking-[0.12em] text-rose-700"><span className="h-1.5 w-1.5 rounded-full bg-rose-500" aria-hidden="true" />Sotilgan</div>
                      <div className="mt-1 flex justify-center"><Unavailable reason={SOLD_UNAVAILABLE} testId="text-sold-unavailable" /></div>
                    </div>
                    <div className="bg-emerald-50/50 px-2 py-2.5">
                      <div className="flex items-center justify-center gap-1 text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-800"><span className="h-1.5 w-1.5 rounded-full bg-emerald-600" aria-hidden="true" />Qolgan</div>
                      <div className="mt-1 text-base font-bold tabular-nums text-[#0f2a1e]" data-testid="text-remaining-qty">{formatQty(boot ? stock?.totalQuantity : 0)} <span className="text-xs font-medium text-slate-500">dona</span></div>
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <h4 className="text-xs font-bold uppercase tracking-[0.14em] text-[#14532d]">Mavjud mahsulotlar</h4>
                      <span className="text-[11px] text-slate-500">{items.length} ta</span>
                    </div>
                    {items.length === 0 ? (
                      <div className="flex flex-col items-center rounded-xl border border-dashed border-[#cfdcd3] py-8 text-slate-500">
                        <Package className="mb-2 h-7 w-7 opacity-40" aria-hidden="true" />
                        <p className="text-sm">Avto omborda mahsulotlar yo'q</p>
                      </div>
                    ) : (
                      <ul className="space-y-1.5">
                        {valueItems.map((item, idx) => { const pk = formatLoadedPackages(item); return (
                          <li key={`${item.product}-${idx}`} className="flex items-center gap-3 rounded-xl border border-[#e6ede8] bg-white px-3 py-2" data-testid={`card-vehicle-product-${idx}`}>
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#e8f0ea] text-sm font-bold text-[#14532d]" aria-hidden="true">
                              {(item.productName || item.product).trim().charAt(0).toUpperCase()}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-semibold text-slate-800">{item.productName || item.product}</div>
                              <div className="truncate font-mono text-[11px] text-slate-500">{item.productSku || item.product} · dona / kg</div>
                            </div>
                            <div className="shrink-0 text-right">
                              <div className="flex items-center justify-end gap-1 text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" aria-hidden="true" />Mavjud
                              </div>
                              <div className="text-sm font-bold tabular-nums text-[#0f2a1e]">{formatStockPrimary(item)}</div>
                              {pk ? <div className="text-[11px] tabular-nums text-slate-500" title="Tarixiy yuklangan qadoqlar, qoldiq emas">{pk}</div> : <div className="text-[11px] tabular-nums text-slate-500">{formatQty(item.weightKg)} kg</div>}
                            </div>
                            <div className="hidden w-32 shrink-0 text-right sm:block">
                              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Tannarx</div>
                              <div className="text-xs tabular-nums text-slate-600">{formatMoney(item.costValue, item.currency)}</div>
                              <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">Sotuv qiymati</div>
                              <div className="text-xs font-semibold tabular-nums text-slate-800">{formatMoney(item.retailValue, item.currency)}</div>
                            </div>
                          </li>
                        ); })}
                      </ul>
                    )}
                  </div>

                  {boot && <RecentSales enabled={active && open} />}

                  <p className="flex items-start gap-1.5 text-[11px] text-slate-500">
                    <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                    Qiymatlar joriy katalog narxlari bo‘yicha, har bir valyutada alohida jamlanadi; noma’lum qiymatlar nol deb hisoblanmaydi. Yuklangan qadoqlar — topshirish tarixi, qolgan qadoqlar soni emas.
                  </p>
                </>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
