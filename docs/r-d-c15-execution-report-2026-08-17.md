# R-D C-15 IJRO HISOBOTI — 2026-08-17

**Buyruq:** «R-D GO C-15» (egasi, 2026-08-17) · **Doira:** FAQAT C-15 (warehouse_id=21) · **Asos:** `docs/r-d-dryrun-c15-2026-08-17.md` (13/13 PASS)
**Skript:** `scripts/sql/r-d-c15-execution-2026-08-17.sql` · **SHA-256:** `972d9cf95365b447a95a7c34a82f09676b2ddbb11546860c7b6419d09eabdbc0`
**Zaxira:** `backups/pre-r-d-c15-2026-08-17.dump` (1 015 451 bayt, PG18.6 pg_dump, ijrodan OLDIN olingan)
**COMMIT vaqti:** 2026-08-17 07:21:14 UTC (Toshkent 12:21:14)

---

## 0. Xulosa

C-15 konteynerining fizik sanog'i (2026-08-16, 3 pozitsiya, **13 020.00 kg**) prod bazaga **bitta atomar tranzaksiyada** yuklandi: 3 ta BASELINE harakati + 3 ta inventar satri + registrdagi C-15 holati `MAPPED → LOADED`. Boshqa hech narsa tegilmadi — registr, legacy arxiv, sotuvlar, xomashyo jadvali, qolgan 9 ombor kesimi bayt-ma-bayt avvalgidek.

## 1. GO qarorlari (egasi tasdiqlagan)

| Qaror | Qiymat |
|---|---|
| kg-only konvensiya | `quantity = 0`, `weight_kg = sanoq kg` (№5 savol — C-15 uchun TASDIQLANDI, pretsedent) |
| Harakat muallifi | `created_by = 'thisismurodov'` (№6 savolning R-D qismi — C-15 uchun HAL) |
| Mahsulot turi | `product_type = 'raw'` (C-15 maqsadi hali `finished` — №3 savol R-E'da, yuklashni bloklamaydi) |
| Doira | faqat C-15; nollash YO'Q (C-15 izsiz-toza edi); boshqa konteynerlar MUZLATILGAN |

## 2. Himoya zanjiri (barchasi ishladi)

1. **Pre-GO zaxira** — to'liq prod dump, ijrodan oldin.
2. **Bitta REPEATABLE READ tranzaksiya** — yo hammasi, yo hech narsa (qisman yozuv mumkin emas).
3. **QULFLAR snapshot'dan OLDIN** *(arxitektor ko'rigi bilan kuchaytirildi)* — `physical_baselines, physical_baseline_positions, items, warehouses, inventory, stock_movements` jadvallariga `SHARE ROW EXCLUSIVE`: parallel yozuvchilar COMMIT'gacha kutadi, tekshiruvlar YAKUNIY holatni ko'radi. Isbot — mashqdagi qulf probasi (§3).
4. **GATE0 — qoziqlar**: 9 baseline · 94 item · 97 pozitsiya / 71 862.20 kg / 126 360.00 dona · C-15 nomi va 3 pozitsiya tuplе-darajada bayt-ma-bayt solishtirildi.
5. **GATE1 — LATCH**: id=9 `FOR UPDATE` + `status='MAPPED'` sharti — dublikat GO matematik bloklanadi.
6. **GATE2 — tozalik**: global BASELINE=0, C-15'da harakat/inventar/iz = 0.
7. **9.1–9.10 tekshiruv COMMIT'dan oldin** — birortasi yiqilsa → avtomatik ROLLBACK.
8. `ON_ERROR_STOP=1` + SHA-256 tasdiqlash ijro buyrug'ining o'zida.

## 3. Mashq (throwaway bazada, dump'dan tiklab)

Replika prod bilan aynan: 9/97/94 registr, 43 inventar, 620 harakat, legacy 43/36/17/1, 6 muzlatish triggeri.

