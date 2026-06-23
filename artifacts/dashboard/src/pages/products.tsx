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
type ProductionLine = { id: number; name: string };

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
  payrollMethod?: string;
  lineId?: number | null;
  lineName?: string | null;
  electricityCost: number;
  otherCost: number;
  rawMaterialCost: number;
  totalCost: number;
  profit: number;
  marginPct: number;
  minimumStock: number;
  piecesPerBox: number;
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
  currency: string;
  quantityRequired: number;
  lineCost: number;
  calculatedUzsLineCost: number;
};

type Tier = {
  id: number;
  minQty: number;
  maxQty: number;
  price: number;
  currency: string;
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
  piecesPerBox: z.coerce.number().int().min(1).default(1),
  active: z.boolean().default(true),
  payrollMethod: z.enum(["PRODUCT_RATE", "ROLE_BASED_KG"]).default("PRODUCT_RATE"),
  lineId: z.coerce.number().nullable().optional(),
});
type ProductForm = z.infer<typeof productSchema>;

// ── Query keys ────────────────────────────────────────────────────────────────
const PRODUCTS_KEY = ["v3-products"];
const RAW_MATERIALS_KEY = ["raw-materials"];
const bomKey = (name: string) => ["bom", name];
const tierKey = (productId: number) => ["product-tiers", productId];

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

