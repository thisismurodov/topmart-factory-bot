import os

WORKERS = {
    "Aziza":   "AZ",
    "Gullola": "GL",
    "Shohida": "SH",
}

# Admin har bir hodimning telefon raqamini shu yerga yozadi.
# Format: raqam (7 yoki 9 xona, oldidagi + va 998 bo'lishi mumkin) → hodim ismi
# Misol: "998901234567": "Aziza"
WORKER_PHONES: dict[str, str] = {
    "998901234567": "Aziza",
    "998907654321": "Gullola",
    "998931234567": "Shohida",
}

PRODUCTS = [
    "Oq 4 kg",
    "Oq 5 kg",
    "Oq 6 kg",
    "Tulpor",
    "Shakar",
    "Strupa Oq",
    "Strupa Sariq",
    "Shroki 3.5",
]

# To'lov stavkalari
# "kg"   — jami kg bo'yicha hisob (og'irlik so'raladi)
# "dona" — dona bo'yicha hisob
PRODUCT_RATES: dict[str, dict] = {
    "Oq 4 kg":      {"type": "kg",   "rate": 1500},
    "Oq 5 kg":      {"type": "kg",   "rate": 1500},
    "Oq 6 kg":      {"type": "kg",   "rate": 1500},
    "Tulpor":       {"type": "dona", "rate": 100},
    "Shakar":       {"type": "dona", "rate": 100},
    "Strupa Oq":    {"type": "dona", "rate": 100},
    "Strupa Sariq": {"type": "dona", "rate": 100},
    "Shroki 3.5":   {"type": "dona", "rate": 100},
}

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(_BASE_DIR, "data", "topmart.db")


def normalize_phone(raw: str) -> str:
    digits = "".join(c for c in raw if c.isdigit())
    if digits.startswith("998") and len(digits) == 12:
        return digits
    if len(digits) == 9:
        return "998" + digits
    return digits


def find_worker_by_phone(raw: str) -> str | None:
    normalized = normalize_phone(raw)
    return WORKER_PHONES.get(normalized)


def calc_earnings(product: str, quantity: int, weight_kg: float) -> float:
    info = PRODUCT_RATES.get(product, {"type": "dona", "rate": 100})
    if info["type"] == "kg":
        return weight_kg * info["rate"]
    return quantity * info["rate"]
