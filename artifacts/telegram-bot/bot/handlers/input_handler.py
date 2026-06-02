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
from ..database import create_batch, next_batch_code, get_worker_chat_id
from ..config import WORKERS, PRODUCT_RATES, calc_earnings
from ..label_generator import generate_label_pdf

CHOOSE_WORKER, CHOOSE_PRODUCT, ENTER_QUANTITY, ENTER_WEIGHT = range(4)

MONTHS_UZ = {
    1: "Yanvar", 2: "Fevral", 3: "Mart", 4: "Aprel",
    5: "May", 6: "Iyun", 7: "Iyul", 8: "Avgust",
    9: "Sentabr", 10: "Oktabr", 11: "Noyabr", 12: "Dekabr",
}


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
            "⚠️ Iltimos, musbat butun son kiriting (masalan: 48):",
            reply_markup=cancel_keyboard(),
        )
        return ENTER_QUANTITY

    context.user_data["quantity"] = int(text)
    product   = context.user_data["product"]
    rate_info = PRODUCT_RATES.get(product, {"type": "dona"})

    if rate_info["type"] == "kg":
        await update.message.reply_text(
            f"⚖️ *Jami og'irlik qancha?*\n"
            f"Tarozida o'lchab yozing (kg):\n"
            f"_Masalan: 205.5_",
            parse_mode="Markdown",
            reply_markup=cancel_keyboard(),
        )
        return ENTER_WEIGHT
    else:
        context.user_data["weight_kg"] = 0.0
        return await _save_batch(update, context)


async def enter_weight(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    text = update.message.text.strip().replace(",", ".")
    try:
        weight = float(text)
        if weight <= 0:
            raise ValueError
    except ValueError:
        await update.message.reply_text(
            "⚠️ Iltimos, to'g'ri og'irlik kiriting (masalan: 205.5):",
            reply_markup=cancel_keyboard(),
        )
        return ENTER_WEIGHT

    context.user_data["weight_kg"] = weight
    return await _save_batch(update, context)


async def _save_batch(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    worker    = context.user_data["worker"]
    product   = context.user_data["product"]
    quantity  = context.user_data["quantity"]
    weight_kg = context.user_data.get("weight_kg", 0.0)

    earnings      = calc_earnings(product, quantity, weight_kg)
    worker_prefix = WORKERS[worker]
    batch_code    = next_batch_code(worker_prefix)

    create_batch(batch_code, worker, product, quantity, weight_kg, earnings)

    today_str   = date.today().strftime("%d.%m.%Y")
    rate_info   = PRODUCT_RATES.get(product, {"type": "dona", "rate": 100})
    unit_weight = (weight_kg / quantity) if weight_kg and quantity > 0 else 0.0
    weight_line = (
        f"⚖️ Jami og'irlik: *{weight_kg} kg* (~{unit_weight:.2f} kg/dona)\n"
        if rate_info["type"] == "kg" else ""
    )

    await update.message.reply_text(
        f"✅ *Partiya yaratildi!*\n\n"
        f"📌 Partiya: `{batch_code}`\n"
        f"👷 Ishlab chiqaruvchi: {worker}\n"
        f"📦 Mahsulot: {product}\n"
        f"🔢 Miqdor: *{quantity} dona*\n"
        f"{weight_line}"
        f"💰 Haq: *{earnings:,.0f} so'm*\n"
        f"📅 Sana: {today_str}",
        parse_mode="Markdown",
        reply_markup=main_menu_keyboard(),
    )

    generating_msg = await update.message.reply_text(
        f"🖨️ {quantity} ta stiker tayyorlanmoqda…"
    )

    pdf_buf = generate_label_pdf(batch_code, worker, product, quantity, weight_kg)
    await update.message.reply_document(
        document=pdf_buf,
        filename=f"{batch_code}.pdf",
        caption=(
            f"🏷️ *{batch_code}* — {product}\n"
            f"{quantity} ta stiker | "
            f"{f'{weight_kg} kg' if weight_kg else f'{quantity} dona'}"
        ),
        parse_mode="Markdown",
    )
    await generating_msg.delete()

    await _notify_worker(context, worker, batch_code, product, quantity, weight_kg, earnings)

    context.user_data.clear()
    return ConversationHandler.END


async def _notify_worker(
    context: ContextTypes.DEFAULT_TYPE,
    worker: str,
    batch_code: str,
    product: str,
    quantity: int,
    weight_kg: float,
    earnings: float,
) -> None:
    chat_id = get_worker_chat_id(worker)
    if not chat_id:
        return

    today = date.today()
    rate_info = PRODUCT_RATES.get(product, {"type": "dona"})
    detail = f"{weight_kg} kg" if rate_info["type"] == "kg" else f"{quantity} dona"

    from ..database import get_worker_monthly
    month_rows = get_worker_monthly(worker, today.year, today.month)
    month_total = sum(r["total_earnings"] for r in month_rows)

    month_name = MONTHS_UZ.get(today.month, str(today.month))

    try:
        await context.bot.send_message(
            chat_id=chat_id,
            text=(
                f"✅ *Yangi partiya kiritildi!*\n\n"
                f"📦 {product} — {detail}\n"
                f"💰 Bu partiya: *{earnings:,.0f} so'm*\n\n"
                f"📊 {month_name} oyi jami: *{month_total:,.0f} so'm*"
            ),
            parse_mode="Markdown",
        )
    except Exception:
        pass


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
            ENTER_WEIGHT: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, enter_weight),
                CallbackQueryHandler(cancel_callback, pattern=r"^cancel$"),
            ],
        },
        fallbacks=[
            MessageHandler(filters.COMMAND, cancel_command),
        ],
        per_message=False,
        allow_reentry=True,
    )
