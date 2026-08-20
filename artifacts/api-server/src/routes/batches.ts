import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  GetBatchesQueryParams,
  GetBatchesResponse,
  DeleteBatchParams,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
const PAYROLL_SCOPE = "arqon";

router.get("/batches", async (req, res): Promise<void> => {
  const parsed = GetBatchesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { date, worker, product, limit = 50, offset = 0 } = parsed.data;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (date) {
    params.push(date);
    conditions.push(`b.created_at::date = $${params.length}`);
  }
  if (worker) {
    params.push(worker);
    conditions.push(`b.worker = $${params.length}`);
  }
  if (product) {
    params.push(product);
    conditions.push(`b.product = $${params.length}`);
  }

  // archived=true ko'rsatilmasa, faqat faol partiyalar ko'rsatiladi
  const showArchived = (req.query.archived as string) === "true";
  if (!showArchived) {
    conditions.push(`(b.archived = FALSE OR b.archived IS NULL)`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const filterParams = [...params];

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const [itemsResult, countResult] = await Promise.all([
    pool.query(
      `SELECT
         b.id,
         b.batch_code,
         b.worker,
         b.product,
         b.quantity,
         b.weight_kg,
         b.earnings,
         b.payroll_method,
         b.created_at,
         COALESCE(b.production_line_id, p.line_id) AS payroll_line_id,
         pl.name AS payroll_line_name,
         to_char(
           (b.created_at AT TIME ZONE 'Asia/Tashkent')::date,
           'YYYY-MM-DD'
         ) AS payroll_work_date,
         CASE
           WHEN b.payroll_method <> 'ROLE_BASED_KG' THEN 'PRODUCT_RATE'
           WHEN COALESCE(b.production_line_id, p.line_id) IS NULL THEN 'UNASSIGNED'
           WHEN dpr.line_id IS NOT NULL THEN 'CLOSED'
           ELSE 'OPEN'
         END AS payroll_status,
         CASE
           WHEN dpr.line_id IS NOT NULL THEN COALESCE(se.total_amount, 0)
           ELSE NULL
         END AS frozen_daily_earnings
       FROM batches b
       LEFT JOIN products p ON p.name = b.product
       LEFT JOIN production_lines pl
         ON pl.id = COALESCE(b.production_line_id, p.line_id)
       LEFT JOIN daily_payroll_runs dpr
         ON dpr.scope = $${params.length + 1}
        AND dpr.line_id = COALESCE(b.production_line_id, p.line_id)
        AND dpr.work_date = (b.created_at AT TIME ZONE 'Asia/Tashkent')::date
       LEFT JOIN (
         SELECT scope, line_id, work_date, SUM(amount) AS total_amount
         FROM salary_entries
         WHERE source_type = 'daily_shared'
         GROUP BY scope, line_id, work_date
       ) se
         ON se.scope = dpr.scope
        AND se.line_id = dpr.line_id
        AND se.work_date = dpr.work_date
       ${where}
       ORDER BY b.id DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, PAYROLL_SCOPE]
    ),
    pool.query(`SELECT COUNT(*) AS cnt FROM batches b ${where}`, filterParams),
  ]);

  res.json(
    GetBatchesResponse.parse({
      items: itemsResult.rows.map((b) => ({
        id: b.id,
        batchCode: b.batch_code,
        worker: b.worker,
        product: b.product,
        quantity: b.quantity,
        weightKg: Number(b.weight_kg),
        earnings: Number(b.earnings),
        payrollMethod: b.payroll_method,
        payrollStatus: b.payroll_status,
        payrollLineId: b.payroll_line_id === null ? null : Number(b.payroll_line_id),
        payrollLineName: b.payroll_line_name,
        payrollWorkDate: b.payroll_work_date,
        frozenDailyEarnings:
          b.frozen_daily_earnings === null ? null : Number(b.frozen_daily_earnings),
        createdAt: b.created_at instanceof Date ? b.created_at.toISOString() : b.created_at,
      })),
      total: Number(countResult.rows[0].cnt),
    })
  );
});

router.delete("/batches/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteBatchParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const result = await pool.query("DELETE FROM batches WHERE id = $1", [params.data.id]);

  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Batch not found" });
    return;
  }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

// ── PATCH /batches/:id/archive — yumshoq arxivlash ───────────────────────────
router.patch("/batches/:id/archive", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const archived = req.body?.archived !== false; // default: true (arxivlash)
  const result = await pool.query(
    "UPDATE batches SET archived=$1 WHERE id=$2", [archived, id]
  );
  if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: "Batch not found" }); return; }
  res.json({ ok: true, archived });
});

export default router;
