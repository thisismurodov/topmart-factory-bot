"""100×80mm etiketka generatori guard-testlari.

Bu testlar DB talab qilmaydi — sof Pillow/img2pdf.
"""
import io
import unittest
from datetime import datetime

from bot.label_generator import (
    LABEL_H,
    LABEL_W,
    _build_single,
    generate_batch_session_pdf,
)

TS = datetime(2026, 8, 18, 14, 32)


class LabelGeneratorTest(unittest.TestCase):
    def test_canvas_is_100x80mm_at_203dpi(self):
        # 100×80mm @ 203 DPI — yangi termal printer qog'ozi
        self.assertEqual(LABEL_W, round(100 * 203 / 25.4))  # 799
        self.assertEqual(LABEL_H, round(80 * 203 / 25.4))   # 639

    def test_label_size_is_fixed_not_cropped(self):
        """Die-cut stiker: balandlik doim qat'iy, pastki kesish yo'q."""
        for product, per_box, weight in [
            ("Arqon 6mm Ko'k", 1, 12.5),
            ("Polipropilen CF 1500D Sariq granula eksport", 25, 18.75),
            ("0.5 Babin / Qora", 1, 0.0),
        ]:
            img = _build_single("B-1808-3", "Botir", product, 1, 4,
                                weight, TS, per_box=per_box)
            self.assertEqual(img.size, (LABEL_W, LABEL_H), product)

    def test_weightless_label_has_no_dash_blob(self):
        """Og'irliksiz etiketkada pastki chap burchakda katta qora «—»
        chizilmasligi kerak (brak dog'iga o'xshaydi)."""
        img = _build_single("B-1808-7", "Dilshod", "0.5 Babin", 1, 4, 0.0, TS)
        # Og'irlik zonasi (footer chizig'idan yuqorida, chap yarim) oq bo'lishi shart
        zone = img.crop((20, LABEL_H - 160, LABEL_W // 2, LABEL_H - 80))
        colors = zone.getcolors(maxcolors=8)
        self.assertIsNotNone(colors)
        self.assertEqual(len(colors), 1, "zonada faqat oq rang bo'lishi kerak")
        self.assertEqual(colors[0][1], (255, 255, 255))

    def test_pdf_page_count_dona_and_boxed(self):
        """Donabay: har donaga 1 sahifa; qutili: ceil(qty/per_box) sahifa."""
        pdf = generate_batch_session_pdf("B-1808-3", "Botir", [
            {"product": "Arqon", "quantity": 3, "weight_kg": 12.5, "pieces_per_box": 1},
            {"product": "Qop ip", "quantity": 50, "weight_kg": 50, "pieces_per_box": 25},
        ], created_at=TS)
        data = pdf.read()
        self.assertEqual(data[:4], b"%PDF")
        pages = max(data.count(b"/Type /Page "), data.count(b"/Type/Page "))
        self.assertEqual(pages, 3 + 2)


if __name__ == "__main__":
    unittest.main()
