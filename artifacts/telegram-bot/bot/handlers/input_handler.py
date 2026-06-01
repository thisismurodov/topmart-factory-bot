from datetime import date
from telegram import Update
from telegram.ext import (
    ContextTypes,
    ConversationHandler,
    CallbackQueryHandler,
    MessageHandler,
    filters,
)
from ..keyboards import workers_keyboard, products_keyboard, cancel_keyboard, main_menu_keyboard
from ..database import create_batch, next_batch_code
from ..config import WORKERS

CHOOSE_WORKER, CHOOSE_PRODUCT, ENTER_QUANTITY = range(3)


async def start_input(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    await update.message.reply_text(
        "👷 *Kim ishlab chiqardi?*\nIshlab chiqaruvchini tanlang:",
        parse_mode="Markdown",
        reply_markup=workers_keyboard(),
    )
    return CHOOSE_WORKER


async def choose_worker(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    worker = query.data.split(":", 1)[1]
    context.user_data["worker"] = worker

    await query.edit_message_text(
        f"👷 Ishlab chiqaruvchi: *{worker}*\n\n📦 *Mahsulotni tanlang:*",
        parse_mode="Markdown",
        reply_markup=products_keyboard(),
    )
    return CHOOSE_PRODUCT


async def choose_product(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    product = query.data.split(":", 1)[1]
    context.user_data["product"] = product

    await query.edit_message_text(
        f"📦 Mahsulot: *{product}*\n\n🔢 *Necha dona ishlab chiqarildi?*\nRaqam kiriting:",
        parse_mode="Markdown",
        reply_markup=cancel_keyboard(),
    )
    return ENTER_QUANTITY


async def enter_quantity(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    text = update.message.text.strip()

    if not text.isdigit() or int(text) <= 0:
        await update.message.reply_text(
            "⚠️ Iltimos, musbat butun son kiriting (masalan: 50):",
            reply_markup=cancel_keyboard(),
        )
        return ENTER_QUANTITY

    quantity = int(text)
    worker = context.user_data["worker"]
    product = context.user_data["product"]

    worker_prefix = WORKERS[worker]
    batch_code = next_batch_code(worker_prefix)

    create_batch(batch_code, worker, product, quantity)

    today_str = date.today().strftime("%d.%m.%Y")

    await update.message.reply_text(
        f"✅ *Partiya yaratildi!*\n\n"
        f"📌 Partiya: `{batch_code}`\n"
        f"👷 Ishlab chiqaruvchi: {worker}\n"
        f"📦 Mahsulot: {product}\n"
        f"🔢 Miqdor: *{quantity} dona*\n"
        f"📅 Sana: {today_str}",
        parse_mode="Markdown",
        reply_markup=main_menu_keyboard(),
    )

    context.user_data.clear()
    return ConversationHandler.END


async def cancel_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    context.user_data.clear()
    await query.edit_message_text("❌ Bekor qilindi.")
    await query.message.reply_text("Asosiy menyu:", reply_markup=main_menu_keyboard())
    return ConversationHandler.END


async def cancel_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data.clear()
    await update.message.reply_text(
        "❌ Bekor qilindi. Asosiy menyu:",
        reply_markup=main_menu_keyboard(),
    )
    return ConversationHandler.END


def build_conversation_handler() -> ConversationHandler:
    return ConversationHandler(
        entry_points=[
            MessageHandler(filters.Regex(r"^🏭 Tovar kiritish$"), start_input),
        ],
        states={
            CHOOSE_WORKER: [
                CallbackQueryHandler(choose_worker, pattern=r"^worker:"),
                CallbackQueryHandler(cancel_callback, pattern=r"^cancel$"),
            ],
            CHOOSE_PRODUCT: [
                CallbackQueryHandler(choose_product, pattern=r"^product:"),
                CallbackQueryHandler(cancel_callback, pattern=r"^cancel$"),
            ],
            ENTER_QUANTITY: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, enter_quantity),
                CallbackQueryHandler(cancel_callback, pattern=r"^cancel$"),
            ],
        },
        fallbacks=[
            MessageHandler(filters.COMMAND, cancel_command),
        ],
        per_message=False,
        allow_reentry=True,
    )
