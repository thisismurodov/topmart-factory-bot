import { timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { pool as sharedPool } from "@workspace/db";
import { logger } from "../../lib/logger";
import { vehicleDistributionGate } from "./index";

const heartbeatSchema = z.object({
  agentId: z.string().trim().min(1).max(100),
  printerName: z.string().trim().min(1).max(300),
  printerAvailable: z.boolean(),
  mediaValid: z.boolean(),
  printableAreaValid: z.boolean(),
  physicalWidthMm: z.number().positive().nullable(),
  physicalHeightMm: z.number().positive().nullable(),
  printableWidthMm: z.number().positive().nullable(),
  printableHeightMm: z.number().positive().nullable(),
  detail: z.string().max(1000),
}).strict();

type Heartbeat = z.infer<typeof heartbeatSchema>;
type HealthStatus = "healthy" | "unhealthy";
const DEFAULT_STALE_SECONDS = 180;

function safeKeyEqual(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function botAuth(req: Request, res: Response, next: NextFunction): void {
  const provided = req.headers["x-vehicle-distribution-bot-key"];
  const expected = process.env.VEHICLE_DISTRIBUTION_BOT_KEY ?? "";
  if (typeof provided !== "string" || !safeKeyEqual(provided, expected)) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}

function warehouseChatIds(): string[] {
  return [...new Set(
    (process.env.VEHICLE_REPLENISHMENT_TELEGRAM_CHAT_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  )];
}

async function sendWarehouseNotice(
  status: HealthStatus,
  row: Record<string, unknown>,
  alreadySent: string[],
): Promise<{ sent: string[]; complete: boolean }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = warehouseChatIds();
  if (!token || chatIds.length === 0) return { sent: alreadySent, complete: false };
  const dimensions = row.physical_width_mm && row.physical_height_mm
    ? `${row.physical_width_mm}×${row.physical_height_mm} mm`
    : "aniqlanmadi";
  const printable = row.printable_width_mm && row.printable_height_mm
    ? `${row.printable_width_mm}×${row.printable_height_mm} mm`
    : "aniqlanmadi";
  const text = status === "unhealthy"
    ? `⚠️ Etiketka printeri tayyor emas\nAgent: ${row.agent_id}\nPrinter: ${row.printer_name}\nMedia: ${dimensions}; printable: ${printable}\nSabab: ${row.detail}\nWindows agenti, aynan shu printer va 100×80 media profilini tekshiring.`
    : `✅ Etiketka printeri qayta tayyor\nAgent: ${row.agent_id}\nPrinter: ${row.printer_name}\n100×80 media va printable area tekshirildi.`;
  const sent = new Set(alreadySent);
  for (const chatId of chatIds.filter((id) => !sent.has(id))) {
    try {
      const response = await fetch(
        `${process.env.TELEGRAM_API_BASE || "https://api.telegram.org"}/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        },
      );
      if (response.ok) sent.add(chatId);
    } catch {}
  }
  return { sent: [...sent], complete: chatIds.every((id) => sent.has(id)) };
}

async function notifyTransition(
  client: PoolClient,
  row: Record<string, unknown>,
  status: HealthStatus,
): Promise<void> {
  if (row.last_notified_status === status) return;
  const alreadySent = Array.isArray(row.notified_chat_ids)
    ? row.notified_chat_ids.map(String)
    : [];
  const delivery = await sendWarehouseNotice(status, row, alreadySent);
  await client.query(
    `UPDATE print_agent_health
        SET notified_chat_ids=$2,
            last_notified_status=CASE WHEN $3 THEN $4 ELSE last_notified_status END,
            updated_at=NOW()
      WHERE agent_id=$1`,
    [row.agent_id, delivery.sent, delivery.complete, status],
  );
}

export async function recordPrintAgentHeartbeat(pool: Pool, heartbeat: Heartbeat): Promise<HealthStatus> {
  const healthy =
    heartbeat.printerAvailable &&
    heartbeat.mediaValid &&
    heartbeat.printableAreaValid;
  const status: HealthStatus = healthy ? "healthy" : "unhealthy";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`print-agent:${heartbeat.agentId}`]);
    const previous = await client.query(
      "SELECT healthy FROM print_agent_health WHERE agent_id=$1 FOR UPDATE",
      [heartbeat.agentId],
    );
    const changed = previous.rows.length === 0 || Boolean(previous.rows[0].healthy) !== healthy;
    const result = await client.query(
      `INSERT INTO print_agent_health
         (agent_id,printer_name,printer_available,media_valid,printable_area_valid,
          physical_width_mm,physical_height_mm,printable_width_mm,printable_height_mm,
          healthy,detail,last_seen_at,last_transition_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
       ON CONFLICT (agent_id) DO UPDATE SET
         printer_name=EXCLUDED.printer_name,
         printer_available=EXCLUDED.printer_available,
         media_valid=EXCLUDED.media_valid,
         printable_area_valid=EXCLUDED.printable_area_valid,
         physical_width_mm=EXCLUDED.physical_width_mm,
         physical_height_mm=EXCLUDED.physical_height_mm,
         printable_width_mm=EXCLUDED.printable_width_mm,
         printable_height_mm=EXCLUDED.printable_height_mm,
         healthy=EXCLUDED.healthy,
         detail=EXCLUDED.detail,
         last_seen_at=NOW(),
         last_transition_at=CASE WHEN print_agent_health.healthy IS DISTINCT FROM EXCLUDED.healthy
                                 THEN NOW() ELSE print_agent_health.last_transition_at END,
         notified_chat_ids=CASE WHEN print_agent_health.healthy IS DISTINCT FROM EXCLUDED.healthy
                                THEN '{}'::text[] ELSE print_agent_health.notified_chat_ids END,
         updated_at=NOW()
       RETURNING *`,
      [
        heartbeat.agentId, heartbeat.printerName, heartbeat.printerAvailable,
        heartbeat.mediaValid, heartbeat.printableAreaValid,
        heartbeat.physicalWidthMm, heartbeat.physicalHeightMm,
        heartbeat.printableWidthMm, heartbeat.printableHeightMm,
        healthy, heartbeat.detail,
      ],
    );
    const shouldNotify =
      (!healthy && previous.rows.length === 0) ||
      previous.rows.length > 0 && (
        changed || result.rows[0].last_notified_status !== status
      );
    if (shouldNotify) await notifyTransition(client, result.rows[0], status);
    await client.query("COMMIT");
    return status;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function sweepStalePrintAgents(
  pool: Pool = sharedPool,
  staleSeconds = Number(process.env.PRINT_AGENT_STALE_SECONDS || DEFAULT_STALE_SECONDS),
): Promise<number> {
  const client = await pool.connect();
  let transitioned = 0;
  try {
    const candidates = await client.query(
      `SELECT agent_id FROM print_agent_health
        WHERE healthy=TRUE AND last_seen_at < NOW() - ($1 * INTERVAL '1 second')`,
      [staleSeconds],
    );
    for (const candidate of candidates.rows) {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`print-agent:${candidate.agent_id}`]);
      const result = await client.query(
        `UPDATE print_agent_health
            SET healthy=FALSE, detail='Agent heartbeat kelmayapti',
                last_transition_at=NOW(), notified_chat_ids='{}'::text[],
                updated_at=NOW()
          WHERE agent_id=$1 AND healthy=TRUE
            AND last_seen_at < NOW() - ($2 * INTERVAL '1 second')
          RETURNING *`,
        [candidate.agent_id, staleSeconds],
      );
      if (result.rows.length) {
        transitioned += 1;
        await notifyTransition(client, result.rows[0], "unhealthy");
      }
      await client.query("COMMIT");
    }
    return transitioned;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function startPrintAgentHealthMonitor(pool: Pool = sharedPool): NodeJS.Timeout {
  const intervalSeconds = Number(process.env.PRINT_AGENT_SWEEP_SECONDS || 60);
  const staleSeconds = Number(process.env.PRINT_AGENT_STALE_SECONDS || DEFAULT_STALE_SECONDS);
  if (
    !Number.isFinite(intervalSeconds) || intervalSeconds < 10 ||
    !Number.isFinite(staleSeconds) || staleSeconds < intervalSeconds * 2
  ) {
    throw new Error(
      "PRINT_AGENT_STALE_SECONDS must be finite and at least twice PRINT_AGENT_SWEEP_SECONDS",
    );
  }
  const sweep = () => {
    void sweepStalePrintAgents(pool, staleSeconds).catch((err) => {
      logger.error({ err }, "print-agent stale sweep failed");
    });
  };
  sweep();
  const timer = setInterval(() => {
    sweep();
  }, intervalSeconds * 1000);
  timer.unref();
  return timer;
}

export function createPrintAgentHealthRouter(pool: Pool): IRouter {
  const router: IRouter = Router();
  router.use("/vehicle-distribution/print-agent", botAuth, vehicleDistributionGate);
  router.post("/vehicle-distribution/print-agent/heartbeat", async (req, res): Promise<void> => {
    const parsed = heartbeatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const status = await recordPrintAgentHeartbeat(pool, parsed.data);
      res.json({ accepted: true, status });
    } catch (error) {
      req.log.error({ err: error }, "print-agent heartbeat failed");
      res.status(500).json({ error: "Heartbeat failed" });
    }
  });
  return router;
}

export default createPrintAgentHealthRouter(sharedPool);