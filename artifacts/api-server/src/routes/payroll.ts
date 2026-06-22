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
  GetProductionLinesResponse,
  CreateProductionLineBody,
  CreateProductionLineResponse,
  DeleteProductionLineParams,
  DeleteProductionLineResponse,
  AddProductionLineWorkerParams,
  AddProductionLineWorkerBody,
  AddProductionLineWorkerResponse,
  RemoveProductionLineWorkerParams,
  RemoveProductionLineWorkerResponse,
  ClosePayrollDayResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const SCOPE = "arqon";

// Per-line maximum workers by role (minimums are surfaced as warnings, not enforced on add)
const ROLE_MAX: Record<string, number> = {
  producer: 5,
  preparation: 3,
  packaging: 5,
};

const ROLE_UZ: Record<string, string> = {
  producer: "Ishlab chiqaruvchi",
  preparation: "Tayyorlovchi",
  packaging: "Upakovkachi",
  packer: "Upakovkachi",
};

const toIso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null;

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
  const scope = parsed.data.scope ?? SCOPE;
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

// ── GET /payroll/workers — list assigned kg-payroll workers (legacy pool) ──────
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

// ── POST /payroll/workers — assign a worker to the legacy kg-payroll pool ──────
router.post("/payroll/workers", async (req, res): Promise<void> => {
  const parsed = AssignKgPayrollWorkerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const scope = parsed.data.scope ?? SCOPE;
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

// ── DELETE /payroll/workers/:id — remove a legacy assignment ──────────────────
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

// ── GET /payroll/lines — list production lines ────────────────────────────────
router.get("/payroll/lines", async (_req, res): Promise<void> => {
  const { rows } = await pool.query(
    `SELECT id, name, created_at FROM production_lines ORDER BY id`
  );
  res.json(
    GetProductionLinesResponse.parse(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: toIso(r.created_at),
      }))
    )
  );
});

// ── POST /payroll/lines — create a production line ────────────────────────────
router.post("/payroll/lines", async (req, res): Promise<void> => {
  const parsed = CreateProductionLineBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const name = parsed.data.name.trim();
  if (!name) {
    res.status(400).json({ error: "Liniya nomi bo'sh bo'lishi mumkin emas" });
    return;
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO production_lines (name) VALUES ($1) RETURNING id, name, created_at`,
      [name]
    );
    const r = rows[0];
    res.json(
      CreateProductionLineResponse.parse({
        id: r.id,
        name: r.name,
        createdAt: toIso(r.created_at),
      })
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      res.status(409).json({ error: "Bu nomli liniya allaqachon mavjud" });
      return;
    }
    throw e;
  }
});

// ── DELETE /payroll/lines/:id — delete a production line ───────────────────────
// Refused when the line is referenced by batches / payroll history, otherwise
// the line's kg snapshot (batches.production_line_id is a plain int, not an FK)
// would be orphaned and silently excluded from payroll.
router.delete("/payroll/lines/:id", async (req, res): Promise<void> => {
  const parsed = DeleteProductionLineParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const lineId = parsed.data.id;

  const { rows: refRows } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM batches WHERE production_line_id = $1)::int AS batches,
       (SELECT COUNT(*) FROM daily_payroll_runs WHERE line_id = $1)::int AS runs,
       (SELECT COUNT(*) FROM salary_entries WHERE line_id = $1)::int AS entries`,
    [lineId]
  );
  const ref = refRows[0];
  if (ref.batches > 0 || ref.runs > 0 || ref.entries > 0) {
    res.status(409).json({
      error: "Bu liniyada partiyalar yoki hisoblangan maoshlar mavjud — o'chirib bo'lmaydi",
    });
    return;
  }

  const result = await pool.query("DELETE FROM production_lines WHERE id = $1", [lineId]);
  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Liniya topilmadi" });
    return;
  }
  res.json(DeleteProductionLineResponse.parse({ status: "ok" }));
});

