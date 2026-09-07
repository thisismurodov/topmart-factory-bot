    res.setHeader(
      "Content-Disposition",
      `attachment; filename="tahlil_${fromDate}_${toDate}.xlsx"`
    );
    await wb.xlsx.write(res);
    res.end();
    return;
  }

  // ── CSV format (odatiy) ────────────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push(`Davr,${csvEsc(fromDate)},${csvEsc(toDate)}`);
  lines.push("");
  lines.push("Kunlik hisobot");
  lines.push("Sana,Tashriflar (do'kon),Savdo soni,Savdo summasi (so'm)");
  for (const r of dailyRows) {
    lines.push(`${r.date},${r.visits},${r.sales},${r.salesTotal}`);
  }

  lines.push("");
  lines.push("Agent KPI");
  lines.push("Agent,Kirilgan do'konlar,Sotib olgan do'konlar,Konversiya %,Takroriy %,Nasiya %,Savdo soni,Savdo summasi (so'm)");
  for (const a of agentKpi) {
    lines.push(
      `${csvEsc(a.name)},${a.visited},${a.sold},${a.conv ?? ""},${a.rep ?? ""},${a.nas ?? ""},${a.salesCount},${a.salesTotal}`
    );
  }

  const csv = "\uFEFF" + lines.join("\r\n") + "\r\n";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="tahlil_${fromDate}_${toDate}.csv"`
  );
  res.send(csv);
});

// ── Issiqlik xaritasi (heatmap) ──────────────────────────────────────────────────
// agentId/viloyat/hudud/search filtrlari (sana yo'q — joriy holat ko'rsatiladi).
// Har bir do'kon uchun oxirgi xariddan o'tgan kunlar soni va rang sinfi:
//   green  — 1–14 kun (faol)
//   yellow — 15–30 kun (sovumoqda)
//   red    — 31+ kun   (yo'qotish xavfi)
//   new    — hech qachon xarid qilmagan
// Hudud (tuman) darajasida jamlangan statistika va qo'l centroid ham qaytadi.
router.get("/distribution/heatmap", async (req, res): Promise<void> => {
  const f = parseFilters(req);
  const params: unknown[] = [];
  const w = shopsWhere(f, params);

  const { rows: shopRows } = await pool.query(
    `SELECT
       d.id, d.nomi, d.viloyat, d.hudud,
       d.latitude, d.longitude,
       d.agent_id::text AS agent_id,
       u.name AS agent_name,
       COALESCE(
         NULLIF(substr(d.last_order_date,1,10),'')::date,
         NULL
       ) AS last_order,
       (now() AT TIME ZONE 'Asia/Tashkent')::date AS today,
       -- avg_repeat_days: har do'konning odatiy xarid takrorlash kadansi
       -- 0 → tarix yo'q yoki yagona xarid (fallback fixed thresholds ishlaydi)
       COALESCE(
         (SELECT ROUND(AVG(cur - prev))::int
            FROM (
              SELECT LAG(substr(s2.created_at,1,10)::date)
                       OVER (ORDER BY s2.created_at)      AS prev,
                     substr(s2.created_at,1,10)::date     AS cur
                FROM distribution.savdolar s2
               WHERE s2.dokon_id = d.id
            ) gaps
           WHERE prev IS NOT NULL
             AND (cur - prev) BETWEEN 1 AND 90
         ), 0
       )::int AS avg_repeat_days
     FROM distribution.dokonlar d
     LEFT JOIN distribution.users u ON u.telegram_id = d.agent_id
     WHERE d.holat = 'faol' AND d.latitude IS NOT NULL AND d.longitude IS NOT NULL${w}
     ORDER BY d.id`,
    params
  );

  // Har bir do'kon uchun sinf va kunlar hisobi
  // Tasniflash — kadans asosida (avg_repeat_days > 0 bo'lsa):
  //   green  — days <= avg_repeat_days          (odatiy davr ichida)
  //   yellow — days <= avg_repeat_days * 2      (birozgina kechikkan)
  //   red    — days >  avg_repeat_days * 2      (sezilarli kechikkan)
  // Kadans tarixsiz do'konlar uchun fallback: green ≤14, yellow ≤30, red >30.
  type ShopRow = {
    id: number; nomi: string | null; viloyat: string | null; hudud: string | null;
    lat: number; lng: number; agentId: string | null; agentName: string | null;
    days: number | null; avgRepeatDays: number; cls: "green" | "yellow" | "red" | "new";
  };
  const shops: ShopRow[] = shopRows.map((r) => {
    let days: number | null = null;
    let cls: "green" | "yellow" | "red" | "new" = "new";
    const avgRepeatDays = Number(r.avg_repeat_days) || 0;
    if (r.last_order) {
      const lo = new Date(r.last_order as string);
      const tod = new Date(r.today as string);
      days = Math.round((tod.getTime() - lo.getTime()) / 86400000);
      if (avgRepeatDays > 0) {
        // Kadans asosida: birinchi kadans — yashil, ikkinchi kadans — sariq, undan oshsa — qizil
        cls = days <= avgRepeatDays ? "green" : days <= avgRepeatDays * 2 ? "yellow" : "red";
      } else {
        // Fallback fixed: ≤14 kun → yashil, ≤30 kun → sariq, 31+ kun → qizil
        cls = days <= 14 ? "green" : days <= 30 ? "yellow" : "red";
      }
    }
    return {
      id: r.id as number,
      nomi: r.nomi as string | null,
      viloyat: r.viloyat as string | null,
      hudud: r.hudud as string | null,
      lat: Number(r.latitude),
      lng: Number(r.longitude),
      agentId: r.agent_id as string | null,
      agentName: r.agent_name as string | null,
      days,
      avgRepeatDays,
      cls,
    };
  });

  // Hudud darajasida jamlash — centroid o'rtacha koordinata
  type HududKey = string;
  const hudMap = new Map<HududKey, {
    viloyat: string | null; hudud: string | null;
    shopCount: number; green: number; yellow: number; red: number; new: number;
    latSum: number; lngSum: number;
  }>();
  for (const s of shops) {
    const key: HududKey = `${s.viloyat ?? ""}|${s.hudud ?? ""}`;
    let h = hudMap.get(key);
    if (!h) {
      h = { viloyat: s.viloyat, hudud: s.hudud, shopCount: 0, green: 0, yellow: 0, red: 0, new: 0, latSum: 0, lngSum: 0 };
      hudMap.set(key, h);
    }
    h.shopCount++;
    h[s.cls]++;
    h.latSum += s.lat;
    h.lngSum += s.lng;
  }

  // Hudud sinfi — ko'pchilik do'konlar qaysi rangda bo'lsa, o'sha
  const hududlar = Array.from(hudMap.values()).map((h) => {
    const clsScores: ["green", "yellow", "red", "new"] = ["green", "yellow", "red", "new"];
    const dominant = clsScores.reduce((best, c) => (h[c] > h[best] ? c : best), "green" as "green" | "yellow" | "red" | "new");
    return {
      viloyat: h.viloyat,
      hudud: h.hudud,
      shopCount: h.shopCount,
      green: h.green,
      yellow: h.yellow,
      red: h.red,
      new: h.new,
      cls: dominant,
      centroid: h.shopCount > 0
        ? { lat: Math.round((h.latSum / h.shopCount) * 100000) / 100000, lng: Math.round((h.lngSum / h.shopCount) * 100000) / 100000 }
        : null,
    };
  });

  res.json({ shops, hududlar });
});

// ── AI tavsiyalar (LLM reyting) ─────────────────────────────────────────────────
// Nomzod do'konlar (overdue + qaytish + marshrut) LLM'ga beriladi; u biznes
// kontekst asosida ustuvorlik beradi va har biriga qisqa o'zbekcha izoh yozadi.
// Xato bo'lsa — jimgina rule-based natijaga qaytiladi (ai: null).
type AiCandidate = {
  dokonId: number;
  nomi: string | null;
  hudud: string | null;
  agentName: string | null;
  days: number | null;          // oxirgi xariddan beri kunlar
  avgRepeatDays: number | null; // o'rtacha takror interval (kun)
  nasiya: number;               // qarz qoldig'i (so'm)
  distKm: number | null;        // agent GPS'idan masofa
  tartib: number | null;        // bugungi marshrutdagi tartib
  qaytishSanasi: string | null; // va'da qilingan qaytish sanasi
  sabab: string | null;         // oxirgi olmaslik sababi
};
export type AiSuggestion = {
  dokonId: number;
  nomi: string | null;
  hudud: string | null;
  agentName: string | null;
  score: number;   // 0-100 ustuvorlik
  reason: string;  // qisqa o'zbekcha izoh
};

const AI_SUGGEST_MODEL = "gpt-5-mini";
const AI_SUGGEST_TTL_MS = 10 * 60 * 1000; // 10 daqiqa kesh — har refetch'da LLM chaqirilmaydi
const aiSuggestCache = new Map<string, { at: number; items: AiSuggestion[] }>();

const AI_SUGGEST_SYSTEM = `Sen TopMart distribyutsiya kompaniyasining savdo tahlilchisisan. Senga bugun tashrif buyurish mumkin bo'lgan nomzod do'konlar ro'yxati JSON ko'rinishida beriladi. Har bir do'kon uchun maydonlar:
- days: oxirgi xariddan beri o'tgan kunlar
- avgRepeatDays: do'konning o'rtacha xarid intervali (kun, 0 = tarix yo'q)
- nasiya: qarz qoldig'i (so'm)
- distKm: agentning hozirgi GPS joyidan masofa (km, null = noma'lum)
- tartib: bugungi marshrutdagi tartib raqami (null = marshrutda emas)
- qaytishSanasi: do'kon "keyin keling" degan sana
- sabab: oxirgi olmaslik sababi kodi

Vazifang: eng muhim 10 tagacha do'konni tanlab, ustuvorlik bo'yicha tartibla.
Mezonlar: odatiy intervalidan qancha ko'p kechikkani (days vs avgRepeatDays) eng muhim; katta nasiya qarzi ustuvorlikni oshiradi (pul yig'ish kerak); qaytish sanasi kelganlar muhim; yaqin masofa va marshrutdagi kichik tartib qulaylik beradi.

