import unittest
from decimal import Decimal as D
from bot.receipt_load_weight import receipt_weight, documented_movements, apply_receipt_corrections


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


class InternalReceiptTests(unittest.TestCase):
    def setUp(self):
        common = dict(quantity=D(400), weight_kg=D(20), direction="in",
                      from_warehouse_id=None, to_warehouse_id=9,
                      receipt_id=None, sale_item_id=8,
                      sale_quantity=D(400), sale_type="dona")
        self.rows = [
            dict(common, id=1, reference="topmart-sale:64:1:transfer",
                 movement_type="TRANSFER"),
            dict(common, id=2, reference="topmart-sale:64:1:in",
                 movement_type="IN"),
        ]

    def test_verified_internal_receipt_counted_once(self):
        rows = list(documented_movements(self.rows))
        self.assertEqual(len(rows), 1)
        self.assertEqual(receipt_weight(rows, 400, 20, 50), D("2.5000"))
        self.assertIsNone(self.rows[1]["receipt_id"])

    def test_missing_sale_is_rejected(self):
        self.rows[1]["sale_item_id"] = None
        with self.assertRaisesRegex(ValueError, "hujjati topilmadi"):
            list(documented_movements(self.rows))

    def test_missing_or_duplicate_twin_is_rejected(self):
        for rows in (self.rows[1:], self.rows + [dict(self.rows[0], id=3)]):
            with self.assertRaisesRegex(ValueError, "juft harakati"):
                list(documented_movements(rows))

    def test_mismatched_sale_or_twin_is_rejected(self):
        for field, value in (("quantity", D(399)), ("weight_kg", D(21)),
                             ("to_warehouse_id", 23), ("from_warehouse_id", 23)):
            with self.subTest(field=field):
                rows = [dict(self.rows[0], **{field: value}), self.rows[1]]
                with self.assertRaises(ValueError):
                    list(documented_movements(rows))
        self.rows[1]["sale_quantity"] = D(399)
        with self.assertRaises(ValueError):
            list(documented_movements(self.rows))

    def test_historical_wrong_weight_is_not_silently_repaired(self):
        for row in self.rows:
            row["weight_kg"] = D("8.695652173913043")
        rows = list(documented_movements(self.rows)) + [entry(100, 5, "out")]
        with self.assertRaisesRegex(ValueError, "2.1739 kg.*5.0000 kg"):
            receipt_weight(rows, 300, "3.695652173913043", 50)

    def test_external_receipt_unchanged(self):
        rows = list(documented_movements([entry(100, 5)]))
        self.assertEqual(receipt_weight(rows, 100, 5, 50), D("2.5000"))

    def test_missing_weight_is_explicit_error(self):
        with self.assertRaisesRegex(ValueError, "vazn yoki dona"):
            receipt_weight([entry(50, None)], 50, 0, 50)

    def correction_rows(self):
        for row in self.rows:
            row.update(weight_kg=D("8.695652173913043"), created_at=1)
        correction = dict(id=4, quantity=0, weight_kg=D("11.304347826086957"),
                          direction="in", movement_type="IN", from_warehouse_id=None,
                          to_warehouse_id=9, reason="receipt_weight_correction",
                          reference="receipt-weight-correction:2", created_at=3)
        return list(documented_movements(self.rows)) + [
            dict(entry(100, 5, "out"), id=3, created_at=2), correction]

    def test_explicit_correction_replays_without_rewriting_history(self):
        rows = self.correction_rows()
        replay = apply_receipt_corrections(rows)
        self.assertEqual(receipt_weight(replay, 300, 15, 50), D("2.5000"))
        self.assertEqual(rows[0]["weight_kg"], D("8.695652173913043"))
        self.assertEqual(len(replay), 2)

    def test_correction_wrong_target_duplicate_or_warehouse_rejected(self):
        for changes in ({"reference": "receipt-weight-correction:99"},
                        {"reference": "receipt-weight-correction:3"},
                        {"to_warehouse_id": 23}, {"quantity": 1}):
            rows = self.correction_rows()
            rows[-1].update(changes)
            with self.assertRaises(ValueError):
                apply_receipt_corrections(rows)
        rows = self.correction_rows()
        with self.assertRaises(ValueError):
            apply_receipt_corrections(rows + [dict(rows[-1], id=5)])

    def test_correction_does_not_bypass_stock_or_withdrawal_guards(self):
        rows = apply_receipt_corrections(self.correction_rows())
        with self.assertRaises(ValueError):
            receipt_weight(rows, 300, "3.695652173913043", 50)
        rows[1]["weight_kg"] = 6
        with self.assertRaises(ValueError):
            receipt_weight(rows, 300, 14, 50)
