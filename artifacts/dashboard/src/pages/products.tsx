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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Trash2, Package, ShoppingCart } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const prodFormSchema = z.object({
  name: z.string().min(1, "Mahsulot nomi kiritilishi shart"),
  rateType: z.enum(["per_kg", "per_piece"]),
  rate: z.coerce.number().min(0, "Narx musbat bo'lishi shart"),
});

const salesFormSchema = z.object({
  name:  z.string().min(1, "Nomi kiritilishi shart"),
  unit:  z.enum(["dona", "kg", "metr", "qop"]),
  price: z.coerce.number().min(0),
});

type SalesProduct = { id: number; name: string; unit: string; price: number };

const SALES_PRODUCTS_KEY = ["sales-products"];

function useSalesProducts() {
  return useQuery<SalesProduct[]>({
    queryKey: SALES_PRODUCTS_KEY,
    queryFn: async () => {
      const res = await fetch("/api/sales-products");
      if (!res.ok) throw new Error("Fetch failed");
      return res.json();
    },
  });
}

function useCreateSalesProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string; unit: string; price: number }) => {
      const res = await fetch("/api/sales-products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
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
    mutationFn: async (id: number) => {
      await fetch(`/api/sales-products/${id}`, { method: "DELETE" });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: SALES_PRODUCTS_KEY }),
  });
}

export default function Products() {
  const queryClient = useQueryClient();
  const [isProdOpen, setIsProdOpen] = useState(false);
  const [isSalesOpen, setIsSalesOpen] = useState(false);

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
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetProductsQueryKey() })
    }
  });

  const createSalesProd = useCreateSalesProduct();
  const deleteSalesProd = useDeleteSalesProduct();

  const prodForm = useForm<z.infer<typeof prodFormSchema>>({
    resolver: zodResolver(prodFormSchema),
    defaultValues: { name: "", rateType: "per_kg", rate: 0 },
  });

  const salesForm = useForm<z.infer<typeof salesFormSchema>>({
    resolver: zodResolver(salesFormSchema),
    defaultValues: { name: "", unit: "dona", price: 0 },
  });

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

        {/* ── Production products tab ── */}
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
                        <FormControl>
                          <Input placeholder="masalan: Arqon 12mm Ko'k" {...field} data-testid="input-product-name" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={prodForm.control} name="rateType" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Hisoblash usuli</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl>
                              <SelectTrigger data-testid="select-product-ratetype">
                                <SelectValue placeholder="Tanlang" />
                              </SelectTrigger>
                            </FormControl>
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
                          <FormControl>
                            <Input type="number" placeholder="0" {...field} data-testid="input-product-rate" />
                          </FormControl>
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
                            {product.rateType === 'per_kg' ? "kg bo'yicha" : "dona bo'yicha"}
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
                                <AlertDialogDescription>
                                  {product.name} katalogdan o'chiriladi.
                                </AlertDialogDescription>
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

        {/* ── Sales products tab ── */}
        <TabsContent value="sales" className="space-y-4 mt-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">Savdo formasida ko'rinadigan sotuv mahsulotlari</p>
            <Dialog open={isSalesOpen} onOpenChange={setIsSalesOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="w-4 h-4 mr-2" /> Sotuv mahsulot qo'shish
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Yangi sotuv mahsuloti</DialogTitle>
                  <DialogDescription>Mijozlarga sotiladigan mahsulot nomini kiriting.</DialogDescription>
                </DialogHeader>
                <Form {...salesForm}>
                  <form onSubmit={salesForm.handleSubmit(v => {
                    createSalesProd.mutate(v, {
                      onSuccess: () => { setIsSalesOpen(false); salesForm.reset(); }
                    });
                  })} className="space-y-4">
                    <FormField control={salesForm.control} name="name" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Mahsulot nomi</FormLabel>
                        <FormControl>
                          <Input placeholder="masalan: Arqon 12mm Ko'k 100m" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={salesForm.control} name="unit" render={({ field }) => (
                        <FormItem>
                          <FormLabel>O'lchov birligi</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                            <SelectContent>
                              <SelectItem value="dona">Dona</SelectItem>
                              <SelectItem value="kg">Kilogramm</SelectItem>
                              <SelectItem value="metr">Metr</SelectItem>
                              <SelectItem value="qop">Qop</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={salesForm.control} name="price" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Narx (so'm)</FormLabel>
                          <FormControl>
                            <Input type="number" placeholder="0" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <DialogFooter className="pt-4">
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
                    <TableHead>Birlik</TableHead>
                    <TableHead className="text-right">Narx</TableHead>
                    <TableHead className="text-right w-[80px]"></TableHead>
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
                      </TableRow>
                    ))
                  ) : salesProducts?.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-12 text-muted-foreground">
                        <ShoppingCart className="w-8 h-8 mx-auto mb-2 opacity-30" />
                        Sotuv mahsulotlari kiritilmagan.<br />
                        <span className="text-xs">Yuqoridagi tugmadan qo'shing</span>
                      </TableCell>
                    </TableRow>
                  ) : (
                    salesProducts?.map(sp => (
                      <TableRow key={sp.id}>
                        <TableCell className="font-medium">{sp.name}</TableCell>
                        <TableCell>
                          <span className="text-xs uppercase tracking-wider text-muted-foreground bg-muted px-2 py-1 rounded">
                            {sp.unit}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-mono font-medium">
                          {sp.price > 0 ? formatCurrency(sp.price) : "—"}
                        </TableCell>
                        <TableCell className="text-right">
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