// ── POST /payroll/lines/:id/workers — add a worker (enforces per-role max) ─────
router.post("/payroll/lines/:id/workers", async (req, res): Promise<void> => {
  const paramsParsed = AddProductionLineWorkerParams.safeParse(req.params);
  const bodyParsed = AddProductionLineWorkerBody.safeParse(req.body);
  if (!paramsParsed.success) {
    res.status(400).json({ error: paramsParsed.error.message });
    return;
  }
  if (!bodyParsed.success) {
    res.status(400).json({ error: bodyParsed.error.message });
    return;
  }
  const lineId = paramsParsed.data.id;
  const workerName = bodyParsed.data.workerName.trim();
  const role = bodyParsed.data.role;

  if (!workerName) {
    res.status(400).json({ error: "Ishchi ismi bo'sh bo'lishi mumkin emas" });
    return;
  }

  // Serialize the count+insert per (line, role) so concurrent requests can't
  // exceed the per-role maximum (COUNT-then-INSERT is otherwise racy).
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `add_worker:${lineId}:${role}`,
    ]);

    const { rows: lineRows } = await client.query(
      "SELECT 1 FROM production_lines WHERE id = $1",
      [lineId]
    );
    if (lineRows.length === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Liniya topilmadi" });
      return;
    }

    // Per-line max_workers from line_role_config; fallback to hardcoded ROLE_MAX
    const { rows: cfgRows } = await client.query(
      `SELECT max_workers FROM line_role_config WHERE line_id = $1 AND role_key = $2`,
      [lineId, role]
    );
    let max: number;
    if (cfgRows.length > 0) {
      max = Number(cfgRows[0].max_workers);
    } else if (ROLE_MAX[role] !== undefined) {
      max = ROLE_MAX[role];
    } else {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Noma'lum rol: ${role}` });
      return;
    }

    const { rows: cntRows } = await client.query(
      "SELECT COUNT(*)::int AS c FROM production_line_workers WHERE line_id = $1 AND role = $2",
      [lineId, role]
    );
    if (cntRows[0].c >= max) {
      await client.query("ROLLBACK");
      res.status(400).json({
        error: `${ROLE_UZ[role] ?? role} uchun maksimal soni (${max}) to'ldi`,
      });
      return;
    }

    const { rows } = await client.query(
      `INSERT INTO production_line_workers (line_id, worker_name, role)
       VALUES ($1, $2, $3)
       RETURNING id, line_id, worker_name, role`,
      [lineId, workerName, role]
    );
    await client.query("COMMIT");
    const r = rows[0];
    res.json(
      AddProductionLineWorkerResponse.parse({
        id: r.id,
        lineId: r.line_id,
        workerName: r.worker_name,
        role: r.role,
      })
    );
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if ((e as { code?: string }).code === "23505") {
      const msg =
        role === "producer"
          ? "Bu ishlab chiqaruvchi allaqachon bir liniyaga biriktirilgan"
          : "Bu xodim allaqachon ushbu rol bilan biror liniyaga biriktirilgan";
      res.status(409).json({ error: msg });
      return;
    }
    throw e;
  } finally {
    client.release();
  }
});

// ── DELETE /payroll/line-workers/:id — remove a worker from a line ─────────────
router.delete("/payroll/line-workers/:id", async (req, res): Promise<void> => {
  const parsed = RemoveProductionLineWorkerParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = await pool.query(
    "DELETE FROM production_line_workers WHERE id = $1",
    [parsed.data.id]
  );
  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Xodim topilmadi" });
    return;
  }
  res.json(RemoveProductionLineWorkerResponse.parse({ status: "ok" }));
});

// ── GET /payroll/worker-earnings — per-worker today/month/lifetime + kg + line ─
// Producers come from batches.earnings; shared (prep/packaging) from salary_entries
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
       (SELECT pl.name FROM production_line_workers plw
          JOIN production_lines pl ON pl.id = plw.line_id
          WHERE plw.worker_name = ev.worker
          ORDER BY CASE plw.role WHEN 'producer' THEN 0 WHEN 'preparation' THEN 1 ELSE 2 END
          LIMIT 1)                                                                AS "lineName",
       (SELECT plw.role FROM production_line_workers plw
          WHERE plw.worker_name = ev.worker
          ORDER BY CASE plw.role WHEN 'producer' THEN 0 WHEN 'preparation' THEN 1 ELSE 2 END
          LIMIT 1)                                                                AS "role",
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
        lineName: r.lineName ?? null,
        role: r.role ?? null,
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

