import { useFieldMe, useFieldRouteToday } from "@/lib/fieldApi";
import { formatCurrency } from "@/lib/utils";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { CheckCircle, Clock, MapPin, Target } from "lucide-react";

export default function StartScreen() {
  const { data: me } = useFieldMe();
  const { data: route, isLoading } = useFieldRouteToday();
  const [, setLocation] = useLocation();

  if (isLoading || !me || !route) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-pulse flex flex-col items-center gap-4">
          <div className="w-16 h-16 bg-muted rounded-full"></div>
          <div className="w-32 h-4 bg-muted rounded"></div>
        </div>
      </div>
    );
  }

  if (route.dam) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <div className="w-24 h-24 bg-green-100 text-green-600 rounded-full flex items-center justify-center mb-6">
          <CheckCircle className="w-12 h-12" />
        </div>
        <h1 className="text-3xl font-bold mb-2">Dam olish kuni</h1>
        <p className="text-muted-foreground text-lg">
          Bugun ({route.sana}) dam olish kuni. Yaxshi dam oling, {me.agent.name}!
        </p>
      </div>
    );
  }

  const { stats } = route;

  return (
    <div className="flex-1 flex flex-col p-6">
      <div className="mt-8 mb-10">
        <h1 className="text-3xl font-bold tracking-tight mb-2">
          Assalomu alaykum,<br />
          <span className="text-primary">{me.agent.name}</span>
        </h1>
        <p className="text-muted-foreground text-lg">Bugungi marshrut tayyor</p>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-auto">
        <div className="bg-card border rounded-xl p-4 flex flex-col">
          <div className="text-muted-foreground flex items-center gap-2 mb-2 font-medium">
            <MapPin className="w-5 h-5 text-blue-500" /> Jami
          </div>
          <div className="text-3xl font-bold">{stats.total}</div>
        </div>

        <div className="bg-card border rounded-xl p-4 flex flex-col">
          <div className="text-muted-foreground flex items-center gap-2 mb-2 font-medium">
            <Clock className="w-5 h-5 text-amber-500" /> Kutilmoqda
          </div>
          <div className="text-3xl font-bold text-amber-600">{stats.pending}</div>
        </div>

        <div className="bg-card border rounded-xl p-4 flex flex-col">
          <div className="text-muted-foreground flex items-center gap-2 mb-2 font-medium">
            <CheckCircle className="w-5 h-5 text-green-500" /> Yakunlandi
          </div>
          <div className="text-3xl font-bold text-green-600">{stats.done}</div>
        </div>

        <div className="bg-card border rounded-xl p-4 flex flex-col">
          <div className="text-muted-foreground flex items-center gap-2 mb-2 font-medium">
            <Target className="w-5 h-5 text-primary" /> Savdo
          </div>
          <div className="text-3xl font-bold text-primary">{stats.sold}</div>
        </div>

        <div className="col-span-2 bg-primary/5 border border-primary/20 rounded-xl p-5 flex flex-col">
          <div className="text-primary flex items-center gap-2 mb-2 font-medium">
            Summa
          </div>
          <div className="text-4xl font-bold text-primary">{formatCurrency(stats.savdoSumma)} so'm</div>
        </div>
      </div>

      <div className="mt-8">
        <Button 
          size="lg" 
          className="w-full text-xl h-16 rounded-xl shadow-lg"
          onClick={() => setLocation("/map")}
        >
          BOSHLASH
        </Button>
      </div>
    </div>
  );
}
