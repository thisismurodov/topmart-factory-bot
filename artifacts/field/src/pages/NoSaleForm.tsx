import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import { useFieldRouteToday } from "@/lib/fieldApi";
import { useOptimisticStatus } from "@/hooks/useOptimisticStatus";
import { enqueueNoSale } from "@/lib/sync";
import { markVisitSaved } from "@/lib/utils";
import { useGps } from "@/hooks/useGps";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft } from "lucide-react";

const SABABLAR = [
  { id: "narx_qimmat", label: "Narx qimmat" },
  { id: "tovari_bor", label: "Hozir tovari bor" },
  { id: "boshqa_firma", label: "Boshqa firma bilan ishlaydi" },
  { id: "sifat", label: "Sifat yoqmadi" },
  { id: "egasi_yoq", label: "Egasi yo'q edi" },
  { id: "keyin_keling", label: "Keyin keling dedi" },
  { id: "sotilmaydi", label: "Sotilmaydi dedi" },
  { id: "boshqa", label: "Boshqa sabab" },
];

export default function NoSaleForm() {
  const [, params] = useRoute("/visit/:id/nosale");
  const [, setLocation] = useLocation();
  const dokonId = parseInt(params?.id || "0", 10);
  
  const { data: route } = useFieldRouteToday();
  const setOptimisticStatus = useOptimisticStatus();
  const { location } = useGps();

  const shop = route?.shops.find(s => s.dokonId === dokonId);

  const [sabab, setSabab] = useState<string>("");
  const [boshqaMatn, setBoshqaMatn] = useState("");
  const [sana, setSana] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async () => {
    if (!sabab || submitted) return;

    setSubmitted(true);

    // Avval IndexedDB'ga yoziladi (offline'da ham), keyin navigatsiya
    await enqueueNoSale({
      clientOpId: crypto.randomUUID(),
      dokonId,
      sabab,
      sababText: sabab === "boshqa" ? boshqaMatn : undefined,
      qaytishSanasi: sana || undefined,
      lat: location?.lat,
      lon: location?.lon,
    });

    setOptimisticStatus(dokonId, "nosale");
    
    if (window.Telegram?.WebApp?.HapticFeedback) {
      window.Telegram.WebApp.HapticFeedback.notificationOccurred("success");
    }

    markVisitSaved();
    setLocation("/map");
  };

  if (!shop) return null;

  return (
    <div className="flex-1 flex flex-col bg-background h-full overflow-y-auto">
      <div className="p-4 border-b bg-card sticky top-0 z-10 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => setLocation(`/visit/${dokonId}`)}>
          <ArrowLeft />
        </Button>
        <div className="flex-1">
          <h2 className="font-bold text-lg leading-tight line-clamp-1">{shop.nomi}</h2>
          <p className="text-xs text-destructive font-medium uppercase">Olinmadi</p>
        </div>
      </div>

      <div className="p-4 flex flex-col flex-1 pb-32">
        <h3 className="font-bold text-lg mb-4">Sababni tanlang</h3>
        
        <div className="grid grid-cols-1 gap-3 mb-6">
          {SABABLAR.map(s => (
            <button
              key={s.id}
              onClick={() => setSabab(s.id)}
              className={`text-left p-4 rounded-xl border-2 transition-colors ${
                sabab === s.id 
                  ? 'border-destructive bg-destructive/10 font-bold' 
                  : 'border-muted bg-card text-muted-foreground font-medium'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {sabab === "boshqa" && (
          <div className="mb-6 animate-in fade-in slide-in-from-top-2">
            <label className="block text-sm font-medium mb-2">Batafsil yozing</label>
            <Textarea 
              value={boshqaMatn}
              onChange={(e) => setBoshqaMatn(e.target.value)}
              placeholder="Sababni kiriting..."
              className="resize-none h-24 text-base"
              maxLength={300}
            />
          </div>
        )}

        <div className="mb-6">
          <label className="block text-sm font-medium mb-2">Qachon qaytaylik? (ixtiyoriy)</label>
          <Input 
            type="date" 
            value={sana}
            onChange={(e) => setSana(e.target.value)}
            className="h-14 text-lg"
          />
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-background/95 backdrop-blur border-t z-20">
        <Button 
          variant="destructive"
          className="w-full h-14 text-lg font-bold shadow-lg shadow-destructive/20" 
          disabled={!sabab || (sabab === "boshqa" && boshqaMatn.trim().length === 0) || submitted}
          onClick={handleSubmit}
        >
          {submitted ? "Saqlanmoqda..." : "SAQLASH"}
        </Button>
      </div>
    </div>
  );
}
