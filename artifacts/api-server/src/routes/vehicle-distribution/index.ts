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
  GetVehicleDistributionPilotStockResponse,
  GetVehicleDistributionPilotMovementsResponse,
  GetVehicleDistributionPilotMovementsQueryParams,
  ListVehicleReconciliationsResponse,
  ListVehicleReconciliationsQueryParams,
  CreateVehicleReconciliationBody,
  CreateVehicleReconciliationResponse,
  GetVehicleReconciliationResponse,
  PatchVehicleReconciliationItemsBody,
  PatchVehicleReconciliationItemsResponse,
  ReviewVehicleReconciliationBody,
  ReviewVehicleReconciliationResponse,
  ApplyVehicleReconciliationBody,
  ApplyVehicleReconciliationResponse,
  CancelVehicleReconciliationBody,
  CancelVehicleReconciliationResponse,
} from "@workspace/api-zod";
import {
  readPilotState,
  readPilotStock,
  readPilotMovements,
  bootstrapPilotInTx,
  PilotConflictError,
  PilotAgentError,
  PILOT_LOCK_KEY,
} from "./service";
import {
  listReconciliations,
  getReconciliation,
  createReconciliationInTx,
  patchReconciliationItemsInTx,
  reviewReconciliationInTx,
  applyReconciliationInTx,
  cancelReconciliationInTx,
  ReconciliationNotFoundError,
  ReconciliationConflictError,
  ReconciliationValidationError,
  type ReconciliationActor,
} from "./reconciliation-service";

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

  // ── GET /vehicle-distribution/pilot/stock ─────────────────────────────────
  // Authenticated read-only stock cards for the pilot vehicle warehouse. Pilot
  // + expected vehicle warehouse are resolved server-side (no request input);
  // never falls back to a generic warehouse. Not-bootstrapped → empty payload.
  router.get(
    "/vehicle-distribution/pilot/stock",
    async (_req, res): Promise<void> => {
      const client = await pool.connect();
      try {
        const state = await readPilotStock(client);
        res.json(GetVehicleDistributionPilotStockResponse.parse(state));
      } finally {
        client.release();
      }
    },
  );

  // ── GET /vehicle-distribution/pilot/movements ─────────────────────────────
  // Authenticated read-only, keyset-paginated audit history of movements that
  // touch the pilot vehicle warehouse (from OR to). Server-resolved pilot; never
  // exposes global or other-warehouse-only rows. Not-bootstrapped → empty.
  router.get(
    "/vehicle-distribution/pilot/movements",
    async (req, res): Promise<void> => {
      const parsed = GetVehicleDistributionPilotMovementsQueryParams.safeParse(
        req.query ?? {},
      );
      if (!parsed.success) {
        req.log.warn(
          { err: parsed.error.message },
          "invalid pilot movements query params",
        );
        res.status(400).json({ error: parsed.error.message });
        return;
      }
      const client = await pool.connect();
      try {
        const state = await readPilotMovements(client, {
          limit: parsed.data.limit,
          beforeId: parsed.data.beforeId,
        });
        res.json(GetVehicleDistributionPilotMovementsResponse.parse(state));
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

  // ── F6 Vehicle Reconciliation ──────────────────────────────────────────────

  /** Resolve the server-side admin actor by req.userId. Returns null (and the
   *  caller sends 403) when the authenticated user is not an admin. Never trusts
   *  the request body for authority. */
  async function resolveAdminActor(
    req: Request,
  ): Promise<ReconciliationActor | null> {
    const r = await pool.query(
      "SELECT id, username, role FROM admin_users WHERE id = $1",
      [req.userId],
    );
    if (!r.rows.length || r.rows[0].role !== "admin") return null;
    return {
      type: "admin",
      ref: String(r.rows[0].username),
      actorId: Number(r.rows[0].id),
    };
  }

  function parseReconciliationId(req: Request): number | null {
    const n = Number(req.params.reconciliationId);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
  }

  function sendReconciliationError(
    req: Request,
    res: Response,
    e: unknown,
    label: string,
  ): void {
    if (e instanceof ReconciliationNotFoundError) {
      res.status(404).json({ error: e.message });
      return;
    }
    if (e instanceof ReconciliationValidationError) {
      res.status(400).json({ error: e.message });
      return;
    }
    if (e instanceof ReconciliationConflictError) {
      res.status(409).json({ error: e.message });
      return;
    }
    req.log.error({ err: e }, `${label} failed`);
    res.status(500).json({ error: `${label} failed` });
  }

  // GET list (any authenticated caller)
  router.get(
    "/vehicle-distribution/pilot/reconciliations",
    async (req, res): Promise<void> => {
      const parsed = ListVehicleReconciliationsQueryParams.safeParse(
        req.query ?? {},
      );
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }
      const client = await pool.connect();
      try {
        const out = await listReconciliations(client, parsed.data.limit ?? 50);
        res.json(ListVehicleReconciliationsResponse.parse(out));
      } catch (e) {
        sendReconciliationError(req, res, e, "List reconciliations");
      } finally {
        client.release();
      }
    },
  );

  // POST create (admin-only)
  router.post(
    "/vehicle-distribution/pilot/reconciliations",
    async (req, res): Promise<void> => {
      const parsed = CreateVehicleReconciliationBody.strict().safeParse(
        req.body ?? {},
      );
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }
      const actor = await resolveAdminActor(req);
      if (!actor) {
        res.status(403).json({ error: "Admin role required" });
        return;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await createReconciliationInTx(
          client,
          parsed.data.reconciliationDate,
          parsed.data.notes ?? null,
          actor,
        );
        const payload = CreateVehicleReconciliationResponse.parse(out);
        await client.query("COMMIT");
        res.json(payload);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        sendReconciliationError(req, res, e, "Create reconciliation");
      } finally {
        client.release();
      }
    },
  );

  // GET detail (any authenticated caller)
  router.get(
    "/vehicle-distribution/pilot/reconciliations/:reconciliationId",
    async (req, res): Promise<void> => {
      const id = parseReconciliationId(req);
      if (id == null) {
        res.status(404).json({ error: "Reconciliation not found" });
        return;
      }
      const client = await pool.connect();
      try {
        const detail = await getReconciliation(client, id);
        res.json(GetVehicleReconciliationResponse.parse(detail));
      } catch (e) {
        sendReconciliationError(req, res, e, "Get reconciliation");
      } finally {
        client.release();
      }
    },
  );

  // PATCH items (admin-only, draft only)
  router.patch(
    "/vehicle-distribution/pilot/reconciliations/:reconciliationId/items",
    async (req, res): Promise<void> => {
      const id = parseReconciliationId(req);
      if (id == null) {
        res.status(404).json({ error: "Reconciliation not found" });
        return;
      }
      const parsed = PatchVehicleReconciliationItemsBody.strict().safeParse(
        req.body ?? {},
      );
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }
      const actor = await resolveAdminActor(req);
      if (!actor) {
        res.status(403).json({ error: "Admin role required" });
        return;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const detail = await patchReconciliationItemsInTx(
          client,
          id,
          parsed.data.items.map((i) => ({
            itemId: i.itemId,
            actualQuantity: i.actualQuantity,
            notes: i.notes ?? null,
          })),
          actor,
        );
        const payload = PatchVehicleReconciliationItemsResponse.parse(detail);
        await client.query("COMMIT");
        res.json(payload);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        sendReconciliationError(req, res, e, "Patch reconciliation items");
      } finally {
        client.release();
      }
    },
  );

  // Shared admin-only transition factory (review / apply / cancel).
  function reconciliationTransition(
    label: string,
    fn: (
      client: import("pg").PoolClient,
      id: number,
      actor: ReconciliationActor,
    ) => Promise<unknown>,
    bodySchema: { strict: () => { safeParse: (v: unknown) => { success: boolean; error?: { message: string } } } },
    responseSchema: { parse: (v: unknown) => unknown },
  ) {
    return async (req: Request, res: Response): Promise<void> => {
      const id = parseReconciliationId(req);
      if (id == null) {
        res.status(404).json({ error: "Reconciliation not found" });
        return;
      }
      const parsed = bodySchema.strict().safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error!.message });
        return;
      }
      const actor = await resolveAdminActor(req);
      if (!actor) {
        res.status(403).json({ error: "Admin role required" });
        return;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const detail = await fn(client, id, actor);
        const payload = responseSchema.parse(detail);
        await client.query("COMMIT");
        res.json(payload);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        sendReconciliationError(req, res, e, label);
      } finally {
        client.release();
      }
    };
  }

  router.post(
    "/vehicle-distribution/pilot/reconciliations/:reconciliationId/review",
    reconciliationTransition(
      "Review reconciliation",
      reviewReconciliationInTx,
      ReviewVehicleReconciliationBody,
      ReviewVehicleReconciliationResponse,
    ),
  );

  router.post(
    "/vehicle-distribution/pilot/reconciliations/:reconciliationId/apply",
    reconciliationTransition(
      "Apply reconciliation",
      applyReconciliationInTx,
      ApplyVehicleReconciliationBody,
      ApplyVehicleReconciliationResponse,
    ),
  );

  router.post(
    "/vehicle-distribution/pilot/reconciliations/:reconciliationId/cancel",
    reconciliationTransition(
      "Cancel reconciliation",
      cancelReconciliationInTx,
      CancelVehicleReconciliationBody,
      CancelVehicleReconciliationResponse,
    ),
  );

  return router;
}

const router: IRouter = createVehicleDistributionRouter(sharedPool);

export default router;
