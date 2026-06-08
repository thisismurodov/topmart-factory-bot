import { Request, Response, NextFunction } from "express";
import { pool } from "@workspace/db";

declare global {
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  try {
    const r = await pool.query(
      "SELECT user_id FROM admin_sessions WHERE token = $1",
      [token],
    );
    if (!r.rows.length) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }
    req.userId = r.rows[0].user_id;
    next();
  } catch {
    res.status(500).json({ error: "Auth check failed" });
  }
}
