"""F11: Telegram-first mashina to'ldirish — savdo-bot tomonidagi DB qatlam.

Uch vazifa:
1. Agent yuklash ustasi (wizard) uchun manba omborlar va mahsulotlar —
   ERP public sxema + distribution.mahsulotlar SKU ko'prigi. Tanlash
   qoidalari omborchi botdagi (telegram-bot/bot/database.py) bilan AYNAN
   bir xil: faol, mashina bo'lmagan, purpose='finished' ombor; dona qoldiq
   bor; SKU ikkala katalogda ham yagona va faol.
2. Yo'l yakuni (route-end) MASHINA HISOBOTI: qamrov tekshiruvi, mashina
   qoldiq/sotuv raqamlari, bir-marta-lik marker (vehicle_route_reports) va
   target asosidagi avto to'ldirish so'rovlari (#218 semantikasi:
   current<=min bo'lsa deficit=target-current; ochiq so'rov dedupi partial
   unique indeks orqali).
3. "✅ Mashina to'ldirildi" agent xabari uchun poller helperlari —
   stock_transferred bo'lgan, hali xabar yuborilmagan topshiriqlar.

Pul (narx) Decimal bo'lib qoladi; hech qayerda binary float'ga o'tmaydi.
Kursor xom tuple qaytaradi — dict qatlam shu modulda quriladi.
"""

import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from .connection import get_db, transaction
from .replenishment_delivery import configured_recipient_ids

log = logging.getLogger(__name__)

TASHKENT_TZ = timezone(timedelta(hours=5))

# Eslatma: SKU-yagonalik sharti (omborchi bot bilan bir xil) har bir so'rovda
# TO'LIQ literal ko'rinishda takrorlanadi — EXPLAIN dialekt-sweep testi faqat
# yaxlit string literalasini tekshira oladi (konkatenatsiya skip bo'ladi).
# Shart: savdo botda ham, ERPda ham aynan bitta faol yozuv; aks holda handoff
# API 400 beradi — wizard bunday mahsulotni boshidanoq ko'rsatmaydi.


def today_str():
    """Bot lokal kuni (ISO) — savdolar.created_at TEXT prefiksi bilan mos."""
    return datetime.now().date().isoformat()


def pilot_chain(telegram_id):
    """Faol pilot zanjiri yoki None.

    Qaytaradi: {delivery_agent_id, agent_name, vehicle_id, plate_number,
    vehicle_warehouse_id}. Kirish huquqi EMAS — huquq tekshiruvi
    is_vehicle_pilot_seller da; bu faqat xabar/ombor konteksti.
    """
    with transaction() as c:
        c.execute(
            """SELECT da.id, da.name, v.id, v.plate_number, v.warehouse_id
                 FROM distribution.delivery_agents da
                 JOIN distribution.vehicle_assignments va
                   ON va.delivery_agent_id = da.id AND va.status = 'active'
                 JOIN distribution.vehicles v
                   ON v.id = va.vehicle_id AND v.status = 'active'
                WHERE da.faol = 1 AND da.telegram_id = %s
                ORDER BY va.id DESC
                LIMIT 1""",
            (telegram_id,),
        )
        row = c.fetchone()
    if not row:
        return None
    return {
        "delivery_agent_id": int(row[0]),
        "agent_name": row[1] or "",
        "vehicle_id": int(row[2]),
        "plate_number": row[3] or "",
        "vehicle_warehouse_id": int(row[4]),
    }


def fill_source_warehouses():
    """Sozlangan Top Mart C-3 markaziy ombori, yoki bo'sh ro'yxat.

    F11 yuklashi faqat ``distribution.topmart_config.central_warehouse_id``
    ga ruxsat beradi. Konfiguratsiya bo'lmasa yoki shu ombor faol bo'lmasa,
    mashina ombori bo'lsa, ``purpose='finished'`` bo'lmasa yoxud unda mos
    dona qoldiq bo'lmasa, ro'yxat bo'sh qaytadi.
    """
    with transaction() as c:
        c.execute(
            """SELECT w.id, w.name
                 FROM distribution.topmart_config cfg
                 JOIN warehouses w ON w.id = cfg.central_warehouse_id
                 WHERE cfg.id = 1
                   AND w.active = TRUE
                  AND COALESCE(w.location_type, 'general') <> 'vehicle'
                  AND COALESCE(w.purpose, '') = 'finished'
                  AND EXISTS (
                    SELECT 1
                      FROM inventory i
                      JOIN products p ON p.name = i.product AND p.active = TRUE
                      JOIN distribution.mahsulotlar d ON d.sku = p.sku
                     WHERE i.warehouse_id = w.id AND i.quantity > 0
                       AND COALESCE(p.sku, '') <> ''
                       AND d.faol = 1 AND COALESCE(d.sku, '') <> ''
                       AND (SELECT COUNT(*) FROM distribution.mahsulotlar dx
                             WHERE dx.sku = p.sku AND dx.faol = 1
                               AND COALESCE(dx.sku, '') <> '') = 1
                       AND (SELECT COUNT(*) FROM products px
                             WHERE px.sku = p.sku AND px.active = TRUE) = 1
                   )""",
        )
        rows = c.fetchall()
    return [{"id": int(r[0]), "name": r[1]} for r in rows]


