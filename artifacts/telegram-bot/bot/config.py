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

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(_BASE_DIR, "data", "topmart.db")
