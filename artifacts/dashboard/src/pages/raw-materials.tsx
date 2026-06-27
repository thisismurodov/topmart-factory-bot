import { authFetch } from "@/App";
import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2, Pencil, Boxes, AlertTriangle, PackageCheck, Scale } from "lucide-react";
import { formatCurrency } from "@/lib/format";

// ── Types ─────────────────────────────────────────────────────────────────────
type RawMaterial = {
  id: number;
  name: string;
  unitType: string;
  defaultCost: number;
  currency: string;
  calculatedUzsCost: number;
  currentStock: number;
  minimumStock: number;
  active: boolean;
  createdAt: string;
};

// ── Schema ────────────────────────────────────────────────────────────────────
const UNIT_OPTIONS = ["kg", "dona", "litr", "metr", "rulon", "m²"] as const;

const rawMaterialSchema = z.object({
  name: z.string().min(1, "Nomi kiritilishi shart"),
  unitType: z.string().min(1),
  currency: z.enum(["UZS", "USD"]).default("UZS"),
  defaultCost: z.coerce.number().min(0),
  currentStock: z.coerce.number().min(0),
  minimumStock: z.coerce.number().min(0),
  active: z.boolean().default(true),
});
type RawMaterialForm = z.infer<typeof rawMaterialSchema>;

// ── Query keys ────────────────────────────────────────────────────────────────
const RAW_MATERIALS_KEY = ["raw-materials"];

// ── Helpers ───────────────────────────────────────────────────────────────────
function isLowStock(rm: RawMaterial): boolean {
  return rm.minimumStock > 0 && rm.currentStock <= rm.minimumStock;
}

// ── Hooks ─────────────────────────────────────────────────────────────────────
function useRawMaterials() {
  return useQuery<RawMaterial[]>({
    queryKey: RAW_MATERIALS_KEY,
    queryFn: async () => {
      const res = await authFetch("/api/raw-materials");
      if (!res.ok) throw new Error("Yuklashda xato");
      return res.json();
    },
  });
}

function useCreateRawMaterial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: RawMaterialForm) => {
      const res = await authFetch("/api/raw-materials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Saqlashda xato");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: RAW_MATERIALS_KEY }),
  });
}

function useUpdateRawMaterial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: RawMaterialForm & { id: number }) => {
      const res = await authFetch(`/api/raw-materials/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Saqlashda xato");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: RAW_MATERIALS_KEY }),
  });
}

function useDeleteRawMaterial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await authFetch(`/api/raw-materials/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("O'chirishda xato");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: RAW_MATERIALS_KEY }),
  });
}

function useAdjustRawStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ materialId, stock, note }: { materialId: number; stock: number; note: string }) => {
      const res = await authFetch("/api/ombor/raw-adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ materialId, stock, note }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "To'g'rilashda xato");
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: RAW_MATERIALS_KEY }),
  });
}

