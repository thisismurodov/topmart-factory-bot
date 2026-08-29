"""Pure routing/state guards for the F7 Telegram integration."""

import os
import unittest
from unittest.mock import Mock, patch

# Test runner must supply the isolated child URL; never let the bot prefer an
# inherited Railway/live URL while importing database.connection.
os.environ.pop("RAILWAY_DATABASE_URL", None)
if not os.environ.get("DATABASE_URL"):
    raise RuntimeError("DATABASE_URL must be an isolated test child DB URL")
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "123456:LOCAL_F7_TEST")

import main  # noqa: E402


USER_PILOT = (1, 700, "NAVRUZBEK", "agent", "Toshkent", None)
USER_LEGACY = (2, 701, "OTHER AGENT", "agent", "Toshkent", None)


def sale_data(operation_key="11111111-1111-4111-8111-111111111111"):
    return {
        "operation_key": operation_key,
        "dokon_id": 10,
        "dokon_nomi": "Shop",
        "mahsulotlar": [(5, "Rope", 100, "dona")],
        "tanlangan": {5: 2.0},
        "tolov": "nasiya",
        "foto": None,
        "balans_ishlatildi": 80,
        "yangi_balans": 0,
    }


class FakeCursor:
    def execute(self, *_args):
        pass
    def fetchall(self):
        return [(5, "Rope", 100, "dona")]


class FakeConn:
    def cursor(self):
        return FakeCursor()
    def close(self):
        pass


class Msg:
    class From:
        id = 700
    from_user = From()
    text = "📦 Tovar berish"


def message(text, uid=700):
    msg = Mock()
    msg.from_user.id = uid
    msg.text = text
    return msg


