from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes, CallbackQueryHandler, MessageHandler, filters

from ..database import get_today_batches
from ..keyboards import main_menu_keyboard
from ..label_generator import generate_label


async def show_label_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    rows = get_today_batches()

    if not rows:
        await update.message.reply_text(
            "📋 Bugun hali partiya kiritilmagan.",
            reply_markup=main_menu_keyboard(),
        )
        return

    buttons = [
        [InlineKeyboardButton(
            f"{r['batch_code']} | {r['product']}",
            callback_data=f"label:{r['batch_code']}"
        )]
        for r in rows
    ]
    await update.message.reply_text(
        "🏷️ *Qaysi partiyaning etiketkasini chiqarish kerak?*",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(buttons),
    )


async def send_label_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()

    batch_code = query.data.split(":", 1)[1]
    rows = get_today_batches()
    row = next((r for r in rows if r["batch_code"] == batch_code), None)

    if not row:
        await query.edit_message_text("❌ Partiya topilmadi.")
        return

    await query.edit_message_text(f"🏷️ Etiketka tayyorlanmoqda: `{batch_code}`…",
                                   parse_mode="Markdown")

    buf = generate_label(row["batch_code"], row["worker"], row["product"], row["quantity"])
    await query.message.reply_photo(
        photo=buf,
        caption=f"🏷️ *{row['batch_code']}* — {row['product']} | {row['quantity']} dona",
        parse_mode="Markdown",
        reply_markup=main_menu_keyboard(),
    )


def register(app) -> None:
    app.add_handler(
        MessageHandler(filters.Regex(r"^🏷️ Etiketka$"), show_label_menu)
    )
    app.add_handler(
        CallbackQueryHandler(send_label_callback, pattern=r"^label:")
    )
