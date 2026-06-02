from datetime import date
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ContextTypes, CommandHandler, MessageHandler,
    CallbackQueryHandler, filters,
)
from ..keyboards import main_menu_keyboard, workers_keyboard
from ..database import get_today_batches, register_worker_chat, get_worker_monthly, get_worker_chat_id
from ..config import WORKERS

MONTHS_UZ = {
    1: "Yanvar", 2: "Fevral", 3: "Mart", 4: "Aprel",
    5: "May", 6: "Iyun", 7: "Iyul", 8: "Avgust",
    9: "Sentabr", 10: "Oktabr", 11: "Noyabr", 12: "Dekabr",
}


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    registered_as = _find_worker_by_chat(chat_id)

    if registered_as:
        await _show_worker_menu(update, registered_as)
    else:
        await update.message.reply_text(
            "👋 Xush kelibsiz!\n\n*TopMart Factory Bot* 🏭\n\n"
            "Siz kim sifatida kirmoqchisiz?",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("🏭 Admin / Upakovkachi", callback_data="role:admin")],
                [InlineKeyboardButton("👷 Ishchi (o'z hisobim)", callback_data="role:worker")],
            ]),
        )


async def role_selected(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    role = query.data.split(":", 1)[1]

    if role == "admin":
        await query.edit_message_text(
            "✅ Admin rejimida kirdinqiz.",
        )
        await query.message.reply_text(
            "Asosiy menyu:",
            reply_markup=main_menu_keyboard(),
        )
    else:
        from telegram import InlineKeyboardButton, InlineKeyboardMarkup
        from ..config import WORKERS
        buttons = [
            [InlineKeyboardButton(name, callback_data=f"reg_worker:{name}")]
            for name in WORKERS
        ]
        await query.edit_message_text(
            "👷 *Ismingizni tanlang:*",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup(buttons),
        )


async def worker_register(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    worker_name = query.data.split(":", 1)[1]
    chat_id     = update.effective_chat.id

    register_worker_chat(worker_name, chat_id)

    await query.edit_message_text(
        f"✅ *{worker_name}* sifatida ro'yxatdan o'tdingiz!\n\n"
        f"Endi har bir partiya kiritilganda hisobingiz yangilanadi.",
        parse_mode="Markdown",
    )
    await _show_worker_menu(update, worker_name)


async def _show_worker_menu(update: Update, worker_name: str) -> None:
    today  = date.today()
    rows   = get_worker_monthly(worker_name, today.year, today.month)
    total  = sum(r["total_earnings"] for r in rows)
    month  = MONTHS_UZ.get(today.month, "")

    lines = [f"👷 *{worker_name}* — {month} {today.year}\n"]
    if rows:
        for r in rows:
            detail = f"{r['total_kg']:.1f} kg" if r["total_kg"] > 0 else f"{r['total_qty']} dona"
            lines.append(f"📦 {r['product']}: {detail} → *{r['total_earnings']:,.0f} so'm*")
        lines.append(f"\n💰 Jami: *{total:,.0f} so'm*")
    else:
        lines.append("Bu oy hali partiya kiritilmagan.")

    target = update.message or update.callback_query.message
    await target.reply_text(
        "\n".join(lines),
        parse_mode="Markdown",
    )


def _find_worker_by_chat(chat_id: int) -> str | None:
    for name in WORKERS:
        if get_worker_chat_id(name) == chat_id:
            return name
    return None


async def today_batches_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    rows = get_today_batches()

    if not rows:
        await update.message.reply_text(
            "📋 Bugun hali partiya kiritilmagan.",
            reply_markup=main_menu_keyboard(),
        )
        return

    total_qty      = sum(r["quantity"] for r in rows)
    total_kg       = sum(r["weight_kg"] for r in rows)
    total_earnings = sum(r["earnings"]  for r in rows)

    today_str = date.today().strftime("%d.%m.%Y")
    lines = [f"📋 *Bugungi partiyalar* ({today_str}) — {len(rows)} ta\n"]
    for r in rows:
        kg_part = f" | {r['weight_kg']:.1f} kg" if r["weight_kg"] > 0 else ""
        lines.append(
            f"• `{r['batch_code']}` | {r['product']} | *{r['quantity']} dona*{kg_part}"
        )
    lines.append(f"\n📦 Jami: *{total_qty} dona*")
    if total_kg > 0:
        lines.append(f"⚖️ Jami og'irlik: *{total_kg:.1f} kg*")
    lines.append(f"💰 Jami haq: *{total_earnings:,.0f} so'm*")

    await update.message.reply_text(
        "\n".join(lines),
        parse_mode="Markdown",
        reply_markup=main_menu_keyboard(),
    )


async def unknown_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "Iltimos, quyidagi tugmalardan foydalaning:",
        reply_markup=main_menu_keyboard(),
    )


def register(app) -> None:
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CallbackQueryHandler(role_selected,    pattern=r"^role:"))
    app.add_handler(CallbackQueryHandler(worker_register,  pattern=r"^reg_worker:"))
    app.add_handler(
        MessageHandler(filters.Regex(r"^📋 Bugungi partiyalar$"), today_batches_handler)
    )
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, unknown_handler))