FAQAT quyidagi JSON formatda javob ber, boshqa hech narsa yozma:
{"items":[{"dokonId":123,"score":95,"reason":"..."}]}
reason — 1 jumlali qisqa o'zbekcha izoh, masalan: "3 haftadan beri olmayapti, odatda 10 kunda bir oladi, 2.4 mln nasiyasi bor". Raqamlarni o'zgartirma, faqat berilgan ma'lumotdan foydalan.`;

// AI reytingidan bugun allaqachon tashrif buyurilgan do'konlarni chiqarib
// tashlaydi (savdolar YOKI olmagan_dokonlar qatori bugun paydo bo'lgan bo'lsa).
// Kesh TTL ichida ham har javob oldidan chaqiriladi — shunda agent do'konga
// kirgan zahoti tavsiya kartadan yo'qoladi.
export async function filterVisitedToday(
  items: AiSuggestion[] | null,
  today: string
): Promise<AiSuggestion[] | null> {
  if (!items || items.length === 0) return items;
  const ids = items.map((it) => it.dokonId);
  const { rows } = await pool.query(
    `SELECT DISTINCT v.dokon_id FROM (
       SELECT s.dokon_id FROM distribution.savdolar s
        WHERE s.dokon_id = ANY($1::bigint[]) AND substr(s.created_at,1,10) = $2
       UNION ALL
       SELECT o.dokon_id FROM distribution.olmagan_dokonlar o
        WHERE o.dokon_id = ANY($1::bigint[]) AND substr(o.created_at,1,10) = $2
     ) v`,
    [ids, today]
  );
  if (rows.length === 0) return items;
  const visited = new Set(rows.map((r) => Number(r.dokon_id)));
  return items.filter((it) => !visited.has(it.dokonId));
}

