---
name: Vehicle pilot sale atomicity
description: Transaction and locking rules for exact-pilot vehicle sales.
---

NAVRUZBEK vehicle sales must run on one physical PostgreSQL connection and transaction across `distribution` and `public`; never split sale creation and stock allocation across an HTTP call.

**Why:** A network timeout between independent commits can leave a sale without stock allocation or stock allocation without a sale. F6 also needs a shared lock boundary to detect every stock change.

**How to apply:** Resolve the exact active pilot assignment server-side, lock the vehicle warehouse parent before vehicle reads, use a stable operation key and fingerprint, and atomically commit sale/debt/balance, inventory movement, one allocation per loaded label, claim status, and unit events. Pilot quantities are whole labeled units. Posted pilot sales stay immutable until a compensating reversal model exists.
## Dispatch identity + flow stability
Pilot routing must never key on users.name spelling — prod spells the same person differently across tables ("Navro'zbek" vs "Navruzbek"); names are display data, telegram_id matched against the active assignment chain is identity. Deactivating the assignment is the official pilot-off switch.
The pilot decision is PINNED once per sale flow and re-checked only at the final write: a mid-flow assignment change must abort with refund + explicit error, never switch writers.
**Why:** dispatch and the transactional guard must share one identity source; a DB-backed decision re-evaluated mid-flow becomes a money-corruption window (double debit or unbacked debt reduction).
**How to apply:** pilot-gated features read the pinned flow flag / shared helper — never re-compare names, never re-evaluate the route mid-flow.

## kg (o'lchovli) qatorlar — 2026-08-29
Pilot savdosida birlik!='dona' qatorlar ODDIY savdo qatori: savdo_tafsilot'ga yoziladi, mashina zaxirasi / etiketka claims / allocations / unit-events / replenishment'ga TEGMAYDI (yuklash F6 faqat dona-etiketka, kg mashinada bo'lishi mumkin emas). Chegara: lower(btrim(COALESCE(NULLIF(birlik,''),'dona'))) — bo'sh/NULL birlik dona hisoblanadi. Dona qatorlar avvalgidek qat'iy: butun son, SKU->public.products mapping, FIFO claims.
Jami tekshiruvi: deklaratsiya qilingan jami 0.001 to'rida YOTISHI va qatorlar yig'indisiga AYNAN teng bo'lishi shart. Ikkala tomonni kvantlash mumkin emas — +-0.0005 boshqa jami o'tkazib, BIGINT yumaloqlashda sarlavha/qator summalarini ajratadi (arxitektor ko'rigi topdi). Bot jami'ni round(...,3) bilan yuboradi. Bot gate: dona=butun son, kg<=3 kasr xona, nan/inf parse bosqichida rad (round(inf,3) OverflowError berar edi).
**Why:** kg mahsulot mashinaga yuklanmaydi — usiz pilot sotuvchi kg mahsulotni umuman sota olmas edi.
**How to apply:** kg qatorda "stock yechilmadi" — bug EMAS, dizayn. Fingerprint (_qty_key) butun miqdorlarni JSON int saqlaydi — eski dona imzolar buzilmaydi; kasrlar normalized string.

## Trace-gate: dona qat'iyligi faqat YUKLANGAN mahsulotlarga — 2026-08-30
Dona qator qat'iy stock/etiketka yo'liga FAQAT mashinada shu mahsulot uchun status<>'prepared' claims izi bo'lsa (loaded/sold/returned) tushadi; iz yo'q yoki faqat 'prepared' → kg kabi oddiy savdo qatori.
**Why:** mashina fizik jihatdan pilotdan oldingi mollarni ham tashiydi; "har dona qator mashina omborida bo'lsin" talabi butun aralash savdoni bloklab, dala agentini to'xtatdi (real hodisa). 'prepared' iz hisoblanmaydi: qutilar hali omborda (F6 topshiruv yo'q), BEKOR QILINGAN handofflar ham 'prepared' claims qoldiradi (prod fakt: handoff 6/7) — bular sotuvni to'smasin.
**How to apply:** loaded-iz BOR mahsulot qoldiq tugasa ham oddiy yo'lga TUSHMAYDI (etiketkasiz dona taqiq). Race: 'loaded' faqat F6 transferStock'da paydo bo'ladi va F6 ham, savdo ham bir xil mashina-ombor parent qulfini oladi → probe seriyalashgan. prepareLabelsInTx ham parent qulfni advisory'dan AVVAL oladi (F6 bilan bir global tartib) — defense in depth. Xatolar mahsulot nomi + mavjud/so'ralgan miqdorni aytadi.