// ── GET /payroll/day-status — per-line today snapshot + pool previews ──────────
router.get("/payroll/day-status", async (_req, res): Promise<void> => {
  const { rows: dRows } = await pool.query(
    `SELECT to_char((NOW() AT TIME ZONE 'Asia/Tashkent')::date, 'YYYY-MM-DD') AS today`
  );
  const today: string = dRows[0].today;

  const [rateRes, lineRes, memberRes, kgRes, runRes, roleConfigRes] = await Promise.all([
    pool.query(`SELECT role, rate FROM payroll_role_rates WHERE scope = $1`, [SCOPE]),
    pool.query(`SELECT id, name FROM production_lines ORDER BY id`),
    pool.query(
      `SELECT id, line_id, worker_name, role FROM production_line_workers
       ORDER BY line_id, role, worker_name`
    ),
    pool.query(
      `SELECT COALESCE(b.production_line_id, plw.line_id) AS production_line_id,
              COALESCE(SUM(b.weight_kg), 0) AS kg
       FROM batches b
       LEFT JOIN production_line_workers plw
         ON plw.worker_name = b.worker AND plw.role = 'producer'
         AND b.production_line_id IS NULL
       WHERE (b.created_at AT TIME ZONE 'Asia/Tashkent')::date = $1
       GROUP BY COALESCE(b.production_line_id, plw.line_id)`,
      [today]
    ),
    pool.query(
      `SELECT line_id, closed_at FROM daily_payroll_runs
       WHERE scope = $1 AND work_date = $2`,
      [SCOPE, today]
    ),
    pool.query(
      `SELECT line_id, role_key, label, rate, max_workers
       FROM line_role_config ORDER BY line_id, role_key`
    ),
  ]);

  // Global fallback rates
  const globalRates: Record<string, number> = {};
  for (const r of rateRes.rows) globalRates[r.role] = Number(r.rate);

  // Per-line role configs: Map<lineId, Map<roleKey, {label, rate, maxWorkers}>>
  type RoleCfg = { label: string; rate: number; maxWorkers: number };
  const lineRoleConfigs = new Map<number, Map<string, RoleCfg>>();
  for (const r of roleConfigRes.rows) {
    const lid = Number(r.line_id);
    if (!lineRoleConfigs.has(lid)) lineRoleConfigs.set(lid, new Map());
    lineRoleConfigs.get(lid)!.set(r.role_key, {
      label: r.label,
      rate: Number(r.rate),
      maxWorkers: Number(r.max_workers),
    });
  }

  const lineIdSet = new Set<number>(lineRes.rows.map((ln) => Number(ln.id)));
  const kgByLine = new Map<number, number>();
  let unassignedKg = 0;
  for (const r of kgRes.rows) {
    if (r.production_line_id === null || !lineIdSet.has(Number(r.production_line_id))) {
      unassignedKg += Number(r.kg);
    } else {
      kgByLine.set(Number(r.production_line_id), Number(r.kg));
    }
  }

  const closedByLine = new Map<number, string | null>();
  for (const r of runRes.rows) closedByLine.set(Number(r.line_id), toIso(r.closed_at));

  type Member = { id: number; workerName: string; role: string };
  const membersByLine = new Map<number, Member[]>();
  for (const r of memberRes.rows) {
    const arr = membersByLine.get(Number(r.line_id)) ?? [];
    arr.push({ id: r.id, workerName: r.worker_name, role: r.role });
    membersByLine.set(Number(r.line_id), arr);
  }

  let grandTotal = 0;
  const lines = lineRes.rows.map((ln) => {
    const lineId = Number(ln.id);
    const totalKg = kgByLine.get(lineId) ?? 0;
    grandTotal += totalKg;
    const members = membersByLine.get(lineId) ?? [];
    const lineCfg = lineRoleConfigs.get(lineId);

    // Effective rates: per-line config wins over global fallback
    const effRate = (key: string) =>
      lineCfg?.get(key)?.rate ?? globalRates[key] ?? 0;

    const producerRate = effRate("producer");
    const prepRate = effRate("preparation");
    const packagingRate = effRate("packaging");

    const producers = members.filter((m) => m.role === "producer");
    const preparation = members.filter((m) => m.role === "preparation");
    const packaging = members.filter((m) => m.role === "packaging");
    const prepPool = totalKg * prepRate;
    const packagingPool = totalKg * packagingRate;

    // Build dynamic roles array from per-line config (or default 3 roles)
    type RoleStatus = {
      roleKey: string; label: string; rate: number; maxWorkers: number;
      members: Member[]; pool: number | null; perWorker: number | null;
    };
    let roles: RoleStatus[];
    if (lineCfg && lineCfg.size > 0) {
      roles = Array.from(lineCfg.entries()).map(([roleKey, cfg]) => {
        const rm = members.filter((m) => m.role === roleKey);
        const isProducer = roleKey === "producer";
        const pool2 = isProducer ? null : totalKg * cfg.rate;
        const perWorker = isProducer ? null : (rm.length > 0 ? pool2! / rm.length : 0);
        return { roleKey, label: cfg.label, rate: cfg.rate, maxWorkers: cfg.maxWorkers,
                 members: rm, pool: pool2, perWorker };
      });
    } else {
      roles = [
        { roleKey: "producer", label: "Ishlab chiqaruvchi", rate: producerRate,
          maxWorkers: ROLE_MAX.producer ?? 5, members: producers, pool: null, perWorker: null },
        { roleKey: "preparation", label: "Tayyorlash", rate: prepRate,
          maxWorkers: ROLE_MAX.preparation ?? 3, members: preparation,
          pool: prepPool, perWorker: preparation.length > 0 ? prepPool / preparation.length : 0 },
        { roleKey: "packaging", label: "Qadoqlash", rate: packagingRate,
          maxWorkers: ROLE_MAX.packaging ?? 5, members: packaging,
          pool: packagingPool, perWorker: packaging.length > 0 ? packagingPool / packaging.length : 0 },
      ];
    }

    return {
      lineId,
      lineName: ln.name,
      totalKg,
      closed: closedByLine.has(lineId),
      closedAt: closedByLine.get(lineId) ?? null,
      producers,
      preparation,
      packaging,
      producerRate,
      prepRate,
      packagingRate,
      prepPool,
      prepPerWorker: preparation.length > 0 ? prepPool / preparation.length : 0,
      packagingPool,
      packagingPerWorker: packaging.length > 0 ? packagingPool / packaging.length : 0,
      roles,
    };
  });

  const closed = lines.length > 0 && lines.every((l) => l.closed);

  // Skip Zod parse so extra `roles` field passes through
  res.json({ workDate: today, totalKg: grandTotal, unassignedKg, closed, lines });
});

