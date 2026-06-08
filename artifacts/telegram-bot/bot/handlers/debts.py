"""
Nasiya (debt) handler — bot orqali qarzdor mijozlarni ko'rish va to'lov qabul qilish.

Buyruqlar:
  /nasiya  — nasiya ro'yxati
  📋 Nasiyalar — klaviaturadan

Callback data:
  dbt_list           — barcha qarzdor mijozlar
  dbt_cust:{id}      — bitta mijozning nasiyali savdolari
  dbt_sale:{id}      — bitta savdo detali + to'lov boshlash
  dbt_pay:{id}:{cur} — to'lov summasini kutish holati
  dbt_remind:{id}    — mijozga eslatma xabar yuborish
  dbt_back           — ro'yxatga qaytish
"""

from datetime import date
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ContextTypes, CommandHandler, CallbackQueryHandler,
    MessageHandler, ConversationHandler, filters,
)
from ..database import (
    get_user_role, get_debt_customers, get_customer_debt_sales,
    add_debt_payment, get_debt_totals,
)

# ── Conversation state ─────────────────────────────────────────────────────────
DEBT_AWAIT_AMOUNT = 50

MONTHS_UZ = {
    1: "Yan", 2: "Fev", 3: "Mar", 4: "Apr",
    5: "May", 6: "Iyn", 7: "Iyl", 8: "Avg",
    9: "Sen", 10: "Okt", 11: "Noy", 12: "Dek",
}


# ── Helpers ────────────────────────────────────────────────────────────────────

def _is_admin(chat_id: int) -> bool:
    row = get_user_role(chat_id)
    return row is not None and row["role"] == "admin"


def _fmt(amount: float, currency: str) -> str:
    cur = (currency or "USD").upper()
    if cur == "USD":
        return f"{amount:,.2f} $"
    if amount >= 1_000_000:
        return f"{amount / 1_000_000:.1f}M so'm"
    return f"{amount:,.0f} so'm"


def _short_date(dt) -> str:
    if dt is None:
        return "—"
    if hasattr(dt, "day"):
        return f"{dt.day:02d}.{dt.month:02d}.{dt.year}"
    return str(dt)


def _days_since(dt) -> int:
    if dt is None:
        return 0
    try:
        d = dt.date() if hasattr(dt, "date") else date.fromisoformat(str(dt)[:10])
        return (date.today() - d).days
    except Exception:
        return 0


def _urgency(days: int) -> str:
    if days > 30:
        return "🔴"
    if days > 14:
        return "🟡"
    return "🟢"


def _back_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton("⬅️ Orqaga", callback_data="dbt_list")]])


# ── Screen 1: debt list ────────────────────────────────────────────────────────

async def _show_debt_list(send_fn, totals, customers) -> None:
    if not customers:
        await send_fn(
            "✅ <b>Hech qanday nasiya yo'q!</b>\n\nBarcha mijozlar to'lovlarini amalga oshirgan.",
            parse_mode="HTML",
        )
        return

    lines = [
        "💳 <b>Nasiya hisoboti</b>\n",
        f"👥 Qarzdor mijozlar: <b>{totals['customer_count']}</b> ta",
    ]
    if totals["total_usd"] > 0:
        lines.append(f"💵 Jami USD nasiya: <b>{_fmt(float(totals['total_usd']), 'USD')}</b>")
    if totals["total_uzs"] > 0:
        lines.append(f"💴 Jami UZS nasiya: <b>{_fmt(float(totals['total_uzs']), 'UZS')}</b>")
    lines.append("")

    buttons = []
    for i, c in enumerate(customers[:15], 1):
        debt_usd = float(c["debt_usd"] or 0)
        debt_uzs = float(c["debt_uzs"] or 0)
        debt_str = " | ".join(filter(None, [
            _fmt(debt_usd, "USD") if debt_usd > 0 else "",
            _fmt(debt_uzs, "UZS") if debt_uzs > 0 else "",
        ]))
        days = _days_since(c["oldest_sale"])
        urg = _urgency(days)
        name = c["customer_name"]
        phone = f" {c['phone']}" if c["phone"] else ""
        lines.append(f"{urg} <b>{i}. {name}</b>{phone}\n   └ {debt_str} ({c['sale_count']} savdo, {days} kun)")
        buttons.append([InlineKeyboardButton(
            f"{urg} {name} — {debt_str}",
            callback_data=f"dbt_cust:{c['customer_id']}"
        )])

    if len(customers) > 15:
        lines.append(f"\n<i>... va yana {len(customers) - 15} ta mijoz</i>")

    await send_fn("\n".join(lines), parse_mode="HTML", reply_markup=InlineKeyboardMarkup(buttons))


