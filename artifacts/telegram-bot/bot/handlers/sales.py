from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ContextTypes, ConversationHandler, CommandHandler,
    MessageHandler, CallbackQueryHandler, filters,
)
from ..config import SUPERADMIN_CHAT_ID
from ..database import (
    get_user_role, get_customers, add_customer,
    get_sale_products, get_sale_product_by_id,
    add_sale_product, delete_sale_product,
    create_sale_multi, get_recent_sales,
    get_price_for_qty,
)

# ── States ────────────────────────────────────────────────────────────────────
SALE_CUSTOMER, SALE_NEW_NAME, SALE_NEW_PHONE, \
    SALE_PRODUCT, SALE_QTY, SALE_ITEMS, SALE_CONFIRM = range(7)

AP_NAME, AP_CODE, AP_UNIT, AP_CURRENCY = range(10, 14)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _is_admin(chat_id: int) -> bool:
    row = get_user_role(chat_id)
    return row is not None and row["role"] == "admin"


def _currency_sym(currency: str) -> str:
    cur = (currency or "uzs").lower()
    return "$" if cur in ("usd", "$") else "so'm"


def _fmt_price(price: float, currency: str) -> str:
    sym = _currency_sym(currency)
    if sym == "$":
        return f"{price:,.2f} $"
    return f"{price:,.0f} so'm"


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
        sym = _currency_sym(p["currency"])
        price = float(p.get("default_price") or 0)
        price_str = f"{price:,.0f}" if sym == "so'm" else f"{price:,.2f}"
        label = f"📦 {p['name']} — {price_str} {sym}/{p['unit']}"
        buttons.append([InlineKeyboardButton(label, callback_data=f"sv_p:{p['id']}")])
    if not products:
        buttons.append([InlineKeyboardButton("⚠️ Tovar yo'q — dashboarddan qo'shing", callback_data="sv_cancel")])
    buttons.append([InlineKeyboardButton("❌ Bekor", callback_data="sv_cancel")])
    return InlineKeyboardMarkup(buttons)


def _cancel_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton("❌ Bekor", callback_data="sv_cancel")]])


def _items_action_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("➕ Yana mahsulot qo'shish", callback_data="sv_more")],
        [InlineKeyboardButton("✅ Savdoni yakunlash", callback_data="sv_finish")],
        [InlineKeyboardButton("❌ Bekor qilish", callback_data="sv_cancel")],
    ])


def _confirm_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("✅ Tasdiqlash", callback_data="sv_confirm")],
        [InlineKeyboardButton("🔙 Orqaga", callback_data="sv_back")],
        [InlineKeyboardButton("❌ Bekor qilish", callback_data="sv_cancel")],
    ])


def _items_summary(items: list) -> str:
    """Qo'shilgan mahsulotlar ro'yxatini chiroyli chiqaradi."""
    lines = []
    for i, it in enumerate(items, 1):
        sym = _currency_sym(it["currency"])
        price_str = _fmt_price(it["unit_price"], it["currency"])
        total_str = _fmt_price(it["line_total"], it["currency"])
        lines.append(
            f"{i}. *{it['product_name']}*\n"
            f"   📦 {it['quantity']} {it['sale_type']} × {price_str}\n"
            f"   💰 Jami: *{total_str}*"
        )
    return "\n\n".join(lines)


def _totals_summary(items: list) -> str:
    """Valyuta bo'yicha umumiy jami."""
    totals: dict[str, float] = {}
    for it in items:
        cur = (it["currency"] or "UZS").upper()
        totals[cur] = totals.get(cur, 0.0) + float(it["line_total"])
    parts = []
    for cur, amt in totals.items():
        parts.append(f"*{_fmt_price(amt, cur)}*")
    return " | ".join(parts)


# ── Entry ─────────────────────────────────────────────────────────────────────

async def sale_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    chat_id = update.effective_chat.id
    if not _is_admin(chat_id):
        await update.message.reply_text("❌ Faqat admin uchun.")
        return ConversationHandler.END

    context.user_data["sale"] = {"items": []}
    await update.message.reply_text(
        "🛒 *Yangi savdo*\n\nMijozni tanlang:",
        parse_mode="Markdown",
        reply_markup=_customer_keyboard(),
    )
    return SALE_CUSTOMER


# ── Customer ──────────────────────────────────────────────────────────────────

async def customer_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data == "sv_cancel":
        await query.edit_message_text("❌ Savdo bekor qilindi.")
        context.user_data.pop("sale", None)
        return ConversationHandler.END

    if query.data == "sv_c:new":
        await query.edit_message_text(
            "👤 *Yangi mijoz*\n\nMijoz ismini kiriting:",
            parse_mode="Markdown",
            reply_markup=_cancel_kb(),
        )
        return SALE_NEW_NAME

    _, cid, cname = query.data.split(":", 2)
    context.user_data["sale"]["customer_id"]   = int(cid)
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
        f"📱 *{name}*\n\nTelefon raqami (yoki «-» yozing o'tkazib yuborish uchun):",
        parse_mode="Markdown",
        reply_markup=_cancel_kb(),
    )
    return SALE_NEW_PHONE


