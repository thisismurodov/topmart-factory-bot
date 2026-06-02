from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ContextTypes, CommandHandler, ConversationHandler,
    CallbackQueryHandler, MessageHandler, filters,
)
from ..keyboards import admin_main_keyboard, main_menu_keyboard
from ..database import (
    get_admin_count, get_user_role, set_user_role,
    add_worker, add_product, get_all_workers_config,
    get_products, get_registered_packers,
    assign_packer_workers, get_packer_workers, get_workers,
)

(
    ADM_HOME,
    WORKER_NAME, WORKER_PREFIX, WORKER_PHONE, WORKER_ROLE,
    PRODUCT_NAME, PRODUCT_TYPE, PRODUCT_RATE,
    PACKER_SELECT, PACKER_WORKERS,
) = range(10)


# ── Entry ────────────────────────────────────────────────────────────────────

async def cmd_admin(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    chat_id = update.effective_chat.id
    user_row = get_user_role(chat_id)
    admin_count = get_admin_count()

    if user_row and user_row["role"] == "admin":
        pass
    elif admin_count == 0:
        set_user_role(chat_id, "Admin", "admin")
        await update.message.reply_text(
            "👑 Siz birinchi *admin* sifatida qo'shildingiz!",
            parse_mode="Markdown",
        )
    else:
        await update.message.reply_text("❌ Ruxsat yo'q.")
        return ConversationHandler.END

    await update.message.reply_text(
        "⚙️ *Admin paneli*\nNimani qilmoqchisiz?",
        parse_mode="Markdown",
        reply_markup=admin_main_keyboard(),
    )
    return ADM_HOME


async def adm_home_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    action = query.data.split(":", 1)[1]

    if action == "add_worker":
        await query.edit_message_text(
            "👷 *Yangi hodim ismi:*\n_(misol: Dilnoza)_",
            parse_mode="Markdown",
        )
        return WORKER_NAME

    elif action == "add_product":
        await query.edit_message_text(
            "📦 *Yangi mahsulot nomi:*\n_(misol: Tulpor 2)_",
            parse_mode="Markdown",
        )
        return PRODUCT_NAME

    elif action == "assign_packer":
        packers = get_registered_packers()
        if not packers:
            await query.edit_message_text(
                "⚠️ Hech qanday upakovkachi ro'yxatdan o'tmagan.\n"
                "Avval upakovkachi /start orqali telefon raqamini ulashi kerak.",
                reply_markup=admin_main_keyboard(),
            )
            return ADM_HOME
        buttons = [
            [InlineKeyboardButton(r["worker_name"], callback_data=f"pk_sel:{r['chat_id']}:{r['worker_name']}")]
            for r in packers
        ]
        buttons.append([InlineKeyboardButton("⬅️ Ortga", callback_data="adm:back")])
        await query.edit_message_text(
            "👔 *Upakovkachini tanlang:*",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup(buttons),
        )
        return PACKER_SELECT

    elif action == "list_workers":
        rows = get_all_workers_config()
        if not rows:
            text = "Hodimlar yo'q."
        else:
            lines = ["👷 *Hodimlar ro'yxati:*\n"]
            for r in rows:
                icon = "👔" if r["role"] == "packer" else "👷"
                phone = r["phone"] or "—"
                lines.append(f"{icon} *{r['name']}* ({r['prefix'] or '—'}) | {r['role']} | {phone}")
            text = "\n".join(lines)
        await query.edit_message_text(text, parse_mode="Markdown", reply_markup=admin_main_keyboard())
        return ADM_HOME

    elif action == "list_products":
        prods = get_products()
        if not prods:
            text = "Mahsulotlar yo'q."
        else:
            lines = ["📦 *Mahsulotlar ro'yxati:*\n"]
            for name, rate_type, rate in prods:
                lines.append(f"• {name} — {rate:,.0f} so'm/{rate_type}")
            text = "\n".join(lines)
        await query.edit_message_text(text, parse_mode="Markdown", reply_markup=admin_main_keyboard())
        return ADM_HOME

    elif action == "back":
        await query.edit_message_text(
            "⚙️ *Admin paneli*", parse_mode="Markdown",
            reply_markup=admin_main_keyboard(),
        )
        return ADM_HOME

    return ADM_HOME


# ── Add Worker flow ───────────────────────────────────────────────────────────

async def worker_name_received(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    name = update.message.text.strip()
    if len(name) < 2:
        await update.message.reply_text("⚠️ Ism juda qisqa. Qayta yozing:")
        return WORKER_NAME
    context.user_data["new_worker"] = {"name": name}
    await update.message.reply_text(
        f"✏️ *{name}* uchun prefiks (2-3 harf, masalan AZ):",
        parse_mode="Markdown",
    )
    return WORKER_PREFIX


async def worker_prefix_received(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    prefix = update.message.text.strip().upper()
    if not prefix.isalpha() or len(prefix) > 4:
        await update.message.reply_text("⚠️ Faqat 2-4 harf (masalan: DL). Qayta yozing:")
        return WORKER_PREFIX
    context.user_data["new_worker"]["prefix"] = prefix
    await update.message.reply_text(
        "📱 Telefon raqami (misol: 998901234567):\n_(raqam yo'q bo'lsa — deb yozing)_",
        parse_mode="Markdown",
    )
    return WORKER_PHONE


async def worker_phone_received(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    from ..config import normalize_phone
    text = update.message.text.strip()
    phone = "" if text == "—" else normalize_phone(text)
    context.user_data["new_worker"]["phone"] = phone
    await update.message.reply_text(
        "👔 Lavozimi:",
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton("👷 Ishchi (worker)", callback_data="nw_role:worker")],
            [InlineKeyboardButton("📦 Upakovkachi (packer)", callback_data="nw_role:packer")],
        ]),
    )
    return WORKER_ROLE


async def worker_role_received(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    role = query.data.split(":", 1)[1]
    d = context.user_data.pop("new_worker")
    d["role"] = role

    ok = add_worker(d["name"], d["prefix"], d["phone"], role)
    if ok:
        icon = "📦" if role == "packer" else "👷"
        await query.edit_message_text(
            f"{icon} *{d['name']}* qo'shildi!\n"
            f"Prefiks: `{d['prefix']}` | Tel: `{d['phone'] or '—'}` | Rol: {role}",
            parse_mode="Markdown",
        )
    else:
        await query.edit_message_text(f"⚠️ *{d['name']}* allaqachon mavjud.")
    await query.message.reply_text(
        "⚙️ Admin paneli:", reply_markup=admin_main_keyboard()
    )
    return ADM_HOME


# ── Add Product flow ──────────────────────────────────────────────────────────

async def product_name_received(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    name = update.message.text.strip()
    if len(name) < 2:
        await update.message.reply_text("⚠️ Nom juda qisqa. Qayta yozing:")
        return PRODUCT_NAME
    context.user_data["new_product"] = {"name": name}
    await update.message.reply_text(
        f"📦 *{name}* uchun hisoblash turi:",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton("⚖️ Kg bo'yicha", callback_data="np_type:kg")],
            [InlineKeyboardButton("🔢 Dona bo'yicha", callback_data="np_type:dona")],
        ]),
    )
    return PRODUCT_TYPE


