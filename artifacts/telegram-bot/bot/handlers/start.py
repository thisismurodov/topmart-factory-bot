from datetime import date
from telegram import Update, ReplyKeyboardRemove
from telegram.ext import (
    ContextTypes, CommandHandler, MessageHandler, filters,
)
from ..keyboards import main_menu_keyboard, packer_menu_keyboard, contact_keyboard
from ..database import (
    get_today_batches, get_worker_monthly,
    get_user_role, set_user_role, find_user_by_phone,
    get_packer_workers,
)
from ..config import normalize_phone

MONTHS_UZ = {
    1: "Yanvar", 2: "Fevral", 3: "Mart", 4: "Aprel",
    5: "May", 6: "Iyun", 7: "Iyul", 8: "Avgust",
    9: "Sentabr", 10: "Oktabr", 11: "Noyabr", 12: "Dekabr",
}


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id  = update.effective_chat.id
    user_row = get_user_role(chat_id)

    if user_row:
        role = user_row["role"]
        name = user_row["worker_name"]
        if role == "admin":
            await update.message.reply_text(
                f"👑 *Admin* — {name}\nAsosiy menyu:",
                parse_mode="Markdown",
                reply_markup=main_menu_keyboard(),
            )
        elif role == "packer":
            await _show_packer_menu(update, chat_id, name)
        else:
            await _show_worker_earnings(update, name)
        return

    await update.message.reply_text(
        "👋 *TopMart Factory Bot* 🏭\n\n"
        "Telefon raqamingizni ulang — tizim sizni avtomatik aniqlaydi.",
        parse_mode="Markdown",
        reply_markup=contact_keyboard(),
    )


async def contact_received(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    contact = update.message.contact
    phone   = normalize_phone(contact.phone_number or "")
    chat_id = update.effective_chat.id

    worker_config = find_user_by_phone(phone)

    if not worker_config:
        await update.message.reply_text(
            "❌ Bu raqam tizimda topilmadi.\n"
            "Adminga murojaat qiling yoki /admin orqali qo'shing.",
            reply_markup=ReplyKeyboardRemove(),
        )
        return

    name = worker_config["name"]
    role = worker_config["role"]
    set_user_role(chat_id, name, role)

    icon = "📦" if role == "packer" else "👷"
    await update.message.reply_text(
        f"{icon} *{name}*, xush kelibsiz!\n"
        f"Lavozim: *{role}*",
        parse_mode="Markdown",
        reply_markup=ReplyKeyboardRemove(),
    )

    if role == "packer":
        await _show_packer_menu(update, chat_id, name)
    else:
        await _show_worker_earnings(update, name)


async def cmd_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id  = update.effective_chat.id
    user_row = get_user_role(chat_id)
    if user_row and user_row["role"] == "packer":
        await update.message.reply_text("Menyu:", reply_markup=packer_menu_keyboard())
    else:
        await update.message.reply_text("Menyu:", reply_markup=main_menu_keyboard())


async def _show_worker_earnings(update: Update, worker_name: str) -> None:
    today = date.today()
    rows  = get_worker_monthly(worker_name, today.year, today.month)
    total = sum(r["total_earnings"] for r in rows)
    month = MONTHS_UZ.get(today.month, "")

    lines = [f"👷 *{worker_name}* — {month} {today.year}\n"]
    if rows:
        for r in rows:
            detail = f"{r['total_kg']:.1f} kg" if r["total_kg"] > 0 else f"{r['total_qty']} dona"
            lines.append(f"📦 {r['product']}: {detail} → *{r['total_earnings']:,.0f} so'm*")
        lines.append(f"\n💰 Jami: *{total:,.0f} so'm*")
    else:
        lines.append("Bu oy hali partiya kiritilmagan.")

    msg = update.message or update.callback_query.message
    await msg.reply_text("\n".join(lines), parse_mode="Markdown")


async def _show_packer_menu(update: Update, chat_id: int, packer_name: str) -> None:
    assigned = get_packer_workers(chat_id)
    if assigned:
        workers_txt = ", ".join(assigned)
        info = f"Mas'ul hodimlar: *{workers_txt}*"
    else:
        info = "⚠️ Hech qanday hodim belgilanmagan. Admin bilan bog'laning."

    msg = update.message or update.callback_query.message
    await msg.reply_text(
        f"📦 *Upakovkachi* — {packer_name}\n{info}\n\nQuyidagi tugmalardan foydalaning:",
        parse_mode="Markdown",
        reply_markup=packer_menu_keyboard(),
    )


async def today_batches_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id  = update.effective_chat.id
    user_row = get_user_role(chat_id)

    worker_filter = None
    if user_row and user_row["role"] == "packer":
        worker_filter = get_packer_workers(chat_id)
        kb = packer_menu_keyboard()
    else:
        kb = main_menu_keyboard()

    rows = get_today_batches(worker_filter=worker_filter)

    if not rows:
        msg = "📋 Bugun hali partiya kiritilmagan."
        if worker_filter is not None and not worker_filter:
            msg = "⚠️ Sizga hech qanday hodim belgilanmagan."
        await update.message.reply_text(msg, reply_markup=kb)
        return

    total_qty      = sum(r["quantity"]  for r in rows)
    total_kg       = sum(r["weight_kg"] for r in rows)
    total_earnings = sum(r["earnings"]  for r in rows)

    today_str = date.today().strftime("%d.%m.%Y")
    lines = [f"📋 *Bugungi partiyalar* ({today_str}) — {len(rows)} ta\n"]
    for r in rows:
        kg_part = f" | {r['weight_kg']:.1f} kg" if r["weight_kg"] > 0 else ""
        lines.append(
            f"• `{r['batch_code']}` | {r['worker']} | {r['product']} | *{r['quantity']} dona*{kg_part}"
        )
    lines.append(f"\n📦 Jami: *{total_qty} dona*")
    if total_kg > 0:
        lines.append(f"⚖️ Jami og'irlik: *{total_kg:.1f} kg*")
    lines.append(f"💰 Jami haq: *{total_earnings:,.0f} so'm*")

    await update.message.reply_text("\n".join(lines), parse_mode="Markdown", reply_markup=kb)


async def unknown_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id  = update.effective_chat.id
    user_row = get_user_role(chat_id)
    if user_row and user_row["role"] == "packer":
        kb = packer_menu_keyboard()
    else:
        kb = main_menu_keyboard()
    await update.message.reply_text("Iltimos, quyidagi tugmalardan foydalaning:", reply_markup=kb)


def register(app) -> None:
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("menu",  cmd_menu))
    app.add_handler(MessageHandler(filters.CONTACT, contact_received))
    app.add_handler(
        MessageHandler(filters.Regex(r"^📋 Bugungi partiyalar$"), today_batches_handler)
    )
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, unknown_handler))
