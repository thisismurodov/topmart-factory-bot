"""AI tavsiyalar tugmasi (ai_tavsiyalar / _fetch_ai_suggestions) testlari.

Qamrov:
  • _fetch_ai_suggestions — URL (ai=1&agentId=...) va x-internal-key header
    (kalit bor/yo'q holatlari), timeout.
  • AI ro'yxati kelganda formatlash: sarlavha, TOP-10 cheklovi, score/reason.
  • ai=null (server fallback) — rule-based overdue/qaytish ro'yxatlari,
    kadans matni ("odatda N kunda oladi") bor/yo'q holatlari.
  • Ikkala ro'yxat bo'sh — "shoshilinch do'kon yo'q" xabari.
  • API umuman ishlamasa (exception) — DB'dan lost-dokons hisobotiga fallback
    (scope_agent_id bilan chaqirilishi shart — boshqa agent ma'lumoti chiqmasin).
  • Rol himoyasi: faqat agent/supervisor; dokon/no'malum foydalanuvchi rad.

Izolyatsiya: DB ham, tarmoq ham ishlatilmaydi — barcha tashqi chegaralar mock.
main import bo'lishi uchun TELEGRAM_BOT_TOKEN/DATABASE_URL setdefault qilinadi
(mavjud env qiymatlari O'ZGARTIRILMAYDI — qo'shma discovery bilan mos).
"""

import json
import os
import unittest
import urllib.error
from types import SimpleNamespace
from unittest import mock

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "123456:TEST_TOKEN_AI_GUARD")
os.environ.setdefault(
    "DATABASE_URL", "postgresql://test:test@localhost:5432/ai_guard_dummy"
)

import main  # noqa: E402


AGENT_UID = 777001
# distribution.users qatori: (id, telegram_id, name, role, viloyat, created_at)
AGENT_ROW = (1, AGENT_UID, "Test Agent", "agent", "Toshkent", None)


def _msg(uid=AGENT_UID, text="🤖 AI tavsiyalar"):
    return SimpleNamespace(from_user=SimpleNamespace(id=uid), text=text)


class FakeResp:
    """urllib.request.urlopen kontekst-menejer natijasining minimal o'rinbosari."""

    def __init__(self, payload):
        self._body = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FetchAiSuggestionsTest(unittest.TestCase):
    """_fetch_ai_suggestions: URL tuzilishi va x-internal-key header."""

    def _capture(self, key, agent_id=AGENT_UID):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["req"] = req
            captured["timeout"] = timeout
            return FakeResp({"ai": None, "overdue": [], "qaytish": []})

        with mock.patch.object(main, "AI_INTERNAL_KEY", key), mock.patch(
            "urllib.request.urlopen", side_effect=fake_urlopen
        ):
            body = main._fetch_ai_suggestions(agent_id)
        return captured, body

    def test_url_ai1_va_agent_id(self):
        captured, body = self._capture("test-key-123")
        expected = (
            main.API_BASE_URL.rstrip("/")
            + f"/distribution/suggestions?ai=1&agentId={AGENT_UID}"
        )
        self.assertEqual(captured["req"].full_url, expected)
        self.assertEqual(body, {"ai": None, "overdue": [], "qaytish": []})
        self.assertEqual(captured["timeout"], 60)

    def test_internal_key_header_yuboriladi(self):
        captured, _ = self._capture("test-key-123")
        headers = {k.lower(): v for k, v in captured["req"].header_items()}
        self.assertEqual(headers.get("x-internal-key"), "test-key-123")

    def test_kalit_bolmasa_header_yoq(self):
        captured, _ = self._capture("")
        headers = {k.lower(): v for k, v in captured["req"].header_items()}
        self.assertNotIn("x-internal-key", headers)


