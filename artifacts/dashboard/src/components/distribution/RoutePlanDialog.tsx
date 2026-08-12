import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "@/App";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sparkles, Loader2, AlertTriangle, MapPin, TrendingUp } from "lucide-react";

// AI marshrut rejalashtirish dialogi: viloyat + agent tanlanadi, avval reja
// ko'rib chiqiladi (dry-run), keyin "Saqlash" bosilganda delivery_routes ga yoziladi.
// Biznes ustuvorligi: nasiya (qarz), savdo hajmi va oxirgi tashrifdan o'tgan kunlar
// asosida eng muhim do'konlar haftaning boshiga va kun boshiga joylashtiriladi.

type PlanAgent = { id: number; name: string | null; mashinaNomeri: string | null };

type RouteBizSummary = {
  avgBizScore: number;
  highPriorityCount: number;
  totalCreditBalance: number;
};

type PlanRoute = {
  kun: number;
  stats: {
    shopCount: number;
    totalKm: number;
    driveMinutes: number;
    visitMinutes: number;
    totalMinutes: number;
    crossCount: number;
    backtrackPct: number;
    longJumps: number;
    avgHopKm: number;
    maxHopKm: number;
    efficiency: number;
    score: number;
    startShop: string | null;
    endShop: string | null;
  };
  bizSummary?: RouteBizSummary;
  stops: {
    tartib: number;
    dokonId: number;
    nomi: string | null;
    hudud: string | null;
    bizScore?: number;
    bizReasons?: string[];
  }[];
};

type PlanResult = {
  viloyat: string;
  agentId: number;
  agentName: string | null;
  saved: boolean;
  forceSaved?: boolean; // crossing ogohlantirishiga qaramay majburiy saqlandi
  existing: number;
  totalShops: number;
  totalKm: number;
  avgScore: number;
  businessPriorityActive?: boolean;
  validation?: { ok: boolean; issues: string[]; warnings: string[] };
  skippedNoCoord: { id: number; nomi: string | null }[];
  badCoord: { id: number; nomi: string | null; hudud: string | null; lat: number; lng: number }[];
  routes: PlanRoute[];
};

const KUNLAR = ["dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba", "yakshanba"];

// Biznes ustuvorlik presetlari: nasiya / tashrif oralig'i / savdo vaznlari (jami 100)
type BizPreset = {
  id: string;
  label: string;
  desc: string;
  weights: { credit: number; days: number; sales: number };
};

const BIZ_PRESETS: BizPreset[] = [
  {
    id: "muvozanatli",
    label: "Muvozanatli",
    desc: "Nasiya 40% · Tashrif 35% · Savdo 25%",
    weights: { credit: 40, days: 35, sales: 25 },
  },
  {
    id: "nasiya",
    label: "Nasiya yig'ish",
    desc: "Nasiya 60% · Tashrif 20% · Savdo 20%",
    weights: { credit: 60, days: 20, sales: 20 },
  },
  {
    id: "faollashtirish",
    label: "Faollashtirish",
    desc: "Tashrif 55% · Nasiya 20% · Savdo 25%",
    weights: { credit: 20, days: 55, sales: 25 },
  },
];

function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}s ${m}d` : `${m}d`;
}

function fmtMln(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${Math.round(amount / 1_000)}K`;
  return `${Math.round(amount)}`;
}

function scoreColor(score: number): string {
  if (score >= 80) return "text-green-600";
  if (score >= 50) return "text-amber-600";
  return "text-red-600";
}

function bizScoreColor(score: number): string {
  if (score >= 70) return "text-red-600";
  if (score >= 40) return "text-amber-600";
  return "text-slate-400";
}

