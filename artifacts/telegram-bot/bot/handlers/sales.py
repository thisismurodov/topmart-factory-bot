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

AP_NAME, AP_CODE, AP_UNIT, AP_CURRENCY = range(10, 14)


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


def _currency_sym(currency: str) -> str:
    return "$" if currency == "usd" else "so'm"


def _product_keyboard() -> InlineKeyboardMarkup:
    products = get_sale_products()
    buttons = []
    for p in products:
        sym = _currency_sym(p["currency"])
        label = f"[{p['code']}] {p['name']} — {p['unit']}/{sym}"
        # callback: sv_p:{id}:{unit}:{currency}
        buttons.append([InlineKeyboardButton(label, callback_data=f"sv_p:{p['id']}:{p['unit']}:{p['currency']}")])
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

    # format: sv_p:{id}:{unit}:{currency}
    parts = query.data.split(":")
    prod_id = int(parts[1])
    unit = parts[2] if len(parts) > 2 else "dona"
    currency = parts[3] if len(parts) > 3 else "uzs"

    # nomi uchun ro'yxatdan topamiz
    products = get_sale_products()
    prod_name = next((p["name"] for p in products if p["id"] == prod_id), f"#{prod_id}")

    context.user_data["sale"]["product"] = prod_name
    context.user_data["sale"]["rate_type"] = unit
    context.user_data["sale"]["currency"] = currency

    await query.edit_message_text(
        f"📦 *{prod_name}*\n\nMiqdor (dona) kiriting:",
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
    currency = sale.get("currency", "uzs")
    sym = _currency_sym(currency)
    unit_label = f"{sym}/kg" if rate_type == "kg" else f"{sym}/dona"
    qty_line = f"📦 Miqdor: *{qty} dona*"
    if weight_kg > 0:
        qty_line += f" | *{weight_kg:.1f} kg*"

    text = (
        f"📋 *Savdo ma'lumotlari*\n\n"
        f"👤 Mijoz: *{sale['customer_name']}*\n"
        f"🧵 Mahsulot: *{sale['product']}*\n"
        f"{qty_line}\n"
        f"💵 Narx: *{price:,.2f} {unit_label}*\n"
        f"💰 Jami: *{total:,.2f} {sym}*\n\n"
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
    currency = sale.get("currency", "uzs")
    sale_id = create_sale(
        customer_id=sale["customer_id"],
        customer_name=sale["customer_name"],
        product=sale["product"],
        quantity=sale["quantity"],
        weight_kg=sale.get("weight_kg", 0.0),
        unit_price=sale["unit_price"],
        total_amount=sale["total_amount"],
        currency=currency,
    )
    context.user_data.pop("sale", None)
    sym = _currency_sym(currency)
    await query.edit_message_text(
        f"✅ *Savdo #{sale_id} saqlandi!*\n\n"
        f"👤 {sale['customer_name']} | {sale['product']}\n"
        f"💰 *{sale['total_amount']:,.2f} {sym}*",
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
            "Qo'shish:\n`/tovar_qosh Nom Kod kg uzs`\n"
            "Misol: `/tovar_qosh Qop ip QI kg uzs`",
            parse_mode="Markdown",
        )
        return
    lines = ["📦 *Sotuv tovarlari:*\n"]
    for p in products:
        sym = _currency_sym(p["currency"])
        lines.append(f"• `[{p['code']}]` {p['name']} — {p['unit']}/{sym}")
    lines.append("\n➕ `/tovar_qosh Nom Kod kg uzs`")
    lines.append("🗑 `/tovar_ochir Nom`")
    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


async def cmd_tovar_qosh(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    if not _is_admin(chat_id):
        await update.message.reply_text("❌ Faqat admin uchun.")
        return
    args = context.args
    # Format: /tovar_qosh Nom Kod kg|dona uzs|$|usd
    # Oxirgi 3 ta argument: unit, currency, code; qolganlari nom
    if not args or len(args) < 4:
        await update.message.reply_text(
            "❗ Format: `/tovar_qosh Nom Kod kg uzs`\n\n"
            "Misol:\n"
            "`/tovar_qosh Qop ip QI kg uzs`\n"
            "`/tovar_qosh Mato ip MI kg $`\n\n"
            "• *Nom* — tovar nomi (bir necha so'z bo'lishi mumkin)\n"
            "• *Kod* — qisqa kod (2-4 harf, masalan: QI)\n"
            "• *Birlik* — `kg` yoki `dona`\n"
            "• *Valyuta* — `uzs` yoki `$`",
            parse_mode="Markdown",
        )
        return

    currency_raw = args[-1].lower()
    currency = "usd" if currency_raw in ("$", "usd", "dollar") else "uzs"
    unit_raw = args[-2].lower()
    unit = unit_raw if unit_raw in ("kg", "dona", "metr", "litr") else "dona"
    code = args[-3].upper()
    name = " ".join(args[:-3]).strip()

    if not name:
        await update.message.reply_text("❗ Tovar nomi bo'sh bo'lmasin.")
        return

    ok = add_sale_product(name, code, unit, currency)
    sym = _currency_sym(currency)
    if ok:
        await update.message.reply_text(
            f"✅ *{name}* qo'shildi!\n"
            f"Kod: `{code}` | Birlik: {unit} | Valyuta: {sym}",
            parse_mode="Markdown",
        )
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
        sym = _currency_sym(s.get("currency", "uzs"))
        lines.append(
            f"#{s['id']} | {date_str}\n"
            f"  👤 {s['customer_name']} — {s['product']}\n"
            f"  📦 {qty_info} | 💰 *{float(s['total_amount']):,.2f} {sym}*"
        )

    await update.message.reply_text("\n\n".join(lines), parse_mode="Markdown")


# ── Add product conversation ───────────────────────────────────────────────────

def _unit_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("⚖️ kg", callback_data="ap_unit:kg"),
         InlineKeyboardButton("📦 dona", callback_data="ap_unit:dona")],
        [InlineKeyboardButton("❌ Bekor", callback_data="ap_cancel")],
    ])


