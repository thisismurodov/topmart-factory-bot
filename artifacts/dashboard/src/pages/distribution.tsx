import { authFetch } from "@/App";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Users, Store, ShoppingBag, CreditCard, Banknote, Wallet,
  MapPin, Phone, TrendingUp,
} from "lucide-react";

// ── Helpers ─────────────────────────────────────────────────────────────────────
const fmtSom = (n: number) => `${Math.round(n).toLocaleString("uz-UZ")} so'm`;
const fmtDate = (s: string | null) => (s ? s.slice(0, 10) : "—");

function PaymentBadge({ type }: { type: string | null }) {
  if (type === "naqd")
    return <Badge className="bg-green-100 text-green-700 border-green-200 gap-1 h-5 text-[10px]"><Banknote className="w-2.5 h-2.5" /> Naqd</Badge>;
  if (type === "nasiya")
    return <Badge variant="outline" className="text-amber-600 border-amber-300 gap-1 h-5 text-[10px]"><CreditCard className="w-2.5 h-2.5" /> Nasiya</Badge>;
  return <Badge variant="secondary" className="h-5 text-[10px]">{type || "—"}</Badge>;
}

// ── Types ─────────────────────────────────────────────────────────────────────
type Summary = {
  agentsCount: number; shopsCount: number;
  salesCount: number; salesTotal: number;
  monthSalesCount: number; monthSalesTotal: number;
  collectedTotal: number; outstandingTotal: number;
};
type Agent = {
  telegramId: number | null; name: string | null; viloyat: string | null; role: string | null;
  shops: number; salesCount: number; salesTotal: number; collected: number; outstanding: number;
};
type Shop = {
  id: number; nomi: string | null; egasi: string | null; telefon: string | null;
  viloyat: string | null; hudud: string | null; holat: string | null;
  totalOrders: number; totalSales: number; lastOrderDate: string | null;
  agentName: string | null; outstanding: number;
};
type Sale = {
  id: number; createdAt: string | null; total: number; tolovTuri: string | null;
  agentName: string | null; dokonName: string | null; viloyat: string | null; items: string | null;
};
type Debt = {
  dokonId: number; dokonName: string | null; telefon: string | null; viloyat: string | null;
  agentName: string | null; outstanding: number; entries: number; lastUpdate: string | null;
};

function useDist<T>(key: string, path: string, enabled = true) {
  return useQuery<T>({
    queryKey: ["distribution", key],
    queryFn: async () => {
      const r = await authFetch(`/api/distribution/${path}`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled,
  });
}

// ── Summary cards ───────────────────────────────────────────────────────────────
function SummaryCards() {
  const { data, isLoading } = useDist<Summary>("summary", "summary");

  const cards = [
    { label: "Agentlar", value: data?.agentsCount, icon: Users, tone: "text-blue-600" },
    { label: "Do'konlar", value: data?.shopsCount, icon: Store, tone: "text-emerald-600" },
    { label: "Jami savdolar", value: data?.salesCount, icon: ShoppingBag, tone: "text-primary" },
    { label: "Bu oy savdo", value: data ? fmtSom(data.monthSalesTotal) : undefined, icon: TrendingUp, tone: "text-indigo-600" },
    { label: "Yig'ilgan pul", value: data ? fmtSom(data.collectedTotal) : undefined, icon: Wallet, tone: "text-green-600" },
    { label: "Nasiya qoldiq", value: data ? fmtSom(data.outstandingTotal) : undefined, icon: CreditCard, tone: "text-red-600" },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <c.icon className={`w-4 h-4 ${c.tone}`} />
              <span className="text-xs text-muted-foreground">{c.label}</span>
            </div>
            {isLoading || c.value === undefined
              ? <Skeleton className="h-6 w-20" />
              : <div className="text-lg font-bold leading-tight">{c.value}</div>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ── Loading table skeleton ──────────────────────────────────────────────────────
function TableSkeleton({ cols }: { cols: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex gap-3">
          {Array.from({ length: cols }).map((_, j) => <Skeleton key={j} className="h-6 flex-1" />)}
        </div>
      ))}
    </div>
  );
}

function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="text-center text-muted-foreground py-10">{text}</TableCell>
    </TableRow>
  );
}

