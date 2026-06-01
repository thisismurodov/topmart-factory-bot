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
                created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
            )
            """
        )
        conn.commit()


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


def create_batch(batch_code: str, worker: str, product: str, quantity: int) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO batches (batch_code, worker, product, quantity) VALUES (?, ?, ?, ?)",
            (batch_code, worker, product, quantity),
        )
        conn.commit()


def get_today_batches() -> list[sqlite3.Row]:
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT batch_code, worker, product, quantity, created_at
            FROM   batches
            WHERE  date(created_at) = date('now', 'localtime')
            ORDER  BY id
            """,
        ).fetchall()
    return rows
