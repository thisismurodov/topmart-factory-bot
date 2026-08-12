"""Connection layer: PostgreSQL pool, transactions, init DDL.

Rules:
- The ONLY place a psycopg2 connection is ever opened.
- Connection URL comes from env (RAILWAY_DATABASE_URL preferred, else
  DATABASE_URL) — never hardcoded.
- Every checkout goes through the pool; per-command connects are forbidden.
- All queries use native PostgreSQL syntax (%s params, RETURNING id).
"""

import logging
import os
import threading
from contextlib import contextmanager

import psycopg2
import psycopg2.pool

log = logging.getLogger("distribution.db")

DB_URL = os.environ.get("RAILWAY_DATABASE_URL") or os.environ.get("DATABASE_URL")
if not DB_URL:
    raise RuntimeError("RAILWAY_DATABASE_URL or DATABASE_URL must be set")
_DB_SSL = bool(os.environ.get("RAILWAY_DATABASE_URL"))

_POOL_MIN = int(os.environ.get("DB_POOL_MIN", "1"))
_POOL_MAX = int(os.environ.get("DB_POOL_MAX", "10"))

_pool = None
_pool_lock = threading.Lock()


class DatabaseUnavailable(Exception):
    """Raised when no healthy connection can be obtained from the pool."""


def _connect_kwargs():
    kw = {
        "dsn": DB_URL,
        # Keep long-idle pooled connections alive through NAT/proxies.
        "keepalives": 1,
        "keepalives_idle": 60,
        "keepalives_interval": 15,
        "keepalives_count": 3,
        # Set search_path once per connection — no extra round trip later.
        "options": "-c search_path=distribution,public",
    }
    if _DB_SSL:
        kw["sslmode"] = "require"
    return kw


def _get_pool():
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                _pool = psycopg2.pool.ThreadedConnectionPool(
                    _POOL_MIN, _POOL_MAX, **_connect_kwargs()
                )
                log.info("DB pool created (min=%s max=%s)", _POOL_MIN, _POOL_MAX)
    return _pool


def _checkout():
    """Get a healthy raw connection from the pool (validates, retries once)."""
    pool = _get_pool()
    last_err = None
    for _ in range(3):
        try:
            conn = pool.getconn()
        except psycopg2.pool.PoolError as e:
            last_err = e
            break
        try:
            if conn.closed:
                raise psycopg2.InterfaceError("connection already closed")
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
            conn.rollback()
            return conn
        except (psycopg2.OperationalError, psycopg2.InterfaceError) as e:
            last_err = e
            log.warning("Discarding stale pooled connection: %s", e)
            try:
                pool.putconn(conn, close=True)
            except Exception:
                pass
    log.error("Database unavailable: %s", last_err)
    raise DatabaseUnavailable(str(last_err))


class PooledConnection:
    """Thin wrapper so `conn.close()` returns the connection to the pool.

    Exposes the native psycopg2 cursor — %s params, real transactions.
    """

    def __init__(self, conn):
        self._conn = conn
        self._returned = False

    def cursor(self):
        return self._conn.cursor()

    def commit(self):
        self._conn.commit()

    def rollback(self):
        try:
            self._conn.rollback()
        except Exception:
            pass

    def close(self):
        if self._returned:
            return
        self._returned = True
        try:
            self._conn.rollback()  # drop any uncommitted state before reuse
        except Exception:
            pass
        try:
            _get_pool().putconn(self._conn, close=bool(self._conn.closed))
        except Exception:
            try:
                self._conn.close()
            except Exception:
                pass

    def __del__(self):
        # Safety net: if a handler raised before close(), return the
        # connection to the pool on GC instead of leaking a pool slot.
        try:
            self.close()
        except Exception:
            pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            try:
                self._conn.commit()
            except Exception:
                self.rollback()
                self.close()
                raise
        else:
            self.rollback()
        self.close()
        return False


def get_db():
    """Checkout a pooled connection. Caller must close() (or use `with`)."""
    return PooledConnection(_checkout())


@contextmanager
def transaction():
    """All-or-nothing unit of work: yields a cursor; commit on success,
    rollback on ANY exception. No partial saves."""
    conn = PooledConnection(_checkout())
    cur = conn.cursor()
    try:
        yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        try:
            cur.close()
        except Exception:
            pass
        conn.close()


def close_pool():
    global _pool
    with _pool_lock:
        if _pool is not None:
            try:
                _pool.closeall()
            except Exception:
                pass
            _pool = None


