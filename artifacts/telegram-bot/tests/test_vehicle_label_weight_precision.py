import unittest
from bot.vehicle_distribution_label_generator import _weight_num


class LabelWeightPrecisionTests(unittest.TestCase):
    def test_four_decimal_weights_are_not_rounded_to_grams(self):
        self.assertEqual(_weight_num(0.0255), "0.0255")
        self.assertEqual(_weight_num(7.65), "7.65")
        self.assertEqual(_weight_num(0.306), "0.306")
        self.assertEqual(_weight_num(1.0), "1")
