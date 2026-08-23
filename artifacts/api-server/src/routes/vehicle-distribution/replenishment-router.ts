import { Router, type IRouter, type Request, type Response } from "express";
import type { Pool } from "pg";
import { pool as sharedPool } from "@workspace/db";
import {
  ListVehicleStockTargetsResponse,
  ReplaceVehicleStockTargetBody,
  ReplaceVehicleStockTargetResponse,
  ListVehicleReplenishmentRequestsResponse,
  CreateVehicleReplenishmentRequestBody,
  CreateVehicleReplenishmentRequestResponse,
  GetVehicleReplenishmentRequestResponse,
  ApproveVehicleReplenishmentRequestBody,
  ApproveVehicleReplenishmentRequestResponse,
  CancelVehicleReplenishmentRequestBody,
  CancelVehicleReplenishmentRequestResponse,
} from "@workspace/api-zod";
import { makeHandoffAuth } from "./handoff-router";
import { vehicleDistributionGate } from "./index";
import type { HandoffActor } from "./handoff-service";
import {
  approveRequestInTx,
  cancelRequestInTx,
  createManualRequestInTx,
  getReplenishmentRequest,
  listReplenishmentRequests,
  listStockTargets,
  replaceStockTargetInTx,
  ReplenishmentConflictError,
  ReplenishmentNotFoundError,
  ReplenishmentValidationError,
} from "./replenishment-service";

const actorOf = (req: Request): HandoffActor =>
  (req as Request & { handoffActor: HandoffActor }).handoffActor;

function requireAdmin(req: Request, res: Response): boolean {
  if (actorOf(req).type !== "admin") {
    res.status(403).json({ error: "Admin role required" });
    return false;
  }
  return true;
}

function requestId(req: Request): number | null {
  const id = Number(req.params.requestId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function sendError(req: Request, res: Response, error: unknown, label: string): void {
  if (error instanceof ReplenishmentNotFoundError) {
    res.status(404).json({ error: error.message });
  } else if (error instanceof ReplenishmentValidationError) {
    res.status(400).json({ error: error.message });
  } else if (error instanceof ReplenishmentConflictError) {
    res.status(409).json({ error: error.message });
  } else {
    req.log.error({ err: error }, `${label} failed`);
    res.status(500).json({ error: `${label} failed` });
  }
}

async function transaction<T>(
  pool: Pool,
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function createVehicleReplenishmentRouter(pool: Pool): IRouter {
  const router: IRouter = Router();
  const base = "/vehicle-distribution/pilot";
  router.use(base, makeHandoffAuth(pool), vehicleDistributionGate);

  router.get(`${base}/stock-targets`, async (req, res) => {
    const client = await pool.connect();
    try {
      res.json(ListVehicleStockTargetsResponse.parse(await listStockTargets(client)));
    } catch (error) {
      sendError(req, res, error, "List stock targets");
    } finally {
      client.release();
    }
  });

  router.put(`${base}/stock-targets`, async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const parsed = ReplaceVehicleStockTargetBody.strict().safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const result = await transaction(pool, (client) =>
        replaceStockTargetInTx(
          client,
          {
            ...parsed.data,
            effectiveFrom: parsed.data.effectiveFrom
              ?.toISOString()
              .slice(0, 10),
          },
          actorOf(req),
        ),
      );
      res.json(ReplaceVehicleStockTargetResponse.parse(result));
    } catch (error) {
      sendError(req, res, error, "Replace stock target");
    }
  });

  router.get(`${base}/replenishment-requests`, async (req, res) => {
    const client = await pool.connect();
    try {
      res.json(
        ListVehicleReplenishmentRequestsResponse.parse(
          await listReplenishmentRequests(client),
        ),
      );
    } catch (error) {
      sendError(req, res, error, "List replenishment requests");
    } finally {
      client.release();
    }
  });

  router.post(`${base}/replenishment-requests`, async (req, res) => {
    const parsed = CreateVehicleReplenishmentRequestBody.strict().safeParse(
      req.body ?? {},
    );
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const result = await transaction(pool, (client) =>
        createManualRequestInTx(client, parsed.data, actorOf(req)),
      );
      res.json(CreateVehicleReplenishmentRequestResponse.parse(result));
    } catch (error) {
      sendError(req, res, error, "Create replenishment request");
    }
  });

  router.get(`${base}/replenishment-requests/:requestId`, async (req, res) => {
    const id = requestId(req);
    if (id == null) {
      res.status(404).json({ error: "Replenishment request not found" });
      return;
    }
    const client = await pool.connect();
    try {
      res.json(
        GetVehicleReplenishmentRequestResponse.parse(
          await getReplenishmentRequest(client, id),
        ),
      );
    } catch (error) {
      sendError(req, res, error, "Get replenishment request");
    } finally {
      client.release();
    }
  });

  router.post(
    `${base}/replenishment-requests/:requestId/approve`,
    async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const id = requestId(req);
      if (id == null) {
        res.status(404).json({ error: "Replenishment request not found" });
        return;
      }
      const parsed = ApproveVehicleReplenishmentRequestBody.strict().safeParse(
        req.body ?? {},
      );
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }
      try {
        const result = await transaction(pool, (client) =>
          approveRequestInTx(client, id, actorOf(req)),
        );
        res.json(ApproveVehicleReplenishmentRequestResponse.parse(result));
      } catch (error) {
        sendError(req, res, error, "Approve replenishment request");
      }
    },
  );

  router.post(
    `${base}/replenishment-requests/:requestId/cancel`,
    async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const id = requestId(req);
      if (id == null) {
        res.status(404).json({ error: "Replenishment request not found" });
        return;
      }
      const parsed = CancelVehicleReplenishmentRequestBody.strict().safeParse(
        req.body ?? {},
      );
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }
      try {
        const result = await transaction(pool, (client) =>
          cancelRequestInTx(client, id, actorOf(req)),
        );
        res.json(CancelVehicleReplenishmentRequestResponse.parse(result));
      } catch (error) {
        sendError(req, res, error, "Cancel replenishment request");
      }
    },
  );

  return router;
}

export default createVehicleReplenishmentRouter(sharedPool);