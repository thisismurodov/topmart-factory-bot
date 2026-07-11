import { Router, type IRouter, type Request } from "express";
import { pool } from "@workspace/db";

// Distribyutsiya moduli o'zining `distribution` sxemasida yashaydi (o'zbekcha jadval
// nomlari — savdolar, dokonlar, nasiya ...). Bu yerdagi barcha endpointlar faqat
// o'qish uchun (read-only) — dashboard'ning "Savdo markazi" bo'limi shulardan foydalanadi.
// Barcha summalar so'mda (UZS, bigint). Sanalar TEXT (ISO-8601) ko'rinishida saqlanadi.

const router: IRouter = Router();

// ── Filtr parametrlari ──────────────────────────────────────────────────────────
// from/to: YYYY-MM-DD (Asia/Tashkent kalendari bo'yicha, ikkalasi ham inklyuziv)
// agentId, viloyat, hudud, tolovTuri, mahsulotId, search (do'kon nomi bo'yicha)
type Filters = {
  from?: string;
  to?: string;
  agentId?: string;
  viloyat?: string;
  hudud?: string;
  tolovTuri?: string;
  mahsulotId?: string;
  search?: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseFilters(req: Request): Filters {
  const q = req.query as Record<string, unknown>;
  const s = (k: string): string | undefined => {
    const v = q[k];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  };
  const f: Filters = {};
  const from = s("from");
  const to = s("to");
  if (from && DATE_RE.test(from)) f.from = from;
  if (to && DATE_RE.test(to)) f.to = to;
  const agentId = s("agentId");
  if (agentId && /^\d+$/.test(agentId)) f.agentId = agentId;
  f.viloyat = s("viloyat");
  f.hudud = s("hudud");
  const tt = s("tolovTuri");
  if (tt && ["naqd", "nasiya", "aralash"].includes(tt)) f.tolovTuri = tt;
  const mid = s("mahsulotId");
  if (mid && /^\d+$/.test(mid)) f.mahsulotId = mid;
  f.search = s("search");
  return f;
}

// Savdolar (s alias) + dokonlar (d alias) uchun WHERE bo'laklari.
// params massiviga qiymatlar qo'shiladi, natija " AND ..." satri.
function salesWhere(f: Filters, params: unknown[]): string {
  let w = "";
  if (f.from) {
    params.push(f.from);
    w += ` AND substr(s.created_at,1,10) >= $${params.length}`;
  }
  if (f.to) {
    params.push(f.to);
    w += ` AND substr(s.created_at,1,10) <= $${params.length}`;
  }
  if (f.agentId) {
    params.push(f.agentId);
    w += ` AND s.agent_id = $${params.length}`;
  }
  if (f.viloyat) {
    params.push(f.viloyat);
    w += ` AND d.viloyat = $${params.length}`;
  }
  if (f.hudud) {
    params.push(f.hudud);
    w += ` AND d.hudud = $${params.length}`;
  }
  if (f.tolovTuri) {
    params.push(f.tolovTuri);
    w += ` AND s.tolov_turi = $${params.length}`;
  }
  if (f.mahsulotId) {
    params.push(f.mahsulotId);
    w += ` AND EXISTS (SELECT 1 FROM distribution.savdo_tafsilot st
                        WHERE st.savdo_id = s.id AND st.mahsulot_id = $${params.length})`;
  }
  if (f.search) {
    params.push(`%${f.search}%`);
    w += ` AND d.nomi ILIKE $${params.length}`;
  }
  return w;
}

// Do'konlarga tegishli filtrlar (d alias)
function shopsWhere(f: Filters, params: unknown[]): string {
  let w = "";
  if (f.agentId) {
    params.push(f.agentId);
    w += ` AND d.agent_id = $${params.length}`;
  }
  if (f.viloyat) {
    params.push(f.viloyat);
    w += ` AND d.viloyat = $${params.length}`;
  }
  if (f.hudud) {
    params.push(f.hudud);
    w += ` AND d.hudud = $${params.length}`;
  }
  if (f.search) {
    params.push(`%${f.search}%`);
    w += ` AND d.nomi ILIKE $${params.length}`;
  }
  return w;
}

// ── Filtr lug'atlari (dropdownlar uchun) ────────────────────────────────────────
router.get("/distribution/filters", async (_req, res): Promise<void> => {
  const [agents, viloyatlar, hududlar, mahsulotlar] = await Promise.all([
    pool.query(`SELECT telegram_id, name FROM distribution.users
                 WHERE role IN ('agent','supervisor') AND name IS NOT NULL
                 ORDER BY name`),
    pool.query(`SELECT DISTINCT viloyat FROM distribution.dokonlar
                 WHERE viloyat IS NOT NULL AND viloyat <> '' ORDER BY viloyat`),
    pool.query(`SELECT DISTINCT viloyat, hudud FROM distribution.dokonlar
                 WHERE hudud IS NOT NULL AND hudud <> '' ORDER BY viloyat, hudud`),
    pool.query(`SELECT id, nomi FROM distribution.mahsulotlar WHERE faol = 1 ORDER BY nomi`),
  ]);
  res.json({
    agents: agents.rows.map((r) => ({ id: Number(r.telegram_id), name: r.name })),
    viloyatlar: viloyatlar.rows.map((r) => r.viloyat as string),
    hududlar: hududlar.rows.map((r) => ({ viloyat: r.viloyat as string | null, hudud: r.hudud as string })),
    mahsulotlar: mahsulotlar.rows.map((r) => ({ id: r.id as number, nomi: r.nomi as string })),
  });
});

// ── Umumiy ko'rsatkichlar (KPI kartalar) — filtrlangan davr bo'yicha ────────────
router.get("/distribution/summary", async (req, res): Promise<void> => {
  const f = parseFilters(req);

  const sp: unknown[] = [];
  const sw = salesWhere(f, sp);

  // pul_olish (p alias) — sana + agent + hudud filtrlariga bo'ysunadi
  const pp: unknown[] = [];
  let pw = "";
  if (f.from) {
    pp.push(f.from);
    pw += ` AND substr(p.created_at,1,10) >= $${pp.length}`;
  }
  if (f.to) {
    pp.push(f.to);
    pw += ` AND substr(p.created_at,1,10) <= $${pp.length}`;
  }
  if (f.agentId) {
    pp.push(f.agentId);
    pw += ` AND p.agent_id = $${pp.length}`;
  }
  if (f.viloyat) {
    pp.push(f.viloyat);
    pw += ` AND d.viloyat = $${pp.length}`;
  }
  if (f.hudud) {
    pp.push(f.hudud);
    pw += ` AND d.hudud = $${pp.length}`;
  }

  // nasiya qoldiq — joriy holat (sana filtriga bog'lanmaydi), agent/hudud bo'yicha filtrlash mumkin
  const np: unknown[] = [];
  let nw = "";
  if (f.agentId) {
    np.push(f.agentId);
    nw += ` AND n.agent_id = $${np.length}`;
  }
  if (f.viloyat) {
    np.push(f.viloyat);
    nw += ` AND d.viloyat = $${np.length}`;
  }
  if (f.hudud) {
    np.push(f.hudud);
    nw += ` AND d.hudud = $${np.length}`;
  }

  const shp: unknown[] = [];
  const shw = shopsWhere({ agentId: f.agentId, viloyat: f.viloyat, hudud: f.hudud }, shp);

  const [sales, activeAgents, shops, collected, outstanding] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS c, COALESCE(SUM(s.jami_summa),0)::bigint AS total
         FROM distribution.savdolar s
         JOIN distribution.dokonlar d ON d.id = s.dokon_id
        WHERE 1=1${sw}`,
      sp
    ),
    pool.query(
      `SELECT COUNT(DISTINCT s.agent_id)::int AS c
         FROM distribution.savdolar s
         JOIN distribution.dokonlar d ON d.id = s.dokon_id
        WHERE 1=1${sw}`,
      sp
    ),
    pool.query(
      `SELECT COUNT(*)::int AS c FROM distribution.dokonlar d
        WHERE d.holat = 'faol'${shw}`,
      shp
    ),
    pool.query(
      `SELECT COALESCE(SUM(p.summa),0)::bigint AS total
         FROM distribution.pul_olish p
         JOIN distribution.dokonlar d ON d.id = p.dokon_id
        WHERE 1=1${pw}`,
      pp
    ),
    pool.query(
      `SELECT COALESCE(SUM(n.qoldiq),0)::bigint AS total
         FROM distribution.nasiya n
         JOIN distribution.dokonlar d ON d.id = n.dokon_id
        WHERE n.qoldiq > 0${nw}`,
      np
    ),
  ]);

  res.json({
    activeAgents: activeAgents.rows[0].c,
    shopsCount: shops.rows[0].c,
    salesCount: sales.rows[0].c,
    salesTotal: Number(sales.rows[0].total),
    collectedTotal: Number(collected.rows[0].total),
    outstandingTotal: Number(outstanding.rows[0].total),
  });
});

// ── Savdolar (filtrlangan, oxirgi 200 ta) ───────────────────────────────────────
router.get("/distribution/sales", async (req, res): Promise<void> => {
  const f = parseFilters(req);
  const params: unknown[] = [];
  const w = salesWhere(f, params);
  const { rows } = await pool.query(
    `SELECT
       s.id, s.created_at, s.jami_summa, s.tolov_turi, s.dokon_id,
       u.name AS agent_name,
       d.nomi AS dokon_name,
       d.viloyat, d.hudud,
       (SELECT string_agg(m.nomi || ' x' || st.miqdor::text, ', ')
          FROM distribution.savdo_tafsilot st
          JOIN distribution.mahsulotlar m ON m.id = st.mahsulot_id
         WHERE st.savdo_id = s.id) AS items
     FROM distribution.savdolar s
     LEFT JOIN distribution.users u ON u.telegram_id = s.agent_id
     LEFT JOIN distribution.dokonlar d ON d.id = s.dokon_id
     WHERE 1=1${w}
     ORDER BY s.id DESC
     LIMIT 200`,
    params
  );

  res.json(
    rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      total: Number(r.jami_summa),
      tolovTuri: r.tolov_turi,
      agentName: r.agent_name,
      dokonId: r.dokon_id === null ? null : Number(r.dokon_id),
      dokonName: r.dokon_name,
      viloyat: r.viloyat,
      hudud: r.hudud,
      items: r.items,
    }))
  );
});

// ── Agentlar (davr bo'yicha statistika bilan kartochkalar) ──────────────────────
router.get("/distribution/agents", async (req, res): Promise<void> => {
  const f = parseFilters(req);
  // Davr sharti (savdolar/pul_olish/olmagan uchun) — faqat sana
  const dp: unknown[] = [];
  let dFrom = "";
  let dTo = "";
  if (f.from) {
    dp.push(f.from);
    dFrom = ` AND substr(x.created_at,1,10) >= $${dp.length}`;
  }
  if (f.to) {
    dp.push(f.to);
    dTo = ` AND substr(x.created_at,1,10) <= $${dp.length}`;
  }
  const range = dFrom + dTo;

  // Agent bo'yicha global filtrlar (agent tanlovi va viloyat)
  let agentWhere = "";
  if (f.agentId !== undefined) {
    dp.push(f.agentId);
    agentWhere += ` AND u.telegram_id = $${dp.length}`;
  }
  if (f.viloyat) {
    dp.push(f.viloyat);
    agentWhere += ` AND u.viloyat = $${dp.length}`;
  }

  const { rows } = await pool.query(
    `SELECT
      u.telegram_id,
      u.name,
      u.viloyat,
      u.role,
      (SELECT COUNT(*)::int FROM distribution.dokonlar d
         WHERE d.agent_id = u.telegram_id AND d.holat = 'faol')                       AS shops,
      (SELECT COUNT(*)::int FROM distribution.savdolar x
         WHERE x.agent_id = u.telegram_id${range})                                    AS sales_count,
      (SELECT COALESCE(SUM(x.jami_summa),0)::bigint FROM distribution.savdolar x
         WHERE x.agent_id = u.telegram_id${range})                                    AS sales_total,
      (SELECT COALESCE(SUM(x.summa),0)::bigint FROM distribution.pul_olish x
         WHERE x.agent_id = u.telegram_id${range})                                    AS collected,
      (SELECT COUNT(*)::int FROM distribution.olmagan_dokonlar x
         WHERE x.agent_id = u.telegram_id${range})                                    AS no_order_visits,
      (SELECT COALESCE(SUM(n.qoldiq),0)::bigint FROM distribution.nasiya n
         WHERE n.agent_id = u.telegram_id AND n.qoldiq > 0)                           AS outstanding
    FROM distribution.users u
    WHERE u.role IN ('agent','supervisor')${agentWhere}
    ORDER BY sales_total DESC NULLS LAST`,
    dp
  );

  res.json(
    rows.map((r) => ({
      telegramId: r.telegram_id === null ? null : Number(r.telegram_id),
      name: r.name,
      viloyat: r.viloyat,
      role: r.role,
      shops: r.shops,
      salesCount: r.sales_count,
      salesTotal: Number(r.sales_total),
      collected: Number(r.collected),
      noOrderVisits: r.no_order_visits,
      visits: r.sales_count + r.no_order_visits,
      outstanding: Number(r.outstanding),
    }))
  );
});

// ── Do'konlar (filtrlangan) ─────────────────────────────────────────────────────
router.get("/distribution/shops", async (req, res): Promise<void> => {
  const f = parseFilters(req);
  const params: unknown[] = [];
  const w = shopsWhere(f, params);
  const { rows } = await pool.query(
    `SELECT
       d.id, d.nomi, d.egasi, d.telefon, d.viloyat, d.hudud, d.holat,
       d.total_orders, d.total_sales, d.last_order_date,
       u.name AS agent_name,
       COALESCE((SELECT SUM(n.qoldiq) FROM distribution.nasiya n
                  WHERE n.dokon_id = d.id AND n.qoldiq > 0),0)::bigint AS outstanding
     FROM distribution.dokonlar d
     LEFT JOIN distribution.users u ON u.telegram_id = d.agent_id
     WHERE 1=1${w}
     ORDER BY d.total_sales DESC NULLS LAST
     LIMIT 500`,
    params
  );

  res.json(
    rows.map((r) => ({
      id: r.id,
      nomi: r.nomi,
      egasi: r.egasi,
      telefon: r.telefon,
      viloyat: r.viloyat,
      hudud: r.hudud,
      holat: r.holat,
      totalOrders: r.total_orders,
      totalSales: Number(r.total_sales),
      lastOrderDate: r.last_order_date,
      agentName: r.agent_name,
      outstanding: Number(r.outstanding),
    }))
  );
});

// ── Do'kon tafsiloti (drawer uchun) ─────────────────────────────────────────────
router.get("/distribution/shops/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Noto'g'ri do'kon ID" });
    return;
  }

  const shopQ = await pool.query(
    `SELECT d.id, d.nomi, d.egasi, d.telefon, d.viloyat, d.hudud, d.holat,
            d.total_orders, d.total_sales, d.last_order_date, d.created_at,
            u.name AS agent_name,
            COALESCE((SELECT b.balans FROM distribution.mijoz_balans b WHERE b.dokon_id = d.id),0)::bigint AS balans,
            COALESCE((SELECT SUM(n.qoldiq) FROM distribution.nasiya n
                       WHERE n.dokon_id = d.id AND n.qoldiq > 0),0)::bigint AS outstanding
       FROM distribution.dokonlar d
       LEFT JOIN distribution.users u ON u.telegram_id = d.agent_id
      WHERE d.id = $1`,
    [id]
  );
  if (shopQ.rows.length === 0) {
    res.status(404).json({ error: "Do'kon topilmadi" });
    return;
  }
  const s = shopQ.rows[0];

  const [salesQ, paymentsQ, debtsQ] = await Promise.all([
    pool.query(
      `SELECT s.id, s.created_at, s.jami_summa, s.tolov_turi,
              u.name AS agent_name,
              (SELECT string_agg(m.nomi || ' x' || st.miqdor::text, ', ')
                 FROM distribution.savdo_tafsilot st
                 JOIN distribution.mahsulotlar m ON m.id = st.mahsulot_id
                WHERE st.savdo_id = s.id) AS items
         FROM distribution.savdolar s
         LEFT JOIN distribution.users u ON u.telegram_id = s.agent_id
        WHERE s.dokon_id = $1
        ORDER BY s.id DESC
        LIMIT 10`,
      [id]
    ),
    pool.query(
      `SELECT p.id, p.created_at, p.summa, u.name AS agent_name
         FROM distribution.pul_olish p
         LEFT JOIN distribution.users u ON u.telegram_id = p.agent_id
        WHERE p.dokon_id = $1
        ORDER BY p.id DESC
        LIMIT 10`,
      [id]
    ),
    pool.query(
      `SELECT n.id, n.jami_summa, n.tolangan, n.qoldiq, n.updated_at
         FROM distribution.nasiya n
        WHERE n.dokon_id = $1 AND n.qoldiq > 0
        ORDER BY n.id DESC`,
      [id]
    ),
  ]);

  res.json({
    id: s.id,
    nomi: s.nomi,
    egasi: s.egasi,
    telefon: s.telefon,
    viloyat: s.viloyat,
    hudud: s.hudud,
    holat: s.holat,
    totalOrders: s.total_orders,
    totalSales: Number(s.total_sales),
    lastOrderDate: s.last_order_date,
    createdAt: s.created_at,
    agentName: s.agent_name,
    balans: Number(s.balans),
    outstanding: Number(s.outstanding),
    recentSales: salesQ.rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      total: Number(r.jami_summa),
      tolovTuri: r.tolov_turi,
      agentName: r.agent_name,
      items: r.items,
    })),
    recentPayments: paymentsQ.rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      summa: Number(r.summa),
      agentName: r.agent_name,
    })),
    openDebts: debtsQ.rows.map((r) => ({
      id: r.id,
      total: Number(r.jami_summa),
      paid: Number(r.tolangan),
      remaining: Number(r.qoldiq),
      updatedAt: r.updated_at,
    })),
  });
});

// ── Nasiya (do'konlar bo'yicha qarzdorlik, filtrlangan) ─────────────────────────
router.get("/distribution/debts", async (req, res): Promise<void> => {
  const f = parseFilters(req);
  const params: unknown[] = [];
  let w = "";
  if (f.agentId) {
    params.push(f.agentId);
    w += ` AND n.agent_id = $${params.length}`;
  }
  if (f.viloyat) {
    params.push(f.viloyat);
    w += ` AND d.viloyat = $${params.length}`;
  }
  if (f.hudud) {
    params.push(f.hudud);
    w += ` AND d.hudud = $${params.length}`;
  }
  if (f.search) {
    params.push(`%${f.search}%`);
    w += ` AND d.nomi ILIKE $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT
       d.id AS dokon_id, d.nomi AS dokon_name, d.telefon, d.viloyat, d.hudud,
       u.name AS agent_name,
       SUM(n.qoldiq)::bigint AS outstanding,
       COUNT(*)::int         AS entries,
       MAX(n.updated_at)     AS last_update,
       (SELECT MAX(p.created_at) FROM distribution.pul_olish p
         WHERE p.dokon_id = d.id) AS last_payment
     FROM distribution.nasiya n
     JOIN distribution.dokonlar d ON d.id = n.dokon_id
     LEFT JOIN distribution.users u ON u.telegram_id = n.agent_id
     WHERE n.qoldiq > 0${w}
     GROUP BY d.id, d.nomi, d.telefon, d.viloyat, d.hudud, u.name
     ORDER BY outstanding DESC`,
    params
  );

  res.json(
    rows.map((r) => ({
      dokonId: r.dokon_id,
      dokonName: r.dokon_name,
      telefon: r.telefon,
      viloyat: r.viloyat,
      hudud: r.hudud,
      agentName: r.agent_name,
      outstanding: Number(r.outstanding),
      entries: r.entries,
      lastUpdate: r.last_update,
      lastPayment: r.last_payment,
    }))
  );
});

// ── Marshrutlar (yetkazib berish) ───────────────────────────────────────────────
const KUNLAR = ["dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba", "yakshanba"];

router.get("/distribution/routes", async (req, res): Promise<void> => {
  // kun: 1=dushanba .. 7=yakshanba (bot isoweekday bilan yozadi)
  const kunParam = typeof req.query.kun === "string" ? Number(req.query.kun) : NaN;
  // Standart: bugungi kun (Asia/Tashkent)
  const todayIdxQ = await pool.query(
    `SELECT EXTRACT(ISODOW FROM (now() AT TIME ZONE 'Asia/Tashkent'))::int AS d,
            to_char(now() AT TIME ZONE 'Asia/Tashkent','YYYY-MM-DD') AS today`
  );
  const todayIdx = todayIdxQ.rows[0].d as number; // 1=dushanba
  const today = todayIdxQ.rows[0].today as string;
  const kun = Number.isInteger(kunParam) && kunParam >= 1 && kunParam <= 7 ? kunParam : todayIdx;

  const { rows } = await pool.query(
    `SELECT
       da.id AS agent_id, da.name AS agent_name, da.mashina_nomeri,
       r.tartib, d.id AS dokon_id, d.nomi AS dokon_name, d.telefon,
       d.viloyat, d.hudud,
       EXISTS (SELECT 1 FROM distribution.savdolar s
                WHERE s.dokon_id = d.id AND substr(s.created_at,1,10) = $2) AS visited
     FROM distribution.delivery_routes r
     JOIN distribution.delivery_agents da ON da.id = r.delivery_agent_id
     JOIN distribution.dokonlar d ON d.id = r.dokon_id
     WHERE r.kun = $1 AND da.faol = 1
     ORDER BY da.name, r.tartib`,
    [kun, today]
  );

  res.json({
    kun,
    kunlar: KUNLAR,
    routes: rows.map((r) => ({
      agentId: r.agent_id,
      agentName: r.agent_name,
      mashinaNomeri: r.mashina_nomeri,
      tartib: r.tartib,
      dokonId: r.dokon_id,
      dokonName: r.dokon_name,
      telefon: r.telefon,
      viloyat: r.viloyat,
      hudud: r.hudud,
      visited: r.visited,
    })),
  });
});

export default router;
