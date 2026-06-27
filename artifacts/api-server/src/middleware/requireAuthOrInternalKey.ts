import { Request, Response, NextFunction } from "express";
import { requireAuth } from "./requireAuth";

// AI endpoints are consumed by two clients:
//   • the dashboard — authenticates with a Bearer session token (requireAuth)
//   • the Telegram bot — runs as a separate service, sends a shared x-internal-key
// Allow either. The internal key gates LLM cost from anonymous callers.
export function requireAuthOrInternalKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const internalKey = process.env.AI_INTERNAL_KEY;
  const provided = req.headers["x-internal-key"];
  if (
    internalKey &&
    typeof provided === "string" &&
    provided.length > 0 &&
    provided === internalKey
  ) {
    next();
    return;
  }
  void requireAuth(req, res, next);
}
