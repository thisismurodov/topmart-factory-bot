import ast
from pathlib import Path
import unittest
from unittest.mock import Mock

from sale_catalog import refreshed_catalog


class CatalogRefreshTests(unittest.TestCase):
    def test_new_loads_appear_for_both_profiles_without_losing_cart(self):
        for uid in (700, 701):
            with self.subTest(profile=uid):
                old = [(1, "Selected", 100, "dona")]
                live = [(1, "Selected", 120, "dona"),
                        (155, "Leska 65 gramm", 2365, "dona"),
                        (108, "Ikki Qavat Arqon | 5 kg", 36000, "kg")]
                cart = {1: 2}
                rows, ids = refreshed_catalog(old, live, cart)
                self.assertEqual(ids, {1, 155, 108})
                self.assertEqual(rows[0][2], 100)
                self.assertEqual(rows[1:], live[1:])
                self.assertEqual(cart, {1: 2})
                self.assertEqual(old, [(1, "Selected", 100, "dona")])

    def test_sold_out_is_hidden_but_cart_and_positions_survive(self):
        old = [(1, "Old", 100, "dona"), (2, "Still loaded", 20, "kg")]
        rows, ids = refreshed_catalog(old, [old[1]], {1: 3})
        self.assertEqual(rows, old)
        self.assertEqual(ids, {2})
        self.assertEqual(refreshed_catalog(rows, [], {1: 3}), (old, set()))

    def test_handler_refreshes_each_profile_and_preserves_flow(self):
        # Extract only the handler to prevent bot startup or database side effects.
        tree = ast.parse((Path(__file__).parents[1] / "main.py").read_text())
        fn = next(n for n in tree.body
                  if isinstance(n, ast.FunctionDef) and n.name == "_show_sale_catalog")
        catalog = Mock(return_value=[(155, "Leska 65 gramm", 2365, "dona"),
                                    (108, "Ikki Qavat Arqon | 5 kg", 36000, "kg")])
        ns = {"_flow_pilot": lambda uid, data: True,
              "get_vehicle_seller_products": catalog,
              "VehiclePilotSaleError": ValueError,
              "refreshed_catalog": refreshed_catalog,
              "set_state": Mock(), "bot": Mock(), "_mah_list_kb": Mock()}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), "handler", "exec"), ns)
        for uid in (700, 701):
            data = {"mahsulotlar": [], "tanlangan": {}, "operation_key": "keep",
                    "dokon_id": 10, "vehicle_pilot": True}
            ns["_show_sale_catalog"](uid, data)
            catalog.assert_called_with(uid)
            self.assertEqual(data["available_product_ids"], {155, 108})
            self.assertEqual(data["operation_key"], "keep")
            self.assertEqual(data["dokon_id"], 10)
        catalog.side_effect = ValueError("assignment unavailable")
        ns["set_state"].reset_mock()
        ns["_show_sale_catalog"](700, data)
        ns["set_state"].assert_not_called()


if __name__ == "__main__":
    unittest.main()