def fill_products(warehouse_id):
    """Tanlangan ombordagi yuklash mumkin bo'lgan mahsulotlar.

    [{mahsulot_id, name, sku, available_quantity(int), pieces_per_box(int>=1),
      narx(Decimal|None)}] — nomi bo'yicha. available floor(int) — dona.
    """
    with transaction() as c:
        c.execute(
            """SELECT d.id, p.name, p.sku, i.quantity,
                      GREATEST(COALESCE(p.pieces_per_box, 1), 1), d.narx
                 FROM inventory i
                 JOIN products p ON p.name = i.product AND p.active = TRUE
                 JOIN distribution.mahsulotlar d ON d.sku = p.sku
                WHERE i.warehouse_id = %s AND i.quantity > 0
                  AND COALESCE(p.sku, '') <> ''
                  AND d.faol = 1 AND COALESCE(d.sku, '') <> ''
                  AND (SELECT COUNT(*) FROM distribution.mahsulotlar dx
                        WHERE dx.sku = p.sku AND dx.faol = 1
                          AND COALESCE(dx.sku, '') <> '') = 1
                  AND (SELECT COUNT(*) FROM products px
                        WHERE px.sku = p.sku AND px.active = TRUE) = 1
                ORDER BY p.name""",
            (warehouse_id,),
        )
        rows = c.fetchall()
    out = []
    for r in rows:
        out.append({
            "mahsulot_id": int(r[0]),
            "name": r[1],
            "sku": r[2],
            "available_quantity": int(Decimal(str(r[3]))),
            "pieces_per_box": int(r[4]),
            "narx": Decimal(str(r[5])) if r[5] is not None else None,
        })
    return [p for p in out if p["available_quantity"] > 0]


# ── Route-end hisobot ────────────────────────────────────────────────────────

def route_end_status(delivery_agent_id, telegram_id, kun, today):
    """(planned, covered): bugungi marshrut dokonlari va qamrab olinganlari.

    covered = shu agent bugun dokon uchun faol savdo yozgan YOKI "tovar
    olmadi" (olmagan_dokonlar) yozgan. savdolar.created_at TEXT (isoformat)
    — LEFT(...,10) prefiks taqqoslash (::date EMAS — free-text quirk).
    """
    with transaction() as c:
        c.execute(
            """SELECT COUNT(*)::int,
                      COALESCE(COUNT(*) FILTER (WHERE covered), 0)::int
                 FROM (
                   SELECT r.dokon_id,
                          (EXISTS (SELECT 1 FROM distribution.savdolar s
                                    WHERE s.dokon_id = r.dokon_id
                                      AND s.agent_id = %s
                                      AND COALESCE(s.status, 'active') = 'active'
                                      AND LEFT(s.created_at, 10) = %s)
                           OR EXISTS (SELECT 1 FROM distribution.olmagan_dokonlar o
                                    WHERE o.dokon_id = r.dokon_id
                                      AND o.agent_id = %s
                                      AND LEFT(o.created_at, 10) = %s)) AS covered
                     FROM distribution.delivery_routes r
                     JOIN distribution.dokonlar d
                       ON d.id = r.dokon_id AND d.holat = 'faol'
                    WHERE r.delivery_agent_id = %s AND r.kun = %s
                 ) t""",
            (telegram_id, today, telegram_id, today, delivery_agent_id, kun),
        )
        row = c.fetchone()
    return (int(row[0]), int(row[1])) if row else (0, 0)


