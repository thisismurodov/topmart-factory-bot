from datetime import date, datetime
from telegram import Update
from telegram.ext import (
    ContextTypes, ConversationHandler,
    CallbackQueryHandler, MessageHandler, filters,
)
from ..keyboards import (
    workers_inline_keyboard, products_inline_keyboard, cancel_keyboard,
    main_menu_keyboard, packer_menu_keyboard, weight_confirm_keyboard,
    batch_cart_keyboard,
)
from ..database import (
    create_batch_session, get_worker_chat_id, get_workers,
    get_products, get_product_weight, get_user_role, get_worker_monthly,
)
from ..config import calc_earnings, SUPERADMIN_CHAT_ID
from ..label_generator import generate_batch_session_pdf

CHOOSE_WORKER, CHOOSE_PRODUCT, ENTER_QUANTITY, ENTER_WEIGHT, AFTER_ITEM = range(5)

# Profil og'irligidan ruxsat etilgan chetlanish (±kg)
WEIGHT_TOLERANCE_KG = 0.2

MONTHS_UZ = {
    1: "Yanvar", 2: "Fevral", 3: "Mart", 4: "Aprel",
    5: "May", 6: "Iyun", 7: "Iyul", 8: "Avgust",
    9: "Sentabr", 10: "Oktabr", 11: "Noyabr", 12: "Dekabr",
}


