import { authFetch } from "@/App";
import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ChevronDown, ChevronRight, HardHat, Save,
  Package, Search, Pencil, Trash2, Users, AlertCircle,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
type PackerProduct = { productName: string; productId: number; unitType: string };
type Packer        = { packerName: string; products: PackerProduct[] };
type PackerWorkerRow = { packerName: string; chatId: number | null; workers: string[] };

type Worker = { name: string; prefix: string; phone: string; role: string };
type Product = { id: number; name: string; unitType: string; active: boolean };

// ── Query keys ────────────────────────────────────────────────────────────────
const PACKER_ASSIGNMENTS_KEY        = ["packer-assignments"];
const PACKER_WORKER_ASSIGNMENTS_KEY = ["packer-worker-assignments"];
const ALL_PRODUCTS_KEY              = ["v3-products"];
const WORKERS_KEY                   = ["workers"];

// ── Hooks ─────────────────────────────────────────────────────────────────────
function usePackerAssignments() {
  return useQuery<Packer[]>({
    queryKey: PACKER_ASSIGNMENTS_KEY,
    queryFn: async () => {
      const res = await authFetch("/api/packer-assignments");
      if (!res.ok) throw new Error("Yuklashda xato");
      return res.json();
    },
  });
}

function usePackerWorkerAssignments() {
  return useQuery<PackerWorkerRow[]>({
    queryKey: PACKER_WORKER_ASSIGNMENTS_KEY,
    queryFn: async () => {
      const res = await authFetch("/api/packer-worker-assignments");
      if (!res.ok) throw new Error("Yuklashda xato");
      return res.json();
    },
  });
}

function useAllProducts() {
  return useQuery<Product[]>({
    queryKey: ALL_PRODUCTS_KEY,
    queryFn: async () => {
      const res = await authFetch("/api/products");
      if (!res.ok) throw new Error("Yuklashda xato");
      return res.json();
    },
  });
}

function useWorkers() {
  return useQuery<Worker[]>({
    queryKey: WORKERS_KEY,
    queryFn: async () => {
      const res = await authFetch("/api/workers");
      if (!res.ok) throw new Error("Yuklashda xato");
      return res.json();
    },
  });
}

function useSetPackerProducts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ packerName, productNames }: { packerName: string; productNames: string[] }) => {
      const res = await authFetch(`/api/packer-assignments/${encodeURIComponent(packerName)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productNames }),
      });
      if (!res.ok) throw new Error("Saqlashda xato");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PACKER_ASSIGNMENTS_KEY }),
  });
}

function useSetPackerWorkers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ packerName, workerNames }: { packerName: string; workerNames: string[] }) => {
      const res = await authFetch(`/api/packer-worker-assignments/${encodeURIComponent(packerName)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workerNames }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error ?? "Saqlashda xato");
      }
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PACKER_WORKER_ASSIGNMENTS_KEY }),
  });
}

function useUpdateWorker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { currentName: string; name: string; prefix: string; phone: string; role: string }) => {
      const res = await authFetch("/api/workers/update", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error ?? "Yangilashda xato");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: WORKERS_KEY });
      qc.invalidateQueries({ queryKey: PACKER_ASSIGNMENTS_KEY });
    },
  });
}

function useDeleteWorker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await authFetch("/api/workers/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error ?? "O'chirishda xato");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: WORKERS_KEY });
      qc.invalidateQueries({ queryKey: PACKER_ASSIGNMENTS_KEY });
      qc.invalidateQueries({ queryKey: PACKER_WORKER_ASSIGNMENTS_KEY });
    },
  });
}

