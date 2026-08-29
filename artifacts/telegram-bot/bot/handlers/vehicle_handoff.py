"""Admin-only Telegram flow for the frozen DM-001 vehicle handoff pilot."""
import hashlib
import re

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import (
    CallbackQueryHandler, ContextTypes, ConversationHandler, MessageHandler, filters,
)

from ..api_client import (
    confirm_handoff_labels_printed, create_vehicle_handoff, get_handoff_labels,
    get_vehicle_handoff, list_vehicle_handoffs, mark_handoff_handed_over,
    mark_handoff_stock_transferred, prepare_handoff_labels,
)
from ..database import (
    get_user_role, get_vehicle_handoff_products, get_vehicle_handoff_source_warehouses,
)
from ..keyboards import admin_reply_keyboard
from ..vehicle_label_pdf import build_batch_session_pdf

(MENU, SOURCE, PRODUCT, QUANTITY, WEIGHT, REVIEW, EXISTING, WARNING) = range(8)
ENTRY_TEXT = "🚚 Mashinani to‘ldirish"


def _admin(user_id: int) -> bool:
    row = get_user_role(user_id)
    return bool(row and row["role"] == "admin")


def _token(update: Update) -> str:
    raw = f"{update.effective_chat.id}:{update.update_id}"
    return hashlib.sha256(raw.encode()).hexdigest()[:12]


def _operation(kind: str, handoff_id: int | None, token: str) -> str:
    target = str(handoff_id) if handoff_id is not None else token
    return f"telegram-factory:{kind}:{target}"


def _buttons(rows):
    return InlineKeyboardMarkup(rows)


async def _reject(query, text="❌ Ruxsat yo‘q yoki tugma eskirgan."):
    await query.answer(text, show_alert=True)


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if not _admin(update.effective_user.id):
        await update.message.reply_text("❌ Bu amal faqat admin uchun.")
        return ConversationHandler.END
    token = _token(update)
    context.user_data["vh"] = {"token": token, "done": set()}
    await update.message.reply_text(
        "🚚 *DM-001 mashinasi*\n\nAmalni tanlang:",
        parse_mode="Markdown",
        reply_markup=_buttons([
            [InlineKeyboardButton("➕ Yangi yuklash", callback_data=f"vh:{token}:new")],
            [InlineKeyboardButton("📋 Mavjud topshirishlar", callback_data=f"vh:{token}:list")],
            [InlineKeyboardButton("❌ Bekor qilish", callback_data=f"vh:{token}:cancel")],
        ]),
    )
    return MENU


def _valid(query, context, parts: int = 3) -> tuple[dict | None, list[str]]:
    data = query.data.split(":")
    state = context.user_data.get("vh")
    if (len(data) < parts or not state or data[0] != "vh"
            or data[1] != state.get("token") or not _admin(query.from_user.id)):
        return None, data
    return state, data


async def menu_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    state, data = _valid(q, context)
    if not state:
        await _reject(q)
        return MENU
    await q.answer()
    if data[2] == "cancel":
        context.user_data.pop("vh", None)
        await q.edit_message_text("❌ Bekor qilindi.")
        await q.message.reply_text("Asosiy menyu:", reply_markup=admin_reply_keyboard())
        return ConversationHandler.END
    if data[2] == "list":
        return await _show_handoffs(q, context)
    if data[2] != "new":
        await _reject(q)
        return MENU
    warehouses = get_vehicle_handoff_source_warehouses()
    if not warehouses:
        await q.edit_message_text("❌ Yuklash mumkin bo‘lgan, qoldiqli manba ombor yo‘q.")
        return ConversationHandler.END
    state["warehouses"] = {str(w["id"]): w for w in warehouses}
    rows = [[InlineKeyboardButton(w["name"], callback_data=f"vh:{state['token']}:src:{w['id']}")]
            for w in warehouses]
    rows.append([InlineKeyboardButton("❌ Bekor qilish", callback_data=f"vh:{state['token']}:cancel")])
    await q.edit_message_text("🏬 *Manba omborni tanlang:*", parse_mode="Markdown",
                              reply_markup=_buttons(rows))
    return SOURCE


