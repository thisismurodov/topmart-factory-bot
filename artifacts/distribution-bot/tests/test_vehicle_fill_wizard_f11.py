"""F11 agent yuklash ustasi (wizard) — sof mock routing/state testlari.

Real DB YO'Q: vfill/vehicle_api qatlamlari patch qilinadi. Maqsad — state
mashina o'tishlari, savat/limit qoidalari, finalize idempotentligi (barqaror
operationKey + bitta 409-retry), va route-end hisobot gate'lari.
"""

import json
import os
import unittest
from decimal import Decimal
from unittest.mock import Mock, patch

# Test runner must supply the isolated child URL; never let the bot prefer an
# inherited Railway/live URL while importing database.connection.
os.environ.pop("RAILWAY_DATABASE_URL", None)
if not os.environ.get("DATABASE_URL"):
    raise RuntimeError("DATABASE_URL must be an isolated test child DB URL")
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "123456:LOCAL_F11_TEST")

import main  # noqa: E402


USER_PILOT = (1, 700, "NAVRUZBEK", "delivery", "Toshkent", None)
CHAIN = {
    "delivery_agent_id": 9,
    "agent_name": "NAVRUZBEK",
    "vehicle_id": 3,
    "plate_number": "01 DM 001",
    "vehicle_warehouse_id": 77,
}
WH = {"id": 11, "name": "Tayyor ombor"}
PROD = {
    "mahsulot_id": 5,
    "name": "Arqon 10m",
    "sku": "AR10",
    "available_quantity": 100,
    "pieces_per_box": 24,
    "narx": Decimal("12000"),
}


def message(text, uid=700):
    msg = Mock()
    msg.from_user.id = uid
    msg.text = text
    return msg


def sent_texts(send):
    return [str(c.args[1]) if len(c.args) > 1 else str(c.kwargs.get("text", ""))
            for c in send.call_args_list]


