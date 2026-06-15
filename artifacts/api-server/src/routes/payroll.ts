import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  GetPayrollRoleRatesResponse,
  UpdatePayrollRoleRateBody,
  UpdatePayrollRoleRateResponse,
  GetKgPayrollWorkersResponse,
  GetKgPayrollWorkersResponseItem,
  AssignKgPayrollWorkerBody,
  RemoveKgPayrollWorkerParams,
  RemoveKgPayrollWorkerResponse,
  GetPayrollWorkerEarningsResponse,
  GetPayrollDayStatusResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const toIso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : (typeof v === "string" ? v : null);

// ── GET /payroll/role-rates — list global role rates ──────────────────────────
router.get("/payroll/role-rates", async (_req, res): Promise<void> => {
  const { rows } = await pool.query(
    `SELECT scope, role, rate, updated_at FROM payroll_role_rates ORDER BY scope, role`
  );
  res.json(
    GetPayrollRoleRatesResponse.parse(
      rows.map((r) => ({
        scope: r.scope,
        role: r.role,
        rate: Number(r.rate),
        updatedAt: toIso(r.updated_at),
      }))
    )
  );
});

// ── PUT /payroll/role-rates — upsert a role rate ──────────────────────────────
router.put("/payroll/role-rates", async (req, res): Promise<void> => {
  const parsed = UpdatePayrollRoleRateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const scope = parsed.data.scope ?? "arqon";
  const { role, rate } = parsed.data;

  const { rows } = await pool.query(
    `INSERT INTO payroll_role_rates (scope, role, rate, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (scope, role) DO UPDATE SET rate = EXCLUDED.rate, updated_at = NOW()
     RETURNING scope, role, rate, updated_at`,
    [scope, role, rate]
  );
  const r = rows[0];
  res.json(
    UpdatePayrollRoleRateResponse.parse({
      scope: r.scope,
      role: r.role,
      rate: Number(r.rate),
      updatedAt: toIso(r.updated_at),
    })
  );
});

// ── GET /payroll/workers — list assigned kg-payroll workers ───────────────────
router.get("/payroll/workers", async (_req, res): Promise<void> => {
  const { rows } = await pool.query(
    `SELECT id, scope, worker_name, role, active
     FROM kg_payroll_workers
     ORDER BY role, worker_name`
  );
  res.json(
    GetKgPayrollWorkersResponse.parse(
      rows.map((r) => ({
        id: r.id,
        scope: r.scope,
        workerName: r.worker_name,
        role: r.role,
        active: r.active,
      }))
    )
  );
});

// ── POST /payroll/workers — assign a worker to the kg-payroll pool ─────────────
router.post("/payroll/workers", async (req, res): Promise<void> => {
  const parsed = AssignKgPayrollWorkerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const scope = parsed.data.scope ?? "arqon";
  const { workerName, role } = parsed.data;

  const { rows } = await pool.query(
    `INSERT INTO kg_payroll_workers (scope, worker_name, role, active)
     VALUES ($1, $2, $3, TRUE)
     ON CONFLICT (scope, worker_name, role) DO UPDATE SET active = TRUE
     RETURNING id, scope, worker_name, role, active`,
    [scope, workerName, role]
  );
  const r = rows[0];
  res.status(201).json(
    GetKgPayrollWorkersResponseItem.parse({
      id: r.id,
      scope: r.scope,
      workerName: r.worker_name,
      role: r.role,
      active: r.active,
    })
  );
});

// ── DELETE /payroll/workers/:id — remove an assignment ────────────────────────
router.delete("/payroll/workers/:id", async (req, res): Promise<void> => {
  const parsed = RemoveKgPayrollWorkerParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = await pool.query("DELETE FROM kg_payroll_workers WHERE id = $1", [
    parsed.data.id,
  ]);
  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Assignment not found" });
    return;
  }
  res.json(RemoveKgPayrollWorkerResponse.parse({ status: "ok" }));
});

// ── GET /payroll/worker-earnings — per-worker today/month/lifetime + kg ───────
// Producers come from batches.earnings; shared (prep/packer) from salary_entries
// daily_shared rows. Periods are computed in Asia/Tashkent.
router.get("/payroll/worker-earnings", async (_req, res): Promise<void> => {
  const { rows } = await pool.query(
    `WITH bounds AS (
       SELECT (NOW() AT TIME ZONE 'Asia/Tashkent')::date AS today,
              date_trunc('month', (NOW() AT TIME ZONE 'Asia/Tashkent'))::date AS m_start,
              (date_trunc('month', (NOW() AT TIME ZONE 'Asia/Tashkent')) + interval '1 month')::date AS m_end
     ),
     ev AS (
       SELECT worker,
              (created_at AT TIME ZONE 'Asia/Tashkent')::date AS d,
              weight_kg::numeric AS kg,
              earnings::numeric  AS amt
       FROM batches
       UNION ALL
       SELECT worker, work_date AS d, kg::numeric AS kg, amount::numeric AS amt
       FROM salary_entries
       WHERE source_type = 'daily_shared'
     )
     SELECT ev.worker,
       COALESCE(SUM(amt) FILTER (WHERE d = b.today), 0)                          AS "todayEarnings",
       COALESCE(SUM(amt) FILTER (WHERE d >= b.m_start AND d < b.m_end), 0)       AS "monthEarnings",
       COALESCE(SUM(amt), 0)                                                     AS "lifetimeEarnings",
       COALESCE(SUM(kg)  FILTER (WHERE d = b.today), 0)                          AS "todayKg",
       COALESCE(SUM(kg)  FILTER (WHERE d >= b.m_start AND d < b.m_end), 0)       AS "monthKg",
       COALESCE(SUM(kg), 0)                                                      AS "lifetimeKg"
     FROM ev CROSS JOIN bounds b
     GROUP BY ev.worker, b.today, b.m_start, b.m_end
     ORDER BY ev.worker`
  );
  res.json(
    GetPayrollWorkerEarningsResponse.parse(
      rows.map((r) => ({
        worker: r.worker,
        todayEarnings: Number(r.todayEarnings),
        monthEarnings: Number(r.monthEarnings),
        lifetimeEarnings: Number(r.lifetimeEarnings),
        todayKg: Number(r.todayKg),
        monthKg: Number(r.monthKg),
        lifetimeKg: Number(r.lifetimeKg),
      }))
    )
  );
});

// ── GET /payroll/day-status — today's close status + producer volume ──────────
router.get("/payroll/day-status", async (_req, res): Promise<void> => {
  const { rows } = await pool.query(
    `WITH d AS (SELECT (NOW() AT TIME ZONE 'Asia/Tashkent')::date AS today)
     SELECT
       d.today AS work_date,
       COALESCE((
         SELECT SUM(b.weight_kg)
         FROM batches b
         WHERE b.payroll_method = 'ROLE_BASED_KG'
           AND (b.created_at AT TIME ZONE 'Asia/Tashkent')::date = d.today
       ), 0) AS total_kg,
       (SELECT closed_at FROM daily_payroll_runs r
        WHERE r.scope = 'arqon' AND r.work_date = d.today) AS closed_at
     FROM d`
  );
  const r = rows[0];
  const closedAt = toIso(r.closed_at);
  res.json(
    GetPayrollDayStatusResponse.parse({
      workDate: toIso(r.work_date) ?? String(r.work_date),
      totalKg: Number(r.total_kg),
      closed: closedAt !== null,
      closedAt,
    })
  );
});

export default router;
