// ─────────────────────────────────────────────────────────────────────────────
// F2 Vehicle + Assignment pilot — Express router
//
// Mounted AFTER the global requireAuth wall (see routes/index.ts), so every
// request here is already authenticated.
//
// Feature gate (evaluated at REQUEST time, fail-closed):
//   - Neither/off  → 404 (feature disabled, do not leak existence)
//   - ENABLED=1 but SCHEMA_APPROVED != 1 → 503 (enabled without schema)
//   - Both = 1     → proceed
//
// POST bootstrap additionally requires the caller's admin_users.role = 'admin'
// (looked up server-side by req.userId — never trusted from the body).
//
// The router is a factory over a pg Pool so tests can mount it against a
// throwaway database; the default export binds the shared @workspace/db pool.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { Pool } from "pg";
import { pool as sharedPool } from "@workspace/db";
import {
  GetVehicleDistributionPilotResponse,
  BootstrapVehicleDistributionPilotResponse,
  BootstrapVehicleDistributionPilotBody,
} from "@workspace/api-zod";
import {
  readPilotState,
  bootstrapPilotInTx,
  PilotConflictError,
  PilotAgentError,
  PILOT_LOCK_KEY,
} from "./service";

/** Fail-closed feature gate, evaluated per request from the environment. */
export function vehicleDistributionGate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const enabled = process.env.VEHICLE_DISTRIBUTION_ENABLED === "1";
  const schemaApproved =
    process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED === "1";

  if (!enabled) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!schemaApproved) {
    req.log.warn(
      "vehicle-distribution enabled without schema approval — returning 503",
    );
    res.status(503).json({ error: "Vehicle distribution schema not approved" });
    return;
  }
  next();
}

export function createVehicleDistributionRouter(pool: Pool): IRouter {
  const router: IRouter = Router();

  router.use("/vehicle-distribution", vehicleDistributionGate);

  // ── GET /vehicle-distribution/pilot ───────────────────────────────────────
  // Authenticated read: pilot vehicle, public warehouse balance summary, active
  // assignment. Deterministic not-bootstrapped payload without writes if missing.
  router.get(
    "/vehicle-distribution/pilot",
    async (_req, res): Promise<void> => {
      const client = await pool.connect();
      try {
        const state = await readPilotState(client);
        res.json(GetVehicleDistributionPilotResponse.parse(state));
      } finally {
        client.release();
      }
    },
  );

  // ── POST /vehicle-distribution/pilot/bootstrap ────────────────────────────
  // Admin-only, idempotent, transactional bootstrap.
  router.post(
    "/vehicle-distribution/pilot/bootstrap",
    async (req, res): Promise<void> => {
      // (3) Parse + validate the request body first. The schema intentionally
      // carries no fields (all pilot constants are server-side), so any
      // unexpected property in the body is rejected with 400.
      const bodyParsed = BootstrapVehicleDistributionPilotBody.strict().safeParse(
        req.body ?? {},
      );
      if (!bodyParsed.success) {
        req.log.warn(
          { err: bodyParsed.error.message },
          "invalid vehicle-distribution bootstrap body",
        );
        res.status(400).json({ error: bodyParsed.error.message });
        return;
      }

      // Server-side admin role check — never trust the request body.
      const roleRes = await pool.query(
        "SELECT role FROM admin_users WHERE id = $1",
        [req.userId],
      );
      if (!roleRes.rows.length || roleRes.rows[0].role !== "admin") {
        req.log.warn(
          { userId: req.userId },
          "non-admin attempted vehicle-distribution bootstrap",
        );
        res.status(403).json({ error: "Admin role required" });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          PILOT_LOCK_KEY,
        ]);
        const state = await bootstrapPilotInTx(client);
        // (2) Validate and map the response with the generated Zod schema
        // BEFORE committing: if the response shape is wrong (schema drift),
        // the parse throws, ROLLBACK runs in the catch block, and we never
        // send a half-committed / mis-shaped payload to the client.
        const payload = BootstrapVehicleDistributionPilotResponse.parse(state);
        await client.query("COMMIT");
        res.json(payload);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        if (e instanceof PilotAgentError) {
          req.log.warn({ matches: e.matches }, "pilot agent lookup failed");
          res.status(409).json({ error: e.message });
          return;
        }
        if (e instanceof PilotConflictError) {
          req.log.warn({ err: e.message }, "pilot bootstrap conflict");
          res.status(409).json({ error: e.message });
          return;
        }
        req.log.error({ err: e }, "vehicle-distribution bootstrap failed");
        res.status(500).json({ error: "Bootstrap failed" });
      } finally {
        client.release();
      }
    },
  );

  return router;
}

const router: IRouter = createVehicleDistributionRouter(sharedPool);

export default router;
