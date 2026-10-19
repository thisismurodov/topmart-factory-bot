"""Stateless warehouse report; never changes a conversation or closes a day."""
import asyncio
import logging
import re

from telegram.ext import CommandHandler, MessageHandler, filters

from ..database import get_user_role
from ..day_preparation import BUTTON, messages, read_rows, yesterday

log = logging.getLogger(__name__)


async def show_yesterday(update, context):
    user = await asyncio.to_thread(get_user_role, update.effective_user.id)
    if not user or user["role"] not in ("admin", "omborchi"):
        await update.effective_message.reply_text("Bu ro‘yxat faqat omborchi va administrator uchun.")
        return
    day = yesterday()
    try:
        rows = await asyncio.to_thread(read_rows, day)
        chunks = messages(day, rows)
    except Exception:
        log.exception("Warehouse yesterday preparation read failed")
        await update.effective_message.reply_text(
            "Ro‘yxatni olishda xatolik. Keyinroq qayta urinib ko‘ring.")
        return
    for text in chunks:
        await update.effective_message.reply_text(text, parse_mode=None)


def register(app):
    app.add_handler(CommandHandler("kechagi_royxat", show_yesterday, filters=filters.ChatType.PRIVATE))
    app.add_handler(MessageHandler(
        filters.ChatType.PRIVATE & filters.Regex("^" + re.escape(BUTTON) + "$"),
        show_yesterday))
