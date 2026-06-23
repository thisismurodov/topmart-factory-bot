import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

// ── GET /packer-assignments — list all packers with their products ──────────
router.get("/packer-assignments", async (_req, res): Promise<void> => {
  const { rows: packers } = await pool.query(
    "SELECT name FROM workers WHERE role='packer' ORDER BY name"
  );
  const { rows: assignments } = await pool.query(
    `SELECT ppa.packer_name, ppa.product_name, p.id AS product_id, p.unit_type
     FROM packer_product_assignments ppa
     JOIN products p ON p.name = ppa.product_name
     ORDER BY ppa.packer_name, ppa.product_name`
  );

  const byPacker: Record<string, { productName: string; productId: number; unitType: string }[]> = {};
  for (const a of assignments) {
    if (!byPacker[a.packer_name]) byPacker[a.packer_name] = [];
    byPacker[a.packer_name].push({ productName: a.product_name, productId: a.product_id, unitType: a.unit_type });
  }

  res.json(packers.map(p => ({
    packerName: p.name,
    products: byPacker[p.name] ?? [],
  })));
});

// ── GET /packer-assignments/:packerName/products — products for one packer ──
router.get("/packer-assignments/:packerName/products", async (req, res): Promise<void> => {
  const packerName = decodeURIComponent(req.params.packerName);
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.unit_type, p.rate, p.rate_type
     FROM packer_product_assignments ppa
     JOIN products p ON p.name = ppa.product_name
     WHERE ppa.packer_name = $1
     ORDER BY p.name`,
    [packerName]
  );
  res.json(rows.map(r => ({
    id: r.id, name: r.name, unitType: r.unit_type,
    rate: Number(r.rate), rateType: r.rate_type,
  })));
});

// ── POST /packer-assignments — assign product to packer ──────────────────────
router.post("/packer-assignments", async (req, res): Promise<void> => {
  const { packerName, productName } = req.body ?? {};
  if (!packerName || !productName) {
    res.status(400).json({ error: "packerName and productName are required" }); return;
  }
  try {
    await pool.query(
      `INSERT INTO packer_product_assignments (packer_name, product_name)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [packerName, productName]
    );
    res.status(201).json({ ok: true });
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

// ── PUT /packer-assignments/:packerName — set full product list for packer ──
router.put("/packer-assignments/:packerName", async (req, res): Promise<void> => {
  const packerName = decodeURIComponent(req.params.packerName);
  const { productNames } = req.body ?? {};
  if (!Array.isArray(productNames)) {
    res.status(400).json({ error: "productNames array is required" }); return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM packer_product_assignments WHERE packer_name=$1", [packerName]);
    for (const pn of productNames) {
      await client.query(
        "INSERT INTO packer_product_assignments (packer_name, product_name) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [packerName, pn]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true, count: productNames.length });
  } catch (err: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── DELETE /packer-assignments — remove product from packer ──────────────────
router.delete("/packer-assignments", async (req, res): Promise<void> => {
  const { packerName, productName } = req.body ?? {};
  if (!packerName || !productName) {
    res.status(400).json({ error: "packerName and productName are required" }); return;
  }
  await pool.query(
    "DELETE FROM packer_product_assignments WHERE packer_name=$1 AND product_name=$2",
    [packerName, productName]
  );
  res.json({ ok: true });
});

// ── GET /packer-worker-assignments — each packer with assigned workers ────────
router.get("/packer-worker-assignments", async (_req, res): Promise<void> => {
  const { rows: packers } = await pool.query(
    "SELECT w.name, ur.chat_id FROM workers w LEFT JOIN user_roles ur ON ur.worker_name=w.name AND ur.role='packer' WHERE w.role='packer' ORDER BY w.name"
  );
  const { rows: assignments } = await pool.query(
    "SELECT pa.packer_chat_id, pa.worker_name FROM packer_assignments pa"
  );

  const byChat: Record<string, string[]> = {};
  for (const a of assignments) {
    const key = String(a.packer_chat_id);
    if (!byChat[key]) byChat[key] = [];
    byChat[key].push(a.worker_name);
  }

  res.json(packers.map(p => ({
    packerName: p.name,
    chatId: p.chat_id ? Number(p.chat_id) : null,
    workers: p.chat_id ? (byChat[String(p.chat_id)] ?? []) : [],
  })));
});

// ── PUT /packer-worker-assignments/:packerName — set workers for packer ───────
router.put("/packer-worker-assignments/:packerName", async (req, res): Promise<void> => {
  const packerName = decodeURIComponent(req.params.packerName);
  const { workerNames } = req.body ?? {};
  if (!Array.isArray(workerNames)) {
    res.status(400).json({ error: "workerNames array is required" }); return;
  }

  const { rows: ur } = await pool.query(
    "SELECT chat_id FROM user_roles WHERE worker_name=$1 AND role='packer'",
    [packerName]
  );
  if (ur.length === 0) {
    res.status(404).json({ error: "Packer hali botdan ro'yxatdan o'tmagan (chat_id yo'q)" }); return;
  }
  const chatId = Number(ur[0].chat_id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM packer_assignments WHERE packer_chat_id=$1", [chatId]);
    for (const wn of workerNames) {
      await client.query(
        "INSERT INTO packer_assignments (packer_chat_id, worker_name) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [chatId, wn]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true, count: workerNames.length });
  } catch (err: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export default router;