# ── /nasiya command ────────────────────────────────────────────────────────────

async def cmd_nasiya(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    if not _is_admin(chat_id):
        await update.message.reply_text("❌ Faqat admin uchun.")
        return
    totals    = get_debt_totals()
    customers = get_debt_customers()
    await _show_debt_list(update.message.reply_text, totals, customers)


# ── Callback: dbt_list ─────────────────────────────────────────────────────────

async def cb_dbt_list(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    chat_id = query.from_user.id
    if not _is_admin(chat_id):
        await query.answer("❌ Faqat admin", show_alert=True)
        return
    totals    = get_debt_totals()
    customers = get_debt_customers()

    async def edit_fn(text, **kwargs):
        await query.edit_message_text(text, **kwargs)

    await _show_debt_list(edit_fn, totals, customers)


# ── Callback: dbt_cust:{id} — mijoz savdolari ─────────────────────────────────

async def cb_dbt_customer(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    _, cid_s = query.data.split(":", 1)
    cid = int(cid_s)

    sales = get_customer_debt_sales(cid)
    if not sales:
        await query.edit_message_text(
            "✅ Bu mijozning nasiyas yo'q.",
            reply_markup=_back_kb(),
        )
        return

    # Customer name from first sale
    # Get it from DB customers (we have it from debt_customers call, but simplest: re-fetch)
    cname = sales[0].get("customer_name") if sales else f"Mijoz #{cid}"
    # sales don't have customer_name directly — fetch from customers table
    from ..database import get_customers
    for c in get_customers():
        if c["id"] == cid:
            cname = c["name"]
            break

    lines = [f"👤 <b>{cname}</b> — nasiyali savdolar\n"]
    buttons = []

    for s in sales:
        sale_id   = s["id"]
        debt      = float(s["debt_amount"])
        total     = float(s["total_amount"])
        paid      = float(s["paid_amount"] or 0)
        currency  = (s["currency"] or "USD").upper()
        days      = _days_since(s["created_at"])
        urg       = _urgency(days)
        note      = s["note"] or ""
        status_lbl = "Nasiya" if s["status"] == "pending" else "Qisman"

        lines.append(
            f"{urg} <b>#{sale_id}</b> · {_short_date(s['created_at'])} · {status_lbl}\n"
            f"   Jami: {_fmt(total, currency)} | To'langan: {_fmt(paid, currency)}\n"
            f"   <b>Nasiya: {_fmt(debt, currency)}</b> ({days} kun)"
            + (f"\n   📝 {note}" if note else "")
        )
        buttons.append([
            InlineKeyboardButton(f"💳 #{sale_id} · {_fmt(debt, currency)} to'lash", callback_data=f"dbt_sale:{sale_id}:{currency}:{cid}"),
        ])

    buttons.append([InlineKeyboardButton(f"📢 {cname}ga eslatma", callback_data=f"dbt_remind:{cid}")])
    buttons.append([InlineKeyboardButton("⬅️ Orqaga", callback_data="dbt_list")])

    await query.edit_message_text(
        "\n".join(lines),
        parse_mode="HTML",
        reply_markup=InlineKeyboardMarkup(buttons),
    )


# ── Callback: dbt_sale:{sale_id}:{currency}:{cust_id} — to'lovni boshlash ─────

async def cb_dbt_sale(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    parts = query.data.split(":")  # dbt_sale:sale_id:currency:cust_id
    sale_id  = int(parts[1])
    currency = parts[2]
    cust_id  = int(parts[3])

    context.user_data["debt_sale_id"]  = sale_id
    context.user_data["debt_currency"] = currency
    context.user_data["debt_cust_id"]  = cust_id

    # Get sale details
    sales = get_customer_debt_sales(cust_id)
    sale  = next((s for s in sales if s["id"] == sale_id), None)
    if not sale:
        await query.edit_message_text("❌ Savdo topilmadi.", reply_markup=_back_kb())
        return ConversationHandler.END

    debt = float(sale["debt_amount"])
    context.user_data["debt_max"] = debt

    cancel_kb = InlineKeyboardMarkup([[
        InlineKeyboardButton("✅ Hammasi", callback_data=f"dbt_payall:{sale_id}:{currency}:{cust_id}"),
        InlineKeyboardButton("❌ Bekor", callback_data=f"dbt_cust:{cust_id}"),
    ]])

    await query.edit_message_text(
        f"💳 <b>#{sale_id}</b> savdoga to'lov\n\n"
        f"Qolgan nasiya: <b>{_fmt(debt, currency)}</b>\n\n"
        f"To'lov summasini yozing yoki <b>Hammasi</b> ni bosing:",
        parse_mode="HTML",
        reply_markup=cancel_kb,
    )
    return DEBT_AWAIT_AMOUNT


# ── Callback: dbt_payall — to'liq to'lash ─────────────────────────────────────

async def cb_dbt_payall(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    parts    = query.data.split(":")
    sale_id  = int(parts[1])
    currency = parts[2]
    cust_id  = int(parts[3])

    sales = get_customer_debt_sales(cust_id)
    sale  = next((s for s in sales if s["id"] == sale_id), None)
    if not sale:
        await query.edit_message_text("❌ Savdo topilmadi.", reply_markup=_back_kb())
        return ConversationHandler.END

    debt   = float(sale["debt_amount"])
    result = add_debt_payment(sale_id, debt, currency, note="Bot orqali to'liq to'lov")

    if result["ok"]:
        pay_status_label = "✅ To'liq to'landi" if result["status"] == "paid" else "🔄 Qisman to'landi"
        await query.edit_message_text(
            f"✅ <b>To'lov qabul qilindi!</b>\n\n"
            f"Savdo #{sale_id} — {_fmt(debt, currency)} to'landi.\n"
            f"Holat: {pay_status_label}",
            parse_mode="HTML",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton("⬅️ Mijozga qaytish", callback_data=f"dbt_cust:{cust_id}"),
                InlineKeyboardButton("📋 Nasiyalar", callback_data="dbt_list"),
            ]]),
        )
    else:
        await query.edit_message_text(
            f"❌ Xato: {result['error']}",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("⬅️ Orqaga", callback_data=f"dbt_cust:{cust_id}")]]),
        )
    return ConversationHandler.END


