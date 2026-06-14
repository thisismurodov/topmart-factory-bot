import { authFetch } from "@/App";
import { useState } from "react";
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
import { Plus, Trash2, Pencil, Package } from "lucide-react";
import { formatCurrency } from "@/lib/format";

// ── Types ─────────────────────────────────────────────────────────────────────
type Product = {
  id: number;
  name: string;
  sku: string;
  unitType: string;
  currencyType: string;
  defaultSalePrice: number;
  weight: number;
  effectiveSalePrice: number;
  rate: number;
  rateType: string;
  electricityCost: number;
  otherCost: number;
  rawMaterialCost: number;
  totalCost: number;
  profit: number;
  marginPct: number;
  minimumStock: number;
  active: boolean;
  createdAt: string;
};

type RawMaterial = {
  id: number;
  name: string;
  unitType: string;
  defaultCost: number;
  active: boolean;
};

type BomItem = {
  id: number;
  productName: string;
  rawMaterialId: number;
  rawMaterialName: string;
  unitType: string;
  defaultCost: number;
  quantityRequired: number;
  lineCost: number;
};

// ── Schemas ───────────────────────────────────────────────────────────────────
const productSchema = z.object({
  name: z.string().min(1, "Mahsulot nomi kiritilishi shart"),
  sku: z.string().default(""),
  unitType: z.enum(["dona", "kg"]),
  currencyType: z.enum(["UZS", "USD"]),
  defaultSalePrice: z.coerce.number().min(0),
  weight: z.coerce.number().min(0).default(1),
  rate: z.coerce.number().min(0),
  electricityCost: z.coerce.number().min(0),
  otherCost: z.coerce.number().min(0),
  minimumStock: z.coerce.number().min(0).int(),
  active: z.boolean().default(true),
});
type ProductForm = z.infer<typeof productSchema>;

// ── Query keys ────────────────────────────────────────────────────────────────
const PRODUCTS_KEY = ["v3-products"];
const RAW_MATERIALS_KEY = ["raw-materials"];
const bomKey = (name: string) => ["bom", name];

// ── Hooks ─────────────────────────────────────────────────────────────────────
function useProducts() {
  return useQuery<Product[]>({
    queryKey: PRODUCTS_KEY,
    queryFn: async () => {
      const res = await authFetch("/api/products");
      if (!res.ok) throw new Error("Yuklashda xato");
      return res.json();
    },
  });
}

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

function useBom(productName: string | null) {
  return useQuery<BomItem[]>({
    queryKey: bomKey(productName ?? ""),
    queryFn: async () => {
      if (!productName) return [];
      const res = await authFetch(
        `/api/product-materials?productName=${encodeURIComponent(productName)}`,
      );
      if (!res.ok) throw new Error("Yuklashda xato");
      return res.json();
    },
    enabled: !!productName,
  });
}

function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: ProductForm) => {
      const res = await authFetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, rateType: data.unitType }),
      });
      if (!res.ok) throw new Error("Saqlashda xato");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PRODUCTS_KEY }),
  });
}

function useUpdateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, ...data }: ProductForm & { name: string }) => {
      const res = await authFetch(`/api/products/${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, rateType: data.unitType }),
      });
      if (!res.ok) throw new Error("Saqlashda xato");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PRODUCTS_KEY }),
  });
}

function useDeleteProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await authFetch(`/api/products/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("O'chirishda xato");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PRODUCTS_KEY }),
  });
}

type AddBomVars = { productName: string; rawMaterialId: number; quantityRequired: number };
type DeleteBomVars = { id: number; productName: string };

function useAddBomItem() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, AddBomVars>({
    mutationFn: async (data) => {
      const res = await authFetch("/api/product-materials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Qo'shishda xato");
      return res.json();
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: bomKey(vars.productName) });
      qc.invalidateQueries({ queryKey: PRODUCTS_KEY });
    },
  });
}

