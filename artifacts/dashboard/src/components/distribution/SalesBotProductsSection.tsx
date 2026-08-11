import { authFetch } from "@/App";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Bot, Copy, Link2, Pencil, Plus, RotateCcw, Trash2, Zap } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

// ── Savdo (agent) boti katalogi ─────────────────────────────────────────────────
// Bu bo'lim distribution.mahsulotlar jadvalini ko'rsatadi — savdo boti bilan
// BIR XIL ro'yxat: bu yerdagi o'zgarish botda darhol ko'rinadi (va aksincha).

type SavdoProduct = {
  id: number;
  nomi: string;
  narx: number;
  birlik: string;
  faol: boolean;
  sotuvlarSoni: number;
  jamiMiqdor: number;
  jamiSumma: number;
  oxirgiSavdo: string | null;
  erpBor: boolean;
  sku: string;
  erpNomi: string | null;   // SKU orqali bog'langan ERP mahsuloti nomi
  taklifSku: string | null; // nomi mos ERP mahsulotining SKU'si (bog'lash taklifi)
};

const SAVDO_PRODUCTS_KEY = ["savdo-bot-products"];
const ERP_PRODUCTS_KEY = ["v3-products"]; // products.tsx dagi asosiy ro'yxat bilan bir xil kalit

async function readError(res: Response, fallback: string): Promise<never> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new Error(j && typeof j.error === "string" && j.error ? j.error : fallback);
}

function useSavdoProducts() {
  return useQuery<SavdoProduct[]>({
    queryKey: SAVDO_PRODUCTS_KEY,
    queryFn: async () => {
      const res = await authFetch("/api/distribution/products");
      if (!res.ok) throw new Error("Yuklashda xato");
      return res.json();
    },
  });
}

type SaveVars = { nomi: string; narx: number; birlik: string };

