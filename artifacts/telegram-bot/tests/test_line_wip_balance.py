"""get_line_wip_balance — mahsulot tanlanganda ko'rsatiladigan WIP balansi.

Tekshiradi:
  • Liniyaga bog'langan mahsulot uchun RECEIVE − PRODUCE (kg) qaytadi.
  • Harakatlari bo'lmagan liniya uchun 0.0 qaytadi.
  • Liniyaga bog'lanmagan mahsulot uchun None qaytadi.

Izolyatsiya: throwaway sxema (search_path libpq `options` orqali).
"""

import os
import time
import unittest

import psycopg2

from tests._db_isolation import point_db_to_schema, restore_db_url, schema_url
from bot import database as db

SCHEMA = f"topmart_wipbal_test_{os.getpid()}_{int(time.time())}"


def _conn():
    return psycopg2.connect(schema_url(SCHEMA))


class LineWipBalanceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._old_url = point_db_to_schema(SCHEMA)
        conn = _conn()
        cur = conn.cursor()
        cur.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
        cur.execute(f"CREATE SCHEMA {SCHEMA}")
        cur.execute(
            """
            CREATE TABLE production_lines (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL UNIQUE
            );
            CREATE TABLE products (
                name TEXT PRIMARY KEY,
                line_id INTEGER
            );
            CREATE TABLE wip_movements (
                id SERIAL PRIMARY KEY,
                line_id INTEGER NOT NULL,
                movement_type TEXT NOT NULL,
                product TEXT,
                weight_kg NUMERIC(12,3) NOT NULL DEFAULT 0,
                note TEXT NOT NULL DEFAULT '',
                created_by TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            );
            """
        )
        cur.execute("INSERT INTO production_lines (name) VALUES ('Arqon'), ('Ip') RETURNING id")
        cur.execute("SELECT id FROM production_lines ORDER BY id")
        ids = [r[0] for r in cur.fetchall()]
        cls.line_arqon, cls.line_ip = ids[0], ids[1]
        cur.execute(
            "INSERT INTO products (name, line_id) VALUES "
            "('Arqon 8mm', %s), ('Ip 2mm', %s), ('Boshqa', NULL)",
            (cls.line_arqon, cls.line_ip),
        )
        cur.execute(
            """INSERT INTO wip_movements (line_id, movement_type, weight_kg) VALUES
               (%s, 'RECEIVE', 100.0),
               (%s, 'PRODUCE', 30.5),
               (%s, 'RECEIVE', 10.0)""",
            (cls.line_arqon, cls.line_arqon, cls.line_arqon),
        )
        conn.commit()
        conn.close()

    @classmethod
    def tearDownClass(cls) -> None:
        conn = _conn()
        cur = conn.cursor()
        cur.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
        conn.commit()
        conn.close()
        restore_db_url(cls._old_url)

    def test_receive_minus_produce(self):
        res = db.get_line_wip_balance("Arqon 8mm")
        self.assertIsNotNone(res)
        self.assertEqual(res["line_name"], "Arqon")
        self.assertAlmostEqual(res["wip_kg"], 79.5, places=3)

    def test_line_without_movements_is_zero(self):
        res = db.get_line_wip_balance("Ip 2mm")
        self.assertIsNotNone(res)
        self.assertEqual(res["line_name"], "Ip")
        self.assertEqual(res["wip_kg"], 0.0)

    def test_product_without_line_returns_none(self):
        self.assertIsNone(db.get_line_wip_balance("Boshqa"))

    def test_unknown_product_returns_none(self):
        self.assertIsNone(db.get_line_wip_balance("Yo'q mahsulot"))


if __name__ == "__main__":
    unittest.main()
