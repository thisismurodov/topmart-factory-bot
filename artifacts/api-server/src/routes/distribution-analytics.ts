import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { parseFilters, salesWhere, shopsWhere } from "./distribution";

// Distribution analitika, issiqlik xaritasi va qoida-asosidagi tavsiyalar.
// Barcha endpointlar faqat o'qish uchun (read-only). Sanalar TEXT ISO,
// summalar so'mda (UZS, bigint). "Bugun" — Asia/Tashkent kalendari bo'yicha.

const router: IRouter = Router();

// Do'konning "sog'lik" sinfi — bot'dagi get_store_status bilan bir xil qoida:
// last_order_date yo'q -> 'new'; avg_repeat_days<=0 -> 7/21 kun chegaralari;
// aks holda avg va 2*avg chegaralari (green/yellow/red).
const CLS_SQL = `
  CASE
    WHEN lod IS NULL THEN 'new'
    WHEN avg_days <= 0 THEN
      CASE WHEN days <= 7 THEN 'green' WHEN days <= 21 THEN 'yellow' ELSE 'red' END
    WHEN days <= avg_days THEN 'green'
    WHEN days <= avg_days * 2 THEN 'yellow'
    ELSE 'red'
  END`;

// ── Analitika KPI + kunlik seriya ───────────────────────────────────────────────
router.get("/distribution/analytics", async (req, res): Promise<void> => {
  const f = parseFilters(req);

  // Savdo KPI: soni, summasi, nasiya ulushi, sotilgan (distinct) do'konlar
  const sp: unknown[] = [];
  const sw = salesWhere(f, sp);
  const salesQ = pool.query(
    `SELECT COUNT(*)::int AS cnt,
            COALESCE(SUM(s.jami_summa),0)::bigint AS total,
            COUNT(*) FILTER (WHERE s.tolov_turi IN ('nasiya','aralash'))::int AS nasiya_cnt,
            COUNT(DISTINCT s.dokon_id)::int AS sold_shops
       FROM distribution.savdolar s
       JOIN distribution.dokonlar d ON d.id = s.dokon_id
      WHERE 1=1${sw}`,
    sp
  );

  // Takroriy xaridorlar: davrda olgan do'konlar ichida, davr ichidagi birinchi
  // savdosidan OLDIN ham savdosi bo'lganlar ulushi.
  const rp: unknown[] = [];
  const rw = salesWhere(f, rp);
  const repeatQ = pool.query(
    `WITH period_buyers AS (
       SELECT s.dokon_id, MIN(s.created_at) AS first_at
         FROM distribution.savdolar s
         JOIN distribution.dokonlar d ON d.id = s.dokon_id
        WHERE 1=1${rw}
        GROUP BY s.dokon_id
     )
     SELECT COUNT(*)::int AS buyers,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM distribution.savdolar s2
               WHERE s2.dokon_id = pb.dokon_id AND s2.created_at < pb.first_at))::int AS repeats
       FROM period_buyers pb`,
    rp
  );

  // Tashriflar (savdo YOKI "olmagan" yozuvi) — kunlik, distinct do'kon bo'yicha
  const vp: unknown[] = [];
  const visitPart = (table: string): string => {
    let w = "";
    if (f.from) {
      vp.push(f.from);
      w += ` AND substr(x.created_at,1,10) >= $${vp.length}`;
    }
    if (f.to) {
      vp.push(f.to);
      w += ` AND substr(x.created_at,1,10) <= $${vp.length}`;
    }
    if (f.agentId) {
      vp.push(f.agentId);
      w += ` AND x.agent_id = $${vp.length}`;
    }
    if (f.viloyat) {
      vp.push(f.viloyat);
      w += ` AND d.viloyat = $${vp.length}`;
    }
    if (f.hudud) {
      vp.push(f.hudud);
      w += ` AND d.hudud = $${vp.length}`;
    }
    if (f.search) {
      vp.push(`%${f.search}%`);
      w += ` AND d.nomi ILIKE $${vp.length}`;
    }
    return `SELECT substr(x.created_at,1,10) AS day, x.dokon_id
              FROM distribution.${table} x
              JOIN distribution.dokonlar d ON d.id = x.dokon_id WHERE 1=1${w}`;
  };
  // MUHIM: visitPart params massiviga push qiladi — union SQL faqat BIR marta quriladi
  const visitsUnion = `${visitPart("savdolar")} UNION ALL ${visitPart("olmagan_dokonlar")}`;
  const visitsQ = pool.query(
    `SELECT day, COUNT(DISTINCT dokon_id)::int AS visits
       FROM (${visitsUnion}) v
      GROUP BY day ORDER BY day`,
    vp
  );
  const distinctVisitedQ = pool.query(
    `SELECT COUNT(DISTINCT dokon_id)::int AS c FROM (${visitsUnion}) v`,
    vp
  );

  // Kunlik savdo seriyasi (grafik uchun)
  const dp: unknown[] = [];
  const dw = salesWhere(f, dp);
  const dailySalesQ = pool.query(
    `SELECT substr(s.created_at,1,10) AS day,
            COUNT(*)::int AS cnt,
            COALESCE(SUM(s.jami_summa),0)::bigint AS total
       FROM distribution.savdolar s
       JOIN distribution.dokonlar d ON d.id = s.dokon_id
      WHERE 1=1${dw}
      GROUP BY 1 ORDER BY 1`,
    dp
  );

  const [sales, repeat, visits, dailySales, distinctVisited] = await Promise.all([
    salesQ,
    repeatQ,
    visitsQ,
    dailySalesQ,
    distinctVisitedQ,
  ]);

  const s0 = sales.rows[0];
  const r0 = repeat.rows[0];
  const salesCount = s0.cnt as number;
  const soldShops = s0.sold_shops as number;
  const buyers = r0.buyers as number;

  // Kunlik seriyalarni bitta massivga birlashtirish
  const byDay = new Map<string, { date: string; visits: number; sales: number; salesTotal: number }>();
  for (const r of visits.rows) {
    byDay.set(r.day as string, { date: r.day as string, visits: r.visits as number, sales: 0, salesTotal: 0 });
  }
  for (const r of dailySales.rows) {
    const d = byDay.get(r.day as string) ?? { date: r.day as string, visits: 0, sales: 0, salesTotal: 0 };
    d.sales = r.cnt as number;
    d.salesTotal = Number(r.total);
    byDay.set(r.day as string, d);
  }
  const daily = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));

  const totalVisitShops = daily.reduce((acc, d) => acc + d.visits, 0);

  // Davr kunlari soni: from/to berilsa — kalendar kunlar, aks holda faol kunlar
  let dayCount = daily.length;
  if (f.from && f.to) {
    const ms = Date.parse(f.to) - Date.parse(f.from);
    if (Number.isFinite(ms) && ms >= 0) dayCount = Math.round(ms / 86400000) + 1;
  }

  const visited = distinctVisited.rows[0].c as number;
  res.json({
    from: f.from ?? null,
    to: f.to ?? null,
    kpi: {
      visitedShops: visited,
      soldShops,
      conversionPct: visited > 0 ? Math.round((soldShops / visited) * 1000) / 10 : null,
      repeatPct: buyers > 0 ? Math.round(((r0.repeats as number) / buyers) * 1000) / 10 : null,
      nasiyaPct: salesCount > 0 ? Math.round(((s0.nasiya_cnt as number) / salesCount) * 1000) / 10 : null,
      avgVisitsPerDay: dayCount > 0 ? Math.round((totalVisitShops / dayCount) * 10) / 10 : null,
      salesCount,
      salesTotal: Number(s0.total),
      nasiyaCount: s0.nasiya_cnt as number,
    },
    daily,
  });
});