// ── Savdolar tab ─────────────────────────────────────────────────────────────────
function SalesTab({ active }: { active: boolean }) {
  const { data, isLoading } = useDist<Sale[]>("sales", "sales", active);
  if (isLoading) return <TableSkeleton cols={5} />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Sana</TableHead>
          <TableHead>Do'kon</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead>Mahsulotlar</TableHead>
          <TableHead>To'lov</TableHead>
          <TableHead className="text-right">Summa</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {!data || data.length === 0 ? <EmptyRow colSpan={6} text="Savdolar yo'q" /> : data.map((s) => (
          <TableRow key={s.id}>
            <TableCell className="text-muted-foreground whitespace-nowrap">{fmtDate(s.createdAt)}</TableCell>
            <TableCell className="font-medium">{s.dokonName || "—"}{s.viloyat && <span className="block text-[11px] text-muted-foreground">{s.viloyat}</span>}</TableCell>
            <TableCell>{s.agentName || "—"}</TableCell>
            <TableCell className="max-w-xs truncate text-xs text-muted-foreground">{s.items || "—"}</TableCell>
            <TableCell><PaymentBadge type={s.tolovTuri} /></TableCell>
            <TableCell className="text-right font-semibold whitespace-nowrap">{fmtSom(s.total)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ── Agentlar tab ─────────────────────────────────────────────────────────────────
function AgentsTab({ active }: { active: boolean }) {
  const { data, isLoading } = useDist<Agent[]>("agents", "agents", active);
  if (isLoading) return <TableSkeleton cols={5} />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead>Viloyat</TableHead>
          <TableHead className="text-right">Do'konlar</TableHead>
          <TableHead className="text-right">Savdolar</TableHead>
          <TableHead className="text-right">Savdo summasi</TableHead>
          <TableHead className="text-right">Yig'ilgan</TableHead>
          <TableHead className="text-right">Nasiya</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {!data || data.length === 0 ? <EmptyRow colSpan={7} text="Agentlar yo'q" /> : data.map((a) => (
          <TableRow key={a.telegramId ?? a.name ?? Math.random()}>
            <TableCell className="font-medium">
              {a.name || "—"}
              {a.role === "supervisor" && <Badge variant="secondary" className="ml-2 h-4 text-[9px]">supervisor</Badge>}
            </TableCell>
            <TableCell className="text-muted-foreground">{a.viloyat || "—"}</TableCell>
            <TableCell className="text-right">{a.shops}</TableCell>
            <TableCell className="text-right">{a.salesCount}</TableCell>
            <TableCell className="text-right font-semibold whitespace-nowrap">{fmtSom(a.salesTotal)}</TableCell>
            <TableCell className="text-right text-green-700 whitespace-nowrap">{fmtSom(a.collected)}</TableCell>
            <TableCell className={`text-right whitespace-nowrap ${a.outstanding > 0 ? "text-red-600 font-medium" : "text-muted-foreground"}`}>{a.outstanding > 0 ? fmtSom(a.outstanding) : "—"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ── Do'konlar tab ────────────────────────────────────────────────────────────────
function ShopsTab({ active }: { active: boolean }) {
  const { data, isLoading } = useDist<Shop[]>("shops", "shops", active);
  if (isLoading) return <TableSkeleton cols={5} />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Do'kon</TableHead>
          <TableHead>Hudud</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead>Holat</TableHead>
          <TableHead className="text-right">Buyurtmalar</TableHead>
          <TableHead className="text-right">Jami savdo</TableHead>
          <TableHead className="text-right">Nasiya</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {!data || data.length === 0 ? <EmptyRow colSpan={7} text="Do'konlar yo'q" /> : data.map((d) => (
          <TableRow key={d.id}>
            <TableCell className="font-medium">
              {d.nomi || "—"}
              {d.telefon && <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Phone className="w-2.5 h-2.5" />{d.telefon}</span>}
            </TableCell>
            <TableCell className="text-muted-foreground">
              <span className="flex items-center gap-1"><MapPin className="w-2.5 h-2.5" />{[d.viloyat, d.hudud].filter(Boolean).join(", ") || "—"}</span>
            </TableCell>
            <TableCell>{d.agentName || "—"}</TableCell>
            <TableCell>
              {d.holat === "faol"
                ? <Badge className="bg-green-100 text-green-700 border-green-200 h-5 text-[10px]">Faol</Badge>
                : <Badge variant="outline" className="h-5 text-[10px]">{d.holat || "—"}</Badge>}
            </TableCell>
            <TableCell className="text-right">{d.totalOrders}</TableCell>
            <TableCell className="text-right font-semibold whitespace-nowrap">{fmtSom(d.totalSales)}</TableCell>
            <TableCell className={`text-right whitespace-nowrap ${d.outstanding > 0 ? "text-red-600 font-medium" : "text-muted-foreground"}`}>{d.outstanding > 0 ? fmtSom(d.outstanding) : "—"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ── Nasiya tab ───────────────────────────────────────────────────────────────────
function DebtsTab({ active }: { active: boolean }) {
  const { data, isLoading } = useDist<Debt[]>("debts", "debts", active);
  if (isLoading) return <TableSkeleton cols={4} />;
  const total = data?.reduce((s, d) => s + d.outstanding, 0) ?? 0;
  return (
    <div>
      {data && data.length > 0 && (
        <div className="px-4 py-3 border-b bg-red-50/50 flex items-center gap-2 text-sm">
          <CreditCard className="w-4 h-4 text-red-500" />
          <span className="text-muted-foreground">Umumiy nasiya qoldiq:</span>
          <span className="font-bold text-red-700">{fmtSom(total)}</span>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Do'kon</TableHead>
            <TableHead>Viloyat</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead className="text-right">Yozuvlar</TableHead>
            <TableHead>Oxirgi</TableHead>
            <TableHead className="text-right">Qoldiq</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!data || data.length === 0 ? <EmptyRow colSpan={6} text="Nasiya yo'q" /> : data.map((d) => (
            <TableRow key={d.dokonId}>
              <TableCell className="font-medium">
                {d.dokonName || "—"}
                {d.telefon && <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Phone className="w-2.5 h-2.5" />{d.telefon}</span>}
              </TableCell>
              <TableCell className="text-muted-foreground">{d.viloyat || "—"}</TableCell>
              <TableCell>{d.agentName || "—"}</TableCell>
              <TableCell className="text-right">{d.entries}</TableCell>
              <TableCell className="text-muted-foreground whitespace-nowrap">{fmtDate(d.lastUpdate)}</TableCell>
              <TableCell className="text-right font-bold text-red-600 whitespace-nowrap">{fmtSom(d.outstanding)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Distribution() {
  return (
    <div className="space-y-6">
      <SummaryCards />
      <Card>
        <CardHeader className="pb-0">
          <CardTitle className="text-base">Distribyutsiya</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <Tabs defaultValue="sales">
            <TabsList>
              <TabsTrigger value="sales">Savdolar</TabsTrigger>
              <TabsTrigger value="agents">Agentlar</TabsTrigger>
              <TabsTrigger value="shops">Do'konlar</TabsTrigger>
              <TabsTrigger value="debts">Nasiya</TabsTrigger>
            </TabsList>
            <TabsContent value="sales" className="border rounded-md mt-4 overflow-x-auto">
              <SalesTab active />
            </TabsContent>
            <TabsContent value="agents" className="border rounded-md mt-4 overflow-x-auto">
              <AgentsTab active />
            </TabsContent>
            <TabsContent value="shops" className="border rounded-md mt-4 overflow-x-auto">
              <ShopsTab active />
            </TabsContent>
            <TabsContent value="debts" className="border rounded-md mt-4 overflow-x-auto">
              <DebtsTab active />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
