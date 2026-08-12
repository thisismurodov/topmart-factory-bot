from telegram import (
    InlineKeyboardButton, InlineKeyboardMarkup,
    ReplyKeyboardMarkup, KeyboardButton,
)


def main_menu_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        [
            ["🏭 Tovar kiritish"],
            ["📋 Bugungi partiyalar", "🏷️ Etiketka"],
            ["📊 KPI Hisobot", "💰 To'lovlar tarixi"],
        ],
        resize_keyboard=True,
    )


def admin_reply_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        [
            ["🏭 Tovar kiritish"],
            ["📋 Bugungi partiyalar", "🏷️ Etiketka"],
            ["📊 KPI Hisobot", "💰 Maosh"],
            ["🛒 Savdo", "📊 Savdolar"],
            ["📊 Savdo Hisobot"],
            ["➕ Sotuv Tovar", "📦 Tovarlar"],
            ["💳 Nasiyalar", "🏬 Ombor"],
            ["🤖 AI tahlil", "⚙️ Admin panel"],
        ],
        resize_keyboard=True,
    )


def packer_menu_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        [
            ["🏭 Tovar kiritish"],
            ["📋 Bugungi partiyalar", "🏷️ Etiketka"],
            ["👷 Hodim qo'shish"],
        ],
        resize_keyboard=True,
    )


def contact_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        [[KeyboardButton("📱 Telefon raqamni ulash", request_contact=True)]],
        resize_keyboard=True,
        one_time_keyboard=True,
    )


def workers_inline_keyboard(packer_chat_id: int | None = None) -> InlineKeyboardMarkup:
    from .database import get_workers, get_packer_workers
    workers = get_workers()
    names = list(workers.keys())
    if packer_chat_id is not None:
        assigned = get_packer_workers(packer_chat_id)
        if assigned:
            filtered = [n for n in names if n in assigned]
            # Fallback to all workers if packer has no (valid) assignments
            if filtered:
                names = filtered
    buttons = [
        [InlineKeyboardButton(name, callback_data=f"worker:{name}")]
        for name in names
    ]
    return InlineKeyboardMarkup(buttons)


def products_inline_keyboard(
    packer_name: str | None = None,
) -> InlineKeyboardMarkup:
    from .database import get_product_names, get_products_for_packer
    if packer_name:
        # Packer faqat biriktirilgan mahsulotlarni ko'radi;
        # umuman biriktirilmagan bo'lsa — barcha faol mahsulotlar (fallback);
        # biriktirilgan, lekin hammasi nofaol bo'lsa — bo'sh ro'yxat
        # (pastdagi "Mahsulotlar biriktirilmagan" tugmasi ko'rsatiladi).
        products = get_products_for_packer(packer_name)
    else:
        products = get_product_names()
    buttons = []
    for i in range(0, len(products), 2):
        row = [InlineKeyboardButton(products[i], callback_data=f"product:{products[i]}")]
        if i + 1 < len(products):
            row.append(InlineKeyboardButton(products[i + 1], callback_data=f"product:{products[i + 1]}"))
        buttons.append(row)
    if not buttons:
        buttons = [[InlineKeyboardButton("⚠️ Mahsulotlar biriktirilmagan", callback_data="cancel")]]
    return InlineKeyboardMarkup(buttons)


def cancel_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton("❌ Bekor qilish", callback_data="cancel")]]
    )


def weight_confirm_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("✅ Baribir qabul qilish", callback_data="weight_ok")],
        [InlineKeyboardButton("❌ Bekor qilish",          callback_data="cancel")],
    ])


def stock_confirm_keyboard() -> InlineKeyboardMarkup:
    """Xom ashyo yetishmasa: baribir davom etish yoki bekor qilish."""
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("✅ Baribir davom etish", callback_data="stock_ok")],
        [InlineKeyboardButton("❌ Bekor qilish",        callback_data="cancel")],
    ])


def batch_cart_keyboard() -> InlineKeyboardMarkup:
    """Har bir mahsulot qo'shilgandan keyingi sessiya tugmalari."""
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("➕ Yana mahsulot qo'shish", callback_data="add_more")],
        [InlineKeyboardButton("✅ Tugatish",               callback_data="finish")],
        [InlineKeyboardButton("❌ Bekor qilish",           callback_data="cancel")],
    ])


def containers_inline_keyboard(containers: list[dict]) -> InlineKeyboardMarkup:
    """C-01…C-30 konteynerlar uchun inline klaviatura (3 ta ustun)."""
    buttons: list[list[InlineKeyboardButton]] = []
    row: list[InlineKeyboardButton] = []
    for c in containers:
        row.append(InlineKeyboardButton(
            f"📦 {c['name']}",
            callback_data=f"container:{c['id']}:{c['name']}",
        ))
        if len(row) == 3:
            buttons.append(row)
            row = []
    if row:
        buttons.append(row)
    buttons.append([InlineKeyboardButton("❌ Bekor qilish", callback_data="cancel")])
    return InlineKeyboardMarkup(buttons)


def admin_main_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("➕ Hodim qo'shish",        callback_data="adm:add_worker")],
        [InlineKeyboardButton("➕ Mahsulot qo'shish",     callback_data="adm:add_product")],
        [InlineKeyboardButton("👔 Upakovkachi belgilash", callback_data="adm:assign_packer")],
        [InlineKeyboardButton("📦 Packer mahsulotlari",   callback_data="adm:packer_products")],
        [InlineKeyboardButton("📋 Hodimlar ro'yxati",     callback_data="adm:list_workers")],
        [InlineKeyboardButton("📦 Mahsulotlar ro'yxati",  callback_data="adm:list_products")],
        [InlineKeyboardButton("💰 Maosh boshqaruvi",      callback_data="adm:salary")],
    ])
