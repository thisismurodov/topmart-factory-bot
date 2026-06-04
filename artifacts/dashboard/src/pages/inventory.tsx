import { useQuery } from "@tanstack/react-query";
import { formatNumber } from "@/lib/format";

type StockWarehouse = {
  id: number;
  name: string;
  items: { product: string; quantity: number }[];
};

type Summary = {
  skuCount: number;
  totalStock: number;
  warehouseCount: number;
  lowStock: { product: string; qty: number }[];
};

type Movement = {
  id: number;
  product: string;
  quantity: number;
  movementType: "IN" | "OUT" | "TRANSFER";
  fromWarehouse: string | null;
  toWarehouse: string | null;
  note: string;
  createdBy: string;
  createdAt: string;
};

function useStock() {
  return useQuery<StockWarehouse[]>({
    queryKey: ["inventory-stock"],
    queryFn: () => fetch("/api/inventory/stock").then((r) => r.json()),
    refetchInterval: 30_000,
  });
}

function useSummary() {
  return useQuery<Summary>({
    queryKey: ["inventory-summary"],
    queryFn: () => fetch("/api/inventory/summary").then((r) => r.json()),
    refetchInterval: 30_000,
  });
}

function useMovements() {
  return useQuery<Movement[]>({
    queryKey: ["inventory-movements"],
    queryFn: () => fetch("/api/inventory/movements?limit=30").then((r) => r.json()),
    refetchInterval: 30_000,
  });
}

