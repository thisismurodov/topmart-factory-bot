import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { customFetch } from "@workspace/api-client-react";
import {
  CreditCard,
  Users,
  ShoppingBag,
  TrendingDown,
  Phone,
  Building2,
  Calendar,
  AlertTriangle,
  ChevronRight,
  Search,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
type Totals = { usd: number; uzs: number; customerCount: number; saleCount: number };
type CustomerDebt = {
  customerId: number; customerName: string; phone: string; company: string;
  debtUsd: number; debtUzs: number; saleCount: number; oldestSale: string;
};
type DebtSale = {
  id: number; customerId: number; customerName: string; phone: string;
  totalAmount: number; paidAmount: number; debtAmount: number;
  paymentType: string; currency: string; status: string; note: string;
  daysSince: number; createdAt: string;
};
type Summary = { totals: Totals; customers: CustomerDebt[]; sales: DebtSale[] };
type CustomerSale = {
  id: number; totalAmount: number; paidAmount: number; debtAmount: number;
  currency: string; status: string; note: string; createdAt: string;
};

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtAmt(v: number, cur: string) {
  if (cur === "UZS") return `${v.toLocaleString("uz-UZ")} so'm`;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("uz-UZ", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function urgencyColor(days: number) {
  if (days > 30) return "text-red-600";
  if (days > 14) return "text-amber-600";
  return "text-muted-foreground";
}
function urgencyBadge(days: number) {
  if (days > 30) return <Badge variant="destructive" className="text-xs">{days} kun</Badge>;
  if (days > 14) return <Badge className="text-xs bg-amber-500 hover:bg-amber-500">{days} kun</Badge>;
  return <Badge variant="secondary" className="text-xs">{days} kun</Badge>;
}

// ── Quick Pay Dialog ──────────────────────────────────────────────────────────
type QuickPayProps = {
  saleId: number | null;
  maxAmount: number;
  currency: string;
  onClose: () => void;
  onSuccess: () => void;
};
function QuickPayDialog({ saleId, maxAmount, currency, onClose, onSuccess }: QuickPayProps) {
  const { toast } = useToast();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const amt = parseFloat(amount);
      if (isNaN(amt) || amt <= 0) throw new Error("To'lov summasi noto'g'ri");
      return customFetch(`/api/sales/${saleId}/payments`, {
        method: "POST",
        body: JSON.stringify({ amount: amt, currency, note }),
      });
    },
    onSuccess: () => {
      toast({ title: "To'lov qo'shildi ✓" });
      onSuccess();
      onClose();
    },
    onError: (e: any) => toast({ title: "Xato", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={saleId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>To'lov qo'shish</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-1">
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm">
            <span className="text-amber-700">Qolgan nasiya: </span>
            <span className="font-bold text-amber-800">{fmtAmt(maxAmount, currency)}</span>
          </div>
          <div className="space-y-1.5">
            <Label>To'lov summasi ({currency})</Label>
            <div className="flex gap-2">
              <Input
                type="number"
                min="0.01"
                step="0.01"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="flex-1"
              />
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => setAmount(maxAmount.toString())}
              >
                Hammasi
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Izoh (ixtiyoriy)</Label>
            <Input
              placeholder="To'lov sababi..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1" onClick={onClose}>Bekor</Button>
            <Button
              className="flex-1 bg-green-600 hover:bg-green-700"
              disabled={mutation.isPending || !amount}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? "Saqlanmoqda…" : "To'lovni saqlash"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Customer Sale Picker Dialog ───────────────────────────────────────────────
type CustomerSalePickerProps = {
  customerId: number | null;
  customerName: string;
  onSelect: (sale: CustomerSale) => void;
  onClose: () => void;
};
function CustomerSalePickerDialog({ customerId, customerName, onSelect, onClose }: CustomerSalePickerProps) {
  const { data: sales = [] } = useQuery<CustomerSale[]>({
    queryKey: ["customer-debt-sales", customerId],
    queryFn: () => customFetch(`/api/customers/${customerId}/debt-sales`),
    enabled: customerId !== null,
  });

  return (
    <Dialog open={customerId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{customerName} — nasiyalar</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {sales.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-6">Nasiyalar yo'q</p>
          )}
          {sales.map((s) => (
            <button
              key={s.id}
              onClick={() => { onSelect(s); onClose(); }}
              className="w-full text-left rounded-lg border p-3 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">#{s.id} · {fmtDate(s.createdAt)}</span>
                <Badge variant={s.status === "pending" ? "destructive" : "secondary"} className="text-xs">
                  {s.status === "pending" ? "Nasiya" : "Qisman"}
                </Badge>
              </div>
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-sm">
                  Jami: <strong>{fmtAmt(s.totalAmount, s.currency)}</strong>
                </span>
                <span className="text-sm text-amber-700 font-bold">
                  Nasiya: {fmtAmt(s.debtAmount, s.currency)}
                </span>
              </div>
              {s.note && <p className="text-xs text-muted-foreground mt-1 truncate">{s.note}</p>}
            </button>
          ))}
        </div>
        <Button variant="outline" onClick={onClose}>Yopish</Button>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function Debts() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [payTarget, setPayTarget] = useState<{ saleId: number; maxAmount: number; currency: string } | null>(null);
  const [customerPicker, setCustomerPicker] = useState<{ id: number; name: string } | null>(null);

  const { data, isLoading } = useQuery<Summary>({
    queryKey: ["debts-summary"],
    queryFn: () => customFetch("/api/debts/summary"),
    refetchInterval: 60_000,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["debts-summary"] });

  const q = search.toLowerCase();
  const filteredCustomers = (data?.customers ?? []).filter(
    (c) => c.customerName.toLowerCase().includes(q) || c.phone.includes(q) || c.company.toLowerCase().includes(q),
  );
  const filteredSales = (data?.sales ?? []).filter(
    (s) => s.customerName.toLowerCase().includes(q) || s.phone.includes(q),
  );

  const t = data?.totals;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <CreditCard className="w-6 h-6 text-amber-500" /> Nasiya hisoboti
        </h1>
        <p className="text-sm text-muted-foreground mt-1">Barcha to'lanmagan savdolar va qarzdor mijozlar</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-xl border bg-amber-50 border-amber-200 p-4">
          <div className="flex items-center gap-2 mb-1">
            <TrendingDown className="w-4 h-4 text-amber-500" />
            <span className="text-xs font-medium text-amber-700">Jami nasiya (USD)</span>
          </div>
          <p className="text-xl font-bold text-amber-800">
            {isLoading ? "—" : `$${(t?.usd ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}`}
          </p>
        </div>
        <div className="rounded-xl border bg-orange-50 border-orange-200 p-4">
          <div className="flex items-center gap-2 mb-1">
            <TrendingDown className="w-4 h-4 text-orange-500" />
            <span className="text-xs font-medium text-orange-700">Jami nasiya (UZS)</span>
          </div>
          <p className="text-xl font-bold text-orange-800">
            {isLoading ? "—" : `${(t?.uzs ?? 0).toLocaleString("uz-UZ")} so'm`}
          </p>
        </div>
        <div className="rounded-xl border bg-muted/50 p-4">
          <div className="flex items-center gap-2 mb-1">
            <Users className="w-4 h-4 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">Qarzdor mijozlar</span>
          </div>
          <p className="text-xl font-bold">{isLoading ? "—" : t?.customerCount ?? 0}</p>
        </div>
        <div className="rounded-xl border bg-muted/50 p-4">
          <div className="flex items-center gap-2 mb-1">
            <ShoppingBag className="w-4 h-4 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">Nasiyali savdolar</span>
          </div>
          <p className="text-xl font-bold">{isLoading ? "—" : t?.saleCount ?? 0}</p>
        </div>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Mijoz nomi, telefon..."
          className="pl-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Tabs */}
      <Tabs defaultValue="customers">
        <TabsList>
          <TabsTrigger value="customers" className="gap-2">
            <Users className="w-4 h-4" /> Mijozlar bo'yicha
            {filteredCustomers.length > 0 && (
              <Badge variant="secondary" className="ml-1">{filteredCustomers.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="sales" className="gap-2">
            <ShoppingBag className="w-4 h-4" /> Savdolar bo'yicha
            {filteredSales.length > 0 && (
              <Badge variant="secondary" className="ml-1">{filteredSales.length}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ── Tab: Customers ── */}
        <TabsContent value="customers" className="mt-4">
          {isLoading ? (
            <div className="text-center py-12 text-muted-foreground">Yuklanmoqda…</div>
          ) : filteredCustomers.length === 0 ? (
            <div className="text-center py-12">
              <CreditCard className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">
                {search ? "Qidiruv natijasi yo'q" : "Hech qanday nasiya yo'q"}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredCustomers.map((c) => (
                <div key={c.customerId} className="rounded-xl border bg-card p-4 hover:shadow-sm transition-shadow">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-sm">{c.customerName}</p>
                        {c.company && (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Building2 className="w-3 h-3" />{c.company}
                          </span>
                        )}
                        {c.phone && (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Phone className="w-3 h-3" />{c.phone}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-2 flex-wrap">
                        {c.debtUsd > 0 && (
                          <span className="text-sm font-bold text-amber-700">
                            {fmtAmt(c.debtUsd, "USD")}
                          </span>
                        )}
                        {c.debtUzs > 0 && (
                          <span className="text-sm font-bold text-orange-700">
                            {fmtAmt(c.debtUzs, "UZS")}
                          </span>
                        )}
                        <Badge variant="outline" className="text-xs">
                          {c.saleCount} ta savdo
                        </Badge>
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Calendar className="w-3 h-3" />Eng eski: {fmtDate(c.oldestSale)}
                        </span>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      className="bg-green-600 hover:bg-green-700 shrink-0"
                      onClick={() => setCustomerPicker({ id: c.customerId, name: c.customerName })}
                    >
                      To'lov <ChevronRight className="w-3.5 h-3.5 ml-1" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Tab: Sales ── */}
        <TabsContent value="sales" className="mt-4">
          {isLoading ? (
            <div className="text-center py-12 text-muted-foreground">Yuklanmoqda…</div>
          ) : filteredSales.length === 0 ? (
            <div className="text-center py-12">
              <ShoppingBag className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">
                {search ? "Qidiruv natijasi yo'q" : "Hech qanday nasiya yo'q"}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredSales.map((s) => (
                <div
                  key={s.id}
                  className={`rounded-xl border bg-card p-4 hover:shadow-sm transition-shadow ${s.daysSince > 30 ? "border-red-200" : s.daysSince > 14 ? "border-amber-200" : ""}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-sm">{s.customerName}</p>
                        {s.phone && (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Phone className="w-3 h-3" />{s.phone}
                          </span>
                        )}
                        <Badge
                          variant={s.status === "pending" ? "destructive" : "secondary"}
                          className="text-xs"
                        >
                          {s.status === "pending" ? "Nasiya" : "Qisman to'langan"}
                        </Badge>
                        {s.daysSince > 14 && (
                          <span className="flex items-center gap-1">
                            <AlertTriangle className={`w-3 h-3 ${urgencyColor(s.daysSince)}`} />
                            {urgencyBadge(s.daysSince)}
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-3 gap-x-4 mt-2">
                        <div>
                          <p className="text-xs text-muted-foreground">Jami</p>
                          <p className="text-sm font-medium">{fmtAmt(s.totalAmount, s.currency)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">To'langan</p>
                          <p className="text-sm font-medium text-green-700">{fmtAmt(s.paidAmount, s.currency)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Nasiya</p>
                          <p className="text-sm font-bold text-amber-700">{fmtAmt(s.debtAmount, s.currency)}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 mt-1.5">
                        <span className="text-xs text-muted-foreground">
                          #{s.id} · {fmtDate(s.createdAt)}
                        </span>
                        {s.note && (
                          <span className="text-xs text-muted-foreground truncate max-w-xs">"{s.note}"</span>
                        )}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      className="bg-green-600 hover:bg-green-700 shrink-0"
                      onClick={() =>
                        setPayTarget({ saleId: s.id, maxAmount: s.debtAmount, currency: s.currency })
                      }
                    >
                      To'lov
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Customer sale picker */}
      <CustomerSalePickerDialog
        customerId={customerPicker?.id ?? null}
        customerName={customerPicker?.name ?? ""}
        onClose={() => setCustomerPicker(null)}
        onSelect={(sale) => {
          setPayTarget({ saleId: sale.id, maxAmount: sale.debtAmount, currency: sale.currency });
        }}
      />

      {/* Quick pay */}
      {payTarget && (
        <QuickPayDialog
          saleId={payTarget.saleId}
          maxAmount={payTarget.maxAmount}
          currency={payTarget.currency}
          onClose={() => setPayTarget(null)}
          onSuccess={() => {
            refresh();
            qc.invalidateQueries({ queryKey: ["sales"] });
            qc.invalidateQueries({ queryKey: ["customer-debt-sales"] });
          }}
        />
      )}
    </div>
  );
}
