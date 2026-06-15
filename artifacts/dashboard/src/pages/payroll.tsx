import { useState } from "react";
import { authFetch } from "@/App";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useGetPayrollRoleRates, getGetPayrollRoleRatesQueryKey, useUpdatePayrollRoleRate,
  useGetKgPayrollWorkers, getGetKgPayrollWorkersQueryKey, useAssignKgPayrollWorker, useRemoveKgPayrollWorker,
  useGetPayrollWorkerEarnings, getGetPayrollWorkerEarningsQueryKey,
  useGetPayrollDayStatus, getGetPayrollDayStatusQueryKey,
  useGetWorkers, getGetWorkersQueryKey,
  useGetProducts, getGetProductsQueryKey,
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
import { Lock, LockOpen, Save, Plus, Trash2, Weight, UserPlus } from "lucide-react";

const ROLE_UZ: Record<string, string> = {
  producer: "Ishlab chiqaruvchi",
  preparation: "Tayyorlash",
  packer: "Qadoqlash",
};
const ASSIGNABLE_ROLES = ["preparation", "packer"];

const METHOD_UZ: Record<string, string> = {
  PRODUCT_RATE: "Dona (mahsulot stavkasi)",
  ROLE_BASED_KG: "Kg (rol asosida)",
};

function roleLabel(role: string): string {
  return ROLE_UZ[role] ?? role;
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
        queryClient.invalidateQueries({ queryKey: getGetPayrollWorkerEarningsQueryKey() });
        toast({ title: "Saqlandi", description: `${roleLabel(role)} stavkasi yangilandi.` });
      },
      onError: () => toast({ title: "Xato", description: "Stavkani saqlab bo'lmadi.", variant: "destructive" }),
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

