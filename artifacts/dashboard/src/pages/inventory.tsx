import { useState, useCallback, useMemo, type CSSProperties } from "react";
import { authFetch } from "@/App";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatNumber, formatCurrency } from "@/lib/format";
import {
  Package, Search, ArrowLeftRight, Plus, RefreshCw, ArrowLeft,
  TrendingUp, Boxes, AlertTriangle, Container, LayoutGrid,
  Clock, ArrowRight, X, ChevronRight, SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

// ── Types ─────────────────────────────────────────────────────────────────────

type Summary = {
  rawMaterialValueUzs: number;
  finishedGoodsValueUzs: number;
  totalValueUzs: number;
  rawMaterialCount: number;
  finishedGoodsSkuCount: number;
  lowStockRawCount: number;
  usdRate: number;
  totalContainers: number;
  totalAyvons: number;
  occupiedContainers: number;
  emptyContainers: number;
};

type ContainerSummary = {
  id: number;
  name: string;
  capacityKg: number;
  active: boolean;
  locationType: "container" | "ayvon";
  skuCount: number;
  totalQty: number;
  totalWeightKg: number;
  totalValueUzs: number;
  occupancyPct: number;
};

type ContainerItem = {
  id: number;
  product: string;
  quantity: number;
  weightKg: number | null;
  productType: "raw" | "pre-finished" | "finished";
  unit: string;
  salePrice: number;
  currency: string;
  priceUzs: number;
  totalValueUzs: number;
  updatedAt: string;
};

type ContainerDetail = {
  warehouse: { id: number; name: string; capacityKg: number };
  items: ContainerItem[];
};

type Movement = {
  id: number;
  product: string;
  quantity: number;
  movementType: "IN" | "OUT" | "TRANSFER";
  productType: "raw" | "pre-finished" | "finished";
  fromWarehouse: string | null;
  toWarehouse: string | null;
  note: string;
  createdBy: string;
  createdAt: string;
};

type SearchResult = {
  product: string;
  quantity: number;
  productType: string;
  warehouseId: number;
  warehouseName: string;
  locationType: string;
  unit: string;
};

type Product = { name: string; unit_type?: string };
type RawMaterial = { id: number; name: string; unit: string };

type FinishedGood = {
  product: string;
  stockQty: number;
  stockWeightKg: number;
  unitType: string;
  salePrice: number;
  currency: string;
  priceUzs: number;
  totalValueUzs: number;
  minimumStock: number;
  low: boolean;
};

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useSummary() {
  return useQuery<Summary>({
    queryKey: ["ombor-summary"],
    queryFn: () => authFetch("/api/ombor/summary").then((r) => r.json()),
    refetchInterval: 30_000,
  });
}

function useContainers() {
  return useQuery<ContainerSummary[]>({
    queryKey: ["ombor-containers"],
    queryFn: () => authFetch("/api/ombor/containers").then((r) => r.json()),
    refetchInterval: 30_000,
  });
}

function useContainerDetail(id: number | null) {
  return useQuery<ContainerDetail>({
    queryKey: ["ombor-container-detail", id],
    queryFn: () => authFetch(`/api/ombor/containers/${id}/items`).then((r) => r.json()),
    enabled: id !== null,
  });
}

function useMovements(operator?: string, from?: string, to?: string) {
  return useQuery<Movement[]>({
    queryKey: ["ombor-movements", operator ?? "", from ?? "", to ?? ""],
    queryFn: () => {
      const op = operator ? `&operator=${encodeURIComponent(operator)}` : "";
      const f  = from ? `&from=${encodeURIComponent(from)}` : "";
      const t  = to   ? `&to=${encodeURIComponent(to)}`     : "";
      const base = from || to ? "/api/ombor/movements?limit=1000" : "/api/ombor/movements?limit=60";
      return authFetch(`${base}${op}${f}${t}`).then((r) => r.json());
    },
    refetchInterval: 30_000,
  });
}

function useOperators(warehouseId?: number | null) {
  return useQuery<string[]>({
    queryKey: ["ombor-operators", warehouseId ?? null],
    queryFn: () =>
      authFetch(
        warehouseId != null
          ? `/api/ombor/operators?warehouse=${warehouseId}`
          : "/api/ombor/operators",
      ).then((r) => r.json()),
    staleTime: 60_000,
  });
}

function useFinishedGoods() {
  return useQuery<FinishedGood[]>({
    queryKey: ["ombor-finished-goods"],
    queryFn: () => authFetch("/api/ombor/finished-goods").then((r) => r.json()),
    refetchInterval: 30_000,
  });
}

function useContainerMovements(id: number | null, operator?: string) {
  return useQuery<Movement[]>({
    queryKey: ["ombor-container-movements", id, operator || null],
    queryFn: () => {
      const op = operator ? `&operator=${encodeURIComponent(operator)}` : "";
      return authFetch(`/api/ombor/movements?warehouse=${id}&limit=40${op}`).then((r) => r.json());
    },
    enabled: id !== null,
    refetchInterval: 30_000,
  });
}

function useProducts() {
  return useQuery<Product[]>({
    queryKey: ["products-list"],
    queryFn: () => authFetch("/api/products").then((r) => r.json()),
    staleTime: 60_000,
  });
}

function useRawMaterials() {
  return useQuery<RawMaterial[]>({
    queryKey: ["ombor-raw-materials"],
    queryFn: () => authFetch("/api/ombor/raw-materials").then((r) => r.json()),
    staleTime: 60_000,
  });
}

function useSearch(q: string) {
  return useQuery<SearchResult[]>({
    queryKey: ["ombor-search", q],
    queryFn: () => authFetch(`/api/ombor/search?q=${encodeURIComponent(q)}`).then((r) => r.json()),
    enabled: q.trim().length >= 1,
    staleTime: 10_000,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number) { return formatNumber(n); }
function kgAwareStock(g: FinishedGood) {
  return String(g.unitType).toLowerCase() === "kg" && g.stockWeightKg > 0 ? g.stockWeightKg : g.stockQty;
}
function fmtVal(n: number) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)} mlrd`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(0)} mln`;
  return formatCurrency(n);
}

