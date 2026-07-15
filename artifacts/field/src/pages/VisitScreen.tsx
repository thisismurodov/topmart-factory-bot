// T006 — Tashrif ekrani: 6 ta katta tugma, bitta bosishda amal.
// Savdo / Olinmadi / To'lov / Nasiya / Yangi do'kon / Qo'ng'iroq.

import { useRoute, useLocation } from "wouter";
import { useFieldRouteToday } from "@/lib/fieldApi";
import { Button } from "@/components/ui/button";
import RatingStars from "@/components/RatingStars";
import { formatCurrency } from "@/lib/utils";
import {
  CheckCircle2,
  XCircle,
  Store,
  ArrowLeft,
  Banknote,
  CreditCard,
  Phone,
  PlusCircle,
} from "lucide-react";

export default function VisitScreen() {
  const [, params] = useRoute("/visit/:id");
  const [, setLocation] = useLocation();
  const { data: route } = useFieldRouteToday();

  const dokonId = parseInt(params?.id || "0", 10);
  const shop = route?.shops.find((s) => s.dokonId === dokonId);

  if (!shop) {
    return <div className="p-6 text-center">Do'kon topilmadi</div>;
  }

  return (
    <div className="flex-1 flex flex-col p-5 bg-background overflow-y-auto">
      <div className="mb-6">
        <Button variant="ghost" size="icon" onClick={() => setLocation("/map")} className="mb-3 -ml-2">
          <ArrowLeft className="w-6 h-6" />
        </Button>
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 bg-primary/10 text-primary rounded-2xl flex items-center justify-center shrink-0">
            <Store className="w-7 h-7" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold leading-tight mb-1 line-clamp-2">{shop.nomi}</h1>
            <p className="text-muted-foreground text-sm mb-1">
              {shop.egasi}
              {shop.telefon ? ` • ${shop.telefon}` : ""}
            </p>
            <div className="flex items-center gap-2 text-sm">
              <RatingStars rating={shop.rating} />
              {shop.daysSinceVisit !== null && (
                <span className="text-muted-foreground">• {shop.daysSinceVisit} kun oldin</span>
              )}
            </div>
            {shop.lastPurchase !== null && shop.lastPurchase > 0 && (
              <p className="text-sm mt-1">
                Oxirgi xarid: <b>{formatCurrency(shop.lastPurchase)} so'm</b>
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 grid grid-cols-2 gap-3 content-start pb-6">
        <Button
          className="h-28 flex-col gap-2 text-base font-bold rounded-2xl bg-green-600 hover:bg-green-700 shadow-lg shadow-green-600/20 col-span-2"
          onClick={() => setLocation(`/visit/${shop.dokonId}/sale`)}
        >
          <CheckCircle2 className="w-8 h-8" />
          SAVDO BO'LDI
        </Button>

        <Button
          variant="destructive"
          className="h-24 flex-col gap-2 text-sm font-bold rounded-2xl shadow-lg shadow-red-600/15"
          onClick={() => setLocation(`/visit/${shop.dokonId}/nosale`)}
        >
          <XCircle className="w-7 h-7" />
          OLINMADI
        </Button>

        <Button
          className="h-24 flex-col gap-2 text-sm font-bold rounded-2xl bg-blue-600 hover:bg-blue-700 shadow-lg shadow-blue-600/15"
          onClick={() => setLocation(`/visit/${shop.dokonId}/payment`)}
        >
          <Banknote className="w-7 h-7" />
          PUL OLISH
        </Button>

        <Button
          className="h-24 flex-col gap-2 text-sm font-bold rounded-2xl bg-amber-500 hover:bg-amber-600 text-white shadow-lg shadow-amber-500/15"
          onClick={() => setLocation(`/visit/${shop.dokonId}/sale?nasiya=1`)}
        >
          <CreditCard className="w-7 h-7" />
          NASIYA SAVDO
        </Button>

        <Button
          className="h-24 flex-col gap-2 text-sm font-bold rounded-2xl bg-violet-600 hover:bg-violet-700 shadow-lg shadow-violet-600/15"
          onClick={() => setLocation("/shop/new")}
        >
          <PlusCircle className="w-7 h-7" />
          YANGI DO'KON
        </Button>

        {shop.telefon && (
          <Button
            variant="outline"
            className="h-16 rounded-2xl text-base font-bold col-span-2"
            onClick={() => (window.location.href = `tel:${shop.telefon}`)}
          >
            <Phone className="mr-2 w-5 h-5" />
            EGASIGA QO'NG'IROQ
          </Button>
        )}
      </div>
    </div>
  );
}
