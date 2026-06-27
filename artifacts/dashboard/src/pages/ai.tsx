import { authFetch } from "@/App";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Bot, RefreshCw, AlertTriangle, Boxes, CreditCard, Factory, History,
} from "lucide-react";

type Summary = {
  date: string;
  belowMinCount: number;
  lowRawCount: number;
  overdueCount: number;
  todayKg: number;
  avg7Kg: number;
};
type DailyResponse = {
  id: number;
  analysis: string;
  summary: Summary | null;
  generatedAt: string;
  cached: boolean;
};
type RunRow = {
  id: number;
  analysis: string;
  summary: Summary | null;
  generatedAt: string;
};

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("uz-UZ", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// Escape HTML, then apply minimal *bold* markdown from the LLM output.
function renderLine(line: string): string {
  const esc = line
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc.replace(/\*([^*]+)\*/g, "<strong>$1</strong>");
}

function AnalysisText({ text }: { text: string }) {
  return (
    <div className="space-y-1 text-sm leading-relaxed text-foreground">
      {text.split("\n").map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={i} className="h-2" />;
        return (
          <p key={i} dangerouslySetInnerHTML={{ __html: renderLine(trimmed) }} />
        );
      })}
    </div>
  );
}

function SummaryChips({ s }: { s: Summary | null }) {
  if (!s) return null;
  const chips = [
    { icon: Factory, label: "Minimumdan kam", value: s.belowMinCount, color: "amber" as const },
    { icon: Boxes, label: "Kam xom ashyo", value: s.lowRawCount, color: "amber" as const },
    { icon: CreditCard, label: "Ochiq nasiya", value: s.overdueCount, color: "blue" as const },
  ];
  const colorCls = {
    amber: "bg-amber-50 border-amber-200 text-amber-700",
    blue: "bg-blue-50 border-blue-200 text-blue-700",
  };
  return (
    <div className="flex flex-wrap gap-3">
      {chips.map((c) => (
        <div
          key={c.label}
          className={`flex items-center gap-2 rounded-md border px-3 py-2 ${colorCls[c.color]}`}
        >
          <c.icon className="w-4 h-4" />
          <span className="text-sm">{c.label}:</span>
          <span className="font-semibold">{c.value}</span>
        </div>
      ))}
      <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
        <Factory className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm">Bugun / o'rtacha:</span>
        <span className="font-semibold">
          {s.todayKg} / {s.avg7Kg} kg
        </span>
      </div>
    </div>
  );
}

export default function AiPage() {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const { data: latest, isLoading, error } = useQuery<DailyResponse>({
    queryKey: ["ai-daily"],
    queryFn: async () => {
      const res = await authFetch("/api/ai/daily-analysis");
      if (!res.ok) throw new Error("AI tahlilni olishda xato");
      return res.json();
    },
    retry: false,
  });

  const { data: runs = [] } = useQuery<RunRow[]>({
    queryKey: ["ai-runs"],
    queryFn: async () => {
      const res = await authFetch("/api/ai/runs");
      if (!res.ok) throw new Error("Tarixni olishda xato");
      return res.json();
    },
  });

  async function refresh() {
    setRefreshing(true);
    try {
      const res = await authFetch("/api/ai/daily-analysis?refresh=1");
      if (res.ok) {
        const fresh: DailyResponse = await res.json();
        queryClient.setQueryData(["ai-daily"], fresh);
        queryClient.invalidateQueries({ queryKey: ["ai-runs"] });
      }
    } finally {
      setRefreshing(false);
    }
  }

  const history = runs.filter((r) => r.id !== latest?.id);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Bot className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">AI Zavod Yordamchisi</h2>
            <p className="text-sm text-muted-foreground">
              Ombor, ishlab chiqarish va savdoga asoslangan kunlik tavsiyalar
            </p>
          </div>
        </div>
        <Button onClick={refresh} disabled={refreshing} data-testid="btn-ai-refresh">
          <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Tahlil qilinmoqda…" : "Yangilash"}
        </Button>
      </div>

      {isLoading && (
        <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
          Tahlil yuklanmoqda…
        </div>
      )}

      {!isLoading && error && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5" />
          <div>
            <div className="font-medium text-amber-800">AI tahlil hozircha mavjud emas</div>
            <p className="text-sm text-amber-700 mt-1">
              "Yangilash" tugmasini bosib ko'ring. Muammo davom etsa, AI sozlamalarini tekshiring.
            </p>
          </div>
        </div>
      )}

      {!isLoading && latest && (
        <div className="rounded-lg border bg-card p-6 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <SummaryChips s={latest.summary} />
            <div className="flex items-center gap-2">
              {latest.cached && (
                <Badge variant="secondary" className="text-xs">Saqlangan</Badge>
              )}
              <span className="text-xs text-muted-foreground">
                {fmtDateTime(latest.generatedAt)}
              </span>
            </div>
          </div>
          <div className="border-t pt-4">
            <AnalysisText text={latest.analysis} />
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <History className="w-4 h-4" />
            Oldingi tahlillar
          </div>
          {history.map((r) => (
            <details key={r.id} className="rounded-lg border bg-card group">
              <summary className="cursor-pointer px-4 py-3 flex items-center justify-between text-sm">
                <span className="font-medium">{fmtDateTime(r.generatedAt)}</span>
                {r.summary && (
                  <span className="text-xs text-muted-foreground">
                    {r.summary.belowMinCount} mahsulot · {r.summary.lowRawCount} xom ashyo · {r.summary.overdueCount} nasiya
                  </span>
                )}
              </summary>
              <div className="px-4 pb-4 border-t pt-3">
                <AnalysisText text={r.analysis} />
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
