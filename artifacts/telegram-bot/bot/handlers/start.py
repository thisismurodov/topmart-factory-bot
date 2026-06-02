from datetime import date
from telegram import Update, ReplyKeyboardRemove, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ContextTypes, CommandHandler, MessageHandler,
    CallbackQueryHandler, filters,
)
from ..keyboards import main_menu_keyboard, packer_menu_keyboard, contact_keyboard
from ..database import (
    get_today_batches, get_worker_monthly,
    get_user_role, set_user_role, find_user_by_phone,
    get_packer_workers, save_pending_user, get_pending_user,
    delete_pending_user, add_worker, assign_packer_workers,
    get_workers,
)
from ..config import normalize_phone, SUPERADMIN_CHAT_ID

MONTHS_UZ = {
    1: "Yanvar", 2: "Fevral", 3: "Mart", 4: "Aprel",
    5: "May", 6: "Iyun", 7: "Iyul", 8: "Avgust",
    9: "Sentabr", 10: "Oktabr", 11: "Noyabr", 12: "Dekabr",
}


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id  = update.effective_chat.id
    user_row = get_user_role(chat_id)

    if chat_id == SUPERADMIN_CHAT_ID and (not user_row or user_row["role"] != "admin"):
        set_user_role(chat_id, "Superadmin", "admin")
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
    contact    = update.message.contact
    phone      = normalize_phone(contact.phone_number or "")
    chat_id    = update.effective_chat.id
    tg_name    = (
        update.effective_user.full_name
        or update.effective_user.username
        or "Noma'lum"
    )

    worker_config = find_user_by_phone(phone)

    if not worker_config:
        save_pending_user(chat_id, tg_name, phone)

        await update.message.reply_text(
            "⏳ So'rovingiz adminga yuborildi.\nTasdiqlangach xabar olasiz.",
            reply_markup=ReplyKeyboardRemove(),
        )

        try:
            await context.bot.send_message(
                chat_id=SUPERADMIN_CHAT_ID,
                text=(
                    f"👤 *Yangi foydalanuvchi so'rovi:*\n\n"
                    f"Ism: *{tg_name}*\n"
                    f"Tel: `+{phone}`\n"
                    f"Chat ID: `{chat_id}`\n\n"
                    f"Kim sifatida qo'shilsin?"
                ),
                parse_mode="Markdown",
                reply_markup=InlineKeyboardMarkup([
                    [
                        InlineKeyboardButton("👷 Worker",   callback_data=f"appusr:{chat_id}:worker"),
                        InlineKeyboardButton("📦 Packer",  callback_data=f"appusr:{chat_id}:packer"),
                    ],
                    [InlineKeyboardButton("❌ Rad etish", callback_data=f"rejusr:{chat_id}")],
                ]),
            )
        except Exception:
            pass
        return

    name = worker_config["name"]
    role = worker_config["role"]
    set_user_role(chat_id, name, role)

    icon = "📦" if role == "packer" else "👷"
    await update.message.reply_text(
        f"{icon} *{name}*, xush kelibsiz!\nLavozim: *{role}*",
        parse_mode="Markdown",
        reply_markup=ReplyKeyboardRemove(),
    )

    if role == "packer":
        await _show_packer_menu(update, chat_id, name)
    else:
        await _show_worker_earnings(update, name)


async def approve_user_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()

    if query.from_user.id != SUPERADMIN_CHAT_ID:
        await query.answer("Ruxsat yo'q.", show_alert=True)
        return

    _, pending_chat_id_s, role = query.data.split(":", 2)
    pending_chat_id = int(pending_chat_id_s)

    pending = get_pending_user(pending_chat_id)
    if not pending:
        await query.edit_message_text("⚠️ Bu so'rov allaqachon ko'rib chiqilgan.")
        return

    tg_name = pending["name"]
    phone   = pending["phone"]
    prefix  = _auto_prefix(tg_name)

    add_worker(tg_name, prefix, phone, role)
    set_user_role(pending_chat_id, tg_name, role)
    delete_pending_user(pending_chat_id)

    icon = "📦" if role == "packer" else "👷"
    await query.edit_message_text(
        f"{icon} *{tg_name}* — {role} sifatida qo'shildi\n"
        f"Tel: `+{phone}` | Prefix: `{prefix}`",
        parse_mode="Markdown",
    )

    try:
        if role == "packer":
            msg_text = (
                f"✅ *Tasdiqlandi!*\n\n"
                f"Siz *Upakovkachi* sifatida qo'shildingiz.\n"
                f"Hodimlaringiz belgilanishi bilan /start orqali kirishingiz mumkin."
            )
        else:
            msg_text = (
                f"✅ *Tasdiqlandi!*\n\n"
                f"Siz tizimga *Ishchi* sifatida qo'shildingiz.\n"
                f"Davom etish uchun /start bosing."
            )
        await context.bot.send_message(
            chat_id=pending_chat_id,
            text=msg_text,
            parse_mode="Markdown",
        )
    except Exception:
        pass


async def reject_user_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()

    if query.from_user.id != SUPERADMIN_CHAT_ID:
        await query.answer("Ruxsat yo'q.", show_alert=True)
        return

    pending_chat_id = int(query.data.split(":", 1)[1])
    pending = get_pending_user(pending_chat_id)
    if not pending:
        await query.edit_message_text("⚠️ Bu so'rov allaqachon ko'rib chiqilgan.")
        return

    delete_pending_user(pending_chat_id)
    await query.edit_message_text(f"❌ *{pending['name']}* rad etildi.")

    try:
        await context.bot.send_message(
            chat_id=pending_chat_id,
            text="❌ Afsuski, so'rovingiz rad etildi.\nBatafsil ma'lumot uchun admin bilan bog'laning.",
        )
    except Exception:
        pass


def _auto_prefix(name: str) -> str:
    clean = "".join(c for c in name if c.isalpha())
    return clean[:2].upper() if len(clean) >= 2 else (clean + "X")[:2].upper()


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
        info = "ℹ️ Hodimlar hali belgilanmagan."

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
    kb = packer_menu_keyboard() if (user_row and user_row["role"] == "packer") else main_menu_keyboard()
    await update.message.reply_text("Iltimos, quyidagi tugmalardan foydalaning:", reply_markup=kb)


def register(app) -> None:
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("menu",  cmd_menu))
    app.add_handler(MessageHandler(filters.CONTACT, contact_received))
    app.add_handler(CallbackQueryHandler(approve_user_callback, pattern=r"^appusr:"))
    app.add_handler(CallbackQueryHandler(reject_user_callback,  pattern=r"^rejusr:"))
    app.add_handler(
        MessageHandler(filters.Regex(r"^📋 Bugungi partiyalar$"), today_batches_handler)
    )
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, unknown_handler))