async def start_input(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    chat_id = update.effective_chat.id
    user_row = get_user_role(chat_id)
    if user_row and user_row["role"] == "packer":
        context.user_data["_packer_name"] = user_row["worker_name"]
        kb = workers_inline_keyboard(packer_chat_id=chat_id)
    else:
        context.user_data.pop("_packer_name", None)
        kb = workers_inline_keyboard()
    # Yangi sessiya — savatni tozalaymiz
    context.user_data["items"] = []
    await update.message.reply_text(
        "👷 *Kim ishlab chiqardi?*",
        parse_mode="Markdown",
        reply_markup=kb,
    )
    return CHOOSE_WORKER


async def choose_worker(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    worker = query.data.split(":", 1)[1]
    context.user_data["worker"] = worker
    packer_name = context.user_data.get("_packer_name")
    if packer_name:
        kb = products_inline_keyboard(packer_name=packer_name)
    else:
        kb = products_inline_keyboard()
    await query.edit_message_text(
        f"👷 *{worker}*\n\n📦 *Mahsulotni tanlang:*",
        parse_mode="Markdown",
        reply_markup=kb,
    )
    return CHOOSE_PRODUCT


async def choose_product(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    product = query.data.split(":", 1)[1]
    context.user_data["product"] = product
    await query.edit_message_text(
        f"📦 *{product}*\n\n🔢 *Necha dona?*",
        parse_mode="Markdown",
        reply_markup=cancel_keyboard(),
    )
    return ENTER_QUANTITY


async def enter_quantity(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    text = update.message.text.strip()
    if not text.isdigit() or int(text) <= 0:
        await update.message.reply_text("⚠️ Musbat butun son kiriting:", reply_markup=cancel_keyboard())
        return ENTER_QUANTITY

    context.user_data["quantity"] = int(text)
    product = context.user_data["product"]

    rate_type = "dona"
    for name, rt, rate in get_products():
        if name == product:
            rate_type = rt
            break

    if rate_type == "kg":
        await update.message.reply_text(
            "⚖️ *Jami og'irlik (kg):*\n_Masalan: 205.5_",
            parse_mode="Markdown",
            reply_markup=cancel_keyboard(),
        )
        return ENTER_WEIGHT

    context.user_data["weight_kg"] = 0.0
    return await _add_item(update, context)


async def enter_weight(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    text = update.message.text.strip().replace(",", ".")
    try:
        weight = float(text)
        if weight <= 0:
            raise ValueError
    except ValueError:
        await update.message.reply_text("⚠️ To'g'ri og'irlik kiriting:", reply_markup=cancel_keyboard())
        return ENTER_WEIGHT

    context.user_data["weight_kg"] = weight

    product  = context.user_data["product"]
    quantity = context.user_data["quantity"]
    profile  = get_product_weight(product)
    unit_w   = (weight / quantity) if quantity > 0 else 0.0
    # Profil og'irligi "ma'noli" bo'lsa (>0 va standart 1.0 emas) sifat nazorati
    meaningful = profile > 0 and abs(profile - 1.0) > 0.001

    if meaningful and abs(unit_w - profile) > WEIGHT_TOLERANCE_KG:
        context.user_data["weight_qc"] = "warn"
        await update.message.reply_text(
            f"⚠️ *Og'irlik mos kelmadi!*\n\n"
            f"📦 {product}\n"
            f"📋 Profil: *{profile:.3f} kg/dona*\n"
            f"⚖️ Hozir: *{unit_w:.3f} kg/dona*  ({weight:g} kg ÷ {quantity})\n"
            f"📐 Farq: *{abs(unit_w - profile):.3f} kg*  (ruxsat: ±{WEIGHT_TOLERANCE_KG:g} kg)\n\n"
            f"To'g'ri og'irlikni qayta kiriting yoki baribir qabul qiling:",
            parse_mode="Markdown",
            reply_markup=weight_confirm_keyboard(),
        )
        return ENTER_WEIGHT

    context.user_data["weight_qc"] = "ok" if meaningful else "none"
    return await _add_item(update, context)


async def accept_weight_anyway(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    context.user_data["weight_qc"] = "override"
    try:
        await query.edit_message_reply_markup(reply_markup=None)
    except Exception:
        pass
    return await _add_item(update, context)


# ── Savat (cart) ───────────────────────────────────────────────────────────────

def _item_detail(it: dict) -> str:
    w = it.get("weight_kg") or 0.0
    return f"{w:g} kg" if w > 0 else f"{it['quantity']} dona"


async def _add_item(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Joriy mahsulotni vaqtinchalik savatga qo'shadi va sessiya tugmalarini ko'rsatadi."""
    message   = update.effective_message
    product   = context.user_data["product"]
    quantity  = context.user_data["quantity"]
    weight_kg = context.user_data.get("weight_kg", 0.0)
    qc        = context.user_data.get("weight_qc")
    earnings  = calc_earnings(product, quantity, weight_kg)

    items = context.user_data.setdefault("items", [])
    items.append({
        "product":   product,
        "quantity":  quantity,
        "weight_kg": weight_kg,
        "earnings":  earnings,
        "qc":        qc,
    })

    # Faqat joriy mahsulotning vaqtinchalik maydonlarini tozalaymiz (savat saqlanadi)
    for k in ("product", "quantity", "weight_kg", "weight_qc"):
        context.user_data.pop(k, None)

    lines = []
    total = 0.0
    for idx, it in enumerate(items, 1):
        total += it["earnings"]
        lines.append(f"{idx}. {it['product']} — {_item_detail(it)} · {it['earnings']:,.0f} so'm")

    await message.reply_text(
        f"➕ *Qo'shildi:* {product} ({_item_detail(items[-1])})\n\n"
        f"🧾 *Joriy partiya ({len(items)} ta mahsulot):*\n"
        + "\n".join(lines)
        + f"\n\n💰 Jami haq: *{total:,.0f} so'm*\n\n"
        f"Yana mahsulot qo'shasizmi yoki tugatasizmi?",
        parse_mode="Markdown",
        reply_markup=batch_cart_keyboard(),
    )
    return AFTER_ITEM


async def add_more_product(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """[➕ Yana mahsulot] — mahsulot tanlashga qaytadi (ishchi o'zgarmaydi)."""
    query = update.callback_query
    await query.answer()
    worker = context.user_data["worker"]
    packer_name = context.user_data.get("_packer_name")
    if packer_name:
        kb = products_inline_keyboard(packer_name=packer_name)
    else:
        kb = products_inline_keyboard()
    try:
        await query.edit_message_reply_markup(reply_markup=None)
    except Exception:
        pass
    await query.message.reply_text(
        f"👷 *{worker}*\n\n📦 *Keyingi mahsulotni tanlang:*",
        parse_mode="Markdown",
        reply_markup=kb,
    )
    return CHOOSE_PRODUCT


async def finalize_batches(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """[✅ Tugatish] — savatdagi barcha mahsulotlardan bitta partiya yaratadi."""
    query = update.callback_query
    await query.answer()
    try:
        await query.edit_message_reply_markup(reply_markup=None)
    except Exception:
        pass
    return await _finalize(update, context)


async def _finalize(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    message = update.effective_message
    worker  = context.user_data.get("worker")
    items   = context.user_data.get("items", [])

    chat_id  = update.effective_chat.id
    user_row = get_user_role(chat_id)
    kb = packer_menu_keyboard() if (user_row and user_row["role"] == "packer") else main_menu_keyboard()

    if not items:
        await message.reply_text(
            "⚠️ Hech qanday mahsulot kiritilmadi.",
            reply_markup=kb,
        )
        context.user_data.clear()
        return ConversationHandler.END

    workers = get_workers()
    prefix  = workers.get(worker, worker[:2].upper())
    created = datetime.now()

    result        = create_batch_session(worker, prefix, items)
    batch_code    = result["batch_code"]
    total         = result["total_earnings"]
    low_materials = result["low_materials"]

    today_str = date.today().strftime("%d.%m.%Y")

    lines = []
    for idx, it in enumerate(items, 1):
        qc = it.get("qc")
        w  = it.get("weight_kg") or 0.0
        qmark = ""
        if w > 0 and qc == "ok":
            qmark = " ✅"
        elif w > 0 and qc == "override":
            qmark = " ⚠️"
        lines.append(
            f"{idx}. {it['product']} — {_item_detail(it)}{qmark}\n"
            f"   💰 {it['earnings']:,.0f} so'm"
        )

    low_line = ""
    if low_materials:
        mtxt = "\n".join(
            f"  • {m['name']}: {m['current_stock']:.0f} {m['unit']} (min {m['minimum_stock']:.0f})"
            for m in low_materials
        )
        low_line = f"\n\n⚠️ *Xom ashyo kam qoldi — to'ldiring!*\n{mtxt}"

    await message.reply_text(
        f"✅ *Partiya yaratildi!*\n\n"
        f"📌 Partiya: `{batch_code}`\n"
        f"👷 Ishchi: {worker}\n"
        f"📅 Sana: {today_str}\n"
        f"📦 Mahsulotlar: *{len(items)} ta*\n\n"
        + "\n".join(lines)
        + f"\n\n💰 *Jami haq: {total:,.0f} so'm*"
        + low_line,
        parse_mode="Markdown",
        reply_markup=kb,
    )

    total_stickers = sum(int(it["quantity"]) for it in items)
    gen_msg = await message.reply_text(f"🖨️ {total_stickers} ta stiker tayyorlanmoqda…")

    pdf_buf = generate_batch_session_pdf(batch_code, worker, items, created)
    await message.reply_document(
        document=pdf_buf,
        filename=f"{batch_code}.pdf",
        caption=(
            f"🏷️ *{batch_code}* — {worker}\n"
            f"{len(items)} ta mahsulot · {total_stickers} ta stiker"
        ),
        parse_mode="Markdown",
    )
    await gen_msg.delete()

    await _notify_worker(context, worker, batch_code, items, total)
    await _notify_admin(context, worker, batch_code, items, total)

    context.user_data.clear()
    return ConversationHandler.END


async def _notify_worker(
    context: ContextTypes.DEFAULT_TYPE,
    worker: str, batch_code: str, items: list[dict], total: float,
) -> None:
    chat_id = get_worker_chat_id(worker)
    if not chat_id:
        return

    today = date.today()
    month_name = MONTHS_UZ.get(today.month, str(today.month))
    month_rows  = get_worker_monthly(worker, today.year, today.month)
    month_total = sum(r["total_earnings"] for r in month_rows)

    prod_lines = "\n".join(f"• {it['product']} — {_item_detail(it)}" for it in items)

    try:
        await context.bot.send_message(
            chat_id=chat_id,
            text=(
                f"✅ *Yangi partiya!* (`{batch_code}`)\n\n"
                f"{prod_lines}\n\n"
                f"💰 Bu partiya: *{total:,.0f} so'm*\n"
                f"📊 {month_name} jami: *{month_total:,.0f} so'm*"
            ),
            parse_mode="Markdown",
        )
    except Exception:
        pass


async def _notify_admin(
    context: ContextTypes.DEFAULT_TYPE,
    worker: str, batch_code: str, items: list[dict], total: float,
) -> None:
    prod_lines = "\n".join(f"• {it['product']} — {_item_detail(it)}" for it in items)
    try:
        await context.bot.send_message(
            chat_id=SUPERADMIN_CHAT_ID,
            text=(
                f"🏭 *Yangi partiya kiritildi*\n\n"
                f"👷 Ishchi: *{worker}*\n"
                f"📌 `{batch_code}`  ({len(items)} ta mahsulot)\n\n"
                f"{prod_lines}\n\n"
                f"💰 Jami haq: *{total:,.0f} so'm*"
            ),
            parse_mode="Markdown",
        )
    except Exception:
        pass


async def cancel_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    context.user_data.clear()
    await query.edit_message_text("❌ Bekor qilindi.")
    await query.message.reply_text("Asosiy menyu:", reply_markup=main_menu_keyboard())
    return ConversationHandler.END


async def cancel_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data.clear()
    await update.message.reply_text("❌ Bekor qilindi.", reply_markup=main_menu_keyboard())
    return ConversationHandler.END


def build_conversation_handler() -> ConversationHandler:
    return ConversationHandler(
        entry_points=[
            MessageHandler(filters.Regex(r"^🏭 Tovar kiritish$"), start_input),
        ],
        states={
            CHOOSE_WORKER: [
                CallbackQueryHandler(choose_worker, pattern=r"^worker:"),
                CallbackQueryHandler(cancel_callback, pattern=r"^cancel$"),
            ],
            CHOOSE_PRODUCT: [
                CallbackQueryHandler(choose_product, pattern=r"^product:"),
                CallbackQueryHandler(cancel_callback, pattern=r"^cancel$"),
            ],
            ENTER_QUANTITY: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, enter_quantity),
                CallbackQueryHandler(cancel_callback, pattern=r"^cancel$"),
            ],
            ENTER_WEIGHT: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, enter_weight),
                CallbackQueryHandler(accept_weight_anyway, pattern=r"^weight_ok$"),
                CallbackQueryHandler(cancel_callback, pattern=r"^cancel$"),
            ],
            AFTER_ITEM: [
                CallbackQueryHandler(add_more_product, pattern=r"^add_more$"),
                CallbackQueryHandler(finalize_batches, pattern=r"^finish$"),
                CallbackQueryHandler(cancel_callback, pattern=r"^cancel$"),
            ],
        },
        fallbacks=[MessageHandler(filters.COMMAND, cancel_command)],
        name="tovar_kiritish",
        persistent=True,
        per_message=False,
        allow_reentry=True,
    )
