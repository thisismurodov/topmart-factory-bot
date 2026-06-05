import { useState } from "react";
import {
  useGetSales, getGetSalesQueryKey,
  useCreateSale,
  useDeleteSale,
  useUpdateSaleStatus,
  useGetCustomers, getGetCustomersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
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
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Plus, Trash2, ShoppingBag, CheckCircle2, Clock } from "lucide-react";

type SalesProduct = { id: number; name: string; saleType: string; defaultPrice: number; currency: string };

const SALES_PRODUCTS_KEY = ["sales-products"];

const formSchema = z.object({
  customerId:  z.coerce.number().min(1, "Mijoz tanlanishi shart"),
  product:     z.string().min(1, "Mahsulot tanlanishi shart"),
  quantity:    z.coerce.number().min(0.01, "Miqdor kiritilishi shart"),
  status:      z.string().min(1),
  note:        z.string(),
});

function StatusBadge({ status }: { status: string }) {
  if (status === "paid") {
    return (
      <Badge className="bg-green-100 text-green-700 border-green-200 gap-1">
        <CheckCircle2 className="w-3 h-3" /> To'langan
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-amber-600 border-amber-300">
      <Clock className="w-3 h-3" /> Kutilmoqda
    </Badge>
  );
}

function formatAmount(amount: number, currency: string) {
  if (currency === "USD") {
    return `${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
  }
  return `${amount.toLocaleString("uz-UZ")} so'm`;
}

export default function Sales() {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { data: sales, isLoading } = useGetSales({
    query: { queryKey: getGetSalesQueryKey({ status: statusFilter === "all" ? undefined : statusFilter }) },
    ...(statusFilter !== "all" ? { status: statusFilter } : {}),
  } as any);

  const { data: customers } = useGetCustomers({
    query: { queryKey: getGetCustomersQueryKey() },
  });

  const { data: salesProducts } = useQuery<SalesProduct[]>({
    queryKey: SALES_PRODUCTS_KEY,
    queryFn: async () => {
      const res = await fetch("/api/sales-products");
      if (!res.ok) throw new Error("Fetch failed");
      return res.json();
    },
  });

  const createSale = useCreateSale({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSalesQueryKey({}) });
        setIsOpen(false);
        form.reset();
      },
    },
  });

  const deleteSale = useDeleteSale({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSalesQueryKey({}) });
      },
    },
  });

  const updateStatus = useUpdateSaleStatus({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSalesQueryKey({}) });
      },
    },
  });

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      customerId: 0, product: "", quantity: 0, status: "pending", note: "",
    },
  });

  const watchProduct  = form.watch("product");
  const watchQty      = form.watch("quantity");

  const selectedProd = salesProducts?.find(p => p.name === watchProduct);
  const unitPrice    = selectedProd?.defaultPrice ?? 0;
  const currency     = selectedProd?.currency ?? "UZS";
  const saleType     = selectedProd?.saleType ?? "dona";
  const totalAmount  = Number(watchQty) * unitPrice;

  function onSubmit(values: z.infer<typeof formSchema>) {
    createSale.mutate({
      data: {
        customerId: values.customerId,
        product:    values.product,
        quantity:   values.quantity,
        weightKg:   saleType === "kg" ? values.quantity : 0,
        unitPrice,
        totalAmount,
        currency,
        status: values.status,
        note:   values.note,
      } as any,
    });
  }

  const items = (sales as any)?.items ?? [];
  const total = (sales as any)?.total ?? 0;
  const totalSumUZS = items
    .filter((x: any) => (x.currency ?? "UZS") === "UZS")
    .reduce((s: number, x: any) => s + x.totalAmount, 0);
  const totalSumUSD = items
    .filter((x: any) => x.currency === "USD")
    .reduce((s: number, x: any) => s + x.totalAmount, 0);
  const paidCount = items.filter((x: any) => x.status === "paid").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Savdolar</h1>
          <p className="text-sm text-muted-foreground mt-1">Mahsulot sotish va to'lov holati</p>
        </div>
        <Dialog open={isOpen} onOpenChange={(o) => { setIsOpen(o); if (!o) form.reset(); }}>
          <DialogTrigger asChild>
            <Button><Plus className="w-4 h-4 mr-2" /> Sotuv qo'shish</Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Yangi sotuv</DialogTitle>
              <DialogDescription>Mijoz va mahsulotni tanlang, miqdorni kiriting.</DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">

                {/* 1. Mijoz */}
                <FormField control={form.control} name="customerId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>1. Mijoz</FormLabel>
                    <Select onValueChange={v => field.onChange(parseInt(v))} value={field.value?.toString()}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Tanlang" /></SelectTrigger></FormControl>
                      <SelectContent>
                        {customers?.map(c => (
                          <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />

                {/* 2. Mahsulot */}
                <FormField control={form.control} name="product" render={({ field }) => (
                  <FormItem>
                    <FormLabel>2. Mahsulot</FormLabel>
                    <Select onValueChange={v => { field.onChange(v); form.setValue("quantity", 0); }} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Tanlang" /></SelectTrigger></FormControl>
                      <SelectContent>
                        {salesProducts?.length === 0 && (
                          <SelectItem value="__none__" disabled>
                            Sotuv mahsulotlari yo'q — Mahsulotlar sahifasidan qo'shing
                          </SelectItem>
                        )}
                        {salesProducts?.map(p => (
                          <SelectItem key={p.id} value={p.name}>
                            {p.name}
                            <span className="ml-2 text-xs text-muted-foreground">
                              {p.currency === "USD"
                                ? `$${p.defaultPrice}`
                                : `${p.defaultPrice.toLocaleString()} so'm`} / {p.saleType}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />

                {/* 3. Miqdor */}
                <FormField control={form.control} name="quantity" render={({ field }) => (
                  <FormItem>
                    <FormLabel>3. Miqdor ({saleType === "kg" ? "kg" : "dona"})</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        step={saleType === "kg" ? "0.1" : "1"}
                        placeholder={`0 ${saleType}`}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                {/* Auto-filled info */}
                {selectedProd && (
                  <div className="rounded-lg border bg-muted/40 p-3 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Narx:</span>
                      <span className="font-medium">
                        {currency === "USD" ? `$${unitPrice}` : `${unitPrice.toLocaleString()} so'm`} / {saleType}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Valyuta:</span>
                      <span className="font-medium">{currency}</span>
                    </div>
                    <div className="flex justify-between border-t pt-2">
                      <span className="text-muted-foreground font-medium">Jami summa:</span>
                      <span className="font-bold text-primary text-base">
                        {currency === "USD"
                          ? `${totalAmount.toFixed(2)} $`
                          : `${totalAmount.toLocaleString()} so'm`}
                      </span>
                    </div>
                  </div>
                )}

                {/* To'lov holati + Izoh */}
                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="status" render={({ field }) => (
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
                  <FormField control={form.control} name="note" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Izoh (ixtiyoriy)</FormLabel>
                      <FormControl><Input placeholder="qo'shimcha..." {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>

                <DialogFooter className="pt-2">
                  <Button type="submit" disabled={createSale.isPending || !selectedProd}>
                    {createSale.isPending ? "Saqlanmoqda..." : "Saqlash"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="border-border">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <ShoppingBag className="w-5 h-5 text-primary" />
            </div>
            <div>
              <div className="text-2xl font-bold">{total}</div>
              <div className="text-xs text-muted-foreground">Jami sotuv</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-green-100 flex items-center justify-center">
              <CheckCircle2 className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <div className="text-2xl font-bold">{paidCount}</div>
              <div className="text-xs text-muted-foreground">To'langan</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-100 flex items-center justify-center">
              <ShoppingBag className="w-5 h-5 text-amber-600" />
            </div>
            <div className="min-w-0">
              {totalSumUZS > 0 && (
                <div className="text-sm font-bold leading-tight">{totalSumUZS.toLocaleString()} so'm</div>
              )}
              {totalSumUSD > 0 && (
                <div className="text-sm font-bold leading-tight">{totalSumUSD.toFixed(2)} $</div>
              )}
              {totalSumUZS === 0 && totalSumUSD === 0 && (
                <div className="text-sm font-bold">0</div>
              )}
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
      <Card className="border-border">
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Mijoz</TableHead>
                <TableHead>Mahsulot</TableHead>
                <TableHead>Miqdor</TableHead>
                <TableHead>Narx</TableHead>
                <TableHead>Jami</TableHead>
                <TableHead>Holat</TableHead>
                <TableHead>Sana</TableHead>
                <TableHead className="w-[60px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 8 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-5 w-16" /></TableCell>
                    ))}
                    <TableCell />
                  </TableRow>
                ))
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">
                    <ShoppingBag className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    Hozircha sotuv yozuvlari yo'q.
                  </TableCell>
                </TableRow>
              ) : (
                items.map((s: any) => {
                  const cur = s.currency ?? "UZS";
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="text-muted-foreground text-sm">{s.id}</TableCell>
                      <TableCell className="font-medium">{s.customerName}</TableCell>
                      <TableCell className="max-w-[140px] truncate">{s.product}</TableCell>
                      <TableCell className="text-sm">
                        {s.quantity > 0 ? `${s.quantity}` : ""}
                        {s.weightKg > 0 && s.weightKg !== s.quantity ? ` (${s.weightKg} kg)` : ""}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatAmount(s.unitPrice, cur)}
                      </TableCell>
                      <TableCell className="font-medium">
                        {formatAmount(s.totalAmount, cur)}
                      </TableCell>
                      <TableCell>
                        <button
                          onClick={() => updateStatus.mutate({ id: s.id, data: { status: s.status === "paid" ? "pending" : "paid" } })}
                          className="cursor-pointer"
                          title="Holatni o'zgartirish"
                        >
                          <StatusBadge status={s.status} />
                        </button>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {s.createdAt?.slice(0, 10)}
                      </TableCell>
                      <TableCell>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10">
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Sotuvni o'chirish?</AlertDialogTitle>
                              <AlertDialogDescription>Bu yozuv o'chiriladi.</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                onClick={() => deleteSale.mutate({ id: s.id })}
                              >
                                O'chirish
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