function useDeleteBomItem() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, DeleteBomVars>({
    mutationFn: async ({ id }) => {
      const res = await authFetch(`/api/product-materials/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("O'chirishda xato");
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: bomKey(vars.productName) });
      qc.invalidateQueries({ queryKey: PRODUCTS_KEY });
    },
  });
}

// ── Cost summary ──────────────────────────────────────────────────────────────
function CostSummary({
  rawMaterialCost, rate, rateType, electricityCost, otherCost, salePrice, weight, currencyType,
}: {
  rawMaterialCost: number;
  rate: number;
  rateType: string;
  electricityCost: number;
  otherCost: number;
  salePrice: number;
  weight: number;
  currencyType: string;
}) {
  // mehnat (maosh) stavkadan: kg → rate×og'irlik, dona → rate; elektr/boshqa/narx × og'irlik; xom ashyo mutlaq
  const w        = weight > 0 ? weight : 1;
  const effSalary = rateType === "kg" ? rate * w : rate;
  const effElec   = electricityCost * w;
  const effOther  = otherCost * w;
  const effSale   = salePrice * w;
  const totalCost = rawMaterialCost + effSalary + effElec + effOther;
  const profit    = effSale - totalCost;
  const marginPct = effSale > 0 ? (profit / effSale) * 100 : 0;
  const scaled    = w !== 1;
  const salaryScaled = scaled && rateType === "kg";
  const isUsd = currencyType === "USD";
  const fmt = (v: number) =>
    isUsd
      ? `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : formatCurrency(v);

  return (
    <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5 text-xs">
      {scaled && (
        <div className="flex justify-between font-medium text-foreground border-b pb-1.5">
          <span>Og'irlik</span>
          <span className="font-mono">{w} kg</span>
        </div>
      )}
      <div className="flex justify-between text-muted-foreground">
        <span>Xom ashyo xarajati</span>
        <span className="font-mono">{fmt(rawMaterialCost)}</span>
      </div>
      <div className="flex justify-between text-muted-foreground">
        <span>Maosh (mehnat){salaryScaled && ` (×${w})`}</span>
        <span className="font-mono">{fmt(effSalary)}</span>
      </div>
      <div className="flex justify-between text-muted-foreground">
        <span>Elektr xarajati{scaled && ` (×${w})`}</span>
        <span className="font-mono">{fmt(effElec)}</span>
      </div>
      <div className="flex justify-between text-muted-foreground">
        <span>Boshqa xarajatlar{scaled && ` (×${w})`}</span>
        <span className="font-mono">{fmt(effOther)}</span>
      </div>
      <div className="flex justify-between font-semibold border-t pt-1.5">
        <span>Jami xarajat</span>
        <span className="font-mono">{fmt(totalCost)}</span>
      </div>
      <div className="flex justify-between text-muted-foreground">
        <span>Sotuv narxi{scaled && ` (×${w})`}</span>
        <span className="font-mono">{fmt(effSale)}</span>
      </div>
      <div
        className={`flex justify-between font-bold text-sm ${
          profit >= 0 ? "text-green-700" : "text-red-600"
        }`}
      >
        <span>Foyda</span>
        <span className="font-mono">{fmt(profit)}</span>
      </div>
      <div
        className={`flex justify-between font-semibold ${
          marginPct >= 20 ? "text-green-700" : marginPct >= 0 ? "text-amber-600" : "text-red-600"
        }`}
      >
        <span>Margin</span>
        <span className="font-mono">{marginPct.toFixed(1)}%</span>
      </div>
    </div>
  );
}

// ── BOM tab ───────────────────────────────────────────────────────────────────
function BomTab({
  product, rawMaterials,
}: {
  product: Product; rawMaterials: RawMaterial[];
}) {
  const { data: bom = [], isLoading } = useBom(product.name);
  const addBom = useAddBomItem();
  const deleteBom = useDeleteBomItem();
  const [selMat, setSelMat] = useState<string>("");
  const [qty, setQty] = useState<string>("");

  const rawMatCost = bom.reduce((s, b) => s + b.lineCost, 0);
  const usedIds = new Set(bom.map(b => b.rawMaterialId));
  const available = rawMaterials.filter(m => m.active && !usedIds.has(m.id));

  function handleAdd() {
    if (!selMat || !qty || isNaN(Number(qty))) return;
    addBom.mutate(
      { productName: product.name, rawMaterialId: Number(selMat), quantityRequired: Number(qty) },
      { onSuccess: () => { setSelMat(""); setQty(""); } },
    );
  }

  return (
    <div className="space-y-4">
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-9 w-full" />)}
        </div>
      ) : bom.length === 0 ? (
        <div className="text-center py-8 text-sm text-muted-foreground border rounded-lg">
          <Package className="w-8 h-8 mx-auto mb-2 opacity-30" />
          Xom ashyo qo'shilmagan
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden text-sm">
          <div className="grid grid-cols-[2fr_0.8fr_1fr_1.2fr_auto] text-xs text-muted-foreground px-3 py-2 bg-muted/40 font-medium">
            <span>Xom ashyo</span>
            <span>Birlik</span>
            <span>Narx/birlik</span>
            <span>Miqdor → Jami</span>
            <span />
          </div>
          {bom.map(item => (
            <div
              key={item.id}
              className="grid grid-cols-[2fr_0.8fr_1fr_1.2fr_auto] items-center px-3 py-2 border-t"
            >
              <span className="font-medium truncate">{item.rawMaterialName}</span>
              <span className="text-muted-foreground text-xs">{item.unitType}</span>
              <span className="font-mono text-xs">{formatCurrency(item.defaultCost)}</span>
              <span className="font-mono text-xs">
                {item.quantityRequired} →{" "}
                <strong>{formatCurrency(item.lineCost)}</strong>
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive hover:text-destructive"
                onClick={() => deleteBom.mutate({ id: item.id, productName: product.name })}
                disabled={deleteBom.isPending}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {available.length > 0 && (
        <div className="rounded-lg border p-3 bg-muted/10 space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Xom ashyo qo'shish</p>
          <div className="flex gap-2">
            <Select value={selMat} onValueChange={setSelMat}>
              <SelectTrigger className="flex-1 h-8 text-sm">
                <SelectValue placeholder="Xom ashyo tanlang..." />
              </SelectTrigger>
              <SelectContent>
                {available.map(m => (
                  <SelectItem key={m.id} value={String(m.id)}>
                    {m.name} ({m.unitType}) — {formatCurrency(m.defaultCost)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="number"
              min={0}
              step="0.001"
              placeholder="Miqdor"
              value={qty}
              onChange={e => setQty(e.target.value)}
              className="w-24 h-8 text-sm"
            />
            <Button
              size="sm"
              className="h-8 shrink-0"
              onClick={handleAdd}
              disabled={!selMat || !qty || addBom.isPending}
            >
              <Plus className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      )}

      <CostSummary
        rawMaterialCost={rawMatCost}
        rate={product.rate}
        rateType={product.rateType}
        electricityCost={product.electricityCost}
        otherCost={product.otherCost}
        salePrice={product.defaultSalePrice}
        weight={product.weight}
        currencyType={product.currencyType}
      />
    </div>
  );
}

// ── Product dialog ────────────────────────────────────────────────────────────
function ProductDialog({
  open, onClose, product, rawMaterials,
}: {
  open: boolean;
  onClose: () => void;
  product?: Product | null;
  rawMaterials: RawMaterial[];
}) {
  const [tab, setTab] = useState<"info" | "bom">("info");
  const isEdit = !!product;
  const createProd = useCreateProduct();
  const updateProd = useUpdateProduct();
  const isPending = createProd.isPending || updateProd.isPending;

  const form = useForm<ProductForm>({
    resolver: zodResolver(productSchema),
    values: {
      name: product?.name ?? "",
      sku: product?.sku ?? "",
      unitType: (product?.unitType as "dona" | "kg") ?? "dona",
      currencyType: (product?.currencyType as "UZS" | "USD") ?? "UZS",
      defaultSalePrice: product?.defaultSalePrice ?? 0,
      weight: product?.weight ?? 1,
      rate: product?.rate ?? 0,
      electricityCost: product?.electricityCost ?? 0,
      otherCost: product?.otherCost ?? 0,
      minimumStock: product?.minimumStock ?? 0,
      active: product?.active ?? true,
    },
  });

  const watchedSalePrice = form.watch("defaultSalePrice");
  const watchedWeight    = form.watch("weight");
  const watchedRate      = form.watch("rate");
  const watchedUnitType  = form.watch("unitType");
  const watchedElec      = form.watch("electricityCost");
  const watchedOther     = form.watch("otherCost");
  const watchedCurrency  = form.watch("currencyType");

  function onSubmit(values: ProductForm) {
    if (isEdit) {
      updateProd.mutate(
        { ...values, name: product!.name },
        { onSuccess: () => handleClose() },
      );
    } else {
      createProd.mutate(values, {
        onSuccess: () => { form.reset(); handleClose(); },
      });
    }
  }

  function handleClose() {
    setTab("info");
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={o => !o && handleClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Mahsulotni tahrirlash" : "Yangi mahsulot"}</DialogTitle>
          {isEdit && <DialogDescription>{product!.name}</DialogDescription>}
        </DialogHeader>

        {isEdit && (
          <div className="flex gap-1 border-b">
            {(["info", "bom"] as const).map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${
                  tab === t
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {t === "info" ? "Asosiy ma'lumot" : "Xarajatlar (BOM)"}
              </button>
            ))}
          </div>
        )}

        {(!isEdit || tab === "info") && (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nomi</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        disabled={isEdit}
                        className={isEdit ? "bg-muted" : ""}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="sku"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>SKU (ixtiyoriy)</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="RM-001" />
                    </FormControl>
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="unitType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Birlik turi</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="dona">Dona</SelectItem>
                          <SelectItem value="kg">Kilogramm</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="currencyType"
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

              <div className="grid grid-cols-3 gap-3">
                <FormField
                  control={form.control}
                  name="defaultSalePrice"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sotuv narxi</FormLabel>
                      <FormControl>
                        <Input type="number" step="0.01" min={0} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="weight"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Og'irlik (kg)</FormLabel>
                      <FormControl>
                        <Input type="number" step="0.001" min={0} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="rate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Maosh stavkasi</FormLabel>
                      <FormControl>
                        <Input type="number" step="0.01" min={0} {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>
              <p className="text-xs text-muted-foreground -mt-1">
                Sotuv narxi, elektr va boshqa xarajatlar 1 birlik (kg/dona) uchun.
                Maosh = stavka (kg uchun × og'irlik). Jami = og'irlik × narx.
                Xom ashyo (BOM) bundan mustasno.
              </p>

              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="electricityCost"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Elektr xarajati</FormLabel>
                      <FormControl>
                        <Input type="number" step="0.01" min={0} {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="otherCost"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Boshqa xarajat</FormLabel>
                      <FormControl>
                        <Input type="number" step="0.01" min={0} {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="minimumStock"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Minimal qoldiq</FormLabel>
                      <FormControl>
                        <Input type="number" step="1" min={0} {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="active"
                  render={({ field }) => (
                    <FormItem className="flex flex-col justify-end pb-1">
                      <FormLabel>Faol</FormLabel>
                      <div className="flex items-center gap-2 mt-1">
                        <FormControl>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                        <span className="text-sm text-muted-foreground">
                          {field.value ? "Ha" : "Yo'q"}
                        </span>
                      </div>
                    </FormItem>
                  )}
                />
              </div>

              <CostSummary
                rawMaterialCost={isEdit ? (product?.rawMaterialCost ?? 0) : 0}
                rate={Number(watchedRate) || 0}
                rateType={watchedUnitType}
                electricityCost={Number(watchedElec) || 0}
                otherCost={Number(watchedOther) || 0}
                salePrice={Number(watchedSalePrice) || 0}
                weight={Number(watchedWeight) || 1}
                currencyType={watchedCurrency}
              />

              <DialogFooter>
                <Button type="submit" disabled={isPending}>
                  {isPending ? "Saqlanmoqda..." : isEdit ? "Saqlash" : "Yaratish"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}

        {isEdit && tab === "bom" && (
          <BomTab product={product!} rawMaterials={rawMaterials} />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function Products() {
  const [createOpen, setCreateOpen]   = useState(false);
  const [editProduct, setEditProduct] = useState<Product | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);

  const { data: products = [], isLoading } = useProducts();
  const { data: rawMaterials = [] }        = useRawMaterials();
  const deleteProd = useDeleteProduct();

  const isUsd      = (p: Product) => p.currencyType === "USD";
  const fmtPrice   = (p: Product) =>
    isUsd(p) ? `$${p.effectiveSalePrice.toFixed(2)}` : formatCurrency(p.effectiveSalePrice);
  const fmtCost    = (p: Product) =>
    isUsd(p) ? `$${p.totalCost.toFixed(2)}` : formatCurrency(p.totalCost);
  const fmtProfit  = (p: Product) =>
    isUsd(p) ? `$${p.profit.toFixed(2)}` : formatCurrency(p.profit);

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Package className="w-6 h-6 text-primary" /> Mahsulotlar
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isLoading ? "Yuklanmoqda..." : `${products.length} ta mahsulot`}
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="w-4 h-4 mr-2" /> Yangi mahsulot
        </Button>
      </div>

      <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nomi</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Birlik</TableHead>
              <TableHead>Valyuta</TableHead>
              <TableHead className="text-right">Sotuv narxi</TableHead>
              <TableHead className="text-right">Jami xarajat</TableHead>
              <TableHead className="text-right">Foyda</TableHead>
              <TableHead className="text-right">Margin%</TableHead>
              <TableHead>Holat</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 10 }).map((_c, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-5 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : products.length === 0
                ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-12 text-muted-foreground">
                      <Package className="w-10 h-10 mx-auto mb-2 opacity-20" />
                      Mahsulotlar yo'q
                    </TableCell>
                  </TableRow>
                )
                : products.map(p => {
                    const marginPct  = p.marginPct ?? 0;
                    const profitCls  = p.profit >= 0 ? "text-green-700" : "text-red-600";
                    const marginCls  = marginPct >= 20
                      ? "text-green-700"
                      : marginPct >= 0
                        ? "text-amber-600"
                        : "text-red-600";
                    return (
                      <TableRow key={p.id} className={!p.active ? "opacity-50" : ""}>
                        <TableCell className="font-medium">{p.name}</TableCell>
                        <TableCell className="text-muted-foreground text-xs font-mono">
                          {p.sku || "—"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {p.unitType}
                          {p.weight && p.weight !== 1
                            ? <span className="text-muted-foreground"> · {p.weight} kg</span>
                            : null}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {p.currencyType}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {fmtPrice(p)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm text-muted-foreground">
                          {fmtCost(p)}
                        </TableCell>
                        <TableCell className={`text-right font-mono text-sm font-semibold ${profitCls}`}>
                          {fmtProfit(p)}
                        </TableCell>
                        <TableCell className={`text-right font-semibold text-sm ${marginCls}`}>
                          {marginPct.toFixed(1)}%
                        </TableCell>
                        <TableCell>
                          {p.active
                            ? (
                              <Badge className="bg-green-100 text-green-700 hover:bg-green-100 border border-green-200 shadow-none">
                                Faol
                              </Badge>
                            )
                            : <Badge variant="secondary">Nofaol</Badge>}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => setEditProduct(p)}
                            >
                              <Pencil className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              onClick={() => setDeleteTarget(p)}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
          </TableBody>
        </Table>
      </div>

      <ProductDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        rawMaterials={rawMaterials}
      />
      <ProductDialog
        open={!!editProduct}
        onClose={() => setEditProduct(null)}
        product={editProduct}
        rawMaterials={rawMaterials}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={o => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mahsulotni o'chirish</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deleteTarget?.name}</strong> mahsulotini o'chirmoqchimisiz?
              Bu amalni bekor qilib bo'lmaydi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (!deleteTarget) return;
                deleteProd.mutate(deleteTarget.name, {
                  onSuccess: () => setDeleteTarget(null),
                });
              }}
              disabled={deleteProd.isPending}
            >
              {deleteProd.isPending ? "O'chirilmoqda..." : "O'chirish"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