async function rankWithAi(cacheKey: string, candidates: AiCandidate[]): Promise<AiSuggestion[] | null> {
  if (candidates.length === 0) return [];
  const cached = aiSuggestCache.get(cacheKey);
  if (cached && Date.now() - cached.at < AI_SUGGEST_TTL_MS) return cached.items;
  // Xotira keshi bo'sh (masalan, server endi restart bo'ldi yoki boshqa instans
  // hisoblab qo'ygan) — LLM'ni chaqirishdan OLDIN DB nusxasi tekshiriladi.
  // TTL bir xil 10 daqiqa; eskirgan sanani ko'rsatmaslik uchun kesh kaliti
  // tarkibida sana ham bor. Xato bo'lsa jimgina LLM yo'liga o'tiladi.
  try {
    const { rows } = await pool.query(
      `SELECT items, (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS at_ms
         FROM distribution.ai_suggest_cache
        WHERE cache_key = $1
          AND created_at > NOW() - make_interval(secs => $2)`,
      [cacheKey, AI_SUGGEST_TTL_MS / 1000]
    );
    if (rows.length > 0) {
      const dbItems = JSON.parse(String(rows[0].items)) as unknown;
      if (Array.isArray(dbItems)) {
        const items = dbItems as AiSuggestion[];
        aiSuggestCache.set(cacheKey, { at: Number(rows[0].at_ms), items });
        return items;
      }
    }
  } catch {
    // DB keshi ishlamasa ham tavsiya oqimi to'xtamaydi — LLM chaqiriladi
  }
  try {
    const completion = await openai.chat.completions.create({
      model: AI_SUGGEST_MODEL,
      max_completion_tokens: 8192,
      reasoning_effort: "minimal",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: AI_SUGGEST_SYSTEM },
        { role: "user", content: JSON.stringify({ candidates }) },
      ],
    });
    const raw = completion.choices[0]?.message?.content?.trim() || "";
    const parsed = JSON.parse(raw) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return null;
    const byId = new Map(candidates.map((c) => [c.dokonId, c]));
    const items: AiSuggestion[] = [];
    for (const it of parsed.items as Record<string, unknown>[]) {
      const c = byId.get(Number(it.dokonId));
      if (!c || typeof it.reason !== "string" || it.reason.trim() === "") continue;
      items.push({
        dokonId: c.dokonId,
        nomi: c.nomi,
        hudud: c.hudud,
        agentName: c.agentName,
        score: Math.max(0, Math.min(100, Math.round(Number(it.score) || 0))),
        reason: it.reason.trim(),
      });
      if (items.length >= 10) break;
    }
    aiSuggestCache.set(cacheKey, { at: Date.now(), items });
    // DB nusxasi — restartdan keyin va boshqa instanslar uchun (best-effort).
    // Eski kunlarning kalitlari qayta ishlatilmaydi, shuning uchun yozish
    // paytida 1 kundan eski qatorlar tozalab yuboriladi.
    try {
      await pool.query(
        `INSERT INTO distribution.ai_suggest_cache (cache_key, items, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (cache_key) DO UPDATE SET items = EXCLUDED.items, created_at = NOW()`,
        [cacheKey, JSON.stringify(items)]
      );
      await pool.query(
        `DELETE FROM distribution.ai_suggest_cache WHERE created_at < NOW() - interval '1 day'`
      );
    } catch {
      // Persist xatosi natijaga ta'sir qilmaydi — xotira keshi baribir to'ldi
    }
    return items;
  } catch {
    // Jimgina fallback — rule-based tavsiyalar baribir ko'rsatiladi
    return null;
  }
}

