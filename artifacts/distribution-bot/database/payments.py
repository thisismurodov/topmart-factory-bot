"""Payment flows: pul olish (cash pickup) and nasiya (credit) repayment.

All writes are atomic — FIFO debt payoff, pul_olish record and any balance
credit happen in ONE transaction (no partial saves)."""

from datetime import datetime

from .connection import transaction
from .customers import update_balans_delta


def record_pul_olish(dokon_id, agent_id, summa):
    """Plain cash pickup with no debt applied."""
    with transaction() as c:
        c.execute(
            "INSERT INTO pul_olish (dokon_id,agent_id,summa,created_at) VALUES (%s,%s,%s,%s)",
            (dokon_id, agent_id, summa, datetime.now().isoformat()),
        )


def pay_nasiya_fifo(dokon_id, agent_id, summa, apply_amount=None, ortiqcha=0):
    """Apply a payment to open nasiya rows oldest-first, record pul_olish,
    and credit any overpayment (`ortiqcha`) to the customer balance.

    apply_amount: how much to apply to debt (defaults to `summa`).
    Returns owner_telegram_id (or None)."""
    now = datetime.now().isoformat()
    remaining = summa if apply_amount is None else apply_amount
    with transaction() as c:
        c.execute(
            "SELECT id,qoldiq FROM nasiya WHERE dokon_id=%s AND agent_id=%s AND qoldiq>0 "
            "ORDER BY created_at",
            (dokon_id, agent_id),
        )
        for nid, qoldiq in c.fetchall():
            if remaining <= 0:
                break
            pay = min(remaining, qoldiq)
            c.execute(
                "UPDATE nasiya SET tolangan=tolangan+%s,qoldiq=qoldiq-%s,updated_at=%s WHERE id=%s",
                (pay, pay, now, nid),
            )
            remaining -= pay
        c.execute(
            "INSERT INTO pul_olish (dokon_id,agent_id,summa,created_at) VALUES (%s,%s,%s,%s)",
            (dokon_id, agent_id, summa, now),
        )
        if ortiqcha > 0:
            update_balans_delta(c, dokon_id, ortiqcha)
        c.execute("SELECT owner_telegram_id FROM dokonlar WHERE id=%s", (dokon_id,))
        row = c.fetchone()
        owner_tg = row[0] if row else None
    return owner_tg
