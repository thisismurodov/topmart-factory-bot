// T006 — "To'lov" (pul olish): nasiya bo'lsa FIFO bo'yicha yopiladi,
// ortiqcha summa do'kon balansiga o'tadi (server performFieldPayment).
// Offline navbat orqali yuboriladi (idempotent clientOpId).

import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import { useFieldRouteToday, useFieldShopDetail } from "@/lib/fieldApi";
import { enqueuePayment } from "@/lib/sync";
import { formatCurrency, markVisitSaved } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Banknote } from "lucide-react";

export default function PaymentForm() {
  const [, params] = useRoute("/visit/:id/payment");
  const [, setLocation] = useLocation();
  const dokonId = parseInt(params?.id || "0", 10);

  const { data: route } = useFieldRouteToday();
  const { data: detail } = useFieldShopDetail(dokonId);

  const shop = route?.shops.find((s) => s.dokonId === dokonId);

  const [summaStr, setSummaStr] = useState("");
  const [nasiyaga, setNasiyaga] = useState(true);
  const [submitted, setSubmitted] = useState(false);

  const summa = parseInt(summaStr.replace(/\D/g, ""), 10) || 0;
  const nasiyaQoldiq = detail?.nasiyaQoldiq ?? null;

  const handleSubmit = () => {
    if (summa <= 0 || submitted) return;
    setSubmitted(true);

    enqueuePayment({
      clientOpId: crypto.randomUUID(),
      dokonId,
      summa,
      nasiyagaHisoblash: nasiyaga,
    });

    if (window.Telegram?.WebApp?.HapticFeedback) {
      window.Telegram.WebApp.HapticFeedback.notificationOccurred("success");
    }

    markVisitSaved();
    setLocation("/map");
  };

  if (!shop) {
    return (
      <div className="flex-1 flex items-center justify-center py-20">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-background h-full overflow-y-auto">
      <div className="p-4 border-b bg-card sticky top-0 z-10 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => setLocation(`/visit/${dokonId}`)}>
          <ArrowLeft />
        </Button>
        <div className="flex-1">
          <h2 className="font-bold text-lg leading-tight line-clamp-1">{shop.nomi}</h2>
          <p className="text-xs text-blue-600 font-medium uppercase">Pul olish</p>
        </div>
      </div>

      <div className="p-5 flex flex-col flex-1 pb-32">
        {nasiyaQoldiq !== null && nasiyaQoldiq > 0 && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6">
            <div className="text-sm text-muted-foreground mb-1">Nasiya qoldig'i</div>
            <div className="text-2xl font-black text-red-600">
              {formatCurrency(nasiyaQoldiq)} so'm
            </div>
          </div>
        )}

        <Label className="mb-2 block font-semibold">Olingan summa (so'm)</Label>
        <Input
          type="text"
          inputMode="numeric"
          autoFocus
          value={summaStr}
          onChange={(e) => {
            const raw = e.target.value.replace(/\D/g, "");
            setSummaStr(raw ? formatCurrency(parseInt(raw, 10)) : "");
          }}
          className="h-16 text-2xl font-bold mb-4"
          placeholder="Masalan: 300 000"
        />

        {/* Tez tanlash */}
        <div className="grid grid-cols-3 gap-2 mb-6">
          {[100_000, 200_000, 500_000].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setSummaStr(formatCurrency(v))}
              className="h-11 rounded-xl border bg-card text-sm font-semibold active:bg-muted"
            >
              {formatCurrency(v)}
            </button>
          ))}
          {nasiyaQoldiq !== null && nasiyaQoldiq > 0 && (
            <button
              type="button"
              onClick={() => setSummaStr(formatCurrency(nasiyaQoldiq))}
              className="col-span-3 h-11 rounded-xl border border-red-500/40 bg-red-500/5 text-sm font-bold text-red-600 active:bg-red-500/10"
            >
              To'liq qoldiq: {formatCurrency(nasiyaQoldiq)}
            </button>
          )}
        </div>

        <div className="flex items-center justify-between bg-muted/30 rounded-xl p-4 mb-4">
          <div className="pr-3">
            <Label htmlFor="nasiyaga" className="font-semibold block mb-1">
              Nasiyani yopishga hisoblash
            </Label>
            <p className="text-xs text-muted-foreground">
              Eng eski qarzdan boshlab yopiladi. Ortiqcha summa do'kon balansiga o'tadi.
            </p>
          </div>
          <Switch id="nasiyaga" checked={nasiyaga} onCheckedChange={setNasiyaga} />
        </div>

        {nasiyaga && summa > 0 && nasiyaQoldiq !== null && (
          <div className="text-sm text-muted-foreground bg-muted/30 rounded-xl p-3">
            {summa >= nasiyaQoldiq && nasiyaQoldiq > 0 ? (
              <>
                Nasiya to'liq yopiladi
                {summa > nasiyaQoldiq && (
                  <>
                    , <b className="text-green-600">{formatCurrency(summa - nasiyaQoldiq)} so'm</b> balansga o'tadi
                  </>
                )}
                .
              </>
            ) : nasiyaQoldiq > 0 ? (
              <>
                Qoldiq: <b>{formatCurrency(nasiyaQoldiq - summa)} so'm</b> bo'lib qoladi.
              </>
            ) : (
              <>Nasiya yo'q — butun summa balansga o'tadi.</>
            )}
          </div>
        )}
      </div>

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-background/95 backdrop-blur border-t z-20 max-w-md mx-auto">
        <Button
          className="w-full h-14 text-lg font-bold bg-blue-600 hover:bg-blue-700"
          disabled={summa <= 0 || submitted}
          onClick={handleSubmit}
        >
          <Banknote className="mr-2" />
          {submitted ? "Saqlanmoqda..." : summa > 0 ? `${formatCurrency(summa)} SO'M OLINDI` : "Summani kiriting"}
        </Button>
      </div>
    </div>
  );
}
