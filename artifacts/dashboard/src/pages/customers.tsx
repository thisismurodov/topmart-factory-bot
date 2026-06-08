import { useState } from "react";
import {
  useGetCustomers, getGetCustomersQueryKey,
  useCreateCustomer, useDeleteCustomer,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Plus, Trash2, Building2, Phone, MapPin, Pencil,
  ShoppingBag, CreditCard, CheckCircle2, Clock, Shuffle,
  Banknote, User, ChevronDown, ChevronRight, TrendingUp,
} from "lucide-react";

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtAmt(amount: number, currency: string) {
  if (currency === "USD") return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${amount.toLocaleString("uz-UZ")} so'm`;
}

function StatusBadge({ status }: { status: string }) {
  if (status === "paid")
    return <Badge className="bg-green-100 text-green-700 border-green-200 text-[10px] px-1.5 py-0 gap-0.5 h-5"><CheckCircle2 className="w-2.5 h-2.5" /> To'langan</Badge>;
  if (status === "partial")
    return <Badge className="bg-blue-100 text-blue-700 border-blue-200 text-[10px] px-1.5 py-0 gap-0.5 h-5"><Shuffle className="w-2.5 h-2.5" /> Qisman</Badge>;
  return <Badge variant="outline" className="text-amber-600 border-amber-300 text-[10px] px-1.5 py-0 gap-0.5 h-5"><Clock className="w-2.5 h-2.5" /> Nasiya</Badge>;
}

function PaymentIcon({ type }: { type: string }) {
  if (type === "naqd")   return <Banknote className="w-3 h-3 text-green-600" />;
  if (type === "nasiya") return <CreditCard className="w-3 h-3 text-red-500" />;
  return <Shuffle className="w-3 h-3 text-blue-500" />;
}

// ── Types ─────────────────────────────────────────────────────────────────────
type Customer = { id: number; name: string; phone: string; company: string; address: string; createdAt: string };
type SaleRow = {
  id: number; status: string; note: string;
  totalAmount: number; paidAmount: number; debtAmount: number;
  paymentType: string; currency: string; createdAt: string;
  items: { productName: string; saleType: string; quantity: number; unitPrice: number; currency: string; lineTotal: number }[];
};
type ProfileStats = {
  totalSales: number; totalAmount: number; totalPaid: number;
  totalDebt: number; paidCount: number; pendingCount: number; partialCount: number;
};
type Profile = { customer: Customer; stats: ProfileStats; sales: SaleRow[] };

// ── Schemas ───────────────────────────────────────────────────────────────────
const customerSchema = z.object({
  name:    z.string().min(1, "Ism kiritilishi shart"),
  phone:   z.string().min(1, "Telefon kiritilishi shart"),
  company: z.string().default(""),
  address: z.string().default(""),
});