def vehicle_day_numbers(vehicle_warehouse_id, vehicle_id, today):
    """Mashina bo'yicha kunlik raqamlar (mahsulot kesimida).

    [{mahsulot_id, name, sold(int), remaining(int)}] — bugun sotilganlar
    (vehicle_sale_allocations -> bugungi faol savdolar) FULL OUTER JOIN
    mashina omboridagi joriy qoldiq (inventory, SKU ko'prigi orqali).
    """
    with transaction() as c:
        c.execute(
            """WITH sold AS (
                    SELECT a.mahsulot_id,
                           MAX(a.product_name) AS product_name,
                           SUM(a.allocated_quantity) AS sold_qty
                      FROM distribution.vehicle_sale_allocations a
                      JOIN distribution.savdolar s ON s.id = a.savdo_id
                     WHERE a.vehicle_id = %s
                       AND COALESCE(s.status, 'active') = 'active'
                       AND LEFT(s.created_at, 10) = %s
                     GROUP BY a.mahsulot_id
                 ), stock AS (
                    SELECT d.id AS mahsulot_id,
                           MAX(p.name) AS product_name,
                           SUM(i.quantity) AS remaining
                      FROM inventory i
                      JOIN products p ON p.name = i.product AND p.active = TRUE
                      JOIN distribution.mahsulotlar d ON d.sku = p.sku
                     WHERE i.warehouse_id = %s AND i.quantity > 0
                       AND COALESCE(p.sku, '') <> ''
                       AND d.faol = 1 AND COALESCE(d.sku, '') <> ''
                       AND (SELECT COUNT(*) FROM distribution.mahsulotlar dx
                             WHERE dx.sku = p.sku AND dx.faol = 1
                               AND COALESCE(dx.sku, '') <> '') = 1
                       AND (SELECT COUNT(*) FROM products px
                             WHERE px.sku = p.sku AND px.active = TRUE) = 1
                     GROUP BY d.id
                 )
                 SELECT COALESCE(st.mahsulot_id, so.mahsulot_id) AS mid,
                        COALESCE(st.product_name, so.product_name, m.nomi) AS name,
                        COALESCE(so.sold_qty, 0),
                        COALESCE(st.remaining, 0)
                   FROM stock st
                   FULL OUTER JOIN sold so ON so.mahsulot_id = st.mahsulot_id
                   LEFT JOIN distribution.mahsulotlar m
                     ON m.id = COALESCE(st.mahsulot_id, so.mahsulot_id)
                  ORDER BY 2""",
            (vehicle_id, today, vehicle_warehouse_id),
        )
        rows = c.fetchall()
    out = []
    for r in rows:
        out.append({
            "mahsulot_id": int(r[0]) if r[0] is not None else None,
            "name": r[1] or "?",
            "sold": int(Decimal(str(r[2]))),
            "remaining": int(Decimal(str(r[3]))),
        })
    return out


def try_insert_route_report(vehicle_id, route_date, delivery_agent_id,
                            agent_chat_id, payload):
    """Bir-marta-lik marker. True = biz yutdik (hisobot yuboriladi);
    False = shu kun uchun hisobot allaqachon bor (parallel/qayta urinish)."""
    with transaction() as c:
        c.execute(
            """INSERT INTO distribution.vehicle_route_reports
                 (vehicle_id, route_date, delivery_agent_id, agent_chat_id, payload)
               VALUES (%s, %s::date, %s, %s, %s)
               ON CONFLICT (vehicle_id, route_date) DO NOTHING
               RETURNING id""",
            (vehicle_id, route_date, delivery_agent_id, agent_chat_id, payload),
        )
        return c.fetchone() is not None


