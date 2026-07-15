// T008 — Do'kon bo'yicha suzuvchi bottom sheet: yarim/to'liq ekran.
// Tarkib: do'kon ma'lumoti, reyting, nasiya, top mahsulot, AI tavsiyalar,
// oxirgi savdolar va olinmadi tarixi.

import { useState } from "react";
import { useLocation } from "wouter";
import { useFieldShopDetail } from "@/lib/fieldApi";
import { formatCurrency } from "@/lib/utils";
import RatingStars from "@/components/RatingStars";
import { Button } from "@/components/ui/button";
import { Phone, Store, X, ChevronUp, ChevronDown, Sparkles, TrendingUp } from "lucide-react";

type ShopSheetProps = {
  dokonId: number | null;
  onClose: () => void;
};

const SABAB_LABELS: Record<string, string> = {
  narx_qimmat: "Narx qimmat",
  tovari_bor: "Hozir tovari bor",
  boshqa_firma: "Boshqa firma bilan ishlaydi",
  sifat: "Sifat yoqmadi",
  egasi_yoq: "Egasi yo'q edi",
  keyin_keling: "Keyin keling dedi",
  sotilmaydi: "Sotilmaydi dedi",
  boshqa: "Boshqa sabab",
};

function fmtSana(iso: string): string {
  return iso ? iso.slice(0, 10) : "";
}

export default function ShopSheet({ dokonId, onClose }: ShopSheetProps) {
  const [, setLocation] = useLocation();
  const [full, setFull] = useState(false);
  const { data, isLoading } = useFieldShopDetail(dokonId);

  if (dokonId == null) return null;

  return (
    <div className="absolute inset-0 z-[600]">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className={`absolute left-0 right-0 bottom-0 bg-card rounded-t-3xl shadow-2xl border-t flex flex-col transition-[height] duration-300 ease-out ${
          full ? "h-[92%]" : "h-[55%]"
        }`}
      >
        {/* Drag handle + controls */}
        <div className="flex items-center justify-between px-4 pt-3 pb-1 shrink-0">
          <button
            type="button"
            className="p-2 -m-1 text-muted-foreground"
            onClick={() => setFull((f) => !f)}
            aria-label={full ? "Kichraytirish" : "Kattalashtirish"}
          >
            {full ? <ChevronDown className="w-5 h-5" /> : <ChevronUp className="w-5 h-5" />}
          </button>
          <div className="w-12 h-1.5 bg-muted rounded-full" onClick={() => setFull((f) => !f)} />
          <button type="button" className="p-2 -m-1 text-muted-foreground" onClick={onClose} aria-label="Yopish">
            <X className="w-5 h-5" />
          </button>
        </div>

        {isLoading || !data ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            Yuklanmoqda...
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 pb-8">
            {/* Sarlavha */}
            <div className="flex items-start gap-3 mb-4">
              <div className="w-12 h-12 bg-primary/10 text-primary rounded-xl flex items-center justify-center shrink-0">
                <Store className="w-6 h-6" />
              </div>
              <div className="min-w-0">
                <h2 className="text-xl font-bold leading-tight line-clamp-2">{data.dokon.nomi}</h2>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <RatingStars rating={data.dokon.rating} className="text-base" />
                  {data.dokon.daysSinceVisit !== null && (
                    <span>• {data.dokon.daysSinceVisit} kun oldin</span>
                  )}
                </div>
              </div>
            </div>

            {/* Tez ko'rsatkichlar */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="bg-muted/40 rounded-xl p-3">
                <div className="text-xs text-muted-foreground mb-1">Jami savdo</div>
                <div className="font-bold">{formatCurrency(data.dokon.totalSales)} so'm</div>
              </div>
              <div className="bg-muted/40 rounded-xl p-3">
                <div className="text-xs text-muted-foreground mb-1">Buyurtmalar</div>
                <div className="font-bold">{data.dokon.totalOrders} ta</div>
              </div>
              <div className={`rounded-xl p-3 ${data.nasiyaQoldiq > 0 ? "bg-red-500/10" : "bg-muted/40"}`}>
                <div className="text-xs text-muted-foreground mb-1">Nasiya qoldiq</div>
                <div className={`font-bold ${data.nasiyaQoldiq > 0 ? "text-red-600" : ""}`}>
                  {formatCurrency(data.nasiyaQoldiq)} so'm
                </div>
              </div>
              <div className={`rounded-xl p-3 ${data.balans > 0 ? "bg-green-500/10" : "bg-muted/40"}`}>
                <div className="text-xs text-muted-foreground mb-1">Balans (avans)</div>
                <div className={`font-bold ${data.balans > 0 ? "text-green-600" : ""}`}>
                  {formatCurrency(data.balans)} so'm
                </div>
              </div>
            </div>

            {/* AI tavsiyalar */}
            {data.tavsiyalar.length > 0 && (
              <div className="bg-violet-500/10 border border-violet-500/20 rounded-xl p-4 mb-4">
                <div className="flex items-center gap-2 font-semibold text-violet-700 dark:text-violet-300 mb-2">
                  <Sparkles className="w-4 h-4" /> Tavsiyalar
                </div>
                <ul className="space-y-1.5 text-sm">
                  {data.tavsiyalar.map((t, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-violet-500 shrink-0">•</span>
                      <span>{t}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {data.topProduct && (
              <div className="flex items-center gap-2 text-sm bg-muted/40 rounded-xl p-3 mb-4">
                <TrendingUp className="w-4 h-4 text-primary shrink-0" />
                <span>
                  Eng ko'p oladi: <b>{data.topProduct}</b>
                </span>
              </div>
            )}

            {/* Amallar */}
            <div className="flex gap-3 mb-5">
              <Button
                className="flex-1 h-12 font-bold"
                onClick={() => setLocation(`/visit/${data.dokon.id}`)}
              >
                TASHRIF
              </Button>
              {data.dokon.telefon && (
                <Button
                  variant="outline"
                  className="h-12 px-4"
                  onClick={() => (window.location.href = `tel:${data.dokon.telefon}`)}
                >
                  <Phone className="w-5 h-5" />
                </Button>
              )}
            </div>

            {/* Tarix */}
            <h3 className="font-bold mb-2">Oxirgi savdolar</h3>
            {data.savdolar.length === 0 ? (
              <p className="text-sm text-muted-foreground mb-4">Savdolar yo'q</p>
            ) : (
              <div className="space-y-2 mb-4">
                {data.savdolar.map((s) => (
                  <div key={s.id} className="border rounded-xl p-3">
                    <div className="flex justify-between items-center mb-1">
                      <span className="font-bold">{formatCurrency(s.summa)} so'm</span>
                      <span className="text-xs text-muted-foreground">{fmtSana(s.sana)}</span>
                    </div>
                    <div className="flex justify-between items-center gap-2">
                      <span className="text-xs text-muted-foreground line-clamp-1">{s.items}</span>
                      <span className="text-xs font-medium uppercase shrink-0">{s.tolovTuri}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {data.olinmadi.length > 0 && (
              <>
                <h3 className="font-bold mb-2">Olinmadi tarixi</h3>
                <div className="space-y-2">
                  {data.olinmadi.map((n, i) => (
                    <div key={i} className="border border-red-500/20 bg-red-500/5 rounded-xl p-3">
                      <div className="flex justify-between items-center">
                        <span className="text-sm font-medium">
                          {SABAB_LABELS[n.sabab] || n.sabab}
                          {n.sababText ? ` — ${n.sababText}` : ""}
                        </span>
                        <span className="text-xs text-muted-foreground shrink-0 ml-2">{fmtSana(n.sana)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
