from datetime import date
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ContextTypes, CommandHandler, CallbackQueryHandler, MessageHandler, filters,
)
from ..config import SUPERADMIN_CHAT_ID
from ..database import (
    get_monthly_salary_report, mark_salary_paid,
    get_worker_payment_history, get_user_role,
    get_worker_chat_id,
)

MONTHS_UZ = {
    1: "Yanvar", 2: "Fevral", 3: "Mart", 4: "Aprel",
    5: "May", 6: "Iyun", 7: "Iyul", 8: "Avgust",
    9: "Sentabr", 10: "Oktabr", 11: "Noyabr", 12: "Dekabr",
}


# ── Admin: /maosh ─────────────────────────────────────────────────────────────

async def cmd_maosh(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_row = get_user_role(update.effective_chat.id)
    if not user_row or user_row["role"] != "admin":
        await update.message.reply_text("❌ Faqat admin uchun.")
        return
    today = date.today()
    await _send_month_report(update.message, today.year, today.month)


async def salary_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()

    user_row = get_user_role(query.from_user.id)
    if not user_row or user_row["role"] != "admin":
        await query.answer("❌ Ruxsat yo'q.", show_alert=True)
        return

    parts  = query.data.split(":")
    action = parts[1]

    if action == "list":
        year, month = int(parts[2]), int(parts[3])
        await _send_month_report(query.message, year, month, edit=True)

    elif action == "worker":
        name, year, month = parts[2], int(parts[3]), int(parts[4])
        await _send_worker_detail(query, name, year, month)

    elif action == "confirm":
        name, year, month, amount = parts[2], int(parts[3]), int(parts[4]), float(parts[5])
        mark_salary_paid(name, year, month, amount)
        month_name = MONTHS_UZ.get(month, str(month))
        await query.edit_message_text(
            f"✅ *{name}* — {month_name} {year}\n"
            f"💰 *{amount:,.0f} so'm* to'landi deb belgilandi.",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton("◀️ Ro'yxatga", callback_data=f"sal:list:{year}:{month}")
            ]]),
        )
        await _notify_worker_paid(context, name, year, month, amount)

    elif action == "prev":
        year, month = int(parts[2]), int(parts[3])
        month -= 1
        if month == 0:
            month, year = 12, year - 1
        await _send_month_report(query.message, year, month, edit=True)

    elif action == "next":
        year, month = int(parts[2]), int(parts[3])
        month += 1
        if month == 13:
            month, year = 1, year + 1
        await _send_month_report(query.message, year, month, edit=True)

    elif action == "noop":
        pass


async def _send_month_report(msg, year: int, month: int, edit: bool = False) -> None:
    report     = get_monthly_salary_report(year, month)
    month_name = MONTHS_UZ.get(month, str(month))

    if not report:
        text    = f"📊 *{month_name} {year}*\n\nBu oy hech qanday partiya kiritilmagan."
        buttons = []
    else:
        total      = sum(r["total_earnings"] for r in report)
        paid_count = sum(1 for r in report if r["is_paid"])
        text = (
            f"📊 *{month_name} {year} — Maosh hisoboti*\n"
            f"Jami: *{total:,.0f} so'm* | ✅ {paid_count}/{len(report)} to'landi\n\n"
            f"Hodimni tanlang:"
        )
        buttons = []
        for r in report:
            icon  = "✅" if r["is_paid"] else "⏳"
            label = f"{icon} {r['worker']} — {r['total_earnings']:,.0f} so'm"
            buttons.append([InlineKeyboardButton(
                label, callback_data=f"sal:worker:{r['worker']}:{year}:{month}"
            )])

    buttons.append([
        InlineKeyboardButton("◀️", callback_data=f"sal:prev:{year}:{month}"),
        InlineKeyboardButton(f"{month_name[:3]} {year}", callback_data="sal:noop"),
        InlineKeyboardButton("▶️", callback_data=f"sal:next:{year}:{month}"),
    ])
    kb = InlineKeyboardMarkup(buttons)

    if edit:
        await msg.edit_text(text, parse_mode="Markdown", reply_markup=kb)
    else:
        await msg.reply_text(text, parse_mode="Markdown", reply_markup=kb)


async def _send_worker_detail(query, worker: str, year: int, month: int) -> None:
    report     = get_monthly_salary_report(year, month)
    row        = next((r for r in report if r["worker"] == worker), None)
    month_name = MONTHS_UZ.get(month, str(month))

    if not row:
        await query.edit_message_text("⚠️ Ma'lumot topilmadi.")
        return

    lines = [f"👷 *{worker}* — {month_name} {year}\n"]
    for p in row["products"]:
        detail = f"{p['kg']:.1f} kg" if p["kg"] > 0 else f"{p['qty']} dona"
        lines.append(f"📦 {p['name']}: {detail} → *{p['earnings']:,.0f} so'm*")
    lines.append(f"\n💰 Jami: *{row['total_earnings']:,.0f} so'm*")

    if row["is_paid"]:
        lines.append(f"\n✅ To'langan: {row['paid_at'][:10]}")
        extra_buttons = []
    else:
        amount_int   = int(row["total_earnings"])
        extra_buttons = [[InlineKeyboardButton(
            f"✅ {row['total_earnings']:,.0f} so'm to'landi",
            callback_data=f"sal:confirm:{worker}:{year}:{month}:{amount_int}",
        )]]

    extra_buttons.append([
        InlineKeyboardButton("◀️ Ro'yxatga", callback_data=f"sal:list:{year}:{month}")
    ])
    await query.edit_message_text(
        "\n".join(lines),
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(extra_buttons),
    )


async def _notify_worker_paid(
    context, worker: str, year: int, month: int, amount: float
) -> None:
    chat_id = get_worker_chat_id(worker)
    if not chat_id:
        return
    month_name = MONTHS_UZ.get(month, str(month))
    try:
        await context.bot.send_message(
            chat_id=chat_id,
            text=(
                f"💰 *Maosh to'landi!*\n\n"
                f"📅 {month_name} {year}\n"
                f"💵 *{amount:,.0f} so'm*\n\n"
                f"Rahmat, mehnat qiling! 💪"
            ),
            parse_mode="Markdown",
        )
    except Exception:
        pass


# ── Worker: To'lovlar tarixi ──────────────────────────────────────────────────

async def payment_history_handler(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    chat_id  = update.effective_chat.id
    user_row = get_user_role(chat_id)
    if not user_row or user_row["role"] != "worker":
        await update.message.reply_text("❌ Bu funksiya ishchilar uchun.")
        return

    worker  = user_row["worker_name"]
    history = get_worker_payment_history(worker, limit=6)

    if not history:
        await update.message.reply_text(
            f"👷 *{worker}*\n\n📭 Hali hech qanday to'lov amalga oshirilmagan.",
            parse_mode="Markdown",
        )
        return

    lines = [f"👷 *{worker}* — To'lovlar tarixi\n"]
    for p in history:
        month_name = MONTHS_UZ.get(p["month"], str(p["month"]))
        lines.append(
            f"✅ *{month_name} {p['year']}* — {p['amount']:,.0f} so'm\n"
            f"   📅 {p['paid_at'][:10]}"
        )

    await update.message.reply_text("\n\n".join(lines), parse_mode="Markdown")


def register(app) -> None:
    app.add_handler(CommandHandler("maosh", cmd_maosh))
    app.add_handler(CallbackQueryHandler(salary_callback, pattern=r"^sal:"))
    app.add_handler(MessageHandler(
        filters.Regex(r"^💰 To'lovlar tarixi$"), payment_history_handler
    ))
