"""On-demand AI tahlil tugmasi (admin)."""
import asyncio
import logging

from telegram import Update
from telegram.ext import ContextTypes, MessageHandler, filters

from ..ai_client import get_daily_analysis
from ..config import SUPERADMIN_CHAT_ID
from ..database import get_user_role

_log = logging.getLogger(__name__)


def _is_admin(chat_id: int) -> bool:
    if chat_id == SUPERADMIN_CHAT_ID:
        return True
    row = get_user_role(chat_id)
    return bool(row and row["role"] == "admin")


async def cmd_ai_analysis(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.effective_message
    if not _is_admin(update.effective_chat.id):
        return
    wait = await msg.reply_text("🤖 AI tahlil tayyorlanmoqda…")
    analysis = await asyncio.to_thread(get_daily_analysis, True)
    if not analysis:
        await wait.edit_text(
            "⚠️ AI tahlil hozircha mavjud emas. (API yoki sozlamalarni tekshiring.)"
        )
        return
    text = "🤖 *AI kunlik tahlil*\n\n" + analysis
    if len(text) > 4000:
        text = text[:3990] + "…"
    try:
        await wait.edit_text(text, parse_mode="Markdown")
    except Exception:
        await wait.edit_text(text)


def register(app) -> None:
    app.add_handler(MessageHandler(filters.Regex(r"^🤖 AI tahlil$"), cmd_ai_analysis))
