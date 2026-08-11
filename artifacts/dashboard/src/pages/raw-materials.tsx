import { authFetch } from "@/App";
import { useState, useMemo, useEffect, Fragment } from "react";
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
import { Plus, Trash2, Pencil, Boxes, AlertTriangle, PackageCheck, Scale, History, ArrowDownToLine, ArrowUpFromLine, GitCompareArrows } from "lucide-react";
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

type ReconcileItem = {
  id: number;
  name: string;
  unit: string;
  currentStock: number;
  ledgerSum: number;
  gap: number;
  hasMismatch: boolean;
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
const RAW_MATERIALS_KEY  = ["raw-materials"];
const RAW_HISTORY_KEY    = ["raw-history"];
const RAW_RECONCILE_KEY  = ["raw-reconcile"];

// ── Helpers ───────────────────────────────────────────────────────────────────
function isLowStock(rm: RawMaterial): boolean {
  return rm.minimumStock > 0 && rm.currentStock <= rm.minimumStock;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
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

function useRawReconcile() {
  return useQuery<ReconcileItem[]>({
    queryKey: RAW_RECONCILE_KEY,
    queryFn: async () => {
      const res = await authFetch("/api/ombor/raw-reconcile");
      if (!res.ok) throw new Error("Solishtirishda xato");
      return res.json();
    },
    // Refresh every 2 minutes; not critical to be real-time
    staleTime: 2 * 60 * 1000,
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: RAW_MATERIALS_KEY });
      qc.invalidateQueries({ queryKey: RAW_HISTORY_KEY });
      qc.invalidateQueries({ queryKey: RAW_RECONCILE_KEY });
    },
  });
}

function useResolveReconcile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ materialId, note }: { materialId: number; note: string }) => {
      const res = await authFetch("/api/ombor/raw-reconcile-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ materialId, note }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Farqni yopishda xato");
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: RAW_MATERIALS_KEY });
      qc.invalidateQueries({ queryKey: RAW_HISTORY_KEY });
      qc.invalidateQueries({ queryKey: RAW_RECONCILE_KEY });
    },
  });
}

// ── Stock movement history (per material) ──────────────────────────────────────
type RawMovement = {
  id: number;
  product: string;
  quantity: number;
  movementType: string;
  note: string;
  createdBy: string;
  createdAt: string;
  balanceAfter: number | null;
};

function useRawHistory(name: string | null) {
  return useQuery<RawMovement[]>({
    queryKey: [...RAW_HISTORY_KEY, name],
    enabled: !!name,
    queryFn: async () => {
      const res = await authFetch(
        `/api/ombor/movements?type=raw&limit=10&product=${encodeURIComponent(name!)}`,
      );
      if (!res.ok) throw new Error("Tarixni yuklashda xato");
      return res.json();
    },
  });
}

// To'liq ledger tafsiloti (rekonsiliatsiya ko'rinishi): balans 0 dan boshlab
// oldinga hisoblanadi — oxirgi qator balansi ledger yig'indisiga teng bo'ladi.
function useRawLedger(name: string | null) {
  return useQuery<RawMovement[]>({
    queryKey: [...RAW_HISTORY_KEY, "ledger", name],
    enabled: !!name,
    queryFn: async () => {
      const res = await authFetch(
        `/api/ombor/movements?type=raw&balance=ledger&limit=1000&product=${encodeURIComponent(name!)}`,
      );
      if (!res.ok) throw new Error("Ledger tarixini yuklashda xato");
      return res.json();
    },
  });
}

