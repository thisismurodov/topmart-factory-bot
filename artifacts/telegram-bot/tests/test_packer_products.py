"""Packer mahsulot ro'yxati (get_products_for_packer) xatti-harakati testlari.

Qamrov:
  • Biriktirilmagan packer → barcha faol (in_production) mahsulotlar (fallback).
  • Biriktirilgan packer → faqat biriktirilgan faol mahsulotlar.
  • Biriktirilgan mahsulotlarning HAMMASI nofaol → BO'SH ro'yxat.
    Fallback butun katalogni ochib yubormasligi kerak — bu ataylab cheklangan
    packer uchun xavfsizlik teshigi bo'lardi. Keyboard bo'sh ro'yxatda
    "Mahsulotlar biriktirilmagan" tugmasini ko'rsatadi.

Izolyatsiya: bir martalik sxema (pid+timestamp bilan unikal). bot.database
setUpClass'da sxemaga patch qilinadi (env emas) — qo'shma discovery bilan mos.
"""

import os
import time
import unittest

import psycopg2

from tests._db_isolation import point_db_to_schema, restore_db_url, schema_url
from bot import database as db

SCHEMA = f"topmart_packer_test_{os.getpid()}_{int(time.time())}"


def _conn():
    return psycopg2.connect(schema_url(SCHEMA))


class PackerProductsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._old_url = point_db_to_schema(SCHEMA)
        conn = _conn()
        cur = conn.cursor()
        cur.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
        cur.execute(f"CREATE SCHEMA {SCHEMA}")
        cur.execute(
            """
            CREATE TABLE workers (
                name TEXT PRIMARY KEY,
                prefix TEXT NOT NULL DEFAULT '',
                phone TEXT NOT NULL DEFAULT '',
                role TEXT NOT NULL DEFAULT 'worker'
            );
            CREATE TABLE products (
                name TEXT PRIMARY KEY,
                rate_type TEXT NOT NULL DEFAULT 'dona',
                rate NUMERIC(12,2) NOT NULL DEFAULT 100,
                active BOOLEAN NOT NULL DEFAULT TRUE,
                in_production BOOLEAN NOT NULL DEFAULT TRUE
            );
            CREATE TABLE packer_product_assignments (
                id SERIAL PRIMARY KEY,
                packer_name TEXT NOT NULL REFERENCES workers(name) ON DELETE CASCADE,
                product_name TEXT NOT NULL REFERENCES products(name) ON DELETE CASCADE,
                UNIQUE (packer_name, product_name)
            );
            """
        )
        cur.execute(
            "INSERT INTO workers (name, role) VALUES "
            "('PackerFree','packer'), ('PackerLimited','packer'), ('PackerUnlucky','packer')"
        )
        cur.execute(
            "INSERT INTO products (name, active, in_production) VALUES "
            "('Arqon 4mm', TRUE, TRUE),"
            "('Arqon 6mm', TRUE, TRUE),"
            "('Eski mahsulot', FALSE, TRUE)"
        )
        # PackerLimited → faqat 'Arqon 4mm'; PackerUnlucky → faqat nofaol mahsulot.
        cur.execute(
            "INSERT INTO packer_product_assignments (packer_name, product_name) VALUES "
            "('PackerLimited','Arqon 4mm'), ('PackerUnlucky','Eski mahsulot')"
        )
        conn.commit()
        cur.close()
        conn.close()

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            conn = _conn()
            conn.cursor().execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
            conn.commit()
            conn.close()
        finally:
            restore_db_url(cls._old_url)

    def test_no_assignments_falls_back_to_all_active(self):
        self.assertEqual(
            db.get_products_for_packer("PackerFree"),
            ["Arqon 4mm", "Arqon 6mm"],
        )

    def test_assigned_sees_only_assigned_active(self):
        self.assertEqual(db.get_products_for_packer("PackerLimited"), ["Arqon 4mm"])

    def test_all_assigned_inactive_returns_empty_not_full_catalog(self):
        """Biriktirilgan mahsulotlar nofaol bo'lsa — bo'sh ro'yxat, fallback EMAS."""
        self.assertEqual(db.get_products_for_packer("PackerUnlucky"), [])

    def test_reactivating_assigned_product_restores_it(self):
        conn = _conn()
        cur = conn.cursor()
        cur.execute("UPDATE products SET active = TRUE WHERE name = 'Eski mahsulot'")
        conn.commit()
        try:
            self.assertEqual(
                db.get_products_for_packer("PackerUnlucky"), ["Eski mahsulot"]
            )
        finally:
            cur.execute("UPDATE products SET active = FALSE WHERE name = 'Eski mahsulot'")
            conn.commit()
            cur.close()
            conn.close()


if __name__ == "__main__":
    unittest.main()
