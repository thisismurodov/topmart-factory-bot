import importlib.util
from pathlib import Path
from decimal import Decimal as D
import unittest

spec = importlib.util.spec_from_file_location(
    "claim_weight", Path(__file__).parents[1] / "database" / "claim_weight.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
weight = module.allocated_claim_weight


class ClaimWeightTests(unittest.TestCase):
    def test_legacy_unchanged(self):
        self.assertEqual(weight("0.05", 50, 50, 10), D("0.5"))

    def test_both_leska_loads_total_exactly_16kg(self):
        self.assertEqual(weight(1, 120, 120, 120, 8)
                         + weight("0.0667", 120, 120, 120, 8), D(16))

    def test_each_possible_split_preserves_8kg(self):
        for split in range(1, 120):
            with self.subTest(split=split):
                self.assertEqual(weight(1, 120, 120, split, 8)
                                 + weight(1, 120, 120-split, 120-split, 8), D(8))

    def test_one_by_one_preserves_total(self):
        self.assertEqual(sum(weight(1, 120, r, 1, 8)
                             for r in range(120, 0, -1)), D(8))

    def test_invalid_values_fail_closed(self):
        for args in [(1,120,120,121,8), (1,120,120,1,-8),
                     (1,120,120,1,"NaN"), (1,120,120,"0.5",8)]:
            with self.assertRaises(ValueError):
                weight(*args)


if __name__ == "__main__":
    unittest.main()
