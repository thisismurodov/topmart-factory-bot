import { authFetch } from "@/App";
import { useState, useRef, useEffect } from "react";
import {
  useGetCustomers, getGetCustomersQueryKey,
  useDeleteSale,
  getGetSalesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Plus, Trash2, ShoppingBag, CheckCircle2, Clock, ChevronDown, ChevronRight,
  Pencil, PackagePlus, Banknote, CreditCard, Shuffle, History, Search, X,
} from "lucide-react";

// ── SearchCombobox — qidiruv bilan dropdown ────────────────────────────────────
function SearchCombobox({
  options,
  value,
  onChange,
  placeholder = "Tanlang",
  searchPlaceholder = "Qidirish...",
  emptyText = "Topilmadi",
  displayValue,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  displayValue?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = query.trim()
    ? options.filter(o => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  const selectedLabel = displayValue ?? options.find(o => o.value === value)?.label;

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  function select(v: string) {
    onChange(v);
    setOpen(false);
    setQuery("");
  }

  function clear(e: React.MouseEvent) {
    e.stopPropagation();
    onChange("");
    setQuery("");
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className={selectedLabel ? "text-foreground" : "text-muted-foreground"}>
          {selectedLabel ?? placeholder}
        </span>
        <div className="flex items-center gap-1">
          {value && (
            <X
              className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground"
              onClick={clear}
            />
          )}
          <ChevronDown className="w-4 h-4 opacity-50" />
        </div>
      </button>

      {open && (
        <div className="absolute z-[200] mt-1 w-full rounded-md border bg-popover shadow-md">
          <div className="flex items-center border-b px-3 py-2 gap-2">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-[220px] overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-4">{emptyText}</p>
            ) : (
              filtered.map(o => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => select(o.value)}
                  className={`w-full text-left rounded-sm px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground ${
                    value === o.value ? "bg-accent/60 font-medium" : ""
                  }`}
                >
                  {o.label}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────
type Tier      = { id: number; minQty: number; maxQty: number; price: number; currency: string };
type SalesProd = { id: number; name: string; saleType: string; defaultPrice: number; currency: string; tiers: Tier[] };
type DraftItem = { key: string; productName: string; saleType: string; quantity: number; unitPrice: number; currency: string; lineTotal: number };
type SaleItem  = { id: number; productName: string; saleType: string; quantity: number; unitPrice: number; currency: string; lineTotal: number };
type Sale = {
  id: number; customerId: number; customerName: string;
  status: string; note: string; totalAmount: number;
  paidAmount: number; debtAmount: number;
  paymentType: string; currency: string;
  createdAt: string; saleItems: SaleItem[];
};
type PaymentType = "naqd" | "nasiya" | "aralash";

// ── Tier price helpers (inclusive min<=qty<=max range) ──────────────────────────
function getTier(prod: SalesProd, qty: number): Tier | null {
  if (!prod.tiers || prod.tiers.length === 0 || qty <= 0) return null;
  const sorted = [...prod.tiers].sort((a, b) => a.minQty - b.minQty);
  return sorted.find(t => qty >= t.minQty && qty <= t.maxQty) ?? null;
}
function getTierPrice(prod: SalesProd, qty: number): number {
  const t = getTier(prod, qty);
  return t ? t.price : prod.defaultPrice;
}
function getTierCurrency(prod: SalesProd, qty: number): string {
  const t = getTier(prod, qty);
  return t ? t.currency : prod.currency;
}
function getTierLabel(prod: SalesProd, qty: number): string | null {
  if (qty <= 0) return null;
  const t = getTier(prod, qty);
  if (t) return `Bosqich: ${t.minQty.toLocaleString()}–${t.maxQty.toLocaleString()} ${prod.saleType}`;
  if (prod.tiers && prod.tiers.length > 0) return "Standart narx ishlatildi (mos bosqich yo'q)";
  return null;
}

const SALES_Q_KEY    = ["sales-v2"];
const SALES_PROD_KEY = ["sales-products"];

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtAmt(amount: number, currency: string) {
  if (currency === "USD") return `${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
  return `${amount.toLocaleString("uz-UZ")} so'm`;
}
function groupTotals(items: SaleItem[] | DraftItem[]) {
  const totals: Record<string, number> = {};
  for (const it of items) totals[it.currency] = (totals[it.currency] ?? 0) + it.lineTotal;
  return totals;
}

// ── Status badge ──────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  if (status === "paid")
    return <Badge className="bg-green-100 text-green-700 border-green-200 gap-1"><CheckCircle2 className="w-3 h-3" /> To'langan</Badge>;
  if (status === "partial")
    return <Badge className="bg-blue-100 text-blue-700 border-blue-200 gap-1"><Shuffle className="w-3 h-3" /> Qisman</Badge>;
  return <Badge variant="outline" className="gap-1 text-amber-600 border-amber-300"><Clock className="w-3 h-3" /> Nasiya</Badge>;
}

function PaymentTypeBadge({ type }: { type: string }) {
  if (type === "naqd")    return <span className="text-xs text-green-700 bg-green-50 border border-green-200 px-1.5 py-0.5 rounded flex items-center gap-1"><Banknote className="w-3 h-3" /> Naqd</span>;
  if (type === "nasiya")  return <span className="text-xs text-red-700 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded flex items-center gap-1"><CreditCard className="w-3 h-3" /> Nasiya</span>;
  return <span className="text-xs text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded flex items-center gap-1"><Shuffle className="w-3 h-3" /> Aralash</span>;
}

// ── Schemas ───────────────────────────────────────────────────────────────────
const mainSchema = z.object({
  customerId: z.coerce.number().min(1, "Mijoz tanlanishi shart"),
  status:     z.string().default("pending"),
  note:       z.string().default(""),
});
const itemSchema = z.object({
  product:  z.string().min(1, "Mahsulot tanlang"),
  quantity: z.coerce.number().min(0.001, "Miqdor 0 dan katta bo'lsin"),
});

// ── AddPaymentDialog ──────────────────────────────────────────────────────────
function AddPaymentDialog({ sale, onSuccess }: { sale: Sale; onSuccess: () => void }) {
  const [open, setOpen]   = useState(false);
  const [amt, setAmt]     = useState("");
  const [note, setNote]   = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr]     = useState("");

  const debtLabel = fmtAmt(sale.debtAmount, sale.currency);

  async function handlePay() {
    const a = Number(amt);
    if (!a || a <= 0) { setErr("Musbat miqdor kiriting"); return; }
    if (a > sale.debtAmount + 0.001) { setErr(`Nasiya miqdoridan ko'p: ${debtLabel}`); return; }
    setSaving(true); setErr("");
    try {
      const res = await authFetch(`/api/sales/${sale.id}/payments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: a, currency: sale.currency, note }),
      });
      if (!res.ok) { const d = await res.json(); setErr(d.error ?? "Xatolik"); return; }
      onSuccess();
      setOpen(false); setAmt(""); setNote("");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  function fillAll() { setAmt(String(sale.debtAmount)); }

  return (
    <>
      <Button
        variant="outline" size="sm"
        className="h-7 text-xs gap-1 border-blue-300 text-blue-700 hover:bg-blue-50"
        onClick={e => { e.stopPropagation(); setOpen(true); }}
      >
        <Plus className="w-3 h-3" /> To'lov
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Banknote className="w-4 h-4 text-green-600" /> To'lov qo'shish
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* Nasiya info */}
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 space-y-1">
              <p className="text-xs text-amber-600 font-medium">Qolgan nasiya</p>
              <p className="text-xl font-bold text-amber-700">{debtLabel}</p>
            </div>

            {/* Amount */}
            <div>
              <label className="text-sm font-medium mb-1.5 block">To'lov miqdori ({sale.currency})</label>
              <div className="flex gap-2">
                <Input
                  type="number" min={0} step="0.01"
                  placeholder={`0.00`}
                  value={amt} onChange={e => { setAmt(e.target.value); setErr(""); }}
                  className="flex-1"
                />
                <Button variant="outline" size="sm" onClick={fillAll} className="whitespace-nowrap text-xs">
                  Hammasi
                </Button>
              </div>
              {amt && Number(amt) > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  To'lovdan keyin qoladi: <span className="font-medium text-amber-600">
                    {fmtAmt(Math.max(0, sale.debtAmount - Number(amt)), sale.currency)}
                  </span>
                </p>
              )}
            </div>

            {/* Note */}
            <div>
              <label className="text-sm font-medium mb-1.5 block">Izoh (ixtiyoriy)</label>
              <Input placeholder="masalan: bank o'tkazmasi" value={note} onChange={e => setNote(e.target.value)} />
            </div>

            {err && <p className="text-destructive text-sm">{err}</p>}

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setOpen(false)}>Bekor</Button>
              <Button onClick={handlePay} disabled={saving || !amt}>
                {saving ? "Saqlanmoqda..." : "Saqlash"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── PaymentHistoryDialog ──────────────────────────────────────────────────────
function PaymentHistoryDialog({ saleId, currency }: { saleId: number; currency: string }) {
  const [open, setOpen] = useState(false);
  const { data: payments = [], isLoading } = useQuery({
    queryKey: ["sale-payments", saleId],
    queryFn: async () => {
      const r = await authFetch(`/api/sales/${saleId}/payments`);
      return r.json();
    },
    enabled: open,
  });

  return (
    <>
      <Button
        variant="ghost" size="sm"
        className="h-7 text-xs gap-1 text-muted-foreground"
        onClick={e => { e.stopPropagation(); setOpen(true); }}
      >
        <History className="w-3 h-3" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>To'lovlar tarixi</DialogTitle>
          </DialogHeader>
          {isLoading ? (
            <div className="space-y-2">{Array.from({length:3}).map((_,i)=><Skeleton key={i} className="h-10"/>)}</div>
          ) : payments.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">To'lovlar yo'q</p>
          ) : (
            <div className="space-y-2">
              {payments.map((p: any) => (
                <div key={p.id} className="flex items-center justify-between border rounded p-2.5 text-sm">
                  <div>
                    <p className="font-medium text-green-700">{fmtAmt(p.amount, currency)}</p>
                    {p.note && <p className="text-xs text-muted-foreground">{p.note}</p>}
                  </div>
                  <p className="text-xs text-muted-foreground">{String(p.createdAt).slice(0,10)}</p>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── NewSaleDialog ─────────────────────────────────────────────────────────────
function NewSaleDialog({
  customers, salesProducts, onSave,
}: {
  customers: any[];
  salesProducts: SalesProd[];
  onSave: (data: any) => Promise<void>;
}) {
  const [open, setOpen]           = useState(false);
  const [draftItems, setDraftItems] = useState<DraftItem[]>([]);
  const [editKey, setEditKey]     = useState<string | null>(null);
  const [saving, setSaving]       = useState(false);
  const [itemError, setItemError] = useState("");

  // Payment type state
  const [paymentType, setPaymentType] = useState<PaymentType>("naqd");
  const [paidInput, setPaidInput]     = useState("");

  const mainForm = useForm<z.infer<typeof mainSchema>>({
    resolver: zodResolver(mainSchema),
    defaultValues: { customerId: 0, status: "pending", note: "" },
  });
  const itemForm = useForm<z.infer<typeof itemSchema>>({
    resolver: zodResolver(itemSchema),
    defaultValues: { product: "", quantity: 0 },
  });

  const watchProd   = itemForm.watch("product");
  const watchQty    = itemForm.watch("quantity");
  const selProd     = salesProducts.find(p => p.name === watchProd);
  const currentQty  = Number(watchQty) || 0;
  const unitPrice       = selProd ? getTierPrice(selProd, currentQty) : 0;
  const currentCurrency = selProd ? getTierCurrency(selProd, currentQty) : "UZS";
  const lineTotal       = unitPrice * currentQty;
  const tierLabel       = selProd && currentQty > 0 ? getTierLabel(selProd, currentQty) : null;

  // Totals
  const totalAmt = draftItems.reduce((s, it) => s + it.lineTotal, 0);
  const currency = draftItems[0]?.currency ?? "USD";
  const paidAmt  = paymentType === "naqd" ? totalAmt
                 : paymentType === "nasiya" ? 0
                 : Math.min(Number(paidInput) || 0, totalAmt);
  const debtAmt  = totalAmt - paidAmt;

  function addItem() {
    if (!selProd) return;
    const vals = itemForm.getValues();
    const qty  = Number(vals.quantity);
    if (!qty || qty <= 0) { setItemError("Miqdorni to'g'ri kiriting"); return; }
    setItemError("");
    const price = getTierPrice(selProd, qty);

    if (editKey) {
      setDraftItems(prev => prev.map(it =>
        it.key === editKey ? { ...it, quantity: qty, unitPrice: price, currency: getTierCurrency(selProd, qty), lineTotal: qty * price } : it
      ));
      setEditKey(null);
    } else {
      setDraftItems(prev => [...prev, {
        key: crypto.randomUUID(),
        productName: selProd.name,
        saleType: selProd.saleType,
        quantity: qty,
        unitPrice: price,
        currency: getTierCurrency(selProd, qty),
        lineTotal: qty * price,
      }]);
    }
    itemForm.reset();
  }

  function startEdit(item: DraftItem) {
    setEditKey(item.key);
    itemForm.setValue("product", item.productName);
    itemForm.setValue("quantity", item.quantity);
  }
  function removeItem(key: string) { setDraftItems(prev => prev.filter(it => it.key !== key)); }

  async function handleSave() {
    const mainValid = await mainForm.trigger();
    if (!mainValid) return;
    if (draftItems.length === 0) { setItemError("Kamida bitta mahsulot qo'shing"); return; }
    setSaving(true);
    try {
      const vals = mainForm.getValues();
      await onSave({
        customerId: vals.customerId,
        note: vals.note,
        items: draftItems,
        paymentType,
        paidAmount: paidAmt,
      });
      setOpen(false);
      setDraftItems([]); mainForm.reset(); itemForm.reset();
      setPaymentType("naqd"); setPaidInput("");
    } finally {
      setSaving(false);
    }
  }

  function handleClose(v: boolean) {
    if (!v) { setDraftItems([]); mainForm.reset(); itemForm.reset(); setEditKey(null); setPaymentType("naqd"); setPaidInput(""); }
    setOpen(v);
  }

  const totals = groupTotals(draftItems);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogTrigger asChild>
        <Button><Plus className="w-4 h-4 mr-2" /> Sotuv qo'shish</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Yangi sotuv</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {/* ── Main fields ── */}
          <Form {...mainForm}>
            <div className="grid grid-cols-2 gap-4">
              <FormField control={mainForm.control} name="customerId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Mijoz</FormLabel>
                  <FormControl>
                    <SearchCombobox
                      options={customers?.map((c: any) => ({ value: c.id.toString(), label: c.name })) ?? []}
                      value={field.value?.toString() ?? ""}
                      onChange={v => field.onChange(v ? parseInt(v) : 0)}
                      placeholder="Mijoz tanlang"
                      searchPlaceholder="Mijoz qidirish..."
                      emptyText="Mijoz topilmadi"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={mainForm.control} name="note" render={({ field }) => (
                <FormItem>
                  <FormLabel>Izoh (ixtiyoriy)</FormLabel>
                  <FormControl><Input placeholder="qo'shimcha ma'lumot..." {...field} /></FormControl>
                </FormItem>
              )} />
            </div>
          </Form>

          {/* ── Item builder ── */}
          <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
            <p className="text-sm font-medium flex items-center gap-2">
              <PackagePlus className="w-4 h-4" /> Mahsulot qo'shish
            </p>
            <Form {...itemForm}>
              <div className="grid grid-cols-[1fr_140px] gap-3">
                <FormField control={itemForm.control} name="product" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Mahsulot</FormLabel>
                    <FormControl>
                      <SearchCombobox
                        options={salesProducts.map(p => ({ value: p.name, label: p.name }))}
                        value={field.value}
                        onChange={v => { field.onChange(v); itemForm.setValue("quantity", 0); setItemError(""); }}
                        placeholder="Mahsulot tanlang"
                        searchPlaceholder="Mahsulot qidirish..."
                        emptyText="Mahsulot topilmadi"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={itemForm.control} name="quantity" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Miqdor ({selProd?.saleType ?? "dona"})</FormLabel>
                    <FormControl>
                      <Input type="number" min={0} step={selProd?.saleType === "kg" ? "0.01" : "1"} placeholder="0" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
            </Form>

            {selProd && (
              <div className="flex items-center gap-3 text-sm bg-background rounded p-2 border flex-wrap">
                <span className="text-muted-foreground">Narx:</span>
                <span className="font-semibold text-emerald-700">
                  {currentCurrency === "USD" ? `$${unitPrice}` : `${unitPrice.toLocaleString()} so'm`} / {selProd.saleType}
                </span>
                {tierLabel && (
                  <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">{tierLabel}</span>
                )}
                <span className="text-muted-foreground ml-auto">Jami:</span>
                <span className="font-bold text-primary">
                  {currentCurrency === "USD" ? `${lineTotal.toFixed(2)} $` : `${lineTotal.toLocaleString()} so'm`}
                </span>
              </div>
            )}

            {itemError && <p className="text-destructive text-xs">{itemError}</p>}

            <Button type="button" variant="outline" size="sm" onClick={addItem} disabled={!selProd}>
              {editKey ? <><Pencil className="w-3 h-3 mr-1" /> Saqlash</> : <><Plus className="w-3 h-3 mr-1" /> Qo'shish</>}
            </Button>
          </div>

          {/* ── Draft items table ── */}
          {draftItems.length > 0 && (
            <div className="rounded-lg border overflow-hidden">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Mahsulot</TableHead>
                    <TableHead className="text-right">Miqdor</TableHead>
                    <TableHead className="text-right">Narx</TableHead>
                    <TableHead className="text-right">Jami</TableHead>
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {draftItems.map(it => (
                    <TableRow key={it.key} className={editKey === it.key ? "bg-primary/5" : ""}>
                      <TableCell className="font-medium text-sm">{it.productName}</TableCell>
                      <TableCell className="text-right text-sm">{it.quantity} {it.saleType}</TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">{fmtAmt(it.unitPrice, it.currency)}</TableCell>
                      <TableCell className="text-right font-semibold text-sm">{fmtAmt(it.lineTotal, it.currency)}</TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEdit(it)}><Pencil className="w-3 h-3" /></Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => removeItem(it.key)}><Trash2 className="w-3 h-3" /></Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="border-t px-4 py-2 bg-muted/30 flex gap-6 justify-end text-sm">
                <span className="text-muted-foreground">Umumiy:</span>
                {Object.entries(totals).map(([cur, amt]) => (
                  <span key={cur} className="font-bold">{fmtAmt(amt, cur)}</span>
                ))}
              </div>
            </div>
          )}

          {/* ── TO'LOV QISMI ── */}
          {draftItems.length > 0 && (
            <div className="border rounded-lg p-4 space-y-4 bg-muted/20">
              <p className="text-sm font-semibold">💳 To'lov usuli</p>

              {/* Payment type selector */}
              <div className="grid grid-cols-3 gap-2">
                {(["naqd", "nasiya", "aralash"] as PaymentType[]).map(pt => (
                  <button
                    key={pt}
                    type="button"
                    onClick={() => { setPaymentType(pt); setPaidInput(""); }}
                    className={`rounded-lg border-2 p-3 text-sm font-medium transition-all flex flex-col items-center gap-1 ${
                      paymentType === pt
                        ? pt === "naqd"   ? "border-green-500 bg-green-50 text-green-700"
                        : pt === "nasiya" ? "border-red-400 bg-red-50 text-red-700"
                                          : "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-border text-muted-foreground hover:border-primary/40"
                    }`}
                  >
                    {pt === "naqd"   && <><Banknote className="w-5 h-5" /> Naqd to'liq</>}
                    {pt === "nasiya" && <><CreditCard className="w-5 h-5" /> Nasiya</>}
                    {pt === "aralash"&& <><Shuffle className="w-5 h-5" /> Aralash</>}
                  </button>
                ))}
              </div>

              {/* Aralash — naqd miqdori kiriting */}
              {paymentType === "aralash" && totalAmt > 0 && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">Hozir naqd qilinadi ({currency})</label>
                  <div className="flex gap-2 items-center">
                    <Input
                      type="number" min={0} step="0.01"
                      placeholder="0.00"
                      value={paidInput}
                      onChange={e => setPaidInput(e.target.value)}
                      className="max-w-[180px]"
                    />
                    <Button variant="outline" size="sm" onClick={() => setPaidInput(String(totalAmt))} className="text-xs">
                      Hammasi
                    </Button>
                  </div>

                  {/* Summary box */}
                  <div className="grid grid-cols-3 gap-2 mt-2">
                    <div className="rounded bg-green-50 border border-green-200 px-3 py-2 text-center">
                      <p className="text-xs text-green-600 mb-0.5">Naqd</p>
                      <p className="font-bold text-green-700 text-sm">{fmtAmt(paidAmt, currency)}</p>
                    </div>
                    <div className="rounded bg-amber-50 border border-amber-200 px-3 py-2 text-center">
                      <p className="text-xs text-amber-600 mb-0.5">Nasiya</p>
                      <p className="font-bold text-amber-700 text-sm">{fmtAmt(debtAmt, currency)}</p>
                    </div>
                    <div className="rounded bg-muted border px-3 py-2 text-center">
                      <p className="text-xs text-muted-foreground mb-0.5">Jami</p>
                      <p className="font-bold text-sm">{fmtAmt(totalAmt, currency)}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Naqd summary */}
              {paymentType === "naqd" && totalAmt > 0 && (
                <div className="rounded bg-green-50 border border-green-200 px-4 py-2.5 flex items-center gap-3">
                  <CheckCircle2 className="w-4 h-4 text-green-600" />
                  <span className="text-sm text-green-700 font-medium">
                    {fmtAmt(totalAmt, currency)} — to'liq naqd to'langan
                  </span>
                </div>
              )}

              {/* Nasiya summary */}
              {paymentType === "nasiya" && totalAmt > 0 && (
                <div className="rounded bg-red-50 border border-red-200 px-4 py-2.5 flex items-center gap-3">
                  <CreditCard className="w-4 h-4 text-red-500" />
                  <span className="text-sm text-red-700 font-medium">
                    {fmtAmt(totalAmt, currency)} — nasiyaga qoldiriladi
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)}>Bekor qilish</Button>
            <Button onClick={handleSave} disabled={saving || draftItems.length === 0}>
              {saving ? "Saqlanmoqda..." : "Saqlash"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── SaleRow ───────────────────────────────────────────────────────────────────
function SaleRow({ sale, onDelete, onStatusToggle, onPaymentAdded }: {
  sale: Sale;
  onDelete: () => void;
  onStatusToggle: () => void;
  onPaymentAdded: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const totals = groupTotals(sale.saleItems);
  const hasDebt = sale.debtAmount > 0.001;

  return (
    <>
      <TableRow className="cursor-pointer hover:bg-muted/30" onClick={() => setExpanded(v => !v)}>
        <TableCell className="text-muted-foreground text-sm">{sale.id}</TableCell>
        <TableCell>
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{sale.customerName}</span>
            <PaymentTypeBadge type={sale.paymentType ?? "naqd"} />
          </div>
        </TableCell>
        <TableCell className="text-sm">
          <span className="text-muted-foreground">{sale.saleItems.length} ta mahsulot</span>
        </TableCell>
        <TableCell>
          <div className="space-y-0.5">
            {Object.entries(totals).map(([cur, amt]) => (
              <div key={cur} className="text-sm font-medium">{fmtAmt(amt, cur)}</div>
            ))}
            {sale.saleItems.length === 0 && <span className="text-sm text-muted-foreground">{fmtAmt(sale.totalAmount, sale.currency ?? "USD")}</span>}
            {/* Debt info */}
            {hasDebt && (
              <div className="text-xs text-amber-600 font-medium">
                Nasiya: {fmtAmt(sale.debtAmount, sale.currency ?? "USD")}
              </div>
            )}
          </div>
        </TableCell>
        <TableCell>
          <button onClick={e => { e.stopPropagation(); onStatusToggle(); }}>
            <StatusBadge status={sale.status} />
          </button>
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">{sale.createdAt?.slice(0, 10)}</TableCell>
        <TableCell>
          <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
            {hasDebt && (
              <>
                <AddPaymentDialog sale={sale} onSuccess={onPaymentAdded} />
                <PaymentHistoryDialog saleId={sale.id} currency={sale.currency ?? "USD"} />
              </>
            )}
            <span className="text-muted-foreground">{expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</span>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10">
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Sotuvni o'chirish?</AlertDialogTitle>
                  <AlertDialogDescription>Savdo va uning barcha mahsulotlari o'chiriladi.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Bekor</AlertDialogCancel>
                  <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={onDelete}>
                    O'chirish
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </TableCell>
      </TableRow>

      {expanded && sale.saleItems.length > 0 && (
        <TableRow className="bg-muted/20">
          <TableCell />
          <TableCell colSpan={6} className="py-2">
            <div className="rounded border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Mahsulot</th>
                    <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Miqdor</th>
                    <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Narx</th>
                    <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Jami</th>
                  </tr>
                </thead>
                <tbody>
                  {sale.saleItems.map(it => (
                    <tr key={it.id} className="border-t">
                      <td className="px-3 py-1.5 font-medium">{it.productName}</td>
                      <td className="px-3 py-1.5 text-right">{it.quantity} {it.saleType}</td>
                      <td className="px-3 py-1.5 text-right text-muted-foreground">{fmtAmt(it.unitPrice, it.currency)}</td>
                      <td className="px-3 py-1.5 text-right font-semibold">{fmtAmt(it.lineTotal, it.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Payment summary in expanded */}
            {(sale.paymentType === "aralash" || sale.paymentType === "nasiya") && (
              <div className="mt-2 flex gap-3 text-sm">
                {sale.paidAmount > 0 && (
                  <span className="text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1">
                    Naqd: {fmtAmt(sale.paidAmount, sale.currency ?? "USD")}
                  </span>
                )}
                {sale.debtAmount > 0 && (
                  <span className="text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                    Nasiya: {fmtAmt(sale.debtAmount, sale.currency ?? "USD")}
                  </span>
                )}
              </div>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Sales() {
  const queryClient  = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: salesData, isLoading } = useQuery<{ items: Sale[]; total: number }>({
    queryKey: [...SALES_Q_KEY, statusFilter],
    queryFn: async () => {
      const qs  = statusFilter !== "all" ? `?status=${statusFilter}` : "";
      const res = await authFetch(`/api/sales${qs}`);
      if (!res.ok) throw new Error("Fetch failed");
      return res.json();
    },
  });

  const { data: customers }      = useGetCustomers({ query: { queryKey: getGetCustomersQueryKey() } });
  const { data: salesProducts = [] } = useQuery<SalesProd[]>({
    queryKey: SALES_PROD_KEY,
    queryFn: async () => { const r = await authFetch("/api/sales-products"); return r.json(); },
  });

  const createSale = useMutation({
    mutationFn: async (data: any) => {
      const res = await authFetch("/api/sales", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SALES_Q_KEY }),
  });

  const deleteSale = useDeleteSale({
    mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: SALES_Q_KEY }) },
  });

  function handleStatusToggle(sale: Sale) {
    const newStatus = sale.status === "paid" ? (sale.paymentType === "nasiya" ? "pending" : "partial") : "paid";
    authFetch(`/api/sales/${sale.id}/status`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    }).then(() => queryClient.invalidateQueries({ queryKey: SALES_Q_KEY }));
  }

  const items     = salesData?.items ?? [];
  const total     = salesData?.total ?? 0;
  const allItems  = items.flatMap(s => s.saleItems);
  const totalsUZS = allItems.filter(i => i.currency === "UZS").reduce((s, i) => s + i.lineTotal, 0);
  const totalsUSD = allItems.filter(i => i.currency === "USD").reduce((s, i) => s + i.lineTotal, 0);
  const totalDebt = items.filter(s => s.currency === "USD").reduce((s, i) => s + i.debtAmount, 0);
  const paidCount = items.filter(s => s.status === "paid").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Savdolar</h1>
          <p className="text-sm text-muted-foreground mt-1">Naqd, nasiya va aralash to'lovlar</p>
        </div>
        <NewSaleDialog
          customers={customers ?? []}
          salesProducts={salesProducts}
          onSave={data => createSale.mutateAsync(data)}
        />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <ShoppingBag className="w-5 h-5 text-primary" />
            </div>
            <div><div className="text-2xl font-bold">{total}</div><div className="text-xs text-muted-foreground">Jami savdo</div></div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-green-100 flex items-center justify-center">
              <CheckCircle2 className="w-5 h-5 text-green-600" />
            </div>
            <div><div className="text-2xl font-bold">{paidCount}</div><div className="text-xs text-muted-foreground">To'langan</div></div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-100 flex items-center justify-center">
              <ShoppingBag className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              {totalsUZS > 0 && <div className="text-sm font-bold">{totalsUZS.toLocaleString()} so'm</div>}
              {totalsUSD > 0 && <div className="text-sm font-bold">{totalsUSD.toFixed(2)} $</div>}
              {!totalsUZS && !totalsUSD && <div className="text-sm font-bold">0</div>}
              <div className="text-xs text-muted-foreground">Jami summa</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-red-100 flex items-center justify-center">
              <CreditCard className="w-5 h-5 text-red-500" />
            </div>
            <div>
              <div className="text-sm font-bold text-red-600">{totalDebt > 0 ? `${totalDebt.toFixed(2)} $` : "0"}</div>
              <div className="text-xs text-muted-foreground">Jami nasiya</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filter */}
      <div className="flex gap-2">
        {(["all","pending","partial","paid"] as const).map(s => (
          <Button key={s} variant={statusFilter === s ? "default" : "outline"} size="sm" onClick={() => setStatusFilter(s)}>
            {s === "all" ? "Barchasi" : s === "pending" ? "Nasiya" : s === "partial" ? "Qisman" : "To'langan"}
          </Button>
        ))}
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Mijoz</TableHead>
                <TableHead>Mahsulotlar</TableHead>
                <TableHead>Summa</TableHead>
                <TableHead>Holat</TableHead>
                <TableHead>Sana</TableHead>
                <TableHead className="w-[140px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 7 }).map((_, j) => <TableCell key={j}><Skeleton className="h-5 w-16" /></TableCell>)}
                  </TableRow>
                ))
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                    <ShoppingBag className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    Hozircha savdolar yo'q.
                  </TableCell>
                </TableRow>
              ) : (
                items.map(sale => (
                  <SaleRow
                    key={sale.id}
                    sale={sale}
                    onDelete={() => deleteSale.mutate({ id: sale.id })}
                    onStatusToggle={() => handleStatusToggle(sale)}
                    onPaymentAdded={() => queryClient.invalidateQueries({ queryKey: SALES_Q_KEY })}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