// ── Issiqlik xaritasi: do'kon sinflari + hudud agregatlari ──────────────────────
router.get("/distribution/heatmap", async (req, res): Promise<void> => {
  const f = parseFilters(req);
  const p: unknown[] = [];
  const w = shopsWhere({ agentId: f.agentId, viloyat: f.viloyat, hudud: f.hudud, search: f.search }, p);

  const base = `
    WITH t AS (
      SELECT d.id, d.nomi, d.viloyat, d.hudud, d.latitude, d.longitude, d.agent_id,
             u.name AS agent_name,
             NULLIF(substr(d.last_order_date,1,10),'')::date AS lod,
             COALESCE(d.avg_repeat_days,0) AS avg_days,
             (now() AT TIME ZONE 'Asia/Tashkent')::date AS today
        FROM distribution.dokonlar d
        LEFT JOIN distribution.users u ON u.telegram_id = d.agent_id
       WHERE d.holat = 'faol'${w}
    ),
    td AS (
      SELECT *, (today - lod)::int AS days FROM t
    ),
    c AS (
      SELECT *, ${CLS_SQL} AS cls FROM td
    )`;

  const [shops, hududlar] = await Promise.all([
    pool.query(
      `${base}
       SELECT id, nomi, viloyat, hudud, latitude, longitude, agent_id, agent_name, days, cls
         FROM c WHERE latitude IS NOT NULL AND longitude IS NOT NULL`,
      p
    ),
    pool.query(
      `${base}
       SELECT viloyat, hudud,
              COUNT(*)::int AS shop_count,
              COUNT(*) FILTER (WHERE cls='green')::int  AS green,
              COUNT(*) FILTER (WHERE cls='yellow')::int AS yellow,
              COUNT(*) FILTER (WHERE cls='red')::int    AS red,
              COUNT(*) FILTER (WHERE cls='new')::int    AS new,
              AVG(latitude)  FILTER (WHERE latitude IS NOT NULL)  AS clat,
              AVG(longitude) FILTER (WHERE longitude IS NOT NULL) AS clng
         FROM c GROUP BY viloyat, hudud ORDER BY viloyat, hudud`,
      p
    ),
  ]);

  // Hudud sinfi: green/yellow/red ichida ko'pchilik; teng bo'lsa — yomoni ustun.
  const hududCls = (g: number, y: number, r: number): string => {
    if (g === 0 && y === 0 && r === 0) return "new";
    if (r >= y && r >= g) return "red";
    if (y >= g) return "yellow";
    return "green";
  };

  res.json({
    shops: shops.rows.map((r) => ({
      id: r.id,
      nomi: r.nomi,
      viloyat: r.viloyat,
      hudud: r.hudud,
      lat: Number(r.latitude),
      lng: Number(r.longitude),
      agentId: r.agent_id != null ? String(r.agent_id) : null,
      agentName: r.agent_name,
      days: r.days,
      cls: r.cls,
    })),
    hududlar: hududlar.rows.map((r) => ({
      viloyat: r.viloyat,
      hudud: r.hudud,
      shopCount: r.shop_count,
      green: r.green,
      yellow: r.yellow,
      red: r.red,
      new: r.new,
      cls: hududCls(r.green, r.yellow, r.red),
      centroid: r.clat != null && r.clng != null ? { lat: Number(r.clat), lng: Number(r.clng) } : null,
    })),
  });
});