// ── Adjust (recount) Dialog ─────────────────────────────────────────────────────
function RawAdjustDialog({
  material, onClose,
}: {
  material: RawMaterial | null;
  onClose: () => void;
}) {
  const adjustMut = useAdjustRawStock();
  const [stock, setStock] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (material) {
      setStock(String(material.currentStock));
      setNote("");
      setErr("");
      setConfirming(false);
      adjustMut.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [material?.id]);

  const oldStock = material?.currentStock ?? 0;
  const newStock = Number(stock);
  const valid = stock !== "" && isFinite(newStock) && newStock >= 0 && newStock !== (material?.currentStock ?? -1);
  const delta = newStock - oldStock;

  function submit() {
    if (!material) return;
    setErr("");
    adjustMut.mutate(
      { materialId: material.id, stock: newStock, note },
      { onSuccess: onClose, onError: (e: unknown) => setErr(e instanceof Error ? e.message : "Xato") },
    );
  }

  return (
    <Dialog open={!!material} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scale className="w-5 h-5 text-primary" /> Zahirani to'g'rilash
          </DialogTitle>
          <DialogDescription>
            <strong>{material?.name}</strong> — qayta sanash yoki to'kilishdan keyin haqiqiy zahirani kiriting.
            Hozirgi: {material?.currentStock.toLocaleString("ru-RU")} {material?.unitType}.
          </DialogDescription>
        </DialogHeader>

        {confirming ? (
          <div className="space-y-3">
            <div className="rounded-lg border bg-muted/40 p-4 text-sm space-y-2">
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Xom ashyo</span>
                <span className="font-medium">{material?.name}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Zahira</span>
                <span className="font-medium">
                  {oldStock.toLocaleString("ru-RU")} → <span className="text-primary">{newStock.toLocaleString("ru-RU")} {material?.unitType}</span>
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">O'zgarish</span>
                <span className={`font-medium ${delta > 0 ? "text-green-600" : "text-red-600"}`}>
                  {delta > 0 ? "+" : ""}{delta.toLocaleString("ru-RU")} {material?.unitType} ({delta > 0 ? "IN" : "OUT"})
                </span>
              </div>
              {note && (
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Izoh</span>
                  <span className="font-medium">{note}</span>
                </div>
              )}
            </div>
            {err && <p className="text-sm text-red-600">{err}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(false)} disabled={adjustMut.isPending}>
                Orqaga
              </Button>
              <Button onClick={submit} disabled={adjustMut.isPending}>
                {adjustMut.isPending ? "Saqlanmoqda…" : "Tasdiqlash"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <label className="block text-sm font-medium">
                Haqiqiy zahira ({material?.unitType})
                <Input
                  type="number" min="0" step="0.001" className="mt-1"
                  value={stock} onChange={(e) => setStock(e.target.value)}
                />
              </label>
              <label className="block text-sm font-medium">
                Izoh (ixtiyoriy)
                <Input
                  className="mt-1" placeholder="Masalan: qayta sanash, to'kilish…"
                  value={note} onChange={(e) => setNote(e.target.value)}
                />
              </label>
              {err && <p className="text-sm text-red-600">{err}</p>}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Bekor qilish</Button>
              <Button onClick={() => { setErr(""); setConfirming(true); }} disabled={!valid}>
                Davom etish
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Dialog ────────────────────────────────────────────────────────────────────
function RawMaterialDialog({
  open, onClose, material,
}: {
  open: boolean;
  onClose: () => void;
  material?: RawMaterial | null;
}) {
  const isEdit = !!material;
  const createMut = useCreateRawMaterial();
  const updateMut = useUpdateRawMaterial();
  const isPending = createMut.isPending || updateMut.isPending;

  const form = useForm<RawMaterialForm>({
    resolver: zodResolver(rawMaterialSchema),
    values: {
      name: material?.name ?? "",
      unitType: material?.unitType ?? "kg",
      currency: (material?.currency as "UZS" | "USD") ?? "UZS",
      defaultCost: material?.defaultCost ?? 0,
      currentStock: material?.currentStock ?? 0,
      minimumStock: material?.minimumStock ?? 0,
      active: material?.active ?? true,
    },
  });

  const watchedCurrency = form.watch("currency");

  function onSubmit(values: RawMaterialForm) {
    if (isEdit) {
      updateMut.mutate(
        { ...values, id: material!.id },
        { onSuccess: () => onClose() },
      );
    } else {
      createMut.mutate(values, {
        onSuccess: () => { form.reset(); onClose(); },
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Xom ashyoni tahrirlash" : "Yangi xom ashyo"}</DialogTitle>
          {isEdit && <DialogDescription>{material!.name}</DialogDescription>}
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nomi</FormLabel>
                  <FormControl>
                    <Input placeholder="Masalan: Polipropilen ip" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="unitType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Birlik</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {UNIT_OPTIONS.map(u => (
                          <SelectItem key={u} value={u}>{u}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="currency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Valyuta</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="UZS">UZS (so'm)</SelectItem>
                        <SelectItem value="USD">USD ($)</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="defaultCost"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Narx/birlik ({watchedCurrency === "USD" ? "$" : "so'm"})</FormLabel>
                  <FormControl>
                    <Input type="number" step="0.01" min={0} {...field} />
                  </FormControl>
                  {watchedCurrency === "USD" && (
                    <p className="text-xs text-muted-foreground">
                      Hisob-kitoblarda joriy kursda so'mga aylantiriladi.
                    </p>
                  )}
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="currentStock"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Hozirgi zahira</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" min={0} {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="minimumStock"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Minimal zahira</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" min={0} {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="active"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                  <FormLabel className="mb-0">Faol</FormLabel>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Bekor qilish
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? "Saqlanmoqda..." : "Saqlash"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ── KPI card ──────────────────────────────────────────────────────────────────
function StatCard({
  label, value, icon: Icon, tone = "default",
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "default" | "warning";
}) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Icon className={`w-4 h-4 ${tone === "warning" ? "text-red-500" : "text-muted-foreground"}`} />
      </div>
      <div className={`mt-2 text-2xl font-bold ${tone === "warning" ? "text-red-600" : ""}`}>
        {value}
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function RawMaterials() {
  const { data: materials = [], isLoading } = useRawMaterials();
  const deleteMut = useDeleteRawMaterial();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<RawMaterial | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RawMaterial | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<RawMaterial | null>(null);

  const lowStockCount = useMemo(
    () => materials.filter(isLowStock).length,
    [materials],
  );
  const totalValue = useMemo(
    () => materials.reduce((sum, m) => sum + m.currentStock * m.calculatedUzsCost, 0),
    [materials],
  );

  function openAdd() {
    setEditTarget(null);
    setDialogOpen(true);
  }
  function openEdit(m: RawMaterial) {
    setEditTarget(m);
    setDialogOpen(true);
  }

  return (
    <div>
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Boxes className="w-6 h-6 text-primary" /> Xom ashyolar
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isLoading ? "Yuklanmoqda..." : `${materials.length} ta xom ashyo`}
          </p>
        </div>
        <Button onClick={openAdd}>
          <Plus className="w-4 h-4 mr-1.5" /> Qo'shish
        </Button>
      </div>

      {lowStockCount > 0 && (
        <div className="mb-5 flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <span>
            <strong>{lowStockCount} ta</strong> xom ashyo minimal zahiradan kam yoki teng — to'ldirish kerak.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <StatCard label="Jami xom ashyo" value={String(materials.length)} icon={Boxes} />
        <StatCard
          label="Kam qolgan"
          value={String(lowStockCount)}
          icon={AlertTriangle}
          tone={lowStockCount > 0 ? "warning" : "default"}
        />
        <StatCard label="Zahira qiymati" value={formatCurrency(totalValue)} icon={PackageCheck} />
      </div>

      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nomi</TableHead>
              <TableHead>Birlik</TableHead>
              <TableHead className="text-right">Narx/birlik</TableHead>
              <TableHead className="text-right">UZS ekvivalenti</TableHead>
              <TableHead className="text-right">Hozirgi zahira</TableHead>
              <TableHead className="text-right">Minimal zahira</TableHead>
              <TableHead className="text-center">Holat</TableHead>
              <TableHead className="text-right">Amal</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              [1, 2, 3, 4].map(i => (
                <TableRow key={i}>
                  {[1, 2, 3, 4, 5, 6, 7, 8].map(j => (
                    <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))
            ) : materials.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                  <Boxes className="w-10 h-10 mx-auto mb-2 opacity-20" />
                  Xom ashyolar yo'q. "Qo'shish" tugmasini bosing.
                </TableCell>
              </TableRow>
            ) : (
              materials.map(m => {
                const low = isLowStock(m);
                return (
                  <TableRow key={m.id} className={low ? "bg-red-50/60 hover:bg-red-50" : ""}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {m.name}
                        {!m.active && <Badge variant="secondary" className="text-xs">Nofaol</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{m.unitType}</TableCell>
                    <TableCell className="text-right">
                      {m.currency === "USD"
                        ? `$${m.defaultCost.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : formatCurrency(m.defaultCost)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {m.currency === "USD" ? formatCurrency(m.calculatedUzsCost) : "—"}
                    </TableCell>
                    <TableCell className={`text-right font-medium ${low ? "text-red-600" : ""}`}>
                      {m.currentStock.toLocaleString("ru-RU")} {m.unitType}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {m.minimumStock.toLocaleString("ru-RU")} {m.unitType}
                    </TableCell>
                    <TableCell className="text-center">
                      {low ? (
                        <Badge className="bg-red-100 text-red-700 border border-red-200 hover:bg-red-100 shadow-none">
                          Kam qoldi
                        </Badge>
                      ) : (
                        <Badge className="bg-green-100 text-green-700 border border-green-200 hover:bg-green-100 shadow-none">
                          Yetarli
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Zahirani to'g'rilash"
                          onClick={() => setAdjustTarget(m)}
                        >
                          <Scale className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => openEdit(m)}>
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          onClick={() => setDeleteTarget(m)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <RawMaterialDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        material={editTarget}
      />

      <RawAdjustDialog
        material={adjustTarget}
        onClose={() => setAdjustTarget(null)}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={o => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xom ashyoni o'chirish</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deleteTarget?.name}</strong> o'chiriladi. Bu amalni qaytarib bo'lmaydi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                if (deleteTarget) {
                  deleteMut.mutate(deleteTarget.id, {
                    onSuccess: () => setDeleteTarget(null),
                  });
                }
              }}
            >
              O'chirish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
