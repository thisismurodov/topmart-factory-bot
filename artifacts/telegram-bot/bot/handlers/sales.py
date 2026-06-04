from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ContextTypes, ConversationHandler, CommandHandler,
    MessageHandler, CallbackQueryHandler, filters,
)
from ..config import SUPERADMIN_CHAT_ID
from ..database import (
    get_user_role, get_customers, add_customer,
    get_sale_products, get_sale_product_unit,
    add_sale_product, delete_sale_product,
    create_sale, get_recent_sales,
)

SALE_CUSTOMER, SALE_NEW_NAME, SALE_NEW_PHONE, SALE_PRODUCT, \
    SALE_QTY, SALE_WEIGHT, SALE_PRICE, SALE_CONFIRM = range(8)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _is_admin(chat_id: int) -> bool:
    row = get_user_role(chat_id)
    return row is not None and row["role"] == "admin"


def _customer_keyboard() -> InlineKeyboardMarkup:
    customers = get_customers()
    buttons = []
    for c in customers:
        label = f"👤 {c['name']}"
        if c["phone"]:
            label += f" ({c['phone']})"
        buttons.append([InlineKeyboardButton(label, callback_data=f"sv_c:{c['id']}:{c['name']}")])
    buttons.append([InlineKeyboardButton("➕ Yangi mijoz", callback_data="sv_c:new")])
    buttons.append([InlineKeyboardButton("❌ Bekor", callback_data="sv_cancel")])
    return InlineKeyboardMarkup(buttons)


def _product_keyboard() -> InlineKeyboardMarkup:
    products = get_sale_products()
    buttons = []
    for p in products:
        label = f"📦 {p['name']} ({p['unit']})"
        buttons.append([InlineKeyboardButton(label, callback_data=f"sv_p:{p['name']}:{p['unit']}")])
    if not products:
        buttons.append([InlineKeyboardButton("⚠️ Tovar yo'q — /tovar_qosh", callback_data="sv_cancel")])
    buttons.append([InlineKeyboardButton("❌ Bekor", callback_data="sv_cancel")])
    return InlineKeyboardMarkup(buttons)


def _cancel_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton("❌ Bekor", callback_data="sv_cancel")]])


def _confirm_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("✅ Tasdiqlash", callback_data="sv_confirm")],
        [InlineKeyboardButton("❌ Bekor qilish", callback_data="sv_cancel")],
    ])


# ── Entry ─────────────────────────────────────────────────────────────────────

async def sale_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    chat_id = update.effective_chat.id
    if not _is_admin(chat_id):
        await update.message.reply_text("❌ Faqat admin uchun.")
        return ConversationHandler.END

    context.user_data["sale"] = {}
    await update.message.reply_text(
        "🛒 *Yangi savdo*\n\nMijozni tanlang:",
        parse_mode="Markdown",
        reply_markup=_customer_keyboard(),
    )
    return SALE_CUSTOMER


# ── Customer selection ────────────────────────────────────────────────────────

async def customer_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data == "sv_cancel":
        await query.edit_message_text("❌ Savdo bekor qilindi.")
        return ConversationHandler.END

    if query.data == "sv_c:new":
        await query.edit_message_text(
            "👤 *Yangi mijoz*\n\nMijoz ismini kiriting:",
            parse_mode="Markdown",
            reply_markup=_cancel_kb(),
        )
        return SALE_NEW_NAME

    _, cid, cname = query.data.split(":", 2)
    context.user_data["sale"]["customer_id"] = int(cid)
    context.user_data["sale"]["customer_name"] = cname

    await query.edit_message_text(
        f"✅ Mijoz: *{cname}*\n\nMahsulotni tanlang:",
        parse_mode="Markdown",
        reply_markup=_product_keyboard(),
    )
    return SALE_PRODUCT


