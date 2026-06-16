import { useState } from "react";
import { authFetch } from "@/App";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useGetPayrollRoleRates, getGetPayrollRoleRatesQueryKey, useUpdatePayrollRoleRate,
  useGetPayrollWorkerEarnings, getGetPayrollWorkerEarningsQueryKey,
  useGetPayrollDayStatus, getGetPayrollDayStatusQueryKey,
  useGetWorkers, getGetWorkersQueryKey,
  useGetProducts, getGetProductsQueryKey,
  useCreateProductionLine,
  useDeleteProductionLine,
  useAddProductionLineWorker,
  useRemoveProductionLineWorker,
  useClosePayrollDay,
} from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatNumber, formatDate } from "@/lib/format";
import {
  Lock, LockOpen, Save, Plus, Trash2, Weight, UserPlus, Factory,
  AlertTriangle, Hammer, Boxes, PackageCheck,
} from "lucide-react";

const ROLE_UZ: Record<string, string> = {
  producer: "Ishlab chiqaruvchi",
  preparation: "Tayyorlash",
  packaging: "Qadoqlash",
  packer: "Qadoqlash",
};
// Roles shown in the rate editor (the ones that drive pay).
const RATE_ROLES = ["producer", "preparation", "packaging"];
const ROLE_LIMITS: Record<string, { min: number; max: number }> = {
  producer: { min: 1, max: 5 },
  preparation: { min: 1, max: 3 },
  packaging: { min: 1, max: 5 },
};

const METHOD_UZ: Record<string, string> = {
  PRODUCT_RATE: "Dona (mahsulot stavkasi)",
  ROLE_BASED_KG: "Kg (rol asosida)",
};

function roleLabel(role: string): string {
  return ROLE_UZ[role] ?? role;
}

function errMsg(e: unknown, fallback: string): string {
  const data = (e as { data?: { error?: string } } | null)?.data;
  if (data && typeof data.error === "string" && data.error.trim()) return data.error;
  return fallback;
}

// ── Role rate row (own input state) ─────────────────────────────────────────────
function RoleRateRow({ role, rate, updatedAt }: { role: string; rate: number; updatedAt: string | null }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [value, setValue] = useState<string>(String(rate));
  const changed = Number(value) !== rate && value.trim() !== "";

  const update = useUpdatePayrollRoleRate({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetPayrollRoleRatesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetPayrollDayStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetPayrollWorkerEarningsQueryKey() });
        toast({ title: "Saqlandi", description: `${roleLabel(role)} stavkasi yangilandi.` });
      },
      onError: (e) => toast({ title: "Xato", description: errMsg(e, "Stavkani saqlab bo'lmadi."), variant: "destructive" }),
    },
  });

  return (
    <TableRow data-testid={`rate-row-${role}`}>
      <TableCell className="font-medium">{roleLabel(role)}</TableCell>
      <TableCell>
        <div className="flex items-center gap-2 max-w-[260px]">
          <Input
            type="number"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-9 font-mono"
            data-testid={`rate-input-${role}`}
          />
          <span className="text-xs text-muted-foreground whitespace-nowrap">so'm/kg</span>
        </div>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">{updatedAt ? formatDate(updatedAt) : "—"}</TableCell>
      <TableCell className="text-right">
        <Button
          size="sm"
          variant="outline"
          disabled={!changed || update.isPending}
          onClick={() => update.mutate({ data: { role, rate: Number(value) } })}
          data-testid={`btn-save-rate-${role}`}
        >
          <Save className="w-4 h-4 mr-2" />
          {update.isPending ? "Saqlanmoqda..." : "Saqlash"}
        </Button>
      </TableCell>
    </TableRow>
  );
}

type Member = { id: number; workerName: string; role: string };
type LineStatus = {
  lineId: number;
  lineName: string;
  totalKg: number;
  closed: boolean;
  closedAt: string | null;
  producers: Member[];
  preparation: Member[];
  packaging: Member[];
  producerRate: number;
  prepRate: number;
  packagingRate: number;
  prepPool: number;
  prepPerWorker: number;
  packagingPool: number;
  packagingPerWorker: number;
};

