import os

WORKERS = {
    "Aziza": "AZ",
    "Gullola": "GL",
    "Shohida": "SH",
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
# "kg" — jami kg bo'yicha hisob; "dona" — dona bo'yicha hisob
PRODUCT_RATES: dict[str, dict] = {
    "Oq 4 kg":     {"type": "kg",   "rate": 1500},
    "Oq 5 kg":     {"type": "kg",   "rate": 1500},
    "Oq 6 kg":     {"type": "kg",   "rate": 1500},
    "Tulpor":      {"type": "dona", "rate": 100},
    "Shakar":      {"type": "dona", "rate": 100},
    "Strupa Oq":   {"type": "dona", "rate": 100},
    "Strupa Sariq":{"type": "dona", "rate": 100},
    "Shroki 3.5":  {"type": "dona", "rate": 100},
}

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(_BASE_DIR, "data", "topmart.db")


def calc_earnings(product: str, quantity: int, weight_kg: float) -> float:
    info = PRODUCT_RATES.get(product, {"type": "dona", "rate": 100})
    if info["type"] == "kg":
        return weight_kg * info["rate"]
    else:
        return quantity * info["rate"]
