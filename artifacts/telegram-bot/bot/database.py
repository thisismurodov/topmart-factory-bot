import os
import time
import logging
from datetime import date
from contextlib import contextmanager

import psycopg2
import psycopg2.extras

from .config import DATABASE_URL, SEED_WORKERS, SEED_PRODUCTS

_log = logging.getLogger(__name__)
_MAX_RETRIES = 5


class WipBalanceError(Exception):
    """Bo'limda yetarli xom ashyo yo'q (PRODUCE > RECEIVE − PRODUCE)."""


def _connect_with_retry() -> psycopg2.extensions.connection:
    """psycopg2.connect + exponential backoff (1 2 4 8 16 s)."""
    delay = 1
    for attempt in range(1, _MAX_RETRIES + 1):
        try:
            return psycopg2.connect(DATABASE_URL)
        except psycopg2.OperationalError as exc:
            if attempt == _MAX_RETRIES:
                raise
            _log.warning("DB ulanish xatosi (urinish %d/%d): %s — %ds dan so'ng qayta uriniladi",
                         attempt, _MAX_RETRIES, exc, delay)
            time.sleep(delay)
            delay = min(delay * 2, 16)


@contextmanager
def get_conn():
    conn = _connect_with_retry()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        yield conn, cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


def init_db() -> None:
    with get_conn() as (conn, cur):
        cur.execute("""
            CREATE TABLE IF NOT EXISTS workers (
                name   TEXT PRIMARY KEY,
                prefix TEXT NOT NULL DEFAULT '',
                phone  TEXT NOT NULL DEFAULT '',
                role   TEXT NOT NULL DEFAULT 'worker'
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS products (
                name      TEXT PRIMARY KEY,
                rate_type TEXT NOT NULL DEFAULT 'dona',
                rate      NUMERIC(12,2) NOT NULL DEFAULT 100
            )
        """)
        # V3: add new cost/pricing columns idempotently
        cur.execute("""
            ALTER TABLE products
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
              ADD COLUMN IF NOT EXISTS pieces_per_box   INTEGER NOT NULL DEFAULT 1
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS batches (
                id         SERIAL PRIMARY KEY,
                batch_code TEXT NOT NULL,
                worker     TEXT NOT NULL,
                product    TEXT NOT NULL,
                quantity   INTEGER NOT NULL,
                weight_kg  NUMERIC(10,3) NOT NULL DEFAULT 0,
                earnings   NUMERIC(12,2) NOT NULL DEFAULT 0,
                payroll_method TEXT NOT NULL DEFAULT 'PRODUCT_RATE',
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        # Batch Session: bitta batch_code ostida bir nechta mahsulot (batch items)
        # bo'lishi uchun batch_code ustidagi UNIQUE cheklovini olib tashlaymiz.
        # Eski DB'larda u avtomatik nom bilan yaratilgan — faqat public.batches dagi
        # va batch_code ustunini o'z ichiga olgan UNIQUE cheklovlarni drop qilamiz.
        cur.execute("""
            DO $$
            DECLARE c text;
            BEGIN
              FOR c IN
                SELECT con.conname
                FROM pg_constraint con
                JOIN pg_class rel ON rel.oid = con.conrelid
                JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
                WHERE rel.relname = 'batches'
                  AND nsp.nspname = 'public'
                  AND con.contype = 'u'
                  AND EXISTS (
                    SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = con.conrelid
                      AND a.attnum = ANY(con.conkey)
                      AND a.attname = 'batch_code'
                  )
              LOOP
                EXECUTE format('ALTER TABLE public.batches DROP CONSTRAINT %I', c);
              END LOOP;
            END $$;
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_batches_batch_code ON batches (batch_code)")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS user_roles (
                chat_id     BIGINT PRIMARY KEY,
                worker_name TEXT NOT NULL,
                role        TEXT NOT NULL DEFAULT 'worker'
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS packer_assignments (
                packer_chat_id BIGINT NOT NULL,
                worker_name    TEXT   NOT NULL,
                PRIMARY KEY (packer_chat_id, worker_name)
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS pending_users (
                chat_id    BIGINT PRIMARY KEY,
                name       TEXT NOT NULL,
                phone      TEXT NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS salary_payments (
                id      SERIAL PRIMARY KEY,
                worker  TEXT NOT NULL,
                year    INTEGER NOT NULL,
                month   INTEGER NOT NULL,
                amount  NUMERIC(12,2) NOT NULL,
                paid_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                UNIQUE (worker, year, month)
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS customers (
                id         SERIAL PRIMARY KEY,
                name       TEXT NOT NULL,
                phone      TEXT NOT NULL DEFAULT '',
                company    TEXT NOT NULL DEFAULT '',
                address    TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sales (
                id            SERIAL PRIMARY KEY,
                customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
                customer_name TEXT NOT NULL DEFAULT '',
                product       TEXT NOT NULL,
                quantity      INTEGER NOT NULL DEFAULT 0,
                weight_kg     NUMERIC(10,3) NOT NULL DEFAULT 0,
                unit_price    NUMERIC(12,2) NOT NULL DEFAULT 0,
                total_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
                status        TEXT NOT NULL DEFAULT 'pending',
                note          TEXT NOT NULL DEFAULT '',
                created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sale_products (
                id       SERIAL PRIMARY KEY,
                name     TEXT NOT NULL UNIQUE,
                code     TEXT NOT NULL DEFAULT '',
                unit     TEXT NOT NULL DEFAULT 'dona',
                currency TEXT NOT NULL DEFAULT 'uzs',
                active   BOOLEAN NOT NULL DEFAULT true,
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        # sale_items — sotuvning qatorlari. create_sale() shu jadvalga yozadi,
        # lekin ilgari uni faqat API initDb yaratardi; bot toza bazada sotuv
        # qilsa "relation sale_items does not exist" bilan yiqilardi. API'dagi
        # ta'rif bilan bir xil (idempotent, IF NOT EXISTS).
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sale_items (
                id           SERIAL PRIMARY KEY,
                sale_id      INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
                product_name TEXT NOT NULL,
                sale_type    TEXT NOT NULL DEFAULT 'dona',
                quantity     NUMERIC(12,3) NOT NULL DEFAULT 0,
                unit_price   NUMERIC(12,2) NOT NULL DEFAULT 0,
                currency     TEXT NOT NULL DEFAULT 'UZS',
                line_total   NUMERIC(14,2) NOT NULL DEFAULT 0
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id)
        """)
        # Sotuv sxemasi kengaytmalari — create_sale() currency ustuniga yozadi,
        # add_sale_payment() paid_amount/debt_amount'ni yangilaydi va
        # sale_payments jadvaliga yozadi. Bular ilgari hech qaysi init'da
        # yaratilmagan (faqat jonli DB'da bor edi) — toza bazada bot yiqilardi.
        cur.execute("""
            ALTER TABLE sales
              ADD COLUMN IF NOT EXISTS currency     TEXT NOT NULL DEFAULT 'uzs',
              ADD COLUMN IF NOT EXISTS payment_type TEXT NOT NULL DEFAULT 'naqd',
              ADD COLUMN IF NOT EXISTS paid_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
              ADD COLUMN IF NOT EXISTS debt_amount  NUMERIC(12,2) NOT NULL DEFAULT 0
        """)
        # API POST /sales product'siz INSERT qiladi — NOT NULL bo'lsa 500 bo'ladi.
        cur.execute("ALTER TABLE sales ALTER COLUMN product DROP NOT NULL")
        cur.execute("""
            ALTER TABLE customers
              ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sale_payments (
                id         SERIAL PRIMARY KEY,
                sale_id    INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
                amount     NUMERIC(12,2) NOT NULL,
                currency   TEXT NOT NULL DEFAULT 'USD',
                note       TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_sale_payments_sale ON sale_payments(sale_id)
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS raw_materials (
                id            SERIAL PRIMARY KEY,
                name          TEXT NOT NULL UNIQUE,
                unit          TEXT NOT NULL DEFAULT 'kg',
                unit_type     TEXT NOT NULL DEFAULT 'kg',
                default_cost  NUMERIC(12,2) NOT NULL DEFAULT 0,
                currency      TEXT NOT NULL DEFAULT 'UZS',
                current_stock NUMERIC(12,3) NOT NULL DEFAULT 0,
                minimum_stock NUMERIC(12,3) NOT NULL DEFAULT 0,
                active        BOOLEAN NOT NULL DEFAULT true,
                created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        # V3: idempotent migration — add new columns if pre-V3 table exists
        cur.execute("""
            ALTER TABLE raw_materials
              ADD COLUMN IF NOT EXISTS unit_type     TEXT NOT NULL DEFAULT 'kg',
              ADD COLUMN IF NOT EXISTS default_cost  NUMERIC(12,2) NOT NULL DEFAULT 0,
              ADD COLUMN IF NOT EXISTS currency      TEXT NOT NULL DEFAULT 'UZS',
              ADD COLUMN IF NOT EXISTS current_stock NUMERIC(12,3) NOT NULL DEFAULT 0,
              ADD COLUMN IF NOT EXISTS minimum_stock NUMERIC(12,3) NOT NULL DEFAULT 0
        """)
        cur.execute("""
            DO $$ BEGIN
              IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'raw_materials_currency_check') THEN
                ALTER TABLE raw_materials ADD CONSTRAINT raw_materials_currency_check CHECK (currency IN ('UZS','USD'));
              END IF;
            END $$;
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS product_materials (
                id                SERIAL PRIMARY KEY,
                product_name      TEXT NOT NULL REFERENCES products(name) ON DELETE CASCADE,
                raw_material_id   INTEGER NOT NULL REFERENCES raw_materials(id) ON DELETE CASCADE,
                quantity_required NUMERIC(12,3) NOT NULL,
                UNIQUE (product_name, raw_material_id)
            )
        """)
        # Tier (hajm bo'yicha) narxlash — product_price_tiers
        cur.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS uq_products_id ON products(id)
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS product_price_tiers (
                id           SERIAL PRIMARY KEY,
                product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                min_quantity NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
                max_quantity NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (max_quantity >= min_quantity),
                price        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
                currency     TEXT NOT NULL DEFAULT 'UZS' CHECK (currency IN ('UZS','USD')),
                created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_ppt_product ON product_price_tiers(product_id)
        """)
        # production_lines — products.line_id FK shu jadvalga ishora qiladi, shuning
        # uchun ALTER'dan OLDIN yaratilishi shart. To'liq ta'rif quyiroqda (per-line
        # payroll bo'limida) IF NOT EXISTS bilan takrorlanadi — bo'sh DB'da tartib
        # muhim (aks holda "relation production_lines does not exist" bilan yiqiladi).
        cur.execute("""
            CREATE TABLE IF NOT EXISTS production_lines (
                id         SERIAL PRIMARY KEY,
                name       TEXT NOT NULL UNIQUE,
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        # line_id — mahsulotni ishlab chiqarish liniyasiga bog'lash (ROLE_BASED_KG uchun)
        cur.execute("""
            ALTER TABLE products
              ADD COLUMN IF NOT EXISTS line_id INTEGER REFERENCES production_lines(id) ON DELETE SET NULL
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS packer_product_assignments (
                id           SERIAL PRIMARY KEY,
                packer_name  TEXT NOT NULL REFERENCES workers(name) ON DELETE CASCADE,
                product_name TEXT NOT NULL REFERENCES products(name) ON DELETE CASCADE,
                UNIQUE (packer_name, product_name)
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS db_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)
        # ── Ombor (zaxira) jadvallari ────────────────────────────────────
        # Bu jadvallar avval faqat ishlab chiqarish DB'sida mavjud edi va hech
        # qaysi sxemada ta'riflanmagan edi. Yangi/bo'sh DB'da Ombor sahifasi
        # ishlashi uchun ularni idempotent yaratamiz.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS warehouses (
                id            SERIAL PRIMARY KEY,
                name          TEXT NOT NULL UNIQUE,
                active        BOOLEAN NOT NULL DEFAULT TRUE,
                location_type TEXT NOT NULL DEFAULT 'general',
                capacity_kg   NUMERIC DEFAULT 20000,
                purpose       TEXT NOT NULL DEFAULT 'finished',
                created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS inventory (
                id           SERIAL PRIMARY KEY,
                warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
                product      TEXT NOT NULL,
                quantity     NUMERIC NOT NULL DEFAULT 0,
                weight_kg    NUMERIC NOT NULL DEFAULT 0,
                product_type TEXT NOT NULL DEFAULT 'finished',
                updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                UNIQUE (warehouse_id, product)
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS stock_movements (
                id                SERIAL PRIMARY KEY,
                product           TEXT NOT NULL,
                quantity          NUMERIC NOT NULL DEFAULT 0,
                movement_type     TEXT NOT NULL,
                from_warehouse_id INTEGER REFERENCES warehouses(id),
                to_warehouse_id   INTEGER REFERENCES warehouses(id),
                note              TEXT NOT NULL DEFAULT '',
                created_by        TEXT NOT NULL DEFAULT '',
                product_type      TEXT NOT NULL DEFAULT 'finished',
                created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        # product_type ustunini mavjud jadvallarga qo'shamiz (jadval bo'lmasa xato emas)
        cur.execute("""
            DO $$ BEGIN
              IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='stock_movements') THEN
                ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'finished';
              END IF;
              IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='warehouses') THEN
                ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS location_type TEXT NOT NULL DEFAULT 'general';
                ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS capacity_kg NUMERIC DEFAULT 20000;
                ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'finished';
                ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW();
              END IF;
              IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='inventory') THEN
                ALTER TABLE inventory ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'finished';
                ALTER TABLE inventory ADD COLUMN IF NOT EXISTS weight_kg NUMERIC NOT NULL DEFAULT 0;
              END IF;
            END $$;
        """)
        # Mavjud inventory satrlari uchun og'irlikni partiya nisbati bo'yicha bir marta
        # to'ldiramiz (kg-mahsulotlar). Bundan keyin har bir harakat og'irlikni o'zi
        # olib yuradi; shu sabab faqat bir marta (db_meta bayrog'i bilan) bajariladi.
        cur.execute("SELECT to_regclass('public.inventory') AS t")
        _inv_exists = cur.fetchone()["t"] is not None
        cur.execute("SELECT value FROM db_meta WHERE key = 'inventory_weight_backfilled'")
        if _inv_exists and cur.fetchone() is None:
            cur.execute("""
                WITH wr AS (
                  SELECT product,
                         CASE WHEN SUM(quantity) > 0
                              THEN SUM(weight_kg)::numeric / SUM(quantity)
                              ELSE 0 END AS kg_per_unit
                  FROM batches GROUP BY product
                )
                UPDATE inventory i
                   SET weight_kg = i.quantity * wr.kg_per_unit
                  FROM wr
                  JOIN products p ON p.name = wr.product
                 WHERE wr.product = i.product
                   AND LOWER(p.unit_type) = 'kg'
                   AND wr.kg_per_unit > 0
            """)
            cur.execute(
                "INSERT INTO db_meta (key, value) VALUES ('inventory_weight_backfilled', '1') ON CONFLICT DO NOTHING"
            )
        # ── Rolga asoslangan kg maosh (Arqon bo'limi) ────────────────────
        cur.execute("""
            ALTER TABLE products
              ADD COLUMN IF NOT EXISTS payroll_method TEXT NOT NULL DEFAULT 'PRODUCT_RATE'
        """)
        # Partiya yaratilgan paytdagi maosh usulini snapshot qilib saqlaymiz, shunda
        # kun yopilganda umumiy kg ishlab chiqaruvchiga to'langan asos bilan mos keladi
        # (mahsulot usuli keyin o'zgartirilsa ham eski partiyalarga ta'sir qilmaydi).
        cur.execute("""
            ALTER TABLE batches
              ADD COLUMN IF NOT EXISTS payroll_method TEXT NOT NULL DEFAULT 'PRODUCT_RATE'
        """)
        # Eski ROLE_BASED_KG→kg cheklovini olib tashlaymiz (dona mahsulotlar ham liniya ishlatishi mumkin)
        cur.execute("""
            ALTER TABLE products DROP CONSTRAINT IF EXISTS products_role_kg_requires_kg
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS payroll_role_rates (
                id         SERIAL PRIMARY KEY,
                scope      TEXT NOT NULL DEFAULT 'arqon',
                role       TEXT NOT NULL,
                rate       NUMERIC(12,2) NOT NULL DEFAULT 0,
                updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                UNIQUE (scope, role)
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS kg_payroll_workers (
                id          SERIAL PRIMARY KEY,
                scope       TEXT NOT NULL DEFAULT 'arqon',
                worker_name TEXT NOT NULL,
                role        TEXT NOT NULL,
                active      BOOLEAN NOT NULL DEFAULT TRUE,
                created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                UNIQUE (scope, worker_name, role)
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS salary_entries (
                id          SERIAL PRIMARY KEY,
                scope       TEXT NOT NULL DEFAULT 'arqon',
                worker      TEXT NOT NULL,
                role        TEXT NOT NULL,
                source_type TEXT NOT NULL,
                batch_id    INTEGER,
                work_date   DATE NOT NULL,
                kg          NUMERIC(12,3) NOT NULL DEFAULT 0,
                rate        NUMERIC(12,2) NOT NULL DEFAULT 0,
                amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
                created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS salary_entries_daily_shared_uniq
              ON salary_entries (scope, worker, role, work_date)
              WHERE source_type = 'daily_shared'
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS daily_payroll_runs (
                id        SERIAL PRIMARY KEY,
                scope     TEXT NOT NULL DEFAULT 'arqon',
                line_id   INTEGER,
                work_date DATE NOT NULL,
                total_kg  NUMERIC(12,3) NOT NULL DEFAULT 0,
                status    TEXT NOT NULL DEFAULT 'closed',
                closed_by TEXT,
                closed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        # ── Ishlab chiqarish liniyalari (per-line payroll) ───────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS production_lines (
                id         SERIAL PRIMARY KEY,
                name       TEXT NOT NULL UNIQUE,
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS production_line_workers (
                id          SERIAL PRIMARY KEY,
                line_id     INTEGER NOT NULL REFERENCES production_lines(id) ON DELETE CASCADE,
                worker_name TEXT NOT NULL,
                role        TEXT NOT NULL,
                created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                UNIQUE (line_id, worker_name, role)
            )
        """)
        # Bir ishlab chiqaruvchi faqat bitta liniyada (partiya->liniya bir ma'noli bo'lsin)
        cur.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS production_line_workers_one_producer_line_uniq
              ON production_line_workers (worker_name)
              WHERE role = 'producer'
        """)
        # Har bir (ishchi, rol) faqat bitta liniyada — kunlik ulush (scope, worker, role,
        # work_date) bo'yicha yagona bo'lib qolishi uchun (ikkita liniyada bir xil rol bo'lmasin)
        cur.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS production_line_workers_worker_role_uniq
              ON production_line_workers (worker_name, role)
        """)
        # Har bir liniya uchun alohida rol konfiguratsiyasi
        cur.execute("""
            CREATE TABLE IF NOT EXISTS line_role_config (
                id          SERIAL PRIMARY KEY,
                line_id     INTEGER NOT NULL REFERENCES production_lines(id) ON DELETE CASCADE,
                role_key    TEXT NOT NULL,
                label       TEXT NOT NULL DEFAULT '',
                rate        NUMERIC(12,2) NOT NULL DEFAULT 0,
                max_workers INTEGER NOT NULL DEFAULT 5,
                UNIQUE (line_id, role_key)
            )
        """)
        cur.execute("""
            ALTER TABLE line_role_config
              ADD COLUMN IF NOT EXISTS pay_mode TEXT NOT NULL DEFAULT 'pooled'
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_line_role_config_line
              ON line_role_config(line_id)
        """)
        # ── Ish jarayoni (Material Flow / WIP) ───────────────────────────────
        # Bo'lim (liniya) WIP zahirasi: RECEIVE (+kg) xom ashyo bo'limga berildi,
        # PRODUCE (-kg) tayyor mahsulot chiqdi (partiya yaratilganda). WIP =
        # SUM(RECEIVE) − SUM(PRODUCE). line_id — oddiy int (FK emas, snapshot).
        cur.execute("""
            CREATE TABLE IF NOT EXISTS wip_movements (
                id                SERIAL PRIMARY KEY,
                line_id           INTEGER NOT NULL,
                movement_type     TEXT NOT NULL,
                raw_material      TEXT,
                product           TEXT,
                weight_kg         NUMERIC(12,3) NOT NULL DEFAULT 0,
                from_warehouse_id INTEGER,
                batch_id          INTEGER,
                note              TEXT NOT NULL DEFAULT '',
                created_by        TEXT NOT NULL DEFAULT 'admin',
                created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_wip_line_created ON wip_movements (line_id, created_at DESC)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_wip_type ON wip_movements (movement_type)")
        # Ishlab chiqaruvchi (producer) rollarini 'individual' deb belgilaymiz:
        # config roli a'zolari standart 'producer' rolini ham tutsa — bu producer roli.
        # Idempotent: producer = individual o'zgarmas qoida (qayta ishga tushishda xavfsiz).
        cur.execute("""
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
        """)
        # Partiya yaratilganda liniya snapshot — kun yopilganda liniya bo'yicha jami kg
        cur.execute("ALTER TABLE batches ADD COLUMN IF NOT EXISTS production_line_id INTEGER")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_batches_line_created ON batches (production_line_id, created_at)")
        cur.execute("ALTER TABLE salary_entries ADD COLUMN IF NOT EXISTS line_id INTEGER")
        cur.execute("ALTER TABLE daily_payroll_runs ADD COLUMN IF NOT EXISTS line_id INTEGER")
        # Eski (scope, work_date) UNIQUE cheklovini olib tashlaymiz — endi (scope, work_date, line_id)
        cur.execute("""
            DO $$
            DECLARE c text;
            BEGIN
              FOR c IN
                SELECT con.conname
                FROM pg_constraint con
                JOIN pg_class rel ON rel.oid = con.conrelid
                JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
                WHERE rel.relname = 'daily_payroll_runs'
                  AND nsp.nspname = 'public'
                  AND con.contype = 'u'
                  AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                       FROM pg_attribute a
                       WHERE a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey))
                      = ARRAY['scope','work_date']
              LOOP
                EXECUTE format('ALTER TABLE public.daily_payroll_runs DROP CONSTRAINT %I', c);
              END LOOP;
            END $$;
        """)
        cur.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS daily_payroll_runs_scope_date_line_uniq
              ON daily_payroll_runs (scope, work_date, line_id)
        """)
        # Standart rol stavkalari (Arqon) — seeded bayrog'idan qat'i nazar idempotent
        for _role, _rate in (("producer", 1125), ("preparation", 375), ("packaging", 750), ("packer", 375)):
            cur.execute(
                "INSERT INTO payroll_role_rates (scope, role, rate) VALUES ('arqon', %s, %s) "
                "ON CONFLICT (scope, role) DO NOTHING",
                (_role, _rate),
            )
        # Eski mahsulot-ruxsat tizimi olib tashlandi — qolgan jadvalni tozalaymiz
        cur.execute("DROP TABLE IF EXISTS worker_product_permissions")
        # Standart liniya — "Arqon Bo'limi" (idempotent)
        cur.execute("INSERT INTO production_lines (name) VALUES ('Arqon Bo''limi') ON CONFLICT (name) DO NOTHING")
        # Birinchi sozlashda: mavjud kg_payroll_workers (tayyorlash/upakovka) ni
        # birinchi liniyaga ko'chiramiz. Faqat liniya ishchilari bo'sh bo'lsa —
        # admin keyin o'chirsa, qayta tiklamaymiz.
        cur.execute("SELECT COUNT(*) AS cnt FROM production_line_workers")
        if (cur.fetchone()["cnt"] or 0) == 0:
            cur.execute("SELECT id FROM production_lines ORDER BY id LIMIT 1")
            _line = cur.fetchone()
            if _line:
                cur.execute(
                    """INSERT INTO production_line_workers (line_id, worker_name, role)
                       SELECT %s, worker_name,
                              CASE WHEN role = 'packer' THEN 'packaging' ELSE role END
                       FROM kg_payroll_workers
                       WHERE scope = 'arqon' AND active = TRUE
                         AND role IN ('preparation', 'packer', 'packaging')
                       ON CONFLICT (line_id, worker_name, role) DO NOTHING""",
                    (_line["id"],),
                )
        _seed(cur)


def _seed(cur) -> None:
    cur.execute("SELECT value FROM db_meta WHERE key = 'seeded'")
    already = cur.fetchone()
    if already:
        return
    for w in SEED_WORKERS:
        cur.execute(
            "INSERT INTO workers (name, prefix, phone, role) VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING",
            (w["name"], w["prefix"], w.get("phone", ""), w.get("role", "worker")),
        )
    for p in SEED_PRODUCTS:
        cur.execute(
            "INSERT INTO products (name, rate_type, rate) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
            (p["name"], p["rate_type"], p["rate"]),
        )
    cur.execute("INSERT INTO db_meta (key, value) VALUES ('seeded', '1') ON CONFLICT DO NOTHING")


# ── Workers & Products ────────────────────────────────────────────────────────

def get_workers() -> dict[str, str]:
    with get_conn() as (conn, cur):
        cur.execute("SELECT name, prefix FROM workers WHERE role = 'worker' ORDER BY name")
        rows = cur.fetchall()
    return {r["name"]: r["prefix"] for r in rows}


def get_all_workers_config() -> list[dict]:
    with get_conn() as (conn, cur):
        cur.execute("SELECT * FROM workers ORDER BY role, name")
        return cur.fetchall()


def get_products() -> list[tuple[str, str, float]]:
    with get_conn() as (conn, cur):
        cur.execute("SELECT name, rate_type, rate FROM products WHERE active=TRUE ORDER BY name")
        rows = cur.fetchall()
    return [(r["name"], r["rate_type"], float(r["rate"])) for r in rows]


def get_product_names() -> list[str]:
    with get_conn() as (conn, cur):
        cur.execute("SELECT name FROM products WHERE active=TRUE ORDER BY name")
        return [r["name"] for r in cur.fetchall()]


def get_product_weight(name: str) -> float:
    """Mahsulotning profilda ko'rsatilgan 1 dona og'irligi (kg). Topilmasa 1.0."""
    with get_conn() as (conn, cur):
        cur.execute("SELECT weight FROM products WHERE name=%s", (name,))
        row = cur.fetchone()
    if row and row["weight"] is not None:
        return float(row["weight"])
    return 1.0


def get_product_pieces_per_box(name: str) -> int:
    """Mahsulotning qutisidagi dona soni. Topilmasa 1."""
    with get_conn() as (conn, cur):
        cur.execute("SELECT pieces_per_box FROM products WHERE name=%s", (name,))
        row = cur.fetchone()
    if row and row["pieces_per_box"] and int(row["pieces_per_box"]) > 1:
        return int(row["pieces_per_box"])
    return 1


# ── Rolga asoslangan kg maosh (Arqon) ────────────────────────────────────────

def get_product_method(name: str) -> str:
    with get_conn() as (conn, cur):
        cur.execute("SELECT payroll_method FROM products WHERE name=%s", (name,))
        row = cur.fetchone()
    return row["payroll_method"] if row and row["payroll_method"] else "PRODUCT_RATE"


def get_role_rate(role: str, scope: str = "arqon") -> float:
    with get_conn() as (conn, cur):
        cur.execute(
            "SELECT rate FROM payroll_role_rates WHERE scope=%s AND role=%s",
            (scope, role),
        )
        row = cur.fetchone()
    return float(row["rate"]) if row else 0.0


def get_worker_line_role_rate(worker_name: str, product_name: str) -> tuple:
    """Ishchining liniya roli va stavkasini line_role_config'dan qaytaradi.
    Topilmasa payroll_role_rates global stavkasiga fallback."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT plw.role,
                      COALESCE(lrc.rate, prr.rate, 0) AS rate
               FROM products p
               JOIN production_line_workers plw
                 ON plw.line_id = p.line_id AND plw.worker_name = %s
               LEFT JOIN line_role_config lrc
                 ON lrc.line_id = p.line_id AND lrc.role_key = plw.role
               LEFT JOIN payroll_role_rates prr
                 ON prr.scope = 'arqon' AND prr.role = plw.role
               WHERE p.name = %s
               LIMIT 1""",
            (worker_name, product_name),
        )
        row = cur.fetchone()
    if row:
        return row["role"], float(row["rate"])
    return None, 0.0


def product_line_is_config(product_name: str) -> bool:
    """Mahsulot liniyasida line_role_config bormi (config liniyami)? Legacy
    (config'siz) liniyalardan ajratish uchun — ROLE_BASED_KG ko'rsatuv summasi."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT 1 FROM products p
               JOIN line_role_config lrc ON lrc.line_id = p.line_id
               WHERE p.name = %s LIMIT 1""",
            (product_name,),
        )
        return cur.fetchone() is not None


def get_line_staffed_role_rate_sum(product_name: str) -> float:
    """Config liniyada ≥1 ishchisi bor rollar stavkalari yig'indisi.

    Kun yopilganda har bir birlik (dona/kg) uchun jami shu summa to'lanadi:
    har rol uchun birlik×stavka hisoblanadi va rol ishchilariga teng bo'linadi
    (yig'indida ÷ishchilar soni qisqaradi). Ishchisiz rol to'lanmaydi, shu bois
    yig'indiga kirmaydi. Partiya tasdig'idagi "Jami haq" shu funksiyaga tayanadi
    va kun yopilishi natijasiga mos keladi."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT COALESCE(SUM(lrc.rate), 0) AS s
               FROM products p
               JOIN line_role_config lrc ON lrc.line_id = p.line_id
               WHERE p.name = %s
                 AND EXISTS (
                     SELECT 1 FROM production_line_workers w
                     WHERE w.line_id = lrc.line_id AND w.role = lrc.role_key
                 )""",
            (product_name,),
        )
        row = cur.fetchone()
    return float(row["s"]) if row else 0.0


def get_worker_production_role(worker_name: str, product_name: str) -> str | None:
    """Ishchining mahsulot liniyasidagi rolini qaytaradi (producer/packaging/preparation).
    Topilmasa None qaytaradi."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT plw.role FROM production_line_workers plw
               JOIN products p ON p.line_id = plw.line_id
               WHERE plw.worker_name = %s AND p.name = %s
               LIMIT 1""",
            (worker_name, product_name),
        )
        row = cur.fetchone()
    return row["role"] if row else None


def get_line_role_rate_strict(worker_name: str, product_name: str) -> tuple:
    """Ishchining roli + stavkasini FAQAT line_role_config'dan qaytaradi (global
    fallback YO'Q). Mahsulot liniyasida (products.line_id) shu rol uchun config
    bo'lmasa (None, 0.0). Config liniyalarni legacy'dan ajratish uchun."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT plw.role, lrc.rate
               FROM products p
               JOIN production_line_workers plw
                 ON plw.line_id = p.line_id AND plw.worker_name = %s
               JOIN line_role_config lrc
                 ON lrc.line_id = p.line_id AND lrc.role_key = plw.role
               WHERE p.name = %s
               ORDER BY lrc.rate DESC
               LIMIT 1""",
            (worker_name, product_name),
        )
        row = cur.fetchone()
    if row:
        return row["role"], float(row["rate"])
    return None, 0.0


def close_day(closed_by: str, scope: str = "arqon") -> dict:
    """Kunni yopadi — har bir ishlab chiqarish liniyasi uchun alohida (idempotent).

    Har liniya uchun bugungi ROLE_BASED_KG partiyalar jami kg (liniya snapshot
    bo'yicha) hisoblanadi; tayyorlash va upakovka POOL'lari liniyadagi shu roldagi
    xodimlar soniga BO'LINADI:
        tayyorlash:  (jami_kg × stavka) ÷ tayyorlovchilar_soni
        upakovka:    (jami_kg × stavka) ÷ upakovkachilar_soni
    Ishlab chiqaruvchilar har partiyada darhol to'lanadi (bu yerda qayta yozilmaydi).
    Sana Asia/Tashkent. Liniya bo'yicha kun yopilgach yozuvlar MUZLATILADI: qayta
    chaqirilsa snapshot o'zgarmaydi va xodimlar qayta xabardor qilinmaydi.

    Returns: {
        "work_date", "total_kg", "already_closed",
        "lines": [{"line_id","line_name","total_kg","already_closed",
                   "entries":[{worker,role,rate,amount}]}],
        "new_entries": [{line_id,line_name,worker,role,rate,amount}],  # xabar uchun
    }
    """
    with get_conn() as (conn, cur):
        cur.execute("SELECT (NOW() AT TIME ZONE 'Asia/Tashkent')::date AS d")
        work_date = cur.fetchone()["d"]

        cur.execute("SELECT role, rate FROM payroll_role_rates WHERE scope=%s", (scope,))
        rates = {r["role"]: float(r["rate"]) for r in cur.fetchall()}

        cur.execute("SELECT id, name FROM production_lines ORDER BY id")
        lines = cur.fetchall()

        result_lines: list[dict] = []
        new_entries: list[dict] = []
        grand_total = 0.0

        for ln in lines:
            line_id = ln["id"]
            line_name = ln["name"]

            # Liniya bo'yicha bir vaqtda ikki yopishni ketma-ket qilamiz
            cur.execute(
                "SELECT pg_advisory_xact_lock(hashtext(%s))",
                (f"close_day:{scope}:{line_id}:{work_date}",),
            )

            cur.execute(
                "SELECT total_kg FROM daily_payroll_runs WHERE scope=%s AND line_id=%s AND work_date=%s",
                (scope, line_id, work_date),
            )
            existing = cur.fetchone()

            # ── Liniya avval yopilgan — muzlatilgan snapshot'ni qaytaramiz ──
            if existing is not None:
                cur.execute(
                    """SELECT worker, role, rate, amount FROM salary_entries
                       WHERE scope=%s AND line_id=%s AND work_date=%s AND source_type='daily_shared'
                       ORDER BY role, worker""",
                    (scope, line_id, work_date),
                )
                entries = [
                    {"worker": r["worker"], "role": r["role"],
                     "rate": float(r["rate"]), "amount": float(r["amount"])}
                    for r in cur.fetchall()
                ]
                result_lines.append({
                    "line_id": line_id, "line_name": line_name,
                    "total_kg": float(existing["total_kg"]),
                    "already_closed": True, "entries": entries,
                })
                grand_total += float(existing["total_kg"])
                continue

            # ── Birinchi yopilish — liniya bo'yicha bugungi jami ish birligi ──
            # kg mahsulot → weight_kg; dona mahsulot → quantity. Liniya
            # products.line_id orqali aniqlanadi (snapshot production_line_id ustun).
            cur.execute(
                """SELECT COALESCE(
                            SUM(CASE WHEN p.rate_type='kg' THEN b.weight_kg ELSE b.quantity END), 0
                          ) AS total_units
                   FROM batches b
                   JOIN products p ON p.name = b.product
                   WHERE b.payroll_method = 'ROLE_BASED_KG'
                     AND COALESCE(b.production_line_id, p.line_id) = %s
                     AND (b.created_at AT TIME ZONE 'Asia/Tashkent')::date = %s""",
                (line_id, work_date),
            )
            total_kg = float(cur.fetchone()["total_units"])
            grand_total += total_kg

            # Config liniya → barcha sozlangan rollar (producer ham) shu yerda
            # to'lanadi. Config bo'lmasa (legacy) → producer partiyada to'langan;
            # bu yerda tayyorlash/upakovka POOL'lari global stavkada bo'linadi.
            cur.execute(
                "SELECT role_key, rate, pay_mode FROM line_role_config WHERE line_id=%s",
                (line_id,),
            )
            cfg_rows = cur.fetchall()
            if cfg_rows:
                pay_roles = {r["role_key"]: float(r["rate"]) for r in cfg_rows}
                pay_modes = {r["role_key"]: (r["pay_mode"] or "pooled") for r in cfg_rows}
            else:
                pay_roles = {
                    "preparation": rates.get("preparation", 0.0),
                    "packaging":   rates.get("packaging", 0.0),
                }
                pay_modes = {"preparation": "pooled", "packaging": "pooled"}

            # Har bir ishchining shu liniyadagi BUGUNGI shaxsiy ishlab chiqarishi
            # (individual to'lov uchun: own_kg × rate)
            cur.execute(
                """SELECT b.worker AS worker,
                          COALESCE(SUM(CASE WHEN p.rate_type='kg' THEN b.weight_kg ELSE b.quantity END), 0) AS kg
                   FROM batches b
                   JOIN products p ON p.name = b.product
                   WHERE b.payroll_method = 'ROLE_BASED_KG'
                     AND COALESCE(b.production_line_id, p.line_id) = %s
                     AND (b.created_at AT TIME ZONE 'Asia/Tashkent')::date = %s
                   GROUP BY b.worker""",
                (line_id, work_date),
            )
            own_kg_by_worker: dict[str, float] = {}
            for r in cur.fetchall():
                if r["worker"]:
                    own_kg_by_worker[r["worker"]] = float(r["kg"])

            cur.execute(
                """SELECT worker_name, role FROM production_line_workers
                   WHERE line_id=%s AND role = ANY(%s)
                   ORDER BY role, worker_name""",
                (line_id, list(pay_roles.keys())),
            )
            members = cur.fetchall()
            counts: dict[str, int] = {}
            for m in members:
                counts[m["role"]] = counts.get(m["role"], 0) + 1

            entries = []
            for m in members:
                role = m["role"]
                rate = pay_roles.get(role, rates.get(role, 0.0))
                is_individual = pay_modes.get(role) == "individual"
                if is_individual:
                    kg = own_kg_by_worker.get(m["worker_name"], 0.0)
                    amount = kg * rate
                else:
                    kg = total_kg
                    n = counts.get(role, 0)
                    amount = (total_kg * rate) / n if n > 0 else 0.0
                cur.execute(
                    """INSERT INTO salary_entries
                           (scope, line_id, worker, role, source_type, work_date, kg, rate, amount)
                       VALUES (%s,%s,%s,%s,'daily_shared',%s,%s,%s,%s)
                       ON CONFLICT (scope, worker, role, work_date) WHERE source_type='daily_shared'
                       DO NOTHING""",
                    (scope, line_id, m["worker_name"], role, work_date, kg, rate, amount),
                )
                entries.append({"worker": m["worker_name"], "role": role, "rate": rate, "amount": amount})
                new_entries.append({
                    "line_id": line_id, "line_name": line_name,
                    "worker": m["worker_name"], "role": role, "rate": rate, "amount": amount,
                })

            cur.execute(
                """INSERT INTO daily_payroll_runs (scope, line_id, work_date, total_kg, status, closed_by)
                   VALUES (%s,%s,%s,%s,'closed',%s)
                   ON CONFLICT (scope, work_date, line_id) DO NOTHING""",
                (scope, line_id, work_date, total_kg, closed_by),
            )

            result_lines.append({
                "line_id": line_id, "line_name": line_name,
                "total_kg": total_kg, "already_closed": False, "entries": entries,
            })

    already_closed = all(l["already_closed"] for l in result_lines) if result_lines else True
    return {
        "work_date": work_date,
        "total_kg": grand_total,
        "already_closed": already_closed,
        "lines": result_lines,
        "new_entries": new_entries,
    }


def add_worker(name: str, prefix: str, phone: str, role: str = "worker") -> bool:
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                "INSERT INTO workers (name, prefix, phone, role) VALUES (%s,%s,%s,%s)",
                (name, prefix, phone, role),
            )
            return cur.rowcount > 0
    except psycopg2.IntegrityError:
        return False


def add_product(name: str, rate_type: str, rate: float) -> bool:
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                "INSERT INTO products (name, rate_type, rate) VALUES (%s,%s,%s)",
                (name, rate_type, rate),
            )
            return cur.rowcount > 0
    except psycopg2.IntegrityError:
        return False


def delete_worker(name: str) -> None:
    with get_conn() as (conn, cur):
        cur.execute("DELETE FROM workers WHERE name = %s", (name,))


def delete_product(name: str) -> None:
    with get_conn() as (conn, cur):
        cur.execute("DELETE FROM products WHERE name = %s", (name,))


# ── User roles ────────────────────────────────────────────────────────────────

def get_user_role(chat_id: int) -> dict | None:
    with get_conn() as (conn, cur):
        cur.execute("SELECT * FROM user_roles WHERE chat_id = %s", (chat_id,))
        return cur.fetchone()


def set_user_role(chat_id: int, worker_name: str, role: str) -> None:
    with get_conn() as (conn, cur):
        cur.execute(
            """INSERT INTO user_roles (chat_id, worker_name, role) VALUES (%s,%s,%s)
               ON CONFLICT (chat_id) DO UPDATE SET worker_name = EXCLUDED.worker_name, role = EXCLUDED.role""",
            (chat_id, worker_name, role),
        )


def get_admin_count() -> int:
    with get_conn() as (conn, cur):
        cur.execute("SELECT COUNT(*) AS cnt FROM user_roles WHERE role = 'admin'")
        return cur.fetchone()["cnt"]


def find_user_by_phone(phone: str) -> dict | None:
    with get_conn() as (conn, cur):
        cur.execute("SELECT * FROM workers WHERE phone = %s", (phone,))
        return cur.fetchone()


# ── Packer assignments ────────────────────────────────────────────────────────

def assign_packer_workers(packer_chat_id: int, worker_names: list[str]) -> None:
    with get_conn() as (conn, cur):
        cur.execute("DELETE FROM packer_assignments WHERE packer_chat_id = %s", (packer_chat_id,))
        for w in worker_names:
            cur.execute(
                "INSERT INTO packer_assignments (packer_chat_id, worker_name) VALUES (%s,%s)",
                (packer_chat_id, w),
            )


def get_packer_workers(packer_chat_id: int) -> list[str]:
    with get_conn() as (conn, cur):
        cur.execute(
            "SELECT worker_name FROM packer_assignments WHERE packer_chat_id = %s",
            (packer_chat_id,),
        )
        return [r["worker_name"] for r in cur.fetchall()]


def get_registered_packers() -> list[dict]:
    with get_conn() as (conn, cur):
        cur.execute("SELECT * FROM user_roles WHERE role = 'packer'")
        return cur.fetchall()


# ── Batches ───────────────────────────────────────────────────────────────────

def next_batch_code(worker_prefix: str) -> str:
    today = date.today().strftime("%y%m%d")
    prefix = f"{worker_prefix}-{today}-"
    with get_conn() as (conn, cur):
        cur.execute(
            "SELECT COUNT(DISTINCT batch_code) AS cnt FROM batches WHERE batch_code LIKE %s",
            (f"{prefix}%",),
        )
        seq = (cur.fetchone()["cnt"] or 0) + 1
    return f"{prefix}{seq:02d}"


def create_batch_session(
    worker: str, prefix: str, items: list[dict], warehouse_id: int | None = None
) -> dict:
    """Bitta sessiya = bitta batch_code ostida bir nechta mahsulot (batch items).

    Hammasi BITTA tranzaksiyada bajariladi: bitta kod generatsiya qilinadi, har bir
    mahsulot uchun alohida qator (batch item) yoziladi, tayyor mahsulot omborga
    kiritiladi va BOM bo'yicha xom ashyo zahirasi kamaytiriladi. Biror item xatosi
    bo'lsa, butun sessiya bekor qilinadi (yarim partiya qolmaydi).

    items: [{"product", "quantity", "weight_kg", "earnings"}]
    warehouse_id: tayyor mahsulot qaysi konteynerga tushishini belgilaydi.
                  None bo'lsa birinchi faol ombor tanlanadi (orqaga mos).
    Returns: {"batch_code", "total_earnings", "low_materials"}
      low_materials — minimal zahiradan kam qolgan xom ashyolar (nom bo'yicha dedup).
    """
    today = date.today().strftime("%y%m%d")
    code_prefix = f"{prefix}-{today}-"
    low_by_name: dict[str, dict] = {}
    total_earnings = 0.0

    with get_conn() as (conn, cur):
        # Bir vaqtning o'zida ikki sessiya bir xil kod olmasligi uchun tranzaksiya-lock
        # (kod generatsiyasini ketma-ket qiladi; tranzaksiya tugashi bilan ozod bo'ladi).
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (code_prefix,))
        # Sessiya kodini tranzaksiya ichida generatsiya qilamiz (atomar)
        cur.execute(
            "SELECT COUNT(DISTINCT batch_code) AS cnt FROM batches WHERE batch_code LIKE %s",
            (f"{code_prefix}%",),
        )
        seq = (cur.fetchone()["cnt"] or 0) + 1
        batch_code = f"{code_prefix}{seq:02d}"

        # Tayyor mahsulot uchun ombor: berilgan konteyner yoki birinchi faol ombor
        if warehouse_id:
            cur.execute("SELECT id FROM warehouses WHERE id=%s AND active=TRUE", (warehouse_id,))
            wh = cur.fetchone()
            wh_id = wh["id"] if wh else None
        else:
            cur.execute("SELECT id FROM warehouses WHERE active=TRUE ORDER BY id LIMIT 1")
            wh = cur.fetchone()
            wh_id = wh["id"] if wh else None

        # Ishlab chiqaruvchining liniyasi — mahsulotda line_id bo'lmasa fallback.
        cur.execute(
            "SELECT line_id FROM production_line_workers WHERE worker_name=%s AND role='producer' LIMIT 1",
            (worker,),
        )
        _lrow = cur.fetchone()
        producer_line_id = _lrow["line_id"] if _lrow else None

        line_entries: list[dict] = []  # Xabarnoma uchun: [{worker, role, amount}]

        # WIP balans himoyasi: har bir liniya uchun bir marta qulf olamiz va
        # qolgan balansni sessiya davomida kuzatamiz (bir nechta mahsulot bir
        # liniyada bo'lishi mumkin).
        locked_line_balance: dict[int, float] = {}

        for it in items:
            product   = it["product"]
            quantity  = int(it["quantity"])
            weight_kg = float(it.get("weight_kg") or 0.0)
            earnings  = float(it.get("earnings") or 0.0)
            total_earnings += earnings

            # Maosh usulini partiya yaratilgan paytda snapshot qilamiz.
            method = it.get("payroll_method")
            if not method:
                cur.execute("SELECT payroll_method FROM products WHERE name=%s", (product,))
                _prow = cur.fetchone()
                method = (_prow["payroll_method"] if _prow and _prow["payroll_method"] else "PRODUCT_RATE")

            # Liniyani mahsulot orqali aniqlaymiz (config liniya attribusiyasi);
            # mahsulotda line_id bo'lmasa ishlab chiqaruvchi liniyasiga qaytamiz.
            cur.execute("SELECT line_id, weight FROM products WHERE name=%s", (product,))
            _plrow = cur.fetchone()
            prod_line_id = (_plrow["line_id"] if _plrow and _plrow["line_id"] else None) or producer_line_id
            product_weight = float(_plrow["weight"]) if _plrow and _plrow.get("weight") is not None else 0.0

            # Config liniyami? (line_role_config mavjud). Bunday liniyada ROLE_BASED_KG
            # maoshi kun yopilganda rol bo'yicha hisoblanadi — shu bois partiya
            # earnings = 0 (ikki marta to'lovning oldini olamiz).
            is_config_line = False
            if prod_line_id:
                cur.execute("SELECT 1 FROM line_role_config WHERE line_id=%s LIMIT 1", (prod_line_id,))
                is_config_line = cur.fetchone() is not None
            batch_earnings = 0.0 if (method == "ROLE_BASED_KG" and is_config_line) else earnings

            cur.execute(
                """INSERT INTO batches (batch_code, worker, product, quantity, weight_kg, earnings, payroll_method, production_line_id)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                (batch_code, worker, product, quantity, weight_kg, batch_earnings, method, prod_line_id),
            )

            # Tayyor mahsulotni faol omborga "Kirim" qilib yozamiz
            if wh_id:
                cur.execute(
                    """INSERT INTO stock_movements
                         (product, quantity, movement_type, from_warehouse_id, to_warehouse_id,
                          note, created_by, product_type)
                       VALUES (%s,%s,'IN',NULL,%s,%s,%s,'finished')""",
                    (product, quantity, wh_id, f"Partiya: {batch_code}", worker),
                )
                cur.execute(
                    """INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type, updated_at)
                       VALUES (%s,%s,%s,%s,'finished',NOW())
                       ON CONFLICT (warehouse_id, product)
                       DO UPDATE SET quantity=inventory.quantity+%s,
                                     weight_kg=inventory.weight_kg+%s,
                                     updated_at=NOW()""",
                    (wh_id, product, quantity, weight_kg, quantity, weight_kg),
                )

            # Ish jarayoni (WIP) — bo'lim tayyor mahsulot chiqardi: PRODUCE (-kg).
            # Ishlab chiqarilgan og'irlik: aniq weight_kg bo'lsa o'shani, aks holda
            # dona × dona-og'irligi (products.weight). Faqat liniya aniqlangan bo'lsa.
            if prod_line_id:
                produce_kg = weight_kg if weight_kg > 0 else quantity * product_weight
                if produce_kg > 0:
                    # WIP balans himoyasi — API /ombor/flow/produce bilan bir xil.
                    # Liniyani birinchi marta lock qilamiz va balansni olamiz;
                    # keyingi mahsulotlar uchun allaqachon lock qilingan balansdan
                    # ayirib boramiz (bir sessiya = bitta tranzaksiya).
                    if prod_line_id not in locked_line_balance:
                        cur.execute(
                            "SELECT id FROM production_lines WHERE id=%s FOR UPDATE",
                            (prod_line_id,),
                        )
                        cur.execute(
                            """SELECT COALESCE(SUM(
                                   CASE WHEN movement_type='RECEIVE' THEN weight_kg
                                        WHEN movement_type='PRODUCE' THEN -weight_kg
                                        ELSE 0 END
                               ), 0)::numeric AS wip_kg
                               FROM wip_movements WHERE line_id=%s""",
                            (prod_line_id,),
                        )
                        locked_line_balance[prod_line_id] = float(cur.fetchone()["wip_kg"] or 0)

                    available = locked_line_balance[prod_line_id]
                    if produce_kg > available + 1e-9:
                        raise WipBalanceError(
                            f"Bo'limda yetarli xom ashyo yo'q: mavjud {available:.2f} kg, "
                            f"so'ralgan {produce_kg:.2f} kg ({product}). "
                            f"Avval bo'limga xom ashyo bering."
                        )
                    # Balansni real yozuv kiritilmasdan avval kamaytirish — keyingi
                    # mahsulotlar uchun ham to'g'ri chegirmani ta'minlaydi.
                    locked_line_balance[prod_line_id] = available - produce_kg

                    cur.execute(
                        """INSERT INTO wip_movements
                             (line_id, movement_type, product, weight_kg, note, created_by)
                           VALUES (%s,'PRODUCE',%s,%s,%s,%s)""",
                        (prod_line_id, product, produce_kg, f"Partiya: {batch_code}", worker),
                    )

            # Xom ashyo zahirasini BOM (product_materials) bo'yicha kamaytirish
            cur.execute(
                """SELECT pm.raw_material_id, pm.quantity_required,
                          rm.name, rm.unit, rm.minimum_stock
                   FROM product_materials pm
                   JOIN raw_materials rm ON rm.id = pm.raw_material_id
                   WHERE pm.product_name = %s""",
                (product,),
            )
            for req in cur.fetchall():
                consumed = float(req["quantity_required"]) * quantity
                cur.execute(
                    """UPDATE raw_materials
                       SET current_stock = current_stock - %s
                       WHERE id = %s
                       RETURNING current_stock""",
                    (consumed, req["raw_material_id"]),
                )
                updated = cur.fetchone()
                new_stock = float(updated["current_stock"]) if updated else 0.0
                # Sarflangan xom ashyoni harakatlar tarixiga yozamiz (OUT, raw) —
                # shu tranzaksiya ichida, current_stock kamayishi bilan birga.
                if consumed > 0:
                    cur.execute(
                        """INSERT INTO stock_movements
                             (product, quantity, movement_type, from_warehouse_id,
                              to_warehouse_id, note, created_by, product_type)
                           VALUES (%s,%s,'OUT',NULL,NULL,%s,%s,'raw')""",
                        (req["name"], consumed,
                         f"Ishlab chiqarish: {batch_code} ({product} × {quantity})",
                         worker),
                    )
                min_stock = float(req["minimum_stock"] or 0)
                if min_stock > 0 and new_stock <= min_stock:
                    low_by_name[req["name"]] = {
                        "name":          req["name"],
                        "current_stock": new_stock,
                        "minimum_stock": min_stock,
                        "unit":          req["unit"] or "",
                    }

    return {
        "batch_code":    batch_code,
        "total_earnings": total_earnings,
        "low_materials": list(low_by_name.values()),
        "line_entries":  line_entries,
    }


def get_today_batches(worker_filter: list[str] | None = None) -> list[dict]:
    with get_conn() as (conn, cur):
        if worker_filter:
            placeholders = ",".join(["%s"] * len(worker_filter))
            cur.execute(
                f"""SELECT b.batch_code, b.worker, b.product, b.quantity,
                           b.weight_kg, b.earnings, b.created_at,
                           COALESCE(p.pieces_per_box, 1) AS pieces_per_box
                    FROM batches b
                    LEFT JOIN products p ON p.name = b.product
                    WHERE b.created_at::date = CURRENT_DATE
                      AND b.worker IN ({placeholders})
                    ORDER BY b.id""",
                worker_filter,
            )
        else:
            cur.execute(
                """SELECT b.batch_code, b.worker, b.product, b.quantity,
                          b.weight_kg, b.earnings, b.created_at,
                          COALESCE(p.pieces_per_box, 1) AS pieces_per_box
                   FROM batches b
                   LEFT JOIN products p ON p.name = b.product
                   WHERE b.created_at::date = CURRENT_DATE
                   ORDER BY b.id"""
            )
        return cur.fetchall()


def set_product_pieces_per_box(name: str, pieces_per_box: int) -> bool:
    """Mahsulot uchun qutidagi dona sonini o'rnatadi."""
    if pieces_per_box < 1:
        pieces_per_box = 1
    with get_conn() as (conn, cur):
        cur.execute(
            "UPDATE products SET pieces_per_box=%s WHERE name=%s",
            (pieces_per_box, name),
        )
        return (cur.rowcount or 0) > 0


def get_monthly_kpi(year: int, month: int) -> list[dict]:
    period = f"{year}-{month:02d}"
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT worker, SUM(quantity) AS total_qty, SUM(weight_kg) AS total_kg,
                      SUM(earnings) AS total_earnings, COUNT(DISTINCT batch_code) AS batch_count
               FROM batches WHERE TO_CHAR(created_at, 'YYYY-MM') = %s
               GROUP BY worker ORDER BY total_earnings DESC""",
            (period,),
        )
        return cur.fetchall()


def get_worker_monthly(worker: str, year: int, month: int) -> list[dict]:
    period = f"{year}-{month:02d}"
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT product, SUM(quantity) AS total_qty, SUM(weight_kg) AS total_kg,
                      SUM(earnings) AS total_earnings
               FROM batches WHERE worker = %s AND TO_CHAR(created_at, 'YYYY-MM') = %s
               GROUP BY product ORDER BY total_earnings DESC""",
            (worker, period),
        )
        return cur.fetchall()


# ── Pending users ─────────────────────────────────────────────────────────────

def save_pending_user(chat_id: int, name: str, phone: str) -> None:
    with get_conn() as (conn, cur):
        cur.execute(
            """INSERT INTO pending_users (chat_id, name, phone) VALUES (%s,%s,%s)
               ON CONFLICT (chat_id) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone""",
            (chat_id, name, phone),
        )


def get_pending_user(chat_id: int) -> dict | None:
    with get_conn() as (conn, cur):
        cur.execute("SELECT * FROM pending_users WHERE chat_id = %s", (chat_id,))
        return cur.fetchone()


def delete_pending_user(chat_id: int) -> None:
    with get_conn() as (conn, cur):
        cur.execute("DELETE FROM pending_users WHERE chat_id = %s", (chat_id,))


# ── Salary payments ───────────────────────────────────────────────────────────

def get_monthly_salary_report(year: int, month: int) -> list[dict]:
    period = f"{year}-{month:02d}"
    with get_conn() as (conn, cur):
        cur.execute("SELECT name FROM workers WHERE role = 'worker' ORDER BY name")
        workers = cur.fetchall()
        result = []
        for w in workers:
            name = w["name"]
            cur.execute(
                """SELECT product, SUM(quantity) AS qty, SUM(weight_kg) AS kg,
                          SUM(earnings) AS earnings
                   FROM batches
                   WHERE worker = %s AND TO_CHAR(created_at, 'YYYY-MM') = %s
                   GROUP BY product""",
                (name, period),
            )
            rows = cur.fetchall()
            if not rows:
                continue
            total_earnings = sum(float(r["earnings"]) for r in rows)
            products = [
                {"name": r["product"], "qty": r["qty"], "kg": float(r["kg"]),
                 "earnings": float(r["earnings"])}
                for r in rows
            ]
            cur.execute(
                "SELECT paid_at FROM salary_payments WHERE worker = %s AND year = %s AND month = %s",
                (name, year, month),
            )
            pay_row = cur.fetchone()
            result.append({
                "worker": name,
                "total_earnings": total_earnings,
                "products": products,
                "is_paid": pay_row is not None,
                "paid_at": pay_row["paid_at"] if pay_row else None,
            })
    return result


def mark_salary_paid(worker_name: str, year: int, month: int, amount: float) -> None:
    with get_conn() as (conn, cur):
        cur.execute(
            """INSERT INTO salary_payments (worker, year, month, amount) VALUES (%s,%s,%s,%s)
               ON CONFLICT (worker, year, month) DO UPDATE SET amount = EXCLUDED.amount, paid_at = NOW()""",
            (worker_name, year, month, amount),
        )


def get_worker_payment_history(worker_name: str, limit: int = 6) -> list[dict]:
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT year, month, amount, paid_at FROM salary_payments
               WHERE worker = %s
               ORDER BY year DESC, month DESC
               LIMIT %s""",
            (worker_name, limit),
        )
        return cur.fetchall()


def clear_test_data() -> dict:
    with get_conn() as (conn, cur):
        cur.execute("SELECT COUNT(*) AS cnt FROM batches")
        batches = cur.fetchone()["cnt"]
        cur.execute("SELECT COUNT(*) AS cnt FROM pending_users")
        pending = cur.fetchone()["cnt"]
        cur.execute("DELETE FROM batches")
        cur.execute("DELETE FROM pending_users")
        cur.execute("DELETE FROM salary_payments")
    return {"batches": batches, "pending": pending}


# Legacy compat
def register_worker_chat(worker_name: str, chat_id: int) -> None:
    with get_conn() as (conn, cur):
        cur.execute("SELECT role FROM workers WHERE name = %s", (worker_name,))
        wc = cur.fetchone()
        role = wc["role"] if wc else "worker"
    set_user_role(chat_id, worker_name, role)


def get_worker_chat_id(worker_name: str) -> int | None:
    with get_conn() as (conn, cur):
        cur.execute(
            "SELECT chat_id FROM user_roles WHERE worker_name = %s", (worker_name,)
        )
        row = cur.fetchone()
    return row["chat_id"] if row else None


# ── Customers ─────────────────────────────────────────────────────────────────

def get_customers() -> list[dict]:
    with get_conn() as (conn, cur):
        cur.execute("SELECT id, name, phone, company FROM customers ORDER BY name")
        return cur.fetchall()


def add_customer(name: str, phone: str = "", company: str = "") -> int:
    with get_conn() as (conn, cur):
        cur.execute(
            "INSERT INTO customers (name, phone, company) VALUES (%s,%s,%s) RETURNING id",
            (name, phone, company),
        )
        return cur.fetchone()["id"]


# ── Sales ─────────────────────────────────────────────────────────────────────

def create_sale(
    customer_id: int,
    customer_name: str,
    product: str,
    quantity: int,
    weight_kg: float,
    unit_price: float,
    total_amount: float,
    currency: str = "uzs",
    note: str = "",
) -> int:
    with get_conn() as (conn, cur):
        cur.execute(
            """INSERT INTO sales
               (customer_id, customer_name, product, quantity, weight_kg,
                unit_price, total_amount, currency, status, note)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'pending',%s)
               RETURNING id""",
            (customer_id, customer_name, product, quantity,
             weight_kg, unit_price, total_amount, currency, note),
        )
        return cur.fetchone()["id"]


def get_recent_sales(limit: int = 10) -> list[dict]:
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT s.id, s.customer_name, s.product, s.quantity, s.weight_kg,
                      s.unit_price, s.total_amount, s.currency, s.status, s.created_at
               FROM sales s
               ORDER BY s.id DESC
               LIMIT %s""",
            (limit,),
        )
        return cur.fetchall()


def get_product_rate_type(product_name: str) -> str:
    with get_conn() as (conn, cur):
        cur.execute("SELECT rate_type FROM products WHERE name = %s", (product_name,))
        row = cur.fetchone()
    return row["rate_type"] if row else "dona"


# ── Sale products (sotuv uchun alohida tovar ro'yxati) ────────────────────────

def get_sale_products() -> list[dict]:
    """V3: unified products jadvalidan o'qiydi (default_sale_price, currency_type, unit_type)."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT id, name,
                      unit_type        AS unit,
                      default_sale_price AS default_price,
                      currency_type    AS currency
               FROM products WHERE active = TRUE ORDER BY name"""
        )
        return cur.fetchall()


def get_sale_product_by_id(prod_id: int) -> dict | None:
    """V3: unified products jadvalidan id bo'yicha."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT id, name,
                      unit_type        AS unit,
                      default_sale_price AS default_price,
                      currency_type    AS currency
               FROM products WHERE id = %s AND active = TRUE""",
            (prod_id,),
        )
        return cur.fetchone()


def get_price_for_qty(product_id: int, qty: float) -> tuple[float, str]:
    """V3: hajm bo'yicha mos bosqichni (product_price_tiers, min<=qty<=max) tanlaydi;
    mos bosqich bo'lmasa products.default_sale_price / currency_type qaytaradi."""
    with get_conn() as (conn, cur):
        if qty and qty > 0:
            cur.execute(
                """SELECT price, currency FROM product_price_tiers
                   WHERE product_id = %s AND min_quantity <= %s AND max_quantity >= %s
                   ORDER BY min_quantity LIMIT 1""",
                (product_id, qty, qty),
            )
            tier = cur.fetchone()
            if tier:
                return float(tier["price"] or 0), tier["currency"] or "UZS"
        cur.execute(
            """SELECT default_sale_price AS price, currency_type AS currency
               FROM products WHERE id = %s AND active = TRUE""",
            (product_id,),
        )
        prod = cur.fetchone()
        if prod:
            return float(prod["price"] or 0), prod["currency"] or "UZS"
        return 0.0, "UZS"


def get_sale_product_unit(name: str) -> str:
    """V3: unified products jadvalidan unit_type qaytaradi."""
    with get_conn() as (conn, cur):
        cur.execute("SELECT unit_type FROM products WHERE name = %s", (name,))
        row = cur.fetchone()
    return row["unit_type"] if row else "dona"


def create_sale_multi(
    customer_id: int,
    customer_name: str,
    status: str,
    note: str,
    items: list[dict],
) -> int:
    """
    Transaction ichida sales + sale_items yaratadi.
    items: [{"product_name", "sale_type", "quantity", "unit_price", "currency", "line_total"}, ...]
    """
    total = sum(float(it["line_total"]) for it in items)
    with get_conn() as (conn, cur):
        cur.execute(
            """INSERT INTO sales (customer_id, customer_name, status, note, total_amount)
               VALUES (%s, %s, %s, %s, %s) RETURNING id""",
            (customer_id, customer_name, status, note, total),
        )
        sale_id = cur.fetchone()["id"]
        for it in items:
            cur.execute(
                """INSERT INTO sale_items
                   (sale_id, product_name, sale_type, quantity, unit_price, currency, line_total)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (
                    sale_id,
                    it["product_name"],
                    it.get("sale_type", "dona"),
                    float(it["quantity"]),
                    float(it["unit_price"]),
                    it.get("currency", "UZS"),
                    float(it["line_total"]),
                ),
            )
        return sale_id


def add_sale_product(name: str, code: str = "", unit: str = "dona", currency: str = "uzs") -> bool:
    """V3: unified products jadvaliga yozadi (sotuv tovari = mahsulot)."""
    cur_norm = currency.upper() if currency.upper() in ("UZS", "USD") else "UZS"
    unit_norm = unit if unit in ("kg", "dona") else "dona"
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                """INSERT INTO products (name, sku, unit_type, currency_type, rate_type)
                   VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (name) DO UPDATE
                   SET active=TRUE,
                       unit_type=EXCLUDED.unit_type,
                       currency_type=EXCLUDED.currency_type""",
                (name, code, unit_norm, cur_norm, unit_norm),
            )
            return True
    except Exception:
        return False


def delete_sale_product(name: str) -> bool:
    """V3: unified products jadvalida active=false qiladi."""
    with get_conn() as (conn, cur):
        cur.execute(
            "UPDATE products SET active = false WHERE name = %s",
            (name,),
        )
        return cur.rowcount > 0


# ── Debt / nasiya funksiyalari ─────────────────────────────────────────────

def get_debt_totals() -> dict:
    """Jami nasiya summalarini (USD va UZS) va qarzdor mijozlar sonini qaytaradi."""
    with get_conn() as (conn, cur):
        cur.execute("""
            SELECT
                COUNT(DISTINCT customer_id)::int AS customer_count,
                COALESCE(SUM(debt_amount) FILTER (
                    WHERE UPPER(COALESCE(currency,'USD')) = 'USD'
                ), 0) AS total_usd,
                COALESCE(SUM(debt_amount) FILTER (
                    WHERE UPPER(COALESCE(currency,'USD')) = 'UZS'
                ), 0) AS total_uzs
            FROM sales
            WHERE status IN ('pending', 'partial')
              AND COALESCE(debt_amount, 0) > 0
        """)
        row = cur.fetchone()
        return {
            "customer_count": int(row["customer_count"] or 0),
            "total_usd":      float(row["total_usd"] or 0),
            "total_uzs":      float(row["total_uzs"] or 0),
        }


def get_debt_customers() -> list[dict]:
    """Nasiyasi bor mijozlar ro'yxatini qaytaradi.

    Har bir satrda: customer_id, customer_name, phone,
    debt_usd, debt_uzs, sale_count, oldest_sale.
    """
    with get_conn() as (conn, cur):
        cur.execute("""
            SELECT
                s.customer_id,
                s.customer_name,
                COALESCE(c.phone, '') AS phone,
                COALESCE(SUM(s.debt_amount) FILTER (
                    WHERE UPPER(COALESCE(s.currency,'USD')) = 'USD'
                ), 0) AS debt_usd,
                COALESCE(SUM(s.debt_amount) FILTER (
                    WHERE UPPER(COALESCE(s.currency,'USD')) = 'UZS'
                ), 0) AS debt_uzs,
                COUNT(*)::int     AS sale_count,
                MIN(s.created_at) AS oldest_sale
            FROM sales s
            LEFT JOIN customers c ON c.id = s.customer_id
            WHERE s.status IN ('pending', 'partial')
              AND COALESCE(s.debt_amount, 0) > 0
            GROUP BY s.customer_id, s.customer_name, c.phone
            ORDER BY MIN(s.created_at) ASC
        """)
        return cur.fetchall()


def get_customer_debt_sales(customer_id: int) -> list[dict]:
    """Bitta mijozning barcha nasiyali savdolarini qaytaradi."""
    with get_conn() as (conn, cur):
        cur.execute("""
            SELECT
                id,
                customer_name,
                total_amount,
                COALESCE(paid_amount, 0)  AS paid_amount,
                COALESCE(debt_amount, 0)  AS debt_amount,
                UPPER(COALESCE(currency, 'USD')) AS currency,
                status,
                note,
                created_at
            FROM sales
            WHERE customer_id = %s
              AND status IN ('pending', 'partial')
              AND COALESCE(debt_amount, 0) > 0
            ORDER BY created_at DESC
        """, (customer_id,))
        return cur.fetchall()


def add_debt_payment(
    sale_id: int, amount: float, currency: str = "USD", note: str = ""
) -> dict:
    """Savdoga to'lov qo'shadi: paid_amount oshadi, debt_amount kamayadi.

    Returns:
        ok=True  → {ok, paid, new_debt, status}
        ok=False → {ok, error}
    """
    with get_conn() as (conn, cur):
        cur.execute(
            "SELECT id, total_amount, paid_amount, debt_amount, status FROM sales WHERE id = %s",
            (sale_id,),
        )
        sale = cur.fetchone()
        if not sale:
            return {"ok": False, "error": "Savdo topilmadi"}

        current_debt = float(sale["debt_amount"] or 0)
        if current_debt <= 0:
            return {"ok": False, "error": "Bu savdoda nasiya yo'q"}
        if amount > current_debt + 0.01:
            return {"ok": False, "error": f"Summa nasiyadan ko'p ({current_debt:,.2f})"}

        new_paid = float(sale["paid_amount"] or 0) + amount
        new_debt = max(0.0, round(current_debt - amount, 2))
        new_status = "paid" if new_debt < 0.01 else "partial"

        cur.execute("""
            UPDATE sales
               SET paid_amount = %s,
                   debt_amount = %s,
                   status      = %s
             WHERE id = %s
        """, (new_paid, new_debt, new_status, sale_id))

        # sale_payments jadvaliga yozamiz (agar jadval mavjud bo'lsa)
        try:
            cur.execute("""
                INSERT INTO sale_payments (sale_id, amount, currency, note)
                VALUES (%s, %s, %s, %s)
            """, (sale_id, amount, currency, note))
        except Exception:
            pass  # jadval hali yaratilmagan bo'lsa (eski muhit), o'tkazib yuboramiz

        return {"ok": True, "paid": amount, "new_debt": new_debt, "status": new_status}


# ══════════════════════════════════════════════════════════════════════════════
# OMBOR (INVENTORY) FUNCTIONS
# ══════════════════════════════════════════════════════════════════════════════

def get_warehouses() -> list[dict]:
    with get_conn() as (conn, cur):
        cur.execute("SELECT id, name FROM warehouses WHERE active=TRUE ORDER BY id")
        return cur.fetchall()


def get_containers() -> list[dict]:
    """Faqat konteyner turidagi omborlarni qaytaradi (C-01…C-30)."""
    with get_conn() as (conn, cur):
        cur.execute(
            "SELECT id, name FROM warehouses WHERE active=TRUE AND location_type='container' ORDER BY name"
        )
        return cur.fetchall()


def get_warehouse_by_name(name: str) -> dict | None:
    with get_conn() as (conn, cur):
        cur.execute("SELECT id, name FROM warehouses WHERE name=%s AND active=TRUE", (name,))
        return cur.fetchone()


def get_stock_by_warehouse() -> list[dict]:
    """Returns list of {warehouse_name, product, quantity}"""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT w.name AS warehouse_name, i.product, i.quantity
               FROM inventory i
               JOIN warehouses w ON w.id = i.warehouse_id
               WHERE i.quantity > 0
               ORDER BY w.id, i.product"""
        )
        return cur.fetchall()


def get_stock_for_warehouse(warehouse_id: int) -> list[dict]:
    with get_conn() as (conn, cur):
        cur.execute(
            "SELECT product, quantity FROM inventory WHERE warehouse_id=%s AND quantity>0 ORDER BY product",
            (warehouse_id,),
        )
        return cur.fetchall()


def get_inventory_line(warehouse_id: int, product: str) -> dict | None:
    """Bitta konteyner liniyasi: joriy miqdor, og'irlik va mahsulot birligi (kg/dona)."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT i.quantity,
                      COALESCE(i.weight_kg, 0)            AS weight_kg,
                      LOWER(COALESCE(p.unit_type, 'dona')) AS unit_type
               FROM inventory i
               LEFT JOIN products p ON p.name = i.product
               WHERE i.warehouse_id = %s AND i.product = %s""",
            (warehouse_id, product),
        )
        return cur.fetchone()


def record_movement(
    product: str,
    quantity: float,
    movement_type: str,
    from_warehouse_id: int | None,
    to_warehouse_id: int | None,
    note: str = "",
    created_by: str = "",
    product_type: str = "finished",
) -> bool:
    """movement_type: IN | OUT | TRANSFER; product_type: finished | raw

    Inventory og'irligini (weight_kg) ham yangilaymiz:
      • OUT/TRANSFER manbadan — joriy saqlangan og'irlikdan proporsional ayiramiz
        (weight_kg * qty / quantity), shunda qisman chiqim aniq qoladi.
      • IN/TRANSFER qabul — kg-mahsulot bo'lsa partiya nisbati bo'yicha og'irlik
        qo'shamiz; aks holda 0 (dona mahsulotlar uchun og'irlik ahamiyatsiz).
    """
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                """INSERT INTO stock_movements
                     (product, quantity, movement_type, from_warehouse_id, to_warehouse_id,
                      note, created_by, product_type)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                (product, quantity, movement_type, from_warehouse_id,
                 to_warehouse_id, note, created_by, product_type),
            )

            def _incoming_weight() -> float:
                """Kirim uchun og'irlik — kg-mahsulot bo'lsa partiya nisbati bo'yicha."""
                cur.execute("SELECT unit_type FROM products WHERE name=%s", (product,))
                prow = cur.fetchone()
                if not prow or str(prow.get("unit_type") or "").lower() != "kg":
                    return 0.0
                cur.execute(
                    """SELECT CASE WHEN SUM(quantity) > 0
                                   THEN SUM(weight_kg)::numeric / SUM(quantity)
                                   ELSE 0 END AS kg_per_unit
                       FROM batches WHERE product=%s""",
                    (product,),
                )
                rr = cur.fetchone()
                kg_per_unit = float(rr["kg_per_unit"] or 0) if rr else 0.0
                return quantity * kg_per_unit

            def _outgoing_weight(wh_id: int) -> float:
                """Chiqim uchun og'irlik — joriy saqlangan nisbatdan proporsional."""
                cur.execute(
                    "SELECT quantity, weight_kg FROM inventory WHERE warehouse_id=%s AND product=%s",
                    (wh_id, product),
                )
                row = cur.fetchone()
                if not row:
                    return 0.0
                cur_qty = float(row["quantity"] or 0)
                cur_w   = float(row["weight_kg"] or 0)
                if cur_qty <= 0 or cur_w <= 0:
                    return 0.0
                return min(cur_w, cur_w * quantity / cur_qty)

            if movement_type == "IN" and to_warehouse_id:
                w_in = _incoming_weight()
                cur.execute(
                    """INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type, updated_at)
                       VALUES (%s,%s,%s,%s,%s,NOW())
                       ON CONFLICT (warehouse_id, product)
                       DO UPDATE SET quantity=inventory.quantity+%s,
                                     weight_kg=inventory.weight_kg+%s, updated_at=NOW()""",
                    (to_warehouse_id, product, quantity, w_in, product_type, quantity, w_in),
                )
            elif movement_type == "OUT" and from_warehouse_id:
                w_out = _outgoing_weight(from_warehouse_id)
                cur.execute(
                    """INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type, updated_at)
                       VALUES (%s,%s,0,0,%s,NOW())
                       ON CONFLICT (warehouse_id, product)
                       DO UPDATE SET quantity=GREATEST(0,inventory.quantity-%s),
                                     weight_kg=GREATEST(0,inventory.weight_kg-%s), updated_at=NOW()""",
                    (from_warehouse_id, product, product_type, quantity, w_out),
                )
            elif movement_type == "TRANSFER" and from_warehouse_id and to_warehouse_id:
                w_move = _outgoing_weight(from_warehouse_id)
                cur.execute(
                    """INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type, updated_at)
                       VALUES (%s,%s,0,0,%s,NOW())
                       ON CONFLICT (warehouse_id, product)
                       DO UPDATE SET quantity=GREATEST(0,inventory.quantity-%s),
                                     weight_kg=GREATEST(0,inventory.weight_kg-%s), updated_at=NOW()""",
                    (from_warehouse_id, product, product_type, quantity, w_move),
                )
                cur.execute(
                    """INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type, updated_at)
                       VALUES (%s,%s,%s,%s,%s,NOW())
                       ON CONFLICT (warehouse_id, product)
                       DO UPDATE SET quantity=inventory.quantity+%s,
                                     weight_kg=inventory.weight_kg+%s, updated_at=NOW()""",
                    (to_warehouse_id, product, quantity, w_move, product_type, quantity, w_move),
                )
        return True
    except Exception as e:
        return False


def get_recent_movements(limit: int = 10) -> list[dict]:
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT m.product, m.quantity, m.movement_type,
                      fw.name AS from_wh, tw.name AS to_wh,
                      m.created_by, m.created_at
               FROM stock_movements m
               LEFT JOIN warehouses fw ON fw.id=m.from_warehouse_id
               LEFT JOIN warehouses tw ON tw.id=m.to_warehouse_id
               ORDER BY m.id DESC LIMIT %s""",
            (limit,),
        )
        return cur.fetchall()


# ══════════════════════════════════════════════════════════════════════════════
# PACKER PRODUCT ASSIGNMENTS
# ══════════════════════════════════════════════════════════════════════════════

def get_packer_assigned_products(packer_name: str) -> list[str]:
    """V3: Returns products assigned to a packer via packer_product_assignments.
    Returns [] if no assignments (caller should fallback to all active products)."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT pa.product_name
               FROM packer_product_assignments pa
               JOIN products p ON p.name = pa.product_name
               WHERE pa.packer_name = %s AND p.active = TRUE
               ORDER BY pa.product_name""",
            (packer_name,),
        )
        return [r["product_name"] for r in cur.fetchall()]


def get_products_for_packer(packer_name: str) -> list[str]:
    """V3: Packer uchun ko'rsatiladigan mahsulotlar ro'yxati.

    packer_product_assignments'da yozuv bo'lsa — faqat shu mahsulotlar;
    biriktirilgan mahsulot bo'lmasa — barcha faol mahsulotlar (fallback)."""
    assigned = get_packer_assigned_products(packer_name)
    if assigned:
        return assigned
    return get_product_names()


# ══════════════════════════════════════════════════════════════════════════════
# XOM ASHYO (RAW MATERIALS)
# ══════════════════════════════════════════════════════════════════════════════

def get_raw_materials() -> list[dict]:
    """Barcha faol xom ashyolar ro'yxati."""
    with get_conn() as (conn, cur):
        cur.execute(
            "SELECT id, name, unit FROM raw_materials WHERE active=TRUE ORDER BY name"
        )
        return cur.fetchall()


def get_raw_material_names() -> list[str]:
    with get_conn() as (conn, cur):
        cur.execute("SELECT name FROM raw_materials WHERE active=TRUE ORDER BY name")
        return [r["name"] for r in cur.fetchall()]


def get_raw_materials_full() -> list[dict]:
    """id, name, unit va joriy zahira bilan faol xom ashyolar (to'g'rilash uchun)."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT id, name, unit, COALESCE(current_stock, 0) AS current_stock
               FROM raw_materials WHERE active=TRUE ORDER BY name"""
        )
        return cur.fetchall()


def get_raw_material_by_id(material_id: int) -> dict | None:
    """Bitta xom ashyoning joriy zahirasi va birligi."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT id, name, unit, COALESCE(current_stock, 0) AS current_stock
               FROM raw_materials WHERE id=%s AND active=TRUE""",
            (material_id,),
        )
        return cur.fetchone()


def add_raw_material(name: str, unit: str = "kg") -> bool:
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                "INSERT INTO raw_materials (name, unit) VALUES (%s,%s) ON CONFLICT (name) DO UPDATE SET active=TRUE, unit=%s",
                (name, unit, unit),
            )
        return True
    except Exception:
        return False


def delete_raw_material(name: str) -> bool:
    try:
        with get_conn() as (conn, cur):
            cur.execute("UPDATE raw_materials SET active=FALSE WHERE name=%s", (name,))
        return True
    except Exception:
        return False


def get_stock_by_warehouse_typed() -> dict:
    """Returns {'finished': [...], 'raw': [...]} grouped by product_type."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT w.name AS warehouse_name, i.product, i.quantity, i.product_type
               FROM inventory i
               JOIN warehouses w ON w.id = i.warehouse_id
               WHERE i.quantity > 0
               ORDER BY i.product_type, w.id, i.product"""
        )
        rows = cur.fetchall()
    result: dict = {"finished": [], "raw": []}
    for r in rows:
        pt = r["product_type"] if r["product_type"] in ("finished", "raw") else "finished"
        result[pt].append(r)
    return result


# ── Sales report ──────────────────────────────────────────────────────────────

def get_sales_report_summary(from_date: str, to_date: str) -> dict:
    """Savdo hisoboti uchun umumiy statistika (from_date/to_date: 'YYYY-MM-DD')."""
    with get_conn() as (conn, cur):
        cur.execute("""
            SELECT
              COUNT(DISTINCT s.id)::int AS sale_count,
              COUNT(DISTINCT s.id) FILTER (WHERE s.status='paid')::int AS paid_count,
              COUNT(DISTINCT s.id) FILTER (WHERE s.status IN ('pending','partial'))::int AS pending_count,
              COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='usd'), 0) AS total_usd,
              COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='uzs'), 0) AS total_uzs
            FROM sales s
            LEFT JOIN sale_items si ON si.sale_id = s.id
            WHERE s.created_at::date BETWEEN %s AND %s
        """, (from_date, to_date))
        stats = dict(cur.fetchone() or {})

        cur.execute("""
            SELECT si.product_name,
                   ROUND(SUM(si.quantity)::numeric, 2) AS total_qty,
                   COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='usd'), 0) AS rev_usd,
                   COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='uzs'), 0) AS rev_uzs
            FROM sales s
            JOIN sale_items si ON si.sale_id = s.id
            WHERE s.created_at::date BETWEEN %s AND %s
            GROUP BY si.product_name
            ORDER BY rev_usd DESC, rev_uzs DESC
            LIMIT 10
        """, (from_date, to_date))
        products = cur.fetchall()

        cur.execute("""
            SELECT s.customer_name,
                   COUNT(DISTINCT s.id)::int AS sale_count,
                   COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='usd'), 0) AS total_usd,
                   COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='uzs'), 0) AS total_uzs
            FROM sales s
            LEFT JOIN sale_items si ON si.sale_id = s.id
            WHERE s.created_at::date BETWEEN %s AND %s
            GROUP BY s.customer_name
            ORDER BY total_usd DESC, total_uzs DESC
            LIMIT 10
        """, (from_date, to_date))
        customers = cur.fetchall()

        cur.execute("""
            SELECT s.id, s.created_at::date AS date, s.customer_name,
                   s.status, s.payment_type,
                   si.product_name, si.quantity, si.sale_type,
                   si.unit_price, si.currency, si.line_total
            FROM sales s
            JOIN sale_items si ON si.sale_id = s.id
            WHERE s.created_at::date BETWEEN %s AND %s
            ORDER BY s.created_at DESC, s.id, si.id
            LIMIT 200
        """, (from_date, to_date))
        items = cur.fetchall()

    return {
        "stats": stats,
        "products": [dict(r) for r in products],
        "customers": [dict(r) for r in customers],
        "items": [dict(r) for r in items],
    }
