"""Sale creation — one all-or-nothing transaction."""

import os
from datetime import date, datetime, timedelta

from .connection import transaction
from .customers import update_dokon_repeat


def create_sale(dokon_id, agent_id, items, jami, tolov, foto, nasiya_summa):
    """Save a sale with its detail lines, repeat stats, revisit schedule and
    optional nasiya record — atomically. Returns (sale_id, owner_tg, jami_nasiya_qoldiq).

    items: iterable of (mahsulot_id, miqdor, narx) with miqdor > 0.
    """
    now = datetime.now().isoformat()
    try:
        rdays = int(os.environ.get("REVISIT_DAYS", "7"))
    except ValueError:
        rdays = 7
    revisit_date = (date.today() + timedelta(days=rdays)).isoformat()
    with transaction() as c:
        c.execute(
            "INSERT INTO savdolar (dokon_id,agent_id,jami_summa,tolov_turi,foto,created_at) "
            "VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
            (dokon_id, agent_id, jami, tolov, foto, now),
        )
        sid = c.fetchone()[0]
        update_dokon_repeat(c, dokon_id, jami)
        # Qayta kirish workflow: cancel earlier pending revisit, schedule a new one
        c.execute(
            "UPDATE revisitlar SET status='superseded' WHERE dokon_id=%s AND status='pending'",
            (dokon_id,),
        )
        c.execute(
            "INSERT INTO revisitlar (dokon_id,agent_id,last_order_date,revisit_date,status,created_at) "
            "VALUES (%s,%s,%s,%s,%s,%s)",
            (dokon_id, agent_id, date.today().isoformat(), revisit_date, "pending", now),
        )
        for mid, miqdor, narx in items:
            c.execute(
                "INSERT INTO savdo_tafsilot (savdo_id,mahsulot_id,miqdor,narx,summa) "
                "VALUES (%s,%s,%s,%s,%s)",
                (sid, mid, miqdor, narx, narx * miqdor),
            )
        if nasiya_summa > 0:
            c.execute(
                "INSERT INTO nasiya (dokon_id,agent_id,savdo_id,jami_summa,tolangan,qoldiq,created_at,updated_at) "
                "VALUES (%s,%s,%s,%s,0,%s,%s,%s)",
                (dokon_id, agent_id, sid, nasiya_summa, nasiya_summa, now, now),
            )
        c.execute("SELECT owner_telegram_id FROM dokonlar WHERE id=%s", (dokon_id,))
        row = c.fetchone()
        owner_tg = row[0] if row else None
        c.execute(
            "SELECT COALESCE(SUM(qoldiq),0) FROM nasiya WHERE dokon_id=%s AND qoldiq>0",
            (dokon_id,),
        )
        jami_nasiya_qoldiq = c.fetchone()[0]
    return sid, owner_tg, jami_nasiya_qoldiq
