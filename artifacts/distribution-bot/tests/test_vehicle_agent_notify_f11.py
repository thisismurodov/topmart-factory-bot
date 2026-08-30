"""F11 "✅ MASHINA TO'LDIRILDI" agent xabari — DB-backed poller testlari.

DATABASE_URL modul importida almashtirilmaydi (birlashgan discovery
xavfsizligi) — setUpClass patch qiladi, tearDownClass tiklaydi.
"""

import os
import unittest
import uuid
from unittest.mock import Mock
from urllib.parse import urlparse, urlunparse

import psycopg2

ADMIN_URL = os.environ.get("VEHICLE_TEST_DATABASE_ADMIN_URL", "").strip()
if not ADMIN_URL:
    raise RuntimeError("VEHICLE_TEST_DATABASE_ADMIN_URL is required")
_parsed = urlparse(ADMIN_URL)
if _parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
    raise RuntimeError("VEHICLE_TEST_DATABASE_ADMIN_URL must use a loopback host")
DB_NAME = "dist_f11n_py_%s_%s" % (os.getpid(), uuid.uuid4().hex[:8])
CHILD_URL = urlunparse(_parsed._replace(path="/" + DB_NAME))

os.environ.pop("RAILWAY_DATABASE_URL", None)
if not os.environ.get("DATABASE_URL"):
    raise RuntimeError("DATABASE_URL must be an isolated test child DB URL")
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "123456:LOCAL_F11_TEST")

from database import connection as connmod  # noqa: E402
from database.connection import close_pool, init_db  # noqa: E402
from database import vehicle_fill as vfill  # noqa: E402


