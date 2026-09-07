────
function SalesTab({ f, active, onShop }: { f: Filters; active: boolean; onShop: (id: number) => void }) {
  const qs = filterQuery(f);
  const { data, isLoading } = useDist<Sale[]>(["sales", qs], `sales${qs}`, active);
  if (isLoading) return <TableSkeleton cols={6} />;
  const total = data?.reduce((s, x) => s + x.total, 0) ?? 0;
  return (
    <div>
      {data && data.length > 0 && (
        <div className="px-4 py-2.5 border-b bg-muted/40 flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{data.length} ta savdo{data.length === 200 ? " (oxirgi 200)" : ""}</span>
          <span className="font-bold">{fmtSom(total)}</span>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Sana</TableHead>
            <TableHead>Do'kon</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Mahsulotlar</TableHead>
            <TableHead>To'lov</TableHead>
            <TableHead className="text-right">Summa</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!data || data.length === 0 ? <EmptyRow colSpan={6} text="Tanlangan filtrlar bo'yicha savdolar yo'q" /> : data.map((s) => (
            <TableRow
              key={s.id}
              className={s.dokonId ? "cursor-pointer" : undefined}
              onClick={() => { if (s.dokonId) onShop(s.dokonId); }}
            >
              <TableCell className="text-muted-foreground whitespace-nowrap">{fmtDateTime(s.createdAt)}</TableCell>
              <TableCell className="font-medium">{s.dokonName || "—"}{(s.viloyat || s.hudud) && <span className="block text-[11px] text-muted-foreground">{[s.viloyat, s.hudud].filter(Boolean).join(", ")}</span>}</TableCell>
              <TableCell>{s.agentName || "—"}</TableCell>
              <TableCell className="max-w-xs truncate text-xs text-muted-foreground">{s.items || "—"}</TableCell>
              <TableCell><PaymentBadge type={s.tolovTuri} /></TableCell>
              <TableCell className="text-right font-semibold whitespace-nowrap">{fmtSom(s.total)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Agentlar tab (kartochkalar) ──────────────────────────────────────────────────
function AgentsTab({ f, active }: { f: Filters; active: boolean }) {
  const qs = filterQuery(f);
  const { data, isLoading } = useDist<Agent[]>(["agents", qs], `agents${qs}`, active);
  if (isLoading) return <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3 p-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-44" />)}</div>;
  if (!data || data.length === 0) return <div className="text-center text-muted-foreground py-10">Agentlar yo'q</div>;
  const periodLabel = f.preset === "today" ? "Bugun" : f.preset === "yesterday" ? "Kecha" : f.preset === "week" ? "Shu hafta" : f.preset === "month" ? "Shu oy" : "Davr";
  return (
    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3 p-4">
      {data.map((a) => (
        <Card key={a.telegramId ?? a.name ?? "x"}>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-sm">
                  {(a.name || "?").slice(0, 1).toUpperCase()}
                </div>
                <div>
                  <div className="font-semibold text-sm">{a.name || "—"}</div>
                  <div className="text-[11px] text-muted-foreground">{a.viloyat || "—"}{a.role === "supervisor" ? " • supervisor" : ""}</div>
                </div>
              </div>
              <Badge variant="secondary" className="h-5 text-[10px]">{a.shops} do'kon</Badge>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-md bg-muted/50 p-2">
                <div className="text-[11px] text-muted-foreground">{periodLabel}: tashrif</div>
                <div className="font-bold">{a.visits} ta</div>
              </div>
              <div className="rounded-md bg-muted/50 p-2">
                <div className="text-[11px] text-muted-foreground">Savdo</div>
                <div className="font-bold">{a.salesCount} ta</div>
              </div>
              <div className="rounded-md bg-muted/50 p-2 col-span-2">
                <div className="text-[11px] text-muted-foreground">Savdo summasi</div>
                <div className="font-bold">{fmtSom(a.salesTotal)}</div>
              </div>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-green-700">Yig'ildi: {a.collected > 0 ? fmtSom(a.collected) : "—"}</span>
              <span className={a.outstanding > 0 ? "text-red-600 font-medium" : "text-muted-foreground"}>
                Nasiya: {a.outstanding > 0 ? fmtSom(a.outstanding) : "—"}
              </span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ── Do'konlar tab (Stores Intelligence jadvali) ──────────────────────────────────
function ShopStatusBadge({ status }: { status: ShopIntel["status"] }) {
  if (status === "faol")
    return <Badge className="bg-green-100 text-green-700 border-green-200 h-5 text-[10px]">🟢 Faol</Badge>;
  if (status === "risk")
    return <Badge className="bg-amber-100 text-amber-700 border-amber-200 h-5 text-[10px]">🟡 Risk</Badge>;
  return <Badge className="bg-red-100 text-red-700 border-red-200 h-5 text-[10px]">🔴 Muammo</Badge>;
}

const SHOP_STATUSES = [
  { v: "all", label: "Barchasi" },
  { v: "faol", label: "🟢 Faol" },
  { v: "risk", label: "🟡 Risk" },
  { v: "muammo", label: "🔴 Muammo" },
];

function ShopsTab({ f, active, onShop }: { f: Filters; active: boolean; onShop: (id: number) => void }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("all");
  const baseQs = filterQuery(f);

  // Filtr o'zgarsa birinchi sahifaga qaytamiz
  useEffect(() => { setPage(1); }, [baseQs, status]);

  const qs = filterQuery(f, {
    page: String(page),
    pageSize: "25",
    ...(status !== "all" ? { status } : {}),
  });
  const { data, isLoading } = useDist<ShopsPage>(["shops-intel", qs], `shops${qs}`, active);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div>
      <div className="px-4 py-2.5 border-b bg-muted/40 flex flex-wrap items-center gap-2">
        {SHOP_STATUSES.map((s) => (
          <Button
            key={s.v}
            size="sm"
            variant={status === s.v ? "default" : "outline"}
            className="h-7 text-xs"
            onClick={() => setStatus(s.v)}
          >
            {s.label}
          </Button>
        ))}
        {data && (
          <span className="text-xs text-muted-foreground ml-auto">{data.total} ta do'kon</span>
        )}
      </div>
      {isLoading ? (
        <TableSkeleton cols={8} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Do'kon</TableHead>
              <TableHead>Hudud</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Oxirgi tashrif</TableHead>
              <TableHead>Oxirgi savdo</TableHead>
              <TableHead className="text-right">Buyurtma</TableHead>
              <TableHead className="text-right">Nasiya</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!data || data.rows.length === 0 ? (
              <EmptyRow colSpan={8} text="Tanlangan filtrlar bo'yicha do'konlar yo'q" />
            ) : (
              data.rows.map((d) => (
                <TableRow key={d.id} className="cursor-pointer" onClick={() => onShop(d.id)}>
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-1.5">
                      {d.nomi || "—"}
                      {d.hasLocation && <MapPin className="w-3 h-3 text-emerald-600 shrink-0" />}
                    </span>
                    {d.telefon && <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Phone className="w-2.5 h-2.5" />{d.telefon}</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{[d.viloyat, d.hudud].filter(Boolean).join(", ") || "—"}</TableCell>
                  <TableCell className="text-xs">{d.agentName || "—"}</TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap">{fmtDate(d.lastVisit)}</TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap">{fmtDate(d.lastOrderDate)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {d.totalOrders} ta
                    {d.repeatOrders > 0 && <span className="text-[11px] text-muted-foreground"> ({d.repeatOrders} repeat)</span>}
                  </TableCell>
                  <TableCell className={`text-right whitespace-nowrap ${d.outstanding > 0 ? "text-red-600 font-semibold" : "text-muted-foreground"}`}>
                    {d.outstanding > 0 ? fmtSom(d.outstanding) : "—"}
                  </TableCell>
                  <TableCell><ShopStatusBadge status={d.status} /></TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}
      {data && data.total > data.pageSize && (
        <div className="flex items-center justify-between px-4 py-2.5 border-t text-sm">
          <span className="text-xs text-muted-foreground">
            {(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} / {data.total}
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-7" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Oldingi
            </Button>
            <span className="text-xs text-muted-foreground">{data.page} / {totalPages}</span>
            <Button size="sm" variant="outline" className="h-7" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Keyingi
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Nasiya tab ───────────────────────────────────────────────────────────────────
function DebtsTab({ f, active, onShop }: { f: Filters; active: boolean; onShop: (id: number) => void }) {
  const qs = filterQuery(f);
  const { data, isLoading } = useDist<Debt[]>(["debts", qs], `debts${qs}`, active);
  if (isLoading) return <TableSkeleton cols={5} />;
  const total = data?.reduce((s, d) => s + d.outstanding, 0) ?? 0;
  return (
    <div>
      {data && data.length > 0 && (
        <div className="px-4 py-3 border-b bg-red-50/50 flex items-center gap-2 text-sm">
          <CreditCard className="w-4 h-4 text-red-500" />
          <span className="text-muted-foreground">Umumiy nasiya qoldiq:</span>
          <span className="font-bold text-red-700">{fmtSom(total)}</span>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Do'kon</TableHead>
            <TableHead>Hudud</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead className="text-right">Yozuvlar</TableHead>
            <TableHead>Oxirgi to'lov</TableHead>
            <TableHead className="text-right">Qoldiq</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!data || data.length === 0 ? <EmptyRow colSpan={6} text="Nasiya yo'q" /> : data.map((d) => (
            <TableRow key={d.dokonId} className="cursor-pointer" onClick={() => onShop(d.dokonId)}>
              <TableCell className="font-medium">
                {d.dokonName || "—"}
                {d.telefon && <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Phone className="w-2.5 h-2.5" />{d.telefon}</span>}
              </TableCell>
              <TableCell className="text-muted-foreground">{[d.viloyat, d.hudud].filter(Boolean).join(", ") || "—"}</TableCell>
              <TableCell>{d.agentName || "—"}</TableCell>
              <TableCell className="text-right">{d.entries}</TableCell>
              <TableCell className="text-muted-foreground whitespace-nowrap">{fmtDate(d.lastPayment)}</TableCell>
              <TableCell className="text-right font-bold text-red-600 whitespace-nowrap">{fmtSom(d.outstanding)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Kunlik tashriflar tab ────────────────────────────────────────────────────────
type DailyStop = {
  dokonId: number; dokonName: string | null; viloyat: string | null; hudud: string | null;
  telefon: string | null; lat: number | null; lng: number | null;
  outcome: "sold" | "nosale" | "payment";
  sabab: string | null; sababText: string | null; qaytishSanasi: string | null;
  saleTotal: number | null; tolovTuri: string | null;
  createdAt: string | null; onRoute: boolean;
};
type DailyAgent = {
  agentId: number; agentName: string | null; mashinaNomeri: string | null; hudud: string | null;
  planned: number; visited: number; sold: number; noSale: number;
  salesTotal: number; salesCount: number; remaining: number;
  reasons: { sabab: string; cnt: number }[];
  trail: { lat: number; lng: number; at: string | null }[];
  stops: DailyStop[];
};
type DailyVisits = { date: string; kun: number; agents: DailyAgent[] };

const SABAB_LABELS: Record<string, string> = {
  yopiq: "Do'kon yopiq",
  budjet_yoq: "Budjet yo'q",
  tovar_yetarli: "Tovar yetarli",
  boshqa: "Boshqa sabab",
  qaytib_kelaman: "Qaytib kelaman",
  rad_etdi: "Rad etdi",
};
function dailySababLabel(sabab: string | null, text: string | null): string {
  if (!sabab) return text || "Sabab ko'rsatilmadi";
  return SABAB_LABELS[sabab] ?? (text || sabab);
}

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function DailyAgentCard({ agent, onShop, open, onToggle }: { agent: DailyAgent; onShop: (id: number) => void; open: boolean; onToggle: () => void }) {
  const visitPct = agent.planned > 0 ? Math.round((agent.visited / agent.planned) * 100) : 0;
  const soldPct = agent.visited > 0 ? Math.round((agent.sold / agent.visited) * 100) : 0;

  const outcomeColor: Record<DailyStop["outcome"], string> = {
    sold: "bg-green-100 border-green-200 text-green-700",
    nosale: "bg-red-50 border-red-200 text-red-700",
    payment: "bg-blue-50 border-blue-200 text-blue-700",
  };
  const outcomeLabel: Record<DailyStop["outcome"], string> = {
    sold: "Savdo",
    nosale: "Olmadi",
    payment: "To'lov",
  };

  return (
    <Card id={`daily-agent-card-${agent.agentId}`}>
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-sm shrink-0">
              {(agent.agentName || "?").slice(0, 1).toUpperCase()}
            </div>
            <div>
              <div className="font-semibold text-sm">{agent.agentName || "—"}</div>
              <div className="text-[11px] text-muted-foreground">
                {[agent.hudud, agent.mashinaNomeri].filter(Boolean).join(" • ") || "—"}
              </div>
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-base font-bold text-green-700">{fmtSom(agent.salesTotal)}</div>
            <div className="text-[11px] text-muted-foreground">{agent.salesCount} savdo</div>
          </div>
        </div>

        {/* Progress bars */}
        <div className="space-y-2">
          <div>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-muted-foreground">Tashrif</span>
              <span className="font-medium">{agent.visited} / {agent.planned} ta ({visitPct}%)</span>
            </div>
            <ProgressBar value={agent.visited} max={agent.planned} color="bg-indigo-500" />
          </div>
          {agent.visited > 0 && (
            <div>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-muted-foreground">Konversiya</span>
                <span className="font-medium">{agent.sold} savdo / {agent.visited} tashrif ({soldPct}%)</span>
              </div>
              <ProgressBar value={agent.sold} max={agent.visited} color="bg-green-500" />
            </div>
          )}
        </div>

        {/* Stats chips */}
        <div className="flex flex-wrap gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs bg-green-50 border-green-200 text-green-700">
            <CheckCircle2 className="w-3 h-3" /> {agent.sold} savdo
          </span>
          <span className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs bg-red-50 border-red-200 text-red-700">
            <XCircle className="w-3 h-3" /> {agent.noSale} olmadi
          </span>
          {agent.remaining > 0 && (
            <span className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs bg-amber-50 border-amber-200 text-amber-700">
              <Clock className="w-3 h-3" /> {agent.remaining} qoldi
            </span>
          )}
        </div>

        {/* Reasons breakdown */}
        {agent.reasons.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {agent.reasons.map((r) => (
              <span key={r.sabab} className="text-[11px] rounded-full border px-2 py-0.5 bg-muted/50 text-muted-foreground">
                {dailySababLabel(r.sabab, null)}: <b>{r.cnt}</b>
              </span>
            ))}
          </div>
        )}

        {/* Expand/collapse stops */}
        {agent.stops.length > 0 && (
          <div>
            <button
              type="button"
              onClick={onToggle}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              {agent.stops.length} ta tashrif tafsiloti
            </button>
            {open && (
              <div className="mt-2 space-y-1.5 max-h-80 overflow-y-auto pr-1">
                {agent.stops.map((s) => (
                  <div
                    key={`${s.dokonId}-${s.outcome}`}
                    className={`flex items-start justify-between gap-2 rounded-md border px-2.5 py-2 text-xs cursor-pointer hover:opacity-90 transition-opacity ${outcomeColor[s.outcome]}`}
                    onClick={() => onShop(s.dokonId)}
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate">{s.dokonName || "—"}</div>
                      {s.hudud && <div className="text-[11px] opacity-70">{[s.viloyat, s.hudud].filter(Boolean).join(", ")}</div>}
                      {s.outcome === "nosale" && s.sabab && (
                        <div className="text-[11px] mt-0.5 opacity-80">{dailySababLabel(s.sabab, s.sababText)}</div>
                      )}
                      {s.outcome === "nosale" && s.qaytishSanasi && (
                        <div className="text-[11px] mt-0.5 opacity-70">🔁 Qaytish: {s.qaytishSanasi}</div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-semibold">{outcomeLabel[s.outcome]}</div>
                      {s.saleTotal != null && s.saleTotal > 0 && (
                        <div className="text-[11px]">{fmtSom(s.saleTotal)}</div>
                      )}
                      <div className="text-[10px] opacity-60">{s.createdAt ? s.createdAt.slice(11, 16) : ""}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// CSV export — expanded stop ro'yxatidagi ma'lumotlarning aynan o'zi
const OUTCOME_CSV: Record<DailyStop["outcome"], string> = {
  sold: "Savdo",
  nosale: "Olmadi",
  payment: "To'lov",
};
function exportDailyVisitsCsv(data: DailyVisits) {
  const header = ["Agent", "Do'kon", "Natija", "Sabab", "Vaqt", "Summa"];
  const rows: string[][] = [];
  for (const a of data.agents) {
    for (const s of a.stops) {
      rows.push([
        a.agentName || "—",
        s.dokonName || "—",
        OUTCOME_CSV[s.outcome] ?? s.outcome,
        s.outcome === "nosale" ? dailySababLabel(s.sabab, s.sababText) : "",
        s.createdAt ? `${s.createdAt.slice(0, 10)} ${s.createdAt.slice(11, 16)}` : "",
        s.saleTotal != null && s.saleTotal > 0 ? String(Math.round(s.saleTotal)) : "",
      ]);
    }
  }
  // Agent bo'yicha jamlanma — ekrandagi agent kartalari bilan bir xil qiymatlar
  const summaryHeader = ["Agent", "Rejalashtirilgan", "Kirildi", "Savdo", "Olmadi", "Savdo jami", "Konversiya %"];
  const summaryRows: string[][] = data.agents.map((a) => [
    a.agentName || "—",
    String(a.planned),
    String(a.visited),
    String(a.sold),
    String(a.noSale),
    String(Math.round(a.salesTotal)),
    a.visited > 0 ? String(Math.round((a.sold / a.visited) * 100)) : "",
  ]);

  const all: string[][] = [
    ["Tashriflar"],
    header,
    ...rows,
    [""],
    ["Agentlar jamlanmasi"],
    summaryHeader,
    ...summaryRows,
  ];
  downloadCsv(toCsv(all), `kunlik-tashriflar-${data.date}.csv`);
}

function DailyVisitsTab({ f, active, onShop }: { f: Filters; active: boolean; onShop: (id: number) => void }) {
  // Ochilgan kartalar holati parent darajasida saqlanadi — refetch paytida yo'qolmaydi
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  // Xaritada ajratilgan agent — oxirgi ochilgan karta; yopilganda ochiq qolgan boshqa karta (bo'lsa)
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);
  const toggleExpanded = (agentId: number) =>
    setExpanded((prev) => {
      const willOpen = !prev[agentId];
      const next = { ...prev, [agentId]: willOpen };
      if (willOpen) {
        setSelectedAgentId(agentId);
      } else {
        setSelectedAgentId((cur) => {
          if (cur !== agentId) return cur;
          const other = Object.entries(next).find(([, v]) => v);
          return other ? Number(other[0]) : null;
        });
      }
      return next;
    });
  // Xaritadan tanlash: iz/GPS nuqta bosilganda kartani ochib scroll qilamiz; null — bekor qilish
  const selectFromMap = (agentId: number | null) => {
    setSelectedAgentId(agentId);
    if (agentId == null) return;
    setExpanded((prev) => ({ ...prev, [agentId]: true }));
    // Karta DOM'da yangilangach scroll qilamiz
    setTimeout(() => {
      document.getElementById(`daily-agent-card-${agentId}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 50);
  };
  const p = new URLSearchParams();
  if (f.agentId) p.set("agentId", f.agentId);
  if (f.viloyat) p.set("viloyat", f.viloyat);
  if (f.hudud) p.set("hudud", f.hudud);
  // date: if preset is "today" or "yesterday" pass the specific date; else omit (defaults to today)
  const { from } = presetRange(f.preset, f.from, f.to);
  const isSingleDay = f.preset === "today" || f.preset === "yesterday" || (f.preset === "custom" && f.from === f.to);
  if (isSingleDay && from) p.set("date", from);
  const qs = p.toString() ? `?${p.toString()}` : "";

  const { data, isLoading, dataUpdatedAt, refetch, isFetching } = useQuery<DailyVisits>({
    queryKey: ["distribution", "daily-visits", qs],
    queryFn: async () => {
      const r = await authFetch(`/api/distribution/daily-visits${qs}`);
      if (!r.ok) throw new Error("Ma'lumot yuklanmadi");
      return r.json();
    },
    enabled: active,
    refetchInterval: active ? 30_000 : false, // 30 soniyada yangilanadi
  });

  const lastUpdated = dataUpdatedAt
    ? new Intl.DateTimeFormat("uz-UZ", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Tashkent" }).format(new Date(dataUpdatedAt))
    : null;

  if (!active) return null;

  // Summary totals
  const totals = data?.agents.reduce(
    (acc, a) => ({
      planned: acc.planned + a.planned,
      visited: acc.visited + a.visited,
      sold: acc.sold + a.sold,
      noSale: acc.noSale + a.noSale,
      salesTotal: acc.salesTotal + a.salesTotal,
    }),
    { planned: 0, visited: 0, sold: 0, noSale: 0, salesTotal: 0 }
  );

  return (
    <div className="p-4 space-y-4">
      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-indigo-600" />
          <span className="font-semibold text-sm">
            Kunlik tashriflar — {data?.date ?? "…"}
          </span>
          {!isSingleDay && (
            <span className="text-xs text-muted-foreground">(bugungi kun ko'rsatilmoqda)</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="w-3 h-3" /> {lastUpdated}
            </span>
          )}
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
            Yangilash
          </button>
          <button
            type="button"
            onClick={() => data && exportDailyVisitsCsv(data)}
            disabled={!data || data.agents.every((a) => a.stops.length === 0)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
            title="Kunlik tashriflarni CSV sifatida yuklab olish"
          >
            <Download className="w-3.5 h-3.5" />
            Export
          </button>
        </div>
      </div>

      {/* Summary strip */}
      {totals && !isLoading && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {[
            { label: "Rejalashtirilgan", value: `${totals.planned} ta`, tone: "text-indigo-700" },
            { label: "Kirildi", value: `${totals.visited} ta`, tone: "text-blue-700" },
            { label: "Savdo", value: `${totals.sold} ta`, tone: "text-green-700" },
            { label: "Olmadi", value: `${totals.noSale} ta`, tone: "text-red-600" },
            { label: "Savdo jami", value: fmtSom(totals.salesTotal), tone: "text-green-700 font-bold" },
          ].map((item) => (
            <div key={item.label} className="rounded-md border p-2.5 text-center">
              <div className="text-[11px] text-muted-foreground mb-0.5">{item.label}</div>
              <div className={`text-sm font-semibold ${item.tone}`}>{item.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Xarita: kirilgan do'konlar + agent GPS izi */}
      {data && data.agents.length > 0 && (
        <DailyVisitsMap agents={data.agents} onShop={onShop} selectedAgentId={selectedAgentId} onSelectAgent={selectFromMap} />
      )}

      {/* Agent cards */}
      {isLoading ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-56" />)}
        </div>
      ) : !data || data.agents.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
          <AlertCircle className="w-8 h-8 opacity-40" />
          <div className="text-sm">Bugun hech bir agent tashrif amalga oshirmagan</div>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.agents.map((a) => (
            <DailyAgentCard
              key={a.agentId}
              agent={a}
              onShop={onShop}
              open={!!expanded[a.agentId]}
              onToggle={() => toggleExpanded(a.agentId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Marshrut tab ─────────────────────────────────────────────────────────────────
function RoutesTab({ f, update, active, onShop }: { f: Filters; update: (p: Partial<Filters>) => void; active: boolean; onShop: (id: number) => void }) {
  const kun = f.kun ?? "";
  const { data, isLoading } = useDist<RoutesData>(["routes", kun], `routes${kun ? `?kun=${kun}` : ""}`, active);
  // Kesishish (⚠️) belgisi bosilganda tushuntirish ko'rsatiladigan agent (null — yopiq)
  const [crossInfoAgent, setCrossInfoAgent] = useState<number | null>(null);

  const grouped = useMemo(() => {
    if (!data) return [];
    const crossByAgent = new Map((data.agentStats ?? []).map((s) => [s.agentId, s.crossCount]));
    const m = new Map<number, { agentId: number; agentName: string | null; mashinaNomeri: string | null; crossCount: number; stops: RoutesData["routes"] }>();
    for (const r of data.routes) {
      if (!m.has(r.agentId)) {
        m.set(r.agentId, {
          agentId: r.agentId,
          agentName: r.agentName,
          mashinaNomeri: r.mashinaNomeri,
          crossCount: crossByAgent.get(r.agentId) ?? 0,
          stops: [],
        });
      }
      m.get(r.agentId)!.stops.push(r);
    }
    return Array.from(m.values());
  }, [data]);

  return (
    <div className="p-4 space-y-4">
      {/* Haftalik marshrut xaritasi — har kun o'z rangida, marshrutsiz do'konlar kulrang */}
      <RouteWeekMap active={active} onShop={onShop} />

      {/* Koordinatasi yo'q yoki shubhali do'konlar — GPS tahrirlash */}
      <BadCoordPanel />

      <div className="flex flex-wrap gap-2">
        {(data?.kunlar ?? ["dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba", "yakshanba"]).map((k, i) => (
          <Button
            key={k}
            size="sm"
            variant={(data ? data.kun === i + 1 : false) ? "default" : "outline"}
            className="h-8 capitalize"
            onClick={() => update({ kun: String(i + 1) })}
          >
            {k}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <div className="grid md:grid-cols-2 gap-3">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-48" />)}</div>
      ) : grouped.length === 0 ? (
        <div className="text-center text-muted-foreground py-10">Bu kun uchun marshrut yo'q</div>
      ) : (
        <div className="grid md:grid-cols-2 gap-3">
          {grouped.map((g, gi) => {
            const done = g.stops.filter((s) => s.visited).length;
            return (
              <Card key={gi}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <RouteIcon className="w-4 h-4 text-indigo-600" />
                      <div>
                        <div className="font-semibold text-sm">{g.agentName || "—"}</div>
                        {g.mashinaNomeri && <div className="text-[11px] text-muted-foreground">{g.mashinaNomeri}</div>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {/* Hal qilinmagan kesishishlar — haftalik xaritadagi ⚠️ bilan bir xil signal */}
                      {g.crossCount > 0 && (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={() => setCrossInfoAgent((cur) => (cur === g.agentId ? null : g.agentId))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setCrossInfoAgent((cur) => (cur === g.agentId ? null : g.agentId));
                            }
                          }}
                          title="Bu kunning marshrutida hal qilinmagan kesishishlar bor — bosing"
                          className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-800 border border-amber-300 px-2 py-0.5 text-[10px] font-semibold cursor-pointer"
                        >
                          <AlertCircle className="w-3 h-3" />
                          {g.crossCount}
                        </span>
                      )}
                      {/* Audit belgisi: marshrut kesishish ogohlantirishiga qaramay majburiy saqlangan */}
                      {g.stops.some((s) => s.forceSaved) && (
                        <Badge
                          variant="outline"
                          className="h-5 text-[10px] border-amber-500 text-amber-700 dark:text-amber-400 gap-1 flex items-center"
                          title="Bu marshrut kesishish ogohlantirishiga qaramay majburiy (force) saqlangan"
                        >
                          <AlertCircle className="w-3 h-3" />
                          Majburiy saqlangan
                        </Badge>
                      )}
                      <Badge variant="secondary" className="h-5 text-[10px]">
                        {done}/{g.stops.length} do'kon
                      </Badge>
                    </div>
                  </div>
                  {/* Kesishish tushuntirishi (⚠️ bosilganda) — RouteWeekMap bilan bir xil matn */}
                  {crossInfoAgent === g.agentId && g.crossCount > 0 && data && (
                    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                      <span className="font-semibold capitalize">{data.kunlar[data.kun - 1]}</span> marshrutida{" "}
                      <span className="font-semibold">{g.crossCount} ta kesishish</span> qolgan.
                      Kesishish — marshrut chizig'ining o'z-o'zini kesib o'tishi: agent bir joydan ikki marta o'tadi,
                      bu ortiqcha kilometr va vaqt degani. Bunday marshrut odatda kesishishlar bilan majburan (force)
                      saqlangan — avto-optimallash ularni bartaraf eta olmagan. Yechim: "AI marshrut" orqali qayta
                      rejalashtiring yoki do'konlar tartibini qo'lda o'zgartiring.
                      <button className="ml-2 underline" onClick={() => setCrossInfoAgent(null)}>
                        Yopish
                      </button>
                    </div>
                  )}
                  <div className="space-y-1">
                    {g.stops.map((s) => (
                      <div
                        key={`${s.dokonId}-${s.tartib}`}
                        className="flex items-center gap-2 text-sm py-1 px-1.5 rounded hover:bg-muted/50 cursor-pointer"
                        onClick={() => onShop(s.dokonId)}
                      >
                        {s.visited
                          ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" />
                          : <XCircle className="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />}
                        <span className="text-xs text-muted-foreground w-5 shrink-0">{s.tartib}.</span>
                        <span className="truncate">{s.dokonName || "—"}</span>
                        <span className="text-[11px] text-muted-foreground ml-auto shrink-0">{s.hudud || s.viloyat || ""}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Distribution() {
  const [f, update] = useFilters();
  const [shopId, setShopId] = useState<number | null>(null);

  // Xarita bitta sana bilan ishlaydi: davr bir kun bo'lsa — o'sha kun,
  // aks holda davr oxiri (yoki bugun — backend standarti)
  const mapDate = useMemo(() => {
    const { from, to } = presetRange(f.preset, f.from, f.to);
    return from && from === to ? from : to;
  }, [f.preset, f.from, f.to]);

  return (
    <div className="space-y-4">
      <KpiCards f={f} update={update} />
      <TodayActivityWidget f={f} />
      <FilterPanel f={f} update={update} />
      <Card>
        <CardContent className="pt-4">
          <Tabs value={f.tab} onValueChange={(t) => update({ tab: t })}>
            <TabsList className="flex-wrap h-auto">
              <TabsTrigger value="overview">Umumiy holat</TabsTrigger>
              <TabsTrigger value="visits">Tashriflar</TabsTrigger>
              <TabsTrigger value="sales">Savdolar</TabsTrigger>
              <TabsTrigger value="agents">Agentlar</TabsTrigger>
              <TabsTrigger value="shops">Do'konlar</TabsTrigger>
              <TabsTrigger value="debts">Nasiya</TabsTrigger>
              <TabsTrigger value="routes">Marshrut</TabsTrigger>
              <TabsTrigger value="map">Xarita</TabsTrigger>
              <TabsTrigger value="analytics">Tahlil</TabsTrigger>
              <TabsTrigger value="vehicle-stock">Avto zaxira</TabsTrigger>
              <TabsTrigger value="products">Mahsulotlar</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="border rounded-md mt-4">
              <TopMartOverviewTab active={f.tab === "overview"} />
            </TabsContent>
            <TabsContent value="visits" className="border rounded-md mt-4">
              <DailyVisitsTab f={f} active={f.tab === "visits"} onShop={setShopId} />
            </TabsContent>
            <TabsContent value="sales" className="border rounded-md mt-4 overflow-x-auto">
              <SalesTab f={f} active={f.tab === "sales"} onShop={setShopId} />
            </TabsContent>
            <TabsContent value="agents" className="border rounded-md mt-4">
              <AgentsTab f={f} active={f.tab === "agents"} />
            </TabsContent>
            <TabsContent value="shops" className="border rounded-md mt-4">
              <ShopsTab f={f} active={f.tab === "shops"} onShop={setShopId} />
            </TabsContent>
            <TabsContent value="debts" className="border rounded-md mt-4 overflow-x-auto">
              <DebtsTab f={f} active={f.tab === "debts"} onShop={setShopId} />
            </TabsContent>
            <TabsContent value="routes" className="border rounded-md mt-4">
              <RoutesTab f={f} update={update} active={f.tab === "routes"} onShop={setShopId} />
            </TabsContent>
            <TabsContent value="map" className="border rounded-md mt-4">
              <MapTab
                date={mapDate}
                agentId={f.agentId}
                viloyat={f.viloyat}
                hudud={f.hudud}
                search={f.search}
                active={f.tab === "map"}
                onShop={setShopId}
              />
            </TabsContent>
            <TabsContent value="analytics" className="border rounded-md mt-4">
              <AnalyticsTab qs={filterQuery(f)} active={f.tab === "analytics"} />
            </TabsContent>
            <TabsContent value="vehicle-stock" className="mt-4">
              <VehicleStockTab active={f.tab === "vehicle-stock"} />
            </TabsContent>
            <TabsContent value="products" className="mt-4 p-4 bg-background rounded-md border">
              {f.tab === "products" && <TopMartProductsTab />}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
      <ShopDrawer shopId={shopId} onClose={() => setShopId(null)} />
    </div>
  );
}