export default function Inventory() {
  const { data: summary, isLoading: loadSummary } = useSummary();
  const { data: stock, isLoading: loadStock } = useStock();
  const { data: movements, isLoading: loadMovements } = useMovements();

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div>
        <h1 className="text-xl font-semibold tracking-tight">🏬 Ombor</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Real vaqt qoldiqlari · Harakatlar tarixi
        </p>
      </div>

      {/* ── KPI ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard icon="📦" label="Jami SKU" value={formatNumber(summary?.skuCount)} loading={loadSummary} />
        <KpiCard icon="⚖️" label="Jami qoldiq (dona)" value={formatNumber(summary?.totalStock)} loading={loadSummary} />
        <KpiCard icon="🏪" label="Skladlar soni" value={formatNumber(summary?.warehouseCount)} loading={loadSummary} />
        <KpiCard
          icon="⚠️"
          label="Kam qolgan"
          value={String(summary?.lowStock.length ?? 0)}
          loading={loadSummary}
          warn={!!summary?.lowStock.length}
        />
      </div>

      {/* ── Low Stock Warning ── */}
      {(summary?.lowStock.length ?? 0) > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 space-y-2">
          <div className="text-sm font-bold text-red-700 mb-3">⚠️ Kam Qolgan Mahsulotlar</div>
          {summary!.lowStock.map((item) => (
            <div key={item.product} className="flex items-center justify-between px-3 py-2 bg-white rounded-lg border border-red-100">
              <span className="font-medium text-sm text-red-800">{item.product}</span>
              <span className="text-xs font-bold text-red-600 bg-red-100 px-2 py-0.5 rounded-full border border-red-200">
                {formatNumber(item.qty)} dona
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── Per-Warehouse Stock ── */}
      <div>
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">
          🏬 Sklad Bo'yicha Qoldiqlar
        </h2>
        {loadStock ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="rounded-xl border bg-white p-4 space-y-2">
                <div className="h-4 w-32 rounded animate-pulse bg-muted" />
                <div className="h-3 w-full rounded animate-pulse bg-muted" />
                <div className="h-3 w-3/4 rounded animate-pulse bg-muted" />
              </div>
            ))}
          </div>
        ) : !stock?.length ? (
          <div className="rounded-xl border bg-white p-8 text-center text-muted-foreground text-sm">
            <div className="text-3xl mb-2">📭</div>
            Ombor bo'sh — bot orqali kirim qiling
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {stock.map((wh) => (
              <WarehouseCard key={wh.id} warehouse={wh} />
            ))}
          </div>
        )}
      </div>

      {/* ── Movements History ── */}
      <div>
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">
          📜 Harakatlar Tarixi
        </h2>
        <div className="rounded-xl border bg-white overflow-hidden">
          {loadMovements ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-10 rounded animate-pulse bg-muted" />
              ))}
            </div>
          ) : !movements?.length ? (
            <div className="text-center py-10 text-sm text-muted-foreground">
              Hali harakat yo'q
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">Tur</th>
                    <th className="text-left px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">Mahsulot</th>
                    <th className="text-right px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">Miqdor</th>
                    <th className="text-left px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">Yo'nalish</th>
                    <th className="text-left px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">Kim</th>
                    <th className="text-left px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">Vaqt</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {movements.map((m) => (
                    <MovementRow key={m.id} m={m} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

/* ── Sub-components ── */

function KpiCard({ icon, label, value, loading, warn }: {
  icon: string; label: string; value?: string; loading?: boolean; warn?: boolean;
}) {
  return (
    <div className={`rounded-xl border p-5 shadow-sm bg-white ${warn ? "border-red-200 bg-red-50" : "border-border"}`}>
      <div className={`text-xs font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5 ${warn ? "text-red-500" : "text-muted-foreground"}`}>
        <span className="text-base">{icon}</span> {label}
      </div>
      {loading ? (
        <div className="h-7 w-16 rounded animate-pulse bg-muted" />
      ) : (
        <div className={`text-2xl font-bold ${warn ? "text-red-600" : ""}`}>{value ?? "—"}</div>
      )}
    </div>
  );
}

function WarehouseCard({ warehouse }: { warehouse: StockWarehouse }) {
  const total = warehouse.items.reduce((s, i) => s + i.quantity, 0);
  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="font-semibold text-sm">{warehouse.name}</div>
        <span className="text-xs bg-[#0B5D2A]/10 text-[#0B5D2A] px-2 py-0.5 rounded-full font-bold">
          {formatNumber(Math.round(total))}
        </span>
      </div>
      {warehouse.items.length === 0 ? (
        <div className="text-xs text-muted-foreground">Bo'sh</div>
      ) : (
        <div className="space-y-1.5">
          {warehouse.items.map((item) => (
            <div key={item.product} className="flex justify-between items-center">
              <span className="text-xs text-muted-foreground truncate mr-2">{item.product}</span>
              <span className="text-xs font-mono font-semibold shrink-0">{formatNumber(Math.round(item.quantity))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MovementRow({ m }: { m: Movement }) {
  const cfg = {
    IN:       { label: "Kirim",   bg: "bg-green-100 text-green-700",  icon: "➕" },
    OUT:      { label: "Chiqim",  bg: "bg-red-100 text-red-700",      icon: "➖" },
    TRANSFER: { label: "O'tkazma",bg: "bg-blue-100 text-blue-700",    icon: "🔄" },
  }[m.movementType] ?? { label: m.movementType, bg: "bg-muted text-muted-foreground", icon: "•" };

  const direction =
    m.movementType === "IN"       ? `→ ${m.toWarehouse ?? "?"}`
    : m.movementType === "OUT"    ? `← ${m.fromWarehouse ?? "?"}`
    : `${m.fromWarehouse ?? "?"} → ${m.toWarehouse ?? "?"}`;

  const date = new Date(m.createdAt);
  const timeStr = date.toLocaleDateString("uz-UZ", { day: "2-digit", month: "2-digit" }) +
    " " + date.toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" });

  return (
    <tr className="hover:bg-muted/30 transition-colors">
      <td className="px-4 py-2.5">
        <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${cfg.bg}`}>
          {cfg.icon} {cfg.label}
        </span>
      </td>
      <td className="px-4 py-2.5 font-medium">{m.product}</td>
      <td className="px-4 py-2.5 text-right font-mono font-semibold">{formatNumber(m.quantity)}</td>
      <td className="px-4 py-2.5 text-muted-foreground text-xs">{direction}</td>
      <td className="px-4 py-2.5 text-muted-foreground text-xs">{m.createdBy || "—"}</td>
      <td className="px-4 py-2.5 text-muted-foreground text-xs font-mono">{timeStr}</td>
    </tr>
  );
}
