import { Router, type IRouter, type Request } from "express";
import { pool } from "@workspace/db";
import { computeRouteStats, splitOutliers } from "../lib/routePlanner";
import { uniqueProductSku } from "../lib/sku";
import { runRoutePlan } from "../lib/routePlanService";

// Distribyutsiya moduli o'zining `distribution` sxemasida yashaydi (o'zbekcha jadval
// nomlari — savdolar, dokonlar, nasiya ...). Bu yerdagi barcha endpointlar faqat
// o'qish uchun (read-only) — dashboard'ning "Savdo markazi" bo'limi shulardan foydalanadi.
// Barcha summalar so'mda (UZS, bigint). Sanalar TEXT (ISO-8601) ko'rinishida saqlanadi.

const router: IRouter = Router();

// ── Filtr parametrlari ──────────────────────────────────────────────────────────
// from/to: YYYY-MM-DD (Asia/Tashkent kalendari bo'yicha, ikkalasi ham inklyuziv)
// agentId, viloyat, hudud, tolovTuri, mahsulotId, search (do'kon nomi bo'yicha)
export type Filters = {
  from?: string;
  to?: string;
  agentId?: string;
  viloyat?: string;
  hudud?: string;
  tolovTuri?: string;
  mahsulotId?: string;
  search?: string;
};

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseFilters(req: Request): Filters {
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
export function salesWhere(f: Filters, params: unknown[]): string {
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
export function shopsWhere(f: Filters, params: unknown[]): string {
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
                 WHERE (role IN ('agent','supervisor')
                        OR EXISTS (SELECT 1 FROM distribution.savdolar s
                                    WHERE s.agent_id = users.telegram_id))
                   AND name IS NOT NULL
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

// ── Savdo bot mahsulot katalogi (dashboard'dan boshqarish) ──────────────────────
// distribution.mahsulotlar — savdo (agent) boti bilan BIR XIL jadval: bu yerdagi
// o'zgarish botda darhol ko'rinadi (va aksincha). ERP katalogi (public.products)
// bilan solishtirishda apostrof va bo'shliq farqlari e'tiborga olinmaydi
// ("Po'kak" vs "Po'kak" kabi variantlar bitta deb hisoblanadi).
const nameNorm = (expr: string): string =>
  "regexp_replace(regexp_replace(lower(trim(" + expr + ")), '[''’ʼ`´]', '', 'g'), '\\s+', ' ', 'g')";

router.get("/distribution/products", async (_req, res): Promise<void> => {
  const { rows } = await pool.query(
    `SELECT m.id, m.nomi, m.narx, m.birlik, m.faol, m.sku,
            COALESCE(st.sotuvlar_soni, 0) AS sotuvlar_soni,
            COALESCE(st.jami_miqdor, 0)   AS jami_miqdor,
            COALESCE(st.jami_summa, 0)    AS jami_summa,
            st.oxirgi_savdo,
            (SELECT p.name FROM public.products p
             WHERE p.sku <> '' AND p.sku = m.sku LIMIT 1) AS erp_nomi,
            (SELECT p.sku FROM public.products p
             WHERE p.sku <> '' AND ${nameNorm("p.name")} = ${nameNorm("m.nomi")}
             LIMIT 1) AS taklif_sku,
            EXISTS (SELECT 1 FROM public.products p
                    WHERE ${nameNorm("p.name")} = ${nameNorm("m.nomi")}) AS erp_bor
     FROM distribution.mahsulotlar m
     LEFT JOIN (
       SELECT t.mahsulot_id,
              COUNT(DISTINCT t.savdo_id)       AS sotuvlar_soni,
              SUM(t.miqdor)                    AS jami_miqdor,
              SUM(t.summa)                     AS jami_summa,
              MAX(substr(s.created_at, 1, 10)) AS oxirgi_savdo
       FROM distribution.savdo_tafsilot t
       JOIN distribution.savdolar s ON s.id = t.savdo_id
       GROUP BY t.mahsulot_id
     ) st ON st.mahsulot_id = m.id
     WHERE m.nomi IS NOT NULL
     ORDER BY m.faol DESC, lower(m.nomi)`
  );
  res.json(
    rows.map((r) => ({
      id: r.id as number,
      nomi: r.nomi as string,
      narx: Number(r.narx ?? 0),
      birlik: (r.birlik as string) || "dona",
      faol: Number(r.faol) === 1,
      sotuvlarSoni: Number(r.sotuvlar_soni),
      jamiMiqdor: Number(r.jami_miqdor),
      jamiSumma: Number(r.jami_summa),
      oxirgiSavdo: (r.oxirgi_savdo as string | null) ?? null,
      erpBor: r.erp_bor === true,
      sku: (r.sku as string) || "",
      erpNomi: (r.erp_nomi as string | null) ?? null,
      taklifSku: (r.taklif_sku as string | null) ?? null,
    }))
  );
});

router.post("/distribution/products", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const nomi = typeof body.nomi === "string" ? body.nomi.trim().replace(/\s+/g, " ") : "";
  const narxRaw = Number(body.narx);
  const birlik = body.birlik === "kg" ? "kg" : "dona";

  if (!nomi) {
    res.status(400).json({ error: "Mahsulot nomi kiritilishi shart" });
    return;
  }
  if (!Number.isFinite(narxRaw) || narxRaw <= 0) {
    res.status(400).json({ error: "Narx musbat son bo'lishi kerak" });
    return;
  }
  const narx = Math.round(narxRaw);

  const dup = await pool.query(
    `SELECT id, faol FROM distribution.mahsulotlar
     WHERE ${nameNorm("nomi")} = ${nameNorm("$1")} ORDER BY faol DESC LIMIT 1`,
    [nomi]
  );
  if (dup.rows.length > 0 && Number(dup.rows[0].faol) === 1) {
    res.status(409).json({ error: "Bu nomdagi mahsulot allaqachon bor" });
    return;
  }
  if (dup.rows.length > 0) {
    // Nofaol (o'chirilgan) mahsulot qayta tiklanadi — dublikat yaratilmaydi
    const upd = await pool.query(
      `UPDATE distribution.mahsulotlar SET nomi = $1, narx = $2, birlik = $3, faol = 1
       WHERE id = $4 RETURNING id`,
      [nomi, narx, birlik, dup.rows[0].id]
    );
    res.json({ id: upd.rows[0].id as number, reactivated: true });
    return;
  }
  const ins = await pool.query(
    `INSERT INTO distribution.mahsulotlar (nomi, narx, birlik, faol)
     VALUES ($1, $2, $3, 1) RETURNING id`,
    [nomi, narx, birlik]
  );
  res.status(201).json({ id: ins.rows[0].id as number, reactivated: false });
});

// Savdo botida bor, lekin ERP katalogida yo'q mahsulotlarni public.products'ga
// nusxalash (birlik + narx UZS sotuv narxi sifatida). ids berilmasa — barcha
// yetishmayotgan faol mahsulotlar.
router.post("/distribution/products/sync-to-erp", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  let ids: number[] | null = null;
  if (body.ids !== undefined) {
    if (!Array.isArray(body.ids)) {
      res.status(400).json({ error: "ids massiv bo'lishi kerak" });
      return;
    }
    ids = body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length === 0) {
      res.status(400).json({ error: "ids bo'sh" });
      return;
    }
  }
  const missing = await pool.query(
    `SELECT m.id, m.nomi, m.narx, m.birlik
     FROM distribution.mahsulotlar m
     WHERE m.faol = 1 AND m.nomi IS NOT NULL AND trim(m.nomi) <> ''
       AND ($1::int[] IS NULL OR m.id = ANY($1::int[]))
       AND NOT EXISTS (SELECT 1 FROM public.products p
                       WHERE ${nameNorm("p.name")} = ${nameNorm("m.nomi")})
     ORDER BY m.id`,
    [ids]
  );
  const added: string[] = [];
  for (const m of missing.rows) {
    // Har biriga SKU beriladi va savdo bot mahsuloti darhol shu SKU'ga bog'lanadi
    const sku = await uniqueProductSku(String(m.nomi));
    const unit = m.birlik === "kg" ? "kg" : "dona";
    const ins = await pool.query(
      `INSERT INTO public.products (name, sku, unit_type, rate_type, currency_type, default_sale_price, active)
       VALUES ($1, $2, $3, $3, 'UZS', $4, TRUE)
       ON CONFLICT (name) DO NOTHING RETURNING name, sku`,
      [String(m.nomi), sku, unit, Number(m.narx ?? 0)]
    );
    if (ins.rows.length > 0) {
      await pool.query(`UPDATE distribution.mahsulotlar SET sku = $1 WHERE id = $2`, [sku, m.id]);
      added.push(String(ins.rows[0].name));
    }
  }
  res.json({ added: added.length, names: added });
});

