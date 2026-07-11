import { useRoute, useLocation } from "wouter";
import { useFieldRouteToday } from "@/lib/fieldApi";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, Store, ArrowLeft } from "lucide-react";

export default function VisitScreen() {
  const [, params] = useRoute("/visit/:id");
  const [, setLocation] = useLocation();
  const { data: route } = useFieldRouteToday();

  const dokonId = parseInt(params?.id || "0", 10);
  const shop = route?.shops.find(s => s.dokonId === dokonId);

  if (!shop) {
    return <div className="p-6 text-center">Do'kon topilmadi</div>;
  }

  return (
    <div className="flex-1 flex flex-col p-6 bg-background">
      <div className="mb-8">
        <Button variant="ghost" size="icon" onClick={() => setLocation("/map")} className="mb-4">
          <ArrowLeft className="w-6 h-6" />
        </Button>
        <div className="w-16 h-16 bg-primary/10 text-primary rounded-2xl flex items-center justify-center mb-4">
          <Store className="w-8 h-8" />
        </div>
        <h1 className="text-4xl font-bold mb-2">{shop.nomi}</h1>
        <p className="text-muted-foreground text-lg">{shop.egasi} • {shop.telefon}</p>
      </div>

      <div className="flex-1 flex flex-col justify-center gap-6 pb-12">
        <Button 
          className="w-full h-32 text-2xl font-bold rounded-2xl bg-green-600 hover:bg-green-700 shadow-xl shadow-green-600/20"
          onClick={() => setLocation(`/visit/${shop.dokonId}/sale`)}
        >
          <CheckCircle2 className="mr-3 w-10 h-10" />
          SAVDO BO'LDI
        </Button>

        <Button 
          variant="destructive"
          className="w-full h-32 text-2xl font-bold rounded-2xl shadow-xl shadow-red-600/20"
          onClick={() => setLocation(`/visit/${shop.dokonId}/nosale`)}
        >
          <XCircle className="mr-3 w-10 h-10" />
          OLINMADI
        </Button>
      </div>
    </div>
  );
}
