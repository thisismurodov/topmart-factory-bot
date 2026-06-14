from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes, CallbackQueryHandler, MessageHandler, filters

from ..database import get_today_batches
from ..keyboards import main_menu_keyboard
from ..label_generator import generate_batch_session_pdf


def _group_by_code(rows: list[dict]) -> dict[str, list[dict]]:
    """Bugungi qatorlarni batch_code bo'yicha guruhlaydi (tartibni saqlaydi)."""
    grouped: dict[str, list[dict]] = {}
    for r in rows:
        grouped.setdefault(r["batch_code"], []).append(r)
    return grouped


async def show_label_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    rows = get_today_batches()

    if not rows:
        await update.message.reply_text(
            "📋 Bugun hali partiya kiritilmagan.",
            reply_markup=main_menu_keyboard(),
        )
        return

    grouped = _group_by_code(rows)
    buttons = []
    for code, items in grouped.items():
        if len(items) == 1:
            label = f"{code} | {items[0]['product']} | {items[0]['quantity']} dona"
        else:
            total_qty = sum(int(i["quantity"]) for i in items)
            label = f"{code} | {len(items)} mahsulot | {total_qty} dona"
        buttons.append([InlineKeyboardButton(label, callback_data=f"label:{code}")])

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
    items = [r for r in rows if r["batch_code"] == batch_code]

    if not items:
        await query.edit_message_text("❌ Partiya topilmadi.")
        return

    worker = items[0]["worker"]
    total_qty = sum(int(i["quantity"]) for i in items)
    await query.edit_message_text(
        f"🖨️ *{batch_code}* — {total_qty} ta stiker tayyorlanmoqda…",
        parse_mode="Markdown",
    )

    pdf_items = [
        {
            "product":   r["product"],
            "quantity":  r["quantity"],
            "weight_kg": r["weight_kg"] or 0.0,
        }
        for r in items
    ]
    pdf_buf = generate_batch_session_pdf(batch_code, worker, pdf_items)
    await query.message.reply_document(
        document=pdf_buf,
        filename=f"{batch_code}.pdf",
        caption=(
            f"🏷️ *{batch_code}* — {worker}\n"
            f"{len(items)} ta mahsulot · {total_qty} ta stiker"
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
