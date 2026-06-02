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


def workers_inline_keyboard() -> InlineKeyboardMarkup:
    from .database import get_workers
    workers = get_workers()
    buttons = [
        [InlineKeyboardButton(name, callback_data=f"worker:{name}")]
        for name in workers
    ]
    return InlineKeyboardMarkup(buttons)


def products_inline_keyboard() -> InlineKeyboardMarkup:
    from .database import get_product_names
    products = get_product_names()
    buttons = []
    for i in range(0, len(products), 2):
        row = [InlineKeyboardButton(products[i], callback_data=f"product:{products[i]}")]
        if i + 1 < len(products):
            row.append(InlineKeyboardButton(products[i + 1], callback_data=f"product:{products[i + 1]}"))
        buttons.append(row)
    return InlineKeyboardMarkup(buttons)


def cancel_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton("❌ Bekor qilish", callback_data="cancel")]]
    )


def admin_main_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("➕ Hodim qo'shish",        callback_data="adm:add_worker")],
        [InlineKeyboardButton("➕ Mahsulot qo'shish",     callback_data="adm:add_product")],
        [InlineKeyboardButton("👔 Upakovkachi belgilash", callback_data="adm:assign_packer")],
        [InlineKeyboardButton("📋 Hodimlar ro'yxati",     callback_data="adm:list_workers")],
        [InlineKeyboardButton("📦 Mahsulotlar ro'yxati",  callback_data="adm:list_products")],
        [InlineKeyboardButton("💰 Maosh boshqaruvi",      callback_data="adm:salary")],
    ])