// ── Ledger breakdown (reconciliation drilldown) dialog ────────────────────────
function RawLedgerDialog({
  material, reconcile, onClose, onResolve,
}: {
  material: RawMaterial | null;
  reconcile: ReconcileItem | null;
  onClose: () => void;
  onResolve: (m: RawMaterial) => void;
}) {
  const { data: moves = [], isLoading } = useRawLedger(material?.name ?? null);
  if (!material) return null;

  // API newest-first qaytaradi — jadvalda eng eskisidan boshlab ko'rsatamiz.
  const ordered = [...moves].reverse();
  const lastBalance = [...ordered].reverse().find(m => m.balanceAfter != null)?.balanceAfter ?? 0;
  const gap = material.currentStock - lastBalance;
  const hasMismatch = Math.abs(gap) > 0.001;
  const unit = material.unitType;
  const fmt = (n: number) => n.toLocaleString("ru-RU", { maximumFractionDigits: 3 });

  return (
    <Dialog open={!!material} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitCompareArrows className="w-5 h-5 text-amber-600" /> Ledger tafsiloti — {material.name}
          </DialogTitle>
          <DialogDescription>
            Barcha harakatlar va yig'ilib boruvchi balans. Kulrang qatorlar global zahiraga
            ta'sir qilmaydi (konteyner ichki harakatlari).
          </DialogDescription>
        </DialogHeader>

        {moves.length >= 1000 && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
            Faqat so'nggi 1000 ta harakat ko'rsatilmoqda. Balans ustuni ko'rsatilmagan eski
            yozuvlarni ham hisobga oladi, shuning uchun yakuniy qiymatlar to'g'ri.
          </div>
        )}

        <div className="flex-1 overflow-y-auto rounded-lg border">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-5 w-full" />)}
            </div>
          ) : ordered.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">Harakatlar tarixi yo'q</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sana</TableHead>
                  <TableHead>Harakat</TableHead>
                  <TableHead className="text-right">Miqdor</TableHead>
                  <TableHead>Tuzatish / izoh</TableHead>
                  <TableHead>Kim</TableHead>
                  <TableHead className="text-right">Balans</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ordered.map(mv => {
                  const isIn = mv.movementType === "IN";
                  const containerOnly = mv.balanceAfter == null;
                  return (
                    <TableRow key={mv.id} className={containerOnly ? "opacity-50" : ""}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDateTime(mv.createdAt)}
                      </TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center gap-1 text-xs font-medium ${
                          mv.movementType === "TRANSFER" ? "text-muted-foreground"
                            : isIn ? "text-green-700" : "text-red-700"
                        }`}>
                          {mv.movementType === "TRANSFER" ? (
                            <GitCompareArrows className="w-3.5 h-3.5" />
                          ) : isIn ? (
                            <ArrowDownToLine className="w-3.5 h-3.5" />
                          ) : (
                            <ArrowUpFromLine className="w-3.5 h-3.5" />
                          )}
                          {mv.movementType}
                        </span>
                      </TableCell>
                      <TableCell className={`text-right font-medium ${
                        containerOnly ? "" : isIn ? "text-green-700" : "text-red-700"
                      }`}>
                        {containerOnly ? fmt(mv.quantity) : `${isIn ? "+" : "−"}${fmt(mv.quantity)}`}
                      </TableCell>
                      <TableCell className="max-w-[260px] text-sm text-muted-foreground break-words">
                        {mv.note || "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {mv.createdBy || "—"}
                      </TableCell>
                      <TableCell className="text-right font-medium whitespace-nowrap">
                        {containerOnly ? (
                          <span className="text-xs text-muted-foreground">ta'sir yo'q</span>
                        ) : (
                          <>{fmt(mv.balanceAfter!)} {unit}</>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>

        {!isLoading && (
          <div className={`rounded-lg border p-3 text-sm space-y-1.5 ${
            hasMismatch ? "border-amber-300 bg-amber-50" : "border-green-200 bg-green-50"
          }`}>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Ledger yakuniy balansi</span>
              <span className="font-medium">{fmt(lastBalance)} {unit}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Hozirgi zahira</span>
              <span className="font-medium">{fmt(material.currentStock)} {unit}</span>
            </div>
            <div className="flex justify-between gap-4 border-t pt-1.5">
              <span className={hasMismatch ? "font-semibold text-amber-800" : "text-muted-foreground"}>
                Farq
              </span>
              <span className={`font-semibold ${hasMismatch ? "text-amber-800" : "text-green-700"}`}>
                {hasMismatch
                  ? `${gap > 0 ? "+" : ""}${fmt(gap)} ${unit} — mos kelmaydi`
                  : "0 — mos keladi ✓"}
              </span>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Yopish</Button>
          {hasMismatch && (
            <Button
              className="bg-amber-600 hover:bg-amber-700 text-white"
              onClick={() => { onClose(); onResolve(material); }}
              disabled={!reconcile}
            >
              Farqni yopish
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RawHistoryRow({ name, unit }: { name: string; unit: string }) {
  const { data: moves = [], isLoading } = useRawHistory(name);
  return (
    <TableRow className="bg-muted/30 hover:bg-muted/30">
      <TableCell colSpan={8} className="py-3">
        <div className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
          <History className="w-3.5 h-3.5" /> So'nggi to'g'rilashlar / harakatlar
        </div>
        {isLoading ? (
          <Skeleton className="h-4 w-48" />
        ) : moves.length === 0 ? (
          <div className="text-sm text-muted-foreground py-1">Harakatlar tarixi yo'q</div>
        ) : (
          <ul className="space-y-1.5">
            {moves.map(mv => {
              const isIn = mv.movementType === "IN";
              return (
                <li key={mv.id} className="flex items-center gap-2 text-sm">
                  {isIn ? (
                    <ArrowDownToLine className="w-3.5 h-3.5 text-green-600 shrink-0" />
                  ) : (
                    <ArrowUpFromLine className="w-3.5 h-3.5 text-red-600 shrink-0" />
                  )}
                  <span className={`font-medium ${isIn ? "text-green-700" : "text-red-700"}`}>
                    {isIn ? "+" : "−"}{mv.quantity.toLocaleString("ru-RU")}
                  </span>
                  {mv.balanceAfter != null && (
                    <span className="font-medium text-foreground whitespace-nowrap">
                      → {mv.balanceAfter.toLocaleString("ru-RU")} {unit}
                    </span>
                  )}
                  {mv.note && <span className="text-muted-foreground">· {mv.note}</span>}
                  <span className="text-muted-foreground ml-auto whitespace-nowrap">
                    {mv.createdBy || "—"} · {formatDateTime(mv.createdAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </TableCell>
    </TableRow>
  );
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

// ── Reconcile-resolve dialog ──────────────────────────────────────────────────
// This dialog closes a ledger gap by writing a single baseline-correction
// movement WITHOUT changing current_stock. That is the only operation that can
// actually make gap → 0: raw-adjust changes both stock and ledger by the same
// delta, so the gap stays invariant.
function RawReconcileResolveDialog({
  material,
  reconcile,
  onClose,
}: {
  material: RawMaterial | null;
  reconcile: ReconcileItem | null;
  onClose: () => void;
}) {
  const resolveMut = useResolveReconcile();
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (material) {
      setNote("");
      setErr("");
      resolveMut.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [material?.id]);

  if (!material || !reconcile) return null;

  const gap = reconcile.gap;
  const absGap = Math.abs(gap);
  const direction = gap > 0 ? "IN (kirdi)" : "OUT (chiqdi)";
  const directionColor = gap > 0 ? "text-green-700" : "text-red-700";

  function submit() {
    if (!material) return;
    setErr("");
    resolveMut.mutate(
      { materialId: material.id, note },
      { onSuccess: onClose, onError: (e: unknown) => setErr(e instanceof Error ? e.message : "Xato") },
    );
  }

  return (
    <Dialog open={!!material} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitCompareArrows className="w-5 h-5 text-amber-600" /> Tarixi mos kelmaydigan farqni yopish
          </DialogTitle>
          <DialogDescription>
            <strong>{material.name}</strong> uchun harakat tarixi va hozirgi zahira orasidagi farqni yopuvchi
            bitta tuzatish yozuvi qo'shiladi. Zahira o'ZGARMAYDI.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border bg-muted/40 p-4 text-sm space-y-2">
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Hozirgi zahira</span>
            <span className="font-medium">{reconcile.currentStock.toLocaleString("ru-RU")} {material.unitType}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Ledger yig'indisi</span>
            <span className="font-medium">{reconcile.ledgerSum.toLocaleString("ru-RU", { maximumFractionDigits: 3 })} {material.unitType}</span>
          </div>
          <div className="flex justify-between gap-4 border-t pt-2">
            <span className="text-muted-foreground">Yoziladigan tuzatish</span>
            <span className={`font-semibold ${directionColor}`}>
              {absGap.toLocaleString("ru-RU", { maximumFractionDigits: 3 })} {material.unitType} · {direction}
            </span>
          </div>
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium">
            Izoh (ixtiyoriy)
            <Input
              className="mt-1"
              placeholder="Masalan: BOM tahrirlangan, eski partiyalar tiklandi…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={resolveMut.isPending}>
            Bekor qilish
          </Button>
          <Button
            onClick={submit}
            disabled={resolveMut.isPending}
            className="bg-amber-600 hover:bg-amber-700 text-white"
          >
            {resolveMut.isPending ? "Yozilmoqda…" : "Farqni yopish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Mismatch gap badge ────────────────────────────────────────────────────────
function GapBadge({ item, unit, onClick }: { item: ReconcileItem; unit: string; onClick: () => void }) {
  const abs = Math.abs(item.gap);
  const sign = item.gap > 0 ? "+" : "−";
  return (
    <button
      onClick={onClick}
      title={`Ledger yig'indisi: ${item.ledgerSum.toLocaleString("ru-RU")} ${unit} | Hozirgi zahira: ${item.currentStock.toLocaleString("ru-RU")} ${unit} | Farq: ${item.gap > 0 ? "+" : ""}${item.gap.toLocaleString("ru-RU", { maximumFractionDigits: 3 })} ${unit}. Farqni yopish uchun bosing.`}
      className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-100 transition-colors cursor-pointer"
    >
      <GitCompareArrows className="w-3 h-3 shrink-0" />
      {sign}{abs.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} {unit}
    </button>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function RawMaterials() {
  const { data: materials = [], isLoading } = useRawMaterials();
  const { data: reconcile = [] } = useRawReconcile();
  const deleteMut = useDeleteRawMaterial();

  // Build a fast id→reconcile lookup
  const reconcileMap = useMemo(
    () => Object.fromEntries(reconcile.map(r => [r.id, r])),
    [reconcile],
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<RawMaterial | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RawMaterial | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<RawMaterial | null>(null);
  const [resolveTarget, setResolveTarget] = useState<RawMaterial | null>(null);
  const [ledgerTarget, setLedgerTarget] = useState<RawMaterial | null>(null);
  const [historyId, setHistoryId] = useState<number | null>(null);

  const lowStockCount = useMemo(
    () => materials.filter(isLowStock).length,
    [materials],
  );
  const mismatchCount = useMemo(
    () => reconcile.filter(r => r.hasMismatch).length,
    [reconcile],
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
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <span>
            <strong>{lowStockCount} ta</strong> xom ashyo minimal zahiradan kam yoki teng — to'ldirish kerak.
          </span>
        </div>
      )}

      {mismatchCount > 0 && (
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <GitCompareArrows className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <strong>{mismatchCount} ta</strong> xom ashyo uchun harakat tarixi va hozirgi zahira mos kelmayapti.
            {" "}Sariq badge'li qatorlarda farqni ko'rib, <strong>Tuzatish</strong> orqali yopishingiz mumkin.
          </div>
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
                const rec = reconcileMap[m.id] as ReconcileItem | undefined;
                const hasMismatch = rec?.hasMismatch ?? false;
                return (
                  <Fragment key={m.id}>
                  <TableRow className={low ? "bg-red-50/60 hover:bg-red-50" : ""}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2 flex-wrap">
                        {m.name}
                        {!m.active && <Badge variant="secondary" className="text-xs">Nofaol</Badge>}
                        {hasMismatch && rec && (
                          <GapBadge
                            item={rec}
                            unit={m.unitType}
                            onClick={() => setLedgerTarget(m)}
                          />
                        )}
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
                          title={hasMismatch ? "Ledger tafsiloti" : "Harakatlar tarixi"}
                          className={historyId === m.id ? "bg-muted" : ""}
                          onClick={() =>
                            hasMismatch
                              ? setLedgerTarget(m)
                              : setHistoryId(prev => (prev === m.id ? null : m.id))
                          }
                        >
                          <History className="w-4 h-4" />
                        </Button>
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
                  {historyId === m.id && <RawHistoryRow name={m.name} unit={m.unitType} />}
                  </Fragment>
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

      <RawLedgerDialog
        material={ledgerTarget}
        reconcile={ledgerTarget ? (reconcileMap[ledgerTarget.id] as ReconcileItem ?? null) : null}
        onClose={() => setLedgerTarget(null)}
        onResolve={(m) => setResolveTarget(m)}
      />

      <RawReconcileResolveDialog
        material={resolveTarget}
        reconcile={resolveTarget ? (reconcileMap[resolveTarget.id] as ReconcileItem ?? null) : null}
        onClose={() => setResolveTarget(null)}
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
