"""100×80mm etiketka generatori guard-testlari (jadval shablon + shtrix-kod).

Bu testlar DB talab qilmaydi — sof Pillow/img2pdf/python-barcode.
"""
import unittest
from datetime import datetime

from bot.label_generator import (
    LABEL_H,
    LABEL_W,
    TASHKENT_TZ,
    _build_single,
    barcode_safe,
    extract_metr,
    generate_batch_session_pdf,
)

TS = datetime(2026, 8, 18, 14, 32)


class LabelGeneratorTest(unittest.TestCase):
    def test_canvas_is_100x80mm_at_203dpi(self):
        self.assertEqual(LABEL_W, round(100 * 203 / 25.4))  # 799
        self.assertEqual(LABEL_H, round(80 * 203 / 25.4))   # 639

    def test_label_size_is_fixed_for_all_variants(self):
        """Die-cut stiker: balandlik doim qat'iy — uzun nom, qutili,
        SKU'siz, og'irliksiz holatlarda ham."""
        variants = [
            dict(product="Arqon 6mm Ko'k", per_box=1, w=12.5, sku="ARQ-00012"),
            dict(product="Polipropilen CF 1500D Sariq granula eksport qadoq",
                 per_box=25, w=18.75, sku="PP-00003"),
            dict(product="0.5 Babin / Qora", per_box=1, w=0.0, sku=""),
            dict(product="70 metr Sariq Strupa 16", per_box=1, w=3.1, sku="STR-00016"),
        ]
        for v in variants:
            # Uzun ishchi nomi ham (2 qatorga bo'linadi, yozuv ustiga chiqmaydi)
            img = _build_single("B-1808-3", "Umidjon Qambarov", v["product"],
                                3, 12, v["w"], TS,
                                per_box=v["per_box"], sku=v["sku"])
            self.assertEqual(img.size, (LABEL_W, LABEL_H), v["product"])

    def test_extract_metr_from_product_name(self):
        self.assertEqual(extract_metr("70 metr Sariq Strupa 16"), 70.0)
        self.assertEqual(extract_metr("Arqon 12.5 Metr qizil"), 12.5)
        self.assertEqual(extract_metr("Kanop 3,5 метр"), 3.5)
        self.assertIsNone(extract_metr("Arqon 6mm Ko'k"))
        self.assertIsNone(extract_metr(""))

    def test_barcode_is_rendered(self):
        """Shtrix-kod zonasi (punktirdan pastda) ham qora, ham oq piksellar
        va ko'p vertikal chiziq o'tishlariga ega bo'lishi kerak."""
        img = _build_single("B-1808-3", "Sayyora", "Tulpor", 1, 4, 3.1, TS,
                            sku="TPLR-00087")
        # Shtrix-kod taxminan y=470..540 oralig'ida
        row_y = 505
        px = img.convert("L").load()
        transitions = 0
        prev = px[60, row_y] < 128
        blacks = 0
        for x in range(60, LABEL_W - 60):
            cur = px[x, row_y] < 128
            blacks += cur
            if cur != prev:
                transitions += 1
            prev = cur
        self.assertGreater(transitions, 20, "shtrix-kod chiziqlari topilmadi")
        self.assertGreater(blacks, 50)

    def test_sku_fallback_to_batch_code(self):
        """SKU bo'sh bo'lsa ham etiketka chiziladi (kod partiya kodidan)."""
        img = _build_single("B-1808-7", "Dilshod", "0.5 Babin", 1, 4, 0.0, TS,
                            sku="")
        self.assertEqual(img.size, (LABEL_W, LABEL_H))

    def test_barcode_safe_normalizes_payload(self):
        """Unicode apostrof/kirill SKU shtrix-kodni indamay yo'q qilmasligi kerak."""
        self.assertEqual(barcode_safe("O'ZBEK-01"), "OZBEK-01")
        self.assertEqual(barcode_safe("oʻzbek-01"), "OZBEK-01")
        self.assertEqual(barcode_safe("  tplr-00087 "), "TPLR-00087")
        self.assertEqual(barcode_safe("БЛОК"), "")          # to'liq kirill → bo'sh
        self.assertEqual(barcode_safe(""), "")
        # Kirill SKU'da ham etiketka chiziladi (partiya kodiga tushadi)
        img = _build_single("B-1808-3", "Sayyora", "Tulpor", 1, 2, 1.0, TS,
                            sku="БЛОК")
        self.assertEqual(img.size, (LABEL_W, LABEL_H))

    def test_single_long_token_does_not_overflow(self):
        """Bo'shliqsiz juda uzun nom yozuv/ikonka ustiga chiqmasligi kerak:
        yorliq ustuni (x<400) qiymat matni bilan ifloslanmaydi."""
        img = _build_single("B-1808-3", "X" * 40, "Y" * 60, 1, 2, 1.0, TS,
                            sku="Z" * 50)
        self.assertEqual(img.size, (LABEL_W, LABEL_H))

    def test_reprint_with_same_created_at_is_identical(self):
        """Qayta chop etish (created_at berilgan) AYNAN bir xil rasm berishi
        kerak — sana/shtrix-kod «hozirgi vaqt»ga sirg'alib ketmasin."""
        a = _build_single("B-1808-3", "Botir", "Arqon", 2, 5, 3.0, TS, sku="A-1")
        b = _build_single("B-1808-3", "Botir", "Arqon", 2, 5, 3.0, TS, sku="A-1")
        self.assertEqual(a.tobytes(), b.tobytes())

    def test_tashkent_tz_is_plus5(self):
        from datetime import timezone as _tz
        utc = datetime(2026, 8, 17, 12, 53, tzinfo=_tz.utc)
        loc = utc.astimezone(TASHKENT_TZ)
        self.assertEqual((loc.hour, loc.minute), (17, 53))

    def test_empty_items_raise_clear_error(self):
        with self.assertRaises(ValueError):
            generate_batch_session_pdf("B-1808-3", "Botir", [], created_at=TS)

    def test_pdf_page_count_dona_and_boxed(self):
        """Donabay: har donaga 1 sahifa; qutili: ceil(qty/per_box) sahifa."""
        pdf = generate_batch_session_pdf("B-1808-3", "Botir", [
            {"product": "Arqon", "quantity": 3, "weight_kg": 12.5,
             "pieces_per_box": 1, "sku": "ARQ-1"},
            {"product": "Qop ip", "quantity": 50, "weight_kg": 50,
             "pieces_per_box": 25, "sku": ""},
        ], created_at=TS)
        data = pdf.read()
        self.assertEqual(data[:4], b"%PDF")
        pages = max(data.count(b"/Type /Page "), data.count(b"/Type/Page "))
        self.assertEqual(pages, 3 + 2)


if __name__ == "__main__":
    unittest.main()
