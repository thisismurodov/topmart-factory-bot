import app from "./app";
import { logger } from "./lib/logger";
import { pool, db, adminUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function initDb() {
  // admin_users jadvali (Drizzle schema bor, lekin Railway DB'da bo'lmasligi mumkin)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  // admin_sessions — Drizzle sxemasida yo'q, raw SQL bilan yaratiladi
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id SERIAL PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  // products.weight (og'irlik) — runtime DB (Railway) ustuniga idempotent qo'shamiz.
  // drizzle.config bo'sh Replit DB'ga ishlaydi, shuning uchun bu ALTER kerak.
  await pool.query(`
    ALTER TABLE IF EXISTS products
      ADD COLUMN IF NOT EXISTS weight NUMERIC(12,3) NOT NULL DEFAULT 1
  `);

  // products.pieces_per_box — qutidagi dona soni (etiketika: 1 quti = N dona)
  await pool.query(`
    ALTER TABLE IF EXISTS products
      ADD COLUMN IF NOT EXISTS pieces_per_box INTEGER NOT NULL DEFAULT 1
  `);

  // raw_materials.currency — xom ashyo valyutasi (UZS yoki USD)
  await pool.query(`
    ALTER TABLE IF EXISTS raw_materials
      ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'UZS'
  `);

  // product_price_tiers — hajm bo'yicha tier narxlash
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_price_tiers (
      id           SERIAL PRIMARY KEY,
      product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      min_quantity NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
      max_quantity NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (max_quantity >= min_quantity),
      price        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
      currency     TEXT NOT NULL DEFAULT 'UZS' CHECK (currency IN ('UZS','USD')),
      created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ppt_product ON product_price_tiers(product_id)
  `);

  // packer_product_assignments — packer ishchilari uchun mahsulot biriktirishlar
  // (bot init_db ham yaratadi, lekin API cold-start da mavjudligini kafolatlaymiz)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS packer_product_assignments (
      id           SERIAL PRIMARY KEY,
      packer_name  TEXT NOT NULL,
      product_name TEXT NOT NULL,
      UNIQUE (packer_name, product_name)
    )
  `);

  // line_role_config — har bir liniya uchun alohida rol konfiguratsiyasi
  // (qaysi rollar, qanday stavka, necha kishi max)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS line_role_config (
      id          SERIAL PRIMARY KEY,
      line_id     INTEGER NOT NULL REFERENCES production_lines(id) ON DELETE CASCADE,
      role_key    TEXT NOT NULL,
      label       TEXT NOT NULL DEFAULT '',
      rate        NUMERIC(12,2) NOT NULL DEFAULT 0,
      max_workers INTEGER NOT NULL DEFAULT 5,
      UNIQUE (line_id, role_key)
    )
  `);
  await pool.query(`
    ALTER TABLE line_role_config
      ADD COLUMN IF NOT EXISTS pay_mode TEXT NOT NULL DEFAULT 'pooled'
  `);
  // Producer config roles → 'individual' (own_kg × rate, not pooled).
  // Idempotent backfill: a config role is a producer role if its members also
  // hold the standard 'producer' role on the same line. Mirrors bot init_db so
  // payroll is correct regardless of which service runs migrations first.
  await pool.query(`
    UPDATE line_role_config lrc SET pay_mode = 'individual'
    WHERE lrc.pay_mode <> 'individual'
      AND EXISTS (
        SELECT 1 FROM production_line_workers w
        WHERE w.line_id = lrc.line_id AND w.role = lrc.role_key
          AND EXISTS (
            SELECT 1 FROM production_line_workers w2
            WHERE w2.line_id = w.line_id
              AND w2.worker_name = w.worker_name
              AND w2.role = 'producer'
          )
      )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_line_role_config_line
      ON line_role_config(line_id)
  `);

  // batches.archived — yumshoq o'chirish (soft delete)
  await pool.query(`
    ALTER TABLE IF EXISTS batches
      ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE
  `);

  // audit_logs — kim, qachon, nima o'zgartirdi
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id          SERIAL PRIMARY KEY,
      table_name  TEXT NOT NULL,
      action      TEXT NOT NULL,
      record_id   TEXT,
      changed_by  TEXT NOT NULL DEFAULT 'api',
      old_data    JSONB,
      new_data    JSONB,
      created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_table ON audit_logs(table_name)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_analysis_runs (
      id          SERIAL PRIMARY KEY,
      kind        TEXT NOT NULL DEFAULT 'daily',
      summary     JSONB,
      analysis    TEXT NOT NULL,
      created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_runs_created ON ai_analysis_runs(kind, created_at DESC)
  `);

  // DB darajasida CHECK constraint'lar (idempotent)
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE sale_items ADD CONSTRAINT chk_sale_items_qty CHECK (quantity > 0);
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE sales ADD CONSTRAINT chk_sales_total CHECK (total_amount >= 0);
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);

  // Admin userni seed qilish (mavjud bo'lmasa)
  const existing = await db.select().from(adminUsersTable).where(eq(adminUsersTable.username, "thisismurodov"));
  if (existing.length === 0) {
    const passwordHash = await bcrypt.hash("topmart2026", 10);
    await db.insert(adminUsersTable).values({
      username: "thisismurodov",
      passwordHash,
      role: "admin",
    });
    logger.info("Admin user created: thisismurodov");
  }
}

initDb()
  .then(() => {
    logger.info("DB initialized");
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening");
    });
  })
  .catch((err) => {
    logger.error({ err }, "DB init failed — aborting");
    process.exit(1);
  });
