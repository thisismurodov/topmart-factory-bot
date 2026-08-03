import pg from "pg";

const { Pool } = pg;

const connectionString = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set.");
}

const pool = new Pool({
  connectionString,
  ssl: process.env.RAILWAY_DATABASE_URL ? { rejectUnauthorized: false } : false,
});

const DDL = `
CREATE SCHEMA IF NOT EXISTS distribution;

CREATE TABLE IF NOT EXISTS distribution.users (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE,
  name TEXT,
  role TEXT DEFAULT 'agent',
  viloyat TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS distribution.dokonlar (
  id SERIAL PRIMARY KEY,
  nomi TEXT,
  egasi TEXT,
  telefon TEXT,
  viloyat TEXT,
  hudud TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  foto TEXT,
  agent_id BIGINT,
  holat TEXT DEFAULT 'faol',
  created_at TEXT,
  owner_telegram_id BIGINT,
  first_order_date TEXT,
  last_order_date TEXT,
  total_orders INTEGER DEFAULT 0,
  repeat_orders INTEGER DEFAULT 0,
  total_sales BIGINT DEFAULT 0,
  avg_repeat_days DOUBLE PRECISION DEFAULT 0
);

CREATE TABLE IF NOT EXISTS distribution.mahsulotlar (
  id SERIAL PRIMARY KEY,
  nomi TEXT,
  narx BIGINT,
  birlik TEXT DEFAULT 'dona',
  faol INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS distribution.savdolar (
  id SERIAL PRIMARY KEY,
  dokon_id BIGINT,
  agent_id BIGINT,
  jami_summa BIGINT,
  tolov_turi TEXT,
  foto TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_savdolar_agent ON distribution.savdolar (agent_id);

CREATE TABLE IF NOT EXISTS distribution.savdo_tafsilot (
  id SERIAL PRIMARY KEY,
  savdo_id BIGINT,
  mahsulot_id BIGINT,
  miqdor DOUBLE PRECISION,
  narx BIGINT,
  summa BIGINT
);

CREATE TABLE IF NOT EXISTS distribution.olmagan_dokonlar (
  id SERIAL PRIMARY KEY,
  dokon_id BIGINT,
  agent_id BIGINT,
  sabab TEXT,
  sabab_text TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  qaytish_sanasi TEXT,
  bajarildi INTEGER DEFAULT 0,
  created_at TEXT,
  foto TEXT
);

CREATE TABLE IF NOT EXISTS distribution.pul_olish (
  id SERIAL PRIMARY KEY,
  dokon_id BIGINT,
  agent_id BIGINT,
  summa BIGINT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS distribution.nasiya (
  id SERIAL PRIMARY KEY,
  dokon_id BIGINT,
  agent_id BIGINT,
  savdo_id BIGINT,
  jami_summa BIGINT,
  tolangan BIGINT DEFAULT 0,
  qoldiq BIGINT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS distribution.mijoz_balans (
  id SERIAL PRIMARY KEY,
  dokon_id BIGINT UNIQUE,
  balans BIGINT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS distribution.revisitlar (
  id SERIAL PRIMARY KEY,
  dokon_id BIGINT,
  agent_id BIGINT,
  last_order_date TEXT,
  revisit_date TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_revisit_pending ON distribution.revisitlar (revisit_date, status);

CREATE TABLE IF NOT EXISTS distribution.agent_plans (
  id SERIAL PRIMARY KEY,
  agent_id BIGINT,
  oy TEXT,
  savdo_plan BIGINT DEFAULT 0,
  dokon_plan INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_plans_agent_oy ON distribution.agent_plans (agent_id, oy);

CREATE TABLE IF NOT EXISTS distribution.delivery_agents (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  telefon TEXT,
  tugilgan_kun TEXT,
  mashina_turi TEXT,
  mashina_nomeri TEXT,
  hudud TEXT,
  telegram_id BIGINT,
  faol INTEGER DEFAULT 1,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS distribution.delivery_routes (
  id SERIAL PRIMARY KEY,
  delivery_agent_id BIGINT NOT NULL,
  kun INTEGER NOT NULL,
  dokon_id BIGINT NOT NULL,
  tartib INTEGER DEFAULT 0,
  created_at TEXT,
  added_by_dlv INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_routes_agent_kun_dokon ON distribution.delivery_routes (delivery_agent_id, kun, dokon_id);
CREATE INDEX IF NOT EXISTS idx_routes_agent_day ON distribution.delivery_routes (delivery_agent_id, kun);

CREATE TABLE IF NOT EXISTS distribution.agent_locations (
  id SERIAL PRIMARY KEY,
  agent_id BIGINT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  source TEXT DEFAULT 'manual',
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_locations_agent_time ON distribution.agent_locations (agent_id, created_at);

CREATE TABLE IF NOT EXISTS distribution.field_ops (
  id SERIAL PRIMARY KEY,
  client_op_id TEXT NOT NULL,
  agent_id BIGINT NOT NULL,
  op_type TEXT NOT NULL,
  dokon_id BIGINT,
  result_id BIGINT,
  created_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_field_ops_client_op ON distribution.field_ops (client_op_id);
`;

async function main() {
  const client = await pool.connect();
  try {
    await client.query(DDL);
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'distribution' ORDER BY table_name`,
    );
    console.log("distribution schema tables:", rows.map((r) => r.table_name).join(", "));
    console.log(`Total: ${rows.length} tables`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