// ── POST /payroll/close-day — close all lines for today (idempotent) ──────────
type NewEntry = { worker: string; role: string; rate: number; amount: number; lineName: string };

async function notifyWorkers(newEntries: NewEntry[]): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || newEntries.length === 0) return;
  const names = [...new Set(newEntries.map((e) => e.worker))];
  const { rows } = await pool.query(
    `SELECT worker_name, chat_id FROM user_roles WHERE worker_name = ANY($1)`,
    [names]
  );
  const chatByWorker = new Map<string, string>();
  for (const r of rows) chatByWorker.set(r.worker_name, String(r.chat_id));

  for (const e of newEntries) {
    const chatId = chatByWorker.get(e.worker);
    if (!chatId) continue;
    const text =
      `💰 Kunlik ulush hisoblandi\n` +
      `📦 Liniya: ${e.lineName}\n` +
      `👷 Rol: ${ROLE_UZ[e.role] ?? e.role}\n` +
      `💵 Summa: ${Math.round(e.amount).toLocaleString("ru-RU")} so'm`;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    } catch {
      // notifications are best-effort; never fail the close because of Telegram
    }
  }
}

router.post("/payroll/close-day", async (_req, res): Promise<void> => {
  const closedBy = "dashboard";
  const client = await pool.connect();
  const newEntries: NewEntry[] = [];
  type ResultLine = {
    lineId: number;
    lineName: string;
    totalKg: number;
    alreadyClosed: boolean;
    entries: { worker: string; role: string; rate: number; amount: number }[];
  };
  const resultLines: ResultLine[] = [];
  let grandTotal = 0;
  let workDate = "";

  try {
    await client.query("BEGIN");

    const { rows: dRows } = await client.query(
      `SELECT to_char((NOW() AT TIME ZONE 'Asia/Tashkent')::date, 'YYYY-MM-DD') AS d`
    );
    workDate = dRows[0].d;

    const { rows: rateRows } = await client.query(
      `SELECT role, rate FROM payroll_role_rates WHERE scope = $1`,
      [SCOPE]
    );
    const globalRates: Record<string, number> = {};
    for (const r of rateRows) globalRates[r.role] = Number(r.rate);

    const { rows: lineRows } = await client.query(
      `SELECT id, name FROM production_lines ORDER BY id`
    );

    for (const ln of lineRows) {
      const lineId = Number(ln.id);
      const lineName: string = ln.name;

      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `close_day:${SCOPE}:${lineId}:${workDate}`,
      ]);

      const { rows: ex } = await client.query(
        `SELECT total_kg FROM daily_payroll_runs WHERE scope = $1 AND line_id = $2 AND work_date = $3`,
        [SCOPE, lineId, workDate]
      );

      if (ex[0]) {
        const { rows: ents } = await client.query(
          `SELECT worker, role, rate, amount FROM salary_entries
           WHERE scope = $1 AND line_id = $2 AND work_date = $3 AND source_type = 'daily_shared'
           ORDER BY role, worker`,
          [SCOPE, lineId, workDate]
        );
        const totalKg = Number(ex[0].total_kg);
        grandTotal += totalKg;
        resultLines.push({
          lineId,
          lineName,
          totalKg,
          alreadyClosed: true,
          entries: ents.map((r) => ({
            worker: r.worker,
            role: r.role,
            rate: Number(r.rate),
            amount: Number(r.amount),
          })),
        });
        continue;
      }

      const { rows: kgRows } = await client.query(
        `SELECT COALESCE(SUM(b.weight_kg), 0) AS total_kg
         FROM batches b
         LEFT JOIN production_line_workers plw
           ON plw.worker_name = b.worker AND plw.role = 'producer'
           AND b.production_line_id IS NULL
         WHERE COALESCE(b.production_line_id, plw.line_id) = $1
           AND (b.created_at AT TIME ZONE 'Asia/Tashkent')::date = $2`,
        [lineId, workDate]
      );
      const totalKg = Number(kgRows[0].total_kg);
      grandTotal += totalKg;

      // Per-line non-producer roles: use line_role_config if configured, else global defaults
      const { rows: lineRoleCfgRows } = await client.query(
        `SELECT role_key, rate FROM line_role_config WHERE line_id = $1 AND role_key != 'producer'`,
        [lineId]
      );
      const nonProducerRoles: { role: string; rate: number }[] =
        lineRoleCfgRows.length > 0
          ? lineRoleCfgRows.map((r) => ({ role: r.role_key, rate: Number(r.rate) }))
          : [
              { role: "preparation", rate: globalRates.preparation ?? 0 },
              { role: "packaging", rate: globalRates.packaging ?? 0 },
            ];

      const roleKeys = nonProducerRoles.map((r) => r.role);
      const { rows: members } = await client.query(
        `SELECT worker_name, role FROM production_line_workers
         WHERE line_id = $1 AND role = ANY($2)
         ORDER BY role, worker_name`,
        [lineId, roleKeys]
      );
      const counts: Record<string, number> = {};
      for (const m of members) counts[m.role] = (counts[m.role] ?? 0) + 1;

      const rateByRole: Record<string, number> = {};
      for (const nr of nonProducerRoles) rateByRole[nr.role] = nr.rate;

      const entries: ResultLine["entries"] = [];
      for (const m of members) {
        const role: string = m.role;
        const rate = rateByRole[role] ?? globalRates[role] ?? 0;
        const n = counts[role] ?? 0;
        const amount = n > 0 ? (totalKg * rate) / n : 0;
        await client.query(
          `INSERT INTO salary_entries
             (scope, line_id, worker, role, source_type, work_date, kg, rate, amount)
           VALUES ($1, $2, $3, $4, 'daily_shared', $5, $6, $7, $8)
           ON CONFLICT (scope, worker, role, work_date) WHERE source_type = 'daily_shared'
           DO NOTHING`,
          [SCOPE, lineId, m.worker_name, role, workDate, totalKg, rate, amount]
        );
        entries.push({ worker: m.worker_name, role, rate, amount });
        newEntries.push({ worker: m.worker_name, role, rate, amount, lineName });
      }

      await client.query(
        `INSERT INTO daily_payroll_runs (scope, line_id, work_date, total_kg, status, closed_by)
         VALUES ($1, $2, $3, $4, 'closed', $5)
         ON CONFLICT (scope, work_date, line_id) DO NOTHING`,
        [SCOPE, lineId, workDate, totalKg, closedBy]
      );

      resultLines.push({ lineId, lineName, totalKg, alreadyClosed: false, entries });
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  // Best-effort Telegram notification — only for newly created entries.
  await notifyWorkers(newEntries);

  const alreadyClosed =
    resultLines.length > 0 && resultLines.every((l) => l.alreadyClosed);

  res.json(
    ClosePayrollDayResponse.parse({
      workDate,
      totalKg: grandTotal,
      alreadyClosed,
      newEntryCount: newEntries.length,
      lines: resultLines,
    })
  );
});

