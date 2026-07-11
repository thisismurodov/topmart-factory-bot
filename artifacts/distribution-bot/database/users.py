"""User queries. Rows are returned as raw tuples (handlers read positionally,
e.g. u[3] = role) — do not change to dicts without updating all call sites."""

from .connection import get_db


def get_user(telegram_id):
    conn = get_db()
    try:
        c = conn.cursor()
        c.execute("SELECT * FROM users WHERE telegram_id=%s", (telegram_id,))
        return c.fetchone()
    finally:
        conn.close()


def get_admin_telegram_ids():
    """Telegram IDs of all DB users with role='admin'."""
    conn = get_db()
    try:
        c = conn.cursor()
        c.execute("SELECT telegram_id FROM users WHERE role='admin'")
        return [tid for (tid,) in c.fetchall() if tid]
    finally:
        conn.close()
