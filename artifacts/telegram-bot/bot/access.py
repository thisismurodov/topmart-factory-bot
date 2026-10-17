"""Early access check: revoked users cannot resume persisted conversations."""
from telegram.ext import ApplicationHandlerStop
from .database import get_user_role


async def reject_blocked_user(update, context):
    if not update.effective_user:
        return
    row = get_user_role(update.effective_user.id)
    if row and row["role"] == "blocked":
        if update.callback_query:
            await update.callback_query.answer("Kirish bloklangan.", show_alert=True)
        elif update.effective_message:
            await update.effective_message.reply_text("⛔ Kirish bloklangan. Administratorga murojaat qiling.")
        raise ApplicationHandlerStop