_INIT_DDL = """
CREATE SCHEMA IF NOT EXISTS distribution;
CREATE TABLE IF NOT EXISTS distribution.users (
    id SERIAL PRIMARY KEY, telegram_id BIGINT UNIQUE, name TEXT,
    role TEXT DEFAULT 'agent', viloyat TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS distribution.dokonlar (
    id SERIAL PRIMARY KEY, nomi TEXT, egasi TEXT, telefon TEXT, viloyat TEXT,
    hudud TEXT, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, foto TEXT,
    agent_id BIGINT, holat TEXT DEFAULT 'faol', created_at TEXT, owner_telegram_id BIGINT,
    first_order_date TEXT, last_order_date TEXT, total_orders INTEGER DEFAULT 0,
    repeat_orders INTEGER DEFAULT 0, total_sales BIGINT DEFAULT 0, avg_repeat_days DOUBLE PRECISION DEFAULT 0
);
CREATE TABLE IF NOT EXISTS distribution.mahsulotlar (
    id SERIAL PRIMARY KEY, nomi TEXT, narx BIGINT, birlik TEXT DEFAULT 'dona', faol INTEGER DEFAULT 1,
    sku TEXT DEFAULT ''
);
ALTER TABLE distribution.mahsulotlar ADD COLUMN IF NOT EXISTS sku TEXT DEFAULT '';
CREATE TABLE IF NOT EXISTS distribution.savdolar (
    id SERIAL PRIMARY KEY, dokon_id BIGINT, agent_id BIGINT, jami_summa BIGINT,
    tolov_turi TEXT, foto TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS distribution.savdo_tafsilot (
    id SERIAL PRIMARY KEY, savdo_id BIGINT, mahsulot_id BIGINT, miqdor DOUBLE PRECISION, narx BIGINT, summa BIGINT
);
CREATE TABLE IF NOT EXISTS distribution.olmagan_dokonlar (
    id SERIAL PRIMARY KEY, dokon_id BIGINT, agent_id BIGINT, sabab TEXT, sabab_text TEXT,
    latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, qaytish_sanasi TEXT,
    bajarildi INTEGER DEFAULT 0, created_at TEXT, foto TEXT
);
CREATE TABLE IF NOT EXISTS distribution.pul_olish (
    id SERIAL PRIMARY KEY, dokon_id BIGINT, agent_id BIGINT, summa BIGINT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS distribution.nasiya (
    id SERIAL PRIMARY KEY, dokon_id BIGINT, agent_id BIGINT, savdo_id BIGINT, jami_summa BIGINT,
    tolangan BIGINT DEFAULT 0, qoldiq BIGINT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS distribution.mijoz_balans (
    id SERIAL PRIMARY KEY, dokon_id BIGINT UNIQUE, balans BIGINT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_savdolar_agent ON distribution.savdolar (agent_id);
CREATE TABLE IF NOT EXISTS distribution.revisitlar (
    id SERIAL PRIMARY KEY, dokon_id BIGINT, agent_id BIGINT, last_order_date TEXT,
    revisit_date TEXT, status TEXT DEFAULT 'pending', created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_revisit_pending ON distribution.revisitlar (revisit_date, status);
CREATE TABLE IF NOT EXISTS distribution.agent_plans (
    id SERIAL PRIMARY KEY, agent_id BIGINT, oy TEXT, savdo_plan BIGINT DEFAULT 0,
    dokon_plan INTEGER DEFAULT 0, created_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_plans_agent_oy ON distribution.agent_plans (agent_id, oy);
CREATE TABLE IF NOT EXISTS distribution.delivery_agents (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, telefon TEXT, tugilgan_kun TEXT,
    mashina_turi TEXT, mashina_nomeri TEXT, hudud TEXT, telegram_id BIGINT,
    faol INTEGER DEFAULT 1, created_at TEXT
);
CREATE TABLE IF NOT EXISTS distribution.delivery_routes (
    id SERIAL PRIMARY KEY, delivery_agent_id BIGINT NOT NULL, kun INTEGER NOT NULL,
    dokon_id BIGINT NOT NULL, tartib INTEGER DEFAULT 0, created_at TEXT, added_by_dlv INTEGER DEFAULT 0,
    force_saved INTEGER DEFAULT 0, biz_score INTEGER, biz_reasons TEXT
);
ALTER TABLE distribution.delivery_routes ADD COLUMN IF NOT EXISTS force_saved INTEGER DEFAULT 0;
ALTER TABLE distribution.delivery_routes ADD COLUMN IF NOT EXISTS biz_score INTEGER;
ALTER TABLE distribution.delivery_routes ADD COLUMN IF NOT EXISTS biz_reasons TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_routes_agent_kun_dokon ON distribution.delivery_routes (delivery_agent_id, kun, dokon_id);
CREATE INDEX IF NOT EXISTS idx_routes_agent_day ON distribution.delivery_routes (delivery_agent_id, kun);
CREATE TABLE IF NOT EXISTS distribution.agent_locations (
    id SERIAL PRIMARY KEY, agent_id BIGINT NOT NULL, latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL, source TEXT DEFAULT 'manual', created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_locations_agent_time ON distribution.agent_locations (agent_id, created_at);
CREATE TABLE IF NOT EXISTS distribution.field_ops (
    id SERIAL PRIMARY KEY, client_op_id TEXT NOT NULL, agent_id BIGINT NOT NULL,
    op_type TEXT NOT NULL, dokon_id BIGINT, result_id BIGINT, created_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_field_ops_client_op ON distribution.field_ops (client_op_id);
CREATE TABLE IF NOT EXISTS distribution.dokon_location_log (
    id SERIAL PRIMARY KEY, dokon_id BIGINT NOT NULL,
    old_latitude DOUBLE PRECISION, old_longitude DOUBLE PRECISION,
    new_latitude DOUBLE PRECISION, new_longitude DOUBLE PRECISION,
    changed_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dokon_location_log_dokon ON distribution.dokon_location_log (dokon_id, created_at);
CREATE TABLE IF NOT EXISTS distribution.ai_suggest_cache (
    cache_key TEXT PRIMARY KEY,
    items TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS distribution.field_route_orders (
    id SERIAL PRIMARY KEY, delivery_agent_id BIGINT NOT NULL, sana TEXT NOT NULL,
    dokon_ids TEXT NOT NULL, op_seq BIGINT NOT NULL DEFAULT 0, updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_field_route_orders_agent_sana ON distribution.field_route_orders (delivery_agent_id, sana);
"""


