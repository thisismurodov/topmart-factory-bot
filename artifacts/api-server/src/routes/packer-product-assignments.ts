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

export default router;