def route_end_replenishment(vehicle_id, requested_by_tid, vehicle_warehouse_id,
                            route_date, _marker=None):
    """Yo'l yakunida target asosidagi avto to'ldirish so'rovlari (#218 nusxasi).

    Har bir amaldagi target uchun: current<=min bo'lsa deficit=target-current
    so'rov INSERT ... ON CONFLICT (ochiq-so'rov partial unique) DO NOTHING +
    outbox qatorlari. Savdo paytidagi enqueue bilan bir xil semantika —
    bu faqat xavfsizlik to'ri (sotuv paytida allaqachon ochilgan bo'lsa,
    dedup jim yutadi). Qaytaradi: [(product_name, deficit_int), ...] faqat
    YANGI ochilganlar.
    """
    created = []
    with transaction() as c:
        if _marker is not None:
            # Bir-marta-lik hisobot markeri SHU tranzaksiyada: to'ldirish
            # xatosi markerni ham bekor qiladi — transient xato avto
            # to'ldirishni shu kun uchun abadiy o'chirib qo'yolmaydi.
            _da_id, _chat_id, _payload = _marker
            c.execute(
                """INSERT INTO distribution.vehicle_route_reports
                     (vehicle_id, route_date, delivery_agent_id, agent_chat_id, payload)
                   VALUES (%s, %s::date, %s, %s, %s)
                   ON CONFLICT (vehicle_id, route_date) DO NOTHING
                   RETURNING id""",
                (vehicle_id, route_date, _da_id, _chat_id, _payload),
            )
            if c.fetchone() is None:
                return False, []
        c.execute(
            """SELECT DISTINCT ON (t.public_product_id)
                      t.id, t.mahsulot_id, t.public_product_id, t.product_name,
                      t.sku, t.target_quantity, t.min_quantity
                 FROM distribution.vehicle_stock_targets t
                WHERE t.vehicle_id = %s AND t.public_product_id IS NOT NULL
                  AND t.effective_from <= CURRENT_DATE
                  AND (t.effective_to IS NULL OR t.effective_to >= CURRENT_DATE)
                ORDER BY t.public_product_id, t.effective_from DESC, t.id DESC""",
            (vehicle_id,),
        )
        targets = c.fetchall()
        for (target_id, mahsulot_id, public_product_id, product_name, sku,
             target_quantity, min_quantity) in targets:
            c.execute(
                """SELECT COALESCE(SUM(i.quantity), 0)
                     FROM inventory i
                     JOIN products p ON p.name = i.product AND p.active = TRUE
                    WHERE i.warehouse_id = %s AND p.sku = %s""",
                (vehicle_warehouse_id, sku),
            )
            current = Decimal(str(c.fetchone()[0]))
            target_qty = Decimal(str(target_quantity))
            minimum = Decimal(str(min_quantity))
            if current > minimum:
                continue
            deficit = target_qty - current
            if deficit <= 0:
                continue
            if (target_qty != target_qty.to_integral_value()
                    or minimum != minimum.to_integral_value()
                    or current != current.to_integral_value()
                    or deficit != deficit.to_integral_value()):
                log.error(
                    "Route-end replenishment butun bo'lmagan qiymat: vehicle=%s product=%s",
                    vehicle_id, public_product_id)
                continue
            operation_key = (
                "vehicle-replenishment:auto:route-end:%s:product:%s:date:%s"
                % (vehicle_id, public_product_id, route_date)
            )
            fingerprint_payload = {
                "current_quantity": str(current.normalize()),
                "mahsulot_id": int(mahsulot_id),
                "product_name": str(product_name),
                "public_product_id": int(public_product_id),
                "requested_quantity": str(deficit.normalize()),
                "route_date": str(route_date),
                "sku": str(sku),
                "target_id": int(target_id),
                "target_quantity": str(target_qty.normalize()),
                "vehicle_id": int(vehicle_id),
            }
            request_fingerprint = hashlib.sha256(
                json.dumps(fingerprint_payload, sort_keys=True,
                           separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            ).hexdigest()
            c.execute(
                """INSERT INTO distribution.vehicle_replenishment_requests
                     (vehicle_id,requested_by,mahsulot_id,public_product_id,product_name,sku,
                      requested_quantity,status,operation_key,request_fingerprint,
                      target_quantity_snapshot,current_quantity_snapshot,requested_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,'pending',%s,%s,%s,%s,NOW())
                   ON CONFLICT (vehicle_id,public_product_id)
                     WHERE status IN ('pending','approved')
                   DO NOTHING
                   RETURNING id""",
                (vehicle_id, requested_by_tid, mahsulot_id, public_product_id,
                 product_name, sku, deficit, operation_key, request_fingerprint,
                 target_qty, current),
            )
            inserted = c.fetchone()
            if not inserted:
                continue  # ochiq so'rov allaqachon bor — dublikat ochilmaydi
            request_id = inserted[0]
            try:
                recipients = configured_recipient_ids()
            except ValueError as exc:
                log.error("Vehicle replenishment Telegram config rejected: %s", exc)
                recipients = ()
            for recipient_id in recipients:
                c.execute(
                    """INSERT INTO distribution.vehicle_replenishment_outbox
                         (request_id,recipient_chat_id)
                       VALUES (%s,%s)
                       ON CONFLICT (request_id,recipient_chat_id) DO NOTHING""",
                    (request_id, recipient_id),
                )
            created.append((str(product_name), int(deficit)))
    if _marker is not None:
        return True, created
    return created


def try_route_end_finalize(vehicle_id, route_date, delivery_agent_id,
                           agent_chat_id, payload, requested_by_tid,
                           vehicle_warehouse_id):
    """Marker + avto to'ldirish BITTA tranzaksiyada (atomik yo'l yakuni).

    (False, []) = marker band — hisobot allaqachon ketgan (parallel/qayta).
    (True, created) = biz yutdik, kerak bo'lsa so'rovlar ochildi.
    Har qanday xato -> BUTUN tranzaksiya (marker ham) bekor: keyingi
    savdo/olmadi saqlanishida yakun to'liq qayta uriniladi.
    """
    return route_end_replenishment(
        vehicle_id, requested_by_tid, vehicle_warehouse_id, route_date,
        _marker=(delivery_agent_id, agent_chat_id, payload))


# ── "Mashina to'ldirildi" agent xabari (poller) ─────────────────────────────

def pending_agent_notifications(limit=5):
    """Xabar yuborilmagan stock_transferred topshiriq idlari (eng eskisi avval)."""
    with transaction() as c:
        c.execute(
            """SELECT id FROM distribution.vehicle_handoffs
                WHERE status = 'stock_transferred' AND agent_notified_at IS NULL
                ORDER BY id
                LIMIT %s""",
            (limit,),
        )
        return [int(r[0]) for r in c.fetchall()]


def notify_agent_transfer(handoff_id, send_fn):
    """Bitta topshiriq uchun agentga xabar yuborib, belgini qo'yadi.

    Bitta tranzaksiya: FOR UPDATE SKIP LOCKED qulf -> send_fn(chat_id, text)
    -> agent_notified_at=NOW(). send_fn xato tashlasa rollback — yozuv
    keyingi aylanishda qayta uriniladi (at-least-once).
    Agent telegram_id topilmasa: belgini qo'yib log yozamiz (abadiy loop yo'q).
    True = yozuv yakunlandi (yuborildi yoki yuborib bo'lmaydi deb belgilandi).
    """
    with transaction() as c:
        c.execute(
            """SELECT h.id, h.vehicle_id, h.delivery_agent_id,
                      h.source_warehouse_id, h.stock_transferred_at
                 FROM distribution.vehicle_handoffs h
                WHERE h.id = %s AND h.status = 'stock_transferred'
                  AND h.agent_notified_at IS NULL
                FOR UPDATE SKIP LOCKED""",
            (handoff_id,),
        )
        row = c.fetchone()
        if not row:
            return False
        _, vehicle_id, delivery_agent_id, source_wh_id, transferred_at = row
        c.execute(
            "SELECT telegram_id, name FROM distribution.delivery_agents WHERE id = %s",
            (delivery_agent_id,),
        )
        agent = c.fetchone()
        if not agent or not agent[0]:
            log.error(
                "Handoff %s: delivery agent %s telegram_id yo'q — xabar o'tkazib yuborildi",
                handoff_id, delivery_agent_id)
            c.execute(
                "UPDATE distribution.vehicle_handoffs SET agent_notified_at = NOW() WHERE id = %s",
                (handoff_id,),
            )
            return True
        chat_id, agent_name = int(agent[0]), agent[1] or ""
        c.execute("SELECT plate_number FROM distribution.vehicles WHERE id = %s",
                  (vehicle_id,))
        v = c.fetchone()
        plate = v[0] if v else "?"
        c.execute("SELECT name FROM warehouses WHERE id = %s", (source_wh_id,))
        w = c.fetchone()
        source_name = w[0] if w else ("Ombor #%s" % source_wh_id)
        c.execute(
            """SELECT product_name, quantity_dispatched, pieces_per_box
                 FROM distribution.vehicle_handoff_items
                WHERE handoff_id = %s
                ORDER BY id""",
            (handoff_id,),
        )
        items = c.fetchall()
        lines = []
        total_qty = 0
        total_boxes = 0
        for name, qty, ppb in items:
            q = int(Decimal(str(qty)))
            ppb_i = max(int(ppb or 1), 1)
            boxes = -(-q // ppb_i)  # ceil
            total_qty += q
            total_boxes += boxes
            lines.append("  • %s — %s dona (%s quti)" % (name or "?", q, boxes))
        when = ""
        if transferred_at is not None:
            try:
                when = "\n🕐 " + transferred_at.astimezone(TASHKENT_TZ).strftime(
                    "%d.%m.%Y %H:%M")
            except Exception:
                when = ""
        text = (
            "✅ MASHINA TO'LDIRILDI (№%s)\n"
            "🚚 %s — %s\n"
            "🏬 Manba: %s\n\n"
            "📦 Yuklangan tovarlar:\n%s\n\n"
            "Jami: %s dona · %s quti%s"
            % (handoff_id, plate, agent_name, source_name,
               "\n".join(lines) if lines else "  —",
               total_qty, total_boxes, when)
        )
        send_fn(chat_id, text)
        c.execute(
            "UPDATE distribution.vehicle_handoffs SET agent_notified_at = NOW() WHERE id = %s",
            (handoff_id,),
        )
    return True
