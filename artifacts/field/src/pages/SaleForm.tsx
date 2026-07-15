import { useState, useMemo } from "react";
import { useRoute, useLocation } from "wouter";
import { useFieldRouteToday, useFieldProducts } from "@/lib/fieldApi";
import { useOptimisticStatus } from "@/hooks/useOptimisticStatus";
import { enqueueSale } from "@/lib/sync";
import { formatCurrency, markVisitSaved } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Minus, ArrowLeft, ShoppingCart, Check } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";

export default function SaleForm() {
  const [, params] = useRoute("/visit/:id/sale");
  const [, setLocation] = useLocation();
  const dokonId = parseInt(params?.id || "0", 10);
  
  const { data: route } = useFieldRouteToday();
  const { data: products = [] } = useFieldProducts();
  const setOptimisticStatus = useOptimisticStatus();

  const shop = route?.shops.find(s => s.dokonId === dokonId);

  const [items, setItems] = useState<Record<number, number>>({});
  // "Nasiya savdo" tugmasidan kelinsa (?nasiya=1) — to'lov turi oldindan nasiya
  const [tolovTuri, setTolovTuri] = useState<"naqd" | "karta" | "nasiya" | "aralash">(() => {
    if (typeof window !== "undefined") {
      const qs = new URLSearchParams(window.location.search);
      if (qs.get("nasiya") === "1") return "nasiya";
    }
    return "naqd";
  });
  const [nasiyaQismStr, setNasiyaQismStr] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const selectedItemsList = useMemo(() => {
    return Object.entries(items)
      .filter(([, q]) => q > 0)
      .map(([idStr, q]) => {
        const id = parseInt(idStr, 10);
        const p = products.find(x => x.id === id);
        return {
          mahsulotId: id,
          miqdor: q,
          narx: p?.narx || 0,
          nomi: p?.nomi || "",
        };
      });
  }, [items, products]);

  const jami = useMemo(() => {
    return selectedItemsList.reduce((sum, item) => sum + Math.round(item.narx * item.miqdor), 0);
  }, [selectedItemsList]);

  const updateQuantity = (id: number, delta: number) => {
    setItems(prev => {
      const current = prev[id] || 0;
      const next = Math.max(0, current + delta);
      return { ...prev, [id]: next };
    });
  };

  const setExactQuantity = (id: number, val: string) => {
    const q = parseInt(val, 10) || 0;
    setItems(prev => ({ ...prev, [id]: Math.max(0, q) }));
  };

  const handleSubmit = async () => {
    if (selectedItemsList.length === 0 || submitted) return;
    
    let nasiyaQism: number | undefined = undefined;
    if (tolovTuri === "aralash") {
      nasiyaQism = parseInt(nasiyaQismStr.replace(/\D/g, ""), 10);
      if (isNaN(nasiyaQism) || nasiyaQism <= 0 || nasiyaQism >= jami) {
        alert("Aralash to'lovda nasiya qismi noto'g'ri kiritildi.");
        return;
      }
    }

    setSubmitted(true);

    // Avval IndexedDB'ga yoziladi (offline'da ham), keyin navigatsiya
    await enqueueSale({
      clientOpId: crypto.randomUUID(),
      dokonId,
      tolovTuri,
      items: selectedItemsList.map(x => ({ mahsulotId: x.mahsulotId, miqdor: x.miqdor })),
      nasiyaQism
    });

    setOptimisticStatus(dokonId, "sold");
    
    if (window.Telegram?.WebApp?.HapticFeedback) {
      window.Telegram.WebApp.HapticFeedback.notificationOccurred("success");
    }

    markVisitSaved();
    setLocation("/map");
  };

  if (!shop) return null;

  return (
    <div className="flex-1 flex flex-col bg-background h-full">
      <div className="p-4 border-b bg-card sticky top-0 z-10 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => setLocation(`/visit/${dokonId}`)}>
          <ArrowLeft />
        </Button>
        <div className="flex-1">
          <h2 className="font-bold text-lg leading-tight line-clamp-1">{shop.nomi}</h2>
          <p className="text-xs text-muted-foreground">Savdo</p>
        </div>
        <div className="text-right">
          <div className="font-bold text-primary">{formatCurrency(jami)}</div>
          <div className="text-[10px] text-muted-foreground uppercase">Jami</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 pb-32">
        <div className="space-y-4 mb-8">
          {products.map(p => {
            const q = items[p.id] || 0;
            return (
              <div key={p.id} className={`p-4 border rounded-xl flex flex-col gap-3 transition-colors ${q > 0 ? 'bg-primary/5 border-primary/30' : 'bg-card'}`}>
                <div className="flex justify-between items-start">
                  <div className="font-medium">{p.nomi}</div>
                  <div className="font-bold whitespace-nowrap ml-2">{formatCurrency(p.narx)}</div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground uppercase">{p.birlik}</span>
                  <div className="flex items-center gap-1 bg-muted/50 p-1 rounded-lg">
                    <Button 
                      variant="outline" 
                      size="icon" 
                      className="w-10 h-10 shrink-0 rounded-md" 
                      onClick={() => updateQuantity(p.id, -1)}
                      disabled={q === 0}
                    >
                      <Minus className="w-4 h-4" />
                    </Button>
                    <Input 
                      type="number" 
                      inputMode="numeric"
                      value={q || ""} 
                      onChange={(e) => setExactQuantity(p.id, e.target.value)}
                      className="w-16 h-10 text-center font-bold border-0 bg-transparent text-lg shadow-none focus-visible:ring-0"
                      placeholder="0"
                    />
                    <Button 
                      variant="default" 
                      size="icon" 
                      className="w-10 h-10 shrink-0 rounded-md"
                      onClick={() => updateQuantity(p.id, 1)}
                    >
                      <Plus className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {selectedItemsList.length > 0 && (
          <div className="bg-card border rounded-xl p-5 mb-8">
            <h3 className="font-bold mb-4">To'lov turi</h3>
            <RadioGroup value={tolovTuri} onValueChange={(v: any) => setTolovTuri(v)} className="flex flex-col gap-3">
              <div className="flex items-center space-x-3 bg-muted/30 p-3 rounded-lg">
                <RadioGroupItem value="naqd" id="naqd" />
                <Label htmlFor="naqd" className="flex-1 text-base py-1">Naqd pul</Label>
              </div>
              <div className="flex items-center space-x-3 bg-muted/30 p-3 rounded-lg">
                <RadioGroupItem value="karta" id="karta" />
                <Label htmlFor="karta" className="flex-1 text-base py-1">Plastik karta</Label>
              </div>
              <div className="flex items-center space-x-3 bg-muted/30 p-3 rounded-lg">
                <RadioGroupItem value="nasiya" id="nasiya" />
                <Label htmlFor="nasiya" className="flex-1 text-base py-1">Nasiya (Qarz)</Label>
              </div>
              <div className="flex items-center space-x-3 bg-muted/30 p-3 rounded-lg">
                <RadioGroupItem value="aralash" id="aralash" />
                <Label htmlFor="aralash" className="flex-1 text-base py-1">Aralash</Label>
              </div>
            </RadioGroup>

            {tolovTuri === "aralash" && (
              <div className="mt-4 pt-4 border-t">
                <Label className="mb-2 block">Nasiya qismi (so'm)</Label>
                <Input 
                  type="text" 
                  inputMode="numeric"
                  value={nasiyaQismStr}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/\D/g, "");
                    setNasiyaQismStr(raw ? formatCurrency(parseInt(raw, 10)) : "");
                  }}
                  className="h-14 text-lg font-bold"
                  placeholder="Masalan: 500 000"
                />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="absolute bottom-0 left-0 right-0 p-4 bg-background/95 backdrop-blur border-t z-20">
        <Button 
          className="w-full h-14 text-lg font-bold" 
          disabled={selectedItemsList.length === 0 || submitted}
          onClick={handleSubmit}
        >
          {submitted ? "Saqlanmoqda..." : selectedItemsList.length === 0 ? "Mahsulot tanlang" : "SAQLASH"}
        </Button>
      </div>
    </div>
  );
}