// ── GET /payroll/line-configs — all lines with their per-line role configs ──────
router.get("/payroll/line-configs", async (_req, res): Promise<void> => {
  const [lineRes, cfgRes] = await Promise.all([
    pool.query(`SELECT id, name FROM production_lines ORDER BY id`),
    pool.query(
      `SELECT line_id, role_key, label, rate, max_workers
       FROM line_role_config ORDER BY line_id, role_key`
    ),
  ]);
  const cfgByLine = new Map<number, { roleKey: string; label: string; rate: number; maxWorkers: number }[]>();
  for (const r of cfgRes.rows) {
    const lid = Number(r.line_id);
    const arr = cfgByLine.get(lid) ?? [];
    arr.push({ roleKey: r.role_key, label: r.label, rate: Number(r.rate), maxWorkers: Number(r.max_workers) });
    cfgByLine.set(lid, arr);
  }
  const result = lineRes.rows.map((ln) => ({
    lineId: Number(ln.id),
    lineName: ln.name,
    roles: cfgByLine.get(Number(ln.id)) ?? [],
  }));
  res.json(result);
});

// ── POST /payroll/lines/:id/roles — add a role config to a line ───────────────
router.post("/payroll/lines/:id/roles", async (req, res): Promise<void> => {
  const lineId = Number(req.params.id);
  if (!lineId || isNaN(lineId)) { res.status(400).json({ error: "Noto'g'ri liniya ID" }); return; }
  const { roleKey, label, rate, maxWorkers } = req.body as {
    roleKey?: string; label?: string; rate?: number; maxWorkers?: number;
  };
  if (!roleKey || typeof roleKey !== "string" || !roleKey.trim()) {
    res.status(400).json({ error: "roleKey majburiy" }); return;
  }
  if (typeof rate !== "number" || rate < 0) {
    res.status(400).json({ error: "rate musbat bo'lishi kerak" }); return;
  }
  const mw = typeof maxWorkers === "number" && maxWorkers > 0 ? maxWorkers : 5;
  const lbl = (label ?? roleKey).trim();

  const { rows: lineRows } = await pool.query("SELECT 1 FROM production_lines WHERE id = $1", [lineId]);
  if (lineRows.length === 0) { res.status(404).json({ error: "Liniya topilmadi" }); return; }

  try {
    const { rows } = await pool.query(
      `INSERT INTO line_role_config (line_id, role_key, label, rate, max_workers)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (line_id, role_key) DO UPDATE
         SET label = EXCLUDED.label, rate = EXCLUDED.rate, max_workers = EXCLUDED.max_workers
       RETURNING role_key, label, rate, max_workers`,
      [lineId, roleKey.trim(), lbl, rate, mw]
    );
    const r = rows[0];
    res.status(201).json({ roleKey: r.role_key, label: r.label, rate: Number(r.rate), maxWorkers: Number(r.max_workers) });
  } catch (e) {
    throw e;
  }
});

