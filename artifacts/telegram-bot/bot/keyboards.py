from telegram import InlineKeyboardButton, InlineKeyboardMarkup, ReplyKeyboardMarkup
from .config import WORKERS, PRODUCTS


def main_menu_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        [["🏭 Tovar kiritish"], ["📋 Bugungi partiyalar"]],
        resize_keyboard=True,
        one_time_keyboard=False,
    )


def workers_keyboard() -> InlineKeyboardMarkup:
    buttons = [
        [InlineKeyboardButton(name, callback_data=f"worker:{name}")]
        for name in WORKERS
    ]
    return InlineKeyboardMarkup(buttons)


def products_keyboard() -> InlineKeyboardMarkup:
    buttons = []
    for i in range(0, len(PRODUCTS), 2):
        row = [InlineKeyboardButton(PRODUCTS[i], callback_data=f"product:{PRODUCTS[i]}")]
        if i + 1 < len(PRODUCTS):
            row.append(
                InlineKeyboardButton(PRODUCTS[i + 1], callback_data=f"product:{PRODUCTS[i + 1]}")
            )
        buttons.append(row)
    return InlineKeyboardMarkup(buttons)


def cancel_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton("❌ Bekor qilish", callback_data="cancel")]]
    )
