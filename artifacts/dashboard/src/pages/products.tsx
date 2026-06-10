import { authFetch } from "@/App";
import { useState } from "react";
import { useGetProducts, getGetProductsQueryKey, useCreateProduct, useDeleteProduct } from "@workspace/api-client-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Trash2, Package, ShoppingCart, Pencil, AlertTriangle, ChevronDown, ChevronRight, Layers } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

// ── Types ─────────────────────────────────────────────────────────────────────
type Tier = { id: number; minQty: number; price: number; currency: string };
type SalesProduct = {
  id: number; name: string; saleType: string;
  defaultPrice: number; currency: string; tiers: Tier[];
};

// ── Schemas ───────────────────────────────────────────────────────────────────
const prodFormSchema = z.object({
  name:     z.string().min(1, "Mahsulot nomi kiritilishi shart"),
  rateType: z.enum(["per_kg", "per_piece"]),
  rate:     z.coerce.number().min(0),
});

const salesFormSchema = z.object({
  name:         z.string().min(1, "Nomi kiritilishi shart"),
  saleType:     z.enum(["dona", "kg"]),
  defaultPrice: z.coerce.number().min(0),
  currency:     z.enum(["UZS", "USD"]),
});

// ── Local tier row type (for "add" form) ──────────────────────────────────────
// fromQty → minQty (DB), toQty → display only
type LocalTier = { fromQty: string; toQty: string; price: string };

const SALES_PRODUCTS_KEY = ["sales-products"];

// ── Hooks ─────────────────────────────────────────────────────────────────────
function useSalesProducts() {
  return useQuery<SalesProduct[]>({
    queryKey: SALES_PRODUCTS_KEY,
    queryFn: async () => {
      const res = await authFetch("/api/sales-products");
      if (!res.ok) throw new Error("Fetch failed");
      return res.json();
    },
  });
}

function useCreateSalesProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string; saleType: string; defaultPrice: number; currency: string; tiers: LocalTier[] }) => {
      const res = await authFetch("/api/sales-products", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.name, saleType: data.saleType,
          defaultPrice: data.defaultPrice, currency: data.currency,
          tiers: data.tiers
            .filter(t => t.fromQty !== "" && t.price !== "")
            .map(t => ({ minQty: Number(t.fromQty), price: Number(t.price), currency: data.currency })),
        }),
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: SALES_PRODUCTS_KEY }),
  });
}

function useUpdateSalesProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...data }: { id: number; name: string; saleType: string; defaultPrice: number; currency: string }) => {
      const res = await authFetch(`/api/sales-products/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: SALES_PRODUCTS_KEY }),
  });
}

function useDeleteSalesProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => { await authFetch(`/api/sales-products/${id}`, { method: "DELETE" }); },
    onSuccess: () => qc.invalidateQueries({ queryKey: SALES_PRODUCTS_KEY }),
  });
}

function useAddTier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ productId, minQty, price, currency }: { productId: number; minQty: number; price: number; currency: string }) => {
      const res = await authFetch(`/api/sales-products/${productId}/tiers`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minQty, price, currency }),
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: SALES_PRODUCTS_KEY }),
  });
}

function useDeleteTier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ productId, tierId }: { productId: number; tierId: number }) => {
      await authFetch(`/api/sales-products/${productId}/tiers/${tierId}`, { method: "DELETE" });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: SALES_PRODUCTS_KEY }),
  });
}

// ── TierManager: inline tier add/remove panel ─────────────────────────────────
function TierManager({ product }: { product: SalesProduct }) {
  const [fromQty, setFromQty] = useState("");
  const [toQty,   setToQty]   = useState("");
  const [price,   setPrice]   = useState("");
  const addTier    = useAddTier();
  const deleteTier = useDeleteTier();

  const sym  = product.currency === "USD" ? "$" : "so'm";
  const unit = product.saleType === "kg" ? "kg" : "dona";

  // Sort ascending for range display
  const sorted = [...product.tiers].sort((a, b) => a.minQty - b.minQty);

  function rangeLabel(idx: number) {
    const t    = sorted[idx];
    const next = sorted[idx + 1];
    const from = t.minQty.toLocaleString();
    if (next) {
      const to = (next.minQty - 1).toLocaleString();
      return `${from} – ${to} ${unit}`;
    }
    return `${from} ${unit} va undan ko'p`;
  }

  function handleAdd() {
    if (!fromQty || !price) return;
    addTier.mutate(
      { productId: product.id, minQty: Number(fromQty), price: Number(price), currency: product.currency },
      { onSuccess: () => { setFromQty(""); setToQty(""); setPrice(""); } },
    );
  }

  // Auto-fill "gacha" when "dan" changes: suggest next round number
  function handleFromChange(v: string) {
    setFromQty(v);
    if (v && !toQty) {
      const n = Number(v);
      if (!isNaN(n) && n > 0) {
        // suggest "from+999" or round up
        setToQty(String(n + 999));
      }
    }
  }

  return (
    <div className="space-y-3">
      {sorted.length > 0 ? (
        <div className="rounded-md border divide-y overflow-hidden">
          <div className="grid grid-cols-[1.8fr_1fr_auto] text-xs text-muted-foreground px-3 py-1.5 bg-muted/40 font-medium">
            <span>Miqdor oralig'i</span>
            <span>Narx</span>
            <span />
          </div>
          {sorted.map((t, idx) => (
            <div key={t.id} className="grid grid-cols-[1.8fr_1fr_auto] items-center px-3 py-2 text-sm">
              <span className="font-mono text-xs">{rangeLabel(idx)}</span>
              <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-400">
                {t.currency === "USD" ? `$${t.price}` : formatCurrency(t.price)}
              </span>
              <Button
                variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                onClick={() => deleteTier.mutate({ productId: product.id, tierId: t.id })}
                disabled={deleteTier.isPending}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground py-2">
          Tier narxlar yo'q — barcha miqdor uchun asosiy narx qo'llaniladi.
        </p>
      )}

      {/* Add row */}
      <div className="rounded-md border p-3 bg-muted/10 space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Yangi oraliq qo'shish</p>
        <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Dan ({unit})</label>
            <Input
              type="number" min={0} step="any" placeholder="1"
              value={fromQty} onChange={e => handleFromChange(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Gacha ({unit})</label>
            <Input
              type="number" min={0} step="any" placeholder="1000"
              value={toQty} onChange={e => setToQty(e.target.value)}
              className="h-8 text-sm text-muted-foreground"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Narx ({sym})</label>
            <Input
              type="number" min={0} step="0.01" placeholder="2.5"
              value={price} onChange={e => setPrice(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <Button
            size="sm" variant="default" onClick={handleAdd}
            disabled={!fromQty || !price || addTier.isPending}
            className="h-8"
          >
            <Plus className="w-3.5 h-3.5" />
          </Button>
        </div>
        {fromQty && toQty && price && (
          <p className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">
            Preview: {Number(fromQty).toLocaleString()} – {Number(toQty).toLocaleString()} {unit} → {product.currency === "USD" ? `$${price}` : `${price} so'm`}
          </p>
        )}
        {fromQty && !toQty && price && (
          <p className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">
            Preview: {Number(fromQty).toLocaleString()} {unit} va undan ko'p → {product.currency === "USD" ? `$${price}` : `${price} so'm`}
          </p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        ℹ️ Bot savdoda kiritilgan miqdorga qarab eng mos narxni avtomatik tanlaydi.
      </p>
    </div>
  );
}

// ── LocalTierEditor: for "create" form (before product is saved) ──────────────
function LocalTierEditor({
  tiers, currency, saleType, onChange,
}: {
  tiers: LocalTier[]; currency: string; saleType: string;
  onChange: (tiers: LocalTier[]) => void;
}) {
  const sym  = currency === "USD" ? "$" : "so'm";
  const unit = saleType === "kg" ? "kg" : "dona";

  function addRow() { onChange([...tiers, { fromQty: "", toQty: "", price: "" }]); }
  function removeRow(i: number) { onChange(tiers.filter((_, idx) => idx !== i)); }
  function update(i: number, field: keyof LocalTier, val: string) {
    const updated = tiers.map((t, idx) => idx === i ? { ...t, [field]: val } : t);
    // Auto-fill next row's "dan" from current row's "gacha" + 1
    if (field === "toQty" && val && updated[i + 1] !== undefined && !updated[i + 1].fromQty) {
      const nextFrom = String(Number(val) + 1);
      updated[i + 1] = { ...updated[i + 1], fromQty: nextFrom };
    }
    onChange(updated);
  }

  return (
    <div className="space-y-2">
      {tiers.length > 0 && (
        <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 text-xs text-muted-foreground px-0.5">
          <span>Dan ({unit})</span>
          <span>Gacha ({unit})</span>
          <span>Narx ({sym})</span>
          <span />
        </div>
      )}
      {tiers.map((t, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center">
          <Input
            type="number" min={0} step="any" placeholder="1"
            value={t.fromQty} onChange={e => update(i, "fromQty", e.target.value)}
            className="h-8 text-sm"
          />
          <Input
            type="number" min={0} step="any" placeholder="999"
            value={t.toQty} onChange={e => update(i, "toQty", e.target.value)}
            className="h-8 text-sm text-muted-foreground"
          />
          <Input
            type="number" min={0} step="0.01" placeholder="2.5"
            value={t.price} onChange={e => update(i, "price", e.target.value)}
            className="h-8 text-sm"
          />
          <Button
            variant="ghost" size="icon"
            className="h-8 w-8 text-destructive hover:text-destructive"
            onClick={() => removeRow(i)}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      ))}
      {/* Preview */}
      {tiers.some(t => t.fromQty && t.price) && (
        <div className="rounded bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 px-3 py-2 space-y-0.5">
          {tiers.filter(t => t.fromQty && t.price).map((t, i) => {
            const priceLabel = currency === "USD" ? `$${t.price}` : `${t.price} so'm`;
            const range = t.toQty
              ? `${Number(t.fromQty).toLocaleString()} – ${Number(t.toQty).toLocaleString()} ${unit}`
              : `${Number(t.fromQty).toLocaleString()} ${unit}+`;
            return (
              <p key={i} className="text-xs text-emerald-700 dark:text-emerald-400 font-mono">
                {range} → {priceLabel}
              </p>
            );
          })}
        </div>
      )}
      <Button variant="outline" size="sm" type="button" onClick={addRow} className="h-7 text-xs">
        <Plus className="w-3 h-3 mr-1" /> Tier narx qo'shish
      </Button>
    </div>
  );
}

// ── Edit modal ────────────────────────────────────────────────────────────────
function EditSalesProductModal({ product }: { product: SalesProduct }) {
  const [open, setOpen]           = useState(false);
  const [warnOpen, setWarnOpen]   = useState(false);
  const [pendingValues, setPendingValues] = useState<z.infer<typeof salesFormSchema> | null>(null);
  const [tab, setTab] = useState<"info" | "tiers">("info");
  const updateProd = useUpdateSalesProduct();

  const form = useForm<z.infer<typeof salesFormSchema>>({
    resolver: zodResolver(salesFormSchema),
    defaultValues: {
      name:         product.name,
      saleType:     product.saleType as "dona" | "kg",
      defaultPrice: product.defaultPrice,
      currency:     product.currency as "UZS" | "USD",
    },
  });

  async function onSubmit(values: z.infer<typeof salesFormSchema>) {
    if (values.saleType !== product.saleType) {
      const chk = await authFetch(`/api/sales-products/${product.id}/has-sales`);
      const { hasSales } = await chk.json();
      if (hasSales) { setPendingValues(values); setWarnOpen(true); return; }
    }
    save(values);
  }

  function save(values: z.infer<typeof salesFormSchema>) {
    updateProd.mutate({ id: product.id, ...values }, {
      onSuccess: () => { setOpen(false); setWarnOpen(false); }
    });
  }

  const currency = form.watch("currency");
  const saleType = form.watch("saleType");

  return (
    <>
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setOpen(true)}>
        <Pencil className="w-4 h-4" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Mahsulotni tahrirlash</DialogTitle>
            <DialogDescription>{product.name}</DialogDescription>
          </DialogHeader>

          {/* Tab switcher */}
          <div className="flex gap-1 border-b pb-0">
            <button
              type="button"
              onClick={() => setTab("info")}
              className={`px-3 py-1.5 text-sm font-medium rounded-t border-b-2 transition-colors ${
                tab === "info"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              Asosiy ma'lumot
            </button>
            <button
              type="button"
              onClick={() => setTab("tiers")}
              className={`px-3 py-1.5 text-sm font-medium rounded-t border-b-2 transition-colors flex items-center gap-1 ${
                tab === "tiers"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              Narx tizimlari
              {product.tiers.length > 0 && (
                <span className="ml-1 bg-primary/10 text-primary text-xs px-1.5 rounded-full">
                  {product.tiers.length}
                </span>
              )}
            </button>
          </div>

          {tab === "info" ? (
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nomi</FormLabel>
                    <FormControl><Input {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <div className="grid grid-cols-3 gap-3">
                  <FormField control={form.control} name="saleType" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sotish turi</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="dona">Dona</SelectItem>
                          <SelectItem value="kg">Kilogramm</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="defaultPrice" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Asosiy narx</FormLabel>
                      <FormControl><Input type="number" step="0.01" min={0} {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="currency" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Valyuta</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="UZS">UZS (so'm)</SelectItem>
                          <SelectItem value="USD">USD ($)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
                <p className="text-xs text-muted-foreground">
                  Asosiy narx — tier mos kelmasa qo'llaniladi.
                </p>
                <DialogFooter>
                  <Button type="submit" disabled={updateProd.isPending}>
                    {updateProd.isPending ? "Saqlanmoqda..." : "Saqlash"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          ) : (
            <div className="space-y-2">
              <TierManager product={{ ...product, saleType, currency }} />
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={warnOpen} onOpenChange={setWarnOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" /> Diqqat!
            </AlertDialogTitle>
            <AlertDialogDescription>
              Bu mahsulot bo'yicha avvalgi savdolar mavjud. Sotish turini o'zgartirish
              (dona → kg yoki aksincha) hisobotlarga ta'sir qilishi mumkin. Davom etilsinmi?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-500 hover:bg-amber-600 text-white"
              onClick={() => pendingValues && save(pendingValues)}
            >
              Ha, o'zgartirish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── Tier badge (in table row) ─────────────────────────────────────────────────
function TierBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
      <Layers className="w-2.5 h-2.5" /> {count} tier
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Products() {
  const queryClient = useQueryClient();
  const [isProdOpen, setIsProdOpen] = useState(false);
  const [isSalesOpen, setIsSalesOpen] = useState(false);
  const [localTiers, setLocalTiers] = useState<LocalTier[]>([]);

  const { data: products, isLoading: prodLoading } = useGetProducts({
    query: { queryKey: getGetProductsQueryKey() }
  });
  const { data: salesProducts, isLoading: salesLoading } = useSalesProducts();

  const createProduct = useCreateProduct({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetProductsQueryKey() });
        setIsProdOpen(false);
        prodForm.reset();
      }
    }
  });
  const deleteProduct = useDeleteProduct({
    mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetProductsQueryKey() }) }
  });

  const createSalesProd = useCreateSalesProduct();
  const deleteSalesProd = useDeleteSalesProduct();

  const prodForm = useForm<z.infer<typeof prodFormSchema>>({
    resolver: zodResolver(prodFormSchema),
    defaultValues: { name: "", rateType: "per_kg", rate: 0 },
  });
  const salesForm = useForm<z.infer<typeof salesFormSchema>>({
    resolver: zodResolver(salesFormSchema),
    defaultValues: { name: "", saleType: "dona", defaultPrice: 0, currency: "UZS" },
  });

  const salesCurrency = salesForm.watch("currency");
  const salesSaleType = salesForm.watch("saleType");

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold tracking-tight flex items-center">
        <Package className="w-5 h-5 mr-2" /> Mahsulotlar
      </h1>

      <Tabs defaultValue="production">
        <TabsList>
          <TabsTrigger value="production">⚙️ Ishlab chiqarish</TabsTrigger>
          <TabsTrigger value="sales">🛒 Sotuv mahsulotlari</TabsTrigger>
        </TabsList>

        {/* ── Production tab ─────────────────────────────────────────────── */}
        <TabsContent value="production" className="space-y-4 mt-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">Ishchilar maoshi hisoblanadigan mahsulotlar</p>
            <Dialog open={isProdOpen} onOpenChange={setIsProdOpen}>
              <DialogTrigger asChild>
                <Button data-testid="btn-add-product">
                  <Plus className="w-4 h-4 mr-2" /> Mahsulot qo'shish
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Yangi ishlab chiqarish mahsuloti</DialogTitle>
                  <DialogDescription>Ishchiga to'lanadigan narxni belgilang.</DialogDescription>
                </DialogHeader>
                <Form {...prodForm}>
                  <form onSubmit={prodForm.handleSubmit(v => createProduct.mutate({ data: v }))} className="space-y-4">
                    <FormField control={prodForm.control} name="name" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Mahsulot nomi</FormLabel>
                        <FormControl><Input placeholder="masalan: Arqon 12mm Ko'k" {...field} data-testid="input-product-name" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={prodForm.control} name="rateType" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Hisoblash usuli</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl><SelectTrigger data-testid="select-product-ratetype"><SelectValue /></SelectTrigger></FormControl>
                            <SelectContent>
                              <SelectItem value="per_kg">Kilogramm bo'yicha</SelectItem>
                              <SelectItem value="per_piece">Dona bo'yicha</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={prodForm.control} name="rate" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Narx (so'm)</FormLabel>
                          <FormControl><Input type="number" placeholder="0" {...field} data-testid="input-product-rate" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <DialogFooter className="pt-4">
                      <Button type="submit" disabled={createProduct.isPending} data-testid="btn-submit-product">
                        {createProduct.isPending ? "Saqlanmoqda..." : "Saqlash"}
                      </Button>
                    </DialogFooter>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>
          </div>
          <Card className="border-border">
            <CardContent className="p-0">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Mahsulot nomi</TableHead>
                    <TableHead>Hisoblash usuli</TableHead>
                    <TableHead className="text-right">Narx</TableHead>
                    <TableHead className="text-right w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {prodLoading ? (
                    Array.from({ length: 3 }).map((_, i) => (
                      <TableRow key={i}>
                        <TableCell><Skeleton className="h-5 w-48" /></TableCell>
                        <TableCell><Skeleton className="h-5 w-24" /></TableCell>
                        <TableCell className="text-right"><Skeleton className="h-5 w-24 ml-auto" /></TableCell>
                        <TableCell></TableCell>
                      </TableRow>
                    ))
                  ) : products?.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                        Mahsulotlar kiritilmagan.
                      </TableCell>
                    </TableRow>
                  ) : (
                    products?.map(product => (
                      <TableRow key={product.name} data-testid={`product-row-${product.name}`}>
                        <TableCell className="font-medium">{product.name}</TableCell>
                        <TableCell>
                          <span className="text-xs uppercase tracking-wider text-muted-foreground bg-muted px-2 py-1 rounded">
                            {product.rateType === "per_kg" ? "kg bo'yicha" : "dona bo'yicha"}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-mono font-medium">
                          {formatCurrency(product.rate)}
                        </TableCell>
                        <TableCell className="text-right">
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10" data-testid={`btn-delete-${product.name}`}>
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Mahsulotni o'chirish?</AlertDialogTitle>
                                <AlertDialogDescription>{product.name} katalogdan o'chiriladi.</AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
                                <AlertDialogAction
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  onClick={() => deleteProduct.mutate({ name: product.name })}
                                  data-testid="btn-confirm-delete"
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
        </TabsContent>

        {/* ── Sales products tab ─────────────────────────────────────────── */}
        <TabsContent value="sales" className="space-y-4 mt-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">Savdo formasida ko'rinadigan mahsulotlar (narx va valyuta bilan)</p>
            <Dialog open={isSalesOpen} onOpenChange={(v) => { setIsSalesOpen(v); if (!v) setLocalTiers([]); }}>
              <DialogTrigger asChild>
                <Button><Plus className="w-4 h-4 mr-2" /> Sotuv mahsulot qo'shish</Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>Yangi sotuv mahsuloti</DialogTitle>
                  <DialogDescription>Mijozlarga sotiladigan mahsulot ma'lumotlarini kiriting.</DialogDescription>
                </DialogHeader>
                <Form {...salesForm}>
                  <form onSubmit={salesForm.handleSubmit(v => {
                    createSalesProd.mutate({ ...v, tiers: localTiers }, {
                      onSuccess: () => { setIsSalesOpen(false); salesForm.reset(); setLocalTiers([]); }
                    });
                  })} className="space-y-4">
                    <FormField control={salesForm.control} name="name" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Mahsulot nomi</FormLabel>
                        <FormControl><Input placeholder="masalan: PoliPropilen Sariq Kurtka" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <div className="grid grid-cols-3 gap-3">
                      <FormField control={salesForm.control} name="saleType" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Sotish turi</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                            <SelectContent>
                              <SelectItem value="dona">Dona</SelectItem>
                              <SelectItem value="kg">Kilogramm</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={salesForm.control} name="defaultPrice" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Asosiy narx</FormLabel>
                          <FormControl><Input type="number" step="0.01" min={0} placeholder="0" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={salesForm.control} name="currency" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Valyuta</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                            <SelectContent>
                              <SelectItem value="UZS">UZS (so'm)</SelectItem>
                              <SelectItem value="USD">USD ($)</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>

                    {/* Tier section */}
                    <div className="rounded-md border p-3 space-y-2 bg-muted/20">
                      <p className="text-xs font-semibold flex items-center gap-1 text-muted-foreground">
                        <Layers className="w-3.5 h-3.5" /> Narx tizimlari (ixtiyoriy)
                      </p>
                      <LocalTierEditor
                        tiers={localTiers}
                        currency={salesCurrency}
                        saleType={salesSaleType}
                        onChange={setLocalTiers}
                      />
                    </div>

                    <DialogFooter className="pt-2">
                      <Button type="submit" disabled={createSalesProd.isPending}>
                        {createSalesProd.isPending ? "Saqlanmoqda..." : "Saqlash"}
                      </Button>
                    </DialogFooter>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>
          </div>

          <Card className="border-border">
            <CardContent className="p-0">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Mahsulot nomi</TableHead>
                    <TableHead>Sotish turi</TableHead>
                    <TableHead className="text-right">Asosiy narx</TableHead>
                    <TableHead className="text-right">Valyuta</TableHead>
                    <TableHead className="text-right w-[120px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {salesLoading ? (
                    Array.from({ length: 3 }).map((_, i) => (
                      <TableRow key={i}>
                        <TableCell><Skeleton className="h-5 w-48" /></TableCell>
                        <TableCell><Skeleton className="h-5 w-16" /></TableCell>
                        <TableCell className="text-right"><Skeleton className="h-5 w-24 ml-auto" /></TableCell>
                        <TableCell></TableCell>
                        <TableCell></TableCell>
                      </TableRow>
                    ))
                  ) : salesProducts?.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                        <ShoppingCart className="w-8 h-8 mx-auto mb-2 opacity-30" />
                        Sotuv mahsulotlari kiritilmagan.<br />
                        <span className="text-xs">Yuqoridagi tugmadan qo'shing</span>
                      </TableCell>
                    </TableRow>
                  ) : (
                    salesProducts?.map(sp => (
                      <TableRow key={sp.id}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            {sp.name}
                            <TierBadge count={sp.tiers.length} />
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-xs uppercase tracking-wider text-muted-foreground bg-muted px-2 py-1 rounded">
                            {sp.saleType}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-mono font-medium">
                          {sp.defaultPrice > 0
                            ? sp.currency === "USD"
                              ? `$${sp.defaultPrice}`
                              : formatCurrency(sp.defaultPrice)
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded ${sp.currency === "USD" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"}`}>
                            {sp.currency}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <EditSalesProductModal product={sp} />
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10">
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>O'chirish?</AlertDialogTitle>
                                  <AlertDialogDescription>{sp.name} savdo ro'yxatidan o'chiriladi.</AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
                                  <AlertDialogAction
                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                    onClick={() => deleteSalesProd.mutate(sp.id)}
                                  >
                                    O'chirish
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
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
