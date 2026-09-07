import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { requireAuth } from "./requireAuth";

function safeKeyEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireAuthOrWarehouseBotKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = process.env.WAREHOUSE_BOT_KEY;
  const provided = req.headers["x-warehouse-bot-key"];
  if (
    typeof expected === "string" &&
    expected.length > 0 &&
    typeof provided === "string" &&
    provided.length > 0 &&
    safeKeyEqual(provided, expected)
  ) {
    next();
    return;
  }
  void requireAuth(req, res, next);
}