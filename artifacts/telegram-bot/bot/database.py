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
                id       SERIAL PRIMARY KEY,
                name     TEXT NOT NULL UNIQUE,
                code     TEXT NOT NULL DEFAULT '',
                unit     TEXT NOT NULL DEFAULT 'dona',
                currency TEXT NOT NULL DEFAULT 'uzs',
                active   BOOLEAN NOT NULL DEFAULT true,
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS raw_materials (
                id         SERIAL PRIMARY KEY,
                name       TEXT NOT NULL UNIQUE,
                unit       TEXT NOT NULL DEFAULT 'kg',
                active     BOOLEAN NOT NULL DEFAULT true,
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS db_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)
        # product_type ustunini mavjud jadvallarga qo'shamiz (agar yo'q bo'lsa)
        cur.execute("""
            ALTER TABLE stock_movements
            ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'finished'
        """)
        cur.execute("""
            ALTER TABLE inventory
            ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'finished'
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
        # Tayyor mahsulotni avtomatik birinchi omborga "Kirim" qilib yozamiz
        cur.execute("SELECT id FROM warehouses WHERE active=TRUE ORDER BY id LIMIT 1")
        wh = cur.fetchone()
        if wh:
            wh_id = wh["id"]
            cur.execute(
                """INSERT INTO stock_movements
                     (product, quantity, movement_type, from_warehouse_id, to_warehouse_id,
                      note, created_by, product_type)
                   VALUES (%s,%s,'IN',NULL,%s,%s,%s,'finished')""",
                (product, quantity, wh_id, f"Partiya: {batch_code}", worker),
            )
            cur.execute(
                """INSERT INTO inventory (warehouse_id, product, quantity, product_type, updated_at)
                   VALUES (%s,%s,%s,'finished',NOW())
                   ON CONFLICT (warehouse_id, product)
                   DO UPDATE SET quantity=inventory.quantity+%s, updated_at=NOW()""",
                (wh_id, product, quantity, quantity),
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
    """sales_products jadvalidan o'qiydi (narx, tur, valyuta bilan)."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT id, name, sale_type AS unit, default_price, currency
               FROM sales_products WHERE active = TRUE ORDER BY name"""
        )
        return cur.fetchall()


def get_sale_product_by_id(prod_id: int) -> dict | None:
    with get_conn() as (conn, cur):
        cur.execute(
            "SELECT id, name, sale_type AS unit, default_price, currency FROM sales_products WHERE id = %s",
            (prod_id,),
        )
        return cur.fetchone()


def get_price_for_qty(product_id: int, qty: float) -> tuple[float, str]:
    """
    Miqdorga qarab narxni qaytaradi.
    sales_product_tiers'dan min_qty <= qty shartiga to'g'ri keladigan
    eng katta min_qty'li tier tanlanadi.
    Agar tier yo'q bo'lsa, sales_products.default_price qaytariladi.
    Return: (price, currency)
    """
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT price, currency FROM sales_product_tiers
               WHERE product_id = %s AND min_qty <= %s
               ORDER BY min_qty DESC LIMIT 1""",
            (product_id, qty),
        )
        tier = cur.fetchone()
        if tier:
            return float(tier["price"]), tier["currency"]
        cur.execute(
            "SELECT default_price, currency FROM sales_products WHERE id = %s",
            (product_id,),
        )
        prod = cur.fetchone()
        if prod:
            return float(prod["default_price"] or 0), prod["currency"] or "UZS"
        return 0.0, "UZS"


def get_sale_product_unit(name: str) -> str:
    with get_conn() as (conn, cur):
        cur.execute("SELECT sale_type FROM sales_products WHERE name = %s", (name,))
        row = cur.fetchone()
    return row["sale_type"] if row else "dona"


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
    cur_norm = currency.upper() if currency.upper() in ("UZS", "USD") else "UZS"
    unit_norm = unit if unit in ("kg", "dona") else "dona"
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                """INSERT INTO sales_products (name, sale_type, currency, default_price)
                   VALUES (%s, %s, %s, 0)
                   ON CONFLICT (name) DO UPDATE
                   SET active=true, sale_type=%s, currency=%s""",
                (name, unit_norm, cur_norm, unit_norm, cur_norm),
            )
            return True
    except Exception:
        return False