# ── Message: to'lov summasi keldi ─────────────────────────────────────────────

async def debt_amount_received(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    text     = update.message.text.strip().replace(",", ".").replace(" ", "")
    sale_id  = context.user_data.get("debt_sale_id")
    currency = context.user_data.get("debt_currency", "USD")
    cust_id  = context.user_data.get("debt_cust_id")
    max_amt  = context.user_data.get("debt_max", 0)

    if not sale_id:
        await update.message.reply_text("❌ Xato holatda. /nasiya buyrug'ini qayta yuboring.")
        return ConversationHandler.END

    try:
        amount = float(text)
        if amount <= 0:
            raise ValueError
    except ValueError:
        await update.message.reply_text(
            f"❌ Noto'g'ri summa. Iltimos raqam kiriting (masalan: 150.00)\n"
            f"Maksimum: {_fmt(max_amt, currency)}"
        )
        return DEBT_AWAIT_AMOUNT

    result = add_debt_payment(sale_id, amount, currency, note="Bot orqali to'lov")

    if result["ok"]:
        paid_eff = result["paid"]
        new_debt = result["new_debt"]
        status   = result["status"]

        status_label = "✅ To'liq to'landi" if status == "paid" else "🔄 Qisman to'landi"
        msg = (
            f"✅ <b>To'lov qabul qilindi!</b>\n\n"
            f"Savdo #{sale_id}\n"
            f"To'landi: <b>{_fmt(paid_eff, currency)}</b>\n"
        )
        if new_debt > 0:
            msg += f"Qolgan nasiya: <b>{_fmt(new_debt, currency)}</b>\n"
        else:
            msg += "Nasiya: <b>✅ To'liq to'landi!</b>\n"

        await update.message.reply_text(
            msg,
            parse_mode="HTML",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton("⬅️ Mijozga qaytish", callback_data=f"dbt_cust:{cust_id}"),
                InlineKeyboardButton("📋 Nasiyalar", callback_data="dbt_list"),
            ]]),
        )
    else:
        await update.message.reply_text(f"❌ Xato: {result['error']}")

    return ConversationHandler.END


