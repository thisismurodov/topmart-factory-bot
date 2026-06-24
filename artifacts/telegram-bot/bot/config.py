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
        get_line_role_rate_strict, product_line_is_config,
    )
    if method is None:
        method = get_product_method(product)
    # ROLE_BASED_KG + config liniya: kiruvchi ishchi O'Z roli stavkasi bo'yicha
    # baholanadi (line_role_config). products.rate ishlatilmaydi. Haqiqiy to'lov
    # kun yopilganda rol bo'yicha (POOL ÷ ishchilar soni) hisoblanadi — bu faqat
    # ko'rsatma uchun taxmin.
    if method == "ROLE_BASED_KG" and worker_name:
        _role, _rrate = get_line_role_rate_strict(worker_name, product)
        if _role is not None:
            for name, rate_type, rate in get_products():
                if name == product:
                    units = weight_kg if rate_type == "kg" else float(quantity)
                    return units * _rrate
            return float(quantity) * _rrate
        # Config liniya, lekin ishchi sozlangan rolda emas → to'lov kun yopilganda
        # POOL orqali sozlangan rol ishchilariga ketadi. Bu ishchiga 0 ko'rsatamiz
        # (products.rate yanglish summani ko'rsatmasligi uchun).
        if product_line_is_config(product):
            return 0.0
    # PRODUCT_RATE va config'siz ROLE_BASED_KG (legacy producer): products.rate dan.
    for name, rate_type, rate in get_products():
        if name == product:
            if rate_type == "kg":
                return weight_kg * rate
            return float(quantity) * rate
    return float(quantity) * 100