function useExchangeRate() {
  return useQuery<{ rate: number }>({
    queryKey: ["exchange-rate"],
    queryFn: async () => {
      const res = await authFetch("/api/exchange-rate");
      if (!res.ok) throw new Error("Kursni olishda xato");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}

function useRoleRates() {
  return useQuery<Array<{ scope: string; role: string; rate: number }>>({
    queryKey: ["payroll-role-rates"],
    queryFn: async () => {
      const res = await authFetch("/api/payroll/role-rates");
      if (!res.ok) throw new Error("Stavkalarni olishda xato");
      return res.json();
    },
    staleTime: 60 * 1000,
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

function useProductionLines() {
  return useQuery<ProductionLine[]>({
    queryKey: ["production-lines"],
    queryFn: async () => {
      const res = await authFetch("/api/payroll/lines");
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 60 * 1000,
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

function useTiers(productId: number | null) {
  return useQuery<Tier[]>({
    queryKey: tierKey(productId ?? 0),
    queryFn: async () => {
      if (!productId) return [];
      const res = await authFetch(`/api/sales-products/${productId}/tiers`);
      if (!res.ok) throw new Error("Yuklashda xato");
      return res.json();
    },
    enabled: !!productId,
  });
}

type AddTierVars = { productId: number; minQuantity: number; maxQuantity: number; price: number; currency: string };
type DeleteTierVars = { productId: number; tierId: number };

function useAddTier() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, AddTierVars>({
    mutationFn: async ({ productId, ...body }) => {
      const res = await authFetch(`/api/sales-products/${productId}/tiers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Qo'shishda xato");
      }
      return res.json();
    },
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: tierKey(vars.productId) }),
  });
}

function useDeleteTier() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, DeleteTierVars>({
    mutationFn: async ({ productId, tierId }) => {
      const res = await authFetch(`/api/sales-products/${productId}/tiers/${tierId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("O'chirishda xato");
    },
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: tierKey(vars.productId) }),
  });
}

// ── Cost summary ──────────────────────────────────────────────────────────────
function CostSummary({
  rawMaterialCost, rate, rateType, electricityCost, otherCost, salePrice, weight, currencyType, usdRate, unitType, payrollMethod,
}: {
  rawMaterialCost: number;
  rate: number;
  rateType: string;
  electricityCost: number;
  otherCost: number;
  salePrice: number;
  weight: number;
  currencyType: string;
  usdRate: number;
  unitType: string;
  payrollMethod?: string;
}) {
  // dona: sotuv narxi = 1 dona narxi (og'irlikka ko'paytirilmaydi).
  // kg: sotuv narxi = narx/kg × og'irlik.
  // ROLE_BASED_KG: maosh liniya umumiy summasi (rate) × og'irlik.
  // Barcha qiymatlar UZS'da — USD jonli kursda aylantiriladi.
  const isKg      = unitType === "kg";
  const isRolePay = payrollMethod === "ROLE_BASED_KG";
  const w         = weight > 0 ? weight : 1;
  const saleRate  = currencyType === "USD" ? (usdRate > 0 ? usdRate : 1) : 1;
  const effSale   = salePrice * saleRate * (isKg ? w : 1);
  // ROLE_BASED_KG: rate = umumiy liniya maoshi; kg uchun ×og'irlik, dona uchun sabit
  const effSalary = isRolePay
    ? (isKg ? rate * w : rate)
    : (rateType === "kg" ? rate * w : rate);
  // dona: elektr/boshqa = 1 dona narxi (og'irlikka ko'paytirilmaydi)
  // kg:   elektr/boshqa = narx/kg × og'irlik
  const effElec   = isKg ? electricityCost * w : electricityCost;
  const effOther  = isKg ? otherCost * w : otherCost;
  const totalCost = rawMaterialCost + effSalary + effElec + effOther;
  const profit    = effSale - totalCost;
  const marginPct = effSale > 0 ? (profit / effSale) * 100 : 0;
  const fmt = (v: number) => formatCurrency(v);

  return (
    <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5 text-xs">
      {isKg && w !== 1 && (
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
        <span>
          {isRolePay ? "Liniya maoshi" : `Maosh${rateType === "kg" ? ` (×${w})` : ""}`}
        </span>
        <span className="font-mono text-amber-500">
          {isRolePay ? "kun yopilganda" : (effSalary > 0 ? fmt(effSalary) : "—")}
        </span>
      </div>
      <div className="flex justify-between text-muted-foreground">
        <span>Elektr xarajati{isKg ? ` (×${w})` : ""}</span>
        <span className="font-mono">{fmt(effElec)}</span>
      </div>
      <div className="flex justify-between text-muted-foreground">
        <span>Boshqa xarajatlar{isKg ? ` (×${w})` : ""}</span>
        <span className="font-mono">{fmt(effOther)}</span>
      </div>
      <div className="flex justify-between font-semibold border-t pt-1.5">
        <span>Jami xarajat</span>
        <span className="font-mono">{fmt(totalCost)}</span>
      </div>
      <div className="flex justify-between text-muted-foreground">
        <span>Sotuv narxi{isKg && w !== 1 ? ` (×${w})` : ""}</span>
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
      {currencyType === "USD" && (
        <div className="flex justify-between text-[10px] text-muted-foreground pt-1.5 border-t">
          <span>Kurs (jonli, cbu.uz)</span>
          <span className="font-mono">1$ = {formatCurrency(saleRate)}</span>
        </div>
      )}
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
  const { data: exRate } = useExchangeRate();
  const addBom = useAddBomItem();
  const deleteBom = useDeleteBomItem();
  const [selMat, setSelMat] = useState<string>("");
  const [qty, setQty] = useState<string>("");

  // Xom ashyo jami UZS ekvivalentida (USD xom ashyo jonli kursda aylantirilgan).
  const rawMatCost = bom.reduce((s, b) => s + b.calculatedUzsLineCost, 0);
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
                <strong>{formatCurrency(item.calculatedUzsLineCost)}</strong>
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
        usdRate={exRate?.rate ?? 0}
        unitType={product.unitType}
        payrollMethod={product.payrollMethod}
      />
    </div>
  );
}

// ── Tier pricing tab ──────────────────────────────────────────────────────────
function TierTab({ product }: { product: Product }) {
  const { data: tiers = [], isLoading } = useTiers(product.id);
  const addTier = useAddTier();
  const deleteTier = useDeleteTier();
  const [minQ, setMinQ] = useState<string>("");
  const [maxQ, setMaxQ] = useState<string>("");
  const [price, setPrice] = useState<string>("");
  const [currency, setCurrency] = useState<string>(product.currencyType || "UZS");
  const [error, setError] = useState<string>("");

  const fmt = (v: number, cur: string) =>
    cur === "USD"
      ? `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : formatCurrency(v);

  function handleAdd() {
    setError("");
    const mn = Number(minQ), mx = Number(maxQ), pr = Number(price);
    if (!minQ || !maxQ || !price || isNaN(mn) || isNaN(mx) || isNaN(pr)) {
      setError("Barcha maydonlarni to'g'ri kiriting"); return;
    }
    if (mx < mn) { setError("Maksimal miqdor minimaldan kichik bo'lmasligi kerak"); return; }
    addTier.mutate(
      { productId: product.id, minQuantity: mn, maxQuantity: mx, price: pr, currency },
      {
        onSuccess: () => { setMinQ(""); setMaxQ(""); setPrice(""); },
        onError: (e) => setError(e.message),
      },
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Hajm bo'yicha narx bosqichlari. Sotuvda miqdorga mos bosqich avtomatik tanlanadi
        (min ≤ miqdor ≤ maks). Mos bosqich bo'lmasa standart sotuv narxi ishlatiladi.
      </p>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-9 w-full" />)}
        </div>
      ) : tiers.length === 0 ? (
        <div className="text-center py-8 text-sm text-muted-foreground border rounded-lg">
          <Package className="w-8 h-8 mx-auto mb-2 opacity-30" />
          Narx bosqichi qo'shilmagan
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden text-sm">
          <div className="grid grid-cols-[1.5fr_1.5fr_auto] text-xs text-muted-foreground px-3 py-2 bg-muted/40 font-medium">
            <span>Miqdor oralig'i ({product.unitType})</span>
            <span>Narx/birlik</span>
            <span />
          </div>
          {tiers.map(t => (
            <div
              key={t.id}
              className="grid grid-cols-[1.5fr_1.5fr_auto] items-center px-3 py-2 border-t"
            >
              <span className="font-mono text-xs">
                {t.minQty.toLocaleString()} – {t.maxQty.toLocaleString()}
              </span>
              <span className="font-mono text-xs font-medium">{fmt(t.price, t.currency)}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive hover:text-destructive"
                onClick={() => deleteTier.mutate({ productId: product.id, tierId: t.id })}
                disabled={deleteTier.isPending}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-lg border p-3 bg-muted/10 space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Bosqich qo'shish</p>
        <div className="flex gap-2 flex-wrap">
          <Input
            type="number" min={0} step="1" placeholder="Min"
            value={minQ} onChange={e => setMinQ(e.target.value)}
            className="w-20 h-8 text-sm"
          />
          <Input
            type="number" min={0} step="1" placeholder="Maks"
            value={maxQ} onChange={e => setMaxQ(e.target.value)}
            className="w-20 h-8 text-sm"
          />
          <Input
            type="number" min={0} step="0.01" placeholder="Narx"
            value={price} onChange={e => setPrice(e.target.value)}
            className="flex-1 min-w-[6rem] h-8 text-sm"
          />
          <Select value={currency} onValueChange={setCurrency}>
            <SelectTrigger className="w-24 h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="UZS">UZS</SelectItem>
              <SelectItem value="USD">USD</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            className="h-8 shrink-0"
            onClick={handleAdd}
            disabled={!minQ || !maxQ || !price || addTier.isPending}
          >
            <Plus className="w-3.5 h-3.5" />
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
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
  const [tab, setTab] = useState<"info" | "bom" | "tiers">("info");
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
      payrollMethod: (product?.payrollMethod as "PRODUCT_RATE" | "ROLE_BASED_KG") ?? "PRODUCT_RATE",
      lineId: product?.lineId ?? null,
      electricityCost: product?.electricityCost ?? 0,
      otherCost: product?.otherCost ?? 0,
      minimumStock: product?.minimumStock ?? 0,
      piecesPerBox: product?.piecesPerBox ?? 1,
      active: product?.active ?? true,
    },
  });

  const watchedSalePrice = form.watch("defaultSalePrice");
  const watchedWeight    = form.watch("weight");
  const watchedRate      = form.watch("rate");
  const watchedUnitType  = form.watch("unitType");
  const watchedElec      = form.watch("electricityCost");
  const watchedOther          = form.watch("otherCost");
  const watchedCurrency       = form.watch("currencyType");
  const watchedPayrollMethod  = form.watch("payrollMethod");
  const watchedLineId         = form.watch("lineId");
  const { data: exRate } = useExchangeRate();
  const { data: lines = [] } = useProductionLines();
  const { data: roleRates = [] } = useRoleRates();

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
            {(["info", "bom", "tiers"] as const).map(t => (
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
                {t === "info" ? "Asosiy ma'lumot" : t === "bom" ? "Xarajatlar (BOM)" : "Narx bosqichlari"}
              </button>
            ))}
          </div>
        )}

        {(!isEdit || tab === "info") && (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {/* ─── 1. Asosiy ma'lumot ─── */}
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground border-b pb-1">
                1 · Asosiy ma'lumot
              </p>
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
              <FormField
                control={form.control}
                name="defaultSalePrice"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Sotuv narxi
                      <span className="text-muted-foreground font-normal ml-1 text-xs">
                        ({watchedUnitType === "kg" ? "1 kg uchun" : "1 dona uchun"}, {watchedCurrency})
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" min={0} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* ─── 2. Xarajat tuzilishi ─── */}
              <div className="pt-2 border-t">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground border-b pb-1 mb-3">
                  2 · Xarajat tuzilishi
                </p>
                <div className="space-y-3">
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
                  <div className="grid grid-cols-2 gap-3">
                    <FormField
                      control={form.control}
                      name="electricityCost"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            Elektr xarajati
                            <span className="text-muted-foreground font-normal ml-1 text-xs">
                              (so'm/{watchedUnitType === "kg" ? "kg" : "dona"})
                            </span>
                          </FormLabel>
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
                          <FormLabel>
                            Boshqa xarajat
                            <span className="text-muted-foreground font-normal ml-1 text-xs">
                              (so'm/{watchedUnitType === "kg" ? "kg" : "dona"})
                            </span>
                          </FormLabel>
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
                      name="piecesPerBox"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            Dona/quti
                            <span className="text-muted-foreground font-normal ml-1 text-xs">(etiketika)</span>
                          </FormLabel>
                          <FormControl>
                            <Input type="number" step="1" min={1} {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div />
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
                </div>
              </div>

              {/* ─── 3. Maosh ─── */}
              <div className="pt-2 border-t">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground border-b pb-1 mb-3">
                  3 · Maosh
                </p>
                <div className="space-y-3">
                  <FormField
                    control={form.control}
                    name="payrollMethod"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Maosh usuli</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="PRODUCT_RATE">Mahsulot stavkasi</SelectItem>
                            <SelectItem value="ROLE_BASED_KG">
                              Liniya bo'yicha
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )}
                  />

                  {watchedPayrollMethod === "ROLE_BASED_KG" && (
                    <FormField
                      control={form.control}
                      name="lineId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Ishlab chiqarish liniyasi</FormLabel>
                          <Select
                            onValueChange={v => field.onChange(v === "none" ? null : Number(v))}
                            value={field.value != null ? String(field.value) : "none"}
                          >
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="Liniyani tanlang…" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="none">— Tanlanmagan —</SelectItem>
                              {lines.map(l => (
                                <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {lines.length === 0 && (
                            <p className="text-xs text-muted-foreground mt-1">
                              Liniyalar yo'q — avval Maosh sahifasida liniya qo'shing
                            </p>
                          )}
                        </FormItem>
                      )}
                    />
                  )}

                  {watchedPayrollMethod === "ROLE_BASED_KG" ? (
                    <div className="space-y-1.5">
                      <p className="text-sm font-medium">Liniya stavkalari (so'm/kg)</p>
                      <div className="rounded-md border bg-muted/30 p-2.5 grid grid-cols-3 gap-2 text-xs">
                        {(["producer","packaging","preparation"] as const).map(role => {
                          const r = roleRates.find(x => x.role === role && x.scope === "arqon");
                          const labels: Record<string, string> = { producer: "Ishlab chiqaruvchi", packaging: "O'rash", preparation: "Tayyorlash" };
                          return (
                            <div key={role} className="flex flex-col items-center gap-0.5 rounded border bg-background p-1.5">
                              <span className="text-muted-foreground text-center leading-tight">{labels[role]}</span>
                              <span className="font-semibold font-mono">{r ? r.rate.toLocaleString() : "—"}</span>
                            </div>
                          );
                        })}
                      </div>
                      <p className="text-xs text-muted-foreground">Stavkalarni o'zgartirish uchun → Maosh sahifasi</p>
                    </div>
                  ) : (
                    <FormField
                      control={form.control}
                      name="rate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            Maosh stavkasi
                            <span className="text-muted-foreground font-normal ml-1 text-xs">
                              ({watchedUnitType === "kg" ? "so'm/kg" : "so'm/dona"})
                            </span>
                          </FormLabel>
                          <FormControl>
                            <Input type="number" step="0.01" min={0} {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  )}
                </div>
              </div>

              {/* ─── 4. Foyda ko'rinishi ─── */}
              <div className="pt-2 border-t">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground border-b pb-1 mb-3">
                  4 · Foyda ko'rinishi
                </p>
                <CostSummary
                  rawMaterialCost={isEdit ? (product?.rawMaterialCost ?? 0) : 0}
                  rate={Number(watchedRate) || 0}
                  rateType={watchedUnitType}
                  electricityCost={Number(watchedElec) || 0}
                  otherCost={Number(watchedOther) || 0}
                  salePrice={Number(watchedSalePrice) || 0}
                  weight={Number(watchedWeight) || 1}
                  currencyType={watchedCurrency}
                  usdRate={exRate?.rate ?? 0}
                  unitType={watchedUnitType}
                  payrollMethod={watchedPayrollMethod}
                />
              </div>

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

        {isEdit && tab === "tiers" && (
          <TierTab product={product!} />
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

  // Jami narx/xarajat/foyda API'da UZS'ga normallashtirilgan (USD jonli kursda) — UZS'da ko'rsatamiz.
  const fmtPrice   = (p: Product) => formatCurrency(p.effectiveSalePrice);
  const fmtCost    = (p: Product) => formatCurrency(p.totalCost);
  const fmtProfit  = (p: Product) => formatCurrency(p.profit);

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