// ── EditCustomerDialog ─────────────────────────────────────────────────────────
function EditCustomerDialog({ customer, onSuccess }: { customer: Customer; onSuccess: () => void }) {
  const [open, setOpen] = useState(false);

  const form = useForm<z.infer<typeof customerSchema>>({
    resolver: zodResolver(customerSchema),
    defaultValues: {
      name:    customer.name,
      phone:   customer.phone ?? "",
      company: customer.company ?? "",
      address: customer.address ?? "",
    },
  });

  const update = useMutation({
    mutationFn: async (data: z.infer<typeof customerSchema>) => {
      const res = await fetch(`/api/customers/${customer.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => { onSuccess(); setOpen(false); },
  });

  function handleOpen(v: boolean) {
    if (v) {
      form.reset({ name: customer.name, phone: customer.phone ?? "", company: customer.company ?? "", address: customer.address ?? "" });
    }
    setOpen(v);
  }

  return (
    <>
      <Button
        variant="ghost" size="icon" className="h-8 w-8"
        onClick={e => { e.stopPropagation(); handleOpen(true); }}
      >
        <Pencil className="w-3.5 h-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={handleOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><User className="w-4 h-4" /> Mijozni tahrirlash</DialogTitle>
            <DialogDescription>{customer.name}</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(d => update.mutate(d))} className="space-y-4">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem>
                  <FormLabel>To'liq ismi / kompaniya nomi</FormLabel>
                  <FormControl><Input placeholder="Rahimov Jasur" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="phone" render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-1"><Phone className="w-3 h-3" /> Telefon raqam</FormLabel>
                  <FormControl><Input placeholder="+998901234567" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="company" render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-1"><Building2 className="w-3 h-3" /> Tashkilot (ixtiyoriy)</FormLabel>
                  <FormControl><Input placeholder="masalan: TopMart LLC" {...field} /></FormControl>
                </FormItem>
              )} />
              <FormField control={form.control} name="address" render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-1"><MapPin className="w-3 h-3" /> Manzil (ixtiyoriy)</FormLabel>
                  <FormControl><Input placeholder="masalan: Toshkent, Yunusobod" {...field} /></FormControl>
                </FormItem>
              )} />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setOpen(false)}>Bekor</Button>
                <Button type="submit" disabled={update.isPending}>
                  {update.isPending ? "Saqlanmoqda..." : "Saqlash"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── SaleCard (inside profile) ─────────────────────────────────────────────────
function SaleCard({ sale }: { sale: SaleRow }) {
  const [exp, setExp] = useState(false);
  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-muted/30 transition-colors"
        onClick={() => setExp(v => !v)}
      >
        <div className="flex items-center gap-3">
          <PaymentIcon type={sale.paymentType} />
          <div>
            <div className="text-sm font-medium">{fmtAmt(sale.totalAmount, sale.currency)}</div>
            <div className="text-xs text-muted-foreground">{sale.createdAt?.slice(0, 10)}</div>
          </div>
          {sale.note && <span className="text-xs text-muted-foreground italic">— {sale.note}</span>}
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={sale.status} />
          {sale.debtAmount > 0 && (
            <span className="text-xs text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded font-medium">
              Nasiya: {fmtAmt(sale.debtAmount, sale.currency)}
            </span>
          )}
          {exp ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
        </div>
      </button>

      {exp && sale.items.length > 0 && (
        <div className="border-t bg-muted/10">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-1.5 font-medium text-muted-foreground">Mahsulot</th>
                <th className="text-right px-4 py-1.5 font-medium text-muted-foreground">Miqdor</th>
                <th className="text-right px-4 py-1.5 font-medium text-muted-foreground">Jami</th>
              </tr>
            </thead>
            <tbody>
              {sale.items.map((it, i) => (
                <tr key={i} className="border-t">
                  <td className="px-4 py-1.5 font-medium">{it.productName}</td>
                  <td className="px-4 py-1.5 text-right">{it.quantity} {it.saleType}</td>
                  <td className="px-4 py-1.5 text-right font-semibold">{fmtAmt(it.lineTotal, it.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(sale.paymentType === "aralash" || sale.paymentType === "nasiya") && (
            <div className="px-4 py-2 border-t flex gap-4 text-xs">
              {sale.paidAmount > 0 && <span className="text-green-700">✓ Naqd: {fmtAmt(sale.paidAmount, sale.currency)}</span>}
              {sale.debtAmount > 0 && <span className="text-amber-700">⏳ Nasiya: {fmtAmt(sale.debtAmount, sale.currency)}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── CustomerProfileDialog ─────────────────────────────────────────────────────
function CustomerProfileDialog({ customer, open, onClose, onEdit }: {
  customer: Customer; open: boolean; onClose: () => void; onEdit: () => void;
}) {
  const { data: profile, isLoading } = useQuery<Profile>({
    queryKey: ["customer-profile", customer.id],
    queryFn: async () => {
      const r = await fetch(`/api/customers/${customer.id}/profile`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: open,
  });

  const st = profile?.stats;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <DialogHeader>
          <div className="flex items-start justify-between">
            <div>
              <DialogTitle className="text-xl">{customer.name}</DialogTitle>
              <div className="flex flex-wrap gap-3 mt-2">
                {customer.phone && (
                  <span className="flex items-center gap-1 text-sm text-muted-foreground">
                    <Phone className="w-3.5 h-3.5" /> {customer.phone}
                  </span>
                )}
                {customer.company && (
                  <span className="flex items-center gap-1 text-sm text-muted-foreground">
                    <Building2 className="w-3.5 h-3.5" /> {customer.company}
                  </span>
                )}
                {customer.address && (
                  <span className="flex items-center gap-1 text-sm text-muted-foreground">
                    <MapPin className="w-3.5 h-3.5" /> {customer.address}
                  </span>
                )}
              </div>
            </div>
            <Button variant="outline" size="sm" className="gap-1.5 shrink-0" onClick={onEdit}>
              <Pencil className="w-3 h-3" /> Tahrirlash
            </Button>
          </div>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-3 mt-4">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16" />)}
          </div>
        ) : profile && st ? (
          <div className="space-y-5 mt-2">
            {/* ── Stats grid ── */}
            <div className="grid grid-cols-4 gap-3">
              <div className="rounded-lg border p-3 text-center">
                <div className="text-2xl font-bold">{st.totalSales}</div>
                <div className="text-xs text-muted-foreground mt-0.5">Jami savdo</div>
              </div>
              <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-center">
                <div className="text-2xl font-bold text-green-700">{st.paidCount}</div>
                <div className="text-xs text-green-600 mt-0.5">To'langan</div>
              </div>
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-center">
                <div className="text-2xl font-bold text-blue-700">{st.partialCount}</div>
                <div className="text-xs text-blue-600 mt-0.5">Qisman</div>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-center">
                <div className="text-2xl font-bold text-amber-700">{st.pendingCount}</div>
                <div className="text-xs text-amber-600 mt-0.5">Nasiya</div>
              </div>
            </div>

            {/* ── Financial summary ── */}
            <div className="rounded-lg border p-4 space-y-2.5">
              <p className="text-sm font-semibold flex items-center gap-2"><TrendingUp className="w-4 h-4 text-primary" /> Moliyaviy xulosa</p>
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded bg-muted/50 px-3 py-2.5">
                  <p className="text-xs text-muted-foreground mb-1">Umumiy xarid</p>
                  <p className="font-bold text-sm">{fmtAmt(st.totalAmount, "USD")}</p>
                </div>
                <div className="rounded bg-green-50 border border-green-200 px-3 py-2.5">
                  <p className="text-xs text-green-600 mb-1">To'langan</p>
                  <p className="font-bold text-sm text-green-700">{fmtAmt(st.totalPaid, "USD")}</p>
                </div>
                <div className="rounded bg-amber-50 border border-amber-200 px-3 py-2.5">
                  <p className="text-xs text-amber-600 mb-1">Qolgan nasiya</p>
                  <p className={`font-bold text-sm ${st.totalDebt > 0 ? "text-amber-700" : "text-muted-foreground"}`}>
                    {st.totalDebt > 0 ? fmtAmt(st.totalDebt, "USD") : "Yo'q"}
                  </p>
                </div>
              </div>
            </div>

            {/* ── Sales history ── */}
            <div className="space-y-2">
              <p className="text-sm font-semibold flex items-center gap-2">
                <ShoppingBag className="w-4 h-4" /> Savdo tarixi
                <span className="text-muted-foreground font-normal text-xs">({profile.sales.length} ta)</span>
              </p>
              {profile.sales.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm border rounded-lg">
                  <ShoppingBag className="w-8 h-8 mx-auto mb-2 opacity-30" /> Savdolar yo'q
                </div>
              ) : (
                <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                  {profile.sales.map(s => <SaleCard key={s.id} sale={s} />)}
                </div>
              )}
            </div>

            {/* ── Debt warning ── */}
            {st.totalDebt > 0 && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 flex items-center gap-3">
                <CreditCard className="w-5 h-5 text-amber-500 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-amber-800">
                    Nasiya borligini eslatib o'ting
                  </p>
                  <p className="text-xs text-amber-600">
                    Mijoz hali {fmtAmt(st.totalDebt, "USD")} to'lashi kerak
                  </p>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Customers() {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen]             = useState(false);
  const [profileId, setProfileId]       = useState<number | null>(null);
  const [editAfterProfile, setEditAfterProfile] = useState(false);
  const [editCustomer, setEditCustomer] = useState<Customer | null>(null);

  const { data: customers, isLoading } = useGetCustomers({
    query: { queryKey: getGetCustomersQueryKey() },
  });

  const createCustomer = useCreateCustomer({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCustomersQueryKey() });
        setIsOpen(false); form.reset();
      },
    },
  });
  const deleteCustomer = useDeleteCustomer({
    mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetCustomersQueryKey() }) },
  });

  const form = useForm<z.infer<typeof customerSchema>>({
    resolver: zodResolver(customerSchema),
    defaultValues: { name: "", phone: "", company: "", address: "" },
  });

  function onSubmit(values: z.infer<typeof customerSchema>) {
    createCustomer.mutate({ data: values });
  }

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: getGetCustomersQueryKey() });
    if (profileId) queryClient.invalidateQueries({ queryKey: ["customer-profile", profileId] });
  }

  const profileCustomer = customers?.find(c => c.id === profileId) ?? null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Mijozlar bazasi</h1>
          <p className="text-sm text-muted-foreground mt-1">Mahsulot xaridorlari va hamkorlar</p>
        </div>

        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="w-4 h-4 mr-2" /> Mijoz qo'shish</Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Yangi mijoz</DialogTitle>
              <DialogDescription>Xaridor yoki hamkor ma'lumotlarini kiriting.</DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem>
                    <FormLabel>To'liq ismi / kompaniya nomi</FormLabel>
                    <FormControl><Input placeholder="masalan: Rahimov Jasur" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="phone" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-1"><Phone className="w-3 h-3" /> Telefon raqam</FormLabel>
                    <FormControl><Input placeholder="+998901234567" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="company" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-1"><Building2 className="w-3 h-3" /> Tashkilot (ixtiyoriy)</FormLabel>
                    <FormControl><Input placeholder="masalan: TopMart LLC" {...field} /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="address" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-1"><MapPin className="w-3 h-3" /> Manzil (ixtiyoriy)</FormLabel>
                    <FormControl><Input placeholder="masalan: Toshkent, Yunusobod" {...field} /></FormControl>
                  </FormItem>
                )} />
                <DialogFooter className="pt-4">
                  <Button type="submit" disabled={createCustomer.isPending}>
                    {createCustomer.isPending ? "Saqlanmoqda..." : "Saqlash"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Building2 className="w-5 h-5 text-primary" />
            </div>
            <div>
              <div className="text-2xl font-bold">{customers?.length ?? 0}</div>
              <div className="text-xs text-muted-foreground">Jami mijozlar</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Ism</TableHead>
                <TableHead>Telefon</TableHead>
                <TableHead>Tashkilot</TableHead>
                <TableHead>Manzil</TableHead>
                <TableHead>Sana</TableHead>
                <TableHead className="w-[90px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 6 }).map((_, j) => <TableCell key={j}><Skeleton className="h-5 w-24" /></TableCell>)}
                    <TableCell />
                  </TableRow>
                ))
              ) : customers?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                    <Building2 className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    Mijozlar ro'yxati bo'sh.
                  </TableCell>
                </TableRow>
              ) : (
                customers?.map(c => (
                  <TableRow
                    key={c.id}
                    className="cursor-pointer hover:bg-muted/30 transition-colors"
                    onClick={() => setProfileId(c.id)}
                  >
                    <TableCell className="text-muted-foreground text-sm">{c.id}</TableCell>
                    <TableCell>
                      <span className="font-medium hover:text-primary transition-colors">{c.name}</span>
                    </TableCell>
                    <TableCell>
                      {c.phone
                        ? <span className="flex items-center gap-1 text-sm"><Phone className="w-3 h-3 text-muted-foreground" /> {c.phone}</span>
                        : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      {c.company
                        ? <Badge variant="outline" className="font-normal">{c.company}</Badge>
                        : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      {c.address
                        ? <span className="flex items-center gap-1 text-sm text-muted-foreground"><MapPin className="w-3 h-3" /> {c.address}</span>
                        : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{c.createdAt?.slice(0, 10)}</TableCell>
                    <TableCell onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        <EditCustomerDialog
                          customer={c as Customer}
                          onSuccess={invalidateAll}
                        />
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10">
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Mijozni o'chirish?</AlertDialogTitle>
                              <AlertDialogDescription>
                                {c.name} — barcha sotuv yozuvlari ham o'chib ketadi.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                onClick={() => deleteCustomer.mutate({ id: c.id })}
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

      {/* Profile dialog */}
      {profileCustomer && (
        <CustomerProfileDialog
          customer={profileCustomer as Customer}
          open={profileId !== null}
          onClose={() => setProfileId(null)}
          onEdit={() => { setEditCustomer(profileCustomer as Customer); setProfileId(null); }}
        />
      )}

      {/* Edit dialog (opened from profile) */}
      {editCustomer && (
        <Dialog open={true} onOpenChange={v => { if (!v) setEditCustomer(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><User className="w-4 h-4" /> Mijozni tahrirlash</DialogTitle>
              <DialogDescription>{editCustomer.name}</DialogDescription>
            </DialogHeader>
            <EditCustomerInlineForm
              customer={editCustomer}
              onSuccess={() => { invalidateAll(); setEditCustomer(null); }}
              onCancel={() => setEditCustomer(null)}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ── Inline edit form (reusable) ───────────────────────────────────────────────
function EditCustomerInlineForm({ customer, onSuccess, onCancel }: {
  customer: Customer; onSuccess: () => void; onCancel: () => void;
}) {
  const form = useForm<z.infer<typeof customerSchema>>({
    resolver: zodResolver(customerSchema),
    defaultValues: {
      name:    customer.name,
      phone:   customer.phone ?? "",
      company: customer.company ?? "",
      address: customer.address ?? "",
    },
  });

  const update = useMutation({
    mutationFn: async (data: z.infer<typeof customerSchema>) => {
      const res = await fetch(`/api/customers/${customer.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess,
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(d => update.mutate(d))} className="space-y-4">
        <FormField control={form.control} name="name" render={({ field }) => (
          <FormItem>
            <FormLabel>To'liq ismi / kompaniya nomi</FormLabel>
            <FormControl><Input {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <FormField control={form.control} name="phone" render={({ field }) => (
          <FormItem>
            <FormLabel className="flex items-center gap-1"><Phone className="w-3 h-3" /> Telefon raqam</FormLabel>
            <FormControl><Input placeholder="+998901234567" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <FormField control={form.control} name="company" render={({ field }) => (
          <FormItem>
            <FormLabel className="flex items-center gap-1"><Building2 className="w-3 h-3" /> Tashkilot</FormLabel>
            <FormControl><Input placeholder="masalan: TopMart LLC" {...field} /></FormControl>
          </FormItem>
        )} />
        <FormField control={form.control} name="address" render={({ field }) => (
          <FormItem>
            <FormLabel className="flex items-center gap-1"><MapPin className="w-3 h-3" /> Manzil</FormLabel>
            <FormControl><Input placeholder="masalan: Toshkent, Yunusobod" {...field} /></FormControl>
          </FormItem>
        )} />
        <DialogFooter>
          <Button variant="outline" type="button" onClick={onCancel}>Bekor</Button>
          <Button type="submit" disabled={update.isPending}>
            {update.isPending ? "Saqlanmoqda..." : "Saqlash"}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
