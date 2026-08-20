"""Packer Telegram kun-yopish oqimining ruxsat va xabarnoma testlari."""

import unittest
from types import SimpleNamespace
from unittest import mock
from unittest.mock import AsyncMock

from bot.handlers import packer
from bot.keyboards import packer_menu_keyboard


def _callback_update(user_id: int, data: str, chat_type: str = "private"):
    query = SimpleNamespace(
        data=data,
        answer=AsyncMock(),
        edit_message_text=AsyncMock(),
        message=SimpleNamespace(reply_text=AsyncMock()),
        from_user=SimpleNamespace(id=user_id),
    )
    update = SimpleNamespace(
        effective_chat=SimpleNamespace(id=user_id, type=chat_type),
        effective_user=SimpleNamespace(id=user_id),
        callback_query=query,
    )
    return update, query


class PackerCloseHandlerTest(unittest.IsolatedAsyncioTestCase):
    def test_all_packers_see_close_button(self):
        labels = [
            button.text
            for row in packer_menu_keyboard().keyboard
            for button in row
        ]
        self.assertIn("✅ Bugungi partiyalar tugadi", labels)

    async def test_multiple_lines_are_shown_as_picker(self):
        message = SimpleNamespace(reply_text=AsyncMock())
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=101, type="private"),
            effective_user=SimpleNamespace(id=101),
            message=message,
        )
        context = SimpleNamespace()
        with mock.patch.object(
            packer,
            "get_user_role",
            return_value={"role": "packer", "worker_name": "Packer"},
        ), mock.patch.object(
            packer,
            "get_packer_lines",
            return_value=[
                {"id": 6, "name": "Arqon Bo'lim 3"},
                {"id": 9, "name": "Qop Ip"},
            ],
        ):
            await packer.start_close_day(update, context)

        message.reply_text.assert_awaited_once()
        markup = message.reply_text.await_args.kwargs["reply_markup"]
        callback_data = [
            button.callback_data
            for row in markup.inline_keyboard
            for button in row
        ]
        self.assertIn("pclose:line:6", callback_data)
        self.assertIn("pclose:line:9", callback_data)

    async def test_confirm_reauthorizes_line_with_packer_chat_id(self):
        update, query = _callback_update(201, "pclose:confirm:6")
        context = SimpleNamespace(bot=SimpleNamespace(send_message=AsyncMock()))
        result = {
            "lines": [{
                "line_id": 6,
                "line_name": "Arqon Bo'lim 3",
                "total_kg": 108.15,
                "already_closed": False,
                "entries": [{
                    "worker": "Aziza",
                    "role": "IShlabchiqaruvchi",
                    "rate": 1125.0,
                    "amount": 62550.0,
                }],
            }],
            "new_entries": [{
                "line_id": 6,
                "line_name": "Arqon Bo'lim 3",
                "worker": "Aziza",
                "role": "IShlabchiqaruvchi",
                "rate": 1125.0,
                "amount": 62550.0,
            }],
        }
        with mock.patch.object(
            packer,
            "get_user_role",
            return_value={"role": "packer", "worker_name": "Arqon Packer"},
        ), mock.patch.object(
            packer,
            "get_packer_line_preview",
            return_value={"already_closed": False, "total_kg": 108.15},
        ), mock.patch.object(
            packer,
            "close_day",
            return_value=result,
        ) as close_day, mock.patch.object(
            packer,
            "_notify_salary_workers",
            new=AsyncMock(),
        ) as notify:
            await packer.close_day_callback(update, context)

        close_day.assert_called_once_with(
            closed_by="telegram-packer:201:Arqon Packer",
            line_id=6,
            authorized_packer_chat_id=201,
        )
        notify.assert_awaited_once_with(context, result["new_entries"])
        query.edit_message_text.assert_awaited_once()
        self.assertIn(
            "Bugungi liniya yopildi",
            query.edit_message_text.await_args.args[0],
        )

    async def test_non_packer_cannot_confirm(self):
        update, query = _callback_update(203, "pclose:confirm:9")
        context = SimpleNamespace(bot=SimpleNamespace(send_message=AsyncMock()))
        with mock.patch.object(
            packer,
            "get_user_role",
            return_value={"role": "worker", "worker_name": "Worker"},
        ), mock.patch.object(packer, "close_day") as close_day:
            await packer.close_day_callback(update, context)

        close_day.assert_not_called()
        self.assertIn(
            "faqat ro'yxatdan o'tgan upakovkachi",
            query.edit_message_text.await_args.args[0],
        )

    async def test_group_callback_is_rejected_before_role_lookup(self):
        update, query = _callback_update(
            204,
            "pclose:confirm:6",
            chat_type="group",
        )
        update.effective_chat.id = -100123456
        context = SimpleNamespace(bot=SimpleNamespace(send_message=AsyncMock()))
        with mock.patch.object(packer, "get_user_role") as get_user_role, \
             mock.patch.object(packer, "close_day") as close_day:
            await packer.close_day_callback(update, context)

        get_user_role.assert_not_called()
        close_day.assert_not_called()
        self.assertIn(
            "faqat bot bilan shaxsiy chatda",
            query.edit_message_text.await_args.args[0],
        )

    async def test_notifications_only_target_new_registered_entries(self):
        context = SimpleNamespace(
            bot=SimpleNamespace(send_message=AsyncMock())
        )
        entries = [
            {
                "line_name": "Arqon Bo'lim 3",
                "worker": "Aziza",
                "role": "IShlabchiqaruvchi",
                "amount": 62550.0,
            },
            {
                "line_name": "Arqon Bo'lim 3",
                "worker": "Offline Worker",
                "role": "pock",
                "amount": 40556.25,
            },
        ]
        with mock.patch.object(
            packer,
            "get_worker_chat_id",
            side_effect=[701, None],
        ):
            await packer._notify_salary_workers(context, entries)

        context.bot.send_message.assert_awaited_once()
        self.assertEqual(
            context.bot.send_message.await_args.kwargs["chat_id"],
            701,
        )

        context.bot.send_message.reset_mock()
        await packer._notify_salary_workers(context, [])
        context.bot.send_message.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()