// ── Smart Suggestions (rule-based tavsiyalar) ────────────────────────────────────
// 3 turdagi tavsiya:
//   agents  — GPS jo'natgan agentlarga eng yaqin, bugun hali kirilmagan do'konlar
//   overdue — oxirgi xariddan beri odatdagidan ko'p vaqt o'tgan do'konlar (30+ kun)
//   qaytish — olmagan_dokonlar.qaytish_sanasi <= bugun va bajarildi NULL (yoki 0)
// agentId/viloyat/hudud filtrlari qo'llanadi.
// ALOHIDA router: bu endpoint dashboard (Bearer session) BILAN BIRGA savdo bot
// (x-internal-key) tomonidan ham chaqiriladi — index.ts'da requireAuthOrInternalKey
// bilan auth wall'dan OLDIN mount qilinadi. 10 daqiqalik AI kesh ikkala mijoz
// uchun umumiy (cacheKey — sana + filtrlar).
export const distributionSuggestionsRouter: IRouter = Router();
distributionSuggestionsRouter.get("/distribution/suggestions", async (req, res): Promise<void> => {
  const f = parseFilters(req);

  const dQ = await pool.query(
    `SELECT to_char(now() AT TIME ZONE 'Asia/Tashkent','YYYY-MM-DD') AS today,
            EXTRACT(ISODOW FROM (now() AT TIME ZONE 'Asia/Tashkent'))::int AS dow`
  );
  const today = dQ.rows[0].today as string;
  const dow = dQ.rows[0].dow as number;

  // Filtr parametrlari
  const geoParams: unknown[] = [];
  const geoW = shopsWhere(f, geoParams);

  // 1. Kechikkan do'konlar — 30+ kun xarid yo'q, har do'kon uchun o'rtacha takror interval.
  // avg_repeat_days: LAG oynasi orqali ketma-ket savdolar orasidagi kunlar soni o'rtachasi;
  // (cur - prev) ifodasi to'g'ridan-to'g'ri ishlatiladi — alohida alias talab etilmaydi.
  const overdueParams: unknown[] = [...geoParams];
  const { rows: overdueRows2 } = await pool.query(
    `SELECT t.dokon_id, t.nomi, t.viloyat, t.hudud, t.agent_name, t.days,
            t.avg_repeat_days
     FROM (
       SELECT d.id AS dokon_id, d.nomi, d.viloyat, d.hudud,
              u.name AS agent_name,
              ((now() AT TIME ZONE 'Asia/Tashkent')::date -
               COALESCE(
                 NULLIF(substr(d.last_order_date,1,10),'')::date,
                 NULLIF(substr(d.created_at,1,10),'')::date
               ))::int AS days,
              COALESCE(
                (SELECT ROUND(AVG(cur - prev))::int
                   FROM (
                     SELECT LAG(substr(s2.created_at,1,10)::date) OVER (ORDER BY s2.created_at) AS prev,
                            substr(s2.created_at,1,10)::date                                    AS cur
                       FROM distribution.savdolar s2
                      WHERE s2.dokon_id = d.id
                   ) gaps
                  WHERE prev IS NOT NULL
                    AND (cur - prev) BETWEEN 1 AND 90
                ), 0
              )::int AS avg_repeat_days
         FROM distribution.dokonlar d
         LEFT JOIN distribution.users u ON u.telegram_id = d.agent_id
        WHERE d.holat = 'faol'${geoW}
          AND COALESCE(
                NULLIF(substr(d.last_order_date,1,10),'')::date,
                NULLIF(substr(d.created_at,1,10),'')::date
              ) IS NOT NULL
     ) t
     WHERE t.days > CASE
                      WHEN t.avg_repeat_days > 0 THEN t.avg_repeat_days
                      ELSE 30           -- tarix yo'q: fallback 30 kun
                    END
     ORDER BY t.days DESC
     LIMIT 20`,
    overdueParams
  );

  // 2. Qaytish sanasi kelgan "olmagan" do'konlar (bajarildi NULL yoki 0)
  // MUHIM ARXITEKTURA: avval har do'kon uchun ENG SO'NGGI olmagan tashrif tanlanadi (CTE),
  // shundan keyingina sana/bajarildi/keyingi savdo filtrlari qo'llanadi.
  // Bu yondashuv eski past-due qatorni kelajakdagi/bajarilgan eng yangi qator ortida
  // yashirib qolish muammosini bartaraf etadi.
  const qaytishP: unknown[] = [today, ...geoParams];
  let qaytishW = geoW.replace(/\$(\d+)/g, (m, n) => `$${Number(n) + 1}`);
  const { rows: qaytishRows } = await pool.query(
    `WITH latest_per_shop AS (
       SELECT DISTINCT ON (o.dokon_id)
              o.id, o.dokon_id, o.sabab, o.sabab_text, o.qaytish_sanasi,
              o.bajarildi, o.agent_id, o.created_at
         FROM distribution.olmagan_dokonlar o
        ORDER BY o.dokon_id, o.created_at DESC
     )
     SELECT lps.dokon_id, d.nomi, d.viloyat, d.hudud,
            u.name AS agent_name,
            lps.sabab, lps.sabab_text, lps.qaytish_sanasi,
            lps.qaytish_sanasi AS due_iso
       FROM latest_per_shop lps
       JOIN distribution.dokonlar d ON d.id = lps.dokon_id
       LEFT JOIN distribution.users u ON u.telegram_id = lps.agent_id
      WHERE lps.qaytish_sanasi IS NOT NULL
        AND (lps.bajarildi IS NULL OR lps.bajarildi = 0)
        AND (
          CASE
            -- DD.MM.YYYY: regex + calendar check (day <= last day of that month)
            WHEN lps.qaytish_sanasi ~ '^(0[1-9]|[12][0-9]|3[01])[.](0[1-9]|1[0-2])[.][12][0-9]{3}$'
              AND substr(lps.qaytish_sanasi,1,2)::int <=
                  EXTRACT(DAY FROM (
                    make_date(substr(lps.qaytish_sanasi,7,4)::int,
                              substr(lps.qaytish_sanasi,4,2)::int, 1)
                    + make_interval(months=>1) - interval '1 day'))::int
            THEN make_date(substr(lps.qaytish_sanasi,7,4)::int,
                           substr(lps.qaytish_sanasi,4,2)::int,
                           substr(lps.qaytish_sanasi,1,2)::int)
            -- ISO YYYY-MM-DD: regex + calendar check
            WHEN lps.qaytish_sanasi ~ '^[12][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
              AND substr(lps.qaytish_sanasi,9,2)::int <=
                  EXTRACT(DAY FROM (
                    make_date(substr(lps.qaytish_sanasi,1,4)::int,
                              substr(lps.qaytish_sanasi,6,2)::int, 1)
                    + make_interval(months=>1) - interval '1 day'))::int
            THEN make_date(substr(lps.qaytish_sanasi,1,4)::int,
                           substr(lps.qaytish_sanasi,6,2)::int,
                           substr(lps.qaytish_sanasi,9,2)::int)
            ELSE NULL
          END
        ) <= $1::date
        -- Keyinchalik savdo bo'lgan do'konlarni chiqarish (konvertatsiya amalga oshgan)
        AND NOT EXISTS (
          SELECT 1 FROM distribution.savdolar s
           WHERE s.dokon_id = lps.dokon_id
             AND s.created_at >= lps.created_at
        )${qaytishW}
      ORDER BY lps.dokon_id
      LIMIT 30`,
    qaytishP
  );

  // 3. Agentlarning bugungi GPS joyi → yaqin do'konlar (Haversine)
  // Bugun GPS jo'natgan agentlar (oxirgi koordinata)
  const agentLocP: unknown[] = [today];
  let agentLocW = "";
  if (f.agentId) { agentLocP.push(f.agentId); agentLocW += ` AND al.agent_id = $${agentLocP.length}`; }
  const { rows: locRows } = await pool.query(
    `SELECT DISTINCT ON (al.agent_id) al.agent_id, al.latitude, al.longitude, al.created_at,
            da.name AS agent_name, da.mashina_nomeri,
            da.telegram_id
       FROM distribution.agent_locations al
       JOIN distribution.delivery_agents da ON da.telegram_id = al.agent_id
      WHERE substr(al.created_at,1,10) = $1 AND da.faol = 1${agentLocW}
      ORDER BY al.agent_id, al.created_at DESC`,
    agentLocP
  );

  // Bugungi marshrut do'konlari (koordinatali, hali kirilmagan)
  const routeP: unknown[] = [dow, today];
  let routeW = "";
  if (f.agentId) { routeP.push(f.agentId); routeW += ` AND da.telegram_id = $${routeP.length}`; }
  const { rows: routeShops } = await pool.query(
    `SELECT r.tartib, d.id AS dokon_id, d.nomi, d.hudud,
            d.latitude, d.longitude, da.telegram_id AS agent_telegram_id
       FROM distribution.delivery_routes r
       JOIN distribution.delivery_agents da ON da.id = r.delivery_agent_id
       JOIN distribution.dokonlar d ON d.id = r.dokon_id
      WHERE r.kun = $1 AND da.faol = 1
        AND d.latitude IS NOT NULL AND d.longitude IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM distribution.savdolar s
                         WHERE s.dokon_id = d.id AND substr(s.created_at,1,10) = $2)
        AND NOT EXISTS (SELECT 1 FROM distribution.olmagan_dokonlar o
                         WHERE o.dokon_id = d.id AND substr(o.created_at,1,10) = $2)${routeW}
      ORDER BY r.tartib`,
    routeP
  );

  // Haversine masofasi (km) — JS da hisoblaymiz
  function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return Math.round(R * 2 * Math.asin(Math.sqrt(a)) * 10) / 10;
  }

  // Har agent uchun eng yaqin 3 ta marshrutdagi do'kon
  const agentSuggestions = locRows
    .map((loc) => {
      const agentShops = routeShops.filter(
        (rs) => rs.agent_telegram_id === loc.agent_id
      );
      const nearest = agentShops
        .map((rs) => ({
          dokonId: rs.dokon_id as number,
          nomi: rs.nomi as string | null,
          hudud: rs.hudud as string | null,
          tartib: rs.tartib as number | null,
          distKm: haversine(
            Number(loc.latitude), Number(loc.longitude),
            Number(rs.latitude), Number(rs.longitude)
          ),
        }))
        .sort((a, b) => a.distKm - b.distKm)
        .slice(0, 3);

      if (nearest.length === 0) return null;
      return {
        agentId: String(loc.agent_id),
        agentName: loc.agent_name as string | null,
        mashinaNomeri: loc.mashina_nomeri as string | null,
        gps: { lat: Number(loc.latitude), lng: Number(loc.longitude), at: loc.created_at as string },
        nearest,
      };
    })
    .filter(Boolean);

  // ── AI rejimi (?ai=1) — nomzodlarni yig'ib LLM'dan reyting so'raymiz ─────────
  const q = req.query as Record<string, unknown>;
  const wantAi = q.ai === "1" || q.ai === "true";
  let ai: AiSuggestion[] | null = null;
  if (wantAi) {
    // Nomzodlar: kechikkanlar + qaytish sanasi kelganlar + bugungi marshrutdagilar
    const candMap = new Map<number, AiCandidate>();
    for (const r of overdueRows2) {
      candMap.set(Number(r.dokon_id), {
        dokonId: Number(r.dokon_id),
        nomi: r.nomi as string | null,
        hudud: r.hudud as string | null,
        agentName: r.agent_name as string | null,
        days: Number(r.days),
        avgRepeatDays: Number(r.avg_repeat_days) || 0,
        nasiya: 0,
        distKm: null,
        tartib: null,
        qaytishSanasi: null,
        sabab: null,
      });
    }
    for (const r of qaytishRows) {
      const id = Number(r.dokon_id);
      const c = candMap.get(id);
      if (c) {
        c.qaytishSanasi = r.qaytish_sanasi as string | null;
        c.sabab = r.sabab as string | null;
      } else {
        candMap.set(id, {
          dokonId: id,
          nomi: r.nomi as string | null,
          hudud: r.hudud as string | null,
          agentName: r.agent_name as string | null,
          days: null,
          avgRepeatDays: null,
          nasiya: 0,
          distKm: null,
          tartib: null,
          qaytishSanasi: r.qaytish_sanasi as string | null,
          sabab: r.sabab as string | null,
        });
      }
    }
    // Marshrutdagi kirilmagan do'konlar — tartib + agent GPS'idan masofa
    const locByAgent = new Map(locRows.map((l) => [String(l.agent_id), l]));
    for (const rs of routeShops) {
      const id = Number(rs.dokon_id);
      const loc = locByAgent.get(String(rs.agent_telegram_id));
      const distKm = loc
        ? haversine(Number(loc.latitude), Number(loc.longitude), Number(rs.latitude), Number(rs.longitude))
        : null;
      const c = candMap.get(id);
      if (c) {
        c.tartib = rs.tartib as number | null;
        if (distKm != null) c.distKm = distKm;
      } else if (candMap.size < 60) {
        candMap.set(id, {
          dokonId: id,
          nomi: rs.nomi as string | null,
          hudud: rs.hudud as string | null,
          agentName: null,
          days: null,
          avgRepeatDays: null,
          nasiya: 0,
          distKm,
          tartib: rs.tartib as number | null,
          qaytishSanasi: null,
          sabab: null,
        });
      }
    }
    // Nasiya qoldiqlari — bitta so'rovda barcha nomzodlar uchun
    const candIds = Array.from(candMap.keys());
    if (candIds.length > 0) {
      const { rows: nasRows } = await pool.query(
        `SELECT n.dokon_id, SUM(n.qoldiq)::bigint AS qoldiq
           FROM distribution.nasiya n
          WHERE n.qoldiq > 0 AND n.dokon_id = ANY($1::bigint[])
          GROUP BY n.dokon_id`,
        [candIds]
      );
      for (const nr of nasRows) {
        const c = candMap.get(Number(nr.dokon_id));
        if (c) c.nasiya = Number(nr.qoldiq);
      }
    }
    const cacheKey = `${today}|${f.agentId ?? ""}|${f.viloyat ?? ""}|${f.hudud ?? ""}|${f.search ?? ""}`;
    ai = await rankWithAi(cacheKey, Array.from(candMap.values()));
    // Keshdagi reyting eskirgan bo'lishi mumkin: agent tavsiya etilgan do'konga
    // bugun kirib bo'lgan bo'lsa (savdolar yoki olmagan_dokonlar qatori paydo
    // bo'lsa), o'sha do'kon kartada qolmasligi kerak. Shu sababli har javobdan
    // oldin AI natijasi bugungi tashriflarga qarshi qayta filtrlanadi.
    ai = await filterVisitedToday(ai, today);
  }

  res.json({
    date: today,
    kun: dow,
    ai, // AI reyting (null — AI so'ralmagan yoki xato/fallback)
    agents: agentSuggestions,
    overdue: overdueRows2.map((r) => ({
      dokonId: r.dokon_id,
      nomi: r.nomi,
      viloyat: r.viloyat,
      hudud: r.hudud,
      agentName: r.agent_name,
      days: r.days,
      avgRepeatDays: r.avg_repeat_days,
    })),
    qaytish: qaytishRows.map((r) => ({
      dokonId: r.dokon_id,
      nomi: r.nomi,
      viloyat: r.viloyat,
      hudud: r.hudud,
      agentName: r.agent_name,
      sabab: r.sabab,
      sababText: r.sabab_text,
      qaytishSanasi: r.qaytish_sanasi,
      dueIso: r.due_iso,
    })),
  });
});

