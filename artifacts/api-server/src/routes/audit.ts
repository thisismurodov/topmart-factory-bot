import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

// ── GET /audit-logs?table=&action=&limit=&offset= ─────────────────────────────
router.get("/audit-logs", async (req, res): Promise<void> => {
  const limit  = Math.min(Math.max(parseInt((req.query.limit  as string) ?? "50"),  1), 200);
  const offset = Math.max(parseInt((req.query.offset as string) ?? "0"), 0);
  const table  = (req.query.table  as string | undefined)?.trim() || null;
  const action = (req.query.action as string | undefined)?.trim() || null;

  const conditions: string[] = [];
  const vals: unknown[] = [];

  if (table)  { vals.push(table);  conditions.push(`table_name = $${vals.length}`); }
  if (action) { vals.push(action); conditions.push(`action = $${vals.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [rows, cnt] = await Promise.all([
    pool.query(
      `SELECT id, table_name, action, record_id, changed_by, old_data, new_data, created_at
       FROM audit_logs ${where}
       ORDER BY created_at DESC
       LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`,
      [...vals, limit, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS cnt FROM audit_logs ${where}`, vals),
  ]);

  res.json({
    total: cnt.rows[0].cnt,
    items: rows.rows.map(r => ({
      id:         r.id,
      tableName:  r.table_name,
      action:     r.action,
      recordId:   r.record_id,
      changedBy:  r.changed_by,
      oldData:    r.old_data,
      newData:    r.new_data,
      createdAt:  r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    })),
  });
});

// ── POST /audit-logs — ichki yozuv (middleware tomonidan ishlatiladi) ───────────
export async function writeAuditLog(opts: {
  tableName: string;
  action: string;
  recordId?: string | number | null;
  changedBy?: string;
  oldData?: unknown;
  newData?: unknown;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_logs (table_name, action, record_id, changed_by, old_data, new_data)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        opts.tableName,
        opts.action,
        opts.recordId != null ? String(opts.recordId) : null,
        opts.changedBy ?? "api",
        opts.oldData != null ? JSON.stringify(opts.oldData) : null,
        opts.newData != null ? JSON.stringify(opts.newData) : null,
      ]
    );
  } catch {
    // audit log yozish muvaffaqiyatsiz bo'lsa asosiy so'rovni bloklamaydi
  }
}

export default router;