// ── Edit Dialog ───────────────────────────────────────────────────────────────
function EditPackerDialog({ open, onClose, worker }: { open: boolean; onClose: () => void; worker: Worker }) {
  const [name, setName]     = useState(worker.name);
  const [phone, setPhone]   = useState(worker.phone ?? "");
  const [prefix, setPrefix] = useState(worker.prefix ?? "");
  const updateMut = useUpdateWorker();

  function handleSave() {
    if (!name.trim()) return;
    updateMut.mutate(
      { currentName: worker.name, name: name.trim(), prefix: prefix.trim() || worker.prefix, phone: phone.trim(), role: worker.role },
      { onSuccess: onClose },
    );
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Packerni tahrirlash</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="edit-name">Ism</Label>
            <Input id="edit-name" value={name} onChange={e => setName(e.target.value)} placeholder="Ism familiya" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-phone">Telefon raqami</Label>
            <Input id="edit-phone" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+998901234567" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-prefix">Prefiks (qisqartma)</Label>
            <Input id="edit-prefix" value={prefix} onChange={e => setPrefix(e.target.value.toUpperCase())} placeholder="AB" maxLength={4} />
          </div>
        </div>
        {updateMut.error && <p className="text-xs text-destructive px-0.5">{(updateMut.error as Error).message}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={updateMut.isPending}>Bekor qilish</Button>
          <Button onClick={handleSave} disabled={!name.trim() || updateMut.isPending}>
            {updateMut.isPending ? "Saqlanmoqda..." : "Saqlash"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Delete Confirm ─────────────────────────────────────────────────────────────
function DeletePackerDialog({ open, onClose, worker }: { open: boolean; onClose: () => void; worker: Worker }) {
  const deleteMut = useDeleteWorker();
  return (
    <AlertDialog open={open} onOpenChange={v => !v && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Packerni o'chirish</AlertDialogTitle>
          <AlertDialogDescription>
            <strong>{worker.name}</strong> ni ro'yxatdan o'chirasizmi? Barcha belgilangan mahsulotlar
            ham olib tashlanadi. Bu amalni qaytarib bo'lmaydi.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {deleteMut.error && <p className="text-xs text-destructive px-1">{(deleteMut.error as Error).message}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteMut.isPending}>Bekor qilish</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => deleteMut.mutate(worker.name, { onSuccess: onClose })}
            disabled={deleteMut.isPending}
          >
            {deleteMut.isPending ? "O'chirilmoqda..." : "O'chirish"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Products tab ───────────────────────────────────────────────────────────────
function ProductsTab({ packer, allProducts }: { packer: Packer; allProducts: Product[] }) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(packer.products.map(p => p.productName)),
  );
  const [dirty, setDirty]   = useState(false);
  const [search, setSearch] = useState("");
  const saveMut = useSetPackerProducts();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? allProducts.filter(p => p.name.toLowerCase().includes(q)) : allProducts;
  }, [allProducts, search]);

  function toggle(name: string) {
    setSelected(prev => { const s = new Set(prev); s.has(name) ? s.delete(name) : s.add(name); return s; });
    setDirty(true);
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
        <Input
          placeholder={`${allProducts.length} ta mahsulotda qidirish…`}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-8 h-8 text-sm"
        />
      </div>

      <div className="max-h-[380px] overflow-y-auto rounded-lg border pr-1">
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            <Package className="w-6 h-6 mx-auto mb-1 opacity-30" />Mahsulot topilmadi
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 p-2">
            {filtered.map(product => {
              const checked = selected.has(product.name);
              return (
                <label
                  key={product.name}
                  className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                    checked ? "bg-[#0B5D2A]/5 border-[#0B5D2A]/30" : "border-border hover:bg-muted/30"
                  } ${!product.active ? "opacity-50" : ""}`}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggle(product.name)}
                    className={checked ? "data-[state=checked]:bg-[#0B5D2A] data-[state=checked]:border-[#0B5D2A]" : ""}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{product.name}</div>
                    <div className="text-xs text-muted-foreground">{product.unitType}</div>
                  </div>
                  {!product.active && <Badge variant="secondary" className="text-xs shrink-0">Nofaol</Badge>}
                </label>
              );
            })}
          </div>
        )}
      </div>

      {selected.size === 0 && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          Hech biri tanlanmasa — cheklov olib tashlanadi va packer botda barcha faol mahsulotlarni ko'radi.
        </p>
      )}

      {saveMut.error && (
        <p className="text-xs text-destructive">{(saveMut.error as Error).message}</p>
      )}

      <div className="flex items-center justify-between pt-1 border-t">
        <p className="text-xs text-muted-foreground">{selected.size} ta tanlangan · {allProducts.length} ta jami</p>
        <Button size="sm" onClick={() => saveMut.mutate({ packerName: packer.packerName, productNames: Array.from(selected) }, { onSuccess: () => setDirty(false) })} disabled={!dirty || saveMut.isPending} className={dirty ? "" : "opacity-50"}>
          <Save className="w-3.5 h-3.5 mr-1.5" />
          {saveMut.isPending ? "Saqlanmoqda..." : "Saqlash"}
        </Button>
      </div>
    </div>
  );
}

// ── Workers tab ────────────────────────────────────────────────────────────────
function WorkersTab({
  packerName,
  chatId,
  assignedWorkers,
  allWorkers,
}: {
  packerName: string;
  chatId: number | null;
  assignedWorkers: string[];
  allWorkers: Worker[];
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(assignedWorkers));
  const [dirty, setDirty]   = useState(false);
  const [search, setSearch] = useState("");
  const saveMut = useSetPackerWorkers();

  const nonPackers = useMemo(
    () => allWorkers.filter(w => w.role !== "packer"),
    [allWorkers],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? nonPackers.filter(w => w.name.toLowerCase().includes(q)) : nonPackers;
  }, [nonPackers, search]);

  function toggle(name: string) {
    setSelected(prev => { const s = new Set(prev); s.has(name) ? s.delete(name) : s.add(name); return s; });
    setDirty(true);
  }

  if (!chatId) {
    return (
      <div className="flex items-start gap-3 p-4 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
        <div>
          <p className="font-medium">Packer botdan ro'yxatdan o'tmagan</p>
          <p className="mt-0.5 text-amber-700">Hodimlarni biriktirish uchun packer avval Telegram botga /start bosishi kerak.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
        <Input
          placeholder={`${nonPackers.length} ta hodimda qidirish…`}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-8 h-8 text-sm"
        />
      </div>

      <div className="max-h-[380px] overflow-y-auto rounded-lg border pr-1">
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            <Users className="w-6 h-6 mx-auto mb-1 opacity-30" />Hodim topilmadi
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 p-2">
            {filtered.map(worker => {
              const checked = selected.has(worker.name);
              return (
                <label
                  key={worker.name}
                  className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                    checked ? "bg-[#0B5D2A]/5 border-[#0B5D2A]/30" : "border-border hover:bg-muted/30"
                  }`}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggle(worker.name)}
                    className={checked ? "data-[state=checked]:bg-[#0B5D2A] data-[state=checked]:border-[#0B5D2A]" : ""}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{worker.name}</div>
                    {worker.phone && <div className="text-xs text-muted-foreground">{worker.phone}</div>}
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </div>

      {saveMut.error && (
        <p className="text-xs text-destructive">{(saveMut.error as Error).message}</p>
      )}

      <div className="flex items-center justify-between pt-1 border-t">
        <p className="text-xs text-muted-foreground">{selected.size} ta tanlangan · {nonPackers.length} ta jami</p>
        <Button
          size="sm"
          onClick={() => saveMut.mutate({ packerName, workerNames: Array.from(selected) }, { onSuccess: () => setDirty(false) })}
          disabled={!dirty || saveMut.isPending}
          className={dirty ? "" : "opacity-50"}
        >
          <Save className="w-3.5 h-3.5 mr-1.5" />
          {saveMut.isPending ? "Saqlanmoqda..." : "Saqlash"}
        </Button>
      </div>
    </div>
  );
}

// ── Packer card ───────────────────────────────────────────────────────────────
function PackerCard({
  packer,
  workerRow,
  worker,
  allProducts,
  allWorkers,
}: {
  packer: Packer;
  workerRow: PackerWorkerRow | undefined;
  worker: Worker | undefined;
  allProducts: Product[];
  allWorkers: Worker[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [editOpen, setEditOpen]     = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const initials = packer.packerName
    .split(" ")
    .map(w => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  const productCount = packer.products.length;
  const workerCount  = workerRow?.workers.length ?? 0;

  return (
    <>
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        {/* Header row */}
        <div className="w-full flex items-center gap-4 px-5 py-4">
          <button
            type="button"
            className="flex items-center gap-4 flex-1 min-w-0 text-left hover:opacity-80 transition-opacity"
            onClick={() => setExpanded(e => !e)}
          >
            <div className="w-10 h-10 rounded-full bg-[#0B5D2A] flex items-center justify-center text-white font-bold text-sm shrink-0">
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold">{packer.packerName}</div>
              <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
                {worker?.phone && <span>{worker.phone}</span>}
                <span>{productCount} mahsulot · {workerCount} hodim</span>
              </div>
            </div>
          </button>

          <div className="flex items-center gap-1.5 shrink-0">
            {workerCount > 0 && (
              <Badge className="bg-blue-100 text-blue-700 border border-blue-200 hover:bg-blue-100 shadow-none text-xs hidden sm:inline-flex">
                <Users className="w-3 h-3 mr-1" />{workerCount}
              </Badge>
            )}
            {productCount > 0 && (
              <Badge className="bg-green-100 text-green-700 border border-green-200 hover:bg-green-100 shadow-none text-xs hidden sm:inline-flex">
                <Package className="w-3 h-3 mr-1" />{productCount}
              </Badge>
            )}
            <Button size="icon" variant="ghost" className="w-8 h-8 text-muted-foreground hover:text-foreground"
              onClick={e => { e.stopPropagation(); setEditOpen(true); }} title="Tahrirlash">
              <Pencil className="w-3.5 h-3.5" />
            </Button>
            <Button size="icon" variant="ghost" className="w-8 h-8 text-muted-foreground hover:text-destructive"
              onClick={e => { e.stopPropagation(); setDeleteOpen(true); }} title="O'chirish">
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
            <button type="button" className="p-1 text-muted-foreground" onClick={() => setExpanded(e => !e)}>
              {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Expanded section with tabs */}
        {expanded && (
          <div className="border-t px-5 py-4">
            <Tabs defaultValue="products">
              <TabsList className="mb-4 w-full">
                <TabsTrigger value="products" className="flex-1">
                  <Package className="w-3.5 h-3.5 mr-1.5" />
                  Mahsulotlar
                  {productCount > 0 && (
                    <Badge className="ml-1.5 h-4 px-1.5 text-[10px] bg-green-100 text-green-700 border-green-200 shadow-none hover:bg-green-100">
                      {productCount}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="workers" className="flex-1">
                  <Users className="w-3.5 h-3.5 mr-1.5" />
                  Hodimlar
                  {workerCount > 0 && (
                    <Badge className="ml-1.5 h-4 px-1.5 text-[10px] bg-blue-100 text-blue-700 border-blue-200 shadow-none hover:bg-blue-100">
                      {workerCount}
                    </Badge>
                  )}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="products">
                <ProductsTab packer={packer} allProducts={allProducts} />
              </TabsContent>

              <TabsContent value="workers">
                <WorkersTab
                  packerName={packer.packerName}
                  chatId={workerRow?.chatId ?? null}
                  assignedWorkers={workerRow?.workers ?? []}
                  allWorkers={allWorkers}
                />
              </TabsContent>
            </Tabs>
          </div>
        )}
      </div>

      {worker && <EditPackerDialog open={editOpen} onClose={() => setEditOpen(false)} worker={worker} />}
      {worker && <DeletePackerDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} worker={worker} />}
    </>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function Packers() {
  const { data: packers = [],     isLoading: packersLoading }  = usePackerAssignments();
  const { data: workerRows = [],  isLoading: workerRowsLoading } = usePackerWorkerAssignments();
  const { data: allProducts = [], isLoading: productsLoading } = useAllProducts();
  const { data: workers = [] }                                 = useWorkers();

  const isLoading = packersLoading || productsLoading || workerRowsLoading;
  const activeProducts = useMemo(() => allProducts.filter(p => p.active), [allProducts]);

  const workerByName = useMemo(() => {
    const m: Record<string, Worker> = {};
    for (const w of workers) m[w.name] = w;
    return m;
  }, [workers]);

  const workerRowByName = useMemo(() => {
    const m: Record<string, PackerWorkerRow> = {};
    for (const r of workerRows) m[r.packerName] = r;
    return m;
  }, [workerRows]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <HardHat className="w-6 h-6 text-primary" /> Packerlar
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isLoading ? "Yuklanmoqda..." : `${packers.length} ta packer · ${activeProducts.length} ta mahsulot`}
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="rounded-xl border bg-card p-5">
              <div className="flex items-center gap-4">
                <Skeleton className="w-10 h-10 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : packers.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <HardHat className="w-12 h-12 mx-auto mb-3 opacity-20" />
          <p className="font-medium">Packerlar ro'yxati bo'sh</p>
          <p className="text-sm mt-1">Ishchilar sahifasida rol = "packer" ga o'rnating</p>
        </div>
      ) : (
        <div className="space-y-3">
          {packers.map(packer => (
            <PackerCard
              key={packer.packerName}
              packer={packer}
              workerRow={workerRowByName[packer.packerName]}
              worker={workerByName[packer.packerName]}
              allProducts={activeProducts}
              allWorkers={workers}
            />
          ))}
        </div>
      )}
    </div>
  );
}
