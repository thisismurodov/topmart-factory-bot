import os

# ── Seed data (DB bo'sh bo'lsa shu bilan to'ldiriladi) ────────────────────────

SEED_WORKERS = [
    {"name": "Aziza",   "prefix": "AZ", "phone": "", "role": "worker"},
    {"name": "Gullola", "prefix": "GL", "phone": "", "role": "worker"},
    {"name": "Shohida", "prefix": "SH", "phone": "", "role": "worker"},
]

SEED_PRODUCTS = [
    {"name": "Oq 4 kg",      "rate_type": "kg",   "rate": 1500},
    {"name": "Oq 5 kg",      "rate_type": "kg",   "rate": 1500},
    {"name": "Oq 6 kg",      "rate_type": "kg",   "rate": 1500},
    {"name": "Tulpor",       "rate_type": "dona",  "rate": 100},
    {"name": "Shakar",       "rate_type": "dona",  "rate": 100},
    {"name": "Strupa Oq",    "rate_type": "dona",  "rate": 100},
    {"name": "Strupa Sariq", "rate_type": "dona",  "rate": 100},
    {"name": "Shroki 3.5",   "rate_type": "dona",  "rate": 100},
]

# Yagona doimiy admin chat ID (o'zgartirilmaydi)
SUPERADMIN_CHAT_ID = 1261052681

DATABASE_URL = os.environ["DATABASE_URL"]


def normalize_phone(raw: str) -> str:
    digits = "".join(c for c in raw if c.isdigit())
    if digits.startswith("998") and len(digits) == 12:
        return digits
    if len(digits) == 9:
        return "998" + digits
    return digits


def calc_earnings(
    product: str,
    quantity: int,
    weight_kg: float,
    method: str | None = None,
    worker_role: str | None = None,
    worker_name: str | None = None,
) -> float:
    from .database import (
        get_products, get_product_method,
        product_line_is_config, get_line_staffed_role_rate_sum,
    )
    if method is None:
        method = get_product_method(product)
    # ROLE_BASED_KG + config liniya: partiyaning JAMI qiymati = birlik ×
    # (liniyada ≥1 ishchili rollar stavkalari yig'indisi). Bu kun yopilganda
    # rollarga taqsimlanadigan jami summa (har rol: birlik×stavka÷ishchilar soni;
    # yig'indida ÷soni qisqaradi). products.rate ishlatilmaydi. Kim kiritishidan
    # qat'i nazar bir xil — operator ham, rol ishchisi ham bir xil summani ko'radi.
    if method == "ROLE_BASED_KG" and product_line_is_config(product):
        rate_sum = get_line_staffed_role_rate_sum(product)
        for name, rate_type, _r in get_products():
            if name == product:
                units = weight_kg if rate_type == "kg" else float(quantity)
                return units * rate_sum
        return float(quantity) * rate_sum
    # PRODUCT_RATE va config'siz ROLE_BASED_KG (legacy producer): products.rate dan.
    for name, rate_type, rate in get_products():
        if name == product:
            if rate_type == "kg":
                return weight_kg * rate
            return float(quantity) * rate
    return float(quantity) * 100