async def new_customer_phone(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    text  = update.message.text.strip()
    phone = "" if text == "-" else text
    name  = context.user_data["sale"].pop("new_cust_name")
    cid   = add_customer(name, phone)
    context.user_data["sale"]["customer_id"]   = cid
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
        context.user_data.pop("sale", None)
        return ConversationHandler.END

    prod_id = int(query.data.split(":")[1])
    prod    = get_sale_product_by_id(prod_id)
    if not prod:
        await query.edit_message_text("❌ Mahsulot topilmadi. Qayta urinib ko'ring.")
        return ConversationHandler.END

    context.user_data["sale"]["cur_prod"] = {
        "id":            prod["id"],
        "name":          prod["name"],
        "unit":          prod["unit"] or "dona",
        "default_price": float(prod.get("default_price") or 0),
        "currency":      prod["currency"] or "UZS",
    }

    p = context.user_data["sale"]["cur_prod"]
    price_str = _fmt_price(p["default_price"], p["currency"])
    sym = _currency_sym(p["currency"])

    await query.edit_message_text(
        f"📦 *{p['name']}*\n"
        f"💵 Narx: *{price_str} / {p['unit']}*\n\n"
        f"Miqdorni kiriting ({p['unit']}):\n"
        f"_(masalan: 25.5 yoki 100)_",
        parse_mode="Markdown",
        reply_markup=_cancel_kb(),
    )
    return SALE_QTY


# ── Quantity input ────────────────────────────────────────────────────────────

async def qty_input(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    text = update.message.text.strip().replace(",", ".")
    try:
        qty = float(text)
        if qty <= 0:
            raise ValueError
    except ValueError:
        await update.message.reply_text(
            "⚠️ Musbat son kiriting (masalan: 25.5 yoki 100):",
            reply_markup=_cancel_kb(),
        )
        return SALE_QTY

    sale     = context.user_data["sale"]
    cur_prod = sale["cur_prod"]
    unit     = cur_prod["unit"]
    # Miqdorga qarab tier narxini topamiz
    price, currency = get_price_for_qty(cur_prod["id"], qty)
    line_total = qty * price

    # Qo'shilgan mahsulotlar ro'yxatiga qo'shamiz
    sale["items"].append({
        "product_name": cur_prod["name"],
        "sale_type":    unit,
        "quantity":     qty,
        "unit_price":   price,
        "currency":     currency,
        "line_total":   line_total,
    })

    # Qisqa miqdor ko'rsatish
    qty_str    = f"{qty:g}"
    price_str  = _fmt_price(price, currency)
    total_str  = _fmt_price(line_total, currency)
    items_count = len(sale["items"])

    # Hozircha qo'shilgan barcha mahsulotlar jami
    overall_totals = _totals_summary(sale["items"])

    text_msg = (
        f"✅ *Qo'shildi!*\n\n"
        f"📦 {cur_prod['name']}: {qty_str} {unit} × {price_str} = *{total_str}*\n\n"
        f"📋 Jami {items_count} ta mahsulot | Umumiy: {overall_totals}\n\n"
        f"Nima qilamiz?"
    )
    await update.message.reply_text(
        text_msg,
        parse_mode="Markdown",
        reply_markup=_items_action_kb(),
    )
    return SALE_ITEMS


# ── Items action (yana qo'shish / yakunlash) ──────────────────────────────────

async def items_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data == "sv_cancel":
        await query.edit_message_text("❌ Savdo bekor qilindi.")
        context.user_data.pop("sale", None)
        return ConversationHandler.END

    if query.data == "sv_more":
        # Yana mahsulot tanlash
        await query.edit_message_text(
            "📦 Yana bir mahsulotni tanlang:",
            parse_mode="Markdown",
            reply_markup=_product_keyboard(),
        )
        return SALE_PRODUCT

    if query.data == "sv_finish":
        # Barcha mahsulotlar ro'yxati va tasdiqlash
        sale  = context.user_data["sale"]
        items = sale["items"]
        cname = sale["customer_name"]

        summary = _items_summary(items)
        totals  = _totals_summary(items)

        text_msg = (
            f"📋 *Savdo ma'lumotlari*\n\n"
            f"👤 Mijoz: *{cname}*\n\n"
            f"{summary}\n\n"
            f"{'─' * 25}\n"
            f"💰 Umumiy jami: {totals}\n\n"
            f"Tasdiqlaysizmi?"
        )
        await query.edit_message_text(
            text_msg,
            parse_mode="Markdown",
            reply_markup=_confirm_kb(),
        )
        return SALE_CONFIRM

    return SALE_ITEMS


# ── Confirm ───────────────────────────────────────────────────────────────────

async def confirm_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data == "sv_cancel":
        await query.edit_message_text("❌ Savdo bekor qilindi.")
        context.user_data.pop("sale", None)
        return ConversationHandler.END

    if query.data == "sv_back":
        # Oxirgi holatga qaytish
        sale  = context.user_data["sale"]
        items = sale["items"]
        overall_totals = _totals_summary(items)
        await query.edit_message_text(
            f"📋 Jami {len(items)} ta mahsulot | Umumiy: {overall_totals}\n\n"
            f"Nima qilamiz?",
            parse_mode="Markdown",
            reply_markup=_items_action_kb(),
        )
        return SALE_ITEMS

    if query.data == "sv_confirm":
        sale = context.user_data.get("sale", {})
        try:
            sale_id = create_sale_multi(
                customer_id=sale["customer_id"],
                customer_name=sale["customer_name"],
                status="pending",
                note="",
                items=sale["items"],
            )
        except Exception as e:
            await query.edit_message_text(f"❌ Xatolik yuz berdi: {e}")
            return ConversationHandler.END

        context.user_data.pop("sale", None)
        totals = _totals_summary(sale["items"])
        items_count = len(sale["items"])
        await query.edit_message_text(
            f"✅ *Savdo #{sale_id} saqlandi!*\n\n"
            f"👤 {sale['customer_name']}\n"
            f"📦 {items_count} ta mahsulot\n"
            f"💰 Jami: {totals}",
            parse_mode="Markdown",
        )
        return ConversationHandler.END

    return SALE_CONFIRM


# ── Recent sales ──────────────────────────────────────────────────────────────

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
        date_str  = str(s["created_at"])[:10]
        total_amt = float(s.get("total_amount") or 0)
        lines.append(
            f"#{s['id']} | {date_str}\n"
            f"  👤 {s['customer_name']}\n"
            f"  💰 *{total_amt:,.0f}*"
        )
    await update.message.reply_text("\n\n".join(lines), parse_mode="Markdown")


# ── Cancel fallback ───────────────────────────────────────────────────────────

async def cancel_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data.pop("sale", None)
    await update.message.reply_text("❌ Savdo bekor qilindi.")
    return ConversationHandler.END


# ── Sale products management (admin) ─────────────────────────────────────────

async def cmd_tovarlar(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    if not _is_admin(chat_id):
        await update.message.reply_text("❌ Faqat admin uchun.")
        return
    products = get_sale_products()
    if not products:
        await update.message.reply_text(
            "📭 Sotuv tovarlari yo'q.\n\n"
            "Dashboard orqali qo'shing: *Mahsulotlar → Sotuv mahsulotlari*",
            parse_mode="Markdown",
        )
        return
    lines = ["📦 *Sotuv tovarlari:*\n"]
    for p in products:
        sym   = _currency_sym(p["currency"])
        price = float(p.get("default_price") or 0)
        lines.append(f"• {p['name']} — {price:,.0f} {sym}/{p['unit']}")
    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


# ── Add product conversation (admin) ─────────────────────────────────────────

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
        "📦 *Yangi sotuv tovari*\n\nTovar nomini kiriting:",
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
        f"✅ Nom: *{name}*\n\nSotuv turini tanlang:",
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
    await query.edit_message_text(
        f"✅ Sotuv turi: *{unit}*\n\nNarx valyutasini tanlang:",
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
    unit = ap.get("unit", "dona")
    sym  = _currency_sym(currency)

    ok = add_sale_product(name, code="", unit=unit, currency=currency)
    if ok:
        await query.edit_message_text(
            f"✅ *Tovar saqlandi!*\n\n"
            f"📦 Nom: *{name}* | ⚖️ {unit} | 💰 {sym}\n\n"
            f"Narxni dashboard orqali belgilang.",
            parse_mode="Markdown",
        )
    else:
        await query.edit_message_text("❌ Saqlashda xatolik. Qayta urinib ko'ring.")
    return ConversationHandler.END


async def ap_cancel_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data.pop("ap", None)
    await update.message.reply_text("❌ Bekor qilindi.")
    return ConversationHandler.END


# ── Build handlers ────────────────────────────────────────────────────────────

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
                CallbackQueryHandler(product_callback, pattern=r"^sv_cancel$"),
            ],
            SALE_ITEMS: [
                CallbackQueryHandler(items_callback, pattern=r"^sv_(more|finish|cancel)$"),
            ],
            SALE_CONFIRM: [
                CallbackQueryHandler(confirm_callback, pattern=r"^sv_(confirm|cancel|back)$"),
            ],
        },
        fallbacks=[
            MessageHandler(filters.Regex(r"^❌ Bekor$"), cancel_text),
            CommandHandler("cancel", cancel_text),
        ],
        allow_reentry=True,
        name="sales_conv",
        persistent=True,
    )


def build_add_product_handler() -> ConversationHandler:
    return ConversationHandler(
        entry_points=[
            MessageHandler(filters.Regex(r"^➕ Sotuv Tovar$"), ap_start),
            CommandHandler("tovar_qosh", ap_start),
        ],
        states={
            AP_NAME:     [MessageHandler(filters.TEXT & ~filters.COMMAND, ap_name)],
            AP_UNIT:     [CallbackQueryHandler(ap_unit,     pattern=r"^ap_unit:|^ap_cancel$")],
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


def register(app) -> None:
    app.add_handler(build_sales_handler())
    app.add_handler(build_add_product_handler())
