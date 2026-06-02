import sqlite3
import os
from datetime import date
from .config import DB_PATH, SEED_WORKERS, SEED_PRODUCTS


def get_connection() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_connection() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS batches (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_code TEXT    NOT NULL UNIQUE,
                worker     TEXT    NOT NULL,
                product    TEXT    NOT NULL,
                quantity   INTEGER NOT NULL,
                weight_kg  REAL    NOT NULL DEFAULT 0,
                earnings   REAL    NOT NULL DEFAULT 0,
                created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS workers_config (
                name   TEXT PRIMARY KEY,
                prefix TEXT NOT NULL DEFAULT '',
                phone  TEXT NOT NULL DEFAULT '',
                role   TEXT NOT NULL DEFAULT 'worker'
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS products_config (
                name      TEXT PRIMARY KEY,
                rate_type TEXT NOT NULL DEFAULT 'dona',
                rate      REAL NOT NULL DEFAULT 100
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS user_roles (
                chat_id     INTEGER PRIMARY KEY,
                worker_name TEXT NOT NULL,
                role        TEXT NOT NULL DEFAULT 'worker'
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS packer_assignments (
                packer_chat_id INTEGER NOT NULL,
                worker_name    TEXT    NOT NULL,
                PRIMARY KEY (packer_chat_id, worker_name)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pending_users (
                chat_id    INTEGER PRIMARY KEY,
                name       TEXT    NOT NULL,
                phone      TEXT    NOT NULL,
                created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS salary_payments (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                worker_name TEXT    NOT NULL,
                year        INTEGER NOT NULL,
                month       INTEGER NOT NULL,
                amount      REAL    NOT NULL,
                note        TEXT    NOT NULL DEFAULT '',
                paid_at     TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
                UNIQUE (worker_name, year, month)
            )
        """)
        _migrate(conn)
        _seed(conn)
        conn.commit()


def _migrate(conn: sqlite3.Connection) -> None:
    cols = {row[1] for row in conn.execute("PRAGMA table_info(batches)")}
    if "weight_kg" not in cols:
        conn.execute("ALTER TABLE batches ADD COLUMN weight_kg REAL NOT NULL DEFAULT 0")
    if "earnings" not in cols:
        conn.execute("ALTER TABLE batches ADD COLUMN earnings REAL NOT NULL DEFAULT 0")
    w_cols = {row[1] for row in conn.execute("PRAGMA table_info(workers_config)")}
    if "role" not in w_cols:
        conn.execute("ALTER TABLE workers_config ADD COLUMN role TEXT NOT NULL DEFAULT 'worker'")


def _seed(conn: sqlite3.Connection) -> None:
    if conn.execute("SELECT COUNT(*) FROM workers_config").fetchone()[0] == 0:
        for w in SEED_WORKERS:
            conn.execute(
                "INSERT OR IGNORE INTO workers_config (name, prefix, phone, role) VALUES (?,?,?,?)",
                (w["name"], w["prefix"], w.get("phone", ""), w.get("role", "worker")),
            )
    if conn.execute("SELECT COUNT(*) FROM products_config").fetchone()[0] == 0:
        for p in SEED_PRODUCTS:
            conn.execute(
                "INSERT OR IGNORE INTO products_config (name, rate_type, rate) VALUES (?,?,?)",
                (p["name"], p["rate_type"], p["rate"]),
            )


# ── Workers & Products ────────────────────────────────────────────────────────

def get_workers() -> dict[str, str]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT name, prefix FROM workers_config WHERE role = 'worker' ORDER BY name"
        ).fetchall()
    return {r["name"]: r["prefix"] for r in rows}


def get_all_workers_config() -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM workers_config ORDER BY role, name").fetchall()


def get_products() -> list[tuple[str, str, float]]:
    with get_connection() as conn:
        rows = conn.execute("SELECT name, rate_type, rate FROM products_config ORDER BY name").fetchall()
    return [(r["name"], r["rate_type"], r["rate"]) for r in rows]


def get_product_names() -> list[str]:
    with get_connection() as conn:
        return [r[0] for r in conn.execute("SELECT name FROM products_config ORDER BY name")]


def add_worker(name: str, prefix: str, phone: str, role: str = "worker") -> bool:
    try:
        with get_connection() as conn:
            conn.execute(
                "INSERT INTO workers_config (name, prefix, phone, role) VALUES (?,?,?,?)",
                (name, prefix, phone, role),
            )
            conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False


def add_product(name: str, rate_type: str, rate: float) -> bool:
    try:
        with get_connection() as conn:
            conn.execute(
                "INSERT INTO products_config (name, rate_type, rate) VALUES (?,?,?)",
                (name, rate_type, rate),
            )
            conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False


def delete_worker(name: str) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM workers_config WHERE name = ?", (name,))
        conn.commit()


def delete_product(name: str) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM products_config WHERE name = ?", (name,))
        conn.commit()


# ── User roles ────────────────────────────────────────────────────────────────

def get_user_role(chat_id: int) -> sqlite3.Row | None:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM user_roles WHERE chat_id = ?", (chat_id,)
        ).fetchone()


def set_user_role(chat_id: int, worker_name: str, role: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO user_roles (chat_id, worker_name, role) VALUES (?,?,?)",
            (chat_id, worker_name, role),
        )
        conn.commit()


def get_admin_count() -> int:
    with get_connection() as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM user_roles WHERE role = 'admin'"
        ).fetchone()[0]


def find_user_by_phone(phone: str) -> sqlite3.Row | None:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM workers_config WHERE phone = ?", (phone,)
        ).fetchone()


# ── Packer assignments ────────────────────────────────────────────────────────

def assign_packer_workers(packer_chat_id: int, worker_names: list[str]) -> None:
    with get_connection() as conn:
        conn.execute(
            "DELETE FROM packer_assignments WHERE packer_chat_id = ?", (packer_chat_id,)
        )
        for w in worker_names:
            conn.execute(
                "INSERT INTO packer_assignments (packer_chat_id, worker_name) VALUES (?,?)",
                (packer_chat_id, w),
            )
        conn.commit()


def get_packer_workers(packer_chat_id: int) -> list[str]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT worker_name FROM packer_assignments WHERE packer_chat_id = ?",
            (packer_chat_id,),
        ).fetchall()
    return [r["worker_name"] for r in rows]


def get_registered_packers() -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM user_roles WHERE role = 'packer'"
        ).fetchall()


# ── Batches ───────────────────────────────────────────────────────────────────

def next_batch_code(worker_prefix: str) -> str:
    today = date.today().strftime("%y%m%d")
    prefix = f"{worker_prefix}-{today}-"
    with get_connection() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS cnt FROM batches WHERE batch_code LIKE ?",
            (f"{prefix}%",),
        ).fetchone()
        seq = (row["cnt"] or 0) + 1
    return f"{prefix}{seq:02d}"


def create_batch(
    batch_code: str, worker: str, product: str,
    quantity: int, weight_kg: float, earnings: float,
) -> None:
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO batches (batch_code, worker, product, quantity, weight_kg, earnings)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (batch_code, worker, product, quantity, weight_kg, earnings),
        )
        conn.commit()


def get_today_batches(worker_filter: list[str] | None = None) -> list[sqlite3.Row]:
    with get_connection() as conn:
        if worker_filter:
            placeholders = ",".join("?" * len(worker_filter))
            return conn.execute(
                f"""SELECT batch_code, worker, product, quantity, weight_kg, earnings, created_at
                    FROM batches
                    WHERE date(created_at) = date('now', 'localtime')
                      AND worker IN ({placeholders})
                    ORDER BY id""",
                worker_filter,
            ).fetchall()
        return conn.execute(
            """SELECT batch_code, worker, product, quantity, weight_kg, earnings, created_at
               FROM batches
               WHERE date(created_at) = date('now', 'localtime')
               ORDER BY id""",
        ).fetchall()


def get_monthly_kpi(year: int, month: int) -> list[sqlite3.Row]:
    period = f"{year}-{month:02d}"
    with get_connection() as conn:
        return conn.execute(
            """SELECT worker, SUM(quantity) AS total_qty, SUM(weight_kg) AS total_kg,
                      SUM(earnings) AS total_earnings, COUNT(*) AS batch_count
               FROM batches WHERE strftime('%Y-%m', created_at) = ?
               GROUP BY worker ORDER BY total_earnings DESC""",
            (period,),
        ).fetchall()


def get_worker_monthly(worker: str, year: int, month: int) -> list[sqlite3.Row]:
    period = f"{year}-{month:02d}"
    with get_connection() as conn:
        return conn.execute(
            """SELECT product, SUM(quantity) AS total_qty, SUM(weight_kg) AS total_kg,
                      SUM(earnings) AS total_earnings
               FROM batches WHERE worker = ? AND strftime('%Y-%m', created_at) = ?
               GROUP BY product ORDER BY total_earnings DESC""",
            (worker, period),
        ).fetchall()


# ── Pending users ─────────────────────────────────────────────────────────────

def save_pending_user(chat_id: int, name: str, phone: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO pending_users (chat_id, name, phone) VALUES (?,?,?)",
            (chat_id, name, phone),
        )
        conn.commit()


def get_pending_user(chat_id: int) -> sqlite3.Row | None:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM pending_users WHERE chat_id = ?", (chat_id,)
        ).fetchone()


def delete_pending_user(chat_id: int) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM pending_users WHERE chat_id = ?", (chat_id,))
        conn.commit()


# ── Salary payments ───────────────────────────────────────────────────────────

def get_monthly_salary_report(year: int, month: int) -> list[dict]:
    period = f"{year}-{month:02d}"
    with get_connection() as conn:
        workers = conn.execute(
            "SELECT name FROM workers_config WHERE role = 'worker' ORDER BY name"
        ).fetchall()
        result = []
        for w in workers:
            name = w["name"]
            rows = conn.execute(
                """SELECT product, SUM(quantity) AS qty, SUM(weight_kg) AS kg,
                          SUM(earnings) AS earnings
                   FROM batches
                   WHERE worker = ? AND strftime('%Y-%m', created_at) = ?
                   GROUP BY product""",
                (name, period),
            ).fetchall()
            if not rows:
                continue
            total_earnings = sum(r["earnings"] for r in rows)
            products = [
                {"name": r["product"], "qty": r["qty"], "kg": r["kg"],
                 "earnings": r["earnings"]}
                for r in rows
            ]
            pay_row = conn.execute(
                "SELECT paid_at FROM salary_payments WHERE worker_name=? AND year=? AND month=?",
                (name, year, month),
            ).fetchone()
            result.append({
                "worker": name,
                "total_earnings": total_earnings,
                "products": products,
                "is_paid": pay_row is not None,
                "paid_at": pay_row["paid_at"] if pay_row else None,
            })
    return result


def mark_salary_paid(worker_name: str, year: int, month: int, amount: float) -> None:
    with get_connection() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO salary_payments (worker_name, year, month, amount)
               VALUES (?,?,?,?)""",
            (worker_name, year, month, amount),
        )
        conn.commit()


def get_worker_payment_history(worker_name: str, limit: int = 6) -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            """SELECT year, month, amount, paid_at FROM salary_payments
               WHERE worker_name = ?
               ORDER BY year DESC, month DESC
               LIMIT ?""",
            (worker_name, limit),
        ).fetchall()


def clear_test_data() -> dict:
    with get_connection() as conn:
        batches = conn.execute("SELECT COUNT(*) FROM batches").fetchone()[0]
        pending = conn.execute("SELECT COUNT(*) FROM pending_users").fetchone()[0]
        conn.execute("DELETE FROM batches")
        conn.execute("DELETE FROM pending_users")
        conn.execute("DELETE FROM salary_payments")
        conn.execute("DELETE FROM sqlite_sequence WHERE name IN ('batches', 'salary_payments')")
        conn.commit()
    return {"batches": batches, "pending": pending}


# Legacy compat — used in old label handler
def register_worker_chat(worker_name: str, chat_id: int) -> None:
    role_row = None
    with get_connection() as conn:
        wc = conn.execute(
            "SELECT role FROM workers_config WHERE name = ?", (worker_name,)
        ).fetchone()
        if wc:
            role = wc["role"]
        else:
            role = "worker"
    set_user_role(chat_id, worker_name, role)


def get_worker_chat_id(worker_name: str) -> int | None:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT chat_id FROM user_roles WHERE worker_name = ?", (worker_name,)
        ).fetchone()
    return row["chat_id"] if row else None
