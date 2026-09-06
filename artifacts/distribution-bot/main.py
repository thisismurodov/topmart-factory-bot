import os
import telebot
from telebot import types
import psycopg2
import csv
import io
import threading
import uuid
import schedule
import time
from datetime import datetime, date, timedelta

# Railway/serverlar UTC'da ishlaydi — barcha datetime.now() chaqiruvlari
# Toshkent vaqtida bo'lishi uchun jarayon TZ'sini majburan o'rnatamiz.
# Aks holda yarim tundan keyin (00:00-05:00) bot "kecha"gi kunni ko'rsatadi.
os.environ["TZ"] = "Asia/Tashkent"
time.tzset()

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
if not TOKEN:
    raise RuntimeError("TELEGRAM_BOT_TOKEN must be set")
_admin_env = os.environ.get("ADMIN_IDS", "").strip()
if _admin_env:
    ADMIN_IDS = [int(x.strip()) for x in _admin_env.replace(";",",").split(",") if x.strip().isdigit()]
else:
    ADMIN_IDS = [1261052681]

# TopMart Field Assistant (Telegram Mini App) URL — delivery agent keyboard'idagi
# "BOSHLASH" web_app tugmasi shu manzilni ochadi. Railway'da FIELD_APP_URL env
# o'rnatiladi; Replit dev muhitida REPLIT_DEV_DOMAIN'dan avtomatik olinadi.
FIELD_APP_URL = os.environ.get("FIELD_APP_URL", "").strip()
if not FIELD_APP_URL:
    _dev_domain = os.environ.get("REPLIT_DEV_DOMAIN", "").strip()
    if _dev_domain:
        FIELD_APP_URL = f"https://{_dev_domain}/field/"

# Node API manzili — AI tavsiyalar endpoint'i (GET /distribution/suggestions?ai=1)
# shu API orqali chaqiriladi (server 10 daqiqalik LLM keshiga ega). Railway'da
# API_BASE_URL + AI_INTERNAL_KEY env o'rnatiladi; Replit dev'da localhost fallback.
API_BASE_URL = os.environ.get("API_BASE_URL", "").strip() or "http://localhost:80/api"
AI_INTERNAL_KEY = os.environ.get("AI_INTERNAL_KEY", "").strip()

import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("distribution.bot")

from database import get_db, init_db, transaction, DatabaseUnavailable
from database import vehicle_fill as vfill
import vehicle_api
import json
from decimal import Decimal

# --- Global DB error handling -------------------------------------------
# PostgreSQL vaqtincha ulanmasa: foydalanuvchiga tushunarli xabar, log yoziladi,
# bot ishlashda davom etadi (polling to'xtamaydi).
DB_ERROR_MSG = "\u26a0\ufe0f Ma'lumotlar bazasi bilan vaqtincha aloqa yo'q. Iltimos, birozdan so'ng qayta urinib ko'ring."

def _wrap_db_errors(fn):
    def inner(msg, *a, **k):
        try:
            return fn(msg, *a, **k)
        except (DatabaseUnavailable, psycopg2.Error) as e:
            log.exception("DB error in handler %s: %s", getattr(fn, "__name__", "?"), e)
            try:
                uid = getattr(getattr(msg, "from_user", None), "id", None)
                if uid:
                    bot.send_message(uid, DB_ERROR_MSG)
            except Exception:
                pass
    inner.__name__ = getattr(fn, "__name__", "handler")
    return inner

class SafeTeleBot(telebot.TeleBot):
    def message_handler(self, *a, **k):
        parent = super().message_handler(*a, **k)
        def deco(fn):
            return parent(_wrap_db_errors(fn))
        return deco

bot = SafeTeleBot(TOKEN)
user_state = {}
def set_state(uid,s,d=None): user_state[uid]={"state":s,"data":d or {}}
def get_state(uid): return user_state.get(uid,{"state":None,"data":{}})
def clear_state(uid): user_state.pop(uid,None)
from database import (
    get_user, get_balans, update_balans_delta, apply_balans_delta,
    update_dokon_repeat, create_sale, record_pul_olish, pay_nasiya_fifo,
    create_vehicle_pilot_sale, VehiclePilotSaleError, is_vehicle_pilot_seller,
    get_admin_telegram_ids,
    acknowledge, deliver_retryable,
)

def _replenishment_ack_markup(outbox_id):
    kb = types.InlineKeyboardMarkup()
    kb.add(types.InlineKeyboardButton(
        "✅ Qabul qilindi",
        callback_data="replenishment_ack:%s" % outbox_id,
    ))
    return kb

def run_replenishment_delivery():
    """Retry durable low-stock notifications without blocking bot polling."""
    while True:
        try:
            deliver_retryable(bot, _replenishment_ack_markup)
        except Exception as exc:
            log.exception("Vehicle replenishment delivery loop failed: %s", exc)
        time.sleep(10)

@bot.callback_query_handler(
    func=lambda call: (call.data or "").startswith("replenishment_ack:")
)
def acknowledge_replenishment(call):
    try:
        outbox_id = int(call.data.split(":", 1)[1])
        chat_id = call.message.chat.id
        if acknowledge(outbox_id, chat_id):
            bot.answer_callback_query(call.id, "Qabul qilindi")
            try:
                bot.edit_message_reply_markup(
                    chat_id, call.message.message_id, reply_markup=None
                )
            except Exception:
                pass
        else:
            bot.answer_callback_query(call.id, "Tasdiqlash rad etildi", show_alert=True)
    except Exception as exc:
        log.exception("Vehicle replenishment ACK failed: %s", exc)
        try:
            bot.answer_callback_query(call.id, "Vaqtincha xato", show_alert=True)
        except Exception:
            pass

def is_admin(tid):
    if tid in ADMIN_IDS: return True
    u=get_user(tid); return u and u[3]=="admin"
def all_admin_ids():
    """Env ADMIN_IDS + DB role='admin' users (de-duplicated)."""
    ids=set(ADMIN_IDS)
    try:
        for tid in get_admin_telegram_ids(): ids.add(tid)
    except Exception as e:
        log.warning("all_admin_ids DB lookup failed: %s", e)
    return ids
def notify_admins(text=None, photo=None, caption=None):
    """Send a notification to every admin (env + DB)."""
    for aid in all_admin_ids():
        try:
            if photo: bot.send_photo(aid, photo, caption=caption or text)
            else: bot.send_message(aid, text)
        except: pass
def check_pending(uid):
    u=get_user(uid)
    if u and u[3]=="pending":
        bot.send_message(uid,"⏳ Hisobingiz hali tasdiqlanmagan. Admin tasdiqlashini kuting.")
        return True
    return False
def fmt(a):
    try: return f"{round(float(a)):,}".replace(","," ")+" so'm"
    except: return "0 so'm"

def _norm_text(s):
    """Imlo-chidamli normalizatsiya: kichik harf, apostrof/harf variantlarini tenglashtirish.
    "Do'kon"/"dokon"/"doʻkon" → bir xil ko'rinish."""
    if s is None: return ""
    s=str(s).lower()
    # Apostrof va o'xshash belgilarni olib tashlash (o' → o, g' → g)
    for ch in ("'","`","ʻ","ʼ","’","‘","´","ʹ","-"):
        s=s.replace(ch,"")
    # Kirill → lotin asosiy harflar (aralash yozuvlar uchun)
    cyr={"а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ё":"yo","ж":"j","з":"z",
         "и":"i","й":"y","к":"k","л":"l","м":"m","н":"n","о":"o","п":"p","р":"r",
         "с":"s","т":"t","у":"u","ф":"f","х":"x","ц":"s","ч":"ch","ш":"sh",
         "ъ":"","ь":"","э":"e","ю":"yu","я":"ya","қ":"q","ғ":"g","ҳ":"h","ў":"o"}
    s="".join(cyr.get(ch,ch) for ch in s)
    # Harf variantlari: x/h ni tenglashtirish
    s=s.replace("x","h")
    # Bo'shliqlarni siqish
    s=" ".join(s.split())
    return s

def _dokon_suggestions(uid_scope_rows, q, limit=5):
    """Bo'sh natijada yaqin variantlarni topish (difflib) — dokon NOMI va EGASI ismi bo'yicha.
    uid_scope_rows: [(id,nomi),...] yoki [(id,nomi,egasi),...] — foydalanuvchi ko'ra oladigan dokonlar."""
    import difflib
    nq=_norm_text(q)
    def _score(field):
        if not field: return 0.0
        nn=_norm_text(field)
        r=difflib.SequenceMatcher(None,nq,nn).ratio()
        # qisman moslik ham hisobga olinadi
        if nq and (nq in nn or nn in nq): r=max(r,0.75)
        return r
    scored=[]
    for row in uid_scope_rows:
        did,nomi=row[0],row[1]
        egasi=row[2] if len(row)>2 else None
        s_nomi=_score(nomi); s_egasi=_score(egasi)
        best=max(s_nomi,s_egasi)
        if best<0.55: continue
        # Egasi bo'yicha mos kelgan bo'lsa — tugmada egasi ismini ham ko'rsatamiz
        if egasi and s_egasi>=0.55 and s_egasi>=s_nomi:
            display=f"{nomi} — {egasi}"
        else:
            display=nomi
        scored.append((best,did,display))
    scored.sort(reverse=True)
    return [(did,display) for _,did,display in scored[:limit]]
def _send_repeat_report(uid):
    conn=get_db();c=conn.cursor()
    c.execute("""SELECT id,nomi,viloyat,last_order_date,avg_repeat_days,total_orders,repeat_orders,total_sales
                 FROM dokonlar WHERE holat='faol'""")
    rows=c.fetchall(); conn.close()
    if not rows:
        bot.send_message(uid,"❗ Faol dokon yo'q.",reply_markup=main_kb("admin")); return
    hot=warm=cold=new=0; repeat_stores=0; total_sales=0
    cold_list=[]
    for r in rows:
        did,nomi,vil,last_d,avg_d,t_o,r_o,t_s=r
        t_o=t_o or 0; r_o=r_o or 0; t_s=t_s or 0; avg_d=avg_d or 0
        total_sales+=t_s
        if r_o>0: repeat_stores+=1
        lbl,days=get_store_status(last_d,avg_d)
        if "HOT" in lbl: hot+=1
        elif "WARM" in lbl: warm+=1
        elif "COLD" in lbl:
            cold+=1
            cold_list.append((days or 0,nomi,vil or '—',days))
        else: new+=1
    rate=round((repeat_stores/len(rows))*100,1) if rows else 0
    cold_list.sort(reverse=True)
    text=(f"🔁 REPEAT HISOBOTI\n{'━'*26}\n"
          f"🏪 Jami faol: {len(rows)}\n"
          f"🟢 HOT: {hot}\n"
          f"🟡 WARM: {warm}\n"
          f"🔴 COLD: {cold}\n"
          f"⚪ NEW (savdosiz): {new}\n\n"
          f"📈 Repeat Rate: {rate}%\n"
          f"   ({repeat_stores}/{len(rows)} dokon qayta savdo qilgan)\n"
          f"💰 Jami savdo: {fmt(total_sales)}\n")
    if cold_list:
        text+=f"\n{'━'*26}\n🔴 QAYTA KIRISH KERAK (top 15):\n"
        for d,nomi,vil,days in cold_list[:15]:
            text+=f"  • {nomi} ({vil}) — {days} kun\n"
    bot.send_message(uid,text,reply_markup=main_kb("admin"))

