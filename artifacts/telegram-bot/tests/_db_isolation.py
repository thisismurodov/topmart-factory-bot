"""Test sxema izolyatsiyasi yordamchisi.

`bot.database` DATABASE_URL'ni birinchi import paytida modul globaliga oladi,
shu bois har bir test moduli import'dan oldin os.environ'ni o'zgartirsa, faqat
BIRINCHI import qilingan modul g'olib chiqadi — qo'shma discovery'da qolganlari
noto'g'ri sxemaga ulanib yiqiladi. To'g'ri yo'l: env'ga tegmasdan,
`bot.database.DATABASE_URL` globalini setUpClass'da vaqtincha patch qilish va
tearDownClass'da qaytarish.
"""

import os
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode, quote

from bot import database as db


def schema_url(schema: str) -> str:
    """DATABASE_URL'ga search_path=<schema> options qo'shilgan variant."""
    base = os.environ["DATABASE_URL"]
    u = urlsplit(base)
    q = dict(parse_qsl(u.query))
    q["options"] = f"-c search_path={schema}"
    return urlunsplit((u.scheme, u.netloc, u.path, urlencode(q, quote_via=quote), u.fragment))


def point_db_to_schema(schema: str) -> str:
    """bot.database'ni berilgan sxemaga yo'naltiradi; eski URL'ni qaytaradi."""
    old = db.DATABASE_URL
    db.DATABASE_URL = schema_url(schema)
    return old


def restore_db_url(old_url: str) -> None:
    db.DATABASE_URL = old_url
