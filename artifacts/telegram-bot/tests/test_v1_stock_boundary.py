import unittest
from contextlib import contextmanager
from unittest.mock import Mock, patch
from bot import database


class V1StockBoundaryTests(unittest.TestCase):
    def test_protected_warehouses_reject_every_generic_movement_before_writes(self):
        for kind in ("IN", "OUT", "TRANSFER"):
            for name, location in (("C-03", "general"), (" c-03 ", "container"), ("Truck", "vehicle")):
                with self.subTest(kind=kind, name=name):
                    conn, cur = Mock(), Mock()
                    cur.fetchall.return_value = [{"id": 1, "name": name, "location_type": location}]
                    @contextmanager
                    def connect():
                        yield conn, cur
                    with patch.object(database, "get_conn", connect):
                        self.assertFalse(database.record_movement(
                            "Test", 1, kind, 1 if kind != "IN" else None,
                            1 if kind != "OUT" else None))
                    self.assertEqual(cur.execute.call_count, 1)
                    self.assertIn("FOR UPDATE", cur.execute.call_args.args[0])
                    conn.rollback.assert_called_once()