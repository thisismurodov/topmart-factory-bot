// ─────────────────────────────────────────────────────────────────────────────
// F3 Vehicle Handoff — dedicated Express router + its OWN auth wall
//
// Mounted BEFORE the global requireAuth wall (see routes/index.ts) behind its
// own middleware. Two accepted credentials, both resolved to a SERVER-side
// actor (the request body never carries authoritative actor/agent/vehicle):
//
//   (a) Bearer session — revalidated against admin_sessions/admin_users, and
//       only accepted when the user's role='admin'. Actor = { admin, username }.
//   (b) x-vehicle-distribution-bot-key — compared with VEHICLE_DISTRIBUTION_BOT_KEY
//       via timingSafeEqual, ONLY when that env var is configured & nontrivial.
//       Actor = { warehouse_bot, 'vehicle-distribution-bot' }.
//
// The request-time feature gate (VEHICLE_DISTRIBUTION_ENABLED + SCHEMA_APPROVED)
// is applied after auth, fail-closed (404 / 503) via the shared gate.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { pool as sharedPool } from "@workspace/db";
import {
  CreateVehicleHandoffBody,
  CreateVehicleHandoffResponse,
  GetVehicleHandoffResponse,
  ListVehicleHandoffsResponse,
  PrepareVehicleHandoffLabelsBody,
  PrepareVehicleHandoffLabelsResponse,
  GetVehicleHandoffLabelsResponse,
  ConfirmVehicleHandoffLabelsPrintedBody,
  ConfirmVehicleHandoffLabelsPrintedResponse,
  MarkVehicleHandoffHandedOverResponse,
  MarkVehicleHandoffStockTransferredResponse,
  CancelVehicleHandoffResponse,
} from "@workspace/api-zod";
import { vehicleDistributionGate } from "./index";
import {
  createHandoffInTx,
  markHandedOverInTx,
  markStockTransferredInTx,
  cancelHandoffInTx,
  getHandoff,
  listHandoffs,
  HandoffNotFoundError,
  HandoffConflictError,
  HandoffValidationError,
  type HandoffActor,
} from "./handoff-service";
import {
  prepareLabelsInTx,
  getLabelsPayload,
  confirmLabelsPrintedInTx,
} from "./label-service";

const BOT_ACTOR_TYPE = "warehouse_bot";
const BOT_ACTOR_REF = "vehicle-distribution-bot";
// Fixed numeric id for the bot actor in the BIGINT vehicle_unit_events.actor_id
// column (negative to never collide with a real admin user id).
const BOT_ACTOR_ID = -1;

/** Constant-time comparison guarded on equal length (timingSafeEqual throws on
 *  mismatched lengths). Returns false unless both are nontrivial and equal. */
function safeKeyEqual(provided: string, expected: string): boolean {
  if (!expected || expected.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Dedicated auth middleware for the vehicle-handoff router. Assigns the
 * server-side actor onto req.handoffActor; never trusts the body.
 */
export function makeHandoffAuth(pool: Pool) {
  return async function handoffAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    // (b) Bot key — only when configured and nontrivial.
    const botKey = process.env.VEHICLE_DISTRIBUTION_BOT_KEY;
    const provided = req.headers["x-vehicle-distribution-bot-key"];
    if (
      typeof botKey === "string" &&
      botKey.length > 0 &&
      typeof provided === "string" &&
      provided.length > 0 &&
      safeKeyEqual(provided, botKey)
    ) {
      (req as Request & { handoffActor: HandoffActor }).handoffActor = {
        type: BOT_ACTOR_TYPE,
        ref: BOT_ACTOR_REF,
        actorId: BOT_ACTOR_ID,
      };
      next();
      return;
    }

    // (a) Bearer admin session, revalidated server-side against admin_users.
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    try {
      const r = await pool.query(
        `SELECT u.id, u.username, u.role
           FROM admin_sessions s
           JOIN admin_users u ON u.id = s.user_id
          WHERE s.token = $1`,
        [token],
      );
      if (!r.rows.length) {
        res.status(401).json({ error: "Invalid or expired session" });
        return;
      }
      if (r.rows[0].role !== "admin") {
        res.status(403).json({ error: "Admin role required" });
        return;
      }
      (req as Request & { handoffActor: HandoffActor }).handoffActor = {
        type: "admin",
        ref: String(r.rows[0].username),
        actorId: Number(r.rows[0].id),
      };
      next();
    } catch {
      res.status(500).json({ error: "Auth check failed" });
    }
  };
}

function actorOf(req: Request): HandoffActor {
  return (req as Request & { handoffActor: HandoffActor }).handoffActor;
}

/** F4 gate — production-labels schema must be approved at request time. Applied
 *  to every prepare/list/confirm labels endpoint BEFORE any DB write; returns
 *  503 (fail-closed) when missing. */
function productionLabelsGate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (process.env.PRODUCTION_LABELS_SCHEMA_APPROVED !== "1") {
    req.log.warn(
      "production-labels schema not approved — returning 503 for F4 labels endpoint",
    );
    res
      .status(503)
      .json({ error: "Production labels schema not approved" });
    return;
  }
  next();
}

