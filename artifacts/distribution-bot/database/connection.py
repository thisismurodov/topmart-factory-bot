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
CREATE TABLE IF NOT EXISTS distribution.topmart_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    customer_id INTEGER NOT NULL,
    central_warehouse_id INTEGER NOT NULL,
    updated_by INTEGER,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT topmart_config_singleton_check CHECK (id = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_topmart_config_customer
    ON distribution.topmart_config (customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_topmart_config_warehouse
    ON distribution.topmart_config (central_warehouse_id);
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
    tolov_turi TEXT, foto TEXT, created_at TEXT, operation_key TEXT,
    operation_fingerprint TEXT, status TEXT DEFAULT 'active',
    posted_at TIMESTAMP WITH TIME ZONE
);
ALTER TABLE distribution.savdolar
    ADD COLUMN IF NOT EXISTS operation_key TEXT,
    ADD COLUMN IF NOT EXISTS operation_fingerprint TEXT,
    ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS posted_at TIMESTAMP WITH TIME ZONE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_savdolar_operation_key
    ON distribution.savdolar (operation_key) WHERE operation_key IS NOT NULL;
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

CREATE OR REPLACE FUNCTION distribution.enforce_posted_vehicle_sale_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.operation_key LIKE 'vehicle-sale:%' AND OLD.status = 'posted' THEN
        RAISE EXCEPTION 'posted vehicle sale is immutable' USING ERRCODE='55000';
    END IF;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS savdolar_posted_vehicle_immutable ON distribution.savdolar;
CREATE TRIGGER savdolar_posted_vehicle_immutable
BEFORE UPDATE OR DELETE ON distribution.savdolar
FOR EACH ROW EXECUTE FUNCTION distribution.enforce_posted_vehicle_sale_immutable();

CREATE OR REPLACE FUNCTION distribution.enforce_posted_vehicle_sale_detail_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM distribution.savdolar s
        WHERE s.id=OLD.savdo_id AND s.operation_key LIKE 'vehicle-sale:%'
          AND s.status='posted'
    ) THEN
        RAISE EXCEPTION 'posted vehicle sale detail is immutable' USING ERRCODE='55000';
    END IF;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS savdo_tafsilot_posted_vehicle_immutable ON distribution.savdo_tafsilot;
