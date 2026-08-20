"""Liniya maoshining individual va pooled kun-yopish formulasi.

Arqon Bo'lim 3 live konfiguratsiyasiga teng ssenariy:
  • uch chiqaruvchi o'z KG'i × 1125 bo'yicha alohida;
  • ikki Pochkalash xodimi jami KG × 750 poolini teng bo'lib oladi;
  • bitta Ip O'rovchi jami KG × 375 oladi;
  • qayta yopish muzlatilgan snapshotni qaytaradi va yangi yozuv yaratmaydi.
"""

import os
import time
import unittest

import psycopg2
import psycopg2.extras

from tests._db_isolation import point_db_to_schema, restore_db_url, schema_url
from bot import database as db

SCHEMA = f"topmart_line_payroll_test_{os.getpid()}_{int(time.time())}"


def _conn():
    return psycopg2.connect(schema_url(SCHEMA))


class LinePayrollCloseDayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._old_url = point_db_to_schema(SCHEMA)
        conn = _conn()
        cur = conn.cursor()
        cur.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
        cur.execute(f"CREATE SCHEMA {SCHEMA}")
        cur.execute(
            """
            CREATE TABLE payroll_role_rates (
                scope TEXT NOT NULL,
                role TEXT NOT NULL,
                rate NUMERIC NOT NULL
            );
            CREATE TABLE production_lines (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL
            );
            CREATE TABLE line_role_config (
                id SERIAL PRIMARY KEY,
                line_id INTEGER NOT NULL,
                role_key TEXT NOT NULL,
                label TEXT NOT NULL,
                rate NUMERIC NOT NULL,
                max_workers INTEGER NOT NULL,
                pay_mode TEXT NOT NULL DEFAULT 'pooled'
            );
            CREATE TABLE production_line_workers (
                id SERIAL PRIMARY KEY,
                line_id INTEGER NOT NULL,
                worker_name TEXT NOT NULL,
                role TEXT NOT NULL
            );
            CREATE TABLE products (
                name TEXT PRIMARY KEY,
                rate_type TEXT NOT NULL,
                line_id INTEGER
            );
            CREATE TABLE batches (
                id SERIAL PRIMARY KEY,
                worker TEXT NOT NULL,
                product TEXT NOT NULL,
                quantity INTEGER NOT NULL,
                weight_kg NUMERIC NOT NULL,
                payroll_method TEXT NOT NULL,
                production_line_id INTEGER,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE TABLE salary_entries (
                id SERIAL PRIMARY KEY,
                scope TEXT NOT NULL,
                line_id INTEGER,
                worker TEXT NOT NULL,
                role TEXT NOT NULL,
                source_type TEXT NOT NULL,
                work_date DATE NOT NULL,
                kg NUMERIC NOT NULL,
                rate NUMERIC NOT NULL,
                amount NUMERIC NOT NULL
            );
            CREATE UNIQUE INDEX salary_entries_daily_shared_uniq
              ON salary_entries (scope, worker, role, work_date)
              WHERE source_type='daily_shared';
            CREATE TABLE daily_payroll_runs (
                id SERIAL PRIMARY KEY,
                scope TEXT NOT NULL,
                line_id INTEGER NOT NULL,
                work_date DATE NOT NULL,
                total_kg NUMERIC NOT NULL,
                status TEXT NOT NULL,
                closed_by TEXT NOT NULL,
                closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (scope, work_date, line_id)
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
            """TRUNCATE salary_entries, daily_payroll_runs, batches,
                        production_line_workers, line_role_config, products,
                        production_lines, payroll_role_rates
               RESTART IDENTITY"""
        )
        self.cur.execute(
            "INSERT INTO production_lines (name) VALUES ('Arqon Bo''lim 3') RETURNING id"
        )
        self.line = int(self.cur.fetchone()["id"])
        self.cur.executemany(
            """INSERT INTO line_role_config
                 (line_id, role_key, label, rate, max_workers, pay_mode)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            [
                (self.line, "IShlabchiqaruvchi", "Chiqaruvchi", 1125, 5, "individual"),
                (self.line, "pock", "Pochkalash", 750, 2, "pooled"),
                (self.line, "Uvopchi", "Ip O'rovchi", 375, 5, "pooled"),
            ],
        )
        self.cur.executemany(
            """INSERT INTO production_line_workers (line_id, worker_name, role)
               VALUES (%s, %s, %s)""",
            [
                (self.line, "Aziza", "IShlabchiqaruvchi"),
                (self.line, "Gullola", "IShlabchiqaruvchi"),
                (self.line, "Xusnida", "IShlabchiqaruvchi"),
                (self.line, "Dilnoza", "pock"),
                (self.line, "Madina M", "pock"),
                (self.line, "Zulxumor", "Uvopchi"),
            ],
        )
        self.cur.execute(
            """INSERT INTO products (name, rate_type, line_id)
               VALUES ('Ikki Qavat Arqon | 4 kg', 'kg', %s)""",
            (self.line,),
        )
        self.cur.executemany(
            """INSERT INTO batches
                 (worker, product, quantity, weight_kg, payroll_method,
                  production_line_id, created_at)
               VALUES (%s, 'Ikki Qavat Arqon | 4 kg', 1, %s,
                       'ROLE_BASED_KG', %s, NOW())""",
            [
                ("Aziza", 55.60, self.line),
                ("Gullola", 46.60, self.line),
                ("Xusnida", 5.95, self.line),
            ],
        )
        self.conn.commit()

    def tearDown(self) -> None:
        self.cur.close()
        self.conn.close()

    def test_individual_producers_and_equal_pooled_helpers_are_frozen(self):
        first = db.close_day("test-admin")

        self.assertFalse(first["already_closed"])
        self.assertAlmostEqual(first["total_kg"], 108.15, places=3)
        self.assertEqual(len(first["new_entries"]), 6)
        line = first["lines"][0]
        self.assertEqual(line["line_name"], "Arqon Bo'lim 3")
        self.assertAlmostEqual(line["total_kg"], 108.15, places=3)

        entries = {
            (e["role"], e["worker"]): e
            for e in line["entries"]
        }
        expected_amounts = {
            ("IShlabchiqaruvchi", "Aziza"): 55.60 * 1125,
            ("IShlabchiqaruvchi", "Gullola"): 46.60 * 1125,
            ("IShlabchiqaruvchi", "Xusnida"): 5.95 * 1125,
            ("pock", "Dilnoza"): 108.15 * 750 / 2,
            ("pock", "Madina M"): 108.15 * 750 / 2,
            ("Uvopchi", "Zulxumor"): 108.15 * 375,
        }
        self.assertEqual(set(entries), set(expected_amounts))
        for key, amount in expected_amounts.items():
            self.assertAlmostEqual(entries[key]["amount"], amount, places=3)

        self.cur.execute(
            """SELECT worker, role, kg, rate, amount
               FROM salary_entries ORDER BY role, worker"""
        )
        stored = {(r["role"], r["worker"]): r for r in self.cur.fetchall()}
        self.assertEqual(len(stored), 6)
        self.assertAlmostEqual(float(stored[("IShlabchiqaruvchi", "Aziza")]["kg"]), 55.60, places=3)
        self.assertAlmostEqual(float(stored[("IShlabchiqaruvchi", "Gullola")]["kg"]), 46.60, places=3)
        self.assertAlmostEqual(float(stored[("IShlabchiqaruvchi", "Xusnida")]["kg"]), 5.95, places=3)
        self.assertAlmostEqual(float(stored[("pock", "Dilnoza")]["kg"]), 108.15, places=3)
        self.assertAlmostEqual(float(stored[("pock", "Madina M")]["kg"]), 108.15, places=3)
        self.assertAlmostEqual(float(stored[("Uvopchi", "Zulxumor")]["kg"]), 108.15, places=3)

        # Yopilgandan keyingi stavka/batch o'zgarishi tarixiy snapshotga tegmaydi.
        self.cur.execute("UPDATE line_role_config SET rate=9999")
        self.cur.execute(
            """INSERT INTO batches
                 (worker, product, quantity, weight_kg, payroll_method,
                  production_line_id, created_at)
               VALUES ('Aziza', 'Ikki Qavat Arqon | 4 kg', 1, 10,
                       'ROLE_BASED_KG', %s, NOW())""",
            (self.line,),
        )
        self.conn.commit()

        second = db.close_day("test-admin-again")
        self.assertTrue(second["already_closed"])
        self.assertEqual(second["new_entries"], [])
        self.assertAlmostEqual(second["total_kg"], 108.15, places=3)

        self.cur.execute("SELECT COUNT(*) AS c FROM salary_entries")
        self.assertEqual(int(self.cur.fetchone()["c"]), 6)
        self.cur.execute("SELECT COUNT(*) AS c FROM daily_payroll_runs")
        self.assertEqual(int(self.cur.fetchone()["c"]), 1)
        self.cur.execute(
            "SELECT amount FROM salary_entries WHERE worker='Aziza' AND role='IShlabchiqaruvchi'"
        )
        self.assertAlmostEqual(float(self.cur.fetchone()["amount"]), 55.60 * 1125, places=3)

        # Partial/legacy holat: salary row bor, daily run yo'q. Conflict bo'lgan
        # satr yangi deb qaytmasligi va xabarga tushmasligi kerak.
        self.cur.execute(
            "INSERT INTO production_lines (name) VALUES ('Conflict liniya') RETURNING id"
        )
        conflict_line = int(self.cur.fetchone()["id"])
        self.cur.execute(
            """INSERT INTO line_role_config
                 (line_id, role_key, label, rate, max_workers, pay_mode)
               VALUES (%s, 'producer', 'Chiqaruvchi', 1000, 1, 'individual')""",
            (conflict_line,),
        )
        self.cur.execute(
            """INSERT INTO production_line_workers (line_id, worker_name, role)
               VALUES (%s, 'Conflict Worker', 'producer')""",
            (conflict_line,),
        )
        self.cur.execute(
            """INSERT INTO products (name, rate_type, line_id)
               VALUES ('Conflict mahsulot', 'kg', %s)""",
            (conflict_line,),
        )
        self.cur.execute(
            """INSERT INTO batches
                 (worker, product, quantity, weight_kg, payroll_method,
                  production_line_id, created_at)
               VALUES ('Conflict Worker', 'Conflict mahsulot', 1, 7,
                       'ROLE_BASED_KG', %s, NOW())""",
            (conflict_line,),
        )
        self.cur.execute(
            """INSERT INTO salary_entries
                 (scope, line_id, worker, role, source_type, work_date, kg, rate, amount)
               VALUES ('arqon', %s, 'Conflict Worker', 'producer',
                       'daily_shared', %s, 7, 1000, 7000)""",
            (conflict_line, first["work_date"]),
        )
        self.conn.commit()

        conflict = db.close_day("test-conflict")
        self.assertFalse(conflict["already_closed"])
        self.assertEqual(conflict["new_entries"], [])
        conflict_result = next(
            line for line in conflict["lines"] if line["line_id"] == conflict_line
        )
        self.assertEqual(conflict_result["entries"], [])
        self.cur.execute("SELECT COUNT(*) AS c FROM salary_entries")
        self.assertEqual(int(self.cur.fetchone()["c"]), 7)
        self.cur.execute("SELECT COUNT(*) AS c FROM daily_payroll_runs")
        self.assertEqual(int(self.cur.fetchone()["c"]), 2)


if __name__ == "__main__":
    unittest.main()