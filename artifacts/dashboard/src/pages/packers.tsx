import { authFetch } from "@/App";
import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ChevronDown, ChevronRight, HardHat, Save, Package, Search } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
type PackerProduct = {
  productName: string;
  productId: number;
  unitType: string;
};

type Packer = {
  packerName: string;
  products: PackerProduct[];
};

type Product = {
  id: number;
  name: string;
  unitType: string;
  active: boolean;
};

// ── Keys ──────────────────────────────────────────────────────────────────────
const PACKER_ASSIGNMENTS_KEY = ["packer-assignments"];
const ALL_PRODUCTS_KEY = ["v3-products"];

// ── Hooks ─────────────────────────────────────────────────────────────────────
function usePackerAssignments() {
  return useQuery<Packer[]>({
    queryKey: PACKER_ASSIGNMENTS_KEY,
    queryFn: async () => {
      const res = await authFetch("/api/packer-assignments");
      if (!res.ok) throw new Error("Yuklashda xato");
      return res.json();
    },
  });
}

function useAllProducts() {
  return useQuery<Product[]>({
    queryKey: ALL_PRODUCTS_KEY,
    queryFn: async () => {
      const res = await authFetch("/api/products");
      if (!res.ok) throw new Error("Yuklashda xato");
      return res.json();
    },
  });
}

function useSetPackerAssignments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      packerName,
      productNames,
    }: {
      packerName: string;
      productNames: string[];
    }) => {
      const res = await authFetch(
        `/api/packer-assignments/${encodeURIComponent(packerName)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productNames }),
        },
      );
      if (!res.ok) throw new Error("Saqlashda xato");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PACKER_ASSIGNMENTS_KEY }),
  });
}

// ── Packer card ───────────────────────────────────────────────────────────────
function PackerCard({
  packer,
  allProducts,
}: {
  packer: Packer;
  allProducts: Product[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    new Set(packer.products.map(p => p.productName)),
  );
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useState("");
  const saveMut = useSetPackerAssignments();

  const initials = packer.packerName
    .split(" ")
    .map(w => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allProducts;
    return allProducts.filter(p => p.name.toLowerCase().includes(q));
  }, [allProducts, search]);

  function toggle(productName: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(productName)) next.delete(productName);
      else next.add(productName);
      return next;
    });
    setDirty(true);
  }

  function handleSave() {
    saveMut.mutate(
      { packerName: packer.packerName, productNames: Array.from(selected) },
      {
        onSuccess: () => setDirty(false),
      },
    );
  }

  const assignedCount = selected.size;

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-4 px-5 py-4 hover:bg-muted/30 transition-colors text-left"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="w-10 h-10 rounded-full bg-[#0B5D2A] flex items-center justify-center text-white font-bold text-sm shrink-0">
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold">{packer.packerName}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {assignedCount} ta mahsulot biriktirilgan
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {assignedCount > 0 && (
            <Badge className="bg-green-100 text-green-700 border border-green-200 hover:bg-green-100 shadow-none text-xs">
              {assignedCount} mahsulot
            </Badge>
          )}
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t px-5 py-4 space-y-3">
          {/* Search bar */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <Input
              placeholder={`${allProducts.length} ta mahsulotda qidirish…`}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-8 h-8 text-sm"
            />
          </div>

          {/* Scroll container — max 420px, scrollable inside */}
          <div className="max-h-[420px] overflow-y-auto rounded-lg border border-border pr-1">
            {filteredProducts.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                <Package className="w-6 h-6 mx-auto mb-1 opacity-30" />
                Mahsulot topilmadi
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 p-2">
                {filteredProducts.map(product => {
                  const checked = selected.has(product.name);
                  return (
                    <label
                      key={product.name}
                      className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                        checked
                          ? "bg-[#0B5D2A]/5 border-[#0B5D2A]/30"
                          : "border-border hover:bg-muted/30"
                      } ${!product.active ? "opacity-50" : ""}`}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggle(product.name)}
                        className={checked ? "data-[state=checked]:bg-[#0B5D2A] data-[state=checked]:border-[#0B5D2A]" : ""}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{product.name}</div>
                        <div className="text-xs text-muted-foreground">{product.unitType}</div>
                      </div>
                      {!product.active && (
                        <Badge variant="secondary" className="text-xs shrink-0">Nofaol</Badge>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between pt-1 border-t">
            <p className="text-xs text-muted-foreground">
              {selected.size} ta tanlangan · {allProducts.length} ta jami
            </p>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!dirty || saveMut.isPending}
              className={dirty ? "" : "opacity-50"}
            >
              <Save className="w-3.5 h-3.5 mr-1.5" />
              {saveMut.isPending ? "Saqlanmoqda..." : "Saqlash"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function Packers() {
  const { data: packers = [], isLoading: packersLoading } = usePackerAssignments();
  const { data: allProducts = [], isLoading: productsLoading } = useAllProducts();

  const isLoading = packersLoading || productsLoading;
  const activeProducts = allProducts.filter(p => p.active);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <HardHat className="w-6 h-6 text-primary" /> Packerlar
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isLoading
            ? "Yuklanmoqda..."
            : `${packers.length} ta packer · ${activeProducts.length} ta mahsulot`}
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="rounded-xl border bg-card p-5">
              <div className="flex items-center gap-4">
                <Skeleton className="w-10 h-10 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : packers.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <HardHat className="w-12 h-12 mx-auto mb-3 opacity-20" />
          <p className="font-medium">Packerlar ro'yxati bo'sh</p>
          <p className="text-sm mt-1">
            Ishchilar sahifasida rol = "packer" ga o'rnating
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {packers.map(packer => (
            <PackerCard
              key={packer.packerName}
              packer={packer}
              allProducts={activeProducts}
            />
          ))}
        </div>
      )}
    </div>
  );
}