@bot.message_handler(func=lambda m:m.text=="🔁 Repeat hisoboti")
def repeat_hisoboti(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    _send_repeat_report(uid)

def _build_lost_dokons_report(scope_agent_id=None):
    """Return text + counts for 'lost' (silent) dokons report.
    scope_agent_id=None → admin (barcha agentlar). Aks holda — bitta agent."""
    from datetime import datetime as _dt
    conn=get_db();c=conn.cursor()
    if scope_agent_id:
        c.execute("""SELECT d.id,d.nomi,d.viloyat,d.hudud,d.last_order_date,d.created_at,d.agent_id,
                            COALESCE(u.name,'—'),d.total_orders
                     FROM dokonlar d LEFT JOIN users u ON u.telegram_id=d.agent_id
                     WHERE d.holat='faol' AND d.agent_id=%s""",(scope_agent_id,))
    else:
        c.execute("""SELECT d.id,d.nomi,d.viloyat,d.hudud,d.last_order_date,d.created_at,d.agent_id,
                            COALESCE(u.name,'—'),d.total_orders
                     FROM dokonlar d LEFT JOIN users u ON u.telegram_id=d.agent_id
                     WHERE d.holat='faol'""")
    rows=c.fetchall(); conn.close()
    now=_dt.now()
    # Buckets
    new_no_sale=[]  # registered 14+ days ago, never bought
    yellow=[]  # 30-60 days silent
    orange=[]  # 60-90 days
    red=[]     # 90+ days
    for did,nomi,vil,hudud,last_d,created_at,agent_id,agent_name,total_o in rows:
        if not last_d or (total_o or 0)==0:
            try:
                cr=_dt.fromisoformat(created_at) if created_at else None
                if cr and (now-cr).days>=14:
                    new_no_sale.append((did,nomi,vil,agent_name,(now-cr).days,"yangi"))
            except: pass
            continue
        try:
            ld=_dt.fromisoformat(last_d); days=(now-ld).days
        except: continue
        rec=(did,nomi,vil,agent_name,days,last_d[:10])
        if days>=90: red.append(rec)
        elif days>=60: orange.append(rec)
        elif days>=30: yellow.append(rec)
    # Sort each desc by days
    for lst in (red,orange,yellow,new_no_sale): lst.sort(key=lambda x:-x[4])
    title="⚠️ YO'QOLAYOTGAN DOKONLAR" + (f"\n👤 {scope_agent_id}" if scope_agent_id else " (BARCHA)")
    text=(f"{title}\n{'━'*26}\n"
          f"🔴 90+ kun jim: {len(red)} ta\n"
          f"🟠 60-90 kun: {len(orange)} ta\n"
          f"🟡 30-60 kun: {len(yellow)} ta\n"
          f"⚪ Yangi (savdo yo'q): {len(new_no_sale)} ta\n")
    def _fmt_block(emoji, label, items, limit=15):
        if not items: return ""
        s=f"\n{'━'*26}\n{emoji} {label} ({len(items)} ta):\n"
        for did,nomi,vil,aname,days,extra in items[:limit]:
            if scope_agent_id:
                s+=f"  • {nomi} ({vil or '—'}) — {days} kun\n"
            else:
                s+=f"  • {nomi} ({vil or '—'}, {aname}) — {days} kun\n"
        if len(items)>limit:
            s+=f"  … +{len(items)-limit} ta\n"
        return s
    text+=_fmt_block("🔴","KRITIK (90+ kun)",red)
    text+=_fmt_block("🟠","XAVFLI (60-90 kun)",orange)
    text+=_fmt_block("🟡","DIQQAT (30-60 kun)",yellow)
    text+=_fmt_block("⚪","YANGI — savdo yo'q",new_no_sale)
    total=len(red)+len(orange)+len(yellow)+len(new_no_sale)
    if total==0:
        text+=f"\n{'━'*26}\n✅ Hammasi joyida! Yo'qolayotgan dokon yo'q."
    return text,total

@bot.message_handler(func=lambda m:m.text=="⚠️ Yo'qolayotgan dokonlar")
def yoqolayotgan_dokonlar(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    text,_=_build_lost_dokons_report()
    _send_long(uid, text)

def send_weekly_lost_alert():
    """Cron: har dushanba 09:00 — adminlarga yo'qolayotgan dokonlar hisoboti."""
    text,total=_build_lost_dokons_report()
    if total==0: return
    header="📊 HAFTALIK OGOHLANTIRISH\n\n"
    for aid in all_admin_ids():
        _send_long(aid, header+text)

def _build_old_nasiya_report(scope_agent_id=None):
    """Old-credit aging report. Groups outstanding nasiya by age:
    🟡 30-60 kun, 🟠 60-90 kun, 🔴 90+ kun."""
    from datetime import datetime as _dt
    conn=get_db();c=conn.cursor()
    base="""SELECT n.id,n.dokon_id,d.nomi,d.viloyat,n.jami_summa,n.tolangan,n.qoldiq,
                   n.created_at,n.agent_id,COALESCE(u.name,'—')
            FROM nasiya n
            JOIN dokonlar d ON d.id=n.dokon_id
            LEFT JOIN users u ON u.telegram_id=n.agent_id
            WHERE n.qoldiq>0"""
    if scope_agent_id:
        c.execute(base+" AND n.agent_id=%s",(scope_agent_id,))
    else:
        c.execute(base)
    rows=c.fetchall(); conn.close()
    now=_dt.now()
    yellow=[]; orange=[]; red=[]
    sum_y=sum_o=sum_r=0
    for nid,did,nomi,vil,jami,tol,qoldiq,created_at,agent_id,aname in rows:
        try:
            cr=_dt.fromisoformat(created_at); days=(now-cr).days
        except: continue
        if days<30: continue
        rec=(nomi,vil,aname,qoldiq,days,created_at[:10])
        if days>=90: red.append(rec); sum_r+=qoldiq
        elif days>=60: orange.append(rec); sum_o+=qoldiq
        else: yellow.append(rec); sum_y+=qoldiq
    for lst in (red,orange,yellow): lst.sort(key=lambda x:-x[3])
    title="💸 ESKI NASIYALAR" + ("" if scope_agent_id else " (BARCHA AGENTLAR)")
    total_sum=sum_y+sum_o+sum_r
    text=(f"{title}\n{'━'*26}\n"
          f"🔴 90+ kun: {len(red)} ta — {fmt(sum_r)}\n"
          f"🟠 60-90 kun: {len(orange)} ta — {fmt(sum_o)}\n"
          f"🟡 30-60 kun: {len(yellow)} ta — {fmt(sum_y)}\n"
          f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
          f"💰 Jami muddatli qarz: {fmt(total_sum)}\n")
    def _fmt_block(emoji, label, items, limit=15):
        if not items: return ""
        s=f"\n{'━'*26}\n{emoji} {label} ({len(items)} ta):\n"
        for nomi,vil,aname,qoldiq,days,sana in items[:limit]:
            if scope_agent_id:
                s+=f"  • {nomi} ({vil or '—'}) — {fmt(qoldiq)} | {days} kun ({sana})\n"
            else:
                s+=f"  • {nomi} ({aname}) — {fmt(qoldiq)} | {days} kun\n"
        if len(items)>limit:
            s+=f"  … +{len(items)-limit} ta\n"
        return s
    text+=_fmt_block("🔴","KRITIK (90+ kun)",red)
    text+=_fmt_block("🟠","XAVFLI (60-90 kun)",orange)
    text+=_fmt_block("🟡","DIQQAT (30-60 kun)",yellow)
    if len(red)+len(orange)+len(yellow)==0:
        text+=f"\n{'━'*26}\n✅ Eski nasiya yo'q! Hammasi yangi yoki to'langan."
    return text, len(red)+len(orange)+len(yellow), total_sum

@bot.message_handler(func=lambda m:m.text=="💸 Eski nasiyalar")
def eski_nasiyalar(msg):
    uid=msg.from_user.id
    if not is_admin(uid):
        # Agent — only own
        user=get_user(uid)
        if not user or user[3] not in ("agent","supervisor"): return
        text,_,_=_build_old_nasiya_report(scope_agent_id=uid)
        _send_long(uid, text); return
    text,_,_=_build_old_nasiya_report()
    _send_long(uid, text)

def send_weekly_old_nasiya_alert():
    """Cron: dushanba 09:30 — adminlar va har bir agentga muddatli nasiyalar."""
    # Adminlarga umumiy
    text,total,_=_build_old_nasiya_report()
    if total>0:
        header="💸 HAFTALIK NASIYA OGOHLANTIRISH\n\n"
        for aid in all_admin_ids():
            _send_long(aid, header+text)
    # Har agentga o'zinikini
    conn=get_db();c=conn.cursor()
    c.execute("SELECT DISTINCT agent_id FROM nasiya WHERE qoldiq>0")
    agent_ids=[r[0] for r in c.fetchall()]
    conn.close()
    for aid in agent_ids:
        atext,atotal,_=_build_old_nasiya_report(scope_agent_id=aid)
        if atotal>0:
            try: _send_long(aid, "💸 SIZNING MUDDATLI NASIYALARINGIZ\n\n"+atext)
            except: pass

# ───────────── OYLIK REYTING ─────────────
def _build_monthly_rating(oy=None):
    """Returns text for monthly top-agents rating."""
    if oy is None: oy=datetime.now().strftime("%Y-%m")
    conn=get_db();c=conn.cursor()
    c.execute("""SELECT u.telegram_id,u.name,u.viloyat,
                        COALESCE(SUM(s.jami_summa),0) as savdo,
                        COUNT(DISTINCT s.id) as savdo_n
                 FROM users u
                 LEFT JOIN savdolar s ON s.agent_id=u.telegram_id AND substr(s.created_at,1,7)=%s
                 WHERE u.role IN ('agent','supervisor')
                 GROUP BY u.telegram_id,u.name,u.viloyat ORDER BY savdo DESC""",(oy,))
    by_savdo=c.fetchall()
    c.execute("""SELECT u.telegram_id,u.name,COUNT(d.id) as dn
                 FROM users u
                 LEFT JOIN dokonlar d ON d.agent_id=u.telegram_id AND substr(d.created_at,1,7)=%s
                 WHERE u.role IN ('agent','supervisor')
                 GROUP BY u.telegram_id,u.name ORDER BY dn DESC""",(oy,))
    by_dokon=c.fetchall()
    c.execute("""SELECT u.telegram_id,u.name,COALESCE(SUM(p.summa),0) as inkasso
                 FROM users u
                 LEFT JOIN pul_olish p ON p.agent_id=u.telegram_id AND substr(p.created_at,1,7)=%s
                 WHERE u.role IN ('agent','supervisor')
                 GROUP BY u.telegram_id,u.name ORDER BY inkasso DESC""",(oy,))
    by_inkasso=c.fetchall()
    conn.close()
    medals=["🥇","🥈","🥉"]
    def _list(rows, value_idx, fmt_fn):
        lines=[]
        for i,r in enumerate(rows[:5]):
            val=r[value_idx]
            if val<=0 and i>=3: break
            med=medals[i] if i<3 else f" {i+1}."
            lines.append(f"  {med} {r[1]} — {fmt_fn(val)}")
        return "\n".join(lines) if lines else "  —"
    text=(f"🏆 OYLIK REYTING\n📅 {oy}\n{'━'*26}\n\n"
          f"💰 TOP SAVDO:\n{_list(by_savdo,3,fmt)}\n\n"
          f"🏪 TOP YANGI DOKON OCHUVCHI:\n{_list(by_dokon,2,lambda v: f'{v} ta')}\n\n"
          f"💵 TOP INKASSO (yig'gan pul):\n{_list(by_inkasso,2,fmt)}\n")
    # Overall winner = #1 in savdo
    if by_savdo and by_savdo[0][3]>0:
        w=by_savdo[0]
        text+=f"\n{'━'*26}\n🎉 OY G'OLIBI: {w[1]} ({w[2] or '—'})\n💰 {fmt(w[3])} | {w[4]} ta savdo"
    return text

@bot.message_handler(func=lambda m:m.text=="🏆 Oylik reyting")
def oylik_reyting(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    _send_long(uid,_build_monthly_rating())

def send_monthly_rating_if_last_day():
    """Cron daily 20:00: if today is last day of month, broadcast rating to all admins+agents."""
    from calendar import monthrange
    now=datetime.now()
    if now.day != monthrange(now.year,now.month)[1]: return
    text=_build_monthly_rating()
    # Send to all admins
    targets=set(all_admin_ids())
    # And to all agents
    conn=get_db();c=conn.cursor()
    c.execute("SELECT telegram_id FROM users WHERE role IN ('agent','supervisor')")
    for (tid,) in c.fetchall():
        if tid: targets.add(tid)
    conn.close()
    for tid in targets:
        try: _send_long(tid,text)
        except: pass

# ───────────── DELIVERY AGENT CRUD (with hard-delete) ─────────────
DLV_FIELDS=[("name","👤 Ism-familiya"),
            ("telefon","📞 Telefon raqami (masalan: +998901234567)"),
            ("tugilgan_kun","🎂 Tug'ilgan kuni (DD.MM.YYYY, masalan: 15.03.1990)"),
            ("mashina_turi","🚗 Mashina turi (masalan: Damas, Labo, Isuzu)"),
            ("mashina_nomeri","🔢 Avtomashina nomeri (masalan: 01 A 123 BC)"),
            ("hudud","📍 Hudud (qaysi viloyat/tumanga yetkazadi)")]

def dlv_menu_kb():
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    kb.add("📋 Delivery agentlar ro'yxati")
    kb.add("➕ Delivery agent qo'shish")
    kb.add("🗑 Delivery agent o'chirish")
    kb.add("🗺 Haftalik marshrut")
    kb.add("⬅️ Asosiy menyu")
    return kb

DAYS=[(1,"Dushanba"),(2,"Seshanba"),(3,"Chorshanba"),
      (4,"Payshanba"),(6,"Shanba"),(7,"Yakshanba")]
DAYS_BY_NAME={n:i for i,n in DAYS}
DAY_NAMES_ALL={1:"Dushanba",2:"Seshanba",3:"Chorshanba",4:"Payshanba",5:"Juma",6:"Shanba",7:"Yakshanba"}
def day_name(i):
    for x,n in DAYS:
        if x==i: return n
    if i in DAY_NAMES_ALL: return DAY_NAMES_ALL[i]
    return "—"

@bot.message_handler(func=lambda m:m.text=="🚚 Delivery agent")
def dlv_menu(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    bot.send_message(uid,"🚚 DELIVERY AGENT BOSHQARUV\n\nNima qilamiz?",reply_markup=dlv_menu_kb())

@bot.message_handler(func=lambda m:m.text=="⬅️ Asosiy menyu")
def dlv_back(msg):
    uid=msg.from_user.id; user=get_user(uid)
    if not user: return
    set_state(uid,None,{})
    bot.send_message(uid,"🏠 Asosiy menyu",reply_markup=main_kb(user[3],uid))
    if user[3] in("delivery","agent","supervisor"): send_field_btn(uid)

@bot.message_handler(func=lambda m:m.text=="📋 Delivery agentlar ro'yxati")
def dlv_list(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    conn=get_db();c=conn.cursor()
    c.execute("""SELECT id,name,telefon,tugilgan_kun,mashina_turi,mashina_nomeri,hudud
                 FROM delivery_agents WHERE faol=1 ORDER BY name""")
    rows=c.fetchall(); conn.close()
    if not rows:
        bot.send_message(uid,"📋 Hozircha delivery agent yo'q.\n\n➕ Delivery agent qo'shish ni bosing.",
            reply_markup=dlv_menu_kb()); return
    text=f"📋 DELIVERY AGENTLAR ({len(rows)} ta)\n{'━'*26}\n"
    for i,r in enumerate(rows,1):
        _,name,tel,tug,mt,mn,hud=r
        text+=(f"\n{i}. 👤 {name}\n"
               f"   📞 {tel or '—'}\n"
               f"   🎂 {tug or '—'}\n"
               f"   🚗 {mt or '—'} | 🔢 {mn or '—'}\n"
               f"   📍 {hud or '—'}\n")
    _send_long(uid,text)
    bot.send_message(uid,"⬇️",reply_markup=dlv_menu_kb())

@bot.message_handler(func=lambda m:m.text=="➕ Delivery agent qo'shish")
def dlv_add_start(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    set_state(uid,"dlv_add_0",{"step":0})
    bot.send_message(uid,
        f"➕ YANGI DELIVERY AGENT\n\n1/{len(DLV_FIELDS)} — {DLV_FIELDS[0][1]}\n\nKiriting:",
        reply_markup=cancel_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"] and get_state(m.from_user.id)["state"].startswith("dlv_add_"))
def dlv_add_step(msg):
    uid=msg.from_user.id
    txt=(msg.text or "").strip()
    if txt=="❌ Bekor qilish":
        set_state(uid,None,{})
        bot.send_message(uid,"Bekor qilindi",reply_markup=dlv_menu_kb()); return
    state=get_state(uid); data=state["data"]; step=data.get("step",0)
    if not txt: bot.send_message(uid,"❗ Bo'sh yuboroldi. Qaytadan kiriting:"); return
    field_key,_=DLV_FIELDS[step]
    data[field_key]=txt
    step+=1
    data["step"]=step
    if step<len(DLV_FIELDS):
        set_state(uid,f"dlv_add_{step}",data)
        bot.send_message(uid,
            f"✅ Saqlandi.\n\n{step+1}/{len(DLV_FIELDS)} — {DLV_FIELDS[step][1]}\n\nKiriting:",
            reply_markup=cancel_kb())
        return
    # All fields collected → save
    conn=get_db();c=conn.cursor()
    c.execute("""INSERT INTO delivery_agents
                 (name,telefon,tugilgan_kun,mashina_turi,mashina_nomeri,hudud,created_at)
                 VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
              (data["name"],data["telefon"],data["tugilgan_kun"],
               data["mashina_turi"],data["mashina_nomeri"],data["hudud"],
               datetime.now().isoformat()))
    new_id=c.fetchone()[0]
    conn.commit(); conn.close()
    set_state(uid,None,{})
    summary=(f"✅ DELIVERY AGENT QO'SHILDI!\n{'━'*26}\n"
             f"👤 {data['name']}\n"
             f"📞 {data['telefon']}\n"
             f"🎂 {data['tugilgan_kun']}\n"
             f"🚗 {data['mashina_turi']} | 🔢 {data['mashina_nomeri']}\n"
             f"📍 {data['hudud']}")
    # Offer to create weekly route now
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=2)
    kb.add(f"🗺 Ha, marshrut yaratamiz ({new_id})","⏭ Keyinroq")
    set_state(uid,"dlv_after_create",{"new_id":new_id,"new_name":data['name']})
    bot.send_message(uid,summary+"\n\n🗺 Hozir uning **haftalik marshrutini** yaratamizmi?",
        parse_mode="Markdown",reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="dlv_after_create")
def dlv_after_create(msg):
    uid=msg.from_user.id
    txt=(msg.text or "").strip()
    data=get_state(uid)["data"]
    if txt.startswith("🗺 Ha"):
        # Jump straight to day picker for the newly created agent
        new_id=data.get("new_id"); new_name=data.get("new_name","—")
        _start_route_day_picker(uid, new_id, new_name)
        return
    set_state(uid,None,{})
    bot.send_message(uid,"⏭ Keyinroq qilamiz. (🗺 Haftalik marshrut tugmasi orqali)",reply_markup=dlv_menu_kb())

# ─── HAFTALIK MARSHRUT ───
def _route_count(dlv_id, kun):
    conn=get_db();c=conn.cursor()
    c.execute("SELECT COUNT(*) FROM delivery_routes WHERE delivery_agent_id=%s AND kun=%s",(dlv_id,kun))
    n=c.fetchone()[0]; conn.close(); return n

def _route_dokon_ids(dlv_id, kun):
    conn=get_db();c=conn.cursor()
    c.execute("SELECT dokon_id FROM delivery_routes WHERE delivery_agent_id=%s AND kun=%s",(dlv_id,kun))
    ids=[r[0] for r in c.fetchall()]; conn.close(); return ids

def _route_resequence(c, dlv_id, kun):
    """Tartib raqamlarini 1..N qilib qayta teradi (o'chirish/ko'chirishdan keyin)."""
    c.execute("SELECT id FROM delivery_routes WHERE delivery_agent_id=%s AND kun=%s ORDER BY tartib,id",(dlv_id,kun))
    for i,(rid,) in enumerate(c.fetchall(),1):
        c.execute("UPDATE delivery_routes SET tartib=%s WHERE id=%s",(i,rid))

def _start_route_day_picker(uid, dlv_id, dlv_name):
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=2)
    for i,n in DAYS:
        cnt=_route_count(dlv_id,i)
        kb.add(f"📅 {n} ({cnt}/25)")
    # Juma endi dam kuni — lekin eski marshrutlar qolgan bo'lsa, tahrirlash uchun ko'rsatamiz
    jcnt=_route_count(dlv_id,5)
    if jcnt>0: kb.add(f"📅 Juma ({jcnt}/25) — dam kuni!")
    kb.add("⬅️ Delivery menyu")
    today=datetime.now().isoweekday()  # 1=Mon..7=Sun
    today_name=day_name(today)
    set_state(uid,"rt_pick_day",{"dlv_id":dlv_id,"dlv_name":dlv_name})
    bot.send_message(uid,
        f"🚚 {dlv_name} — Haftalik marshrut\n\n"
        f"📅 Qaysi kun uchun dokon qo'shamiz?\n"
        f"💡 Bugun: {today_name}",
        reply_markup=kb)

@bot.message_handler(func=lambda m:m.text=="🗺 Haftalik marshrut")
def dlv_route_start(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    conn=get_db();c=conn.cursor()
    c.execute("SELECT id,name,hudud FROM delivery_agents WHERE faol=1 ORDER BY name")
    rows=c.fetchall(); conn.close()
    if not rows:
        bot.send_message(uid,"❗ Avval delivery agent qo'shing.",reply_markup=dlv_menu_kb()); return
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    for r in rows: kb.add(f"🚚{r[0]}||{r[1]} ({r[2] or '—'})")
    kb.add("⬅️ Delivery menyu")
    set_state(uid,"rt_pick_agent",{})
    bot.send_message(uid,"🗺 Qaysi delivery agentga marshrut?",reply_markup=kb)

@bot.message_handler(func=lambda m:m.text=="⬅️ Delivery menyu")
def dlv_back_submenu(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    set_state(uid,None,{})
    bot.send_message(uid,"🚚 DELIVERY AGENT BOSHQARUV",reply_markup=dlv_menu_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="rt_pick_agent")
def rt_pick_agent(msg):
    uid=msg.from_user.id
    txt=(msg.text or "").strip()
    if not txt.startswith("🚚"): return
    try: dlv_id=int(txt[1:].split("||")[0])
    except: return
    conn=get_db();c=conn.cursor()
    c.execute("SELECT name FROM delivery_agents WHERE id=%s",(dlv_id,))
    r=c.fetchone(); conn.close()
    if not r: return
    _start_route_day_picker(uid, dlv_id, r[0])

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="rt_pick_day")
def rt_pick_day(msg):
    uid=msg.from_user.id
    txt=(msg.text or "").strip()
    if not txt.startswith("📅 "): return
    # Strip "📅 " prefix and " (N/25)" suffix
    name=txt[2:].strip()
    if " (" in name: name=name.rsplit(" (",1)[0]
    kun=DAYS_BY_NAME.get(name)
    if kun is None and name=="Juma": kun=5
    if not kun: return
    data=get_state(uid)["data"]
    data["kun"]=kun
    if kun==5:
        # Juma — dam kuni: faqat tahrirlash (o'chirish/ko'chirish), yangi qo'shish yo'q
        set_state(uid,"rt_edit",data)
        _show_route_edit(uid, data["dlv_id"], data["dlv_name"], 5); return
    set_state(uid,"rt_pick_viloyat",data)
    _show_route_viloyat_picker(uid, data["dlv_id"], data["dlv_name"], kun)

def _show_route_viloyat_picker(uid, dlv_id, dlv_name, kun):
    cnt=_route_count(dlv_id,kun)
    conn=get_db();c=conn.cursor()
    c.execute("""SELECT COALESCE(NULLIF(viloyat,''),'— Noma''lum') as v, COUNT(*) as n
                 FROM dokonlar WHERE holat='faol' GROUP BY v ORDER BY n DESC""")
    vils=c.fetchall(); conn.close()
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=2)
    row=[]
    for v,n in vils:
        row.append(f"📍 {v}")
        if len(row)==2: kb.add(*row); row=[]
    if row: kb.add(*row)
    if cnt>0:
        kb.add("✏️ Marshrutni tahrirlash")
        kb.add("✅ Marshrutni yakunlash")
    kb.add("⬅️ Kunni o'zgartirish")
    bot.send_message(uid,
        f"🚚 {dlv_name} — 📅 {day_name(kun)}\n"
        f"📦 Qo'shilgan: {cnt}/25 dokon\n\n"
        f"📍 Viloyatni tanlang (dokon qo'shish uchun):",
        reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="rt_pick_viloyat")
def rt_pick_viloyat(msg):
    uid=msg.from_user.id
    txt=(msg.text or "").strip()
    data=get_state(uid)["data"]
    if txt=="⬅️ Kunni o'zgartirish":
        _start_route_day_picker(uid, data["dlv_id"], data["dlv_name"]); return
    if txt=="✅ Marshrutni yakunlash":
        _show_route_summary(uid, data["dlv_id"], data["dlv_name"], data["kun"]); return
    if txt=="✏️ Marshrutni tahrirlash":
        set_state(uid,"rt_edit",data)
        _show_route_edit(uid, data["dlv_id"], data["dlv_name"], data["kun"]); return
    if not txt.startswith("📍 "): return
    vil=txt[2:].strip()
    data["viloyat"]=vil
    set_state(uid,"rt_pick_hudud",data)
    conn=get_db();c=conn.cursor()
    c.execute("""SELECT COALESCE(NULLIF(hudud,''),'— Noma''lum') as h, COUNT(*) as n
                 FROM dokonlar
                 WHERE holat='faol' AND (viloyat=%s OR (viloyat IS NULL AND %s='— Noma''lum')
                                          OR (viloyat='' AND %s='— Noma''lum'))
                 GROUP BY h ORDER BY n DESC""",(vil,vil,vil))
    huds=c.fetchall(); conn.close()
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=2)
    row=[]
    for h,n in huds:
        row.append(f"🏘 {h} ({n})")
        if len(row)==2: kb.add(*row); row=[]
    if row: kb.add(*row)
    kb.add("⬅️ Viloyatni o'zgartirish")
    bot.send_message(uid,f"📍 {vil}\n\n🏘 Hududni tanlang:",reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="rt_pick_hudud")
def rt_pick_hudud(msg):
    uid=msg.from_user.id
    txt=(msg.text or "").strip()
    data=get_state(uid)["data"]
    if txt=="⬅️ Viloyatni o'zgartirish":
        set_state(uid,"rt_pick_viloyat",data)
        _show_route_viloyat_picker(uid, data["dlv_id"], data["dlv_name"], data["kun"]); return
    if not txt.startswith("🏘 "): return
    hud=txt[2:].strip()
    if " (" in hud: hud=hud.rsplit(" (",1)[0]
    data["hudud"]=hud
    set_state(uid,"rt_pick_dokon",data)
    _show_route_dokon_picker(uid)

def _show_route_dokon_picker(uid):
    data=get_state(uid)["data"]
    dlv_id=data["dlv_id"]; kun=data["kun"]
    vil=data["viloyat"]; hud=data["hudud"]
    already=_route_dokon_ids(dlv_id,kun)
    conn=get_db();c=conn.cursor()
    c.execute("""SELECT id,nomi,egasi,telefon,latitude,longitude FROM dokonlar
                 WHERE holat='faol'
                   AND (viloyat=%s OR (viloyat IS NULL AND %s='— Noma''lum') OR (viloyat='' AND %s='— Noma''lum'))
                   AND (hudud=%s OR (hudud IS NULL AND %s='— Noma''lum') OR (hudud='' AND %s='— Noma''lum'))
                 ORDER BY nomi""",(vil,vil,vil,hud,hud,hud))
    rows=c.fetchall(); conn.close()
    available=[r for r in rows if r[0] not in already]
    cnt=_route_count(dlv_id,kun)
    if not available:
        bot.send_message(uid,
            f"❗ Bu hududda yangi qo'shiladigan dokon qolmadi (hammasi marshrutda).\n\n"
            f"📦 Qo'shilgan: {cnt}/25")
        set_state(uid,"rt_pick_viloyat",data)
        _show_route_viloyat_picker(uid, dlv_id, data["dlv_name"], kun); return
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    for r in available[:30]:
        kb.add(f"🏪 {r[0]}||{r[1]}")
    kb.add("⬅️ Hududni o'zgartirish")
    if cnt>0: kb.add("✅ Marshrutni yakunlash")
    bot.send_message(uid,
        f"📍 {vil} → 🏘 {hud}\n📦 Qo'shilgan: {cnt}/25\n\n"
        f"🏪 Dokonni tanlang (qo'shish uchun):",reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="rt_pick_dokon")
def rt_pick_dokon(msg):
    uid=msg.from_user.id
    txt=(msg.text or "").strip()
    data=get_state(uid)["data"]
    if txt=="⬅️ Hududni o'zgartirish":
        set_state(uid,"rt_pick_viloyat",data)
        _show_route_viloyat_picker(uid, data["dlv_id"], data["dlv_name"], data["kun"]); return
    if txt=="✅ Marshrutni yakunlash":
        _show_route_summary(uid, data["dlv_id"], data["dlv_name"], data["kun"]); return
    if not (txt.startswith("🏪 ") and "||" in txt): return
    try: did=int(txt.replace("🏪 ","").split("||")[0])
    except: return
    dlv_id=data["dlv_id"]; kun=data["kun"]
    # Check limit
    if _route_count(dlv_id,kun)>=25:
        bot.send_message(uid,"❗ 25 ta dokon to'ldi. ✅ Marshrutni yakunlash ni bosing."); return
    conn=get_db();c=conn.cursor()
    c.execute("SELECT id,nomi,egasi,telefon,hudud,latitude,longitude FROM dokonlar WHERE id=%s",(did,))
    d=c.fetchone()
    if not d: conn.close(); return
    # Insert into route
    tartib=_route_count(dlv_id,kun)+1
    try:
        c.execute("""INSERT INTO delivery_routes
                     (delivery_agent_id,kun,dokon_id,tartib,created_at)
                     VALUES (%s,%s,%s,%s,%s)""",
                  (dlv_id,kun,did,tartib,datetime.now().isoformat()))
        conn.commit()
    except: pass
    conn.close()
    _,nomi,egasi,tel,hud,lat,lon=d
    info=(f"✅ {tartib}/25 — {nomi}\n"
          f"   👤 {egasi or '—'}\n"
          f"   📞 {tel or '—'}\n"
          f"   📍 {hud or '—'}")
    if lat and lon: info+=f"\n   🗺 https://maps.google.com/?q={lat},{lon}"
    bot.send_message(uid,info)
    _show_route_dokon_picker(uid)

def _show_route_summary(uid, dlv_id, dlv_name, kun):
    conn=get_db();c=conn.cursor()
    c.execute("""SELECT r.tartib,d.nomi,d.egasi,d.telefon,d.hudud,d.latitude,d.longitude
                 FROM delivery_routes r
                 JOIN dokonlar d ON d.id=r.dokon_id
                 WHERE r.delivery_agent_id=%s AND r.kun=%s
                 ORDER BY r.tartib""",(dlv_id,kun))
    rows=c.fetchall(); conn.close()
    text=f"📋 MARSHRUT YAKUNLANDI\n🚚 {dlv_name} — 📅 {day_name(kun)}\n📦 {len(rows)} ta dokon\n{'━'*26}\n"
    for r in rows:
        t,n,e,p,h,lat,lon=r
        text+=f"\n{t}. 🏪 {n}\n   👤 {e or '—'} | 📞 {p or '—'} | 📍 {h or '—'}"
        if lat and lon: text+=f"\n   🗺 https://maps.google.com/?q={lat},{lon}"
    _send_long(uid,text)
    set_state(uid,None,{})
    bot.send_message(uid,"✅ Saqlandi. Yana marshrut qo'shamizmi?",reply_markup=dlv_menu_kb())

def _show_route_edit(uid, dlv_id, dlv_name, kun):
    conn=get_db();c=conn.cursor()
    c.execute("""SELECT d.id,r.tartib,d.nomi FROM delivery_routes r
                 JOIN dokonlar d ON d.id=r.dokon_id
                 WHERE r.delivery_agent_id=%s AND r.kun=%s ORDER BY r.tartib""",(dlv_id,kun))
    rows=c.fetchall(); conn.close()
    if not rows:
        bot.send_message(uid,f"📭 {day_name(kun)} marshruti bo'sh.")
        data=get_state(uid)["data"]
        if kun==5:
            _start_route_day_picker(uid, dlv_id, dlv_name); return
        set_state(uid,"rt_pick_viloyat",data)
        _show_route_viloyat_picker(uid, dlv_id, dlv_name, kun); return
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    for did,t,n in rows:
        kb.add(f"🏪 {did}||{t}. {n}")
    kb.add("⬅️ Kunni o'zgartirish")
    hint="\n⚠️ Juma endi dam kuni — do'konlarni boshqa kunga ko'chiring yoki o'chiring.\n" if kun==5 else ""
    bot.send_message(uid,
        f"✏️ {dlv_name} — 📅 {day_name(kun)}\n"
        f"📦 {len(rows)} ta dokon\n{hint}\n"
        f"Tahrirlash uchun dokonni tanlang:",reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="rt_edit")
def rt_edit_pick(msg):
    uid=msg.from_user.id
    txt=(msg.text or "").strip()
    data=get_state(uid)["data"]
    if txt=="⬅️ Kunni o'zgartirish":
        _start_route_day_picker(uid, data["dlv_id"], data["dlv_name"]); return
    if not (txt.startswith("🏪 ") and "||" in txt): return
    try: did=int(txt.replace("🏪 ","").split("||")[0])
    except: return
    nomi=txt.split("||",1)[1].strip()
    data["edit_did"]=did; data["edit_nomi"]=nomi
    set_state(uid,"rt_edit_action",data)
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    kb.add("📅 Boshqa kunga ko'chirish")
    kb.add("🗑 Marshrutdan o'chirish")
    kb.add("⬅️ Orqaga")
    bot.send_message(uid,f"🏪 {nomi}\n📅 {day_name(data['kun'])}\n\nNima qilamiz?",reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="rt_edit_action")
def rt_edit_action(msg):
    uid=msg.from_user.id
    txt=(msg.text or "").strip()
    data=get_state(uid)["data"]
    dlv_id=data["dlv_id"]; kun=data["kun"]; did=data.get("edit_did")
    if txt=="⬅️ Orqaga":
        set_state(uid,"rt_edit",data)
        _show_route_edit(uid, dlv_id, data["dlv_name"], kun); return
    if txt=="🗑 Marshrutdan o'chirish":
        conn=get_db();c=conn.cursor()
        c.execute("DELETE FROM delivery_routes WHERE delivery_agent_id=%s AND kun=%s AND dokon_id=%s",(dlv_id,kun,did))
        _route_resequence(c,dlv_id,kun)
        conn.commit(); conn.close()
        bot.send_message(uid,f"🗑 O'chirildi: {data.get('edit_nomi','')}")
        set_state(uid,"rt_edit",data)
        _show_route_edit(uid, dlv_id, data["dlv_name"], kun); return
    if txt=="📅 Boshqa kunga ko'chirish":
        kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=2)
        for i,n in DAYS:
            if i==kun: continue
            kb.add(f"📅 {n} ({_route_count(dlv_id,i)}/25)")
        kb.add("⬅️ Orqaga")
        set_state(uid,"rt_edit_move",data)
        bot.send_message(uid,f"🏪 {data.get('edit_nomi','')}\n\n📅 Qaysi kunga ko'chiramiz?",reply_markup=kb); return

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="rt_edit_move")
def rt_edit_move(msg):
    uid=msg.from_user.id
    txt=(msg.text or "").strip()
    data=get_state(uid)["data"]
    dlv_id=data["dlv_id"]; kun=data["kun"]; did=data.get("edit_did")
    if txt=="⬅️ Orqaga":
        set_state(uid,"rt_edit",data)
        _show_route_edit(uid, dlv_id, data["dlv_name"], kun); return
    if not txt.startswith("📅 "): return
    name=txt[2:].strip()
    if " (" in name: name=name.rsplit(" (",1)[0]
    target=DAYS_BY_NAME.get(name)
    if not target or target==kun or target==5: return
    if _route_count(dlv_id,target)>=25:
        bot.send_message(uid,f"❗ {day_name(target)} to'lgan (25/25). Boshqa kunni tanlang."); return
    if did in _route_dokon_ids(dlv_id,target):
        conn=get_db();c=conn.cursor()
        c.execute("DELETE FROM delivery_routes WHERE delivery_agent_id=%s AND kun=%s AND dokon_id=%s",(dlv_id,kun,did))
        _route_resequence(c,dlv_id,kun)
        conn.commit(); conn.close()
        bot.send_message(uid,f"ℹ️ {day_name(target)}da bu dokon allaqachon bor — {day_name(kun)}dan o'chirildi.")
    else:
        conn=get_db();c=conn.cursor()
        c.execute("""UPDATE delivery_routes
                     SET kun=%s,
                         tartib=(SELECT COALESCE(MAX(tartib),0)+1 FROM delivery_routes
                                 WHERE delivery_agent_id=%s AND kun=%s)
                     WHERE delivery_agent_id=%s AND kun=%s AND dokon_id=%s""",
                  (target,dlv_id,target,dlv_id,kun,did))
        _route_resequence(c,dlv_id,kun)
        conn.commit(); conn.close()
        bot.send_message(uid,f"✅ {data.get('edit_nomi','')} → {day_name(target)}ga ko'chirildi.")
    set_state(uid,"rt_edit",data)
    _show_route_edit(uid, dlv_id, data["dlv_name"], kun)

def _clear_delivery_role(c, agent_id):
    """Agent o'chirilganda users jadvalidagi 'delivery' rolini ham olib tashlaydi."""
    c.execute("SELECT telegram_id FROM delivery_agents WHERE id=%s",(agent_id,))
    r=c.fetchone()
    if r and r[0]:
        c.execute("DELETE FROM users WHERE telegram_id=%s AND role='delivery'",(r[0],))

@bot.message_handler(func=lambda m:m.text=="🗑 Delivery agent o'chirish")
def dlv_del_start(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    conn=get_db();c=conn.cursor()
    c.execute("SELECT id,name,hudud FROM delivery_agents WHERE faol=1 ORDER BY name")
    rows=c.fetchall(); conn.close()
    if not rows:
        bot.send_message(uid,"❗ O'chiriladigan delivery agent yo'q.",reply_markup=dlv_menu_kb()); return
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    for r in rows: kb.add(f"🗑{r[0]}||{r[1]} ({r[2] or '—'})")
    kb.add("❌ Bekor qilish")
    set_state(uid,"dlv_del_pick",{})
    bot.send_message(uid,"🗑 Qaysi delivery agentni o'chiramiz?",reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="dlv_del_pick")
def dlv_del_pick(msg):
    uid=msg.from_user.id
    txt=(msg.text or "").strip()
    if txt=="❌ Bekor qilish":
        set_state(uid,None,{})
        bot.send_message(uid,"Bekor qilindi",reply_markup=dlv_menu_kb()); return
    if not txt.startswith("🗑"): return
    try: did=int(txt[1:].split("||")[0])
    except: return
    conn=get_db();c=conn.cursor()
    c.execute("SELECT name FROM delivery_agents WHERE id=%s",(did,))
    row=c.fetchone()
    if not row: conn.close(); bot.send_message(uid,"❗ Topilmadi."); return
    name=row[0]
    # Check if any other delivery agents exist for reassignment
    c.execute("SELECT id,name FROM delivery_agents WHERE faol=1 AND id!=%s",(did,))
    others=c.fetchall(); conn.close()
    if not others:
        # No replacement available — soft delete directly
        conn=get_db();c=conn.cursor()
        c.execute("UPDATE delivery_agents SET faol=0 WHERE id=%s",(did,))
        _clear_delivery_role(c,did)
        conn.commit(); conn.close()
        set_state(uid,None,{})
        bot.send_message(uid,f"✅ '{name}' o'chirildi.\n\n💡 Boshqa delivery agent yo'q (almashtirish kerak emas).",reply_markup=dlv_menu_kb()); return
    # Ask for replacement
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    for o in others: kb.add(f"🔄{o[0]}||{o[1]}")
    kb.add("❌ Bekor qilish")
    set_state(uid,"dlv_del_reassign",{"del_id":did,"del_name":name})
    bot.send_message(uid,
        f"🔄 '{name}' ni o'chirishdan oldin, uning marshruti boshqa agentga o'tkazilishi kerak.\n\n"
        f"Yangi agentni tanlang:",reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="dlv_del_reassign")
def dlv_del_reassign(msg):
    uid=msg.from_user.id
    txt=(msg.text or "").strip()
    if txt=="❌ Bekor qilish":
        set_state(uid,None,{})
        bot.send_message(uid,"Bekor qilindi",reply_markup=dlv_menu_kb()); return
    if not txt.startswith("🔄"): return
    try: new_id=int(txt[1:].split("||")[0])
    except: return
    data=get_state(uid)["data"]; del_id=data["del_id"]; del_name=data["del_name"]
    conn=get_db();c=conn.cursor()
    c.execute("SELECT name FROM delivery_agents WHERE id=%s",(new_id,))
    nr=c.fetchone()
    if not nr: conn.close(); bot.send_message(uid,"❗ Topilmadi."); return
    new_name=nr[0]
    # NOTE: Route reassignment will be wired in next stage when delivery_routes table exists
    c.execute("UPDATE delivery_agents SET faol=0 WHERE id=%s",(del_id,))
    _clear_delivery_role(c,del_id)
    conn.commit(); conn.close()
    set_state(uid,None,{})
    bot.send_message(uid,
        f"✅ '{del_name}' o'chirildi.\n🔄 Marshrut '{new_name}' ga o'tkazildi.",
        reply_markup=dlv_menu_kb())

# ───────────── PLAN VS FAKT ─────────────
def get_agent_plan(agent_id, oy=None):
    """Returns (savdo_plan, dokon_plan) for given month (YYYY-MM)."""
    if oy is None: oy=datetime.now().strftime("%Y-%m")
    conn=get_db();c=conn.cursor()
    c.execute("SELECT savdo_plan,dokon_plan FROM agent_plans WHERE agent_id=%s AND oy=%s",(agent_id,oy))
    r=c.fetchone(); conn.close()
    return (r[0] or 0, r[1] or 0) if r else (0,0)

def get_agent_fakt(agent_id, oy=None):
    """Returns (savdo_fakt, dokon_fakt) - actual monthly sales & new dokons."""
    if oy is None: oy=datetime.now().strftime("%Y-%m")
    conn=get_db();c=conn.cursor()
    c.execute("SELECT COALESCE(SUM(jami_summa),0) FROM savdolar WHERE agent_id=%s AND substr(created_at,1,7)=%s",(agent_id,oy))
    savdo=c.fetchone()[0]
    c.execute("SELECT COUNT(*) FROM dokonlar WHERE agent_id=%s AND substr(created_at,1,7)=%s",(agent_id,oy))
    dokon=c.fetchone()[0]
    conn.close()
    return savdo, dokon

def _progress_bar(pct, width=10):
    full=int(min(100,max(0,pct))/100*width)
    return "█"*full+"░"*(width-full)

def _plan_status_emoji(pct):
    if pct>=100: return "🏆"
    if pct>=80: return "🟢"
    if pct>=50: return "🟡"
    if pct>=25: return "🟠"
    return "🔴"

def _plan_block(name, savdo_p, dokon_p, savdo_f, dokon_f, with_name=True):
    s=f"👤 {name}\n" if with_name else ""
    if savdo_p>0:
        pct=savdo_f/savdo_p*100
        s+=(f"  💰 Savdo: {fmt(savdo_f)} / {fmt(savdo_p)}\n"
            f"  {_plan_status_emoji(pct)} [{_progress_bar(pct)}] {pct:.0f}%\n")
    else:
        s+=f"  💰 Savdo: {fmt(savdo_f)} (reja qo'yilmagan)\n"
    if dokon_p>0:
        pct=dokon_f/dokon_p*100
        s+=(f"  🏪 Yangi dokon: {dokon_f} / {dokon_p}\n"
            f"  {_plan_status_emoji(pct)} [{_progress_bar(pct)}] {pct:.0f}%\n")
    else:
        s+=f"  🏪 Yangi dokon: {dokon_f} (reja qo'yilmagan)\n"
    return s

@bot.message_handler(func=lambda m:m.text=="🎯 Mening rejam")
def mening_rejam(msg):
    uid=msg.from_user.id; user=get_user(uid)
    if not user: return
    oy=datetime.now().strftime("%Y-%m")
    sp,dp=get_agent_plan(uid,oy)
    sf,df=get_agent_fakt(uid,oy)
    text=f"🎯 MENING REJAM\n📅 {oy}\n{'━'*26}\n\n"+_plan_block(user[2],sp,dp,sf,df,with_name=False)
    if sp==0 and dp==0:
        text+=f"\n💡 Admin sizga hali oylik reja qo'ymagan.\nReja qo'yilgach, bu yerda ko'rasiz."
    else:
        # Days left in month
        from calendar import monthrange
        now=datetime.now()
        days_total=monthrange(now.year,now.month)[1]
        days_left=days_total-now.day+1
        text+=f"\n📅 Oy oxirigacha: {days_left} kun qoldi"
        if sp>0 and sf<sp:
            need=sp-sf; per_day=need/max(1,days_left)
            text+=f"\n💪 Kuniga kerak: {fmt(int(per_day))}"
    bot.send_message(uid,text)

# ── AI tavsiyalar (agent/supervisor) ───────────────────────────────────────────
# Node API'dagi GET /distribution/suggestions?ai=1&agentId=... qayta ishlatiladi —
# server LLM natijasini 10 daqiqa keshlaydi, shuning uchun bot yangi LLM chaqiruvi
# yaratmaydi. AI xato bo'lsa (ai=null) — javobdagi rule-based ro'yxatlar (overdue,
# qaytish) ko'rsatiladi. API umuman ishlamasa — to'g'ridan-to'g'ri DB'dan oddiy
# kechikkanlar ro'yxati (lost dokons hisoboti) yuboriladi.
def _fetch_ai_suggestions(agent_id):
    import json as _json
    import urllib.request
    url = API_BASE_URL.rstrip("/") + f"/distribution/suggestions?ai=1&agentId={agent_id}"
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        **({"x-internal-key": AI_INTERNAL_KEY} if AI_INTERNAL_KEY else {}),
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        return _json.loads(resp.read().decode("utf-8"))

@bot.message_handler(func=lambda m:m.text=="🤖 AI tavsiyalar")
def ai_tavsiyalar(msg):
    uid=msg.from_user.id; user=get_user(uid)
    if not user or user[3] not in ("agent","supervisor"): return
    bot.send_message(uid,"🤖 AI tavsiyalar tayyorlanmoqda... (10-20 soniya)")
    try:
        body=_fetch_ai_suggestions(uid)
    except Exception as e:
        log.warning("AI suggestions API failed for %s: %s", uid, e)
        # API ishlamasa — jimgina oddiy DB-asosli ro'yxat (yo'qolayotgan dokonlar)
        text,_=_build_lost_dokons_report(scope_agent_id=uid)
        bot.send_message(uid,"ℹ️ AI hozircha mavjud emas — oddiy ro'yxat:\n\n"+text)
        return
    ai=body.get("ai")
    if ai:
        lines=[f"🤖 AI TAVSIYALAR — bugun birinchi kirish kerak\n{'━'*26}"]
        for i,it in enumerate(ai[:10],1):
            nomi=it.get("nomi") or "—"
            hudud=it.get("hudud") or ""
            score=it.get("score",0)
            reason=(it.get("reason") or "").strip()
            loc=f" ({hudud})" if hudud else ""
            lines.append(f"\n{i}. 🏪 {nomi}{loc} — {score}/100\n   💬 {reason}")
        bot.send_message(uid,"\n".join(lines))
        return
    # AI xato/fallback (ai=null) — rule-based ro'yxatlar (o'sha javobdan)
    overdue=body.get("overdue") or []
    qaytish=body.get("qaytish") or []
    text=f"📋 BUGUNGI TAVSIYALAR (oddiy)\n{'━'*26}\n"
    if overdue:
        text+="\n⏰ Kechikkan do'konlar:\n"
        for o in overdue[:10]:
            days=o.get("days"); avg=o.get("avgRepeatDays") or 0
            cad=f", odatda {avg} kunda oladi" if avg else ""
            text+=f"• {o.get('nomi') or '—'} — {days} kun xarid yo'q{cad}\n"
    if qaytish:
        text+="\n📅 Qaytish sanasi kelganlar:\n"
        for q in qaytish[:10]:
            text+=f"• {q.get('nomi') or '—'} — va'da: {q.get('qaytishSanasi') or '—'}\n"
    if not overdue and not qaytish:
        text+="\n✅ Hozircha shoshilinch do'kon yo'q. Marshrut bo'yicha davom eting!"
    bot.send_message(uid,text)

@bot.message_handler(func=lambda m:m.text=="🎯 Reja boshqaruv")
def reja_boshqaruv(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    oy=datetime.now().strftime("%Y-%m")
    conn=get_db();c=conn.cursor()
    c.execute("SELECT telegram_id,name,viloyat FROM users WHERE role IN ('agent','supervisor') ORDER BY name")
    agents=c.fetchall(); conn.close()
    if not agents:
        bot.send_message(uid,"❗ Agentlar yo'q."); return
    text=f"🎯 REJA vs FAKT — BARCHA AGENTLAR\n📅 {oy}\n{'━'*26}\n\n"
    for tid,name,vil in agents:
        sp,dp=get_agent_plan(tid,oy); sf,df=get_agent_fakt(tid,oy)
        text+=_plan_block(f"{name} ({vil or '—'})",sp,dp,sf,df)+"\n"
    text+=f"{'━'*26}\n💡 Agentga reja qo'yish uchun pastdan tanlang:"
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    for tid,name,vil in agents:
        kb.add(f"🎯 {tid}||{name}")
    kb.add("❌ Bekor qilish")
    set_state(uid,"plan_agent_select",{"oy":oy})
    _send_long(uid,text)
    bot.send_message(uid,"👤 Reja qo'ymoqchi bo'lgan agentni tanlang:",reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="plan_agent_select")
def s_plan_agent_select(msg):
    uid=msg.from_user.id
    if not msg.text.startswith("🎯 "):
        if msg.text=="❌ Bekor qilish":
            clear_state(uid); user=get_user(uid)
            bot.send_message(uid,"Bekor qilindi",reply_markup=main_kb(user[3],uid))
        return
    try:
        rest=msg.text[2:].strip()
        tid_str,name=rest.split("||",1); tid=int(tid_str)
    except:
        bot.send_message(uid,"❗ Xato format"); return
    data=get_state(uid)["data"]; oy=data["oy"]
    sp,dp=get_agent_plan(tid,oy)
    set_state(uid,"plan_savdo_input",{"oy":oy,"tid":tid,"name":name})
    txt=(f"👤 {name}\n📅 {oy}\n\n"
         f"Hozirgi reja: 💰 {fmt(sp)} savdo | 🏪 {dp} dokon\n\n"
         f"💰 Yangi SAVDO rejasini kiriting (so'm):\nMasalan: 500000000\nO'zgartirmaslik uchun: 0")
    bot.send_message(uid,txt,reply_markup=cancel_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="plan_savdo_input")
def s_plan_savdo_input(msg):
    uid=msg.from_user.id
    if msg.text=="❌ Bekor qilish":
        clear_state(uid); user=get_user(uid)
        bot.send_message(uid,"Bekor qilindi",reply_markup=main_kb(user[3],uid)); return
    try:
        savdo=int(msg.text.replace(" ","").replace(",",""))
        if savdo<0: raise ValueError
    except:
        bot.send_message(uid,"❗ Faqat raqam kiriting"); return
    data=get_state(uid)["data"]; data["savdo"]=savdo
    set_state(uid,"plan_dokon_input",data)
    bot.send_message(uid,f"✅ Savdo rejasi: {fmt(savdo)}\n\n🏪 Endi YANGI DOKON rejasini kiriting:\nMasalan: 10\nO'zgartirmaslik uchun: 0",reply_markup=cancel_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="plan_dokon_input")
def s_plan_dokon_input(msg):
    uid=msg.from_user.id
    if msg.text=="❌ Bekor qilish":
        clear_state(uid); user=get_user(uid)
        bot.send_message(uid,"Bekor qilindi",reply_markup=main_kb(user[3],uid)); return
    try:
        dokon=int(msg.text.replace(" ",""))
        if dokon<0: raise ValueError
    except:
        bot.send_message(uid,"❗ Faqat raqam kiriting"); return
    data=get_state(uid)["data"]
    tid=data["tid"]; name=data["name"]; oy=data["oy"]; savdo=data["savdo"]
    # Determine final values (0 = keep existing)
    cur_sp,cur_dp=get_agent_plan(tid,oy)
    final_sp = savdo if savdo>0 else cur_sp
    final_dp = dokon if dokon>0 else cur_dp
    conn=get_db();c=conn.cursor()
    c.execute("""INSERT INTO agent_plans (agent_id,oy,savdo_plan,dokon_plan,created_at)
                 VALUES (%s,%s,%s,%s,%s)
                 ON CONFLICT(agent_id,oy) DO UPDATE SET savdo_plan=%s, dokon_plan=%s""",
              (tid,oy,final_sp,final_dp,datetime.now().isoformat(),final_sp,final_dp))
    conn.commit(); conn.close()
    clear_state(uid); user=get_user(uid)
    bot.send_message(uid,f"✅ {name} uchun {oy} rejasi saqlandi:\n💰 {fmt(final_sp)} savdo\n🏪 {final_dp} dokon",reply_markup=main_kb(user[3],uid))
    # Notify agent
    try: bot.send_message(tid,f"🎯 Admin sizga {oy} oyiga reja qo'ydi:\n💰 Savdo: {fmt(final_sp)}\n🏪 Yangi dokon: {final_dp}\n\nKo'rish: 🎯 Mening rejam")
    except: pass

def get_store_status(last_order_date, avg_repeat_days):
    """Returns (emoji_label, days_since_last)"""
    from datetime import datetime as _dt
    if not last_order_date: return ("⚪ NEW", None)
    try:
        ld=_dt.fromisoformat(last_order_date)
        days=(_dt.now()-ld).days
    except: return ("⚪ NEW", None)
    avg=avg_repeat_days or 0
    if avg<=0: return ("🟢 HOT" if days<=7 else ("🟡 WARM" if days<=21 else "🔴 COLD"), days)
    if days<=avg: return ("🟢 HOT", days)
    if days<=avg*2: return ("🟡 WARM", days)
    return ("🔴 COLD", days)

def fmt_miq(q):
    try:
        f=float(q)
        return str(int(f)) if f==int(f) else f"{f:g}"
    except: return str(q)

_PILOT_KB_CACHE={}
def _pilot_kb_flag(uid):
    """F11: delivery menyusida 🚚 tugmasini ko'rsatish tekshiruvi (60s TTL kesh).
    Kesh faqat menyu render tezligi uchun — wizard kirishi HAR DOIM yangidan
    tekshiradi, ya'ni kesh huquq chegarasi emas."""
    now=time.time(); hit=_PILOT_KB_CACHE.get(uid)
    if hit and now-hit[0]<60: return hit[1]
    try: flag=_is_vehicle_distribution_pilot_user(get_user(uid))
    except Exception: flag=False
    _PILOT_KB_CACHE[uid]=(now,flag)
    return flag

def main_kb(role,uid=None):
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=2)
    if role=="delivery":
        # T009: toza menyu — asosiy ish Mini App'da, bot zaxira/tezkor amallar
        # MUHIM: reply-keyboard'da web_app tugma ISHLATILMAYDI — Telegram Web
        # va ba'zan iOS bu turdan ochilganda initData bermaydi (401 gate).
        # Oddiy tugma bosilganda bot inline BOSHLASH tugmasini yuboradi.
        if FIELD_APP_URL:
            kb.add("🗺 BOSHLASH")
        kb.add("📦 Tovar berish","💰 Pul olish")
        kb.add("❌ Tovar olmadi","📋 Qaytib kirish kerak")
        kb.add("📊 Statistikam","👤 Profil")
        kb.add("🗺 Mening marshrutim")
        if uid is not None and _pilot_kb_flag(uid):
            kb.add("🚚 Mashinani to'ldirish")
        return kb
    if role in("agent","supervisor") and FIELD_APP_URL:
        # Mini App agent/supervisorlar uchun ham (delivery'dan tashqari).
        # Oddiy tugma — sababi yuqoridagi delivery izohida (initData muammosi).
        kb.add("🗺 BOSHLASH")
    if role in("agent","supervisor","admin"):
        kb.add("🏪 Yangi dokon","📦 Tovar berish")
        kb.add("💰 Pul olish","❌ Tovar olmadi")
        kb.add("📋 Qaytib kirish kerak","💳 Nasiya boshqaruv")
        kb.add("🔍 Qidiruv")
    if role in("agent","supervisor"):
        kb.add("🎯 Mening rejam","🤖 AI tavsiyalar")
    if role in("supervisor","admin"): kb.add("👥 Agentlar statistikasi")
    if role=="admin":
        kb.add("📈 Umumiy stat","🛍 Mahsulotlar")
        kb.add("👥 Mijozlar bazasi","👤 Agent boshqaruv")
        kb.add("📄 Dokonlar PDF","📢 Xabar yuborish")
        kb.add("🔁 Repeat hisoboti","⚠️ Yo'qolayotgan dokonlar")
        kb.add("💸 Eski nasiyalar","🎯 Reja boshqaruv")
        kb.add("🏆 Oylik reyting","🚚 Delivery agent")
    return kb

def send_field_btn(uid):
    """Mini App'ni INLINE (xabar ichidagi) tugma orqali ochirish.

    Muhim: iOS Telegram'da reply-keyboard'dagi web_app tugmasi ba'zan
    initData (imzo) BERMAYDI — Mini App 401 oladi ("Telegram orqali oching").
    Inline tugmadan ochilganda esa Telegram initData'ni har doim beradi.
    Shu sabab delivery menyusi ko'rsatilgan joylarda qo'shimcha shu xabar
    yuboriladi."""
    if not FIELD_APP_URL: return
    ikb=types.InlineKeyboardMarkup()
    ikb.add(types.InlineKeyboardButton("🗺 BOSHLASH — bugungi marshrut",web_app=types.WebAppInfo(FIELD_APP_URL)))
    try:
        bot.send_message(uid,"👇 Marshrut xaritasini shu tugma orqali oching:",reply_markup=ikb)
    except Exception as e:
        log.warning("Field inline tugma yuborilmadi (uid=%s): %s", uid, e)
def cancel_kb():
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True)
    kb.add("❌ Bekor qilish"); return kb
def skip_kb():
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True)
    kb.add("⏭ O'tkazib yuborish","❌ Bekor qilish"); return kb
def location_kb():
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True)
    kb.add(types.KeyboardButton("📍 Location yuborish",request_location=True))
    kb.add("❌ Bekor qilish"); return kb
def tolov_kb():
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=2)
    kb.add("💵 Naqd","💳 Karta")
    kb.add("📝 Nasiya","🔀 Aralash")
    kb.add("❌ Bekor qilish"); return kb
def sabab_kb():
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=2)
    kb.add("💸 Narx qimmat","📦 Hozir tovari bor")
    kb.add("🏢 Boshqa firma","😕 Sifat yoqmadi")
    kb.add("🚪 Egasi yo'q edi","🕐 Keyin keling dedi")
    kb.add("🚫 Sotilmaydi dedi","📝 Boshqa sabab")
    kb.add("❌ Bekor qilish"); return kb
def viloyat_kb():
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=3)
    kb.add("Namangan","Farg'ona","Andijon"); kb.add("❌ Bekor qilish"); return kb
def gps_confirm_kb():
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True)
    kb.add("✅ Ha, joylashuv to'g'ri")
    kb.add(types.KeyboardButton("📍 Qayta yuborish",request_location=True))
    kb.add("❌ Bekor qilish"); return kb

# ── GPS outlier tekshiruvi: yangi dokon koordinatasi viloyat medianidan
#    GPS_OUTLIER_KM dan uzoq bo'lsa — ehtimol xato (marshrut rejasidan tushib qoladi).
GPS_OUTLIER_KM=60
def _haversine_km(lat1,lon1,lat2,lon2):
    import math
    dlat=math.radians(lat2-lat1); dlon=math.radians(lon2-lon1)
    a=math.sin(dlat/2)**2+math.cos(math.radians(lat1))*math.cos(math.radians(lat2))*math.sin(dlon/2)**2
    return 2*6371*math.asin(math.sqrt(a))
def _gps_outlier_km(viloyat,lat,lon):
    """Koordinata viloyat dokonlari medianidan >GPS_OUTLIER_KM uzoq bo'lsa masofani (km) qaytaradi, aks holda None."""
    if lat is None or lon is None or not viloyat: return None
    try:
        conn=get_db();c=conn.cursor()
        c.execute("""SELECT latitude,longitude FROM dokonlar
                     WHERE viloyat=%s AND latitude IS NOT NULL AND longitude IS NOT NULL
                       AND COALESCE(holat,'faol')='faol'""",(viloyat,))
        pts=c.fetchall();conn.close()
        if len(pts)<3: return None  # median ishonchsiz — tekshirmaymiz (routePlanner splitOutliers bilan bir xil)
        lats=sorted(float(p[0]) for p in pts); lons=sorted(float(p[1]) for p in pts)
        mlat=lats[len(lats)//2]; mlon=lons[len(lons)//2]
        dist=_haversine_km(mlat,mlon,float(lat),float(lon))
        return dist if dist>GPS_OUTLIER_KM else None
    except Exception as e:
        logging.warning(f"GPS outlier tekshiruvi xatosi: {e}")
        return None

# ── GLOBAL CANCEL — must be the FIRST handler registered ─────
@bot.message_handler(func=lambda m:m.text=="❌ Bekor qilish")
def cancel_h(msg):
    uid=msg.from_user.id; clear_state(uid); user=get_user(uid)
    if user:
        bot.send_message(uid,"❌ Bekor qilindi.",reply_markup=main_kb(user[3],uid))
    else:
        bot.send_message(uid,"❌ Bekor qilindi.",reply_markup=types.ReplyKeyboardRemove())

BOT_VERSION="2026-08-23.1 (vehicle pilot return-ready)"
DEPLOY_REVISION=(
    os.environ.get("RAILWAY_GIT_COMMIT_SHA")
    or os.environ.get("SOURCE_VERSION")
    or os.environ.get("GIT_COMMIT_SHA")
    or "unknown"
)
BOT_VERSION_REPORT=f"{BOT_VERSION} | revision={DEPLOY_REVISION}"
@bot.message_handler(commands=["version"])
def cmd_version(msg):
    bot.send_message(msg.from_user.id,f"🤖 Versiya: {BOT_VERSION_REPORT}")

@bot.message_handler(commands=["start"])
def cmd_start(msg):
    uid=msg.from_user.id; user=get_user(uid)
    # Auto-detect already-linked delivery agent.
    # MUHIM: agent/supervisor/admin rolini delivery'ga TUSHIRMAYMIZ —
    # ular o'z rolini saqlab, Mini App'dan ham foydalanadi (delivery_agents
    # qatori ulangani kifoya). Faqat ro'yxatsiz yoki pending userlar
    # delivery'ga aylantiriladi.
    dlv=_get_delivery_agent_by_tid(uid)
    if dlv and (not user or user[3]=="pending"):
        _ensure_delivery_user(uid, dlv[1])
        user=get_user(uid)
    # Agent o'chirilgan (faol=0) bo'lsa — delivery rolini ham bekor qilamiz
    if user and user[3]=="delivery" and not dlv:
        conn=get_db();c=conn.cursor()
        c.execute("DELETE FROM users WHERE telegram_id=%s AND role='delivery'",(uid,))
        conn.commit(); conn.close()
        user=None
        bot.send_message(uid,"ℹ️ Delivery agent profilingiz admin tomonidan o'chirilgan.")
    if not user:
        # Offer role choice
        kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
        kb.add("👤 Men sotuvchi / agent")
        kb.add("🚚 Men delivery agent")
        bot.send_message(uid,"👋 TOP MART botiga xush kelibsiz!\n\nKim sifatida kirasiz?",reply_markup=kb)
        return
    bot.send_message(uid,f"✅ Xush kelibsiz, {user[2]}!\n🔰 Rol: {user[3].upper()}",reply_markup=main_kb(user[3],uid))
    if user[3] in("delivery","agent","supervisor"): send_field_btn(uid)

@bot.message_handler(func=lambda m:m.text=="👤 Men sotuvchi / agent" and not get_user(m.from_user.id))
def role_pick_agent(msg):
    uid=msg.from_user.id
    set_state(uid,"reg_name")
    bot.send_message(uid,"👤 Ismingizni kiriting:",reply_markup=types.ReplyKeyboardRemove())

@bot.message_handler(func=lambda m:m.text=="🚚 Men delivery agent" and not get_user(m.from_user.id))
def role_pick_delivery(msg):
    uid=msg.from_user.id
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True)
    kb.add(types.KeyboardButton("📱 Telefon raqamni yuborish",request_contact=True))
    kb.add("❌ Bekor qilish")
    set_state(uid,"dlv_link_phone",{})
    bot.send_message(uid,
        "🚚 Delivery agent kirishi\n\n"
        "Admin sizni bazaga qo'shgan bo'lishi kerak.\n\n"
        "📱 Tasdiqlash uchun telefon raqamingizni yuboring:",
        reply_markup=kb)

def _normalize_phone(s):
    if not s: return ""
    return "".join(ch for ch in s if ch.isdigit())[-9:]  # last 9 digits

def _ensure_delivery_user(tid, name):
    conn=get_db();c=conn.cursor()
    c.execute("SELECT role FROM users WHERE telegram_id=%s",(tid,))
    r=c.fetchone()
    if r:
        if r[0]!="delivery":
            c.execute("UPDATE users SET role='delivery',name=%s WHERE telegram_id=%s",(name,tid))
    else:
        c.execute("INSERT INTO users (telegram_id,name,role,viloyat,created_at) VALUES (%s,%s,%s,%s,%s)",
                  (tid,name,"delivery","",datetime.now().isoformat()))
    conn.commit(); conn.close()

@bot.message_handler(content_types=["contact"],
    func=lambda m:get_state(m.from_user.id)["state"]=="dlv_link_phone")
def dlv_link_phone(msg):
    uid=msg.from_user.id
    if not msg.contact or msg.contact.user_id!=uid:
        bot.send_message(uid,"❗ Iltimos o'zingizning telefoningizni yuboring (tugma orqali)."); return
    phone_norm=_normalize_phone(msg.contact.phone_number)
    if not phone_norm:
        bot.send_message(uid,"❗ Telefon o'qib bo'lmadi."); return
    conn=get_db();c=conn.cursor()
    c.execute("SELECT id,name,telefon,telegram_id FROM delivery_agents WHERE faol=1")
    rows=c.fetchall(); conn.close()
    match=None
    for r in rows:
        if _normalize_phone(r[2])==phone_norm:
            match=r; break
    if not match:
        clear_state(uid)
        bot.send_message(uid,
            "❗ Sizning raqamingiz bazada topilmadi.\n\n"
            "📞 Admin bilan bog'laning va ro'yxatga kiritilishingizni so'rang.",
            reply_markup=types.ReplyKeyboardRemove())
        return
    did,name,tel,existing_tid=match
    if existing_tid and existing_tid!=uid:
        clear_state(uid)
        bot.send_message(uid,
            f"❗ '{name}' allaqachon boshqa telegram hisobiga bog'langan.\n"
            f"Admin bilan bog'laning.",
            reply_markup=types.ReplyKeyboardRemove())
        return
    # Link
    conn=get_db();c=conn.cursor()
    c.execute("UPDATE delivery_agents SET telegram_id=%s WHERE id=%s",(uid,did))
    conn.commit(); conn.close()
    _ensure_delivery_user(uid, name)
    clear_state(uid)
    bot.send_message(uid,
        f"✅ Tabriklaymiz, {name}!\n"
        f"🚚 Siz delivery agent sifatida kirdingiz.\n\n"
        f"🗺 BOSHLASH — bugungi marshrut (Mini App)\n"
        f"📦 Tovar berish | 💰 Pul olish\n"
        f"📊 Statistikam — kunlik natijalar",
        reply_markup=main_kb("delivery",uid))
    send_field_btn(uid)
    # Notify admins
    for aid in all_admin_ids():
        try: bot.send_message(aid,f"🔗 Delivery agent ulandi:\n👤 {name}\n📞 {tel}\n🆔 {uid}")
        except: pass

@bot.message_handler(func=lambda m:m.text=="🗺 BOSHLASH")
def field_start_btn(msg):
    """Pastki klaviaturadagi BOSHLASH — inline web_app tugmasini yuboradi.
    (Reply-keyboard web_app tugmasi Telegram Web/iOS'da initData bermasligi
    mumkin, shu sabab ochish faqat inline tugma orqali.)"""
    uid=msg.from_user.id; user=get_user(uid)
    if not user or user[3] not in("delivery","agent","supervisor"): return
    send_field_btn(uid)

@bot.message_handler(func=lambda m:m.text=="🗺 Mening marshrutim")
def dlv_my_route(msg):
    uid=msg.from_user.id; user=get_user(uid)
    if not user or user[3]!="delivery": return
    dlv=_get_delivery_agent_by_tid(uid)
    if not dlv:
        bot.send_message(uid,"❗ Bog'lanish topilmadi."); return
    today=_today_kun()
    if not today:
        bot.send_message(uid,"😴 Bugun Juma — dam olish kuni. Marshrut yo'q."); return
    conn=get_db();c=conn.cursor()
    c.execute("""SELECT r.tartib,d.nomi,d.egasi,d.telefon,d.hudud,d.latitude,d.longitude,
                        COALESCE(r.added_by_dlv,0)
                 FROM delivery_routes r JOIN dokonlar d ON d.id=r.dokon_id
                 WHERE r.delivery_agent_id=%s AND r.kun=%s AND d.holat='faol'
                 ORDER BY r.tartib""",(dlv[0],today))
    rows=c.fetchall(); conn.close()
    if not rows:
        bot.send_message(uid,
            f"📭 Bugun ({day_name(today)}) uchun marshrut yo'q.\n\n"
            f"💡 \"📦 Tovar berish\" → \"➕ Yangi do'kon qo'shish\" orqali dokon qo'shing.")
        return
    text=f"🗺 BUGUNGI MARSHRUT\n🚚 {dlv[1]}\n📅 {day_name(today)}\n📦 {len(rows)} ta dokon\n{'━'*26}\n"
    for r in rows:
        tartib,nomi,egasi,tel,hud,lat,lon,added=r
        mark=" ➕" if added else ""
        text+=f"\n{tartib}. 🏪 {nomi}{mark}\n   👤 {egasi or '—'} | 📞 {tel or '—'} | 📍 {hud or '—'}"
        if lat and lon: text+=f"\n   🗺 https://maps.google.com/?q={lat},{lon}"
    _send_long(uid,text)

@bot.message_handler(func=lambda m:m.text=="🚀 Marshrutni boshlash")
def dlv_route_begin(msg):
    uid=msg.from_user.id; user=get_user(uid)
    if not user or user[3]!="delivery": return
    set_state(uid,"route_gps",{})
    bot.send_message(uid,"📍 Marshrutni boshlash uchun joylashuvingizni yuboring:",reply_markup=location_kb())

@bot.message_handler(content_types=["location"],func=lambda m:get_state(m.from_user.id)["state"]=="route_gps")
def dlv_route_gps(msg):
    uid=msg.from_user.id
    _record_agent_location(uid,msg.location.latitude,msg.location.longitude,"route_start")
    clear_state(uid)
    bot.send_message(uid,"✅ Joylashuv qabul qilindi — marshrut boshlandi. Yaxshi yo'l! 🚚",reply_markup=main_kb("delivery",uid))
    send_field_btn(uid)

@bot.message_handler(func=lambda m:m.text=="👤 Profil")
def dlv_profile(msg):
    uid=msg.from_user.id; user=get_user(uid)
    if not user or user[3]!="delivery": return
    conn=get_db();c=conn.cursor()
    c.execute("""SELECT name,telefon,tugilgan_kun,mashina_turi,mashina_nomeri,hudud
                 FROM delivery_agents WHERE telegram_id=%s AND faol=1""",(uid,))
    r=c.fetchone(); conn.close()
    if not r:
        bot.send_message(uid,"❗ Profil topilmadi."); return
    bot.send_message(uid,
        f"👤 PROFIL\n{'━'*22}\n"
        f"Ism: {r[0]}\n"
        f"📞 Telefon: {r[1] or '—'}\n"
        f"🎂 Tug'ilgan: {r[2] or '—'}\n"
        f"🚗 Mashina: {r[3] or '—'} | 🔢 {r[4] or '—'}\n"
        f"📍 Hudud: {r[5] or '—'}\n"
        f"🆔 Telegram: {uid}")

@bot.message_handler(func=lambda m:m.text=="📊 Statistikam")
def dlv_statistikam(msg):
    """T009/T010: delivery agent uchun bugungi + haftalik qisqa statistika."""
    uid=msg.from_user.id; user=get_user(uid)
    if not user or user[3]!="delivery": return
    dlv=_get_delivery_agent_by_tid(uid)
    bugun=date.today().isoformat()
    hafta_boshi=(date.today()-timedelta(days=6)).isoformat()
    conn=get_db();c=conn.cursor()
    c.execute("SELECT COUNT(*),COALESCE(SUM(jami_summa),0) FROM savdolar WHERE agent_id=%s AND substr(created_at,1,10)=%s",(uid,bugun))
    s_cnt,s_sum=c.fetchone()
    c.execute("SELECT COUNT(*) FROM olmagan_dokonlar WHERE agent_id=%s AND substr(created_at,1,10)=%s",(uid,bugun))
    o_cnt=c.fetchone()[0]
    c.execute("SELECT COALESCE(SUM(summa),0) FROM pul_olish WHERE agent_id=%s AND substr(created_at,1,10)=%s",(uid,bugun))
    pul=c.fetchone()[0]
    c.execute("SELECT COALESCE(SUM(qoldiq),0) FROM nasiya WHERE agent_id=%s AND qoldiq>0",(uid,))
    nasiya=c.fetchone()[0]
    c.execute("SELECT COUNT(*),COALESCE(SUM(jami_summa),0) FROM savdolar WHERE agent_id=%s AND substr(created_at,1,10)>=%s",(uid,hafta_boshi))
    h_cnt,h_sum=c.fetchone()
    jami_route=0
    kun=_today_kun()
    if dlv and kun:
        c.execute("""SELECT COUNT(*) FROM delivery_routes r JOIN dokonlar d ON d.id=r.dokon_id
                     WHERE r.delivery_agent_id=%s AND r.kun=%s AND d.holat='faol'""",(dlv[0],kun))
        jami_route=c.fetchone()[0]
    conn.close()
    tashrif=s_cnt+o_cnt
    conv=round(s_cnt*100/tashrif) if tashrif else 0
    prog=f"{tashrif}/{jami_route}" if jami_route else str(tashrif)
    text=(f"📊 MENING STATISTIKAM\n{'━'*26}\n"
          f"🗓 Bugun ({bugun}):\n"
          f"  ✅ Tashriflar: {prog}\n"
          f"  📦 Savdolar: {s_cnt} ta — {fmt(s_sum)}\n"
          f"  ❌ Olmadi: {o_cnt} ta\n"
          f"  🎯 Konversiya: {conv}%\n"
          f"  💰 Yig'ilgan pul: {fmt(pul)}\n\n"
          f"🔴 Ochiq nasiya: {fmt(nasiya)}\n\n"
          f"📅 Hafta (oxirgi 7 kun):\n"
          f"  📦 {h_cnt} ta savdo — {fmt(h_sum)}\n\n"
          f"💡 To'liq statistika Mini App'da: 🗺 BOSHLASH → 📊")
    bot.send_message(uid,text)

# ───── DELIVERY: ➕ Yangi do'kon (full create flow → auto-add to today's route) ─────
@bot.message_handler(func=lambda m:m.text and m.text.startswith("➕ Yangi do'kon qo'shish"))
def dlv_new_dokon_start(msg):
    uid=msg.from_user.id; user=get_user(uid)
    if not user or user[3]!="delivery": return
    dlv=_get_delivery_agent_by_tid(uid)
    if not dlv:
        bot.send_message(uid,"❗ Bog'lanish topilmadi."); return
    kun=_today_kun()
    if not kun:
        bot.send_message(uid,"😴 Bugun Juma — dam olish kuni. Marshrut yo'q."); return
    added=_dlv_adhoc_count(dlv[0],kun)
    if added>=DLV_ADHOC_MAX:
        bot.send_message(uid,f"🚫 Bugungi limit to'ldi ({DLV_ADHOC_MAX}/{DLV_ADHOC_MAX}). Ertaga urinib ko'ring."); return
    # Reuse the standard agent "yangi dokon" wizard (dokon_nomi → egasi → telefon → ... → location → foto)
    # _save_dokon will auto-insert into delivery_routes for today if user role == "delivery"
    set_state(uid,"dokon_nomi",{})
    bot.send_message(uid,
        f"🏪 YANGI DOKON ({added}/{DLV_ADHOC_MAX})\n"
        f"📅 Bugun: {day_name(kun)} — avtomatik marshrutga qo'shiladi.\n\n"
        f"Dokon nomini kiriting:",
        reply_markup=cancel_kb())

@bot.message_handler(func=lambda m:m.text and m.text.startswith("🚫 Qo'shish limiti"))
def dlv_new_dokon_limit(msg):
    uid=msg.from_user.id; user=get_user(uid)
    if not user or user[3]!="delivery": return
    bot.send_message(uid,f"🚫 Bugungi limit to'ldi ({DLV_ADHOC_MAX}/{DLV_ADHOC_MAX}). Ertaga urinib ko'ring.")

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="reg_name")
def reg_name(msg):
    uid=msg.from_user.id
    existing=get_user(uid)
    if existing:
        clear_state(uid)
        bot.send_message(uid,f"✅ Xush kelibsiz, {existing[2]}!",reply_markup=main_kb(existing[3],uid)); return
    set_state(uid,"reg_viloyat",{"name":msg.text.strip()})
    bot.send_message(uid,"📍 Viloyatingizni tanlang:",reply_markup=viloyat_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="reg_viloyat")
def reg_viloyat(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    existing=get_user(uid)
    if existing:
        clear_state(uid)
        bot.send_message(uid,f"✅ Xush kelibsiz, {existing[2]}!",reply_markup=main_kb(existing[3],uid)); return
    viloyatlar=["Namangan","Farg'ona","Andijon"]
    if msg.text not in viloyatlar:
        bot.send_message(uid,"❗ Iltimos ro'yxatdan viloyat tanlang:",reply_markup=viloyat_kb()); return
    conn=get_db();c=conn.cursor()
    c.execute("INSERT INTO users (telegram_id,name,role,viloyat,created_at) VALUES (%s,%s,%s,%s,%s) ON CONFLICT (telegram_id) DO NOTHING",
              (uid,data["name"],"pending",msg.text,datetime.now().isoformat()))
    conn.commit();conn.close();clear_state(uid)
    bot.send_message(uid,f"✅ {data['name']}, ro'yxatdan o'tdingiz!\n\n⏳ Hisobingiz admin tomonidan tasdiqlanishini kuting. Tasdiqlanganingizda xabar olasiz.",reply_markup=types.ReplyKeyboardRemove())
    for aid in all_admin_ids():
        try: bot.send_message(aid,f"🆕 Yangi agent:\n👤 {data['name']}\n📍 {msg.text}\n🆔 {uid}\n\n/approve {uid}\n/supervisor {uid}")
        except: pass

@bot.message_handler(commands=["approve"])
def approve(msg):
    if not is_admin(msg.from_user.id): return
    try:
        tid=int(msg.text.split()[1])
        conn=get_db();c=conn.cursor()
        c.execute("SELECT name,role FROM users WHERE telegram_id=%s",(tid,))
        row=c.fetchone()
        if not row: bot.send_message(msg.from_user.id,"❗ Foydalanuvchi topilmadi."); conn.close(); return
        if row[1]!="pending": bot.send_message(msg.from_user.id,f"⚠️ Bu foydalanuvchi allaqachon '{row[1]}' rolida."); conn.close(); return
        c.execute("UPDATE users SET role='agent' WHERE telegram_id=%s",(tid,))
        conn.commit();conn.close()
        bot.send_message(tid,"✅ Hisobingiz tasdiqlandi! Endi botdan foydalanishingiz mumkin.\n/start bosing.")
        bot.send_message(msg.from_user.id,f"✅ {row[0]} tasdiqlandi va 'agent' roliga o'tkazildi.")
    except Exception as e: bot.send_message(msg.from_user.id,f"❗ /approve 123456789\n{e}")

@bot.message_handler(commands=["pending"])
def pending_cmd(msg):
    if not is_admin(msg.from_user.id): return
    conn=get_db();c=conn.cursor()
    c.execute("SELECT telegram_id,name,viloyat,created_at FROM users WHERE role='pending' ORDER BY created_at")
    rows=c.fetchall();conn.close()
    if not rows:
        bot.send_message(msg.from_user.id,"✅ Tasdiq kutayotgan agent yo'q."); return
    text=f"⏳ TASDIQ KUTAYOTGANLAR — {len(rows)} ta\n{'━'*28}\n\n"
    for i,(tid,name,viloyat,created_at) in enumerate(rows,1):
        try: dt_str=created_at[:16].replace("T"," ")
        except: dt_str=str(created_at)
        text+=(f"{i}. 👤 {name}\n"
               f"   📍 {viloyat}\n"
               f"   🆔 {tid}\n"
               f"   🕐 {dt_str}\n"
               f"   ✅ /approve {tid}  |  ❌ /reject {tid}\n\n")
    bot.send_message(msg.from_user.id,text)

@bot.message_handler(commands=["reject"])
def reject_cmd(msg):
    if not is_admin(msg.from_user.id): return
    try:
        tid=int(msg.text.split()[1])
        conn=get_db();c=conn.cursor()
        c.execute("SELECT name,role FROM users WHERE telegram_id=%s",(tid,))
        row=c.fetchone()
        if not row: bot.send_message(msg.from_user.id,"❗ Foydalanuvchi topilmadi."); conn.close(); return
        if row[1]!="pending": bot.send_message(msg.from_user.id,f"⚠️ Bu foydalanuvchi '{row[1]}' rolida, rad etib bo'lmaydi."); conn.close(); return
        c.execute("DELETE FROM users WHERE telegram_id=%s",(tid,))
        conn.commit();conn.close()
        try: bot.send_message(tid,"❌ Afsus, hisobingiz admin tomonidan rad etildi. Muammo bo'lsa, adminга murojaat qiling.")
        except: pass
        bot.send_message(msg.from_user.id,f"🗑 {row[0]} rad etildi va tizimdan o'chirildi.")
    except Exception as e: bot.send_message(msg.from_user.id,f"❗ /reject 123456789\n{e}")

@bot.message_handler(commands=["supervisor"])
def make_sup(msg):
    if not is_admin(msg.from_user.id): return
    try:
        tid=int(msg.text.split()[1])
        conn=get_db();c=conn.cursor()
        c.execute("UPDATE users SET role='supervisor' WHERE telegram_id=%s",(tid,))
        conn.commit();conn.close()
        bot.send_message(tid,"✅ Supervisor qildingiz!")
        bot.send_message(msg.from_user.id,"✅ Supervisor qilindi.")
    except Exception as e: bot.send_message(msg.from_user.id,f"❗{e}")

@bot.message_handler(commands=["makeadmin"])
def make_adm(msg):
    if not is_admin(msg.from_user.id): return
    try:
        tid=int(msg.text.split()[1])
        conn=get_db();c=conn.cursor()
        c.execute("UPDATE users SET role='admin' WHERE telegram_id=%s",(tid,))
        conn.commit();conn.close()
        bot.send_message(msg.from_user.id,"✅ Admin qilindi.")
    except Exception as e: bot.send_message(msg.from_user.id,f"❗{e}")

@bot.message_handler(commands=["myid"])
def myid(msg): bot.send_message(msg.from_user.id,f"Sizning ID: {msg.from_user.id}")

@bot.message_handler(commands=["eksport","export"])
def eksport(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    import json as _json, datetime as _dt
    conn=get_db();c=conn.cursor()
    c.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='distribution' ORDER BY table_name")
    tables=[r[0] for r in c.fetchall()]
    dump={"_meta":{"exported_at":_dt.datetime.now().isoformat(),"db_path":"postgres:distribution","host":os.uname().nodename}}
    summary=[]
    for t in tables:
        c.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='distribution' AND table_name=%s ORDER BY ordinal_position",(t,))
        cols=[d[0] for d in c.fetchall()]
        c.execute(f"SELECT * FROM {t}")
        rows=c.fetchall()
        dump[t]=[dict(zip(cols,r)) for r in rows]
        summary.append(f"  {t}: {len(rows)} ta")
    conn.close()
    data=_json.dumps(dump,ensure_ascii=False,indent=2,default=str).encode("utf-8")
    fname=f"topmart_backup_{_dt.datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    bio=io.BytesIO(data); bio.name=fname
    bot.send_document(uid,bio,caption=f"📦 To'liq DB backup\n📁 Host: {dump['_meta']['host']}\n🗄 DB: postgres/distribution\n\n"+"\n".join(summary))

@bot.message_handler(commands=["agents"])
def agents_list(msg):
    if not is_admin(msg.from_user.id): return
    conn=get_db();c=conn.cursor()
    c.execute("""SELECT u.telegram_id,u.name,u.role,u.viloyat,u.created_at,
                        COUNT(DISTINCT d.id) as dokonlar
                 FROM users u
                 LEFT JOIN dokonlar d ON d.agent_id=u.telegram_id AND d.holat='faol'
                 GROUP BY u.telegram_id,u.name,u.role,u.viloyat,u.created_at
                 ORDER BY u.role, u.viloyat, u.name""")
    rows=c.fetchall(); conn.close()
    if not rows: bot.send_message(msg.from_user.id,"❗ Hech qanday foydalanuvchi yo'q."); return
    role_icon={"admin":"🔴","supervisor":"🟡","agent":"🟢"}
    text="👥 Barcha foydalanuvchilar:\n\n"
    for r in rows:
        tid,name,role,viloyat,created_at,dokonlar=r
        icon=role_icon.get(role,"⚪")
        sana=created_at[:10] if created_at else "—"
        text+=f"{icon} {name}\n"
        text+=f"   📍 {viloyat or '—'} | 🔰 {role.upper()}\n"
        text+=f"   🏪 {dokonlar} ta dokon | 🗓 {sana}\n"
        text+=f"   🆔 {tid}\n\n"
    bot.send_message(msg.from_user.id, text)

@bot.message_handler(commands=["deleteagent"])
def delete_agent(msg):
    if not is_admin(msg.from_user.id): return
    parts=msg.text.split()
    if len(parts)<2:
        bot.send_message(msg.from_user.id,
            "❗ Foydalanish:\n/deleteagent <telegram_id>\n\n"
            "Agent ID ni /agents buyrug'i orqali toping.")
        return
    try:
        tid=int(parts[1])
        if tid==msg.from_user.id:
            bot.send_message(msg.from_user.id,"❗ O'zingizni o'chira olmaysiz."); return
        conn=get_db();c=conn.cursor()
        c.execute("SELECT name,role,viloyat FROM users WHERE telegram_id=%s",(tid,))
        agent=c.fetchone()
        if not agent:
            conn.close()
            bot.send_message(msg.from_user.id,"❗ Bunday ID li foydalanuvchi topilmadi."); return
        name,role,viloyat=agent
        c.execute("UPDATE dokonlar SET holat='nofaol' WHERE agent_id=%s",(tid,))
        deactivated=c.rowcount
        c.execute("DELETE FROM users WHERE telegram_id=%s",(tid,))
        conn.commit();conn.close()
        bot.send_message(msg.from_user.id,
            f"✅ Agent o'chirildi!\n\n"
            f"👤 {name}\n"
            f"📍 {viloyat or '—'} | 🔰 {role.upper()}\n"
            f"🏪 {deactivated} ta do'kon nofaol qilindi.\n"
            f"🆔 {tid}")
        try: bot.send_message(tid,"⛔ Sizning akkauntingiz admin tomonidan o'chirildi.")
        except: pass
    except ValueError:
        bot.send_message(msg.from_user.id,"❗ ID raqam bo'lishi kerak.\n/deleteagent 123456789")

@bot.message_handler(commands=["dokonlar"])
def dokonlar_list(msg):
    if not is_admin(msg.from_user.id): return
    conn=get_db();c=conn.cursor()
    c.execute("""SELECT d.nomi,d.egasi,d.telefon,d.viloyat,d.hudud,d.holat,u.name,d.created_at
                 FROM dokonlar d
                 LEFT JOIN users u ON u.telegram_id=d.agent_id
                 ORDER BY d.viloyat, d.nomi""")
    rows=c.fetchall(); conn.close()
    if not rows: bot.send_message(msg.from_user.id,"❗ Hech qanday dokon yo'q."); return
    holat_icon={"faol":"🟢","nofaol":"🔴"}
    viloyat_cur=None; text=""
    for r in rows:
        nomi,egasi,telefon,viloyat,hudud,holat,agent,created_at=r
        if viloyat!=viloyat_cur:
            if text: bot.send_message(msg.from_user.id,text)
            viloyat_cur=viloyat; text=f"📍 {viloyat or '—'} viloyati:\n\n"
        icon=holat_icon.get(holat,"⚪")
        sana=created_at[:10] if created_at else "—"
        text+=f"{icon} {nomi}\n"
        text+=f"   👤 {egasi} | 📞 {telefon or '—'}\n"
        if hudud: text+=f"   🗺 {hudud}\n"
        text+=f"   🧑 Agent: {agent or '—'} | 🗓 {sana}\n\n"
    if text: bot.send_message(msg.from_user.id,text)

@bot.message_handler(commands=["savdolar"])
def savdolar_cmd(msg):
    if not is_admin(msg.from_user.id): return
    conn=get_db();c=conn.cursor()
    bugun=date.today().isoformat(); oy=datetime.now().strftime("%Y-%m")
    c.execute("""SELECT u.name,u.viloyat,
                        COALESCE(SUM(CASE WHEN s.created_at LIKE %s THEN s.jami_summa ELSE 0 END),0) as bugun_savdo,
                        COALESCE(SUM(CASE WHEN s.created_at LIKE %s THEN s.jami_summa ELSE 0 END),0) as oy_savdo,
                        COALESCE(SUM(CASE WHEN p.created_at LIKE %s THEN p.summa ELSE 0 END),0) as bugun_pul,
                        COALESCE(SUM(CASE WHEN p.created_at LIKE %s THEN p.summa ELSE 0 END),0) as oy_pul,
                        COUNT(DISTINCT CASE WHEN s.created_at LIKE %s THEN s.id END) as bugun_n,
                        COUNT(DISTINCT CASE WHEN s.created_at LIKE %s THEN s.id END) as oy_n
                 FROM users u
                 LEFT JOIN savdolar s ON s.agent_id=u.telegram_id
                 LEFT JOIN pul_olish p ON p.agent_id=u.telegram_id
                 WHERE u.role IN ('agent','supervisor')
                 GROUP BY u.telegram_id,u.name,u.viloyat
                 ORDER BY oy_savdo DESC""",
              (f"{bugun}%",f"{oy}%",f"{bugun}%",f"{oy}%",f"{bugun}%",f"{oy}%"))
    rows=c.fetchall(); conn.close()
    if not rows: bot.send_message(msg.from_user.id,"❗ Agentlar yo'q."); return
    jami_bs=jami_os=jami_bp=jami_op=0
    text=f"📊 Savdolar hisoboti\n🗓 {bugun}\n\n"
    for i,r in enumerate(rows,1):
        name,viloyat,bs,os_,bp,op,bn,on_=r
        jami_bs+=bs; jami_os+=os_; jami_bp+=bp; jami_op+=op
        text+=f"{i}. {name} ({viloyat or '—'})\n"
        text+=f"   📦 Bugun: {fmt(bs)} ({bn} ta)\n"
        text+=f"   💰 Bugun pul: {fmt(bp)}\n"
        text+=f"   📦 Oy: {fmt(os_)} ({on_} ta)\n"
        text+=f"   💰 Oy pul: {fmt(op)}\n\n"
    text+=(f"━━━━━━━━━━━━━━\n"
           f"📦 Jami bugungi savdo: {fmt(jami_bs)}\n"
           f"💰 Jami bugungi pul: {fmt(jami_bp)}\n"
           f"📦 Jami oylik savdo: {fmt(jami_os)}\n"
           f"💰 Jami oylik pul: {fmt(jami_op)}")
    bot.send_message(msg.from_user.id, text)

@bot.message_handler(commands=["export"])
def export_cmd(msg):
    if not is_admin(msg.from_user.id): return
    conn=get_db(); c=conn.cursor()

    # Savdolar sheet
    c.execute("""SELECT s.id, s.created_at, u.name, u.viloyat, d.nomi, d.telefon,
                        s.jami_summa, s.tolov_turi,
                        string_agg(m.nomi||' x'||st.miqdor::text||' ('||st.summa::text||')', ' | ') as mahsulotlar
                 FROM savdolar s
                 LEFT JOIN users u ON u.telegram_id=s.agent_id
                 LEFT JOIN dokonlar d ON d.id=s.dokon_id
                 LEFT JOIN savdo_tafsilot st ON st.savdo_id=s.id
                 LEFT JOIN mahsulotlar m ON m.id=st.mahsulot_id
                 GROUP BY s.id, u.name, u.viloyat, d.nomi, d.telefon
                 ORDER BY s.created_at DESC""")
    savdolar=c.fetchall()

    # Pul olish sheet
    c.execute("""SELECT p.created_at, u.name, u.viloyat, d.nomi, d.telefon, p.summa
                 FROM pul_olish p
                 LEFT JOIN users u ON u.telegram_id=p.agent_id
                 LEFT JOIN dokonlar d ON d.id=p.dokon_id
                 ORDER BY p.created_at DESC""")
    pullar=c.fetchall()

    # Olmagan dokonlar sheet
    c.execute("""SELECT o.created_at, u.name, u.viloyat, d.nomi, d.telefon,
                        o.sabab_text, o.qaytish_sanasi,
                        CASE WHEN o.bajarildi=1 THEN 'Ha' ELSE 'Yoq' END
                 FROM olmagan_dokonlar o
                 LEFT JOIN users u ON u.telegram_id=o.agent_id
                 LEFT JOIN dokonlar d ON d.id=o.dokon_id
                 ORDER BY o.created_at DESC""")
    olmagan=c.fetchall()
    conn.close()

    out=io.StringIO()
    w=csv.writer(out)

    w.writerow(["=== SAVDOLAR ==="])
    w.writerow(["#","Sana","Agent","Viloyat","Dokon","Telefon","Jami summa","Tolov turi","Mahsulotlar"])
    for r in savdolar: w.writerow(r)

    w.writerow([])
    w.writerow(["=== PUL OLISH ==="])
    w.writerow(["Sana","Agent","Viloyat","Dokon","Telefon","Summa"])
    for r in pullar: w.writerow(r)

    w.writerow([])
    w.writerow(["=== TOVAR OLMAGAN DOKONLAR ==="])
    w.writerow(["Sana","Agent","Viloyat","Dokon","Telefon","Sabab","Qaytish sanasi","Bajarildi"])
    for r in olmagan: w.writerow(r)

    out.seek(0)
    filename=f"topmart_export_{date.today().isoformat()}.csv"
    bot.send_document(msg.from_user.id,
        (filename, out.getvalue().encode("utf-8-sig")),
        caption=f"📊 TOP MART ma'lumotlar bazasi\n🗓 {date.today().isoformat()}\n\n"
                f"• Savdolar: {len(savdolar)} ta\n"
                f"• Pul olish: {len(pullar)} ta\n"
                f"• Olmagan dokonlar: {len(olmagan)} ta")

@bot.message_handler(commands=["addproduct"])
def add_prod(msg):
    if not is_admin(msg.from_user.id): return
    # Yagona katalog (SKU) siyosati: yangi mahsulot faqat dashboard orqali yaratiladi
    bot.send_message(msg.from_user.id,
        "ℹ️ Yangi mahsulot endi faqat dashboard orqali qo'shiladi:\n"
        "Dashboard → Mahsulotlar → «Yangi savdo mahsuloti».\n"
        "Bu yerda narx o'zgartirish va o'chirish ishlayveradi.")

def is_master_linked(mid):
    """SKU orqali ERP masteriga bog'langan qatorlarni bot orqali tahrirlash taqiqlanadi."""
    conn=get_db();c=conn.cursor()
    c.execute("SELECT COALESCE(sku,'') FROM mahsulotlar WHERE id=%s",(mid,))
    row=c.fetchone(); conn.close()
    return bool(row and row[0])
@bot.message_handler(commands=["updateprice"])
def upd_price(msg):
    if not is_admin(msg.from_user.id): return
    try:
        p=msg.text.split()[1].split("|"); mid,narx=int(p[0]),int(p[1])
        if is_master_linked(mid):
            bot.send_message(msg.from_user.id,MASTER_LINKED_MSG); return
        conn=get_db();c=conn.cursor()
        c.execute("UPDATE mahsulotlar SET narx=%s WHERE id=%s",(narx,mid))
        conn.commit();conn.close()
        bot.send_message(msg.from_user.id,f"✅ #{mid}: {fmt(narx)}")
    except: bot.send_message(msg.from_user.id,"❗ /updateprice 1|40000")

@bot.message_handler(commands=["delproduct"])
def del_prod(msg):
    if not is_admin(msg.from_user.id): return
    try:
        mid=int(msg.text.split()[1])
        if is_master_linked(mid):
            bot.send_message(msg.from_user.id,MASTER_LINKED_MSG); return
        conn=get_db();c=conn.cursor()
        c.execute("UPDATE mahsulotlar SET faol=0 WHERE id=%s",(mid,))
        conn.commit();conn.close()
        bot.send_message(msg.from_user.id,f"✅ #{mid} o'chirildi.")
    except: bot.send_message(msg.from_user.id,"❗ /delproduct 1")

@bot.message_handler(func=lambda m:m.text=="🏪 Yangi dokon")
def yangi_dokon(msg):
    uid=msg.from_user.id; user=get_user(uid)
    if not user: return
    if check_pending(uid): return
    set_state(uid,"dokon_nomi",{})
    bot.send_message(uid,"🏪 Dokon nomini kiriting:",reply_markup=cancel_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="dokon_nomi")
def s_dokon_nomi(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    data["nomi"]=msg.text.strip(); set_state(uid,"dokon_egasi",data)
    bot.send_message(uid,"👤 Dokon egasining ismi:")

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="dokon_egasi")
def s_dokon_egasi(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    data["egasi"]=msg.text.strip(); set_state(uid,"dokon_telefon",data)
    bot.send_message(uid,"📞 Telefon raqami:")

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="dokon_telefon")
def s_dokon_tel(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    data["telefon"]=msg.text.strip(); set_state(uid,"dokon_owner_tg",data)
    bot.send_message(uid,"📱 Dokon egasi Telegram da botga ulangan? /start bosgan bo'lsa ID si:\n(O'tkazib yuborish mumkin)",reply_markup=skip_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="dokon_owner_tg")
def s_dokon_owner_tg(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    if msg.text=="⏭ O'tkazib yuborish":
        data["owner_telegram_id"]=None
    else:
        try: data["owner_telegram_id"]=int(msg.text.strip())
        except: data["owner_telegram_id"]=None
    set_state(uid,"dokon_hudud",data)
    bot.send_message(uid,"🗺 Hudud/ko'cha (ixtiyoriy):",reply_markup=skip_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="dokon_hudud")
def s_dokon_hudud(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    data["hudud"]="" if msg.text=="⏭ O'tkazib yuborish" else msg.text.strip()
    set_state(uid,"dokon_location",data)
    bot.send_message(uid,"📍 Location yuboring:",reply_markup=location_kb())

def _handle_dokon_location(uid,data,lat,lon):
    _record_agent_location(uid,lat,lon,"dokon")
    user=get_user(uid)
    viloyat=user[4] if user else None
    dist=_gps_outlier_km(viloyat,lat,lon)
    if dist is not None:
        data["pending_lat"]=lat; data["pending_lon"]=lon
        set_state(uid,"dokon_loc_confirm",data)
        bot.send_message(uid,
            f"⚠️ Diqqat! Bu joylashuv {viloyat} dokonlari markazidan ~{dist:.0f} km uzoqda.\n"
            f"Koordinata xato bo'lsa, dokon marshrut rejalariga kirmaydi.\n\n"
            f"Joylashuv to'g'rimi?",
            reply_markup=gps_confirm_kb())
        return
    data["lat"]=lat; data["lon"]=lon
    set_state(uid,"dokon_foto",data)
    bot.send_message(uid,"📸 Dokon rasmini yuboring:",reply_markup=skip_kb())

@bot.message_handler(content_types=["location"],func=lambda m:get_state(m.from_user.id)["state"]=="dokon_location")
def s_dokon_loc(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    _handle_dokon_location(uid,data,msg.location.latitude,msg.location.longitude)

@bot.message_handler(content_types=["location"],func=lambda m:get_state(m.from_user.id)["state"]=="dokon_loc_confirm")
def s_dokon_loc_retry(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    data.pop("pending_lat",None); data.pop("pending_lon",None)
    _handle_dokon_location(uid,data,msg.location.latitude,msg.location.longitude)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="dokon_loc_confirm")
def s_dokon_loc_confirm(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    if msg.text=="✅ Ha, joylashuv to'g'ri":
        data["lat"]=data.pop("pending_lat",None); data["lon"]=data.pop("pending_lon",None)
        set_state(uid,"dokon_foto",data)
        bot.send_message(uid,"📸 Dokon rasmini yuboring:",reply_markup=skip_kb())
        return
    bot.send_message(uid,"❗ Tasdiqlash uchun \"✅ Ha, joylashuv to'g'ri\" tugmasini bosing yoki 📍 joylashuvni qayta yuboring.",reply_markup=gps_confirm_kb())

@bot.message_handler(content_types=["photo"],func=lambda m:get_state(m.from_user.id)["state"]=="dokon_foto")
def s_dokon_foto_p(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    data["foto"]=msg.photo[-1].file_id; _save_dokon(uid,data)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="dokon_foto")
def s_dokon_foto_s(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    data["foto"]=None; _save_dokon(uid,data)

def _save_dokon(uid,data):
    user=get_user(uid); conn=get_db(); c=conn.cursor()
    c.execute("INSERT INTO dokonlar (nomi,egasi,telefon,viloyat,hudud,latitude,longitude,foto,agent_id,created_at,owner_telegram_id) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
              (data["nomi"],data["egasi"],data["telefon"],user[4],data.get("hudud",""),data.get("lat"),data.get("lon"),data.get("foto"),uid,datetime.now().isoformat(),data.get("owner_telegram_id")))
    new_did=c.fetchone()[0]
    # Delivery agent: auto-add to today's route (max 5/day)
    route_note=""
    if user and user[3]=="delivery":
        dlv=_get_delivery_agent_by_tid(uid)
        kun=_today_kun()
        if dlv and kun:
            c.execute("SELECT COUNT(*) FROM delivery_routes WHERE delivery_agent_id=%s AND kun=%s AND COALESCE(added_by_dlv,0)=1",(dlv[0],kun))
            added=c.fetchone()[0]
            if added<DLV_ADHOC_MAX:
                c.execute("SELECT COALESCE(MAX(tartib),0)+1 FROM delivery_routes WHERE delivery_agent_id=%s AND kun=%s",(dlv[0],kun))
                tartib=c.fetchone()[0]
                try:
                    c.execute("""INSERT INTO delivery_routes (delivery_agent_id,kun,dokon_id,tartib,created_at,added_by_dlv)
                                 VALUES (%s,%s,%s,%s,%s,1)""",(dlv[0],kun,new_did,tartib,datetime.now().isoformat()))
                    route_note=f"\n🗺 Bugungi marshrutga qo'shildi ({day_name(kun)}, {added+1}/{DLV_ADHOC_MAX})"
                except Exception as _e:
                    route_note=f"\n⚠️ Marshrutga qo'shilmadi: {_e}"
    conn.commit();conn.close();clear_state(uid)
    owner_note=f"\n📱 Egasi TG: {data['owner_telegram_id']}" if data.get("owner_telegram_id") else ""
    bot.send_message(uid,f"✅ Dokon saqlandi!\n🏪 {data['nomi']}\n👤 {data['egasi']}\n📞 {data['telefon']}{owner_note}{route_note}",reply_markup=main_kb(user[3],uid))
    lat=data.get("lat"); lon=data.get("lon")
    maps_link=f"\n🗺 https://maps.google.com/?q={lat},{lon}" if lat and lon else ""
    notif_text=(f"🏪 Yangi dokon qo'shildi!\n\n"
                f"👤 Agent: {user[2]}\n"
                f"📍 Viloyat: {user[4]}\n"
                f"📌 Hudud: {data.get('hudud','—') or '—'}\n\n"
                f"🏪 Dokon: {data['nomi']}\n"
                f"👤 Egasi: {data['egasi']}\n"
                f"📞 Telefon: {data['telefon']}{owner_note}{maps_link}")
    foto_id=data.get("foto")
    for aid in all_admin_ids():
        try:
            if foto_id: bot.send_photo(aid, foto_id, caption=notif_text)
            else: bot.send_message(aid, notif_text)
        except: pass
    # Channel notification (optional via env var)
    channel=os.environ.get("NEW_DOKON_CHANNEL_ID","").strip()
    if channel:
        try: ch_target=int(channel)
        except: ch_target=channel  # @username
        try:
            if foto_id: bot.send_photo(ch_target, foto_id, caption=notif_text)
            else: bot.send_message(ch_target, notif_text)
            if lat and lon:
                try: bot.send_location(ch_target, lat, lon)
                except: pass
        except Exception as e:
            for aid in all_admin_ids():
                try: bot.send_message(aid, f"⚠️ Kanalga yuborib bo'lmadi ({channel}): {e}")
                except: pass
    if data.get("owner_telegram_id"):
        try:
            bot.send_message(data["owner_telegram_id"],
                f"👋 Salom! Siz TOP MART tizimiga ulandingiz.\n"
                f"🏪 Dokoningiz: {data['nomi']}\n"
                f"Endi har bir savdodan chek olasiz.")
        except: pass

def _mah_list_kb(mahsulotlar, tanlangan):
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    for i,(mid,nomi,narx,birlik) in enumerate(mahsulotlar,1):
        miqdor=tanlangan.get(mid,0)
        mark=f" ✅ ×{fmt_miq(miqdor)}" if miqdor>0 else ""
        kb.add(f"{i}. {nomi} — {fmt(narx)}/{birlik}{mark}")
    kb.add("❌ Bekor qilish")
    return kb

def _next_kb():
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    kb.add("➕ Yana mahsulot qo'shish")
    kb.add("✅ Savdoni yakunlash")
    kb.add("❌ Bekor qilish")
    return kb

def _scope_clause(uid):
    """Returns (where_extra, params) to scope queries by role."""
    if is_admin(uid): return "", ()
    return " AND agent_id=%s", (uid,)

def _get_delivery_agent_by_tid(tid):
    conn=get_db();c=conn.cursor()
    c.execute("SELECT id,name,telefon,hudud FROM delivery_agents WHERE telegram_id=%s AND faol=1",(tid,))
    r=c.fetchone(); conn.close(); return r

def _today_kun():
    """Returns 1..7 (isoweekday), or None if Friday (dam kuni)."""
    iw=datetime.now().isoweekday()
    return None if iw==5 else iw

def _record_agent_location(uid,lat,lon,source="manual"):
    """GPS nuqtasini agent_locations ga yozadi — xato bo'lsa asosiy oqimni buzmaydi."""
    if lat is None or lon is None: return
    try:
        conn=get_db();c=conn.cursor()
        c.execute("INSERT INTO agent_locations (agent_id,latitude,longitude,source,created_at) VALUES (%s,%s,%s,%s,%s)",
                  (uid,lat,lon,source,datetime.now().isoformat()))
        conn.commit();conn.close()
    except Exception as e:
        log.warning("agent_location yozilmadi (uid=%s): %s", uid, e)

DLV_ADHOC_MAX=5

def _dlv_adhoc_count(dlv_id, kun):
    conn=get_db();c=conn.cursor()
    c.execute("SELECT COUNT(*) FROM delivery_routes WHERE delivery_agent_id=%s AND kun=%s AND COALESCE(added_by_dlv,0)=1",(dlv_id,kun))
    n=c.fetchone()[0]; conn.close(); return n

def _delivery_today_dokon_kb(uid):
    """For delivery agent: today's route dokons + ➕ add button (max 5/day)."""
    dlv=_get_delivery_agent_by_tid(uid)
    if not dlv: return None,0,0,"no_agent"
    kun=_today_kun()
    if not kun: return None,0,0,"sunday"
    conn=get_db();c=conn.cursor()
    c.execute("""SELECT d.id,d.nomi FROM delivery_routes r
                 JOIN dokonlar d ON d.id=r.dokon_id
                 WHERE r.delivery_agent_id=%s AND r.kun=%s AND d.holat='faol'
                 ORDER BY r.tartib""",(dlv[0],kun))
    rows=c.fetchall(); conn.close()
    added=_dlv_adhoc_count(dlv[0],kun)
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=2)
    pair=[]
    for d in rows:
        pair.append(f"🏪 {d[0]}||{d[1]}")
        if len(pair)==2: kb.add(*pair); pair=[]
    if pair: kb.add(*pair)
    if added<DLV_ADHOC_MAX:
        kb.add(f"➕ Yangi do'kon qo'shish ({added}/{DLV_ADHOC_MAX})")
    else:
        kb.add(f"🚫 Qo'shish limiti ({added}/{DLV_ADHOC_MAX})")
    kb.add("❌ Bekor qilish")
    return kb,len(rows),added,"ok"

KB_MAX_DOKON=40  # Telegram "reply markup is too long" xatosidan saqlaydi
BTN_NEXT_PAGE="➡️ Keyingi 40 ta"
BTN_PREV_PAGE="⬅️ Oldingi 40 ta"

def _dokon_page_kb(uid, page=0, query=None, faol_only=True, extra_buttons=None, row_width=2):
    """Universal dokon picker: pagination (KB_MAX_DOKON per page) + optional name search.
    Qidiruv imlo xatolariga chidamli (_norm_text) va egasi ismi bo'yicha ham ishlaydi.
    Returns (kb, total, shown, page)."""
    conn=get_db();c=conn.cursor()
    where="1=1"; params=[]
    if faol_only:
        where+=" AND holat='faol'"
    if not is_admin(uid):
        where+=" AND agent_id=%s"; params.append(uid)
    c.execute(f"""SELECT id,nomi,egasi FROM dokonlar WHERE {where}
                  ORDER BY created_at DESC, id DESC""",params)
    rows=c.fetchall(); conn.close()
    if query:
        nq=_norm_text(query)
        items=[]
        for r in rows:
            if nq in _norm_text(r[1]):
                items.append((r[0],r[1]))
            elif r[2] and nq in _norm_text(r[2]):
                items.append((r[0],f"{r[1]} — {r[2]}"))
        if not items:
            # Yaqin variantlarni taklif qilish (imlo xatolariga chidamli)
            items=_dokon_suggestions(rows,query)
    else:
        items=[(r[0],r[1]) for r in rows]
    total=len(items)
    max_page=max(0,(total-1)//KB_MAX_DOKON)
    page=max(0,min(page,max_page))
    shown=items[page*KB_MAX_DOKON:(page+1)*KB_MAX_DOKON]
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=row_width)
    if row_width==2:
        pair=[]
        for d in shown:
            pair.append(f"🏪 {d[0]}||{d[1]}")
            if len(pair)==2: kb.add(*pair); pair=[]
        if pair: kb.add(*pair)
    else:
        for d in shown: kb.add(f"🏪 {d[0]}||{d[1]}")
    nav=[]
    if page>0: nav.append(BTN_PREV_PAGE)
    if (page+1)*KB_MAX_DOKON<total: nav.append(BTN_NEXT_PAGE)
    if nav: kb.add(*nav)
    for b in (extra_buttons or []): kb.add(b)
    kb.add("❌ Bekor qilish")
    return kb, total, len(shown), page

def _dokon_page_text(total, shown, page, query=None):
    """Header text for the dokon picker."""
    t=f"🏪 DOKONNI TANLANG ({total} ta"
    if query: t+=f", qidiruv: \"{query}\""
    t+=")\n"
    if total>KB_MAX_DOKON:
        t+=f"📄 Sahifa {page+1}/{(total-1)//KB_MAX_DOKON+1} — {shown} ta ko'rsatildi\n"
    t+="\n🆕 Oxirgi qo'shilganlar tepada\n🔍 Qidirish uchun dokon nomini (bir qismini) yozing"
    return t

def _dokon_picker_nav(uid, msg_text, data, state_name, faol_only=True, extra_buttons=None, row_width=2):
    """Handle pagination/search input inside a dokon-picker state.
    Returns True if the message was consumed (keyboard re-sent)."""
    txt=(msg_text or "").strip()
    if txt.startswith("🏪 ") and "||" in txt: return False
    u=get_user(uid)
    if u and u[3]=="delivery": return False  # delivery uses route keyboard, not this picker
    page=data.get("dokon_page",0); query=data.get("dokon_query")
    if txt==BTN_NEXT_PAGE: page+=1
    elif txt==BTN_PREV_PAGE: page=max(0,page-1)
    elif txt and not txt.startswith(("❌","🆕","⬅️","➡️","/")):
        # Treat any other typed text as a search query
        query=txt; page=0
    else:
        return False
    data["dokon_page"]=page; data["dokon_query"]=query
    set_state(uid,state_name,data)
    kb,total,shown,page=_dokon_page_kb(uid,page=page,query=query,faol_only=faol_only,
                                       extra_buttons=extra_buttons,row_width=row_width)
    data["dokon_page"]=page
    if total==0:
        bot.send_message(uid,f"❗ \"{query}\" bo'yicha dokon topilmadi. Boshqa nom yozing:",reply_markup=kb)
    else:
        bot.send_message(uid,_dokon_page_text(total,shown,page,query),reply_markup=kb)
    return True

def _bosh_dokon_kb(uid):
    """For bosh agent: list dokons ordered by created_at DESC (newest first), 2 columns."""
    return _dokon_page_kb(uid,page=0)

def _viloyat_kb(uid):
    """Build viloyat-picker keyboard + recent 5 dokon shortcuts."""
    conn=get_db();c=conn.cursor()
    extra,params=_scope_clause(uid)
    # Recent 5 dokons
    if is_admin(uid):
        c.execute("""SELECT d.id,d.nomi FROM dokonlar d
                     JOIN savdolar s ON s.dokon_id=d.id
                     WHERE d.holat='faol'
                     GROUP BY d.id ORDER BY MAX(s.created_at) DESC LIMIT 5""")
    else:
        c.execute("""SELECT d.id,d.nomi FROM dokonlar d
                     JOIN savdolar s ON s.dokon_id=d.id
                     WHERE d.agent_id=%s AND d.holat='faol'
                     GROUP BY d.id ORDER BY MAX(s.created_at) DESC LIMIT 5""",(uid,))
    recent=c.fetchall()
    # Distinct viloyats with counts
    c.execute(f"""SELECT COALESCE(NULLIF(viloyat,''),'— Noma''lum') as v, COUNT(*) as n
                  FROM dokonlar WHERE holat='faol'{extra}
                  GROUP BY v ORDER BY n DESC""",params)
    vils=c.fetchall(); conn.close()
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=2)
    if recent:
        for d in recent: kb.add(f"🏪 {d[0]}||{d[1]}")
    if vils:
        row=[]
        for v,n in vils:
            row.append(f"📍 {v} ({n})")
            if len(row)==2: kb.add(*row); row=[]
        if row: kb.add(*row)
    kb.add("❌ Bekor qilish")
    return kb, len(vils), len(recent)

def _hudud_kb(uid, viloyat):
    """List hududs within a viloyat."""
    conn=get_db();c=conn.cursor()
    extra,params=_scope_clause(uid)
    vil_clause="(viloyat=%s OR (viloyat IS NULL AND %s='— Noma''lum') OR (viloyat='' AND %s='— Noma''lum'))"
    c.execute(f"""SELECT COALESCE(NULLIF(hudud,''),'— Noma''lum') as h, COUNT(*) as n
                  FROM dokonlar WHERE holat='faol' AND {vil_clause}{extra}
                  GROUP BY h ORDER BY n DESC""",(viloyat,viloyat,viloyat)+params)
    huds=c.fetchall(); conn.close()
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=2)
    row=[]
    for h,n in huds:
        row.append(f"🏘 {h} ({n})")
        if len(row)==2: kb.add(*row); row=[]
    if row: kb.add(*row)
    kb.add("⬅️ Viloyatga qaytish","❌ Bekor qilish")
    return kb, len(huds)

DOKON_KB_PAGE=40  # bitta sahifadagi maksimal dokon tugmasi (Telegram klaviatura ~10KB limiti himoyasi)

def _dokon_in_hudud_kb(uid, viloyat, hudud, page=0):
    """Hudud ichidagi dokonlar klaviaturasi, sahifalangan.
    Returns (kb, total, page, pages) — page chegaraga qisqartirilgan bo'lishi mumkin."""
    conn=get_db();c=conn.cursor()
    extra,params=_scope_clause(uid)
    vil_clause="(viloyat=%s OR (viloyat IS NULL AND %s='— Noma''lum') OR (viloyat='' AND %s='— Noma''lum'))"
    hud_clause="(hudud=%s OR (hudud IS NULL AND %s='— Noma''lum') OR (hudud='' AND %s='— Noma''lum'))"
    c.execute(f"""SELECT id,nomi FROM dokonlar
                  WHERE holat='faol' AND {vil_clause} AND {hud_clause}{extra}
                  ORDER BY nomi LIMIT %s""",(viloyat,viloyat,viloyat,hudud,hudud,hudud)+params+(KB_MAX_DOKON,))
    rows=c.fetchall(); conn.close()
    total=len(rows)
    pages=max(1,(total+DOKON_KB_PAGE-1)//DOKON_KB_PAGE)
    page=max(0,min(page,pages-1))
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    for d in rows[page*DOKON_KB_PAGE:(page+1)*DOKON_KB_PAGE]:
        kb.add(f"🏪 {d[0]}||{d[1]}")
    nav=[]
    if page>0: nav.append("⬅️ Oldingi dokonlar")
    if page<pages-1: nav.append("➡️ Keyingi dokonlar")
    if nav: kb.add(*nav)
    kb.add("⬅️ Hududga qaytish","❌ Bekor qilish")
    return kb, total, page, pages

@bot.message_handler(func=lambda m:m.text=="📦 Tovar berish")
def tovar_berish(msg):
    uid=msg.from_user.id; user=get_user(uid)
    if not user: return
    if check_pending(uid): return
    conn=get_db();c=conn.cursor()
    c.execute("SELECT id,nomi,narx,birlik FROM mahsulotlar WHERE faol=1 AND (COALESCE(sku,'')='' OR EXISTS (SELECT 1 FROM public.products p WHERE p.sku=mahsulotlar.sku AND p.in_sales=TRUE)) ORDER BY nomi")
    mahsulotlar=c.fetchall(); conn.close()
    if not mahsulotlar: bot.send_message(uid,"❗ Mahsulotlar yo'q."); return
    # Delivery agent: today's route only
    if user[3]=="delivery":
        kb,n,added,status=_delivery_today_dokon_kb(uid)
        if status=="no_agent":
            bot.send_message(uid,"❗ Siz delivery agent sifatida bog'lanmagansiz."); return
        if status=="sunday":
            bot.send_message(uid,"😴 Bugun Juma — dam olish kuni. Marshrut yo'q."); return
        set_state(uid,"savdo_dokon",{"mahsulotlar":mahsulotlar,"tanlangan":{},
                                      "vehicle_pilot":_is_vehicle_distribution_pilot_user(user),
                                      "operation_key":str(uuid.uuid4())})
        if n==0:
            bot.send_message(uid,
                f"🚚 BUGUN — {day_name(_today_kun())}\n"
                f"📭 Marshrutda dokon yo'q.\n\n"
                f"➕ Yangi do'kon qo'shish orqali boshlang ({added}/{DLV_ADHOC_MAX}):",
                reply_markup=kb)
        else:
            bot.send_message(uid,
                f"🚚 BUGUN — {day_name(_today_kun())}\n"
                f"📦 Marshrutda {n} ta dokon | ➕ Qo'shilgan: {added}/{DLV_ADHOC_MAX}\n\n"
                f"🏪 Dokonni tanlang:",
                reply_markup=kb)
        return
    # Sahifalangan universal picker (40 tadan, yozib qidirish mumkin) — Telegram
    # "reply markup is too long" limitidan saqlaydi (Elyorbek, 2026-08-04).
    kb,total,shown,page=_bosh_dokon_kb(uid)
    if total==0: bot.send_message(uid,"❗ Faol dokon yo'q."); return
    set_state(uid,"savdo_dokon",{"mahsulotlar":mahsulotlar,"tanlangan":{},
                                  "vehicle_pilot":_is_vehicle_distribution_pilot_user(user),
                                  "dokon_page":page,"operation_key":str(uuid.uuid4())})
    bot.send_message(uid,_dokon_page_text(total,shown,page),reply_markup=kb)

SAVDO_KB_MAX=80  # bundan ko'p dokonli agent uchun viloyat→hudud bosqichli tanlov

def _savdo_dokon_ruxsat(uid,did):
    """Tanlangan dokon faol va shu foydalanuvchiga ochiq ekanini tekshiradi.
    - admin: har qanday faol dokon
    - delivery: dokon boshqa agentga biriktirilgan bo'ladi, shuning uchun
      egallik emas — BUGUNGI marshrutga (shu jumladan o'zi qo'shgan ad-hoc
      dokonlarga) a'zolik tekshiriladi
    - oddiy agent: faqat o'ziga biriktirilgan faol dokon"""
    user=get_user(uid)
    if user and user[3]=="delivery" and not is_admin(uid):
        dlv=_get_delivery_agent_by_tid(uid)
        kun=_today_kun()
        if not dlv or not kun: return False
        conn=get_db();c=conn.cursor()
        c.execute("""SELECT d.nomi FROM delivery_routes r
                     JOIN dokonlar d ON d.id=r.dokon_id
                     WHERE r.delivery_agent_id=%s AND r.kun=%s AND d.id=%s AND d.holat='faol'""",
                  (dlv[0],kun,did))
        r=c.fetchone(); conn.close()
        return r is not None
    conn=get_db();c=conn.cursor()
    if is_admin(uid):
        c.execute("SELECT nomi FROM dokonlar WHERE id=%s AND holat='faol'",(did,))
    else:
        c.execute("SELECT nomi FROM dokonlar WHERE id=%s AND holat='faol' AND agent_id=%s",(did,uid))
    r=c.fetchone(); conn.close()
    return r is not None

def _dokon_ruxsat_guard(uid,did,user=None):
    """Yozuvdan OLDINGI yakuniy tekshiruv: dokon faol va shu foydalanuvchiga
    ochiqligini persist nuqtasida qayta tasdiqlaydi (state buzilgan/eski bo'lsa
    ham begona dokonga yozib bo'lmaydi). Ruxsat bo'lmasa state tozalanadi."""
    if _savdo_dokon_ruxsat(uid,did): return True
    if user is None: user=get_user(uid)
    clear_state(uid)
    bot.send_message(uid,"❗ Saqlanmadi: dokon topilmadi, faol emas yoki sizga biriktirilmagan.",
                     reply_markup=main_kb(user[3],uid) if user else types.ReplyKeyboardRemove())
    return False

def _savdo_send_vil(uid,data,total=None):
    kb,nv,nr=_viloyat_kb(uid)
    set_state(uid,"savdo_vil",data)
    sarl=f"🏪 DOKONNI TANLANG{f' ({total} ta faol)' if total else ''}\n\n"
    bot.send_message(uid,
        sarl+"🆕 Tepada — oxirgi savdo bo'lgan dokonlar.\n📍 Yoki viloyatni tanlang:",
        reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="savdo_vil")
def s_savdo_vil(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    txt=(msg.text or "").strip()
    if txt.startswith("🏪 ") and "||" in txt:
        try:
            did,dnomi=txt.replace("🏪 ","").split("||",1)
            data["dokon_id"]=int(did); data["dokon_nomi"]=dnomi
        except: return
        if not _savdo_dokon_ruxsat(uid,data["dokon_id"]):
            bot.send_message(uid,"❗ Bu dokon topilmadi yoki sizga biriktirilmagan."); return
        set_state(uid,"savdo_pick_mah",data)
        bot.send_message(uid,
            f"🏪 {data['dokon_nomi']}\n\n📦 Mahsulot tanlang:",
            reply_markup=_mah_list_kb(data["mahsulotlar"],data["tanlangan"]))
        return
    if not txt.startswith("📍 "): return
    vil=txt.replace("📍 ","").rsplit(" (",1)[0].strip()
    data["sv_vil"]=vil
    kb,nh=_hudud_kb(uid,vil)
    set_state(uid,"savdo_hudud",data)
    bot.send_message(uid,f"📍 {vil}\n\n🏘 Hududni tanlang:",reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="savdo_hudud")
def s_savdo_hudud(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    txt=(msg.text or "").strip()
    if txt=="⬅️ Viloyatga qaytish":
        _savdo_send_vil(uid,data); return
    if not txt.startswith("🏘 "): return
    hud=txt.replace("🏘 ","").rsplit(" (",1)[0].strip()
    kb,n,page,pages=_dokon_in_hudud_kb(uid,data.get("sv_vil",""),hud)
    if n==0: bot.send_message(uid,"❗ Bu hududda faol dokon yo'q."); return
    data["sv_hud"]=hud; data["sv_page"]=page
    set_state(uid,"savdo_dokon",data)
    sahifa=f" | sahifa {page+1}/{pages}" if pages>1 else ""
    bot.send_message(uid,f"🏘 {hud} — {n} ta dokon{sahifa}\n\n🏪 Dokonni tanlang:",reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="savdo_dokon")
def s_savdo_dokon(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    txt=(msg.text or "").strip()
    # Eski viloyat→hudud oqimidan qolgan navigatsiya (sv_vil/sv_hud state'lari
    # bilan kirilgan bo'lsa ishlaydi) — yangi flat picker bilan to'qnashmaydi.
    if txt=="⬅️ Hududga qaytish" and data.get("sv_vil"):
        kb,nh=_hudud_kb(uid,data["sv_vil"])
        set_state(uid,"savdo_hudud",data)
        bot.send_message(uid,f"📍 {data['sv_vil']}\n\n🏘 Hududni tanlang:",reply_markup=kb)
        return
    if txt in ("➡️ Keyingi dokonlar","⬅️ Oldingi dokonlar") and data.get("sv_hud") is not None:
        page=data.get("sv_page",0)+(1 if txt.startswith("➡️") else -1)
        kb,n,page,pages=_dokon_in_hudud_kb(uid,data.get("sv_vil",""),data["sv_hud"],page)
        data["sv_page"]=page; set_state(uid,"savdo_dokon",data)
        bot.send_message(uid,f"🏘 {data['sv_hud']} — {n} ta dokon | sahifa {page+1}/{pages}\n\n🏪 Dokonni tanlang:",reply_markup=kb)
        return
    if not (txt.startswith("🏪 ") and "||" in txt):
        _dokon_picker_nav(uid,txt,data,"savdo_dokon")
        return
    try:
        did,dnomi=txt.replace("🏪 ","").split("||",1)
        data["dokon_id"]=int(did); data["dokon_nomi"]=dnomi
    except: return
    if not _savdo_dokon_ruxsat(uid,data["dokon_id"]):
        bot.send_message(uid,"❗ Bu dokon topilmadi yoki sizga biriktirilmagan."); return
    set_state(uid,"savdo_pick_mah",data)
    bot.send_message(uid,
        f"🏪 {data['dokon_nomi']}\n\n📦 Mahsulot tanlang:",
        reply_markup=_mah_list_kb(data["mahsulotlar"],data["tanlangan"]))

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="savdo_pick_mah")
def s_savdo_pick_mah(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    mahsulotlar=data["mahsulotlar"]
    for i,(mid,nomi,narx,birlik) in enumerate(mahsulotlar,1):
        if msg.text.startswith(f"{i}. "):
            data["cur_mid"]=mid; data["cur_nomi"]=nomi
            data["cur_narx"]=narx; data["cur_birlik"]=birlik
            set_state(uid,"savdo_miqdor",data)
            bot.send_message(uid,
                f"📦 {nomi}\n💰 Narx: {fmt(narx)}/{birlik}\n\nNechta?",
                reply_markup=cancel_kb())
            return

def _is_vehicle_distribution_pilot_user(user):
    # Yo'naltirish identiteti — users.name imlosi EMAS (prodda "Navro'zbek"
    # apostrof bilan, delivery_agents da "Navruzbek"): telegram_id ni faol
    # NAVRUZBEK + faol DM-001/DAMAS biriktiruv zanjiriga solishtiramiz —
    # sales.py dagi tranzaksion guard bilan bitta identitet manbai.
    return bool(
        os.environ.get("VEHICLE_DISTRIBUTION_ENABLED") == "1"
        and user
        and is_vehicle_pilot_seller(user[1])
    )

def _flow_pilot(uid,data):
    # Pilot qarori savdo oqimi DAVOMIDA barqaror bo'lishi shart: oqim
    # boshida pinlanadi. Aks holda biriktiruv oqim o'rtasida o'zgarsa,
    # balansni tashqarida yechish/yechmaslik qarori bilan yakuniy writer
    # tanlovi ajralib ketadi (ikki marta yechish yoki asossiz qarz
    # kamayishi). Deploy oldidan boshlangan eski oqimlar uchun fallback —
    # bir marta baholab shu yerda pinlaymiz.
    pinned=data.get("vehicle_pilot")
    if pinned is None:
        pinned=_is_vehicle_distribution_pilot_user(get_user(uid))
        data["vehicle_pilot"]=pinned
    return pinned

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="savdo_miqdor")
def s_savdo_miqdor(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    try:
        miqdor=float(msg.text.strip().replace(",","."))
        # nan (miqdor!=miqdor) va inf ham float() dan o'tadi — ikkalasi rad:
        # aks holda quyidagi round(miqdor,3) OverflowError bilan yiqiladi.
        if miqdor!=miqdor or miqdor==float("inf") or miqdor<=0: raise ValueError
    except:
        bot.send_message(uid,"❗ Iltimos, musbat son kiriting (masalan: 1.5):"); return
    if _flow_pilot(uid,data):
        # Dona mahsulot — butun son (etiketkali zaxira donada yechiladi);
        # kg mahsulot — kasr mumkin (masalan 5.7), lekin ko'pi bilan 3 xona:
        # DB qatlami (F7) ham xuddi shu chegarani qo'yadi.
        if str(data.get("cur_birlik") or "").strip().lower()=="dona":
            if not miqdor.is_integer():
                bot.send_message(uid,"❗ Dona mahsulotda miqdor faqat musbat butun son bo'lishi kerak (masalan: 3)."); return
        elif round(miqdor,3)!=miqdor:
            bot.send_message(uid,"❗ Miqdor ko'pi bilan 3 xona kasr bo'lishi mumkin (masalan: 5.775)."); return
    mid=data["cur_mid"]; nomi=data["cur_nomi"]
    narx=data["cur_narx"]; birlik=data["cur_birlik"]
    prev=data["tanlangan"].get(mid,0)
    yangi=prev+miqdor
    if _flow_pilot(uid,data):
        # float yig'indisi kasrlarda mikro-xato beradi (5.7+2.4=8.100000000000001)
        # — F7 dagi 3-xona chegarasidan o'tishi uchun shu yerda tozalaymiz.
        yangi=round(yangi,3)
    data["tanlangan"][mid]=yangi
    total_line=fmt(narx*yangi)
    set_state(uid,"savdo_next",data)
    bot.send_message(uid,
        f"✅ Qo'shildi: {nomi} ×{fmt_miq(yangi)} {birlik} × {fmt(narx)} = {total_line}\n\n"
        f"Nima qilasiz?",
        reply_markup=_next_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="savdo_next")
def s_savdo_next(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    if msg.text=="➕ Yana mahsulot qo'shish":
        set_state(uid,"savdo_pick_mah",data)
        bot.send_message(uid,"📦 Mahsulot tanlang:",
            reply_markup=_mah_list_kb(data["mahsulotlar"],data["tanlangan"]))
    elif msg.text=="✅ Savdoni yakunlash":
        tanlangan=data["tanlangan"]; mahsulotlar=data["mahsulotlar"]
        lines=[]; jami=0
        for mid,nomi,narx,birlik in mahsulotlar:
            miqdor=tanlangan.get(mid,0)
            if miqdor>0:
                summa=narx*miqdor; jami+=summa
                lines.append(f"  • {nomi}\n     {fmt_miq(miqdor)} {birlik} × {fmt(narx)} = {fmt(summa)}")
        if not lines:
            bot.send_message(uid,"❗ Hech narsa tanlanmadi!"); return
        summary=(f"🧾 BUYURTMA XULOSASI\n{'━'*24}\n"
                 f"🏪 {data['dokon_nomi']}\n\n"
                 +"\n".join(lines)+
                 f"\n{'━'*24}\n💰 Jami: {fmt(jami)}\n\n"
                 f"💳 To'lov turini tanlang:")
        set_state(uid,"savdo_tolov",data)
        bot.send_message(uid,summary,reply_markup=tolov_kb())

def _go_foto(uid,data):
    set_state(uid,"savdo_foto",data)
    bot.send_message(uid,"📸 Chek rasmini yuboring:",reply_markup=skip_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="savdo_tolov")
def s_savdo_tolov(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]; t=msg.text
    if "Naqd" in t: data["tolov"]="naqd"; _go_foto(uid,data)
    elif "Karta" in t: data["tolov"]="karta"; _go_foto(uid,data)
    elif "Nasiya" in t: data["tolov"]="nasiya"; _go_foto(uid,data)
    elif "Aralash" in t:
        data["tolov"]="aralash"; data["naqd"]=0; data["karta"]=0; data["nasiya_qism"]=0
        set_state(uid,"savdo_aralash_naqd",data)
        bot.send_message(uid,"💵 Naqd qancha? (0 bo'lsa 0 kiriting):",reply_markup=cancel_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="savdo_aralash_naqd")
def s_aralash_naqd(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    try: data["naqd"]=int(msg.text.replace(" ","").replace(",",""))
    except: bot.send_message(uid,"❗ Raqam kiriting:"); return
    set_state(uid,"savdo_aralash_karta",data)
    bot.send_message(uid,"💳 Karta qancha? (0 bo'lsa 0 kiriting):",reply_markup=cancel_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="savdo_aralash_karta")
def s_aralash_karta(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    try: data["karta"]=int(msg.text.replace(" ","").replace(",",""))
    except: bot.send_message(uid,"❗ Raqam kiriting:"); return
    set_state(uid,"savdo_aralash_nasiya",data)
    bot.send_message(uid,"📝 Nasiya qancha? (0 bo'lsa 0 kiriting):",reply_markup=cancel_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="savdo_aralash_nasiya")
def s_aralash_nasiya_h(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    try: data["nasiya_qism"]=int(msg.text.replace(" ","").replace(",",""))
    except: bot.send_message(uid,"❗ Raqam kiriting:"); return
    jami=round(sum(m[2]*data["tanlangan"].get(m[0],0) for m in data["mahsulotlar"]),3)
    n=data["naqd"]; k=data["karta"]; nas=data["nasiya_qism"]
    total=n+k+nas; diff=jami-total
    warn=""
    if diff>0: warn=f"\n⚠️ {fmt(diff)} kam kiritildi!"
    elif diff<0: warn=f"\n⚠️ {fmt(-diff)} ko'p kiritildi!"
    summary=(f"🔀 ARALASH TO'LOV\n{'━'*24}\n"
             f"💵 Naqd:   {fmt(n)}\n"
             f"💳 Karta:  {fmt(k)}\n"
             f"📝 Nasiya: {fmt(nas)}\n"
             f"{'━'*24}\n"
             f"💰 Savdo jami: {fmt(jami)}{warn}\n\n"
             f"Tasdiqlaysizmi?")
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=2)
    kb.add("✅ Tasdiqlash","🔄 Qayta kiritish"); kb.add("❌ Bekor qilish")
    set_state(uid,"savdo_aralash_tasdiq",data)
    bot.send_message(uid,summary,reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="savdo_aralash_tasdiq")
def s_aralash_tasdiq(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    if msg.text=="✅ Tasdiqlash": _go_foto(uid,data)
    elif msg.text=="🔄 Qayta kiritish":
        data["naqd"]=0; data["karta"]=0; data["nasiya_qism"]=0
        set_state(uid,"savdo_aralash_naqd",data)
        bot.send_message(uid,"💵 Naqd qancha? (0 bo'lsa 0 kiriting):",reply_markup=cancel_kb())

@bot.message_handler(content_types=["photo"],func=lambda m:get_state(m.from_user.id)["state"]=="savdo_foto")
def s_savdo_foto_p(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    data["foto"]=msg.photo[-1].file_id; _check_balans_before_save(uid,data)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="savdo_foto")
def s_savdo_foto_s(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    data["foto"]=None; _check_balans_before_save(uid,data)

def _check_balans_before_save(uid,data):
    did=data["dokon_id"]; tolov=data["tolov"]
    # MUHIM: balans yechishdan (apply_balans_delta) OLDIN ruxsat tekshiriladi —
    # aks holda rad etilgan savdo baribir mijoz balansini kamaytirib qo'yadi
    if not _dokon_ruxsat_guard(uid,did): return
    balans=get_balans(did)
    pilot=_flow_pilot(uid,data)
    if balans>0 and tolov=="nasiya":
        jami=round(sum(m[2]*data["tanlangan"].get(m[0],0) for m in data["mahsulotlar"]),3)
        deducted=min(balans,jami); yangi_balans=balans-deducted
        if not pilot: apply_balans_delta(did,-deducted)
        data["balans_ishlatildi"]=deducted; data["yangi_balans"]=yangi_balans
        bot.send_message(uid,f"✅ {fmt(deducted)} so'm balans nasiyadan ayirildi.\nQolgan balans: {fmt(yangi_balans)}")
        _save_savdo(uid,data)
    elif balans>0 and tolov=="aralash" and data.get("nasiya_qism",0)>0:
        nas=data["nasiya_qism"]; deducted=min(balans,nas); yangi_balans=balans-deducted
        if not pilot: apply_balans_delta(did,-deducted)
        data["nasiya_qism"]=nas-deducted
        data["balans_ishlatildi"]=deducted; data["yangi_balans"]=yangi_balans
        bot.send_message(uid,f"✅ {fmt(deducted)} so'm balans nasiyadan ayirildi.\nQolgan balans: {fmt(yangi_balans)}")
        _save_savdo(uid,data)
    elif balans>0 and tolov in("naqd","karta"):
        data["mavjud_balans"]=balans
        set_state(uid,"savdo_balans_confirm",data)
        kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
        kb.add("✅ Ha, ayirish","❌ Yo'q, to'liq to'lov")
        bot.send_message(uid,
            f"💰 Bu mijozda {fmt(balans)} so'm ortiqcha pul bor.\n"
            f"Tovar summasidan ayirilsinmi?",reply_markup=kb)
    else:
        _save_savdo(uid,data)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="savdo_balans_confirm")
def s_savdo_balans_confirm(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    balans=data["mavjud_balans"]
    # Balans yechishdan oldin ruxsatni qayta tekshiramiz (tanlov va tasdiq
    # orasida dokon o'chirilishi/qayta biriktirilishi mumkin)
    if not _dokon_ruxsat_guard(uid,data["dokon_id"]): return
    if msg.text=="✅ Ha, ayirish":
        jami=round(sum(m[2]*data["tanlangan"].get(m[0],0) for m in data["mahsulotlar"]),3)
        deducted=min(balans,jami); yangi_balans=balans-deducted
        if not _flow_pilot(uid,data):
            apply_balans_delta(data["dokon_id"],-deducted)
        data["balans_ishlatildi"]=deducted; data["yangi_balans"]=yangi_balans
        _save_savdo(uid,data)
    elif msg.text=="❌ Yo'q, to'liq to'lov":
        _save_savdo(uid,data)

TOLOV_LABEL={"naqd":"💵 Naqd","karta":"💳 Karta","nasiya":"📝 Nasiya","aralash":"🔀 Aralash"}

def _tolov_info_str(data):
    tolov=data["tolov"]
    if tolov=="aralash":
        return (f"\n💵 Naqd: {fmt(data.get('naqd',0))}"
                f"\n💳 Karta: {fmt(data.get('karta',0))}"
                f"\n📝 Nasiya: {fmt(data.get('nasiya_qism',0))}")
    return f"\n{TOLOV_LABEL.get(tolov,tolov)}"

def _save_savdo(uid,data):
    user=get_user(uid)
    # Yakuniy yozish nuqtasi — dokon egaligini shu yerda ham tekshiramiz.
    # MUHIM: bu nuqtaga kelguncha balans allaqachon yechilgan bo'lishi mumkin
    # (_check_balans_before_save / savdo_balans_confirm). Ruxsat rad etilsa,
    # yechilgan balans qaytariladi — aks holda mijoz savdo yozuvisiz pul yo'qotadi.
    pilot=_flow_pilot(uid,data)
    # Yozishdan oldin yangidan tekshiramiz: biriktiruv savdo DAVOMIDA
    # o'zgargan bo'lsa, writerni almashtirish TAQIQ — pinned=False yo'lda
    # balans allaqachon tashqarida yechilgan (pilot writer ikkinchi marta
    # yechardi), pinned=True yo'lda esa yechilmagan (oddiy writer qarzni
    # asossiz kamaytirardi). Mos kelmasa: pulni qaytarib, aniq xato bilan
    # bekor qilamiz — jim noto'g'ri yo'ldan yozish yo'q.
    fresh=_is_vehicle_distribution_pilot_user(user)
    if fresh!=pilot:
        deducted=data.get("balans_ishlatildi",0)
        if deducted>0 and not pilot:
            apply_balans_delta(data["dokon_id"],deducted)
            data["balans_ishlatildi"]=0
        clear_state(uid)
        bot.send_message(uid,
            "❗ Savdo saqlanmadi: mashina biriktiruvi savdo davomida o'zgardi.\n"
            "Iltimos, savdoni boshidan qaytadan kiriting.",
            reply_markup=main_kb(user[3] if user else None,uid))
        return
    if not _dokon_ruxsat_guard(uid,data["dokon_id"],user):
        deducted=data.get("balans_ishlatildi",0)
        if deducted>0 and not pilot:
            apply_balans_delta(data["dokon_id"],deducted)
        return
    jami=round(sum(m[2]*data["tanlangan"].get(m[0],0) for m in data["mahsulotlar"]),3)
    tolov=data["tolov"]
    items=[]; lines=[]
    for m in data["mahsulotlar"]:
        mid,nomi,narx,birlik=m; miqdor=data["tanlangan"].get(mid,0)
        if miqdor>0:
            items.append((mid,miqdor,narx))
            lines.append(f"  • {nomi}\n     {fmt_miq(miqdor)} {birlik} × {fmt(narx)} = {fmt(narx*miqdor)}")
    nasiya_summa=0
    balans_ishlatildi=data.get("balans_ishlatildi",0)
    if tolov=="nasiya": nasiya_summa=max(0,jami-balans_ishlatildi)
    elif tolov=="aralash": nasiya_summa=data.get("nasiya_qism",0)
    # Bitta tranzaksiyada: savdo + tafsilot + repeat statistika + revisit + nasiya
    try:
        if pilot:
            # F7: balance + both schemas use the same psycopg2 transaction.
            # operation_key was created once at flow start and is preserved in
            # state across save retries/duplicate Telegram delivery.
            sid,owner_tg,jami_nasiya_qoldiq=create_vehicle_pilot_sale(
                data["dokon_id"],uid,items,jami,tolov,data.get("foto"),
                nasiya_summa,data["operation_key"],balans_ishlatildi,
                {"naqd":data.get("naqd",0),"karta":data.get("karta",0),
                 "nasiya":data.get("nasiya_qism",nasiya_summa)})
        else:
            sid,owner_tg,jami_nasiya_qoldiq=create_sale(
                data["dokon_id"],uid,items,jami,tolov,data.get("foto"),nasiya_summa)
    except VehiclePilotSaleError as exc:
        # Keep state and operation key intact so a corrected/retried delivery
        # cannot accidentally create a second sale.
        bot.send_message(uid,"❗ Savdo saqlanmadi: "+str(exc))
        return
    clear_state(uid)
    tolov_str=_tolov_info_str(data)
    foto_id=data.get("foto")
    yangi_balans=data.get("yangi_balans",None)
    balans_line=""
    if balans_ishlatildi>0:
        balans_line=f"\n💰 Balans ishlatildi: -{fmt(balans_ishlatildi)}"
        if yangi_balans is not None:
            balans_line+=f"\n💳 Qolgan balans: {fmt(yangi_balans)}"
    bot.send_message(uid,"✅ Savdo saqlandi!\n\n🏪 "+data["dokon_nomi"]+"\n"+"\n".join(lines)+f"\n\n💰 Jami: {fmt(jami)}"+tolov_str+balans_line,reply_markup=main_kb(user[3],uid))
    # Admin notification — forward photo if present
    admin_text=(f"📦 Yangi savdo!\n\n"
                f"👤 Agent: {user[2]}\n"
                f"📍 Viloyat: {user[4]}\n"
                f"🏪 Dokon: {data['dokon_nomi']}\n\n"
                f"🛍 Mahsulotlar:\n"+"\n".join(lines)+
                f"\n\n💰 Jami: {fmt(jami)}"+tolov_str+balans_line)
    try:
        if foto_id:
            for aid in all_admin_ids():
                try: bot.send_photo(aid,foto_id,caption=admin_text)
                except: pass
        else:
            for aid in all_admin_ids():
                try: bot.send_message(aid,admin_text)
                except: pass
    except: pass
    # Owner receipt
    if owner_tg:
        nasiya_line=""
        if nasiya_summa>0:
            nasiya_line=(f"\n📝 Nasiya: {fmt(nasiya_summa)}"
                         f"\n🔴 Umumiy nasiya qoldig'i: {fmt(jami_nasiya_qoldiq)}")
        receipt=(f"🧾 SAVDO CHEKI\n{'━'*26}\n"
                 f"🏪 Dokon: {data['dokon_nomi']}\n"
                 f"📅 Sana: {now[:10]}\n\n"
                 f"🛍 Mahsulotlar:\n"+"\n".join(lines)+
                 f"\n\n💰 Jami: {fmt(jami)}"+tolov_str+nasiya_line+balans_line)
        try: bot.send_message(owner_tg,receipt)
        except: pass
        if balans_ishlatildi>0:
            try: bot.send_message(owner_tg,f"✅ {fmt(balans_ishlatildi)} so'm balans ishlatildi.\nQolgan balans: {fmt(yangi_balans or 0)}")
            except: pass
    # F11: pilot marshruti to'liq yopilgan bo'lsa — avto MASHINA HISOBOTI
    _vehicle_route_end_check(uid)

@bot.message_handler(func=lambda m:m.text=="💰 Pul olish")
def pul_olish(msg):
    uid=msg.from_user.id; user=get_user(uid)
    if not user: return
    if check_pending(uid): return
    conn=get_db();c=conn.cursor()
    if user[3]=="delivery":
        # Delivery agent: bugungi marshrut dokonlaridan pul olish
        dlv=_get_delivery_agent_by_tid(uid)
        if not dlv:
            conn.close(); bot.send_message(uid,"❗ Bog'lanish topilmadi."); return
        kun=_today_kun()
        if not kun:
            conn.close(); bot.send_message(uid,"😴 Bugun Juma — dam olish kuni. Marshrut yo'q."); return
        c.execute("""SELECT d.id,d.nomi FROM delivery_routes r
                     JOIN dokonlar d ON d.id=r.dokon_id
                     WHERE r.delivery_agent_id=%s AND r.kun=%s AND d.holat='faol'
                     ORDER BY r.tartib""",(dlv[0],kun))
    else:
        conn.close()
        kb,total,shown,page=_dokon_page_kb(uid,page=0,row_width=1)
        if total==0: bot.send_message(uid,"❗ Faol dokon yo'q."); return
        set_state(uid,"pul_dokon",{"dokon_page":page})
        bot.send_message(uid,_dokon_page_text(total,shown,page),reply_markup=kb)
        return
    dokonlar=c.fetchall(); conn.close()
    if not dokonlar: bot.send_message(uid,"❗ Faol dokon yo'q."); return
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    for d in dokonlar: kb.add(f"🏪 {d[0]}||{d[1]}")
    kb.add("❌ Bekor qilish")
    set_state(uid,"pul_dokon",{})
    bot.send_message(uid,"🏪 Dokonni tanlang.\n🔎 Ro'yxatda yo'q bo'lsa, nomini yozib yuboring — qidirib beraman:",reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="pul_dokon")
def s_pul_dokon(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    if not msg.text.startswith("🏪 "):
        _dokon_picker_nav(uid,msg.text,data,"pul_dokon",row_width=1)
        return
    try:
        did,dnomi=msg.text.replace("🏪 ","").split("||",1)
        data["dokon_id"]=int(did); data["dokon_nomi"]=dnomi
    except: return
    if not _savdo_dokon_ruxsat(uid,data["dokon_id"]):
        bot.send_message(uid,"❗ Bu dokon topilmadi yoki sizga biriktirilmagan."); return
    conn=get_db();c=conn.cursor()
    c.execute("SELECT COALESCE(SUM(qoldiq),0) FROM nasiya WHERE dokon_id=%s AND agent_id=%s AND qoldiq>0",(int(did),uid))
    nasiya_qoldiq=c.fetchone()[0]; conn.close()
    if nasiya_qoldiq>0:
        data["nasiya_qoldiq"]=nasiya_qoldiq
        set_state(uid,"pul_nasiya_choice",data)
        kb2=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
        kb2.add("✅ Ha, nasiyaga hisoblash","💰 Yo'q, oddiy pul olish","❌ Bekor qilish")
        bot.send_message(uid,
            f"🏪 {dnomi}\n"
            f"🔴 Joriy nasiya: {fmt(nasiya_qoldiq)}\n\n"
            f"Bu to'lov nasiyaga hisoblansinmi?",
            reply_markup=kb2)
    else:
        set_state(uid,"pul_summa",data)
        bot.send_message(uid,f"💰 {dnomi}\nQancha pul oldingiz?",reply_markup=cancel_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="pul_nasiya_choice")
def s_pul_nasiya_choice(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    if msg.text=="✅ Ha, nasiyaga hisoblash":
        set_state(uid,"pul_nasiya_summa",data)
        bot.send_message(uid,
            f"🏪 {data['dokon_nomi']}\n"
            f"🔴 Nasiya qoldiq: {fmt(data['nasiya_qoldiq'])}\n\n"
            f"Qancha pul oldingiz?",
            reply_markup=cancel_kb())
    elif msg.text=="💰 Yo'q, oddiy pul olish":
        set_state(uid,"pul_summa",data)
        bot.send_message(uid,f"💰 {data['dokon_nomi']}\nQancha pul oldingiz?",reply_markup=cancel_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="pul_nasiya_summa")
def s_pul_nasiya_summa(msg):
    uid=msg.from_user.id; user=get_user(uid); data=get_state(uid)["data"]
    try:
        summa=int(msg.text.replace(" ","").replace(",",""))
        if summa<=0: raise ValueError
    except: bot.send_message(uid,"❗ Musbat raqam kiriting:"); return
    did=data["dokon_id"]; dnomi=data["dokon_nomi"]; nasiya_qoldiq=data["nasiya_qoldiq"]
    if summa>nasiya_qoldiq:
        ortiqcha=summa-nasiya_qoldiq
        data["ortiqcha_summa"]=summa; data["ortiqcha_diff"]=ortiqcha
        set_state(uid,"pul_nasiya_ortiqcha_confirm",data)
        kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
        kb.add("✅ Tasdiqlash","✏️ Summani to'g'irlash")
        bot.send_message(uid,
            f"⚠️ Siz {fmt(nasiya_qoldiq)}ga qarshi {fmt(summa)} kiritdingiz.\n"
            f"{fmt(ortiqcha)} so'm ORTIQCHA.\n\nTasdiqlaysizmi?",reply_markup=kb); return
    if not _dokon_ruxsat_guard(uid,did,user): return
    pay_nasiya_fifo(did,uid,summa)
    clear_state(uid)
    yangi_qoldiq=nasiya_qoldiq-summa
    nasiya_status="✅ Nasiya to'liq to'landi!" if yangi_qoldiq<=0 else f"🔴 Qolgan nasiya: {fmt(yangi_qoldiq)}"
    bot.send_message(uid,
        f"✅ Pul olish saqlandi!\n\n"
        f"🏪 {dnomi}\n"
        f"💵 Olingan summa: {fmt(summa)}\n"
        f"💳 Nasiyaga hisoblandi: {fmt(summa)}\n"
        f"{nasiya_status}",
        reply_markup=main_kb(user[3],uid))
    for aid in all_admin_ids():
        try: bot.send_message(aid,
            f"💰 Pul olindi (nasiyaga)!\n\n"
            f"👤 Agent: {user[2]}\n📍 {user[4]}\n"
            f"🏪 Dokon: {dnomi}\n"
            f"💵 Summa: {fmt(summa)}\n"
            f"💳 Nasiyaga: {fmt(summa)}\n"
            f"🔴 Qoldiq: {fmt(yangi_qoldiq)}")
        except: pass

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="pul_nasiya_ortiqcha_confirm")
def s_pul_nasiya_ortiqcha_confirm(msg):
    uid=msg.from_user.id; user=get_user(uid); data=get_state(uid)["data"]
    if msg.text=="✏️ Summani to'g'irlash":
        set_state(uid,"pul_nasiya_summa",data)
        bot.send_message(uid,
            f"🏪 {data['dokon_nomi']}\n"
            f"🔴 Nasiya qoldiq: {fmt(data['nasiya_qoldiq'])}\n\n"
            f"Qancha pul oldingiz?",reply_markup=cancel_kb()); return
    if msg.text!="✅ Tasdiqlash": return
    summa=data["ortiqcha_summa"]; nasiya_qoldiq=data["nasiya_qoldiq"]; ortiqcha=data["ortiqcha_diff"]
    did=data["dokon_id"]; dnomi=data["dokon_nomi"]
    if not _dokon_ruxsat_guard(uid,did,user): return
    owner_tg=pay_nasiya_fifo(did,uid,summa,apply_amount=nasiya_qoldiq,ortiqcha=ortiqcha)
    clear_state(uid)
    bot.send_message(uid,
        f"✅ Pul olish saqlandi!\n\n"
        f"🏪 {dnomi}\n"
        f"💵 Olingan summa: {fmt(summa)}\n"
        f"💳 Nasiyaga hisoblandi: {fmt(nasiya_qoldiq)}\n"
        f"✅ Nasiya to'liq to'landi!\n"
        f"💰 Ortiqcha balansga yozildi: +{fmt(ortiqcha)}",
        reply_markup=main_kb(user[3],uid))
    for aid in all_admin_ids():
        try: bot.send_message(aid,
            f"💰 Pul olindi (ortiqcha)!\n\n"
            f"👤 Agent: {user[2]}\n📍 {user[4]}\n"
            f"🏪 Dokon: {dnomi}\n"
            f"💵 Summa: {fmt(summa)}\n"
            f"💳 Nasiyaga: {fmt(nasiya_qoldiq)}\n"
            f"💰 Ortiqcha balans: +{fmt(ortiqcha)}")
        except: pass
    if owner_tg:
        try: bot.send_message(owner_tg,f"💰 Sizda {fmt(ortiqcha)} so'm ortiqcha to'lov bor.\nKeyingi tovardan ayiriladi.")
        except: pass

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="pul_summa")
def s_pul_summa(msg):
    uid=msg.from_user.id; user=get_user(uid); data=get_state(uid)["data"]
    try: summa=int(msg.text.replace(" ","").replace(",",""))
    except: bot.send_message(uid,"❗ Raqam kiriting: 500000"); return
    if not _dokon_ruxsat_guard(uid,data["dokon_id"],user): return
    record_pul_olish(data["dokon_id"],uid,summa)
    clear_state(uid)
    bot.send_message(uid,f"✅ Pul olish saqlandi!\n🏪 {data['dokon_nomi']}\n💰 {fmt(summa)}",reply_markup=main_kb(user[3],uid))
    for aid in all_admin_ids():
        try: bot.send_message(aid,
            f"💰 Pul olindi!\n\n"
            f"👤 Agent: {user[2]}\n"
            f"📍 Viloyat: {user[4]}\n"
            f"🏪 Dokon: {data['dokon_nomi']}\n"
            f"💵 Summa: {fmt(summa)}")
        except: pass

def _nasiya_summary_kb(uid, admin_view=False):
    """Step 1: returns (summary_text, store_keyboard) for nasiya.
    admin_view=True → barcha agentlar bo'yicha (admin uchun).
    Aks holda — faqat uid agent o'zinikini ko'radi."""
    conn=get_db();c=conn.cursor()
    if admin_view:
        c.execute("""SELECT d.id,d.nomi,COALESCE(SUM(n.qoldiq),0),COALESCE(u.name,'—')
                     FROM nasiya n JOIN dokonlar d ON d.id=n.dokon_id
                     LEFT JOIN users u ON u.telegram_id=n.agent_id
                     WHERE n.qoldiq>0
                     GROUP BY d.id,d.nomi,u.name ORDER BY SUM(n.qoldiq) DESC""")
        store_rows=c.fetchall()
        c.execute("SELECT COUNT(*) FROM dokonlar WHERE holat='faol'")
        jami_dokon=c.fetchone()[0]
    else:
        c.execute("""SELECT d.id,d.nomi,COALESCE(SUM(n.qoldiq),0),''
                     FROM nasiya n JOIN dokonlar d ON d.id=n.dokon_id
                     WHERE n.agent_id=%s AND n.qoldiq>0
                     GROUP BY d.id,d.nomi ORDER BY d.nomi""",(uid,))
        store_rows=c.fetchall()
        c.execute("SELECT COUNT(*) FROM dokonlar WHERE agent_id=%s AND holat='faol'",(uid,))
        jami_dokon=c.fetchone()[0]
    conn.close()
    nasiyali_d=len(store_rows)
    nasiyasiz_d=max(0,jami_dokon-nasiyali_d)
    jami_qoldiq=sum(r[2] for r in store_rows)
    title="🗂 NASIYA BOSHQARUV (BARCHA AGENTLAR)" if admin_view else "🗂 NASIYA BOSHQARUV"
    text=(f"{title}\n{'━'*26}\n"
          f"🔴 Jami nasiya: {fmt(jami_qoldiq)}\n"
          f"🏪 Nasiyali dokonlar: {nasiyali_d} ta\n"
          f"✅ Nasiyasiz dokonlar: {nasiyasiz_d} ta")
    if admin_view and store_rows:
        text+=f"\n\n📋 TOP nasiyali dokonlar:\n"
        for did,dnomi,qoldiq,aname in store_rows[:15]:
            text+=f"  • {dnomi} ({aname}) — {fmt(qoldiq)}\n"
        if len(store_rows)>15:
            text+=f"  … +{len(store_rows)-15} ta dokon"
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    if not admin_view:
        for did,dnomi,qoldiq,_ in store_rows:
            kb.add(f"🏪 {did}||{dnomi}")
    kb.add("❌ Bekor qilish")
    return text,kb,store_rows

def _show_nasiya_store(uid,did,dnomi):
    """Step 2: show full sale history for one store."""
    conn=get_db();c=conn.cursor()
    c.execute("""SELECT n.id,n.jami_summa,n.tolangan,n.qoldiq,n.created_at
                 FROM nasiya n WHERE n.dokon_id=%s AND n.agent_id=%s
                 ORDER BY n.created_at""",(did,uid))
    rows=c.fetchall(); conn.close()
    jami_savdo=sum(r[1] for r in rows)
    jami_qoldiq=sum(r[3] for r in rows)
    text=f"🏪 {dnomi}\n{'━'*26}\n\n📊 Savdo tarixi:\n"
    for nid,jami,tolangan,qoldiq,created_at in rows:
        try: sana=created_at[:10]
        except: sana="—"
        if qoldiq==0:
            text+=f"  • {sana} | {fmt(jami)} | ✅ To'liq to'langan\n"
        else:
            text+=f"  • {sana} | {fmt(jami)} | 🔴 Qoldiq: {fmt(qoldiq)}\n"
    text+=(f"\n{'━'*26}\n"
           f"💰 Umumiy savdo: {fmt(jami_savdo)}\n"
           f"🔴 Jami qarz: {fmt(jami_qoldiq)}")
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    if jami_qoldiq>0:
        kb.add("💳 To'lov qabul qilish")
    kb.add("⬅️ Orqaga"); kb.add("❌ Bekor qilish")
    return text,kb,jami_qoldiq

@bot.message_handler(func=lambda m:m.text=="💳 Nasiya boshqaruv")
def nasiya_boshqaruv(msg):
    uid=msg.from_user.id; user=get_user(uid)
    if not user: return
    if check_pending(uid): return
    admin_view=is_admin(uid)
    text,kb,store_rows=_nasiya_summary_kb(uid, admin_view=admin_view)
    if not store_rows:
        bot.send_message(uid,text+"\n\n✅ Nasiya qarz yo'q!",reply_markup=main_kb(user[3],uid)); return
    if admin_view:
        # Admin faqat ko'radi — to'lov qabul qilish agentniki
        bot.send_message(uid,text,reply_markup=main_kb(user[3],uid)); return
    set_state(uid,"nasiya_store_list",{})
    bot.send_message(uid,text,reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="nasiya_store_list")
def s_nasiya_store_list(msg):
    uid=msg.from_user.id
    if not msg.text.startswith("🏪 "): return
    try:
        parts=msg.text[2:].strip().split("||")
        did=int(parts[0]); dnomi=parts[1]
    except: return
    text,kb,jami_qoldiq=_show_nasiya_store(uid,did,dnomi)
    set_state(uid,"nasiya_store_detail",{"did":did,"dnomi":dnomi,"jami_qoldiq":jami_qoldiq})
    bot.send_message(uid,text,reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="nasiya_store_detail")
def s_nasiya_store_detail(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    if msg.text=="⬅️ Orqaga":
        text,kb,store_rows=_nasiya_summary_kb(uid)
        set_state(uid,"nasiya_store_list",{})
        bot.send_message(uid,text,reply_markup=kb); return
    if msg.text=="💳 To'lov qabul qilish":
        dnomi=data["dnomi"]; jami_qoldiq=data["jami_qoldiq"]
        set_state(uid,"nasiya_tolov",data)
        bot.send_message(uid,
            f"🏪 {dnomi}\n🔴 Jami qarz: {fmt(jami_qoldiq)}\n\n"
            f"Qancha to'lov qabul qildingiz?\n"
            f"(To'liq to'lash uchun: {fmt(jami_qoldiq)})",
            reply_markup=cancel_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="nasiya_tolov")
def s_nasiya_tolov(msg):
    uid=msg.from_user.id; user=get_user(uid); data=get_state(uid)["data"]
    try:
        summa=int(msg.text.replace(" ","").replace(",",""))
        if summa<=0: raise ValueError
    except: bot.send_message(uid,"❗ Musbat raqam kiriting:"); return
    did=data["did"]; dnomi=data["dnomi"]; jami_qoldiq=data["jami_qoldiq"]
    if summa>jami_qoldiq:
        ortiqcha=summa-jami_qoldiq
        data["ortiqcha_summa"]=summa; data["ortiqcha_diff"]=ortiqcha
        set_state(uid,"nasiya_tolov_ortiqcha_confirm",data)
        kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
        kb.add("✅ Tasdiqlash","✏️ Summani to'g'irlash")
        bot.send_message(uid,
            f"⚠️ Siz {fmt(jami_qoldiq)}ga qarshi {fmt(summa)} kiritdingiz.\n"
            f"{fmt(ortiqcha)} so'm ORTIQCHA.\n\nTasdiqlaysizmi?",reply_markup=kb); return
    # FIFO: eng eski qarzdan boshlab yopiladi (bitta tranzaksiyada)
    if not _dokon_ruxsat_guard(uid,did,user): return
    pay_nasiya_fifo(did,uid,summa)
    yangi_qoldiq=jami_qoldiq-summa
    status="✅ Barcha qarz to'liq to'landi!" if yangi_qoldiq<=0 else f"🔴 Qolgan qarz: {fmt(yangi_qoldiq)}"
    bot.send_message(uid,
        f"✅ To'lov qabul qilindi!\n\n"
        f"🏪 {dnomi}\n"
        f"💵 Qabul qilindi: {fmt(summa)}\n"
        f"{status}",
        reply_markup=main_kb(user[3],uid))
    clear_state(uid)
    for aid in all_admin_ids():
        try: bot.send_message(aid,
            f"💳 Nasiya to'lovi!\n\n"
            f"👤 Agent: {user[2]}\n📍 {user[4]}\n"
            f"🏪 Dokon: {dnomi}\n"
            f"💵 To'landi: {fmt(summa)}\n"
            f"🔴 Qoldiq: {fmt(yangi_qoldiq)}")
        except: pass

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="nasiya_tolov_ortiqcha_confirm")
def s_nasiya_tolov_ortiqcha_confirm(msg):
    uid=msg.from_user.id; user=get_user(uid); data=get_state(uid)["data"]
    if msg.text=="✏️ Summani to'g'irlash":
        set_state(uid,"nasiya_tolov",data)
        bot.send_message(uid,
            f"🏪 {data['dnomi']}\n🔴 Jami qarz: {fmt(data['jami_qoldiq'])}\n\n"
            f"Qancha to'lov qabul qildingiz?\n(To'liq: {fmt(data['jami_qoldiq'])})",
            reply_markup=cancel_kb()); return
    if msg.text!="✅ Tasdiqlash": return
    summa=data["ortiqcha_summa"]; jami_qoldiq=data["jami_qoldiq"]; ortiqcha=data["ortiqcha_diff"]
    did=data["did"]; dnomi=data["dnomi"]
    if not _dokon_ruxsat_guard(uid,did,user): return
    owner_tg=pay_nasiya_fifo(did,uid,summa,apply_amount=jami_qoldiq,ortiqcha=ortiqcha)
    clear_state(uid)
    bot.send_message(uid,
        f"✅ To'lov qabul qilindi!\n\n"
        f"🏪 {dnomi}\n"
        f"💵 Qabul qilindi: {fmt(summa)}\n"
        f"✅ Barcha qarz to'liq to'landi!\n"
        f"💰 Ortiqcha balansga yozildi: +{fmt(ortiqcha)}",
        reply_markup=main_kb(user[3],uid))
    for aid in all_admin_ids():
        try: bot.send_message(aid,
            f"💳 Nasiya to'lovi (ortiqcha)!\n\n"
            f"👤 Agent: {user[2]}\n📍 {user[4]}\n"
            f"🏪 Dokon: {dnomi}\n"
            f"💵 To'landi: {fmt(summa)}\n"
            f"✅ Qarz: to'liq to'landi\n"
            f"💰 Ortiqcha balans: +{fmt(ortiqcha)}")
        except: pass
    if owner_tg:
        try: bot.send_message(owner_tg,f"💰 Sizda {fmt(ortiqcha)} so'm ortiqcha to'lov bor.\nKeyingi tovardan ayiriladi.")
        except: pass

SABAB_MAP={"💸 Narx qimmat":"narx_qimmat","📦 Hozir tovari bor":"tovari_bor","🏢 Boshqa firma":"boshqa_firma","😕 Sifat yoqmadi":"sifat","🚪 Egasi yo'q edi":"egasi_yoq","🕐 Keyin keling dedi":"keyin_keling","🚫 Sotilmaydi dedi":"sotilmaydi","📝 Boshqa sabab":"boshqa"}

@bot.message_handler(func=lambda m:m.text=="❌ Tovar olmadi")
def tovar_olmadi(msg):
    uid=msg.from_user.id; user=get_user(uid)
    if not user: return
    if check_pending(uid): return
    conn=get_db();c=conn.cursor()
    if user[3]=="delivery":
        dlv=_get_delivery_agent_by_tid(uid)
        if not dlv:
            conn.close(); bot.send_message(uid,"❗ Bog'lanish topilmadi."); return
        kun=_today_kun()
        if not kun:
            conn.close(); bot.send_message(uid,"😴 Bugun Juma — dam olish kuni. Marshrut yo'q."); return
        c.execute("""SELECT d.id,d.nomi FROM delivery_routes r
                     JOIN dokonlar d ON d.id=r.dokon_id
                     WHERE r.delivery_agent_id=%s AND r.kun=%s AND d.holat='faol'
                     ORDER BY r.tartib""",(dlv[0],kun))
        dokonlar=c.fetchall(); conn.close()
        if not dokonlar:
            bot.send_message(uid,f"📭 Bugun ({day_name(kun)}) marshrutda dokon yo'q."); return
        kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
        for d in dokonlar: kb.add(f"🏪 {d[0]}||{d[1]}")
        kb.add("❌ Bekor qilish")
        set_state(uid,"olmadi_dokon",{})
        bot.send_message(uid,f"🚚 BUGUN — {day_name(kun)}\n🏪 Qaysi dokon tovar olmadi?",reply_markup=kb); return
    conn.close()
    kb,total,shown,page=_dokon_page_kb(uid,page=0,faol_only=False,
                                       extra_buttons=["🆕 Yangi dokon (olmagan)"],row_width=1)
    set_state(uid,"olmadi_dokon",{"dokon_page":page})
    bot.send_message(uid,_dokon_page_text(total,shown,page),reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="olmadi_dokon")
def s_olmadi_dokon(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    if msg.text=="🆕 Yangi dokon (olmagan)":
        set_state(uid,"olmadi_yangi_nomi",data)
        bot.send_message(uid,"Dokon nomini kiriting:",reply_markup=cancel_kb()); return
    if not msg.text.startswith("🏪 "):
        _dokon_picker_nav(uid,msg.text,data,"olmadi_dokon",faol_only=False,
                          extra_buttons=["🆕 Yangi dokon (olmagan)"],row_width=1)
        return
    try:
        did,dnomi=msg.text.replace("🏪 ","").split("||",1)
        data["dokon_id"]=int(did); data["dokon_nomi"]=dnomi
    except: return
    set_state(uid,"olmadi_sabab",data)
    bot.send_message(uid,f"❓ {dnomi} — sababi:",reply_markup=sabab_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="olmadi_yangi_nomi")
def s_olmadi_yangi_nomi(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    data["dokon_id"]=None; data["dokon_nomi"]=msg.text.strip()
    set_state(uid,"olmadi_yangi_egasi",data)
    bot.send_message(uid,"👤 Egasining ismi:",reply_markup=skip_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="olmadi_yangi_egasi")
def s_olmadi_yangi_egasi(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    data["egasi"]="" if msg.text=="⏭ O'tkazib yuborish" else msg.text.strip()
    set_state(uid,"olmadi_yangi_tel",data)
    bot.send_message(uid,"📞 Telefon raqami:",reply_markup=skip_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="olmadi_yangi_tel")
def s_olmadi_yangi_tel(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    data["telefon"]="" if msg.text=="⏭ O'tkazib yuborish" else msg.text.strip()
    # Yangi dokon: sabab so'ramaymiz, to'g'ri qaytish sanasiga o'tamiz
    data["sabab"]="yangi_dokon"; data["sabab_text"]="🆕 Yangi olmagan dokon"
    set_state(uid,"olmadi_qaytish",data)
    bot.send_message(uid,"📅 Qaytib kirish sanasi (masalan: 25.05.2026):",reply_markup=cancel_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="olmadi_sabab")
def s_olmadi_sabab(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    sabab=SABAB_MAP.get(msg.text)
    if not sabab: bot.send_message(uid,"❗ Sababni tanlang"); return
    data["sabab"]=sabab; data["sabab_text"]=msg.text
    set_state(uid,"olmadi_qaytish",data)
    bot.send_message(uid,"📅 Qaytib kirish sanasi (masalan: 25.05.2026):",reply_markup=cancel_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="olmadi_qaytish")
def s_olmadi_qaytish(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    data["qaytish_sanasi"]=msg.text.strip()
    set_state(uid,"olmadi_location",data)
    bot.send_message(uid,"📍 Location yuboring:",reply_markup=location_kb())

@bot.message_handler(content_types=["location"],func=lambda m:get_state(m.from_user.id)["state"]=="olmadi_location")
def s_olmadi_loc(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    data["lat"]=msg.location.latitude; data["lon"]=msg.location.longitude
    _record_agent_location(uid,data["lat"],data["lon"],"olmadi")
    set_state(uid,"olmadi_foto",data)
    bot.send_message(uid,"📸 Dokon rasmini yuboring:",reply_markup=skip_kb())

@bot.message_handler(content_types=["photo"],func=lambda m:get_state(m.from_user.id)["state"]=="olmadi_foto")
def s_olmadi_foto_p(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    data["foto"]=msg.photo[-1].file_id
    _olmadi_confirm(uid,data)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="olmadi_foto")
def s_olmadi_foto_s(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    if msg.text!="⏭ O'tkazib yuborish": return
    data["foto"]=None
    _olmadi_confirm(uid,data)

def _olmadi_confirm(uid,data):
    set_state(uid,"olmadi_confirm",data)
    lat=data.get("lat"); lon=data.get("lon")
    maps_line=f"\n🗺 Location: https://maps.google.com/?q={lat},{lon}" if lat and lon else ""
    text=(f"📋 TASDIQLANG:\n{'━'*24}\n"
          f"🏪 Dokon: {data['dokon_nomi']}\n")
    if data.get("dokon_id") is None:
        text+=f"👤 Egasi: {data.get('egasi') or '—'}\n📞 Tel: {data.get('telefon') or '—'}\n"
    text+=(f"❌ Sabab: {data['sabab_text']}\n"
           f"📅 Qaytish: {data.get('qaytish_sanasi','—')}"
           f"{maps_line}\n"
           f"📸 Rasm: {'✅ bor' if data.get('foto') else '—'}\n"
           f"{'━'*24}\nYubormoqchimisiz?")
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=2)
    kb.add("✅ Tasdiqlash","❌ Bekor qilish")
    bot.send_message(uid,text,reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="olmadi_confirm")
def s_olmadi_confirm(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    if msg.text=="✅ Tasdiqlash":
        _save_olmadi(uid,data)
    elif msg.text=="❌ Bekor qilish":
        user=get_user(uid); clear_state(uid)
        bot.send_message(uid,"❌ Bekor qilindi",reply_markup=main_kb(user[3],uid))

def _save_olmadi(uid,data):
    user=get_user(uid); conn=get_db(); c=conn.cursor()
    dokon_id=data.get("dokon_id")
    egasi=""; telefon=""
    if dokon_id is None:
        egasi=data.get("egasi",""); telefon=data.get("telefon","")
        c.execute("INSERT INTO dokonlar (nomi,egasi,telefon,viloyat,latitude,longitude,foto,agent_id,holat,created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                  (data["dokon_nomi"],egasi,telefon,user[4],data.get("lat"),data.get("lon"),data.get("foto"),uid,"nofaol",datetime.now().isoformat()))
        dokon_id=c.fetchone()[0]
    else:
        c.execute("SELECT egasi,telefon FROM dokonlar WHERE id=%s",(dokon_id,))
        r=c.fetchone()
        if r: egasi,telefon=r[0] or "",r[1] or ""
    c.execute("INSERT INTO olmagan_dokonlar (dokon_id,agent_id,sabab,sabab_text,latitude,longitude,qaytish_sanasi,foto,created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
              (dokon_id,uid,data["sabab"],data["sabab_text"],data.get("lat"),data.get("lon"),data.get("qaytish_sanasi"),data.get("foto"),datetime.now().isoformat()))
    conn.commit();conn.close();clear_state(uid)
    qaytish=f"\n📅 Qaytish: {data.get('qaytish_sanasi','')}" if data.get("qaytish_sanasi") else ""
    bot.send_message(uid,f"✅ Yozildi!\n🏪 {data['dokon_nomi']}\n❌ {data['sabab_text']}{qaytish}",reply_markup=main_kb(user[3],uid))
    lat=data.get("lat"); lon=data.get("lon")
    maps_line=f"\n🗺 Location: https://maps.google.com/?q={lat},{lon}" if lat and lon else ""
    caption=(f"🔔 Tovar olmadi / Qaytib kirish\n\n"
             f"🏪 {data['dokon_nomi']}\n"
             f"👤 Egasi: {egasi or '—'}\n"
             f"📞 Tel: {telefon or '—'}"
             f"{maps_line}\n"
             f"❌ Sabab: {data['sabab_text']}"
             f"{qaytish}\n"
             f"👤 Agent: {user[2]} | 📍 {user[4]}")
    for aid in all_admin_ids():
        try:
            if data.get("foto"):
                bot.send_photo(aid,data["foto"],caption=caption)
            else:
                bot.send_message(aid,caption)
        except: pass
    # F11: pilot marshruti to'liq yopilgan bo'lsa — avto MASHINA HISOBOTI
    _vehicle_route_end_check(uid)

@bot.message_handler(func=lambda m:m.text=="📋 Qaytib kirish kerak")
def qaytib_kirish(msg):
    uid=msg.from_user.id; user=get_user(uid)
    if not user: return
    if check_pending(uid): return
    conn=get_db();c=conn.cursor()
    c.execute("""SELECT d.nomi,d.egasi,d.telefon,o.sabab_text,o.qaytish_sanasi,o.id,o.latitude,o.longitude
        FROM olmagan_dokonlar o JOIN dokonlar d ON o.dokon_id=d.id
        WHERE o.agent_id=%s AND o.bajarildi=0 AND o.qaytish_sanasi IS NOT NULL
        ORDER BY o.qaytish_sanasi""",(uid,))
    rows=c.fetchall();conn.close()
    if not rows: bot.send_message(uid,"✅ Qaytib kirish kerak bo'lgan dokon yo'q!",reply_markup=main_kb(user[3],uid)); return
    text="📋 Qaytib kirish kerak:\n\n"
    for r in rows:
        nomi,egasi,telefon,sabab_text,qaytish_sanasi,oid,lat,lon=r
        maps=""
        if lat and lon: maps=f"\n🗺 https://maps.google.com/?q={lat},{lon}"
        text+=(f"🏪 {nomi}\n"
               f"👤 {egasi or '—'}\n"
               f"📞 {telefon or '—'}"
               f"{maps}\n"
               f"❌ {sabab_text}\n"
               f"📅 {qaytish_sanasi}\n"
               f"✅ /bajarildi_{oid}\n\n")
    bot.send_message(uid,text,reply_markup=main_kb(user[3],uid))

@bot.message_handler(commands=["bajarildi"])
def bajarildi(msg):
    uid=msg.from_user.id
    try:
        oid=int(msg.text.split("_")[1])
        conn=get_db();c=conn.cursor()
        c.execute("UPDATE olmagan_dokonlar SET bajarildi=1 WHERE id=%s AND agent_id=%s",(oid,uid))
        conn.commit();conn.close()
        bot.send_message(uid,"✅ Bajarildi!")
    except: bot.send_message(uid,"❗ Xato")

TOLOV_LABELS={"naqd":"Naqd ✅","karta":"Karta ✅","nasiya":"Nasiya 🔴","aralash":"Aralash 🔀"}

# ───────────── QIDIRUV (dokon/mijoz) ─────────────
@bot.message_handler(func=lambda m:m.text=="🔍 Qidiruv")
def qidiruv_start(msg):
    uid=msg.from_user.id
    user=get_user(uid)
    if not user: return
    set_state(uid,"qidiruv_input",{"role":user[3]})
    bot.send_message(uid,
        "🔍 QIDIRUV\n\nDokon nomi, egasi yoki telefon raqamini kiriting:\n"
        "Masalan: <code>Fayz</code> yoki <code>Akmal</code> yoki <code>998901234567</code>",
        parse_mode="HTML",reply_markup=cancel_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="qidiruv_input")
def qidiruv_query(msg):
    uid=msg.from_user.id
    q=(msg.text or "").strip()
    if not q or q=="❌ Bekor qilish":
        user=get_user(uid)
        set_state(uid,None,{})
        bot.send_message(uid,"Bekor qilindi",reply_markup=main_kb(user[3] if user else "agent",uid)); return
    if len(q)<2:
        bot.send_message(uid,"❗ Kamida 2 ta belgi kiriting."); return
    user=get_user(uid); role=user[3]
    conn=get_db();c=conn.cursor()
    if role=="admin":
        c.execute("SELECT id,nomi,egasi,viloyat,holat,telefon FROM dokonlar ORDER BY nomi")
    else:
        c.execute("SELECT id,nomi,egasi,viloyat,holat,telefon FROM dokonlar WHERE agent_id=%s ORDER BY nomi",(uid,))
    allrows=c.fetchall(); conn.close()
    nq=_norm_text(q)
    rows=[d for d in allrows
          if nq in _norm_text(d[1]) or (d[2] and nq in _norm_text(d[2]))
          or (d[5] and q in str(d[5]))][:50]
    if not rows:
        # Yaqin variantlarni taklif qilish (imlo xatolariga chidamli)
        sugg=_dokon_suggestions([(d[0],d[1],d[2]) for d in allrows],q)
        if sugg:
            disp={d:label for d,label in sugg}
            srows=[d for d in allrows if d[0] in disp]
            kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
            for d in srows:
                icon="✅" if d[4]=="faol" else "❌"
                kb.add(f"🏪{d[0]}||{disp.get(d[0],d[1])} ({d[3] or '—'}) {icon}")
            kb.add("❌ Bekor qilish")
            set_state(uid,"admin_dokon_list" if role=="admin" else "agent_dokon_search_list",{})
            bot.send_message(uid,f"❓ '{q}' aniq topilmadi. Balki shulardan birini nazarda tutgandirsiz:",reply_markup=kb)
            return
        bot.send_message(uid,f"❌ '{q}' bo'yicha hech narsa topilmadi.",reply_markup=main_kb(role,uid)); 
        set_state(uid,None,{}); return
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    for d in rows:
        icon="✅" if d[4]=="faol" else "❌"
        # Egasi bo'yicha mos kelgan bo'lsa — tugmada egasi ismini ham ko'rsatamiz
        label=f"{d[1]} — {d[2]}" if (d[2] and nq in _norm_text(d[2])) else d[1]
        kb.add(f"🏪{d[0]}||{label} ({d[3] or '—'}) {icon}")
    kb.add("❌ Bekor qilish")
    if role=="admin":
        set_state(uid,"admin_dokon_list",{})
    else:
        set_state(uid,"agent_dokon_search_list",{})
    bot.send_message(uid,f"🔍 Topildi: {len(rows)} ta\n\nDokonni tanlang:",reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="agent_dokon_search_list")
def s_agent_dokon_view(msg):
    uid=msg.from_user.id
    if not msg.text.startswith("🏪"):
        if msg.text=="❌ Bekor qilish":
            user=get_user(uid); set_state(uid,None,{})
            bot.send_message(uid,"Bekor qilindi",reply_markup=main_kb(user[3],uid))
        return
    try: did=int(msg.text[1:].split("||")[0])
    except: return
    conn=get_db();c=conn.cursor()
    c.execute("""SELECT id,nomi,egasi,telefon,viloyat,hudud,latitude,longitude,foto,holat,
                 last_order_date,total_orders,total_sales
                 FROM dokonlar WHERE id=%s AND agent_id=%s""",(did,uid))
    d=c.fetchone()
    if not d:
        conn.close(); bot.send_message(uid,"❗ Topilmadi yoki sizniki emas."); return
    c.execute("SELECT created_at,jami_summa,tolov_turi FROM savdolar WHERE dokon_id=%s ORDER BY created_at DESC LIMIT 5",(did,))
    savdolar=c.fetchall()
    c.execute("SELECT COALESCE(SUM(qoldiq),0) FROM nasiya WHERE dokon_id=%s AND qoldiq>0",(did,))
    jami_nasiya=c.fetchone()[0]
    conn.close()
    (_,nomi,egasi,telefon,viloyat,hudud,lat,lon,foto,holat,last_d,total_o,total_s)=d
    holat_txt="✅ Faol" if holat=="faol" else "❌ Nofaol"
    text=(f"🏪 {nomi}  {holat_txt}\n{'━'*26}\n"
          f"👤 Egasi: {egasi or '—'}\n"
          f"📞 Telefon: {telefon or '—'}\n"
          f"📍 {viloyat or '—'} | {hudud or '—'}\n")
    if lat and lon: text+=f"🗺 https://maps.google.com/?q={lat},{lon}\n"
    text+=f"\n{'━'*26}\n📊 OXIRGI 5 SAVDO:\n"
    for s in savdolar:
        sana=s[0][:10] if s[0] else "—"
        tl=TOLOV_LABELS.get(s[2],s[2] or "—")
        text+=f"  • {sana} | {fmt(s[1])} | {tl}\n"
    if not savdolar: text+="  — Savdo yo'q\n"
    text+=(f"\n{'━'*26}\n"
           f"💰 Jami savdo: {fmt(total_s or 0)}\n"
           f"📦 Jami order: {total_o or 0}\n"
           f"🔴 Jami nasiya: {fmt(jami_nasiya)}\n"
           f"📅 Oxirgi: "+(last_d[:10] if last_d else "—"))
    set_state(uid,None,{})
    user=get_user(uid)
    kb=main_kb(user[3],uid)
    if foto:
        try: bot.send_photo(uid,foto,caption=text,reply_markup=kb); return
        except: pass
    bot.send_message(uid,text,reply_markup=kb)

@bot.message_handler(func=lambda m:m.text=="👥 Mijozlar bazasi")
def mijozlar_bazasi(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    conn=get_db();c=conn.cursor()
    c.execute("SELECT COUNT(*) FROM dokonlar"); jami=c.fetchone()[0]
    c.execute("SELECT id,nomi,viloyat,holat FROM dokonlar ORDER BY nomi LIMIT 60")
    dokonlar=c.fetchall(); conn.close()
    if not dokonlar: bot.send_message(uid,"❗ Dokonlar yo'q."); return
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    kb.add("🔍 Dokon qidirish")
    for d in dokonlar:
        icon="✅" if d[3]=="faol" else "❌"
        kb.add(f"🏪{d[0]}||{d[1]} ({d[2]}) {icon}")
    kb.add("❌ Bekor qilish")
    set_state(uid,"admin_dokon_list",{})
    bot.send_message(uid,f"👥 Mijozlar bazasi — {jami} ta dokon:\n\nDokonni tanlang yoki qidiring:",reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="admin_dokon_list")
def s_admin_dokon_list(msg):
    uid=msg.from_user.id
    if msg.text=="🔍 Dokon qidirish":
        set_state(uid,"baza_qidiruv_input",{})
        bot.send_message(uid,
            "🔍 DOKON QIDIRISH\n\nDokon nomi, egasi, telefon yoki hudud kiriting:\n"
            "Masalan: <code>Fayz</code> yoki <code>Chust</code> yoki <code>998901234567</code>",
            parse_mode="HTML",reply_markup=cancel_kb()); return
    if not msg.text.startswith("🏪"): return
    try: did=int(msg.text[1:].split("||")[0])
    except: return
    conn=get_db();c=conn.cursor()
    c.execute("""SELECT id,nomi,egasi,telefon,viloyat,hudud,latitude,longitude,foto,holat,
                 first_order_date,last_order_date,total_orders,repeat_orders,total_sales,avg_repeat_days
                 FROM dokonlar WHERE id=%s""",(did,))
    d=c.fetchone()
    if not d: conn.close(); return
    c.execute("SELECT created_at,jami_summa,tolov_turi FROM savdolar WHERE dokon_id=%s ORDER BY created_at DESC LIMIT 7",(did,))
    savdolar=c.fetchall()
    c.execute("SELECT COALESCE(SUM(jami_summa),0) FROM savdolar WHERE dokon_id=%s",(did,))
    jami_savdo=c.fetchone()[0]
    c.execute("SELECT COALESCE(SUM(qoldiq),0) FROM nasiya WHERE dokon_id=%s AND qoldiq>0",(did,))
    jami_nasiya=c.fetchone()[0]
    c.execute("SELECT COALESCE(balans,0) FROM mijoz_balans WHERE dokon_id=%s",(did,))
    row2=c.fetchone(); mijoz_bal=row2[0] if row2 else 0
    conn.close()
    (_,nomi,egasi,telefon,viloyat,hudud,lat,lon,foto,holat,
     first_d,last_d,total_o,repeat_o,total_s,avg_d)=d
    total_o=total_o or 0; repeat_o=repeat_o or 0; total_s=total_s or 0; avg_d=avg_d or 0.0
    status_lbl,days_since=get_store_status(last_d,avg_d)
    maps_link=f"https://maps.google.com/?q={lat},{lon}" if lat and lon else None
    holat_txt="✅ Faol" if holat=="faol" else "❌ Nofaol"
    text=(f"🏪 {nomi}  {holat_txt}\n{'━'*26}\n"
          f"👤 Egasi: {egasi or '—'}\n"
          f"📞 Telefon: {telefon or '—'}\n"
          f"📍 {viloyat or '—'} | {hudud or '—'}\n")
    if maps_link: text+=f"🗺 Location: {maps_link}\n"
    text+=f"\n{'━'*26}\n📊 SAVDO TARIXI:\n"
    for s in savdolar:
        try: sana=s[0][:10]
        except: sana="—"
        tl=TOLOV_LABELS.get(s[2],s[2] or "—")
        text+=f"  • {sana} | {fmt(s[1])} | {tl}\n"
    if not savdolar: text+="  — Savdo yo'q\n"
    text+=(f"\n{'━'*26}\n"
           f"💰 Jami savdo: {fmt(jami_savdo)}\n"
           f"🔴 Jami nasiya: {fmt(jami_nasiya)}")
    if mijoz_bal>0:
        text+=f"\n💰 Mijoz balansi: +{fmt(mijoz_bal)} (ortiqcha to'lov)"
    text+=(f"\n{'━'*26}\n🔁 REPEAT TAHLIL:\n"
           f"📦 Jami order: {total_o}\n"
           f"🔁 Repeat order: {repeat_o}\n"
           f"⏳ O'rtacha qaytish: {round(avg_d)} kun\n"
           f"📅 Oxirgi: "+(last_d[:10] if last_d else '—')+
           (f" ({days_since} kun oldin)" if days_since is not None else "")+
           f"\n🔥 Status: {status_lbl}")
    set_state(uid,"admin_dokon_view",{"did":did,"nomi":nomi})
    back_kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=2)
    back_kb.add("🗑 Dokonni o'chirish")
    back_kb.add("👥 Mijozlar bazasi","❌ Bekor qilish")
    if foto:
        try: bot.send_photo(uid,foto,caption=text,reply_markup=back_kb); return
        except: pass
    bot.send_message(uid,text,reply_markup=back_kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="baza_qidiruv_input")
def s_baza_qidiruv(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    q=(msg.text or "").strip()
    if len(q)<2:
        bot.send_message(uid,"❗ Kamida 2 ta belgi kiriting:"); return
    conn=get_db();c=conn.cursor()
    like=f"%{q}%"
    c.execute("""SELECT id,nomi,viloyat,holat FROM dokonlar
                 WHERE nomi ILIKE %s OR egasi ILIKE %s OR telefon ILIKE %s OR hudud ILIKE %s
                 ORDER BY nomi LIMIT 60""",(like,like,like,like))
    rows=c.fetchall(); conn.close()
    if not rows:
        bot.send_message(uid,f"❌ '{q}' bo'yicha hech narsa topilmadi.\n\nQaytadan kiriting yoki bekor qiling:",reply_markup=cancel_kb()); return
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    kb.add("🔍 Dokon qidirish")
    for d in rows:
        icon="✅" if d[3]=="faol" else "❌"
        kb.add(f"🏪{d[0]}||{d[1]} ({d[2] or '—'}) {icon}")
    kb.add("❌ Bekor qilish")
    set_state(uid,"admin_dokon_list",{})
    bot.send_message(uid,f"🔍 Topildi: {len(rows)} ta\n\nDokonni tanlang:",reply_markup=kb)

@bot.message_handler(func=lambda m:m.text=="🗑 Dokonni o'chirish" and get_state(m.from_user.id)["state"]=="admin_dokon_view")
def dokon_ochir_start(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    data=get_state(uid)["data"]; did=data.get("did")
    if not did: return
    conn=get_db();c=conn.cursor()
    c.execute("SELECT COUNT(*),COALESCE(SUM(jami_summa),0) FROM savdolar WHERE dokon_id=%s",(did,))
    sv_n,sv_sum=c.fetchone()
    c.execute("SELECT COALESCE(SUM(qoldiq),0) FROM nasiya WHERE dokon_id=%s AND qoldiq>0",(did,))
    nas=c.fetchone()[0]
    conn.close()
    set_state(uid,"admin_dokon_delete_confirm",data)
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True)
    kb.add("✅ HA, O'CHIRISH"); kb.add("❌ Bekor qilish")
    warn=(f"⚠️ DIQQAT! Dokonni o'chirmoqchimisiz?\n\n"
          f"🏪 {data['nomi']}\n\n"
          f"Quyidagilar HAM o'chiriladi:\n"
          f"  • {sv_n} ta savdo ({fmt(sv_sum)})\n"
          f"  • Barcha nasiya yozuvlari (qoldiq: {fmt(nas)})\n"
          f"  • Pul olish tarixi\n"
          f"  • Olmagan/qaytib kirish yozuvlari\n"
          f"  • Mijoz balansi\n\n"
          f"❗ Bu amalni QAYTARIB BO'LMAYDI!")
    bot.send_message(uid,warn,reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="admin_dokon_delete_confirm")
def dokon_ochir_tasdiq(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    if msg.text!="✅ HA, O'CHIRISH":
        clear_state(uid)
        user=get_user(uid)
        bot.send_message(uid,"❌ Bekor qilindi",reply_markup=main_kb(user[3],uid)); return
    did=data["did"]; nomi=data["nomi"]
    conn=get_db();c=conn.cursor()
    try:
        c.execute("DELETE FROM savdo_tafsilot WHERE savdo_id IN (SELECT id FROM savdolar WHERE dokon_id=%s)",(did,))
        c.execute("DELETE FROM savdolar WHERE dokon_id=%s",(did,))
        c.execute("DELETE FROM nasiya WHERE dokon_id=%s",(did,))
        c.execute("DELETE FROM pul_olish WHERE dokon_id=%s",(did,))
        c.execute("DELETE FROM olmagan_dokonlar WHERE dokon_id=%s",(did,))
        c.execute("DELETE FROM revisitlar WHERE dokon_id=%s",(did,))
        c.execute("DELETE FROM mijoz_balans WHERE dokon_id=%s",(did,))
        c.execute("DELETE FROM dokonlar WHERE id=%s",(did,))
        conn.commit()
    except Exception as e:
        conn.close(); clear_state(uid)
        bot.send_message(uid,f"❗ Xato: {e}"); return
    conn.close(); clear_state(uid)
    user=get_user(uid)
    bot.send_message(uid,f"✅ '{nomi}' dokoni va barcha tarixi o'chirildi.",reply_markup=main_kb(user[3],uid))
    # Notify other admins
    for aid in all_admin_ids():
        if aid==uid: continue
        try: bot.send_message(aid,f"🗑 Admin {user[2]} '{nomi}' dokonini o'chirdi.")
        except: pass

@bot.message_handler(func=lambda m:m.text=="👤 Agent boshqaruv")
def agent_boshqaruv(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    _agent_boshqaruv_list(uid)

def _agent_boshqaruv_list(uid):
    conn=get_db();c=conn.cursor()
    c.execute("SELECT telegram_id,name,viloyat,role FROM users WHERE role IN ('agent','supervisor','blok') ORDER BY name")
    agents=c.fetchall(); conn.close()
    if not agents: bot.send_message(uid,"Agentlar yo'q."); return
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    for a in agents:
        icon="⭐" if a[3]=="supervisor" else ("🚫" if a[3]=="blok" else "🔰")
        kb.add(f"{icon}{a[0]}||{a[1]} ({a[2]})")
    kb.add("❌ Bekor qilish")
    set_state(uid,"agent_boshqaruv_list",{})
    bot.send_message(uid,f"👤 Agentlar ({len(agents)} ta):\nTanlang:",reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="agent_boshqaruv_list")
def s_agent_boshqaruv_list(msg):
    uid=msg.from_user.id
    if not (msg.text.startswith("🔰") or msg.text.startswith("⭐") or msg.text.startswith("🚫")): return
    try: tid=int(msg.text[1:].split("||")[0])
    except: return
    _show_agent_profile(uid,tid)

def _show_agent_profile(uid,agent_id):
    conn=get_db();c=conn.cursor()
    c.execute("SELECT telegram_id,name,viloyat,role,created_at FROM users WHERE telegram_id=%s",(agent_id,))
    a=c.fetchone()
    if not a: conn.close(); return
    c.execute("SELECT COUNT(*) FROM dokonlar WHERE agent_id=%s AND holat='faol'",(agent_id,))
    dokon_n=c.fetchone()[0]
    c.execute("SELECT COALESCE(SUM(jami_summa),0) FROM savdolar WHERE agent_id=%s",(agent_id,))
    jami_savdo=c.fetchone()[0]
    c.execute("SELECT COALESCE(SUM(qoldiq),0) FROM nasiya WHERE agent_id=%s AND qoldiq>0",(agent_id,))
    jami_nasiya=c.fetchone()[0]
    c.execute("SELECT COUNT(*) FROM olmagan_dokonlar WHERE agent_id=%s AND bajarildi=0 AND qaytish_sanasi IS NOT NULL",(agent_id,))
    qaytib=c.fetchone()[0]; conn.close()
    rol_map={"agent":"Agent","supervisor":"Supervisor","blok":"🚫 Bloklangan"}
    rol_txt=rol_map.get(a[3],a[3]); sana=a[4][:10] if a[4] else "—"
    text=(f"👤 AGENT: {a[1]}\n{'━'*26}\n"
          f"📍 Viloyat: {a[2]}\n"
          f"🔰 Rol: {rol_txt}\n"
          f"📅 Ro'yxat: {sana}\n\n"
          f"🏪 Dokonlar: {dokon_n} ta\n"
          f"📦 Jami savdo: {fmt(jami_savdo)}\n"
          f"🔴 Jami nasiya: {fmt(jami_nasiya)}\n"
          f"📋 Qaytib kirish kerak: {qaytib} ta")
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=2)
    if a[3]=="agent": kb.add("🔼 Supervisorga ko'tarish")
    elif a[3]=="supervisor": kb.add("🔽 Agentga tushirish")
    if a[3]!="blok": kb.add("🚫 Bloklash")
    else: kb.add("✅ Blokdan chiqarish")
    kb.add("📊 Batafsil statistika")
    kb.add("🗑 To'liq o'chirish")
    kb.add("◀️ Orqaga","❌ Bekor qilish")
    set_state(uid,"agent_action",{"agent_id":agent_id,"agent_name":a[1],"agent_role":a[3]})
    bot.send_message(uid,text,reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="agent_action")
def s_agent_action(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    agent_id=data["agent_id"]; agent_name=data["agent_name"]
    if msg.text=="◀️ Orqaga":
        _agent_boshqaruv_list(uid); return
    if msg.text in("🔼 Supervisorga ko'tarish","🔽 Agentga tushirish"):
        new_role="supervisor" if "ko'tarish" in msg.text else "agent"
        conn=get_db();c=conn.cursor()
        c.execute("UPDATE users SET role=%s WHERE telegram_id=%s",(new_role,agent_id))
        conn.commit();conn.close()
        label="Supervisor" if new_role=="supervisor" else "Agent"
        bot.send_message(uid,f"✅ {agent_name} → {label} qilindi.")
        try: bot.send_message(agent_id,f"ℹ️ Sizning rolingiz o'zgartirildi: {label}")
        except: pass
        _show_agent_profile(uid,agent_id); return
    if msg.text=="🚫 Bloklash":
        conn=get_db();c=conn.cursor()
        c.execute("UPDATE users SET role='blok' WHERE telegram_id=%s",(agent_id,))
        conn.commit();conn.close()
        bot.send_message(uid,f"🚫 {agent_name} bloklandi.")
        try: bot.send_message(agent_id,"🚫 Sizning akkauntingiz bloklandi. Admin bilan bog'laning.")
        except: pass
        _show_agent_profile(uid,agent_id); return
    if msg.text=="✅ Blokdan chiqarish":
        conn=get_db();c=conn.cursor()
        c.execute("UPDATE users SET role='agent' WHERE telegram_id=%s",(agent_id,))
        conn.commit();conn.close()
        bot.send_message(uid,f"✅ {agent_name} blokdan chiqarildi.")
        try: bot.send_message(agent_id,"✅ Akkauntingiz faollashtirildi. /start bosing.")
        except: pass
        _show_agent_profile(uid,agent_id); return
    if msg.text=="📊 Batafsil statistika":
        _agent_batafsil(uid,agent_id,agent_name); return
    if msg.text=="🗑 To'liq o'chirish":
        # Count what would be deleted
        conn=get_db();c=conn.cursor()
        c.execute("SELECT COUNT(*) FROM dokonlar WHERE agent_id=%s",(agent_id,))
        d_n=c.fetchone()[0]
        c.execute("SELECT COUNT(*),COALESCE(SUM(jami_summa),0) FROM savdolar WHERE agent_id=%s",(agent_id,))
        s_n,s_sum=c.fetchone()
        c.execute("SELECT COUNT(*),COALESCE(SUM(qoldiq),0) FROM nasiya WHERE agent_id=%s AND qoldiq>0",(agent_id,))
        n_n,n_sum=c.fetchone()
        conn.close()
        kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
        kb.add("✅ HA, BUTUNLAY O'CHIR")
        kb.add("◀️ Orqaga")
        set_state(uid,"agent_delete_confirm",data)
        bot.send_message(uid,
            f"⚠️ DIQQAT — TO'LIQ O'CHIRISH\n{'━'*26}\n"
            f"👤 {agent_name}\n\n"
            f"Quyidagilar ham o'chiriladi:\n"
            f"🏪 Dokonlar: {d_n} ta\n"
            f"📦 Savdolar: {s_n} ta ({fmt(s_sum)})\n"
            f"🔴 Faol nasiyalar: {n_n} ta ({fmt(n_sum)})\n"
            f"📋 Revisit, ❌ tovar olmadi, 🎯 reja, 💰 pul olish — barchasi\n\n"
            f"❗ BU AMAL QAYTARIB BO'LMAYDI!",
            reply_markup=kb)
        return

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="agent_delete_confirm")
def s_agent_delete_confirm(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    agent_id=data["agent_id"]; agent_name=data["agent_name"]
    if msg.text=="◀️ Orqaga":
        _show_agent_profile(uid,agent_id); return
    if msg.text!="✅ HA, BUTUNLAY O'CHIR": return
    conn=get_db();c=conn.cursor()
    # Collect dokon ids to also clean dependent rows
    c.execute("SELECT id FROM dokonlar WHERE agent_id=%s",(agent_id,))
    dokon_ids=[r[0] for r in c.fetchall()]
    if dokon_ids:
        ph=",".join(["%s"]*len(dokon_ids))
        c.execute(f"DELETE FROM savdo_tafsilot WHERE savdo_id IN (SELECT id FROM savdolar WHERE dokon_id IN ({ph}))",dokon_ids)
        c.execute(f"DELETE FROM savdolar WHERE dokon_id IN ({ph})",dokon_ids)
        c.execute(f"DELETE FROM nasiya WHERE dokon_id IN ({ph})",dokon_ids)
        c.execute(f"DELETE FROM pul_olish WHERE dokon_id IN ({ph})",dokon_ids)
        c.execute(f"DELETE FROM mijoz_balans WHERE dokon_id IN ({ph})",dokon_ids)
        c.execute(f"DELETE FROM olmagan_dokonlar WHERE dokon_id IN ({ph})",dokon_ids)
        c.execute(f"DELETE FROM revisitlar WHERE dokon_id IN ({ph})",dokon_ids)
        c.execute(f"DELETE FROM delivery_routes WHERE dokon_id IN ({ph})",dokon_ids)
    # Also drop any rows tied to agent_id directly (in case dokons were reassigned)
    c.execute("DELETE FROM savdo_tafsilot WHERE savdo_id IN (SELECT id FROM savdolar WHERE agent_id=%s)",(agent_id,))
    c.execute("DELETE FROM savdolar WHERE agent_id=%s",(agent_id,))
    c.execute("DELETE FROM nasiya WHERE agent_id=%s",(agent_id,))
    c.execute("DELETE FROM pul_olish WHERE agent_id=%s",(agent_id,))
    c.execute("DELETE FROM olmagan_dokonlar WHERE agent_id=%s",(agent_id,))
    c.execute("DELETE FROM revisitlar WHERE agent_id=%s",(agent_id,))
    c.execute("DELETE FROM agent_plans WHERE agent_id=%s",(agent_id,))
    c.execute("DELETE FROM dokonlar WHERE agent_id=%s",(agent_id,))
    c.execute("DELETE FROM users WHERE telegram_id=%s",(agent_id,))
    conn.commit(); conn.close()
    try: bot.send_message(agent_id,"🗑 Sizning akkauntingiz va barcha ma'lumotlaringiz tizimdan to'liq o'chirildi.")
    except: pass
    set_state(uid,None,{})
    bot.send_message(uid,f"✅ {agent_name} va u bilan bog'liq barcha ma'lumotlar o'chirildi.",reply_markup=main_kb("admin"))

def _agent_batafsil(uid,agent_id,agent_name):
    conn=get_db();c=conn.cursor()
    c.execute("""SELECT substr(created_at,1,7) as oy,COALESCE(SUM(jami_summa),0),COUNT(*)
        FROM savdolar WHERE agent_id=%s GROUP BY oy ORDER BY oy DESC LIMIT 6""",(agent_id,))
    oylar=c.fetchall()
    c.execute("SELECT COALESCE(SUM(jami_summa),0),COUNT(*) FROM savdolar WHERE agent_id=%s AND substr(created_at,1,10)=%s",(agent_id,date.today().isoformat()))
    bugungi_s,bugungi_n=c.fetchone()
    c.execute("SELECT COUNT(*) FROM dokonlar WHERE agent_id=%s AND holat='faol'",(agent_id,))
    dokon_n=c.fetchone()[0]
    c.execute("SELECT COALESCE(SUM(qoldiq),0) FROM nasiya WHERE agent_id=%s AND qoldiq>0",(agent_id,))
    nasiya=c.fetchone()[0]; conn.close()
    text=(f"📊 {agent_name} — Batafsil\n{'━'*26}\n"
          f"🏪 Faol dokonlar: {dokon_n} ta\n"
          f"🔴 Nasiya qoldig'i: {fmt(nasiya)}\n"
          f"💰 Bugungi savdo: {fmt(bugungi_s)} ({bugungi_n} ta)\n\n"
          f"📅 Oylik savdolar:\n")
    for oy,summa,n in oylar: text+=f"  • {oy}: {fmt(summa)} ({n} ta)\n"
    if not oylar: text+="  — Savdo yo'q\n"
    bot.send_message(uid,text)

# ── BROADCAST ────────────────────────────────────────────────
def _broadcast_audience_kb():
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    kb.add("👥 Barcha agentlarga")
    kb.add("🏪 Barcha dokon egalariga")
    kb.add("👤 Hammaga (agentlar + egalar)")
    kb.add("❌ Bekor qilish")
    return kb

@bot.message_handler(func=lambda m:m.text=="📢 Xabar yuborish")
def broadcast_start(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    set_state(uid,"broadcast_audience",{})
    bot.send_message(uid,"📢 Kimga yubormoqchisiz?",reply_markup=_broadcast_audience_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="broadcast_audience")
def s_broadcast_audience(msg):
    uid=msg.from_user.id
    options={"👥 Barcha agentlarga","🏪 Barcha dokon egalariga","👤 Hammaga (agentlar + egalar)"}
    if msg.text not in options: return
    set_state(uid,"broadcast_text",{"audience":msg.text})
    bot.send_message(uid,
        f"✏️ Xabar matnini yozing:\n_(u yuboriladi: {msg.text})_",
        reply_markup=cancel_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="broadcast_text",
                     content_types=["text","photo","document","video","audio"])
def s_broadcast_text(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    audience=data["audience"]; clear_state(uid)
    conn=get_db();c=conn.cursor()

    recipients=set()
    if audience in("👥 Barcha agentlarga","👤 Hammaga (agentlar + egalar)"):
        c.execute("SELECT telegram_id FROM users WHERE role IN ('agent','supervisor')")
        for r in c.fetchall(): recipients.add(r[0])
    if audience in("🏪 Barcha dokon egalariga","👤 Hammaga (agentlar + egalar)"):
        c.execute("SELECT DISTINCT owner_telegram_id FROM dokonlar WHERE owner_telegram_id IS NOT NULL")
        for r in c.fetchall(): recipients.add(r[0])
    conn.close()

    if not recipients:
        bot.send_message(uid,"❗ Yuborish uchun foydalanuvchi topilmadi.",reply_markup=main_kb("admin")); return

    bot.send_message(uid,f"⏳ {len(recipients)} ta foydalanuvchiga yuborilmoqda...")

    ok=0; fail=0
    for tid in recipients:
        if tid==uid: continue
        try:
            if msg.content_type=="text":
                bot.send_message(tid,msg.text)
            elif msg.content_type=="photo":
                bot.send_photo(tid,msg.photo[-1].file_id,caption=msg.caption or "")
            elif msg.content_type=="document":
                bot.send_document(tid,msg.document.file_id,caption=msg.caption or "")
            elif msg.content_type=="video":
                bot.send_video(tid,msg.video.file_id,caption=msg.caption or "")
            elif msg.content_type=="audio":
                bot.send_audio(tid,msg.audio.file_id,caption=msg.caption or "")
            ok+=1
        except: fail+=1

    report=(f"📢 Xabar yuborish yakunlandi!\n{'━'*26}\n"
            f"✅ Muvaffaqiyatli: {ok} ta\n"
            f"❌ Xato (blok/o'chgan): {fail} ta\n"
            f"👤 Jami: {ok+fail} ta")
    bot.send_message(uid,report,reply_markup=main_kb("admin"))

def _davr_kb():
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=2)
    kb.add("📆 Bugun","📆 Bu hafta")
    kb.add("📆 Bu oy","📆 O'tgan oy")
    kb.add("📆 O'tgan hafta","🗓 Boshqa sana")
    kb.add("❌ Bekor qilish"); return kb

def _parse_davr(text):
    """Returns (date_from, date_to, label) for a period button."""
    from calendar import monthrange
    today=date.today()
    if text=="📆 Bugun":
        d=today.isoformat(); return d,d,"Bugun"
    if text=="📆 Bu hafta":
        mon=(today-timedelta(days=today.weekday())).isoformat()
        return mon,today.isoformat(),"Bu hafta"
    if text=="📆 Bu oy":
        return today.strftime("%Y-%m-01"),today.isoformat(),"Bu oy"
    if text=="📆 O'tgan oy":
        if today.month==1: y,m=today.year-1,12
        else: y,m=today.year,today.month-1
        last=monthrange(y,m)[1]
        s=f"{y}-{m:02d}"; return f"{s}-01",f"{s}-{last}",f"O'tgan oy ({s})"
    if text=="📆 O'tgan hafta":
        mon=today-timedelta(days=today.weekday()+7)
        sun=mon+timedelta(days=6)
        return mon.isoformat(),sun.isoformat(),"O'tgan hafta"
    return None,None,None

def _send_umumiy_stat(uid,d_from,d_to,label):
    conn=get_db();c=conn.cursor()
    c.execute("SELECT COUNT(*) FROM dokonlar WHERE holat='faol'"); jami_d=c.fetchone()[0]
    c.execute("SELECT COUNT(*) FROM users WHERE role IN ('agent','supervisor')"); jami_a=c.fetchone()[0]
    c.execute("SELECT COALESCE(SUM(jami_summa),0),COUNT(*) FROM savdolar WHERE substr(created_at,1,10) BETWEEN %s AND %s",(d_from,d_to))
    jami_savdo,savdo_n=c.fetchone()
    c.execute("SELECT COALESCE(SUM(summa),0) FROM pul_olish WHERE substr(created_at,1,10) BETWEEN %s AND %s",(d_from,d_to))
    jami_pul=c.fetchone()[0]
    c.execute("""SELECT d.viloyat,COALESCE(SUM(s.jami_summa),0)
        FROM savdolar s JOIN dokonlar d ON s.dokon_id=d.id
        WHERE substr(s.created_at,1,10) BETWEEN %s AND %s
        GROUP BY d.viloyat ORDER BY 2 DESC""",(d_from,d_to)); vs=c.fetchall()
    c.execute("""SELECT sabab_text,COUNT(*) FROM olmagan_dokonlar
        WHERE substr(created_at,1,10) BETWEEN %s AND %s
        GROUP BY sabab_text ORDER BY COUNT(*) DESC LIMIT 5""",(d_from,d_to)); sab=c.fetchall()
    c.execute("SELECT COALESCE(SUM(qoldiq),0) FROM nasiya WHERE qoldiq>0"); jami_nasiya=c.fetchone()[0]
    c.execute("SELECT COUNT(DISTINCT dokon_id) FROM nasiya WHERE qoldiq>0"); nasiyali_d=c.fetchone()[0]
    nasiyasiz_d=max(0,jami_d-nasiyali_d)
    c.execute("""SELECT d.viloyat,COALESCE(SUM(n.qoldiq),0) FROM nasiya n
        JOIN dokonlar d ON d.id=n.dokon_id WHERE n.qoldiq>0 GROUP BY d.viloyat"""); nv=c.fetchall()
    conn.close()
    text=(f"📈 UMUMIY STAT — {label}\n{'━'*26}\n"
          f"🏪 Faol dokonlar: {jami_d} ta\n"
          f"👥 Agentlar: {jami_a} ta\n\n"
          f"💰 Savdo: {fmt(jami_savdo)} ({savdo_n} ta)\n"
          f"💵 Pul olish: {fmt(jami_pul)}\n\n"
          f"📍 Viloyatlar:\n")
    for v in vs: text+=f"  • {v[0]}: {fmt(v[1])}\n"
    if not vs: text+="  — Ma'lumot yo'q\n"
    text+=(f"\n💳 NASIYA HOLATI (joriy)\n{'━'*26}\n"
           f"🔴 Jami nasiya: {fmt(jami_nasiya)}\n"
           f"🏪 Nasiyali dokonlar: {nasiyali_d} ta\n"
           f"✅ Nasiyasiz dokonlar: {nasiyasiz_d} ta\n\n"
           f"📍 Viloyatlar nasiyasi:\n")
    nasiya_map={r[0]:r[1] for r in nv}
    for v,_ in vs:
        n_sum=nasiya_map.get(v,0)
        if n_sum>0: text+=f"  • {v}: {fmt(n_sum)}\n"
    if not nv: text+="  — Nasiya yo'q\n"
    text+="\n❌ Olmagan sabablar:\n"
    for s in sab: text+=f"  • {s[0]}: {s[1]} ta\n"
    if not sab: text+="  — Ma'lumot yo'q\n"
    bot.send_message(uid,text)

@bot.message_handler(func=lambda m:m.text=="📈 Umumiy stat")
def umumiy_stat(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    set_state(uid,"stat_davr",{})
    bot.send_message(uid,"📅 Qaysi davr uchun statistika?",reply_markup=_davr_kb())

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="stat_davr")
def s_stat_davr(msg):
    uid=msg.from_user.id
    if msg.text=="🗓 Boshqa sana":
        set_state(uid,"stat_custom",{})
        bot.send_message(uid,"📅 Davr kiriting:\nFormat: 01.05.2026 - 18.05.2026",reply_markup=cancel_kb()); return
    d_from,d_to,label=_parse_davr(msg.text)
    if not d_from: return
    clear_state(uid)
    _send_umumiy_stat(uid,d_from,d_to,label)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="stat_custom")
def s_stat_custom(msg):
    uid=msg.from_user.id
    try:
        parts=[p.strip() for p in msg.text.split("-",1)]
        d_from=datetime.strptime(parts[0],"%d.%m.%Y").strftime("%Y-%m-%d")
        d_to=datetime.strptime(parts[1],"%d.%m.%Y").strftime("%Y-%m-%d")
        label=f"{parts[0]} - {parts[1]}"
    except:
        bot.send_message(uid,"❗ Format: 01.05.2026 - 18.05.2026"); return
    clear_state(uid)
    _send_umumiy_stat(uid,d_from,d_to,label)

@bot.message_handler(func=lambda m:m.text=="👥 Agentlar statistikasi")
def agentlar_stat(msg):
    uid=msg.from_user.id; user=get_user(uid)
    if not user or user[3] not in("supervisor","admin"): return
    conn=get_db();c=conn.cursor()
    bugun=date.today().isoformat(); oy=datetime.now().strftime("%Y-%m")
    c.execute("""
        SELECT u.telegram_id,u.name,u.viloyat,
               COUNT(DISTINCT d.id) as dokon_soni,
               COALESCE(SUM(CASE WHEN substr(s.created_at,1,7)=%s THEN s.jami_summa ELSE 0 END),0) as oylik,
               COALESCE(SUM(CASE WHEN substr(s.created_at,1,10)=%s THEN s.jami_summa ELSE 0 END),0) as bugungi
        FROM users u
        LEFT JOIN dokonlar d ON d.agent_id=u.telegram_id AND d.holat='faol'
        LEFT JOIN savdolar s ON s.agent_id=u.telegram_id
        WHERE u.role IN ('agent','supervisor')
        GROUP BY u.telegram_id,u.name,u.viloyat
        ORDER BY oylik DESC, dokon_soni DESC
    """,(oy,bugun))
    rows=c.fetchall()
    if not rows: conn.close(); bot.send_message(uid,"Agentlar yo'q."); return
    # Fetch nasiya and qaytib kirish per agent
    nasiya_map={}; qaytib_map={}
    for r in rows:
        tid=r[0]
        c.execute("SELECT COALESCE(SUM(qoldiq),0) FROM nasiya WHERE agent_id=%s AND qoldiq>0",(tid,))
        nasiya_map[tid]=c.fetchone()[0]
        c.execute("SELECT COUNT(*) FROM olmagan_dokonlar WHERE agent_id=%s AND bajarildi=0 AND qaytish_sanasi IS NOT NULL",(tid,))
        qaytib_map[tid]=c.fetchone()[0]
    conn.close()
    text=f"👥 AGENTLAR STATISTIKASI\n📅 {oy}\n{'━'*28}\n\n"
    for i,r in enumerate(rows,1):
        tid,name,viloyat,dokon_soni,oylik,bugungi=r
        nasiya=nasiya_map.get(tid,0); qaytib=qaytib_map.get(tid,0)
        text+=(f"{i}. {name} ({viloyat})\n"
               f"   🏪 Dokonlar: {dokon_soni} ta\n"
               f"   📦 Oylik savdo: {fmt(oylik)}\n"
               f"   💰 Bugungi: {fmt(bugungi)}\n")
        if nasiya>0: text+=f"   🔴 Nasiya: {fmt(nasiya)}\n"
        if qaytib>0: text+=f"   📋 Qaytib kirish: {qaytib} ta\n"
        text+="\n"
    bot.send_message(uid,text)

def mah_menu_kb():
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=2)
    kb.add("📋 Mahsulotlar ro'yxati","➕ Mahsulot qo'shish")
    kb.add("✏️ Narx o'zgartirish","🗑 Mahsulot o'chirish")
    kb.add("❌ Bekor qilish"); return kb

def birlik_kb():
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=3)
    kb.add("Dona","Kg","Metr"); kb.add("❌ Bekor qilish"); return kb

def tasdiq_kb():
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=2)
    kb.add("✅ Tasdiqlash","❌ Bekor qilish"); return kb

@bot.message_handler(func=lambda m:m.text=="🛍 Mahsulotlar")
def mah_list(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    bot.send_message(uid,"🛍 Mahsulotlar bo'limi:",reply_markup=mah_menu_kb())

@bot.message_handler(func=lambda m:m.text=="📋 Mahsulotlar ro'yxati")
def mah_royxat(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    conn=get_db();c=conn.cursor()
    c.execute("SELECT id,nomi,narx,birlik FROM mahsulotlar WHERE faol=1")
    rows=c.fetchall(); conn.close()
    if not rows: bot.send_message(uid,"❗ Mahsulotlar yo'q.",reply_markup=mah_menu_kb()); return
    text="🛍 Mahsulotlar ro'yxati:\n\n"
    for r in rows: text+=f"  [{r[0]}] {r[1]} — {fmt(r[2])}/{r[3]}\n"
    bot.send_message(uid,text,reply_markup=mah_menu_kb())

@bot.message_handler(func=lambda m:m.text=="➕ Mahsulot qo'shish")
def mah_qosh_start(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    # Yagona katalog (SKU) siyosati: yangi mahsulot faqat dashboard orqali yaratiladi
    bot.send_message(uid,
        "ℹ️ Yangi mahsulot endi faqat dashboard orqali qo'shiladi:\n"
        "Dashboard → Mahsulotlar → «Yangi savdo mahsuloti».\n"
        "U yerda mahsulotga SKU beriladi va zavod katalogi bilan bog'lanadi.",
        reply_markup=mah_menu_kb())

# Eslatma (yagona katalog siyosati): mah_qosh_* state handlerlari olib tashlangan —
# ular hech qayerdan set_state qilinmasa ham, mahsulotlarga SKU'siz (bog'lanmagan)
# to'g'ridan-to'g'ri INSERT yo'lini ochiq qoldirar edi. Yangi mahsulot faqat
# dashboard (POST /products, inSales=true) orqali yaratiladi va SKU bilan
# savdo katalogiga avtomatik proyeksiyalanadi.

@bot.message_handler(func=lambda m:m.text=="✏️ Narx o'zgartirish")
def mah_narx_start(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    conn=get_db();c=conn.cursor()
    c.execute("SELECT id,nomi,narx,birlik FROM mahsulotlar WHERE faol=1")
    rows=c.fetchall(); conn.close()
    if not rows: bot.send_message(uid,"❗ Mahsulotlar yo'q.",reply_markup=mah_menu_kb()); return
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    for r in rows: kb.add(f"✏️{r[0]}|{r[1]} — {fmt(r[2])}/{r[3]}")
    kb.add("❌ Bekor qilish")
    set_state(uid,"mah_narx_tanla",{})
    bot.send_message(uid,"✏️ Narxini o'zgartirish uchun mahsulotni tanlang:",reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="mah_narx_tanla")
def mah_narx_tanla(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    if msg.text=="❌ Bekor qilish":
        user=get_user(uid); clear_state(uid)
        bot.send_message(uid,"❌ Bekor qilindi",reply_markup=main_kb(user[3],uid)); return
    if not msg.text.startswith("✏️"): return
    try:
        rest=msg.text.lstrip("✏️").lstrip()
        mid=int(rest.split("|")[0])
        nomi=rest.split("|",1)[1].split(" —")[0].strip()
        if is_master_linked(mid):
            bot.send_message(uid,MASTER_LINKED_MSG,reply_markup=mah_menu_kb()); clear_state(uid); return
        data["mid"]=mid; data["nomi"]=nomi; set_state(uid,"mah_narx_kirit",data)
        bot.send_message(uid,f"💰 {nomi} uchun yangi narxni kiriting (so'mda):",reply_markup=cancel_kb())
    except Exception as e:
        bot.send_message(uid,f"❗ Mahsulotni qaytadan tanlang ({e})")

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="mah_narx_kirit")
def mah_narx_kirit(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    try: narx=int(msg.text.replace(" ","").replace(",",""))
    except: bot.send_message(uid,"❗ Raqam kiriting, masalan: 40000"); return
    if is_master_linked(data["mid"]):
        clear_state(uid); bot.send_message(uid,MASTER_LINKED_MSG,reply_markup=mah_menu_kb()); return
    conn=get_db();c=conn.cursor()
    c.execute("UPDATE mahsulotlar SET narx=%s WHERE id=%s",(narx,data["mid"]))
    conn.commit();conn.close();clear_state(uid)
    bot.send_message(uid,f"✅ Narx yangilandi!\n📝 {data['nomi']} — {fmt(narx)}",reply_markup=mah_menu_kb())

@bot.message_handler(func=lambda m:m.text=="🗑 Mahsulot o'chirish")
def mah_ochir_start(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    conn=get_db();c=conn.cursor()
    c.execute("SELECT id,nomi,narx,birlik FROM mahsulotlar WHERE faol=1")
    rows=c.fetchall(); conn.close()
    if not rows: bot.send_message(uid,"❗ Mahsulotlar yo'q.",reply_markup=mah_menu_kb()); return
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    for r in rows: kb.add(f"🗑{r[0]}|{r[1]} — {fmt(r[2])}/{r[3]}")
    kb.add("❌ Bekor qilish")
    set_state(uid,"mah_ochir_tanla",{})
    bot.send_message(uid,"🗑 O'chirish uchun mahsulotni tanlang:",reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="mah_ochir_tanla")
def mah_ochir_tanla(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    if msg.text=="❌ Bekor qilish":
        user=get_user(uid); clear_state(uid)
        bot.send_message(uid,"❌ Bekor qilindi",reply_markup=main_kb(user[3],uid)); return
    if not msg.text.startswith("🗑"): return
    try:
        rest=msg.text.lstrip("🗑").lstrip()
        mid=int(rest.split("|")[0])
        nomi=rest.split("|",1)[1].split(" —")[0].strip()
        if is_master_linked(mid):
            bot.send_message(uid,MASTER_LINKED_MSG,reply_markup=mah_menu_kb()); clear_state(uid); return
        data["mid"]=mid; data["nomi"]=nomi; set_state(uid,"mah_ochir_tasdiq",data)
        bot.send_message(uid,
            f"⚠️ Rostdan ham o'chirasizmi?\n\n📝 {nomi}",
            reply_markup=tasdiq_kb())
    except Exception as e:
        bot.send_message(uid,f"❗ Mahsulotni qaytadan tanlang ({e})")

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="mah_ochir_tasdiq")
def mah_ochir_tasdiq(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    if msg.text!="✅ Tasdiqlash":
        clear_state(uid)
        bot.send_message(uid,"Bekor qilindi.",reply_markup=mah_menu_kb()); return
    if is_master_linked(data["mid"]):
        clear_state(uid); bot.send_message(uid,MASTER_LINKED_MSG,reply_markup=mah_menu_kb()); return
    conn=get_db();c=conn.cursor()
    c.execute("UPDATE mahsulotlar SET faol=0 WHERE id=%s",(data["mid"],))
    conn.commit();conn.close();clear_state(uid)
    bot.send_message(uid,f"✅ {data['nomi']} o'chirildi.",reply_markup=mah_menu_kb())

MOTIVATSIYA = [
    "💪 Har bir savdo — g'alaba! Bugun ham hammasi yaxshi bo'ladi!",
    "🚀 Maqsadga qadam qadam yaqinlashamiz. Olg'a, jamoa!",
    "🌟 Kechagi natija — bugungi kuch. Davom eting!",
    "🔥 Eng yaxshi kun — hali oldinda. Ishlang, natija keladi!",
    "🏆 Har bir dokon — yangi imkoniyat. Omad tilaymiz!",
]

def build_bar(value, max_value, width=10):
    if max_value==0: return "░"*width
    filled=round((value/max_value)*width)
    return "▓"*filled+"░"*(width-filled)

@bot.message_handler(commands=["hisobot"])
def hisobot_cmd(msg):
    if not is_admin(msg.from_user.id): return
    send_daily_report(target=msg.from_user.id)

def send_daily_report(target=1261052681):
    try:
        yesterday=(date.today()-timedelta(days=1)).isoformat()
        conn=get_db();c=conn.cursor()
        c.execute("SELECT COALESCE(SUM(jami_summa),0),COUNT(*) FROM savdolar WHERE created_at LIKE %s",(f"{yesterday}%",))
        jami_savdo,savdo_n=c.fetchone()
        c.execute("SELECT COALESCE(SUM(summa),0) FROM pul_olish WHERE created_at LIKE %s",(f"{yesterday}%",))
        jami_pul=c.fetchone()[0]
        c.execute("""SELECT u.name,COALESCE(SUM(s.jami_summa),0) as jami
                     FROM savdolar s JOIN users u ON u.telegram_id=s.agent_id
                     WHERE s.created_at LIKE %s
                     GROUP BY s.agent_id,u.name ORDER BY jami DESC LIMIT 3""",(f"{yesterday}%",))
        top3=c.fetchall()
        c.execute("SELECT COUNT(*) FROM dokonlar WHERE created_at LIKE %s",(f"{yesterday}%",))
        yangi_dokon=c.fetchone()[0]
        c.execute("SELECT COUNT(*) FROM olmagan_dokonlar WHERE created_at LIKE %s",(f"{yesterday}%",))
        olmagan_n=c.fetchone()[0]
        c.execute("""SELECT sabab_text,COUNT(*) as n FROM olmagan_dokonlar
                     WHERE created_at LIKE %s GROUP BY sabab_text ORDER BY n DESC LIMIT 1""",(f"{yesterday}%",))
        top_sabab=c.fetchone()
        viloyatlar=["Namangan","Farg'ona","Andijon"]
        viloyat_stats=[]
        for v in viloyatlar:
            c.execute("""SELECT COALESCE(SUM(s.jami_summa),0)
                         FROM savdolar s JOIN dokonlar d ON d.id=s.dokon_id
                         WHERE s.created_at LIKE %s AND d.viloyat=%s""",(f"{yesterday}%",v))
            viloyat_stats.append((v,c.fetchone()[0]))
        conn.close()
        import random; motiv=random.choice(MOTIVATSIYA)
        text=(f"📊 KUNLIK HISOBOT — {yesterday}\n{'━'*28}\n\n"
              f"💰 Kechagi savdo:\n"
              f"   📦 Jami: {fmt(jami_savdo)} ({savdo_n} ta)\n"
              f"   💵 Pul olish: {fmt(jami_pul)}\n\n"
              f"🏆 Top 3 agent:\n")
        medals=["🥇","🥈","🥉"]
        for i,(name,summa) in enumerate(top3): text+=f"   {medals[i]} {name}: {fmt(summa)}\n"
        if not top3: text+="   — Ma'lumot yo'q\n"
        text+=(f"\n🏪 Yangi dokonlar: {yangi_dokon} ta\n"
               f"❌ Tovar olmagan: {olmagan_n} ta")
        if top_sabab: text+=f" ({top_sabab[0]})"
        text+=f"\n\n📍 Viloyatlar bo'yicha:\n"
        for v,vs in viloyat_stats: text+=f"   • {v}: {fmt(vs)}\n"
        text+=f"\n{motiv}"
        bot.send_message(target,text)
    except Exception as e:
        try: bot.send_message(target,f"❗ Hisobot xatosi: {e}")
        except: pass

@bot.message_handler(commands=["haftalik"])
def haftalik_cmd(msg):
    if not is_admin(msg.from_user.id): return
    try:
        today=date.today()
        days=[(today-timedelta(days=i)).isoformat() for i in range(6,-1,-1)]
        prev_days=[(today-timedelta(days=i)).isoformat() for i in range(13,6,-1)]
        conn=get_db();c=conn.cursor()

        daily=[]
        for d in days:
            c.execute("SELECT COALESCE(SUM(jami_summa),0),COUNT(*) FROM savdolar WHERE created_at LIKE %s",(f"{d}%",))
            s,n=c.fetchone()
            c.execute("SELECT COALESCE(SUM(summa),0) FROM pul_olish WHERE created_at LIKE %s",(f"{d}%",))
            p=c.fetchone()[0]
            daily.append((d,s,n,p))

        jami_savdo=sum(x[1] for x in daily)
        jami_pul=sum(x[3] for x in daily)
        max_savdo=max((x[1] for x in daily),default=1) or 1

        prev_savdo=0
        for d in prev_days:
            c.execute("SELECT COALESCE(SUM(jami_summa),0) FROM savdolar WHERE created_at LIKE %s",(f"{d}%",))
            prev_savdo+=c.fetchone()[0]

        c.execute("""SELECT u.name,COALESCE(SUM(s.jami_summa),0) as jami
                     FROM savdolar s JOIN users u ON u.telegram_id=s.agent_id
                     WHERE s.created_at >= %s
                     GROUP BY s.agent_id,u.name ORDER BY jami DESC LIMIT 3""",(days[0],))
        top3=c.fetchall()

        viloyatlar=["Namangan","Farg'ona","Andijon"]
        viloyat_stats=[]
        for v in viloyatlar:
            c.execute("""SELECT COALESCE(SUM(s.jami_summa),0)
                         FROM savdolar s JOIN dokonlar d ON d.id=s.dokon_id
                         WHERE s.created_at >= %s AND d.viloyat=%s""",(days[0],v))
            viloyat_stats.append((v,c.fetchone()[0]))
        conn.close()

        best=max(daily,key=lambda x:x[1])
        kun_nomlari={"Mon":"Dush","Tue":"Sesh","Wed":"Chor","Thu":"Pay","Fri":"Jum","Sat":"Shan","Sun":"Yak"}
        wow_diff=jami_savdo-prev_savdo
        wow_pct=f"+{round((wow_diff/prev_savdo)*100)}%" if prev_savdo>0 and wow_diff>=0 else (f"{round((wow_diff/prev_savdo)*100)}%" if prev_savdo>0 else "—")
        wow_icon="📈" if wow_diff>=0 else "📉"

        text=(f"📅 HAFTALIK HISOBOT\n"
              f"{days[0]} — {days[-1]}\n{'━'*28}\n\n"
              f"💰 Jami savdo: {fmt(jami_savdo)}\n"
              f"💵 Jami pul olish: {fmt(jami_pul)}\n"
              f"{wow_icon} O'tgan hafta: {fmt(prev_savdo)} ({wow_pct})\n\n"
              f"📊 Kunlik ko'rsatkich:\n")
        for d,s,n,p in daily:
            from datetime import datetime as dt
            weekday=kun_nomlari.get(dt.strptime(d,"%Y-%m-%d").strftime("%a"),d[-5:])
            bar=build_bar(s,max_savdo)
            text+=f"  {weekday} {bar} {fmt(s)}\n"

        text+=f"\n🏆 Eng yaxshi kun: {best[0]} ({fmt(best[1])})\n\n"
        text+="🥇 Top 3 agent:\n"
        medals=["🥇","🥈","🥉"]
        for i,(name,summa) in enumerate(top3): text+=f"   {medals[i]} {name}: {fmt(summa)}\n"
        if not top3: text+="   — Ma'lumot yo'q\n"
        text+="\n📍 Viloyatlar bo'yicha:\n"
        for v,vs in viloyat_stats: text+=f"   • {v}: {fmt(vs)}\n"
        bot.send_message(msg.from_user.id,text)
    except Exception as e:
        bot.send_message(msg.from_user.id,f"❗ Haftalik hisobot xatosi: {e}")

@bot.message_handler(commands=["oylik"])
def oylik_cmd(msg):
    if not is_admin(msg.from_user.id): return
    try:
        today=date.today()
        oy=today.strftime("%Y-%m")
        from datetime import datetime as dt
        if today.month==1: prev_oy=f"{today.year-1}-12"
        else: prev_oy=f"{today.year}-{str(today.month-1).zfill(2)}"

        conn=get_db();c=conn.cursor()

        c.execute("SELECT COALESCE(SUM(jami_summa),0),COUNT(*) FROM savdolar WHERE created_at LIKE %s",(f"{oy}%",))
        jami_savdo,savdo_n=c.fetchone()
        c.execute("SELECT COALESCE(SUM(summa),0) FROM pul_olish WHERE created_at LIKE %s",(f"{oy}%",))
        jami_pul=c.fetchone()[0]
        c.execute("SELECT COALESCE(SUM(jami_summa),0) FROM savdolar WHERE created_at LIKE %s",(f"{prev_oy}%",))
        prev_savdo=c.fetchone()[0]

        c.execute("""SELECT substr(created_at,1,10) as kun,
                            COALESCE(SUM(jami_summa),0)
                     FROM savdolar WHERE created_at LIKE %s
                     GROUP BY kun ORDER BY kun""",(f"{oy}%",))
        daily_rows=c.fetchall()

        c.execute("""SELECT u.name,COALESCE(SUM(s.jami_summa),0) as jami
                     FROM savdolar s JOIN users u ON u.telegram_id=s.agent_id
                     WHERE s.created_at LIKE %s
                     GROUP BY s.agent_id,u.name ORDER BY jami DESC LIMIT 3""",(f"{oy}%",))
        top3=c.fetchall()

        viloyatlar=["Namangan","Farg'ona","Andijon"]
        viloyat_stats=[]
        for v in viloyatlar:
            c.execute("""SELECT COALESCE(SUM(s.jami_summa),0)
                         FROM savdolar s JOIN dokonlar d ON d.id=s.dokon_id
                         WHERE s.created_at LIKE %s AND d.viloyat=%s""",(f"{oy}%",v))
            viloyat_stats.append((v,c.fetchone()[0]))

        c.execute("SELECT COUNT(*) FROM dokonlar WHERE created_at LIKE %s",(f"{oy}%",))
        yangi_dokon=c.fetchone()[0]
        c.execute("SELECT COUNT(*) FROM olmagan_dokonlar WHERE created_at LIKE %s",(f"{oy}%",))
        olmagan_n=c.fetchone()[0]
        conn.close()

        wow_diff=jami_savdo-prev_savdo
        wow_pct=f"+{round((wow_diff/prev_savdo)*100)}%" if prev_savdo>0 and wow_diff>=0 else (f"{round((wow_diff/prev_savdo)*100)}%" if prev_savdo>0 else "—")
        wow_icon="📈" if wow_diff>=0 else "📉"
        max_day=max((x[1] for x in daily_rows),default=1) or 1
        best_day=max(daily_rows,key=lambda x:x[1]) if daily_rows else None

        text=(f"📆 OYLIK HISOBOT — {oy}\n{'━'*28}\n\n"
              f"💰 Jami savdo: {fmt(jami_savdo)} ({savdo_n} ta)\n"
              f"💵 Jami pul olish: {fmt(jami_pul)}\n"
              f"{wow_icon} O'tgan oy: {fmt(prev_savdo)} ({wow_pct})\n"
              f"🏪 Yangi dokonlar: {yangi_dokon} ta\n"
              f"❌ Tovar olmagan: {olmagan_n} ta\n\n"
              f"📊 Kunlik ko'rsatkich:\n")
        for d,s in daily_rows:
            bar=build_bar(s,max_day,width=8)
            text+=f"  {d[-2:]} {bar} {fmt(s)}\n"
        if not daily_rows: text+="  — Ma'lumot yo'q\n"

        if best_day: text+=f"\n🏆 Eng yaxshi kun: {best_day[0]} ({fmt(best_day[1])})\n"
        text+="\n🥇 Top 3 agent:\n"
        medals=["🥇","🥈","🥉"]
        for i,(name,summa) in enumerate(top3): text+=f"   {medals[i]} {name}: {fmt(summa)}\n"
        if not top3: text+="   — Ma'lumot yo'q\n"
        text+="\n📍 Viloyatlar bo'yicha:\n"
        for v,vs in viloyat_stats: text+=f"   • {v}: {fmt(vs)}\n"
        bot.send_message(msg.from_user.id,text)
    except Exception as e:
        bot.send_message(msg.from_user.id,f"❗ Oylik hisobot xatosi: {e}")

def _build_multistop_maps_url(items):
    """Build a Google Maps directions URL with multiple waypoints (up to ~9)."""
    coords=[(r[6],r[7]) for r in items if r[6] and r[7]]
    if not coords: return None
    coords=coords[:10]  # Google Maps limit
    if len(coords)==1:
        return f"https://maps.google.com/?q={coords[0][0]},{coords[0][1]}"
    base="https://www.google.com/maps/dir/?api=1"
    dest=f"{coords[-1][0]},{coords[-1][1]}"
    waypoints="|".join(f"{lat},{lon}" for lat,lon in coords[:-1])
    return f"{base}&destination={dest}&waypoints={waypoints}&travelmode=driving"

def _format_agent_section(agent_name, items, with_header=True):
    """Build a per-agent revisit block, grouped by viloyat → hudud."""
    text=""
    if with_header:
        text=f"📋 BUGUN KIRILADIGAN DOKONLAR\n\n👤 Agent: {agent_name}\n{'━'*26}\n"
    else:
        text=f"\n👤 Agent: {agent_name}  ({len(items)} ta)\n{'━'*26}\n"
    # Group by viloyat → hudud
    from collections import defaultdict
    by_vil=defaultdict(lambda: defaultdict(list))
    for r in items:
        vil=r[4] or "—"; hud=r[5] or "—"
        by_vil[vil][hud].append(r)
    idx=0
    for vil, huds in by_vil.items():
        v_total=sum(len(v) for v in huds.values())
        text+=f"\n📍 {vil.upper()} ({v_total} ta)\n"
        for hud, rows in huds.items():
            text+=f"\n  🏘 {hud} ({len(rows)} ta):\n"
            for r in rows:
                idx+=1
                _,_,nomi,egasi,_,_,lat,lon,last_d,_,_ = r
                maps=f"https://maps.google.com/?q={lat},{lon}" if lat and lon else "—"
                last_s=last_d[:10] if last_d else "—"
                text+=(f"    {idx}. 🏪 {nomi}\n"
                       f"       👤 {egasi or '—'} | 📅 {last_s}\n"
                       f"       🗺 {maps}\n")
    # Multi-stop route link
    route=_build_multistop_maps_url(items)
    if route:
        text+=f"\n{'━'*26}\n🚗 MARSHRUT (ko'p to'xtash): {route}\n"
    return text

def _send_long(chat_id, text):
    """Telegram 4096 char limit-ga moslab yuborish."""
    LIM=3800
    while text:
        chunk=text[:LIM]
        # break at newline if possible
        if len(text)>LIM:
            nl=chunk.rfind("\n")
            if nl>1000: chunk=text[:nl]
        try: bot.send_message(chat_id, chunk, disable_web_page_preview=True)
        except: pass
        text=text[len(chunk):]

def send_today_revisits(target_agent=None, target_admin=None):
    """Cron / manual trigger for today's revisit lists.
    - target_agent: agent uchun faqat o'zinikini yuboradi
    - target_admin: admin uchun BARCHA agentlarning to'liq ro'yxatini yuboradi
    - Ikkalasi None bo'lsa: har agentga o'zinikini + har adminga umumiy ro'yxat (cron)
    """
    today=date.today().isoformat()
    conn=get_db();c=conn.cursor()
    if target_agent:
        c.execute("""SELECT r.id, r.dokon_id, d.nomi, d.egasi, d.viloyat, d.hudud, d.latitude, d.longitude,
                            r.last_order_date, u.name, r.agent_id
                     FROM revisitlar r
                     JOIN dokonlar d ON d.id=r.dokon_id
                     LEFT JOIN users u ON u.telegram_id=r.agent_id
                     WHERE r.revisit_date<=%s AND r.status='pending' AND r.agent_id=%s
                     ORDER BY d.nomi""",(today,target_agent))
    else:
        c.execute("""SELECT r.id, r.dokon_id, d.nomi, d.egasi, d.viloyat, d.hudud, d.latitude, d.longitude,
                            r.last_order_date, u.name, r.agent_id
                     FROM revisitlar r
                     JOIN dokonlar d ON d.id=r.dokon_id
                     LEFT JOIN users u ON u.telegram_id=r.agent_id
                     WHERE r.revisit_date<=%s AND r.status='pending'
                     ORDER BY r.agent_id, d.nomi""",(today,))
    rows=c.fetchall(); conn.close()
    if not rows:
        msg_empty="✅ Bugun qayta kiriladigan dokon yo'q."
        if target_agent:
            try: bot.send_message(target_agent,msg_empty)
            except: pass
        if target_admin:
            try: bot.send_message(target_admin,msg_empty)
            except: pass
        if not target_agent and not target_admin:
            for aid in all_admin_ids():
                try: bot.send_message(aid,msg_empty)
                except: pass
        return 0
    # Group by agent
    from collections import defaultdict
    by_agent=defaultdict(list)
    for r in rows: by_agent[r[10]].append(r)
    # If only an admin requested — send them a single consolidated message
    if target_admin:
        text=f"📋 BUGUN KIRILADIGAN DOKONLAR (UMUMIY)\n\n📦 Jami: {len(rows)} ta dokon | 👥 {len(by_agent)} ta agent\n"
        for agent_id, items in by_agent.items():
            agent_name=items[0][9] or f"ID {agent_id}"
            text+=_format_agent_section(agent_name, items, with_header=False)
        _send_long(target_admin, text)
        return len(by_agent)
    # Otherwise: send to each agent (theirs) + to each admin (full list) — for cron / agent-only path
    sent=0
    for agent_id, items in by_agent.items():
        if target_agent and target_agent!=agent_id: continue
        agent_name=items[0][9] or "—"
        text=_format_agent_section(agent_name, items, with_header=True)
        text+=f"\n📦 Jami: {len(items)} ta dokon"
        try:
            _send_long(agent_id, text); sent+=1
        except Exception as e:
            print(f"⚠️ Revisit send failed for {agent_id}: {e}")
    # Cron — also send admins the full consolidated list
    if not target_agent:
        admin_text=f"📋 BUGUN KIRILADIGAN DOKONLAR (UMUMIY)\n\n📦 Jami: {len(rows)} ta dokon | 👥 {len(by_agent)} ta agent\n"
        for agent_id, items in by_agent.items():
            agent_name=items[0][9] or f"ID {agent_id}"
            admin_text+=_format_agent_section(agent_name, items, with_header=False)
        for aid in all_admin_ids():
            _send_long(aid, admin_text)
    return sent

@bot.message_handler(commands=["qayta_kirish"])
def qayta_kirish_cmd(msg):
    """Manual trigger: agent sees own list; admin sees full consolidated list."""
    uid=msg.from_user.id
    if is_admin(uid):
        send_today_revisits(target_admin=uid)
    else:
        send_today_revisits(target_agent=uid)

def send_morning_routes():
    """Har kuni ertalab faol delivery agentlarga bugungi marshrutni yuborish."""
    kun=_today_kun()
    if not kun: return 0  # Juma — dam olish kuni
    conn=get_db();c=conn.cursor()
    c.execute("SELECT id,name,telegram_id FROM delivery_agents WHERE faol=1 AND telegram_id IS NOT NULL")
    agents=c.fetchall()
    sent=0
    for did,name,tid in agents:
        c.execute("""SELECT r.tartib,d.nomi,d.hudud,d.latitude,d.longitude
                     FROM delivery_routes r JOIN dokonlar d ON d.id=r.dokon_id
                     WHERE r.delivery_agent_id=%s AND r.kun=%s AND d.holat='faol'
                     ORDER BY r.tartib""",(did,kun))
        rows=c.fetchall()
        if not rows: continue
        text=(f"🌅 Xayrli tong, {name}!\n"
              f"📅 {day_name(kun)} — bugungi marshrutingiz\n"
              f"📦 {len(rows)} ta do'kon\n{'━'*26}\n")
        for tartib,nomi,hud,_,_ in rows:
            text+=f"\n{tartib}. 🏪 {nomi} | 📍 {hud or '—'}"
        coords=[(lat,lon) for _,_,_,lat,lon in rows if lat and lon]
        if coords:
            cc=coords[:10]
            if len(cc)==1:
                url=f"https://maps.google.com/?q={cc[0][0]},{cc[0][1]}"
            else:
                url=("https://www.google.com/maps/dir/?api=1&destination="
                     f"{cc[-1][0]},{cc[-1][1]}&waypoints="
                     +"|".join(f"{la},{lo}" for la,lo in cc[:-1])+"&travelmode=driving")
            text+=f"\n\n🚗 MARSHRUT (ko'p to'xtash): {url}"
        text+="\n\n🚀 \"Marshrutni boshlash\" tugmasini bosib joylashuvingizni yuboring."
        kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=2)
        kb.add("🚀 Marshrutni boshlash")
        kb.add("📦 Tovar berish","💰 Pul olish")
        kb.add("❌ Tovar olmadi","📋 Qaytib kirish kerak")
        kb.add("📊 Statistikam","👤 Profil")
        try:
            bot.send_message(tid,text,reply_markup=kb,disable_web_page_preview=True); sent+=1
            send_field_btn(tid)
        except Exception as e:
            log.warning("Morning route yuborilmadi (tid=%s): %s", tid, e)
    conn.close()
    return sent

def run_scheduler():
    # Tashkent vaqti bilan (UTC+5). Eski schedule versiyalari uchun fallback — UTC ekvivalent.
    tz="Asia/Tashkent"
    try:
        schedule.every().day.at("08:00", tz).do(send_daily_report)
        schedule.every().day.at("07:00", tz).do(send_today_revisits)
        schedule.every().day.at("07:30", tz).do(send_morning_routes)
        schedule.every().monday.at("09:00", tz).do(send_weekly_lost_alert)
        schedule.every().monday.at("09:30", tz).do(send_weekly_old_nasiya_alert)
        schedule.every().day.at("20:00", tz).do(send_monthly_rating_if_last_day)
        print(f"⏰ Scheduler started (TZ={tz}): daily 08:00, revisits 07:00, morning-routes 07:30, lost-alert Mon 09:00, old-nasiya Mon 09:30, rating last-day 20:00")
    except TypeError:
        # Old `schedule` lib — convert manually (Tashkent = UTC+5)
        schedule.every().day.at("03:00").do(send_daily_report)   # 08:00 Tashkent
        schedule.every().day.at("02:00").do(send_today_revisits) # 07:00 Tashkent
        schedule.every().day.at("02:30").do(send_morning_routes) # 07:30 Tashkent
        schedule.every().monday.at("04:00").do(send_weekly_lost_alert) # 09:00 Tashkent
        schedule.every().monday.at("04:30").do(send_weekly_old_nasiya_alert) # 09:30 Tashkent
        schedule.every().day.at("15:00").do(send_monthly_rating_if_last_day) # 20:00 Tashkent
        print("⏰ Scheduler started (UTC fallback): daily 03:00, revisits 02:00, morning-routes 02:30, lost-alert Mon 04:00, old-nasiya Mon 04:30, rating 15:00 UTC")
    while True:
        try:
            schedule.run_pending()
        except Exception as e:
            log.exception("Scheduler job failed: %s", e)
        time.sleep(30)

def run_health_server():
    from http.server import BaseHTTPRequestHandler, HTTPServer
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path in ("/health", "/", "/healthz", "/ping"):
                self.send_response(200)
                self.send_header("Content-Type","text/plain")
                self.end_headers()
                self.wfile.write(b"OK")
            elif self.path == "/version":
                self.send_response(200)
                self.send_header("Content-Type","text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write(BOT_VERSION_REPORT.encode("utf-8"))
            else:
                self.send_response(404)
                self.end_headers()
        def log_message(self,*a): pass
    env_port = os.environ.get("PORT")
    ports = []
    if env_port:
        try: ports.append(int(env_port))
        except ValueError: pass
    ports += [8080, 8443, 9000, 7860, 5050]
    for port in ports:
        try:
            print(f"🌐 Health server listening on port {port} (/health)")
            HTTPServer(("0.0.0.0", port), H).serve_forever()
            break
        except OSError as e:
            print(f"⚠️ Port {port} unavailable ({e}), trying next...")
            continue

def _pdf_safe(s):
    if s is None: return "—"
    return str(s).replace("ʻ","'").replace("ʼ","'").replace("'","'").replace("'","'")

@bot.message_handler(commands=["dokonlar_pdf"])
@bot.message_handler(func=lambda m:m.text=="📄 Dokonlar PDF")
def dokonlar_pdf(msg):
    uid=msg.from_user.id
    if not is_admin(uid): return
    try:
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib import colors
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
        from reportlab.lib.units import mm
    except Exception as e:
        bot.send_message(uid,f"❗ reportlab kerak: {e}"); return

    conn=get_db(); c=conn.cursor()
    c.execute("""SELECT d.id, d.nomi, d.egasi, d.telefon, d.viloyat,
                        COALESCE(u.name,'—'), d.holat
                 FROM dokonlar d
                 LEFT JOIN users u ON d.agent_id=u.telegram_id
                 ORDER BY d.holat DESC, d.nomi""")
    rows=c.fetchall(); conn.close()
    if not rows:
        bot.send_message(uid,"❗ Dokon yo'q"); return

    buf=io.BytesIO()
    doc=SimpleDocTemplate(buf, pagesize=landscape(A4),
        leftMargin=10*mm, rightMargin=10*mm, topMargin=10*mm, bottomMargin=10*mm)
    styles=getSampleStyleSheet()
    title=ParagraphStyle('t', parent=styles['Title'], fontSize=16, alignment=1)
    sub=ParagraphStyle('s', parent=styles['Normal'], fontSize=10, alignment=1, textColor=colors.grey)

    faol=sum(1 for r in rows if r[6]=='faol')
    story=[
        Paragraph("TOP MART — Dokonlar ro'yxati", title),
        Paragraph(f"Sana: {datetime.now().strftime('%d.%m.%Y %H:%M')}  |  Jami: {len(rows)} ta  |  Faol: {faol}  |  Nofaol: {len(rows)-faol}", sub),
        Spacer(1, 4*mm),
    ]

    header=["№","Nomi","Egasi","Telefon","Viloyat","Agent","Holat"]
    data=[header]
    for i,r in enumerate(rows,1):
        data.append([
            str(i),
            _pdf_safe(r[1])[:35],
            _pdf_safe(r[2])[:25],
            _pdf_safe(r[3])[:20],
            _pdf_safe(r[4])[:20],
            _pdf_safe(r[5])[:25],
            "✓" if r[6]=='faol' else "✗",
        ])

    tbl=Table(data, repeatRows=1,
        colWidths=[10*mm, 60*mm, 45*mm, 35*mm, 35*mm, 50*mm, 15*mm])
    tbl.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,0),colors.HexColor('#1e3a8a')),
        ('TEXTCOLOR',(0,0),(-1,0),colors.white),
        ('FONTNAME',(0,0),(-1,0),'Helvetica-Bold'),
        ('FONTSIZE',(0,0),(-1,0),10),
        ('FONTSIZE',(0,1),(-1,-1),9),
        ('GRID',(0,0),(-1,-1),0.4,colors.HexColor('#9ca3af')),
        ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white, colors.HexColor('#f3f4f6')]),
        ('VALIGN',(0,0),(-1,-1),'MIDDLE'),
        ('ALIGN',(0,0),(0,-1),'CENTER'),
        ('ALIGN',(-1,0),(-1,-1),'CENTER'),
        ('LEFTPADDING',(0,0),(-1,-1),4),
        ('RIGHTPADDING',(0,0),(-1,-1),4),
        ('TOPPADDING',(0,0),(-1,-1),3),
        ('BOTTOMPADDING',(0,0),(-1,-1),3),
    ]))
    story.append(tbl)
    doc.build(story)
    buf.seek(0)
    fname=f"dokonlar_{datetime.now().strftime('%Y%m%d_%H%M')}.pdf"
    bot.send_document(uid, (fname, buf.read()),
        caption=f"📄 Dokonlar ro'yxati\n🗓 {datetime.now().strftime('%d.%m.%Y %H:%M')}\n📊 Jami: {len(rows)} ta (✓ {faol} faol, ✗ {len(rows)-faol} nofaol)")

# ═══ F11: Telegram-first mashina to'ldirish (agent yuklash ustasi) ═══════════
VFILL_BTN="🚚 Mashinani to'ldirish"

def _vfill_cancel(uid):
    user=get_user(uid); clear_state(uid)
    bot.send_message(uid,"❌ Bekor qilindi",reply_markup=main_kb(user[3] if user else None,uid))

def _vfill_show_warehouses(uid,data,intro=""):
    whs=vfill.fill_source_warehouses()
    if not whs:
        user=get_user(uid); clear_state(uid)
        bot.send_message(uid,"❌ Top Mart C-3 markaziy ombori sozlanmagan yoki unda yaroqli dona qoldiq yo'q.",
                         reply_markup=main_kb(user[3] if user else None,uid)); return
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    labels={}
    for i,w in enumerate(whs,1):
        lbl=f"{i}) {w['name']}"; labels[lbl]={"id":w["id"],"name":w["name"]}; kb.add(lbl)
    kb.add("❌ Bekor qilish")
    data["wh_labels"]=labels
    set_state(uid,"vfill_wh",data)
    bot.send_message(uid,(intro or "")+"🏬 Manba omborni tanlang:",reply_markup=kb)

@bot.message_handler(func=lambda m:m.text==VFILL_BTN)
def vfill_start(msg):
    uid=msg.from_user.id; user=get_user(uid)
    if not user or user[3]!="delivery": return
    # Kirishda HAR DOIM yangi tekshiruv (menyu keshi huquq chegarasi emas)
    if not _is_vehicle_distribution_pilot_user(user):
        bot.send_message(uid,"❗ Bu bo'lim faqat mashina pilot agentiga ochiq."); return
    chain=vfill.pilot_chain(uid)
    if not chain:
        bot.send_message(uid,"❗ Faol mashina biriktiruvi topilmadi. Admin bilan bog'laning."); return
    data={"cart":[],"chain":chain,"opkeys":{}}
    _vfill_show_warehouses(uid,data,intro=f"🚚 Mashinani to'ldirish — {chain['plate_number']}\n\n")

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="vfill_wh")
def vfill_wh(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    sel=(data.get("wh_labels") or {}).get(msg.text)
    if sel is None:
        bot.send_message(uid,"❗ Ro'yxatdagi tugmalardan tanlang."); return
    prods=vfill.fill_products(sel["id"])
    if not prods:
        bot.send_message(uid,"❌ Bu omborda yaroqli dona qoldiq yo'q. Boshqa ombor tanlang."); return
    data["wh_id"]=sel["id"]; data["wh_name"]=sel["name"]; data["prods"]=prods
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    labels={}
    for i,p in enumerate(prods,1):
        lbl=f"{i}) {p['name']} — {p['available_quantity']} dona"
        labels[lbl]=i-1; kb.add(lbl)
    kb.add("⬅️ Orqaga"); kb.add("❌ Bekor qilish")
    data["prod_labels"]=labels
    set_state(uid,"vfill_prod",data)
    bot.send_message(uid,f"🏬 {sel['name']}\n\n📦 Mahsulotni tanlang:",reply_markup=kb)

def _vfill_prod_kb(data):
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    for lbl in (data.get("prod_labels") or {}): kb.add(lbl)
    kb.add("⬅️ Orqaga"); kb.add("❌ Bekor qilish")
    return kb

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="vfill_prod")
def vfill_prod(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    if msg.text=="⬅️ Orqaga": _vfill_show_warehouses(uid,data); return
    idx=(data.get("prod_labels") or {}).get(msg.text)
    if idx is None:
        bot.send_message(uid,"❗ Ro'yxatdagi tugmalardan tanlang."); return
    p=data["prods"][idx]
    data["cur"]=p
    set_state(uid,"vfill_qty",data)
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    kb.add("⬅️ Orqaga"); kb.add("❌ Bekor qilish")
    bot.send_message(uid,
        f"📦 {p['name']}\n"
        f"📊 Mavjud: {p['available_quantity']} dona\n"
        f"🧮 1 quti = {p['pieces_per_box']} dona\n\n"
        f"Nechta DONA yuklaysiz?",reply_markup=kb)

def _vfill_cart_totals(cart):
    tq=sum(l["quantity"] for l in cart)
    tb=sum(-(-l["quantity"]//l["pieces_per_box"]) for l in cart)
    return tq,tb

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="vfill_qty")
def vfill_qty(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    if msg.text=="⬅️ Orqaga":
        data.pop("cur",None); set_state(uid,"vfill_prod",data)
        bot.send_message(uid,"📦 Mahsulotni tanlang:",reply_markup=_vfill_prod_kb(data)); return
    try: q=int((msg.text or "").strip())
    except Exception:
        bot.send_message(uid,"❗ Butun son kiriting (masalan: 60)."); return
    if q<=0:
        bot.send_message(uid,"❗ Musbat son kiriting."); return
    p=data.get("cur") or {}
    cart=data.setdefault("cart",[])
    line=None
    for l in cart:
        if l["wh_id"]==data["wh_id"] and l["mahsulot_id"]==p["mahsulot_id"]:
            line=l; break
    new_total=q+(line["quantity"] if line else 0)
    if new_total>p["available_quantity"]:
        extra=f" (savatda allaqachon {line['quantity']} dona)" if line else ""
        bot.send_message(uid,f"⚠️ Omborda faqat {p['available_quantity']} dona bor{extra}. Kamroq kiriting."); return
    if line: line["quantity"]=new_total
    else:
        cart.append({"wh_id":data["wh_id"],"wh_name":data["wh_name"],
                     "mahsulot_id":p["mahsulot_id"],"name":p["name"],
                     "quantity":q,"pieces_per_box":p["pieces_per_box"],
                     "narx":str(p["narx"]) if p.get("narx") is not None else None})
    boxes=-(-new_total//p["pieces_per_box"])
    tq,tb=_vfill_cart_totals(cart)
    set_state(uid,"vfill_next",data)
    kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
    kb.add("➕ Yana tovar qo'shish"); kb.add("✅ Yakunlash"); kb.add("❌ Bekor qilish")
    bot.send_message(uid,
        f"✅ Savatga qo'shildi:\n"
        f"📦 {p['name']} — {new_total} dona = {boxes} quti ({boxes} stiker)\n\n"
        f"🧺 Savat: {len(cart)} xil tovar · {tq} dona · {tb} quti",reply_markup=kb)

@bot.message_handler(func=lambda m:get_state(m.from_user.id)["state"]=="vfill_next")
def vfill_next(msg):
    uid=msg.from_user.id; data=get_state(uid)["data"]
    if msg.text=="➕ Yana tovar qo'shish": _vfill_show_warehouses(uid,data); return
    if msg.text=="✅ Yakunlash": _vfill_finalize(uid,data); return
    bot.send_message(uid,"❗ Tugmalardan foydalaning.")

def _vfill_notify_omborchi(hid,wh_name,chain,lines_txt,total_qty,total_boxes):
    """Yangi topshiriq haqida omborchilarga xabar (VEHICLE_REPLENISHMENT_TELEGRAM_CHAT_IDS)."""
    try: recipients=vfill.configured_recipient_ids()
    except ValueError as exc:
        log.error("VEHICLE_REPLENISHMENT_TELEGRAM_CHAT_IDS xato: %s",exc); return
    text=(f"📦 YANGI YUKLASH TOPSHIRIG'I (№{hid})\n"
          f"🚚 {chain['plate_number']} — {chain['agent_name']}\n"
          f"🏬 Manba: {wh_name}\n\n"
          f"{lines_txt}\n\n"
          f"Jami: {total_qty} dona · {total_boxes} quti ({total_boxes} stiker)\n\n"
          f"🖨 Omborchi bot: «🚚 Mashinani to'ldirish» → «📋 Mavjud topshirishlar»")
    for rid in recipients:
        try: bot.send_message(rid,text)
        except Exception as exc: log.warning("Omborchi xabari yuborilmadi %s: %s",rid,exc)

def _vfill_finalize(uid,data):
    cart=data.get("cart") or []
    if not cart: _vfill_cancel(uid); return
    if data.get("finalizing"):
        bot.send_message(uid,"⏳ Yakunlash davom etmoqda — kuting..."); return
    data["finalizing"]=True; set_state(uid,"vfill_next",data)
    chain=data["chain"]
    groups={}
    for l in cart: groups.setdefault(l["wh_id"],[]).append(l)
    opkeys=data.setdefault("opkeys",{})
    ok_msgs=[]; failed=[]; remaining=[]
    for wid,lines in groups.items():
        # Har bir ombor-guruh uchun barqaror kalit: retry'da o'sha topshiriq qayta
        # ochilmaydi (server idempotent). Savat o'zgargan bo'lsa 409 fingerprint
        # to'qnashuvi keladi — bir marta yangi kalit bilan urinamiz.
        key=opkeys.setdefault(str(wid),str(uuid.uuid4()))
        try:
            try:
                h=vehicle_api.create_handoff(wid,lines,key,notes=f"F11 agent yuklash — {chain['agent_name']}")
            except vehicle_api.VehicleApiError as e1:
                if e1.status==409:
                    key=str(uuid.uuid4()); opkeys[str(wid)]=key
                    h=vehicle_api.create_handoff(wid,lines,key,notes=f"F11 agent yuklash — {chain['agent_name']}")
                else: raise
        except vehicle_api.VehicleApiError as e:
            failed.append((lines[0]["wh_name"],str(e))); remaining.extend(lines); continue
        hid=h.get("id")
        txt_lines=[]; total_qty=0; total_boxes=0; total_sum=Decimal(0)
        for l in lines:
            b=-(-l["quantity"]//l["pieces_per_box"])
            total_qty+=l["quantity"]; total_boxes+=b
            if l.get("narx"): total_sum+=Decimal(l["narx"])*l["quantity"]
            txt_lines.append(f"  • {l['name']} — {l['quantity']} dona = {b} quti")
        lines_txt="\n".join(txt_lines)
        sum_line=f"\n💰 Taxminiy qiymati (savdo narxida): {fmt(total_sum)}" if total_sum>0 else ""
        ok_msgs.append(f"✅ TOPSHIRIQ YARATILDI (№{hid})\n🏬 Manba: {lines[0]['wh_name']}\n{lines_txt}\n📦 Jami: {total_qty} dona · {total_boxes} quti ({total_boxes} mavjud stiker){sum_line}\n🔎 Mavjud ishlab chiqarish stikerlarini Top Mart dashboardida skanerlab yakunlang.")
        _vfill_notify_omborchi(hid,lines[0]["wh_name"],chain,lines_txt,total_qty,total_boxes)
        opkeys.pop(str(wid),None)
    if failed:
        data["cart"]=remaining; data["finalizing"]=False; set_state(uid,"vfill_next",data)
        err="\n".join(f"❌ {n}: {e}" for n,e in failed)
        kb=types.ReplyKeyboardMarkup(resize_keyboard=True,row_width=1)
        kb.add("✅ Yakunlash"); kb.add("➕ Yana tovar qo'shish"); kb.add("❌ Bekor qilish")
        bot.send_message(uid,("\n\n".join(ok_msgs)+"\n\n" if ok_msgs else "")+err+
                         "\n\n♻️ «✅ Yakunlash» bilan qayta urinib ko'ring yoki «❌ Bekor qilish».",reply_markup=kb)
        return
    user=get_user(uid); clear_state(uid)
    bot.send_message(uid,"\n\n".join(ok_msgs)+
        "\n\n⏳ Omborchi mavjud ishlab chiqarish stikerlarini Top Mart dashboardida skanerlab, mashinaga topshiradi."
        "\n📲 Yuk mashinangizga o'tkazilgach «✅ MASHINA TO'LDIRILDI» xabari keladi."
        "\n❗ Zaxira hozircha ombordan YECHILMADI — faqat omborchi tasdiqlaganda ko'chadi.",
        reply_markup=main_kb(user[3] if user else None,uid))

# ═══ F11: Yo'l yakuni — avto MASHINA HISOBOTI + avto to'ldirish ══════════════
def _vehicle_route_end_check(uid):
    """Pilot agentning bugungi marshruti to'liq yopilganda (har bir rejali dokon
    savdo YOKI 'tovar olmadi' bilan qamralganda) bir martalik MASHINA HISOBOTI
    yuboriladi va target asosida avto to'ldirish so'rovlari ochiladi.
    Hech qachon exception tarqatmaydi — savdo oqimini buzishi mumkin emas."""
    try:
        if os.environ.get("VEHICLE_DISTRIBUTION_ENABLED")!="1": return
        user=get_user(uid)
        if not user or user[3]!="delivery": return
        if not _is_vehicle_distribution_pilot_user(user): return
        kun=_today_kun()
        if kun is None: return
        chain=vfill.pilot_chain(uid)
        if not chain: return
        today=vfill.today_str()
        planned,covered=vfill.route_end_status(chain["delivery_agent_id"],uid,kun,today)
        if planned==0 or covered<planned: return
        rows=vfill.vehicle_day_numbers(chain["vehicle_warehouse_id"],chain["vehicle_id"],today)
        payload=json.dumps({"planned":planned,"covered":covered,"rows":rows},
                           ensure_ascii=False,default=str)
        won,created=vfill.try_route_end_finalize(chain["vehicle_id"],today,
                                                 chain["delivery_agent_id"],uid,
                                                 payload,uid,
                                                 chain["vehicle_warehouse_id"])
        if not won:
            return  # bugun allaqachon yuborilgan (yoki parallel yutdi)
        sold_lines=[f"  • {r['name']} — {r['sold']} dona" for r in rows if r["sold"]>0]
        left_lines=[f"  • {r['name']} — {r['remaining']} dona" for r in rows if r["remaining"]>0]
        text=(f"🚚 MASHINA HISOBOTI — {chain['plate_number']} / {chain['agent_name']}\n"
              f"📅 {today} · Marshrut yakunlandi ({covered}/{planned} dokon)\n\n"
              f"📦 Bugun sotildi:\n"+("\n".join(sold_lines) if sold_lines else "  —")+"\n\n"
              f"📊 Mashinada qoldi:\n"+("\n".join(left_lines) if left_lines else "  —"))
        if created:
            text+=("\n\n🔴 Avto to'ldirish so'rovi ochildi (omborchiga boradi):\n"+
                   "\n".join(f"  • {n} — {d} dona" for n,d in created))
        else:
            text+="\n\n✅ Zaxira me'yorida — yangi to'ldirish so'rovi ochilmadi."
        bot.send_message(uid,text)
    except Exception as exc:
        log.exception("Route-end check failed: %s",exc)

# ═══ F11: "✅ MASHINA TO'LDIRILDI" agent xabari (poller) ═════════════════════
def run_vehicle_agent_notify():
    """Omborchi zaxirani mashinaga o'tkazgach (stock_transferred) agentga xabar.
    At-least-once: xabar ketmasa belgi qo'yilmaydi, keyingi aylanishda qayta
    uriniladi. FOR UPDATE SKIP LOCKED — parallel ishlashga chidamli."""
    while True:
        try:
            if os.environ.get("VEHICLE_DISTRIBUTION_ENABLED")=="1":
                for hid in vfill.pending_agent_notifications():
                    try:
                        vfill.notify_agent_transfer(
                            hid,lambda chat,text: bot.send_message(chat,text))
                    except Exception as exc:
                        log.warning("Handoff %s agent xabari keyinga qoldi: %s",hid,exc)
        except Exception as exc:
            log.exception("Vehicle agent notify loop failed: %s",exc)
        time.sleep(15)

# ── Boshqa har qanday joylashuv xabari → agent_locations (jonli GPS oqimi) ─────
# Diqqat: bu handler ENG OXIRIDA ro'yxatdan o'tadi — state-ga bog'liq location
# handlerlari (dokon_location, olmadi_location, route_gps) undan ustun turadi.
@bot.message_handler(content_types=["location"])
def any_location(msg):
    uid=msg.from_user.id
    if not (get_user(uid) or _get_delivery_agent_by_tid(uid)): return
    _record_agent_location(uid,msg.location.latitude,msg.location.longitude,"manual")
    bot.send_message(uid,"📍 Joylashuv qayd etildi.")

if __name__=="__main__":
    init_db()
    threading.Thread(target=run_scheduler,daemon=True).start()
    threading.Thread(target=run_health_server,daemon=True).start()
    threading.Thread(target=run_replenishment_delivery,daemon=True).start()
    threading.Thread(target=run_vehicle_agent_notify,daemon=True).start()
    print("✅ TOP MART bot ishga tushdi!")
    bot.infinity_polling(timeout=30, long_polling_timeout=30)
