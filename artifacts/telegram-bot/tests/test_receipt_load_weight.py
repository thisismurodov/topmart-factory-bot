import unittest
from decimal import Decimal as D
from bot.receipt_load_weight import receipt_weight


def entry(qty, kg, direction="in", receipt=True):
    return dict(quantity=qty, weight_kg=kg, direction=direction,
                receipt_id=1 if receipt else None, receipt_quantity=qty, receipt_weight=kg)


class ReceiptWeightTests(unittest.TestCase):
    def setUp(self):
        self.rows = [entry(1200, "25.5"), entry(0, "5.1", receipt=False),
                     entry(300, "7.65", "out"), entry(972, "20.25"),
                     entry(120, "3.06", "out")]

    def test_original_receipt_and_explicit_correction_not_stock_average(self):
        self.assertEqual(receipt_weight(self.rows, 1752, "40.14", 96), D("2.4480"))

    def test_rejects_crossing_differently_weighed_receipts(self):
        with self.assertRaisesRegex(ValueError, "780"):
            receipt_weight(self.rows, 1752, "40.14", 800)

    def test_new_receipt_after_old_one_is_consumed(self):
        rows = self.rows + [entry(780, "19.89", "out")]
        self.assertEqual(receipt_weight(rows, 972, "20.25", 96), D("2.0000"))

    def test_stale_stock_or_unexplained_ledger_is_rejected(self):
        with self.assertRaises(ValueError):
            receipt_weight(self.rows, 1752, "44.676", 96)
        with self.assertRaises(ValueError):
            receipt_weight(self.rows + [entry(0, "1", receipt=False)], 1752, "41.14", 96)
        with self.assertRaises(ValueError):
            receipt_weight([entry(10, 1, receipt=False)], 10, 1, 1)

    def test_receipt_and_movement_must_agree(self):
        self.rows[0]["receipt_weight"] = "30.6"
        with self.assertRaises(ValueError):
            receipt_weight(self.rows, 1752, "40.14", 96)