def delete_sale_product(name: str) -> bool:
    with get_conn() as (conn, cur):
        cur.execute(
            "UPDATE sales_products SET active = false WHERE name = %s",
            (name,),
        )
        return cur.rowcount > 0


# ══════════════════════════════════════════════════════════════════════════════
# OMBOR (INVENTORY) FUNCTIONS
# ══════════════════════════════════════════════════════════════════════════════

def get_warehouses() -> list[dict]:
    with get_conn() as (conn, cur):
        cur.execute("SELECT id, name FROM warehouses WHERE active=TRUE ORDER BY id")
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
    """movement_type: IN | OUT | TRANSFER; product_type: finished | raw"""
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
            if movement_type == "IN" and to_warehouse_id:
                cur.execute(
                    """INSERT INTO inventory (warehouse_id, product, quantity, product_type, updated_at)
                       VALUES (%s,%s,%s,%s,NOW())
                       ON CONFLICT (warehouse_id, product)
                       DO UPDATE SET quantity=inventory.quantity+%s, updated_at=NOW()""",
                    (to_warehouse_id, product, quantity, product_type, quantity),
                )
            elif movement_type == "OUT" and from_warehouse_id:
                cur.execute(
                    """INSERT INTO inventory (warehouse_id, product, quantity, product_type, updated_at)
                       VALUES (%s,%s,0,%s,NOW())
                       ON CONFLICT (warehouse_id, product)
                       DO UPDATE SET quantity=GREATEST(0,inventory.quantity-%s), updated_at=NOW()""",
                    (from_warehouse_id, product, product_type, quantity),
                )
            elif movement_type == "TRANSFER" and from_warehouse_id and to_warehouse_id:
                cur.execute(
                    """INSERT INTO inventory (warehouse_id, product, quantity, product_type, updated_at)
                       VALUES (%s,%s,0,%s,NOW())
                       ON CONFLICT (warehouse_id, product)
                       DO UPDATE SET quantity=GREATEST(0,inventory.quantity-%s), updated_at=NOW()""",
                    (from_warehouse_id, product, product_type, quantity),
                )
                cur.execute(
                    """INSERT INTO inventory (warehouse_id, product, quantity, product_type, updated_at)
                       VALUES (%s,%s,%s,%s,NOW())
                       ON CONFLICT (warehouse_id, product)
                       DO UPDATE SET quantity=inventory.quantity+%s, updated_at=NOW()""",
                    (to_warehouse_id, product, quantity, product_type, quantity),
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
# WORKER PRODUCT PERMISSIONS
# ══════════════════════════════════════════════════════════════════════════════

def get_worker_allowed_products(worker_name: str) -> list[str]:
    """Returns list of allowed product names for a worker.
    If no permissions set → returns [] (caller should treat as 'all allowed')."""
    with get_conn() as (conn, cur):
        cur.execute(
            "SELECT product_name FROM worker_product_permissions WHERE worker_name=%s ORDER BY product_name",
            (worker_name,),
        )
        rows = cur.fetchall()
    return [r["product_name"] for r in rows]


def set_worker_allowed_products(worker_name: str, product_names: list[str]) -> None:
    """Replace all permissions for a worker with the given list."""
    with get_conn() as (conn, cur):
        cur.execute("DELETE FROM worker_product_permissions WHERE worker_name=%s", (worker_name,))
        for pname in product_names:
            cur.execute(
                "INSERT INTO worker_product_permissions (worker_name, product_name) VALUES (%s,%s) ON CONFLICT DO NOTHING",
                (worker_name, pname),
            )


def get_all_worker_permissions() -> dict[str, list[str]]:
    """Returns {worker_name: [product_name, ...]} for all workers that have permissions."""
    with get_conn() as (conn, cur):
        cur.execute(
            "SELECT worker_name, product_name FROM worker_product_permissions ORDER BY worker_name, product_name"
        )
        rows = cur.fetchall()
    result: dict[str, list[str]] = {}
    for r in rows:
        result.setdefault(r["worker_name"], []).append(r["product_name"])
    return result


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