class VehicleFillWizardF11(unittest.TestCase):
    def setUp(self):
        main.user_state.clear()
        main._PILOT_KB_CACHE.clear()

    # ── Menyu gate ───────────────────────────────────────────────────────────
    def test_delivery_menu_shows_fill_button_only_for_pilot(self):
        # to_json() emoji-larni \\uXXXX qilib qochiradi — JSON parse orqali
        # tugma matnlarini aynan solishtiramiz.
        def btn_texts(kb):
            return [b["text"] for row in json.loads(kb.to_json())["keyboard"]
                    for b in row]
        with patch.object(main, "_pilot_kb_flag", return_value=True):
            self.assertIn(main.VFILL_BTN, btn_texts(main.main_kb("delivery", 700)))
        with patch.object(main, "_pilot_kb_flag", return_value=False):
            self.assertNotIn(main.VFILL_BTN,
                             btn_texts(main.main_kb("delivery", 700)))
        # Boshqa rollarda tugma umuman yo'q — hatto pilot flag True bo'lsa ham.
        with patch.object(main, "_pilot_kb_flag", return_value=True):
            for role in ("agent", "omborchi", "blok"):
                kb = main.main_kb(role, 700)
                if kb is not None:
                    self.assertNotIn(main.VFILL_BTN, btn_texts(kb))

    # ── Kirish guardlari ────────────────────────────────────────────────────
    @patch.object(main.bot, "send_message")
    def test_start_rejects_non_pilot_and_missing_chain(self, send):
        with patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main, "_is_vehicle_distribution_pilot_user",
                          return_value=False), \
             patch.object(main.vfill, "pilot_chain") as chain:
            main.vfill_start(message(main.VFILL_BTN))
            chain.assert_not_called()
        self.assertIsNone(main.get_state(700)["state"])
        self.assertTrue(any("faqat mashina pilot" in t for t in sent_texts(send)))

        send.reset_mock()
        with patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main, "_is_vehicle_distribution_pilot_user",
                          return_value=True), \
             patch.object(main.vfill, "pilot_chain", return_value=None):
            main.vfill_start(message(main.VFILL_BTN))
        self.assertIsNone(main.get_state(700)["state"])
        self.assertTrue(any("Faol mashina biriktiruvi topilmadi" in t
                            for t in sent_texts(send)))

        # delivery bo'lmagan rol — jim chiqib ketadi (hech narsa yuborilmaydi).
        send.reset_mock()
        with patch.object(main, "get_user",
                          return_value=(2, 701, "X", "agent", "T", None)):
            main.vfill_start(message(main.VFILL_BTN, uid=701))
        send.assert_not_called()

    @patch.object(main.bot, "send_message")
    def test_start_explains_when_central_warehouse_is_unconfigured_or_empty(self, send):
        with patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main, "_is_vehicle_distribution_pilot_user",
                          return_value=True), \
             patch.object(main.vfill, "pilot_chain", return_value=dict(CHAIN)), \
             patch.object(main.vfill, "fill_source_warehouses", return_value=[]):
            main.vfill_start(message(main.VFILL_BTN))

        self.assertIsNone(main.get_state(700)["state"])
        self.assertTrue(any(
            "Top Mart C-3 markaziy ombori sozlanmagan" in text
            for text in sent_texts(send)
        ))

    # ── To'liq happy-path: ombor → mahsulot → dona → savat ──────────────────
    @patch.object(main.bot, "send_message")
    def test_happy_path_states_and_cart_math(self, send):
        with patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main, "_is_vehicle_distribution_pilot_user",
                          return_value=True), \
             patch.object(main.vfill, "pilot_chain", return_value=dict(CHAIN)), \
             patch.object(main.vfill, "fill_source_warehouses",
                          return_value=[dict(WH)]), \
             patch.object(main.vfill, "fill_products",
                          return_value=[dict(PROD)]):
            main.vfill_start(message(main.VFILL_BTN))
            self.assertEqual(main.get_state(700)["state"], "vfill_wh")

            main.vfill_wh(message("1) Tayyor ombor"))
            st = main.get_state(700)
            self.assertEqual(st["state"], "vfill_prod")
            self.assertEqual(st["data"]["wh_id"], 11)

            main.vfill_prod(message("1) Arqon 10m — 100 dona"))
            self.assertEqual(main.get_state(700)["state"], "vfill_qty")

            main.vfill_qty(message("60"))
            st = main.get_state(700)
            self.assertEqual(st["state"], "vfill_next")
            cart = st["data"]["cart"]
            self.assertEqual(len(cart), 1)
            self.assertEqual(cart[0]["quantity"], 60)
            self.assertEqual(cart[0]["pieces_per_box"], 24)
        # 60 dona / 24 = 3 quti (ceil)
        self.assertTrue(any("3 quti" in t for t in sent_texts(send)))

    @patch.object(main.bot, "send_message")
    def test_qty_validation_merge_and_availability_cap(self, send):
        data = {"cart": [{"wh_id": 11, "wh_name": WH["name"],
                          "mahsulot_id": 5, "name": PROD["name"],
                          "quantity": 8, "pieces_per_box": 24, "narx": "12000"}],
                "chain": dict(CHAIN), "opkeys": {},
                "wh_id": 11, "wh_name": WH["name"],
                "cur": dict(PROD, available_quantity=10)}
        main.set_state(700, "vfill_qty", data)

        main.vfill_qty(message("abc"))
        self.assertEqual(main.get_state(700)["state"], "vfill_qty")
        main.vfill_qty(message("-3"))
        self.assertEqual(main.get_state(700)["state"], "vfill_qty")
        # 8 (savatda) + 5 > 10 mavjud — rad, savat o'zgarmaydi.
        main.vfill_qty(message("5"))
        st = main.get_state(700)
        self.assertEqual(st["state"], "vfill_qty")
        self.assertEqual(st["data"]["cart"][0]["quantity"], 8)
        texts = sent_texts(send)
        self.assertTrue(any("Butun son" in t for t in texts))
        self.assertTrue(any("Musbat son" in t for t in texts))
        self.assertTrue(any("faqat 10 dona" in t for t in texts))
        # 8 + 2 = 10 — chegarada ruxsat, mavjud satrga QO'SHILADI (yangi emas).
        main.vfill_qty(message("2"))
        st = main.get_state(700)
        self.assertEqual(st["state"], "vfill_next")
        self.assertEqual(len(st["data"]["cart"]), 1)
        self.assertEqual(st["data"]["cart"][0]["quantity"], 10)

    @patch.object(main.bot, "send_message")
    def test_back_navigation(self, send):
        with patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main.vfill, "fill_source_warehouses",
                          return_value=[dict(WH)]), \
             patch.object(main.vfill, "fill_products",
                          return_value=[dict(PROD)]):
            data = {"cart": [], "chain": dict(CHAIN), "opkeys": {},
                    "wh_id": 11, "wh_name": WH["name"],
                    "prods": [dict(PROD)],
                    "prod_labels": {"1) Arqon 10m — 100 dona": 0},
                    "cur": dict(PROD)}
            main.set_state(700, "vfill_qty", data)
            main.vfill_qty(message("⬅️ Orqaga"))
            self.assertEqual(main.get_state(700)["state"], "vfill_prod")
            main.vfill_prod(message("⬅️ Orqaga"))
            self.assertEqual(main.get_state(700)["state"], "vfill_wh")

    # ── Finalize: idempotent kalit, 409-retry, partial failure ──────────────
    def _cart_two_lines(self):
        return [
            {"wh_id": 11, "wh_name": WH["name"], "mahsulot_id": 5,
             "name": "Arqon 10m", "quantity": 60, "pieces_per_box": 24,
             "narx": "12000"},
            {"wh_id": 11, "wh_name": WH["name"], "mahsulot_id": 6,
             "name": "Ip 5mm", "quantity": 10, "pieces_per_box": 10,
             "narx": None},
        ]

    @patch.object(main.bot, "send_message")
    def test_finalize_success_one_handoff_per_warehouse(self, send):
        data = {"cart": self._cart_two_lines(), "chain": dict(CHAIN),
                "opkeys": {}}
        main.set_state(700, "vfill_next", data)
        with patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main.vehicle_api, "create_handoff",
                          return_value={"id": 501}) as create, \
             patch.object(main.vfill, "configured_recipient_ids",
                          return_value=(111,)):
            main._vfill_finalize(700, data)
        self.assertEqual(create.call_count, 1)
        args = create.call_args.args
        self.assertEqual(args[0], 11)
        self.assertEqual([l["mahsulot_id"] for l in args[1]], [5, 6])
        self.assertIsNone(main.get_state(700)["state"])
        texts = sent_texts(send)
        agent_txt = next(t for t in texts if "TOPSHIRIQ YARATILDI" in t)
        self.assertIn("№501", agent_txt)
        self.assertIn("YECHILMADI", agent_txt)          # zaxira hali ko'chmagan
        self.assertIn("Taxminiy qiymati", agent_txt)     # narx bor — summa chiqadi
        self.assertIn("dashboardida skanerlab", agent_txt)
        omb = [(c.args[0], c.args[1]) for c in send.call_args_list
               if c.args and c.args[0] == 111]
        self.assertTrue(omb and "YANGI YUKLASH TOPSHIRIG'I" in omb[0][1])

    @patch.object(main.bot, "send_message")
    def test_finalize_stable_key_and_single_409_retry(self, send):
        data = {"cart": self._cart_two_lines(), "chain": dict(CHAIN),
                "opkeys": {}}
        main.set_state(700, "vfill_next", data)
        err = main.vehicle_api.VehicleApiError("fingerprint to'qnashuvi", 409)
        with patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main.vehicle_api, "create_handoff",
                          side_effect=[err, {"id": 502}]) as create, \
             patch.object(main.vfill, "configured_recipient_ids",
                          return_value=()):
            main._vfill_finalize(700, data)
        self.assertEqual(create.call_count, 2)
        first_key = create.call_args_list[0].args[2]
        second_key = create.call_args_list[1].args[2]
        self.assertNotEqual(first_key, second_key)
        self.assertIsNone(main.get_state(700)["state"])
        self.assertTrue(any("№502" in t for t in sent_texts(send)))

    @patch.object(main.bot, "send_message")
    def test_finalize_failure_keeps_cart_for_retry_with_same_key(self, send):
        data = {"cart": self._cart_two_lines(), "chain": dict(CHAIN),
                "opkeys": {}}
        main.set_state(700, "vfill_next", data)
        err = main.vehicle_api.VehicleApiError("Omborda zaxira yetarli emas", 400)
        with patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main.vehicle_api, "create_handoff",
                          side_effect=err) as create, \
             patch.object(main.vfill, "configured_recipient_ids",
                          return_value=()):
            main._vfill_finalize(700, data)
            st = main.get_state(700)
            self.assertEqual(st["state"], "vfill_next")
            self.assertEqual(len(st["data"]["cart"]), 2)
            self.assertFalse(st["data"]["finalizing"])
            key_after_fail = st["data"]["opkeys"]["11"]
            self.assertTrue(any("qayta urinib" in t for t in sent_texts(send)))
            # Retry o'sha kalit bilan ketadi (server idempotent).
            create.side_effect = None
            create.return_value = {"id": 503}
            main._vfill_finalize(700, st["data"])
            self.assertEqual(create.call_args.args[2], key_after_fail)

    @patch.object(main.bot, "send_message")
    def test_finalize_reentry_guard(self, send):
        data = {"cart": self._cart_two_lines(), "chain": dict(CHAIN),
                "opkeys": {}, "finalizing": True}
        main.set_state(700, "vfill_next", data)
        with patch.object(main.vehicle_api, "create_handoff") as create:
            main._vfill_finalize(700, data)
            create.assert_not_called()
        self.assertTrue(any("davom etmoqda" in t for t in sent_texts(send)))

    # ── Route-end hisobot gate'lari ──────────────────────────────────────────
    def _route_patches(self, **over):
        vals = {
            "status": (4, 4),
            "rows": [{"mahsulot_id": 5, "name": "Arqon 10m",
                      "sold": 2, "remaining": 8}],
            "marker": True,
            "created": [("Arqon 10m", 40)],
        }
        vals.update(over)
        return vals

    @patch.object(main.bot, "send_message")
    def test_route_end_env_gate_and_incomplete_coverage(self, send):
        with patch.dict(os.environ, {"VEHICLE_DISTRIBUTION_ENABLED": "0"}), \
             patch.object(main.vfill, "pilot_chain") as chain:
            main._vehicle_route_end_check(700)
            chain.assert_not_called()

        with patch.dict(os.environ, {"VEHICLE_DISTRIBUTION_ENABLED": "1"}), \
             patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main, "_is_vehicle_distribution_pilot_user",
                          return_value=True), \
             patch.object(main, "_today_kun", return_value="dushanba"), \
             patch.object(main.vfill, "pilot_chain", return_value=dict(CHAIN)), \
             patch.object(main.vfill, "route_end_status", return_value=(5, 3)), \
             patch.object(main.vfill, "try_route_end_finalize") as marker:
            main._vehicle_route_end_check(700)
            marker.assert_not_called()
        send.assert_not_called()

    @patch.object(main.bot, "send_message")
    def test_route_end_report_sent_once_with_replenishment(self, send):
        v = self._route_patches()
        with patch.dict(os.environ, {"VEHICLE_DISTRIBUTION_ENABLED": "1"}), \
             patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main, "_is_vehicle_distribution_pilot_user",
                          return_value=True), \
             patch.object(main, "_today_kun", return_value="dushanba"), \
             patch.object(main.vfill, "pilot_chain", return_value=dict(CHAIN)), \
             patch.object(main.vfill, "route_end_status",
                          return_value=v["status"]), \
             patch.object(main.vfill, "vehicle_day_numbers",
                          return_value=v["rows"]), \
             patch.object(main.vfill, "try_route_end_finalize",
                          return_value=(True, v["created"])) as fin:
            main._vehicle_route_end_check(700)
            fin.assert_called_once()
        texts = sent_texts(send)
        report = next(t for t in texts if "MASHINA HISOBOTI" in t)
        self.assertIn("4/4", report)
        self.assertIn("Arqon 10m — 2 dona", report)      # sotildi
        self.assertIn("Arqon 10m — 8 dona", report)      # qoldi
        self.assertIn("Avto to'ldirish so'rovi ochildi", report)
        self.assertIn("Arqon 10m — 40 dona", report)

    @patch.object(main.bot, "send_message")
    def test_route_end_marker_lost_means_silent_and_no_replenishment(self, send):
        with patch.dict(os.environ, {"VEHICLE_DISTRIBUTION_ENABLED": "1"}), \
             patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main, "_is_vehicle_distribution_pilot_user",
                          return_value=True), \
             patch.object(main, "_today_kun", return_value="dushanba"), \
             patch.object(main.vfill, "pilot_chain", return_value=dict(CHAIN)), \
             patch.object(main.vfill, "route_end_status", return_value=(4, 4)), \
             patch.object(main.vfill, "vehicle_day_numbers", return_value=[]), \
             patch.object(main.vfill, "try_route_end_finalize",
                          return_value=(False, [])):
            main._vehicle_route_end_check(700)
        send.assert_not_called()

    @patch.object(main.bot, "send_message")
    def test_route_end_healthy_stock_message(self, send):
        with patch.dict(os.environ, {"VEHICLE_DISTRIBUTION_ENABLED": "1"}), \
             patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main, "_is_vehicle_distribution_pilot_user",
                          return_value=True), \
             patch.object(main, "_today_kun", return_value="dushanba"), \
             patch.object(main.vfill, "pilot_chain", return_value=dict(CHAIN)), \
             patch.object(main.vfill, "route_end_status", return_value=(2, 2)), \
             patch.object(main.vfill, "vehicle_day_numbers", return_value=[]), \
             patch.object(main.vfill, "try_route_end_finalize",
                          return_value=(True, [])):
            main._vehicle_route_end_check(700)
        report = next(t for t in sent_texts(send) if "MASHINA HISOBOTI" in t)
        self.assertIn("Zaxira me'yorida", report)

    @patch.object(main.bot, "send_message")
    def test_route_end_never_raises(self, send):
        with patch.dict(os.environ, {"VEHICLE_DISTRIBUTION_ENABLED": "1"}), \
             patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main, "_is_vehicle_distribution_pilot_user",
                          return_value=True), \
             patch.object(main, "_today_kun", return_value="dushanba"), \
             patch.object(main.vfill, "pilot_chain",
                          side_effect=RuntimeError("db down")):
            main._vehicle_route_end_check(700)  # exception tarqamasligi shart
        send.assert_not_called()
        # Finalize (marker+to'ldirish) ham yiqilsa — jim: marker bekor bo'ldi,
        # keyingi saqlashda butun yakun qayta uriniladi.
        with patch.dict(os.environ, {"VEHICLE_DISTRIBUTION_ENABLED": "1"}), \
             patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main, "_is_vehicle_distribution_pilot_user",
                          return_value=True), \
             patch.object(main, "_today_kun", return_value="dushanba"), \
             patch.object(main.vfill, "pilot_chain", return_value=dict(CHAIN)), \
             patch.object(main.vfill, "route_end_status", return_value=(1, 1)), \
             patch.object(main.vfill, "vehicle_day_numbers", return_value=[]), \
             patch.object(main.vfill, "try_route_end_finalize",
                          side_effect=RuntimeError("txn down")):
            main._vehicle_route_end_check(700)
        send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
