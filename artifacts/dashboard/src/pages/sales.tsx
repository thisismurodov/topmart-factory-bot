import { useState } from "react";
import {
  useGetCustomers, getGetCustomersQueryKey,
  useDeleteSale,
  useUpdateSaleStatus,
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Plus, Trash2, ShoppingBag, CheckCircle2, Clock, ChevronDown, ChevronRight, Pencil, PackagePlus } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
type SalesProd = { id: number; name: string; saleType: string; defaultPrice: number; currency: string };
type DraftItem = { key: string; productName: string; saleType: string; quantity: number; unitPrice: number; currency: string; lineTotal: number };
type SaleItem  = { id: number; productName: string; saleType: string; quantity: number; unitPrice: number; currency: string; lineTotal: number };
type Sale      = { id: number; customerId: number; customerName: string; status: string; note: string; totalAmount: number; createdAt: string; saleItems: SaleItem[] };

const SALES_Q_KEY     = ["sales-v2"];
const SALES_PROD_KEY  = ["sales-products"];

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtAmt(amount: number, currency: string) {
  if (currency === "USD") return `${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
  return `${amount.toLocaleString("uz-UZ")} so'm`;
}

function groupTotals(items: SaleItem[] | DraftItem[]) {
  const totals: Record<string, number> = {};
  for (const it of items) {
    totals[it.currency] = (totals[it.currency] ?? 0) + it.lineTotal;
  }
  return totals;
}

function StatusBadge({ status }: { status: string }) {
  if (status === "paid")
    return <Badge className="bg-green-100 text-green-700 border-green-200 gap-1"><CheckCircle2 className="w-3 h-3" /> To'langan</Badge>;
  return <Badge variant="outline" className="gap-1 text-amber-600 border-amber-300"><Clock className="w-3 h-3" /> Kutilmoqda</Badge>;
}

// ── Main form schema ──────────────────────────────────────────────────────────
const mainSchema = z.object({
  customerId: z.coerce.number().min(1, "Mijoz tanlanishi shart"),
  status:     z.string().default("pending"),
  note:       z.string().default(""),
});

// ── Item sub-form schema ──────────────────────────────────────────────────────
const itemSchema = z.object({
  product:  z.string().min(1, "Mahsulot tanlang"),
  quantity: z.coerce.number().min(0.001, "Miqdor 0 dan katta bo'lsin"),
});

