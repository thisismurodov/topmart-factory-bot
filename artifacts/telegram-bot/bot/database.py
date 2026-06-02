import sqlite3
import os
from datetime import date
from .config import DB_PATH


def get_connection() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS batches (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_code  TEXT    NOT NULL UNIQUE,
                worker      TEXT    NOT NULL,
                product     TEXT    NOT NULL,
                quantity    INTEGER NOT NULL,
                weight_kg   REAL    NOT NULL DEFAULT 0,
                earnings    REAL    NOT NULL DEFAULT 0,
                created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS worker_chats (
                worker_name TEXT PRIMARY KEY,
                chat_id     INTEGER NOT NULL
            )
            """
        )
        _migrate(conn)
        conn.commit()


def _migrate(conn: sqlite3.Connection) -> None:
    cols = {row[1] for row in conn.execute("PRAGMA table_info(batches)")}
    if "weight_kg" not in cols:
        conn.execute("ALTER TABLE batches ADD COLUMN weight_kg REAL NOT NULL DEFAULT 0")
    if "earnings" not in cols:
        conn.execute("ALTER TABLE batches ADD COLUMN earnings REAL NOT NULL DEFAULT 0")


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
    batch_code: str,
    worker: str,
    product: str,
    quantity: int,
    weight_kg: float,
    earnings: float,
) -> None:
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO batches
               (batch_code, worker, product, quantity, weight_kg, earnings)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (batch_code, worker, product, quantity, weight_kg, earnings),
        )
        conn.commit()


def get_today_batches() -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            """SELECT batch_code, worker, product, quantity, weight_kg, earnings, created_at
               FROM   batches
               WHERE  date(created_at) = date('now', 'localtime')
               ORDER  BY id""",
        ).fetchall()


def get_monthly_kpi(year: int, month: int) -> list[sqlite3.Row]:
    period = f"{year}-{month:02d}"
    with get_connection() as conn:
        return conn.execute(
            """SELECT worker,
                      SUM(quantity)  AS total_qty,
                      SUM(weight_kg) AS total_kg,
                      SUM(earnings)  AS total_earnings,
                      COUNT(*)       AS batch_count
               FROM   batches
               WHERE  strftime('%Y-%m', created_at) = ?
               GROUP  BY worker
               ORDER  BY total_earnings DESC""",
            (period,),
        ).fetchall()


def get_worker_monthly(worker: str, year: int, month: int) -> list[sqlite3.Row]:
    period = f"{year}-{month:02d}"
    with get_connection() as conn:
        return conn.execute(
            """SELECT product,
                      SUM(quantity)  AS total_qty,
                      SUM(weight_kg) AS total_kg,
                      SUM(earnings)  AS total_earnings
               FROM   batches
               WHERE  worker = ? AND strftime('%Y-%m', created_at) = ?
               GROUP  BY product
               ORDER  BY total_earnings DESC""",
            (worker, period),
        ).fetchall()


def register_worker_chat(worker_name: str, chat_id: int) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO worker_chats (worker_name, chat_id) VALUES (?, ?)",
            (worker_name, chat_id),
        )
        conn.commit()


def get_worker_chat_id(worker_name: str) -> int | None:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT chat_id FROM worker_chats WHERE worker_name = ?",
            (worker_name,),
        ).fetchone()
    return row["chat_id"] if row else None