export default function Payroll() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: dayStatus, isLoading: dayLoading } = useGetPayrollDayStatus({
    query: { queryKey: getGetPayrollDayStatusQueryKey() },
  });
  const { data: roleRates, isLoading: ratesLoading } = useGetPayrollRoleRates({
    query: { queryKey: getGetPayrollRoleRatesQueryKey() },
  });
  const { data: kgWorkers, isLoading: kgLoading } = useGetKgPayrollWorkers({
    query: { queryKey: getGetKgPayrollWorkersQueryKey() },
  });
  const { data: workers } = useGetWorkers({ query: { queryKey: getGetWorkersQueryKey() } });
  const { data: products, isLoading: productsLoading } = useGetProducts({
    query: { queryKey: getGetProductsQueryKey() },
  });
  const { data: earnings, isLoading: earningsLoading } = useGetPayrollWorkerEarnings({
    query: { queryKey: getGetPayrollWorkerEarningsQueryKey() },
  });

  // ── assignment form state ──
  const [newWorker, setNewWorker] = useState<string>("");
  const [newRole, setNewRole] = useState<string>("preparation");

  const assign = useAssignKgPayrollWorker({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetKgPayrollWorkersQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetPayrollWorkerEarningsQueryKey() });
        setNewWorker("");
        toast({ title: "Biriktirildi", description: "Ishchi kg maosh ro'yxatiga qo'shildi." });
      },
      onError: () => toast({ title: "Xato", description: "Ishchini biriktirib bo'lmadi.", variant: "destructive" }),
    },
  });

  const removeWorker = useRemoveKgPayrollWorker({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetKgPayrollWorkersQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetPayrollWorkerEarningsQueryKey() });
        toast({ title: "O'chirildi", description: "Biriktirma olib tashlandi." });
      },
      onError: () => toast({ title: "Xato", description: "Biriktirmani o'chirib bo'lmadi.", variant: "destructive" }),
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

  const assignedNames = new Set((kgWorkers ?? []).map((w) => `${w.workerName}::${w.role}`));
  const availableWorkers = (workers ?? []).filter((w) => !assignedNames.has(`${w.name}::${newRole}`));

  const totalToday = (earnings ?? []).reduce((a, r) => a + r.todayEarnings, 0);
  const totalMonth = (earnings ?? []).reduce((a, r) => a + r.monthEarnings, 0);
  const totalLifetime = (earnings ?? []).reduce((a, r) => a + r.lifetimeEarnings, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Kg maosh boshqaruvi</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Rol asosidagi (Arqon) kg maosh tizimi — stavkalar, biriktirilgan ishchilar va daromadlar.
        </p>
      </div>

      {/* Day status banner */}
      <Card className="border-border">
        <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 ${dayStatus?.closed ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>
              {dayStatus?.closed ? <Lock className="w-5 h-5" /> : <LockOpen className="w-5 h-5" />}
            </div>
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">
                Bugungi kun {dayStatus ? `(${formatDate(dayStatus.workDate)})` : ""}
              </div>
              {dayLoading ? (
                <Skeleton className="h-6 w-48" />
              ) : (
                <div className="flex items-center gap-3">
                  <span className="text-lg font-semibold tracking-tight flex items-center gap-1.5">
                    <Weight className="w-4 h-4 text-muted-foreground" />
                    {formatNumber(dayStatus?.totalKg ?? 0)} kg
                  </span>
                  {dayStatus?.closed ? (
                    <Badge className="bg-primary/15 text-primary border-primary/30 hover:bg-primary/15 cursor-default">
                      Yopilgan{dayStatus.closedAt ? ` · ${formatDate(dayStatus.closedAt)}` : ""}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground cursor-default">Ochiq</Badge>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="text-xs text-muted-foreground max-w-xs sm:text-right">
            Kunni yopish va tayyorlash/qadoqlash maoshini hisoblash Telegram bot orqali amalga oshiriladi.
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="settings" className="space-y-6">
        <TabsList>
          <TabsTrigger value="settings" data-testid="tab-settings">Sozlamalar</TabsTrigger>
          <TabsTrigger value="earnings" data-testid="tab-earnings">Ishchilar daromadi</TabsTrigger>
        </TabsList>

        {/* ── Settings tab ── */}
        <TabsContent value="settings" className="space-y-6">
          {/* Role rates */}
          <Card className="border-border">
            <CardContent className="p-0">
              <div className="px-5 py-4 border-b border-border">
                <h2 className="font-semibold">Rol stavkalari</h2>
                <p className="text-sm text-muted-foreground mt-0.5">Har bir rol uchun 1 kg ga to'lanadigan summa.</p>
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
                  ) : (roleRates ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Stavkalar topilmadi.</TableCell>
                    </TableRow>
                  ) : (
                    [...(roleRates ?? [])]
                      .sort((a, b) => a.role.localeCompare(b.role))
                      .map((r) => <RoleRateRow key={r.role} role={r.role} rate={r.rate} updatedAt={r.updatedAt} />)
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Assigned workers */}
          <Card className="border-border">
            <CardContent className="p-0">
              <div className="px-5 py-4 border-b border-border">
                <h2 className="font-semibold">Biriktirilgan ishchilar</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Faqat bu yerda biriktirilgan tayyorlash/qadoqlash ishchilari kunlik kg maosh oladi.
                </p>
              </div>
              <div className="px-5 py-4 border-b border-border bg-muted/20 flex flex-col sm:flex-row gap-3 sm:items-end">
                <div className="flex-1 space-y-1.5">
                  <Label className="text-xs">Ishchi</Label>
                  <Select value={newWorker} onValueChange={setNewWorker}>
                    <SelectTrigger data-testid="select-new-worker"><SelectValue placeholder="Ishchini tanlang" /></SelectTrigger>
                    <SelectContent>
                      {availableWorkers.length === 0 ? (
                        <div className="px-2 py-3 text-sm text-muted-foreground text-center">Mavjud ishchi yo'q</div>
                      ) : (
                        availableWorkers.map((w) => (
                          <SelectItem key={w.name} value={w.name}>{w.name || "(nomsiz)"}</SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-full sm:w-48 space-y-1.5">
                  <Label className="text-xs">Rol</Label>
                  <Select value={newRole} onValueChange={setNewRole}>
                    <SelectTrigger data-testid="select-new-role"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ASSIGNABLE_ROLES.map((r) => (
                        <SelectItem key={r} value={r}>{roleLabel(r)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  disabled={!newWorker || assign.isPending}
                  onClick={() => assign.mutate({ data: { workerName: newWorker, role: newRole } })}
                  data-testid="btn-assign-worker"
                >
                  <UserPlus className="w-4 h-4 mr-2" />
                  {assign.isPending ? "Qo'shilmoqda..." : "Qo'shish"}
                </Button>
              </div>
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Ishchi</TableHead>
                    <TableHead>Rol</TableHead>
                    <TableHead>Holat</TableHead>
                    <TableHead className="text-right w-[120px]">Amal</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {kgLoading ? (
                    Array.from({ length: 3 }).map((_, i) => (
                      <TableRow key={i}>
                        <TableCell><Skeleton className="h-5 w-32" /></TableCell>
                        <TableCell><Skeleton className="h-5 w-24" /></TableCell>
                        <TableCell><Skeleton className="h-6 w-16 rounded-full" /></TableCell>
                        <TableCell className="text-right"><Skeleton className="h-8 w-20 ml-auto" /></TableCell>
                      </TableRow>
                    ))
                  ) : (kgWorkers ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                        Hali ishchi biriktirilmagan.
                      </TableCell>
                    </TableRow>
                  ) : (
                    (kgWorkers ?? []).map((w) => (
                      <TableRow key={w.id} data-testid={`kgworker-row-${w.id}`}>
                        <TableCell className="font-medium">{w.workerName || "(nomsiz)"}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{roleLabel(w.role)}</Badge>
                        </TableCell>
                        <TableCell>
                          {w.active ? (
                            <Badge className="bg-primary/15 text-primary border-primary/30 hover:bg-primary/15 cursor-default">Faol</Badge>
                          ) : (
                            <Badge variant="outline" className="text-muted-foreground cursor-default">Nofaol</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive hover:bg-destructive/10" data-testid={`btn-remove-kgworker-${w.id}`}>
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Biriktirmani o'chirish</AlertDialogTitle>
                                <AlertDialogDescription>
                                  <strong>{w.workerName || "(nomsiz)"}</strong> ({roleLabel(w.role)}) kg maosh ro'yxatidan olib tashlansinmi?
                                  Avval hisoblangan maoshlar saqlanib qoladi.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => removeWorker.mutate({ id: w.id })}
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  data-testid="btn-confirm-remove-kgworker"
                                >
                                  O'chirish
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </TableCell>
                      </TableRow>
                    ))
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
                        {Array.from({ length: 6 }).map((__, j) => (
                          <TableCell key={j} className="text-right"><Skeleton className="h-5 w-16 ml-auto" /></TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : (earnings ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Daromad ma'lumotlari yo'q.</TableCell>
                    </TableRow>
                  ) : (
                    (earnings ?? []).map((r) => (
                      <TableRow key={r.worker} data-testid={`earnings-row-${r.worker}`}>
                        <TableCell className="font-medium">{r.worker || "(nomsiz)"}</TableCell>
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
      </Tabs>
    </div>
  );
}