router.patch("/distribution/products/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "id noto'g'ri" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [];
  let nomiVal: string | null = null;
  let faolVal: number | null = null;

  if (body.nomi !== undefined) {
    const nomi = typeof body.nomi === "string" ? body.nomi.trim().replace(/\s+/g, " ") : "";
    if (!nomi) {
      res.status(400).json({ error: "Mahsulot nomi bo'sh bo'lishi mumkin emas" });
      return;
    }
    const dup = await pool.query(
      `SELECT id FROM distribution.mahsulotlar
       WHERE faol = 1 AND id <> $1 AND ${nameNorm("nomi")} = ${nameNorm("$2")} LIMIT 1`,
      [id, nomi]
    );
    if (dup.rows.length > 0) {
      res.status(409).json({ error: "Bu nomdagi faol mahsulot allaqachon bor" });
      return;
    }
    nomiVal = nomi;
    params.push(nomi);
    sets.push(`nomi = $${params.length}`);
  }
  if (body.narx !== undefined) {
    const narx = Number(body.narx);
    if (!Number.isFinite(narx) || narx <= 0) {
      res.status(400).json({ error: "Narx musbat son bo'lishi kerak" });
      return;
    }
    params.push(Math.round(narx));
    sets.push(`narx = $${params.length}`);
  }
  if (body.birlik !== undefined) {
    if (body.birlik !== "dona" && body.birlik !== "kg") {
      res.status(400).json({ error: "Birlik 'dona' yoki 'kg' bo'lishi kerak" });
      return;
    }
    params.push(body.birlik);
    sets.push(`birlik = $${params.length}`);
  }
  if (body.faol !== undefined) {
    const faol =
      body.faol === true || body.faol === 1 ? 1 : body.faol === false || body.faol === 0 ? 0 : null;
    if (faol === null) {
      res.status(400).json({ error: "faol qiymati noto'g'ri" });
      return;
    }
    faolVal = faol;
    params.push(faol);
    sets.push(`faol = $${params.length}`);
  }
  if (body.sku !== undefined) {
    // SKU orqali ERP mahsulotiga bog'lash ('' — bog'lanishni uzish)
    // Diqqat: mavjud ERP SKU'lar aralash registrda ("shrk35") — aynan yozilganicha solishtiriladi
    const sku = typeof body.sku === "string" ? body.sku.trim() : null;
    if (sku === null) {
      res.status(400).json({ error: "sku matn bo'lishi kerak" });
      return;
    }
    if (sku !== "") {
      const erp = await pool.query(`SELECT 1 FROM public.products WHERE sku = $1`, [sku]);
      if (erp.rows.length === 0) {
        res.status(404).json({ error: "Bunday SKU'li ERP mahsuloti topilmadi" });
        return;
      }
      const used = await pool.query(
        `SELECT 1 FROM distribution.mahsulotlar WHERE sku = $1 AND faol = 1 AND id <> $2 LIMIT 1`,
        [sku, id]
      );
      if (used.rows.length > 0) {
        res.status(409).json({ error: "Bu SKU boshqa faol savdo mahsulotiga bog'langan" });
        return;
      }
    }
    params.push(sku);
    sets.push(`sku = $${params.length}`);
  }

  // Reaktivatsiya himoyasi: faol=1 ga o'tishda (nomi o'zgartirilmasa ham) joriy nom
  // bilan boshqa faol mahsulot to'qnashmasligi tekshiriladi — aks holda nofaol
  // qatorni qayta yoqish dublikat faol mahsulotlarni hosil qilar edi. Eslatma:
  // normallashtirilgan nom bo'yicha DB-darajasida UNIQUE indeks ataylab qo'yilmagan —
  // bot ham dublikat nazoratisiz yozadi, tarixiy ma'lumotda takror nomlar bo'lishi
  // mumkin va mahsulotlar DDL'i 3 joyda drift-nazorat ostida turadi.
  if (faolVal === 1 && nomiVal === null) {
    const dupAct = await pool.query(
      `SELECT 1 FROM distribution.mahsulotlar other
       WHERE other.faol = 1 AND other.id <> $1
         AND ${nameNorm("other.nomi")} =
             ${nameNorm("(SELECT self.nomi FROM distribution.mahsulotlar self WHERE self.id = $1)")}
       LIMIT 1`,
      [id]
    );
    if (dupAct.rows.length > 0) {
      res.status(409).json({
        error: "Bu nomdagi faol mahsulot allaqachon bor — avval nomini o'zgartiring",
      });
      return;
    }
  }

  if (sets.length === 0) {
    res.status(400).json({ error: "O'zgartirish uchun maydon berilmadi" });
    return;
  }

  params.push(id);
  const upd = await pool.query(
    `UPDATE distribution.mahsulotlar SET ${sets.join(", ")}
     WHERE id = $${params.length} RETURNING id, nomi, narx, birlik, faol, sku`,
    params
  );
  if (upd.rows.length === 0) {
    res.status(404).json({ error: "Mahsulot topilmadi" });
    return;
  }
  const r = upd.rows[0];
  res.json({
    id: r.id as number,
    nomi: r.nomi as string,
    narx: Number(r.narx),
    birlik: r.birlik as string,
    faol: Number(r.faol) === 1,
    sku: (r.sku as string) || "",
  });
});

// Nomi mos keladigan (nameNorm) savdo bot mahsulotlarini ERP SKU'lariga
// avtomatik bog'lash. Faqat hali bog'lanmagan (sku='') faol mahsulotlar.
router.post("/distribution/products/auto-link", async (_req, res): Promise<void> => {
  const { rows } = await pool.query(
    `UPDATE distribution.mahsulotlar m
     SET sku = p.sku
     FROM public.products p
     WHERE m.faol = 1 AND COALESCE(m.sku, '') = ''
       AND p.sku <> ''
       AND ${nameNorm("p.name")} = ${nameNorm("m.nomi")}
       AND NOT EXISTS (SELECT 1 FROM distribution.mahsulotlar x
                       WHERE x.sku = p.sku AND x.faol = 1)
       AND (SELECT COUNT(*) FROM public.products p2
            WHERE p2.sku <> '' AND ${nameNorm("p2.name")} = ${nameNorm("m.nomi")}) = 1
     RETURNING m.id, m.nomi, m.sku`
  );
  res.json({ linked: rows.length, items: rows.map((r) => ({ id: r.id, nomi: r.nomi, sku: r.sku })) });
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

  // Davr ichida berilgan nasiya (kredit savdolar) — sana + agent + hudud filtrlari
  const ncp: unknown[] = [];
  let ncw = "";
  if (f.from) {
    ncp.push(f.from);
    ncw += ` AND substr(n.created_at,1,10) >= $${ncp.length}`;
  }
  if (f.to) {
    ncp.push(f.to);
    ncw += ` AND substr(n.created_at,1,10) <= $${ncp.length}`;
  }
  if (f.agentId) {
    ncp.push(f.agentId);
    ncw += ` AND n.agent_id = $${ncp.length}`;
  }
  if (f.viloyat) {
    ncp.push(f.viloyat);
    ncw += ` AND d.viloyat = $${ncp.length}`;
  }
  if (f.hudud) {
    ncp.push(f.hudud);
    ncw += ` AND d.hudud = $${ncp.length}`;
  }

  const shp: unknown[] = [];
  const shw = shopsWhere({ agentId: f.agentId, viloyat: f.viloyat, hudud: f.hudud }, shp);

  // Yangi qo'shilgan do'konlar (davr bo'yicha) — dokonlar.created_at TEXT ISO
  const nsp: unknown[] = [];
  let nsw = shopsWhere({ agentId: f.agentId, viloyat: f.viloyat, hudud: f.hudud }, nsp);
  if (f.from) {
    nsp.push(f.from);
    nsw += ` AND substr(d.created_at,1,10) >= $${nsp.length}`;
  }
  if (f.to) {
    nsp.push(f.to);
    nsw += ` AND substr(d.created_at,1,10) <= $${nsp.length}`;
  }

  // Kirilgan do'konlar (davr bo'yicha): savdo YOKI "olmagan" yozuvi bor
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
    return `SELECT x.dokon_id FROM distribution.${table} x
              JOIN distribution.dokonlar d ON d.id = x.dokon_id WHERE 1=1${w}`;
  };
  const visitedSql = `SELECT COUNT(DISTINCT dokon_id)::int AS c
                        FROM (${visitPart("savdolar")} UNION ALL ${visitPart("olmagan_dokonlar")}) v`;

  // 7/14/30 kundan beri buyurtma bermagan faol do'konlar (joriy holat, sana filtrisiz).
  // Hech qachon buyurtma bermaganlar uchun qo'shilgan sana asos qilinadi.
  const stp: unknown[] = [];
  const stw = shopsWhere({ agentId: f.agentId, viloyat: f.viloyat, hudud: f.hudud }, stp);
  const staleSql = `
    SELECT
      COUNT(*) FILTER (WHERE ref_date <= today - 7)::int  AS s7,
      COUNT(*) FILTER (WHERE ref_date <= today - 14)::int AS s14,
      COUNT(*) FILTER (WHERE ref_date <= today - 30)::int AS s30
    FROM (
      SELECT
        COALESCE(NULLIF(substr(d.last_order_date,1,10),'')::date,
                 NULLIF(substr(d.created_at,1,10),'')::date) AS ref_date,
        (now() AT TIME ZONE 'Asia/Tashkent')::date AS today
      FROM distribution.dokonlar d
      WHERE d.holat = 'faol'${stw}
    ) t
    WHERE ref_date IS NOT NULL`;

  const [sales, activeAgents, shops, collected, outstanding, nasiyaSales, lastSale, newShops, visited, stale] = await Promise.all([
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
    pool.query(
      `SELECT COUNT(*)::int AS c, COALESCE(SUM(n.jami_summa),0)::bigint AS total
         FROM distribution.nasiya n
         JOIN distribution.dokonlar d ON d.id = n.dokon_id
        WHERE 1=1${ncw}`,
      ncp
    ),
    // Oxirgi savdo sanasi (sana filtrisiz — bo'sh davr uchun ko'rsatma)
    pool.query(`SELECT MAX(s.created_at) AS m FROM distribution.savdolar s`),
    pool.query(`SELECT COUNT(*)::int AS c FROM distribution.dokonlar d WHERE 1=1${nsw}`, nsp),
    pool.query(visitedSql, vp),
    pool.query(staleSql, stp),
  ]);

  res.json({
    activeAgents: activeAgents.rows[0].c,
    shopsCount: shops.rows[0].c,
    salesCount: sales.rows[0].c,
    salesTotal: Number(sales.rows[0].total),
    collectedTotal: Number(collected.rows[0].total),
    outstandingTotal: Number(outstanding.rows[0].total),
    nasiyaSalesTotal: Number(nasiyaSales.rows[0].total),
    nasiyaSalesCount: nasiyaSales.rows[0].c,
    lastSaleAt: lastSale.rows[0].m ?? null,
    newShops: newShops.rows[0].c,
    visitedShops: visited.rows[0].c,
    stale7: stale.rows[0].s7,
    stale14: stale.rows[0].s14,
    stale30: stale.rows[0].s30,
  });
});

