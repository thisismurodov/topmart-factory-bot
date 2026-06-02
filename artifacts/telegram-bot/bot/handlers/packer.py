from telegram import Update
from telegram.ext import (
    ContextTypes, ConversationHandler,
    CallbackQueryHandler, MessageHandler, filters,
)
from ..keyboards import packer_menu_keyboard, cancel_keyboard
from ..database import (
    add_worker, assign_packer_workers, get_packer_workers,
    get_user_role,
)
from ..config import normalize_phone, SUPERADMIN_CHAT_ID

PACKER_WORKER_NAME, PACKER_WORKER_PHONE = range(2)


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
