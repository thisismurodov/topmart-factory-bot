import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import type { Pool } from "pg";
import { pool as sharedPool } from "@workspace/db";
import {
  GetVehicleDistributionPilotWeeklySummaryQueryParams,
  GetVehicleDistributionPilotWeeklySummaryResponse,
} from "@workspace/api-zod";
import { vehicleDistributionGate } from "./index";
import {
  readPilotWeeklySummary,
  WeeklySummaryPilotNotFoundError,
  WeeklySummaryValidationError,
} from "./weekly-summary-service";

/** F10 accepts only an explicit, currently valid admin session. Bot credentials
 * and authenticated non-admin users are deliberately forbidden. */
export function makeWeeklySummaryAdminAuth(pool: Pool) {
  return async function weeklySummaryAdminAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (typeof req.headers["x-vehicle-distribution-bot-key"] === "string") {
      res.status(403).json({ error: "Admin session required" });
      return;
    }
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    try {
      const { rows } = await pool.query(
        `SELECT u.id,u.role
           FROM admin_sessions s
           JOIN admin_users u ON u.id=s.user_id
          WHERE s.token=$1`,
        [token],
      );
      if (!rows.length) {
        res.status(401).json({ error: "Invalid or expired session" });
        return;
      }
      if (rows[0].role !== "admin") {
        res.status(403).json({ error: "Admin role required" });
        return;
      }
      next();
    } catch {
      res.status(500).json({ error: "Auth check failed" });
    }
  };
}

export function createVehicleWeeklySummaryRouter(pool: Pool): IRouter {
  const router: IRouter = Router();
  const path = "/vehicle-distribution/pilot/weekly-summary";
  router.use(path, makeWeeklySummaryAdminAuth(pool));
  router.use(path, vehicleDistributionGate);
  router.get(path, async (req, res): Promise<void> => {
    const parsed = GetVehicleDistributionPilotWeeklySummaryQueryParams.safeParse(
      req.query ?? {},
    );
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const client = await pool.connect();
    try {
      const out = await readPilotWeeklySummary(client, parsed.data.weekStart);
      res.json(GetVehicleDistributionPilotWeeklySummaryResponse.parse(out));
    } catch (e) {
      if (e instanceof WeeklySummaryValidationError) {
        res.status(400).json({ error: e.message });
      } else if (e instanceof WeeklySummaryPilotNotFoundError) {
        res.status(404).json({ error: e.message });
      } else {
        req.log.error({ err: e }, "Weekly pilot summary failed");
        res.status(500).json({ error: "Weekly pilot summary failed" });
      }
    } finally {
      client.release();
    }
  });
  return router;
}

export default createVehicleWeeklySummaryRouter(sharedPool);