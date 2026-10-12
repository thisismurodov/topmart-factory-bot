import type { Request, Response } from "express";
import { pool } from "@workspace/db";

/** Only called after warehouse-key authentication AND operator authorization.
 * Generic recounts must continue to reject C-03 and vehicle warehouses.
 */
export async function correctC03Weight(req: Request, res: Response): Promise<boolean> {
  const body = req.body ?? {};
  if (!Number.isSafeInteger(body.warehouseId)) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const parent = await client.query(
      "SELECT id,name,purpose,active,location_type FROM warehouses WHERE id=$1 FOR UPDATE",
      [body.warehouseId],
    );
    const wh = parent.rows[0];
    if (!wh || String(wh.name).trim().toUpperCase() !== "C-03") {
      await client.query("ROLLBACK");
      return false;
    }
    const fail = async (status: number, error: string) => {
      await client.query("ROLLBACK");
      res.status(status).json({ error });
      return true;
    };
    if (!wh.active || wh.purpose !== "finished" || wh.location_type === "vehicle") {
      return await fail(409, "Canonical active C-03 finished-goods warehouse is unavailable");
    }
    const validWeight = (value: unknown) =>
      (typeof value === "string" || typeof value === "number") &&
      /^\d{1,9}(?:\.\d{1,3})?$/.test(String(value)) && Number.isFinite(Number(value));
    if (typeof body.product !== "string" || !Number.isSafeInteger(body.qty) || body.qty <= 0 ||
        !validWeight(body.weightKg) || Number(body.weightKg) <= 0 ||
        !validWeight(body.expectedWeightKg)) {
      return await fail(400, "C-03: dona, yangi kg va oldingi kg talab qilinadi. Amalni qaytadan boshlang.");
    }
    const stock = await client.query(
      `SELECT i.quantity,i.weight_kg,i.product_type,p.unit_type
         FROM inventory i JOIN products p ON p.name=i.product
        WHERE i.warehouse_id=$1 AND i.product=$2 FOR UPDATE OF i`,
      [wh.id, body.product],
    );
    const row = stock.rows[0];
    if (!row || row.product_type !== "finished" || row.unit_type !== "dona") {
      return await fail(400, "C-03: faqat mavjud dona mahsulotning jami kg sini tuzatish mumkin");
    }
    if (Number(row.quantity) !== body.qty) {
      return await fail(409, "C-03: dona sonini o'zgartirish mumkin emas. Qoldiqni qayta oching.");
    }
    const oldWeight = Number(row.weight_kg);
    const newWeight = Number(body.weightKg);
    // A delivery retry is harmless, but a different intervening correction is not.
    if (oldWeight === newWeight) {
      await client.query("COMMIT");
      res.json({ ok: true, replayed: true });
      return true;
    }
    if (oldWeight !== Number(body.expectedWeightKg)) {
      return await fail(409, "C-03 og'irligi o'zgargan. Qoldiqni qayta ochib tekshiring.");
    }
    await client.query(
      "UPDATE inventory SET weight_kg=$1,updated_at=NOW() WHERE warehouse_id=$2 AND product=$3",
      [newWeight, wh.id, body.product],
    );
    await client.query(
      `INSERT INTO stock_movements
         (product,quantity,weight_kg,movement_type,from_warehouse_id,to_warehouse_id,note,created_by,product_type)
       VALUES ($1,0,$2,$3,$4,$5,$6,$7,'finished')`,
      [body.product, Math.abs(newWeight - oldWeight).toFixed(3), newWeight > oldWeight ? "IN" : "OUT",
        newWeight < oldWeight ? wh.id : null, newWeight > oldWeight ? wh.id : null,
        `C-03 jami kg tuzatish: ${oldWeight} → ${newWeight} kg; ${body.qty} dona o'zgarmadi`,
        req.username],
    );
    await client.query("COMMIT");
    res.json({ ok: true });
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
