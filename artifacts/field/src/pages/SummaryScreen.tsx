import { useFieldSummaryToday } from "@/lib/fieldApi";
import { formatCurrency } from "@/lib/utils";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowLeft, MapPin, Clock, Target, CheckCircle2, XCircle } from "lucide-react";

export default function SummaryScreen() {
  const { data: summary, isLoading } = useFieldSummaryToday();
  const [, setLocation] = useLocation();

  if (isLoading || !summary) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-4 border-primary border-r-4 border-r-transparent"></div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-background">
      <div className="p-4 border-b bg-card sticky top-0 z-10 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => setLocation("/map")}>
          <ArrowLeft />
        </Button>
        <h2 className="font-bold text-lg flex-1">Kunlik Hisobot</h2>
      </div>

      <div className="p-6 flex-1 flex flex-col">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center p-3 bg-primary/10 text-primary rounded-2xl mb-4">
            <CheckCircle2 className="w-10 h-10" />
          </div>
          <h1 className="text-3xl font-bold mb-2">Natija</h1>
          <p className="text-muted-foreground">{summary.sana}</p>
        </div>

        <div className="bg-primary/5 border border-primary/20 rounded-2xl p-6 flex flex-col items-center justify-center mb-6">
          <p className="text-sm font-medium text-primary uppercase tracking-wider mb-2">Jami Savdo</p>
          <p className="text-4xl font-black text-primary">{formatCurrency(summary.savdoSumma)}</p>
          <p className="text-primary/70 mt-1">so'm</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="bg-card border rounded-xl p-5 flex flex-col">
            <CheckCircle2 className="w-6 h-6 text-green-500 mb-2" />
            <div className="text-3xl font-bold text-green-600 mb-1">{summary.savdolar}</div>
            <div className="text-sm text-muted-foreground font-medium">Savdo</div>
          </div>
          
          <div className="bg-card border rounded-xl p-5 flex flex-col">
            <XCircle className="w-6 h-6 text-red-500 mb-2" />
            <div className="text-3xl font-bold text-red-600 mb-1">{summary.olinmadi}</div>
            <div className="text-sm text-muted-foreground font-medium">Olinmadi</div>
          </div>

          <div className="bg-card border rounded-xl p-5 flex flex-col">
            <MapPin className="w-6 h-6 text-blue-500 mb-2" />
            <div className="text-3xl font-bold mb-1">{summary.km}</div>
            <div className="text-sm text-muted-foreground font-medium">Kilometr</div>
          </div>

          <div className="bg-card border rounded-xl p-5 flex flex-col">
            <Clock className="w-6 h-6 text-amber-500 mb-2" />
            <div className="text-3xl font-bold mb-1">{Math.floor(summary.daqiqa / 60)}s {summary.daqiqa % 60}m</div>
            <div className="text-sm text-muted-foreground font-medium">Vaqt</div>
          </div>
        </div>
      </div>
    </div>
  );
}