def _currency_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🇺🇿 so'm", callback_data="ap_cur:uzs"),
         InlineKeyboardButton("💵 dollar ($)", callback_data="ap_cur:usd")],
        [InlineKeyboardButton("❌ Bekor", callback_data="ap_cancel")],
    ])


async def ap_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    chat_id = update.effective_chat.id
    if not _is_admin(chat_id):
        await update.message.reply_text("❌ Faqat admin uchun.")
        return ConversationHandler.END
    context.user_data["ap"] = {}
    await update.message.reply_text(
        "📦 *Yangi sotuv tovari*\n\nTovar nomini kiriting:\n_(masalan: Qop ip)_",
        parse_mode="Markdown",
    )
    return AP_NAME


async def ap_name(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    name = update.message.text.strip()
    if not name:
        await update.message.reply_text("❗ Nom bo'sh bo'lmasin. Qayta kiriting:")
        return AP_NAME
    context.user_data["ap"]["name"] = name
    await update.message.reply_text(
        f"✅ Nom: *{name}*\n\nQisqa *kod* kiriting:\n_(masalan: QI, PP, MI — 2-4 harf)_",
        parse_mode="Markdown",
    )
    return AP_CODE


async def ap_code(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    code = update.message.text.strip().upper()
    if not code or len(code) > 6:
        await update.message.reply_text("❗ Kod 1-6 ta harf bo'lsin. Qayta kiriting:")
        return AP_CODE
    context.user_data["ap"]["code"] = code
    await update.message.reply_text(
        f"✅ Kod: `{code}`\n\nSotuv turini tanlang:",
        parse_mode="Markdown",
        reply_markup=_unit_kb(),
    )
    return AP_UNIT


async def ap_unit(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    if query.data == "ap_cancel":
        context.user_data.pop("ap", None)
        await query.edit_message_text("❌ Bekor qilindi.")
        return ConversationHandler.END
    unit = query.data.split(":")[1]
    context.user_data["ap"]["unit"] = unit
    unit_label = "kg" if unit == "kg" else "dona"
    await query.edit_message_text(
        f"✅ Sotuv turi: *{unit_label}*\n\nNarx valyutasini tanlang:",
        parse_mode="Markdown",
        reply_markup=_currency_kb(),
    )
    return AP_CURRENCY


async def ap_currency(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    if query.data == "ap_cancel":
        context.user_data.pop("ap", None)
        await query.edit_message_text("❌ Bekor qilindi.")
        return ConversationHandler.END

    currency = query.data.split(":")[1]
    ap = context.user_data.pop("ap", {})
    name = ap.get("name", "")
    code = ap.get("code", "")
    unit = ap.get("unit", "dona")
    sym = _currency_sym(currency)

    ok = add_sale_product(name, code, unit, currency)
    if ok:
        await query.edit_message_text(
            f"✅ *Tovar saqlandi!*\n\n"
            f"📦 Nom: *{name}*\n"
            f"🔖 Kod: `{code}`\n"
            f"⚖️ Birlik: *{unit}*\n"
            f"💰 Valyuta: *{sym}*",
            parse_mode="Markdown",
        )
    else:
        await query.edit_message_text("❌ Saqlashda xatolik. Qayta urinib ko'ring.")
    return ConversationHandler.END


async def ap_cancel_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data.pop("ap", None)
    await update.message.reply_text("❌ Bekor qilindi.")
    return ConversationHandler.END


def build_add_product_handler() -> ConversationHandler:
    return ConversationHandler(
        entry_points=[
            MessageHandler(filters.Regex(r"^➕ Sotuv Tovar$"), ap_start),
            CommandHandler("tovar_qosh", ap_start),
        ],
        states={
            AP_NAME: [MessageHandler(filters.TEXT & ~filters.COMMAND, ap_name)],
            AP_CODE: [MessageHandler(filters.TEXT & ~filters.COMMAND, ap_code)],
            AP_UNIT: [CallbackQueryHandler(ap_unit, pattern=r"^ap_unit:|^ap_cancel$")],
            AP_CURRENCY: [CallbackQueryHandler(ap_currency, pattern=r"^ap_cur:|^ap_cancel$")],
        },
        fallbacks=[
            MessageHandler(filters.Regex(r"^❌ Bekor$"), ap_cancel_text),
            CommandHandler("cancel", ap_cancel_text),
        ],
        allow_reentry=True,
        name="add_product_conv",
        persistent=True,
    )


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
    app.add_handler(build_add_product_handler())
    app.add_handler(build_sales_handler())
    app.add_handler(CommandHandler("savdolar", cmd_savdolar))
    app.add_handler(MessageHandler(filters.Regex(r"^📊 Savdolar$"), cmd_savdolar))
    app.add_handler(CommandHandler("tovarlar", cmd_tovarlar))
    app.add_handler(MessageHandler(filters.Regex(r"^📦 Tovarlar$"), cmd_tovarlar))
    app.add_handler(CommandHandler("tovar_ochir", cmd_tovar_ochir))