// ── New sale dialog ───────────────────────────────────────────────────────────
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

  const mainForm = useForm<z.infer<typeof mainSchema>>({
    resolver: zodResolver(mainSchema),
    defaultValues: { customerId: 0, status: "pending", note: "" },
  });
  const itemForm = useForm<z.infer<typeof itemSchema>>({
    resolver: zodResolver(itemSchema),
    defaultValues: { product: "", quantity: 0 },
  });

  const watchProd = itemForm.watch("product");
  const watchQty  = itemForm.watch("quantity");
  const selProd   = salesProducts.find(p => p.name === watchProd);
  const lineTotal = selProd ? Number(watchQty) * selProd.defaultPrice : 0;

  function addItem() {
    if (!selProd) return;
    const vals = itemForm.getValues();
    const qty  = Number(vals.quantity);
    if (!qty || qty <= 0) { setItemError("Miqdorni to'g'ri kiriting"); return; }
    setItemError("");

    if (editKey) {
      setDraftItems(prev => prev.map(it =>
        it.key === editKey
          ? { ...it, quantity: qty, unitPrice: selProd.defaultPrice, lineTotal: qty * selProd.defaultPrice }
          : it
      ));
      setEditKey(null);
    } else {
      setDraftItems(prev => [...prev, {
        key:         crypto.randomUUID(),
        productName: selProd.name,
        saleType:    selProd.saleType,
        quantity:    qty,
        unitPrice:   selProd.defaultPrice,
        currency:    selProd.currency,
        lineTotal:   qty * selProd.defaultPrice,
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
      await onSave({ customerId: vals.customerId, status: vals.status, note: vals.note, items: draftItems });
      setOpen(false);
      setDraftItems([]);
      mainForm.reset();
      itemForm.reset();
    } finally {
      setSaving(false);
    }
  }

  const totals = groupTotals(draftItems);

  return (
    <Dialog open={open} onOpenChange={v => { setOpen(v); if (!v) { setDraftItems([]); mainForm.reset(); itemForm.reset(); setEditKey(null); } }}>
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
                  <Select onValueChange={v => field.onChange(parseInt(v))} value={field.value?.toString()}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Tanlang" /></SelectTrigger></FormControl>
                    <SelectContent>
                      {customers?.map(c => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={mainForm.control} name="status" render={({ field }) => (
                <FormItem>
                  <FormLabel>To'lov holati</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="pending">Kutilmoqda</SelectItem>
                      <SelectItem value="paid">To'langan</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <FormField control={mainForm.control} name="note" render={({ field }) => (
              <FormItem>
                <FormLabel>Izoh (ixtiyoriy)</FormLabel>
                <FormControl><Input placeholder="qo'shimcha ma'lumot..." {...field} /></FormControl>
              </FormItem>
            )} />
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
                    <Select onValueChange={v => { field.onChange(v); itemForm.setValue("quantity", 0); setItemError(""); }} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Tanlang" /></SelectTrigger></FormControl>
                      <SelectContent>
                        {salesProducts.length === 0
                          ? <SelectItem value="__" disabled>Sotuv mahsulotlari yo'q</SelectItem>
                          : salesProducts.map(p => (
                            <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
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

            {/* Auto info row */}
            {selProd && (
              <div className="flex items-center gap-4 text-sm bg-background rounded p-2 border">
                <span className="text-muted-foreground">Narx:</span>
                <span className="font-medium">{selProd.currency === "USD" ? `$${selProd.defaultPrice}` : `${selProd.defaultPrice.toLocaleString()} so'm`} / {selProd.saleType}</span>
                <span className="text-muted-foreground ml-2">Jami:</span>
                <span className="font-bold text-primary">{selProd.currency === "USD" ? `${lineTotal.toFixed(2)} $` : `${lineTotal.toLocaleString()} so'm`}</span>
                <span className="ml-auto">
                  <Badge variant="outline" className={selProd.currency === "USD" ? "text-green-700 border-green-300" : "text-blue-700 border-blue-300"}>
                    {selProd.currency}
                  </Badge>
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
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEdit(it)}>
                            <Pencil className="w-3 h-3" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => removeItem(it.key)}>
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {/* Totals */}
              <div className="border-t px-4 py-2 bg-muted/30 flex gap-6 justify-end text-sm">
                <span className="text-muted-foreground">Umumiy:</span>
                {Object.entries(totals).map(([cur, amt]) => (
                  <span key={cur} className="font-bold">{fmtAmt(amt, cur)}</span>
                ))}
              </div>
            </div>
          )}

          {/* ── Save button ── */}
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

// ── Sale row with expandable items ────────────────────────────────────────────
function SaleRow({ sale, onDelete, onStatusToggle }: { sale: Sale; onDelete: () => void; onStatusToggle: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const totals = groupTotals(sale.saleItems);

  return (
    <>
      <TableRow className="cursor-pointer hover:bg-muted/30" onClick={() => setExpanded(v => !v)}>
        <TableCell className="text-muted-foreground text-sm">{sale.id}</TableCell>
        <TableCell className="font-medium">{sale.customerName}</TableCell>
        <TableCell className="text-sm">
          <span className="text-muted-foreground">{sale.saleItems.length} ta mahsulot</span>
        </TableCell>
        <TableCell>
          <div className="space-y-0.5">
            {Object.entries(totals).map(([cur, amt]) => (
              <div key={cur} className="text-sm font-medium">{fmtAmt(amt, cur)}</div>
            ))}
            {sale.saleItems.length === 0 && <span className="text-sm text-muted-foreground">{fmtAmt(sale.totalAmount, "UZS")}</span>}
          </div>
        </TableCell>
        <TableCell>
          <button onClick={e => { e.stopPropagation(); onStatusToggle(); }} className="cursor-pointer">
            <StatusBadge status={sale.status} />
          </button>
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">{sale.createdAt?.slice(0, 10)}</TableCell>
        <TableCell>
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">{expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</span>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={e => e.stopPropagation()}>
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
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Sales() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: salesData, isLoading } = useQuery<{ items: Sale[]; total: number }>({
    queryKey: [...SALES_Q_KEY, statusFilter],
    queryFn: async () => {
      const qs = statusFilter !== "all" ? `?status=${statusFilter}` : "";
      const res = await fetch(`/api/sales${qs}`);
      if (!res.ok) throw new Error("Fetch failed");
      return res.json();
    },
  });

  const { data: customers } = useGetCustomers({ query: { queryKey: getGetCustomersQueryKey() } });

  const { data: salesProducts = [] } = useQuery<SalesProd[]>({
    queryKey: SALES_PROD_KEY,
    queryFn: async () => { const r = await fetch("/api/sales-products"); return r.json(); },
  });

  const createSale = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch("/api/sales", {
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

  const updateStatus = useUpdateSaleStatus({
    mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: SALES_Q_KEY }) },
  });

  const items = salesData?.items ?? [];
  const total = salesData?.total ?? 0;
  const allSaleItems = items.flatMap(s => s.saleItems);
  const totalsUZS = allSaleItems.filter(i => i.currency === "UZS").reduce((s, i) => s + i.lineTotal, 0);
  const totalsUSD = allSaleItems.filter(i => i.currency === "USD").reduce((s, i) => s + i.lineTotal, 0);
  const paidCount = items.filter(s => s.status === "paid").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Savdolar</h1>
          <p className="text-sm text-muted-foreground mt-1">Ko'p mahsulotli savdo boshqaruvi</p>
        </div>
        <NewSaleDialog
          customers={customers ?? []}
          salesProducts={salesProducts}
          onSave={data => createSale.mutateAsync(data)}
        />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
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
      </div>

      {/* Filter */}
      <div className="flex gap-2">
        {["all","pending","paid"].map(s => (
          <Button key={s} variant={statusFilter === s ? "default" : "outline"} size="sm" onClick={() => setStatusFilter(s)}>
            {s === "all" ? "Barchasi" : s === "pending" ? "Kutilmoqda" : "To'langan"}
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
                <TableHead className="w-[80px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 7 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-5 w-16" /></TableCell>
                    ))}
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
                    onStatusToggle={() => updateStatus.mutate({ id: sale.id, data: { status: sale.status === "paid" ? "pending" : "paid" } })}
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
