from datetime import date, datetime
from telegram import Update
from telegram.ext import (
    ContextTypes, ConversationHandler,
    CallbackQueryHandler, MessageHandler, filters,
)
from ..keyboards import (
    workers_inline_keyboard, products_inline_keyboard, cancel_keyboard,
    main_menu_keyboard, packer_menu_keyboard, weight_confirm_keyboard,
    batch_cart_keyboard, containers_inline_keyboard, stock_confirm_keyboard,
)
from ..database import (
    create_batch_session, get_worker_chat_id, get_workers,
    get_products, get_product_weight, get_user_role, get_worker_monthly,
    get_product_method, get_containers, get_product_pieces_per_box,
    get_product_label_info,
    mark_batch_labels_printed,
    get_worker_production_role, RawStockError,
)
from ..config import calc_earnings, SUPERADMIN_CHAT_ID
from ..label_generator import TASHKENT_TZ, generate_batch_session_pdf

(CHOOSE_WORKER, CHOOSE_PRODUCT, ENTER_QUANTITY, ENTER_WEIGHT,
 AFTER_ITEM, CHOOSE_CONTAINER, CONFIRM_STOCK) = range(7)

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

    payroll_method = get_product_method(product)

    if rate_type == "kg":
        await update.message.reply_text(
            "⚖️ *Jami og'irlik (kg):*\n_Masalan: 205.5_",
            parse_mode="Markdown",
            reply_markup=cancel_keyboard(),
        )
        return ENTER_WEIGHT

    # ROLE_BASED_KG + dona: weight_kg = quantity × dona_og'irligi (avtomatik)
    if payroll_method == "ROLE_BASED_KG":
        unit_weight = get_product_weight(product)  # kg/dona
        quantity = context.user_data["quantity"]
        context.user_data["weight_kg"] = unit_weight * quantity
    else:
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
    worker    = context.user_data.get("worker", "")
    # Usulni daromad bilan bir paytda (bir o'qishda) qayd etamiz — keyin partiyaga
    # shu usul saqlanadi, shunda ishlab chiqaruvchi to'lovi va snapshot mos bo'ladi.
    method        = get_product_method(product)
    worker_role   = get_worker_production_role(worker, product) if method == "ROLE_BASED_KG" else None
    earnings      = calc_earnings(product, quantity, weight_kg, method=method, worker_role=worker_role, worker_name=worker)
    pieces_per_box = get_product_pieces_per_box(product)
    try:
        label_info = get_product_label_info(product)
    except Exception:
        # Profil o'qilmasa ham etiketka chiqishi shart
        label_info = {"sku": "", "profile_kg": 0.0, "roll_length_m": 0.0}
    sku = label_info["sku"]

    items = context.user_data.setdefault("items", [])
    items.append({
        "product":        product,
        "quantity":       quantity,
        "weight_kg":      weight_kg,
        "earnings":       earnings,
        "payroll_method": method,
        "worker_role":    worker_role,
        "qc":             qc,
        "pieces_per_box": pieces_per_box,
        "sku":            sku,
        "profile_kg":     label_info["profile_kg"],
        "metr":           label_info["roll_length_m"],
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
    """[✅ Tugatish] — konteyner tanlash bosqichini ko'rsatadi."""
    query = update.callback_query
    await query.answer()
    try:
        await query.edit_message_reply_markup(reply_markup=None)
    except Exception:
        pass

    containers = get_containers()
    if not containers:
        # Konteynerlar yo'q bo'lsa to'g'ridan-to'g'ri saqlash
        return await _finalize(update, context)

    items = context.user_data.get("items", [])
    total = sum(it["earnings"] for it in items)
    lines = "\n".join(
        f"{i+1}. {it['product']} — {_item_detail(it)}"
        for i, it in enumerate(items)
    )

    await query.message.reply_text(
        f"🧾 *Partiya:* {len(items)} ta mahsulot\n"
        f"{lines}\n"
        f"💰 Jami: *{total:,.0f} so'm*\n\n"
        f"📦 *Qaysi konteynerga joylashtirasiz?*",
        parse_mode="Markdown",
        reply_markup=containers_inline_keyboard(containers),
    )
    return CHOOSE_CONTAINER


async def choose_container(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Konteyner tanlanadi va partiya saqlanadi."""
    query = update.callback_query
    await query.answer()
    try:
        await query.edit_message_reply_markup(reply_markup=None)
    except Exception:
        pass

    # callback_data = "container:{id}:{name}"
    parts = query.data.split(":", 2)
    wh_id   = int(parts[1])
    wh_name = parts[2] if len(parts) > 2 else f"Konteyner #{wh_id}"

    context.user_data["warehouse_id"]   = wh_id
    context.user_data["warehouse_name"] = wh_name

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

    workers      = get_workers()
    prefix       = workers.get(worker, worker[:2].upper())
    # Etiketkadagi sana/soat doim Toshkent bo'yicha (server UTC'da ishlaydi)
    created      = datetime.now(TASHKENT_TZ).replace(tzinfo=None)
    warehouse_id = context.user_data.get("warehouse_id")
    wh_name      = context.user_data.get("warehouse_name", "")

    try:
        result = create_batch_session(
            worker, prefix, items, warehouse_id=warehouse_id,
            allow_negative_stock=context.user_data.get("allow_negative_stock", False),
        )
    except RawStockError as e:
        # Zahira yetmasa — ayirish bajarilmadi (tranzaksiya bekor). Operator
        # ogohlantirishni ko'radi va davom etish yoki bekor qilishni tanlaydi.
        lines = "\n".join(
            f"• {s['name']}: kerak *{s['required']:g} {s['unit']}*, "
            f"mavjud *{s['available']:g} {s['unit']}*"
            for s in e.shortages
        )
        await message.reply_text(
            f"⚠️ *Xom ashyo zahirasi yetarli emas!*\n\n{lines}\n\n"
            f"Davom etilsa zahira *minusga* tushadi. "
            f"Baribir davom etasizmi yoki bekor qilasizmi?",
            parse_mode="Markdown",
            reply_markup=stock_confirm_keyboard(),
        )
        return CONFIRM_STOCK
    batch_code    = result["batch_code"]
    total         = result["total_earnings"]
    low_materials = result["low_materials"]
    label_items   = result["label_items"]
    produced_at   = result.get("created_at")
    if isinstance(produced_at, datetime):
        created = (
            produced_at.astimezone(TASHKENT_TZ).replace(tzinfo=None)
            if produced_at.tzinfo is not None else produced_at
        )

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

    container_line = f"\n📦 Konteyner: *{wh_name}*" if wh_name else ""

    await message.reply_text(
        f"✅ *Partiya yaratildi!*\n\n"
        f"📌 Partiya: `{batch_code}`\n"
        f"👷 Ishchi: {worker}\n"
        f"📅 Sana: {today_str}"
        + container_line
        + f"\n📦 Mahsulotlar: *{len(items)} ta*\n\n"
        + "\n".join(lines)
        + f"\n\n💰 *Jami haq: {total:,.0f} so'm*"
        + low_line,
        parse_mode="Markdown",
        reply_markup=kb,
    )

    total_stickers = sum(len(it["labels"]) for it in label_items)
    total_qty = sum(int(it["quantity"]) for it in items)
    qty_note = f" ({total_qty} dona)" if total_stickers != total_qty else ""
    gen_msg = await message.reply_text(f"🖨️ {total_stickers} ta stiker tayyorlanmoqda…")

    pdf_buf = generate_batch_session_pdf(batch_code, worker, label_items, created)
    await message.reply_document(
        document=pdf_buf,
        filename=f"{batch_code}.pdf",
        caption=(
            f"🏷️ *{batch_code}* — {worker}\n"
            f"{len(items)} ta mahsulot · {total_stickers} ta stiker{qty_note}"
        ),
        parse_mode="Markdown",
    )
    marked = mark_batch_labels_printed(batch_code)
    if marked != total_stickers:
        raise RuntimeError(
            f"{batch_code}: {total_stickers} label chop etildi, "
            f"lekin {marked} passport metadata yangilandi"
        )
    await gen_msg.delete()

    await _notify_worker(context, worker, batch_code, items, total)
    await _notify_admin(context, worker, batch_code, items, total, wh_name)
    # ROLE_BASED_KG: boshqa roldagi ishchilarga ham xabarnoma
    line_entries = result.get("line_entries", [])
    if line_entries:
        total_qty_str = ", ".join(
            f"{it['product']} — {_item_detail(it)}" for it in items
        )
        await _notify_line_workers(context, batch_code, total_qty_str, line_entries)

    # AI maslahat — keyingi galda nima ishlab chiqarish foydali (xato bo'lsa jim o'tadi)
    try:
        import asyncio
        from ..ai_client import get_packer_tip
        tip = await asyncio.to_thread(get_packer_tip, worker, items)
        if tip:
            await message.reply_text(f"🤖 {tip}")
    except Exception:
        pass

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
    wh_name: str = "",
) -> None:
    prod_lines = "\n".join(f"• {it['product']} — {_item_detail(it)}" for it in items)
    container_line = f"\n📦 Konteyner: *{wh_name}*" if wh_name else ""
    try:
        await context.bot.send_message(
            chat_id=SUPERADMIN_CHAT_ID,
            text=(
                f"🏭 *Yangi partiya kiritildi*\n\n"
                f"👷 Ishchi: *{worker}*\n"
                f"📌 `{batch_code}`  ({len(items)} ta mahsulot)"
                + container_line
                + f"\n\n{prod_lines}\n\n"
                f"💰 Jami haq: *{total:,.0f} so'm*"
            ),
            parse_mode="Markdown",
        )
    except Exception:
        pass


ROLE_UZ = {
    "producer":    "Ishlab chiqaruvchi",
    "preparation": "Tayyorlash",
    "packaging":   "Upakovka",
    "packer":      "Upakovka",
    "o'rash":      "O'rash",
}


async def _notify_line_workers(
    context: ContextTypes.DEFAULT_TYPE,
    batch_code: str,
    prod_summary: str,
    line_entries: list[dict],
) -> None:
    """Liniyaning boshqa roldagi ishchilariga darhol maosh haqida xabar yuboradi."""
    for e in line_entries:
        chat_id = get_worker_chat_id(e["worker"])
        if not chat_id:
            continue
        role_label = ROLE_UZ.get(e["role"], e["role"])
        qty_val  = e.get("qty_val", 0)
        qty_unit = e.get("qty_unit", "kg")
        rate     = e.get("rate", 0)
        amount   = e.get("amount", 0)
        try:
            await context.bot.send_message(
                chat_id=chat_id,
                text=(
                    f"💵 *Maosh hisoblandi!*\n\n"
                    f"📌 Partiya: `{batch_code}`\n"
                    f"📦 {prod_summary}\n"
                    f"🧩 Rol: {role_label}\n"
                    f"📐 {qty_val:g} {qty_unit} × {rate:,.0f} so'm\n"
                    f"💰 Haq: *{amount:,.0f} so'm*"
                ),
                parse_mode="Markdown",
            )
        except Exception:
            pass


async def confirm_stock_shortage(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """[✅ Baribir davom etish] — zahira minusga tushishiga rozilik bilan saqlash."""
    query = update.callback_query
    await query.answer()
    try:
        await query.edit_message_reply_markup(reply_markup=None)
    except Exception:
        pass
    context.user_data["allow_negative_stock"] = True
    return await _finalize(update, context)


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
            CHOOSE_CONTAINER: [
                CallbackQueryHandler(choose_container, pattern=r"^container:"),
                CallbackQueryHandler(cancel_callback, pattern=r"^cancel$"),
            ],
            CONFIRM_STOCK: [
                CallbackQueryHandler(confirm_stock_shortage, pattern=r"^stock_ok$"),
                CallbackQueryHandler(cancel_callback, pattern=r"^cancel$"),
            ],
        },
        fallbacks=[MessageHandler(filters.COMMAND, cancel_command)],
        name="tovar_kiritish",
        persistent=True,
        per_message=False,
        allow_reentry=True,
    )
