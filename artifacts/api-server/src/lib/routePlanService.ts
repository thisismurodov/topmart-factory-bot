// ── Marshrut rejalashtirish xizmati ────────────────────────────────────────────
// route-plan endpointi va CLI skript uchun UMUMIY mantiq.
//
// ASOSIY QOIDA — eksklyuziv egalik ("bitta do'kon → bitta marshrut → bitta agent"):
// boshqa FAOL agentlarning marshrutlarida turgan do'konlar "qulflangan" hisoblanadi
// va rejalashtirish kirishiga umuman kiritilmaydi. Shu bilan mavjud marshrutlar
// o'zgarishsiz qoladi (locked) va hech qachon ikki agentda bir xil do'kon bo'lmaydi.
//
// Viloyat filtri IXTIYORIY: berilmasa, tanlov GPS asosida bo'ladi — barcha bo'sh
// (birovga biriktirilmagan) koordinatali faol do'konlar olinadi, mintaqa medianidan
// 60+ km uzoq nuqtalar splitOutliers bilan chiqariladi. Bu viloyat matni noto'g'ri
// kiritilgan do'konlarni ham to'g'ri hududga qo'shish imkonini beradi (region
// haqiqatda GPS koordinatadan aniqlanadi, yaratgan agent yozuvidan emas).
import { pool } from "@workspace/db";
import {
  DEFAULT_START_POINT,
  type BizWeights,
  computeBusinessScores,
  planRoutes,
  splitOutliers,
  validatePlan,
  type PlanShop,
  type PlanResult,
  type PlanValidation,
  type ShopBusinessSignals,
} from "./routePlanner";