const ROLE_ICON: Record<string, typeof Hammer> = {
  producer: Hammer,
  preparation: Boxes,
  packaging: PackageCheck,
};

// ── One role column inside a line card ──────────────────────────────────────────
function RoleSection({
  role, members, availableWorkers, closed, totalKg, pool, perWorker, rate, onAdd, onRemove, adding,
}: {
  role: string;
  members: Member[];
  availableWorkers: string[];
  closed: boolean;
  totalKg: number;
  pool: number | null; // null for producer (no shared pool)
  perWorker: number | null;
  rate: number;
  onAdd: (role: string, workerName: string) => void;
  onRemove: (memberId: number, workerName: string, role: string) => void;
  adding: boolean;
}) {
  const [sel, setSel] = useState<string>("");
  const limit = ROLE_LIMITS[role];
  const atMax = members.length >= limit.max;
  const belowMin = members.length < limit.min;
  const Icon = ROLE_ICON[role] ?? Hammer;
  const isPool = role !== "producer";

  return (
    <div className="rounded-lg border border-border bg-card/40 flex flex-col" data-testid={`role-section-${role}`}>
      <div className="px-3 py-2.5 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-muted-foreground" />
          <span className="font-medium text-sm">{roleLabel(role)}</span>
        </div>
        <Badge
          variant="outline"
          className={members.length === 0 ? "text-amber-600 border-amber-300" : "text-muted-foreground"}
        >
          {members.length}/{limit.max}
        </Badge>
      </div>

      {/* Pool preview */}
      <div className="px-3 py-2 text-xs border-b border-border bg-muted/20">
        {isPool ? (
          <div className="space-y-0.5">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Fond ({formatNumber(totalKg)}×{formatNumber(rate)})</span>
              <span className="font-mono font-medium">{formatCurrency(pool ?? 0)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Har biriga ({members.length || 0} kishi)</span>
              <span className="font-mono font-medium text-primary">{formatCurrency(perWorker ?? 0)}</span>
            </div>
          </div>
        ) : (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Stavka (har partiyada)</span>
            <span className="font-mono font-medium">{formatNumber(rate)} so'm/kg</span>
          </div>
        )}
      </div>

      {/* Members */}
      <div className="flex-1 p-2 space-y-1 min-h-[60px]">
        {members.length === 0 ? (
          <div className="text-xs text-amber-600 flex items-center gap-1.5 px-1 py-2">
            <AlertTriangle className="w-3.5 h-3.5" /> Ishchi biriktirilmagan
          </div>
        ) : (
          members.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between gap-2 rounded-md bg-background border border-border px-2 py-1.5"
              data-testid={`member-${m.id}`}
            >
              <span className="text-sm truncate">{m.workerName || "(nomsiz)"}</span>
              {!closed && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => onRemove(m.id, m.workerName, role)}
                  data-testid={`btn-remove-member-${m.id}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
          ))
        )}
      </div>

      {/* Add control */}
      {!closed && (
        <div className="p-2 border-t border-border flex gap-1.5">
          <Select value={sel} onValueChange={setSel} disabled={atMax}>
            <SelectTrigger className="h-8 text-xs" data-testid={`select-add-${role}`}>
              <SelectValue placeholder={atMax ? `Maksimal (${limit.max})` : "Ishchi tanlang"} />
            </SelectTrigger>
            <SelectContent>
              {availableWorkers.length === 0 ? (
                <div className="px-2 py-2 text-xs text-muted-foreground text-center">Mavjud ishchi yo'q</div>
              ) : (
                availableWorkers.map((w) => (
                  <SelectItem key={w} value={w}>{w || "(nomsiz)"}</SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          <Button
            size="icon"
            className="h-8 w-8 shrink-0"
            disabled={!sel || atMax || adding}
            onClick={() => { onAdd(role, sel); setSel(""); }}
            data-testid={`btn-add-${role}`}
          >
            <Plus className="w-4 h-4" />
          </Button>
        </div>
      )}
      {belowMin && members.length > 0 && (
        <div className="px-3 pb-2 text-[11px] text-amber-600">Tavsiya etilgan minimum: {limit.min}</div>
      )}
    </div>
  );
}

// ── A single production line card ────────────────────────────────────────────────
function LineCard({
  line, workers, globalProducers, globalPrep, globalPackaging, onAdd, onRemove, onDelete, adding, deleting,
}: {
  line: LineStatus;
  workers: string[];
  globalProducers: Set<string>;
  globalPrep: Set<string>;
  globalPackaging: Set<string>;
  onAdd: (lineId: number, role: string, workerName: string) => void;
  onRemove: (memberId: number, workerName: string, role: string) => void;
  onDelete: (lineId: number, lineName: string) => void;
  adding: boolean;
  deleting: boolean;
}) {
  const producerNames = new Set(line.producers.map((m) => m.workerName));

  // Each (worker, role) belongs to exactly one line — filter globally so a
  // worker already holding a role elsewhere isn't offered for another line.
  const producerAvail = workers.filter((w) => !globalProducers.has(w));
  const prepAvail = workers.filter((w) => !globalPrep.has(w));
  const packagingAvail = workers.filter((w) => !globalPackaging.has(w));

  return (
    <Card className="border-border overflow-hidden" data-testid={`line-card-${line.lineId}`}>
      <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3 bg-muted/30">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Factory className="w-4.5 h-4.5" />
          </div>
          <div>
            <h3 className="font-semibold tracking-tight">{line.lineName}</h3>
            <div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
              <Weight className="w-3.5 h-3.5" />
              Bugun: <span className="font-medium text-foreground">{formatNumber(line.totalKg)} kg</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {line.closed ? (
            <Badge className="bg-primary/15 text-primary border-primary/30 hover:bg-primary/15 cursor-default">
              <Lock className="w-3 h-3 mr-1" /> Yopilgan
            </Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground cursor-default">
              <LockOpen className="w-3 h-3 mr-1" /> Ochiq
            </Badge>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                disabled={deleting}
                data-testid={`btn-delete-line-${line.lineId}`}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Liniyani o'chirish</AlertDialogTitle>
                <AlertDialogDescription>
                  <strong>{line.lineName}</strong> liniyasi va unga biriktirilgan barcha ishchilar o'chiriladi.
                  Avval hisoblangan maoshlar saqlanib qoladi. Davom etilsinmi?
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => onDelete(line.lineId, line.lineName)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  data-testid={`btn-confirm-delete-line-${line.lineId}`}
                >
                  O'chirish
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <CardContent className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <RoleSection
            role="producer"
            members={line.producers}
            availableWorkers={producerAvail.filter((w) => !producerNames.has(w))}
            closed={line.closed}
            totalKg={line.totalKg}
            pool={null}
            perWorker={null}
            rate={line.producerRate}
            onAdd={(role, w) => onAdd(line.lineId, role, w)}
            onRemove={onRemove}
            adding={adding}
          />
          <RoleSection
            role="preparation"
            members={line.preparation}
            availableWorkers={prepAvail}
            closed={line.closed}
            totalKg={line.totalKg}
            pool={line.prepPool}
            perWorker={line.prepPerWorker}
            rate={line.prepRate}
            onAdd={(role, w) => onAdd(line.lineId, role, w)}
            onRemove={onRemove}
            adding={adding}
          />
          <RoleSection
            role="packaging"
            members={line.packaging}
            availableWorkers={packagingAvail}
            closed={line.closed}
            totalKg={line.totalKg}
            pool={line.packagingPool}
            perWorker={line.packagingPerWorker}
            rate={line.packagingRate}
            onAdd={(role, w) => onAdd(line.lineId, role, w)}
            onRemove={onRemove}
            adding={adding}
          />
        </div>
      </CardContent>
    </Card>
  );
}

export default function Payroll() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: dayStatus, isLoading: dayLoading } = useGetPayrollDayStatus({
    query: { queryKey: getGetPayrollDayStatusQueryKey() },
  });
  const { data: roleRates, isLoading: ratesLoading } = useGetPayrollRoleRates({
    query: { queryKey: getGetPayrollRoleRatesQueryKey() },
  });
  const { data: workers } = useGetWorkers({ query: { queryKey: getGetWorkersQueryKey() } });
  const { data: products, isLoading: productsLoading } = useGetProducts({
    query: { queryKey: getGetProductsQueryKey() },
  });
  const { data: earnings, isLoading: earningsLoading } = useGetPayrollWorkerEarnings({
    query: { queryKey: getGetPayrollWorkerEarningsQueryKey() },
  });

  const invalidateDay = () => {
    queryClient.invalidateQueries({ queryKey: getGetPayrollDayStatusQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPayrollWorkerEarningsQueryKey() });
  };

  const [newLineName, setNewLineName] = useState<string>("");

  const createLine = useCreateProductionLine({
    mutation: {
      onSuccess: () => {
        invalidateDay();
        setNewLineName("");
        toast({ title: "Yaratildi", description: "Yangi liniya qo'shildi." });
      },
      onError: (e) => toast({ title: "Xato", description: errMsg(e, "Liniyani yaratib bo'lmadi."), variant: "destructive" }),
    },
  });

  const deleteLine = useDeleteProductionLine({
    mutation: {
      onSuccess: () => { invalidateDay(); toast({ title: "O'chirildi", description: "Liniya o'chirildi." }); },
      onError: (e) => toast({ title: "Xato", description: errMsg(e, "Liniyani o'chirib bo'lmadi."), variant: "destructive" }),
    },
  });

  const addWorker = useAddProductionLineWorker({
    mutation: {
      onSuccess: () => { invalidateDay(); toast({ title: "Qo'shildi", description: "Ishchi liniyaga biriktirildi." }); },
      onError: (e) => toast({ title: "Xato", description: errMsg(e, "Ishchini biriktirib bo'lmadi."), variant: "destructive" }),
    },
  });

  const removeWorker = useRemoveProductionLineWorker({
    mutation: {
      onSuccess: () => { invalidateDay(); toast({ title: "Olib tashlandi", description: "Ishchi liniyadan olib tashlandi." }); },
      onError: (e) => toast({ title: "Xato", description: errMsg(e, "Ishchini olib tashlab bo'lmadi."), variant: "destructive" }),
    },
  });

  const closeDay = useClosePayrollDay({
    mutation: {
      onSuccess: (res) => {
        invalidateDay();
        if (res.alreadyClosed) {
          toast({ title: "Allaqachon yopilgan", description: "Bugungi kun barcha liniyalar uchun yopilgan." });
        } else {
          toast({
            title: "Kun yopildi",
            description: `${res.newEntryCount} ta ulush hisoblandi · jami ${formatNumber(res.totalKg)} kg.`,
          });
        }
      },
      onError: (e) => toast({ title: "Xato", description: errMsg(e, "Kunni yopib bo'lmadi."), variant: "destructive" }),
    },
  });

  const updateMethod = useMutation({
    mutationFn: async ({ name, method }: { name: string; method: string }) => {
      const res = await authFetch(`/api/products/${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payrollMethod: method }),
      });
      if (!res.ok) throw new Error("Saqlashda xato");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getGetProductsQueryKey() });
      toast({ title: "Saqlandi", description: "Mahsulot maosh usuli yangilandi." });
    },
    onError: () => toast({ title: "Xato", description: "Maosh usulini saqlab bo'lmadi.", variant: "destructive" }),
  });

  const lines = (dayStatus?.lines ?? []) as LineStatus[];
  const workerNames = (workers ?? []).map((w) => w.name).filter((n): n is string => !!n);
  const globalProducers = new Set<string>();
  const globalPrep = new Set<string>();
  const globalPackaging = new Set<string>();
  for (const l of lines) {
    for (const p of l.producers) globalProducers.add(p.workerName);
    for (const p of l.preparation) globalPrep.add(p.workerName);
    for (const p of l.packaging) globalPackaging.add(p.workerName);
  }

  const unassignedKg = dayStatus?.unassignedKg ?? 0;
  const allClosed = dayStatus?.closed ?? false;
  // Lines that have production today but are missing a shared role.
  const emptyRoleLines = lines.filter(
    (l) => l.totalKg > 0 && (l.preparation.length === 0 || l.packaging.length === 0)
  );
  const hasWarnings = unassignedKg > 0 || emptyRoleLines.length > 0;

  const totalToday = (earnings ?? []).reduce((a, r) => a + r.todayEarnings, 0);
  const totalMonth = (earnings ?? []).reduce((a, r) => a + r.monthEarnings, 0);
  const totalLifetime = (earnings ?? []).reduce((a, r) => a + r.lifetimeEarnings, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Ishlab chiqarish liniyalari</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Har bir liniya o'z ishchilari va kunlik kg hajmiga ega. Tayyorlash/qadoqlash fondi liniya ishchilari soniga bo'linadi.
        </p>
      </div>

      {/* Day status banner */}
      <Card className="border-border">
        <CardContent className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 ${allClosed ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>
              {allClosed ? <Lock className="w-5 h-5" /> : <LockOpen className="w-5 h-5" />}
            </div>
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">
                Bugungi kun {dayStatus ? `(${formatDate(dayStatus.workDate)})` : ""}
              </div>
              {dayLoading ? (
                <Skeleton className="h-6 w-56" />
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-lg font-semibold tracking-tight flex items-center gap-1.5">
                    <Weight className="w-4 h-4 text-muted-foreground" />
                    {formatNumber(dayStatus?.totalKg ?? 0)} kg
                  </span>
                  {allClosed ? (
                    <Badge className="bg-primary/15 text-primary border-primary/30 hover:bg-primary/15 cursor-default">Yopilgan</Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground cursor-default">Ochiq</Badge>
                  )}
                  {unassignedKg > 0 && (
                    <Badge variant="outline" className="text-amber-600 border-amber-300 cursor-default" data-testid="badge-unassigned">
                      <AlertTriangle className="w-3 h-3 mr-1" /> {formatNumber(unassignedKg)} kg liniyasiz
                    </Badge>
                  )}
                </div>
              )}
            </div>
          </div>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button disabled={closeDay.isPending || lines.length === 0} data-testid="btn-close-day">
                <Lock className="w-4 h-4 mr-2" />
                {closeDay.isPending ? "Yopilmoqda..." : "Kunni yopish"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Kunni yopish</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-2">
                    <p>
                      Barcha liniyalar uchun bugungi tayyorlash/qadoqlash ulushi hisoblanadi va ishchilarga Telegram orqali xabar yuboriladi.
                      Bu amal har bir liniya uchun kuniga bir marta bajariladi.
                    </p>
                    {hasWarnings && (
                      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-800 text-sm space-y-1">
                        <div className="font-medium flex items-center gap-1.5">
                          <AlertTriangle className="w-4 h-4" /> Diqqat
                        </div>
                        {unassignedKg > 0 && (
                          <p>{formatNumber(unassignedKg)} kg hech qaysi liniyaga biriktirilmagan — bu ulush hisoblanmaydi.</p>
                        )}
                        {emptyRoleLines.map((l) => (
                          <p key={l.lineId}>
                            <strong>{l.lineName}</strong>: {l.preparation.length === 0 ? "tayyorlovchi" : ""}
                            {l.preparation.length === 0 && l.packaging.length === 0 ? " va " : ""}
                            {l.packaging.length === 0 ? "qadoqlovchi" : ""} yo'q — ushbu fond hisoblanmaydi.
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
                <AlertDialogAction onClick={() => closeDay.mutate()} data-testid="btn-confirm-close-day">
                  Kunni yopish
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>

      <Tabs defaultValue="lines" className="space-y-6">
        <TabsList>
          <TabsTrigger value="lines" data-testid="tab-lines">Liniyalar</TabsTrigger>
          <TabsTrigger value="earnings" data-testid="tab-earnings">Ishchilar daromadi</TabsTrigger>
          <TabsTrigger value="settings" data-testid="tab-settings">Sozlamalar</TabsTrigger>
        </TabsList>

        {/* ── Lines tab ── */}
        <TabsContent value="lines" className="space-y-5">
          {/* Create line */}
          <Card className="border-border">
            <CardContent className="p-4 flex flex-col sm:flex-row gap-3 sm:items-end">
              <div className="flex-1 space-y-1.5">
                <Label className="text-xs">Yangi liniya nomi</Label>
                <Input
                  value={newLineName}
                  onChange={(e) => setNewLineName(e.target.value)}
                  placeholder="Masalan: Arqon Bo'limi 2"
                  data-testid="input-new-line"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newLineName.trim()) createLine.mutate({ data: { name: newLineName.trim() } });
                  }}
                />
              </div>
              <Button
                disabled={!newLineName.trim() || createLine.isPending}
                onClick={() => createLine.mutate({ data: { name: newLineName.trim() } })}
                data-testid="btn-create-line"
              >
                <Plus className="w-4 h-4 mr-2" />
                {createLine.isPending ? "Qo'shilmoqda..." : "Liniya qo'shish"}
              </Button>
            </CardContent>
          </Card>

          {dayLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-64 w-full rounded-xl" />)}
            </div>
          ) : lines.length === 0 ? (
            <Card className="border-border border-dashed">
              <CardContent className="py-12 text-center text-muted-foreground">
                <Factory className="w-8 h-8 mx-auto mb-3 opacity-40" />
                Hali liniya yo'q. Yuqorida birinchi liniyani qo'shing.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {lines.map((line) => (
                <LineCard
                  key={line.lineId}
                  line={line}
                  workers={workerNames}
                  globalProducers={globalProducers}
                  globalPrep={globalPrep}
                  globalPackaging={globalPackaging}
                  onAdd={(lineId, role, workerName) => addWorker.mutate({ id: lineId, data: { workerName, role } })}
                  onRemove={(memberId) => removeWorker.mutate({ id: memberId })}
                  onDelete={(lineId) => deleteLine.mutate({ id: lineId })}
                  adding={addWorker.isPending}
                  deleting={deleteLine.isPending}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Earnings tab ── */}
        <TabsContent value="earnings" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className="border-border bg-sidebar text-sidebar-foreground">
              <CardContent className="p-5">
                <div className="text-xs font-bold uppercase tracking-wider mb-2 text-sidebar-foreground/70">Bugun</div>
                {earningsLoading ? <Skeleton className="h-8 w-24 bg-sidebar-accent" /> : (
                  <div className="text-2xl font-semibold tracking-tight">{formatCurrency(totalToday)}</div>
                )}
              </CardContent>
            </Card>
            <Card className="border-border">
              <CardContent className="p-5">
                <div className="text-xs font-bold uppercase tracking-wider mb-2 text-muted-foreground">Bu oy</div>
                {earningsLoading ? <Skeleton className="h-8 w-24" /> : (
                  <div className="text-2xl font-semibold tracking-tight">{formatCurrency(totalMonth)}</div>
                )}
              </CardContent>
            </Card>
            <Card className="border-border">
              <CardContent className="p-5">
                <div className="text-xs font-bold uppercase tracking-wider mb-2 text-muted-foreground">Jami (umrbod)</div>
                {earningsLoading ? <Skeleton className="h-8 w-24" /> : (
                  <div className="text-2xl font-semibold tracking-tight text-primary">{formatCurrency(totalLifetime)}</div>
                )}
              </CardContent>
            </Card>
          </div>

          <Card className="border-border">
            <CardContent className="p-0">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Ishchi</TableHead>
                    <TableHead>Liniya</TableHead>
                    <TableHead>Rol</TableHead>
                    <TableHead className="text-right">Bugun kg</TableHead>
                    <TableHead className="text-right">Oy kg</TableHead>
                    <TableHead className="text-right">Jami kg</TableHead>
                    <TableHead className="text-right">Bugun</TableHead>
                    <TableHead className="text-right">Oy</TableHead>
                    <TableHead className="text-right">Jami</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {earningsLoading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <TableRow key={i}>
                        <TableCell><Skeleton className="h-5 w-32" /></TableCell>
                        {Array.from({ length: 8 }).map((__, j) => (
                          <TableCell key={j} className="text-right"><Skeleton className="h-5 w-16 ml-auto" /></TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : (earnings ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">Daromad ma'lumotlari yo'q.</TableCell>
                    </TableRow>
                  ) : (
                    (earnings ?? []).map((r) => (
                      <TableRow key={r.worker} data-testid={`earnings-row-${r.worker}`}>
                        <TableCell className="font-medium">{r.worker || "(nomsiz)"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{r.lineName ?? "—"}</TableCell>
                        <TableCell>{r.role ? <Badge variant="outline">{roleLabel(r.role)}</Badge> : "—"}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatNumber(r.todayKg)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatNumber(r.monthKg)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatNumber(r.lifetimeKg)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatCurrency(r.todayEarnings)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatCurrency(r.monthEarnings)}</TableCell>
                        <TableCell className="text-right font-mono text-sm font-medium">{formatCurrency(r.lifetimeEarnings)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Settings tab ── */}
        <TabsContent value="settings" className="space-y-6">
          {/* Role rates */}
          <Card className="border-border">
            <CardContent className="p-0">
              <div className="px-5 py-4 border-b border-border">
                <h2 className="font-semibold">Rol stavkalari</h2>
                <p className="text-sm text-muted-foreground mt-0.5">Har bir rol uchun 1 kg ga to'lanadigan summa (barcha liniyalar uchun umumiy).</p>
              </div>
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Rol</TableHead>
                    <TableHead>Stavka</TableHead>
                    <TableHead>Yangilangan</TableHead>
                    <TableHead className="text-right w-[140px]">Amal</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ratesLoading ? (
                    Array.from({ length: 3 }).map((_, i) => (
                      <TableRow key={i}>
                        <TableCell><Skeleton className="h-5 w-28" /></TableCell>
                        <TableCell><Skeleton className="h-9 w-48" /></TableCell>
                        <TableCell><Skeleton className="h-5 w-24" /></TableCell>
                        <TableCell className="text-right"><Skeleton className="h-8 w-24 ml-auto" /></TableCell>
                      </TableRow>
                    ))
                  ) : (
                    RATE_ROLES.map((role) => {
                      const r = (roleRates ?? []).find((x) => x.role === role);
                      return (
                        <RoleRateRow
                          key={role}
                          role={role}
                          rate={r?.rate ?? 0}
                          updatedAt={r?.updatedAt ?? null}
                        />
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Product methods */}
          <Card className="border-border">
            <CardContent className="p-0">
              <div className="px-5 py-4 border-b border-border">
                <h2 className="font-semibold">Mahsulot maosh usuli</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Kg (rol asosida) — ishlab chiqaruvchi kg×stavka oladi. Dona — eski mahsulot stavkasi.
                </p>
              </div>
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Mahsulot</TableHead>
                    <TableHead>Birlik</TableHead>
                    <TableHead className="w-[280px]">Maosh usuli</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {productsLoading ? (
                    Array.from({ length: 4 }).map((_, i) => (
                      <TableRow key={i}>
                        <TableCell><Skeleton className="h-5 w-40" /></TableCell>
                        <TableCell><Skeleton className="h-5 w-16" /></TableCell>
                        <TableCell><Skeleton className="h-9 w-64" /></TableCell>
                      </TableRow>
                    ))
                  ) : (products ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">Mahsulotlar topilmadi.</TableCell>
                    </TableRow>
                  ) : (
                    (products ?? []).map((p) => (
                      <TableRow key={p.name} data-testid={`product-method-row-${p.name}`}>
                        <TableCell className="font-medium">{p.name}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{p.rateType}</TableCell>
                        <TableCell>
                          <Select
                            value={p.payrollMethod || "PRODUCT_RATE"}
                            disabled={p.rateType !== "kg"}
                            onValueChange={(method) => updateMethod.mutate({ name: p.name, method })}
                          >
                            <SelectTrigger className="max-w-[260px]" data-testid={`select-method-${p.name}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="PRODUCT_RATE">{METHOD_UZ.PRODUCT_RATE}</SelectItem>
                              {(p.rateType === "kg" || p.payrollMethod === "ROLE_BASED_KG") && (
                                <SelectItem value="ROLE_BASED_KG">{METHOD_UZ.ROLE_BASED_KG}</SelectItem>
                              )}
                            </SelectContent>
                          </Select>
                          {p.rateType !== "kg" && (
                            <p className="text-xs text-muted-foreground mt-1">
                              Kg asosida faqat kg mahsulotlar uchun
                            </p>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