async def choose_source(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    state, data = _valid(q, context, 4)
    if not state or data[2] != "src" or data[3] not in state.get("warehouses", {}):
        await _reject(q)
        return SOURCE
    await q.answer()
    warehouse = state["warehouses"][data[3]]
    products = get_vehicle_handoff_products(int(data[3]))
    if not products:
        await q.edit_message_text("❌ Bu omborda faol, moslangan va qoldiqli mahsulot yo‘q.")
        return ConversationHandler.END
    state["warehouse"] = warehouse
    state["products"] = {str(i): p for i, p in enumerate(products)}
    rows = [[InlineKeyboardButton(
        f"{p['name']} — {float(p['available_quantity']):g} dona",
        callback_data=f"vh:{state['token']}:prod:{i}",
    )] for i, p in enumerate(products)]
    await q.edit_message_text(
        f"🏬 *{warehouse['name']}*\n\n📦 Faol, moslangan mahsulotni tanlang:",
        parse_mode="Markdown", reply_markup=_buttons(rows),
    )
    return PRODUCT


async def choose_product(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    state, data = _valid(q, context, 4)
    if not state or data[2] != "prod" or data[3] not in state.get("products", {}):
        await _reject(q)
        return PRODUCT
    await q.answer()
    state["product"] = state["products"][data[3]]
    p = state["product"]
    await q.edit_message_text(
        f"📦 *{p['name']}*\nQoldiq: *{float(p['available_quantity']):g} dona*\n\n"
        "Musbat butun miqdorni kiriting:", parse_mode="Markdown",
    )
    return QUANTITY


async def enter_quantity(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if not _admin(update.effective_user.id) or "vh" not in context.user_data:
        await update.message.reply_text("❌ Sessiya eskirgan.")
        return ConversationHandler.END
    text = update.message.text.strip()
    state = context.user_data["vh"]
    if not text.isdigit() or int(text) <= 0:
        await update.message.reply_text("⚠️ Musbat butun son kiriting:")
        return QUANTITY
    if int(text) > int(float(state["product"]["available_quantity"])):
        await update.message.reply_text("⚠️ Miqdor mavjud qoldiqdan oshmasligi kerak:")
        return QUANTITY
    state["quantity"] = int(text)
    await update.message.reply_text("⚖️ Jami musbat og‘irlikni kg da kiriting (masalan, 25.5):")
    return WEIGHT


async def enter_weight(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if not _admin(update.effective_user.id) or "vh" not in context.user_data:
        await update.message.reply_text("❌ Sessiya eskirgan.")
        return ConversationHandler.END
    raw_weight = update.message.text.strip().replace(",", ".")
    try:
        if not re.fullmatch(r"\d+(?:\.\d{1,3})?", raw_weight):
            raise ValueError
        weight = float(raw_weight)
        if weight <= 0:
            raise ValueError
    except ValueError:
        await update.message.reply_text("⚠️ Musbat kg kiriting:")
        return WEIGHT
    state = context.user_data["vh"]
    state["weight"] = weight
    p, w = state["product"], state["warehouse"]
    unit_weight = float(p.get("unit_weight_kg") or 0)
    expected = unit_weight * state["quantity"] if unit_weight > 0 else None
    state["expected_weight"] = expected
    profile_line = (
        f"🏷️ Profil bo‘yicha jami: *{expected:g} kg*\n"
        if expected is not None else
        "🏷️ Profil og‘irligi belgilanmagan — kiritilgan jami kg ishlatiladi.\n"
    )
    await update.message.reply_text(
        "🔎 *Tekshiring*\n\n"
        f"🚚 Mashina: *DM-001*\n🏬 Manba: *{w['name']}*\n"
        f"📦 Mahsulot: *{p['name']}*\n🔢 Miqdor: *{state['quantity']} dona*\n"
        f"⚖️ Kiritilgan jami: *{weight:g} kg*\n"
        + profile_line + "\n"
        "Tasdiqlaysizmi?", parse_mode="Markdown",
        reply_markup=_buttons([
            [InlineKeyboardButton("✅ Tayyorlash", callback_data=f"vh:{state['token']}:create")],
            [InlineKeyboardButton("❌ Bekor qilish", callback_data=f"vh:{state['token']}:cancel")],
        ]),
    )
    return REVIEW


async def confirm_create(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    state, data = _valid(q, context)
    if not state or data[2] != "create":
        await _reject(q)
        return REVIEW
    if "create" in state["done"]:
        await _reject(q, "Bu so‘rov allaqachon bajarilgan.")
        return REVIEW
    await q.answer()
    state["done"].add("create")
    p = state["product"]
    notes = f"Telegram factory bot; operator total kg: {state['weight']:g}"
    ok, result = create_vehicle_handoff(
        state["warehouse"]["id"], p["mahsulot_id"], state["quantity"], state["weight"],
        _operation("create", None, state["token"]), notes,
    )
    if not ok:
        state["done"].discard("create")
        await q.edit_message_text(f"❌ Topshirish yaratilmadi: {result}")
        return ConversationHandler.END
    handoff_id = int(result["id"])
    ok, labels = prepare_handoff_labels(
        handoff_id, _operation("prepare-labels", handoff_id, state["token"])
    )
    if not ok:
        await q.edit_message_text(f"⚠️ Topshirish #{handoff_id} yaratildi, etiketka tayyorlanmadi: {labels}")
        return ConversationHandler.END
    # Fetch the persisted payload rather than trusting a transient prepare response.
    ok, labels = get_handoff_labels(handoff_id)
    if not ok:
        await q.edit_message_text(f"⚠️ Topshirish #{handoff_id} yaratildi, etiketka olinmadi: {labels}")
        return ConversationHandler.END
    pdf = build_batch_session_pdf(labels)
    await q.edit_message_text(
        f"✅ Topshirish *#{handoff_id}* tayyorlandi.\n"
        "⚠️ PDF yuborildi, lekin “chop etildi” hali tasdiqlanmadi.",
        parse_mode="Markdown",
    )
    await q.message.reply_document(
        document=pdf, filename=f"VH-{handoff_id}.pdf",
        caption=f"🏷️ VH-{handoff_id} · {labels['totalLabels']} ta 100×80 etiketka",
    )
    await _send_actions(q.message, state, handoff_id, "prepared")
    return EXISTING


async def _show_handoffs(q, context) -> int:
    state = context.user_data["vh"]
    ok, payload = list_vehicle_handoffs()
    if not ok:
        await q.edit_message_text(f"❌ Ro‘yxat olinmadi: {payload}")
        return ConversationHandler.END
    handoffs = payload.get("handoffs", payload if isinstance(payload, list) else [])
    if not handoffs:
        await q.edit_message_text("📭 Mavjud topshirishlar yo‘q.")
        return ConversationHandler.END
    rows = [[InlineKeyboardButton(
        f"#{h['id']} · {h['status']}",
        callback_data=f"vh:{state['token']}:open:{h['id']}",
    )] for h in handoffs[:30]]
    await q.edit_message_text("📋 *DM-001 topshirishlari:*", parse_mode="Markdown",
                              reply_markup=_buttons(rows))
    return EXISTING


async def _send_actions(message, state, handoff_id: int, status: str):
    rows = [[InlineKeyboardButton("📄 PDFni olish", callback_data=f"vh:{state['token']}:pdf:{handoff_id}")]]
    if status == "prepared":
        rows.append([InlineKeyboardButton("⚠️ Chop etilganini tasdiqlash",
                                          callback_data=f"vh:{state['token']}:warn:printed:{handoff_id}")])
    elif status == "labels_printed":
        rows.append([InlineKeyboardButton("⚠️ Mashinaga topshirildi",
                                          callback_data=f"vh:{state['token']}:warn:handed:{handoff_id}")])
    elif status == "handed_over":
        rows.append([InlineKeyboardButton("⚠️ Zaxirani o‘tkazish",
                                          callback_data=f"vh:{state['token']}:warn:stock:{handoff_id}")])
    await message.reply_text(
        f"Topshirish #{handoff_id} · holat: *{status}*", parse_mode="Markdown",
        reply_markup=_buttons(rows),
    )


async def existing_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    state, data = _valid(q, context, 4)
    if not state or data[2] not in ("open", "pdf"):
        await _reject(q)
        return EXISTING
    try:
        handoff_id = int(data[3])
    except ValueError:
        await _reject(q)
        return EXISTING
    await q.answer()
    ok, detail = get_vehicle_handoff(handoff_id)
    if not ok:
        await q.edit_message_text(f"❌ Topshirish olinmadi: {detail}")
        return EXISTING
    if data[2] == "pdf":
        ok, labels = get_handoff_labels(handoff_id)
        if not ok:
            await q.message.reply_text(f"❌ PDF olinmadi: {labels}")
            return EXISTING
        await q.message.reply_document(build_batch_session_pdf(labels),
                                       filename=f"VH-{handoff_id}.pdf")
    await _send_actions(q.message, state, handoff_id, detail["status"])
    return EXISTING


async def warning_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    state, data = _valid(q, context, 5)
    if not state or data[2] != "warn" or data[3] not in ("printed", "handed", "stock"):
        await _reject(q)
        return EXISTING
    try:
        handoff_id = int(data[4])
    except ValueError:
        await _reject(q)
        return EXISTING
    await q.answer()
    labels = {
        "printed": "etiketkalar haqiqatda chop etilganini",
        "handed": "yuk haqiqatda mashinaga topshirilganini",
        "stock": "zaxira haqiqatda mashinaga o‘tishini",
    }
    await q.edit_message_text(
        f"⚠️ *Ogohlantirish*\n\n#{handoff_id}: {labels[data[3]]} tasdiqlaysizmi?",
        parse_mode="Markdown",
        reply_markup=_buttons([
            [InlineKeyboardButton("✅ Ha, tasdiqlayman",
                                  callback_data=f"vh:{state['token']}:do:{data[3]}:{handoff_id}")],
            [InlineKeyboardButton("❌ Yo‘q", callback_data=f"vh:{state['token']}:open:{handoff_id}")],
        ]),
    )
    return WARNING


async def action_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    state, data = _valid(q, context, 5)
    if not state or data[2] != "do" or data[3] not in ("printed", "handed", "stock"):
        await _reject(q)
        return WARNING
    try:
        handoff_id = int(data[4])
    except ValueError:
        await _reject(q)
        return WARNING
    dedupe = f"{data[3]}:{handoff_id}"
    if dedupe in state["done"]:
        await _reject(q, "Bu amal allaqachon yuborilgan.")
        return EXISTING
    await q.answer()
    state["done"].add(dedupe)
    if data[3] == "printed":
        ok, result = confirm_handoff_labels_printed(
            handoff_id, _operation("confirm-printed", handoff_id, state["token"])
        )
    elif data[3] == "handed":
        ok, result = mark_handoff_handed_over(handoff_id)
    else:
        ok, result = mark_handoff_stock_transferred(handoff_id)
    if not ok:
        state["done"].discard(dedupe)
        await q.edit_message_text(f"❌ Amal bajarilmadi: {result}")
        return ConversationHandler.END
    detail = result.get("handoff", result)
    await q.edit_message_text(f"✅ #{handoff_id} holati: *{detail['status']}*",
                              parse_mode="Markdown")
    await _send_actions(q.message, state, handoff_id, detail["status"])
    return EXISTING


async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data.pop("vh", None)
    await update.effective_message.reply_text("❌ Bekor qilindi.",
                                              reply_markup=admin_reply_keyboard())
    return ConversationHandler.END


async def stale_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    await _reject(update.callback_query)
    return ConversationHandler.END


def build_vehicle_handoff_handler() -> ConversationHandler:
    return ConversationHandler(
        entry_points=[MessageHandler(filters.Regex(r"^🚚 Mashinani to‘ldirish$"), start)],
        states={
            MENU: [CallbackQueryHandler(menu_callback, pattern=r"^vh:")],
            SOURCE: [
                CallbackQueryHandler(choose_source, pattern=r"^vh:[^:]+:src:"),
                CallbackQueryHandler(menu_callback, pattern=r"^vh:[^:]+:cancel$"),
            ],
            PRODUCT: [
                CallbackQueryHandler(choose_product, pattern=r"^vh:[^:]+:prod:"),
                CallbackQueryHandler(menu_callback, pattern=r"^vh:[^:]+:cancel$"),
            ],
            QUANTITY: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, enter_quantity),
                CallbackQueryHandler(stale_callback, pattern=r"^vh:"),
            ],
            WEIGHT: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, enter_weight),
                CallbackQueryHandler(stale_callback, pattern=r"^vh:"),
            ],
            REVIEW: [
                CallbackQueryHandler(confirm_create, pattern=r"^vh:[^:]+:create$"),
                CallbackQueryHandler(menu_callback, pattern=r"^vh:[^:]+:cancel$"),
            ],
            EXISTING: [
                CallbackQueryHandler(warning_callback, pattern=r"^vh:[^:]+:warn:"),
                CallbackQueryHandler(existing_callback, pattern=r"^vh:"),
            ],
            WARNING: [
                CallbackQueryHandler(action_callback, pattern=r"^vh:[^:]+:do:"),
                CallbackQueryHandler(existing_callback, pattern=r"^vh:"),
            ],
        },
        fallbacks=[MessageHandler(filters.COMMAND, cancel)],
        name="vehicle_handoff_dm001", persistent=True, allow_reentry=True,
    )