import logging

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ContextTypes, ConversationHandler,
    CallbackQueryHandler, MessageHandler, filters,
)
from ..keyboards import packer_menu_keyboard, cancel_keyboard
from ..database import (
    add_worker, assign_packer_workers, get_packer_workers,
    get_user_role, get_packer_lines, get_packer_line_preview,
    get_worker_chat_id, close_day, PackerLineAccessError,
)
from ..config import normalize_phone, SUPERADMIN_CHAT_ID

PACKER_WORKER_NAME, PACKER_WORKER_PHONE = range(2)
_log = logging.getLogger(__name__)

ROLE_UZ = {
    "producer": "Ishlab chiqaruvchi",
    "IShlabchiqaruvchi": "Chiqaruvchi",
    "preparation": "Tayyorlash",
    "packaging": "Upakovka",
    "packer": "Upakovka",
    "pock": "Pochkalash",
    "Uvopchi": "Ip O'rovchi",
    "o'rash": "O'rash",
}


async def start_add_worker(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    chat_id  = update.effective_chat.id
    user_row = get_user_role(chat_id)

    if not user_row or user_row["role"] != "packer":
        await update.message.reply_text("❌ Bu funksiya faqat upakovkachi uchun.")
        return ConversationHandler.END

    context.user_data["packer_chat_id"]   = chat_id
    context.user_data["packer_name"]      = user_row["worker_name"]

    await update.message.reply_text(
        "👷 *Yangi hodim ismi:*\n_(masalan: Dilnoza)_",
        parse_mode="Markdown",
        reply_markup=cancel_keyboard(),
    )
    return PACKER_WORKER_NAME


async def worker_name_step(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    name = update.message.text.strip()
    if len(name) < 2:
        await update.message.reply_text("⚠️ Ism juda qisqa:", reply_markup=cancel_keyboard())
        return PACKER_WORKER_NAME

    context.user_data["new_w_name"] = name
    await update.message.reply_text(
        f"📱 *{name}* telefon raqami:\n_(masalan: 998901234567)_",
        parse_mode="Markdown",
        reply_markup=cancel_keyboard(),
    )
    return PACKER_WORKER_PHONE


async def worker_phone_step(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    text  = update.message.text.strip()
    phone = normalize_phone(text)

    if len(phone) < 9:
        await update.message.reply_text(
            "⚠️ To'g'ri telefon raqam kiriting:", reply_markup=cancel_keyboard()
        )
        return PACKER_WORKER_PHONE

    name         = context.user_data.pop("new_w_name")
    packer_cid   = context.user_data.pop("packer_chat_id")
    packer_name  = context.user_data.pop("packer_name")

    prefix = _auto_prefix(name)
    add_worker(name, prefix, phone, role="worker")

    current_workers = get_packer_workers(packer_cid)
    if name not in current_workers:
        assign_packer_workers(packer_cid, current_workers + [name])

    await update.message.reply_text(
        f"✅ *{name}* qo'shildi!\n"
        f"Tel: `+{phone}`\n\n"
        f"U endi /start orqali botga ulanishi mumkin.",
        parse_mode="Markdown",
        reply_markup=packer_menu_keyboard(),
    )

    try:
        await update.get_bot().send_message(
            chat_id=SUPERADMIN_CHAT_ID,
            text=(
                f"👤 *Yangi hodim qo'shildi*\n\n"
                f"Packer: *{packer_name}*\n"
                f"Hodim: *{name}*\n"
                f"Tel: `+{phone}`"
            ),
            parse_mode="Markdown",
        )
    except Exception:
        pass

    return ConversationHandler.END


async def cancel_cb(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    context.user_data.clear()
    await query.edit_message_text("❌ Bekor qilindi.")
    await query.message.reply_text("Menyu:", reply_markup=packer_menu_keyboard())
    return ConversationHandler.END


async def cancel_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data.clear()
    await update.message.reply_text("❌ Bekor qilindi.", reply_markup=packer_menu_keyboard())
    return ConversationHandler.END


def _line_result_text(line: dict, repeated: bool = False) -> str:
    total_amount = sum(float(entry["amount"]) for entry in line["entries"])
    heading = (
        "ℹ️ Bu liniya bugun avval yopilgan."
        if repeated
        else "✅ Bugungi liniya yopildi."
    )
    rows = [
        heading,
        "",
        f"📦 Liniya: {line['line_name']}",
        f"⚖️ Jami hisob hajmi: {line['total_kg']:,.2f}",
        "",
        "💰 Hisoblangan maoshlar:",
    ]
    if line["entries"]:
        for entry in line["entries"]:
            role = ROLE_UZ.get(entry["role"], entry["role"])
            rows.append(
                f"• {entry['worker']} — {role}: "
                f"{entry['amount']:,.0f} so'm"
            )
    else:
        rows.append("• Maosh yozuvi yaratilmadi.")
    rows.extend(["", f"💵 Jami maosh: {total_amount:,.0f} so'm"])
    return "\n".join(rows)


async def _show_line_confirmation(message, packer_chat_id: int, line_id: int) -> None:
    edit_text = (
        message.edit_text
        if hasattr(message, "edit_text")
        else message.edit_message_text
    )
    try:
        preview = get_packer_line_preview(packer_chat_id, line_id)
    except PackerLineAccessError:
        await edit_text("❌ Bu liniyani yopishga ruxsatingiz yo'q.")
        return

    if preview["already_closed"]:
        await edit_text(_line_result_text(preview, repeated=True))
        return

    if preview["total_kg"] <= 0:
        await edit_text(
            f"⚠️ {preview['line_name']} liniyasida bugun "
            "ROLE_BASED_KG partiyasi topilmadi.\nKunni yopib bo'lmaydi."
        )
        return

    await edit_text(
        "⚠️ KUNNI YOPISHNI TASDIQLANG\n\n"
        f"📦 Liniya: {preview['line_name']}\n"
        f"⚖️ Bugungi jami hisob hajmi: {preview['total_kg']:,.2f}\n\n"
        "Tasdiqlangach barcha liniya xodimlarining bugungi maoshi "
        "stavka bo'yicha hisoblanadi va muzlatiladi. Keyingi partiyalar "
        "bu kunning maoshiga qo'shilmaydi.",
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton(
                "✅ Ha, liniyani yoping",
                callback_data=f"pclose:confirm:{line_id}",
            )],
            [InlineKeyboardButton(
                "❌ Bekor qilish",
                callback_data="pclose:cancel",
            )],
        ]),
    )


async def start_close_day(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> None:
    if update.effective_chat.type != "private":
        await update.message.reply_text(
            "❌ Kunni yopish faqat bot bilan shaxsiy chatda ishlaydi."
        )
        return

    user_id = update.effective_user.id
    user_row = get_user_role(user_id)
    if not user_row or user_row["role"] != "packer":
        await update.message.reply_text(
            "❌ Bu funksiya faqat ro'yxatdan o'tgan upakovkachi uchun."
        )
        return

    lines = get_packer_lines(user_id)
    if not lines:
        await update.message.reply_text(
            "⚠️ Sizga ishlab chiqarish liniyasi biriktirilmagan.\n"
            "Admin liniya xodimlari yoki packer biriktirishini tekshirsin.",
            reply_markup=packer_menu_keyboard(),
        )
        return

    if len(lines) == 1:
        waiting = await update.message.reply_text("⏳ Liniya holati tekshirilmoqda...")
        await _show_line_confirmation(waiting, user_id, int(lines[0]["id"]))
        return

    buttons = [
        [InlineKeyboardButton(
            line["name"],
            callback_data=f"pclose:line:{line['id']}",
        )]
        for line in lines
    ]
    buttons.append([
        InlineKeyboardButton("❌ Bekor qilish", callback_data="pclose:cancel")
    ])
    await update.message.reply_text(
        "📦 Qaysi liniyaning bugungi ishini yakunlaysiz?",
        reply_markup=InlineKeyboardMarkup(buttons),
    )


async def _notify_salary_workers(
    context: ContextTypes.DEFAULT_TYPE,
    entries: list[dict],
) -> None:
    """Faqat yangi salary entry olgan xodimlarni bir marta xabardor qiladi."""
    for entry in entries:
        chat_id = get_worker_chat_id(entry["worker"])
        if not chat_id:
            continue
        role = ROLE_UZ.get(entry["role"], entry["role"])
        try:
            await context.bot.send_message(
                chat_id=chat_id,
                text=(
                    "💰 Kunlik maosh hisoblandi\n\n"
                    f"📦 Liniya: {entry['line_name']}\n"
                    f"👷 Rol: {role}\n"
                    f"💵 Summa: {entry['amount']:,.0f} so'm"
                ),
            )
        except Exception as exc:
            _log.warning(
                "Kunlik maosh xabari yuborilmadi (%s): %s",
                entry["worker"],
                exc,
            )


async def close_day_callback(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> None:
    query = update.callback_query
    await query.answer()

    if update.effective_chat.type != "private":
        await query.edit_message_text(
            "❌ Kunni yopish faqat bot bilan shaxsiy chatda ishlaydi."
        )
        return

    user_id = query.from_user.id

    if query.data == "pclose:cancel":
        await query.edit_message_text("❌ Kunni yopish bekor qilindi.")
        await query.message.reply_text(
            "Menyu:",
            reply_markup=packer_menu_keyboard(),
        )
        return

    user_row = get_user_role(user_id)
    if not user_row or user_row["role"] != "packer":
        await query.edit_message_text(
            "❌ Bu funksiya faqat ro'yxatdan o'tgan upakovkachi uchun."
        )
        return

    parts = query.data.split(":")
    if len(parts) != 3 or not parts[2].isdigit():
        await query.edit_message_text("⚠️ Noto'g'ri liniya tanlandi.")
        return
    action = parts[1]
    line_id = int(parts[2])

    if action == "line":
        await _show_line_confirmation(query, user_id, line_id)
        return
    if action != "confirm":
        await query.edit_message_text("⚠️ Noma'lum amal.")
        return

    try:
        preview = get_packer_line_preview(user_id, line_id)
        if not preview["already_closed"] and preview["total_kg"] <= 0:
            await query.edit_message_text(
                "⚠️ Bu liniyada bugun partiya yo'q. Kunni yopib bo'lmaydi."
            )
            return
        result = close_day(
            closed_by=f"telegram-packer:{user_id}:{user_row['worker_name']}",
            line_id=line_id,
            authorized_packer_chat_id=user_id,
        )
    except PackerLineAccessError:
        await query.edit_message_text(
            "❌ Bu liniyani yopishga ruxsatingiz yo'q."
        )
        return
    except ValueError:
        await query.edit_message_text("⚠️ Ishlab chiqarish liniyasi topilmadi.")
        return

    if not result["lines"]:
        await query.edit_message_text("⚠️ Liniya natijasi topilmadi.")
        return

    line = result["lines"][0]
    await query.edit_message_text(
        _line_result_text(line, repeated=line["already_closed"])
    )
    await _notify_salary_workers(context, result["new_entries"])


def _auto_prefix(name: str) -> str:
    clean = "".join(c for c in name if c.isalpha())
    return clean[:2].upper() if len(clean) >= 2 else (clean + "X")[:2].upper()


def build_packer_handler() -> ConversationHandler:
    return ConversationHandler(
        entry_points=[
            MessageHandler(filters.Regex(r"^👷 Hodim qo'shish$"), start_add_worker),
        ],
        states={
            PACKER_WORKER_NAME: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, worker_name_step),
                CallbackQueryHandler(cancel_cb, pattern=r"^cancel$"),
            ],
            PACKER_WORKER_PHONE: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, worker_phone_step),
                CallbackQueryHandler(cancel_cb, pattern=r"^cancel$"),
            ],
        },
        fallbacks=[MessageHandler(filters.COMMAND, cancel_cmd)],
        per_message=False,
        allow_reentry=True,
    )


def register_close_day_handlers(app) -> None:
    app.add_handler(MessageHandler(
        filters.Regex(r"^✅ Bugungi partiyalar tugadi$"),
        start_close_day,
    ))
    app.add_handler(CallbackQueryHandler(
        close_day_callback,
        pattern=r"^pclose:",
    ))