// ── PATCH /payroll/lines/:id/roles/:roleKey — update rate/label/maxWorkers ─────
router.patch("/payroll/lines/:id/roles/:roleKey", async (req, res): Promise<void> => {
  const lineId = Number(req.params.id);
  const roleKey = req.params.roleKey;
  if (!lineId || isNaN(lineId)) { res.status(400).json({ error: "Noto'g'ri liniya ID" }); return; }

  const { label, rate, maxWorkers } = req.body as {
    label?: string; rate?: number; maxWorkers?: number;
  };

  const setClauses: string[] = [];
  const vals: (string | number)[] = [lineId, roleKey];
  if (typeof rate === "number" && rate >= 0) { vals.push(rate); setClauses.push(`rate = $${vals.length}`); }
  if (typeof maxWorkers === "number" && maxWorkers > 0) { vals.push(maxWorkers); setClauses.push(`max_workers = $${vals.length}`); }
  if (typeof label === "string" && label.trim()) { vals.push(label.trim()); setClauses.push(`label = $${vals.length}`); }

  if (setClauses.length === 0) { res.status(400).json({ error: "Hech narsa o'zgartirilmadi" }); return; }

  const { rows } = await pool.query(
    `UPDATE line_role_config SET ${setClauses.join(", ")}
     WHERE line_id = $1 AND role_key = $2
     RETURNING role_key, label, rate, max_workers`,
    vals
  );
  if (rows.length === 0) { res.status(404).json({ error: "Rol konfiguratsiyasi topilmadi" }); return; }
  const r = rows[0];
  res.json({ roleKey: r.role_key, label: r.label, rate: Number(r.rate), maxWorkers: Number(r.max_workers) });
});

