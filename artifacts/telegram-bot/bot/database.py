import os
from datetime import date
from contextlib import contextmanager

import psycopg2
import psycopg2.extras

from .config import DATABASE_URL, SEED_WORKERS, SEED_PRODUCTS


@contextmanager
def get_conn():
    conn = psycopg2.connect(DATABASE_URL)
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
        cur.execute("""
            CREATE TABLE IF NOT EXISTS batches (
                id         SERIAL PRIMARY KEY,
                batch_code TEXT NOT NULL UNIQUE,
                worker     TEXT NOT NULL,
                product    TEXT NOT NULL,
                quantity   INTEGER NOT NULL,
                weight_kg  NUMERIC(10,3) NOT NULL DEFAULT 0,
                earnings   NUMERIC(12,2) NOT NULL DEFAULT 0,
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
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
                id      SERIAL PRIMARY KEY,
                name    TEXT NOT NULL UNIQUE,
                unit    TEXT NOT NULL DEFAULT 'dona',
                active  BOOLEAN NOT NULL DEFAULT true,
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS db_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)
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
        cur.execute("SELECT name, rate_type, rate FROM products ORDER BY name")
        rows = cur.fetchall()
    return [(r["name"], r["rate_type"], float(r["rate"])) for r in rows]


def get_product_names() -> list[str]:
    with get_conn() as (conn, cur):
        cur.execute("SELECT name FROM products ORDER BY name")
        return [r["name"] for r in cur.fetchall()]


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
            "SELECT COUNT(*) AS cnt FROM batches WHERE batch_code LIKE %s",
            (f"{prefix}%",),
        )
        seq = (cur.fetchone()["cnt"] or 0) + 1
    return f"{prefix}{seq:02d}"


def create_batch(
    batch_code: str, worker: str, product: str,
    quantity: int, weight_kg: float, earnings: float,
) -> None:
    with get_conn() as (conn, cur):
        cur.execute(
            """INSERT INTO batches (batch_code, worker, product, quantity, weight_kg, earnings)
               VALUES (%s,%s,%s,%s,%s,%s)""",
            (batch_code, worker, product, quantity, weight_kg, earnings),
        )


def get_today_batches(worker_filter: list[str] | None = None) -> list[dict]:
    with get_conn() as (conn, cur):
        if worker_filter:
            placeholders = ",".join(["%s"] * len(worker_filter))
            cur.execute(
                f"""SELECT batch_code, worker, product, quantity, weight_kg, earnings, created_at
                    FROM batches
                    WHERE created_at::date = CURRENT_DATE
                      AND worker IN ({placeholders})
                    ORDER BY id""",
                worker_filter,
            )
        else:
            cur.execute(
                """SELECT batch_code, worker, product, quantity, weight_kg, earnings, created_at
                   FROM batches
                   WHERE created_at::date = CURRENT_DATE
                   ORDER BY id"""
            )
        return cur.fetchall()


def get_monthly_kpi(year: int, month: int) -> list[dict]:
    period = f"{year}-{month:02d}"
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT worker, SUM(quantity) AS total_qty, SUM(weight_kg) AS total_kg,
                      SUM(earnings) AS total_earnings, COUNT(*) AS batch_count
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
    note: str = "",
) -> int:
    with get_conn() as (conn, cur):
        cur.execute(
            """INSERT INTO sales
               (customer_id, customer_name, product, quantity, weight_kg,
                unit_price, total_amount, status, note)
               VALUES (%s,%s,%s,%s,%s,%s,%s,'pending',%s)
               RETURNING id""",
            (customer_id, customer_name, product, quantity,
             weight_kg, unit_price, total_amount, note),
        )
        return cur.fetchone()["id"]


def get_recent_sales(limit: int = 10) -> list[dict]:
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT s.id, s.customer_name, s.product, s.quantity, s.weight_kg,
                      s.unit_price, s.total_amount, s.status, s.created_at
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
    with get_conn() as (conn, cur):
        cur.execute(
            "SELECT id, name, unit FROM sale_products WHERE active = true ORDER BY name"
        )
        return cur.fetchall()


def get_sale_product_unit(name: str) -> str:
    with get_conn() as (conn, cur):
        cur.execute("SELECT unit FROM sale_products WHERE name = %s", (name,))
        row = cur.fetchone()
    return row["unit"] if row else "dona"


def add_sale_product(name: str, unit: str = "dona") -> bool:
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                "INSERT INTO sale_products (name, unit) VALUES (%s, %s) ON CONFLICT (name) DO UPDATE SET active=true, unit=%s",
                (name, unit, unit),
            )
            return True
    except Exception:
        return False


def delete_sale_product(name: str) -> bool:
    with get_conn() as (conn, cur):
        cur.execute(
            "UPDATE sale_products SET active = false WHERE name = %s",
            (name,),
        )
        return cur.rowcount > 0
