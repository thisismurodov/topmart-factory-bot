"""Manfiy WIP balans Telegram ogohlantirishi testlari (yozuvchi tomonda).

Real yozuvchi orqali tekshiradi: `create_batch_session` commit'dan keyin
sessiya tegib o'tgan liniyalarning haqiqiy balansini o'qiydi va minus bo'lsa
adminlarga Telegram xabar yuboradi (soxta Telegram HTTP serveriga) —
dashboard /ombor/flow endpointi chaqirilmasdan.

Dedupe: wip_negative_alerts jadvali orqali kuniga liniya boshiga 1 marta.

Izolyatsiya: throwaway sxema (search_path) — test_inventory_weight.py bilan
bir xil naqsh; DATABASE_URL env'iga tegilmaydi (bot.database globalini patch).
"""

import json
import os
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import psycopg2
import psycopg2.extras

from tests._db_isolation import point_db_to_schema, restore_db_url, schema_url
from bot import database as db
from bot import wip_alerts

SCHEMA = f"topmart_kg_wipalert_test_{os.getpid()}_{int(time.time())}"

ADMIN_CHAT_1 = "111111"
ADMIN_CHAT_2 = "222222"

# Soxta Telegram API qabul qilgan sendMessage so'rovlari.
SENT: list[dict] = []


class _FakeTelegramHandler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path.endswith("/sendMessage"):
            SENT.append({"path": self.path, "chat_id": str(body.get("chat_id")),
                         "text": str(body.get("text"))})
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *args):  # jim
        pass


def _conn():
    return psycopg2.connect(schema_url(SCHEMA))


class NegativeWipAlertTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._old_url = point_db_to_schema(SCHEMA)
        cls._old_env = {k: os.environ.get(k)
                        for k in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_API_BASE", "ADMIN_CHAT_ID")}
        cls._tg = ThreadingHTTPServer(("127.0.0.1", 0), _FakeTelegramHandler)
        threading.Thread(target=cls._tg.serve_forever, daemon=True).start()
        os.environ["TELEGRAM_BOT_TOKEN"] = "test-token"
        os.environ["TELEGRAM_API_BASE"] = f"http://127.0.0.1:{cls._tg.server_address[1]}"
        os.environ.pop("ADMIN_CHAT_ID", None)

        conn = _conn()
        cur = conn.cursor()
        cur.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
        cur.execute(f"CREATE SCHEMA {SCHEMA}")
        cur.execute(
            """
            CREATE TABLE warehouses (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                active BOOLEAN NOT NULL DEFAULT TRUE,
                location_type TEXT NOT NULL DEFAULT 'container',
                capacity_kg NUMERIC DEFAULT 20000
            );
            CREATE TABLE products (
                name TEXT PRIMARY KEY,
                unit_type TEXT NOT NULL DEFAULT 'dona',
                payroll_method TEXT NOT NULL DEFAULT 'PRODUCT_RATE',
                line_id INTEGER,
                weight NUMERIC(12,3) NOT NULL DEFAULT 1
            );
            CREATE TABLE production_lines (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                active BOOLEAN NOT NULL DEFAULT TRUE
            );
            CREATE TABLE production_line_workers (
                worker_name TEXT NOT NULL,
                role TEXT NOT NULL,
                line_id INTEGER
            );
            CREATE TABLE line_role_config (
                line_id INTEGER NOT NULL,
                role TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE raw_materials (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                unit TEXT NOT NULL DEFAULT 'kg',
                minimum_stock NUMERIC NOT NULL DEFAULT 0,
                current_stock NUMERIC NOT NULL DEFAULT 0
            );
            CREATE TABLE product_materials (
                id SERIAL PRIMARY KEY,
                product_name TEXT NOT NULL,
                raw_material_id INTEGER NOT NULL,
                quantity_required NUMERIC NOT NULL DEFAULT 0
            );
            CREATE TABLE batches (
                id SERIAL PRIMARY KEY,
                batch_code TEXT NOT NULL,
                worker TEXT NOT NULL DEFAULT '',
                product TEXT NOT NULL,
                quantity INTEGER NOT NULL,
                weight_kg NUMERIC(10,3) NOT NULL DEFAULT 0,
                earnings NUMERIC(12,2) NOT NULL DEFAULT 0,
                payroll_method TEXT NOT NULL DEFAULT 'PRODUCT_RATE',
                production_line_id INTEGER,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE TABLE production_labels (
                id SERIAL PRIMARY KEY, barcode_value TEXT NOT NULL, batch_id INTEGER,
                batch_code TEXT NOT NULL, label_type TEXT NOT NULL, label_number INTEGER NOT NULL,
                total_labels INTEGER NOT NULL, pieces_in_label INTEGER NOT NULL,
                pieces_per_box INTEGER NOT NULL, quantity_total INTEGER NOT NULL,
                weight_kg NUMERIC NOT NULL, length_m NUMERIC, product_name TEXT NOT NULL,
                product_sku TEXT NOT NULL, worker_name TEXT NOT NULL, produced_at TIMESTAMPTZ NOT NULL,
                warehouse_id INTEGER, warehouse_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'created',
                print_count INTEGER NOT NULL DEFAULT 0, last_printed_at TIMESTAMPTZ
            );
            CREATE TABLE inventory (
                id SERIAL PRIMARY KEY,
                warehouse_id INTEGER NOT NULL,
                product TEXT NOT NULL,
                quantity NUMERIC NOT NULL DEFAULT 0,
                weight_kg NUMERIC NOT NULL DEFAULT 0,
                product_type TEXT NOT NULL DEFAULT 'finished',
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (warehouse_id, product)
            );
            CREATE TABLE stock_movements (
                id SERIAL PRIMARY KEY,
                product TEXT NOT NULL,
                quantity NUMERIC NOT NULL,
                movement_type TEXT NOT NULL,
                from_warehouse_id INTEGER,
                to_warehouse_id INTEGER,
                note TEXT NOT NULL DEFAULT '',
                created_by TEXT NOT NULL DEFAULT '',
                product_type TEXT NOT NULL DEFAULT 'finished',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE TABLE wip_movements (
                id SERIAL PRIMARY KEY,
                line_id INTEGER NOT NULL,
                movement_type TEXT NOT NULL,
                raw_material TEXT,
                product TEXT,
                weight_kg NUMERIC(12,3) NOT NULL DEFAULT 0,
                from_warehouse_id INTEGER,
                batch_id INTEGER,
                note TEXT NOT NULL DEFAULT '',
                created_by TEXT NOT NULL DEFAULT 'admin',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE TABLE user_roles (
                chat_id BIGINT PRIMARY KEY,
                worker_name TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'worker'
            );
            CREATE TABLE wip_negative_alerts (
                line_id INTEGER NOT NULL,
                alert_date DATE NOT NULL,
                wip_kg NUMERIC(12,3) NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (line_id, alert_date)
            );
            """
        )
        cur.execute("INSERT INTO warehouses (name) VALUES ('Tayyor ombor (wip alert test)')")
        cur.execute(
            "INSERT INTO user_roles (chat_id, worker_name, role) VALUES "
            "(%s,'Admin Bir','admin'), (%s,'Admin Ikki','admin'), (333333,'Ishchi','worker')",
            (ADMIN_CHAT_1, ADMIN_CHAT_2),
        )
        conn.commit()
        cur.close()
        conn.close()

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            conn = _conn()
            cur = conn.cursor()
            cur.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
            conn.commit()
            cur.close()
            conn.close()
        finally:
            cls._tg.shutdown()
            for k, v in cls._old_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            restore_db_url(cls._old_url)

    def setUp(self) -> None:
        SENT.clear()
        conn = _conn()
        cur = conn.cursor()
        cur.execute("TRUNCATE wip_movements, wip_negative_alerts, batches, "
                    "inventory, stock_movements, products, production_lines "
                    "RESTART IDENTITY")
        conn.commit()
        cur.close()
        conn.close()

    # ── yordamchilar ──────────────────────────────────────────────────────
    def _mk_line(self, name: str) -> int:
        conn = _conn()
        cur = conn.cursor()
        cur.execute("INSERT INTO production_lines (name) VALUES (%s) RETURNING id", (name,))
        line_id = cur.fetchone()[0]
        conn.commit()
        cur.close()
        conn.close()
        return line_id

    def _mk_product(self, name: str, line_id: int, weight: float) -> None:
        conn = _conn()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO products (name, line_id, weight) VALUES (%s,%s,%s)",
            (name, line_id, weight),
        )
        conn.commit()
        cur.close()
        conn.close()

    def _add_wip(self, line_id: int, mtype: str, kg: float) -> None:
        conn = _conn()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO wip_movements (line_id, movement_type, weight_kg) VALUES (%s,%s,%s)",
            (line_id, mtype, kg),
        )
        conn.commit()
        cur.close()
        conn.close()

    # ── testlar ───────────────────────────────────────────────────────────
    def test_batch_writer_alerts_admins_when_balance_is_negative(self):
        """Real yozuvchi (create_batch_session) manfiy balansni topib xabar yuboradi.

        Manfiy balans tarixiy/qo'lda yozuvdan keladi (himoya kiritilishidan
        oldingi PRODUCE) — yangi partiya yozuvi o'sha liniyaga tegishi bilan
        commit'dan keyin adminlarga xabar ketishi kerak.
        """
        line_id = self._mk_line("Makaron bo'limi (neg)")
        self._add_wip(line_id, "RECEIVE", 10)
        self._add_wip(line_id, "PRODUCE", 15)  # tarixiy yozuv → balans −5
        # Og'irliksiz mahsulot: produce_kg=0 — WIP himoyasi bloklamaydi,
        # lekin liniya sessiyada "tegilgan" bo'ladi.
        self._mk_product("Etiketka (0 kg)", line_id, 0)

        db.create_batch_session(
            "Tester", "TS", [{"product": "Etiketka (0 kg)", "quantity": 3, "weight_kg": 0}],
        )

        self.assertEqual(len(SENT), 2)
        self.assertEqual({s["chat_id"] for s in SENT}, {ADMIN_CHAT_1, ADMIN_CHAT_2})
        for s in SENT:
            self.assertIn("Makaron bo'limi (neg)", s["text"])
            self.assertIn("5.00 kg", s["text"])
            self.assertIn("minus", s["text"])
            self.assertIn("/bottest-token/sendMessage", s["path"])

        conn = _conn()
        cur = conn.cursor()
        cur.execute("SELECT line_id FROM wip_negative_alerts")
        rows = cur.fetchall()
        cur.close()
        conn.close()
        self.assertEqual([r[0] for r in rows], [line_id])

    def test_no_duplicate_alert_same_day(self):
        line_id = self._mk_line("Makaron bo'limi (dedupe)")
        self._add_wip(line_id, "RECEIVE", 10)
        self._add_wip(line_id, "PRODUCE", 15)
        self._mk_product("Etiketka (dedupe)", line_id, 0)

        item = [{"product": "Etiketka (dedupe)", "quantity": 1, "weight_kg": 0}]
        db.create_batch_session("Tester", "TS", item)
        self.assertEqual(len(SENT), 2)
        db.create_batch_session("Tester", "TS", item)  # o'sha kun — dedupe
        self.assertEqual(len(SENT), 2)

    def test_no_alert_when_balance_stays_non_negative(self):
        line_id = self._mk_line("Makaron bo'limi (ok)")
        self._add_wip(line_id, "RECEIVE", 20)
        self._mk_product("Makaron 5kg (ok)", line_id, 5)

        db.create_batch_session(
            "Tester", "TS", [{"product": "Makaron 5kg (ok)", "quantity": 1, "weight_kg": 5}],
        )  # balans 20 − 5 = 15

        self.assertEqual(SENT, [])
        conn = _conn()
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM wip_negative_alerts")
        self.assertEqual(cur.fetchone()[0], 0)
        cur.close()
        conn.close()

    def test_helper_never_raises_without_token(self):
        os.environ.pop("TELEGRAM_BOT_TOKEN", None)
        try:
            self.assertEqual(wip_alerts.check_and_notify_negative_wip([1, 2]), [])
        finally:
            os.environ["TELEGRAM_BOT_TOKEN"] = "test-token"


if __name__ == "__main__":
    unittest.main()
