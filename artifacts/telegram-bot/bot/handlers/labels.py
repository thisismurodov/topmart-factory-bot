from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes, CallbackQueryHandler, MessageHandler, filters

from ..database import get_today_batches
from ..keyboards import main_menu_keyboard
from ..label_generator import generate_label_pdf


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
            f"{r['batch_code']} | {r['product']} | {r['quantity']} dona",
            callback_data=f"label:{r['batch_code']}"
        )]
        for r in rows
    ]
    await update.message.reply_text(
        "🏷️ *Qaysi partiyaning stikerlarini chiqarish kerak?*",
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

    qty = row["quantity"]
    await query.edit_message_text(
        f"🖨️ *{batch_code}* — {qty} ta stiker tayyorlanmoqda…",
        parse_mode="Markdown",
    )

    pdf_buf = generate_label_pdf(
        row["batch_code"],
        row["worker"],
        row["product"],
        qty,
        row["weight_kg"] or 0.0,
    )
    await query.message.reply_document(
        document=pdf_buf,
        filename=f"{batch_code}.pdf",
        caption=(
            f"🏷️ *{batch_code}* — {row['product']}\n"
            f"{qty} ta stiker"
            + (f" | {row['weight_kg']:.1f} kg" if row["weight_kg"] else "")
        ),
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
