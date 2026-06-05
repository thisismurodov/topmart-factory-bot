import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { pool, db, adminUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { LoginBody, GetMeResponse, HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { username, password } = parsed.data;
  const [user] = await db.select().from(adminUsersTable).where(eq(adminUsersTable.username, username));

  if (!user) { res.status(401).json({ error: "Invalid credentials" }); return; }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) { res.status(401).json({ error: "Invalid credentials" }); return; }

  const token = randomUUID();
  await pool.query(
    "INSERT INTO admin_sessions (token, user_id) VALUES ($1, $2)",
    [token, user.id]
  );

  res.json({
    ok: true,
    token,
    user: { id: user.id, username: user.username, role: user.role },
  });
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
router.get("/auth/me", async (req, res): Promise<void> => {
  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) { res.status(401).json({ error: "Not authenticated" }); return; }

  const sessionRes = await pool.query(
    "SELECT user_id FROM admin_sessions WHERE token = $1",
    [token]
  );
  if (!sessionRes.rows.length) { res.status(401).json({ error: "Invalid or expired token" }); return; }

  const userId = sessionRes.rows[0].user_id;
  const [user] = await db.select().from(adminUsersTable).where(eq(adminUsersTable.id, userId));
  if (!user) { res.status(401).json({ error: "User not found" }); return; }

  res.json(GetMeResponse.parse({ id: user.id, username: user.username, role: user.role }));
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
router.post("/auth/logout", async (req, res): Promise<void> => {
  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token) {
    await pool.query("DELETE FROM admin_sessions WHERE token = $1", [token]);
  }
  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
