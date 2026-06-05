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

const formSchema = z.object({
  customerId:  z.coerce.number().min(1, "Mijoz tanlanishi shart"),
  product:     z.string().min(1, "Mahsulot tanlanishi shart"),
  quantity:    z.coerce.number().min(0),
  weightKg:    z.coerce.number().min(0),
  unitPrice:   z.coerce.number().min(0, "Narx kiritilishi shart"),
  totalAmount: z.coerce.number().min(0),
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

  const { data: products } = useQuery<{ id: number; name: string; unit: string; price: number }[]>({
    queryKey: ["sales-products"],
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
      customerId: 0, product: "", quantity: 0, weightKg: 0,
      unitPrice: 0, totalAmount: 0, status: "pending", note: "",
    },
  });

  const watchQty      = form.watch("quantity");
  const watchWeight   = form.watch("weightKg");
  const watchPrice    = form.watch("unitPrice");
  const watchProduct  = form.watch("product");

  function calcTotal() {
    const prod = products?.find(p => p.name === watchProduct);
    if (!prod) return 0;
    if (prod.unit === "kg") return Number(watchWeight) * Number(watchPrice);
    return Number(watchQty) * Number(watchPrice);
  }

  function onSubmit(values: z.infer<typeof formSchema>) {
    const totalAmount = calcTotal();
    createSale.mutate({ data: { ...values, totalAmount } });
  }

  const items = (sales as any)?.items ?? [];
  const total = (sales as any)?.total ?? 0;
  const totalAmount = items.reduce((s: number, x: any) => s + x.totalAmount, 0);
  const paidCount = items.filter((x: any) => x.status === "paid").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Savdolar</h1>
          <p className="text-sm text-muted-foreground mt-1">Mahsulot sotish va to'lov holati</p>
        </div>
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="w-4 h-4 mr-2" /> Sotuv qo'shish</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Yangi sotuv</DialogTitle>
              <DialogDescription>Mahsulot sotish yozuvini kiriting.</DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="customerId" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Mijoz</FormLabel>
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
                  <FormField control={form.control} name="product" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Mahsulot</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger><SelectValue placeholder="Tanlang" /></SelectTrigger></FormControl>
                        <SelectContent>
                          {products?.map(p => (
                            <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <FormField control={form.control} name="quantity" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Miqdor (dona)</FormLabel>
                      <FormControl><Input type="number" min={0} {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="weightKg" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Og'irlik (kg)</FormLabel>
                      <FormControl><Input type="number" min={0} step="0.1" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="unitPrice" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Narx (so'm)</FormLabel>
                      <FormControl><Input type="number" min={0} {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
                <div className="bg-muted/50 rounded-md p-3 text-sm flex justify-between items-center">
                  <span className="text-muted-foreground">Jami summa:</span>
                  <span className="font-bold text-primary text-base">
                    {calcTotal().toLocaleString()} so'm
                  </span>
                </div>
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
                      <FormControl><Input placeholder="qo'shimcha ma'lumot..." {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
                <DialogFooter className="pt-2">
                  <Button type="submit" disabled={createSale.isPending}>
                    {createSale.isPending ? "Saqlanmoqda..." : "Saqlash"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

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
            <div>
              <div className="text-2xl font-bold text-sm leading-tight pt-1">
                {totalAmount.toLocaleString()} so'm
              </div>
              <div className="text-xs text-muted-foreground">Jami summa</div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex gap-2">
        {["all","pending","paid"].map(s => (
          <Button
            key={s}
            variant={statusFilter === s ? "default" : "outline"}
            size="sm"
            onClick={() => setStatusFilter(s)}
          >
            {s === "all" ? "Barchasi" : s === "pending" ? "Kutilmoqda" : "To'langan"}
          </Button>
        ))}
      </div>

      <Card className="border-border">
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Mijoz</TableHead>
                <TableHead>Mahsulot</TableHead>
                <TableHead>Miqdor</TableHead>
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
                      <TableCell key={j}><Skeleton className="h-5 w-20" /></TableCell>
                    ))}
                    <TableCell />
                  </TableRow>
                ))
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                    <ShoppingBag className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    Hozircha sotuv yozuvlari yo'q.
                  </TableCell>
                </TableRow>
              ) : (
                items.map((s: any) => (
                  <TableRow key={s.id}>
                    <TableCell className="text-muted-foreground text-sm">{s.id}</TableCell>
                    <TableCell className="font-medium">{s.customerName}</TableCell>
                    <TableCell>{s.product}</TableCell>
                    <TableCell className="text-sm">
                      {s.quantity > 0 ? `${s.quantity} dona` : ""}
                      {s.weightKg > 0 ? ` ${s.weightKg} kg` : ""}
                    </TableCell>
                    <TableCell className="font-medium">
                      {s.totalAmount.toLocaleString()} so'm
                    </TableCell>
                    <TableCell>
                      <button
                        onClick={() =>
                          updateStatus.mutate({
                            id: s.id,
                            data: { status: s.status === "paid" ? "pending" : "paid" },
                          })
                        }
                        className="cursor-pointer"
                        title="Holatni o'zgartirish uchun bosing"
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
                            <AlertDialogDescription>
                              Bu yozuv va unga bog'liq ma'lumotlar o'chiriladi.
                            </AlertDialogDescription>
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
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
