import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  GetWorkersResponse,
  CreateWorkerBody,
  UpdateWorkerBody,
  UpdateWorkerParams,
  UpdateWorkerResponse,
  DeleteWorkerParams,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/workers", async (_req, res): Promise<void> => {
  const result = await pool.query(
    "SELECT name, prefix, phone, role FROM workers ORDER BY name"
  );
  res.json(GetWorkersResponse.parse(result.rows));
});

router.post("/workers", async (req, res): Promise<void> => {
  const parsed = CreateWorkerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, prefix, phone, role } = parsed.data;
  const upperPrefix = prefix.toUpperCase();

  try {
    await pool.query(
      `INSERT INTO workers (name, prefix, phone, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE SET prefix = $2, phone = $3, role = $4`,
      [name, upperPrefix, phone, role]
    );
    res.status(201).json({ name, prefix: upperPrefix, phone, role });
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

router.put("/workers/:name", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
  const params = UpdateWorkerParams.safeParse({ name: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateWorkerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const currentName = params.data.name;
  const newName = parsed.data.name.trim();
  const phone = parsed.data.phone.trim();
  const role = parsed.data.role;
  const newPrefix = parsed.data.prefix.trim().toUpperCase();

  if (!newName) {
    res.status(400).json({ error: "Ism bo'sh bo'lishi mumkin emas" });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      "SELECT name FROM workers WHERE name = $1 FOR UPDATE",
      [currentName]
    );
    if (existing.rowCount === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Worker not found" });
      return;
    }

    if (newName === currentName) {
      await client.query(
        "UPDATE workers SET prefix = $1, phone = $2, role = $3 WHERE name = $4",
        [newPrefix, phone, role, currentName]
      );
      // Botdagi ushbu foydalanuvchi rolini ham moslaymiz
      await client.query("UPDATE user_roles SET role = $1 WHERE worker_name = $2", [
        role,
        currentName,
      ]);
    } else {
      const clash = await client.query("SELECT name FROM workers WHERE name = $1", [newName]);
      if ((clash.rowCount ?? 0) > 0) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "Bu ism allaqachon mavjud" });
        return;
      }

      // Ism — birlamchi kalit va bir nechta jadvalda matn sifatida saqlanadi.
      // packer_product_assignments.packer_name FK'da ON UPDATE CASCADE yo'q, shuning
      // uchun: yangi qatorni qo'shamiz → barcha havolalarni yangilaymiz → eskisini o'chiramiz.
      await client.query(
        "INSERT INTO workers (name, prefix, phone, role) VALUES ($1, $2, $3, $4)",
        [newName, newPrefix, phone, role]
      );
      await client.query("UPDATE batches SET worker = $1 WHERE worker = $2", [newName, currentName]);
      await client.query("UPDATE salary_payments SET worker = $1 WHERE worker = $2", [
        newName,
        currentName,
      ]);
      await client.query("UPDATE packer_assignments SET worker_name = $1 WHERE worker_name = $2", [
        newName,
        currentName,
      ]);
      await client.query(
        "UPDATE packer_product_assignments SET packer_name = $1 WHERE packer_name = $2",
        [newName, currentName]
      );
      await client.query("UPDATE stock_movements SET created_by = $1 WHERE created_by = $2", [
        newName,
        currentName,
      ]);
      await client.query(
        "UPDATE user_roles SET worker_name = $1, role = $2 WHERE worker_name = $3",
        [newName, role, currentName]
      );
      await client.query("DELETE FROM workers WHERE name = $1", [currentName]);
    }

    await client.query("COMMIT");
    res.json(UpdateWorkerResponse.parse({ name: newName, prefix: newPrefix, phone, role }));
  } catch (err: any) {
    await client.query("ROLLBACK");
    req.log.error({ err }, "updateWorker failed");
    res.status(409).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.delete("/workers/:name", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
  const params = DeleteWorkerParams.safeParse({ name: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const result = await pool.query("DELETE FROM workers WHERE name = $1", [params.data.name]);

  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Worker not found" });
    return;
  }

  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