def init_db():
    """Idempotent DDL — safe to run at every startup (IF NOT EXISTS)."""
    conn = psycopg2.connect(**_connect_kwargs())
    try:
        cur = conn.cursor()
        cur.execute(_INIT_DDL)
        # Bot sotuv katalogi public.products (ERP master) in_sales flagini o'qiydi.
        # Yangi (faqat-distribution) bazada ham mavjud bo'lishi shart — factory
        # telegram-bot init_db'sidagi bilan bir xil idempotent CREATE+ALTER nusxasi.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS public.products (
                name      TEXT PRIMARY KEY,
                rate_type TEXT NOT NULL DEFAULT 'dona',
                rate      NUMERIC(12,2) NOT NULL DEFAULT 100
            )
            ;
            ALTER TABLE public.products
              ADD COLUMN IF NOT EXISTS id               SERIAL UNIQUE,
              ADD COLUMN IF NOT EXISTS sku              TEXT NOT NULL DEFAULT '',
              ADD COLUMN IF NOT EXISTS unit_type        TEXT NOT NULL DEFAULT 'dona',
              ADD COLUMN IF NOT EXISTS currency_type    TEXT NOT NULL DEFAULT 'UZS',
              ADD COLUMN IF NOT EXISTS default_sale_price NUMERIC(12,2) NOT NULL DEFAULT 0,
              ADD COLUMN IF NOT EXISTS salary_cost      NUMERIC(12,2) NOT NULL DEFAULT 0,
              ADD COLUMN IF NOT EXISTS electricity_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
              ADD COLUMN IF NOT EXISTS other_cost       NUMERIC(12,2) NOT NULL DEFAULT 0,
              ADD COLUMN IF NOT EXISTS minimum_stock    INTEGER NOT NULL DEFAULT 0,
              ADD COLUMN IF NOT EXISTS active           BOOLEAN NOT NULL DEFAULT TRUE,
              ADD COLUMN IF NOT EXISTS weight           NUMERIC(12,3) NOT NULL DEFAULT 1,
              ADD COLUMN IF NOT EXISTS created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
              ADD COLUMN IF NOT EXISTS pieces_per_box   INTEGER NOT NULL DEFAULT 1,
              ADD COLUMN IF NOT EXISTS in_sales         BOOLEAN NOT NULL DEFAULT FALSE,
              ADD COLUMN IF NOT EXISTS in_production    BOOLEAN NOT NULL DEFAULT TRUE
        """)
        conn.commit()
        cur.close()
        log.info("distribution schema initialized")
    finally:
        conn.close()