async def new_customer_name(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    name = update.message.text.strip()
    if not name:
        await update.message.reply_text("Ism bo'sh bo'lmasin. Qayta kiriting:")
        return SALE_NEW_NAME
    context.user_data["sale"]["new_cust_name"] = name
    await update.message.reply_text(
        f"📱 *{name}*\n\nTelefon raqami (yoki o'tkazib yuborish uchun «-» yozing):",
        parse_mode="Markdown",
        reply_markup=_cancel_kb(),
    )
    return SALE_NEW_PHONE


async def new_customer_phone(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    text = update.message.text.strip()
    phone = "" if text == "-" else text
    name = context.user_data["sale"].pop("new_cust_name")
    cid = add_customer(name, phone)
    context.user_data["sale"]["customer_id"] = cid
    context.user_data["sale"]["customer_name"] = name

    await update.message.reply_text(
        f"✅ Mijoz qo'shildi: *{name}*\n\nMahsulotni tanlang:",
        parse_mode="Markdown",
        reply_markup=_product_keyboard(),
    )
    return SALE_PRODUCT


# ── Product selection ─────────────────────────────────────────────────────────

async def product_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data == "sv_cancel":
        await query.edit_message_text("❌ Savdo bekor qilindi.")
        return ConversationHandler.END

    # format: sv_p:{name}:{unit}
    parts = query.data.split(":", 2)
    product = parts[1]
    unit = parts[2] if len(parts) > 2 else get_sale_product_unit(product)
    context.user_data["sale"]["product"] = product
    context.user_data["sale"]["rate_type"] = unit

    await query.edit_message_text(
        f"📦 *{product}*\n\nMiqdor (dona) kiriting:",
        parse_mode="Markdown",
        reply_markup=_cancel_kb(),
    )
    return SALE_QTY


# ── Quantity ──────────────────────────────────────────────────────────────────

async def qty_input(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    try:
        qty = int(update.message.text.strip())
        if qty <= 0:
            raise ValueError
    except ValueError:
        await update.message.reply_text("⚠️ Musbat son kiriting (masalan: 100):")
        return SALE_QTY

    context.user_data["sale"]["quantity"] = qty
    rate_type = context.user_data["sale"].get("rate_type", "dona")

    if rate_type == "kg":
        await update.message.reply_text(
            f"⚖️ Og'irlik (kg) kiriting (masalan: 25.5):",
            reply_markup=_cancel_kb(),
        )
        return SALE_WEIGHT
    else:
        context.user_data["sale"]["weight_kg"] = 0.0
        await update.message.reply_text(
            "💵 Birlik narxi (so'm) kiriting (masalan: 15000):",
            reply_markup=_cancel_kb(),
        )
        return SALE_PRICE


# ── Weight (only for kg products) ────────────────────────────────────────────

async def weight_input(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    try:
        kg = float(update.message.text.strip().replace(",", "."))
        if kg <= 0:
            raise ValueError
    except ValueError:
        await update.message.reply_text("⚠️ Musbat son kiriting (masalan: 25.5):")
        return SALE_WEIGHT

    context.user_data["sale"]["weight_kg"] = kg
    await update.message.reply_text(
        "💵 Birlik narxi (so'm/kg) kiriting (masalan: 8000):",
        reply_markup=_cancel_kb(),
    )
    return SALE_PRICE


# ── Price & summary ───────────────────────────────────────────────────────────

async def price_input(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    try:
        price = float(update.message.text.strip().replace(",", ".").replace(" ", ""))
        if price <= 0:
            raise ValueError
    except ValueError:
        await update.message.reply_text("⚠️ Musbat narx kiriting (masalan: 15000):")
        return SALE_PRICE

    sale = context.user_data["sale"]
    sale["unit_price"] = price
    rate_type = sale.get("rate_type", "dona")
    weight_kg = sale.get("weight_kg", 0.0)
    qty = sale["quantity"]

    if rate_type == "kg":
        total = weight_kg * price
    else:
        total = qty * price
    sale["total_amount"] = total

    unit_label = "so'm/kg" if rate_type == "kg" else "so'm/dona"
    qty_line = f"📦 Miqdor: *{qty} dona*"
    if weight_kg > 0:
        qty_line += f" | *{weight_kg:.1f} kg*"

    text = (
        f"📋 *Savdo ma'lumotlari*\n\n"
        f"👤 Mijoz: *{sale['customer_name']}*\n"
        f"🧵 Mahsulot: *{sale['product']}*\n"
        f"{qty_line}\n"
        f"💵 Narx: *{price:,.0f} {unit_label}*\n"
        f"💰 Jami: *{total:,.0f} so'm*\n\n"
        f"Tasdiqlaysizmi?"
    )
    await update.message.reply_text(text, parse_mode="Markdown", reply_markup=_confirm_kb())
    return SALE_CONFIRM


# ── Confirm / Cancel ──────────────────────────────────────────────────────────

async def confirm_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data == "sv_cancel":
        await query.edit_message_text("❌ Savdo bekor qilindi.")
        context.user_data.pop("sale", None)
        return ConversationHandler.END

    sale = context.user_data.get("sale", {})
    sale_id = create_sale(
        customer_id=sale["customer_id"],
        customer_name=sale["customer_name"],
        product=sale["product"],
        quantity=sale["quantity"],
        weight_kg=sale.get("weight_kg", 0.0),
        unit_price=sale["unit_price"],
        total_amount=sale["total_amount"],
    )
    context.user_data.pop("sale", None)

    await query.edit_message_text(
        f"✅ *Savdo #{sale_id} saqlandi!*\n\n"
        f"👤 {sale['customer_name']} | {sale['product']}\n"
        f"💰 *{sale['total_amount']:,.0f} so'm*",
        parse_mode="Markdown",
    )
    return ConversationHandler.END


# ── Sale products management (admin only) ─────────────────────────────────────

async def cmd_tovarlar(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    if not _is_admin(chat_id):
        await update.message.reply_text("❌ Faqat admin uchun.")
        return
    products = get_sale_products()
    if not products:
        await update.message.reply_text(
            "📭 Sotuv tovarlari yo'q.\n\n"
            "Qo'shish: `/tovar_qosh Tovar nomi kg`\n"
            "(yoki `dona` birligi uchun: `/tovar_qosh Tovar nomi dona`)",
            parse_mode="Markdown",
        )
        return
    lines = ["📦 *Sotuv tovarlari:*\n"]
    for p in products:
        lines.append(f"• {p['name']} — {p['unit']}")
    lines.append("\n➕ Qo'shish: `/tovar_qosh Nomi kg`")
    lines.append("🗑 O'chirish: `/tovar_ochir Nomi`")
    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


async def cmd_tovar_qosh(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    if not _is_admin(chat_id):
        await update.message.reply_text("❌ Faqat admin uchun.")
        return
    args = context.args
    if not args or len(args) < 1:
        await update.message.reply_text(
            "❗ Ishlatish: `/tovar_qosh Tovar nomi kg`\n"
            "Misol: `/tovar_qosh Polipropilen ip kg`",
            parse_mode="Markdown",
        )
        return
    unit = "dona"
    if args[-1].lower() in ("kg", "dona", "metr", "litr"):
        unit = args[-1].lower()
        name = " ".join(args[:-1]).strip()
    else:
        name = " ".join(args).strip()
    if not name:
        await update.message.reply_text("❗ Tovar nomi bo'sh bo'lmasin.")
        return
    ok = add_sale_product(name, unit)
    if ok:
        await update.message.reply_text(f"✅ *{name}* ({unit}) qo'shildi.", parse_mode="Markdown")
    else:
        await update.message.reply_text("❌ Qo'shib bo'lmadi.")


async def cmd_tovar_ochir(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    if not _is_admin(chat_id):
        await update.message.reply_text("❌ Faqat admin uchun.")
        return
    if not context.args:
        await update.message.reply_text(
            "❗ Ishlatish: `/tovar_ochir Tovar nomi`", parse_mode="Markdown"
        )
        return
    name = " ".join(context.args).strip()
    ok = delete_sale_product(name)
    if ok:
        await update.message.reply_text(f"🗑 *{name}* o'chirildi.", parse_mode="Markdown")
    else:
        await update.message.reply_text(f"❌ *{name}* topilmadi.", parse_mode="Markdown")


# ── Recent sales list ─────────────────────────────────────────────────────────

async def cmd_savdolar(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    if not _is_admin(chat_id):
        await update.message.reply_text("❌ Faqat admin uchun.")
        return

    sales = get_recent_sales(limit=10)
    if not sales:
        await update.message.reply_text("📭 Hali savdo amalga oshirilmagan.")
        return

    lines = ["📊 *So'nggi savdolar*\n"]
    for s in sales:
        date_str = str(s["created_at"])[:10]
        qty_info = f"{s['quantity']} dona"
        if s["weight_kg"] and float(s["weight_kg"]) > 0:
            qty_info += f" | {float(s['weight_kg']):.1f} kg"
        lines.append(
            f"#{s['id']} | {date_str}\n"
            f"  👤 {s['customer_name']} — {s['product']}\n"
            f"  📦 {qty_info} | 💰 *{float(s['total_amount']):,.0f} so'm*"
        )

    await update.message.reply_text("\n\n".join(lines), parse_mode="Markdown")


# ── Cancel handler ────────────────────────────────────────────────────────────

async def cancel_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data.pop("sale", None)
    await update.message.reply_text("❌ Savdo bekor qilindi.")
    return ConversationHandler.END


# ── Registration ──────────────────────────────────────────────────────────────

def build_sales_handler() -> ConversationHandler:
    return ConversationHandler(
        entry_points=[
            MessageHandler(filters.Regex(r"^🛒 Savdo$"), sale_start),
        ],
        states={
            SALE_CUSTOMER: [
                CallbackQueryHandler(customer_callback, pattern=r"^sv_c:"),
                CallbackQueryHandler(customer_callback, pattern=r"^sv_cancel$"),
            ],
            SALE_NEW_NAME: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, new_customer_name),
                CallbackQueryHandler(customer_callback, pattern=r"^sv_cancel$"),
            ],
            SALE_NEW_PHONE: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, new_customer_phone),
                CallbackQueryHandler(customer_callback, pattern=r"^sv_cancel$"),
            ],
            SALE_PRODUCT: [
                CallbackQueryHandler(product_callback, pattern=r"^sv_p:"),
                CallbackQueryHandler(product_callback, pattern=r"^sv_cancel$"),
            ],
            SALE_QTY: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, qty_input),
                CallbackQueryHandler(confirm_callback, pattern=r"^sv_cancel$"),
            ],
            SALE_WEIGHT: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, weight_input),
                CallbackQueryHandler(confirm_callback, pattern=r"^sv_cancel$"),
            ],
            SALE_PRICE: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, price_input),
                CallbackQueryHandler(confirm_callback, pattern=r"^sv_cancel$"),
            ],
            SALE_CONFIRM: [
                CallbackQueryHandler(confirm_callback, pattern=r"^sv_confirm$"),
                CallbackQueryHandler(confirm_callback, pattern=r"^sv_cancel$"),
            ],
        },
        fallbacks=[
            MessageHandler(filters.Regex(r"^❌ Bekor$"), cancel_text),
            CommandHandler("cancel", cancel_text),
        ],
        allow_reentry=True,
        name="sale_conv",
        persistent=True,
    )


def register(app) -> None:
    app.add_handler(build_sales_handler())
    app.add_handler(CommandHandler("savdolar", cmd_savdolar))
    app.add_handler(MessageHandler(filters.Regex(r"^📊 Savdolar$"), cmd_savdolar))
    app.add_handler(CommandHandler("tovarlar", cmd_tovarlar))
    app.add_handler(CommandHandler("tovar_qosh", cmd_tovar_qosh))
    app.add_handler(CommandHandler("tovar_ochir", cmd_tovar_ochir))