// ── Bir martalik backfill: eski marshrut qatorlariga biz_score/biz_reasons ─────
// biz_score/biz_reasons faqat marshrut REJALASHTIRUVCHI orqali saqlanganda
// yoziladi. Ushbu yangilanishdan OLDIN saqlangan marshrutlar (va bot orqali
// qo'lda qo'shilgan to'xtashlar, added_by_dlv=1) NULL biz ustunlari bilan
// qoladi — agentlar hech qanday shoshilinchlik belgisini ko'rmaydi.
//
// QAROR: bot orqali qo'shilgan to'xtashlar HAM ball oladi — shoshilinchlik
// (nasiya, savdo, tashrif) do'konning biznes holatini bildiradi, to'xtash
// qanday qo'shilganidan qat'i nazar. added_by_dlv bayrog'i o'zgarmaydi.
//
// Idempotent: faqat biz_score IS NULL qatorlarni yangilaydi. Ballar
// computeBusinessScores bilan AGENT kohorti bo'yicha normalizatsiya qilinadi
// (rejalashtiruvchidagi kabi nisbiy ball — agentning o'z marshruti ichida).
// Signal umuman bo'lmagan agent kohortida qatorlar NULL bo'lib qoladi
// (badge yo'q — ma'lumot yo'q).
export async function backfillRouteBizScores(): Promise<{ scanned: number; updated: number }> {
  const nullQ = await pool.query(
    `SELECT r.delivery_agent_id, r.dokon_id
       FROM distribution.delivery_routes r
      WHERE r.biz_score IS NULL
      GROUP BY r.delivery_agent_id, r.dokon_id`
  );
  if (nullQ.rows.length === 0) return { scanned: 0, updated: 0 };

  // Agent → do'kon idlari
  const byAgent = new Map<number, number[]>();
  const allShopIds = new Set<number>();
  for (const row of nullQ.rows) {
    const agentId = Number(row.delivery_agent_id);
    const dokonId = Number(row.dokon_id);
    if (!byAgent.has(agentId)) byAgent.set(agentId, []);
    byAgent.get(agentId)!.push(dokonId);
    allShopIds.add(dokonId);
  }
  const shopIds = [...allShopIds];

  // Rejalashtiruvchidagi BIR XIL signallar: savdo (90 kun), nasiya, oxirgi tashrif
  const nintyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const [salesQ, creditQ, visitQ] = await Promise.all([
    pool.query(
      `SELECT s.dokon_id, SUM(t.summa)::bigint AS sales_sum
         FROM distribution.savdolar s
         JOIN distribution.savdo_tafsilot t ON t.savdo_id = s.id
        WHERE s.dokon_id = ANY($1::int[])
          AND substr(s.created_at, 1, 10) >= $2
        GROUP BY s.dokon_id`,
      [shopIds, nintyDaysAgo]
    ),
    pool.query(
      `SELECT dokon_id, SUM(qoldiq)::bigint AS credit_balance
         FROM distribution.nasiya
        WHERE dokon_id = ANY($1::int[])
        GROUP BY dokon_id`,
      [shopIds]
    ),
    pool.query(
      `SELECT dokon_id,
              (CURRENT_DATE - MAX(substr(created_at,1,10))::date) AS days_since
         FROM (
           SELECT dokon_id, created_at FROM distribution.savdolar
            WHERE dokon_id = ANY($1::int[])
           UNION ALL
           SELECT dokon_id, created_at FROM distribution.olmagan_dokonlar
            WHERE dokon_id = ANY($1::int[])
         ) v
        GROUP BY dokon_id`,
      [shopIds]
    ),
  ]);
  const salesMap  = new Map<number, number>(salesQ.rows.map((r)  => [Number(r.dokon_id), Number(r.sales_sum)]));
  const creditMap = new Map<number, number>(creditQ.rows.map((r) => [Number(r.dokon_id), Number(r.credit_balance)]));
  const daysMap   = new Map<number, number>(visitQ.rows.map((r)  => [Number(r.dokon_id), Number(r.days_since)]));

  let updated = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [agentId, ids] of byAgent) {
      // Kohort = agent marshrutidagi do'konlar (nisbiy normalizatsiya shu ichida)
      const cohort: PlanShop[] = ids.map((id) => ({
        id,
        nomi: null,
        hudud: null,
        lat: 0,
        lng: 0,
        biz: {
          salesSum: salesMap.get(id),
          creditBalance: creditMap.get(id),
          daysSinceVisit: daysMap.get(id),
        } satisfies ShopBusinessSignals,
      }));
      const scores = computeBusinessScores(cohort);
      if (scores.size === 0) continue; // kohortda signal yo'q — NULL qoladi

      for (const [dokonId, entry] of scores) {
        const res = await client.query(
          `UPDATE distribution.delivery_routes
              SET biz_score = $1, biz_reasons = $2
            WHERE delivery_agent_id = $3 AND dokon_id = $4 AND biz_score IS NULL`,
          [
            entry.score,
            entry.reasons.length > 0 ? JSON.stringify(entry.reasons) : null,
            agentId,
            dokonId,
          ]
        );
        updated += res.rowCount ?? 0;
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  return { scanned: nullQ.rows.length, updated };
}

export type RoutePlanFailure = {
  ok: false;
  status: number;
  error: string;
  extra?: Record<string, unknown>;
};

export type RoutePlanSuccess = {
  ok: true;
  agentId: number;
  agentName: string;
  viloyat: string | null;
  existing: number; // agentning saqlashdan oldingi marshrut nuqtalari soni
  lockedElsewhere: number; // boshqa faol agentlar egallagani uchun chiqarilgan do'konlar
  saved: boolean;
  forceSaved: boolean; // crossing ogohlantirishlariga qaramay force=true bilan saqlandi (audit)
  plan: PlanResult;
  validation: PlanValidation;
  skippedNoCoord: { id: number; nomi: string | null }[];
  badCoord: PlanShop[];
  businessPriorityActive: boolean; // biznes signallari marshrut tartibiga ta'sir qildimi
};

export type RoutePlanRun = RoutePlanFailure | RoutePlanSuccess;

export async function runRoutePlan(opts: {
  agentId: number;
  viloyat?: string | null;
  save?: boolean;
  replace?: boolean;
  // force=true: crossing blokini chetlab o'tadi (dublikat/yo'qolgan do'kon baribir bloklaydi)
  force?: boolean;
  // Biznes ustuvorlik vaznlari (nasiya/tashrif/savdo) — berilmasa default 40/35/25
  bizWeights?: Partial<BizWeights> | null;
}): Promise<RoutePlanRun> {
  const { agentId } = opts;
  const viloyat = opts.viloyat?.trim() ? opts.viloyat.trim() : null;

  const agentQ = await pool.query(
    `SELECT id, name, faol FROM distribution.delivery_agents WHERE id = $1`,
    [agentId]
  );
  if (agentQ.rows.length === 0) {
    return { ok: false, status: 404, error: "Agent topilmadi" };
  }
  if (Number(agentQ.rows[0].faol) !== 1) {
    return { ok: false, status: 400, error: "Agent nofaol — marshrut biriktirib bo'lmaydi" };
  }

  const existingQ = await pool.query(
    `SELECT count(*)::int AS c FROM distribution.delivery_routes WHERE delivery_agent_id = $1`,
    [agentId]
  );
  const existing = existingQ.rows[0].c as number;

  // Qulflangan do'konlar: boshqa FAOL agentlarning marshrutlaridagi do'konlar.
  // Ular rejaga kirmaydi — mavjud marshrutlar kompaniya aktivi sifatida saqlanadi.
  const lockedQ = await pool.query(
    `SELECT DISTINCT r.dokon_id
       FROM distribution.delivery_routes r
       JOIN distribution.delivery_agents a ON a.id = r.delivery_agent_id
      WHERE a.faol = 1 AND r.delivery_agent_id <> $1`,
    [agentId]
  );
  const locked = new Set<number>(lockedQ.rows.map((r) => Number(r.dokon_id)));

  const params: unknown[] = [];
  let where = `(d.holat IS NULL OR d.holat <> 'nofaol')`;
  if (viloyat) {
    params.push(viloyat);
    where += ` AND d.viloyat = $${params.length}`;
  }
  const shopsQ = await pool.query(
    `SELECT d.id, d.nomi, d.hudud, d.latitude, d.longitude
       FROM distribution.dokonlar d
      WHERE ${where}
      ORDER BY d.id`,
    params
  );

  const freeRows = shopsQ.rows.filter((r) => !locked.has(Number(r.id)));
  const lockedElsewhere = shopsQ.rows.length - freeRows.length;

  const coordRows = freeRows.filter((r) => r.latitude != null && r.longitude != null);
  const skippedNoCoord = freeRows
    .filter((r) => r.latitude == null || r.longitude == null)
    .map((r) => ({ id: Number(r.id), nomi: r.nomi as string | null }));

  if (coordRows.length === 0) {
    return {
      ok: false,
      status: 400,
      error: viloyat
        ? `${viloyat} viloyatida bo'sh (boshqa agentga biriktirilmagan) koordinatali faol do'kon topilmadi`
        : "Bo'sh (boshqa agentga biriktirilmagan) koordinatali faol do'kon topilmadi",
    };
  }

  // Biznes signallarini yuklash: savdo hajmi, nasiya balansi, oxirgi tashrif
  const shopIds = coordRows.map((r) => Number(r.id));
  const nintyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const [salesQ, creditQ, visitQ] = await Promise.all([
    pool.query(
      `SELECT s.dokon_id, SUM(t.summa)::bigint AS sales_sum
         FROM distribution.savdolar s
         JOIN distribution.savdo_tafsilot t ON t.savdo_id = s.id
        WHERE s.dokon_id = ANY($1::int[])
          AND substr(s.created_at, 1, 10) >= $2
        GROUP BY s.dokon_id`,
      [shopIds, nintyDaysAgo]
    ),
    pool.query(
      `SELECT dokon_id, SUM(qoldiq)::bigint AS credit_balance
         FROM distribution.nasiya
        WHERE dokon_id = ANY($1::int[])
        GROUP BY dokon_id`,
      [shopIds]
    ),
    pool.query(
      `SELECT dokon_id,
              (CURRENT_DATE - MAX(substr(created_at,1,10))::date) AS days_since
         FROM (
           SELECT dokon_id, created_at FROM distribution.savdolar
            WHERE dokon_id = ANY($1::int[])
           UNION ALL
           SELECT dokon_id, created_at FROM distribution.olmagan_dokonlar
            WHERE dokon_id = ANY($1::int[])
         ) v
        GROUP BY dokon_id`,
      [shopIds]
    ),
  ]);

  const salesMap  = new Map<number, number>(salesQ.rows.map((r)  => [Number(r.dokon_id), Number(r.sales_sum)]));
  const creditMap = new Map<number, number>(creditQ.rows.map((r) => [Number(r.dokon_id), Number(r.credit_balance)]));
  const daysMap   = new Map<number, number>(visitQ.rows.map((r)  => [Number(r.dokon_id), Number(r.days_since)]));

  const hasBizSignals = salesMap.size > 0 || creditMap.size > 0 || daysMap.size > 0;

  const shops: PlanShop[] = coordRows.map((r) => {
    const id = Number(r.id);
    const biz: ShopBusinessSignals = {
      salesSum:      salesMap.get(id),
      creditBalance: creditMap.get(id),
      daysSinceVisit: daysMap.get(id),
    };
    return {
      id,
      nomi: r.nomi as string | null,
      hudud: r.hudud as string | null,
      lat: Number(r.latitude),
      lng: Number(r.longitude),
      biz,
    };
  });

  // GPS xatosi bo'lgan do'konlar (mintaqa medianidan 60+ km) rejaga kirmaydi
  const { inliers, outliers } = splitOutliers(shops);
  const plan = planRoutes(inliers, {
    startPoint: DEFAULT_START_POINT,
    businessPriority: hasBizSignals,
    bizWeights: opts.bizWeights,
  });
  const validation = validatePlan(plan, inliers);

  // Eksklyuzivlik himoyasi (belt-and-braces): reja ichida qulflangan do'kon
  // bo'lsa — strukturaviy xato, saqlash bloklanadi. Konstruktsiya bo'yicha
  // bo'lishi mumkin emas, lekin kelajakdagi o'zgarishlardan himoya qiladi.
  const overlap = plan.routes.flatMap((r) => r.stops).filter((st) => locked.has(st.id));
  if (overlap.length > 0) {
    validation.ok = false;
    validation.issues.push(
      `${overlap.length} ta do'kon boshqa faol agent marshrutida ham bor (eksklyuzivlik buzildi)`
    );
  }

  let saved = false;
  // force_saved auditi: force haqiqatan crossing blokini chetlab o'tgandagina 1 —
  // ya'ni validatsiya xatolari bor edi, hammasi crossing bilan bog'liq (forceable)
  // va force=true yuborilgan. Optimizer o'zi muvaffaqiyatli bo'lsa — 0.
  let forceApplied = false;
  if (opts.save) {
    // force=true bo'lsa crossing bloki chetlab o'tiladi; boshqa xatolar (dublikat,
    // yo'qolgan, tartib, eksklyuzivlik) baribir saqlashni bloklaydi.
    // validation.forceable: validatePlan tomonidan hisoblangan — barcha xatolar
    // faqat crossing bilan bog'liq bo'lsa true.
    const { forceable } = validation;
    forceApplied = opts.force === true && forceable && validation.issues.length > 0;
    const blockingIssues = forceApplied
      ? [] // force bilan crossing bloki chetlab o'tiladi
      : validation.issues;
    if (blockingIssues.length > 0) {
      return {
        ok: false,
        status: 422,
        error: `Reja sifat tekshiruvidan o'tmadi: ${blockingIssues.join("; ")}`,
        extra: { validation, forceable },
      };
    }
    if (existing > 0 && !opts.replace) {
      return {
        ok: false,
        status: 409,
        error: `Agentda ${existing} ta mavjud marshrut nuqtasi bor. Almashtirish uchun replace=true yuboring.`,
        extra: { existing },
      };
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM distribution.delivery_routes WHERE delivery_agent_id = $1`, [
        agentId,
      ]);
      const nowIso = new Date()
        .toLocaleString("sv-SE", { timeZone: "Asia/Tashkent" })
        .replace(" ", "T");
      for (const r of plan.routes) {
        for (const st of r.stops) {
          await client.query(
            `INSERT INTO distribution.delivery_routes (delivery_agent_id, kun, dokon_id, tartib, created_at, added_by_dlv, force_saved, biz_score, biz_reasons)
             VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8)`,
            [
              agentId,
              r.kun,
              st.id,
              st.tartib,
              nowIso,
              forceApplied ? 1 : 0,
              st.bizScore ?? null,
              st.bizReasons && st.bizReasons.length > 0 ? JSON.stringify(st.bizReasons) : null,
            ]
          );
        }
      }
      await client.query("COMMIT");
      saved = true;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  return {
    ok: true,
    agentId,
    agentName: agentQ.rows[0].name as string,
    viloyat,
    existing,
    lockedElsewhere,
    saved,
    forceSaved: saved && forceApplied,
    plan,
    validation,
    skippedNoCoord,
    badCoord: outliers,
    businessPriorityActive: plan.businessPriorityActive ?? false,
  };
}
