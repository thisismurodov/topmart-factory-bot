# R-D FINAL — 8 KONTEYNER + 2 EXACT IJRO HISOBOTI (2026-08-17)

**Asos:** Egasining «R-D FINAL GO» buyrug'i (2026-08-17) + FINAL MASTER PROMPT (§22 gate 11/11 PASS).
**Skript:** `scripts/sql/r-d-8cont-execution-2026-08-17.sql` · sha256 `dc4b5517040e8c57a7f0abba0505502289e088a1e1c056e1cb1ef17e22836028`
**Natija: ✅ COMMIT — barcha GATE va verifikatsiyalar PASS, mustaqil post-verify PASS.**

---

## 1. Backup (GO tartibi 1-band)

| Tekshiruv | Natija |
|---|---|
| Fayl | `backups/pre-r-d-8cont-2026-08-17.dump` (pg_dump -Fc, to'liq baza) |
| Hajm / vaqt | 1 042 127 bayt · 2026-08-17 09:37 UTC (ijrodan bevosita oldin) |
| TOC butunligi | `pg_restore --list` OK — 1 910 yozuv, 262 TABLE DATA |
| Kalit jadvallar | inventory, stock_movements, items, physical_baselines, physical_baseline_positions, sales, sale_items, products, raw_materials, warehouses, legacy.inventory_baseline_pre — barchasi TOCda ✓ |

## 2. Drift oldindan-tekshiruv (ijro oldidan, read-only)

`inv=46 mov=623 base=3 sales=45/143 items=94 pos=97 mapped=8 loaded=1 arxiv=43 rawmat=17` — GATE-0 pinlari bilan **aynan mos**, preview'dan beri prod o'zgarmagan.

## 3. Ijro (bitta atomik tranzaksiya)

Qulflar (SHARE ROW EXCLUSIVE) **birinchi SELECTdan oldin**: physical_baselines, physical_baseline_positions, items, warehouses, inventory, stock_movements, products, **sales, sale_items, raw_materials** (arxitektor topilmasi), legacy.inventory_baseline_pre.

```
NOTICE: GATE-0: BARCHA PINLAR PASS (1.1–1.14)
NOTICE: GATE-1 LATCH: 8/8 MAPPED qulflandi
NOTICE: NOLLASH: 13/13 auditli BASELINE bilan nollandi
NOTICE: STATUS: 8/8 LOADED
NOTICE: 9.x: BARCHA VERIFIKATSIYA PASS — COMMIT xavfsiz
COMMIT  (exit=0)
```

Yozuvlar: 92 TM BASELINE harakat + 92 inventar satri · 2 EXACT harakat + 2 satr · 13 legacy nollash (auditli BASELINE, eski qiymat reason ichida) · 8 baseline MAPPED→LOADED. **DELETE ishlatilmadi. C-15'ga yozilmadi.**

## 4. Mustaqil post-verifikatsiya (yangi sessiya, `default_transaction_read_only=on`)

| # | Tekshiruv | Natija | Holat |
|---|---|---|---|
| PV1 | Global | inv=140 · mov=730 · BASELINE=110 · LOADED=9 · MAPPED=0 | ✅ |
| PV2 | Mustaqil qayta hisob | inventar 9 joy = **71 862,20 kg** = registr 97 pozitsiya = **71 862,20 kg**; dona **126 360 = 126 360** | ✅ |
| PV4 | EXACT | 2 satr aynan pinlangan (C-18/Rossiya Tros/531,00 · C-02/Shroki 3.5 Oq/676,55; qty=0, finished, item_id NULL); global dublikat tekshiruvi: har nom 1 satr | ✅ |
| PV5 | Legacy nollash | 13 satr · qoldiq 0 · kg 0 (C-16: 3, C-17: 10) | ✅ |
| PV6 | Tasnif | **raw=6** (TM-000018/61/62/92/93/94) · **pre-finished=3** (TM-000005/16/17) · **finished=88** — egasi ro'yxati bilan aynan | ✅ |
| PV7 | C-15 daxlsiz | 3 satr · 13 020,00 kg · 3 harakat (o'zgarmagan) | ✅ |
| PV8 | Daxlsizlar | sales=45/143 · items=94 · arxiv=43 · raw_materials=17 · pozitsiyalar=97 (2 EXACT hamon EXCLUDED, item_id NULL — registr muzlatilgan) · baselines=9 | ✅ |
| PV9 | Katalog | products id=46 (Rossiya Tros/ROSSIYATROS) va id=108 (Shroki 3.5 Oq/SHROKI-3-5-OQ) o'zgarmagan, yangi SKU yaratilmadi | ✅ |
| PV10 | Harakat kesimi | yuklash=95 (**92 bu GO + 3 C-15 pretsedenti**, prefiks umumiy) · EXACT=2 · nollash=13 → 110 BASELINE | ✅ |
| PV11 | TM-000022 | 2 lokatsiya satri, ikkalasi finished | ✅ |
| PV12 | Harakat↔inventar tengligi | item_id bo'yicha ikki yo'nalishli EXCEPT: **0 / 0 farq**; EXACT wid+nom bo'yicha 2/2 | ✅ |
| PV13 | Nollash auditi | 13 harakat, from_warehouse_id to'g'ri (22/23), eski qiymat reason ichida | ✅ |

### Joy-kesim (PV3) — inventar ↔ registr

| Konteyner | wid | Inventar satr | kg | dona | Registr pos / kg / dona |
|---|---|---|---|---|---|
| C-02 | 8 | 10 | 6 053,00 | 0 | 10 / 6 053,00 / 0 |
| C-04 | 10 | 7 | 6 363,30 | 0 | 7 / 6 363,30 / 0 |
| C-06 | 12 | 13 | 7 435,50 | 0 | 13 / 7 435,50 / 0 |
| C-15 | 21 | 3 | 13 020,00 | 0 | 3 / 13 020,00 / 0 |
| C-16 | 22 | 6 (3 yangi + 3 legacy·0) | 7 045,20 | 61 080 | 3 / 7 045,20 / 61 080 |
| C-17 | 23 | 19 (9 yangi + 10 legacy·0) | 3 256,00 | 65 280 | 9 / 3 256,00 / 65 280 |
| C-18 | 24 | 29 | 9 839,45 | 0 | 29 / 9 839,45 / 0 |
| C-19 | 25 | 13 | 8 713,30 | 0 | 13 / 8 713,30 / 0 |
| C-20 | 26 | 10 | 10 136,45 | 0 | 10 / 10 136,45 / 0 |
| **JAMI** | | **110 baseline satri** | **71 862,20** | **126 360** | **97 / 71 862,20 / 126 360** |

## 5. Yakuniy nazorat (egasi ro'yxati)

97 pozitsiya ✅ · 94 TM item ✅ · 2 EXACT ✅ · 9 lokatsiya ✅ · 71 862,20 kg ✅ · 126 360 dona ✅ · 110 BASELINE ✅ · 9 LOADED ✅ — **joriy inventar fizik sanoq bilan aynan mos.**

## 6. api-tests eslatmasi

449/450 PASS; yagona xato `wip-negative-alert.test.ts`da hook **timeout** (TRUNCATE 30s kutdi) — vaqti backup `pg_dump` oynasiga to'g'ri kelgan (dump ACCESS SHARE qulflari umumiy bazadagi test-sxema TRUNCATE'ini bloklaydi). Runtime kod bu sessiyada o'zgarmagan (faqat SQL skript + hujjatlar) — regressiya emas, qulf to'qnashuvi.

## 7. Ochiq qolganlar (egasi darvozalari, avto-boshlanmaydi)

- №3: C-15 maqsadi (`finished` → `raw`?) — R-E nazorati.
- №4: WIP kesimi — R-D endi to'liq yakunlangach, egasi qaroriga tayyor.
- №7 va §17–18 UI bosqichi: pre-finished/raw satrlarning ayrim panellarda ko'rinishi (ombor filtri `='finished'/'raw'`, dashboard belgisi) — alohida UI GO talab qiladi.

**Biz taxmin qilmaymiz. Biz bilamiz.**