async def product_type_received(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    rate_type = query.data.split(":", 1)[1]
    context.user_data["new_product"]["rate_type"] = rate_type
    unit = "kg" if rate_type == "kg" else "dona"
    await query.edit_message_text(
        f"💰 Narx (so'm/{unit}):\n_(masalan: 1500)_",
        parse_mode="Markdown",
    )
    return PRODUCT_RATE


async def product_rate_received(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    text = update.message.text.strip().replace(" ", "").replace(",", ".")
    try:
        rate = float(text)
        if rate <= 0:
            raise ValueError
    except ValueError:
        await update.message.reply_text("⚠️ To'g'ri narx kiriting (masalan: 1500):")
        return PRODUCT_RATE

    d = context.user_data.pop("new_product")
    ok = add_product(d["name"], d["rate_type"], rate)
    if ok:
        await update.message.reply_text(
            f"✅ *{d['name']}* qo'shildi!\n"
            f"{rate:,.0f} so'm/{d['rate_type']}",
            parse_mode="Markdown",
        )
    else:
        await update.message.reply_text(f"⚠️ *{d['name']}* allaqachon mavjud.")
    await update.message.reply_text("⚙️ Admin paneli:", reply_markup=admin_main_keyboard())
    return ADM_HOME


# ── Packer assignment flow ────────────────────────────────────────────────────

async def packer_selected(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    _, packer_chat_id_s, packer_name = query.data.split(":", 2)
    packer_chat_id = int(packer_chat_id_s)
    context.user_data["packer_chat_id"] = packer_chat_id
    context.user_data["packer_name"]    = packer_name

    assigned = set(get_packer_workers(packer_chat_id))
    workers  = list(get_workers().keys())

    context.user_data["packer_selected"] = set(assigned)

    buttons = []
    for w in workers:
        check = "✅" if w in assigned else "☐"
        buttons.append([InlineKeyboardButton(f"{check} {w}", callback_data=f"pk_tog:{w}")])
    buttons.append([InlineKeyboardButton("💾 Saqlash", callback_data="pk_save")])

    await query.edit_message_text(
        f"👔 *{packer_name}* — hodimlarni belgilang:",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(buttons),
    )
    return PACKER_WORKERS


async def packer_worker_toggle(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    worker = query.data.split(":", 1)[1]
    selected: set = context.user_data.get("packer_selected", set())

    if worker in selected:
        selected.discard(worker)
    else:
        selected.add(worker)
    context.user_data["packer_selected"] = selected

    packer_chat_id = context.user_data["packer_chat_id"]
    packer_name    = context.user_data["packer_name"]
    workers = list(get_workers().keys())

    buttons = []
    for w in workers:
        check = "✅" if w in selected else "☐"
        buttons.append([InlineKeyboardButton(f"{check} {w}", callback_data=f"pk_tog:{w}")])
    buttons.append([InlineKeyboardButton("💾 Saqlash", callback_data="pk_save")])

    await query.edit_message_reply_markup(reply_markup=InlineKeyboardMarkup(buttons))
    return PACKER_WORKERS


async def packer_save(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    packer_chat_id = context.user_data.pop("packer_chat_id")
    packer_name    = context.user_data.pop("packer_name")
    selected       = list(context.user_data.pop("packer_selected", set()))

    assign_packer_workers(packer_chat_id, selected)

    worker_list = ", ".join(selected) if selected else "hech kim"
    await query.edit_message_text(
        f"✅ *{packer_name}* uchun belgilandi:\n{worker_list}",
        parse_mode="Markdown",
    )
    await query.message.reply_text("⚙️ Admin paneli:", reply_markup=admin_main_keyboard())
    return ADM_HOME


# ── Cancel ────────────────────────────────────────────────────────────────────

async def adm_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data.clear()
    await update.message.reply_text(
        "❌ Bekor qilindi.", reply_markup=main_menu_keyboard()
    )
    return ConversationHandler.END


def build_admin_handler() -> ConversationHandler:
    return ConversationHandler(
        entry_points=[CommandHandler("admin", cmd_admin)],
        states={
            ADM_HOME: [
                CallbackQueryHandler(adm_home_callback, pattern=r"^adm:"),
            ],
            WORKER_NAME: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, worker_name_received),
            ],
            WORKER_PREFIX: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, worker_prefix_received),
            ],
            WORKER_PHONE: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, worker_phone_received),
            ],
            WORKER_ROLE: [
                CallbackQueryHandler(worker_role_received, pattern=r"^nw_role:"),
            ],
            PRODUCT_NAME: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, product_name_received),
            ],
            PRODUCT_TYPE: [
                CallbackQueryHandler(product_type_received, pattern=r"^np_type:"),
            ],
            PRODUCT_RATE: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, product_rate_received),
            ],
            PACKER_SELECT: [
                CallbackQueryHandler(packer_selected,      pattern=r"^pk_sel:"),
                CallbackQueryHandler(adm_home_callback,    pattern=r"^adm:"),
            ],
            PACKER_WORKERS: [
                CallbackQueryHandler(packer_worker_toggle, pattern=r"^pk_tog:"),
                CallbackQueryHandler(packer_save,          pattern=r"^pk_save$"),
            ],
        },
        fallbacks=[MessageHandler(filters.COMMAND, adm_cancel)],
        per_message=False,
        allow_reentry=True,
    )