# ── Callback: dbt_remind:{cust_id} — eslatma xabar ───────────────────────────

async def cb_dbt_remind(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer("📢 Eslatma tayyorlanmoqda...")
    cid = int(query.data.split(":")[1])

    sales = get_customer_debt_sales(cid)
    if not sales:
        await query.answer("✅ Nasiya yo'q!", show_alert=True)
        return

    from ..database import get_customers
    cname = f"Mijoz #{cid}"
    phone = ""
    for c in get_customers():
        if c["id"] == cid:
            cname = c["name"]
            phone = c.get("phone", "")
            break

    total_usd = sum(float(s["debt_amount"]) for s in sales if (s["currency"] or "USD").upper() == "USD")
    total_uzs = sum(float(s["debt_amount"]) for s in sales if (s["currency"] or "USD").upper() == "UZS")

    debt_str = " | ".join(filter(None, [
        _fmt(total_usd, "USD") if total_usd > 0 else "",
        _fmt(total_uzs, "UZS") if total_uzs > 0 else "",
    ]))

    remind_text = (
        f"📢 <b>Eslatma matn nusxasi:</b>\n\n"
        f"Assalomu alaykum, <b>{cname}</b>!\n"
        f"TopMart zavodidan eslatma: sizning {debt_str} miqdoridagi to'lovingiz kutilmoqda.\n"
        f"Iltimos, imkon qadar tezroq to'lovni amalga oshiring.\n"
        f"Savol bo'lsa, biz bilan bog'laning."
    )
    if phone:
        remind_text += f"\n\n📱 Mijoz telefoni: <code>{phone}</code>"

    await query.edit_message_text(
        remind_text,
        parse_mode="HTML",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("⬅️ Orqaga", callback_data=f"dbt_cust:{cid}"),
        ]]),
    )


# ── ConversationHandler ────────────────────────────────────────────────────────

def build_debt_handler() -> ConversationHandler:
    return ConversationHandler(
        entry_points=[
            CommandHandler("nasiya", cmd_nasiya),
            CallbackQueryHandler(cb_dbt_sale, pattern=r"^dbt_sale:"),
        ],
        states={
            DEBT_AWAIT_AMOUNT: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, debt_amount_received),
                CallbackQueryHandler(cb_dbt_payall, pattern=r"^dbt_payall:"),
                CallbackQueryHandler(cb_dbt_customer, pattern=r"^dbt_cust:"),
            ],
        },
        fallbacks=[
            CommandHandler("nasiya", cmd_nasiya),
        ],
        per_message=False,
        persistent=False,
        name="debt_conversation",
    )


def register(app) -> None:
    # Non-conversation callbacks
    app.add_handler(CallbackQueryHandler(cb_dbt_list,     pattern=r"^dbt_list$"))
    app.add_handler(CallbackQueryHandler(cb_dbt_customer, pattern=r"^dbt_cust:\d+$"))
    app.add_handler(CallbackQueryHandler(cb_dbt_remind,   pattern=r"^dbt_remind:\d+$"))
    app.add_handler(CallbackQueryHandler(cb_dbt_payall,   pattern=r"^dbt_payall:"))
    # Conversation for payment flow
    app.add_handler(build_debt_handler())