// ── Bugungi do'kon faolligi (har doim bugungi kun, Asia/Tashkent) ───────────────
router.get("/distribution/today-activity", async (req, res): Promise<void> => {
  const f = parseFilters(req);

  const tq = await pool.query(
    `SELECT to_char(now() AT TIME ZONE 'Asia/Tashkent','YYYY-MM-DD') AS today,
            EXTRACT(ISODOW FROM (now() AT TIME ZONE 'Asia/Tashkent'))::int AS dow`
  );
  const today = tq.rows[0].today as string;
  const dow = tq.rows[0].dow as number;

  // Do'kon darajasidagi filtrlar (agent/viloyat/hudud)
  const geo = { agentId: f.agentId, viloyat: f.viloyat, hudud: f.hudud };

  // Bugun qo'shilgan do'konlar
  const ap: unknown[] = [];
  let aw = shopsWhere(geo, ap);
  ap.push(today);
  aw += ` AND substr(d.created_at,1,10) = $${ap.length}`;

  // Bugun kirilgan (savdo YOKI olmagan) va savdo qilgan do'konlar
  const vp: unknown[] = [today];
  let vGeo = "";
  if (f.agentId) {
    vp.push(f.agentId);
    vGeo += ` AND x.agent_id = $${vp.length}`;
  }
  if (f.viloyat) {
    vp.push(f.viloyat);
    vGeo += ` AND d.viloyat = $${vp.length}`;
  }
  if (f.hudud) {
    vp.push(f.hudud);
    vGeo += ` AND d.hudud = $${vp.length}`;
  }
  const visitSql = `
    WITH sold AS (
      SELECT DISTINCT x.dokon_id FROM distribution.savdolar x
        JOIN distribution.dokonlar d ON d.id = x.dokon_id
       WHERE substr(x.created_at,1,10) = $1${vGeo}
    ), noorder AS (
      SELECT DISTINCT x.dokon_id FROM distribution.olmagan_dokonlar x
        JOIN distribution.dokonlar d ON d.id = x.dokon_id
       WHERE substr(x.created_at,1,10) = $1${vGeo}
    )
    SELECT
      (SELECT COUNT(*) FROM (SELECT dokon_id FROM sold UNION SELECT dokon_id FROM noorder) v)::int AS visited,
      (SELECT COUNT(*) FROM sold)::int AS sold,
      (SELECT COUNT(*) FROM noorder n WHERE NOT EXISTS (SELECT 1 FROM sold s WHERE s.dokon_id = n.dokon_id))::int AS no_sale`;

  // Bugungi marshrutdagi do'konlar orasidan kirilmaganlari
  const rp: unknown[] = [dow, today];
  let rGeo = "";
  if (f.agentId) {
    rp.push(f.agentId);
    rGeo += ` AND da.telegram_id = $${rp.length}`;
  }
  if (f.viloyat) {
    rp.push(f.viloyat);
    rGeo += ` AND d.viloyat = $${rp.length}`;
  }
  if (f.hudud) {
    rp.push(f.hudud);
    rGeo += ` AND d.hudud = $${rp.length}`;
  }
  const routeSql = `
    SELECT
      COUNT(DISTINCT r.dokon_id)::int AS planned,
      COUNT(DISTINCT r.dokon_id) FILTER (
        WHERE NOT EXISTS (SELECT 1 FROM distribution.savdolar s
                           WHERE s.dokon_id = r.dokon_id AND substr(s.created_at,1,10) = $2)
          AND NOT EXISTS (SELECT 1 FROM distribution.olmagan_dokonlar o
                           WHERE o.dokon_id = r.dokon_id AND substr(o.created_at,1,10) = $2)
      )::int AS not_visited
    FROM distribution.delivery_routes r
    JOIN distribution.delivery_agents da ON da.id = r.delivery_agent_id
    JOIN distribution.dokonlar d ON d.id = r.dokon_id
    WHERE r.kun = $1 AND da.faol = 1${rGeo}`;

  const [added, visits, route] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS c FROM distribution.dokonlar d WHERE 1=1${aw}`, ap),
    pool.query(visitSql, vp),
    pool.query(routeSql, rp),
  ]);

  res.json({
    today,
    addedToday: added.rows[0].c,
    visitedToday: visits.rows[0].visited,
    soldToday: visits.rows[0].sold,
    visitedNoSale: visits.rows[0].no_sale,
    routePlanned: route.rows[0].planned,
    routeNotVisited: route.rows[0].not_visited,
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
    WHERE (u.role IN ('agent','supervisor')
           OR EXISTS (SELECT 1 FROM distribution.savdolar sx
                       WHERE sx.agent_id = u.telegram_id))${agentWhere}
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

// ── Do'konlar Intelligence (status, oxirgi tashrif, server-side pagination) ────
// status: faol (oxirgi 7 kunda buyurtma) / risk (8-14 kun) / muammo (15+ kun).
// Hech qachon buyurtma bermaganlar uchun qo'shilgan sana asos qilinadi —
// summary'dagi stale7/14/30 hisobi bilan bir xil qoida (COALESCE last_order_date, created_at).
router.get("/distribution/shops", async (req, res): Promise<void> => {
  const f = parseFilters(req);
  const q = req.query as Record<string, unknown>;
  const pageRaw = typeof q.page === "string" ? Number(q.page) : 1;
  const sizeRaw = typeof q.pageSize === "string" ? Number(q.pageSize) : 25;
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const pageSize = Number.isInteger(sizeRaw) && sizeRaw >= 1 && sizeRaw <= 100 ? sizeRaw : 25;
  const status = typeof q.status === "string" && ["faol", "risk", "muammo"].includes(q.status) ? q.status : undefined;

  const params: unknown[] = [];
  let w = shopsWhere(f, params);

  // Savdoga oid filtrlar (sana oralig'i, to'lov turi, mahsulot) — shu shartlarga
  // mos KAMIDA BITTA savdosi bo'lgan do'konlargina qoladi (EXISTS orqali).
  if (f.from || f.to || f.tolovTuri || f.mahsulotId) {
    let sw = "";
    if (f.from) {
      params.push(f.from);
      sw += ` AND substr(s.created_at,1,10) >= $${params.length}`;
    }
    if (f.to) {
      params.push(f.to);
      sw += ` AND substr(s.created_at,1,10) <= $${params.length}`;
    }
    if (f.tolovTuri) {
      params.push(f.tolovTuri);
      sw += ` AND s.tolov_turi = $${params.length}`;
    }
    if (f.mahsulotId) {
      params.push(f.mahsulotId);
      sw += ` AND EXISTS (SELECT 1 FROM distribution.savdo_tafsilot st
                           WHERE st.savdo_id = s.id AND st.mahsulot_id = $${params.length})`;
    }
    w += ` AND EXISTS (SELECT 1 FROM distribution.savdolar s
                        WHERE s.dokon_id = d.id${sw})`;
  }

  // Asosiy so'rov: har bir do'kon uchun status va oxirgi tashrif (savdo ∪ olmagan)
  let statusFilter = "";
  if (status) {
    params.push(status);
    statusFilter = ` WHERE t.status = $${params.length}`;
  }

  const cte = `
    WITH base AS (
      SELECT
        d.id, d.nomi, d.egasi, d.telefon, d.viloyat, d.hudud, d.holat,
        d.total_orders, d.repeat_orders, d.total_sales, d.last_order_date,
        (d.latitude IS NOT NULL AND d.longitude IS NOT NULL) AS has_location,
        u.name AS agent_name,
        -- Oxirgi tashrif: savdo YOKI "olmagan" yozuvining eng so'nggi sanasi.
        -- PostgreSQL'da GREATEST NULL argumentlarni e'tiborsiz qoldiradi (Oracle'dan
        -- farqli) — faqat ikkala manba ham bo'sh bo'lsa NULL qaytadi. Regressiya
        -- testi: distribution-fresh-db.test.ts ("lastVisit is null-safe").
        GREATEST(
          (SELECT MAX(substr(s.created_at,1,10)) FROM distribution.savdolar s WHERE s.dokon_id = d.id),
          (SELECT MAX(substr(o.created_at,1,10)) FROM distribution.olmagan_dokonlar o WHERE o.dokon_id = d.id)
        ) AS last_visit,
        COALESCE((SELECT SUM(n.qoldiq) FROM distribution.nasiya n
                   WHERE n.dokon_id = d.id AND n.qoldiq > 0),0)::bigint AS outstanding,
        COALESCE(NULLIF(substr(d.last_order_date,1,10),'')::date,
                 NULLIF(substr(d.created_at,1,10),'')::date) AS ref_date,
        (now() AT TIME ZONE 'Asia/Tashkent')::date AS today
      FROM distribution.dokonlar d
      LEFT JOIN distribution.users u ON u.telegram_id = d.agent_id
      WHERE 1=1${w}
    ), t AS (
      SELECT *,
        CASE
          WHEN ref_date IS NULL THEN 'muammo'
          WHEN ref_date >= today - 7  THEN 'faol'
          WHEN ref_date >= today - 14 THEN 'risk'
          ELSE 'muammo'
        END AS status
      FROM base
    )`;

  const dataParams = [...params, pageSize, (page - 1) * pageSize];
  const sql = `${cte}
    SELECT t.*
    FROM t${statusFilter}
    ORDER BY t.total_sales DESC NULLS LAST, t.id
    LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`;
  const countSql = `${cte}
    SELECT COUNT(*)::int AS c FROM t${statusFilter}`;

  // total alohida hisoblanadi — sahifa chegaradan tashqarida bo'lsa ham to'g'ri qoladi
  const [{ rows }, cnt] = await Promise.all([
    pool.query(sql, dataParams),
    pool.query(countSql, params),
  ]);

  res.json({
    page,
    pageSize,
    total: cnt.rows[0].c,
    rows: rows.map((r) => ({
      id: r.id,
      nomi: r.nomi,
      egasi: r.egasi,
      telefon: r.telefon,
      viloyat: r.viloyat,
      hudud: r.hudud,
      holat: r.holat,
      hasLocation: r.has_location,
      totalOrders: r.total_orders,
      repeatOrders: r.repeat_orders,
      totalSales: Number(r.total_sales),
      lastOrderDate: r.last_order_date,
      lastVisit: r.last_visit,
      agentName: r.agent_name,
      outstanding: Number(r.outstanding),
      status: r.status,
    })),
  });
});

// ── Koordinatasi yo'q yoki shubhali do'konlar ──────────────────────────────────
// noCoord: latitude/longitude yo'q bo'lgan faol do'konlar.
// badCoord: koordinatasi bor, lekin viloyat medianidan 60+ km uzoq do'konlar
//           (splitOutliers algoritmi — routePlanService bilan bir xil mantiq).
// MUHIM: bu marshrut /shops/:id dan OLDIN ro'yxatga olinishi shart —
//        aks holda Express "bad-coord" ni :id sifatida izohlaydi.
router.get("/distribution/shops/bad-coord", async (_req, res): Promise<void> => {
  const { rows } = await pool.query(
    `SELECT d.id, d.nomi, d.viloyat, d.hudud, d.latitude, d.longitude
       FROM distribution.dokonlar d
      WHERE (d.holat IS NULL OR d.holat <> 'nofaol')
      ORDER BY d.viloyat NULLS LAST, d.nomi`
  );

  const noCoord: { id: number; nomi: string | null; viloyat: string | null; hudud: string | null }[] = [];
  const byViloyat = new Map<string, { id: number; nomi: string | null; hudud: string | null; lat: number; lng: number }[]>();

  for (const r of rows) {
    if (r.latitude == null || r.longitude == null) {
      noCoord.push({ id: Number(r.id), nomi: r.nomi, viloyat: r.viloyat, hudud: r.hudud });
      continue;
    }
    const key = (r.viloyat as string | null) ?? "__unknown__";
    if (!byViloyat.has(key)) byViloyat.set(key, []);
    byViloyat.get(key)!.push({
      id: Number(r.id),
      nomi: r.nomi,
      hudud: r.hudud,
      lat: Number(r.latitude),
      lng: Number(r.longitude),
    });
  }

  const badCoord: { id: number; nomi: string | null; viloyat: string | null; hudud: string | null; lat: number; lng: number }[] = [];
  for (const [viloyat, shops] of byViloyat) {
    const fakeShops = shops.map((s) => ({ ...s, biz: {} }));
    const { outliers } = splitOutliers(fakeShops as Parameters<typeof splitOutliers>[0]);
    for (const o of outliers) {
      badCoord.push({ id: o.id, nomi: o.nomi, viloyat: viloyat === "__unknown__" ? null : viloyat, hudud: o.hudud, lat: o.lat, lng: o.lng });
    }
  }

  res.json({ noCoord, badCoord });
});

// ── Do'kon GPS koordinatasini yangilash ─────────────────────────────────────────
router.patch("/distribution/shops/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Noto'g'ri do'kon ID" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [];

  if (body.latitude !== undefined || body.lat !== undefined) {
    const raw = body.latitude ?? body.lat;
    if (raw === null) {
      params.push(null);
      sets.push(`latitude = $${params.length}`);
    } else {
      const v = Number(raw);
      if (!Number.isFinite(v) || v < -90 || v > 90) {
        res.status(400).json({ error: "latitude qiymati noto'g'ri (-90..90)" });
        return;
      }
      params.push(v);
      sets.push(`latitude = $${params.length}`);
    }
  }

  if (body.longitude !== undefined || body.lng !== undefined) {
    const raw = body.longitude ?? body.lng;
    if (raw === null) {
      params.push(null);
      sets.push(`longitude = $${params.length}`);
    } else {
      const v = Number(raw);
      if (!Number.isFinite(v) || v < -180 || v > 180) {
        res.status(400).json({ error: "longitude qiymati noto'g'ri (-180..180)" });
        return;
      }
      params.push(v);
      sets.push(`longitude = $${params.length}`);
    }
  }

  if (sets.length === 0) {
    res.status(400).json({ error: "latitude yoki longitude berilishi shart" });
    return;
  }

  params.push(id);
  const upd = await pool.query(
    `UPDATE distribution.dokonlar SET ${sets.join(", ")}
     WHERE id = $${params.length}
     RETURNING id, nomi, latitude, longitude`,
    params
  );
  if (upd.rows.length === 0) {
    res.status(404).json({ error: "Do'kon topilmadi" });
    return;
  }
  const r = upd.rows[0];
  res.json({
    id: r.id as number,
    nomi: r.nomi as string | null,
    latitude: r.latitude != null ? Number(r.latitude) : null,
    longitude: r.longitude != null ? Number(r.longitude) : null,
  });
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
            d.latitude, d.longitude,
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

  const [salesQ, paymentsQ, debtsQ, visitsQ] = await Promise.all([
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
    // Oxirgi tashriflar (mahsulot olinmagan holatlar — sabab + qaytish sanasi bilan)
    pool.query(
      `SELECT o.id, o.created_at, o.sabab, o.sabab_text, o.qaytish_sanasi, o.bajarildi,
              u.name AS agent_name
         FROM distribution.olmagan_dokonlar o
         LEFT JOIN distribution.users u ON u.telegram_id = o.agent_id
        WHERE o.dokon_id = $1
        ORDER BY o.id DESC
        LIMIT 10`,
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
    latitude: s.latitude === null ? null : Number(s.latitude),
    longitude: s.longitude === null ? null : Number(s.longitude),
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
    recentVisits: visitsQ.rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      sabab: r.sabab,
      sababText: r.sabab_text,
      qaytishSanasi: r.qaytish_sanasi,
      bajarildi: r.bajarildi,
      agentName: r.agent_name,
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

// ── Haftalik marshrut xaritasi (Marshrut tab) ──────────────────────────────────
// Bir agentning (yoki hammasining) butun haftalik marshrutlari — har kun alohida
// chiziq sifatida chiziladi. Marshrutga kirmagan do'konlar ham qaytariladi,
// shunda "qolib ketgan" do'konlarni xaritada osongina ko'rish mumkin.
router.get("/distribution/route-map", async (req, res): Promise<void> => {
  const agentParam = typeof req.query.agentId === "string" ? Number(req.query.agentId) : NaN;
  const agentId = Number.isInteger(agentParam) && agentParam > 0 ? agentParam : null;

  const agentsQ = pool.query(
    `SELECT DISTINCT da.id, da.name, da.mashina_nomeri
       FROM distribution.delivery_routes r
       JOIN distribution.delivery_agents da ON da.id = r.delivery_agent_id
      WHERE da.faol = 1
      ORDER BY da.name`
  );

  // Barcha faol yetkazib beruvchi agentlar (marshruti yo'qlari ham) —
  // AI marshrut rejalashtirish dialogi uchun kerak
  const allAgentsQ = pool.query(
    `SELECT id, name, mashina_nomeri FROM distribution.delivery_agents
      WHERE faol = 1 ORDER BY name`
  );

  const stopsQ = pool.query(
    `SELECT r.kun, r.tartib, da.id AS agent_id, da.name AS agent_name,
            d.id AS dokon_id, d.nomi, d.hudud, d.latitude, d.longitude
       FROM distribution.delivery_routes r
       JOIN distribution.delivery_agents da ON da.id = r.delivery_agent_id
       JOIN distribution.dokonlar d ON d.id = r.dokon_id
      WHERE da.faol = 1 AND ($1::int IS NULL OR da.id = $1)
      ORDER BY r.kun, r.tartib`,
    [agentId]
  );

  // Hech qanday marshrutga kiritilmagan do'konlar (barcha agentlar bo'yicha).
  // Nofaol do'konlar chiqarilmaydi — ular marshrutga baribir qo'shilmaydi.
  const unassignedQ = pool.query(
    `SELECT d.id, d.nomi, d.viloyat, d.hudud, d.holat, d.latitude, d.longitude
       FROM distribution.dokonlar d
      WHERE (d.holat IS NULL OR d.holat <> 'nofaol')
        AND NOT EXISTS (SELECT 1 FROM distribution.delivery_routes r
                          JOIN distribution.delivery_agents da ON da.id = r.delivery_agent_id AND da.faol = 1
                         WHERE r.dokon_id = d.id)
      ORDER BY d.nomi`
  );

  const [agents, allAgents, stops, unassigned] = await Promise.all([agentsQ, allAgentsQ, stopsQ, unassignedQ]);

  const withCoord = stops.rows.filter((r) => r.latitude != null && r.longitude != null);
  const noCoord = stops.rows.filter((r) => r.latitude == null || r.longitude == null);
  const unWith = unassigned.rows.filter((r) => r.latitude != null && r.longitude != null);
  const unNo = unassigned.rows.filter((r) => r.latitude == null || r.longitude == null);

  // Har (kun, agent) juftligi uchun statistika: km, vaqt, boshlanish/tugash, AI ball
  const statGroups = new Map<string, { kun: number; agentId: number; agentName: string; pts: { lat: number; lng: number; nomi: string | null }[] }>();
  for (const r of withCoord) {
    const key = `${r.kun}|${r.agent_id}`;
    let g = statGroups.get(key);
    if (!g) {
      g = { kun: r.kun as number, agentId: r.agent_id as number, agentName: r.agent_name as string, pts: [] };
      statGroups.set(key, g);
    }
    g.pts.push({ lat: Number(r.latitude), lng: Number(r.longitude), nomi: r.nomi as string | null });
  }
  const routeStats = [...statGroups.values()].map((g) => ({
    kun: g.kun,
    agentId: g.agentId,
    agentName: g.agentName,
    ...computeRouteStats(g.pts),
  }));

  res.json({
    kunlar: KUNLAR,
    agentId,
    agents: agents.rows.map((a) => ({ id: a.id, name: a.name, mashinaNomeri: a.mashina_nomeri })),
    allAgents: allAgents.rows.map((a) => ({ id: a.id, name: a.name, mashinaNomeri: a.mashina_nomeri })),
    stops: withCoord.map((r) => ({
      kun: r.kun,
      tartib: r.tartib,
      agentId: r.agent_id,
      agentName: r.agent_name,
      dokonId: r.dokon_id,
      nomi: r.nomi,
      hudud: r.hudud,
      lat: Number(r.latitude),
      lng: Number(r.longitude),
    })),
    noCoord: noCoord.map((r) => ({ kun: r.kun, dokonId: r.dokon_id, nomi: r.nomi, hudud: r.hudud })),
    unassigned: unWith.map((r) => ({
      id: r.id,
      nomi: r.nomi,
      viloyat: r.viloyat,
      hudud: r.hudud,
      holat: r.holat,
      lat: Number(r.latitude),
      lng: Number(r.longitude),
    })),
    unassignedNoCoord: unNo.map((r) => ({ id: r.id, nomi: r.nomi, viloyat: r.viloyat, hudud: r.hudud, holat: r.holat })),
    routeStats,
  });
});

// ── AI marshrut rejalashtirish ──────────────────────────────────────────────────
// Bo'sh (boshqa faol agentga biriktirilmagan) faol do'konlarni deterministik
// geo-algoritm bilan optimal kunlik marshrutlarga bo'ladi. viloyat IXTIYORIY —
// berilmasa tanlov faqat GPS asosida (region matni noto'g'ri bo'lsa ham ishlaydi).
// EKSKLYUZIV EGALIK: boshqa faol agent marshrutidagi do'konlar rejaga KIRMAYDI
// (lockedElsewhere hisobida qaytadi) — mavjud marshrutlar o'zgarishsiz qoladi.
// save=true bo'lsa natija delivery_routes jadvaliga yoziladi (agentning O'ZINING
// eski marshrutlari o'chiriladi — shuning uchun replace=true talab qilinadi).
router.post("/distribution/route-plan", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const viloyat = typeof body.viloyat === "string" ? body.viloyat.trim() : "";
  const agentId = Number(body.agentId);
  const save = body.save === true;
  const replace = body.replace === true;
  // force: faqat crossing blokini chetlab o'tadi; dublikat/yo'qolgan do'kon baribir bloklaydi
  const force = body.force === true;

  if (!Number.isInteger(agentId) || agentId <= 0) {
    res.status(400).json({ error: "agentId noto'g'ri" });
    return;
  }

  const run = await runRoutePlan({ agentId, viloyat: viloyat || null, save, replace, force });
  if (!run.ok) {
    res.status(run.status).json({ error: run.error, ...(run.extra ?? {}) });
    return;
  }

  res.json({
    viloyat: run.viloyat,
    agentId: run.agentId,
    agentName: run.agentName,
    saved: run.saved,
    existing: run.existing,
    lockedElsewhere: run.lockedElsewhere,
    totalShops: run.plan.totalShops,
    totalKm: run.plan.totalKm,
    avgScore: run.plan.avgScore,
    businessPriorityActive: run.businessPriorityActive,
    validation: run.validation,
    skippedNoCoord: run.skippedNoCoord,
    badCoord: run.badCoord.map((o) => ({ id: o.id, nomi: o.nomi, hudud: o.hudud, lat: o.lat, lng: o.lng })),
    routes: run.plan.routes.map((r) => ({
      kun: r.kun,
      stats: r.stats,
      bizSummary: r.bizSummary,
      stops: r.stops.map((st) => ({
        dokonId: st.id,
        nomi: st.nomi,
        hudud: st.hudud,
        tartib: st.tartib,
        lat: st.lat,
        lng: st.lng,
        bizScore: st.bizScore,
        bizReasons: st.bizReasons,
      })),
    })),
  });
});

// ── Xarita (Leaflet tab) ────────────────────────────────────────────────────────
// Tanlangan sana bo'yicha do'kon markerlari holati:
//   sold    — shu kuni savdo bo'lgan (yashil)
//   nosale  — kirilgan, mahsulot olinmagan + sabab bor (qizil)
//   visited — kirilgan (pul yig'ilgan), savdo yo'q (ko'k)
//   planned — shu kun marshrutida bor, hali kirilmagan (sariq)
//   none    — hech biri (kulrang)
// date berilmasa — bugungi kun (Asia/Tashkent). kun = sananing isoweekday'i (1..7).
router.get("/distribution/map", async (req, res): Promise<void> => {
  const f = parseFilters(req);
  const q = req.query as Record<string, unknown>;
  const dateRaw = typeof q.date === "string" && DATE_RE.test(q.date) ? q.date : null;

  const dQ = await pool.query(
    `SELECT COALESCE($1::text, to_char(now() AT TIME ZONE 'Asia/Tashkent','YYYY-MM-DD')) AS d,
            EXTRACT(ISODOW FROM COALESCE($1::text::date, (now() AT TIME ZONE 'Asia/Tashkent')::date))::int AS dow`,
    [dateRaw]
  );
  const date = dQ.rows[0].d as string;
  const dow = dQ.rows[0].dow as number; // 1=dushanba .. 7=yakshanba

  // Do'kon markerlari (faqat koordinatasi borlar)
  const sp: unknown[] = [date, dow];
  const sw = shopsWhere(f, sp);
  const shopsQ = pool.query(
    `SELECT d.id, d.nomi, d.telefon, d.viloyat, d.hudud, d.holat,
            d.latitude, d.longitude,
            u.name AS agent_name,
            EXISTS (SELECT 1 FROM distribution.savdolar s
                     WHERE s.dokon_id = d.id AND substr(s.created_at,1,10) = $1)      AS sold,
            EXISTS (SELECT 1 FROM distribution.olmagan_dokonlar o
                     WHERE o.dokon_id = d.id AND substr(o.created_at,1,10) = $1)      AS nosale,
            (SELECT o.sabab FROM distribution.olmagan_dokonlar o
              WHERE o.dokon_id = d.id AND substr(o.created_at,1,10) = $1
              ORDER BY o.id DESC LIMIT 1)                                             AS sabab,
            (SELECT o.sabab_text FROM distribution.olmagan_dokonlar o
              WHERE o.dokon_id = d.id AND substr(o.created_at,1,10) = $1
              ORDER BY o.id DESC LIMIT 1)                                             AS sabab_text,
            (SELECT o.qaytish_sanasi FROM distribution.olmagan_dokonlar o
              WHERE o.dokon_id = d.id AND substr(o.created_at,1,10) = $1
              ORDER BY o.id DESC LIMIT 1)                                             AS qaytish_sanasi,
            EXISTS (SELECT 1 FROM distribution.pul_olish p
                     WHERE p.dokon_id = d.id AND substr(p.created_at,1,10) = $1)      AS paid,
            EXISTS (SELECT 1 FROM distribution.delivery_routes r
                     JOIN distribution.delivery_agents da ON da.id = r.delivery_agent_id AND da.faol = 1
                    WHERE r.dokon_id = d.id AND r.kun = $2)                           AS on_route
       FROM distribution.dokonlar d
       LEFT JOIN distribution.users u ON u.telegram_id = d.agent_id
      WHERE d.latitude IS NOT NULL AND d.longitude IS NOT NULL${sw}`,
    sp
  );

  // Marshrut to'xtashlari (polyline uchun, tartib bilan)
  const rp: unknown[] = [dow, date];
  let rw = "";
  if (f.agentId) {
    rp.push(f.agentId);
    rw += ` AND da.telegram_id = $${rp.length}`;
  }
  if (f.viloyat) {
    rp.push(f.viloyat);
    rw += ` AND d.viloyat = $${rp.length}`;
  }
  if (f.hudud) {
    rp.push(f.hudud);
    rw += ` AND d.hudud = $${rp.length}`;
  }
  const routesQ = pool.query(
    `SELECT da.id AS agent_id, da.name AS agent_name, da.mashina_nomeri,
            r.tartib, d.id AS dokon_id, d.nomi AS dokon_name, d.latitude, d.longitude,
            EXISTS (SELECT 1 FROM distribution.savdolar s
                     WHERE s.dokon_id = d.id AND substr(s.created_at,1,10) = $2) AS sold,
            (EXISTS (SELECT 1 FROM distribution.savdolar s
                      WHERE s.dokon_id = d.id AND substr(s.created_at,1,10) = $2)
             OR EXISTS (SELECT 1 FROM distribution.olmagan_dokonlar o
                         WHERE o.dokon_id = d.id AND substr(o.created_at,1,10) = $2)
             OR EXISTS (SELECT 1 FROM distribution.pul_olish p
                         WHERE p.dokon_id = d.id AND substr(p.created_at,1,10) = $2)) AS visited
       FROM distribution.delivery_routes r
       JOIN distribution.delivery_agents da ON da.id = r.delivery_agent_id
       JOIN distribution.dokonlar d ON d.id = r.dokon_id
      WHERE r.kun = $1 AND da.faol = 1
        AND d.latitude IS NOT NULL AND d.longitude IS NOT NULL${rw}
      ORDER BY da.name, r.tartib`,
    rp
  );

  const [shops, routes] = await Promise.all([shopsQ, routesQ]);

  res.json({
    date,
    kun: dow,
    shops: shops.rows.map((r) => {
      const status = r.sold
        ? "sold"
        : r.nosale
          ? "nosale"
          : r.paid
            ? "visited"
            : r.on_route
              ? "planned"
              : "none";
      return {
        id: r.id,
        nomi: r.nomi,
        telefon: r.telefon,
        viloyat: r.viloyat,
        hudud: r.hudud,
        holat: r.holat,
        lat: Number(r.latitude),
        lng: Number(r.longitude),
        agentName: r.agent_name,
        status,
        sabab: r.sabab,
        sababText: r.sabab_text,
        qaytishSanasi: r.qaytish_sanasi,
      };
    }),
    routes: routes.rows.map((r) => ({
      agentId: r.agent_id,
      agentName: r.agent_name,
      mashinaNomeri: r.mashina_nomeri,
      tartib: r.tartib,
      dokonId: r.dokon_id,
      dokonName: r.dokon_name,
      lat: Number(r.latitude),
      lng: Number(r.longitude),
      sold: r.sold,
      visited: r.visited,
    })),
  });
});

// ── Marshrut progressi (har bir yetkazib beruvchi agent uchun) ──────────────────
// planned/visited/sold/remaining — tanlangan sana marshrutidagi do'konlar bo'yicha.
router.get("/distribution/route-progress", async (req, res): Promise<void> => {
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

  const params: unknown[] = [dow, date];
  let w = "";
  if (f.agentId) {
    params.push(f.agentId);
    w += ` AND da.telegram_id = $${params.length}`;
  }
  if (f.viloyat) {
    params.push(f.viloyat);
    w += ` AND d.viloyat = $${params.length}`;
  }
  if (f.hudud) {
    params.push(f.hudud);
    w += ` AND d.hudud = $${params.length}`;
  }

  const { rows } = await pool.query(
    `WITH stops AS (
       SELECT da.id AS agent_id, da.name AS agent_name, da.mashina_nomeri, r.dokon_id,
              EXISTS (SELECT 1 FROM distribution.savdolar s
                       WHERE s.dokon_id = r.dokon_id AND substr(s.created_at,1,10) = $2) AS sold,
              EXISTS (SELECT 1 FROM distribution.olmagan_dokonlar o
                       WHERE o.dokon_id = r.dokon_id AND substr(o.created_at,1,10) = $2) AS noorder,
              EXISTS (SELECT 1 FROM distribution.pul_olish p
                       WHERE p.dokon_id = r.dokon_id AND substr(p.created_at,1,10) = $2) AS paid
         FROM distribution.delivery_routes r
         JOIN distribution.delivery_agents da ON da.id = r.delivery_agent_id
         JOIN distribution.dokonlar d ON d.id = r.dokon_id
        WHERE r.kun = $1 AND da.faol = 1${w}
     )
     SELECT agent_id, agent_name, mashina_nomeri,
            COUNT(*)::int                                        AS planned,
            COUNT(*) FILTER (WHERE sold OR noorder OR paid)::int AS visited,
            COUNT(*) FILTER (WHERE sold)::int                    AS sold
       FROM stops
      GROUP BY agent_id, agent_name, mashina_nomeri
      ORDER BY agent_name`,
    params
  );

  res.json({
    date,
    kun: dow,
    agents: rows.map((r) => ({
      agentId: r.agent_id,
      agentName: r.agent_name,
      mashinaNomeri: r.mashina_nomeri,
      planned: r.planned,
      visited: r.visited,
      sold: r.sold,
      remaining: r.planned - r.visited,
    })),
  });
});

// ── Jonli holat: har bir delivery agentning oxirgi GPS nuqtasi + bugungi progress ──
// Bot yozgan agent_locations (telegram_id bo'yicha) + marshrut statistikasi + savdolar.
router.get("/distribution/live-status", async (req, res): Promise<void> => {
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

  const params: unknown[] = [dow, date];
  let stopsW = "";
  if (f.viloyat) {
    params.push(f.viloyat);
    stopsW += ` AND d.viloyat = $${params.length}`;
  }
  if (f.hudud) {
    params.push(f.hudud);
    stopsW += ` AND d.hudud = $${params.length}`;
  }
  let agentW = "";
  if (f.agentId) {
    params.push(f.agentId);
    agentW += ` AND da.telegram_id = $${params.length}`;
  }
  // Viloyat/hudud filtri berilsa — faqat shu hududda marshruti bor agentlar
  const restrict = f.viloyat || f.hudud ? " AND p.agent_id IS NOT NULL" : "";

  const { rows } = await pool.query(
    `WITH stops AS (
       SELECT da.id AS agent_id, r.dokon_id,
              EXISTS (SELECT 1 FROM distribution.savdolar s
                       WHERE s.dokon_id = r.dokon_id AND substr(s.created_at,1,10) = $2) AS sold,
              EXISTS (SELECT 1 FROM distribution.olmagan_dokonlar o
                       WHERE o.dokon_id = r.dokon_id AND substr(o.created_at,1,10) = $2) AS noorder,
              EXISTS (SELECT 1 FROM distribution.pul_olish pl
                       WHERE pl.dokon_id = r.dokon_id AND substr(pl.created_at,1,10) = $2) AS paid
         FROM distribution.delivery_routes r
         JOIN distribution.delivery_agents da ON da.id = r.delivery_agent_id
         JOIN distribution.dokonlar d ON d.id = r.dokon_id
        WHERE r.kun = $1 AND da.faol = 1${stopsW}
     ),
     prog AS (
       SELECT agent_id,
              COUNT(*)::int                                        AS planned,
              COUNT(*) FILTER (WHERE sold OR noorder OR paid)::int AS visited,
              COUNT(*) FILTER (WHERE sold)::int                    AS sold
         FROM stops GROUP BY agent_id
     ),
     loc AS (
       SELECT DISTINCT ON (agent_id) agent_id, latitude, longitude, created_at
         FROM distribution.agent_locations
        WHERE substr(created_at,1,10) = $2
        ORDER BY agent_id, created_at DESC
     ),
     sales AS (
       SELECT agent_id, COALESCE(SUM(jami_summa),0) AS total, COUNT(*)::int AS cnt
         FROM distribution.savdolar
        WHERE substr(created_at,1,10) = $2
        GROUP BY agent_id
     )
     SELECT da.id, da.name, da.mashina_nomeri, da.hudud, da.telegram_id,
            COALESCE(p.planned,0)::int  AS planned,
            COALESCE(p.visited,0)::int  AS visited,
            COALESCE(p.sold,0)::int     AS sold,
            l.latitude  AS loc_lat,
            l.longitude AS loc_lng,
            l.created_at AS loc_at,
            COALESCE(sa.total,0)        AS sales_total,
            COALESCE(sa.cnt,0)::int     AS sales_count
       FROM distribution.delivery_agents da
       LEFT JOIN prog p  ON p.agent_id  = da.id
       LEFT JOIN loc l   ON l.agent_id  = da.telegram_id
       LEFT JOIN sales sa ON sa.agent_id = da.telegram_id
      WHERE da.faol = 1${agentW}
        AND (p.agent_id IS NOT NULL OR l.agent_id IS NOT NULL OR sa.agent_id IS NOT NULL)${restrict}
      ORDER BY da.name`,
    params
  );

  res.json({
    date,
    kun: dow,
    agents: rows.map((r) => ({
      agentId: r.id,
      agentName: r.name,
      mashinaNomeri: r.mashina_nomeri,
      hudud: r.hudud,
      planned: r.planned,
      visited: r.visited,
      sold: r.sold,
      remaining: r.planned - r.visited,
      salesTotal: Number(r.sales_total),
      salesCount: r.sales_count,
      lastLocation:
        r.loc_lat != null && r.loc_lng != null
          ? { lat: r.loc_lat, lng: r.loc_lng, at: r.loc_at as string }
          : null,
    })),
  });
});

// ── Analytics (savdo/conversion/repeat/nasiya foizlari va kunlik dinamika) ────────
// from/to/agentId/viloyat/hudud/tolovTuri/mahsulotId/search filtrlari qo'llanadi.
// conversionPct = soldShops / visitedShops * 100 (visit bo'lmasa null).
// repeatPct = savdo qilgan do'konlar orasida avvalroq ham savdo qilganlar ulushi.
// nasiyaPct = nasiya+aralash savdolar / jami savdolar * 100.
// avgVisitsPerDay = jami shop_day_pairs / ish kunlari soni.
//
// Arxitektura: savdolar filtri salesWhere (tolovTuri/mahsulotId/search ham);
// olmagan filtri alohida owParams (tolovTuri/mahsulotId olmagan bilan bog'liq emas).
// Visited shops uchun owOff = ow $N indekslari swParams.length ga siljitiladi.
router.get("/distribution/analytics", async (req, res): Promise<void> => {
  const f = parseFilters(req);

  const dQ = await pool.query(
    `SELECT to_char(now() AT TIME ZONE 'Asia/Tashkent','YYYY-MM-DD') AS today`
  );
  const today = dQ.rows[0].today as string;

  const fromDate = f.from ?? (() => {
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() - 29);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const toDate = f.to ?? today;

  // ef: from/to kafolatli — salesWhere har doim date filtrni qo'shadi
  const ef: Filters = { ...f, from: fromDate, to: toDate };

  // sw: salesWhere barcha savdo filtrlarini (tolovTuri, mahsulotId, search ham) qo'shadi.
  // swParams[0] = fromDate (salesWhere 'from'ni birinchi push qiladi).
  const swParams: unknown[] = [];
  const sw = salesWhere(ef, swParams);

  // ow: olmagan_dokonlar filtri — faqat sana+agent+do'kon maydonlari
  // (tolovTuri/mahsulotId olmagan tashriflar bilan bog'liq emas)
  const owParams: unknown[] = [];
  let ow = "";
  owParams.push(fromDate); ow += ` AND substr(o.created_at,1,10) >= $${owParams.length}`;
  owParams.push(toDate);   ow += ` AND substr(o.created_at,1,10) <= $${owParams.length}`;
  if (ef.agentId) { owParams.push(ef.agentId); ow += ` AND o.agent_id = $${owParams.length}`; }
  if (ef.viloyat) { owParams.push(ef.viloyat); ow += ` AND d.viloyat = $${owParams.length}`; }
  if (ef.hudud)   { owParams.push(ef.hudud);   ow += ` AND d.hudud = $${owParams.length}`; }
  if (ef.search)  { owParams.push(`%${ef.search}%`); ow += ` AND d.nomi ILIKE $${owParams.length}`; }

  // owOff: olmagan WHERE $N indekslarini swParams soni qadar siljitamiz
  // (visited shops birlashtirilgan so'rovida [swParams,...owParams] ishlatiladi)
  const owOff = ow.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) + swParams.length}`);
  const combinedP = [...swParams, ...owParams];

  const [kpiR, visitedR, dailySR, dailyVisitR] = await Promise.all([
    // 1. Savdolar KPI — barcha filtrlar (salesWhere orqali)
    pool.query(`
      WITH period_sales AS (
        SELECT s.dokon_id, s.jami_summa, s.tolov_turi, s.created_at
          FROM distribution.savdolar s
          JOIN distribution.dokonlar d ON d.id = s.dokon_id
         WHERE 1=1${sw}
      ),
      repeat_shops AS (
        SELECT COUNT(DISTINCT ps.dokon_id)::int AS cnt
          FROM period_sales ps
         WHERE EXISTS (
           SELECT 1 FROM distribution.savdolar prev
            WHERE prev.dokon_id = ps.dokon_id
              AND substr(prev.created_at,1,10) < $1
         )
      )
      SELECT
        COUNT(DISTINCT ps.dokon_id)::int               AS sold_shops,
        COUNT(*)::int                                   AS sales_count,
        COALESCE(SUM(ps.jami_summa),0)::bigint          AS sales_total,
        COUNT(*) FILTER (WHERE ps.tolov_turi IN ('nasiya','aralash'))::int AS nasiya_count,
        COUNT(DISTINCT substr(ps.created_at,1,10))::int AS work_days,
        (SELECT cnt FROM repeat_shops)                  AS repeat_shops
      FROM period_sales ps
    `, swParams),

    // 2. Visited shops: savdolar ∪ olmagan (noyob do'konlar soni)
    pool.query(`
      SELECT COUNT(DISTINCT dokon_id)::int AS cnt
        FROM (
          SELECT s.dokon_id FROM distribution.savdolar s
            JOIN distribution.dokonlar d ON d.id = s.dokon_id
           WHERE 1=1${sw}
          UNION
          SELECT o.dokon_id FROM distribution.olmagan_dokonlar o
            JOIN distribution.dokonlar d ON d.id = o.dokon_id
           WHERE 1=1${owOff}
        ) v
    `, combinedP),

    // 3. Kunlik savdolar statistikasi (savdo soni + summasi)
    pool.query(`
      SELECT substr(s.created_at,1,10) AS date,
             COUNT(*)::int AS sales,
             COALESCE(SUM(s.jami_summa),0)::bigint AS sales_total
        FROM distribution.savdolar s
        JOIN distribution.dokonlar d ON d.id = s.dokon_id
       WHERE 1=1${sw}
       GROUP BY substr(s.created_at,1,10)
    `, swParams),

    // 4. Kunlik NOYOB tashrif qilingan do'konlar (savdolar ∪ olmagan, UNION-dedupe)
    // UNION (DISTINCT) har kunda bir xil do'kon bir marta hisoblanishini kafolatlaydi
    pool.query(`
      SELECT v.date, COUNT(DISTINCT v.dokon_id)::int AS visited_shops
        FROM (
          SELECT substr(s.created_at,1,10) AS date, s.dokon_id
            FROM distribution.savdolar s
            JOIN distribution.dokonlar d ON d.id = s.dokon_id
           WHERE 1=1${sw}
          UNION
          SELECT substr(o.created_at,1,10) AS date, o.dokon_id
            FROM distribution.olmagan_dokonlar o
            JOIN distribution.dokonlar d ON d.id = o.dokon_id
           WHERE 1=1${owOff}
        ) v
       GROUP BY v.date
    `, combinedP),
  ]);

  const k = kpiR.rows[0];
  const soldShops     = Number(k.sold_shops);
  const visitedShops  = Number(visitedR.rows[0]?.cnt ?? 0);
  const repeatShops   = Number(k.repeat_shops ?? 0);
  const nasiCnt       = Number(k.nasiya_count);
  const totalSalesCnt = Number(k.sales_count);
  const workDays      = Number(k.work_days);

  // Kunlik qatorlarni sana oralig'i bo'yicha birlashtirish
  // dailySMap: faqat savdo soni/summasi (visits uchun ishlatilmaydi — UNION dedupe quyida)
  const dailySMap = new Map<string, { sales: number; salesTotal: number }>();
  for (const r of dailySR.rows) {
    dailySMap.set(r.date as string, {
      sales: Number(r.sales),
      salesTotal: Number(r.sales_total),
    });
  }
  // dailyVisitMap: UNION DISTINCT so'rovidan — har kunda noyob tashrif qilingan do'konlar soni
  // (bir do'kon savdo ham, olmagan ham bo'lsa BIR marta hisoblanadi)
  const dailyVisitMap = new Map<string, number>();
  for (const r of dailyVisitR.rows) {
    dailyVisitMap.set(r.date as string, Number(r.visited_shops));
  }

  const daily: Array<{ date: string; visits: number; sales: number; salesTotal: number }> = [];
  // shopDayPairs: jami shop-kun juftliklari, visitWorkDays: tashrif bor kunlar soni
  // avgVisitsPerDay denominator = visitWorkDays (savdo+olmagan), "olmagan-only" davrda to'g'ri ishlaydi
  let shopDayPairs = 0;
  let visitWorkDays = 0;
  const cur = new Date(`${fromDate}T12:00:00`);
  const end = new Date(`${toDate}T12:00:00`);
  while (cur <= end) {
    const dateStr = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
    const s = dailySMap.get(dateStr);
    const visits = dailyVisitMap.get(dateStr) ?? 0;
    daily.push({ date: dateStr, visits, sales: s?.sales ?? 0, salesTotal: s?.salesTotal ?? 0 });
    shopDayPairs += visits;
    if (visits > 0) visitWorkDays += 1;
    cur.setDate(cur.getDate() + 1);
  }

  res.json({
    from: fromDate,
    to: toDate,
    kpi: {
      visitedShops,
      soldShops,
      conversionPct: visitedShops > 0 ? Math.round((soldShops / visitedShops) * 100) : null,
      repeatPct: soldShops > 0 ? Math.round((repeatShops / soldShops) * 100) : null,
      nasiyaPct: totalSalesCnt > 0 ? Math.round((nasiCnt / totalSalesCnt) * 100) : null,
      avgVisitsPerDay: visitWorkDays > 0 ? Math.round((shopDayPairs / visitWorkDays) * 10) / 10 : null,
      salesCount: totalSalesCnt,
      salesTotal: Number(k.sales_total),
      nasiyaCount: nasiCnt,
    },
    daily,
  });
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

// ── Smart Suggestions (rule-based tavsiyalar) ────────────────────────────────────
// 3 turdagi tavsiya:
//   agents  — GPS jo'natgan agentlarga eng yaqin, bugun hali kirilmagan do'konlar
//   overdue — oxirgi xariddan beri odatdagidan ko'p vaqt o'tgan do'konlar (30+ kun)
//   qaytish — olmagan_dokonlar.qaytish_sanasi <= bugun va bajarildi NULL (yoki 0)
// agentId/viloyat/hudud filtrlari qo'llanadi.
router.get("/distribution/suggestions", async (req, res): Promise<void> => {
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

  res.json({
    date: today,
    kun: dow,
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
  if (f.agentId) {
    params.push(f.agentId);
    agentW += ` AND da.telegram_id = $${params.length}`;
  }
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
        WHERE substr(s.created_at,1,10) = $1${agentW}${shopW}
        GROUP BY s.agent_id
     ),
     nosale_agg AS (
       SELECT o.agent_id,
              COUNT(DISTINCT o.dokon_id)::int AS nosale_shops
         FROM distribution.olmagan_dokonlar o
         JOIN distribution.dokonlar dk ON dk.id = o.dokon_id
        WHERE substr(o.created_at,1,10) = $1${agentW}${shopW}
        GROUP BY o.agent_id
     ),
     payment_agg AS (
       SELECT p.agent_id,
              COUNT(DISTINCT p.dokon_id)::int AS payment_only_shops
         FROM distribution.pul_olish p
         JOIN distribution.dokonlar dk ON dk.id = p.dokon_id
        WHERE substr(p.created_at,1,10) = $1${agentW}${shopW}
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
        WHERE substr(s.created_at,1,10) = $1${agentW}${shopW}
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
          )${agentW}${shopW}
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
          )${agentW}${shopW}
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

  // 3. No-sale reasons breakdown per agent
  const reasonsQ = pool.query(
    `SELECT o.agent_id,
            COALESCE(o.sabab,'boshqa') AS sabab,
            COUNT(*)::int AS cnt
       FROM distribution.olmagan_dokonlar o
       JOIN distribution.dokonlar dk ON dk.id = o.dokon_id
      WHERE substr(o.created_at,1,10) = $1${agentW}${shopW}
      GROUP BY o.agent_id, COALESCE(o.sabab,'boshqa')
      ORDER BY o.agent_id, cnt DESC`,
    params
  );

  const [summary, stops, reasons] = await Promise.all([summaryQ, stopsQ, reasonsQ]);

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
