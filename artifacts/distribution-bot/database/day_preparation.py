"""Vehicle-wide daily preparation snapshots and restart-safe Telegram delivery.

Reuse route_reports.payload for the durable delivery cursor; no stock writes.
Telegram delivery is at-least-once (a crash after send may repeat one chunk).
"""
import hashlib
import json
import os
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from .connection import transaction
from .sales import _shared_dm001_sellers
from .replenishment_delivery import configured_recipient_ids

TASHKENT = timezone(timedelta(hours=5))
BUTTON = "✅ Kun savdosini yakunlash"


def today():
    return datetime.now(TASHKENT).date().isoformat()


def enabled():
    return (os.environ.get("VEHICLE_DISTRIBUTION_ENABLED") == "1"
            and os.environ.get("VEHICLE_DISTRIBUTION_SCHEMA_APPROVED") == "1")


def read_rows(cursor, warehouse_id, day):
    # Movement time is the real DB instant; legacy posted_at may contain a
    # local naive timestamp incorrectly interpreted as UTC. EXISTS prevents
    # multiplying quantities when one sale is split over multiple labels.
    cursor.execute(
        """SELECT m.id, MAX(sm.product), lower(btrim(m.birlik)),
                  SUM(CASE WHEN lower(btrim(m.birlik))='kg'
                      THEN sm.weight_kg ELSE sm.quantity END), MAX(sm.id)
             FROM public.stock_movements sm
             JOIN distribution.savdo_tafsilot t
               ON sm.reference='vehicle-sale:'||t.savdo_id||':detail:'||t.id
             JOIN distribution.savdolar s ON s.id=t.savdo_id
             JOIN distribution.mahsulotlar m ON m.id=t.mahsulot_id
            WHERE sm.from_warehouse_id=%s AND sm.movement_type='OUT'
              AND sm.reason='vehicle_sale' AND s.status='posted'
              AND (sm.created_at AT TIME ZONE 'Asia/Tashkent')::date=%s::date
            GROUP BY m.id,lower(btrim(m.birlik)) ORDER BY 2,m.id""",
        (warehouse_id, day),
    )
    rows = []
    for mid, name, unit, qty, marker in cursor.fetchall():
        if unit not in ("kg", "dona") or qty is None or Decimal(qty) <= 0:
            raise ValueError("Savdo birligi yoki miqdori noto‘g‘ri; hisobot yuborilmadi.")
        rows.append({"id": mid, "name": name, "unit": unit,
                     "quantity": str(qty), "marker": marker})
    return rows


def chunks_for(rows, day, revision):
    header = (f"DM-001 — TAYYORLAB QO‘YISH KERAK\n{day} · ro‘yxat {revision}\n"
              "Ikkala profilning jami sotuvlari. Avvalgi shu kunlik ro‘yxat o‘rniga.\n\n")
    lines = [f"• {r['name']} — {format(Decimal(r['quantity']), 'f').rstrip('0').rstrip('.') if '.' in format(Decimal(r['quantity']), 'f') else r['quantity']} {r['unit']}"
             for r in rows] or ["Bugun sotuv yo‘q."]
    chunks, text = [], header
    for line in lines:
        if len(text) + len(line) > 3000:
            chunks.append(text)
            text = header
        text += line + "\n"
    chunks.append(text + "\nBu ro‘yxat ombor qoldig‘ini o‘zgartirmaydi.")
    return chunks


def queue_day(uid, day=None):
    if not enabled():
        raise ValueError("Mashina kun-yakuni xizmati yoqilmagan.")
    recipients = configured_recipient_ids()
    if not recipients:
        raise ValueError("Omborchi xabar oluvchisi sozlanmagan; ro‘yxat yuborilmadi.")
    day = day or today()
    with transaction() as c:
        sellers = [r for r in _shared_dm001_sellers(c) if r[1] == uid]
        if len(sellers) != 1:
            raise ValueError("DM-001 uchun faol sotuvchi ruxsati topilmadi.")
        delivery_id, _, vehicle_id, warehouse_id = sellers[0]
        # Same parent lock as sale writer; snapshot cannot split a sale commit.
        c.execute("SELECT id FROM public.warehouses WHERE id=%s FOR UPDATE", (warehouse_id,))
        rows = read_rows(c, warehouse_id, day)
        fingerprint = hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()
        c.execute("""INSERT INTO distribution.vehicle_route_reports
                     (vehicle_id,route_date,delivery_agent_id,agent_chat_id,payload)
                     VALUES (%s,%s::date,%s,%s,'{}')
                     ON CONFLICT(vehicle_id,route_date) DO NOTHING""",
                  (vehicle_id, day, delivery_id, uid))
        c.execute("""SELECT id,payload FROM distribution.vehicle_route_reports
                     WHERE vehicle_id=%s AND route_date=%s::date FOR UPDATE""", (vehicle_id, day))
        report_id, raw = c.fetchone()
        payload = json.loads(raw or "{}")
        previous = payload.get("preparation", {})
        if previous.get("fingerprint") == fingerprint:
            return False
        revision = int(previous.get("revision", 0)) + 1
        payload["preparation"] = {
            "fingerprint": fingerprint, "revision": revision,
            "chunks": chunks_for(rows, day, revision),
            "recipients": {str(r): 0 for r in recipients},
        }
        payload.pop("preparation_done", None)
        c.execute("UPDATE distribution.vehicle_route_reports SET payload=%s WHERE id=%s",
                  (json.dumps(payload, ensure_ascii=False), report_id))
    return True


def deliver_pending(bot):
    if not enabled():
        return
    allowed = {str(r) for r in configured_recipient_ids()}
    # Persist per-recipient chunk progress; concurrent pollers skip locked rows.
    # On send error the transaction rolls back and the next poll retries.
    with transaction() as c:
        c.execute("""SELECT id,payload FROM distribution.vehicle_route_reports
                     WHERE payload LIKE '%%\"preparation\":%%'
                       AND payload NOT LIKE '%%\"preparation_done\": true%%'
                     ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 10""")
        for report_id, raw in c.fetchall():
            payload = json.loads(raw)
            prep = payload["preparation"]
            for recipient, position in prep["recipients"].items():
                if recipient not in allowed:
                    continue
                retry = prep.setdefault("retry", {}).get(recipient, {})
                if retry.get("after", 0) > time.time():
                    continue
                if position < len(prep["chunks"]):
                    try:
                        bot.send_message(int(recipient), prep["chunks"][position],
                                         parse_mode=None, timeout=20)
                        prep["recipients"][recipient] = position + 1
                        prep["retry"].pop(recipient, None)
                    except Exception:
                        attempts = int(retry.get("attempts", 0)) + 1
                        prep["retry"][recipient] = {
                            "attempts": attempts,
                            "after": time.time() + min(3600, 30 * 2 ** min(attempts, 7)),
                        }
                    # Only one send per transaction: earlier successful chunks
                    # are not rolled back if a later recipient fails.
                    c.execute("UPDATE distribution.vehicle_route_reports SET payload=%s WHERE id=%s",
                              (json.dumps(payload, ensure_ascii=False), report_id))
                    return
            if all(p >= len(prep["chunks"]) for p in prep["recipients"].values()):
                payload["preparation_done"] = True
                c.execute("UPDATE distribution.vehicle_route_reports SET payload=%s WHERE id=%s",
                          (json.dumps(payload, ensure_ascii=False), report_id))
