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
        with patch.object(main, "get_user", return_value=USER_PILOT), \
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
    def test_exact_navruzbek_routes_pilot_nonpilot_legacy(self, _send):
        with patch.object(main, "_dokon_ruxsat_guard", return_value=True), \
             patch.object(main, "all_admin_ids", return_value=[]), \
             patch.object(main, "main_kb", return_value=None), \
             patch.object(main, "create_vehicle_pilot_sale", return_value=(1, None, 0)) as pilot, \
             patch.object(main, "create_sale", return_value=(2, None, 0)) as legacy:
            with patch.object(main, "get_user", return_value=USER_PILOT):
                main._save_savdo(700, sale_data())
            pilot.assert_called_once()
            legacy.assert_not_called()
            pilot.reset_mock()
            with patch.object(main, "get_user", return_value=USER_LEGACY):
                d = sale_data()
                d["balans_ishlatildi"] = 0
                main._save_savdo(701, d)
            legacy.assert_called_once()
            pilot.assert_not_called()

    @patch.object(main.bot, "send_message")
    def test_pilot_balance_decision_never_calls_external_delta(self, _send):
        data = sale_data()
        data.pop("balans_ishlatildi")
        data.pop("yangi_balans")
        with patch.object(main, "_dokon_ruxsat_guard", return_value=True), \
             patch.object(main, "get_user", return_value=USER_PILOT), \
             patch.object(main, "get_balans", return_value=80), \
             patch.object(main, "apply_balans_delta") as external, \
             patch.object(main, "_save_savdo") as save:
            main._check_balans_before_save(700, data)
        external.assert_not_called()
        save.assert_called_once_with(700, data)
        self.assertEqual(data["balans_ishlatildi"], 80)


if __name__ == "__main__":
    unittest.main()