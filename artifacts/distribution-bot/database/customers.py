"""Customer (dokon) balance and repeat-order statistics."""

from datetime import datetime

from .connection import get_db, transaction


def get_balans(dokon_id):
    conn = get_db()
    try:
        c = conn.cursor()
        c.execute("SELECT balans FROM mijoz_balans WHERE dokon_id=%s", (dokon_id,))
        row = c.fetchone()
        return row[0] if row else 0
    finally:
        conn.close()


def update_balans_delta(c, dokon_id, delta):
    """Apply a balance delta inside an existing transaction (cursor `c`)."""
    c.execute(
        "INSERT INTO mijoz_balans (dokon_id,balans) VALUES (%s,%s) "
        "ON CONFLICT(dokon_id) DO UPDATE SET balans=mijoz_balans.balans+%s",
        (dokon_id, delta, delta),
    )


def apply_balans_delta(dokon_id, delta):
    """Standalone atomic balance change (own transaction)."""
    with transaction() as c:
        update_balans_delta(c, dokon_id, delta)


def update_dokon_repeat(c, dokon_id, jami_summa):
    """Repeat System: update store stats after each new order (inside caller's tx)."""
    today = datetime.now()
    c.execute(
        "SELECT total_orders,repeat_orders,avg_repeat_days,last_order_date,first_order_date "
        "FROM dokonlar WHERE id=%s",
        (dokon_id,),
    )
    row = c.fetchone()
    if not row:
        return
    total, repeat_n, avg, last_d, first_d = row
    total = total or 0
    repeat_n = repeat_n or 0
    avg = avg or 0.0
    if total == 0:
        first_d = today.isoformat()
    else:
        try:
            ld = datetime.fromisoformat(last_d)
            days = (today - ld).days
            total_repeat_time = avg * repeat_n
            repeat_n += 1
            avg = (total_repeat_time + days) / repeat_n
        except Exception:
            pass
    total += 1
    c.execute(
        """UPDATE dokonlar SET first_order_date=COALESCE(first_order_date,%s),
           last_order_date=%s, total_orders=%s, repeat_orders=%s, avg_repeat_days=%s,
           total_sales=COALESCE(total_sales,0)+%s WHERE id=%s""",
        (first_d, today.isoformat(), total, repeat_n, avg, jami_summa or 0, dokon_id),
    )