/** Map service errors to HTTP responses. */
function sendError(req: Request, res: Response, e: unknown, label: string): void {
  if (e instanceof HandoffNotFoundError) {
    res.status(404).json({ error: e.message });
    return;
  }
  if (e instanceof HandoffValidationError) {
    res.status(400).json({ error: e.message });
    return;
  }
  if (e instanceof HandoffConflictError) {
    res.status(409).json({ error: e.message });
    return;
  }
  req.log.error({ err: e }, `${label} failed`);
  res.status(500).json({ error: `${label} failed` });
}

function parseHandoffId(req: Request): number | null {
  const raw = req.params.handoffId;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export function createVehicleHandoffRouter(pool: Pool): IRouter {
  const router: IRouter = Router();

  // Own auth wall, then the shared fail-closed feature gate.
  router.use("/vehicle-distribution/handoffs", makeHandoffAuth(pool));
  router.use("/vehicle-distribution/handoffs", vehicleDistributionGate);

  // ── GET list ───────────────────────────────────────────────────────────────
  router.get(
    "/vehicle-distribution/handoffs",
    async (req, res): Promise<void> => {
      const client = await pool.connect();
      try {
        const out = await listHandoffs(client);
        res.json(ListVehicleHandoffsResponse.parse(out));
      } catch (e) {
        sendError(req, res, e, "List handoffs");
      } finally {
        client.release();
      }
    },
  );

  // ── POST create ──────────────────────────────────────────────────────────────
  router.post(
    "/vehicle-distribution/handoffs",
    async (req, res): Promise<void> => {
      const parsed = CreateVehicleHandoffBody.strict().safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }
      const body = parsed.data;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const detail = await createHandoffInTx(
          client,
          {
            sourceWarehouseId: body.sourceWarehouseId,
            items: body.items.map((i) => ({
              mahsulotId: i.mahsulotId,
              quantity: i.quantity,
              totalWeightKg: i.totalWeightKg,
            })),
            notes: body.notes ?? null,
            operationKey: body.operationKey,
          },
          actorOf(req),
        );
        const payload = CreateVehicleHandoffResponse.parse(detail);
        await client.query("COMMIT");
        res.json(payload);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        sendError(req, res, e, "Create handoff");
      } finally {
        client.release();
      }
    },
  );

  // ── GET detail ───────────────────────────────────────────────────────────────
  router.get(
    "/vehicle-distribution/handoffs/:handoffId",
    async (req, res): Promise<void> => {
      const handoffId = parseHandoffId(req);
      if (handoffId == null) {
        res.status(404).json({ error: "Handoff not found" });
        return;
      }
      const client = await pool.connect();
      try {
        const detail = await getHandoff(client, handoffId);
        res.json(GetVehicleHandoffResponse.parse(detail));
      } catch (e) {
        sendError(req, res, e, "Get handoff");
      } finally {
        client.release();
      }
    },
  );

  // Shared transition handler factory (all mutate in one transaction and
  // validate the response before commit).
  function transition(
    label: string,
    fn: (
      client: import("pg").PoolClient,
      handoffId: number,
      actor: HandoffActor,
    ) => Promise<unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema: { parse: (v: unknown) => unknown },
  ) {
    return async (req: Request, res: Response): Promise<void> => {
      const handoffId = parseHandoffId(req);
      if (handoffId == null) {
        res.status(404).json({ error: "Handoff not found" });
        return;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const detail = await fn(client, handoffId, actorOf(req));
        const payload = schema.parse(detail);
        await client.query("COMMIT");
        res.json(payload);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        sendError(req, res, e, label);
      } finally {
        client.release();
      }
    };
  }

  // ── F4: POST prepare labels ─────────────────────────────────────────────────
  router.post(
    "/vehicle-distribution/handoffs/:handoffId/labels/prepare",
    productionLabelsGate,
    async (req, res): Promise<void> => {
      const handoffId = parseHandoffId(req);
      if (handoffId == null) {
        res.status(404).json({ error: "Handoff not found" });
        return;
      }
      const parsed = PrepareVehicleHandoffLabelsBody.strict().safeParse(
        req.body ?? {},
      );
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const payload = await prepareLabelsInTx(
          client,
          handoffId,
          parsed.data.operationKey,
          actorOf(req),
        );
        const out = PrepareVehicleHandoffLabelsResponse.parse(payload);
        await client.query("COMMIT");
        res.json(out);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        sendError(req, res, e, "Prepare labels");
      } finally {
        client.release();
      }
    },
  );

  // ── F4: GET labels payload ──────────────────────────────────────────────────
  router.get(
    "/vehicle-distribution/handoffs/:handoffId/labels",
    productionLabelsGate,
    async (req, res): Promise<void> => {
      const handoffId = parseHandoffId(req);
      if (handoffId == null) {
        res.status(404).json({ error: "Handoff not found" });
        return;
      }
      const client = await pool.connect();
      try {
        const payload = await getLabelsPayload(client, handoffId);
        res.json(GetVehicleHandoffLabelsResponse.parse(payload));
      } catch (e) {
        sendError(req, res, e, "Get labels");
      } finally {
        client.release();
      }
    },
  );

  // ── F4: POST confirm labels printed (first print + reprint) ──────────────────
  router.post(
    "/vehicle-distribution/handoffs/:handoffId/confirm-labels-printed",
    productionLabelsGate,
    async (req, res): Promise<void> => {
      const handoffId = parseHandoffId(req);
      if (handoffId == null) {
        res.status(404).json({ error: "Handoff not found" });
        return;
      }
      const parsed = ConfirmVehicleHandoffLabelsPrintedBody.strict().safeParse(
        req.body ?? {},
      );
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await confirmLabelsPrintedInTx(
          client,
          handoffId,
          parsed.data.operationKey,
          actorOf(req),
        );
        const out = ConfirmVehicleHandoffLabelsPrintedResponse.parse(result);
        await client.query("COMMIT");
        res.json(out);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        sendError(req, res, e, "Confirm labels printed");
      } finally {
        client.release();
      }
    },
  );

  router.post(
    "/vehicle-distribution/handoffs/:handoffId/handed-over",
    transition(
      "Mark handed over",
      markHandedOverInTx,
      MarkVehicleHandoffHandedOverResponse,
    ),
  );

  router.post(
    "/vehicle-distribution/handoffs/:handoffId/stock-transferred",
    transition(
      "Mark stock transferred",
      markStockTransferredInTx,
      MarkVehicleHandoffStockTransferredResponse,
    ),
  );

  router.post(
    "/vehicle-distribution/handoffs/:handoffId/cancel",
    transition("Cancel handoff", cancelHandoffInTx, CancelVehicleHandoffResponse),
  );

  return router;
}

const router: IRouter = createVehicleHandoffRouter(sharedPool);

export default router;
