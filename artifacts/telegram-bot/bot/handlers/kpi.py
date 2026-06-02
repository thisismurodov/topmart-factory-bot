from datetime import date
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes, MessageHandler, CallbackQueryHandler, filters

from ..database import get_monthly_kpi, get_worker_monthly
from ..keyboards import main_menu_keyboard

MONTHS_UZ = {
    1: "Yanvar", 2: "Fevral", 3: "Mart", 4: "Aprel",
    5: "May", 6: "Iyun", 7: "Iyul", 8: "Avgust",
    9: "Sentabr", 10: "Oktabr", 11: "Noyabr", 12: "Dekabr",
}


def _month_keyboard() -> InlineKeyboardMarkup:
    today = date.today()
    buttons = []
    for delta in range(3):
        m = today.month - delta
        y = today.year
        if m <= 0:
            m += 12
            y -= 1
        label = f"{MONTHS_UZ[m]} {y}"
        buttons.append([InlineKeyboardButton(label, callback_data=f"kpi_month:{y}:{m}")])
    return InlineKeyboardMarkup(buttons)


async def show_kpi_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "📊 *KPI Hisoboti*\nQaysi oyni ko'rmoqchisiz?",
        parse_mode="Markdown",
        reply_markup=_month_keyboard(),
    )


async def show_monthly_kpi(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    _, year_s, month_s = query.data.split(":")
    year, month = int(year_s), int(month_s)

    rows = get_monthly_kpi(year, month)
    month_name = f"{MONTHS_UZ[month]} {year}"

    if not rows:
        await query.edit_message_text(
            f"📊 *{month_name}* — ma'lumot yo'q.",
            parse_mode="Markdown",
        )
        return

    total_earnings = sum(r["total_earnings"] for r in rows)
    lines = [f"📊 *{month_name} — Umumiy hisobot*\n"]
    for r in rows:
        lines.append(
            f"👷 *{r['worker']}*\n"
            f"   Partiya: {r['batch_count']} ta | Dona: {r['total_qty']:,}\n"
            f"   💰 *{r['total_earnings']:,.0f} so'm*\n"
        )
    lines.append(f"━━━━━━━━━━━━━━━━")
    lines.append(f"💵 Jami: *{total_earnings:,.0f} so'm*")

    buttons = [
        [InlineKeyboardButton(f"👷 {r['worker']} batafsil", callback_data=f"kpi_worker:{year}:{month}:{r['worker']}")]
        for r in rows
    ]

    await query.edit_message_text(
        "\n".join(lines),
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(buttons),
    )


async def show_worker_kpi(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    _, year_s, month_s, worker = query.data.split(":", 3)
    year, month = int(year_s), int(month_s)

    rows = get_worker_monthly(worker, year, month)
    month_name = f"{MONTHS_UZ[month]} {year}"

    if not rows:
        await query.edit_message_text(f"*{worker}* — {month_name} ma'lumot yo'q.", parse_mode="Markdown")
        return

    total = sum(r["total_earnings"] for r in rows)
    lines = [f"👷 *{worker}* — {month_name}\n"]
    for r in rows:
        if r["total_kg"] and r["total_kg"] > 0:
            detail = f"{r['total_kg']:.1f} kg"
        else:
            detail = f"{r['total_qty']:,} dona"
        lines.append(f"📦 {r['product']}: {detail} → *{r['total_earnings']:,.0f} so'm*")
    lines.append(f"\n💰 Jami: *{total:,.0f} so'm*")

    back_btn = InlineKeyboardMarkup([
        [InlineKeyboardButton("⬅️ Ortga", callback_data=f"kpi_month:{year}:{month}")]
    ])

    await query.edit_message_text(
        "\n".join(lines),
        parse_mode="Markdown",
        reply_markup=back_btn,
    )


async def my_earnings(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    today = date.today()
    worker_name = context.user_data.get("worker_name")

    if not worker_name:
        await update.message.reply_text(
            "ℹ️ Bu funksiya hozircha admin uchun. /start bosing.",
            reply_markup=main_menu_keyboard(),
        )
        return

    rows = get_worker_monthly(worker_name, today.year, today.month)
    month_name = f"{MONTHS_UZ[today.month]} {today.year}"

    if not rows:
        await update.message.reply_text(f"Bu oy hali ma'lumot yo'q.", reply_markup=main_menu_keyboard())
        return

    total = sum(r["total_earnings"] for r in rows)
    lines = [f"💰 *Sizning hisobingiz* — {month_name}\n"]
    for r in rows:
        lines.append(f"📦 {r['product']}: *{r['total_earnings']:,.0f} so'm*")
    lines.append(f"\n✅ Jami: *{total:,.0f} so'm*")

    await update.message.reply_text("\n".join(lines), parse_mode="Markdown", reply_markup=main_menu_keyboard())


def register(app) -> None:
    app.add_handler(MessageHandler(filters.Regex(r"^📊 KPI Hisobot$"), show_kpi_menu))
    app.add_handler(CallbackQueryHandler(show_monthly_kpi, pattern=r"^kpi_month:"))
    app.add_handler(CallbackQueryHandler(show_worker_kpi, pattern=r"^kpi_worker:"))