// ── Kunlik tashriflar — har bir agent uchun bugungi/tanlangan kun progressi ──────
// field_ops jadvalini asosiy manba sifatida ishlatadi; savdolar/olmagan_dokonlar
// bilan boyitadi. Har bir agent uchun: planned (marshrut), visited, sold, noSale;
// har bir stop uchun: dokon, natija (sold/nosale/payment), sabab, GPS nuqtasi.
router.get("/distribution/daily-visits", async (req, res): Promise<void> => {
  const f = parseFilters(req);
  const q = req.query as Record<string, unknown>;
  const dateRaw = typeof q.date === "string" && DATE_RE.test(q.date) ? q.date : null;

  const dQ = await pool.query(
    `SELECT COALESCE($1::text, to_char(now() AT TIME ZONE 'Asia/Tashkent','YYYY-MM-DD')) AS d,
            EXTRACT(ISODOW FROM COALESCE($1::text::date, (now() AT TIME ZONE 'Asia/Tashkent')::date))::int AS dow`,
    [dateRaw]
  );
  const date = dQ.rows[0].d as string;
  const dow = dQ.rows[0].dow as number;

  const params: unknown[] = [date, dow];
  let agentW = "";
  let shopW = "";
  let agentIdx = 0; // agentId parametrining $-indeksi (0 = filtr yo'q)
  if (f.agentId) {
    params.push(f.agentId);
    agentIdx = params.length;
    agentW += ` AND da.telegram_id = $${agentIdx}`;
  }
  // savdolar/olmagan/pul_olish jadvallarida agent telegram_id `agent_id` ustunida —
  // `da` aliasisiz subquery'larda shu yordamchi ishlatiladi
  const aW = (alias: string): string => (agentIdx ? ` AND ${alias}.agent_id = $${agentIdx}` : "");
  if (f.viloyat) {
    params.push(f.viloyat);
    shopW += ` AND dk.viloyat = $${params.length}`;
  }
  if (f.hudud) {
    params.push(f.hudud);
    shopW += ` AND dk.hudud = $${params.length}`;
  }

  // 1. Per-agent summary: planned from routes + visited from field_ops activity
  const summaryQ = pool.query(
    `WITH route_counts AS (
       SELECT da.id AS agent_id,
              COUNT(*)::int AS planned
         FROM distribution.delivery_routes r
         JOIN distribution.delivery_agents da ON da.id = r.delivery_agent_id
         JOIN distribution.dokonlar dk ON dk.id = r.dokon_id
        WHERE r.kun = $2 AND da.faol = 1${agentW}${shopW}
        GROUP BY da.id
     ),
     sales_agg AS (
       SELECT s.agent_id,
              COUNT(DISTINCT s.dokon_id)::int AS sold_shops,
              SUM(s.jami_summa)               AS sales_total,
              COUNT(*)::int                   AS sales_count
         FROM distribution.savdolar s
         JOIN distribution.dokonlar dk ON dk.id = s.dokon_id
        WHERE substr(s.created_at,1,10) = $1${aW("s")}${shopW}
        GROUP BY s.agent_id
     ),
     nosale_agg AS (
       SELECT o.agent_id,
              COUNT(DISTINCT o.dokon_id)::int AS nosale_shops
         FROM distribution.olmagan_dokonlar o
         JOIN distribution.dokonlar dk ON dk.id = o.dokon_id
        WHERE substr(o.created_at,1,10) = $1${aW("o")}${shopW}
        GROUP BY o.agent_id
     ),
     payment_agg AS (
       SELECT p.agent_id,
              COUNT(DISTINCT p.dokon_id)::int AS payment_only_shops
         FROM distribution.pul_olish p
         JOIN distribution.dokonlar dk ON dk.id = p.dokon_id
        WHERE substr(p.created_at,1,10) = $1${aW("p")}${shopW}
          AND NOT EXISTS (
            SELECT 1 FROM distribution.savdolar s2
             WHERE s2.dokon_id = p.dokon_id
               AND s2.agent_id = p.agent_id
               AND substr(s2.created_at,1,10) = $1
          )
          AND NOT EXISTS (
            SELECT 1 FROM distribution.olmagan_dokonlar o2
             WHERE o2.dokon_id = p.dokon_id
               AND o2.agent_id = p.agent_id
               AND substr(o2.created_at,1,10) = $1
          )
        GROUP BY p.agent_id
     )
     SELECT da.id, da.name, da.mashina_nomeri, da.hudud,
            COALESCE(rc.planned,0)::int                                             AS planned,
            (COALESCE(sa.sold_shops,0) + COALESCE(na.nosale_shops,0)
             + COALESCE(pa.payment_only_shops,0))::int                              AS visited,
            COALESCE(sa.sold_shops,0)::int                                          AS sold,
            COALESCE(na.nosale_shops,0)::int                                        AS no_sale,
            COALESCE(sa.sales_total,0)                                              AS sales_total,
            COALESCE(sa.sales_count,0)::int                                         AS sales_count
       FROM distribution.delivery_agents da
       LEFT JOIN route_counts rc   ON rc.agent_id  = da.id
       LEFT JOIN sales_agg    sa   ON sa.agent_id  = da.telegram_id
       LEFT JOIN nosale_agg   na   ON na.agent_id  = da.telegram_id
       LEFT JOIN payment_agg  pa   ON pa.agent_id  = da.telegram_id
      WHERE da.faol = 1${agentW}
        AND (rc.agent_id IS NOT NULL OR sa.agent_id IS NOT NULL
             OR na.agent_id IS NOT NULL OR pa.agent_id IS NOT NULL)
      ORDER BY da.name`,
    params
  );

  // 2. Per-stop detail: all visits (sale + nosale + payment-only) for the day
  const stopsQ = pool.query(
    `WITH sold_stops AS (
       SELECT DISTINCT ON (s.agent_id, s.dokon_id)
              s.agent_id, s.dokon_id, 'sold' AS outcome,
              NULL::text AS sabab, NULL::text AS sabab_text,
              NULL::text AS qaytish_sanasi,
              s.jami_summa AS sale_total,
              s.tolov_turi,
              s.created_at
         FROM distribution.savdolar s
         JOIN distribution.dokonlar dk ON dk.id = s.dokon_id
        WHERE substr(s.created_at,1,10) = $1${aW("s")}${shopW}
        ORDER BY s.agent_id, s.dokon_id, s.created_at DESC
     ),
     nosale_stops AS (
       SELECT DISTINCT ON (o.agent_id, o.dokon_id)
              o.agent_id, o.dokon_id, 'nosale' AS outcome,
              o.sabab, o.sabab_text, o.qaytish_sanasi,
              NULL::numeric AS sale_total,
              NULL::text AS tolov_turi,
              o.created_at
         FROM distribution.olmagan_dokonlar o
         JOIN distribution.dokonlar dk ON dk.id = o.dokon_id
        WHERE substr(o.created_at,1,10) = $1
          AND NOT EXISTS (
            SELECT 1 FROM distribution.savdolar s2
             WHERE s2.dokon_id = o.dokon_id AND s2.agent_id = o.agent_id
               AND substr(s2.created_at,1,10) = $1
          )${aW("o")}${shopW}
        ORDER BY o.agent_id, o.dokon_id, o.created_at DESC
     ),
     payment_stops AS (
       SELECT DISTINCT ON (p.agent_id, p.dokon_id)
              p.agent_id, p.dokon_id, 'payment' AS outcome,
              NULL::text AS sabab, NULL::text AS sabab_text,
              NULL::text AS qaytish_sanasi,
              p.summa AS sale_total,
              NULL::text AS tolov_turi,
              p.created_at
         FROM distribution.pul_olish p
         JOIN distribution.dokonlar dk ON dk.id = p.dokon_id
        WHERE substr(p.created_at,1,10) = $1
          AND NOT EXISTS (
            SELECT 1 FROM distribution.savdolar s2
             WHERE s2.dokon_id = p.dokon_id AND s2.agent_id = p.agent_id
               AND substr(s2.created_at,1,10) = $1
          )
          AND NOT EXISTS (
            SELECT 1 FROM distribution.olmagan_dokonlar o2
             WHERE o2.dokon_id = p.dokon_id AND o2.agent_id = p.agent_id
               AND substr(o2.created_at,1,10) = $1
          )${aW("p")}${shopW}
        ORDER BY p.agent_id, p.dokon_id, p.created_at DESC
     ),
     all_stops AS (
       SELECT * FROM sold_stops
       UNION ALL SELECT * FROM nosale_stops
       UNION ALL SELECT * FROM payment_stops
     )
     SELECT st.agent_id, da.id AS delivery_agent_id, da.name AS agent_name,
            st.dokon_id,
            dk.nomi AS dokon_name, dk.viloyat, dk.hudud, dk.telefon,
            dk.latitude, dk.longitude,
            st.outcome, st.sabab, st.sabab_text, st.qaytish_sanasi,
            st.sale_total, st.tolov_turi,
            st.created_at,
            EXISTS (SELECT 1 FROM distribution.delivery_routes r
                     JOIN distribution.delivery_agents da2 ON da2.id = r.delivery_agent_id
                    WHERE r.dokon_id = st.dokon_id AND r.kun = $2
                      AND da2.telegram_id = st.agent_id) AS on_route
       FROM all_stops st
       JOIN distribution.dokonlar dk ON dk.id = st.dokon_id
       LEFT JOIN distribution.delivery_agents da ON da.telegram_id = st.agent_id AND da.faol = 1
      ORDER BY da.name, st.created_at DESC`,
    params
  );

  // 3. No-sale reasons breakdown per agent — o'z parametrlar massivi
  // (umumiy params'da $2=dow ishlatilmagani uchun PG bind xatosi berardi)
  const rParams: unknown[] = [date];
  let rW = "";
  if (f.agentId) { rParams.push(f.agentId); rW += ` AND o.agent_id = $${rParams.length}`; }
  if (f.viloyat) { rParams.push(f.viloyat); rW += ` AND dk.viloyat = $${rParams.length}`; }
  if (f.hudud) { rParams.push(f.hudud); rW += ` AND dk.hudud = $${rParams.length}`; }
  const reasonsQ = pool.query(
    `SELECT da.id AS agent_id,
            COALESCE(o.sabab,'boshqa') AS sabab,
            COUNT(*)::int AS cnt
       FROM distribution.olmagan_dokonlar o
       JOIN distribution.dokonlar dk ON dk.id = o.dokon_id
       JOIN distribution.delivery_agents da ON da.telegram_id = o.agent_id AND da.faol = 1
      WHERE substr(o.created_at,1,10) = $1${rW}
      GROUP BY da.id, COALESCE(o.sabab,'boshqa')
      ORDER BY da.id, cnt DESC`,
    rParams
  );

  // 4. Agent GPS trail (breadcrumbs) — kun bo'yicha barcha nuqtalar, vaqt tartibida
  const trailP: unknown[] = [date];
  let trailW = "";
  if (f.agentId) {
    trailP.push(f.agentId);
    trailW = ` AND da.telegram_id = $${trailP.length}`;
  }
  const trailQ = pool.query(
    `SELECT da.id AS delivery_agent_id,
            al.latitude, al.longitude, al.created_at
       FROM distribution.agent_locations al
       JOIN distribution.delivery_agents da ON da.telegram_id = al.agent_id
      WHERE substr(al.created_at,1,10) = $1 AND da.faol = 1${trailW}
        AND al.latitude IS NOT NULL AND al.longitude IS NOT NULL
      ORDER BY da.id, al.created_at`,
    trailP
  );

  const [summary, stops, reasons, trail] = await Promise.all([summaryQ, stopsQ, reasonsQ, trailQ]);

  // Index trail points by delivery_agent_id
  const trailMap = new Map<number, { lat: number; lng: number; at: string | null }[]>();
  for (const t of trail.rows) {
    const k = t.delivery_agent_id as number;
    if (!trailMap.has(k)) trailMap.set(k, []);
    trailMap.get(k)!.push({
      lat: Number(t.latitude),
      lng: Number(t.longitude),
      at: t.created_at as string | null,
    });
  }

  // Index reasons by agent_id
  const reasonMap = new Map<number | string, { sabab: string; cnt: number }[]>();
  for (const r of reasons.rows) {
    const k = r.agent_id;
    if (!reasonMap.has(k)) reasonMap.set(k, []);
    reasonMap.get(k)!.push({ sabab: r.sabab as string, cnt: r.cnt as number });
  }

  // Index stops by delivery_agent_id
  const stopsMap = new Map<number | null, typeof stops.rows>();
  for (const s of stops.rows) {
    const k = s.delivery_agent_id as number | null;
    if (!stopsMap.has(k)) stopsMap.set(k, []);
    stopsMap.get(k)!.push(s);
  }

  res.json({
    date,
    kun: dow,
    agents: summary.rows.map((a) => ({
      agentId: a.id,
      agentName: a.name,
      mashinaNomeri: a.mashina_nomeri,
      hudud: a.hudud,
      planned: a.planned,
      visited: a.visited,
      sold: a.sold,
      noSale: a.no_sale,
      salesTotal: Number(a.sales_total),
      salesCount: a.sales_count,
      remaining: Math.max(0, a.planned - a.visited),
      reasons: reasonMap.get(a.id) ?? [],
      trail: trailMap.get(a.id) ?? [],
      stops: (stopsMap.get(a.id) ?? []).map((s) => ({
        dokonId: s.dokon_id,
        dokonName: s.dokon_name,
        viloyat: s.viloyat,
        hudud: s.hudud,
        telefon: s.telefon,
        lat: s.latitude != null ? Number(s.latitude) : null,
        lng: s.longitude != null ? Number(s.longitude) : null,
        outcome: s.outcome as "sold" | "nosale" | "payment",
        sabab: s.sabab as string | null,
        sababText: s.sabab_text as string | null,
        qaytishSanasi: s.qaytish_sanasi as string | null,
        saleTotal: s.sale_total != null ? Number(s.sale_total) : null,
        tolovTuri: s.tolov_turi as string | null,
        createdAt: s.created_at as string | null,
        onRoute: s.on_route as boolean,
      })),
    })),
  });
});

export default router;
