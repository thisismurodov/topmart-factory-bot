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


from bot.label_generator import kg_profile_meaningful  # noqa: E402


class LabelProfileFieldsTest(unittest.TestCase):
    """Profildan olinadigan KG/METRI qiymatlari."""

    def test_kg_profile_meaningful(self):
        self.assertFalse(kg_profile_meaningful(0.0))
        self.assertFalse(kg_profile_meaningful(-2.0))
        self.assertFalse(kg_profile_meaningful(1.0))       # standart qiymat
        self.assertFalse(kg_profile_meaningful(1.0005))    # epsilon ichida
        self.assertTrue(kg_profile_meaningful(0.5))
        self.assertTrue(kg_profile_meaningful(3.1))

    def test_metr_param_overrides_name_regex(self):
        from datetime import datetime as _dt
        from bot.label_generator import _build_single as _bs
        ts = _dt(2026, 8, 18, 14, 32)
        base  = _bs("B-1", "W", "Arqon 6mm", 1, 1, 2.0, ts, sku="A-1")
        withm = _bs("B-1", "W", "Arqon 6mm", 1, 1, 2.0, ts, sku="A-1", metr=80.0)
        self.assertNotEqual(base.tobytes(), withm.tobytes())
        # metr=0 → nomdagi «70 metr» regex ishlashi saqlanadi
        named  = _bs("B-1", "W", "70 metr Strupa", 1, 1, 2.0, ts, sku="A-1")
        named0 = _bs("B-1", "W", "70 metr Strupa", 1, 1, 2.0, ts, sku="A-1", metr=0.0)
        self.assertEqual(named.tobytes(), named0.tobytes())

    def test_session_pdf_with_profile_fields(self):
        from datetime import datetime as _dt
        from bot.label_generator import generate_batch_session_pdf as _gen
        items = [
            {"product": "Arqon", "quantity": 2, "weight_kg": 6.3,
             "pieces_per_box": 1, "sku": "A-1", "profile_kg": 3.1, "metr": 80},
            {"product": "Qop", "quantity": 50, "weight_kg": 100.0,
             "pieces_per_box": 25, "sku": "Q-1", "profile_kg": 2.0, "metr": 0},
        ]
        buf = _gen("B-9", "W", items, _dt(2026, 8, 18, 10, 0))
        self.assertGreater(len(buf.getvalue()), 1000)


class PartialBoxTest(unittest.TestCase):
    """Oxirgi to'liq bo'lmagan quti: haqiqiy dona soni va og'irligi."""

    def test_box_contents(self):
        from bot.label_generator import box_contents
        self.assertEqual(box_contents(26, 25, 1), 25)
        self.assertEqual(box_contents(26, 25, 2), 1)   # oxirgi qutida 1 dona
        self.assertEqual(box_contents(50, 25, 2), 25)
        self.assertEqual(box_contents(24, 25, 1), 24)  # bitta to'liqmas quti
        self.assertEqual(box_contents(5, 1, 3), 1)     # donabay rejim

    def test_partial_box_label_differs_from_full(self):
        from datetime import datetime as _dt
        from bot.label_generator import _build_single as _bs
        ts = _dt(2026, 8, 18, 10, 0)
        full    = _bs("B", "W", "Qop", 1, 2, 50.0, ts, per_box=25, sku="Q-1", in_box=25)
        partial = _bs("B", "W", "Qop", 2, 2, 2.0,  ts, per_box=25, sku="Q-1", in_box=1)
        self.assertNotEqual(full.tobytes(), partial.tobytes())

    def test_partial_box_session_pdf_pages(self):
        from datetime import datetime as _dt
        from bot.label_generator import generate_batch_session_pdf as _gen
        items = [{"product": "Qop", "quantity": 26, "weight_kg": 52.0,
                  "pieces_per_box": 25, "sku": "Q-1", "profile_kg": 2.0}]
        buf = _gen("B-9", "W", items, _dt(2026, 8, 18, 10, 0))
        self.assertGreater(len(buf.getvalue()), 1000)
