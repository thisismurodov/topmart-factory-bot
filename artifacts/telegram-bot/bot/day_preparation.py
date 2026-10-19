"""Read-only, shared-vehicle preparation list for warehouse operators."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from .database import get_conn

BUTTON = "📋 Kechagi tayyorlash ro‘yxati"
TASHKENT = timezone(timedelta(hours=5))


def yesterday(now=None):
    now = now or datetime.now(TASHKENT)
    return now.astimezone(TASHKENT).date() - timedelta(days=1)


def read_rows(day):
    start = datetime.combine(day, datetime.min.time(), tzinfo=TASHKENT)
    with get_conn() as (conn, cur):
        # All queries on this connection, including future edits, must be read-only.
        conn.set_session(readonly=True)
        cur.execute("""SELECT warehouse_id FROM distribution.vehicles
                       WHERE plate_number='DM-001'""")
        vehicles = cur.fetchall()
        if len(vehicles) != 1:
            raise ValueError("DM-001 mashina ombori aniq sozlanmagan.")
        cur.execute("""
            SELECT t.mahsulot_id, MAX(sm.product) AS name,
                   lower(btrim(m.birlik)) AS unit,
                   SUM(CASE WHEN lower(btrim(m.birlik))='kg'
                       THEN sm.weight_kg ELSE sm.quantity END) AS quantity
              FROM public.stock_movements sm
              JOIN distribution.savdo_tafsilot t
                ON sm.reference='vehicle-sale:'||t.savdo_id||':detail:'||t.id
              JOIN distribution.savdolar s ON s.id=t.savdo_id
              JOIN distribution.mahsulotlar m ON m.id=t.mahsulot_id
             WHERE sm.from_warehouse_id=%s AND sm.movement_type='OUT'
               AND sm.reason='vehicle_sale' AND s.status='posted'
               AND sm.created_at >= %s AND sm.created_at < %s
             GROUP BY t.mahsulot_id,lower(btrim(m.birlik))
             ORDER BY name,t.mahsulot_id
        """, (vehicles[0]["warehouse_id"], start, start + timedelta(days=1)))
        rows = cur.fetchall()
        for row in rows:
            if row["unit"] not in ("kg", "dona") or row["quantity"] is None or Decimal(row["quantity"]) <= 0:
                raise ValueError("Savdo birligi yoki miqdori noto‘g‘ri.")
        return rows


def messages(day, rows):
    header = (f"DM-001 — KECHAGI TAYYORLASH RO‘YXATI\n"
              f"{day:%d.%m.%Y} · Toshkent vaqti\n"
              "Ikkala profilning jami sotilgan tovarlari.\n\n")
    footer = "\nKo‘rish uchun: kun yopilmadi, qoldiq o‘zgarmadi."
    lines = []
    for row in rows:
        quantity = format(Decimal(row["quantity"]), "f")
        if "." in quantity:
            quantity = quantity.rstrip("0").rstrip(".")
        lines.append(f"• {row['name']} — {quantity} {row['unit']}\n")
    text = header
    result = []
    for line in lines or ["Bu kunda sotuv yo‘q.\n"]:
        if len(text) + len(line) + len(footer) > 3000:
            result.append(text + footer)
            text = header
        text += line
    result.append(text + footer)
    return result