CREATE TRIGGER savdo_tafsilot_posted_vehicle_immutable
BEFORE UPDATE OR DELETE ON distribution.savdo_tafsilot
FOR EACH ROW EXECUTE FUNCTION distribution.enforce_posted_vehicle_sale_detail_immutable();
"""


_VEHICLE_DDL = """
CREATE TABLE IF NOT EXISTS distribution.vehicles (
    id               SERIAL PRIMARY KEY,
    plate_number     TEXT NOT NULL,
    vehicle_type     TEXT NOT NULL DEFAULT 'DAMAS',
    description      TEXT,
    capacity_kg      NUMERIC(12,3) NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'active',
    warehouse_id     INTEGER NOT NULL,
    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT vehicles_type_check     CHECK (vehicle_type IN ('DAMAS','LABO','NEXIA','SPARK','COBALT','OTHER')),
    CONSTRAINT vehicles_status_check   CHECK (status IN ('active','inactive','in_warehouse','on_route','maintenance')),
    CONSTRAINT vehicles_capacity_check CHECK (capacity_kg >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicles_plate     ON distribution.vehicles (plate_number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicles_warehouse ON distribution.vehicles (warehouse_id);
CREATE INDEX        IF NOT EXISTS idx_vehicles_status   ON distribution.vehicles (status);

CREATE TABLE IF NOT EXISTS distribution.vehicle_assignments (
    id                SERIAL PRIMARY KEY,
    vehicle_id        INTEGER NOT NULL,
    delivery_agent_id INTEGER NOT NULL,
    assigned_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    unassigned_at     TIMESTAMP WITH TIME ZONE,
    status            TEXT NOT NULL DEFAULT 'active',
    notes             TEXT,
    created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT vehicle_assignments_status_check CHECK (status IN ('active','ended'))
);
CREATE INDEX IF NOT EXISTS idx_vehicle_assignments_vehicle ON distribution.vehicle_assignments (vehicle_id, status);
CREATE INDEX IF NOT EXISTS idx_vehicle_assignments_agent   ON distribution.vehicle_assignments (delivery_agent_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_assignments_active_vehicle
    ON distribution.vehicle_assignments (vehicle_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_assignments_active_agent
    ON distribution.vehicle_assignments (delivery_agent_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS distribution.vehicle_handoffs (
    id                    SERIAL PRIMARY KEY,
    vehicle_id            INTEGER NOT NULL,
    delivery_agent_id     INTEGER NOT NULL,
    source_warehouse_id   INTEGER NOT NULL,
    vehicle_warehouse_id  INTEGER NOT NULL,
    handoff_date          DATE NOT NULL,
    status                TEXT NOT NULL DEFAULT 'prepared',
    labels_printed_at     TIMESTAMP WITH TIME ZONE,
    labels_printed_by     INTEGER,
    handed_over_at        TIMESTAMP WITH TIME ZONE,
    handed_over_by        INTEGER,
    stock_transferred_at  TIMESTAMP WITH TIME ZONE,
    stock_transferred_by  INTEGER,
    cancelled_at          TIMESTAMP WITH TIME ZONE,
    cancelled_by          INTEGER,
    movement_reference    TEXT,
    operation_key         TEXT,
    request_fingerprint   TEXT,
    prepared_actor_type   TEXT,
    prepared_actor_ref    TEXT,
    label_mode            TEXT NOT NULL DEFAULT 'generated',
    notes                 TEXT,
    created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT vehicle_handoffs_status_check CHECK (status IN ('prepared','labels_printed','handed_over','stock_transferred','cancelled')),
    CONSTRAINT vehicle_handoffs_label_mode_check CHECK (label_mode IN ('generated','existing'))
);
ALTER TABLE distribution.vehicle_handoffs ADD COLUMN IF NOT EXISTS operation_key       TEXT;
ALTER TABLE distribution.vehicle_handoffs ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;
ALTER TABLE distribution.vehicle_handoffs ADD COLUMN IF NOT EXISTS prepared_actor_type TEXT;
ALTER TABLE distribution.vehicle_handoffs ADD COLUMN IF NOT EXISTS prepared_actor_ref  TEXT;
ALTER TABLE distribution.vehicle_handoffs ADD COLUMN IF NOT EXISTS label_mode TEXT NOT NULL DEFAULT 'generated';
ALTER TABLE distribution.vehicle_handoffs DROP CONSTRAINT IF EXISTS vehicle_handoffs_label_mode_check;
ALTER TABLE distribution.vehicle_handoffs ADD CONSTRAINT vehicle_handoffs_label_mode_check CHECK (label_mode IN ('generated','existing'));
CREATE INDEX IF NOT EXISTS idx_vehicle_handoffs_vehicle_date ON distribution.vehicle_handoffs (vehicle_id, handoff_date);
CREATE INDEX IF NOT EXISTS idx_vehicle_handoffs_status       ON distribution.vehicle_handoffs (status, handoff_date);
-- F3: partial unique on non-null idempotency operation_key and movement_reference.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_handoffs_operation_key
    ON distribution.vehicle_handoffs (operation_key) WHERE operation_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_handoffs_movement_reference
    ON distribution.vehicle_handoffs (movement_reference) WHERE movement_reference IS NOT NULL;
-- F11: Telegram-first yuklash — agentga "✅ Mashina to'ldirildi" xabari
-- yuborilgan payt. NULL = poller hali yubormagan (at-least-once).
ALTER TABLE distribution.vehicle_handoffs ADD COLUMN IF NOT EXISTS agent_notified_at TIMESTAMP WITH TIME ZONE;

-- F11: yo'l yakuni (route-end) MASHINA HISOBOTI — bir mashina/bir kun uchun
-- BITTA yozuv. Unique juftlik hisobotning ikki marta ketishini to'sadi;
-- payload keyin tekshirish uchun JSON matn snapshoti.
CREATE TABLE IF NOT EXISTS distribution.vehicle_route_reports (
    id                 SERIAL PRIMARY KEY,
    vehicle_id         INTEGER NOT NULL,
    route_date         DATE NOT NULL,
    delivery_agent_id  INTEGER,
    agent_chat_id      BIGINT,
    payload            TEXT,
    created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_route_reports_vehicle_date
    ON distribution.vehicle_route_reports (vehicle_id, route_date);

-- Aggregate line items (one row per handoff+product). Deliberately holds NO
-- single production_label_id/barcode — per-unit label/barcode identity lives on
-- vehicle_unit_events (event_type='load').
CREATE TABLE IF NOT EXISTS distribution.vehicle_handoff_items (
    id                   SERIAL PRIMARY KEY,
    handoff_id           INTEGER NOT NULL,
    mahsulot_id          INTEGER NOT NULL,
    sku                  TEXT NOT NULL DEFAULT '',
    quantity_dispatched  NUMERIC(12,3) NOT NULL,
    unit_cost            NUMERIC(12,2) NOT NULL DEFAULT 0,
    product_name         TEXT,
    pieces_per_box       INTEGER NOT NULL DEFAULT 1,
    unit_weight_kg       NUMERIC(12,3),
    total_weight_kg      NUMERIC(12,3),
    created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT vehicle_handoff_items_qty_check  CHECK (quantity_dispatched > 0),
    CONSTRAINT vehicle_handoff_items_cost_check CHECK (unit_cost >= 0),
    CONSTRAINT vehicle_handoff_items_pieces_per_box_check CHECK (pieces_per_box > 0),
    CONSTRAINT vehicle_handoff_items_unit_weight_check  CHECK (unit_weight_kg  IS NULL OR unit_weight_kg  >= 0),
    CONSTRAINT vehicle_handoff_items_total_weight_check CHECK (total_weight_kg IS NULL OR total_weight_kg >= 0)
);
ALTER TABLE distribution.vehicle_handoff_items ADD COLUMN IF NOT EXISTS product_name    TEXT;
ALTER TABLE distribution.vehicle_handoff_items ADD COLUMN IF NOT EXISTS pieces_per_box  INTEGER NOT NULL DEFAULT 1;
ALTER TABLE distribution.vehicle_handoff_items ADD COLUMN IF NOT EXISTS unit_weight_kg  NUMERIC(12,3);
ALTER TABLE distribution.vehicle_handoff_items ADD COLUMN IF NOT EXISTS total_weight_kg NUMERIC(12,3);
ALTER TABLE distribution.vehicle_handoff_items DROP CONSTRAINT IF EXISTS vehicle_handoff_items_pieces_per_box_check;
ALTER TABLE distribution.vehicle_handoff_items ADD CONSTRAINT vehicle_handoff_items_pieces_per_box_check CHECK (pieces_per_box > 0);
CREATE INDEX        IF NOT EXISTS idx_vehicle_handoff_items_handoff          ON distribution.vehicle_handoff_items (handoff_id);
CREATE INDEX        IF NOT EXISTS idx_vehicle_handoff_items_mahsulot         ON distribution.vehicle_handoff_items (mahsulot_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_handoff_items_handoff_mahsulot  ON distribution.vehicle_handoff_items (handoff_id, mahsulot_id);

-- Per-unit lifecycle events. Individual-unit identity (production_label_id /
-- barcode) lives HERE, not on the aggregate vehicle_handoff_items. The two
-- partial unique load-identity indexes prevent the same non-null unit from
-- being loaded twice in the same handoff.
CREATE TABLE IF NOT EXISTS distribution.vehicle_unit_events (
    id                  SERIAL PRIMARY KEY,
    vehicle_id          INTEGER NOT NULL,
    handoff_id          INTEGER,
    handoff_item_id     INTEGER,
    mahsulot_id         INTEGER NOT NULL,
    sku                 TEXT NOT NULL DEFAULT '',
    event_type          TEXT NOT NULL,
    quantity            NUMERIC(12,3) NOT NULL,
    actor_id            BIGINT NOT NULL,
    production_label_id INTEGER,
    barcode             TEXT,
    operation_key       TEXT,
    label_claim_id      INTEGER,
    event_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    notes               TEXT,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT vehicle_unit_events_type_check CHECK (event_type IN ('load','unload','return','adjustment','sale','label_prepared','label_printed')),
    CONSTRAINT vehicle_unit_events_qty_check  CHECK (quantity <> 0)
);
ALTER TABLE distribution.vehicle_unit_events ADD COLUMN IF NOT EXISTS operation_key  TEXT;
ALTER TABLE distribution.vehicle_unit_events ADD COLUMN IF NOT EXISTS label_claim_id INTEGER;
-- F3 upgrade migration: if this table was created by F1 DDL it has the old CHECK
-- that only allows load/unload/return/adjustment/sale. Idempotently expand it to
-- also allow label_prepared and label_printed (safe because old set ⊆ new set).
-- DROP IF EXISTS + ADD is atomic within the transaction and safe to replay.
ALTER TABLE distribution.vehicle_unit_events
    DROP CONSTRAINT IF EXISTS vehicle_unit_events_type_check;
ALTER TABLE distribution.vehicle_unit_events
    ADD  CONSTRAINT vehicle_unit_events_type_check
    CHECK (event_type IN ('load','unload','return','adjustment','sale','label_prepared','label_printed'));
CREATE INDEX IF NOT EXISTS idx_vehicle_unit_events_vehicle_at   ON distribution.vehicle_unit_events (vehicle_id, event_at);
CREATE INDEX IF NOT EXISTS idx_vehicle_unit_events_mahsulot     ON distribution.vehicle_unit_events (mahsulot_id, event_type);
CREATE INDEX IF NOT EXISTS idx_vehicle_unit_events_handoff      ON distribution.vehicle_unit_events (handoff_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_unit_events_handoff_item ON distribution.vehicle_unit_events (handoff_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_unit_events_load_label
    ON distribution.vehicle_unit_events (handoff_id, production_label_id)
    WHERE event_type = 'load' AND production_label_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_unit_events_load_barcode
    ON distribution.vehicle_unit_events (handoff_id, barcode)
    WHERE event_type = 'load' AND barcode IS NOT NULL;
-- F3: partial unique on non-null idempotency operation_key (one event per key).
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_unit_events_operation_key
    ON distribution.vehicle_unit_events (operation_key)
    WHERE operation_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vehicle_unit_events_label_claim ON distribution.vehicle_unit_events (label_claim_id);

-- Immutable C-3 receipt provenance for already-issued production labels. This
-- intentionally records only first receipt, not subsequent custody history.
CREATE TABLE IF NOT EXISTS distribution.topmart_label_receipts (
    id                    SERIAL PRIMARY KEY,
    production_label_id   INTEGER NOT NULL,
    barcode               TEXT NOT NULL,
    sale_id               INTEGER NOT NULL,
    central_warehouse_id  INTEGER NOT NULL,
    product_sku           TEXT NOT NULL,
    pieces_in_label       INTEGER NOT NULL,
    weight_kg             NUMERIC(12,3) NOT NULL,
    receipt_fingerprint   TEXT NOT NULL,
    received_by           INTEGER NOT NULL,
    received_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT topmart_label_receipts_pieces_check CHECK (pieces_in_label > 0),
    CONSTRAINT topmart_label_receipts_weight_check CHECK (weight_kg > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_topmart_label_receipts_production_label ON distribution.topmart_label_receipts(production_label_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_topmart_label_receipts_barcode ON distribution.topmart_label_receipts(barcode);
CREATE INDEX IF NOT EXISTS idx_topmart_label_receipts_sale ON distribution.topmart_label_receipts(sale_id);
CREATE INDEX IF NOT EXISTS idx_topmart_label_receipts_warehouse ON distribution.topmart_label_receipts(central_warehouse_id);
CREATE OR REPLACE FUNCTION distribution.enforce_topmart_label_receipt_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Top Mart label receipt provenance is immutable' USING ERRCODE='55000';
END;
$$;
DROP TRIGGER IF EXISTS topmart_label_receipts_immutable ON distribution.topmart_label_receipts;
CREATE TRIGGER topmart_label_receipts_immutable
BEFORE UPDATE OR DELETE ON distribution.topmart_label_receipts
FOR EACH ROW EXECUTE FUNCTION distribution.enforce_topmart_label_receipt_immutable();

-- F3: cross-handoff physical-unit label claim. One row per physical unit
-- (production_label_id), globally unique across ALL handoffs. This is the
-- cross-handoff invariant: a physical labelled unit can only ever be claimed
-- by one handoff item. Weight/SKU snapshots make the claim self-describing.
CREATE TABLE IF NOT EXISTS distribution.vehicle_label_claims (
    id                  SERIAL PRIMARY KEY,
    vehicle_id          INTEGER NOT NULL,
    handoff_id          INTEGER NOT NULL,
    handoff_item_id     INTEGER NOT NULL,
    production_label_id INTEGER NOT NULL,
    barcode             TEXT NOT NULL,
    mahsulot_id         INTEGER NOT NULL,
    sku                 TEXT NOT NULL DEFAULT '',
    unit_weight_kg      NUMERIC(12,3) NOT NULL,
    pieces_in_label     INTEGER NOT NULL DEFAULT 1,
    remaining_quantity  INTEGER NOT NULL DEFAULT 1,
    status              TEXT NOT NULL DEFAULT 'prepared',
    operation_key       TEXT,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT vehicle_label_claims_status_check CHECK (status IN ('prepared','printed','loaded','sold','returned')),
    CONSTRAINT vehicle_label_claims_weight_check CHECK (unit_weight_kg > 0),
    CONSTRAINT vehicle_label_claims_pieces_in_label_check CHECK (pieces_in_label > 0),
    CONSTRAINT vehicle_label_claims_remaining_quantity_check CHECK (remaining_quantity >= 0 AND remaining_quantity <= pieces_in_label),
    CONSTRAINT vehicle_label_claims_status_remaining_check CHECK (
        (status IN ('sold','returned') AND remaining_quantity = 0)
        OR (status IN ('prepared','printed','loaded','return_reserved') AND remaining_quantity > 0)
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_label_claims_production_label ON distribution.vehicle_label_claims (production_label_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_label_claims_barcode         ON distribution.vehicle_label_claims (barcode);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_label_claims_operation_key
    ON distribution.vehicle_label_claims (operation_key) WHERE operation_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vehicle_label_claims_handoff      ON distribution.vehicle_label_claims (handoff_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_label_claims_handoff_item ON distribution.vehicle_label_claims (handoff_item_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_label_claims_vehicle      ON distribution.vehicle_label_claims (vehicle_id, status);
CREATE INDEX IF NOT EXISTS idx_vehicle_label_claims_mahsulot     ON distribution.vehicle_label_claims (mahsulot_id, status);

-- F4: label PREPARE session. Exactly one per handoff (handoff_id UNIQUE); the
-- server-side idempotency operation_key is globally unique. request_fingerprint
-- is a canonical SHA256 over the handoff + items snapshot so a replay with the
-- same key but a mutated payload is rejected.
CREATE TABLE IF NOT EXISTS distribution.vehicle_label_prepare_sessions (
    id                   SERIAL PRIMARY KEY,
    handoff_id           INTEGER NOT NULL,
    operation_key        TEXT NOT NULL,
    request_fingerprint  TEXT NOT NULL,
    label_count          INTEGER NOT NULL,
    actor_type           TEXT NOT NULL,
    actor_ref            TEXT NOT NULL,
    created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT vehicle_label_prepare_sessions_count_check CHECK (label_count > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_label_prepare_sessions_handoff       ON distribution.vehicle_label_prepare_sessions (handoff_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_label_prepare_sessions_operation_key ON distribution.vehicle_label_prepare_sessions (operation_key);

-- F4: label PRINT/confirm session. Many per handoff (first print + reprints);
-- operation_key globally unique for confirm idempotency. is_reprint marks a
-- reprint confirm (handoff already at/past labels_printed).
CREATE TABLE IF NOT EXISTS distribution.vehicle_label_print_sessions (
    id                   SERIAL PRIMARY KEY,
    handoff_id           INTEGER NOT NULL,
    operation_key        TEXT NOT NULL,
    label_count          INTEGER NOT NULL,
    is_reprint           BOOLEAN NOT NULL DEFAULT FALSE,
    actor_type           TEXT NOT NULL,
    actor_ref            TEXT NOT NULL,
    confirmed_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT vehicle_label_print_sessions_count_check CHECK (label_count > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_label_print_sessions_operation_key ON distribution.vehicle_label_print_sessions (operation_key);
CREATE INDEX        IF NOT EXISTS idx_vehicle_label_print_sessions_handoff       ON distribution.vehicle_label_print_sessions (handoff_id);

CREATE TABLE IF NOT EXISTS distribution.vehicle_sale_allocations (
    id                  SERIAL PRIMARY KEY,
    handoff_id          INTEGER NOT NULL,
    savdo_id            BIGINT NOT NULL,
    savdo_tafsilot_id   BIGINT NOT NULL,
    mahsulot_id         INTEGER NOT NULL,
    product_name        TEXT NOT NULL,
    product_sku         TEXT NOT NULL DEFAULT '',
    vehicle_id          INTEGER NOT NULL,
    allocated_quantity  NUMERIC(12,3) NOT NULL,
    allocated_weight_kg NUMERIC(12,3) NOT NULL,
    production_label_id INTEGER,
    barcode             TEXT,
    source_unit_event_id INTEGER,
    label_claim_id      INTEGER,
    operation_key       TEXT NOT NULL,
    allocated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT vehicle_sale_allocations_qty_check    CHECK (allocated_quantity > 0),
    CONSTRAINT vehicle_sale_allocations_weight_check CHECK (allocated_weight_kg > 0)
);
ALTER TABLE distribution.vehicle_sale_allocations
    ADD COLUMN IF NOT EXISTS label_claim_id INTEGER;
ALTER TABLE distribution.vehicle_sale_allocations
    DROP CONSTRAINT IF EXISTS vehicle_sale_allocations_concrete_qty_check;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_sale_allocations_op_key  ON distribution.vehicle_sale_allocations (operation_key);
DROP INDEX IF EXISTS distribution.uq_vehicle_sale_allocations_source_unit_event;
DROP INDEX IF EXISTS distribution.uq_vehicle_sale_allocations_label_claim;
CREATE INDEX IF NOT EXISTS idx_vehicle_sale_allocations_source_unit_event
    ON distribution.vehicle_sale_allocations (source_unit_event_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_sale_allocations_label_claim
    ON distribution.vehicle_sale_allocations (label_claim_id);
CREATE INDEX        IF NOT EXISTS idx_vehicle_sale_allocations_handoff ON distribution.vehicle_sale_allocations (handoff_id);
CREATE INDEX        IF NOT EXISTS idx_vehicle_sale_allocations_savdo   ON distribution.vehicle_sale_allocations (savdo_id);
CREATE INDEX        IF NOT EXISTS idx_vehicle_sale_allocations_vehicle ON distribution.vehicle_sale_allocations (vehicle_id);

CREATE TABLE IF NOT EXISTS distribution.vehicle_stock_targets (
    id              SERIAL PRIMARY KEY,
    vehicle_id      INTEGER NOT NULL,
    mahsulot_id     INTEGER NOT NULL,
    public_product_id BIGINT,
    product_name    TEXT,
    sku             TEXT NOT NULL DEFAULT '',
    target_quantity NUMERIC(12,3) NOT NULL,
    min_quantity    NUMERIC(12,3) NOT NULL DEFAULT 0,
    effective_from  DATE NOT NULL,
    effective_to    DATE,
    operation_key   TEXT,
    actor_type      TEXT,
    actor_ref       TEXT,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT vehicle_stock_targets_qty_check CHECK (target_quantity > 0),
    CONSTRAINT vehicle_stock_targets_min_check CHECK (min_quantity >= 0),
    CONSTRAINT vehicle_stock_targets_range_check CHECK (min_quantity <= target_quantity),
    CONSTRAINT vehicle_stock_targets_whole_units_check CHECK (
        public_product_id IS NULL OR
        (target_quantity = trunc(target_quantity) AND min_quantity = trunc(min_quantity))
    ),
    CONSTRAINT vehicle_stock_targets_identity_check CHECK (
        public_product_id IS NULL OR
        (product_name IS NOT NULL AND btrim(product_name) <> '' AND btrim(sku) <> '')
    )
);
ALTER TABLE distribution.vehicle_stock_targets
    ADD COLUMN IF NOT EXISTS public_product_id BIGINT,
    ADD COLUMN IF NOT EXISTS product_name TEXT,
    ADD COLUMN IF NOT EXISTS operation_key TEXT,
    ADD COLUMN IF NOT EXISTS actor_type TEXT,
    ADD COLUMN IF NOT EXISTS actor_ref TEXT;
ALTER TABLE distribution.vehicle_stock_targets
    DROP CONSTRAINT IF EXISTS vehicle_stock_targets_range_check,
    DROP CONSTRAINT IF EXISTS vehicle_stock_targets_whole_units_check,
    DROP CONSTRAINT IF EXISTS vehicle_stock_targets_identity_check;
ALTER TABLE distribution.vehicle_stock_targets
    ADD CONSTRAINT vehicle_stock_targets_range_check CHECK (min_quantity <= target_quantity),
    ADD CONSTRAINT vehicle_stock_targets_whole_units_check CHECK (
        public_product_id IS NULL OR
        (target_quantity = trunc(target_quantity) AND min_quantity = trunc(min_quantity))
    ),
    ADD CONSTRAINT vehicle_stock_targets_identity_check CHECK (
        public_product_id IS NULL OR
        (product_name IS NOT NULL AND btrim(product_name) <> '' AND btrim(sku) <> '')
    );
DROP INDEX IF EXISTS distribution.uq_vehicle_stock_targets_vehicle_mahsulot_from;
CREATE INDEX        IF NOT EXISTS idx_vehicle_stock_targets_vehicle ON distribution.vehicle_stock_targets (vehicle_id, public_product_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_stock_targets_current
    ON distribution.vehicle_stock_targets (vehicle_id, public_product_id)
    WHERE effective_to IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_stock_targets_operation_key
    ON distribution.vehicle_stock_targets (operation_key)
    WHERE operation_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS distribution.vehicle_replenishment_requests (
    id                 SERIAL PRIMARY KEY,
    vehicle_id         INTEGER NOT NULL,
    requested_by       BIGINT NOT NULL,
    mahsulot_id        INTEGER NOT NULL,
    public_product_id  BIGINT,
    product_name       TEXT,
    sku                TEXT NOT NULL DEFAULT '',
    requested_quantity NUMERIC(12,3) NOT NULL,
    approved_quantity  NUMERIC(12,3),
    target_quantity_snapshot NUMERIC(12,3),
    current_quantity_snapshot NUMERIC(12,3),
    source_warehouse_id INTEGER,
    handoff_id         INTEGER,
    operation_key      TEXT,
    request_fingerprint TEXT,
    status             TEXT NOT NULL DEFAULT 'pending',
    requested_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    resolved_at        TIMESTAMP WITH TIME ZONE,
    approved_by        BIGINT,
    approved_at        TIMESTAMP WITH TIME ZONE,
    cancelled_by       BIGINT,
    cancelled_at       TIMESTAMP WITH TIME ZONE,
    fulfilled_at       TIMESTAMP WITH TIME ZONE,
    notes              TEXT,
    created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT vehicle_replenishment_status_check   CHECK (status IN ('pending','approved','fulfilled','rejected','cancelled')),
    CONSTRAINT vehicle_replenishment_qty_check      CHECK (requested_quantity > 0),
    CONSTRAINT vehicle_replenishment_approved_check CHECK (approved_quantity IS NULL OR approved_quantity > 0),
    CONSTRAINT vehicle_replenishment_whole_units_check CHECK (
        public_product_id IS NULL OR
        (requested_quantity = trunc(requested_quantity)
         AND (approved_quantity IS NULL OR approved_quantity = trunc(approved_quantity)))
    ),
    CONSTRAINT vehicle_replenishment_handoff_fk FOREIGN KEY (handoff_id)
        REFERENCES distribution.vehicle_handoffs(id),
    CONSTRAINT vehicle_replenishment_identity_check CHECK (
        public_product_id IS NULL OR
        (product_name IS NOT NULL AND btrim(product_name) <> '' AND btrim(sku) <> '')
    ),
    CONSTRAINT vehicle_replenishment_snapshot_check CHECK (
        public_product_id IS NULL OR
        (target_quantity_snapshot > 0 AND current_quantity_snapshot >= 0
         AND requested_quantity = target_quantity_snapshot - current_quantity_snapshot)
    ),
    CONSTRAINT vehicle_replenishment_full_approval_check CHECK (
        status NOT IN ('approved','fulfilled') OR
        (approved_quantity IS NOT NULL AND approved_quantity = requested_quantity)
    ),
    CONSTRAINT vehicle_replenishment_linkage_check CHECK (
        public_product_id IS NULL OR
        (status = 'pending' AND approved_quantity IS NULL AND approved_by IS NULL
         AND approved_at IS NULL AND handoff_id IS NULL AND source_warehouse_id IS NULL
         AND cancelled_by IS NULL AND cancelled_at IS NULL AND fulfilled_at IS NULL)
        OR (status = 'approved' AND approved_quantity = requested_quantity
         AND approved_by IS NOT NULL AND approved_at IS NOT NULL
         AND handoff_id IS NOT NULL AND source_warehouse_id IS NOT NULL
         AND cancelled_by IS NULL AND cancelled_at IS NULL AND fulfilled_at IS NULL)
        OR (status = 'fulfilled' AND approved_quantity = requested_quantity
         AND approved_by IS NOT NULL AND approved_at IS NOT NULL
         AND handoff_id IS NOT NULL AND source_warehouse_id IS NOT NULL
         AND cancelled_by IS NULL AND cancelled_at IS NULL AND fulfilled_at IS NOT NULL)
        OR (status = 'cancelled' AND cancelled_by IS NOT NULL
         AND cancelled_at IS NOT NULL AND fulfilled_at IS NULL)
        OR (status = 'rejected' AND handoff_id IS NULL AND fulfilled_at IS NULL)
    )
);
ALTER TABLE distribution.vehicle_replenishment_requests
    ADD COLUMN IF NOT EXISTS public_product_id BIGINT,
    ADD COLUMN IF NOT EXISTS product_name TEXT,
    ADD COLUMN IF NOT EXISTS target_quantity_snapshot NUMERIC(12,3),
    ADD COLUMN IF NOT EXISTS current_quantity_snapshot NUMERIC(12,3),
    ADD COLUMN IF NOT EXISTS source_warehouse_id INTEGER,
    ADD COLUMN IF NOT EXISTS handoff_id INTEGER,
    ADD COLUMN IF NOT EXISTS operation_key TEXT,
    ADD COLUMN IF NOT EXISTS request_fingerprint TEXT,
    ADD COLUMN IF NOT EXISTS approved_by BIGINT,
    ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS cancelled_by BIGINT,
    ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS fulfilled_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE distribution.vehicle_replenishment_requests
    DROP CONSTRAINT IF EXISTS vehicle_replenishment_approved_check,
    DROP CONSTRAINT IF EXISTS vehicle_replenishment_whole_units_check,
    DROP CONSTRAINT IF EXISTS vehicle_replenishment_identity_check,
    DROP CONSTRAINT IF EXISTS vehicle_replenishment_snapshot_check,
    DROP CONSTRAINT IF EXISTS vehicle_replenishment_full_approval_check,
    DROP CONSTRAINT IF EXISTS vehicle_replenishment_linkage_check;
ALTER TABLE distribution.vehicle_replenishment_requests
    ADD CONSTRAINT vehicle_replenishment_approved_check CHECK (approved_quantity IS NULL OR approved_quantity > 0),
    ADD CONSTRAINT vehicle_replenishment_whole_units_check CHECK (
        public_product_id IS NULL OR
        (requested_quantity = trunc(requested_quantity)
         AND (approved_quantity IS NULL OR approved_quantity = trunc(approved_quantity)))
    ),
    ADD CONSTRAINT vehicle_replenishment_identity_check CHECK (
        public_product_id IS NULL OR
        (product_name IS NOT NULL AND btrim(product_name) <> '' AND btrim(sku) <> '')
    ),
    ADD CONSTRAINT vehicle_replenishment_snapshot_check CHECK (
        public_product_id IS NULL OR
        (target_quantity_snapshot > 0 AND current_quantity_snapshot >= 0
         AND requested_quantity = target_quantity_snapshot - current_quantity_snapshot)
    ),
    ADD CONSTRAINT vehicle_replenishment_full_approval_check CHECK (
        status NOT IN ('approved','fulfilled') OR
        (approved_quantity IS NOT NULL AND approved_quantity = requested_quantity)
    ),
    ADD CONSTRAINT vehicle_replenishment_linkage_check CHECK (
        public_product_id IS NULL OR
        (status = 'pending' AND approved_quantity IS NULL AND approved_by IS NULL
         AND approved_at IS NULL AND handoff_id IS NULL AND source_warehouse_id IS NULL
         AND cancelled_by IS NULL AND cancelled_at IS NULL AND fulfilled_at IS NULL)
        OR (status = 'approved' AND approved_quantity = requested_quantity
         AND approved_by IS NOT NULL AND approved_at IS NOT NULL
         AND handoff_id IS NOT NULL AND source_warehouse_id IS NOT NULL
         AND cancelled_by IS NULL AND cancelled_at IS NULL AND fulfilled_at IS NULL)
        OR (status = 'fulfilled' AND approved_quantity = requested_quantity
         AND approved_by IS NOT NULL AND approved_at IS NOT NULL
         AND handoff_id IS NOT NULL AND source_warehouse_id IS NOT NULL
         AND cancelled_by IS NULL AND cancelled_at IS NULL AND fulfilled_at IS NOT NULL)
        OR (status = 'cancelled' AND cancelled_by IS NOT NULL
         AND cancelled_at IS NOT NULL AND fulfilled_at IS NULL)
        OR (status = 'rejected' AND handoff_id IS NULL AND fulfilled_at IS NULL)
    );
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE connamespace='distribution'::regnamespace
          AND conname='vehicle_replenishment_handoff_fk'
    ) THEN
        ALTER TABLE distribution.vehicle_replenishment_requests
            ADD CONSTRAINT vehicle_replenishment_handoff_fk FOREIGN KEY (handoff_id)
            REFERENCES distribution.vehicle_handoffs(id);
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_vehicle_replenishment_vehicle_status ON distribution.vehicle_replenishment_requests (vehicle_id, status);
CREATE INDEX IF NOT EXISTS idx_vehicle_replenishment_product ON distribution.vehicle_replenishment_requests (public_product_id, status);
DROP INDEX IF EXISTS distribution.uq_vehicle_replenishment_open;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_replenishment_open
    ON distribution.vehicle_replenishment_requests (vehicle_id, public_product_id)
    WHERE status IN ('pending','approved');
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_replenishment_operation_key
    ON distribution.vehicle_replenishment_requests (operation_key)
    WHERE operation_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_replenishment_fingerprint
    ON distribution.vehicle_replenishment_requests (request_fingerprint)
    WHERE request_fingerprint IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_replenishment_handoff
    ON distribution.vehicle_replenishment_requests (handoff_id)
    WHERE handoff_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS distribution.vehicle_replenishment_outbox (
    id                    SERIAL PRIMARY KEY,
    request_id            INTEGER NOT NULL,
    recipient_chat_id     BIGINT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'PENDING',
    attempt_count         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    last_error            TEXT,
    telegram_message_id   BIGINT,
    claimed_at            TIMESTAMP WITH TIME ZONE,
    claim_token           TEXT,
    sent_at               TIMESTAMP WITH TIME ZONE,
    acknowledged_at       TIMESTAMP WITH TIME ZONE,
    created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT vehicle_replenishment_outbox_request_fk FOREIGN KEY (request_id)
        REFERENCES distribution.vehicle_replenishment_requests(id) ON DELETE CASCADE,
    CONSTRAINT vehicle_replenishment_outbox_status_check
        CHECK (status IN ('PENDING','SENT','FAILED','ACKNOWLEDGED')),
    CONSTRAINT vehicle_replenishment_outbox_attempt_check CHECK (attempt_count >= 0)
);
ALTER TABLE distribution.vehicle_replenishment_outbox
    ADD COLUMN IF NOT EXISTS claim_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_replenishment_outbox_request_recipient
    ON distribution.vehicle_replenishment_outbox (request_id, recipient_chat_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_replenishment_outbox_retry
    ON distribution.vehicle_replenishment_outbox (status, next_attempt_at, claimed_at);

CREATE TABLE IF NOT EXISTS distribution.vehicle_reconciliations (
    id                   SERIAL PRIMARY KEY,
    vehicle_id           INTEGER NOT NULL,
    delivery_agent_id    INTEGER NOT NULL,
    reconciliation_date  DATE NOT NULL,
    status               TEXT NOT NULL DEFAULT 'draft',
    created_by           BIGINT,
    reviewed_by          BIGINT,
    reviewed_at          TIMESTAMP WITH TIME ZONE,
    approved_by          INTEGER,
    approved_at          TIMESTAMP WITH TIME ZONE,
    applied_by           INTEGER,
    applied_at           TIMESTAMP WITH TIME ZONE,
    notes                TEXT,
    created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT vehicle_reconciliations_status_check CHECK (status IN ('draft','approved','applied','disputed','cancelled'))
);
-- F6 upgrade: header actor columns on pre-existing tables (idempotent).
ALTER TABLE distribution.vehicle_reconciliations
    ADD COLUMN IF NOT EXISTS created_by  BIGINT,
    ADD COLUMN IF NOT EXISTS reviewed_by BIGINT,
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP WITH TIME ZONE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_reconciliations_vehicle_date ON distribution.vehicle_reconciliations (vehicle_id, reconciliation_date);
CREATE INDEX        IF NOT EXISTS idx_vehicle_reconciliations_status_date ON distribution.vehicle_reconciliations (status, reconciliation_date);
CREATE INDEX        IF NOT EXISTS idx_vehicle_reconciliations_agent       ON distribution.vehicle_reconciliations (delivery_agent_id, reconciliation_date);

CREATE TABLE IF NOT EXISTS distribution.vehicle_reconciliation_items (
    id                    SERIAL PRIMARY KEY,
    reconciliation_id     INTEGER NOT NULL,
    mahsulot_id           INTEGER,
    public_product_id     BIGINT,
    product_name          TEXT,
    sku                   TEXT NOT NULL DEFAULT '',
    expected_quantity     NUMERIC(12,3) NOT NULL,
    expected_weight_kg    NUMERIC(12,3),
    actual_quantity       NUMERIC(12,3),
    discrepancy           NUMERIC(12,3) NOT NULL DEFAULT 0,
    counted_by            BIGINT,
    counted_at            TIMESTAMP WITH TIME ZONE,
    adjustment_reference  TEXT,
    notes                 TEXT,
    created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT vehicle_reconciliation_items_expected_check CHECK (expected_quantity >= 0),
    CONSTRAINT vehicle_reconciliation_items_expected_weight_check CHECK (expected_weight_kg IS NULL OR expected_weight_kg >= 0),
    CONSTRAINT vehicle_reconciliation_items_actual_check   CHECK (actual_quantity IS NULL OR actual_quantity >= 0),
    CONSTRAINT vehicle_reconciliation_items_erp_line_check  CHECK (public_product_id IS NULL OR (product_name IS NOT NULL AND sku IS NOT NULL))
);
-- F6 upgrade: reshape a pre-existing legacy table (idempotent).
ALTER TABLE distribution.vehicle_reconciliation_items
    ADD COLUMN IF NOT EXISTS public_product_id  BIGINT,
    ADD COLUMN IF NOT EXISTS product_name       TEXT,
    ADD COLUMN IF NOT EXISTS expected_weight_kg NUMERIC(12,3),
    ADD COLUMN IF NOT EXISTS counted_by         BIGINT,
    ADD COLUMN IF NOT EXISTS counted_at         TIMESTAMP WITH TIME ZONE;
ALTER TABLE distribution.vehicle_reconciliation_items ALTER COLUMN mahsulot_id     DROP NOT NULL;
ALTER TABLE distribution.vehicle_reconciliation_items ALTER COLUMN actual_quantity DROP NOT NULL;
-- Replace/ensure the F6 CHECK constraints (drop-then-add so each ALTER is
-- idempotent: no ADD CONSTRAINT IF NOT EXISTS in Postgres).
ALTER TABLE distribution.vehicle_reconciliation_items DROP CONSTRAINT IF EXISTS vehicle_reconciliation_items_actual_check;
ALTER TABLE distribution.vehicle_reconciliation_items ADD CONSTRAINT vehicle_reconciliation_items_actual_check CHECK (actual_quantity IS NULL OR actual_quantity >= 0);
ALTER TABLE distribution.vehicle_reconciliation_items DROP CONSTRAINT IF EXISTS vehicle_reconciliation_items_expected_weight_check;
ALTER TABLE distribution.vehicle_reconciliation_items ADD CONSTRAINT vehicle_reconciliation_items_expected_weight_check CHECK (expected_weight_kg IS NULL OR expected_weight_kg >= 0);
ALTER TABLE distribution.vehicle_reconciliation_items DROP CONSTRAINT IF EXISTS vehicle_reconciliation_items_erp_line_check;
ALTER TABLE distribution.vehicle_reconciliation_items ADD CONSTRAINT vehicle_reconciliation_items_erp_line_check CHECK (public_product_id IS NULL OR (product_name IS NOT NULL AND sku IS NOT NULL));
-- Legacy unique becomes partial (multi-NULL mahsulot_id must not collide).
DROP INDEX IF EXISTS distribution.uq_vehicle_reconciliation_items_rec_mahsulot;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_reconciliation_items_rec_mahsulot
    ON distribution.vehicle_reconciliation_items (reconciliation_id, mahsulot_id)
    WHERE mahsulot_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_reconciliation_items_rec_public_product
    ON distribution.vehicle_reconciliation_items (reconciliation_id, public_product_id)
    WHERE public_product_id IS NOT NULL;
CREATE INDEX        IF NOT EXISTS idx_vehicle_reconciliation_items_reconciliation ON distribution.vehicle_reconciliation_items (reconciliation_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_reconciliation_items_adj_ref
    ON distribution.vehicle_reconciliation_items (adjustment_reference)
    WHERE adjustment_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS distribution.vehicle_returns (
    id SERIAL PRIMARY KEY,
    vehicle_id INTEGER NOT NULL,
    vehicle_assignment_id INTEGER NOT NULL,
    delivery_agent_id INTEGER NOT NULL,
    vehicle_warehouse_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'prepared',
    operation_key TEXT NOT NULL,
    operation_fingerprint TEXT NOT NULL,
    notes TEXT,
    prepared_by BIGINT NOT NULL,
    prepared_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    handed_back_by BIGINT,
    handed_back_at TIMESTAMP WITH TIME ZONE,
    transferred_by BIGINT,
    transferred_at TIMESTAMP WITH TIME ZONE,
    cancelled_by BIGINT,
    cancelled_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT vehicle_returns_status_check
      CHECK (status IN ('prepared','handed_back','stock_transferred','cancelled')),
    CONSTRAINT vehicle_returns_lifecycle_check CHECK (
      (status='prepared' AND handed_back_by IS NULL AND handed_back_at IS NULL
       AND transferred_by IS NULL AND transferred_at IS NULL
       AND cancelled_by IS NULL AND cancelled_at IS NULL)
      OR (status='handed_back' AND handed_back_by IS NOT NULL AND handed_back_at IS NOT NULL
       AND transferred_by IS NULL AND transferred_at IS NULL
       AND cancelled_by IS NULL AND cancelled_at IS NULL)
      OR (status='stock_transferred' AND handed_back_by IS NOT NULL AND handed_back_at IS NOT NULL
       AND transferred_by IS NOT NULL AND transferred_at IS NOT NULL
       AND cancelled_by IS NULL AND cancelled_at IS NULL)
      OR (status='cancelled' AND handed_back_by IS NULL AND handed_back_at IS NULL
       AND transferred_by IS NULL AND transferred_at IS NULL
       AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL)
    )
);
ALTER TABLE distribution.vehicle_returns
    ADD COLUMN IF NOT EXISTS vehicle_assignment_id INTEGER,
    ADD COLUMN IF NOT EXISTS delivery_agent_id INTEGER,
    ADD COLUMN IF NOT EXISTS operation_fingerprint TEXT,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW();
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_returns_operation_key
    ON distribution.vehicle_returns (operation_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_returns_open_vehicle
    ON distribution.vehicle_returns (vehicle_id)
    WHERE status IN ('prepared','handed_back');
CREATE INDEX IF NOT EXISTS idx_vehicle_returns_vehicle_created
    ON distribution.vehicle_returns (vehicle_id, created_at);

ALTER TABLE distribution.vehicle_label_claims
    ADD COLUMN IF NOT EXISTS return_id INTEGER,
    ADD COLUMN IF NOT EXISTS returned_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS returned_by BIGINT,
    ADD COLUMN IF NOT EXISTS pieces_in_label INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS remaining_quantity INTEGER NOT NULL DEFAULT 1;
UPDATE distribution.vehicle_label_claims
   SET remaining_quantity = CASE WHEN status IN ('sold','returned') THEN 0 ELSE 1 END
 WHERE remaining_quantity = 1;
ALTER TABLE distribution.vehicle_label_claims DROP CONSTRAINT IF EXISTS vehicle_label_claims_status_check;
ALTER TABLE distribution.vehicle_label_claims ADD CONSTRAINT vehicle_label_claims_status_check
    CHECK (status IN ('prepared','printed','loaded','return_reserved','sold','returned'));
ALTER TABLE distribution.vehicle_label_claims DROP CONSTRAINT IF EXISTS vehicle_label_claims_pieces_in_label_check;
ALTER TABLE distribution.vehicle_label_claims ADD CONSTRAINT vehicle_label_claims_pieces_in_label_check CHECK (pieces_in_label > 0);
ALTER TABLE distribution.vehicle_label_claims DROP CONSTRAINT IF EXISTS vehicle_label_claims_remaining_quantity_check;
ALTER TABLE distribution.vehicle_label_claims ADD CONSTRAINT vehicle_label_claims_remaining_quantity_check CHECK (remaining_quantity >= 0 AND remaining_quantity <= pieces_in_label);
ALTER TABLE distribution.vehicle_label_claims DROP CONSTRAINT IF EXISTS vehicle_label_claims_status_remaining_check;
ALTER TABLE distribution.vehicle_label_claims ADD CONSTRAINT vehicle_label_claims_status_remaining_check CHECK (
    (status IN ('sold','returned') AND remaining_quantity = 0)
    OR (status IN ('prepared','printed','loaded','return_reserved') AND remaining_quantity > 0)
);
ALTER TABLE distribution.vehicle_label_claims DROP CONSTRAINT IF EXISTS vehicle_label_claims_return_linkage_check;
ALTER TABLE distribution.vehicle_label_claims ADD CONSTRAINT vehicle_label_claims_return_linkage_check CHECK (
    (status='return_reserved' AND return_id IS NOT NULL AND returned_at IS NULL AND returned_by IS NULL)
    OR (status='returned' AND
       ((return_id IS NOT NULL AND returned_at IS NOT NULL AND returned_by IS NOT NULL)
        OR (return_id IS NULL AND returned_at IS NULL AND returned_by IS NULL)))
    OR (status NOT IN ('return_reserved','returned') AND return_id IS NULL
        AND returned_at IS NULL AND returned_by IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_vehicle_label_claims_return
    ON distribution.vehicle_label_claims (return_id);
DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname='vehicle_label_claims_return_fk'
         AND conrelid='distribution.vehicle_label_claims'::regclass
    ) THEN
      ALTER TABLE distribution.vehicle_label_claims
        ADD CONSTRAINT vehicle_label_claims_return_fk
        FOREIGN KEY (return_id) REFERENCES distribution.vehicle_returns(id);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS distribution.vehicle_return_items (
    id SERIAL PRIMARY KEY,
    return_id INTEGER NOT NULL REFERENCES distribution.vehicle_returns(id),
    label_claim_id INTEGER NOT NULL UNIQUE REFERENCES distribution.vehicle_label_claims(id),
    production_label_id INTEGER NOT NULL,
    barcode TEXT NOT NULL,
    handoff_id INTEGER NOT NULL,
    handoff_item_id INTEGER NOT NULL,
    mahsulot_id INTEGER NOT NULL,
    public_product_id BIGINT NOT NULL,
    product_name TEXT NOT NULL,
    sku TEXT NOT NULL,
    unit_weight_kg NUMERIC(12,3) NOT NULL,
    return_quantity INTEGER NOT NULL DEFAULT 1,
    return_weight_kg NUMERIC(12,3) NOT NULL DEFAULT 1,
    destination_warehouse_id INTEGER NOT NULL,
    movement_reference TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT vehicle_return_items_weight_check CHECK (unit_weight_kg > 0),
    CONSTRAINT vehicle_return_items_return_quantity_check CHECK (return_quantity > 0),
    CONSTRAINT vehicle_return_items_return_weight_check CHECK (return_weight_kg > 0),
    CONSTRAINT vehicle_return_items_identity_check
      CHECK (btrim(barcode) <> '' AND btrim(product_name) <> '' AND btrim(sku) <> '')
);
ALTER TABLE distribution.vehicle_return_items
    ADD COLUMN IF NOT EXISTS return_quantity INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS return_weight_kg NUMERIC(12,3) NOT NULL DEFAULT 1;
UPDATE distribution.vehicle_return_items
   SET return_weight_kg = unit_weight_kg
 WHERE return_quantity = 1
   AND return_weight_kg = 1
   AND unit_weight_kg <> 1;
ALTER TABLE distribution.vehicle_return_items DROP CONSTRAINT IF EXISTS vehicle_return_items_return_quantity_check;
ALTER TABLE distribution.vehicle_return_items ADD CONSTRAINT vehicle_return_items_return_quantity_check CHECK (return_quantity > 0);
ALTER TABLE distribution.vehicle_return_items DROP CONSTRAINT IF EXISTS vehicle_return_items_return_weight_check;
ALTER TABLE distribution.vehicle_return_items ADD CONSTRAINT vehicle_return_items_return_weight_check CHECK (return_weight_kg > 0);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_return_items_return_barcode
    ON distribution.vehicle_return_items (return_id, barcode);
CREATE INDEX IF NOT EXISTS idx_vehicle_return_items_return
    ON distribution.vehicle_return_items (return_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_return_items_destination
    ON distribution.vehicle_return_items (destination_warehouse_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_unit_events_return_label_claim
    ON distribution.vehicle_unit_events (label_claim_id)
    WHERE event_type='return' AND label_claim_id IS NOT NULL;
"""

_VEHICLE_APPROVED = os.environ.get("VEHICLE_DISTRIBUTION_SCHEMA_APPROVED") == "1"


def init_db():
    """Idempotent DDL — safe to run at every startup (IF NOT EXISTS)."""
    conn = psycopg2.connect(**_connect_kwargs())
    try:
        cur = conn.cursor()
        cur.execute(_INIT_DDL)
        if _VEHICLE_APPROVED:
            log.info("VEHICLE_DISTRIBUTION_SCHEMA_APPROVED=1 — applying vehicle tables...")
            cur.execute(_VEHICLE_DDL)
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
        # F7 direct bot transaction prerequisites. These definitions mirror the
        # API public initializer so a fresh bot-owned database can plan and run
        # the cross-schema sale without relying on API startup order.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS public.warehouses (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                active BOOLEAN NOT NULL DEFAULT TRUE,
                location_type TEXT NOT NULL DEFAULT 'general',
                capacity_kg NUMERIC DEFAULT 20000,
                purpose TEXT NOT NULL DEFAULT 'finished',
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            );
            ALTER TABLE public.warehouses
                ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
                ADD COLUMN IF NOT EXISTS location_type TEXT NOT NULL DEFAULT 'general',
                ADD COLUMN IF NOT EXISTS capacity_kg NUMERIC DEFAULT 20000,
                ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'finished',
                ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW();
            CREATE TABLE IF NOT EXISTS public.inventory (
                id SERIAL PRIMARY KEY,
                warehouse_id INTEGER NOT NULL REFERENCES public.warehouses(id),
                product TEXT NOT NULL,
                quantity NUMERIC NOT NULL DEFAULT 0,
                weight_kg NUMERIC NOT NULL DEFAULT 0,
                product_type TEXT NOT NULL DEFAULT 'finished',
                updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                UNIQUE (warehouse_id, product)
            );
            ALTER TABLE public.inventory
                ADD COLUMN IF NOT EXISTS weight_kg NUMERIC NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'finished',
                ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW();
            CREATE TABLE IF NOT EXISTS public.stock_movements (
                id SERIAL PRIMARY KEY,
                product TEXT NOT NULL,
                quantity NUMERIC NOT NULL DEFAULT 0,
                movement_type TEXT NOT NULL
                    CHECK (movement_type IN ('IN','OUT','TRANSFER','BASELINE')),
                from_warehouse_id INTEGER REFERENCES public.warehouses(id),
                to_warehouse_id INTEGER REFERENCES public.warehouses(id),
                note TEXT NOT NULL DEFAULT '',
                created_by TEXT NOT NULL DEFAULT '',
                product_type TEXT NOT NULL DEFAULT 'finished',
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                weight_kg NUMERIC,
                reference TEXT,
                reason TEXT
            );
            ALTER TABLE public.stock_movements
                ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'finished',
                ADD COLUMN IF NOT EXISTS weight_kg NUMERIC,
                ADD COLUMN IF NOT EXISTS reference TEXT,
                ADD COLUMN IF NOT EXISTS reason TEXT;
            CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movements_vehicle_sale_reference
                ON public.stock_movements (reference)
                WHERE reference LIKE 'vehicle-sale:%';
            CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movements_vehicle_return_reference
                ON public.stock_movements (reference)
                WHERE reference LIKE 'vehicle-return:%';
        """)
        conn.commit()
        cur.close()
        log.info("distribution schema initialized")
    finally:
        conn.close()