function useCreateSavdoProduct() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, SaveVars>({
    mutationFn: async (data) => {
      const res = await authFetch("/api/distribution/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) await readError(res, "Saqlashda xato");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: SAVDO_PRODUCTS_KEY }),
  });
}

type UpdateVars = { id: number; nomi?: string; narx?: number; birlik?: string; faol?: boolean; sku?: string };

function useUpdateSavdoProduct() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, UpdateVars>({
    mutationFn: async ({ id, ...data }) => {
      const res = await authFetch(`/api/distribution/products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) await readError(res, "Saqlashda xato");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: SAVDO_PRODUCTS_KEY }),
  });
}

function useSyncToErp() {
  const qc = useQueryClient();
  return useMutation<{ added: number; names: string[] }, Error, { ids?: number[] }>({
    mutationFn: async (body) => {
      const res = await authFetch("/api/distribution/products/sync-to-erp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body.ids ? { ids: body.ids } : {}),
      });
      if (!res.ok) await readError(res, "Nusxalashda xato");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SAVDO_PRODUCTS_KEY });
      qc.invalidateQueries({ queryKey: ERP_PRODUCTS_KEY });
    },
  });
}

function useAutoLink() {
  const qc = useQueryClient();
  return useMutation<{ linked: number }, Error, void>({
    mutationFn: async () => {
      const res = await authFetch("/api/distribution/products/auto-link", { method: "POST" });
      if (!res.ok) await readError(res, "Bog'lashda xato");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: SAVDO_PRODUCTS_KEY }),
  });
}

// ERP katalogi (SKU tanlash uchun qisqa ro'yxat)
type ErpProductLite = { name: string; sku: string };
function useErpProductsLite() {
  return useQuery<ErpProductLite[]>({
    queryKey: ["erp-products-lite"],
    queryFn: async () => {
      const res = await authFetch("/api/products");
      if (!res.ok) throw new Error("ERP katalogini yuklashda xato");
      const all = (await res.json()) as { name: string; sku: string; active: boolean }[];
      return all.filter((p) => p.sku).map((p) => ({ name: p.name, sku: p.sku }));
    },
  });
}

// ── ERP bilan bog'lash dialogi ─────────────────────────────────────────────────
function LinkDialog({ product, onClose }: { product: SavdoProduct; onClose: () => void }) {
  const [sku, setSku] = useState(product.sku || product.taklifSku || "");
  const { data: erp = [], isLoading } = useErpProductsLite();
  const update = useUpdateSavdoProduct();
  const { toast } = useToast();

  const save = (value: string) =>
    update.mutate(
      { id: product.id, sku: value },
      {
        onSuccess: () => onClose(),
        onError: (e) => toast({ title: "Bog'lashda xato", description: e.message, variant: "destructive" }),
      }
    );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>ERP mahsulotiga bog'lash</DialogTitle>
          <DialogDescription>
            <strong>{product.nomi}</strong> qaysi ERP (zavod) mahsuloti bilan bitta ekanini tanlang —
            SKU orqali narx va hisobotlar bog'lanadi.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Label>ERP mahsuloti (SKU)</Label>
          <Select value={sku} onValueChange={setSku} disabled={isLoading}>
            <SelectTrigger>
              <SelectValue placeholder={isLoading ? "Yuklanmoqda..." : "Tanlang"} />
            </SelectTrigger>
            <SelectContent>
              {erp.map((p) => (
                <SelectItem key={p.sku} value={p.sku}>
                  {p.name} · {p.sku}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {product.taklifSku && !product.sku && (
            <p className="text-xs text-muted-foreground">
              Nomi mos kelgani uchun <span className="font-mono">{product.taklifSku}</span> taklif qilindi.
            </p>
          )}
        </div>
        <DialogFooter className="gap-2">
          {product.sku && (
            <Button variant="outline" disabled={update.isPending} onClick={() => save("")}>
              Bog'lanishni uzish
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>
            Bekor qilish
          </Button>
          <Button onClick={() => sku && save(sku)} disabled={update.isPending || !sku}>
            {update.isPending ? "Saqlanmoqda..." : "Bog'lash"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Tezkor bog'lash rejimi ──────────────────────────────────────────────────────
// Bog'lanmagan mahsulotlarni ketma-ket ko'rsatadi: ERP tanlab bog'lash,
// ERP'da yo'q bo'lsa yaratib bog'lash (sync-to-erp), yoki keyingisiga o'tish.
function QuickLinkDialog({
  queue,
  onClose,
}: {
  queue: SavdoProduct[];
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [doneCount, setDoneCount] = useState(0);
  const [filter, setFilter] = useState("");
  const { data: erp = [], isLoading } = useErpProductsLite();
  const update = useUpdateSavdoProduct();
  const sync = useSyncToErp();
  const { toast } = useToast();

  const product = queue[index] ?? null;
  const pending = update.isPending || sync.isPending;

  const advance = (linked: boolean) => {
    if (linked) setDoneCount((c) => c + 1);
    setFilter("");
    if (index + 1 >= queue.length) onClose();
    else setIndex(index + 1);
  };

  if (!product) return null;

  const norm = (s: string) => s.toLowerCase().replace(/[’ʻʼ']/g, "'");
  const filtered = filter.trim()
    ? erp.filter((p) => norm(p.name).includes(norm(filter)) || norm(p.sku).includes(norm(filter)))
    : erp;

  const linkTo = (sku: string) =>
    update.mutate(
      { id: product.id, sku },
      {
        onSuccess: () => advance(true),
        onError: (e) => toast({ title: "Bog'lashda xato", description: e.message, variant: "destructive" }),
      }
    );

  const createAndLink = () =>
    sync.mutate(
      { ids: [product.id] },
      {
        onSuccess: (r) => {
          toast({
            title:
              r.added > 0
                ? `"${product.nomi}" ERP katalogiga qo'shildi va bog'landi`
                : "ERP'da shu nomli mahsulot allaqachon bor",
          });
          advance(r.added > 0);
        },
        onError: (e) => toast({ title: "Nusxalashda xato", description: e.message, variant: "destructive" }),
      }
    );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" /> Tezkor bog'lash · {index + 1}/{queue.length}
          </DialogTitle>
          <DialogDescription>
            <strong>{product.nomi}</strong>
            <span className="text-muted-foreground"> · {formatCurrency(product.narx)} · {product.birlik}</span>
            {" — "}qaysi ERP (zavod) mahsuloti bilan bitta? Ro'yxatdan tanlang, yo'q bo'lsa yaratib bog'lang.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {product.taklifSku && (
            <Button
              variant="secondary"
              className="w-full justify-start"
              disabled={pending}
              onClick={() => linkTo(product.taklifSku!)}
            >
              <Link2 className="w-4 h-4 mr-2" />
              Taklif: <span className="font-mono ml-1">{product.taklifSku}</span>
              <span className="ml-1 text-muted-foreground">(nomi mos)</span>
            </Button>
          )}
          <Input
            placeholder="ERP mahsulotini qidirish..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
          <div className="max-h-56 overflow-y-auto rounded-md border divide-y">
            {isLoading ? (
              <div className="p-3 text-sm text-muted-foreground">Yuklanmoqda...</div>
            ) : filtered.length === 0 ? (
              <div className="p-3 text-sm text-muted-foreground">Mos ERP mahsuloti topilmadi</div>
            ) : (
              filtered.map((p) => (
                <button
                  key={p.sku}
                  type="button"
                  disabled={pending}
                  onClick={() => linkTo(p.sku)}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-accent disabled:opacity-50 flex items-center justify-between gap-2"
                >
                  <span>{p.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{p.sku}</span>
                </button>
              ))
            )}
          </div>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" disabled={pending} onClick={createAndLink}>
            <Copy className="w-4 h-4 mr-2" /> ERP'da yo'q — yaratib bog'lash
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" disabled={pending} onClick={onClose}>
              Tugatish{doneCount > 0 ? ` (${doneCount} bog'landi)` : ""}
            </Button>
            <Button variant="outline" disabled={pending} onClick={() => advance(false)}>
              Keyingisi →
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Qo'shish / tahrirlash dialogi ───────────────────────────────────────────────
function SavdoProductDialog({ product, onClose }: { product: SavdoProduct | null; onClose: () => void }) {
  const [nomi, setNomi] = useState(product?.nomi ?? "");
  const [narx, setNarx] = useState(product ? String(product.narx) : "");
  const [birlik, setBirlik] = useState(product?.birlik === "kg" ? "kg" : "dona");
  const [localErr, setLocalErr] = useState<string | null>(null);

  const create = useCreateSavdoProduct();
  const update = useUpdateSavdoProduct();
  const pending = create.isPending || update.isPending;
  const serverErr = create.error?.message || update.error?.message || null;

  const submit = () => {
    const narxNum = Number(narx);
    if (!nomi.trim()) {
      setLocalErr("Mahsulot nomi kiritilishi shart");
      return;
    }
    if (!Number.isFinite(narxNum) || narxNum <= 0) {
      setLocalErr("Narx musbat son bo'lishi kerak");
      return;
    }
    setLocalErr(null);
    const vars = { nomi: nomi.trim(), narx: narxNum, birlik };
    if (product) update.mutate({ id: product.id, ...vars }, { onSuccess: onClose });
    else create.mutate(vars, { onSuccess: onClose });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{product ? "Mahsulotni tahrirlash" : "Yangi savdo mahsuloti"}</DialogTitle>
          <DialogDescription>
            Bu ro'yxat savdo (agent) boti bilan umumiy — o'zgarish botda darhol ko'rinadi.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="savdo-nomi">Nomi</Label>
            <Input
              id="savdo-nomi"
              value={nomi}
              onChange={(e) => setNomi(e.target.value)}
              placeholder="Masalan: Tulpor 50 metr"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="savdo-narx">Narx (so'm)</Label>
              <Input
                id="savdo-narx"
                type="number"
                min={0}
                value={narx}
                onChange={(e) => setNarx(e.target.value)}
                placeholder="24000"
              />
            </div>
            <div className="space-y-2">
              <Label>Birlik</Label>
              <Select value={birlik} onValueChange={setBirlik}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dona">dona</SelectItem>
                  <SelectItem value="kg">kg</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {(localErr || serverErr) && (
            <p className="text-sm text-red-600">{localErr || serverErr}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Bekor qilish
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saqlanmoqda..." : "Saqlash"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Asosiy bo'lim ───────────────────────────────────────────────────────────────
export function SalesBotProductsSection() {
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SavdoProduct | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<SavdoProduct | null>(null);
  const [syncAllOpen, setSyncAllOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState<SavdoProduct | null>(null);
  const [quickQueue, setQuickQueue] = useState<SavdoProduct[] | null>(null);

  const { data: items = [], isLoading } = useSavdoProducts();
  const update = useUpdateSavdoProduct();
  const sync = useSyncToErp();
  const autoLink = useAutoLink();
  const { toast } = useToast();

  const faolCount = items.filter((p) => p.faol).length;
  const missing = items.filter((p) => p.faol && !p.erpBor);
  const linkable = items.filter((p) => p.faol && !p.sku && p.taklifSku);
  const unlinked = items.filter((p) => p.faol && !p.sku);

  const runSync = (ids?: number[]) =>
    sync.mutate(ids ? { ids } : {}, {
      onSuccess: (r) => {
        setSyncAllOpen(false);
        toast({
          title:
            r.added > 0
              ? `${r.added} ta mahsulot ERP katalogiga qo'shildi`
              : "Yangi qo'shiladigan mahsulot topilmadi",
        });
      },
      onError: (e) => toast({ title: "Nusxalashda xato", description: e.message, variant: "destructive" }),
    });

  return (
    <div className="mt-10">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Bot className="w-5 h-5 text-primary" /> Savdo bot mahsulotlari
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {isLoading
              ? "Yuklanmoqda..."
              : `${items.length} ta mahsulot · ${faolCount} faol` +
                (missing.length > 0 ? ` · ${missing.length} tasi ERP katalogida yo'q` : "")}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Savdo (agent) botidagi katalog bilan umumiy ro'yxat — bu yerdagi o'zgarish botda darhol ko'rinadi.
          </p>
        </div>
        <div className="flex gap-2">
          {unlinked.length > 0 && (
            <Button onClick={() => setQuickQueue(unlinked)}>
              <Zap className="w-4 h-4 mr-2" /> Tezkor bog'lash ({unlinked.length})
            </Button>
          )}
          {linkable.length > 0 && (
            <Button
              variant="outline"
              disabled={autoLink.isPending}
              onClick={() =>
                autoLink.mutate(undefined, {
                  onSuccess: (r) =>
                    toast({ title: r.linked > 0 ? `${r.linked} ta mahsulot SKU orqali bog'landi` : "Bog'lanadigan mahsulot topilmadi" }),
                  onError: (e) => toast({ title: "Bog'lashda xato", description: e.message, variant: "destructive" }),
                })
              }
            >
              <Link2 className="w-4 h-4 mr-2" /> Avto-bog'lash ({linkable.length})
            </Button>
          )}
          {missing.length > 0 && (
            <Button variant="outline" onClick={() => setSyncAllOpen(true)} disabled={sync.isPending}>
              <Copy className="w-4 h-4 mr-2" /> ERP ga nusxalash ({missing.length})
            </Button>
          )}
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="w-4 h-4 mr-2" /> Yangi mahsulot
          </Button>
        </div>
      </div>

      <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nomi</TableHead>
              <TableHead className="text-right">Narx</TableHead>
              <TableHead>Birlik</TableHead>
              <TableHead className="text-right">Sotuvlar</TableHead>
              <TableHead>Oxirgi savdo</TableHead>
              <TableHead>ERP katalogi</TableHead>
              <TableHead>Holat</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 8 }).map((_c, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-5 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : items.length === 0
                ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                      <Bot className="w-10 h-10 mx-auto mb-2 opacity-20" />
                      Savdo botida mahsulotlar yo'q
                    </TableCell>
                  </TableRow>
                )
                : items.map((p) => (
                    <TableRow key={p.id} className={!p.faol ? "opacity-50" : ""}>
                      <TableCell className="font-medium">{p.nomi}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{formatCurrency(p.narx)}</TableCell>
                      <TableCell className="text-xs">{p.birlik}</TableCell>
                      <TableCell className="text-right text-sm">
                        {p.sotuvlarSoni > 0 ? (
                          <div className="flex flex-col items-end">
                            <span>{p.sotuvlarSoni} ta</span>
                            <span className="text-xs text-muted-foreground font-mono">
                              {formatCurrency(p.jamiSumma)}
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {p.oxirgiSavdo ?? "—"}
                      </TableCell>
                      <TableCell>
                        {p.sku && p.erpNomi ? (
                          <button
                            type="button"
                            title={`Bog'langan: ${p.erpNomi} — o'zgartirish uchun bosing`}
                            onClick={() => setLinkTarget(p)}
                          >
                            <Badge className="bg-green-100 text-green-700 hover:bg-green-200 border border-green-200 shadow-none font-mono cursor-pointer">
                              {p.sku}
                            </Badge>
                          </button>
                        ) : p.erpBor ? (
                          <div className="flex items-center gap-1.5">
                            <Badge className="bg-green-100 text-green-700 hover:bg-green-100 border border-green-200 shadow-none">
                              Bor
                            </Badge>
                            {p.faol && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-6 px-2 text-xs"
                                onClick={() => setLinkTarget(p)}
                              >
                                Bog'lash
                              </Button>
                            )}
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100 border border-amber-200 shadow-none">
                              Yo'q
                            </Badge>
                            {p.faol && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-6 px-2 text-xs"
                                disabled={sync.isPending}
                                onClick={() => runSync([p.id])}
                              >
                                Qo'shish
                              </Button>
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        {p.faol ? (
                          <Badge className="bg-green-100 text-green-700 hover:bg-green-100 border border-green-200 shadow-none">
                            Faol
                          </Badge>
                        ) : (
                          <Badge variant="secondary">Nofaol</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => setEditTarget(p)}
                          >
                            <Pencil className="w-4 h-4" />
                          </Button>
                          {p.faol ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              onClick={() => setDeactivateTarget(p)}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              title="Qayta faollashtirish"
                              disabled={update.isPending}
                              onClick={() =>
                                update.mutate(
                                  { id: p.id, faol: true },
                                  {
                                    onError: (e) =>
                                      toast({
                                        title: "Qayta faollashtirishda xato",
                                        description: e.message,
                                        variant: "destructive",
                                      }),
                                  }
                                )
                              }
                            >
                              <RotateCcw className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
          </TableBody>
        </Table>
      </div>

      {addOpen && <SavdoProductDialog product={null} onClose={() => setAddOpen(false)} />}
      {editTarget && <SavdoProductDialog product={editTarget} onClose={() => setEditTarget(null)} />}
      {linkTarget && <LinkDialog product={linkTarget} onClose={() => setLinkTarget(null)} />}
      {quickQueue && quickQueue.length > 0 && (
        <QuickLinkDialog queue={quickQueue} onClose={() => setQuickQueue(null)} />
      )}

      <AlertDialog open={!!deactivateTarget} onOpenChange={(o) => !o && setDeactivateTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mahsulotni o'chirish</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deactivateTarget?.nomi}</strong> savdo botidagi ro'yxatdan olinadi (nofaol bo'ladi) —
              agentlar uni endi sota olmaydi. Sotuv tarixi saqlanib qoladi va keyin qayta faollashtirish mumkin.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={update.isPending}
              onClick={() => {
                if (!deactivateTarget) return;
                update.mutate(
                  { id: deactivateTarget.id, faol: false },
                  {
                    onSuccess: () => setDeactivateTarget(null),
                    onError: (e) =>
                      toast({ title: "O'chirishda xato", description: e.message, variant: "destructive" }),
                  }
                );
              }}
            >
              {update.isPending ? "O'chirilmoqda..." : "O'chirish"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={syncAllOpen} onOpenChange={setSyncAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>ERP katalogiga nusxalash</AlertDialogTitle>
            <AlertDialogDescription>
              Savdo botidagi <strong>{missing.length} ta</strong> mahsulot ERP katalogiga qo'shiladi
              (bot narxi UZS sotuv narxi sifatida). Keyin ular yuqoridagi asosiy jadvalda ham ko'rinadi
              va xarajat/foyda ma'lumotlarini to'ldirish mumkin bo'ladi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction disabled={sync.isPending} onClick={() => runSync()}>
              {sync.isPending ? "Nusxalanmoqda..." : "Nusxalash"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