export default function RoutePlanDialog({ agents }: { agents: PlanAgent[] }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [viloyat, setViloyat] = useState("");
  const [agentId, setAgentId] = useState("");
  const [presetId, setPresetId] = useState("muvozanatli");
  // Reja tuzilgan paytdagi preset — banner shu nomni ko'rsatadi (keyin picker o'zgarsa ham)
  const [planPreset, setPlanPreset] = useState<BizPreset | null>(null);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [phase, setPhase] = useState<"idle" | "planning" | "saving" | "force-saving">("idle");
  const [error, setError] = useState<string | null>(null);
  // 422 kelganda va barcha xatolar faqat crossing bilan bog'liq bo'lsa true —
  // "Baribir saqlash" tugmasi ko'rsatiladi
  const [forceable, setForceable] = useState(false);

  const { data: dict } = useQuery<{ viloyatlar: string[] }>({
    queryKey: ["distribution", "filters"],
    queryFn: async () => {
      const r = await authFetch("/api/distribution/filters");
      if (!r.ok) throw new Error("Filtrlar yuklanmadi");
      return r.json();
    },
    enabled: open,
  });

  const run = async (save: boolean, force = false) => {
    if (!viloyat || !agentId) return;
    setPhase(save ? (force ? "force-saving" : "saving") : "planning");
    setError(null);
    setForceable(false);
    try {
      const r = await authFetch("/api/distribution/route-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          viloyat,
          agentId: Number(agentId),
          weights: (BIZ_PRESETS.find((p) => p.id === presetId) ?? BIZ_PRESETS[0]).weights,
          save,
          // Foydalanuvchi rejani ko'rib bo'lgach saqlaydi — eski marshrut almashtiriladi
          replace: save,
          force,
        }),
      });
      const j = (await r.json()) as PlanResult & { error?: string; forceable?: boolean };
      if (!r.ok) {
        setError(j.error || "Xatolik yuz berdi");
        // 422 va barcha xatolar crossing bilan bog'liq bo'lsa — force bilan saqlash taklif qilinadi.
        // Mavjud plan (dry-run dan) o'zgarmaydi — faqat forceable bayroqi o'rnatiladi,
        // shunda routes/badCoord/skippedNoCoord render xatosiz ishlaydi.
        if (r.status === 422 && j.forceable) {
          setForceable(true);
          // plan state saqlanadi (setPlan chaqirilmaydi) — u allaqachon dry-run natijasini o'z ichiga oladi
        }
        return;
      }
      setPlan(j);
      setPlanPreset(BIZ_PRESETS.find((p) => p.id === presetId) ?? BIZ_PRESETS[0]);
      if (j.saved) {
        // Xarita va marshrut ro'yxatlarini yangilaymiz
        qc.invalidateQueries({ queryKey: ["distribution", "route-map"] });
        qc.invalidateQueries({ queryKey: ["distribution", "routes"] });
      }
    } catch {
      setError("Server bilan bog'lanib bo'lmadi");
    } finally {
      setPhase("idle");
    }
  };

  const reset = (o: boolean) => {
    setOpen(o);
    if (!o) {
      setPlan(null);
      setPlanPreset(null);
      setError(null);
      setForceable(false);
    }
  };

  const busy = phase !== "idle";

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-7 text-xs gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white">
          <Sparkles className="w-3.5 h-3.5" />
          AI marshrut tuzish
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-indigo-600" /> AI marshrut rejalashtirish
          </DialogTitle>
          <DialogDescription>
            Viloyatdagi barcha faol do'konlar geografik jihatdan optimal kunlik marshrutlarga bo'linadi (har kunga ~30 do'kon).
            Nasiya qoldig'i, savdo hajmi va oxirgi tashrifdan o'tgan kunlar asosida eng muhim do'konlar haftaning boshiga va kun boshiga joylashtiriladi.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2">
          <Select value={viloyat} onValueChange={(v) => { setViloyat(v); setPlan(null); }}>
            <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Viloyat" /></SelectTrigger>
            <SelectContent>
              {(dict?.viloyatlar ?? []).map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={agentId} onValueChange={(v) => { setAgentId(v); setPlan(null); }}>
            <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Yetkazuvchi agent" /></SelectTrigger>
            <SelectContent>
              {agents.map((a) => (
                <SelectItem key={a.id} value={String(a.id)}>
                  🚚 {a.name || "Agent"}{a.mashinaNomeri ? ` · ${a.mashinaNomeri}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Biznes ustuvorlik preseti: nasiya/tashrif/savdo vaznlari */}
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">Biznes ustuvorligi</div>
          <Select value={presetId} onValueChange={(v) => { setPresetId(v); setPlan(null); setPlanPreset(null); }}>
            <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Ustuvorlik preseti" /></SelectTrigger>
            <SelectContent>
              {BIZ_PRESETS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <span className="font-medium">{p.label}</span>
                  <span className="text-xs text-muted-foreground"> — {p.desc}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {error && (
          <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-950/30 rounded-md p-2.5">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
          </div>
        )}

        {plan && (
          <div className="space-y-3">
            {/* Biznes ustuvorligi banner */}
            {plan.businessPriorityActive && (
              <div className="flex items-start gap-2 text-xs bg-indigo-50 dark:bg-indigo-950/30 rounded-md p-2.5">
                <TrendingUp className="w-3.5 h-3.5 shrink-0 mt-0.5 text-indigo-600" />
                <div className="text-indigo-700 dark:text-indigo-300">
                  <span className="font-semibold">
                    Biznes ustuvorligi faol{planPreset ? ` · ${planPreset.label}` : ""}
                  </span> —
                  {planPreset ? ` ${planPreset.desc}. ` : " "}
                  Nasiya qoldig'i katta, savdo hajmi yuqori yoki uzoq bormagan do'konlar
                  haftaning boshiga va kun boshiga joylashtirildi.
                </div>
              </div>
            )}

            {/* Umumiy natija */}
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md border p-2">
                <div className="text-lg font-bold">{plan.totalShops}</div>
                <div className="text-[11px] text-muted-foreground">do'kon</div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-lg font-bold">{plan.totalKm} km</div>
                <div className="text-[11px] text-muted-foreground">umumiy yo'l</div>
              </div>
              <div className="rounded-md border p-2">
                <div className={`text-lg font-bold ${scoreColor(plan.avgScore)}`}>{plan.avgScore}</div>
                <div className="text-[11px] text-muted-foreground">o'rtacha ball</div>
              </div>
            </div>

            {/* Kunlik marshrutlar */}
            <div className="space-y-1">
              {plan.routes.map((r) => {
                const biz = r.bizSummary;
                return (
                  <div
                    key={r.kun}
                    className="rounded-md border px-2.5 py-1.5 space-y-0.5"
                    title={`Masofa: ${r.stats.totalKm} km\nHarakat vaqti: ~${fmtMin(r.stats.driveMinutes)}\nTashrif vaqti: ~${fmtMin(r.stats.visitMinutes)}\nO'rtacha hop: ${r.stats.avgHopKm} km\nEng uzun hop: ${r.stats.maxHopKm} km\nAI Score: ${r.stats.score}/100`}
                  >
                    <div className="flex items-center gap-2 text-sm">
                      <span className="capitalize font-medium w-24 shrink-0">{KUNLAR[r.kun - 1]}</span>
                      <span className="text-xs text-muted-foreground">{r.stats.shopCount} do'kon</span>
                      <span className="text-xs text-muted-foreground">· {r.stats.totalKm} km</span>
                      <span className="text-xs text-muted-foreground">· ~{fmtMin(r.stats.totalMinutes)}</span>
                      <span className={`text-xs font-semibold ml-auto ${scoreColor(r.stats.score)}`}>⭐ {r.stats.score}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className={r.stats.efficiency >= 90 ? "text-green-600" : r.stats.efficiency >= 70 ? "text-amber-600" : "text-red-600"}>
                        ⚡ Samaradorlik {r.stats.efficiency}%
                      </span>
                      <span className={r.stats.crossCount === 0 ? "text-green-600" : "text-red-600"}>
                        ✂️ Kesishish {r.stats.crossCount}
                      </span>
                      <span className={r.stats.backtrackPct <= 10 ? "text-green-600" : "text-amber-600"}>
                        ↩️ Orqaga {r.stats.backtrackPct}%
                      </span>
                      {r.stats.longJumps > 0 && (
                        <span className="text-amber-600">⤴️ {r.stats.longJumps} sakrash</span>
                      )}
                    </div>
                    {/* Biznes ustuvorlik ko'rsatkichlari */}
                    {biz && (biz.highPriorityCount > 0 || biz.totalCreditBalance > 0) && (
                      <div className="flex items-center gap-2 text-[11px]">
                        {biz.highPriorityCount > 0 && (
                          <span className={bizScoreColor(biz.avgBizScore)}>
                            🎯 {biz.highPriorityCount} ustuvor do'kon
                          </span>
                        )}
                        {biz.totalCreditBalance > 0 && (
                          <span className="text-red-600">
                            💳 Nasiya: {fmtMln(biz.totalCreditBalance)} so'm
                          </span>
                        )}
                        {biz.avgBizScore > 0 && (
                          <span className={`ml-auto ${bizScoreColor(biz.avgBizScore)}`}>
                            Biz. ball: {biz.avgBizScore}
                          </span>
                        )}
                      </div>
                    )}
                    {(r.stats.startShop || r.stats.endShop) && (
                      <div className="text-[11px] text-muted-foreground truncate">
                        🏁 {r.stats.startShop || "—"} → 🎯 {r.stats.endShop || "—"}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Validatsiya natijasi */}
            {plan.validation && !plan.validation.ok && !forceable && (
              <div className="text-xs bg-red-50 dark:bg-red-950/30 rounded-md p-2.5 space-y-1">
                <div className="flex items-center gap-1.5 font-medium text-red-700 dark:text-red-400">
                  <AlertTriangle className="w-3.5 h-3.5" /> Reja sifat tekshiruvidan o'tmadi — saqlab bo'lmaydi:
                </div>
                {plan.validation.issues.map((s, i) => (
                  <div key={i} className="text-muted-foreground pl-5">{s}</div>
                ))}
              </div>
            )}
            {/* Crossing-only blok: force bilan saqlash mumkin */}
            {forceable && plan.validation && (
              <div className="text-xs bg-amber-50 dark:bg-amber-950/30 rounded-md p-2.5 space-y-1">
                <div className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="w-3.5 h-3.5" /> Marshrutda kesishish qoldi — odatda saqlab bo'lmaydi:
                </div>
                {plan.validation.issues.map((s, i) => (
                  <div key={i} className="text-muted-foreground pl-5">{s}</div>
                ))}
                <div className="text-amber-700 dark:text-amber-400 pt-0.5">
                  Agar kesishish geometriya sabab bo'lsa (masalan, tarqoq hudud), "Baribir saqlash" tugmasi bilan majburiy saqlash mumkin.
                </div>
              </div>
            )}
            {plan.validation && plan.validation.ok && plan.validation.warnings.length > 0 && (
              <div className="text-xs bg-amber-50 dark:bg-amber-950/30 rounded-md p-2.5 space-y-1">
                <div className="font-medium text-amber-700 dark:text-amber-400">Sifat ogohlantirishlari:</div>
                {plan.validation.warnings.map((s, i) => (
                  <div key={i} className="text-muted-foreground pl-5">{s}</div>
                ))}
              </div>
            )}

            {/* Ogohlantirishlar */}
            {plan.badCoord.length > 0 && (
              <div className="text-xs bg-amber-50 dark:bg-amber-950/30 rounded-md p-2.5 space-y-1">
                <div className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
                  <MapPin className="w-3.5 h-3.5" /> {plan.badCoord.length} ta do'kon koordinatasi shubhali (rejaga kiritilmadi):
                </div>
                {plan.badCoord.map((b) => (
                  <div key={b.id} className="text-muted-foreground pl-5">
                    {b.nomi || `#${b.id}`}{b.hudud ? ` · ${b.hudud}` : ""} — GPS: {b.lat.toFixed(4)}, {b.lng.toFixed(4)}
                  </div>
                ))}
              </div>
            )}
            {plan.skippedNoCoord.length > 0 && (
              <Badge variant="outline" className="h-5 text-[10px] font-normal">
                📍 {plan.skippedNoCoord.length} ta do'konning koordinatasi yo'q — rejaga kiritilmadi
              </Badge>
            )}

            {plan.saved ? (
              <div className="text-sm text-green-600 font-medium">
                ✅ Marshrut saqlandi — xaritada ko'rishingiz mumkin
                {plan.forceSaved && (
                  <div className="text-xs text-amber-700 dark:text-amber-400 font-normal mt-0.5">
                    ⚠️ Kesishish ogohlantirishiga qaramay majburiy saqlandi — bu marshrut ro'yxatda belgilanadi.
                  </div>
                )}
              </div>
            ) : plan.existing > 0 ? (
              <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded-md p-2.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                Agentda {plan.existing} ta mavjud marshrut nuqtasi bor — saqlansa, ular o'chirilib yangi reja yoziladi.
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter className="gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={() => reset(false)}>Yopish</Button>
          {!plan?.saved && (
            <>
              <Button size="sm" variant={plan ? "outline" : "default"} disabled={!viloyat || !agentId || busy} onClick={() => run(false)}>
                {phase === "planning" && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
                {plan ? "Qayta hisoblash" : "Rejani ko'rish"}
              </Button>
              {plan && !forceable && (
                <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-white" disabled={busy} onClick={() => run(true)}>
                  {phase === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
                  Saqlash
                </Button>
              )}
              {/* Crossing bloki bor, lekin force bilan saqlash mumkin */}
              {forceable && (
                <Button
                  size="sm"
                  variant="outline"
                  className="border-amber-500 text-amber-700 hover:bg-amber-50 dark:border-amber-500 dark:text-amber-400 dark:hover:bg-amber-950/40"
                  disabled={busy}
                  onClick={() => run(true, true)}
                >
                  {phase === "force-saving" && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
                  {phase !== "force-saving" && <AlertTriangle className="w-3.5 h-3.5 mr-1.5" />}
                  Baribir saqlash
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
