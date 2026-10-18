import json
import os
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.parse import urlparse, urlunparse

import psycopg2
from database import connection
from database import day_preparation as prep


class DailyPreparationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        parsed = urlparse(os.environ["VEHICLE_TEST_DATABASE_ADMIN_URL"])
        assert parsed.hostname in ("localhost", "127.0.0.1", "::1")
        cls.admin = psycopg2.connect(os.environ["VEHICLE_TEST_DATABASE_ADMIN_URL"])
        cls.admin.autocommit = True
        cls.name = "prep_test_" + uuid.uuid4().hex
        with cls.admin.cursor() as c:
            c.execute('CREATE DATABASE "' + cls.name + '"')
        cls.old_url = connection.DB_URL
        connection.close_pool()
        connection.DB_URL = urlunparse(parsed._replace(path="/" + cls.name))
        with connection.transaction() as c:
            c.execute("""
              CREATE SCHEMA distribution;
              CREATE TABLE public.warehouses(id INT PRIMARY KEY);
              INSERT INTO public.warehouses VALUES(37);
              CREATE TABLE distribution.vehicle_route_reports(
                id SERIAL PRIMARY KEY, vehicle_id INT, route_date DATE,
                delivery_agent_id INT, agent_chat_id BIGINT, payload TEXT,
                UNIQUE(vehicle_id,route_date));
              CREATE TABLE distribution.mahsulotlar(id INT PRIMARY KEY, birlik TEXT);
              INSERT INTO distribution.mahsulotlar VALUES(1,'dona'),(2,'kg');
              CREATE TABLE distribution.savdolar(id INT PRIMARY KEY, status TEXT, agent_id INT);
              CREATE TABLE distribution.savdo_tafsilot(id INT PRIMARY KEY,savdo_id INT,mahsulot_id INT);
              CREATE TABLE public.stock_movements(
                id SERIAL PRIMARY KEY, product TEXT, reference TEXT, quantity NUMERIC,
                weight_kg NUMERIC, from_warehouse_id INT, movement_type TEXT,
                reason TEXT,created_at TIMESTAMPTZ);
            """)

    @classmethod
    def tearDownClass(cls):
        connection.close_pool()
        connection.DB_URL = cls.old_url
        with cls.admin.cursor() as c:
            c.execute('DROP DATABASE "' + cls.name + '"')
        cls.admin.close()

    def setUp(self):
        self.env = patch.dict(os.environ, {
            "VEHICLE_DISTRIBUTION_ENABLED": "1",
            "VEHICLE_DISTRIBUTION_SCHEMA_APPROVED": "1",
            "VEHICLE_REPLENISHMENT_TELEGRAM_CHAT_IDS": "90001,90002",
        })
        self.env.start()
        self.auth = patch.object(prep, "_shared_dm001_sellers",
                                 return_value=[(1, 10, 1, 37), (2, 20, 1, 37)])
        self.auth.start()
        with connection.transaction() as c:
            c.execute("""TRUNCATE distribution.vehicle_route_reports,distribution.savdolar,
                         distribution.savdo_tafsilot,public.stock_movements RESTART IDENTITY""")
        self.sale(1, 10, 1, "10", "0.7", "2026-10-17 20:00:00+00")
        self.sale(2, 20, 1, "5", "0.35", "2026-10-18 06:00:00+00")
        self.sale(3, 20, 2, "0", "2.55", "2026-10-18 06:00:00+00")
        self.sale(4, 10, 1, "99", "1", "2026-10-17 18:59:59+00")

    def tearDown(self):
        self.auth.stop()
        self.env.stop()

    def sale(self, sid, agent, mid, qty, kg, at):
        with connection.transaction() as c:
            c.execute("INSERT INTO distribution.savdolar VALUES(%s,'posted',%s)", (sid, agent))
            c.execute("INSERT INTO distribution.savdo_tafsilot VALUES(%s,%s,%s)", (sid, sid, mid))
            c.execute("""INSERT INTO public.stock_movements
              (product,reference,quantity,weight_kg,from_warehouse_id,movement_type,reason,created_at)
              VALUES(%s,%s,%s,%s,37,'OUT','vehicle_sale',%s)""",
                      ("Product " + str(mid), f"vehicle-sale:{sid}:detail:{sid}", qty, kg, at))

    def payload(self):
        with connection.transaction() as c:
            c.execute("SELECT payload FROM distribution.vehicle_route_reports")
            return json.loads(c.fetchone()[0])

    def test_shared_sellers_units_and_tashkent_boundary(self):
        with connection.transaction() as c:
            rows = prep.read_rows(c, 37, "2026-10-18")
        self.assertEqual([(r["unit"], r["quantity"]) for r in rows], [("dona", "15"), ("kg", "2.55")])
        self.assertTrue(prep.queue_day(10, "2026-10-18"))
        self.assertFalse(prep.queue_day(20, "2026-10-18"))
        text = self.payload()["preparation"]["chunks"][0]
        self.assertIn("15 dona", text)
        self.assertIn("2.55 kg", text)

    def test_retry_restart_and_revised_snapshot(self):
        prep.queue_day(10, "2026-10-18")
        bot = Mock()
        bot.send_message.side_effect = RuntimeError("network unavailable")
        with patch.object(prep.time, "time", return_value=0):
            prep.deliver_pending(bot)
        self.assertEqual(self.payload()["preparation"]["recipients"]["90001"], 0)
        bot.send_message.side_effect = None
        with patch.object(prep.time, "time", return_value=10000):
            for _ in range(4):
                prep.deliver_pending(bot)
        self.assertTrue(self.payload()["preparation_done"])
        self.assertEqual(bot.send_message.call_count, 3)  # failed + two recipients
        prep.deliver_pending(bot)
        self.assertEqual(bot.send_message.call_count, 3)
        self.sale(5, 10, 1, "2", "0.14", "2026-10-18 08:00:00+00")
        self.assertTrue(prep.queue_day(20, "2026-10-18"))
        self.assertNotIn("preparation_done", self.payload())
        self.assertEqual(self.payload()["preparation"]["revision"], 2)
        self.assertIn("17 dona", self.payload()["preparation"]["chunks"][0])

    def test_denied_or_missing_recipient_does_not_create_report(self):
        with self.assertRaises(ValueError):
            prep.queue_day(999, "2026-10-18")
        with patch.dict(os.environ, {"VEHICLE_REPLENISHMENT_TELEGRAM_CHAT_IDS": ""}):
            with self.assertRaises(ValueError):
                prep.queue_day(10, "2026-10-18")
        with connection.transaction() as c:
            c.execute("SELECT count(*) FROM distribution.vehicle_route_reports")
            self.assertEqual(c.fetchone()[0], 0)

    def test_long_report_splits_without_losing_products(self):
        rows = [{"name": "Long product " + str(i), "quantity": "1.500",
                 "unit": "kg"} for i in range(300)]
        chunks = prep.chunks_for(rows, "2026-10-18", 1)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(s) < 4096 for s in chunks))
        self.assertEqual(sum(s.count("• ") for s in chunks), 300)

    def test_menu_and_confirmation_for_both_seller_roles(self):
        import main
        with patch.object(main, "_pilot_kb_flag", return_value=True):
            for role in ("agent", "delivery"):
                buttons = json.loads(main.main_kb(role, 10).to_json())["keyboard"]
                self.assertIn(prep.BUTTON, [button["text"] for row in buttons for button in row])
        call = SimpleNamespace(id="callback", from_user=SimpleNamespace(id=10),
                               data="prepare_day:" + prep.today())
        with patch.object(main, "get_user", return_value=(1, 10)), \
             patch.object(main, "_is_vehicle_distribution_pilot_user", return_value=True), \
             patch.object(main, "get_state", return_value={"state": None}), \
             patch.object(main.bot, "send_message") as send, \
             patch.object(main.bot, "answer_callback_query"), \
             patch.object(main.dayprep, "queue_day", return_value=True) as queue:
            main.confirm_vehicle_day(call)
            queue.assert_called_once_with(10)
            self.assertIn("navbatiga", send.call_args.args[1])
            queue.reset_mock()
            call.data = "prepare_day:2000-01-01"
            main.confirm_vehicle_day(call)
            queue.assert_not_called()
