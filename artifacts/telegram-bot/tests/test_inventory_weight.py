"""Konteyner kilogrammlari (inventory.weight_kg) yaxlitligi testlari.

Bot tomonidagi mutatsiya yo'llarini tekshiradi:
  • create_batch_session — partiya KIRIM og'irlikni to'g'ri qo'shadi (jamlanadi).
  • record_movement OUT — saqlangan og'irlikdan proporsional ayiradi.
  • record_movement TRANSFER — qisman ko'chirishda og'irlik manbadan
    proporsional ayiriladi va qabul qiluvchiga qo'shiladi.

Izolyatsiya: barcha so'rovlar bir martalik (throwaway) sxemada bajariladi
(search_path libpq `options` parametri orqali beriladi), shu bois haqiqiy
ma'lumotlarga tegmaydi.
"""

import os
import unittest
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode, quote

import psycopg2
import psycopg2.extras

SCHEMA = "topmart_kg_bot_test"


def _test_database_url() -> str:
    base = os.environ["DATABASE_URL"]
    u = urlsplit(base)
    q = dict(parse_qsl(u.query))
    q["options"] = f"-c search_path={SCHEMA}"
    return urlunsplit((u.scheme, u.netloc, u.path, urlencode(q, quote_via=quote), u.fragment))


# Bot kodi DATABASE_URL'ni import paytida o'qiydi — shuning uchun import'dan
# OLDIN test sxemasiga yo'naltiramiz.
os.environ["DATABASE_URL"] = _test_database_url()

from bot import database as db  # noqa: E402


def _conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


class ContainerWeightTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        conn = _conn()
        cur = conn.cursor()
        cur.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
        cur.execute(f"CREATE SCHEMA {SCHEMA}")
        # Bot funksiyalari teguvchi jadvallarning minimal nusxalari.
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
                line_id INTEGER
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
            """
        )
        conn.commit()
        cur.close()
        conn.close()

    @classmethod
    def tearDownClass(cls) -> None:
        conn = _conn()
        cur = conn.cursor()
        cur.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
        conn.commit()
        cur.close()
        conn.close()

    def setUp(self) -> None:
        self.conn = _conn()
        self.cur = self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        self.cur.execute(
            "TRUNCATE inventory, stock_movements, batches RESTART IDENTITY"
        )
        self.cur.execute("TRUNCATE products, warehouses RESTART IDENTITY")
        # KG va dona mahsulot
        self.cur.execute(
            "INSERT INTO products (name, unit_type) VALUES ('TestKg','kg'), ('TestDona','dona')"
        )
        # Ikkita konteyner
        self.cur.execute(
            "INSERT INTO warehouses (name) VALUES ('C-A'),('C-B') RETURNING id"
        )
        self.conn.commit()
        self.cur.execute("SELECT id, name FROM warehouses ORDER BY id")
        rows = self.cur.fetchall()
        self.wh_a = rows[0]["id"]
        self.wh_b = rows[1]["id"]

    def tearDown(self) -> None:
        self.cur.close()
        self.conn.close()

    def _inv(self, warehouse_id: int, product: str):
        self.cur.execute(
            "SELECT quantity, weight_kg FROM inventory WHERE warehouse_id=%s AND product=%s",
            (warehouse_id, product),
        )
        return self.cur.fetchone()

    def _seed_inventory(self, warehouse_id, product, quantity, weight_kg):
        self.cur.execute(
            """INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type)
               VALUES (%s,%s,%s,%s,'finished')""",
            (warehouse_id, product, quantity, weight_kg),
        )
        self.conn.commit()

    # ── create_batch_session: KIRIM og'irligi ──────────────────────────────
    def test_batch_in_adds_and_accumulates_weight(self):
        db.create_batch_session(
            "Ali", "AL",
            [{"product": "TestKg", "quantity": 100, "weight_kg": 250.0, "earnings": 0}],
            warehouse_id=self.wh_a,
        )
        row = self._inv(self.wh_a, "TestKg")
        self.assertEqual(float(row["quantity"]), 100.0)
        self.assertAlmostEqual(float(row["weight_kg"]), 250.0, places=3)

        # Ikkinchi partiya — og'irlik jamlanadi (qo'shiladi, almashtirmaydi)
        db.create_batch_session(
            "Ali", "AL",
            [{"product": "TestKg", "quantity": 40, "weight_kg": 110.0, "earnings": 0}],
            warehouse_id=self.wh_a,
        )
        row = self._inv(self.wh_a, "TestKg")
        self.assertEqual(float(row["quantity"]), 140.0)
        self.assertAlmostEqual(float(row["weight_kg"]), 360.0, places=3)

    # ── record_movement IN: partiya nisbati bo'yicha og'irlik ──────────────
    def test_manual_in_adds_batch_ratio_weight(self):
        # Partiya nisbati 2.5 kg/dona (250/100) — KIRIM og'irligi shundan olinadi.
        self.cur.execute(
            "INSERT INTO batches (batch_code, product, quantity, weight_kg) VALUES ('B-1','TestKg',100,250)"
        )
        self.conn.commit()

        ok = db.record_movement("TestKg", 40, "IN", None, self.wh_a, product_type="finished")
        self.assertTrue(ok)

        row = self._inv(self.wh_a, "TestKg")
        # 40 * 2.5 = 100 kg
        self.assertEqual(float(row["quantity"]), 40.0)
        self.assertAlmostEqual(float(row["weight_kg"]), 100.0, places=3)

    def test_manual_in_dona_product_stays_weightless(self):
        ok = db.record_movement("TestDona", 25, "IN", None, self.wh_a, product_type="finished")
        self.assertTrue(ok)
        row = self._inv(self.wh_a, "TestDona")
        self.assertEqual(float(row["quantity"]), 25.0)
        self.assertAlmostEqual(float(row["weight_kg"]), 0.0, places=3)

    # ── record_movement OUT: proporsional ayirish ──────────────────────────
    def test_manual_out_subtracts_proportional_stored_weight(self):
        # Saqlangan nisbat 3.0 kg/dona (300/100).
        self._seed_inventory(self.wh_a, "TestKg", 100, 300)

        ok = db.record_movement("TestKg", 40, "OUT", self.wh_a, None, product_type="finished")
        self.assertTrue(ok)

        row = self._inv(self.wh_a, "TestKg")
        # 300 * 40/100 = 120 ayiriladi → 60 dona / 180 kg
        self.assertEqual(float(row["quantity"]), 60.0)
        self.assertAlmostEqual(float(row["weight_kg"]), 180.0, places=3)

    # ── record_movement TRANSFER: qisman ko'chirish ────────────────────────
    def test_partial_transfer_moves_proportional_weight(self):
        self._seed_inventory(self.wh_a, "TestKg", 100, 300)

        ok = db.record_movement("TestKg", 40, "TRANSFER", self.wh_a, self.wh_b, product_type="finished")
        self.assertTrue(ok)

        src = self._inv(self.wh_a, "TestKg")
        dst = self._inv(self.wh_b, "TestKg")
        # moveWeight = 300 * 40/100 = 120
        self.assertEqual(float(src["quantity"]), 60.0)
        self.assertAlmostEqual(float(src["weight_kg"]), 180.0, places=3)
        self.assertEqual(float(dst["quantity"]), 40.0)
        self.assertAlmostEqual(float(dst["weight_kg"]), 120.0, places=3)


if __name__ == "__main__":
    unittest.main()