PUBLIC_DDL = """
CREATE TABLE IF NOT EXISTS public.warehouses (
 id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, active BOOLEAN NOT NULL DEFAULT TRUE,
 location_type TEXT NOT NULL DEFAULT 'general', capacity_kg NUMERIC DEFAULT 20000,
 purpose TEXT NOT NULL DEFAULT 'finished', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""


def _admin():
    c = psycopg2.connect(ADMIN_URL)
    c.autocommit = True
    return c


def _db():
    return psycopg2.connect(CHILD_URL)


class VehicleAgentNotifyF11(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        admin = _admin()
        try:
            with admin.cursor() as cur:
                cur.execute("CREATE DATABASE %s" % DB_NAME)
        finally:
            admin.close()
        cls._prev_db_url = os.environ.get("DATABASE_URL")
        os.environ["DATABASE_URL"] = CHILD_URL
        cls._prev_dburl_attr = connmod.DB_URL
        connmod.DB_URL = CHILD_URL  # DB_URL importda muzlaydi — attr patch shart
        cls._prev_vapproved = connmod._VEHICLE_APPROVED
        connmod._VEHICLE_APPROVED = True  # vehicle DDL flagi ham importda muzlaydi
        close_pool()
        init_db()
        with _db() as conn, conn.cursor() as cur:
            cur.execute(PUBLIC_DDL)

    @classmethod
    def tearDownClass(cls):
        close_pool()
        connmod.DB_URL = cls._prev_dburl_attr
        connmod._VEHICLE_APPROVED = cls._prev_vapproved
        if cls._prev_db_url is not None:
            os.environ["DATABASE_URL"] = cls._prev_db_url
        admin = _admin()
        try:
            with admin.cursor() as cur:
                cur.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname=%s AND pid<>pg_backend_pid()", (DB_NAME,))
                cur.execute("DROP DATABASE IF EXISTS %s" % DB_NAME)
        finally:
            admin.close()

    def setUp(self):
        close_pool()
        with _db() as conn, conn.cursor() as c:
            c.execute("""
              TRUNCATE distribution.vehicle_handoff_items,
                distribution.vehicle_handoffs,distribution.vehicle_assignments,
                distribution.vehicles,distribution.delivery_agents,
                distribution.mahsulotlar,public.warehouses
              RESTART IDENTITY CASCADE
            """)
            c.execute("INSERT INTO distribution.delivery_agents(name,telegram_id,faol) "
                      "VALUES('NAVRUZBEK',700,1) RETURNING id")
            self.da = c.fetchone()[0]
            c.execute("INSERT INTO public.warehouses(name,active,location_type,purpose) "
                      "VALUES('DM-001 mashina ombori',TRUE,'vehicle','finished') RETURNING id")
            self.vwh = c.fetchone()[0]
            c.execute("INSERT INTO public.warehouses(name,active,location_type,purpose) "
                      "VALUES('Tayyor ombor',TRUE,'general','finished') RETURNING id")
            self.swh = c.fetchone()[0]
            c.execute("INSERT INTO distribution.vehicles(plate_number,vehicle_type,status,warehouse_id) "
                      "VALUES('DM-001','DAMAS','active',%s) RETURNING id", (self.vwh,))
            self.veh = c.fetchone()[0]
            c.execute("INSERT INTO distribution.vehicle_assignments(vehicle_id,delivery_agent_id,status) "
                      "VALUES(%s,%s,'active')", (self.veh, self.da))
            c.execute("INSERT INTO distribution.mahsulotlar(nomi,narx,faol,sku) "
                      "VALUES('Arqon 10m',12000,1,'SKU-A') RETURNING id")
            self.mA = c.fetchone()[0]
            c.execute("INSERT INTO distribution.mahsulotlar(nomi,narx,faol,sku) "
                      "VALUES('Ip 5mm',8000,1,'SKU-B') RETURNING id")
            self.mB = c.fetchone()[0]

    def _handoff(self, status="stock_transferred", notified=False,
                 items=(("Arqon 10m", 60, 24), ("Ip 5mm", 10, 10))):
        with _db() as conn, conn.cursor() as c:
            c.execute("""INSERT INTO distribution.vehicle_handoffs
                       (vehicle_id,delivery_agent_id,source_warehouse_id,vehicle_warehouse_id,
                        handoff_date,status,stock_transferred_at,agent_notified_at)
                       VALUES(%s,%s,%s,%s,CURRENT_DATE,%s,
                              CASE WHEN %s='stock_transferred' THEN NOW() END,
                              CASE WHEN %s THEN NOW() END)
                       RETURNING id""",
                      (self.veh, self.da, self.swh, self.vwh, status, status, notified))
            hid = c.fetchone()[0]
            skus = {"Arqon 10m": (self.mA, "SKU-A"), "Ip 5mm": (self.mB, "SKU-B")}
            for name, qty, ppb in items:
                mid, sku = skus[name]
                c.execute("""INSERT INTO distribution.vehicle_handoff_items
                           (handoff_id,mahsulot_id,sku,quantity_dispatched,product_name,
                            pieces_per_box) VALUES(%s,%s,%s,%s,%s,%s)""",
                          (hid, mid, sku, qty, name, ppb))
        return hid

    def test_pending_lists_only_unnotified_stock_transferred(self):
        a = self._handoff()
        self._handoff(status="prepared")
        self._handoff(notified=True)
        b = self._handoff()
        self.assertEqual(vfill.pending_agent_notifications(), [a, b])
        self.assertEqual(vfill.pending_agent_notifications(limit=1), [a])

    def test_notify_success_formats_marks_and_is_idempotent(self):
        hid = self._handoff()
        send = Mock()
        self.assertTrue(vfill.notify_agent_transfer(hid, send))
        send.assert_called_once()
        chat_id, text = send.call_args.args
        self.assertEqual(chat_id, 700)
        self.assertIn("MASHINA TO'LDIRILDI (№%s)" % hid, text)
        self.assertIn("DM-001", text)
        self.assertIn("NAVRUZBEK", text)
        self.assertIn("Tayyor ombor", text)
        self.assertIn("Arqon 10m — 60 dona (3 quti)", text)
        self.assertIn("Ip 5mm — 10 dona (1 quti)", text)
        self.assertIn("Jami: 70 dona · 4 quti", text)
        self.assertIn("🕐", text)  # stock_transferred_at Toshkent vaqtida
        self.assertEqual(vfill.pending_agent_notifications(), [])
        self.assertFalse(vfill.notify_agent_transfer(hid, send))
        send.assert_called_once()  # qayta yuborilmaydi

    def test_notify_rolls_back_when_send_fails(self):
        hid = self._handoff()
        send = Mock(side_effect=RuntimeError("telegram down"))
        with self.assertRaises(RuntimeError):
            vfill.notify_agent_transfer(hid, send)
        with _db() as conn, conn.cursor() as c:
            c.execute("SELECT agent_notified_at FROM distribution.vehicle_handoffs "
                      "WHERE id=%s", (hid,))
            self.assertIsNone(c.fetchone()[0])
        self.assertEqual(vfill.pending_agent_notifications(), [hid])

    def test_notify_missing_telegram_id_marks_without_send(self):
        hid = self._handoff()
        with _db() as conn, conn.cursor() as c:
            c.execute("UPDATE distribution.delivery_agents SET telegram_id=NULL")
        send = Mock()
        self.assertTrue(vfill.notify_agent_transfer(hid, send))
        send.assert_not_called()
        self.assertEqual(vfill.pending_agent_notifications(), [])

    def test_notify_ignores_non_transferred_statuses(self):
        hid = self._handoff(status="prepared")
        send = Mock()
        self.assertFalse(vfill.notify_agent_transfer(hid, send))
        send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
