import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

// Distribyutsiya moduli o'zining `distribution` sxemasida yashaydi (o'zbekcha jadval
// nomlari — savdolar, dokonlar, nasiya ...). Bu yerdagi barcha endpointlar faqat
// o'qish uchun (read-only) — dashboard'ning "Distribyutsiya" bo'limi shulardan foydalanadi.
// Barcha summalar so'mda (UZS, bigint). Sanalar TEXT (ISO-8601) ko'rinishida saqlanadi.

const router: IRouter = Router();

// ── Umumiy ko'rsatkichlar (KPI kartalar) ────────────────────────────────────────
router.get("/distribution/summary", async (_req, res): Promise<void> => {
  const [agents, shops, sales, monthSales, collected, outstanding] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS c FROM distribution.users WHERE role IN ('agent','supervisor')`),
    pool.query(`SELECT COUNT(*)::int AS c FROM distribution.dokonlar WHERE holat = 'faol'`),
    pool.query(`SELECT COUNT(*)::int AS c, COALESCE(SUM(jami_summa),0)::bigint AS total FROM distribution.savdolar`),
    pool.query(
      `SELECT COUNT(*)::int AS c, COALESCE(SUM(jami_summa),0)::bigint AS total
         FROM distribution.savdolar
        WHERE substr(created_at,1,7) = to_char(now() AT TIME ZONE 'Asia/Tashkent','YYYY-MM')`
    ),
    pool.query(`SELECT COALESCE(SUM(summa),0)::bigint AS total FROM distribution.pul_olish`),
    pool.query(`SELECT COALESCE(SUM(qoldiq),0)::bigint AS total FROM distribution.nasiya WHERE qoldiq > 0`),
  ]);

  res.json({
    agentsCount: agents.rows[0].c,
    shopsCount: shops.rows[0].c,
    salesCount: sales.rows[0].c,
    salesTotal: Number(sales.rows[0].total),
    monthSalesCount: monthSales.rows[0].c,
    monthSalesTotal: Number(monthSales.rows[0].total),
    collectedTotal: Number(collected.rows[0].total),
    outstandingTotal: Number(outstanding.rows[0].total),
  });
});

// ── Agentlar (sotuv agentlari) ──────────────────────────────────────────────────
router.get("/distribution/agents", async (_req, res): Promise<void> => {
  const { rows } = await pool.query(`
    SELECT
      u.telegram_id,
      u.name,
      u.viloyat,
      u.role,
      (SELECT COUNT(*)::int FROM distribution.dokonlar d
         WHERE d.agent_id = u.telegram_id AND d.holat = 'faol')                       AS shops,
      (SELECT COUNT(*)::int FROM distribution.savdolar s
         WHERE s.agent_id = u.telegram_id)                                            AS sales_count,
      (SELECT COALESCE(SUM(s.jami_summa),0)::bigint FROM distribution.savdolar s
         WHERE s.agent_id = u.telegram_id)                                            AS sales_total,
      (SELECT COALESCE(SUM(p.summa),0)::bigint FROM distribution.pul_olish p
         WHERE p.agent_id = u.telegram_id)                                            AS collected,
      (SELECT COALESCE(SUM(n.qoldiq),0)::bigint FROM distribution.nasiya n
         WHERE n.agent_id = u.telegram_id AND n.qoldiq > 0)                           AS outstanding
    FROM distribution.users u
    WHERE u.role IN ('agent','supervisor')
    ORDER BY sales_total DESC NULLS LAST
  `);

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
      outstanding: Number(r.outstanding),
    }))
  );
});

// ── Do'konlar ───────────────────────────────────────────────────────────────────
router.get("/distribution/shops", async (_req, res): Promise<void> => {
  const { rows } = await pool.query(`
    SELECT
      d.id, d.nomi, d.egasi, d.telefon, d.viloyat, d.hudud, d.holat,
      d.total_orders, d.total_sales, d.last_order_date,
      u.name AS agent_name,
      COALESCE((SELECT SUM(n.qoldiq) FROM distribution.nasiya n
                 WHERE n.dokon_id = d.id AND n.qoldiq > 0),0)::bigint AS outstanding
    FROM distribution.dokonlar d
    LEFT JOIN distribution.users u ON u.telegram_id = d.agent_id
    ORDER BY d.created_at DESC NULLS LAST
    LIMIT 500
  `);

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

// ── Savdolar (oxirgi 100 ta) ────────────────────────────────────────────────────
router.get("/distribution/sales", async (_req, res): Promise<void> => {
  const { rows } = await pool.query(`
    SELECT
      s.id, s.created_at, s.jami_summa, s.tolov_turi,
      u.name AS agent_name,
      d.nomi AS dokon_name,
      d.viloyat,
      (SELECT string_agg(m.nomi || ' x' || st.miqdor::text, ', ')
         FROM distribution.savdo_tafsilot st
         JOIN distribution.mahsulotlar m ON m.id = st.mahsulot_id
        WHERE st.savdo_id = s.id) AS items
    FROM distribution.savdolar s
    LEFT JOIN distribution.users u ON u.telegram_id = s.agent_id
    LEFT JOIN distribution.dokonlar d ON d.id = s.dokon_id
    ORDER BY s.id DESC
    LIMIT 100
  `);

  res.json(
    rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      total: Number(r.jami_summa),
      tolovTuri: r.tolov_turi,
      agentName: r.agent_name,
      dokonName: r.dokon_name,
      viloyat: r.viloyat,
      items: r.items,
    }))
  );
});

// ── Nasiya (do'konlar bo'yicha qarzdorlik) ──────────────────────────────────────
router.get("/distribution/debts", async (_req, res): Promise<void> => {
  const { rows } = await pool.query(`
    SELECT
      d.id AS dokon_id, d.nomi AS dokon_name, d.telefon, d.viloyat,
      u.name AS agent_name,
      SUM(n.qoldiq)::bigint AS outstanding,
      COUNT(*)::int         AS entries,
      MAX(n.updated_at)     AS last_update
    FROM distribution.nasiya n
    JOIN distribution.dokonlar d ON d.id = n.dokon_id
    LEFT JOIN distribution.users u ON u.telegram_id = n.agent_id
    WHERE n.qoldiq > 0
    GROUP BY d.id, d.nomi, d.telefon, d.viloyat, u.name
    ORDER BY outstanding DESC
  `);

  res.json(
    rows.map((r) => ({
      dokonId: r.dokon_id,
      dokonName: r.dokon_name,
      telefon: r.telefon,
      viloyat: r.viloyat,
      agentName: r.agent_name,
      outstanding: Number(r.outstanding),
      entries: r.entries,
      lastUpdate: r.last_update,
    }))
  );
});

export default router;
