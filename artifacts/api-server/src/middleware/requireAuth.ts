import { Request, Response, NextFunction } from "express";
import { pool } from "@workspace/db";

declare global {
  namespace Express {
    interface Request {
      userId?: number;
      username?: string;
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
      `SELECT s.user_id, u.username
       FROM admin_sessions s
       JOIN admin_users u ON u.id = s.user_id
       WHERE s.token = $1`,
      [token],
    );
    if (!r.rows.length) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }
    req.userId = r.rows[0].user_id;
    req.username = r.rows[0].username;
    next();
  } catch {
    res.status(500).json({ error: "Auth check failed" });
  }
}