function timeAgo(iso: string) {
  const d = new Date(iso);
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60)    return "hozirgina";
  if (diff < 3600)  return `${Math.floor(diff / 60)} daq oldin`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} soat oldin`;
  return d.toLocaleDateString("uz-UZ", { day: "numeric", month: "short" });
}

function occupancyColor(pct: number) {
  if (pct === 0)  return "#E5E7EB";
  if (pct < 30)   return "#16A34A";
  if (pct < 70)   return "#F7C948";
  if (pct < 90)   return "#F97316";
  return "#DC2626";
}

// ── KPI Card ──────────────────────────────────────────────────────────────────

type KpiProps = {
  icon: React.ReactNode;
  label: string;
  value?: string | number;
  sub?: string;
  accent?: boolean;
  warn?: boolean;
  loading?: boolean;
};

function KpiCard({ icon, label, value, sub, accent, warn, loading }: KpiProps) {
  return (
    <div
      style={{
        background: accent ? "#0B6B3A" : "#fff",
        borderRadius: 16,
        padding: "20px 22px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
        border: warn ? "1.5px solid #FCA5A5" : "1px solid rgba(0,0,0,0.06)",
        display: "flex",
        flexDirection: "column" as const,
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, opacity: 0.7 }}>
        <span style={{ color: accent ? "#A7F3D0" : "#0B6B3A" }}>{icon}</span>
        <span style={{ fontSize: 12, fontWeight: 500, color: accent ? "#D1FAE5" : "#6B7280", letterSpacing: "0.02em" }}>
          {label}
        </span>
      </div>
      {loading ? (
        <Skeleton className="h-7 w-28 mt-1" />
      ) : (
        <div style={{ fontSize: 22, fontWeight: 700, color: accent ? "#fff" : "#111827", lineHeight: 1.2 }}>
          {value ?? "—"}
        </div>
      )}
      {sub && !loading && (
        <div style={{ fontSize: 12, color: warn ? "#DC2626" : accent ? "#A7F3D0" : "#9CA3AF" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

// ── Container Card ────────────────────────────────────────────────────────────

function ContainerCard({ c, onClick }: { c: ContainerSummary; onClick: () => void }) {
  const isEmpty = c.skuCount === 0;
  const color   = occupancyColor(c.occupancyPct);

  return (
    <button
      onClick={onClick}
      style={{
        background: "#fff",
        borderRadius: 16,
        padding: "18px 20px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        border: isEmpty ? "1px dashed #E5E7EB" : "1px solid rgba(0,0,0,0.06)",
        textAlign: "left",
        cursor: "pointer",
        transition: "all 0.15s ease",
        width: "100%",
        display: "flex",
        flexDirection: "column" as const,
        gap: 12,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 4px 12px rgba(0,0,0,0.12)";
        (e.currentTarget as HTMLButtonElement).style.transform = "translateY(-2px)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 1px 3px rgba(0,0,0,0.06)";
        (e.currentTarget as HTMLButtonElement).style.transform = "translateY(0)";
      }}
    >
      {/* Name row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 18 }}>{c.locationType === "ayvon" ? "🏠" : "📦"}</span>
          <span style={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>{c.name}</span>
        </div>
        {!isEmpty && (
          <ChevronRight style={{ width: 16, height: 16, color: "#9CA3AF" }} />
        )}
      </div>

      {/* Stats */}
      <div style={{ display: "flex", gap: 16 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: isEmpty ? "#D1D5DB" : "#0B6B3A", lineHeight: 1 }}>
            {isEmpty ? "—" : c.skuCount}
          </div>
          <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2 }}>SKU</div>
        </div>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: isEmpty ? "#D1D5DB" : "#111827", lineHeight: 1 }}>
            {isEmpty ? "—" : c.totalQty > 0 ? fmt(c.totalQty) : fmt(c.totalWeightKg)}
          </div>
          <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2 }}>
            {isEmpty ? "dona/kg" : c.totalQty > 0 ? (c.totalWeightKg > 0 ? `dona · ${fmt(c.totalWeightKg)} kg` : "dona") : "kg"}
          </div>
        </div>
        {!isEmpty && (
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#374151", lineHeight: 1 }}>
              {fmtVal(c.totalValueUzs)}
            </div>
            <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2 }}>so'm</div>
          </div>
        )}
      </div>

      {/* Occupancy bar */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span style={{ fontSize: 11, color: "#9CA3AF" }}>Bandlik</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: isEmpty ? "#D1D5DB" : color }}>
            {isEmpty ? "Bo'sh" : `${c.occupancyPct}%`}
          </span>
        </div>
        <div style={{ height: 4, background: "#F3F4F6", borderRadius: 4, overflow: "hidden" }}>
          <div
            style={{
              height: "100%",
              width: `${c.occupancyPct}%`,
              background: color,
              borderRadius: 4,
              transition: "width 0.4s ease",
            }}
          />
        </div>
      </div>
    </button>
  );
}

// ── Container Grid ────────────────────────────────────────────────────────────

function ContainerGrid({
  containers,
  loading,
  onSelect,
}: {
  containers: ContainerSummary[];
  loading: boolean;
  onSelect: (c: ContainerSummary) => void;
}) {
  if (loading) {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
        {Array.from({ length: 12 }).map((_, i) => (
          <Skeleton key={i} style={{ height: 150, borderRadius: 16 }} />
        ))}
      </div>
    );
  }

  const konteynerlar = containers.filter((c) => c.locationType !== "ayvon");
  const ayvonlar = containers.filter((c) => c.locationType === "ayvon");
  const grid = (list: ContainerSummary[]) => (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
      {list.map((c) => (
        <ContainerCard key={c.id} c={c} onClick={() => onSelect(c)} />
      ))}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#6B7280", marginBottom: 8 }}>
          Konteynerlar ({konteynerlar.length})
        </div>
        {grid(konteynerlar)}
      </div>
      {ayvonlar.length > 0 && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#6B7280", marginBottom: 8 }}>
            Ayvonlar ({ayvonlar.length})
          </div>
          {grid(ayvonlar)}
        </div>
      )}
    </div>
  );
}

// ── Container Detail ──────────────────────────────────────────────────────────

function ContainerDetailView({
  containerId,
  containerName,
  locationType,
  onBack,
  onTransfer,
  onReceive,
  onAdjust,
}: {
  containerId: number;
  containerName: string;
  locationType?: "container" | "ayvon";
  onBack: () => void;
  onTransfer: (product: string, qty: number, weightKg?: number) => void;
  onReceive: () => void;
  onAdjust: (item: ContainerItem) => void;
}) {
  const { data, isLoading } = useContainerDetail(containerId);

  const totalValue = data?.items.reduce((s, i) => s + i.totalValueUzs, 0) ?? 0;
  const totalQty   = data?.items.reduce((s, i) => s + i.quantity, 0) ?? 0;
  const totalKg    = data?.items.reduce((s, i) => s + (i.weightKg ?? 0), 0) ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Back + header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          onClick={onBack}
          style={{
            background: "#F4F7F5", border: "none", borderRadius: 10,
            padding: "8px 12px", cursor: "pointer", display: "flex",
            alignItems: "center", gap: 6, color: "#374151", fontSize: 14, fontWeight: 500,
          }}
        >
          <ArrowLeft style={{ width: 16, height: 16 }} /> Orqaga
        </button>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: "#111827", margin: 0 }}>
            {locationType === "ayvon" ? "🏠" : "📦"} {containerName}
          </h2>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <Button variant="outline" size="sm" onClick={onReceive}>
            <Plus style={{ width: 14, height: 14, marginRight: 6 }} /> Qabul qilish
          </Button>
          <Button size="sm" onClick={() => onTransfer("", 0)}>
            <ArrowLeftRight style={{ width: 14, height: 14, marginRight: 6 }} /> Transfer
          </Button>
        </div>
      </div>

      {/* Container stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <KpiCard icon={<Boxes style={{ width: 18, height: 18 }} />} label="SKU soni"
          value={isLoading ? undefined : data?.items.length ?? 0} loading={isLoading} />
        <KpiCard icon={<Package style={{ width: 18, height: 18 }} />} label="Jami miqdor"
          value={isLoading ? undefined : totalQty > 0 ? fmt(totalQty) : `${fmt(totalKg)} kg`}
          sub={!isLoading && totalQty > 0 && totalKg > 0 ? `${fmt(totalKg)} kg` : undefined}
          loading={isLoading} />
        <KpiCard icon={<TrendingUp style={{ width: 18, height: 18 }} />} label="Jami qiymat"
          value={isLoading ? undefined : fmtVal(totalValue)} accent loading={isLoading} />
      </div>

      {/* Items table */}
      <div style={{
        background: "#fff", borderRadius: 16, overflow: "hidden",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)", border: "1px solid rgba(0,0,0,0.06)",
      }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #F3F4F6" }}>
          <span style={{ fontWeight: 600, fontSize: 15, color: "#111827" }}>Konteyner ichidagi mahsulotlar</span>
        </div>
        {isLoading ? (
          <div style={{ padding: 24 }}>
            {[1, 2, 3].map((i) => <Skeleton key={i} style={{ height: 44, marginBottom: 8, borderRadius: 8 }} />)}
          </div>
        ) : !data?.items.length ? (
          <div style={{ textAlign: "center", padding: "48px 24px", color: "#9CA3AF" }}>
            <span style={{ fontSize: 40 }}>📭</span>
            <div style={{ marginTop: 12, fontWeight: 500 }}>Konteyner bo'sh</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>Mahsulot qabul qilish uchun yuqoridagi tugmani bosing</div>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#F9FAFB" }}>
                  {["Mahsulot", "Miqdor", "Og'irlik (kg)", "Birlik", "Narx (so'm)", "Qiymat", "Tur", "", ""].map((h, hi) => (
                    <th key={hi} style={{
                      padding: "10px 16px", textAlign: "left", fontSize: 12,
                      fontWeight: 600, color: "#6B7280", letterSpacing: "0.04em",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id} style={{ borderTop: "1px solid #F3F4F6" }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = "#F9FAFB"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = ""; }}>
                    <td style={{ padding: "12px 16px", fontWeight: 500, color: "#111827", fontSize: 14 }}>
                      {item.product}
                    </td>
                    <td style={{ padding: "12px 16px", color: "#374151", fontWeight: 600 }}>
                      {fmt(item.quantity)}
                    </td>
                    <td style={{ padding: "12px 16px", color: item.weightKg != null ? "#0B6B3A" : "#D1D5DB", fontWeight: 600 }}>
                      {item.weightKg != null
                        ? `${item.weightKg.toLocaleString("uz-UZ", { maximumFractionDigits: 1 })} kg`
                        : "—"}
                    </td>
                    <td style={{ padding: "12px 16px", color: "#6B7280", fontSize: 13 }}>{item.unit}</td>
                    <td style={{ padding: "12px 16px", color: "#374151" }}>
                      {formatCurrency(item.priceUzs)}
                    </td>
                    <td style={{ padding: "12px 16px", fontWeight: 600, color: "#0B6B3A" }}>
                      {fmtVal(item.totalValueUzs)}
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      <span style={{
                        fontSize: 11, padding: "3px 8px", borderRadius: 6, fontWeight: 500,
                        background: item.productType === "raw" ? "#FEF3C7" : item.productType === "pre-finished" ? "#DBEAFE" : "#DCFCE7",
                        color: item.productType === "raw" ? "#92400E" : item.productType === "pre-finished" ? "#1E40AF" : "#166534",
                      }}>
                        {item.productType === "raw" ? "Xom" : item.productType === "pre-finished" ? "Yarim tayyor" : "Tayyor"}
                      </span>
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      <button
                        onClick={() => onTransfer(item.product, item.quantity, item.weightKg ?? 0)}
                        style={{
                          border: "none", background: "none", cursor: "pointer",
                          color: "#6B7280", padding: "4px 8px", borderRadius: 6,
                          fontSize: 12, display: "flex", alignItems: "center", gap: 4,
                        }}
                      >
                        <ArrowLeftRight style={{ width: 12, height: 12 }} /> Transfer
                      </button>
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      <button
                        onClick={() => onAdjust(item)}
                        style={{
                          border: "none", background: "none", cursor: "pointer",
                          color: "#6B7280", padding: "4px 8px", borderRadius: 6,
                          fontSize: 12, display: "flex", alignItems: "center", gap: 4,
                        }}
                      >
                        <SlidersHorizontal style={{ width: 12, height: 12 }} /> To'g'rilash
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Per-warehouse movements */}
      <ContainerMovementsPanel warehouseId={containerId} />
    </div>
  );
}

// ── Transfer Modal ─────────────────────────────────────────────────────────────

function TransferModal({
  fromId,
  fromName,
  containers,
  preProduct,
  preQty,
  preWeight,
  onClose,
  onDone,
}: {
  fromId: number;
  fromName: string;
  containers: ContainerSummary[];
  preProduct?: string;
  preQty?: number;
  preWeight?: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [product, setProduct]   = useState(preProduct ?? "");
  const [toId, setToId]         = useState<number>(0);
  const [qty, setQty]           = useState(preQty ? String(preQty) : "");
  const [weight, setWeight]     = useState(preWeight ? String(preWeight) : "");
  const [note, setNote]         = useState("");
  const [err, setErr]           = useState("");

  const { data: detailData } = useContainerDetail(fromId);
  const products = detailData?.items.map((i) => i.product) ?? [];
  const selItem  = detailData?.items.find((i) => i.product === product);
  const isKgOnly = !!selItem && selItem.quantity <= 0 && (selItem.weightKg ?? 0) > 0;

  const mut = useMutation({
    mutationFn: () =>
      authFetch("/api/ombor/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromId, toId, product,
          qty: isKgOnly ? 0 : Number(qty),
          weightKg: isKgOnly && weight !== "" ? Number(weight) : undefined,
          note,
        }),
      }).then((r) => r.json()),
    onSuccess: (d) => {
      if (d.error) { setErr(d.error); return; }
      qc.invalidateQueries({ queryKey: ["ombor-containers"] });
      qc.invalidateQueries({ queryKey: ["ombor-container-detail"] });
      qc.invalidateQueries({ queryKey: ["ombor-movements"] });
      qc.invalidateQueries({ queryKey: ["ombor-container-movements"] });
      qc.invalidateQueries({ queryKey: ["ombor-summary"] });
      onDone();
    },
    onError: () => setErr("Xatolik yuz berdi"),
  });

  const others = containers.filter((c) => c.id !== fromId);

  return (
    <ModalOverlay onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#111827" }}>
          Transfer: {fromName}
        </h3>
        <p style={{ margin: 0, fontSize: 13, color: "#6B7280" }}>
          <ArrowLeftRight style={{ width: 12, height: 12, display: "inline", marginRight: 4 }} />
          Mahsulotni boshqa konteynerga ko'chirish
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={labelStyle}>
            Mahsulot
            <select
              style={selectStyle}
              value={product}
              onChange={(e) => {
                // Mahsulot almashganda eski dona/kg qiymatlari chalg'itmasligi uchun tozalaymiz
                setProduct(e.target.value);
                setQty("");
                setWeight("");
              }}
            >
              <option value="">Tanlang…</option>
              {products.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>

          <label style={labelStyle}>
            Qayerga (konteyner)
            <select style={selectStyle} value={toId} onChange={(e) => setToId(Number(e.target.value))}>
              <option value={0}>Tanlang…</option>
              {others.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.skuCount} SKU)</option>
              ))}
            </select>
          </label>

          {isKgOnly ? (
            <label style={labelStyle}>
              Og'irlik (kg)
              <Input
                type="number" min="0.001" step="0.001" placeholder="0"
                value={weight} onChange={(e) => setWeight(e.target.value)}
                style={{ borderRadius: 10 }}
              />
              {selItem?.weightKg != null && (
                <span style={{ fontSize: 12, color: "#6B7280", marginTop: 4 }}>
                  Mavjud: {selItem.weightKg.toLocaleString("uz-UZ", { maximumFractionDigits: 2 })} kg
                </span>
              )}
            </label>
          ) : (
            <label style={labelStyle}>
              Miqdor
              <Input
                type="number" min="0.001" step="0.001" placeholder="0"
                value={qty} onChange={(e) => setQty(e.target.value)}
                style={{ borderRadius: 10 }}
              />
            </label>
          )}

          <label style={labelStyle}>
            Izoh (ixtiyoriy)
            <Input
              placeholder="Sabab…"
              value={note} onChange={(e) => setNote(e.target.value)}
              style={{ borderRadius: 10 }}
            />
          </label>
        </div>

        {err && <div style={{ color: "#DC2626", fontSize: 13 }}>{err}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="outline" onClick={onClose}>Bekor</Button>
          <Button
            onClick={() => { setErr(""); mut.mutate(); }}
            disabled={!product || !toId || (isKgOnly ? !(Number(weight) > 0) : !qty) || mut.isPending}
            style={{ background: "#0B6B3A", color: "#fff" }}
          >
            {mut.isPending ? "Ko'chirilmoqda…" : "Transfer qilish"}
          </Button>
        </div>
      </div>
    </ModalOverlay>
  );
}

// ── Receive (Finished-In) Modal ───────────────────────────────────────────────

function ReceiveModal({
  warehouseId,
  warehouseName,
  containers,
  onClose,
  onDone,
}: {
  warehouseId: number;
  warehouseName: string;
  containers: ContainerSummary[];
  onClose: () => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [product, setProduct]   = useState("");
  const [wId, setWId]           = useState(warehouseId);
  const [qty, setQty]           = useState("");
  const [weight, setWeight]     = useState("");
  const [note, setNote]         = useState("");
  const [err, setErr]           = useState("");

  const { data: products = [] } = useProducts();
  const isKg = (Array.isArray(products) ? products : []).some(
    (p: any) => p.name === product && p.unitType === "kg",
  );

  const mut = useMutation({
    mutationFn: () =>
      authFetch("/api/ombor/finished-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          warehouseId: wId, product, qty: Number(qty),
          weightKg: isKg && weight !== "" ? Number(weight) : undefined,
          note,
        }),
      }).then((r) => r.json()),
    onSuccess: (d) => {
      if (d.error) { setErr(d.error); return; }
      qc.invalidateQueries({ queryKey: ["ombor-containers"] });
      qc.invalidateQueries({ queryKey: ["ombor-container-detail"] });
      qc.invalidateQueries({ queryKey: ["ombor-summary"] });
      qc.invalidateQueries({ queryKey: ["ombor-movements"] });
      qc.invalidateQueries({ queryKey: ["ombor-container-movements"] });
      onDone();
    },
    onError: () => setErr("Xatolik yuz berdi"),
  });

  return (
    <ModalOverlay onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#111827" }}>
          Tayyor mahsulot qabul
        </h3>
        <p style={{ margin: 0, fontSize: 13, color: "#6B7280" }}>
          Ishlab chiqarishdan konteynerga mahsulot kiriting
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={labelStyle}>
            Mahsulot
            <select style={selectStyle} value={product} onChange={(e) => setProduct(e.target.value)}>
              <option value="">Tanlang…</option>
              {Array.isArray(products) && products.map((p: any) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </label>

          <label style={labelStyle}>
            Konteyner
            <select style={selectStyle} value={wId} onChange={(e) => setWId(Number(e.target.value))}>
              {containers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>

          <label style={labelStyle}>
            Miqdor (dona)
            <Input
              type="number" min="1" step="1" placeholder="0"
              value={qty} onChange={(e) => setQty(e.target.value)}
              style={{ borderRadius: 10 }}
            />
          </label>

          {isKg && (
            <label style={labelStyle}>
              Og'irlik (kg, ixtiyoriy)
              <Input
                type="number" min="0" step="0.001" placeholder="Bo'sh qolsa avtomatik hisoblanadi"
                value={weight} onChange={(e) => setWeight(e.target.value)}
                style={{ borderRadius: 10 }}
              />
            </label>
          )}

          <label style={labelStyle}>
            Izoh (ixtiyoriy)
            <Input
              placeholder="Masalan: Partiya № dan keldi"
              value={note} onChange={(e) => setNote(e.target.value)}
              style={{ borderRadius: 10 }}
            />
          </label>
        </div>

        {err && <div style={{ color: "#DC2626", fontSize: 13 }}>{err}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="outline" onClick={onClose}>Bekor</Button>
          <Button
            onClick={() => { setErr(""); mut.mutate(); }}
            disabled={!product || !qty || mut.isPending}
            style={{ background: "#0B6B3A", color: "#fff" }}
          >
            {mut.isPending ? "Saqlanmoqda…" : "Qabul qilish"}
          </Button>
        </div>
      </div>
    </ModalOverlay>
  );
}

// ── Adjust (Correct) Modal ────────────────────────────────────────────────────

function AdjustModal({
  warehouseId,
  warehouseName,
  product,
  currentQty,
  currentWeight,
  isKg,
  onClose,
  onDone,
}: {
  warehouseId: number;
  warehouseName: string;
  product: string;
  currentQty: number;
  currentWeight: number | null;
  isKg: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [qty, setQty]       = useState(String(currentQty));
  const [weight, setWeight] = useState(currentWeight != null ? String(currentWeight) : "");
  const [note, setNote]     = useState("");
  const [err, setErr]       = useState("");

  const mut = useMutation({
    mutationFn: () =>
      authFetch("/api/ombor/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          warehouseId, product, qty: Number(qty),
          weightKg: isKg && weight !== "" ? Number(weight) : undefined,
          note,
        }),
      }).then((r) => r.json()),
    onSuccess: (d) => {
      if (d.error) { setErr(d.error); return; }
      qc.invalidateQueries({ queryKey: ["ombor-containers"] });
      qc.invalidateQueries({ queryKey: ["ombor-container-detail"] });
      qc.invalidateQueries({ queryKey: ["ombor-summary"] });
      qc.invalidateQueries({ queryKey: ["ombor-movements"] });
      qc.invalidateQueries({ queryKey: ["ombor-container-movements"] });
      onDone();
    },
    onError: () => setErr("Xatolik yuz berdi"),
  });

  const disabled =
    qty === "" || (isKg && weight === "") || mut.isPending;

  return (
    <ModalOverlay onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#111827" }}>
          Zahirani to'g'rilash
        </h3>
        <p style={{ margin: 0, fontSize: 13, color: "#6B7280" }}>
          📦 {warehouseName} · <strong>{product}</strong>
          <br />
          Qayta sanash yoki to'kilishdan keyin miqdor{isKg ? " va og'irlikni" : "ni"} tuzating
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={labelStyle}>
            Miqdor (dona)
            <Input
              type="number" min="0" step="0.001" placeholder="0"
              value={qty} onChange={(e) => setQty(e.target.value)}
              style={{ borderRadius: 10 }}
            />
          </label>

          {isKg && (
            <label style={labelStyle}>
              Og'irlik (kg)
              <Input
                type="number" min="0" step="0.001" placeholder="0"
                value={weight} onChange={(e) => setWeight(e.target.value)}
                style={{ borderRadius: 10 }}
              />
            </label>
          )}

          <label style={labelStyle}>
            Izoh (ixtiyoriy)
            <Input
              placeholder="Masalan: qayta sanash, to'kilish…"
              value={note} onChange={(e) => setNote(e.target.value)}
              style={{ borderRadius: 10 }}
            />
          </label>
        </div>

        {err && <div style={{ color: "#DC2626", fontSize: 13 }}>{err}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="outline" onClick={onClose}>Bekor</Button>
          <Button
            onClick={() => { setErr(""); mut.mutate(); }}
            disabled={disabled}
            style={{ background: "#0B6B3A", color: "#fff" }}
          >
            {mut.isPending ? "Saqlanmoqda…" : "To'g'rilash"}
          </Button>
        </div>
      </div>
    </ModalOverlay>
  );
}

// ── Raw In Modal ───────────────────────────────────────────────────────────────

function RawInModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const [matId, setMatId]   = useState<number>(0);
  const [qty, setQty]       = useState("");
  const [note, setNote]     = useState("");
  const [err, setErr]       = useState("");

  const { data: raws = [] } = useRawMaterials();

  const mut = useMutation({
    mutationFn: () =>
      authFetch("/api/ombor/raw-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ materialId: matId, qty: Number(qty), note }),
      }).then((r) => r.json()),
    onSuccess: (d) => {
      if (d.error) { setErr(d.error); return; }
      qc.invalidateQueries({ queryKey: ["ombor-raw-materials"] });
      qc.invalidateQueries({ queryKey: ["ombor-summary"] });
      qc.invalidateQueries({ queryKey: ["ombor-movements"] });
      qc.invalidateQueries({ queryKey: ["ombor-container-movements"] });
      onDone();
    },
    onError: () => setErr("Xatolik"),
  });

  return (
    <ModalOverlay onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#111827" }}>
          Xom ashyo kirimi
        </h3>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={labelStyle}>
            Material
            <select style={selectStyle} value={matId} onChange={(e) => setMatId(Number(e.target.value))}>
              <option value={0}>Tanlang…</option>
              {Array.isArray(raws) && raws.map((r: any) => (
                <option key={r.id} value={r.id}>{r.name} ({r.unit})</option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Miqdor
            <Input
              type="number" min="0.001" step="0.001" placeholder="0"
              value={qty} onChange={(e) => setQty(e.target.value)}
              style={{ borderRadius: 10 }}
            />
          </label>
          <label style={labelStyle}>
            Izoh (ixtiyoriy)
            <Input placeholder="Yetkazib beruvchi, hujjat №…"
              value={note} onChange={(e) => setNote(e.target.value)}
              style={{ borderRadius: 10 }}
            />
          </label>
        </div>

        {err && <div style={{ color: "#DC2626", fontSize: 13 }}>{err}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="outline" onClick={onClose}>Bekor</Button>
          <Button
            onClick={() => { setErr(""); mut.mutate(); }}
            disabled={!matId || !qty || mut.isPending}
            style={{ background: "#0B6B3A", color: "#fff" }}
          >
            {mut.isPending ? "Saqlanmoqda…" : "Kirish"}
          </Button>
        </div>
      </div>
    </ModalOverlay>
  );
}

// ── Movements Panel ───────────────────────────────────────────────────────────

function movementIcon(type: string) {
  if (type === "IN")  return { emoji: "⬇️", color: "#16A34A", label: "Kirim" };
  if (type === "OUT") return { emoji: "⬆️", color: "#DC2626", label: "Chiqim" };
  return                     { emoji: "↔️", color: "#2563EB", label: "Transfer" };
}

function MovementRow({ m }: { m: Movement }) {
  const { emoji, color } = movementIcon(m.movementType);
  return (
    <div
      style={{
        padding: "12px 20px",
        borderBottom: "1px solid #F9FAFB",
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
      }}
    >
      <div style={{
        width: 36, height: 36, borderRadius: 10, flexShrink: 0,
        background: `${color}15`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 16,
      }}>
        {emoji}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: "#111827" }}>
            {m.product}
          </span>
          <span style={{ fontSize: 12, color, fontWeight: 600 }}>
            {m.movementType === "IN" ? "+" : m.movementType === "OUT" ? "-" : "↔"}{fmt(m.quantity)}
          </span>
          <span style={{
            fontSize: 11, padding: "2px 7px", borderRadius: 5, fontWeight: 500,
            background: m.productType === "raw" ? "#FEF3C7" : m.productType === "pre-finished" ? "#DBEAFE" : "#DCFCE7",
            color: m.productType === "raw" ? "#92400E" : m.productType === "pre-finished" ? "#1E40AF" : "#166534",
          }}>
            {m.productType === "raw" ? "Xom" : m.productType === "pre-finished" ? "Yarim tayyor" : "Tayyor"}
          </span>
        </div>
        <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>
          {m.fromWarehouse && <span>{m.fromWarehouse} <ArrowRight style={{ width: 10, height: 10, display: "inline" }} /> </span>}
          {m.toWarehouse && <span>{m.toWarehouse}</span>}
          {m.note && <span> · {m.note}</span>}
          {m.createdBy && <span> · 👤 {m.createdBy}</span>}
        </div>
      </div>
      <div style={{ fontSize: 11, color: "#9CA3AF", whiteSpace: "nowrap", flexShrink: 0 }}>
        {timeAgo(m.createdAt)}
      </div>
    </div>
  );
}

type FgSort = "value" | "qty" | "name";

function FinishedGoodsPanel() {
  const { data: goods = [], isLoading } = useFinishedGoods();
  const totalValue = goods.reduce((s, g) => s + g.totalValueUzs, 0);
  const lowCount = goods.filter((g) => g.low).length;

  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<FgSort>("value");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? goods.filter((g) => g.product.toLowerCase().includes(q)) : goods.slice();
    filtered.sort((a, b) => {
      if (sortBy === "name") return a.product.localeCompare(b.product);
      if (sortBy === "qty") return kgAwareStock(b) - kgAwareStock(a);
      return b.totalValueUzs - a.totalValueUzs;
    });
    return filtered;
  }, [goods, query, sortBy]);

  const visibleValue = visible.reduce((s, g) => s + g.totalValueUzs, 0);

  const sortBtn = (key: FgSort, label: string) => (
    <button
      key={key}
      onClick={() => setSortBy(key)}
      style={{
        padding: "6px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer",
        border: "1px solid", borderColor: sortBy === key ? "#0B6B3A" : "#E5E7EB",
        background: sortBy === key ? "#0B6B3A" : "#fff", color: sortBy === key ? "#fff" : "#6B7280",
      }}
    >{label}</button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Summary strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 12 }}>
        <KpiCard
          icon={<Package style={{ width: 18, height: 18 }} />}
          label="Mahsulot turlari"
          value={isLoading ? undefined : goods.length}
          loading={isLoading}
        />
        <KpiCard
          icon={<TrendingUp style={{ width: 18, height: 18 }} />}
          label="Jami tayyor mahsulot qiymati"
          value={isLoading ? undefined : fmtVal(totalValue)}
          sub={isLoading ? undefined : "so'm"}
          accent
          loading={isLoading}
        />
        <KpiCard
          icon={<AlertTriangle style={{ width: 18, height: 18 }} />}
          label="Kam qolgan"
          value={isLoading ? undefined : lowCount}
          sub={isLoading ? undefined : "minimal zahiradan past"}
          warn={lowCount > 0}
          loading={isLoading}
        />
      </div>

      {/* Table */}
      <div style={{
        background: "#fff", borderRadius: 16, overflow: "hidden",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)", border: "1px solid rgba(0,0,0,0.06)",
      }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #F3F4F6", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Package style={{ width: 16, height: 16, color: "#0B6B3A" }} />
          <span style={{ fontWeight: 600, fontSize: 15, color: "#111827" }}>Tayyor mahsulot zahirasi</span>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ position: "relative" }}>
              <Search style={{ width: 14, height: 14, color: "#9CA3AF", position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)" }} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Mahsulot qidirish..."
                style={{
                  padding: "7px 10px 7px 28px", borderRadius: 8, border: "1px solid #E5E7EB",
                  fontSize: 13, width: 180, outline: "none",
                }}
              />
            </div>
            {sortBtn("value", "Qiymat")}
            {sortBtn("qty", "Zahira")}
            {sortBtn("name", "Nomi")}
          </div>
        </div>

        {isLoading ? (
          <div style={{ padding: 24 }}>
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} style={{ height: 44, marginBottom: 8, borderRadius: 8 }} />)}
          </div>
        ) : !goods.length ? (
          <div style={{ textAlign: "center", padding: "48px 24px", color: "#9CA3AF" }}>
            <span style={{ fontSize: 40 }}>📦</span>
            <div style={{ marginTop: 12, fontWeight: 500 }}>Zahirada tayyor mahsulot yo'q</div>
          </div>
        ) : !visible.length ? (
          <div style={{ textAlign: "center", padding: "48px 24px", color: "#9CA3AF" }}>
            <div style={{ fontWeight: 500 }}>"{query}" bo'yicha mahsulot topilmadi</div>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#F9FAFB" }}>
                  {["Mahsulot", "Zahira", "Min. zahira", "Birlik", "Narx (so'm)", "Jami qiymat"].map((h, hi) => (
                    <th key={hi} style={{
                      padding: "10px 16px", textAlign: hi === 0 ? "left" : "right", fontSize: 12,
                      fontWeight: 600, color: "#6B7280", letterSpacing: "0.04em",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((g) => {
                  const isUsd = String(g.currency).toUpperCase() === "USD";
                  return (
                    <tr key={g.product} style={{ borderTop: "1px solid #F3F4F6", background: g.low ? "#FEF2F2" : undefined }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = g.low ? "#FEE2E2" : "#F9FAFB"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = g.low ? "#FEF2F2" : ""; }}>
                      <td style={{ padding: "12px 16px", fontWeight: 500, color: "#111827", fontSize: 14 }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          {g.low && <AlertTriangle style={{ width: 14, height: 14, color: "#DC2626" }} />}
                          {g.product}
                        </span>
                      </td>
                      <td style={{ padding: "12px 16px", fontWeight: 600, textAlign: "right", color: g.low ? "#DC2626" : "#374151" }}>
                        {String(g.unitType).toLowerCase() === "kg" && g.stockWeightKg > 0
                          ? `${fmt(g.stockWeightKg)} kg`
                          : fmt(g.stockQty)}
                      </td>
                      <td style={{ padding: "12px 16px", color: "#9CA3AF", fontSize: 13, textAlign: "right" }}>
                        {g.minimumStock > 0 ? fmt(g.minimumStock) : "—"}
                      </td>
                      <td style={{ padding: "12px 16px", color: "#6B7280", fontSize: 13, textAlign: "right" }}>
                        {g.unitType}
                      </td>
                      <td style={{ padding: "12px 16px", color: "#374151", textAlign: "right" }}>
                        {formatCurrency(g.priceUzs)}
                        {isUsd && (
                          <span style={{ fontSize: 11, color: "#9CA3AF", marginLeft: 6 }}>
                            (${fmt(g.salePrice)})
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "12px 16px", fontWeight: 600, color: "#0B6B3A", textAlign: "right" }}>
                        {fmtVal(g.totalValueUzs)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: "2px solid #E5E7EB", background: "#F9FAFB" }}>
                  <td colSpan={5} style={{ padding: "12px 16px", fontWeight: 600, color: "#374151", textAlign: "right" }}>
                    Jami{query.trim() ? " (filtrlangan)" : ""}:
                  </td>
                  <td style={{ padding: "12px 16px", fontWeight: 700, color: "#0B6B3A", textAlign: "right" }}>
                    {fmtVal(query.trim() ? visibleValue : totalValue)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function MovementsPanel() {
  const [operator, setOperator] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { data: movements = [], isLoading } = useMovements(operator || undefined, from || undefined, to || undefined);
  const { data: operators = [] } = useOperators();

  const dateInputStyle: CSSProperties = {
    fontSize: 13, color: "#374151", padding: "5px 10px",
    borderRadius: 8, border: "1px solid #E5E7EB", background: "#fff", cursor: "pointer",
  };

  return (
    <div style={{
      background: "#fff", borderRadius: 16, overflow: "hidden",
      boxShadow: "0 1px 3px rgba(0,0,0,0.06)", border: "1px solid rgba(0,0,0,0.06)",
    }}>
      <div style={{ padding: "16px 20px", borderBottom: "1px solid #F3F4F6", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Clock style={{ width: 16, height: 16, color: "#0B6B3A" }} />
        <span style={{ fontWeight: 600, fontSize: 15, color: "#111827" }}>Harakatlar tarixi</span>
        <select
          value={operator}
          onChange={(e) => setOperator(e.target.value)}
          style={{
            marginLeft: 8, fontSize: 13, color: "#374151", padding: "5px 10px",
            borderRadius: 8, border: "1px solid #E5E7EB", background: "#fff", cursor: "pointer",
          }}
        >
          <option value="">👤 Barcha operatorlar</option>
          {operators.map((op) => <option key={op} value={op}>{op}</option>)}
        </select>
        <input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(e) => setFrom(e.target.value)}
          title="Boshlanish sanasi"
          style={dateInputStyle}
        />
        <span style={{ fontSize: 13, color: "#9CA3AF" }}>—</span>
        <input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => setTo(e.target.value)}
          title="Tugash sanasi"
          style={dateInputStyle}
        />
        {(from || to) && (
          <button
            onClick={() => { setFrom(""); setTo(""); }}
            style={{
              fontSize: 13, color: "#6B7280", padding: "5px 10px", borderRadius: 8,
              border: "1px solid #E5E7EB", background: "#fff", cursor: "pointer",
            }}
          >
            Tozalash
          </button>
        )}
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#9CA3AF" }}>{movements.length} ta yozuv</span>
      </div>

      {isLoading ? (
        <div style={{ padding: 20 }}>
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} style={{ height: 56, marginBottom: 8, borderRadius: 10 }} />)}
        </div>
      ) : !movements.length ? (
        <div style={{ textAlign: "center", padding: "40px 24px", color: "#9CA3AF" }}>
          Hozircha harakatlar yo'q
        </div>
      ) : (
        <div style={{ maxHeight: 400, overflowY: "auto" }}>
          {movements.map((m) => <MovementRow key={m.id} m={m} />)}
        </div>
      )}
    </div>
  );
}

function ContainerMovementsPanel({ warehouseId }: { warehouseId: number }) {
  const [operator, setOperator] = useState("");
  const { data: movements = [], isLoading } = useContainerMovements(warehouseId, operator || undefined);
  const { data: operators = [] } = useOperators(warehouseId);

  return (
    <div style={{
      background: "#fff", borderRadius: 16, overflow: "hidden",
      boxShadow: "0 1px 3px rgba(0,0,0,0.06)", border: "1px solid rgba(0,0,0,0.06)",
    }}>
      <div style={{ padding: "16px 20px", borderBottom: "1px solid #F3F4F6", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Clock style={{ width: 16, height: 16, color: "#0B6B3A" }} />
        <span style={{ fontWeight: 600, fontSize: 15, color: "#111827" }}>Konteyner harakatlari</span>
        <select
          value={operator}
          onChange={(e) => setOperator(e.target.value)}
          style={{
            marginLeft: 8, fontSize: 13, color: "#374151", padding: "5px 10px",
            borderRadius: 8, border: "1px solid #E5E7EB", background: "#fff", cursor: "pointer",
          }}
        >
          <option value="">👤 Barcha operatorlar</option>
          {operators.map((op) => <option key={op} value={op}>{op}</option>)}
        </select>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#9CA3AF" }}>{movements.length} ta yozuv</span>
      </div>

      {isLoading ? (
        <div style={{ padding: 20 }}>
          {[1, 2, 3].map((i) => <Skeleton key={i} style={{ height: 56, marginBottom: 8, borderRadius: 10 }} />)}
        </div>
      ) : !movements.length ? (
        <div style={{ textAlign: "center", padding: "40px 24px", color: "#9CA3AF" }}>
          Bu konteyner uchun hozircha harakatlar yo'q
        </div>
      ) : (
        <div style={{ maxHeight: 360, overflowY: "auto" }}>
          {movements.map((m) => <MovementRow key={m.id} m={m} />)}
        </div>
      )}
    </div>
  );
}

// ── Search Results ─────────────────────────────────────────────────────────────

function SearchResults({ q, onContainerClick }: { q: string; onContainerClick: (id: number, name: string) => void }) {
  const { data: results = [], isLoading } = useSearch(q);

  if (isLoading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {[1, 2, 3].map((i) => <Skeleton key={i} style={{ height: 60, borderRadius: 12 }} />)}
      </div>
    );
  }

  if (!results.length) {
    return (
      <div style={{
        background: "#fff", borderRadius: 16, padding: "40px 24px",
        textAlign: "center", color: "#9CA3AF",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
      }}>
        <div style={{ fontSize: 32 }}>🔍</div>
        <div style={{ marginTop: 12, fontWeight: 500 }}>
          "{q}" bo'yicha hech narsa topilmadi
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 13, color: "#6B7280", marginBottom: 4 }}>
        {results.length} ta natija topildi
      </div>
      {results.map((r, i) => (
        <button
          key={i}
          onClick={() => onContainerClick(r.warehouseId, r.warehouseName)}
          style={{
            background: "#fff", borderRadius: 12, padding: "14px 18px",
            border: "1px solid rgba(0,0,0,0.06)",
            boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
            textAlign: "left", cursor: "pointer", width: "100%",
            display: "flex", alignItems: "center", justifyContent: "space-between",
            transition: "all 0.15s",
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 4px 12px rgba(0,0,0,0.1)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 1px 3px rgba(0,0,0,0.06)"; }}
        >
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, color: "#111827" }}>{r.product}</div>
            <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>
              📦 {r.warehouseName} ·{" "}
              <span style={{ fontWeight: 600, color: "#0B6B3A" }}>{fmt(r.quantity)} {r.unit}</span>
            </div>
          </div>
          <ChevronRight style={{ width: 16, height: 16, color: "#9CA3AF" }} />
        </button>
      ))}
    </div>
  );
}

// ── Modal Overlay ─────────────────────────────────────────────────────────────

function ModalOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 100, padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "#fff", borderRadius: 20, padding: 28,
        width: "100%", maxWidth: 480,
        boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
        maxHeight: "90vh", overflowY: "auto",
      }}>
        {children}
      </div>
    </div>
  );
}

// ── Style constants ────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 6,
  fontSize: 13, fontWeight: 500, color: "#374151",
};

const selectStyle: React.CSSProperties = {
  border: "1px solid #E5E7EB", borderRadius: 10, padding: "8px 12px",
  fontSize: 14, color: "#111827", background: "#fff",
  outline: "none", cursor: "pointer", width: "100%",
};

// ── Main Page ─────────────────────────────────────────────────────────────────

type Modal =
  | { kind: "transfer"; fromId: number; fromName: string; product?: string; qty?: number; weightKg?: number }
  | { kind: "receive"; warehouseId: number; warehouseName: string }
  | { kind: "adjust"; warehouseId: number; warehouseName: string; product: string; currentQty: number; currentWeight: number | null; isKg: boolean }
  | { kind: "rawin" };

export default function Inventory() {
  const qc = useQueryClient();
  const [selectedContainer, setSelectedContainer] = useState<ContainerSummary | null>(null);
  const [modal, setModal]       = useState<Modal | null>(null);
  const [searchQ, setSearchQ]   = useState("");
  const [activeTab, setActiveTab] = useState<"containers" | "finished" | "movements">("containers");

  const { data: summary, isLoading: loadSummary } = useSummary();
  const { data: containers = [], isLoading: loadContainers } = useContainers();

  const refreshAll = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["ombor-summary"] });
    qc.invalidateQueries({ queryKey: ["ombor-containers"] });
    qc.invalidateQueries({ queryKey: ["ombor-movements"] });
    qc.invalidateQueries({ queryKey: ["ombor-container-movements"] });
    qc.invalidateQueries({ queryKey: ["ombor-finished-goods"] });
    if (selectedContainer) {
      qc.invalidateQueries({ queryKey: ["ombor-container-detail", selectedContainer.id] });
    }
  }, [qc, selectedContainer]);

  const isSearching = searchQ.trim().length >= 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          {selectedContainer ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                onClick={() => setSelectedContainer(null)}
                style={{ border: "none", background: "none", cursor: "pointer", color: "#6B7280", padding: 0 }}
              >
                <ArrowLeft style={{ width: 18, height: 18 }} />
              </button>
              <div>
                <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#111827" }}>
                  📦 {selectedContainer.name}
                </h1>
                <p style={{ margin: "2px 0 0", fontSize: 13, color: "#6B7280" }}>Konteyner profili</p>
              </div>
            </div>
          ) : (
            <div>
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#111827" }}>
                🏭 Ombor
              </h1>
              <p style={{ margin: "2px 0 0", fontSize: 13, color: "#6B7280" }}>
                Warehouse Management System
              </p>
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {!selectedContainer && (
            <>
              {/* Search */}
              <div style={{ position: "relative" }}>
                <Search style={{
                  position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)",
                  width: 15, height: 15, color: "#9CA3AF", pointerEvents: "none",
                }} />
                <Input
                  placeholder="SKU qidirish…"
                  value={searchQ}
                  onChange={(e) => setSearchQ(e.target.value)}
                  style={{ paddingLeft: 32, width: 200, borderRadius: 10, height: 36 }}
                />
                {searchQ && (
                  <button
                    onClick={() => setSearchQ("")}
                    style={{
                      position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                      border: "none", background: "none", cursor: "pointer", color: "#9CA3AF", padding: 0,
                    }}
                  >
                    <X style={{ width: 14, height: 14 }} />
                  </button>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={refreshAll}>
                <RefreshCw style={{ width: 14, height: 14, marginRight: 6 }} /> Yangilash
              </Button>
              <Button size="sm" onClick={() => setModal({ kind: "rawin" })}
                style={{ background: "#0B6B3A", color: "#fff" }}>
                <Plus style={{ width: 14, height: 14, marginRight: 6 }} /> Xom ashyo
              </Button>
            </>
          )}
          {selectedContainer && (
            <>
              <Button variant="outline" size="sm" onClick={() => setModal({
                kind: "receive", warehouseId: selectedContainer.id, warehouseName: selectedContainer.name,
              })}>
                <Plus style={{ width: 14, height: 14, marginRight: 6 }} /> Qabul
              </Button>
              <Button size="sm" onClick={() => setModal({
                kind: "transfer", fromId: selectedContainer.id, fromName: selectedContainer.name,
              })} style={{ background: "#0B6B3A", color: "#fff" }}>
                <ArrowLeftRight style={{ width: 14, height: 14, marginRight: 6 }} /> Transfer
              </Button>
            </>
          )}
        </div>
      </div>

      {/* ── KPI Row ── */}
      {!selectedContainer && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 12 }}>
          <KpiCard
            icon={<Container style={{ width: 18, height: 18 }} />}
            label="Jami konteynerlar"
            value={loadSummary ? undefined : summary?.totalContainers ?? 0}
            sub={loadSummary || !(summary?.totalAyvons) ? undefined : `+ ${summary.totalAyvons} ta ayvon`}
            loading={loadSummary}
          />
          <KpiCard
            icon={<Boxes style={{ width: 18, height: 18 }} />}
            label="Band"
            value={loadSummary ? undefined : summary?.occupiedContainers ?? 0}
            sub={loadSummary ? undefined : `${summary?.emptyContainers ?? 0} ta bo'sh`}
            loading={loadSummary}
          />
          <KpiCard
            icon={<TrendingUp style={{ width: 18, height: 18 }} />}
            label="Jami aktiv"
            value={loadSummary ? undefined : fmtVal(summary?.totalValueUzs ?? 0)}
            accent
            loading={loadSummary}
          />
          <KpiCard
            icon={<Package style={{ width: 18, height: 18 }} />}
            label="Tayyor mahsulot"
            value={loadSummary ? undefined : fmtVal(summary?.finishedGoodsValueUzs ?? 0)}
            sub={loadSummary ? undefined : `${summary?.finishedGoodsSkuCount ?? 0} ta SKU`}
            loading={loadSummary}
          />
          <KpiCard
            icon={<AlertTriangle style={{ width: 18, height: 18 }} />}
            label="Kam qolgan"
            value={loadSummary ? undefined : summary?.lowStockRawCount ?? 0}
            sub={loadSummary ? undefined : "xom ashyo turi"}
            warn={(summary?.lowStockRawCount ?? 0) > 0}
            loading={loadSummary}
          />
        </div>
      )}

      {/* ── Search results ── */}
      {isSearching && !selectedContainer && (
        <SearchResults
          q={searchQ}
          onContainerClick={(id, name) => {
            const c = containers.find((x) => x.id === id);
            if (c) { setSelectedContainer(c); setSearchQ(""); }
          }}
        />
      )}

      {/* ── Container Detail ── */}
      {selectedContainer && !isSearching && (
        <ContainerDetailView
          containerId={selectedContainer.id}
          containerName={selectedContainer.name}
          locationType={selectedContainer.locationType}
          onBack={() => setSelectedContainer(null)}
          onTransfer={(product, qty, weightKg) =>
            setModal({ kind: "transfer", fromId: selectedContainer.id, fromName: selectedContainer.name, product, qty, weightKg })
          }
          onReceive={() =>
            setModal({ kind: "receive", warehouseId: selectedContainer.id, warehouseName: selectedContainer.name })
          }
          onAdjust={(item) =>
            setModal({
              kind: "adjust",
              warehouseId: selectedContainer.id,
              warehouseName: selectedContainer.name,
              product: item.product,
              currentQty: item.quantity,
              currentWeight: item.weightKg,
              isKg: String(item.unit).toLowerCase() === "kg",
            })
          }
        />
      )}

      {/* ── Main tabs (Containers / Movements) ── */}
      {!selectedContainer && !isSearching && (
        <>
          {/* Tab bar */}
          <div style={{ display: "flex", gap: 4, background: "#F4F7F5", padding: 4, borderRadius: 12, width: "fit-content" }}>
            {(["containers", "finished", "movements"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: "7px 18px", borderRadius: 9, border: "none", cursor: "pointer",
                  fontSize: 13, fontWeight: 600, transition: "all 0.15s",
                  background: activeTab === tab ? "#fff" : "transparent",
                  color: activeTab === tab ? "#0B6B3A" : "#6B7280",
                  boxShadow: activeTab === tab ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                }}
              >
                {tab === "containers" ? (
                  <span><LayoutGrid style={{ width: 13, height: 13, display: "inline", marginRight: 6 }} />Konteynerlar</span>
                ) : tab === "finished" ? (
                  <span><Package style={{ width: 13, height: 13, display: "inline", marginRight: 6 }} />Tayyor mahsulot</span>
                ) : (
                  <span><Clock style={{ width: 13, height: 13, display: "inline", marginRight: 6 }} />Harakatlar</span>
                )}
              </button>
            ))}
          </div>

          {activeTab === "containers" ? (
            <ContainerGrid
              containers={containers}
              loading={loadContainers}
              onSelect={(c) => setSelectedContainer(c)}
            />
          ) : activeTab === "finished" ? (
            <FinishedGoodsPanel />
          ) : (
            <MovementsPanel />
          )}
        </>
      )}

      {/* ── Modals ── */}
      {modal?.kind === "transfer" && (
        <TransferModal
          fromId={modal.fromId}
          fromName={modal.fromName}
          containers={containers}
          preProduct={modal.product}
          preQty={modal.qty}
          preWeight={modal.weightKg}
          onClose={() => setModal(null)}
          onDone={() => setModal(null)}
        />
      )}
      {modal?.kind === "receive" && (
        <ReceiveModal
          warehouseId={modal.warehouseId}
          warehouseName={modal.warehouseName}
          containers={containers}
          onClose={() => setModal(null)}
          onDone={() => setModal(null)}
        />
      )}
      {modal?.kind === "adjust" && (
        <AdjustModal
          warehouseId={modal.warehouseId}
          warehouseName={modal.warehouseName}
          product={modal.product}
          currentQty={modal.currentQty}
          currentWeight={modal.currentWeight}
          isKg={modal.isKg}
          onClose={() => setModal(null)}
          onDone={() => setModal(null)}
        />
      )}
      {modal?.kind === "rawin" && (
        <RawInModal onClose={() => setModal(null)} onDone={() => setModal(null)} />
      )}
    </div>
  );
}