class AiTavsiyalarHandlerTest(unittest.TestCase):
    """ai_tavsiyalar handler: uch rejim (AI / ai=null / API xato) + rol himoyasi."""

    def setUp(self):
        self.sent = []
        p_send = mock.patch.object(
            main.bot,
            "send_message",
            side_effect=lambda uid, text, **k: self.sent.append((uid, text)),
        )
        p_user = mock.patch.object(main, "get_user", return_value=AGENT_ROW)
        p_send.start()
        self.get_user = p_user.start()
        self.addCleanup(p_send.stop)
        self.addCleanup(p_user.stop)

    def test_ai_royxati_formatlanadi_va_top10(self):
        ai = [
            {
                "nomi": f"Dokon {i}",
                "hudud": "Chilonzor" if i == 1 else "",
                "score": 90 - i,
                "reason": f"Sabab {i}",
            }
            for i in range(1, 13)  # 12 ta — faqat TOP-10 chiqishi kerak
        ]
        with mock.patch.object(
            main, "_fetch_ai_suggestions", return_value={"ai": ai}
        ) as fetch:
            main.ai_tavsiyalar(_msg())
        fetch.assert_called_once_with(AGENT_UID)
        # 1-xabar "tayyorlanmoqda", 2-xabar natija
        self.assertEqual(len(self.sent), 2)
        self.assertIn("tayyorlanmoqda", self.sent[0][1])
        final = self.sent[-1][1]
        self.assertIn("AI TAVSIYALAR", final)
        self.assertIn("1. 🏪 Dokon 1 (Chilonzor) — 89/100", final)
        self.assertIn("💬 Sabab 1", final)
        self.assertIn("\n10. 🏪 Dokon 10", final)
        self.assertNotIn("\n11. ", final)  # TOP-10 cheklovi
        self.assertNotIn("Dokon 11", final)
        self.assertNotIn("BUGUNGI TAVSIYALAR", final)  # rule-based blok chiqmasin

    def test_ai_null_rule_based_fallback(self):
        body = {
            "ai": None,
            "overdue": [
                {"nomi": "Shop Over", "days": 12, "avgRepeatDays": 7},
                {"nomi": "Shop NoCad", "days": 45, "avgRepeatDays": 0},
            ],
            "qaytish": [{"nomi": "Shop Ret", "qaytishSanasi": "15.08.2026"}],
        }
        with mock.patch.object(main, "_fetch_ai_suggestions", return_value=body):
            main.ai_tavsiyalar(_msg())
        final = self.sent[-1][1]
        self.assertIn("BUGUNGI TAVSIYALAR (oddiy)", final)
        self.assertIn("Kechikkan do'konlar", final)
        self.assertIn("Shop Over — 12 kun xarid yo'q, odatda 7 kunda oladi", final)
        # Kadanssiz do'konda "odatda ..." qo'shimchasi bo'lmasligi kerak
        self.assertIn("Shop NoCad — 45 kun xarid yo'q\n", final)
        self.assertNotIn("Shop NoCad — 45 kun xarid yo'q,", final)
        self.assertIn("Qaytish sanasi kelganlar", final)
        self.assertIn("Shop Ret — va'da: 15.08.2026", final)
        self.assertNotIn("AI TAVSIYALAR", final)

    def test_ai_null_bosh_royxatlar(self):
        body = {"ai": None, "overdue": [], "qaytish": []}
        with mock.patch.object(main, "_fetch_ai_suggestions", return_value=body):
            main.ai_tavsiyalar(_msg())
        self.assertIn("Hozircha shoshilinch do'kon yo'q", self.sent[-1][1])

    def test_api_xato_lost_dokons_fallback(self):
        with mock.patch.object(
            main, "_fetch_ai_suggestions", side_effect=urllib.error.URLError("boom")
        ), mock.patch.object(
            main, "_build_lost_dokons_report", return_value=("LOST HISOBOT MATNI", 3)
        ) as rep:
            main.ai_tavsiyalar(_msg())
        # Fallback FAQAT shu agent doirasida chaqirilishi shart
        rep.assert_called_once_with(scope_agent_id=AGENT_UID)
        final = self.sent[-1][1]
        self.assertIn("AI hozircha mavjud emas", final)
        self.assertIn("LOST HISOBOT MATNI", final)

    def test_http_status_xato_ham_fallbackka_tushadi(self):
        err = urllib.error.HTTPError(
            url="http://x", code=500, msg="ISE", hdrs=None, fp=None
        )
        with mock.patch.object(
            main, "_fetch_ai_suggestions", side_effect=err
        ), mock.patch.object(
            main, "_build_lost_dokons_report", return_value=("ZAXIRA RO'YXAT", 1)
        ):
            main.ai_tavsiyalar(_msg())
        self.assertIn("ZAXIRA RO'YXAT", self.sent[-1][1])

    def test_rol_himoyasi_dokon_rad(self):
        self.get_user.return_value = (1, AGENT_UID, "Do'kon egasi", "dokon", "T", None)
        with mock.patch.object(main, "_fetch_ai_suggestions") as fetch:
            main.ai_tavsiyalar(_msg())
        fetch.assert_not_called()
        self.assertEqual(self.sent, [])

    def test_nomalum_foydalanuvchi_rad(self):
        self.get_user.return_value = None
        with mock.patch.object(main, "_fetch_ai_suggestions") as fetch:
            main.ai_tavsiyalar(_msg())
        fetch.assert_not_called()
        self.assertEqual(self.sent, [])

    def test_supervisor_ruxsat(self):
        self.get_user.return_value = (1, AGENT_UID, "Sup", "supervisor", "T", None)
        with mock.patch.object(
            main,
            "_fetch_ai_suggestions",
            return_value={"ai": None, "overdue": [], "qaytish": []},
        ):
            main.ai_tavsiyalar(_msg())
        self.assertEqual(len(self.sent), 2)


if __name__ == "__main__":
    unittest.main()