| Sinov | Natija |
|---|---|
| Skript ijrosi | ✅ NOTICE «9.1–9.10 BARCHASI PASS» + COMMIT |
| Dublikat GO (2-marta ishga tushirish) | ✅ LATCH bloklandi: «C-15 (id=9) MAPPED holatda topilmadi… HECH NARSA YOZILMADI» |
| Qulf probasi (parallel yozuvchi) | ✅ qulf ushlab turilganda `INSERT` `lock_timeout`ga urildi; qulf bo'shagach o'tdi (musbat nazorat) |

Mashq bazalari o'chirildi. *(Texnik izoh: to'liq dump tiklash `distribution` sxemasi tufayli sekin — mashq faqat `public`+`legacy` bilan tiklandi; `-n legacy` sxemani o'zi yaratmaydi, oldindan `CREATE SCHEMA` kerak bo'ldi.)*

## 4. Prod ijro

```
SHA OK → BEGIN → LOCK TABLE → NOTICE: R-D C-15: 9.1-9.10 BARCHASI PASS
       → 3 BASELINE harakat + 3 inventar satri + status LOADED → COMMIT
```

## 5. Post-COMMIT mustaqil tekshiruv (yangi read-only sessiya) — egasining 6 talabi

| № | Talab | Natija |
|---|---|---|
| 1 | C-15 balansi | ✅ 3 satr (id 335–337): Qizil 3 720.00 · Ko'k 3 840.00 · Sariq 5 460.00 kg, hammasi `quantity=0`, `raw`, item_id 93/94/95 |
| 2 | 3 BASELINE harakat | ✅ id **625/626/627**, `to_warehouse_id=21`, `from=NULL`, `created_by='thisismurodov'`, reference → R-B pozitsiya 95/96/97 |
| 3 | Jami 13 020.00 kg | ✅ inventar SUM = 13 020.00 = harakatlar SUM |
| 4 | MAPPED→LOADED | ✅ C-15 = LOADED; qolgan 8 tasi MAPPED |
| 5 | Invariantlar | ✅ quyidagi jadval — faqat kutilgan +3/+3 o'zgardi |
| 6 | Ijro hisoboti | ✅ ushbu hujjat |

## 6. Oldin / keyin

| Ko'rsatkich | Oldin | Keyin | Izoh |
|---|---|---|---|
| `inventory` satrlari | 43 | **46** | +3 faqat C-15 |
| `stock_movements` | 620 | **623** | +3, barchasi BASELINE |
| BASELINE harakatlar | 0 | **3** | 13 020.00 kg |
| Registr (9 / 97 / 71 862.20 / 126 360.00) | ✓ | ✓ | o'zgarmagan |
| `items` | 94 | 94 | o'zgarmagan |
| Legacy arxiv (43/36/17/1) | ✓ | ✓ | o'zgarmagan |
| `raw_materials` (17 / 14 420.780) | ✓ | ✓ | o'zgarmagan |
| Sotuvlar (45 / 143) | ✓ | ✓ | o'zgarmagan |
| Boshqa 9 ombor kesimi | ✓ | ✓ | qatorma-qator avvalgidek |

*Izoh: harakat id'lari 625–627 (620+3 emas) — PostgreSQL sequence xatti-harakati (bekor qilingan urinishlar raqam «yeydi»); satrlar SONI aynan 620→623, ya'ni ledger aniq.*

## 7. Orqaga qaytish yo'li (agar kerak bo'lsa)

COMMIT'dan keyin faqat **STORNO**: har BASELINE harakatiga teskari yozuv (`reference='ROLLBACK …'`), hech narsa o'chirilmaydi. Zaxira dump qo'shimcha himoya sifatida saqlanadi.

## 8. Keyingi holat

- **C-15 — LOADED** ✅ (birinchi yuklangan konteyner, dashboard'da ko'rinadi)
- Qolgan **8 konteyner MUZLATILGAN** — har biriga alohida «R-D GO C-XX» kerak: C-20, C-19, C-18, C-02, C-04, C-06, C-16, C-17
- C-16/C-17 GO'sida qo'shimcha: 13 legacy qatorni auditli nollash (№2 savol o'sha yerda tasdiqlanadi)
- №3 (C-15 maqsadi `finished→raw`) — R-E bosqichida
- №4 (WIP kesimi) — R-D to'liq yakunida

---

*Biz taxmin qilmaymiz. Biz bilamiz.*
