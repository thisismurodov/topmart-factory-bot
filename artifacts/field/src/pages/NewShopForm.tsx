// T006 — "Yangi do'kon": agent yo'lda yangi do'kon qo'shadi.
// GPS avtomatik olinadi; server bugungi marshrutga (limit 5 tagacha)
// avtomatik qo'shadi. Offline navbat orqali yuboriladi.

import { useState } from "react";
import { useLocation } from "wouter";
import { enqueueNewShop } from "@/lib/sync";
import { useGps } from "@/hooks/useGps";
import { markVisitSaved } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, MapPin, Store } from "lucide-react";

export default function NewShopForm() {
  const [, setLocation] = useLocation();
  const { location } = useGps();

  const [nomi, setNomi] = useState("");
  const [egasi, setEgasi] = useState("");
  const [telefon, setTelefon] = useState("");
  const [hudud, setHudud] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async () => {
    if (nomi.trim().length < 2 || submitted) return;
    setSubmitted(true);

    // Avval IndexedDB'ga yoziladi (offline'da ham), keyin navigatsiya
    await enqueueNewShop({
      clientOpId: crypto.randomUUID(),
      nomi: nomi.trim(),
      egasi: egasi.trim() || undefined,
      telefon: telefon.trim() || undefined,
      hudud: hudud.trim() || undefined,
      lat: location?.lat ?? null,
      lon: location?.lon ?? null,
    });

    if (window.Telegram?.WebApp?.HapticFeedback) {
      window.Telegram.WebApp.HapticFeedback.notificationOccurred("success");
    }

    markVisitSaved();
    setLocation("/map");
  };

  return (
    <div className="flex-1 flex flex-col bg-background h-full overflow-y-auto">
      <div className="p-4 border-b bg-card sticky top-0 z-10 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => setLocation("/map")}>
          <ArrowLeft />
        </Button>
        <div className="flex-1">
          <h2 className="font-bold text-lg leading-tight">Yangi do'kon</h2>
          <p className="text-xs text-violet-600 font-medium uppercase">Ro'yxatga olish</p>
        </div>
        <Store className="w-6 h-6 text-violet-500" />
      </div>

      <div className="p-5 flex flex-col flex-1 pb-32 gap-4">
        <div>
          <Label className="mb-2 block font-semibold">Do'kon nomi *</Label>
          <Input
            value={nomi}
            onChange={(e) => setNomi(e.target.value)}
            className="h-14 text-lg"
            placeholder="Masalan: Bek market"
            autoFocus
            maxLength={120}
          />
        </div>

        <div>
          <Label className="mb-2 block font-semibold">Egasining ismi</Label>
          <Input
            value={egasi}
            onChange={(e) => setEgasi(e.target.value)}
            className="h-14 text-lg"
            placeholder="Ism"
            maxLength={80}
          />
        </div>

        <div>
          <Label className="mb-2 block font-semibold">Telefon</Label>
          <Input
            type="tel"
            inputMode="tel"
            value={telefon}
            onChange={(e) => setTelefon(e.target.value)}
            className="h-14 text-lg"
            placeholder="+998 90 123 45 67"
            maxLength={20}
          />
        </div>

        <div>
          <Label className="mb-2 block font-semibold">Hudud / mo'ljal</Label>
          <Input
            value={hudud}
            onChange={(e) => setHudud(e.target.value)}
            className="h-14 text-lg"
            placeholder="Masalan: Chorsu bozori yoni"
            maxLength={120}
          />
        </div>

        <div
          className={`flex items-center gap-3 rounded-xl p-4 border ${
            location ? "bg-green-500/10 border-green-500/30" : "bg-amber-500/10 border-amber-500/30"
          }`}
        >
          <MapPin className={`w-6 h-6 shrink-0 ${location ? "text-green-600" : "text-amber-600"}`} />
          <div className="text-sm">
            {location ? (
              <>
                <b>GPS olindi</b> — do'kon joylashuvi avtomatik saqlanadi
              </>
            ) : (
              <>GPS kutilmoqda... (joylashuvsiz ham saqlash mumkin)</>
            )}
          </div>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-background/95 backdrop-blur border-t z-20 max-w-md mx-auto">
        <Button
          className="w-full h-14 text-lg font-bold bg-violet-600 hover:bg-violet-700"
          disabled={nomi.trim().length < 2 || submitted}
          onClick={handleSubmit}
        >
          {submitted ? "Saqlanmoqda..." : "DO'KONNI SAQLASH"}
        </Button>
      </div>
    </div>
  );
}