// ── Tavsiyalar (qoida asosida, AI ishlatilmaydi) ────────────────────────────────
// 1) nearest: agentning bugungi oxirgi GPS nuqtasidan eng yaqin, hali kirilmagan
//    marshrut do'konlari (Haversine, SQL ichida).
// 2) overdue: odatdagi takror oralig'idan sezilarli o'tib ketgan faol do'konlar.
// 3) qaytish: "olmagan" yozuvidagi qaytish sanasi kelgan (yoki o'tgan) do'konlar.
router.get("/distribution/suggestions", async (req, res): Promise<void> => {
  const f = parseFilters(req);

  const dQ = await pool.query(
    `SELECT to_char(now() AT TIME ZONE 'Asia/Tashkent','YYYY-MM-DD') AS d,
            EXTRACT(ISODOW FROM (now() AT TIME ZONE 'Asia/Tashkent')::date)::int AS dow`
  );
  const today = dQ.rows[0].d as string;
  const dow = dQ.rows[0].dow as number;

  // (1) Eng yaqin keyingi do'konlar — bugun GPS yuborgan faol yetkazib beruvchilar
  const np: unknown[] = [dow, today];
  let naw = "";
  if (f.agentId) {
    np.push(f.agentId);
    naw += ` AND da.telegram_id = $${np.length}`;
  }
  const nearestQ = pool.query(
    `WITH loc AS (
       SELECT DISTINCT ON (agent_id) agent_id, latitude, longitude, created_at
         FROM distribution.agent_locations
        WHERE substr(created_at,1,10) = $2
        ORDER BY agent_id, created_at DESC
     )
     SELECT da.id AS agent_id, da.name AS agent_name, da.mashina_nomeri,
            l.latitude AS gps_lat, l.longitude AS gps_lng, l.created_at AS gps_at,
            n.dokon_id, n.nomi, n.hudud, n.tartib, n.dist_km
       FROM distribution.delivery_agents da
       JOIN loc l ON l.agent_id = da.telegram_id
       LEFT JOIN LATERAL (
         SELECT d.id AS dokon_id, d.nomi, d.hudud, r.tartib,
                6371 * acos(LEAST(1.0,
                  cos(radians(l.latitude)) * cos(radians(d.latitude))
                    * cos(radians(d.longitude) - radians(l.longitude))
                  + sin(radians(l.latitude)) * sin(radians(d.latitude)))) AS dist_km
           FROM distribution.delivery_routes r
           JOIN distribution.dokonlar d ON d.id = r.dokon_id
          WHERE r.delivery_agent_id = da.id AND r.kun = $1
            AND d.latitude IS NOT NULL AND d.longitude IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM distribution.savdolar s
                             WHERE s.dokon_id = d.id AND substr(s.created_at,1,10) = $2)
            AND NOT EXISTS (SELECT 1 FROM distribution.olmagan_dokonlar o
                             WHERE o.dokon_id = d.id AND substr(o.created_at,1,10) = $2)
          ORDER BY dist_km LIMIT 3
       ) n ON true
      WHERE da.faol = 1${naw}
      ORDER BY da.name, n.dist_km`,
    np
  );

  // (2) Kechikkan do'konlar: days > GREATEST(avg*1.5, 7), avg > 0
  const op: unknown[] = [];
  const ow = shopsWhere({ agentId: f.agentId, viloyat: f.viloyat, hudud: f.hudud, search: f.search }, op);
  const overdueQ = pool.query(
    `WITH t AS (
       SELECT d.id, d.nomi, d.viloyat, d.hudud, u.name AS agent_name,
              d.avg_repeat_days AS avg_days,
              ((now() AT TIME ZONE 'Asia/Tashkent')::date
                - NULLIF(substr(d.last_order_date,1,10),'')::date)::int AS days
         FROM distribution.dokonlar d
         LEFT JOIN distribution.users u ON u.telegram_id = d.agent_id
        WHERE d.holat = 'faol'
          AND NULLIF(substr(d.last_order_date,1,10),'') IS NOT NULL${ow}
     )
     SELECT * FROM t
      WHERE (avg_days > 0 AND days > GREATEST(avg_days * 1.5, 7))
         OR (avg_days <= 0 AND days > 21)
      ORDER BY CASE WHEN avg_days > 0 THEN days::float / avg_days ELSE days::float / 21 END DESC
      LIMIT 10`,
    op
  );

  // (3) Qaytish sanasi kelganlar. DIQQAT: qaytish_sanasi erkin matn —
  // bot DD.MM.YYYY formatini so'raydi, lekin tekshirmaydi. Xavfsiz taqqoslash
  // uchun matnni ISO ko'rinishga regexp bilan o'giramiz (date parse yo'q).
  const qp: unknown[] = [today];
  const qw = shopsWhere({ agentId: f.agentId, viloyat: f.viloyat, hudud: f.hudud, search: f.search }, qp);
  const qaytishQ = pool.query(
    `WITH last_o AS (
       SELECT DISTINCT ON (o.dokon_id) o.dokon_id, o.sabab, o.sabab_text,
              o.qaytish_sanasi, o.created_at, o.bajarildi
         FROM distribution.olmagan_dokonlar o
        ORDER BY o.dokon_id, o.id DESC
     ),
     parsed AS (
       SELECT lo.*, d.nomi, d.viloyat, d.hudud, u.name AS agent_name,
              CASE
                WHEN lo.qaytish_sanasi ~ '^\\d{2}\\.\\d{2}\\.\\d{4}$'
                  THEN substr(lo.qaytish_sanasi,7,4) || '-' || substr(lo.qaytish_sanasi,4,2)
                       || '-' || substr(lo.qaytish_sanasi,1,2)
                WHEN lo.qaytish_sanasi ~ '^\\d{2}\\.\\d{2}\\.\\d{2}$'
                  THEN '20' || substr(lo.qaytish_sanasi,7,2) || '-' || substr(lo.qaytish_sanasi,4,2)
                       || '-' || substr(lo.qaytish_sanasi,1,2)
                WHEN lo.qaytish_sanasi ~ '^\\d{4}-\\d{2}-\\d{2}'
                  THEN substr(lo.qaytish_sanasi,1,10)
                ELSE NULL
              END AS due_iso
         FROM last_o lo
         JOIN distribution.dokonlar d ON d.id = lo.dokon_id
         LEFT JOIN distribution.users u ON u.telegram_id = d.agent_id
        WHERE d.holat = 'faol' AND COALESCE(lo.bajarildi,0) = 0${qw}
     )
     SELECT dokon_id, nomi, viloyat, hudud, agent_name, sabab, sabab_text,
            qaytish_sanasi, due_iso
       FROM parsed
      WHERE due_iso IS NOT NULL AND due_iso <= $1
        AND NOT EXISTS (SELECT 1 FROM distribution.savdolar s
                         WHERE s.dokon_id = parsed.dokon_id AND s.created_at > parsed.created_at)
      ORDER BY due_iso
      LIMIT 10`,
    qp
  );

  const [nearest, overdue, qaytish] = await Promise.all([nearestQ, overdueQ, qaytishQ]);

  // nearest satrlarini agent bo'yicha guruhlash
  type NearestShop = { dokonId: number; nomi: string; hudud: string | null; tartib: number; distKm: number };
  const agents = new Map<
    number,
    {
      agentId: number;
      agentName: string;
      mashinaNomeri: string | null;
      gps: { lat: number; lng: number; at: string };
      nearest: NearestShop[];
    }
  >();
  for (const r of nearest.rows) {
    let a = agents.get(r.agent_id as number);
    if (!a) {
      a = {
        agentId: r.agent_id,
        agentName: r.agent_name,
        mashinaNomeri: r.mashina_nomeri,
        gps: { lat: Number(r.gps_lat), lng: Number(r.gps_lng), at: r.gps_at as string },
        nearest: [],
      };
      agents.set(r.agent_id as number, a);
    }
    if (r.dokon_id != null) {
      a.nearest.push({
        dokonId: r.dokon_id,
        nomi: r.nomi,
        hudud: r.hudud,
        tartib: r.tartib,
        distKm: Math.round(Number(r.dist_km) * 10) / 10,
      });
    }
  }

  res.json({
    date: today,
    kun: dow,
    agents: [...agents.values()],
    overdue: overdue.rows.map((r) => ({
      dokonId: r.id,
      nomi: r.nomi,
      viloyat: r.viloyat,
      hudud: r.hudud,
      agentName: r.agent_name,
      days: r.days,
      avgRepeatDays: Math.round(Number(r.avg_days) * 10) / 10,
    })),
    qaytish: qaytish.rows.map((r) => ({
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

export default router;