class VehiclePilotBotF7(unittest.TestCase):
    def setUp(self):
        main.user_state.clear()

    @patch.object(main.bot, "send_message")
    def test_operation_key_created_once_at_flow_start(self, _send):
        with patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main, "check_pending", return_value=False), \
             patch.object(main, "get_db", return_value=FakeConn()), \
             patch.object(main, "_bosh_dokon_kb", return_value=(object(), 1, 1, 0)):
            main.tovar_berish(Msg())
        first = main.get_state(700)["data"]["operation_key"]
        self.assertRegex(first, r"^[0-9a-f-]{36}$")
        # State transitions preserve the same dict/key rather than regenerating.
        data = main.get_state(700)["data"]
        main.set_state(700, "savdo_foto", data)
        self.assertEqual(main.get_state(700)["data"]["operation_key"], first)

    @patch.object(main.bot, "send_message")
    def test_pilot_error_keeps_key_then_retry_reuses_it(self, send):
        data = sale_data()
        seen = []
        def pilot(*args):
            seen.append(args[7])
            if len(seen) == 1:
                raise main.VehiclePilotSaleError("Etiketka yetarli emas")
            return (44, None, 0)
        main.set_state(700, "savdo_foto", data)
        with patch.dict(os.environ, {"VEHICLE_DISTRIBUTION_ENABLED": "1"}), \
             patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main, "is_vehicle_pilot_seller", return_value=True), \
             patch.object(main, "_dokon_ruxsat_guard", return_value=True), \
             patch.object(main, "create_vehicle_pilot_sale", side_effect=pilot), \
             patch.object(main, "create_sale") as legacy, \
             patch.object(main, "all_admin_ids", return_value=[]), \
             patch.object(main, "main_kb", return_value=None):
            main._save_savdo(700, data)
            self.assertEqual(main.get_state(700)["data"]["operation_key"], data["operation_key"])
            main._save_savdo(700, data)
        self.assertEqual(seen, [data["operation_key"], data["operation_key"]])
        legacy.assert_not_called()
        self.assertIsNone(main.get_state(700)["state"])
        self.assertTrue(any("Savdo saqlanmadi" in str(c) and
                            "Etiketka yetarli emas" in str(c) for c in send.call_args_list))
        self.assertTrue(any("Savdo saqlandi" in str(c) for c in send.call_args_list))

    @patch.object(main.bot, "send_message")
    def test_navruzbek_vehicle_routing_requires_exact_enabled_flag(self, _send):
        with patch.object(main, "_dokon_ruxsat_guard", return_value=True), \
             patch.object(main, "all_admin_ids", return_value=[]), \
             patch.object(main, "main_kb", return_value=None), \
             patch.object(main, "is_vehicle_pilot_seller", return_value=True), \
             patch.object(main, "create_vehicle_pilot_sale", return_value=(1, None, 0)) as pilot, \
             patch.object(main, "create_sale", return_value=(2, None, 0)) as legacy:
            for flag in (None, "0"):
                with self.subTest(flag=flag), \
                     patch.dict(os.environ, {}, clear=False), \
                     patch.object(main, "get_user", return_value=USER_PILOT):
                    os.environ.pop("VEHICLE_DISTRIBUTION_ENABLED", None)
                    if flag is not None:
                        os.environ["VEHICLE_DISTRIBUTION_ENABLED"] = flag
                    main._save_savdo(700, sale_data())
                pilot.assert_not_called()
            self.assertEqual(legacy.call_count, 2)

            pilot.reset_mock()
            legacy.reset_mock()
            with patch.dict(os.environ, {"VEHICLE_DISTRIBUTION_ENABLED": "1"}), \
                 patch.object(main, "get_user", return_value=USER_PILOT):
                main._save_savdo(700, sale_data())
            pilot.assert_called_once()
            legacy.assert_not_called()

    @patch.object(main.bot, "send_message")
    def test_enabled_flag_does_not_change_normal_non_vehicle_sales(self, _send):
        data = sale_data()
        data["balans_ishlatildi"] = 0
        with patch.dict(os.environ, {"VEHICLE_DISTRIBUTION_ENABLED": "1"}), \
             patch.object(main, "get_user", return_value=USER_LEGACY), \
             patch.object(main, "is_vehicle_pilot_seller", return_value=False), \
             patch.object(main, "_dokon_ruxsat_guard", return_value=True), \
             patch.object(main, "all_admin_ids", return_value=[]), \
             patch.object(main, "main_kb", return_value=None), \
             patch.object(main, "create_vehicle_pilot_sale") as pilot, \
             patch.object(main, "create_sale", return_value=(2, None, 0)) as legacy:
            main._save_savdo(701, data)
        legacy.assert_called_once()
        pilot.assert_not_called()

    @patch.object(main.bot, "send_message")
    def test_disabled_navruzbek_keeps_normal_fractional_quantity_flow(self, _send):
        for flag in (None, "0"):
            with self.subTest(flag=flag), \
                 patch.dict(os.environ, {}, clear=False), \
                 patch.object(main, "get_user", return_value=USER_PILOT), \
                 patch.object(main, "_next_kb", return_value=None):
                os.environ.pop("VEHICLE_DISTRIBUTION_ENABLED", None)
                if flag is not None:
                    os.environ["VEHICLE_DISTRIBUTION_ENABLED"] = flag
                data = sale_data()
                data.update({
                    "cur_mid": 5,
                    "cur_nomi": "Rope",
                    "cur_narx": 100,
                    "cur_birlik": "dona",
                })
                main.set_state(700, "savdo_miqdor", data)
                main.s_savdo_miqdor(message("1.5"))
                state = main.get_state(700)
                self.assertEqual(state["state"], "savdo_next")
                self.assertEqual(state["data"]["tanlangan"][5], 3.5)

    @patch.object(main.bot, "send_message")
    def test_pilot_kg_item_accepts_fractional_quantity(self, _send):
        # F9: kg mahsulotda kasr miqdor (5.7) pilot oqimida qabul qilinadi.
        with patch.object(main, "_next_kb", return_value=None):
            data = sale_data()
            data.update({"cur_mid": 8, "cur_nomi": "Gilam tros",
                         "cur_narx": 24000, "cur_birlik": "kg",
                         "vehicle_pilot": True})
            main.set_state(700, "savdo_miqdor", data)
            main.s_savdo_miqdor(message("5.7"))
            state = main.get_state(700)
            self.assertEqual(state["state"], "savdo_next")
            self.assertEqual(state["data"]["tanlangan"][8], 5.7)

    @patch.object(main.bot, "send_message")
    def test_pilot_kg_accumulation_stays_within_3_decimals(self, _send):
        # 5.7 + 2.4 float'da 8.100000000000001 bo'ladi — pilot oqimida
        # 3 xonaga tozalanishi shart (F7 chegarasi bilan mos).
        with patch.object(main, "_next_kb", return_value=None):
            data = sale_data()
            data.update({"cur_mid": 8, "cur_nomi": "Gilam tros",
                         "cur_narx": 24000, "cur_birlik": "kg",
                         "vehicle_pilot": True})
            data["tanlangan"][8] = 5.7
            main.set_state(700, "savdo_miqdor", data)
            main.s_savdo_miqdor(message("2.4"))
            state = main.get_state(700)
            self.assertEqual(state["data"]["tanlangan"][8], 8.1)

    @patch.object(main.bot, "send_message")
    def test_pilot_kg_item_rejects_more_than_3_decimals(self, _send):
        data = sale_data()
        data.update({"cur_mid": 8, "cur_nomi": "Gilam tros",
                     "cur_narx": 24000, "cur_birlik": "kg",
                     "vehicle_pilot": True})
        main.set_state(700, "savdo_miqdor", data)
        main.s_savdo_miqdor(message("5.6789"))
        state = main.get_state(700)
        self.assertEqual(state["state"], "savdo_miqdor")
        self.assertNotIn(8, state["data"]["tanlangan"])

    @patch.object(main.bot, "send_message")
    def test_pilot_kg_item_rejects_non_finite_input(self, _send):
        # inf round(...,3) da OverflowError bilan yiqilmasin; nan ham rad.
        for raw in ("inf", "nan", "-inf"):
            data = sale_data()
            data.update({"cur_mid": 8, "cur_nomi": "Gilam tros",
                         "cur_narx": 24000, "cur_birlik": "kg",
                         "vehicle_pilot": True})
            main.set_state(700, "savdo_miqdor", data)
            main.s_savdo_miqdor(message(raw))
            state = main.get_state(700)
            self.assertEqual(state["state"], "savdo_miqdor")
            self.assertNotIn(8, state["data"]["tanlangan"])

    @patch.object(main.bot, "send_message")
    def test_pilot_dona_item_still_requires_integer(self, _send):
        data = sale_data()
        data.update({"cur_mid": 5, "cur_nomi": "Rope", "cur_narx": 100,
                     "cur_birlik": "dona", "vehicle_pilot": True})
        data["tanlangan"] = {}
        main.set_state(700, "savdo_miqdor", data)
        main.s_savdo_miqdor(message("2.5"))
        state = main.get_state(700)
        self.assertEqual(state["state"], "savdo_miqdor")
        self.assertNotIn(5, state["data"]["tanlangan"])

    @patch.object(main.bot, "send_message")
    def test_disabled_navruzbek_uses_normal_balance_deduction_boundaries(self, _send):
        for flag in (None, "0"):
            with self.subTest(boundary="precheck", flag=flag), \
                 patch.dict(os.environ, {}, clear=False), \
                 patch.object(main, "_dokon_ruxsat_guard", return_value=True), \
                 patch.object(main, "get_user", return_value=USER_PILOT), \
                 patch.object(main, "get_balans", return_value=80), \
                 patch.object(main, "apply_balans_delta") as external, \
                 patch.object(main, "_save_savdo") as save:
                os.environ.pop("VEHICLE_DISTRIBUTION_ENABLED", None)
                if flag is not None:
                    os.environ["VEHICLE_DISTRIBUTION_ENABLED"] = flag
                data = sale_data()
                data.pop("balans_ishlatildi")
                data.pop("yangi_balans")
                main._check_balans_before_save(700, data)
                external.assert_called_once_with(10, -80)
                save.assert_called_once_with(700, data)

            with self.subTest(boundary="confirm", flag=flag), \
                 patch.dict(os.environ, {}, clear=False), \
                 patch.object(main, "_dokon_ruxsat_guard", return_value=True), \
                 patch.object(main, "get_user", return_value=USER_PILOT), \
                 patch.object(main, "apply_balans_delta") as external, \
                 patch.object(main, "_save_savdo") as save:
                os.environ.pop("VEHICLE_DISTRIBUTION_ENABLED", None)
                if flag is not None:
                    os.environ["VEHICLE_DISTRIBUTION_ENABLED"] = flag
                data = sale_data()
                data["mavjud_balans"] = 80
                main.set_state(700, "savdo_balans_confirm", data)
                main.s_savdo_balans_confirm(message("✅ Ha, ayirish"))
                external.assert_called_once_with(10, -80)
                save.assert_called_once_with(700, data)

    @patch.object(main.bot, "send_message")
    def test_pilot_balance_decision_never_calls_external_delta(self, _send):
        data = sale_data()
        data.pop("balans_ishlatildi")
        data.pop("yangi_balans")
        with patch.dict(os.environ, {"VEHICLE_DISTRIBUTION_ENABLED": "1"}), \
             patch.object(main, "_dokon_ruxsat_guard", return_value=True), \
             patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main, "is_vehicle_pilot_seller", return_value=True), \
             patch.object(main, "get_balans", return_value=80), \
             patch.object(main, "apply_balans_delta") as external, \
             patch.object(main, "_save_savdo") as save:
            main._check_balans_before_save(700, data)
        external.assert_not_called()
        save.assert_called_once_with(700, data)
        self.assertEqual(data["balans_ishlatildi"], 80)

    @patch.object(main.bot, "send_message")
    def test_prod_apostrophe_users_name_still_routes_to_pilot(self, _send):
        # Prod holat: users.name="Navro'zbek" (apostrof), delivery_agents
        # esa "Navruzbek" — yo'naltirish ism imlosiga emas, telegram_id +
        # biriktiruv zanjiriga qarashi shart.
        prod_user = (1, 700, "Navro'zbek", "agent", "Namangan", None)
        with patch.dict(os.environ, {"VEHICLE_DISTRIBUTION_ENABLED": "1"}), \
             patch.object(main, "get_user", return_value=prod_user), \
             patch.object(main, "is_vehicle_pilot_seller", return_value=True) as chain, \
             patch.object(main, "_dokon_ruxsat_guard", return_value=True), \
             patch.object(main, "all_admin_ids", return_value=[]), \
             patch.object(main, "main_kb", return_value=None), \
             patch.object(main, "create_vehicle_pilot_sale", return_value=(1, None, 0)) as pilot, \
             patch.object(main, "create_sale", return_value=(2, None, 0)) as legacy:
            main._save_savdo(700, sale_data())
        pilot.assert_called_once()
        legacy.assert_not_called()
        chain.assert_called_with(700)

    @patch.object(main.bot, "send_message")
    def test_assignment_ended_mid_flow_aborts_instead_of_ordinary_writer(self, send):
        # Precheck pilot=True (balans tashqarida YECHILMAGAN, lekin
        # balans_ishlatildi saqlangan) → saqlashda fresh=False: oddiy
        # writerga jim o'tish asossiz qarz kamayishi bo'lardi — savdo aniq
        # xato bilan bekor, refund YO'Q (tashqi yechish bo'lmagan).
        data = sale_data()
        data["vehicle_pilot"] = True
        with patch.dict(os.environ, {"VEHICLE_DISTRIBUTION_ENABLED": "1"}), \
             patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main, "is_vehicle_pilot_seller", return_value=False), \
             patch.object(main, "apply_balans_delta") as external, \
             patch.object(main, "main_kb", return_value=None), \
             patch.object(main, "create_vehicle_pilot_sale") as pilot, \
             patch.object(main, "create_sale") as legacy:
            main.set_state(700, "savdo_next", data)
            main._save_savdo(700, data)
        pilot.assert_not_called()
        legacy.assert_not_called()
        external.assert_not_called()
        self.assertIsNone(main.get_state(700)["state"])

    @patch.object(main.bot, "send_message")
    def test_assignment_activated_mid_flow_refunds_and_aborts(self, send):
        # Precheck pilot=False (balans TASHQARIDA yechilgan) → saqlashda
        # fresh=True: pilot writer o'sha balansni IKKINCHI marta yechardi —
        # refund + aniq xato, hech qaysi writer chaqirilmaydi.
        data = sale_data()
        data["vehicle_pilot"] = False
        with patch.dict(os.environ, {"VEHICLE_DISTRIBUTION_ENABLED": "1"}), \
             patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main, "is_vehicle_pilot_seller", return_value=True), \
             patch.object(main, "apply_balans_delta") as external, \
             patch.object(main, "main_kb", return_value=None), \
             patch.object(main, "create_vehicle_pilot_sale") as pilot, \
             patch.object(main, "create_sale") as legacy:
            main._save_savdo(700, data)
        pilot.assert_not_called()
        legacy.assert_not_called()
        external.assert_called_once_with(10, 80)
        self.assertEqual(data["balans_ishlatildi"], 0)

    @patch.object(main.bot, "send_message")
    def test_pinned_decision_stable_at_balance_precheck(self, _send):
        # Balans bosqichi pinlangan qarordan foydalanadi — DB holati bu
        # nuqtada yo'nalishni o'zgartira olmaydi (writer tanlovi bilan
        # balans qarori hech qachon ajralmasin).
        data = sale_data()
        data.pop("balans_ishlatildi")
        data.pop("yangi_balans")
        data["vehicle_pilot"] = True
        with patch.dict(os.environ, {"VEHICLE_DISTRIBUTION_ENABLED": "1"}), \
             patch.object(main, "_dokon_ruxsat_guard", return_value=True), \
             patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main, "is_vehicle_pilot_seller", return_value=False) as helper, \
             patch.object(main, "get_balans", return_value=80), \
             patch.object(main, "apply_balans_delta") as external, \
             patch.object(main, "_save_savdo") as save:
            main._check_balans_before_save(700, data)
        external.assert_not_called()
        save.assert_called_once_with(700, data)
        helper.assert_not_called()


if __name__ == "__main__":
    unittest.main()