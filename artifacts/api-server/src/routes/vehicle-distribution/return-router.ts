import { Router, type IRouter, type Request, type Response } from "express";
import type { Pool } from "pg";
import { pool as sharedPool } from "@workspace/db";
import {
  CancelVehicleReturnBody,
  CancelVehicleReturnResponse,
  CreateVehicleReturnBody,
  CreateVehicleReturnResponse,
  GetVehicleReturnResponse,
  ListVehicleReturnableLabelsResponse,
  ListVehicleReturnsResponse,
  MarkVehicleReturnHandedBackBody,
  MarkVehicleReturnHandedBackResponse,
  TransferVehicleReturnStockBody,
  TransferVehicleReturnStockResponse,
} from "@workspace/api-zod";
import { makeHandoffAuth } from "./handoff-router";
import { vehicleDistributionGate } from "./index";
import type { HandoffActor } from "./handoff-service";
import {
  ReturnConflictError,
  ReturnNotFoundError,
  ReturnValidationError,
  cancelReturnInTx,
  createReturnInTx,
  getReturn,
  listReturnableLabels,
  listReturns,
  markReturnHandedBackInTx,
  transferReturnStockInTx,
} from "./return-service";

const actorOf = (req: Request): HandoffActor =>
  (req as Request & { handoffActor: HandoffActor }).handoffActor;

function requireAdmin(req: Request, res: Response, next: () => void): void {
  if (actorOf(req).type !== "admin") {
    res.status(403).json({ error: "Admin role required" });
    return;
  }
  next();
}

function productionLabelsGate(req: Request, res: Response, next: () => void): void {
  if (process.env.PRODUCTION_LABELS_SCHEMA_APPROVED !== "1") {
    res.status(503).json({ error: "Production labels schema not approved" });
    return;
  }
  next();
}

function idOf(req: Request): number | null {
  const id = Number(req.params.returnId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function sendError(req: Request, res: Response, error: unknown, label: string): void {
  if (error instanceof ReturnNotFoundError) res.status(404).json({ error: error.message });
  else if (error instanceof ReturnValidationError) res.status(400).json({ error: error.message });
  else if (error instanceof ReturnConflictError) res.status(409).json({ error: error.message });
  else {
    req.log.error({ err: error }, `${label} failed`);
    res.status(500).json({ error: `${label} failed` });
  }
}

async function tx<T>(pool: Pool, fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export function createVehicleReturnRouter(pool: Pool): IRouter {
  const router: IRouter = Router();
  const base = "/vehicle-distribution/pilot";
  // Deliberately authenticate using the shared wall, then explicitly reject its
  // warehouse-bot actor for every F9 route.
  router.use(base, makeHandoffAuth(pool), requireAdmin, vehicleDistributionGate, productionLabelsGate);

  router.get(`${base}/returnable-labels`, async (req, res) => {
    const c = await pool.connect();
    try {
      const search = typeof req.query.search === "string" ? req.query.search : undefined;
      res.json(ListVehicleReturnableLabelsResponse.parse(await listReturnableLabels(c, search)));
    } catch (e) { sendError(req, res, e, "List returnable labels"); }
    finally { c.release(); }
  });

  router.get(`${base}/returns`, async (req, res) => {
    const c = await pool.connect();
    try { res.json(ListVehicleReturnsResponse.parse(await listReturns(c))); }
    catch (e) { sendError(req, res, e, "List returns"); }
    finally { c.release(); }
  });

  router.post(`${base}/returns`, async (req, res) => {
    const parsed = CreateVehicleReturnBody.strict().safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
    try {
      const out = await tx(pool, (c) => createReturnInTx(c, {
        ...parsed.data, notes: parsed.data.notes ?? null,
      }, actorOf(req)));
      res.json(CreateVehicleReturnResponse.parse(out));
    } catch (e) { sendError(req, res, e, "Create return"); }
  });

  router.get(`${base}/returns/:returnId`, async (req, res) => {
    const id = idOf(req);
    if (id == null) { res.status(404).json({ error: "Vehicle return not found" }); return; }
    const c = await pool.connect();
    try { res.json(GetVehicleReturnResponse.parse(await getReturn(c, id))); }
    catch (e) { sendError(req, res, e, "Get return"); }
    finally { c.release(); }
  });

  const transition = (
    label: string,
    fn: (c: import("pg").PoolClient, id: number, actor: HandoffActor) => Promise<unknown>,
    bodySchema: { strict: () => { safeParse: (v: unknown) => { success: boolean; error?: { message: string } } } },
    responseSchema: { parse: (v: unknown) => unknown },
  ) => async (req: Request, res: Response) => {
    const id = idOf(req);
    if (id == null) { res.status(404).json({ error: "Vehicle return not found" }); return; }
    const parsed = bodySchema.strict().safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error?.message }); return; }
    try { res.json(responseSchema.parse(await tx(pool, (c) => fn(c, id, actorOf(req))))); }
    catch (e) { sendError(req, res, e, label); }
  };

  router.post(`${base}/returns/:returnId/handed-back`, transition(
    "Mark return handed back", markReturnHandedBackInTx,
    MarkVehicleReturnHandedBackBody, MarkVehicleReturnHandedBackResponse,
  ));
  router.post(`${base}/returns/:returnId/stock-transferred`, transition(
    "Transfer returned stock", transferReturnStockInTx,
    TransferVehicleReturnStockBody, TransferVehicleReturnStockResponse,
  ));
  router.post(`${base}/returns/:returnId/cancel`, transition(
    "Cancel return", cancelReturnInTx,
    CancelVehicleReturnBody, CancelVehicleReturnResponse,
  ));
  return router;
}

export default createVehicleReturnRouter(sharedPool);