// ── DELETE /payroll/lines/:id/roles/:roleKey — remove role config ─────────────
router.delete("/payroll/lines/:id/roles/:roleKey", async (req, res): Promise<void> => {
  const lineId = Number(req.params.id);
  const roleKey = req.params.roleKey;
  if (!lineId || isNaN(lineId)) { res.status(400).json({ error: "Noto'g'ri liniya ID" }); return; }

  // Block removal if workers are still assigned to this role on this line
  const { rows: wRows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM production_line_workers WHERE line_id = $1 AND role = $2`,
    [lineId, roleKey]
  );
  if ((wRows[0].c ?? 0) > 0) {
    res.status(409).json({ error: "Bu rolda ishchilar bor — avval ularni olib tashlang" }); return;
  }

  const result = await pool.query(
    `DELETE FROM line_role_config WHERE line_id = $1 AND role_key = $2`,
    [lineId, roleKey]
  );
  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Rol konfiguratsiyasi topilmadi" }); return;
  }
  res.json({ status: "ok" });
});

// ── PATCH /payroll/lines/:id — rename a production line ───────────────────────
router.patch("/payroll/lines/:id", async (req, res): Promise<void> => {
  const lineId = Number(req.params.id);
  if (!lineId || isNaN(lineId)) { res.status(400).json({ error: "Noto'g'ri liniya ID" }); return; }
  const { name } = req.body as { name?: string };
  if (!name || !name.trim()) { res.status(400).json({ error: "Nom bo'sh bo'lishi mumkin emas" }); return; }
  try {
    const { rows } = await pool.query(
      `UPDATE production_lines SET name = $1 WHERE id = $2 RETURNING id, name`,
      [name.trim(), lineId]
    );
    if (rows.length === 0) { res.status(404).json({ error: "Liniya topilmadi" }); return; }
    res.json({ id: Number(rows[0].id), name: rows[0].name });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      res.status(409).json({ error: "Bu nomli liniya allaqachon mavjud" }); return;
    }
    throw e;
  }
});

export default router;
