"""WIP balans himoyasi (create_batch_session) testlari.

Bot operatori bo'limda xom ashyo bo'lmasa ham ortiqcha mahsulot yozib
yubormasligini tekshiradi:
  • produce_kg > WIP balans (tarix bo'sh) → WipBalanceError; batches /
    wip_movements / inventory / stock_movements'ga HECH NARSA yozilmaydi.
  • produce_kg = 0 (weight_kg=0, product.weight=0) → eski (legacy) oqim
    bloklanmaydi, partiya yoziladi, WIP ledger'ga yozuv tushmaydi.
  • produce_kg <= WIP balans → muvaffaqiyat, ledger balansi to'g'ri kamayadi.

Izolyatsiya: barcha so'rovlar bir martalik (throwaway) sxemada bajariladi
(search_path libpq `options` orqali), haqiqiy ma'lumotlarga tegmaydi.
"""

import os
import time
import unittest

import psycopg2
import psycopg2.extras

from tests._db_isolation import point_db_to_schema, restore_db_url, schema_url
from bot import database as db

SCHEMA = f"topmart_wip_guard_test_{os.getpid()}_{int(time.time())}"


def _conn():
    return psycopg2.connect(schema_url(SCHEMA))


class WipBalanceGuardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._old_url = point_db_to_schema(SCHEMA)
        conn = _conn()
        cur = conn.cursor()
        cur.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
        cur.execute(f"CREATE SCHEMA {SCHEMA}")
        # create_batch_session teguvchi jadvallarning minimal nusxalari.
        cur.execute(
            """
            CREATE TABLE warehouses (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                active BOOLEAN NOT NULL DEFAULT TRUE,
                location_type TEXT NOT NULL DEFAULT 'container',
                capacity_kg NUMERIC DEFAULT 20000
            );
            CREATE TABLE production_lines (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL
            );
            CREATE TABLE products (
                name TEXT PRIMARY KEY,
                unit_type TEXT NOT NULL DEFAULT 'dona',
                payroll_method TEXT NOT NULL DEFAULT 'PRODUCT_RATE',
                line_id INTEGER,
                weight NUMERIC(12,3) NOT NULL DEFAULT 1
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
            """
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
            restore_db_url(cls._old_url)

    def setUp(self) -> None:
        self.conn = _conn()
        self.cur = self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        self.cur.execute(
            "TRUNCATE inventory, stock_movements, batches, wip_movements RESTART IDENTITY"
        )
        self.cur.execute(
            "TRUNCATE products, warehouses, production_lines RESTART IDENTITY"
        )
        self.cur.execute("INSERT INTO warehouses (name) VALUES ('C-A') RETURNING id")
        self.wh = self.cur.fetchone()["id"]
        self.cur.execute("INSERT INTO production_lines (name) VALUES ('Arqon') RETURNING id")
        self.line = self.cur.fetchone()["id"]
        # KG mahsulot liniyaga bog'langan → WIP guard ishga tushadi;
        # LegacyDona: weight=0 → produce_kg=0 (eski oqim).
        self.cur.execute(
            "INSERT INTO products (name, unit_type, line_id, weight) VALUES "
            "('GuardKg','kg',%s,1), ('LegacyDona','dona',%s,0)",
            (self.line, self.line),
        )
        self.conn.commit()

    def tearDown(self) -> None:
        self.cur.close()
        self.conn.close()

    def _count(self, table: str) -> int:
        self.cur.execute(f"SELECT COUNT(*) AS c FROM {table}")
        return int(self.cur.fetchone()["c"])

    def _wip_balance(self) -> float:
        self.cur.execute(
            """SELECT COALESCE(SUM(
                   CASE WHEN movement_type='RECEIVE' THEN weight_kg
                        WHEN movement_type='PRODUCE' THEN -weight_kg
                        ELSE 0 END), 0)::numeric AS b
               FROM wip_movements WHERE line_id=%s""",
            (self.line,),
        )
        return float(self.cur.fetchone()["b"])

    def _receive(self, kg: float) -> None:
        self.cur.execute(
            "INSERT INTO wip_movements (line_id, movement_type, weight_kg) "
            "VALUES (%s,'RECEIVE',%s)",
            (self.line, kg),
        )
        self.conn.commit()

    # ── 1) Tarix bo'sh, produce_kg > 0 → rad, hech narsa yozilmaydi ─────────
    def test_overstated_output_with_no_wip_history_is_rejected(self):
        with self.assertRaises(db.WipBalanceError):
            db.create_batch_session(
                "Ali", "AL",
                [{"product": "GuardKg", "quantity": 10, "weight_kg": 50.0, "earnings": 0}],
                warehouse_id=self.wh,
            )
        # Butun sessiya rollback bo'lgan — hech qaysi jadvalga iz qolmagan.
        self.assertEqual(self._count("batches"), 0)
        self.assertEqual(self._count("wip_movements"), 0)
        self.assertEqual(self._count("inventory"), 0)
        self.assertEqual(self._count("stock_movements"), 0)

    # ── 2) produce_kg = 0 (legacy) → tarix bo'lmasa ham o'tadi ──────────────
    def test_zero_produce_kg_allowed_without_history(self):
        res = db.create_batch_session(
            "Ali", "AL",
            [{"product": "LegacyDona", "quantity": 15, "weight_kg": 0, "earnings": 0}],
            warehouse_id=self.wh,
        )
        self.assertTrue(res["batch_code"])
        self.assertEqual(self._count("batches"), 1)
        # WIP ledger'ga PRODUCE tushmaydi (produce_kg = 0).
        self.assertEqual(self._count("wip_movements"), 0)
        self.cur.execute(
            "SELECT quantity FROM inventory WHERE warehouse_id=%s AND product='LegacyDona'",
            (self.wh,),
        )
        self.assertEqual(float(self.cur.fetchone()["quantity"]), 15.0)

    # ── 3) produce_kg <= balans → o'tadi, ledger balansi to'g'ri ────────────
    def test_within_balance_succeeds_and_ledger_correct(self):
        self._receive(100.0)
        db.create_batch_session(
            "Ali", "AL",
            [{"product": "GuardKg", "quantity": 20, "weight_kg": 60.0, "earnings": 0}],
            warehouse_id=self.wh,
        )
        self.assertEqual(self._count("batches"), 1)
        self.cur.execute(
            "SELECT weight_kg FROM wip_movements WHERE movement_type='PRODUCE' AND product='GuardKg'"
        )
        rows = self.cur.fetchall()
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(float(rows[0]["weight_kg"]), 60.0, places=3)
        self.assertAlmostEqual(self._wip_balance(), 40.0, places=3)

    # ── 4) Bir sessiyada bir necha mahsulot balansdan oshib ketsa → rad ─────
    def test_multi_item_session_overdraw_rejected_atomically(self):
        self._receive(100.0)
        with self.assertRaises(db.WipBalanceError):
            db.create_batch_session(
                "Ali", "AL",
                [
                    {"product": "GuardKg", "quantity": 20, "weight_kg": 60.0, "earnings": 0},
                    {"product": "GuardKg", "quantity": 20, "weight_kg": 60.0, "earnings": 0},
                ],
                warehouse_id=self.wh,
            )
        # Birinchi item ham rollback bo'ladi — sessiya atomar.
        self.assertEqual(self._count("batches"), 0)
        self.assertEqual(self._count("inventory"), 0)
        self.assertEqual(self._count("stock_movements"), 0)
        self.assertAlmostEqual(self._wip_balance(), 100.0, places=3)


if __name__ == "__main__":
    unittest.main()
